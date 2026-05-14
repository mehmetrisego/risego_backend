// Sunucunun saat dilimini Türkiye (İstanbul) olarak ayarla
process.env.TZ = 'Europe/Istanbul';

require('dotenv').config();
const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');

const config = require('./config');
const yandexFleetApi      = require('./services/yandexFleetApi');
const leaderboardService  = require('./services/leaderboardService');
const authService = require('./services/authService');
const paymentService    = require('./services/paymentService');
const uptService        = require('./services/uptService');
const uptStatusService  = require('./services/uptStatusService');

// Çekim cooldown artık DB'de tutulur (driver_profiles.last_withdraw_at)
// RAM map kaldırıldı — restart sonrası da korunur
const dbCampaigns = require('./db/campaigns');
const dbDriverBankAccounts = require('./db/driverBankAccounts');
const db = require('./db');
const { runMigrations } = require('./db/runMigrations');
const dbPaymentLogs = require('./db/paymentLogs');

const path = require('path');
const fs = require('fs').promises;
const fsSync = require('fs');
const app = express();



// ─── KILLSWITCH (ACİL DURUM ANAHTARI) ──────────────────────────────────────
let isKillswitchActive = false;
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
    if (leaderboardService && typeof leaderboardService.stopCron === 'function') {
        leaderboardService.stopCron();
    }

    // Uption durum takip cron'unu durdur
    if (global._paymentCheckCron) {
        clearInterval(global._paymentCheckCron);
        global._paymentCheckCron = null;
    }

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

// Güvenlik Katmanı 1: Helmet - Başlıkları güvenlik altına alır
app.use(helmet());

// Güvenlik Katmanı 2: CORS - Sadece belirtilen domainlere izin verilir (Tarayıcı saldırı koruması)
const allowedOrigins = [
    'https://risegodriver.com',
    'https://www.risegodriver.com',
    'https://admin.risegodriver.com',
    'https://mehmetrisego.github.io',
    'https://risegobackend-production-2e58.up.railway.app',
    'http://localhost:3000',
    'http://127.0.0.1:3000',
    'http://127.0.0.1:5500',
    'http://localhost:5500',
    'http://192.168.1.102:5500',
    'null'  // file:// ile açılan sayfalar
];
app.use(cors({
    origin: (origin, callback) => {
        if (!origin) return callback(null, true);  // Postman, curl vb.
        if (allowedOrigins.includes(origin)) return callback(null, true);
        if (origin.endsWith('.risegodriver.com') || origin.endsWith('.github.io')) return callback(null, true);
        callback(null, false);  // İzin verilmedi
    },
    methods: ['GET', 'POST', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Origin', 'X-Requested-With', 'Content-Type', 'Accept', 'x-session-token', 'x-park-partner-id', 'x-admin-token'],
    credentials: true
}));

app.use(express.json());

// Railway, Heroku gibi ortamlarda (Reverse Proxy arkasında) IP adresini doğru almak için:
app.set('trust proxy', 1);

// Güvenlik Katmanı 3: Rate Limiting - SMS Brute Force engellemek için
const authLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 10,
    message: { success: false, message: 'Çok fazla giriş denemesi yaptınız, lütfen daha sonra tekrar deneyin.' }
});

// Login, OTP ve Admin limitlerini bağla
app.use('/api/auth/login', authLimiter);
app.use('/api/drivers/register/request-otp', authLimiter);
app.use('/api/admin/auth/login', authLimiter);

// Güvenlik Katmanı 4: Özel Tarih Filtreleme (DDoS / Memory Leak Koruması)
// Sadece ?from ve ?to olan isteklerde max 10 saniyede 1 istek atılmasına izin verilir (IP tabanlı)
const customLeaderboardLimiter = rateLimit({
    windowMs: 10 * 1000, // 10 saniye
    max: 1, // IP başına 1 istek
    message: { success: false, message: 'Çok sık tarih filtresi attınız. Lütfen 10 saniye bekleyip tekrar deneyiniz.' },
    skip: (req) => !req.query.from && !req.query.to // Sadece özel tarih filtreliler rate limit yer, normal leaderboard hızlıdır
});

async function loadCampaignForPark(parkPid) {
    return await dbCampaigns.getCampaign(parkPid);
}

/** Admin: query veya body'den parkPartnerId — yoksa birincil park */
function resolveAdminCampaignPark(req, res) {
    const fromQuery = (req.query.parkPartnerId || '').trim();
    const fromBody = req.body && req.body.parkPartnerId != null ? String(req.body.parkPartnerId).trim() : '';
    const raw = fromQuery || fromBody;
    if (raw && !config.findYandexParkByPartnerId(raw)) {
        res.status(400).json({ success: false, message: 'Geçersiz park (şehir) seçimi.' });
        return null;
    }
    const pid = raw || config.yandexFleet.partnerId;
    if (!pid || !config.findYandexParkByPartnerId(pid)) {
        res.status(400).json({ success: false, message: 'Park yapılandırması bulunamadı.' });
        return null;
    }
    return pid;
}

/** Public GET /api/campaign için park UUID (token → DB/RAM; yoksa query/header; son çare birincil park) */
async function resolvePublicCampaignPark(req) {
    const token = req.headers['x-session-token'];
    if (token) {
        try {
            const parkPid = await authService.getSessionParkPartnerId(token);
            if (parkPid && String(parkPid).trim().length > 0) {
                return String(parkPid).trim();
            }
        } catch (_) { /* yoksay */ }
    }
    const q = (req.query.parkPartnerId || '').trim();
    if (q && config.findYandexParkByPartnerId(q)) return q;
    const cityParam = (req.query.city || '').trim();
    if (cityParam) {
        const src = config.findYandexParkByCity(cityParam);
        if (src) return src.partnerId;
    }
    const hdrPark = (req.headers['x-park-partner-id'] || '').trim();
    if (hdrPark && config.findYandexParkByPartnerId(hdrPark)) return hdrPark;
    return config.yandexFleet.partnerId;
}

// ============================================
// Auth Middleware - Sürücü endpoint'leri için oturum doğrulama
// ============================================
async function requireAuth(req, res, next) {
    const token = req.headers['x-session-token'];
    if (!token) {
        return res.status(401).json({ success: false, message: 'Oturum bulunamadı. Lütfen giriş yapın.' });
    }
    try {
        const driver = await authService.validateSession(token);
        if (!driver) {
            return res.status(401).json({ success: false, message: 'Oturum geçersiz veya süresi dolmuş. Lütfen tekrar giriş yapın.' });
        }
        req.sessionDriver = driver;
        next();
    } catch (error) {
        console.error('[Server] Auth middleware hatası:', error.message);
        res.status(401).json({ success: false, message: 'Oturum doğrulanamadı.' });
    }
}

/** Oturumdaki sürücünün Yandex park kimliği (çoklu şehir API anahtarları) */
function sessionParkPartnerId(req) {
    return (req.sessionDriver && req.sessionDriver.parkPartnerId) || config.yandexFleet.partnerId;
}

// Admin panel oturum doğrulama
async function requireAdminAuth(req, res, next) {
    const token = req.headers['x-admin-token'];
    if (!token) {
        return res.status(401).json({ success: false, message: 'Oturum bulunamadı. Lütfen giriş yapın.' });
    }
    try {
        const session = await authService.validateAdminSession(token);
        if (!session) {
            return res.status(401).json({ success: false, message: 'Oturum geçersiz veya süresi dolmuş. Lütfen tekrar giriş yapın.' });
        }
        req.adminSession = session;
        next();
    } catch (error) {
        console.error('[Server] Admin auth middleware hatası:', error.message);
        res.status(401).json({ success: false, message: 'Oturum doğrulanamadı.' });
    }
}

// ============================================
// Auth Endpoints
// ============================================

/**
 * POST /api/auth/login
 * Telefon numarasını kontrol eder ve OTP gönderir
 */
app.post('/api/auth/login', async (req, res) => {
    try {
        const { phone, city } = req.body;

        if (!phone || !city) {
            return res.status(400).json({
                success: false,
                message: 'Telefon numarası ve şehir gereklidir.'
            });
        }

        const result = await authService.login(phone, city);
        res.json(result);
    } catch (error) {
        console.error('[Server] Login hatası:', error.message);
        res.status(500).json({
            success: false,
            message: 'Sunucu hatası oluştu. Lütfen tekrar deneyin.'
        });
    }
});

/**
 * POST /api/auth/verify-otp
 * OTP kodunu doğrular
 */
app.post('/api/auth/verify-otp', async (req, res) => {
    try {
        const { phone, otp } = req.body;

        if (!phone || !otp) {
            return res.status(400).json({
                success: false,
                message: 'Telefon numarası ve doğrulama kodu gereklidir.'
            });
        }

        const result = await authService.verifyOTP(phone, otp);
        res.json(result);
    } catch (error) {
        console.error('[Server] OTP doğrulama hatası:', error.message);
        res.status(500).json({
            success: false,
            message: 'Sunucu hatası oluştu. Lütfen tekrar deneyin.'
        });
    }
});

/**
 * GET /api/auth/session
 * Kayıtlı oturumu doğrular, geçerliyse sürücü verilerini döner
 */
app.get('/api/auth/session', async (req, res) => {
    try {
        const token = req.headers['x-session-token'];
        if (!token) {
            return res.json({ success: false });
        }

        const driver = await authService.validateSession(token);

        if (driver) {
            res.json({ success: true, driver });
        } else {
            res.json({ success: false });
        }
    } catch (error) {
        console.error('[Server] Session doğrulama hatası:', error.message);
        res.json({ success: false });
    }
});

/**
 * DELETE /api/auth/session
 * Oturumu sonlandırır
 */
app.delete('/api/auth/session', (req, res) => {
    const token = req.headers['x-session-token'];
    if (token) {
        authService.destroySession(token);
    }
    res.json({ success: true });
});

// ============================================
// Driver Endpoints (mevcut)
// ============================================

/**
 * POST /api/drivers/trip-count
 * Belirli bir sürücünün dönem bazlı yolculuk sayısını döner (oturum gerekli)
 */
app.post('/api/drivers/trip-count', requireAuth, async (req, res) => {
    try {
        const { period } = req.body;
        const driverId = req.sessionDriver.id;

        const validPeriods = ['daily', 'weekly', 'monthly', 'all'];
        const selectedPeriod = validPeriods.includes(period) ? period : 'all';

        const tripCount = await leaderboardService.getDriverTripCount(
            driverId,
            selectedPeriod,
            sessionParkPartnerId(req)
        );

        res.json({
            success: true,
            period: selectedPeriod,
            tripCount: tripCount
        });
    } catch (error) {
        console.error('[Server] Trip count hatası:', error.message);
        res.status(500).json({
            success: false,
            message: 'Yolculuk sayısı alınırken hata oluştu.'
        });
    }
});

/**
 * GET /api/drivers/campaign — oturum zorunlu; profil ile aynı park (sessionParkPartnerId)
 */
app.get('/api/drivers/campaign', requireAuth, async (req, res) => {
    try {
        const parkPid = sessionParkPartnerId(req);
        const campaign = await loadCampaignForPark(parkPid);
        res.json({ success: true, campaign, parkPartnerId: parkPid });
    } catch (error) {
        console.error('[Server] Sürücü kampanya hatası:', error.message);
        res.status(500).json({ success: false, message: 'Kampanya yüklenemedi.' });
    }
});

/**
 * POST /api/drivers/balance
 * Belirli bir sürücünün bakiyesini döner (oturum gerekli)
 */
app.post('/api/drivers/balance', requireAuth, async (req, res) => {
    try {
        const driverId = req.sessionDriver.id;

        const balanceData = await yandexFleetApi.getDriverBalance(driverId, sessionParkPartnerId(req));

        if (balanceData) {
            res.json({
                success: true,
                balance: balanceData.balance,
                blockedBalance: balanceData.blockedBalance
            });
        } else {
            res.json({
                success: false,
                message: 'Bakiye bilgisi alınamadı.'
            });
        }
    } catch (error) {
        console.error('[Server] Balance hatası:', error.message);
        res.status(500).json({
            success: false,
            message: 'Bakiye alınırken hata oluştu.'
        });
    }
});

/**
 * GET /api/drivers/bank-account
 * Oturumdaki sürücünün tüm kayıtlı banka hesaplarını döner.
 */
app.get('/api/drivers/bank-account', requireAuth, async (req, res) => {
    try {
        if (!db.isConfigured()) {
            return res.status(503).json({ success: false, message: 'Veritabanı yapılandırılmamış.' });
        }

        const accounts = await dbDriverBankAccounts.getDriverBankAccounts(req.sessionDriver.id);
        res.json({ success: true, accounts });
    } catch (error) {
        console.error('[Server] Banka hesapları getirme hatası:', error.message);
        res.status(500).json({ success: false, message: 'Banka hesap bilgileri alınırken hata oluştu.' });
    }
});

/**
 * POST /api/drivers/bank-account
 * Yeni bir banka hesabı ekler.
 */
app.post('/api/drivers/bank-account', requireAuth, async (req, res) => {
    try {
        if (!db.isConfigured()) {
            return res.status(503).json({ success: false, message: 'Veritabanı yapılandırılmamış.' });
        }

        const ibanRaw = req.body?.iban;
        const accountHolderNameRaw = req.body?.accountHolderName;
        const iban = dbDriverBankAccounts.normalizeIban(ibanRaw);
        const accountHolderName = String(accountHolderNameRaw || '').trim();

        if (!iban || !accountHolderName) {
            return res.status(400).json({ success: false, message: 'IBAN ve hesap sahibinin adı soyadı zorunludur.' });
        }

        if (!/^TR\d{24}$/.test(iban)) {
            return res.status(400).json({ success: false, message: 'Geçerli bir TR IBAN giriniz (TR + 24 hane).' });
        }

        const account = await dbDriverBankAccounts.addDriverBankAccount(
            req.sessionDriver.id,
            iban,
            accountHolderName
        );

        res.json({
            success: true,
            message: 'Yeni hesap başarıyla eklendi.',
            account
        });
    } catch (error) {
        console.error('[Server] Banka hesabı ekleme hatası:', error.message, error);
        res.status(500).json({
            success: false,
            message: 'Hesap bilgileri kaydedilirken hata oluştu: ' + error.message
        });
    }
});

/**
 * DELETE /api/drivers/bank-account/:id
 * Belirtilen banka hesabını siler.
 */
app.delete('/api/drivers/bank-account/:id', requireAuth, async (req, res) => {
    try {
        if (!db.isConfigured()) {
            return res.status(503).json({ success: false, message: 'Veritabanı yapılandırılmamış.' });
        }

        const accountId = parseInt(req.params.id);
        const driverId = req.sessionDriver.id;

        const deleted = await dbDriverBankAccounts.deleteDriverBankAccount(driverId, accountId);

        if (deleted) {
            res.json({ success: true, message: 'Banka hesabı silindi.' });
        } else {
            res.status(404).json({ success: false, message: 'Hesap bulunamadı veya silinemedi.' });
        }
    } catch (error) {
        console.error('[Server] Banka hesabı silme hatası:', error.message);
        res.status(500).json({ success: false, message: 'Hesap silinirken hata oluştu.' });
    }
});

/**
 * POST /api/drivers/withdraw
 * Sürücünün kayıtlı IBAN'ına EFT gönderir ve Yandex bakiyesini düşer.
 * - 4 TL çekim ücreti alınır (sürücüye amount-4 gider, Yandex'ten amount düşer)
 * - 12 saat cooldown DB'de saklanır (restart sonrası korunur)
 */
const WITHDRAW_FEE_TL   = 4;
const WITHDRAW_COOLDOWN_MS = 5 * 60 * 1000; // 5 Dakika (Çift Tıklama ve Tekrar Deneme Bekleme Süresi)

app.post('/api/drivers/withdraw', requireAuth, async (req, res) => {
    let client;
    const driverId = req.sessionDriver.id;
    const grossAmount = parseFloat(req.body?.amount);

    try {
        if (!db.isConfigured()) {
            return res.status(503).json({ success: false, message: 'Veritabanı yapılandırılmamış.' });
        }

        // ── 1. Ön Validasyonlar ───────────────────────────────────
        if (isKillswitchActive) {
            return res.status(503).json({ success: false, message: 'Para çekme işlemleri geçici bir süreliğine askıya alınmıştır. Lütfen daha sonra tekrar deneyiniz.' });
        }

        if (isNaN(grossAmount) || grossAmount <= 0) {
            return res.status(400).json({ success: false, message: 'Geçerli bir tutar giriniz.' });
        }
        if (grossAmount <= WITHDRAW_FEE_TL) {
            return res.status(400).json({
                success: false,
                message: `Çekim tutarı en az ${WITHDRAW_FEE_TL + 0.01} TL olmalıdır (${WITHDRAW_FEE_TL} TL çekim ücreti alınmaktadır).`
            });
        }

        // ── 2. Atomik Cooldown ve Satır Kilitleme (Race Condition Koruması) ──
        // Transaction başlatıyoruz ve driver_profiles satırını kilitliyoruz.
        client = await db.pool.connect();
        await client.query('BEGIN');

        // FOR UPDATE ile bu sürücünün satırını diğer işlemler bitene kadar kilitliyoruz.
        const profileRow = await client.query(
            'SELECT last_withdraw_at FROM driver_profiles WHERE driver_id = $1 FOR UPDATE',
            [driverId]
        );
        
        const lastWithdrawAt = profileRow.rows[0]?.last_withdraw_at
            ? new Date(profileRow.rows[0].last_withdraw_at).getTime()
            : null;

        if (lastWithdrawAt) {
            const elapsed = Date.now() - lastWithdrawAt;
            const remaining = WITHDRAW_COOLDOWN_MS - elapsed;
            if (remaining > 0) {
                await client.query('ROLLBACK');
                client.release();
                client = null;

                const nextTime = new Date(lastWithdrawAt + WITHDRAW_COOLDOWN_MS);
                const hh = String(nextTime.getHours()).padStart(2, '0');
                const mm = String(nextTime.getMinutes()).padStart(2, '0');
                return res.status(429).json({
                    success: false,
                    message: `Bekleme süresi dolmadı. Tekrar çekim yapabileceğiniz saat: ${hh}:${mm}.`
                });
            }
        }

        // Cooldown'ı hemen şimdi (bekleme durumunda) güncelliyoruz ki paralel istekler engellensin.
        await client.query(
            `UPDATE driver_profiles SET last_withdraw_at = NOW(), updated_at = NOW() WHERE driver_id = $1`,
            [driverId]
        );

        // Kilidi bırakabiliriz (commit), çünkü artık last_withdraw_at güncel.
        await client.query('COMMIT');
        client.release();
        client = null;

        // ── 3. Anlık Bakiye Doğrulama (Yandex API) ────────────────
        // Frontend'den gelen tutarın gerçekte var olup olmadığını Yandex API'den anlık teyit ediyoruz.
        const parkPid = sessionParkPartnerId(req);
        const yandexBalance = await yandexFleetApi.getDriverBalance(driverId, parkPid);
        
        const currentTotal    = parseFloat(yandexBalance?.balance || 0);
        // İncelemede olan bakiye (blockedBalance) artık dikkate alınmıyor. Sürücü tümünü çekebilir.
        const withdrawable    = currentTotal;

        if (grossAmount > withdrawable + 0.01) { // 0.01 TL'lik küçük yuvarlama payı
            // Bakiye yetersizse cooldown'ı geri çek (sürücü tekrar deneyebilsin)
            await db.query(
                'UPDATE driver_profiles SET last_withdraw_at = $1 WHERE driver_id = $2',
                [profileRow.rows[0]?.last_withdraw_at || null, driverId]
            );
            return res.status(400).json({
                success: false,
                message: `Yetersiz bakiye. Çekilebilir tutarınız (${withdrawable.toFixed(2).replace('.', ',')} TL) talep edilen tutardan düşük.`
            });
        }

        // ── 4. Banka Hesabı ve Ödeme İşlemi ───────────────────────
        const netAmount = parseFloat((grossAmount - WITHDRAW_FEE_TL).toFixed(2));
        const bankAccountId = req.body?.bankAccountId;
        let account = null;

        if (bankAccountId) {
            const accRes = await db.query(
                'SELECT iban, account_holder_name FROM driver_bank_accounts WHERE id = $1 AND driver_id = $2',
                [bankAccountId, driverId]
            );
            if (accRes.rows.length > 0) {
                account = {
                    iban: accRes.rows[0].iban,
                    accountHolderName: accRes.rows[0].account_holder_name
                };
            }
        } else {
            // Eğer ID gönderilmemişse son hesabı al (geriye uyumluluk ve varsayılan)
            const accounts = await dbDriverBankAccounts.getDriverBankAccounts(driverId);
            if (accounts.length > 0) account = accounts[0];
        }
        
        if (!account || !account.iban || !account.accountHolderName) {
            // IBAN yoksa cooldown'ı geri çek
            await db.query('UPDATE driver_profiles SET last_withdraw_at = $1 WHERE driver_id = $2', [profileRow.rows[0]?.last_withdraw_at || null, driverId]);
            return res.status(400).json({ success: false, message: 'Geçerli bir banka hesabı seçilmedi.' });
        }

        const nameParts = account.accountHolderName.trim().split(/\s+/);
        const beneficiarySurname = nameParts.length > 1 ? nameParts.slice(1).join(' ') : nameParts[0];
        const beneficiaryName    = nameParts[0];

        const result = await paymentService.sendPayment({
            driverId,
            beneficiaryName,
            beneficiarySurname,
            beneficiaryIban: account.iban,
            amount:           netAmount,
            yandexAmount:     grossAmount,
            parkPartnerId:    parkPid
        });

        const nextWithdrawTime = new Date(Date.now() + WITHDRAW_COOLDOWN_MS);
        res.json({
            success:        true,
            message:        `Para çekimi başarıyla gerçekleşti. Hesabınıza ${netAmount.toFixed(2).replace('.', ',')} TL aktarıldı.`,
            netAmount,
            grossAmount,
            tuRefNumber:    result.tuRefNumber,
            warning:        result.warning || null,
            nextWithdrawAt: nextWithdrawTime.toISOString()
        });

    } catch (error) {
        if (client) {
            await client.query('ROLLBACK');
            client.release();
        }
        console.error('[Server] Para çekimi hatası:', error.message);
        res.status(500).json({ success: false, message: error.message || 'Para çekimi sırasında hata oluştu.' });
    }
});

/**
 * GET /api/drivers/withdraw-status
 * Sürücünün para çekme cooldown durumunu DB'den döner (restart sonrası korunur)
 */
app.get('/api/drivers/withdraw-status', requireAuth, async (req, res) => {
    try {
        const driverId = req.sessionDriver.id;
        if (!db.isConfigured()) {
            return res.json({ success: true, canWithdraw: true, cooldownUntil: null, minutesLeft: 0 });
        }
        const profileRow = await db.query(
            'SELECT last_withdraw_at FROM driver_profiles WHERE driver_id = $1',
            [driverId]
        );
        const lastWithdrawAt = profileRow.rows[0]?.last_withdraw_at
            ? new Date(profileRow.rows[0].last_withdraw_at).getTime()
            : null;

        if (!lastWithdrawAt) {
            return res.json({ success: true, canWithdraw: true, cooldownUntil: null, hoursLeft: 0 });
        }
        const elapsed   = Date.now() - lastWithdrawAt;
        const remaining = WITHDRAW_COOLDOWN_MS - elapsed;
        if (remaining <= 0) {
            return res.json({ success: true, canWithdraw: true, cooldownUntil: null, minutesLeft: 0 });
        }
        const minutesLeft = Math.ceil(remaining / (1000 * 60));
        return res.json({
            success: true,
            canWithdraw: false,
            cooldownUntil: new Date(lastWithdrawAt + WITHDRAW_COOLDOWN_MS).toISOString(),
            minutesLeft
        });
    } catch (err) {
        console.error('[Server] Withdraw status hatası:', err.message);
        return res.json({ success: true, canWithdraw: true, cooldownUntil: null, minutesLeft: 0 });
    }
});

/**
 * GET /api/drivers/withdraw-history
 * Oturumdaki sürücünün para çekme geçmişini döner.
 */
app.get('/api/drivers/withdraw-history', requireAuth, async (req, res) => {
    try {
        if (!db.isConfigured()) {
            return res.status(503).json({ success: false, message: 'Veritabanı yapılandırılmamış.' });
        }

        const logs = await dbPaymentLogs.getDriverPaymentLogs(req.sessionDriver.id);
        res.json({ success: true, logs });
    } catch (error) {
        console.error('[Server] Çekim geçmişi getirme hatası:', error.message);
        res.status(500).json({ success: false, message: 'Çekim geçmişi alınırken hata oluştu.' });
    }
});

/**
 * GET /api/leaderboard
 * Sürücü sıralama tablosu: top 30 + kullanıcının sırası (oturum gerekli)
 * Query: ?from=YYYY-MM-DD&to=YYYY-MM-DD  (zorunlu, en fazla 31 gün)
 */
app.get('/api/leaderboard', requireAuth, customLeaderboardLimiter, async (req, res) => {
    try {
        const driverId = req.sessionDriver.id;
        const { from, to } = req.query;

        if (!from || !to) {
            return res.status(400).json({
                success: false,
                message: 'Başlangıç ve bitiş tarihi gereklidir (from, to).'
            });
        }

        // Tarih format validasyonu
        if (!/^\d{4}-\d{2}-\d{2}$/.test(from) || !/^\d{4}-\d{2}-\d{2}$/.test(to)) {
            return res.status(400).json({ success: false, message: 'Tarih formatı YYYY-MM-DD olmalıdır.' });
        }

        const startDate = new Date(from);
        const endDate   = new Date(to);
        if (isNaN(startDate.getTime()) || isNaN(endDate.getTime())) {
            return res.status(400).json({ success: false, message: 'Geçersiz tarih.' });
        }
        if (startDate > endDate) {
            return res.status(400).json({ success: false, message: 'Başlangıç tarihi bitiş tarihinden sonra olamaz.' });
        }
        const diffDays = Math.ceil((endDate - startDate) / (1000 * 60 * 60 * 24));
        if (diffDays > 31) {
            return res.status(400).json({ success: false, message: 'En fazla 1 aylık (31 gün) dönem seçebilirsiniz.' });
        }

        const data = await leaderboardService.getLeaderboard(from, to, {
            adminView: false,
            parkPartnerId: sessionParkPartnerId(req)
        });
        const { drivers, totalDrivers, totalOrders, periodLabel } = data;

        // Sürücüye yalnızca baş harfler göster (gizlilik)
        const top30 = drivers.slice(0, 30).map(d => ({
            id:        d.id,
            initials:  d.initials,
            tripCount: d.tripCount,
            rank:      d.rank
        }));

        // Mevcut sürücünün sırasını bul
        let currentUser = null;
        const found = drivers.find(d => d.id === driverId);
        if (found) {
            if (found.rank > 30) {
                currentUser = { id: found.id, initials: found.initials, tripCount: found.tripCount, rank: found.rank };
            }
        } else {
            currentUser = { id: driverId, initials: '?', tripCount: 0, rank: drivers.length + 1 };
        }

        res.json({
            success:      true,
            leaderboard:  top30,
            currentUser:  currentUser,
            totalDrivers: totalDrivers,
            totalOrders:  totalOrders || 0,
            periodLabel:  periodLabel || '',
            syncedAt:     data.syncedAt
        });
    } catch (error) {
        console.error('[Server] Leaderboard hatası:', error.message);
        res.status(500).json({ success: false, message: 'Sıralama tablosu yüklenirken hata oluştu.' });
    }
});

/**
 * POST /api/drivers/check-plate
 * Plakanın sistemde kayıtlı olup olmadığını kontrol eder (oturum gerekli)
 */
app.post('/api/drivers/check-plate', requireAuth, async (req, res) => {
    try {
        const { plate } = req.body;

        if (!plate || typeof plate !== 'string') {
            return res.status(400).json({
                success: false,
                message: 'Plaka numarası gereklidir.'
            });
        }

        const trimmed = plate.trim().toUpperCase();
        if (trimmed.length < 3) {
            return res.status(400).json({
                success: false,
                message: 'Geçerli bir plaka numarası giriniz.'
            });
        }

        const car = await yandexFleetApi.findCarByPlate(trimmed, sessionParkPartnerId(req));

        if (car) {
            res.json({
                success: true,
                found: true,
                car: {
                    id: car.id,
                    brand: car.brand,
                    model: car.model,
                    year: car.year,
                    number: car.number
                }
            });
        } else {
            res.json({
                success: true,
                found: false,
                car: null
            });
        }
    } catch (error) {
        console.error('[Server] Plaka kontrol hatası:', error.message);
        res.status(500).json({
            success: false,
            message: error.message || 'Plaka kontrol edilirken hata oluştu.'
        });
    }
});

/**
 * POST /api/drivers/change-car
 * Sürücünün aracını değiştirir: kayıtlı araç varsa bağlar, yoksa yeni araç oluşturup bağlar (oturum gerekli)
 */
app.post('/api/drivers/change-car', requireAuth, async (req, res) => {
    try {
        const { plate, carId, brand, model, year } = req.body;
        const driverId = req.sessionDriver.id;

        const trimmedPlate = (plate || '').trim().toUpperCase();
        if (trimmedPlate.length < 3) {
            return res.status(400).json({
                success: false,
                message: 'Geçerli bir plaka numarası giriniz.'
            });
        }

        const parkPid = sessionParkPartnerId(req);

        if (carId) {
            await yandexFleetApi.bindCarToDriver(driverId, carId, parkPid);

            // Araç bilgilerini plaka ile ara (findCarByPlate düz formatta döner)
            let car = null;
            try {
                car = await yandexFleetApi.findCarByPlate(trimmedPlate, parkPid);
            } catch (findErr) {
                console.warn('[Server] Araç bilgisi alınamadı:', findErr.message);
            }

            const carInfo = car ? {
                id: car.id || carId,
                brand: car.brand || brand || '',
                model: car.model || model || '',
                year: car.year || year || '',
                number: car.number || trimmedPlate
            } : {
                id: carId,
                brand: brand || '',
                model: model || '',
                year: year || '',
                number: trimmedPlate
            };

            res.json({
                success: true,
                message: 'Araç başarıyla değiştirildi.',
                car: carInfo
            });
        } else {
            if (!brand || !model || !year) {
                return res.status(400).json({
                    success: false,
                    message: 'Yeni araç için marka, model ve yıl gereklidir.'
                });
            }
            const result = await yandexFleetApi.createCarAndBind(trimmedPlate, brand, model, year, driverId, parkPid);
            res.json({
                success: true,
                message: 'Yeni araç kaydedildi ve size atandı.',
                car: {
                    id: result.vehicleId,
                    brand: result.brand,
                    model: result.model,
                    year: result.year,
                    number: result.plate
                }
            });
        }
    } catch (error) {
        console.error('[Server] Araç değiştirme hatası:', error.message);
        res.status(500).json({
            success: false,
            message: error.message || 'Araç değiştirilirken hata oluştu.'
        });
    }
});

/**
 * POST /api/drivers/register/request-otp
 * Kayıt öncesi telefon doğrulaması - OTP gönderir (sürücü henüz oluşturulmaz)
 */
app.post('/api/drivers/register/request-otp', async (req, res) => {
    try {
        const {
            firstName,
            lastName,
            phone,
            city,
            taxIdentificationNumber,
            driverLicenseNumber,
            driverLicenseIssueDate,
            driverLicenseExpiryDate,
            birthDate,
            country
        } = req.body;

        if (!firstName || !lastName || !phone || !city || !taxIdentificationNumber || !driverLicenseNumber ||
            !driverLicenseIssueDate || !driverLicenseExpiryDate || !birthDate) {
            return res.status(400).json({
                success: false,
                message: 'Tüm zorunlu alanları doldurunuz.'
            });
        }

        if (taxIdentificationNumber.length !== 11) {
            return res.status(400).json({
                success: false,
                message: 'TC kimlik numarası 11 haneli olmalıdır.'
            });
        }

        const phoneClean = phone.replace(/\D/g, '');
        if (phoneClean.length < 10) {
            return res.status(400).json({
                success: false,
                message: 'Geçerli bir telefon numarası giriniz.'
            });
        }

        const normalizedPhone = phoneClean.startsWith('90') ? '+' + phoneClean : '+90' + phoneClean;

        const result = await authService.sendRegistrationOTP(normalizedPhone, city, {
            firstName: firstName.trim(),
            lastName: lastName.trim(),
            taxIdentificationNumber: taxIdentificationNumber.trim(),
            driverLicenseNumber: driverLicenseNumber.trim(),
            driverLicenseIssueDate,
            driverLicenseExpiryDate,
            birthDate,
            country: country || 'tur'
        });

        res.json(result);
    } catch (error) {
        console.error('[Server] Kayıt OTP hatası:', error.message);
        res.status(500).json({
            success: false,
            message: error.message || 'Kod gönderilirken hata oluştu.'
        });
    }
});

/**
 * POST /api/drivers/register/verify
 * OTP doğrular, sürücü oluşturur ve oturum açar
 */
app.post('/api/drivers/register/verify', async (req, res) => {
    try {
        const { phone, otp } = req.body;

        if (!phone || !otp) {
            return res.status(400).json({
                success: false,
                message: 'Telefon numarası ve doğrulama kodu gereklidir.'
            });
        }

        const phoneClean = phone.replace(/\D/g, '');
        const normalizedPhone = phoneClean.startsWith('90') ? '+' + phoneClean : '+90' + phoneClean;

        const result = await authService.verifyRegistrationOTP(normalizedPhone, otp);

        if (result.success) {
            res.json({
                success: true,
                driver: result.driver,
                sessionToken: result.sessionToken
            });
        } else {
            res.status(400).json({
                success: false,
                message: result.message
            });
        }
    } catch (error) {
        console.error('[Server] Kayıt doğrulama hatası:', error.message);
        res.status(500).json({
            success: false,
            message: error.message || 'Doğrulama sırasında hata oluştu.'
        });
    }
});

/**
 * GET /api/drivers/car-brands
 * Zorunlu: data/yandexVehicleReference.json (brandsWithModels dolu olmalı)
 */
function getCarBrandsPayload() {
    const refPath = path.join(__dirname, 'data', 'yandexVehicleReference.json');
    try {
        if (fsSync.existsSync(refPath)) {
            const raw = JSON.parse(fsSync.readFileSync(refPath, 'utf8'));
            if (raw.brandsWithModels && Array.isArray(raw.brandsWithModels) && raw.brandsWithModels.length > 0) {
                const brands = raw.brandsWithModels.map(b => b.brand);
                return { success: true, brands, brandsWithModels: raw.brandsWithModels };
            }
        }
    } catch (e) {
        console.error('[Server] yandexVehicleReference.json okunamadı:', e.message);
    }
    return {
        success: false,
        message:
            'Araç marka/model listesi yüklenemedi. Sunucuda data/yandexVehicleReference.json dosyası olmalı ve brandsWithModels dolu olmalı.',
        brands: [],
        brandsWithModels: []
    };
}

app.get('/api/drivers/car-brands', (req, res) => {
    res.json(getCarBrandsPayload());
});



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

// ============================================
// Admin Auth Endpoints (OTP - sadece yetkili numaralar)
// ============================================

/**
 * POST /api/admin/auth/login
 * Yetkili telefon numarasına OTP gönderir
 */
app.post('/api/admin/auth/login', async (req, res) => {
    try {
        const { phone } = req.body;
        if (!phone) {
            return res.status(400).json({ success: false, message: 'Telefon numarası gereklidir.' });
        }
        const result = await authService.adminLogin(phone);
        res.json(result);
    } catch (error) {
        console.error('[Server] Admin login hatası:', error.message);
        res.status(500).json({ success: false, message: 'Sunucu hatası oluştu.' });
    }
});

/**
 * POST /api/admin/auth/verify-otp
 * Admin OTP doğrulama
 */
app.post('/api/admin/auth/verify-otp', async (req, res) => {
    try {
        const { phone, otp } = req.body;
        if (!phone || !otp) {
            return res.status(400).json({ success: false, message: 'Telefon numarası ve doğrulama kodu gereklidir.' });
        }
        const result = await authService.adminVerifyOTP(phone, otp);
        res.json(result);
    } catch (error) {
        console.error('[Server] Admin OTP hatası:', error.message);
        res.status(500).json({ success: false, message: 'Sunucu hatası oluştu.' });
    }
});

/**
 * GET /api/admin/auth/session
 * Admin oturum kontrolü
 */
app.get('/api/admin/auth/session', async (req, res) => {
    try {
        const token = req.headers['x-admin-token'];
        if (!token) {
            return res.json({ success: false, message: 'Oturum bulunamadı.' });
        }
        const session = await authService.validateAdminSession(token);
        if (!session) {
            return res.json({ success: false, message: 'Oturum geçersiz.' });
        }
        const activeDriverSessions = await authService.getActiveDriverSessionCount();
        res.json({ success: true, activeDriverSessions });
    } catch (error) {
        console.error('[Server] Admin session hatası:', error.message);
        res.json({ success: false, message: 'Oturum doğrulanamadı.' });
    }
});

/**
 * POST /api/admin/auth/logout
 * Admin oturum sonlandırma
 */
app.post('/api/admin/auth/logout', (req, res) => {
    const token = req.headers['x-admin-token'];
    if (token) authService.destroyAdminSession(token);
    res.json({ success: true });
});

// ============================================
// Kampanya Yönetimi Endpoints (Admin Panel)
// ============================================

/**
 * POST /api/admin/campaign
 * Admin panelinden kampanya metni kaydetme
 * Body: { text, parkPartnerId? } — park yoksa birincil park
 */
app.post('/api/admin/campaign', requireAdminAuth, async (req, res) => {
    try {
        const parkPid = resolveAdminCampaignPark(req, res);
        if (!parkPid) return;

        const { text } = req.body;

        if (!text || typeof text !== 'string' || text.trim().length === 0) {
            return res.status(400).json({
                success: false,
                message: 'Kampanya metni boş olamaz.'
            });
        }

        const trimmed = text.trim();
        if (db.isConfigured()) {
            const campaign = await dbCampaigns.upsertCampaign(trimmed, parkPid);
            console.log(`[Server] Kampanya DB'ye kaydedildi (${parkPid}): "${trimmed}"`);
            return res.json({
                success: true,
                message: 'Kampanya başarıyla kaydedildi.',
                campaign
            });
        }
        const campaign = { text: trimmed, active: true, updatedAt: new Date().toISOString() };
        setCampaignMemory(parkPid, campaign);
        console.log(`[Server] Kampanya güncellendi (bellek, ${parkPid}): "${trimmed}"`);
        res.json({
            success: true,
            message: 'Kampanya başarıyla kaydedildi.',
            campaign
        });
    } catch (error) {
        console.error('[Server] Kampanya kaydetme hatası:', error.message);
        res.status(500).json({
            success: false,
            message: 'Kampanya kaydedilirken hata oluştu.'
        });
    }
});

/**
 * GET /api/admin/campaign
 * Admin panelinden aktif kampanyayı okuma
 * Query: ?parkPartnerId=... (yoksa birincil park)
 */
app.get('/api/admin/campaign', requireAdminAuth, async (req, res) => {
    try {
        const parkPid = resolveAdminCampaignPark(req, res);
        if (!parkPid) return;

        const campaign = db.isConfigured()
            ? await dbCampaigns.getCampaign(parkPid)
            : getCampaignMemory(parkPid);
        res.json({ success: true, campaign });
    } catch (error) {
        console.error('[Server] Kampanya okuma hatası:', error.message);
        const fallback = getCampaignMemory(config.yandexFleet.partnerId);
        res.json({ success: true, campaign: fallback });
    }
});

/**
 * DELETE /api/admin/campaign
 * Admin panelinden kampanyayı silme
 * Query: ?parkPartnerId=... (yoksa birincil park)
 */
app.delete('/api/admin/campaign', requireAdminAuth, async (req, res) => {
    try {
        const parkPid = resolveAdminCampaignPark(req, res);
        if (!parkPid) return;

        if (db.isConfigured()) {
            await dbCampaigns.deactivateCampaign(parkPid);
        }
        setCampaignMemory(parkPid, { text: '', active: false, updatedAt: new Date().toISOString() });
        console.log(`[Server] Kampanya silindi (${parkPid}).`);
        res.json({ success: true, message: 'Kampanya başarıyla silindi.' });
    } catch (error) {
        console.error('[Server] Kampanya silme hatası:', error.message);
        res.status(500).json({ success: false, message: 'Kampanya silinirken hata oluştu.' });
    }
});

/** GET /api/campaign — public; token veya ?parkPartnerId / ?city / X-Park-Partner-Id */
app.get('/api/campaign', async (req, res) => {
    try {
        const parkPid = await resolvePublicCampaignPark(req);
        const campaign = await loadCampaignForPark(parkPid);
        res.json({ success: true, campaign });
    } catch (error) {
        console.error('[Server] Kampanya okuma hatası:', error.message);
        res.json({
            success: true,
            campaign: { text: '', active: false, updatedAt: null }
        });
    }
});

/**
 * GET /api/admin/upt-balance
 * Uption (Aktif Bank) kurumsal cüzdan TRY bakiyesini döner (admin gerekli)
 */
app.get('/api/admin/upt-balance', requireAdminAuth, async (req, res) => {
    try {
        const result = await uptService.getUptBalance();

        res.json({
            success:    result.success,
            tryBalanceRaw: result.tryBalanceRaw,
            balances:   result.balances,
            error:      result.error || null
        });
    } catch (err) {
        console.error('[Admin] UPT bakiye hatası:', err.message);
        res.status(500).json({ success: false, error: err.message });
    }
});


/**
 * GET /api/admin/parks
 * Yandex parklar\u0131 (\u015fehir etiketi + partnerId) \u2014 admin paneli \u015fehir filtresi i\u00e7in
 */
app.get('/api/admin/parks', requireAdminAuth, async (req, res) => {
    try {
        const parks = config.getYandexParkSources().map(s => ({
            label: s.label,
            partnerId: s.partnerId
        }));
        res.json({ success: true, parks });
    } catch (error) {
        console.error('[Server] Admin parks hatası:', error.message);
        res.status(500).json({ success: false, message: 'Park listesi alınamadı.' });
    }
});

/**
 * GET /api/admin/leaderboard
 * Admin paneli leaderboard — tam ad + yolculuk sayısı + sıralama
 * Query:
 *   ?from=YYYY-MM-DD&to=YYYY-MM-DD  → özel tarih aralığı
 *   ?parkPartnerId=<uuid>  → şehir/park (belirtilmezse varsayılan ilk park)
 *   (from/to yoksa: bugün)
 */
app.get('/api/admin/leaderboard', requireAdminAuth, customLeaderboardLimiter, async (req, res) => {
    try {
        let { from, to } = req.query;

        // from/to belirtilmemişse varsayılan: bugün
        if (!from || !to) {
            const today = new Date();
            const yyyy  = today.getFullYear();
            const mm    = String(today.getMonth() + 1).padStart(2, '0');
            const dd    = String(today.getDate()).padStart(2, '0');
            from = `${yyyy}-${mm}-${dd}`;
            to   = `${yyyy}-${mm}-${dd}`;
        }

        // Format validasyonu
        if (!/^\d{4}-\d{2}-\d{2}$/.test(from) || !/^\d{4}-\d{2}-\d{2}$/.test(to)) {
            return res.status(400).json({ success: false, message: 'Tarih formatı YYYY-MM-DD olmalıdır.' });
        }

        const parkPid = (req.query.parkPartnerId || '').trim() || config.yandexFleet.partnerId;
        const data = await leaderboardService.getLeaderboard(from, to, {
            adminView: true,
            parkPartnerId: parkPid
        });
        const driversArray = data.drivers || [];

        res.json({
            success:      true,
            leaderboard:  driversArray.map(d => ({
                id:        d.id,
                fullName:  d.fullName,
                tripCount: d.tripCount,
                rank:      d.rank
            })),
            periodLabel:  data.periodLabel,
            totalOrders:  data.totalOrders,
            totalDrivers: data.totalDrivers,
            syncedAt:     data.syncedAt
        });
    } catch (error) {
        console.error('[Server] Admin leaderboard hatası:', error.message);
        res.status(500).json({ success: false, message: 'Leaderboard verisi yüklenirken hata oluştu.' });
    }
});

/**
 * POST /api/admin/leaderboard/resync
 * Tüm leaderboard cache'ini temizler ve Yandex API'den yeniden tam senkronizasyon başlatır.
 * Hatalı veri / eksik yolculuk durumlarında admin tarafından manuel tetiklenir.
 */
app.get('/api/admin/payment-logs', requireAdminAuth, async (req, res) => {
    try {
        if (!db.isConfigured()) {
            return res.status(503).json({ success: false, message: 'Veritabanı yapılandırılmamış.' });
        }
        const result = await db.query(
            `SELECT * FROM payment_logs ORDER BY created_at DESC LIMIT 500`
        );
        res.json({ success: true, logs: result.rows });
    } catch (err) {
        console.error('[AdminAPI] Payment logs hatası:', err.message);
        res.status(500).json({ success: false, message: err.message });
    }
});



app.get('/api/admin/drivers/total-balance', requireAdminAuth, async (req, res) => {
    try {
        if (!db.isConfigured()) {
            return res.json({ success: true, totalBalance: 0 });
        }
        const result = await db.query('SELECT SUM(balance) as total FROM park_driver_balances');
        const total = parseFloat(result.rows[0]?.total || 0);
        res.json({ success: true, totalBalance: total });
    } catch (err) {
        console.error('[AdminAPI] Toplam sürücü bakiyesi hesaplanamadı:', err.message);
        res.status(500).json({ success: false, message: err.message });
    }
});

app.get('/api/admin/killswitch', requireAdminAuth, (req, res) => {
    res.json({ success: true, active: isKillswitchActive });
});

app.post('/api/admin/killswitch', requireAdminAuth, express.json(), async (req, res) => {
    const { active } = req.body;
    if (typeof active !== 'boolean') {
        return res.status(400).json({ success: false, message: 'Geçersiz parametre.' });
    }
    
    try {
        await db.query(
            "UPDATE system_settings SET value = $1, updated_at = NOW() WHERE key = 'is_withdraw_suspended'",
            [active ? 'true' : 'false']
        );
        isKillswitchActive = active;
        console.log(`[Admin] Killswitch durumu veritabanında değiştirildi: ${active ? 'AÇIK (ASKIYA ALINDI)' : 'KAPALI (AKTİF)'}`);
        res.json({ success: true, active: isKillswitchActive, message: active ? 'Para çekme işlemleri askıya alındı.' : 'Para çekme işlemleri tekrar aktif edildi.' });
    } catch (err) {
        console.error('[AdminAPI] Killswitch güncelleme hatası:', err.message);
        res.status(500).json({ success: false, message: 'Ayarlar güncellenirken veritabanı hatası oluştu.' });
    }
});

app.post('/api/admin/leaderboard/resync', requireAdminAuth, async (req, res) => {
    try {
        console.log('[Server] Admin tarafından zorla yeniden senkronizasyon talep edildi.');
        // Arka planda başlat — cevabı hemen dön
        leaderboardService.forceResync().catch(err => {
            console.error('[Server] Yeniden senkronizasyon arka plan hatası:', err.message);
        });
        res.json({
            success: true,
            message: 'Yeniden senkronizasyon arka planda başlatıldı. 1-5 dakika içinde veriler güncellenecek.'
        });
    } catch (error) {
        console.error('[Server] Resync hatası:', error.message);
        res.status(500).json({ success: false, message: 'Yeniden senkronizasyon başlatılamadı.' });
    }
});

/**
 * GET /api/admin/leaderboard/status
 * Leaderboard servisinin mevcut durumunu döner (debug / monitoring için)
 */
app.get('/api/admin/leaderboard/status', requireAdminAuth, async (req, res) => {
    try {
        const status = await leaderboardService.getStatus();
        res.json({ success: true, status });
    } catch (err) {
        res.status(500).json({ success: false, message: err.message });
    }
});

// Ana sayfa - API bilgisi (frontend ayrı repo'da GitHub Pages'te)
app.get('/', (req, res) => {
    res.json({
        message: 'RiseGo Backend API',
        docs: {
            health: 'GET /api/health',
            login: 'POST /api/auth/login',
            verifyOtp: 'POST /api/auth/verify-otp',
            session: 'GET /api/auth/session',
            tripCount: 'POST /api/drivers/trip-count',
            leaderboard: 'GET /api/leaderboard',
            campaign: 'GET /api/campaign',
            driverCampaign: 'GET /api/drivers/campaign (oturum — profil ile aynı şehir/park)',
            adminCampaign: 'POST|GET|DELETE /api/admin/campaign (?parkPartnerId & body.parkPartnerId)',
            adminParks: 'GET /api/admin/parks',
            adminLeaderboard: 'GET /api/admin/leaderboard'
        }
    });
});

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

                try {
                    const result = await db.query(
                        `INSERT INTO driver_profiles
                             (driver_id, phone, first_name, last_name, park_partner_id, created_at, updated_at)
                         VALUES ($1, $2, $3, $4, $5, NOW(), NOW())
                         ON CONFLICT (driver_id) DO NOTHING`,
                        [drvId, phone, firstName, lastName, park.partnerId]
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
                const ksResult = await db.query("SELECT value FROM system_settings WHERE key = 'is_withdraw_suspended'");
                if (ksResult.rows.length > 0) {
                    isKillswitchActive = ksResult.rows[0].value === 'true';
                    console.log(`[Server] Killswitch durumu veritabanından yüklendi: ${isKillswitchActive ? 'ASKIDA' : 'AKTİF'}`);
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

        leaderboardService.startCron().catch(err => {
            console.error('[Server] LeaderboardService başlatma hatası:', err.message);
        });

        // ─── Uption işlem durum takip cron'u (her 5 dakikada bir) ───────────
        global._paymentCheckCron = setInterval(async () => {
            try {
                await uptStatusService.checkPendingPayments();
                await uptStatusService.syncRefundsFromBank();
            } catch (err) {
                console.error('[Server] UptStatus cron hatası:', err.message);
            }
        }, 5 * 60 * 1000);

        // Başlangıçta 5 sn sonra bir kez çalıştır (restart sonrası bekleyenleri yakala)
        setTimeout(async () => {
            try {
                await uptStatusService.checkPendingPayments();
                await uptStatusService.syncRefundsFromBank();
            } catch (err) {
                console.error('[Server] UptStatus ilk çalışma hatası:', err.message);
            }
        }, 5000);
        console.log('[Server] UptStatus cron başlatıldı (5 dk aralıklı).');
    });
}

startServer().catch(err => {
    console.error('[Server] Başlatma hatası:', err);
    process.exit(1);
});


