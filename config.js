// Ortam değişkenlerini yükle (.env dosyasından)
require('dotenv').config();

const DEFAULT_YANDEX_BASE = 'https://fleet-api.taxi.yandex.net';

/**
 * Çoklu park: YANDEX_PARK_1_*, YANDEX_PARK_2_* ... (N artarak; PARTNER_ID boş kalana kadar)
 * Her park için: _NAME (opsiyonel), _PARTNER_ID (zorunlu), _CLIENT_ID (opsiyonel, yoksa taxi/park/<PARTNER_ID>), _API_KEY (zorunlu)
 */
function loadIndexedYandexParks(baseUrl) {
    const sources = [];
    for (let i = 1; i <= 64; i++) {
        const partnerId = (process.env[`YANDEX_PARK_${i}_PARTNER_ID`] || '').trim();
        if (!partnerId) break;

        const apiKey = (process.env[`YANDEX_PARK_${i}_API_KEY`] || '').trim();
        if (!apiKey) {
            console.warn(`[Config] YANDEX_PARK_${i}_PARTNER_ID tanımlı ama YANDEX_PARK_${i}_API_KEY eksik; park atlandı.`);
            continue;
        }

        const label = (process.env[`YANDEX_PARK_${i}_NAME`] || '').trim() || `Park ${i}`;
        let clientId = (process.env[`YANDEX_PARK_${i}_CLIENT_ID`] || '').trim();
        if (!clientId) clientId = `taxi/park/${partnerId}`;

        sources.push({
            label,
            clientId,
            apiKey,
            partnerId,
            baseUrl
        });
    }
    return sources;
}

/**
 * İndeksli park yoksa: klasik YANDEX_* + isteğe bağlı YANDEX_ADANA_*
 */
function loadLegacyYandexParks(baseUrl) {
    const mainId = process.env.YANDEX_CLIENT_ID;
    const mainKey = process.env.YANDEX_API_KEY;
    const mainPark = process.env.YANDEX_PARTNER_ID;
    const sources = [];

    if (mainId && mainKey && mainPark) {
        sources.push({
            label: process.env.YANDEX_PARK_NAME || 'Ana park',
            clientId: mainId,
            apiKey: mainKey,
            partnerId: mainPark,
            baseUrl
        });
    }

    const adanaParkId = (process.env.YANDEX_ADANA_PARTNER_ID || '').trim();
    if (adanaParkId) {
        sources.push({
            label: process.env.YANDEX_ADANA_NAME || 'Adana',
            clientId: (process.env.YANDEX_ADANA_CLIENT_ID || '').trim() || mainId,
            apiKey: (process.env.YANDEX_ADANA_API_KEY || '').trim() || mainKey,
            partnerId: adanaParkId,
            baseUrl
        });
    }

    return sources;
}

function buildYandexParkSources() {
    const baseUrl = process.env.YANDEX_BASE_URL || DEFAULT_YANDEX_BASE;
    const indexed = loadIndexedYandexParks(baseUrl);
    if (indexed.length > 0) return indexed;
    return loadLegacyYandexParks(baseUrl);
}

function buildPrimaryYandexFleet() {
    const baseUrl = process.env.YANDEX_BASE_URL || DEFAULT_YANDEX_BASE;
    const sources = buildYandexParkSources();
    if (sources.length > 0) {
        const p = sources[0];
        return {
            baseUrl,
            clientId: p.clientId,
            apiKey: p.apiKey,
            partnerId: p.partnerId,
            workRuleId: process.env.YANDEX_WORK_RULE_ID
        };
    }
    return {
        baseUrl,
        clientId: process.env.YANDEX_CLIENT_ID,
        apiKey: process.env.YANDEX_API_KEY,
        partnerId: process.env.YANDEX_PARTNER_ID,
        workRuleId: process.env.YANDEX_WORK_RULE_ID
    };
}

const primaryYandex = buildPrimaryYandexFleet();

/** Türkçe karakter duyarlı şehir anahtarı (eşleştirme için) */
function normalizeCityKey(s) {
    if (s == null || typeof s !== 'string') return '';
    return s.trim().toLocaleLowerCase('tr-TR').replace(/\s+/g, ' ');
}

/** Şehir → park: önce tam eşleşme, sonra gevşek (oturum city / env etiketi uyumsuzluğu) */
function findYandexParkByCity(cityInput) {
    const key = normalizeCityKey(cityInput);
    if (!key) return null;
    const sources = buildYandexParkSources();
    for (const src of sources) {
        if (normalizeCityKey(src.label) === key) return src;
    }
    const firstWord = key.split(' ')[0] || '';
    for (const src of sources) {
        const l = normalizeCityKey(src.label);
        if (!l) continue;
        if (key === l || key.startsWith(l + ' ') || l.startsWith(key + ' ')) return src;
        if (firstWord && (l === firstWord || l.startsWith(firstWord) || firstWord.startsWith(l))) return src;
    }
    return null;
}

function findYandexParkByPartnerId(partnerId) {
    if (!partnerId) return null;
    return buildYandexParkSources().find(s => s.partnerId === partnerId) || null;
}

// Yandex Fleet API Configuration
// Hassas değerler .env dosyasından okunur - asla buraya yazmayın!
const config = {
    yandexFleet: primaryYandex,
    normalizeCityKey,
    findYandexParkByCity,
    findYandexParkByPartnerId,
    /**
     * Export ve çoklu park: .env içinde YANDEX_PARK_1_*, _2_* ... veya eski YANDEX_* + isteğe bağlı YANDEX_ADANA_*
     */
    getYandexParkSources() {
        return buildYandexParkSources();
    },
    server: {
        port: process.env.PORT || 3000
    },
    // NetGSM OTP SMS API (auth için)
    netgsm: {
        baseUrl: process.env.NETGSM_BASE_URL || 'https://api.netgsm.com.tr',
        endpoint: '/sms/rest/v2/otp',
        username: process.env.NETGSM_USERNAME,
        usercode: process.env.NETGSM_USERCODE,
        msgheader: process.env.NETGSM_MSGHEADER || 'RISE LTD'
    },
    /**
     * Sadece local geliştirme: SMS olmadan sürücü oturumu (POST /api/auth/dev-session)
     * DEV_DRIVER_SESSION=true ve DEV_SESSION_SECRET (en az 16 karakter) gerekir.
     */
    devDriverSession: {
        enabled: process.env.DEV_DRIVER_SESSION === 'true',
        secret: (process.env.DEV_SESSION_SECRET || '').trim()
    }
};

/**
 * @returns {boolean}
 */
function isDevDriverSessionEnabled() {
    return (
        config.devDriverSession.enabled &&
        config.devDriverSession.secret.length >= 16
    );
}

config.isDevDriverSessionEnabled = isDevDriverSessionEnabled;

// Geliştirme ortamında eksik değişkenleri kontrol et
if (!config.yandexFleet.clientId || !config.yandexFleet.apiKey || !config.yandexFleet.partnerId) {
    console.warn('[Config] UYARI: Yandex Fleet kimlik bilgisi eksik.');
    console.warn('[Config] Ya YANDEX_PARK_1_PARTNER_ID / YANDEX_PARK_1_API_KEY ... ya da YANDEX_CLIENT_ID, YANDEX_API_KEY, YANDEX_PARTNER_ID tanımlayın.');
    console.warn('[Config] .env dosyasını .env.example\'dan oluşturup doldurun.');
}
if (!config.netgsm.username || !config.netgsm.usercode) {
    console.warn('[Config] UYARI: NETGSM_USERNAME veya NETGSM_USERCODE tanımlı değil. OTP SMS gönderilemeyecek.');
}
if (config.devDriverSession.enabled && config.devDriverSession.secret.length < 16) {
    console.warn(
        '[Config] DEV_DRIVER_SESSION açık ancak DEV_SESSION_SECRET en az 16 karakter olmalı. Dev oturum endpoint\'i devre dışı.'
    );
}
if (isDevDriverSessionEnabled()) {
    console.warn('[Config] DEV_DRIVER_SESSION aktif — yalnızca güvenilir ortamlarda kullanın. Üretimde kapatın.');
}

module.exports = config;
