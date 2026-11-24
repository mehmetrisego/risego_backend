'use strict';

const config = require('../config');
const db = require('../db');
const yandexFleetApi = require('./yandexFleetApi');
const paymentService = require('./paymentService');
const netgsm = require('./netgsmService');
const { createLogger } = require('./logger');

const logger = createLogger('WITHDRAWAL', { service: 'yandex-v3-reconciliation' });
let running = false;

// ─── Takılma (stuck) eşikleri ────────────────────────────────────────────────
// Bir Yandex işlemi bu kadar denemeye RAĞMEN hâlâ terminal duruma (success/fail)
// ulaşmadıysa veya bu yaştan daha eskiyse, otomatik karar VERİLMEZ; kayıt
// 'yandex_stuck_review' olarak manuel incelemeye alınır ve SMS alarmı gönderilir.
const STUCK_MAX_ATTEMPTS = config.alerts?.stuckMaxAttempts || 20;
const STUCK_MAX_AGE_MS = config.alerts?.stuckMaxAgeMs || 30 * 60 * 1000;
const ALERT_PHONE = config.alerts?.phone || '';

function enabled() {
    return config.yandexTransactions?.apiVersion === 'v3' && db.isConfigured();
}

async function saveStatus(row, response) {
    const info = response?.version_info || response || {};
    const status = info.status || 'unknown';
    await db.query(
        `UPDATE payment_logs SET
            yandex_transaction_id = COALESCE($1, yandex_transaction_id),
            yandex_event_id = COALESCE($2, yandex_event_id),
            yandex_version = COALESCE($3, yandex_version, 1),
            yandex_status = $4::varchar(32),
            yandex_status_description = $5,
            yandex_status_checked_at = NOW(),
            yandex_attempt_count = yandex_attempt_count + 1,
            yandex_reconciliation_required = $6,
            status = CASE WHEN $4::varchar(32) = 'fail' THEN 'yandex_failed' ELSE status END,
            updated_at = NOW()
         WHERE id = $7`,
        [response?.id || null, response?.event_id || null, info.version || 1, status,
            info.status_description || null, !['success', 'fail'].includes(status), row.id]
    );
    return { status, info, transactionId: response?.id || row.yandex_transaction_id };
}

async function fetchStatus(row) {
    if (!row.yandex_transaction_id) {
        return yandexFleetApi.createTransactionV3({
            driverId: row.driver_id,
            amount: row.yandex_requested_amount || `-${Number(row.gross_amount).toFixed(2)}`,
            parkPartnerId: row.park_partner_id,
            description: 'Para çekimi talebi',
            idempotencyToken: row.yandex_idempotency_token,
            balanceMin: Number(row.gross_amount).toFixed(4),
            data: { kind: 'other', reason: 'Para çekimi talebi' }
        });
    }
    return yandexFleetApi.getTransactionStatusV3({
        driverId: row.driver_id,
        parkPartnerId: row.park_partner_id,
        transactionId: row.yandex_transaction_id,
        version: row.yandex_version || 1
    });
}

async function continueWithBank(row) {
    // Atomik UPT sahiplenmesi paymentService içinde yapılır. Normal HTTP akışı ile
    // cron aynı anda buraya ulaşsa bile yalnızca biri bankaya çıkabilir.
    const payment = row;
    const nameParts = String(payment.beneficiary_name || '').trim().split(/\s+/).filter(Boolean);
    const beneficiaryName = nameParts.shift() || '-';
    const beneficiarySurname = nameParts.join(' ') || beneficiaryName;
    await paymentService.sendPayment({
        driverId: payment.driver_id,
        beneficiaryName,
        beneficiarySurname,
        beneficiaryIban: payment.beneficiary_iban,
        amount: Number(payment.amount),
        yandexAmount: Number(payment.gross_amount),
        parkPartnerId: payment.park_partner_id,
        transactionId: payment.transaction_id,
        skipYandex: true
    });
}

// ─── Takılan işlemi manuel incelemeye al ─────────────────────────────────────
// status'ü 'yandex_stuck_review' yapar → reconcile sorgusu artık bu kaydı
// SEÇMEZ (sonsuz sessiz döngü biter). Para güvenliği: otomatik success/fail
// kararı verilmez; idempotency token korunur, insan uzlaştırır.
async function escalateStuck(row, lastStatus, attempts, ageMs) {
    const ageMin = Math.round(ageMs / 60000);
    const res = await db.query(
        `UPDATE payment_logs
            SET status = 'yandex_stuck_review',
                yandex_reconciliation_required = FALSE,
                yandex_status_description = $2,
                updated_at = NOW()
          WHERE id = $1 AND status = 'yandex_pending'`,
        [row.id, `TAKILDI: Yandex=${lastStatus}, ${attempts} deneme, ${ageMin} dk. Manuel inceleme gerekli.`]
    );
    const changed = res.rowCount > 0;
    if (changed) {
        logger.error('Yandex işlemi takıldı; manuel incelemeye alındı', {
            provider: 'Yandex-Fleet', operation: 'stuck-review',
            tx: row.transaction_id, driver: row.driver_id,
            result: 'manual_review_required', lastStatus, attempts, ageMinutes: ageMin,
            amount: Number(row.gross_amount), currency: 'TRY'
        }, undefined, { dedupe: false });
    }
    return changed;
}

// ─── Takılma alarmı: tek SMS (çoklu takılma tek mesajda özetlenir) ────────────
async function sendStuckAlert(stuck) {
    if (!ALERT_PHONE || stuck.length === 0) return;
    const total = stuck.reduce((s, x) => s + (Number(x.amount) || 0), 0);
    const first = stuck[0];
    let msg = stuck.length === 1
        ? `RiseGo UYARI: Para cekimi takildi, manuel kontrol gerekli. tx=${first.tx} tutar=${Number(first.amount).toFixed(0)} TL`
        : `RiseGo UYARI: ${stuck.length} para cekimi takildi, manuel kontrol gerekli. Toplam ~${total.toFixed(0)} TL. Ilk tx=${first.tx}`;
    if (msg.length > 160) msg = msg.slice(0, 157) + '...';
    try {
        const r = await netgsm.sendOtpSms(ALERT_PHONE, msg);
        if (r.success) {
            logger.info('Takilma alarmi SMS gonderildi', {
                operation: 'stuck-alert-sms', count: stuck.length, jobId: r.jobId
            });
        } else {
            logger.error('Takilma alarmi SMS gonderilemedi', {
                operation: 'stuck-alert-sms', count: stuck.length, reason: r.error
            }, undefined, { dedupe: false });
        }
    } catch (e) {
        logger.error('Takilma alarmi SMS hatasi', {
            operation: 'stuck-alert-sms', reason: e.message
        }, e, { dedupe: false });
    }
}

async function reconcilePendingTransactions() {
    if (!enabled() || running) return;
    running = true;
    const stuck = [];
    try {
        const result = await db.query(
            `SELECT * FROM payment_logs
             WHERE status = 'yandex_pending'
               AND yandex_status IN ('in_progress', 'unknown', 'success')
               AND yandex_idempotency_token IS NOT NULL
             ORDER BY created_at ASC
             LIMIT 25`
        );
        for (const row of result.rows) {
            const ageMs = Date.now() - new Date(row.created_at).getTime();
            try {
                if (row.yandex_status === 'success') {
                    await continueWithBank(row);
                    continue;
                }
                const response = await fetchStatus(row);
                const state = await saveStatus(row, response);
                if (state.status === 'success') {
                    await continueWithBank(row);
                    continue;
                }
                // Hâlâ in_progress/unknown → takılma eşiği kontrolü
                const attempts = (Number(row.yandex_attempt_count) || 0) + 1; // saveStatus +1 artırdı
                const freshAge = Date.now() - new Date(row.created_at).getTime();
                // Yalnizca yasa bak: yandex_attempt_count istek sirasindaki durum sorgularini da
                // sayiyor; deneme sayisina gore eskalasyon islemi ~40 sn'de yanlislikla kenara aliyordu.
                if (freshAge >= STUCK_MAX_AGE_MS) {
                    if (await escalateStuck(row, state.status, attempts, freshAge)) {
                        stuck.push({ tx: row.transaction_id, amount: Number(row.gross_amount) });
                    }
                }
            } catch (error) {
                // Sorgu başarısız olsa bile yaşa göre eskalasyon (sonsuz sessiz döngüyü önler)
                if (ageMs >= STUCK_MAX_AGE_MS) {
                    try {
                        if (await escalateStuck(row, 'sorgu_hatasi', Number(row.yandex_attempt_count) || 0, ageMs)) {
                            stuck.push({ tx: row.transaction_id, amount: Number(row.gross_amount) });
                        }
                    } catch (_) { /* aşağıda loglanır */ }
                }
                logger.error('Bekleyen Yandex işlemi uzlaştırılamadı', {
                    provider: 'Yandex-Fleet', operation: 'reconcile-transaction',
                    tx: row.transaction_id, driver: row.driver_id,
                    result: 'pending', httpStatus: error.response?.status,
                    reason: error.response?.data?.message || error.message
                }, error);
            }
        }
        if (stuck.length > 0) await sendStuckAlert(stuck);
    } finally {
        running = false;
    }
}

module.exports = { reconcilePendingTransactions };
