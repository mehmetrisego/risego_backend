'use strict';
/**
 * services/uptStatusService.js
 *
 * Uption (Aktif Bank) işlem durum takip ve otomatik Yandex iade servisi.
 *
 * Görev:
 *   - payment_logs'taki 'pending_bank' kayıtlarını periyodik olarak Uption'dan sorgular.
 *   - TR010/011/012 → 'success' olarak günceller.
 *   - TR005C/TR006 vb. iptal kodları → iade nedenini alır, Yandex'e geri yükler, 'bank_returned' kaydeder.
 *   - Hâlâ işlemde olanları (TR000, TR001 vb.) bir sonraki döngüye bırakır.
 */

const axios = require('axios');
const db = require('../db');
const { deductYandexBalance } = require('./paymentService');

const ENDPOINT = process.env.UPTION_ENDPOINT
    || 'https://upt.aktifbank.com.tr/ISV/TU/WebServices/V1_6/CorpService.asmx';
const USERNAME = process.env.UPTION_USERNAME;
const PASSWORD = process.env.UPTION_PASSWORD;

/** Kaç dakika geçtikten sonra sorgulanmaya başlasın (EFT genellikle 5-30 dk) */
const MIN_AGE_MINUTES = 10;

// ─── Uption Durum Kodu Kümeleri ──────────────────────────────────────────────

/** Bu kodlar geldiğinde işlem KESİNLEŞMİŞ (başarılı) sayılır */
const FINAL_SUCCESS_CODES = new Set(['TR010', 'TR011', 'TR012', 'PA010', 'PA012']);

/** Bu kodlar geldiğinde işlem İPTAL / İADE edilmiş sayılır */
const FINAL_CANCEL_CODES = new Set([
    'TR005C', // Gönderim İptal Edildi - Dekont Basıldı
    'TR006',  // Gönderim Onay Red Edildi (Para iadesi Bekleniyor)
    'TR007',  // Gönderim (Red) Para iadesi Yapıldı
    'TR003R', // Gönderim İade Tamamlandı
    'IT004C', // İade Gönderim İptal Edildi
    'PA004C', // Ödeme İptal Edildi
    'PA005C', // Ödeme İptal Edildi - Dekont Basıldı
    'PA006C', // Ödeme İptal Red Edildi
]);

// ─── İade Neden Kodu → Türkçe Açıklama Haritası ─────────────────────────────

const RETURN_REASON_MAP = {
    '01': 'Alıcı hesabı kapalı',
    '02': 'Alıcı hesap numarası hatalı veya bulunamadı',
    '03': 'Hesap türü uyumsuz',
    '04': 'İşlem limiti aşıldı',
    '05': 'Alıcı tarafından işlem reddedildi',
    '06': 'IBAN format hatası',
    '07': 'Banka şubesi bulunamadı',
    '08': 'İşlem zaman aşımına uğradı',
    '09': 'Teknik hata (banka sistemi)',
    '10': 'Alıcı hesabı para almaya kapalı',
    '11': 'Alıcı adı ve IBAN bilgisi uyuşmuyor',
    '12': 'IBAN geçersiz veya hatalı',
    '13': 'Alıcı hesabı bloke',
    '14': 'Yetersiz hesap bilgisi',
    '15': 'İşlem tutarı geçersiz',
};

function getReturnReasonText(code) {
    if (!code) return 'Banka tarafından işlem iade edildi';
    return RETURN_REASON_MAP[String(code)] || `Banka iadesi (Kod: ${code})`;
}

// ─── XML Tag Ayıklayıcı ──────────────────────────────────────────────────────

function extractTag(xml, tagName) {
    const regex = new RegExp(
        `<(?:[\\w.-]+:)?${tagName}\\b[^>]*>([\\s\\S]*?)<\\/(?:[\\w.-]+:)?${tagName}>`,
        'i'
    );
    const match = xml.match(regex);
    return match ? match[1].trim() : null;
}

// ─── SOAP POST ────────────────────────────────────────────────────────────────

async function postSoap(soapAction, xml) {
    const resp = await axios.post(ENDPOINT, xml, {
        headers: {
            'Content-Type': 'text/xml; charset=utf-8',
            'SOAPAction': `"${soapAction}"`
        },
        timeout: 30000,
        responseType: 'text',
        transformResponse: [d => d]
    });
    return resp.data;
}

// ─── Uption: İşlem Durumu Sorgula ────────────────────────────────────────────

async function queryTransferStatus(tuRefNumber) {
    const xml = `<?xml version="1.0" encoding="utf-8"?>
<soapenv:Envelope xmlns:soapenv="http://schemas.xmlsoap.org/soap/envelope/" xmlns:tem="http://tempuri.org/">
  <soapenv:Header>
    <tem:WsSystemUserInfo>
      <tem:Username>${USERNAME}</tem:Username>
      <tem:Password>${PASSWORD}</tem:Password>
    </tem:WsSystemUserInfo>
  </soapenv:Header>
  <soapenv:Body>
    <tem:GetTransferList>
      <tem:obj>
        <tem:UPTREF>${tuRefNumber}</tem:UPTREF>
      </tem:obj>
    </tem:GetTransferList>
  </soapenv:Body>
</soapenv:Envelope>`;

    const responseText = await postSoap('http://tempuri.org/GetTransferList', xml);
    const response = extractTag(responseText, 'RESPONSE');

    if (response !== 'Success') {
        return { found: false, statusCode: null };
    }

    const statusCode = extractTag(responseText, 'STATUS');
    return { found: true, statusCode };
}

// ─── Uption: İade Nedeni Sorgula ─────────────────────────────────────────────

async function queryRefundReason(tuRefNumber) {
    const xml = `<?xml version="1.0" encoding="utf-8"?>
<soapenv:Envelope xmlns:soapenv="http://schemas.xmlsoap.org/soap/envelope/" xmlns:tem="http://tempuri.org/">
  <soapenv:Header>
    <tem:WsSystemUserInfo>
      <tem:Username>${USERNAME}</tem:Username>
      <tem:Password>${PASSWORD}</tem:Password>
    </tem:WsSystemUserInfo>
  </soapenv:Header>
  <soapenv:Body>
    <tem:GetRefundTransferList>
      <tem:obj>
        <tem:UPTREF>${tuRefNumber}</tem:UPTREF>
      </tem:obj>
    </tem:GetRefundTransferList>
  </soapenv:Body>
</soapenv:Envelope>`;

    const responseText = await postSoap('http://tempuri.org/GetRefundTransferList', xml);
    return extractTag(responseText, 'RETURN_REASON_CODE');
}

// ─── Tek Bir Kaydı İşle ──────────────────────────────────────────────────────

/**
 * Bir payment_logs kaydını Uption'dan sorgular ve durumuna göre günceller.
 * @param {Object} row - payment_logs satırı
 */
async function processSinglePayment(row) {
    const { id, driver_id, tu_ref_number, gross_amount, park_partner_id } = row;

    // ── 1. Banka durumunu sorgula
    let found, statusCode;
    try {
        ({ found, statusCode } = await queryTransferStatus(tu_ref_number));
    } catch (err) {
        console.error(`[UptStatus] Ref ${tu_ref_number} sorgulanamadı:`, err.message);
        return;
    }

    // Her halükarda son kontrol zamanını ve kodu güncelle
    await db.query(
        `UPDATE payment_logs
         SET bank_status_code = $1, bank_status_checked_at = NOW()
         WHERE id = $2`,
        [statusCode, id]
    );

    if (!found) {
        console.warn(`[UptStatus] Ref ${tu_ref_number} banka sisteminde bulunamadı.`);
        return;
    }

    // ── 2. Nihai başarı
    if (FINAL_SUCCESS_CODES.has(statusCode)) {
        await db.query(
            `UPDATE payment_logs
             SET status = 'success', bank_status_code = $1, bank_status_checked_at = NOW()
             WHERE id = $2`,
            [statusCode, id]
        );
        console.log(`[UptStatus] ✅ Ref ${tu_ref_number} başarıyla tamamlandı. Kod: ${statusCode}`);
        return;
    }

    // ── 3. Banka iade / iptal etti
    if (FINAL_CANCEL_CODES.has(statusCode)) {
        // İade nedenini öğren
        let returnReasonCode = null;
        try {
            returnReasonCode = await queryRefundReason(tu_ref_number);
        } catch (err) {
            console.warn(`[UptStatus] İade nedeni alınamadı (${tu_ref_number}):`, err.message);
        }

        const returnReasonText = getReturnReasonText(returnReasonCode);
        const errorMessage = `Banka iadesi — ${returnReasonText}`;

        console.log(`[UptStatus] ❌ Ref ${tu_ref_number} iade edildi: ${errorMessage}`);

        // Yandex'e geri yükle (pozitif tutar = iade)
        let yandexRefundSuccess = false;
        for (let attempt = 1; attempt <= 3; attempt++) {
            try {
                await deductYandexBalance(
                    driver_id,
                    parseFloat(gross_amount), // Pozitif = para geri ekleme
                    park_partner_id,
                    `İADE: ${returnReasonText}`
                );
                yandexRefundSuccess = true;
                console.log(`[UptStatus] 🔄 Yandex iadesi başarılı (Deneme ${attempt}). Sürücü: ${driver_id}`);
                break;
            } catch (refundErr) {
                console.error(`[UptStatus] ⚠️ Yandex iadesi denemesi ${attempt}/3 başarısız:`, refundErr.message);
                if (attempt < 3) await new Promise(r => setTimeout(r, 3000));
            }
        }

        // DB'yi güncelle
        const finalErrorMsg = yandexRefundSuccess
            ? errorMessage
            : `KRİTİK — YANDEX İADESİ BAŞARISIZ — ${errorMessage}`;

        await db.query(`
            UPDATE payment_logs
            SET status                 = 'bank_returned',
                return_reason_code     = $1,
                error_message          = $2,
                bank_status_code       = $3,
                bank_status_checked_at = NOW(),
                yandex_refund_at       = $4
            WHERE id = $5
        `, [
            returnReasonCode,
            finalErrorMsg,
            statusCode,
            yandexRefundSuccess ? new Date() : null,
            id
        ]);

        if (!yandexRefundSuccess) {
            console.error(`[UptStatus] 🚨 KRİTİK: id=${id} için Yandex iadesi 3 denemede de başarısız oldu! Manuel müdahale gerekiyor.`);
        }
        return;
    }

    // ── 4. Hâlâ işlemde (TR000, TR001, TR004, TR008 vb.) → bekle
    console.log(`[UptStatus] ⏳ Ref ${tu_ref_number} hâlâ işlemde. Kod: ${statusCode}`);
}

// ─── Ana Fonksiyon: Tüm Bekleyenleri Kontrol Et ──────────────────────────────

/**
 * DB'deki 'pending_bank' kayıtlarını toplu kontrol eder.
 * Her 15 dakikada bir çağrılmak üzere tasarlanmıştır.
 */
async function checkPendingPayments() {
    if (!db.isConfigured()) return;

    let rows;
    try {
        const result = await db.query(`
            SELECT id, driver_id, tu_ref_number, gross_amount, park_partner_id, created_at
            FROM payment_logs
            WHERE status = 'pending_bank'
              AND tu_ref_number IS NOT NULL
              AND created_at < NOW() - INTERVAL '${MIN_AGE_MINUTES} minutes'
            ORDER BY created_at ASC
            LIMIT 50
        `);
        rows = result.rows;
    } catch (err) {
        console.error('[UptStatus] Bekleyen kayıtlar sorgulanamadı:', err.message);
        return;
    }

    if (rows.length === 0) {
        console.log('[UptStatus] Kontrol edilecek bekleyen işlem yok.');
        return;
    }

    console.log(`[UptStatus] ${rows.length} bekleyen işlem kontrol ediliyor...`);

    for (const row of rows) {
        try {
            await processSinglePayment(row);
            // Rate limiting — Uption API'ye çok hızlı istek atmamak için
            await new Promise(r => setTimeout(r, 500));
        } catch (err) {
            console.error(`[UptStatus] İşlem hatası (id=${row.id}):`, err.message);
        }
    }

    console.log('[UptStatus] Kontrol tamamlandı.');
}

/**
 * GetRefundTransferList kullanarak son 2 gündeki tüm iadeleri toplu çeker.
 * Başarılı sanılıp sonradan iade edilen (banka itirazı) işlemleri yakalar.
 */
async function syncRefundsFromBank() {
    if (!db.isConfigured()) return;
    try {
        console.log('[UptStatus] Toplu iade kontrolü (syncRefundsFromBank) başlatıldı...');
        
        const endD = new Date();
        const startD = new Date();
        startD.setDate(endD.getDate() - 2); // Son 2 gün
        
        const fmt = (d) => d.toISOString().split('T')[0];
        const beginDate = fmt(startD);
        const endDate = fmt(endD);

        const xml = `<?xml version="1.0" encoding="utf-8"?>
<soapenv:Envelope xmlns:soapenv="http://schemas.xmlsoap.org/soap/envelope/" xmlns:tem="http://tempuri.org/">
  <soapenv:Header>
    <tem:WsSystemUserInfo>
      <tem:Username>${USERNAME}</tem:Username>
      <tem:Password>${PASSWORD}</tem:Password>
    </tem:WsSystemUserInfo>
  </soapenv:Header>
  <soapenv:Body>
    <tem:GetRefundTransferList>
      <tem:obj>
        <tem:BEGINTRANSACTIONDATE>${beginDate}</tem:BEGINTRANSACTIONDATE>
        <tem:ENDTRANSACTIONDATE>${endDate}</tem:ENDTRANSACTIONDATE>
      </tem:obj>
    </tem:GetRefundTransferList>
  </soapenv:Body>
</soapenv:Envelope>`;

        const responseText = await postSoap('http://tempuri.org/GetRefundTransferList', xml);
        
        // Regex ile tüm itemleri bul
        const regex = /<WSGetRefundTransferItem>(.*?)<\/WSGetRefundTransferItem>/gs;
        let match;
        let refundCount = 0;
        
        while ((match = regex.exec(responseText)) !== null) {
            const item = match[1];
            const uptRefMatch = item.match(/<UPTREF>(.*?)<\/UPTREF>/);
            const reasonMatch = item.match(/<RETURN_REASON_CODE>(.*?)<\/RETURN_REASON_CODE>/);
            
            if (uptRefMatch && uptRefMatch[1]) {
                const tuRefNumber = uptRefMatch[1];
                const returnReasonCode = reasonMatch ? reasonMatch[1] : '99';
                
                // Bu ref numarasıyla bizde bank_returned olmayan kayıt var mı?
                const dbRes = await db.query(
                    `SELECT * FROM payment_logs WHERE tu_ref_number = $1 AND status != 'bank_returned'`,
                    [tuRefNumber]
                );
                
                if (dbRes.rows.length > 0) {
                    // İşlenmemiş bir iade bulduk!
                    refundCount++;
                    console.log(`[UptStatus] Sonradan iade tespit edildi (Ref: ${tuRefNumber}). Durum güncelleniyor...`);
                    
                    // Sahte bir processSinglePayment simülasyonu için geçici row objesi
                    // processSinglePayment TR005C gördüğünde iade işlemini tetikler.
                    const fakeRow = { ...dbRes.rows[0] };
                    
                    const returnReasonText = getReturnReasonText(returnReasonCode);
                    const finalErrorMsg = `Banka iadesi: ${returnReasonText}`;
                    
                    let yandexRefundSuccess = false;
                    for (let attempt = 1; attempt <= 3; attempt++) {
                        try {
                            await deductYandexBalance(
                                fakeRow.driver_id,
                                parseFloat(fakeRow.gross_amount), 
                                fakeRow.park_partner_id,
                                `İADE: ${returnReasonText}`
                            );
                            console.log(`[UptStatus] 🔄 Gecikmeli iade (Ref ${tuRefNumber}): Bakiye başarıyla geri yüklendi.`);
                            yandexRefundSuccess = true;
                            break;
                        } catch (err) {
                            console.error(`[UptStatus] ⚠️ Gecikmeli iade denemesi ${attempt} başarısız (Ref ${tuRefNumber}):`, err.message);
                            if (attempt < 3) await new Promise(res => setTimeout(res, 2000));
                        }
                    }
                    
                    await db.query(`
                        UPDATE payment_logs 
                        SET status = 'bank_returned',
                            return_reason_code = $1,
                            error_message = $2,
                            bank_status_code = 'TR005C',
                            yandex_refund_at = $3,
                            updated_at = NOW()
                        WHERE id = $4
                    `, [
                        returnReasonCode,
                        finalErrorMsg,
                        yandexRefundSuccess ? new Date() : null,
                        fakeRow.id
                    ]);
                }
            }
        }
        
        console.log(`[UptStatus] Toplu iade kontrolü bitti. Yeni tespit edilen iade sayısı: ${refundCount}`);
        
    } catch (err) {
        console.error('[UptStatus] Toplu iade kontrolü hatası:', err.message);
    }
}

module.exports = {
    checkPendingPayments,
    processSinglePayment,
    syncRefundsFromBank,
    getReturnReasonText,
    RETURN_REASON_MAP,
    FINAL_SUCCESS_CODES,
    FINAL_CANCEL_CODES
};
