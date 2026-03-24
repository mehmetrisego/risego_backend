const crypto = require('crypto');
const config = require('../config');
const yandexFleetApi = require('./yandexFleetApi');
const leaderboardService = require('./leaderboardService');
const netgsmService = require('./netgsmService');
const dbSessions = require('../db/sessions');
const dbAdminSessions = require('../db/adminSessions');
const db = require('../db');

class AuthService {
    constructor() {
        this.otpStore = new Map();

        // Kayıt OTP store: telefon -> { code, expiresAt, attempts, registrationData }
        this.registerOtpStore = new Map();
        this.registerOtpLastSentAt = new Map();
        this.REGISTER_OTP_RATE_LIMIT_MS = 60 * 1000; // 1 dakikada 1 OTP

        // OTP gönderim rate limit: telefon -> son gönderim zamanı
        this.otpLastSentAt = new Map();
        this.OTP_RATE_LIMIT_MS = 60 * 1000; // 1 dakikada 1 OTP

        // Sürücü cache (telefon -> profil) — birincil park ile uyumluluk
        this.driverCache = new Map();
        this.cacheExpiry = null;
        this.cacheTTL = 10 * 60 * 1000; // ✅ 10 dakika (eskiden 5'ti)
        /** partnerId -> { expiry, phoneMap } — şehir/park bazlı giriş doğrulama */
        this.parkDriverCaches = new Map();
        this._parkRefreshPending = Object.create(null);

        // ✅ OPT-7: Sürücü başına bakiye+trip mini-cache (2 dakika)
        // validateSession her çağrıda 2 API isteği atmaması için
        this._driverLiveCache = new Map(); // driverId -> { balance, tripCount, expiry }

        // Oturum yönetimi: token -> { phone, driverId, city, createdAt }
        this.sessions = new Map();
        this.SESSION_TTL = 7 * 24 * 60 * 60 * 1000; // 7 gün
        // Admin panel OTP ve oturum
        this.adminOtpStore = new Map();
        this.adminOtpLastSentAt = new Map();
        this.adminSessions = new Map();
        this.ALLOWED_ADMIN_PHONES = ['+05466706626', '+905424571462', '+905061283492'].map(p => this.normalizePhone(p));

        // Memory Leak önlemek için belli periyotlarla ölü oturumları silen görev başlatılıyor
        this._startGarbageCollector();
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
                if (now - session.createdAt > this.SESSION_TTL) {
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
            // Süresi dolan kayıt form OTP çöplerini temizle
            for (const [phone, otpData] of this.registerOtpStore.entries()) {
                if (now > otpData.expiresAt) {
                    this.registerOtpStore.delete(phone);
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
        }, 1000 * 60 * 30); // ✅ Her 30 dakikada bir (eskiden saatte birdi)
    }

    /**
     * 6 haneli OTP kodu oluşturur
     */
    generateOTP() {
        return Math.floor(100000 + Math.random() * 900000).toString();
    }

    /**
     * Cache'i invalidate eder (yeni kayıt sonrası gibi)
     */
    invalidateDriverCache() {
        this.cacheExpiry = null;
        this.driverCache.clear();
        this.parkDriverCaches.clear();
        this._driverLiveCache.clear();
        yandexFleetApi.invalidateProfileCache();
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
            balance: !isNaN(rawBalance) ? `${Math.round(rawBalance)} ₺` : '-',
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

        if (this._parkRefreshPending[partnerId]) {
            return this._parkRefreshPending[partnerId];
        }

        const task = (async () => {
            try {
                const profiles = await yandexFleetApi.fetchDriverProfilesForParkSource(parkSource);
                const phoneMap = new Map();
                for (const profile of profiles) {
                    const driverInfo = this.profileToDriverInfo(profile, partnerId);
                    for (const ph of driverInfo.phones || []) {
                        phoneMap.set(this.normalizePhone(ph), driverInfo);
                    }
                }
                this.parkDriverCaches.set(partnerId, {
                    expiry: Date.now() + this.cacheTTL,
                    phoneMap
                });
                if (partnerId === config.yandexFleet.partnerId) {
                    this.driverCache.clear();
                    for (const [k, v] of phoneMap.entries()) {
                        this.driverCache.set(k, v);
                    }
                    this.cacheExpiry = Date.now() + this.cacheTTL;
                }
            } catch (error) {
                console.error('[AuthService] Park sürücü önbelleği hatası:', partnerId, error.message);
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

    async findDriverByPhoneInPark(phone, parkSource) {
        await this.refreshParkDriverCache(parkSource);
        return this.lookupPhoneInParkCache(phone, parkSource.partnerId);
    }

    /** Kayıt: telefon herhangi bir filoda var mı */
    async findDriverByPhoneInAnyPark(phone) {
        const sources = config.getYandexParkSources();
        if (sources.length === 0) return null;
        await Promise.all(sources.map(s => this.refreshParkDriverCache(s)));
        const normalized = this.normalizePhone(phone);
        for (const src of sources) {
            const d = this.lookupPhoneInParkCache(normalized, src.partnerId);
            if (d) return d;
        }
        return null;
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
        await this.refreshParkDriverCache(src);
        return this.lookupPhoneInParkCache(phone, pid);
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
     * Telefon numarasıyla sürücü arar
     * @param {string} phone - Telefon numarası
     * @returns {object|null} Sürücü bilgisi veya null
     */
    async findDriverByPhone(phone) {
        return this.findDriverByPhoneInAnyPark(phone);
    }

    /**
     * Kayıt için OTP gönderir (sürücü henüz oluşturulmadan)
     * Telefon sistemde kayıtlı olmamalı
     * @param {string} phone - Telefon numarası
     * @param {string} city - Şehir
     * @param {object} registrationData - Kayıt form verileri
     * @returns {object} İşlem sonucu
     */
    async sendRegistrationOTP(phone, city, registrationData) {
        const normalizedPhone = this.normalizePhone(phone);

        if (!config.findYandexParkByCity(city)) {
            return { success: false, message: 'Geçersiz şehir seçimi veya bu şehirde kayıt kabul edilmiyor.' };
        }

        // Telefon zaten herhangi bir filoda kayıtlı mı?
        const existingDriver = await this.findDriverByPhoneInAnyPark(normalizedPhone);
        if (existingDriver) {
            return { success: false, message: 'Bu telefon numarası zaten kayıtlıdır.' };
        }

        // Rate limit
        const lastSent = this.registerOtpLastSentAt.get(normalizedPhone);
        if (lastSent && Date.now() - lastSent < this.REGISTER_OTP_RATE_LIMIT_MS) {
            const waitSec = Math.ceil((this.REGISTER_OTP_RATE_LIMIT_MS - (Date.now() - lastSent)) / 1000);
            return { success: false, message: `Yeni kod göndermek için ${waitSec} saniye bekleyin.` };
        }

        const expiresAt = Date.now() + 5 * 60 * 1000; // 5 dakika
        const otpCode = this.generateOTP();

        this.registerOtpStore.set(normalizedPhone, {
            code: otpCode,
            expiresAt,
            attempts: 0,
            registrationData: { ...registrationData, city }
        });

        const smsMessage = `RiseGo kayıt doğrulama kodunuz: ${otpCode}. Bu kod 5 dakika geçerlidir.`;
        const smsResult = await netgsmService.sendOtpSms(normalizedPhone, smsMessage);
        if (!smsResult.success) {
            this.registerOtpStore.delete(normalizedPhone);
            return { success: false, message: 'SMS gönderilemedi. Lütfen bir süre sonra tekrar deneyin.' };
        }

        this.registerOtpLastSentAt.set(normalizedPhone, Date.now());

        return { success: true, message: 'Doğrulama kodu telefonunuza gönderildi.' };
    }

    /**
     * Kayıt OTP doğrular, sürücü oluşturur ve oturum açar
     * @param {string} phone - Telefon numarası
     * @param {string} otp - OTP kodu
     * @returns {object} { success, driver, sessionToken } veya hata
     */
    async verifyRegistrationOTP(phone, otp) {
        const normalizedPhone = this.normalizePhone(phone);
        const data = this.registerOtpStore.get(normalizedPhone);

        if (!data) {
            return { success: false, message: 'Doğrulama kodu bulunamadı. Lütfen tekrar deneyin.' };
        }

        if (Date.now() > data.expiresAt) {
            this.registerOtpStore.delete(normalizedPhone);
            return { success: false, message: 'Doğrulama kodunun süresi doldu. Lütfen yeni kod isteyin.' };
        }

        if (data.attempts >= 5) {
            this.registerOtpStore.delete(normalizedPhone);
            return { success: false, message: 'Çok fazla deneme yapıldı. Lütfen yeni kod isteyin.' };
        }

        data.attempts++;
        if (data.code !== otp) {
            return {
                success: false,
                message: `Geçersiz doğrulama kodu. ${5 - data.attempts} deneme hakkınız kaldı.`
            };
        }

        // OTP doğru - store'dan al ve temizle
        const { registrationData } = data;
        this.registerOtpStore.delete(normalizedPhone);

        const parkForRegistration = config.findYandexParkByCity(registrationData.city);
        if (!parkForRegistration) {
            return { success: false, message: 'Geçersiz şehir seçimi veya bu şehirde kayıt kabul edilmiyor.' };
        }

        let result;
        try {
            result = await yandexFleetApi.createDriverProfile(
                {
                    firstName: registrationData.firstName,
                    lastName: registrationData.lastName,
                    phone: normalizedPhone,
                    taxIdentificationNumber: registrationData.taxIdentificationNumber,
                    driverLicenseNumber: registrationData.driverLicenseNumber,
                    driverLicenseIssueDate: registrationData.driverLicenseIssueDate,
                    driverLicenseExpiryDate: registrationData.driverLicenseExpiryDate,
                    birthDate: registrationData.birthDate,
                    country: registrationData.country || 'tur'
                },
                parkForRegistration.partnerId
            );
        } catch (err) {
            console.error('[AuthService] Sürücü oluşturma hatası:', err.message);
            return { success: false, message: err.message || 'Sürücü oluşturulurken hata oluştu.' };
        }

        this.invalidateDriverCache();

        const driver = {
            id: result.contractorProfileId,
            name: `${registrationData.firstName} ${registrationData.lastName}`.trim(),
            car: 'Araç atanmamış',
            balance: '-',
            tripCount: 0,
            carId: null,
            carNumber: null,
            parkPartnerId: parkForRegistration.partnerId
        };

        // Bakiye ve yolculuk sayısını çek (yeni sürücü için 0 olacak)
        try {
            const [tripCount, balanceData] = await Promise.all([
                leaderboardService.getDriverTripCount(driver.id, 'all', driver.parkPartnerId).catch(() => 0),
                yandexFleetApi.getDriverBalance(driver.id, parkForRegistration.partnerId).catch(() => null)
            ]);
            driver.tripCount = tripCount;
            if (balanceData) {
                const rawBal = parseFloat(balanceData.balance);
                driver.balance = !isNaN(rawBal) ? `${Math.round(rawBal)} ₺` : '-';
            }
        } catch (e) {
            console.error('[AuthService] Yeni sürücü verileri çekilemedi:', e.message);
        }

        const sessionToken = crypto.randomBytes(32).toString('hex');
        const expiresAt = Date.now() + this.SESSION_TTL;
        this.sessions.set(sessionToken, {
            phone: normalizedPhone,
            driverId: driver.id,
            createdAt: Date.now(),
            parkPartnerId: parkForRegistration.partnerId
        });
        if (db.isConfigured()) {
            await dbSessions.createSession(
                sessionToken,
                driver.id,
                normalizedPhone,
                registrationData.city || '',
                expiresAt,
                parkForRegistration.partnerId
            );
        }

        return { success: true, driver, sessionToken };
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

        const driver = await this.findDriverByPhoneInPark(phone, parkSource);
        if (!driver) {
            return {
                success: false,
                message: 'Bu telefon numarası seçtiğiniz şehirdeki filomuzda kayıtlı değil.'
            };
        }

        const normalizedPhone = this.normalizePhone(phone);

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
        otpData.attempts++;
        if (otpData.code !== otp) {
            return {
                success: false,
                message: `Geçersiz doğrulama kodu. ${5 - otpData.attempts} deneme hakkınız kaldı.`
            };
        }

        const driver = { ...otpData.driver, parkPartnerId: otpData.parkPartnerId };
        this.otpStore.delete(normalizedPhone);

        const parkPid = otpData.parkPartnerId;
        try {
            const balanceData = await yandexFleetApi.getDriverBalance(driver.id, parkPid).catch(err => null);

            // Tüm zamanları çekmek çok ağır, UI'de göstermek için 'daily' (günlük) veya dashboard'un kendi isteği tercih edilmeli.
            // driver.tripCount manuel veya ayrı apiden gelsin. Burada sistemi kilitlemiyoruz.
            driver.tripCount = await leaderboardService.getDriverTripCount(driver.id, 'all', driver.parkPartnerId).catch(() => 0);

            if (balanceData) {
                const rawBal = parseFloat(balanceData.balance);
                driver.balance = !isNaN(rawBal) ? `${Math.round(rawBal)} ₺` : driver.balance;
            }
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
        } else {
            // Cache süresi dolmuş veya yok — taze çek
            try {
                const [balanceData, tripCount] = await Promise.all([
                    yandexFleetApi.getDriverBalance(driver.id, parkPid).catch(() => null),
                    leaderboardService.getDriverTripCount(driver.id, 'all', driver.parkPartnerId).catch(() => 0)
                ]);

                if (balanceData) {
                    const rawBal = parseFloat(balanceData.balance);
                    driver.balance = !isNaN(rawBal) ? `${Math.round(rawBal)} ₺` : driver.balance;
                }
                driver.tripCount = tripCount;

                // Mini-cache'e yaz
                this._driverLiveCache.set(driver.id, {
                    balance: driver.balance,
                    tripCount: driver.tripCount,
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
        const digits = normalizedPhone.replace(/\D/g, '');
        const isAllowed = this.ALLOWED_ADMIN_PHONES.some(allowed => {
            const allowedDigits = allowed.replace(/\D/g, '');
            return digits === allowedDigits || digits.endsWith(allowedDigits.slice(-10)) || allowedDigits.endsWith(digits.slice(-10));
        });

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

        console.log(`[Admin OTP] ${normalizedPhone} numarasına gönderilen kod: ${otpCode}`);

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
        const digits = normalizedPhone.replace(/\D/g, '');
        const isAllowed = this.ALLOWED_ADMIN_PHONES.some(allowed => {
            const allowedDigits = allowed.replace(/\D/g, '');
            return digits === allowedDigits || digits.endsWith(allowedDigits.slice(-10)) || allowedDigits.endsWith(digits.slice(-10));
        });
        if (!isAllowed) {
            return { success: false, message: 'Yetkisi olmayan bir numara tuşladınız' };
        }

        // OTP verisini bul (normalizedPhone veya digit eşleşmesi ile)
        let otpData = this.adminOtpStore.get(normalizedPhone);
        let storeKey = normalizedPhone;
        if (!otpData) {
            const inputDigits = digits.length >= 10 ? digits.slice(-10) : digits;
            for (const [key, data] of this.adminOtpStore.entries()) {
                const keyDigits = key.replace(/\D/g, '');
                const keyLast10 = keyDigits.length >= 10 ? keyDigits.slice(-10) : keyDigits;
                if (keyDigits === digits || keyLast10 === inputDigits || keyDigits.endsWith(inputDigits) || digits.endsWith(keyLast10)) {
                    otpData = data;
                    storeKey = key;
                    break;
                }
            }
        }

        if (!otpData) {
            console.log(`[Admin OTP] Doğrulama: ${normalizedPhone} için store\'da kayıt yok. Store keys:`, [...this.adminOtpStore.keys()]);
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
            console.log(`[Admin OTP] Kod uyuşmazlığı - Beklenen: "${otpData.code}" (${typeof otpData.code}), Girilen: "${otpTrimmed}" (${typeof otpTrimmed}), Telefon: ${normalizedPhone}`);
            return {
                success: false,
                message: `Geçersiz doğrulama kodu. ${5 - otpData.attempts} deneme hakkınız kaldı.`
            };
        }

        this.adminOtpStore.delete(storeKey);

        console.log(`[Admin OTP] Başarılı giriş: ${normalizedPhone}`);

        const adminSessionToken = crypto.randomBytes(32).toString('hex');
        const expiresAt = Date.now() + this.SESSION_TTL;
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
        if (Date.now() - session.createdAt > this.SESSION_TTL) {
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

