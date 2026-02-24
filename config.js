// Ortam değişkenlerini yükle (.env dosyasından)
require('dotenv').config();

// Yandex Fleet API Configuration
// Hassas değerler .env dosyasından okunur - asla buraya yazmayın!
const config = {
    yandexFleet: {
        baseUrl: process.env.YANDEX_BASE_URL || 'https://fleet-api.taxi.yandex.net',
        clientId: process.env.YANDEX_CLIENT_ID,
        apiKey: process.env.YANDEX_API_KEY,
        partnerId: process.env.YANDEX_PARTNER_ID
    },
    server: {
        port: process.env.PORT || 3000
    }
};

// Geliştirme ortamında eksik değişkenleri kontrol et
if (!config.yandexFleet.clientId || !config.yandexFleet.apiKey || !config.yandexFleet.partnerId) {
    console.warn('[Config] UYARI: YANDEX_CLIENT_ID, YANDEX_API_KEY veya YANDEX_PARTNER_ID tanımlı değil.');
    console.warn('[Config] .env dosyasını .env.example\'dan oluşturup doldurun.');
}

module.exports = config;
