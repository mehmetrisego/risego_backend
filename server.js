// Sunucunun saat dilimini Türkiye (İstanbul) olarak ayarla
process.env.TZ = 'Europe/Istanbul';

require('dotenv').config();
// Express setup moved to app.js
const config = require('./config');
const yandexFleetApi      = require('./services/yandexFleetApi');
const leaderboardService  = require('./services/leaderboardService');
const authService = require('./services/authService');
const paymentService    = require('./services/paymentService');
const uptService        = require('./services/uptService');
const uptStatusService  = require('./services/uptStatusService');
const { requireAuth, requireAdminAuth, sessionParkPartnerId } = require('./middlewares/auth.middleware');

// Çekim cooldown artık DB'de tutulur (driver_profiles.last_withdraw_at)
// RAM map kaldırıldı — restart sonrası da korunur
const dbCampaigns = require('./db/campaigns');
const dbDriverBankAccounts = require('./db/driverBankAccounts');
const db = require('./db');
const { runMigrations } = require('./db/runMigrations');
const dbPaymentLogs = require('./db/paymentLogs');

const path = require('path');
const fsSync = require('fs');
const app = require('./app');
const cronManager = require('./jobs/cronManager');



// ─── KILLSWITCH (ACİL DURUM ANAHTARI) ──────────────────────────────────────
let suspendedCities = [];
// Durum başlangıçta startServer() içinde veritabanından yüklenecek.
// ──────────────────────────────────────────────────────────────────────────


// ─── CANLI ORTAM İYİLEŞTİRMELERİ (Stability & Error Handling) ──────────────

// 1. Beklenmedik hata yakalayıcılar (Unhandled Rejections / Uncaught Exceptions)
// Sunucunun herhangi bir asenkron hata yüzünden aniden kapanmasını engeller.
process.on('unhandledRejection', (reason, promise) => {
    console.error('[CRITICAL] Yakalanamayan Asenkron Hata (Unhandled Rejection):', reason);
});

process.on('uncaughtException', (error) => {
    console.error('[CRITICAL] Yakalanamayan İstisna (Uncaught Exception):', error);
    // Ciddi hatalarda sunucuyu kapatıp PM2/Railway gibi araçların restart atmasını sağlamak gerekebilir.
    // Ancak basit hatalarda sistemi ayakta tutmak için sadece logluyoruz.
});

// 2. Nazik Kapanış (Graceful Shutdown)
// Sunucu kapatılırken (deployment veya manuel stop) DB bağlantılarını ve cronları kapatır.
async function gracefulShutdown(signal) {
    console.log(`\n[Server] ${signal} sinyali alındı. Sunucu kapatılıyor...`);
    
    // Cron görevlerini durdur
    cronManager.stopAllCrons();

    // Veritabanı bağlantı havuzunu kapat
    if (db && typeof db.closePool === 'function') {
        await db.closePool();
    }

    console.log('[Server] Güvenli bir şekilde kapatıldı. Hoşça kalın!');
    process.exit(0);
}

process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
process.on('SIGINT', () => gracefulShutdown('SIGINT'));

// ─────────────────────────────────────────────────────────────────────────────

// Express middlewares moved to app.js

// customLeaderboardLimiter moved to driver.routes.js

// Admin and Public campaign route utilities moved to controllers

// Driver Auth Endpoints moved to routes/auth.routes.js

// Driver Endpoints moved to routes/driver.routes.js

/**
 * GET /api/health
 * Sunucu durumunu kontrol eder
 */
app.get('/api/health', async (req, res) => {
    try {
        const leaderboardStatus = await leaderboardService.getStatus();
        res.json({
            status:    'ok',
            service:   'RiseGo Backend - Yandex Fleet Sürücü Bilgi Sistemi',
            timestamp: new Date().toISOString(),
            leaderboard: leaderboardStatus
        });
    } catch (err) {
        res.json({
            status:    'ok',
            service:   'RiseGo Backend - Yandex Fleet Sürücü Bilgi Sistemi',
            timestamp: new Date().toISOString(),
            leaderboard: { ready: false, error: err.message }
        });
    }
});

// Admin endpoints moved to routes/admin.routes.js
// Public endpoints moved to routes/public.routes.js

// Sunucuyu başlat (DB migration sonrası)
const PORT = config.server.port;

/**
 * Yandex Fleet'teki tüm sürücüleri driver_profiles tablosuna ekler.
 * Mevcut kayıtlara dokunmaz — sadece eksik driver_id'leri ekler.
 * Telefon numarası olmayan sürücüler atlanır (phone NOT NULL UNIQUE kısıtı).
 */
async function syncDriverProfiles() {
    if (!db.isConfigured()) return;

    const parks = config.getYandexParkSources();
    let totalInserted = 0;
    let totalSkipped  = 0;
    let totalNoPhone  = 0;

    for (const park of parks) {
        try {
            console.log(`[DriverProfileSync] ${park.label} sürücüleri çekiliyor...`);
            const profiles = await yandexFleetApi.fetchDriverProfilesForParkSource(park);

            for (const profile of profiles) {
                const dp        = profile.driver_profile || profile;
                const drvId     = dp.id || dp.driver_profile_id;
                if (!drvId) continue;

                const firstName = (dp.first_name || '').trim();
                const lastName  = (dp.last_name  || '').trim();
                const phone     = Array.isArray(dp.phones) && dp.phones.length
                    ? String(dp.phones[0]).replace(/\D/g, '')  // sadece rakam
                    : null;

                // Telefonu olmayan sürücüleri atla (phone NOT NULL UNIQUE kısıtı)
                if (!phone) {
                    totalNoPhone++;
                    continue;
                }

                const car = profile.car || {};
                const carId = car.id || null;
                const carNumber = car.number || null;
                const carText = car.number
                    ? `${car.brand || ''} ${car.model || ''} (${car.year || ''}) - Plaka: ${car.number}`
                    : 'Araç atanmamış';

                try {
                    const result = await db.query(
                        `INSERT INTO driver_profiles
                              (driver_id, phone, first_name, last_name, park_partner_id, car_id, car_number, car_name, created_at, updated_at)
                          VALUES ($1, $2, $3, $4, $5, $6, $7, $8, NOW(), NOW())
                          ON CONFLICT (driver_id) DO UPDATE SET
                              phone = EXCLUDED.phone,
                              first_name = EXCLUDED.first_name,
                              last_name = EXCLUDED.last_name,
                              park_partner_id = EXCLUDED.park_partner_id,
                              car_id = EXCLUDED.car_id,
                              car_number = EXCLUDED.car_number,
                              car_name = EXCLUDED.car_name,
                              updated_at = NOW()`,
                        [drvId, phone, firstName, lastName, park.partnerId, carId, carNumber, carText]
                    );
                    if (result.rowCount > 0) totalInserted++;
                    else totalSkipped++;
                } catch (insertErr) {
                    // Aynı telefon numarası farklı driver_id ile zaten kayıtlı — atla
                    totalSkipped++;
                }
            }

            console.log(`[DriverProfileSync] ${park.label}: ${profiles.length} profil işlendi.`);
        } catch (err) {
            console.warn(`[DriverProfileSync] ${park.label} hata:`, err.message);
        }
    }

    console.log(
        `[DriverProfileSync] Tamamlandı: ${totalInserted} eklendi, ` +
        `${totalSkipped} zaten mevcuttu, ${totalNoPhone} telefonsuz atlandı.`
    );
}

async function startServer() {
    if (db.isConfigured()) {
        const connected = await db.testConnection();
        if (connected) {
            await runMigrations();

            // Killswitch durumunu veritabanından yükleyelim
            try {
                const ksResult = await db.query("SELECT value FROM system_settings WHERE key = 'suspended_cities'");
                if (ksResult.rows.length > 0) {
                    try {
                        suspendedCities = JSON.parse(ksResult.rows[0].value);
                        if (!Array.isArray(suspendedCities)) suspendedCities = [];
                    } catch (e) {
                        suspendedCities = [];
                    }
                    console.log(`[Server] Killswitch durumu veritabanından yüklendi. Askıdaki şehirler: ${suspendedCities.join(', ')}`);
                } else {
                    await db.query("INSERT INTO system_settings (key, value) VALUES ('suspended_cities', '[]') ON CONFLICT (key) DO NOTHING");
                }
            } catch (ksErr) {
                console.error('[Server] Killswitch durumu veritabanından okunamadı:', ksErr.message);
            }
            try {
                const mainPid = config.yandexFleet.partnerId;
                if (mainPid) {
                    await db.query(
                        `UPDATE campaigns SET park_partner_id = $1 WHERE park_partner_id IS NULL`,
                        [mainPid]
                    );
                }
            } catch (e) {
                console.warn('[DB] campaigns park_partner_id backfill:', e.message);
            }

            // driver_profiles tablosunu Yandex'ten gelen verilerle doldur (eksikleri ekle)
            syncDriverProfiles().catch(e =>
                console.warn('[DB] driver_profiles sync hatası:', e.message)
            );
        }
    }

    app.listen(PORT, '0.0.0.0', () => {
        console.log('='.repeat(50));
        console.log(`  RiseGo Backend - Yandex Fleet Sürücü Sistemi`);
        console.log(`  Sunucu http://0.0.0.0:${PORT} adresinde çalışıyor`);
        console.log(`  Yerel ağ erişimi: http://192.168.1.102:${PORT}/api`);
        console.log(`  Veritabanı: ${db.isConfigured() ? 'PostgreSQL (aktif)' : 'Bellek (fallback)'}`);
        console.log('='.repeat(50));
        console.log('\nKullanılabilir endpointler:');
        console.log(`  GET  http://localhost:${PORT}/                    - API bilgisi`);
        console.log(`  GET  http://localhost:${PORT}/api/health          - Sunucu durumu`);
        console.log(`  POST http://localhost:${PORT}/api/auth/login      - Giriş (telefon + şehir)`);
        console.log(`  POST http://localhost:${PORT}/api/auth/verify-otp - OTP doğrulama`);
        console.log(`  POST http://localhost:${PORT}/api/drivers/trip-count - Dönem bazlı yolculuk sayısı`);
        console.log(`  GET  http://localhost:${PORT}/api/drivers         - Detaylı sürücü bilgileri`);
        console.log(`  GET  http://localhost:${PORT}/api/drivers/fetch   - Hızlı sürücü profilleri`);
        console.log('');

        cronManager.startAllCrons();
    });
}

startServer().catch(err => {
    console.error('[Server] Başlatma hatası:', err);
    process.exit(1);
});


