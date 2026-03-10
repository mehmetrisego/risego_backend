const crypto = require('crypto');
const yandexFleetApi = require('./yandexFleetApi');
const netgsmService = require('./netgsmService');

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

        // Sürücü cache (telefon -> profil)
        this.driverCache = new Map();
        this.cacheExpiry = null;
        this.cacheTTL = 10 * 60 * 1000; // ✅ 10 dakika (eskiden 5'ti)

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
        setInterval(() => {
            const now = Date.now();
            // Süresi dolan oturumları temizle
            for (const [token, session] of this.sessions.entries()) {
                if (now - session.createdAt > this.SESSION_TTL) {
                    this.sessions.delete(token);
                }
            }
            // Süresi dolan admin oturumları temizle
            for (const [token, session] of this.adminSessions.entries()) {
                if (now - session.createdAt > this.SESSION_TTL) {
                    this.adminSessions.delete(token);
                }
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
        this._driverLiveCache.clear();
        // ✅ OPT: Yandex profil cache'ini de sıfırla
        yandexFleetApi.invalidateProfileCache();
    }

    /**
     * Sürücü veritabanını günceller/cache'ler
     */
    async refreshDriverCache() {
        const now = Date.now();
        if (this.driverCache.size > 0 && this.cacheExpiry && now < this.cacheExpiry) {
            return;
        }

        try {
            const driverProfiles = await yandexFleetApi.getDriverProfiles();
            this.driverCache.clear();

            for (const profile of driverProfiles) {
                const dp = profile.driver_profile || {};
                const car = profile.car || {};
                const accounts = profile.accounts || [];
                const account = accounts[0] || {};
                const phones = dp.phones || [];

                const rawBalance = parseFloat(account.balance);
                const driverInfo = {
                    id: dp.id,
                    name: `${dp.first_name || ''} ${dp.last_name || ''}`.trim(),
                    phones: phones,
                    carId: car.id || null,
                    carNumber: car.number || null,
                    car: car.number
                        ? `${car.brand || ''} ${car.model || ''} (${car.year || ''}) - Plaka: ${car.number}`
                        : 'Araç atanmamış',
                    balance: !isNaN(rawBalance)
                        ? `${Math.round(rawBalance)} ₺`
                        : '-',
                    tripCount: 0
                };

                // Her telefon numarası için cache'e ekle
                for (const phone of phones) {
                    const normalizedPhone = this.normalizePhone(phone);
                    this.driverCache.set(normalizedPhone, driverInfo);
                }
            }

            this.cacheExpiry = now + this.cacheTTL;
        } catch (error) {
            console.error('[AuthService] Sürücü veritabanı güncelleme hatası:', error.message);
            throw error;
        }
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
        await this.refreshDriverCache();

        const normalizedPhone = this.normalizePhone(phone);

        // Exact match
        if (this.driverCache.has(normalizedPhone)) {
            return this.driverCache.get(normalizedPhone);
        }

        // Try different formats
        const digits = normalizedPhone.replace(/\D/g, '');
        for (const [key, value] of this.driverCache.entries()) {
            const keyDigits = key.replace(/\D/g, '');
            if (keyDigits === digits || keyDigits.endsWith(digits.slice(-10))) {
                return value;
            }
        }

        return null;
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

        // Telefon zaten sistemde kayıtlı mı?
        const existingDriver = await this.findDriverByPhone(normalizedPhone);
        if (existingDriver) {
            return { success: false, message: 'Bu telefon numarası zaten kayıtlıdır.' };
        }

        // Rate limit
        const lastSent = this.registerOtpLastSentAt.get(normalizedPhone);
        if (lastSent && Date.now() - lastSent < this.REGISTER_OTP_RATE_LIMIT_MS) {
            const waitSec = Math.ceil((this.REGISTER_OTP_RATE_LIMIT_MS - (Date.now() - lastSent)) / 1000);
            return { success: false, message: `Yeni kod göndermek için ${waitSec} saniye bekleyin.` };
        }

        const otpCode = this.generateOTP();
        const expiresAt = Date.now() + 5 * 60 * 1000; // 5 dakika

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

        // Sürücü oluştur (yandexFleetApi.createDriverProfile)
        let result;
        try {
            result = await yandexFleetApi.createDriverProfile({
                firstName: registrationData.firstName,
                lastName: registrationData.lastName,
                phone: normalizedPhone,
                taxIdentificationNumber: registrationData.taxIdentificationNumber,
                driverLicenseNumber: registrationData.driverLicenseNumber,
                driverLicenseIssueDate: registrationData.driverLicenseIssueDate,
                driverLicenseExpiryDate: registrationData.driverLicenseExpiryDate,
                birthDate: registrationData.birthDate,
                country: registrationData.country || 'tur'
            });
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
            carNumber: null
        };

        // Bakiye ve yolculuk sayısını çek (yeni sürücü için 0 olacak)
        try {
            const [tripCount, balanceData] = await Promise.all([
                yandexFleetApi.getDriverOrderCount(driver.id).catch(() => 0),
                yandexFleetApi.getDriverBalance(driver.id).catch(() => null)
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
        this.sessions.set(sessionToken, {
            phone: normalizedPhone,
            driverId: driver.id,
            createdAt: Date.now()
        });

        return { success: true, driver, sessionToken };
    }

    /**
     * Giriş işlemi: telefon kontrolü + OTP gönderimi
     * @param {string} phone - Telefon numarası
     * @param {string} city - Şehir
     * @returns {object} İşlem sonucu
     */
    async login(phone, city) {
        // 1. Sürücüyü bul
        const driver = await this.findDriverByPhone(phone);
        if (!driver) {
            return {
                success: false,
                message: 'Bu telefon numarasına kayıtlı bir sürücü bulunamadı.'
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

        // 2. OTP oluştur
        const otpCode = this.generateOTP();
        const expiresAt = Date.now() + 5 * 60 * 1000; // 5 dakika geçerli

        this.otpStore.set(normalizedPhone, {
            code: otpCode,
            expiresAt: expiresAt,
            attempts: 0,
            driver: driver
        });

        // 3. NetGSM ile OTP SMS gönder
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

        // Başarılı - OTP'yi temizle
        const driver = otpData.driver;
        this.otpStore.delete(normalizedPhone);

        // Bakiye ve yolculuk (Sadece giriş anında bakiyeye ve günlük yolculuğa odaklanıldı, sistemi boğmamak için)
        try {
            const balanceData = await yandexFleetApi.getDriverBalance(driver.id).catch(err => null);

            // Tüm zamanları çekmek çok ağır, UI'de göstermek için 'daily' (günlük) veya dashboard'un kendi isteği tercih edilmeli.
            // driver.tripCount manuel veya ayrı apiden gelsin. Burada sistemi kilitlemiyoruz.
            driver.tripCount = await yandexFleetApi.getDriverOrderCount(driver.id, 'all').catch(() => 0);

            if (balanceData) {
                const rawBal = parseFloat(balanceData.balance);
                driver.balance = !isNaN(rawBal) ? `${Math.round(rawBal)} ₺` : driver.balance;
            }
        } catch (error) {
            console.error('[AuthService] Sürücü verileri çekilemedi:', error.message);
        }

        // Session token oluştur
        const sessionToken = crypto.randomBytes(32).toString('hex');
        this.sessions.set(sessionToken, {
            phone: normalizedPhone,
            driverId: driver.id,
            createdAt: Date.now()
        });

        return {
            success: true,
            message: 'Giriş başarılı!',
            driver: driver,
            sessionToken: sessionToken
        };
    }

    /**
     * Session token ile oturum doğrulama
     * ✅ OPT-7: Bakiye ve tripCount sürücü başına 2 dakika cache'lenir
     * Her sayfa yenilemesinde 2 API isteği atılmasını önler
     */
    async validateSession(token) {
        const session = this.sessions.get(token);
        if (!session) return null;

        if (Date.now() - session.createdAt > this.SESSION_TTL) {
            this.sessions.delete(token);
            return null;
        }

        // Sürücü bilgilerini cache'den veya API'den çek
        await this.refreshDriverCache();
        const driver = this.driverCache.get(session.phone);
        if (!driver) {
            this.sessions.delete(token);
            return null;
        }

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
                    yandexFleetApi.getDriverBalance(driver.id).catch(() => null),
                    yandexFleetApi.getDriverOrderCount(driver.id, 'all').catch(() => 0)
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
        this.adminSessions.set(adminSessionToken, {
            phone: normalizedPhone,
            createdAt: Date.now()
        });

        return {
            success: true,
            message: 'Giriş başarılı!',
            adminSessionToken
        };
    }

    /**
     * Admin session doğrulama
     */
    validateAdminSession(token) {
        const session = this.adminSessions.get(token);
        if (!session) return null;
        if (Date.now() - session.createdAt > this.SESSION_TTL) {
            this.adminSessions.delete(token);
            return null;
        }
        return session;
    }

    destroyAdminSession(token) {
        return this.adminSessions.delete(token);
    }

    /**
     * Aktif sürücü oturumu sayısını döndürür
     */
    getActiveDriverSessionCount() {
        return this.sessions.size;
    }
}

module.exports = new AuthService();

