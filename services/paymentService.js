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
    tuRefNumber, status, errorMessage, parkPartnerId
}) {
    if (!db.isConfigured()) return;
    try {
        await db.query(
            `INSERT INTO payment_logs 
            (driver_id, beneficiary_name, beneficiary_iban, amount, gross_amount, tu_ref_number, status, error_message, park_partner_id, updated_at)
            VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, NOW())`,
            [
                driverId,
                beneficiaryName,
                beneficiaryIban,
                amount,
                grossAmount,
                tuRefNumber || null,
                status,
                errorMessage || null,
                parkPartnerId || ''
            ]
        );
    } catch (err) {
        console.error('[PaymentService] Log yazma hatası:', err.message);
    }
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
function buildSendRequestXml({ beneficiaryName, beneficiarySurname, beneficiaryIban, amount }) {
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
        <tem:CORRESPONDENT_REF></tem:CORRESPONDENT_REF>
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
async function postSoap(soapAction, xmlBody) {
    let lastError;

    for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
        try {
            const resp = await axios.post(ENDPOINT, xmlBody, {
                headers: {
                    'Content-Type': 'text/xml; charset=utf-8',
                    'SOAPAction': `"${soapAction}"`
                },
                timeout: FETCH_TIMEOUT_MS,
                responseType: 'text',
                transformResponse: [data => data] // ham string
            });
            return { status: resp.status, statusText: resp.statusText, responseText: resp.data };
        } catch (error) {
            lastError = error;
            const status = error.response?.status;
            if (attempt < MAX_RETRIES && (!status || status >= 500)) {
                await new Promise(r => setTimeout(r, RETRY_DELAY_MS));
            }
        }
    }

    throw new Error(`Uption SOAP isteği ${MAX_RETRIES} denemede başarısız: ${lastError?.message || 'bilinmeyen hata'}`);
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
async function deductYandexBalance(driverId, amount, parkPartnerId, description = 'Para çekimi') {
    const src = parkPartnerId
        ? config.findYandexParkByPartnerId(parkPartnerId)
        : null;

    const baseUrl = (src?.baseUrl) || config.yandexFleet.baseUrl;
    const clientId = (src?.clientId) || config.yandexFleet.clientId;
    const apiKey = (src?.apiKey) || config.yandexFleet.apiKey;
    const parkId = (src?.partnerId) || config.yandexFleet.partnerId;

    const idempotencyToken = crypto.randomBytes(16).toString('hex');

    const body = {
        park_id: parkId,
        driver_profile_id: driverId,
        category_id: 'partner_service_manual', // is_creatable=true olan kategori
        amount: String(amount), // İşlemin negatif veya pozitif (iade) olmasına izin veriyoruz
        description
    };

    console.log(`[PaymentService] Yandex bakiye kesintisi: sürücü=${driverId} tutar=${amount} TRY park=${parkId}`);
    console.log(`[PaymentService] Transaction body:`, JSON.stringify(body));

    let resp;
    try {
        resp = await axios.post(
            `${baseUrl}/v2/parks/driver-profiles/transactions`,
            body,
            {
                headers: {
                    'X-Client-ID': clientId,
                    'X-API-Key': apiKey,
                    'X-Park-ID': parkId,
                    'X-Idempotency-Token': idempotencyToken,
                    'Content-Type': 'application/json',
                    'Accept-Language': 'tr'
                },
                timeout: 30000
            }
        );
    } catch (err) {
        // Yandex 400/403 hata detayını logla
        if (err.response) {
            console.error(`[PaymentService] Yandex transaction HTTP ${err.response.status}:`, JSON.stringify(err.response.data));
        }
        throw err;
    }

    return resp.data;
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
async function sendPayment({ driverId, beneficiaryName, beneficiarySurname, beneficiaryIban, amount, yandexAmount, parkPartnerId }) {
    // ── 1. Validasyon ────────────────────────────────────────────
    if (!beneficiaryName || !beneficiarySurname) throw new Error('Ad ve soyad zorunludur.');
    const ibanClean = String(beneficiaryIban || '').replace(/\s/g, '').toUpperCase();
    if (!/^TR\d{24}$/.test(ibanClean)) throw new Error('Geçerli bir TR IBAN giriniz.');
    const numAmount = parseFloat(amount);
    if (isNaN(numAmount) || numAmount <= 0) throw new Error('Geçerli bir tutar giriniz.');

    const yandexDeductAmount = yandexAmount || numAmount;

    // ── 2. ADIM: Yandex Bakiye Kesme (Önce Güvenlik) ───────────────────────────
    // Para bankadan çıkmadan önce Yandex cüzdanından düşüyoruz.
    // Eğer Yandex hata verirse (yetersiz bakiye, API hatası vb.) işlem burada durur.
    console.log(`[PaymentService] [GÜVENLİK] Önce bakiye düşülüyor: ${yandexDeductAmount} TRY`);
    let yandexTransaction;
    try {
        yandexTransaction = await deductYandexBalance(
            driverId,
            -yandexDeductAmount, // Kesinti olduğu için eksi gönderilmeli
            parkPartnerId,
            `Para çekimi talebi `
        );
        console.log(`[PaymentService] ✅ Yandex bakiye kesintisi başarılı. TransactionId: ${yandexTransaction.id}`);
    } catch (yandexErr) {
        console.error('[PaymentService] ❌ Yandex bakiye kesilemedi, ödeme iptal edildi:', yandexErr.message);
        throw new Error('Yandex bakiyeniz düşülemediği için ödeme başlatılamadı: ' + yandexErr.message);
    }

    // ── 3. ADIM: CorpSendRequest (Uption) ───────────────────────────────
    try {
        const sendXml = buildSendRequestXml({
            beneficiaryName: beneficiaryName.trim(),
            beneficiarySurname: beneficiarySurname.trim(),
            beneficiaryIban: ibanClean,
            amount: numAmount
        });

        console.log(`[PaymentService] CorpSendRequest başlatılıyor: ${ibanClean} | ${numAmount} TRY`);
        const sendResult = await postSoap(SOAP_ACTION_SEND, sendXml);
        const tuRefNumber = extractTuRefNumber(sendResult.responseText);

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

        console.log(`[PaymentService] 💰 Ödeme başarıyla tamamlandı. Ref: ${tuRefNumber}`);

        // BANKA SIRA KAYDI — nihai durum uptStatusService tarafından kontrol edilir
        // 'pending_bank': Uption sıraya aldı, banka henüz nihai sonucu dönmedi.
        // uptStatusService her 15 dk'da kontrol eder: TR010/011/012 → 'success',
        // TR005C/TR006 vb. → 'bank_returned' + Yandex iadesi otomatik yapılır.
        await savePaymentLog({
            driverId, beneficiaryName: `${beneficiaryName} ${beneficiarySurname}`,
            beneficiaryIban: ibanClean, amount: numAmount, grossAmount: yandexDeductAmount,
            tuRefNumber, status: 'pending_bank', parkPartnerId
        });

        return { success: true, tuRefNumber };

    } catch (paymentErr) {
        console.error('[PaymentService] ❌ Ödeme hatası! Kesilen bakiye iade edilmeye çalışılıyor...', paymentErr.message);

        let status = 'error';
        let refundSuccess = false;
        
        // İade işlemi kritik olduğu için geçici ağ hatalarına karşı 3 kez tekrar deniyoruz (Retry)
        for (let attempt = 1; attempt <= 3; attempt++) {
            try {
                await deductYandexBalance(
                    driverId,
                    yandexDeductAmount, // İade olduğu için artı (pozitif)
                    parkPartnerId,
                    `İADE: Ödeme hatası sebebiyle bakiye geri yüklendi`
                );
                console.log(`[PaymentService] 🔄 Bakiye başarıyla iade edildi.`);
                status = 'refunded';
                refundSuccess = true;
                break; // Başarılı olursa döngüden çık
            } catch (refundErr) {
                console.error(`[PaymentService] ⚠️ İade denemesi ${attempt} başarısız:`, refundErr.message);
                if (attempt < 3) await new Promise(res => setTimeout(res, 2000)); // 2 sn bekle
            }
        }

        if (!refundSuccess) {
            console.error('[PaymentService] 🚨 KRİTİK: 3 denemeye rağmen bakiye iade edilemedi! Manuel müdahale GEREKİYOR.');
        }

        // HATA/İADE LOG
        await savePaymentLog({
            driverId, beneficiaryName: `${beneficiaryName} ${beneficiarySurname}`,
            beneficiaryIban: ibanClean, amount: numAmount, grossAmount: yandexDeductAmount,
            status, errorMessage: paymentErr.message, parkPartnerId
        });

        throw new Error('Ödeme sırasında banka hatası oluştu: ' + paymentErr.message);
    }
}

module.exports = { sendPayment, deductYandexBalance };
