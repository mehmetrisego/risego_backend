/**
 * services/uptService.js
 * Uption (Aktif Bank) SOAP API üzerinden kurum bakiyesini sorgular.
 * kontrol.js referans alınmıştır; o dosyaya dokunulmamıştır.
 */
const axios = require('axios');


const ENDPOINT        = process.env.UPTION_ENDPOINT;
const SOAP_ACTION_BAL = 'http://tempuri.org/GetAccountBalance';
const USERNAME        = process.env.UPTION_USERNAME;
const PASSWORD        = process.env.UPTION_PASSWORD;

/** XML parse yardımcısı: tüm eşleşmeleri döner */
function extractTagValues(xml, tagName) {
    const regex = new RegExp(
        `<(?:[\\w.-]+:)?${tagName}\\b[^>]*>([\\s\\S]*?)<\\/(?:[\\w.-]+:)?${tagName}>`,
        'gi'
    );
    const values = [];
    for (const match of xml.matchAll(regex)) values.push(match[1].trim());
    return values;
}

/** CurrencyBalance bloklarını parse eder */
function extractBalances(xml) {
    const blockRx   = /<(?:[\w.-]+:)?CurrencyBalance\b[^>]*>([\s\S]*?)<\/(?:[\w.-]+:)?CurrencyBalance>/gi;
    const currencyRx = /<(?:[\w.-]+:)?Currency\b[^>]*>([\s\S]*?)<\/(?:[\w.-]+:)?Currency>/i;
    const balanceRx  = /<(?:[\w.-]+:)?Balance\b[^>]*>([\s\S]*?)<\/(?:[\w.-]+:)?Balance>/i;

    const items = [];
    for (const match of xml.matchAll(blockRx)) {
        const block = match[1];
        const cm = currencyRx.exec(block);
        const bm = balanceRx.exec(block);
        items.push({
            currency: cm ? cm[1].trim() : 'UNKNOWN',
            balance:  bm ? bm[1].trim() : ''
        });
    }
    return items;
}

/** SOAP isteği gönderir (axios ile, kontrol.js mantığı korundu) */
async function postSoap(xmlBody) {
    const response = await axios.post(ENDPOINT, xmlBody, {
        headers: {
            'Content-Type': 'text/xml; charset=utf-8',
            SOAPAction: `"${SOAP_ACTION_BAL}"`
        },
        timeout: 30000
    });
    return response.data;
}

/**
 * UPT kurumsal cüzdan bakiyesini sorgular.
 * @returns {{ success: boolean, balances: Array<{currency, balance}>, tryBalance: number|null, raw: string }}
 */
async function getUptBalance() {
    const xml = `<?xml version="1.0" encoding="utf-8"?>
<soapenv:Envelope xmlns:soapenv="http://schemas.xmlsoap.org/soap/envelope/" xmlns:tem="http://tempuri.org/">
  <soapenv:Header>
    <tem:WsSystemUserInfo>
      <tem:Username>${USERNAME}</tem:Username>
      <tem:Password>${PASSWORD}</tem:Password>
    </tem:WsSystemUserInfo>
  </soapenv:Header>
  <soapenv:Body>
    <tem:GetAccountBalance>
      <tem:request>
        <tem:CurrencyName></tem:CurrencyName>
      </tem:request>
    </tem:GetAccountBalance>
  </soapenv:Body>
</soapenv:Envelope>`;

    try {
        const responseText = await postSoap(xml);
        const balances = extractBalances(responseText);

        // TRY/TL bakıyesini bul — ham string’i koru ("4.982,00" formatı)
        const tryEntry      = balances.find(b => b.currency === 'TRY' || b.currency === 'TL');
        const tryBalanceRaw = tryEntry ? tryEntry.balance : null;          // "4.982,00"

        const responses = extractTagValues(responseText, 'RESPONSE');
        const isSuccess = responses.length === 0 || responses[0] === 'Success' || responses[0] === '';

        return { success: isSuccess, balances, tryBalanceRaw, raw: responseText };
    } catch (err) {
        console.error('[UptService] Bakiye sorgu hatası:', err.message);
        return { success: false, balances: [], tryBalance: null, error: err.message };
    }
}

module.exports = { getUptBalance };
