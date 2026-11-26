'use strict';
// ============================================================
//  PaymentService — Uption (Aktif Bank) SOAP EFT Gönderim + Yandex Bakiye Kesme
//
//  deneme.js içindeki yapı (ENDPOINT, XML şablonu, postSoap, confirm akışı)
//  HİÇBİR DEĞİŞİKLİK YAPILMADAN burada servis olarak sarmalanmıştır.
//  Sürücüye özgü alanlar (BENEFICIARY_NAME, BENEFICIARY_SURNAME, BENEFICIARY_IBAN,
//  AMOUNT, BENEFICIARY_PAYMENT_AMOUNT) dinamik olarak doldurulur.
// ============================================================

const axios = require('axios');
const crypto = require('crypto');
const config = require('../config');
const db = require('../db');
const yandexFleetApi = require('./yandexFleetApi');
const { createLogger, maskId } = require('./logger');

const paymentLogger = createLogger('WITHDRAWAL', { service: 'payment-service' });
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

function stableIdempotencyToken(scope, transactionId) {
    return crypto.createHash('sha256').update(`${scope}:${transactionId}`).digest('hex');
}

function usesYandexV3() {
    return config.yandexTransactions?.apiVersion === 'v3';
}

function parkName(partnerId) {
    const resolvedId = partnerId || config.yandexFleet.partnerId;
    return config.findYandexParkByPartnerId(resolvedId)?.label || 'Bilinmeyen park';
}

/**
 * XML özel karakterlerini kaçırır (XML Injection koruması)
 */
function escapeXml(unsafe) {
    if (unsafe == null) return '';
    return String(unsafe).replace(/[<>&'"]/g, (c) => {
        switch (c) {
            case '<': return '&lt;';
            case '>': return '&gt;';
            case '&': return '&amp;';
            case '\'': return '&apos;';
            case '"': return '&quot;';
            default: return c;
        }
    });
}


/**
 * Finansal işlemi veritabanına loglar
 */
async function savePaymentLog({
    driverId, beneficiaryName, beneficiaryIban, amount, grossAmount,
    tuRefNumber, status, errorMessage, parkPartnerId, transactionId
}) {
    if (!db.isConfigured()) return;
    try {
        if (transactionId) {
            const updated = await db.query(
                `UPDATE payment_logs
                 SET beneficiary_name = $1, beneficiary_iban = $2, amount = $3,
                     gross_amount = $4, tu_ref_number = $5, status = $6,
                     error_message = $7, park_partner_id = $8, updated_at = NOW()
                 WHERE transaction_id = $9`,
                [beneficiaryName, beneficiaryIban, amount, grossAmount, tuRefNumber || null,
                    status, errorMessage || null, parkPartnerId || '', transactionId]
            );
            if (updated.rowCount > 0) return;
        }
        await db.query(
            `INSERT INTO payment_logs 
            (driver_id, beneficiary_name, beneficiary_iban, amount, gross_amount, tu_ref_number, status, error_message, park_partner_id, transaction_id, updated_at)
            VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, NOW())`,
            [
                driverId,
                beneficiaryName,
                beneficiaryIban,
                amount,
                grossAmount,
                tuRefNumber || null,
                status,
                errorMessage || null,
                parkPartnerId || '',
                transactionId || null
            ]
        );
    } catch (err) {
        console.error('[PaymentService] Log yazma hatası:', err.message);
        throw err;
    }
}

async function createYandexPendingLog({
    driverId, beneficiaryName, beneficiaryIban, amount, grossAmount,
    parkPartnerId, transactionId, idempotencyToken, yandexRequestedAmount
}) {
    if (!db.isConfigured()) return;
    await db.query(
        `INSERT INTO payment_logs
         (driver_id, beneficiary_name, beneficiary_iban, amount, gross_amount,
          status, park_partner_id, transaction_id, yandex_idempotency_token,
          yandex_requested_amount, yandex_status, yandex_attempt_count,
          yandex_reconciliation_required, updated_at)
         VALUES ($1,$2,$3,$4,$5,'yandex_pending',$6,$7,$8,$9,'unknown',0,TRUE,NOW())`,
        [driverId, beneficiaryName, beneficiaryIban, amount, grossAmount,
            parkPartnerId || '', transactionId, idempotencyToken, yandexRequestedAmount]
    );
}

async function updateYandexState(transactionId, data = {}) {
    if (!db.isConfigured() || !transactionId) return;
    if (data.isRefund) {
        await db.query(
            `UPDATE payment_logs SET
                yandex_refund_transaction_id = COALESCE($1, yandex_refund_transaction_id),
                yandex_refund_status = COALESCE($2, yandex_refund_status),
                yandex_status_description = $3,
                yandex_status_checked_at = NOW(),
                yandex_attempt_count = yandex_attempt_count + 1,
                yandex_reconciliation_required = $4,
                updated_at = NOW()
             WHERE transaction_id = $5`,
            [data.id || null, data.status || null, data.description || null,
                data.reconciliationRequired !== false, transactionId]
        );
        return;
    }
    await db.query(
        `UPDATE payment_logs SET
            yandex_transaction_id = COALESCE($1, yandex_transaction_id),
            yandex_event_id = COALESCE($2, yandex_event_id),
            yandex_version = COALESCE($3, yandex_version),
            yandex_status = COALESCE($4, yandex_status),
            yandex_status_description = $5,
            yandex_status_checked_at = NOW(),
            yandex_attempt_count = yandex_attempt_count + 1,
            yandex_reconciliation_required = $6,
            status = CASE
                WHEN $4 = 'fail' THEN 'yandex_failed'
                WHEN status IN ('yandex_pending', 'bank_starting') THEN status
                ELSE status
            END,
            updated_at = NOW()
         WHERE transaction_id = $7`,
        [data.id || null, data.eventId || null, data.version || null, data.status || null,
            data.description || null, data.reconciliationRequired !== false, transactionId]
    );
}

// ─── Uption Sabitler (deneme.js'den alındı) ─────────────────────────────────
const ENDPOINT = process.env.UPTION_ENDPOINT || 'https://upt.aktifbank.com.tr/ISV/TU/WebServices/V1_6/CorpService.asmx';
const SOAP_ACTION_SEND = 'http://tempuri.org/CorpSendRequest';
const SOAP_ACTION_CONFIRM = 'http://tempuri.org/CorpSendRequestConfirm';
const FETCH_TIMEOUT_MS = 30000;
const MAX_RETRIES = 3;
const RETRY_DELAY_MS = 1200;

// Kimlik bilgileri .env'den okunur
const UPTION_USERNAME = process.env.UPTION_USERNAME;
const UPTION_PASSWORD = process.env.UPTION_PASSWORD;

// Gönderici bilgileri (sabit — Rise Go kurumsal)
const SENDER_NAME = 'Rise';
const SENDER_SURNAME = 'Go';
const SENDER_COUNTRY_CODE = 'TR';
const SENDER_NATIONALITY = 'TR';
const SENDER_ID_TYPE = 'NCZ';
const SENDER_CITIZENSHIP_NO = process.env.UPTION_SENDER_TC;
const BENEFICIARY_COUNTRY_CODE = 'TR';
const TRANSFER_TYPE = 'c2c';
const TRANSACTION_TYPE = '002'; // EFT
const AMOUNT_CURRENCY = 'TRY';

// ─── XML Builder (deneme.js REQUEST_XML yapısı aynen korundu) ────────────────

/**
 * Sürücüye özgü CorpSendRequest XML'i oluşturur.
 * BENEFICIARY_NAME, BENEFICIARY_SURNAME, BENEFICIARY_IBAN ve AMOUNT
 * sürücünün kayıtlı bilgilerinden alınır.
 * @param {Object} p
 * @param {string} p.beneficiaryName    - Sürücünün adı
 * @param {string} p.beneficiarySurname - Sürücünün soyadı
 * @param {string} p.beneficiaryIban    - TR formatında IBAN (boşluksuz)
 * @param {number} p.amount             - Gönderilecek TRY tutarı
 * @returns {string} SOAP XML
 */
function buildSendRequestXml({ beneficiaryName, beneficiarySurname, beneficiaryIban, amount, transactionId }) {
    const amountStr = Number(amount).toFixed(2);
    return `<?xml version="1.0" encoding="utf-8"?>
<soapenv:Envelope xmlns:soapenv="http://schemas.xmlsoap.org/soap/envelope/" xmlns:tem="http://tempuri.org/">
  <soapenv:Header>
    <tem:WsSystemUserInfo>
      <tem:Username>${escapeXml(UPTION_USERNAME)}</tem:Username>
      <tem:Password>${escapeXml(UPTION_PASSWORD)}</tem:Password>
    </tem:WsSystemUserInfo>
  </soapenv:Header>
  <soapenv:Body>
    <tem:CorpSendRequest>
      <tem:obj>
        <tem:CORRESPONDENT_REF>${escapeXml(transactionId)}</tem:CORRESPONDENT_REF>
        <tem:SENDER_COUNTRY_CODE>${escapeXml(SENDER_COUNTRY_CODE)}</tem:SENDER_COUNTRY_CODE>
        <tem:SENDER_NATIONALITY>${escapeXml(SENDER_NATIONALITY)}</tem:SENDER_NATIONALITY>
        <tem:SENDER_ID_TYPE>${escapeXml(SENDER_ID_TYPE)}</tem:SENDER_ID_TYPE>
        <tem:SENDER_CITIZENSHIP_NO>${escapeXml(SENDER_CITIZENSHIP_NO)}</tem:SENDER_CITIZENSHIP_NO>
        <tem:BENEFICIARY_COUNTRY_CODE>${escapeXml(BENEFICIARY_COUNTRY_CODE)}</tem:BENEFICIARY_COUNTRY_CODE>
        <tem:SENDER_NAME>${escapeXml(SENDER_NAME)}</tem:SENDER_NAME>
        <tem:SENDER_SURNAME>${escapeXml(SENDER_SURNAME)}</tem:SENDER_SURNAME>
        <tem:BENEFICIARY_NAME>${escapeXml(beneficiaryName)}</tem:BENEFICIARY_NAME>
        <tem:BENEFICIARY_SURNAME>${escapeXml(beneficiarySurname)}</tem:BENEFICIARY_SURNAME>
        <tem:BENEFICIARY_IBAN>${escapeXml(beneficiaryIban)}</tem:BENEFICIARY_IBAN>
        <tem:TRANSACTION_TYPE>${escapeXml(TRANSACTION_TYPE)}</tem:TRANSACTION_TYPE>
        <tem:MONEY_TAKEN>0</tem:MONEY_TAKEN>
        <tem:MONEY_TAKEN_CURRENCY></tem:MONEY_TAKEN_CURRENCY>
        <tem:AMOUNT>${amountStr}</tem:AMOUNT>
        <tem:AMOUNT_CURRENCY>${escapeXml(AMOUNT_CURRENCY)}</tem:AMOUNT_CURRENCY>
        <tem:BENEFICIARY_PAYMENT_AMOUNT>${amountStr}</tem:BENEFICIARY_PAYMENT_AMOUNT>
        <tem:BENEFICIARY_PAYMENT_AMOUNT_CURRENCY>${escapeXml(AMOUNT_CURRENCY)}</tem:BENEFICIARY_PAYMENT_AMOUNT_CURRENCY>
        <tem:TRANSFER_TYPE>${escapeXml(TRANSFER_TYPE)}</tem:TRANSFER_TYPE>
      </tem:obj>
    </tem:CorpSendRequest>
  </soapenv:Body>
</soapenv:Envelope>`;
}

/**
 * CorpSendRequestConfirm XML'i oluşturur (deneme.js buildConfirmRequestXml aynen).
 * @param {string} tuRefNumber - CorpSendRequest'ten dönen TU_REFNUMBER_OUT
 * @returns {string} SOAP XML
 */
function buildConfirmRequestXml(tuRefNumber) {
    return `<?xml version="1.0" encoding="utf-8"?>
<soapenv:Envelope xmlns:soapenv="http://schemas.xmlsoap.org/soap/envelope/" xmlns:tem="http://tempuri.org/">
  <soapenv:Header>
    <tem:WsSystemUserInfo>
      <tem:Username>${escapeXml(UPTION_USERNAME)}</tem:Username>
      <tem:Password>${escapeXml(UPTION_PASSWORD)}</tem:Password>
    </tem:WsSystemUserInfo>
  </soapenv:Header>
  <soapenv:Body>
    <tem:CorpSendRequestConfirm>
      <tem:obj>
        <tem:TU_REFNUMBER>${escapeXml(tuRefNumber)}</tem:TU_REFNUMBER>
      </tem:obj>
    </tem:CorpSendRequestConfirm>
  </soapenv:Body>
</soapenv:Envelope>`;
}

// ─── Yardımcı (deneme.js fonksiyonları aynen) ────────────────────────────────

function extractTuRefNumber(xml) {
    const match = xml.match(/<TU_REFNUMBER_OUT\b[^>]*>([^<]+)<\/TU_REFNUMBER_OUT>/i);
    return match ? match[1].trim() : '';
}

function extractTagValues(xml, tagName) {
    const regex = new RegExp(
        `<(?:[\\w.-]+:)?${tagName}\\b[^>]*>([\\s\\S]*?)<\\/(?:[\\w.-]+:)?${tagName}>`,
        'gi',
    );
    const selfClosingRegex = new RegExp(`<(?:[\\w.-]+:)?${tagName}\\b[^>]*/>`, 'gi');
    const values = [];
    for (const match of xml.matchAll(regex)) values.push(match[1].trim());
    for (const _ of xml.matchAll(selfClosingRegex)) values.push('');
    return values;
}

function parseResponse(xml) {
    const responses = extractTagValues(xml, 'RESPONSE');
    const responseDatas = extractTagValues(xml, 'RESPONSE_DATA');
    return {
        response: responses[0] || '',
        responseData: responseDatas[0] || '',
        raw: xml
    };
}

/**
 * SOAP POST — deneme.js postSoap() ile birebir aynı mantık.
 * Node.js'de global fetch yerine node-fetch/axios kullanılır.
 * @param {string} soapAction
 * @param {string} xmlBody
 */
async function postSoap(soapAction, xmlBody, options = {}) {
    let lastError;
    const maxAttempts = Math.max(1, Number(options.maxAttempts || MAX_RETRIES));

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
        try {
            const resp = await axios.post(ENDPOINT, xmlBody, {
                headers: {
                    'Content-Type': 'text/xml; charset=utf-8',
                    'SOAPAction': `"${soapAction}"`
                },
                timeout: FETCH_TIMEOUT_MS,
                maxRedirects: 0,
                maxContentLength: 2 * 1024 * 1024,
                maxBodyLength: 256 * 1024,
                responseType: 'text',
                transformResponse: [data => data] // ham string
            });
            return { status: resp.status, statusText: resp.statusText, responseText: resp.data };
        } catch (error) {
            lastError = error;
            const status = error.response?.status;
            if (attempt < maxAttempts && (!status || status >= 500)) {
                await new Promise(r => setTimeout(r, RETRY_DELAY_MS));
            }
        }
    }

    const error = new Error(`Uption SOAP isteği ${maxAttempts} denemede başarısız: ${lastError?.message || 'bilinmeyen hata'}`);
    error.httpStatus = lastError?.response?.status;
    error.cause = lastError;
    throw error;
}

async function claimBankTransfer(transactionId) {
    // V2 eski akışta Yandex ön-kayıt satırı bulunmuyor. V3'te tek yürütücü şarttır.
    if (!usesYandexV3() || !db.isConfigured()) return true;
    const result = await db.query(
        `UPDATE payment_logs
         SET status = 'bank_starting', bank_started_at = NOW(),
             upt_correspondent_ref = $1, updated_at = NOW()
         WHERE transaction_id = $1
           AND status = 'yandex_pending'
           AND yandex_status = 'success'
           AND tu_ref_number IS NULL
         RETURNING id`,
        [transactionId]
    );
    return result.rowCount === 1;
}

// ─── Yandex Fleet Transaction (Bakiye Kesme) ─────────────────────────────────

/**
 * Sürücünün Yandex Fleet bakiyesinden belirtilen tutarı düşer.
 * POST /v2/parks/driver-profiles/transactions
 *
 * @param {string} driverId        - Yandex sürücü profil ID
 * @param {number} amount          - Kesilecek TRY tutarı (pozitif)
 * @param {string} [parkPartnerId] - Park UUID (yoksa birincil park)
 * @param {string} [description]   - İşlem açıklaması
 * @returns {Promise<Object>}
 */
async function deductYandexBalance(driverId, amount, parkPartnerId, description = 'Para çekimi', logContext = {}) {
    const parkId = parkPartnerId || config.yandexFleet.partnerId;
    const startedAt = Date.now();
    paymentLogger.info('Yandex bakiye işlemi başlatıldı', {
        provider: 'Yandex-Fleet', operation: amount < 0 ? 'deduct-balance' : 'refund-balance',
        tx: logContext.tx, driver: driverId, park: parkName(parkId),
        amount: Math.abs(Number(amount)), currency: 'TRY'
    });

    try {
        const idempotencyToken = logContext.idempotencyToken || crypto.randomBytes(16).toString('hex');
        // Aynı finansal işlem için retry sırasında token kesinlikle değişmez.
        const data = await yandexFleetApi.deductBalance(
            driverId,
            String(amount),
            parkId,
            description,
            {
                idempotencyToken,
                balanceMin: Number(amount) < 0 ? Math.abs(Number(amount)).toFixed(4) : undefined,
                data: logContext.data
            }
        );

        if (usesYandexV3()) {
            let statusData = data;
            let status = data?.status;
            await updateYandexState(logContext.tx, {
                id: data?.id,
                eventId: data?.event_id,
                version: data?.version || 1,
                status,
                description: data?.status_description,
                isRefund: Number(amount) > 0,
                reconciliationRequired: status !== 'success' && status !== 'fail'
            });

            for (let attempt = 0;
                status === 'in_progress' && attempt < config.yandexTransactions.statusPollMaxAttempts;
                attempt++) {
                await sleep(config.yandexTransactions.statusPollIntervalMs);
                statusData = await yandexFleetApi.getTransactionStatusV3({
                    driverId,
                    parkPartnerId: parkId,
                    transactionId: data.id,
                    version: data.version || 1
                });
                const versionInfo = statusData?.version_info || {};
                status = versionInfo.status;
                await updateYandexState(logContext.tx, {
                    id: statusData?.id || data?.id,
                    eventId: statusData?.event_id || data?.event_id,
                    version: versionInfo.version || data?.version || 1,
                    status,
                    description: versionInfo.status_description,
                    isRefund: Number(amount) > 0,
                    reconciliationRequired: status !== 'success' && status !== 'fail'
                });
            }

            if (status === 'fail') {
                const error = new Error(statusData?.version_info?.status_description || data?.status_description || 'Yandex işlemi reddedildi.');
                error.code = 'YANDEX_TRANSACTION_FAILED';
                throw error;
            }
            if (status !== 'success') {
                const error = new Error('Yandex işlemi hâlâ işleniyor. Sonuç arka planda takip edilecek.');
                error.code = 'YANDEX_TRANSACTION_PENDING';
                error.yandexTransaction = data;
                throw error;
            }
        }
        paymentLogger.info('Yandex bakiye işlemi tamamlandı', {
            provider: 'Yandex-Fleet', operation: amount < 0 ? 'deduct-balance' : 'refund-balance',
            tx: logContext.tx, driver: driverId, result: 'success',
            providerTx: data?.id ? maskId(data.id, 8) : undefined, durationMs: Date.now() - startedAt
        });
        return data;
    } catch (err) {
        const terminalHttpError = [400, 401, 403].includes(err.response?.status);
        if (usesYandexV3() && logContext.tx && err.code !== 'YANDEX_TRANSACTION_FAILED' && !terminalHttpError) {
            await updateYandexState(logContext.tx, {
                id: err.yandexTransaction?.id,
                eventId: err.yandexTransaction?.event_id,
                version: err.yandexTransaction?.version || 1,
                status: err.code === 'YANDEX_TRANSACTION_PENDING' ? 'in_progress' : 'unknown',
                description: err.response?.data?.message || err.message,
                isRefund: Number(amount) > 0,
                reconciliationRequired: true
            });
            err.code = 'YANDEX_TRANSACTION_PENDING';
        }
        paymentLogger.error('Yandex bakiye işlemi başarısız', {
            provider: 'Yandex-Fleet', operation: amount < 0 ? 'deduct-balance' : 'refund-balance',
            tx: logContext.tx, driver: driverId, result: 'failed',
            httpStatus: err.response?.status, reason: err.response?.data?.message || err.message,
            durationMs: Date.now() - startedAt
        }, err);
        throw err;
    }
}

// ─── Ana Servis Fonksiyonu ───────────────────────────────────────────────────

/**
 * Sürücüye EFT gönderir ve ardından Yandex bakiyesinden keser.
 *
 * Akış (deneme.js ile birebir):
 *   1. CorpSendRequest  → TU_REFNUMBER_OUT alınır
 *   2. CorpSendRequestConfirm → onay verilir
 *   3. Yandex /v2/parks/driver-profiles/transactions → bakiye düşülür
 *
 * @param {Object}  opts
 * @param {string}  opts.driverId          - Yandex sürücü ID (bakiye kesme için)
 * @param {string}  opts.beneficiaryName   - Sürücü adı (IBAN sahibi)
 * @param {string}  opts.beneficiarySurname- Sürücü soyadı
 * @param {string}  opts.beneficiaryIban   - TR IBAN (boşluksuz, TR + 24 hane)
 * @param {number}  opts.amount            - Gönderilecek TRY tutarı
 * @param {string}  [opts.parkPartnerId]   - Yandex park UUID
 * @returns {Promise<{success:boolean, tuRefNumber?:string, message?:string}>}
 */
async function sendPayment({
    driverId, beneficiaryName, beneficiarySurname, beneficiaryIban, amount, yandexAmount,
    parkPartnerId, transactionId, skipYandex = false, idempotencyToken
}) {
    // ── 1. Validasyon ────────────────────────────────────────────
    if (!beneficiaryName || !beneficiarySurname) throw new Error('Ad ve soyad zorunludur.');
    const ibanClean = String(beneficiaryIban || '').replace(/\s/g, '').toUpperCase();
    if (!/^TR\d{24}$/.test(ibanClean)) throw new Error('Geçerli bir TR IBAN giriniz.');
    const numAmount = Number(amount);
    if (!Number.isFinite(numAmount) || numAmount <= 0) throw new Error('Geçerli bir tutar giriniz.');

    const yandexDeductAmount = Number(yandexAmount ?? numAmount);
    if (!Number.isFinite(yandexDeductAmount) || yandexDeductAmount <= 0) {
        throw new Error('Geçerli bir Yandex kesinti tutarı giriniz.');
    }
    const tx = transactionId || `wd_${crypto.randomBytes(6).toString('hex')}`;
    const yandexIdempotencyToken = idempotencyToken || crypto.randomBytes(16).toString('hex');
    const yandexRequestedAmount = String(-Number(yandexDeductAmount));
    const startedAt = Date.now();

    if (usesYandexV3() && !skipYandex) {
        await createYandexPendingLog({
            driverId,
            beneficiaryName: `${beneficiaryName} ${beneficiarySurname}`,
            beneficiaryIban: ibanClean,
            amount: numAmount,
            grossAmount: yandexDeductAmount,
            parkPartnerId,
            transactionId: tx,
            idempotencyToken: yandexIdempotencyToken,
            yandexRequestedAmount
        });
    }

    paymentLogger.info('Para çekimi başlatıldı', {
        provider: 'internal', operation: 'withdrawal', tx,
        driver: driverId, park: parkName(parkPartnerId),
        amount: numAmount, grossAmount: yandexDeductAmount, currency: 'TRY'
    });

    // ── 2. ADIM: Yandex Bakiye Kesme (Önce Güvenlik) ───────────────────────────
    // Para bankadan çıkmadan önce Yandex cüzdanından düşüyoruz.
    // Eğer Yandex hata verirse (yetersiz bakiye, API hatası vb.) işlem burada durur.
    let yandexTransaction;
    if (!skipYandex) {
        try {
            yandexTransaction = await deductYandexBalance(
                driverId,
                -yandexDeductAmount, // Kesinti olduğu için eksi gönderilmeli
                parkPartnerId,
                'Para çekimi talebi',
                { tx, idempotencyToken: yandexIdempotencyToken }
            );
        } catch (yandexErr) {
            paymentLogger.error('Para çekimi Yandex aşamasında durduruldu', {
                provider: 'Yandex-Fleet', operation: 'deduct-balance', tx,
                driver: driverId, result: yandexErr.code === 'YANDEX_TRANSACTION_PENDING' ? 'pending' : 'failed',
                reason: yandexErr.message,
                durationMs: Date.now() - startedAt
            }, yandexErr);
            if (yandexErr.code === 'YANDEX_TRANSACTION_PENDING') {
                return { success: true, processing: true, transactionId: tx };
            }
            throw new Error('Yandex bakiyeniz düşülemediği için ödeme başlatılamadı: ' + yandexErr.message);
        }
    }

    const bankClaimed = await claimBankTransfer(tx);
    if (!bankClaimed) {
        paymentLogger.warn('UPT transferi başka bir yürütücü tarafından sahiplenildi', {
            provider: 'internal', operation: 'claim-bank-transfer', tx,
            driver: driverId, result: 'duplicate_suppressed'
        });
        return { success: true, processing: true, duplicateSuppressed: true, transactionId: tx };
    }

    // ── 3. ADIM: CorpSendRequest (Uption) ───────────────────────────────
    let tuRefNumber = null;
    try {
        const sendXml = buildSendRequestXml({
            beneficiaryName: beneficiaryName.trim(),
            beneficiarySurname: beneficiarySurname.trim(),
            beneficiaryIban: ibanClean,
            amount: numAmount,
            transactionId: tx
        });

        paymentLogger.info('Banka transferi başlatıldı', {
            provider: 'UPT', operation: 'create-transfer', tx,
            driver: driverId, amount: numAmount, currency: 'TRY'
        });
        let sendResult;
        try {
            // CorpSendRequest para oluşturan, idempotent olduğu belgelenmemiş bir çağrıdır.
            // Timeout/5xx sonrasında kör retry ikinci transfer üretebilir.
            sendResult = await postSoap(SOAP_ACTION_SEND, sendXml, { maxAttempts: 1 });
        } catch (error) {
            // Cevapsız ağ hatası veya 5xx durumunda UPT talebi işlemiş olabilir.
            // 4xx ise istek açıkça reddedilmiştir ve normal iade akışı güvenlidir.
            if (!error.httpStatus || error.httpStatus >= 500) {
                error.code = 'UPT_CREATE_UNKNOWN';
            }
            throw error;
        }
        tuRefNumber = extractTuRefNumber(sendResult.responseText);

        if (!tuRefNumber) {
            const sendParsed = parseResponse(sendResult.responseText);
            throw new Error(sendParsed.responseData || sendParsed.response || 'TU referans numarası alınamadı.');
        }

        // ── 4. ADIM: CorpSendRequestConfirm ───────────────────────
        const confirmXml = buildConfirmRequestXml(tuRefNumber);
        const confirmResult = await postSoap(SOAP_ACTION_CONFIRM, confirmXml);
        const confirmParsed = parseResponse(confirmResult.responseText);

        if (confirmParsed.response && confirmParsed.response !== '0' && confirmParsed.response.toLowerCase().includes('err')) {
            throw new Error(confirmParsed.responseData || confirmParsed.response || 'Transfer onayı başarısız.');
        }

        paymentLogger.info('Para çekimi bankaya iletildi', {
            provider: 'UPT', operation: 'confirm-transfer', tx,
            driver: driverId, bankRef: maskId(tuRefNumber, 8),
            amount: numAmount, currency: 'TRY', result: 'pending_bank',
            durationMs: Date.now() - startedAt
        });

        // BANKA SIRA KAYDI — nihai durum uptStatusService tarafından kontrol edilir
        // 'pending_bank': Uption sıraya aldı, banka henüz nihai sonucu dönmedi.
        // uptStatusService her 15 dk'da kontrol eder: TR010/011/012 → 'success',
        // TR005C/TR006 vb. → 'bank_returned' + Yandex iadesi otomatik yapılır.
        await savePaymentLog({
            driverId, beneficiaryName: `${beneficiaryName} ${beneficiarySurname}`,
            beneficiaryIban: ibanClean, amount: numAmount, grossAmount: yandexDeductAmount,
            tuRefNumber, status: 'pending_bank', parkPartnerId, transactionId: tx
        });

        return { success: true, tuRefNumber, transactionId: tx };

    } catch (paymentErr) {
        // UPT bir referans ürettiyse transfer artık var olabilir. Confirm çağrısının
        // hata vermesi veya cevabının kaybolması halinde Yandex'e otomatik iade yapmak
        // sürücüye hem banka ödemesi hem Yandex kredisi verebilir.
        if (paymentErr.code === 'UPT_CREATE_UNKNOWN' || tuRefNumber) {
            await savePaymentLog({
                driverId, beneficiaryName: `${beneficiaryName} ${beneficiarySurname}`,
                beneficiaryIban: ibanClean, amount: numAmount, grossAmount: yandexDeductAmount,
                tuRefNumber, status: 'bank_unknown', errorMessage: paymentErr.message,
                parkPartnerId, transactionId: tx
            });
            paymentLogger.error('KRİTİK: UPT sonucu belirsiz; otomatik tekrar ve Yandex iadesi yapılmadı', {
                provider: 'UPT', operation: tuRefNumber ? 'confirm-transfer' : 'create-transfer', tx,
                driver: driverId, result: 'manual_reconciliation_required',
                bankRef: tuRefNumber ? maskId(tuRefNumber, 8) : undefined,
                correspondentRef: tx, reason: paymentErr.message
            }, paymentErr, { dedupe: false });
            throw new Error('Banka transferi sonucu belirsiz. İşlem güvenli şekilde incelemeye alındı.');
        }

        paymentLogger.error('Banka transferi başarısız; Yandex iadesi başlatıldı', {
            provider: 'UPT', operation: 'create-or-confirm-transfer', tx,
            driver: driverId, result: 'failed', reason: paymentErr.message,
            durationMs: Date.now() - startedAt
        }, paymentErr);

        let status = 'error';
        let refundSuccess = false;
        const refundIdempotencyToken = stableIdempotencyToken('payment-failure-refund', tx);
        
        // İade işlemi kritik olduğu için geçici ağ hatalarına karşı 3 kez tekrar deniyoruz (Retry)
        for (let attempt = 1; attempt <= 3; attempt++) {
            try {
                await deductYandexBalance(
                    driverId,
                    yandexDeductAmount, // İade olduğu için artı (pozitif)
                    parkPartnerId,
                    'İADE: Ödeme hatası sebebiyle bakiye geri yüklendi',
                    { tx, idempotencyToken: refundIdempotencyToken }
                );
                paymentLogger.info('Yandex iadesi tamamlandı', {
                    provider: 'Yandex-Fleet', operation: 'refund-balance', tx,
                    driver: driverId, result: 'success', attempt
                });
                status = 'refunded';
                refundSuccess = true;
                break; // Başarılı olursa döngüden çık
            } catch (refundErr) {
                paymentLogger.error('Yandex iade denemesi başarısız', {
                    provider: 'Yandex-Fleet', operation: 'refund-balance', tx,
                    driver: driverId, result: 'failed', attempt: `${attempt}/3`, reason: refundErr.message
                }, refundErr);
                if (attempt < 3) await new Promise(res => setTimeout(res, 2000)); // 2 sn bekle
            }
        }

        if (!refundSuccess) {
            paymentLogger.error('KRİTİK: Yandex iadesi başarısız; manuel müdahale gerekiyor', {
                provider: 'Yandex-Fleet', operation: 'refund-balance', tx,
                driver: driverId, result: 'manual_action_required', attempts: 3
            }, paymentErr, { dedupe: false });
        }

        // HATA/İADE LOG
        await savePaymentLog({
            driverId, beneficiaryName: `${beneficiaryName} ${beneficiarySurname}`,
            beneficiaryIban: ibanClean, amount: numAmount, grossAmount: yandexDeductAmount,
            status, errorMessage: paymentErr.message, parkPartnerId, transactionId: tx
        });

        throw new Error('Ödeme sırasında banka hatası oluştu: ' + paymentErr.message);
    }
}

/**
 * Admin karari icin yeni banka transferi: CorpSendRequest + CorpSendRequestConfirm.
 * Iki cagri da tek deneme yapar (kor tekrar ikinci transfer uretebilir). Cagiran, ayni
 * correspondentRef ile once GetTransferList'e bakmali; varsa yeniden olusturmamali.
 */
async function createBankTransfer({ beneficiaryName, beneficiarySurname, beneficiaryIban, amount, correspondentRef }) {
    const iban = String(beneficiaryIban || '').replace(/\s/g, '').toUpperCase();
    if (!/^TR\d{24}$/.test(iban)) throw new Error('Geçerli bir TR IBAN bulunamadı.');
    const numAmount = Number(amount);
    if (!Number.isFinite(numAmount) || numAmount <= 0) throw new Error('Geçerli bir tutar bulunamadı.');
    const sendXml = buildSendRequestXml({ beneficiaryName, beneficiarySurname, beneficiaryIban: iban, amount: numAmount, transactionId: correspondentRef });
    const sendResult = await postSoap(SOAP_ACTION_SEND, sendXml, { maxAttempts: 1 });
    const tuRefNumber = extractTuRefNumber(sendResult.responseText);
    if (!tuRefNumber) {
        const parsed = parseResponse(sendResult.responseText);
        throw new Error(parsed.responseData || parsed.response || 'TU referans numarası alınamadı.');
    }
    const confirmResult = await postSoap(SOAP_ACTION_CONFIRM, buildConfirmRequestXml(tuRefNumber), { maxAttempts: 1 });
    const parsed = parseResponse(confirmResult.responseText);
    return { tuRefNumber, confirmed: parsed.response === 'Success', message: parsed.responseData || parsed.response || '' };
}

module.exports = {
    sendPayment,
    createBankTransfer,
    deductYandexBalance,
    claimBankTransfer,
    _test: { buildSendRequestXml, stableIdempotencyToken }
};
