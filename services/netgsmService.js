/**
 * NetGSM OTP SMS Servisi
 *
 * NetGSM OTP API: https://www.netgsm.com.tr/dokuman/#otp-sms
 * Endpoint: POST https://api.netgsm.com.tr/sms/rest/v2/otp
 *
 * Güvenlik: Tüm hassas bilgiler .env üzerinden okunur.
 */

const axios = require('axios');

const config = require('../config');

// NetGSM hata kodları (dokümantasyondan)
const ERROR_CODES = {
    '20': 'Mesaj metni hatası veya karakter limiti aşıldı',
    '30': 'Geçersiz kullanıcı adı/şifre veya API erişim izni yok',
    '40': 'Mesaj başlığı sistemde tanımlı değil',
    '50': 'IYS kontrollü gönderim yapılamaz',
    '51': 'IYS marka bilgisi bulunamadı',
    '60': 'Belirtilen JobID bulunamadı',
    '70': 'Geçersiz parametre veya eksik alan',
    '80': 'Gönderim limiti aşıldı',
    '85': 'Aynı numaraya 1 dakikada 20\'den fazla görev oluşturulamaz',
};

/**
 * Telefon numarasını NetGSM formatına çevirir (5XXXXXXXXX)
 * @param {string} phone - +905061283492 veya 5061283492 vb.
 * @returns {string} 5XXXXXXXXX formatında numara
 */
function formatPhoneForNetgsm(phone) {
    if (!phone || typeof phone !== 'string') return '';
    const digits = phone.replace(/\D/g, '');
    // +90 ile başlıyorsa 90'ı kaldır
    if (digits.startsWith('90') && digits.length >= 12) {
        return digits.substring(2);
    }
    if (digits.startsWith('0') && digits.length === 11) {
        return digits.substring(1);
    }
    return digits;
}

/**
 * NetGSM OTP SMS gönderir
 * @param {string} phone - Alıcı telefon numarası
 * @param {string} message - OTP mesajı (max 160 karakter)
 * @returns {Promise<{success: boolean, jobId?: string, error?: string}>}
 */
async function sendOtpSms(phone, message) {
    const netgsm = config.netgsm;
    if (!netgsm?.username || !netgsm?.usercode || !netgsm?.msgheader) {
        console.error('[NetGSM] Konfigürasyon eksik. .env dosyasında NETGSM_USERNAME, NETGSM_USERCODE, NETGSM_MSGHEADER tanımlı olmalı.');
        return { success: false, error: 'SMS servisi yapılandırılmamış.' };
    }

    const formattedPhone = formatPhoneForNetgsm(phone);
    if (formattedPhone.length < 10 || !formattedPhone.startsWith('5')) {
        console.error('[NetGSM] Geçersiz telefon formatı:', phone);
        return { success: false, error: 'Geçersiz telefon numarası.' };
    }

    if (!message || message.length > 160) {
        return { success: false, error: 'Mesaj 1-160 karakter olmalıdır.' };
    }

    const url = `${netgsm.baseUrl}${netgsm.endpoint}`;
    const authToken = Buffer.from(`${netgsm.username}:${netgsm.usercode}`).toString('base64');

    const payload = {
        msgheader: netgsm.msgheader,
        msg: message,
        no: formattedPhone,
    };

    try {
        const response = await axios.post(url, payload, {
            headers: {
                'Content-Type': 'application/json',
                Authorization: `Basic ${authToken}`,
            },
            timeout: 10000,
        });

        const data = response.data;
        if (data?.code === '00') {
            return { success: true, jobId: data.jobId || data.jobid };
        }

        const errMsg = ERROR_CODES[data?.code] || data?.description || 'Bilinmeyen hata';
        console.error('[NetGSM] API hatası:', data?.code, errMsg);
        return { success: false, error: errMsg };
    } catch (error) {
        if (error.response?.data) {
            const code = error.response.data?.code;
            const errMsg = ERROR_CODES[code] || error.response.data?.description || 'API hatası';
            console.error('[NetGSM] API hatası:', code, errMsg);
            return { success: false, error: errMsg };
        }
        console.error('[NetGSM] Bağlantı hatası:', error.message);
        return { success: false, error: 'SMS gönderilemedi. Lütfen tekrar deneyin.' };
    }
}

module.exports = {
    sendOtpSms,
    formatPhoneForNetgsm,
};
