'use strict';
/**
 * services/adminDecisionService.js
 *
 * Otomatik denemelerle gönderilemeyen çekimler için admin kararı:
 *   send -> net tutar Uption ile gönderilir (bankada TR000 transfer varsa AYNI transfer onaylanır)
 *   none -> işlem yapılmaz (not zorunlu)
 * Yandex'e iade seçeneği yok: Uption "Hesaba Gönderim" transferlerini iptal etmiyor (26.11 canlı test),
 * bekleyen transfer kapatılamadığı için iade çift ödeme riski taşır.
 * Her karardan önce banka ve Yandex durumu yeniden okunur; kayıt kilitlenir, karar bir kez uygulanır.
 */

const db = require('../db');
const upt = require('./uptStatusService');
const paymentService = require('./paymentService');
const yandexFleetApi = require('./yandexFleetApi');
const withdrawalSafety = require('./withdrawalSafetyService');
const { createLogger, maskId } = require('./logger');

const logger = createLogger('WITHDRAWAL', { service: 'admin-decision' });

const ELIGIBLE_STATUSES = ['admin_review', 'bank_tr000_error', 'yandex_stuck_review'];
const OPTIONS = ['send', 'none'];
const LOCK_MINUTES = 5;

const fmt = n => Number(n).toLocaleString('tr-TR', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const httpError = (status, message) => Object.assign(new Error(message), { status });

/** Hangi seçeneğin uygulanabileceğini belirler (saf fonksiyon). */
function evaluateOptions({ yandexDeducted, bankState, net }) {
    const none = { allowed: true };
    if (bankState === 'paid') {
        return { bankPaid: true, send: { allowed: false, amount: net, reason: 'Banka bu transferi ödemiş; yeniden gönderim çift ödeme olur.' }, none };
    }
    if (!yandexDeducted) {
        return { send: { allowed: false, amount: net, reason: 'Sürücünün Yandex bakiyesinden kesinti yapılmamış ya da tutar zaten iade edilmiş.' }, none };
    }
    if (bankState === 'in_progress') {
        return { send: { allowed: false, amount: net, reason: 'Banka işlemi sürüyor; sonuçlanmasını bekleyin.' }, none };
    }
    // needs_confirm: bankada TR000 transfer var -> aynı transfer onaylanır; aksi halde yeni transfer.
    return { send: { allowed: true, amount: net, mode: bankState === 'needs_confirm' ? 'confirm' : 'create' }, none };
}

function splitName(fullName) {
    const parts = String(fullName || '').trim().split(/\s+/).filter(Boolean);
    const name = parts.shift() || '-';
    return { name, surname: parts.join(' ') || name };
}

async function loadRow(id) {
    if (!Number.isInteger(id) || id < 1) throw httpError(400, 'Geçersiz işlem numarası.');
    const row = (await db.query('SELECT * FROM payment_logs WHERE id = $1', [id])).rows[0];
    if (!row) throw httpError(404, 'İşlem bulunamadı.');
    return row;
}

async function loadState(row) {
    const bank = await upt.queryByCorrespondentRef(row.transaction_id);
    const bankState = upt.classifyBankState(bank);
    // Banka aşamasına yalnızca Yandex kesintisi başarılıysa geçilir; Yandex'te takılmış kayıtlar için canlı kontrol.
    let yandexDeducted = !row.yandex_refund_at;
    if (yandexDeducted && (row.status === 'yandex_stuck_review' || (row.admin_previous_status === 'yandex_stuck_review'))) {
        if (!row.yandex_transaction_id) yandexDeducted = false;
        else {
            const s = await yandexFleetApi.getTransactionStatusV3({
                driverId: row.driver_id, parkPartnerId: row.park_partner_id,
                transactionId: row.yandex_transaction_id, version: row.yandex_version || 1
            });
            yandexDeducted = s?.version_info?.status === 'success';
        }
    }
    const gross = Number(row.gross_amount);
    const net = Number(row.amount);
    return { bank, bankState, yandexDeducted, gross, net, options: evaluateOptions({ yandexDeducted, bankState, net }) };
}

async function preview(id) {
    const row = await loadRow(id);
    if (!ELIGIBLE_STATUSES.includes(row.status)) throw httpError(409, 'Bu işlem için admin kararı gerekmiyor ya da karar zaten verilmiş.');
    const st = await loadState(row);
    return {
        record: {
            id: row.id, beneficiary_name: row.beneficiary_name, beneficiary_iban: row.beneficiary_iban,
            amount: st.net, gross_amount: st.gross, status: row.status, created_at: row.created_at,
            tu_ref_number: row.tu_ref_number, transaction_id: row.transaction_id,
            bank_retry_count: row.bank_retry_count, bank_retry_last_result: row.bank_retry_last_result,
            error_message: row.error_message, admin_decision_result: row.admin_decision_result
        },
        bank: { found: st.bank.found, statusCode: st.bank.statusCode, uptref: st.bank.uptref, state: st.bankState },
        yandexDeducted: st.yandexDeducted,
        options: st.options
    };
}

async function lock(id) {
    const res = await db.query(
        `UPDATE payment_logs
            SET admin_previous_status = CASE WHEN status = 'admin_processing' THEN admin_previous_status ELSE status END,
                status = 'admin_processing',
                admin_lock_until = NOW() + make_interval(mins => $2),
                updated_at = NOW()
          WHERE id = $1
            AND (status = ANY($3::text[]) OR (status = 'admin_processing' AND admin_lock_until < NOW()))
          RETURNING *`,
        [id, LOCK_MINUTES, ELIGIBLE_STATUSES]
    );
    if (!res.rowCount) throw httpError(409, 'Bu işlem şu anda başka bir kararla işleniyor ya da karar zaten verilmiş. Listeyi yenileyin.');
    return res.rows[0];
}

async function finalize(id, fields) {
    const sets = [];
    const values = [id];
    for (const [col, value] of Object.entries(fields)) {
        values.push(value);
        sets.push(`${col} = $${values.length}`);
    }
    await db.query(
        `UPDATE payment_logs SET ${sets.join(', ')}, admin_lock_until = NULL, updated_at = NOW()
          WHERE id = $1 AND status = 'admin_processing'`,
        values
    );
}

async function executeSend(row, st, chosen) {
    if (chosen.mode === 'confirm') {
        const c = await upt.confirmTransfer(st.bank.uptref);
        const after = await upt.queryByCorrespondentRef(row.transaction_id);
        if (!c.ok && upt.classifyBankState(after) !== 'paid') {
            throw httpError(502, `Uption onayı reddetti: ${c.message || c.response || 'yanıt yok'}`);
        }
        return {
            result: `${fmt(st.net)} TL Uption kullanılarak gönderildi · UPTREF ${st.bank.uptref}`,
            extra: { tu_ref_number: st.bank.uptref, bank_status_code: after.statusCode || null }
        };
    }
    // Bankada transfer yok (ya da banka iade etmiş): yeni transfer, ayrı ve sabit bir referansla.
    await withdrawalSafety.assertSufficientBalance(st.net);
    const newRef = `${row.transaction_id}-a1`;
    let uptref;
    const existing = await upt.queryByCorrespondentRef(newRef);
    if (existing.found) {
        // Önceki bir karar denemesi transferi oluşturmuş; yeniden oluşturma, onu tamamla.
        uptref = existing.uptref;
        if (upt.classifyBankState(existing) === 'needs_confirm') {
            const c = await upt.confirmTransfer(uptref);
            if (!c.ok) throw httpError(502, `Transfer bankada var ama onaylanamadı: ${c.message || c.response}`);
        }
    } else {
        const { name, surname } = splitName(row.beneficiary_name);
        const r = await paymentService.createBankTransfer({
            beneficiaryName: name, beneficiarySurname: surname,
            beneficiaryIban: row.beneficiary_iban, amount: st.net, correspondentRef: newRef
        });
        uptref = r.tuRefNumber;
        if (!r.confirmed) throw httpError(502, `Transfer oluşturuldu ama onaylanamadı: ${r.message}. Kararı tekrar uygulayabilirsiniz; aynı transfer tamamlanır.`);
    }
    const after = await upt.queryByCorrespondentRef(newRef);
    return {
        result: `${fmt(st.net)} TL Uption kullanılarak gönderildi · UPTREF ${uptref}`,
        extra: { tu_ref_number: uptref, upt_correspondent_ref: newRef, bank_status_code: after.statusCode || null }
    };
}

async function decide(id, body = {}, adminPhone = '') {
    const option = body.option;
    const note = typeof body.note === 'string' ? body.note.trim().slice(0, 500) : '';
    if (!OPTIONS.includes(option)) throw httpError(400, 'Geçersiz karar seçeneği.');
    if (option === 'none' && note.length < 3) throw httpError(400, '"Hiçbir şey yapma" için kısa bir not zorunlu (ör. elden ödendi).');
    await loadRow(id);
    const row = await lock(id);
    try {
        const st = await loadState(row);
        if (st.options.bankPaid) {
            await finalize(id, {
                status: 'success', tu_ref_number: st.bank.uptref, bank_status_code: st.bank.statusCode,
                admin_decision_result: 'Karar uygulanmadı: banka transferi zaten ödemiş.'
            });
            return { status: 'success', result: 'Banka bu transferi zaten ödemiş; kayıt "Başarılı" yapıldı, karar uygulanmadı.' };
        }
        const chosen = st.options[option];
        if (!chosen.allowed) throw httpError(409, chosen.reason);
        if (option !== 'none' && Math.abs(Number(body.amount) - chosen.amount) > 0.009) {
            throw httpError(409, 'Tutar değişmiş görünüyor; pencereyi kapatıp yeniden açın.');
        }
        let outcome;
        if (option === 'none') outcome = { result: `İşlem yapılmadı · Not: ${note}`, extra: {} };
        else outcome = await executeSend(row, st, chosen);

        await finalize(id, {
            status: 'admin_resolved', admin_decision: option, admin_decision_result: outcome.result,
            admin_decision_note: note || null, admin_decided_at: new Date(), admin_decided_by: String(adminPhone || '').slice(0, 32),
            ...outcome.extra
        });
        logger.info('Admin kararı uygulandı', {
            provider: 'internal', operation: 'admin-decision', tx: row.transaction_id, driver: row.driver_id,
            decision: option, result: outcome.result, admin: maskId(adminPhone, 4)
        });
        return { status: 'admin_resolved', result: outcome.result };
    } catch (error) {
        await db.query(
            `UPDATE payment_logs
                SET status = COALESCE(admin_previous_status, 'admin_review'), admin_lock_until = NULL,
                    admin_decision_result = $2, updated_at = NOW()
              WHERE id = $1 AND status = 'admin_processing'`,
            [id, `Son karar denemesi başarısız (${option}): ${error.message}`]
        ).catch(() => {});
        logger.error('Admin kararı uygulanamadı', {
            provider: 'internal', operation: 'admin-decision', tx: row.transaction_id, decision: option, reason: error.message
        }, error, { dedupe: false });
        if (!error.status) error.status = 502;
        throw error;
    }
}

module.exports = { preview, decide, evaluateOptions, ELIGIBLE_STATUSES };
