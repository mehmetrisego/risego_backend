const crypto = require('crypto');
const config = require('../config');
const yandexFleetApi = require('./yandexFleetApi');

const leaderboardService = require('./leaderboardService');
const netgsmService = require('./netgsmService');
const dbSessions = require('../db/sessions');
const dbAdminSessions = require('../db/adminSessions');
const db = require('../db');

function isDevModeEnabled() {
    const raw = process.env.DEVMODE || process.env.devmode || '';
    return process.env.NODE_ENV === 'development' && String(raw).trim().toLowerCase() === 'enable';
}

class AuthService {
    constructor() {
        this.otpStore = new Map();

        // OTP gönderim rate limit: telefon -> son gönderim zamanı
        this.otpLastSentAt = new Map();
        this.OTP_RATE_LIMIT_MS = 60 * 1000; // 1 dakikada 1 OTP

        // Sürücü cache (telefon -> profil) — birincil park ile uyumluluk
        this.driverCache = new Map();
        this.cacheExpiry = null;
        this.cacheTTL = 30 * 60 * 1000; // ✅ 30 dakika cache süresi (eski 10 dk)
        /** partnerId -> { expiry, phoneMap } — şehir/park bazlı giriş doğrulama */
        this.parkDriverCaches = new Map();
        this._parkRefreshPending = Object.create(null);
        // İlk cache oluşmadan Yandex 429 verirse her girişin yeniden toplu
        // profil isteği başlatmasını engelleyen park bazlı devre kesici.
        this._parkRefreshBlockedUntil = Object.create(null);

        // ✅ OPT-7: Sürücü başına bakiye+trip mini-cache (2 dakika)
        // validateSession her çağrıda 2 API isteği atmaması için
        this._driverLiveCache = new Map(); // driverId -> { balance, tripCount, expiry }

        // Oturum yönetimi: token -> { phone, driverId, city, createdAt }
        this.sessions = new Map();
        this.SESSION_TTL = 10 * 365 * 24 * 60 * 60 * 1000; // 10 yıl (pratikte süresiz)
        // Admin panel OTP ve oturum
        this.adminOtpStore = new Map();
        this.adminOtpLastSentAt = new Map();
        this.adminSessions = new Map();
        this.ADMIN_SESSION_TTL = Math.max(15 * 60 * 1000, Number(process.env.ADMIN_SESSION_TTL_MS || 12 * 60 * 60 * 1000));
        this.ALLOWED_ADMIN_PHONES = ['+05466706626', '+905424571462', '+905061283492'].map(p => this.normalizePhone(p));

        // Memory Leak önlemek için belli periyotlarla ölü oturumları silen görev başlatılıyor
        this._startGarbageCollector();

        // Yandex API bakiye istekleri için park önbelleğini sorgulama callback'ini kaydet
        yandexFleetApi.registerCacheLookup((driverId, parkPartnerId) => {
            const pid = parkPartnerId || config.yandexFleet.partnerId;
            const entry = this.parkDriverCaches.get(pid);
            if (entry && entry.driverIdMap) {
                return entry.driverIdMap.get(driverId);
            }
            return null;
        });
    }

    /**
     * RAM şişmesini önleyen asenkron temizleyici görev
     */
    _startGarbageCollector() {
        setInterval(async () => {
            const now = Date.now();
            // Süresi dolan oturumları temizle (bellek)
            for (const [token, session] of this.sessions.entries()) {
                if (now - session.createdAt > this.SESSION_TTL) {
                    this.sessions.delete(token);
                }
            }
            // Süresi dolan admin oturumları temizle (bellek)
            for (const [token, session] of this.adminSessions.entries()) {
                if (now - session.createdAt > this.ADMIN_SESSION_TTL) {
                    this.adminSessions.delete(token);
                }
            }
            // DB'deki süresi dolan oturumları temizle
            if (db.isConfigured()) {
                dbSessions.deleteExpiredSessions().catch(e => console.error('[AuthService] Expired sessions cleanup:', e.message));
                dbAdminSessions.deleteExpiredAdminSessions().catch(e => console.error('[AuthService] Expired admin sessions cleanup:', e.message));
            }
            // Süresi dolan (veya patlamış) OTP verilerini temizle
            for (const [phone, otpData] of this.otpStore.entries()) {
                if (now > otpData.expiresAt) {
                    this.otpStore.delete(phone);
                }
            }
            // Admin OTP kayıtlarını temizle
            for (const [phone, otpData] of this.adminOtpStore.entries()) {
                if (now > otpData.expiresAt) {
                    this.adminOtpStore.delete(phone);
                }
            }
            // ✅ OPT-7: Sürücü mini live-cache'teki eski kayıtları temizle
            for (const [driverId, entry] of this._driverLiveCache.entries()) {
                if (now > entry.expiry) {
                    this._driverLiveCache.delete(driverId);
                }
            }
            // Rate-limit cache çöplerini temizle
            for (const [phone, lastSent] of this.otpLastSentAt.entries()) {
                if (now - lastSent > this.OTP_RATE_LIMIT_MS) this.otpLastSentAt.delete(phone);
            }
            for (const [phone, lastSent] of this.adminOtpLastSentAt.entries()) {
                if (now - lastSent > this.OTP_RATE_LIMIT_MS) this.adminOtpLastSentAt.delete(phone);
            }
        }, 1000 * 60 * 30); // ✅ Her 30 dakikada bir (eskiden saatte birdi)
    }

    /**
     * 6 haneli OTP kodu oluşturur
     */
    generateOTP() {
        return crypto.randomInt(100000, 1000000).toString();
    }

    isAllowedAdminPhone(normalizedPhone) {
        return /^\+905\d{9}$/.test(normalizedPhone) && this.ALLOWED_ADMIN_PHONES.includes(normalizedPhone);
    }

    /**
     * Cache'i invalidate eder (yeni kayıt sonrası gibi)
     */
    invalidateDriverCache() {
        this.cacheExpiry = null;
        this.driverCache.clear();
        this.parkDriverCaches.clear();
        this._parkRefreshBlockedUntil = Object.create(null);
        this._driverLiveCache.clear();
        yandexFleetApi.invalidateProfileCache();
    }

    getYandexRetryAfterMs(error) {
        const raw = error.response?.headers?.['retry-after'];
        const defaultMs = 30 * 60 * 1000;
        if (!raw) return defaultMs;

        const seconds = Number(raw);
        if (Number.isFinite(seconds) && seconds >= 0) {
            return Math.min(Math.max(seconds * 1000, 1000), 60 * 60 * 1000);
        }

        const retryDate = Date.parse(raw);
        if (Number.isFinite(retryDate)) {
            return Math.min(Math.max(retryDate - Date.now(), 1000), 60 * 60 * 1000);
        }
        return defaultMs;
    }

    createYandexRateLimitError(partnerId, retryAfterMs) {
        const error = new Error('Sürücü doğrulama servisi geçici olarak yoğun. Lütfen daha sonra tekrar deneyin.');
        error.code = 'YANDEX_RATE_LIMITED';
        error.statusCode = 503;
        error.partnerId = partnerId;
        error.retryAfterSeconds = Math.max(1, Math.ceil(retryAfterMs / 1000));
        return error;
    }

    profileToDriverInfo(profile, parkPartnerId) {
        const dp = profile.driver_profile || {};
        const car = profile.car || {};
        const accounts = profile.accounts || [];
        const account = accounts[0] || {};
        const phones = dp.phones || [];
        const rawBalance = parseFloat(account.balance);
        return {
            id: dp.id,
            name: `${dp.first_name || ''} ${dp.last_name || ''}`.trim(),
            phones,
            carId: car.id || null,
            carNumber: car.number || null,
            car: car.number
                ? `${car.brand || ''} ${car.model || ''} (${car.year || ''}) - Plaka: ${car.number}`
                : 'Araç atanmamış',
            balance: !isNaN(rawBalance) ? `${rawBalance.toFixed(2).replace('.', ',')} ₺` : '-',
            rawBalance: !isNaN(rawBalance) ? rawBalance : 0,
            tripCount: 0,
            parkPartnerId
        };
    }

    /**
     * Tek Yandex parkı için sürücü listesini önbelleğe alır (TTL: cacheTTL)
     */
    async refreshParkDriverCache(parkSource) {
        const partnerId = parkSource.partnerId;
        const now = Date.now();
        const cached = this.parkDriverCaches.get(partnerId);
        if (cached && now < cached.expiry) return;

        const blockedUntil = this._parkRefreshBlockedUntil[partnerId] || 0;
        if (now < blockedUntil) {
            if (cached) return;
            throw this.createYandexRateLimitError(partnerId, blockedUntil - now);
        }

        if (this._parkRefreshPending[partnerId]) {
            return this._parkRefreshPending[partnerId];
        }

        const task = (async () => {
            try {
                const profiles = await yandexFleetApi.fetchDriverProfilesForParkSource(parkSource);
                const phoneMap = new Map();
                const driverIdMap = new Map();
                for (const profile of profiles) {
                    const driverInfo = this.profileToDriverInfo(profile, partnerId);
                    for (const ph of driverInfo.phones || []) {
                        phoneMap.set(this.normalizePhone(ph), driverInfo);
                    }
                    if (driverInfo.id) {
                        driverIdMap.set(driverInfo.id, driverInfo);
                    }
                }
                this.parkDriverCaches.set(partnerId, {
                    expiry: Date.now() + this.cacheTTL,
                    phoneMap,
                    driverIdMap
                });
                delete this._parkRefreshBlockedUntil[partnerId];
                if (partnerId === config.yandexFleet.partnerId) {
                    this.driverCache.clear();
                    for (const [k, v] of phoneMap.entries()) {
                        this.driverCache.set(k, v);
                    }
                    this.cacheExpiry = Date.now() + this.cacheTTL;
                }
            } catch (error) {
                console.error(`[AuthService] Park sürücü önbelleği hatası (${partnerId}):`, error.message);

                // Hata durumunda (429/500/etc.) ve eski cache varsa, cooldown/spam engellemek için expiry süresini uzat
                const is429 = error.response?.status === 429 || error.message.includes('429');
                const cooldownMs = is429 ? this.getYandexRetryAfterMs(error) : 5 * 60 * 1000;
                if (cached) {
                    console.warn(`[AuthService] ${partnerId} için eski önbellek (stale) ${cooldownMs / 60000} dakika daha uzatılarak kullanılıyor.`);
                    cached.expiry = Date.now() + cooldownMs;
                    return;
                }

                if (is429) {
                    this._parkRefreshBlockedUntil[partnerId] = Date.now() + cooldownMs;
                    console.warn(`[AuthService] ${partnerId} için Yandex istekleri ${Math.ceil(cooldownMs / 1000)} saniye durduruldu.`);
                    throw this.createYandexRateLimitError(partnerId, cooldownMs);
                }

                // Eğer elimizde hiç veri yoksa (ilk yükleme hatası), o zaman mecbur hata fırlatıyoruz.
                throw error;
            } finally {
                delete this._parkRefreshPending[partnerId];
            }
        })();

        this._parkRefreshPending[partnerId] = task;
        return task;
    }

    lookupPhoneInParkCache(phone, partnerId) {
        const entry = this.parkDriverCaches.get(partnerId);
        if (!entry) return null;
        const normalizedPhone = this.normalizePhone(phone);
        const map = entry.phoneMap;
        if (map.has(normalizedPhone)) return map.get(normalizedPhone);
        const digits = normalizedPhone.replace(/\D/g, '');
        for (const [key, value] of map.entries()) {
            const keyDigits = key.replace(/\D/g, '');
            if (keyDigits === digits || keyDigits.endsWith(digits.slice(-10))) {
                return value;
            }
        }
        return null;
    }

    createDatabaseUnavailableError(cause) {
        const error = new Error('Sürücü doğrulama servisi geçici olarak kullanılamıyor. Lütfen daha sonra tekrar deneyin.');
        error.code = 'DATABASE_UNAVAILABLE';
        error.statusCode = 503;
        error.cause = cause;
        return error;
    }

    driverRowToInfo(row, fallbackParkPartnerId) {
        return {
            id: row.driver_id,
            name: `${row.first_name || ''} ${row.last_name || ''}`.trim(),
            phones: [row.phone],
            carId: row.car_id || null,
            carNumber: row.car_number || null,
            car: row.car_name || 'Araç atanmamış',
            balance: '-',
            rawBalance: 0,
            tripCount: 0,
            parkPartnerId: row.park_partner_id || fallbackParkPartnerId
        };
    }

    async findDriverInDatabase(phone, parkPartnerId, operationName) {
        if (!db.isConfigured()) {
            console.error(`[AuthService] ${operationName}: veritabanı yapılandırılmamış.`);
            throw this.createDatabaseUnavailableError();
        }

        const normalized = this.normalizePhone(phone);
        const digits = normalized.replace(/\D/g, '');
        const last10 = digits.slice(-10);

        try {
            const result = await db.query(
                `SELECT driver_id, first_name, last_name, phone, park_partner_id, city, car_id, car_number, car_name
                 FROM driver_profiles
                 WHERE park_partner_id = $1
                   AND (work_status = 'working' OR work_status IS NULL)
                   AND (phone = $2 OR phone = $3 OR phone = $4 OR phone = $5)
                 LIMIT 1`,
                [parkPartnerId, normalized, digits, '90' + last10, '0' + last10]
            );

            return result.rows?.[0]
                ? this.driverRowToInfo(result.rows[0], parkPartnerId)
                : null;
        } catch (dbError) {
            console.error(`[AuthService] ${operationName}:`, dbError.message);
            throw this.createDatabaseUnavailableError(dbError);
        }
    }

    async findDriverByPhoneInPark(phone, parkSource) {
        return this.findDriverInDatabase(phone, parkSource.partnerId, 'DB sürücü arama hatası');
    }

    /**
     * Birincil park profilleri (leaderboard vb. ile uyum)
     */
    async refreshDriverCache() {
        const sources = config.getYandexParkSources();
        if (sources.length === 0) return;
        await this.refreshParkDriverCache(sources[0]);
    }

    async getDriverForSession(phone, parkPartnerId) {
        const pid = parkPartnerId || config.yandexFleet.partnerId;
        const src = config.findYandexParkByPartnerId(pid);
        if (!src) return null;
        return this.findDriverInDatabase(phone, src.partnerId, 'DB getDriverForSession hatası');
    }

    /**
     * Telefon numarasını normalize eder (+90 formatına çevirir)
     */
    normalizePhone(phone) {
        if (!phone) return '';

        let cleaned = phone.replace(/\D/g, '');

        // Farklı formatları handle et
        if (cleaned.startsWith('90') && cleaned.length === 12) {
            return '+' + cleaned;
        }
        if (cleaned.startsWith('0') && cleaned.length === 11) {
            return '+9' + cleaned;
        }
        if (cleaned.length === 10 && cleaned.startsWith('5')) {
            return '+90' + cleaned;
        }
        if (cleaned.startsWith('90') && cleaned.length > 12) {
            return '+' + cleaned.substring(0, 12);
        }

        return '+' + cleaned;
    }

    /**
     * Giriş işlemi: telefon kontrolü + OTP gönderimi
     * @param {string} phone - Telefon numarası
     * @param {string} city - Şehir
     * @returns {object} İşlem sonucu
     */
    async login(phone, city) {
        const parkSource = config.findYandexParkByCity(city);
        if (!parkSource) {
            return {
                success: false,
                message: 'Geçersiz şehir seçimi veya bu şehirde hizmet bulunmuyor.'
            };
        }

        const normalizedPhone = this.normalizePhone(phone);
        if (!/^\+905\d{9}$/.test(normalizedPhone)) {
            return {
                success: false,
                message: 'Geçerli bir cep telefonu numarası giriniz.'
            };
        }

        const driver = await this.findDriverByPhoneInPark(normalizedPhone, parkSource);
        if (!driver) {
            return {
                success: false,
                message: 'Bu telefon numarası seçtiğiniz şehirdeki filomuzda kayıtlı değil.'
            };
        }

        // Rate limit: Aynı numaraya 1 dakikada birden fazla OTP gönderme
        const lastSent = this.otpLastSentAt.get(normalizedPhone);
        if (lastSent && Date.now() - lastSent < this.OTP_RATE_LIMIT_MS) {
            const waitSec = Math.ceil((this.OTP_RATE_LIMIT_MS - (Date.now() - lastSent)) / 1000);
            return {
                success: false,
                message: `Yeni kod göndermek için ${waitSec} saniye bekleyin.`
            };
        }

        const expiresAt = Date.now() + 5 * 60 * 1000; // 5 dakika geçerli
        const otpCode = this.generateOTP();

        this.otpStore.set(normalizedPhone, {
            code: otpCode,
            expiresAt: expiresAt,
            attempts: 0,
            driver: driver,
            city: city || '',
            parkPartnerId: parkSource.partnerId
        });

        const smsMessage = `RiseGo doğrulama kodunuz: ${otpCode}. Bu kod 5 dakika geçerlidir.`;
        const smsResult = await netgsmService.sendOtpSms(normalizedPhone, smsMessage);

        if (!smsResult.success) {
            this.otpStore.delete(normalizedPhone);
            console.error('[AuthService] OTP SMS gönderilemedi:', smsResult.error);
            return {
                success: false,
                message: 'SMS gönderilemedi. Lütfen bir süre sonra tekrar deneyin.'
            };
        }

        this.otpLastSentAt.set(normalizedPhone, Date.now());

        return {
            success: true,
            message: 'Doğrulama kodu telefonunuza gönderildi.'
        };
    }

    /**
     * OTP doğrulama
     * @param {string} phone - Telefon numarası
     * @param {string} otp - Girilen OTP kodu
     * @returns {object} Doğrulama sonucu
     */
    async verifyOTP(phone, otp) {
        const normalizedPhone = this.normalizePhone(phone);
        const otpData = this.otpStore.get(normalizedPhone);
        const otpTrimmed = String(otp || '').trim().replace(/\D/g, '');

        if (!otpData) {
            return {
                success: false,
                message: 'Doğrulama kodu bulunamadı. Lütfen tekrar giriş yapın.'
            };
        }

        // Süre kontrolü
        if (Date.now() > otpData.expiresAt) {
            this.otpStore.delete(normalizedPhone);
            return {
                success: false,
                message: 'Doğrulama kodunun süresi doldu. Lütfen yeni kod isteyin.'
            };
        }

        // Deneme sayısı kontrolü
        if (otpData.attempts >= 5) {
            this.otpStore.delete(normalizedPhone);
            return {
                success: false,
                message: 'Çok fazla deneme yapıldı. Lütfen yeni kod isteyin.'
            };
        }

        // Kod kontrolü
        const isDevBypass = isDevModeEnabled() && otpTrimmed === '000000';
        otpData.attempts++;
        if (!isDevBypass && otpData.code !== otpTrimmed) {
            return {
                success: false,
                message: `Geçersiz doğrulama kodu. ${5 - otpData.attempts} deneme hakkınız kaldı.`
            };
        }

        const driver = { ...otpData.driver, parkPartnerId: otpData.parkPartnerId };
        this.otpStore.delete(normalizedPhone);

        const parkPid = otpData.parkPartnerId;
        try {
            // Sadece tripCount bilgisini al (Yandex'ten çekme)
            const tripCount = await leaderboardService.getDriverTripCount(driver.id, 'all', driver.parkPartnerId).catch(() => 0);
            
            driver.tripCount = tripCount;

            // Mini-cache'e yaz (girişte 2 dk geçerli)
            this._driverLiveCache.set(driver.id, {
                balance: driver.balance,
                tripCount: driver.tripCount,
                car: driver.car,
                carId: driver.carId,
                carNumber: driver.carNumber,
                expiry: Date.now() + 2 * 60 * 1000
            });
        } catch (error) {
            console.error('[AuthService] Sürücü verileri çekilemedi:', error.message);
        }

        // Session token oluştur
        const sessionToken = crypto.randomBytes(32).toString('hex');
        const expiresAt = Date.now() + this.SESSION_TTL;
        this.sessions.set(sessionToken, {
            phone: normalizedPhone,
            driverId: driver.id,
            createdAt: Date.now(),
            parkPartnerId: parkPid
        });
        if (db.isConfigured()) {
            await dbSessions.createSession(
                sessionToken,
                driver.id,
                normalizedPhone,
                otpData.city || '',
                expiresAt,
                parkPid
            );
        }

        return {
            success: true,
            message: 'Giriş başarılı!',
            driver: driver,
            sessionToken: sessionToken
        };
    }

    /** DB oturum satırından park UUID (city → findYandexParkByCity) */
    _resolveParkPartnerIdFromDbSession(dbSession, memorySession) {
        let parkPid = (dbSession.park_partner_id || '').trim();
        if (!parkPid && dbSession.city) {
            const byCity = config.findYandexParkByCity(dbSession.city);
            if (byCity) parkPid = byCity.partnerId;
        }
        if (!parkPid && memorySession && memorySession.parkPartnerId) {
            parkPid = String(memorySession.parkPartnerId).trim();
        }
        if (!parkPid) parkPid = config.yandexFleet.partnerId;
        return parkPid;
    }

    /** Token → park UUID (DB/RAM; Yandex çağrısı yok) — GET /api/campaign için */
    async getSessionParkPartnerId(token) {
        if (!token) return null;
        const memSession = this.sessions.get(token);
        if (db.isConfigured()) {
            try {
                const dbSession = await dbSessions.getSession(token);
                if (dbSession) {
                    return this._resolveParkPartnerIdFromDbSession(dbSession, memSession);
                }
            } catch (_) { /* DB hatası — RAM'e düş */ }
        }
        if (memSession) {
            if (Date.now() - memSession.createdAt > this.SESSION_TTL) return null;
            return memSession.parkPartnerId || config.yandexFleet.partnerId;
        }
        return null;
    }

    /**
     * Oturum doğrulama; bakiye ve tripCount 2 dk cache
     */
    async validateSession(token) {
        let session = this.sessions.get(token);
        if (db.isConfigured()) {
            const dbSession = await dbSessions.getSession(token);
            if (dbSession) {
                const parkPartnerId = this._resolveParkPartnerIdFromDbSession(dbSession, session);
                session = {
                    phone: dbSession.phone,
                    driverId: dbSession.driver_id,
                    createdAt: new Date(dbSession.created_at).getTime(),
                    parkPartnerId
                };
            }
        }
        if (!session) return null;

        if (Date.now() - session.createdAt > this.SESSION_TTL) {
            this.sessions.delete(token);
            if (db.isConfigured()) await dbSessions.deleteSession(token);
            return null;
        }

        const parkPid = session.parkPartnerId || config.yandexFleet.partnerId;
        const driver = await this.getDriverForSession(session.phone, parkPid);
        if (!driver) {
            this.sessions.delete(token);
            if (db.isConfigured()) await dbSessions.deleteSession(token);
            return null;
        }
        driver.parkPartnerId = parkPid;

        const now = Date.now();
        const LIVE_TTL = 2 * 60 * 1000; // 2 dakika
        const cached = this._driverLiveCache.get(driver.id);

        if (cached && now < cached.expiry) {
            // Cache geçerli — API'ye gitmeden taze gibi göster
            driver.balance = cached.balance;
            driver.tripCount = cached.tripCount;
            if (cached.car) {
                driver.car = cached.car;
                driver.carId = cached.carId;
                driver.carNumber = cached.carNumber;
            }
        } else {
            // Cache süresi dolmuş veya yok — Yandex API kullanılmıyor, databaseden gelen veriler kullanılıyor
            try {
                const tripCount = await leaderboardService.getDriverTripCount(driver.id, 'all', driver.parkPartnerId).catch(() => 0);

                driver.tripCount = tripCount;

                // Mini-cache'e yaz
                this._driverLiveCache.set(driver.id, {
                    balance: driver.balance,
                    tripCount: driver.tripCount,
                    car: driver.car,
                    carId: driver.carId,
                    carNumber: driver.carNumber,
                    expiry: now + LIVE_TTL
                });
            } catch (e) {
                console.error('[AuthService] Session veri çekme hatası:', e.message);
            }
        }

        return driver;
    }

    /**
     * Session'ı sonlandırır (çıkış)
     */
    destroySession(token) {
        if (db.isConfigured()) dbSessions.deleteSession(token).catch(err => console.error('[AuthService] Session silme hatası:', err.message));
        return this.sessions.delete(token);
    }

    // ============================================
    // Admin Panel OTP (sadece yetkili numaralar)
    // ============================================

    /**
     * Admin giriş: sadece yetkili numaralara OTP gönderir
     * @param {string} phone - Telefon numarası
     * @returns {object} İşlem sonucu
     */
    async adminLogin(phone) {
        const normalizedPhone = this.normalizePhone(phone);

        // Yetkili numara kontrolü
        const isAllowed = this.isAllowedAdminPhone(normalizedPhone);

        if (!isAllowed) {
            return {
                success: false,
                message: 'Yetkisi olmayan bir numara tuşladınız'
            };
        }

        // Rate limit
        const lastSent = this.adminOtpLastSentAt.get(normalizedPhone);
        if (lastSent && Date.now() - lastSent < this.OTP_RATE_LIMIT_MS) {
            const waitSec = Math.ceil((this.OTP_RATE_LIMIT_MS - (Date.now() - lastSent)) / 1000);
            return {
                success: false,
                message: `Yeni kod göndermek için ${waitSec} saniye bekleyin.`
            };
        }

        const otpCode = this.generateOTP();
        const expiresAt = Date.now() + 5 * 60 * 1000; // 5 dakika

        this.adminOtpStore.set(normalizedPhone, {
            code: otpCode,
            expiresAt,
            attempts: 0
        });

        const smsMessage = `RiseGo doğrulama kodunuz: ${otpCode}. Bu kod 5 dakika geçerlidir.`;
        const smsResult = await netgsmService.sendOtpSms(normalizedPhone, smsMessage);

        if (!smsResult.success) {
            this.adminOtpStore.delete(normalizedPhone);
            return {
                success: false,
                message: 'SMS gönderilemedi. Lütfen bir süre sonra tekrar deneyin.'
            };
        }

        this.adminOtpLastSentAt.set(normalizedPhone, Date.now());

        return {
            success: true,
            message: 'Doğrulama kodu telefonunuza gönderildi.'
        };
    }

    /**
     * Admin OTP doğrulama
     * @param {string} phone - Telefon numarası
     * @param {string} otp - OTP kodu
     * @returns {object} { success, adminSessionToken } veya hata
     */
    async adminVerifyOTP(phone, otp) {
        const normalizedPhone = this.normalizePhone(phone);
        const otpTrimmed = String(otp || '').trim().replace(/\D/g, '');

        // Yetkili numara kontrolü (tekrar)
        const isAllowed = this.isAllowedAdminPhone(normalizedPhone);
        if (!isAllowed) {
            return { success: false, message: 'Yetkisi olmayan bir numara tuşladınız' };
        }

        const otpData = this.adminOtpStore.get(normalizedPhone);
        const storeKey = normalizedPhone;

        if (!otpData) {
            return {
                success: false,
                message: 'Doğrulama kodu bulunamadı. Lütfen tekrar giriş yapın.'
            };
        }

        if (Date.now() > otpData.expiresAt) {
            this.adminOtpStore.delete(storeKey);
            return {
                success: false,
                message: 'Doğrulama kodunun süresi doldu. Lütfen yeni kod isteyin.'
            };
        }

        if (otpData.attempts >= 5) {
            this.adminOtpStore.delete(storeKey);
            return {
                success: false,
                message: 'Çok fazla deneme yapıldı. Lütfen yeni kod isteyin.'
            };
        }

        otpData.attempts++;
        if (otpData.code !== otpTrimmed) {
            return {
                success: false,
                message: `Geçersiz doğrulama kodu. ${5 - otpData.attempts} deneme hakkınız kaldı.`
            };
        }

        this.adminOtpStore.delete(storeKey);

        const adminSessionToken = crypto.randomBytes(32).toString('hex');
        const expiresAt = Date.now() + this.ADMIN_SESSION_TTL;
        this.adminSessions.set(adminSessionToken, {
            phone: normalizedPhone,
            createdAt: Date.now()
        });
        if (db.isConfigured()) {
            await dbAdminSessions.createAdminSession(adminSessionToken, normalizedPhone, expiresAt);
        }

        return {
            success: true,
            message: 'Giriş başarılı!',
            adminSessionToken
        };
    }

    /**
     * Admin session doğrulama
     */
    async validateAdminSession(token) {
        let session = this.adminSessions.get(token);
        if (db.isConfigured()) {
            const dbSession = await dbAdminSessions.getAdminSession(token);
            if (dbSession) {
                session = { phone: dbSession.phone, createdAt: new Date(dbSession.created_at).getTime() };
            }
        }
        if (!session) return null;
        if (Date.now() - session.createdAt > this.ADMIN_SESSION_TTL) {
            this.adminSessions.delete(token);
            if (db.isConfigured()) await dbAdminSessions.deleteAdminSession(token);
            return null;
        }
        return session;
    }

    destroyAdminSession(token) {
        if (db.isConfigured()) dbAdminSessions.deleteAdminSession(token).catch(err => console.error('[AuthService] Admin session silme hatası:', err.message));
        return this.adminSessions.delete(token);
    }

    /**
     * Aktif sürücü oturumu sayısını döndürür
     */
    async getActiveDriverSessionCount() {
        if (db.isConfigured()) {
            return await dbSessions.getActiveSessionCount();
        }
        return this.sessions.size;
    }
}

module.exports = new AuthService();

