'use strict';
/**
 * services/bankRetryService.js
 *
 * Banka adımı belirsiz kalan çekimleri (bank_unknown, ya da bankada TR000'da duran
 * pending_bank) sürücünün 10 dakikalık çekim bekleme süresi içinde 3 kez dener.
 * Her denemede önce bankadaki durum okunur:
 *   ödenmiş (TR010…)   -> success
 *   iade/iptal kodu    -> mevcut iade akışı (processSinglePayment)
 *   TR000              -> aynı transferin onayı gönderilir (tamamlanmışsa banka reddeder)
 *   bankada yok        -> sonraki denemeye bırakılır
 * 3 denemede gönderilemeyen kayıt admin kararına (admin_review) yönlendirilir.
 */

const config = require('../config');
const db = require('../db');
const upt = require('./uptStatusService');
const netgsm = require('./netgsmService');
const { createLogger, maskId } = require('./logger');

const logger = createLogger('WITHDRAWAL', { service: 'bank-retry-service' });

// Banka adımının başlangıcından itibaren deneme dakikaları (hepsi 10 dk'lık bekleme süresi içinde).
const RETRY_OFFSETS_MIN = [1, 4, 8];
const MAX_ATTEMPTS = RETRY_OFFSETS_MIN.length;
// Bu andan önce oluşmuş kayıtlar otomasyona girmez (eskiler elle / "TR000 hata kodu" ile yönetildi).
const RETRY_SINCE_ISO = process.env.BANK_RETRY_SINCE || '2026-11-26T15:00:00Z';
const ALERT_PHONE = config.alerts?.phone || '';
const BATCH = 20;

let running = false;

const retryDueSql = `COALESCE(bank_started_at, created_at) + make_interval(mins => (CASE bank_retry_count
    WHEN 0 THEN ${RETRY_OFFSETS_MIN[0]} WHEN 1 THEN ${RETRY_OFFSETS_MIN[1]} ELSE ${RETRY_OFFSETS_MIN[2]} END)) <= NOW()`;

// TR000'da (onay bekleyen) veya sonucu hiç bilinmeyen kayıtlar.
const RETRYABLE_SQL = `status IN ('bank_unknown', 'pending_bank')
    AND (status = 'bank_unknown' OR bank_status_code = 'TR000')
    AND created_at >= $1::timestamptz`;

async function saveBankRef(id, q) {
    await db.query(
        `UPDATE payment_logs
            SET tu_ref_number = COALESCE(tu_ref_number, $2),
                bank_status_code = $3,
                bank_status_checked_at = NOW(),
                status = CASE WHEN status = 'bank_unknown' THEN 'pending_bank' ELSE status END,
                updated_at = NOW()
          WHERE id = $1`,
        [id, q.uptref, q.statusCode || null]
    );
}

async function markSuccess(id, statusCode) {
    await db.query(
        `UPDATE payment_logs SET status = 'success', bank_status_code = $2, bank_status_checked_at = NOW(), updated_at = NOW()
          WHERE id = $1 AND status IN ('bank_unknown', 'pending_bank', 'admin_review')`,
        [id, statusCode]
    );
}

/** Bankadaki duruma göre kaydı ilerletir; yapılanı açıklayan kısa metni döner. */
async function handleBankState(row, q, { allowConfirm }) {
    const state = upt.classifyBankState(q);
    if (q.found) await saveBankRef(row.id, q);
    if (state === 'paid') {
        await markSuccess(row.id, q.statusCode);
        return { state, text: `Banka ödemiş (${q.statusCode})` };
    }
    if (state === 'returned') {
        await upt.processSinglePayment({ ...row, tu_ref_number: q.uptref });
        return { state, text: `Banka iade etti (${q.statusCode}); iade akışı çalıştı` };
    }
    if (state === 'in_progress') return { state, text: `Banka işliyor (${q.statusCode})` };
    if (state === 'not_found') return { state, text: 'Bankada transfer bulunamadı' };

    // needs_confirm (TR000)
    if (!allowConfirm) return { state, text: 'Bankada onay bekliyor (TR000)' };
    const c = await upt.confirmTransfer(q.uptref);
    const after = await upt.queryByCorrespondentRef(row.transaction_id);
    const afterState = upt.classifyBankState(after);
    if (after.found) await saveBankRef(row.id, after);
    if (afterState === 'paid') {
        await markSuccess(row.id, after.statusCode);
        return { state: 'paid', text: `Onay gönderildi, banka ödedi (${after.statusCode})` };
    }
    return {
        state: afterState,
        text: c.ok
            ? `Onay gönderildi (Success), banka durumu ${after.statusCode || 'bilinmiyor'}`
            : `Onay reddedildi: ${c.message || c.response || 'yanıt yok'}`
    };
}

async function attempt(row) {
    const claimed = await db.query(
        `UPDATE payment_logs SET bank_retry_count = bank_retry_count + 1, bank_retry_last_at = NOW(), updated_at = NOW()
          WHERE id = $1 AND bank_retry_count = $2 AND status IN ('bank_unknown', 'pending_bank')
          RETURNING bank_retry_count`,
        [row.id, row.bank_retry_count]
    );
    if (!claimed.rowCount) return; // başka bir yürütücü aldı
    const n = claimed.rows[0].bank_retry_count;
    let text;
    try {
        const q = await upt.queryByCorrespondentRef(row.transaction_id);
        text = (await handleBankState(row, q, { allowConfirm: true })).text;
    } catch (error) {
        text = `Deneme hatası: ${error.message}`;
    }
    await db.query('UPDATE payment_logs SET bank_retry_last_result = $2 WHERE id = $1', [row.id, `${n}/${MAX_ATTEMPTS}: ${text}`]);
    logger.info('Banka adımı yeniden denendi', {
        provider: 'UPT', operation: 'bank-retry', tx: row.transaction_id, driver: row.driver_id,
        attempt: `${n}/${MAX_ATTEMPTS}`, result: text
    });
}

async function sendReviewAlert(rows) {
    if (!ALERT_PHONE || rows.length === 0) return;
    const total = rows.reduce((sum, r) => sum + (Number(r.amount) || 0), 0);
    let msg = `RiseGo: ${rows.length} cekim 3 denemede gonderilemedi, admin karari bekliyor. Toplam ~${total.toFixed(0)} TL.`;
    if (msg.length > 160) msg = msg.slice(0, 157) + '...';
    try {
        const r = await netgsm.sendOtpSms(ALERT_PHONE, msg);
        if (!r.success) logger.error('Admin karari alarmi SMS gonderilemedi', { operation: 'admin-review-sms', reason: r.error }, undefined, { dedupe: false });
    } catch (e) {
        logger.error('Admin karari alarmi SMS hatasi', { operation: 'admin-review-sms', reason: e.message }, e, { dedupe: false });
    }
}

/** 3 deneme bitmiş ve hâlâ gönderilememiş kayıtları son kez okuyup admin kararına yönlendirir. */
async function escalate() {
    const rows = (await db.query(
        `SELECT * FROM payment_logs
          WHERE ${RETRYABLE_SQL} AND bank_retry_count >= $2 AND bank_retry_last_at < NOW() - INTERVAL '1 minute'
          ORDER BY created_at ASC LIMIT ${BATCH}`,
        [RETRY_SINCE_ISO, MAX_ATTEMPTS]
    )).rows;
    const escalated = [];
    for (const row of rows) {
        try {
            const q = await upt.queryByCorrespondentRef(row.transaction_id);
            const { state, text } = await handleBankState(row, q, { allowConfirm: false });
            if (state !== 'needs_confirm' && state !== 'not_found') continue;
            const res = await db.query(
                `UPDATE payment_logs
                    SET admin_previous_status = status, status = 'admin_review',
                        bank_retry_last_result = COALESCE(bank_retry_last_result, '') || $2, updated_at = NOW()
                  WHERE id = $1 AND status IN ('bank_unknown', 'pending_bank')`,
                [row.id, ` → Admin kararına yönlendirildi (${text})`]
            );
            if (res.rowCount) {
                escalated.push(row);
                logger.error('Çekim 3 denemede gönderilemedi; admin kararı bekleniyor', {
                    provider: 'UPT', operation: 'bank-retry-escalate', tx: row.transaction_id, driver: row.driver_id,
                    bankRef: q.uptref ? maskId(q.uptref, 8) : undefined, result: 'admin_review', reason: text,
                    amount: Number(row.amount), currency: 'TRY'
                }, undefined, { dedupe: false });
            }
        } catch (error) {
            logger.error('Admin kararına yönlendirme kontrolü başarısız', {
                provider: 'UPT', operation: 'bank-retry-escalate', tx: row.transaction_id, reason: error.message
            }, error);
        }
    }
    await sendReviewAlert(escalated);
}

async function runBankRetries() {
    if (running || !db.isConfigured() || process.env.BANK_RETRY_ENABLED === 'false') return;
    running = true;
    try {
        const due = (await db.query(
            `SELECT * FROM payment_logs
              WHERE ${RETRYABLE_SQL} AND bank_retry_count < $2 AND ${retryDueSql}
              ORDER BY created_at ASC LIMIT ${BATCH}`,
            [RETRY_SINCE_ISO, MAX_ATTEMPTS]
        )).rows;
        for (const row of due) {
            await attempt(row);
            await new Promise(r => setTimeout(r, 300));
        }
        await escalate();
    } catch (error) {
        logger.error('Banka yeniden deneme döngüsü hatası', { provider: 'UPT', operation: 'bank-retry', reason: error.message }, error);
    } finally {
        running = false;
    }
}

module.exports = { runBankRetries, handleBankState, RETRY_OFFSETS_MIN, MAX_ATTEMPTS, RETRY_SINCE_ISO };
