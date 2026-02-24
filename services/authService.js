const crypto = require('crypto');
const yandexFleetApi = require('./yandexFleetApi');

class AuthService {
    constructor() {
        this.otpStore = new Map();

        // Sürücü cache (telefon -> profil)
        this.driverCache = new Map();
        this.cacheExpiry = null;
        this.cacheTTL = 5 * 60 * 1000;

        // Oturum yönetimi: token -> { phone, driverId, city, createdAt }
        this.sessions = new Map();
        this.SESSION_TTL = 30 * 24 * 60 * 60 * 1000; // 30 gün
    }

    /**
     * 6 haneli rastgele OTP kodu oluşturur
     */
    generateOTP() {
        return Math.floor(100000 + Math.random() * 900000).toString();
    }

    /**
     * Sürücü veritabanını günceller/cache'ler
     */
    async refreshDriverCache() {
        const now = Date.now();
        if (this.driverCache.size > 0 && this.cacheExpiry && now < this.cacheExpiry) {
            console.log('[AuthService] Sürücü cache aktif, API çağrısı atlanıyor.');
            return;
        }

        console.log('[AuthService] Sürücü veritabanı güncelleniyor...');
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
            console.log(`[AuthService] ${driverProfiles.length} sürücü cache'lendi. ${this.driverCache.size} telefon numarası eşlendi.`);
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
        console.log(`[AuthService] Sürücü aranıyor: ${normalizedPhone}`);

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

        console.log(`[AuthService] Sürücü bulunamadı: ${normalizedPhone}`);
        return null;
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

        // 2. OTP oluştur
        const otpCode = this.generateOTP();
        const expiresAt = Date.now() + 5 * 60 * 1000; // 5 dakika geçerli

        this.otpStore.set(this.normalizePhone(phone), {
            code: otpCode,
            expiresAt: expiresAt,
            attempts: 0,
            driver: driver
        });

        console.log(`[AuthService] OTP oluşturuldu: ${phone} -> ${otpCode} (NetGSM entegrasyonu sonra eklenecek)`);

        // OTP gönderimi: NetGSM API ile eklenecek. Şimdilik sadece store'da tutuluyor.
        return {
            success: true,
            message: 'Doğrulama kodu hazırlandı.'
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

        // Yolculuk sayısı ve bakiyeyi paralel çek
        try {
            const [tripCount, balanceData] = await Promise.all([
                yandexFleetApi.getDriverOrderCount(driver.id).catch(err => {
                    console.error('[AuthService] Yolculuk sayısı çekilemedi:', err.message);
                    return 0;
                }),
                yandexFleetApi.getDriverBalance(driver.id).catch(err => {
                    console.error('[AuthService] Bakiye çekilemedi:', err.message);
                    return null;
                })
            ]);

            driver.tripCount = tripCount;

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
        console.log(`[AuthService] Oturum oluşturuldu: ${driver.name}`);

        return {
            success: true,
            message: 'Giriş başarılı!',
            driver: driver,
            sessionToken: sessionToken
        };
    }

    /**
     * Session token ile oturum doğrulama
     * Geçerliyse sürücü verisini taze çekip döner
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

        // Bakiye ve yolculuk sayısını taze çek
        try {
            const [tripCount, balanceData] = await Promise.all([
                yandexFleetApi.getDriverOrderCount(driver.id).catch(() => 0),
                yandexFleetApi.getDriverBalance(driver.id).catch(() => null)
            ]);
            driver.tripCount = tripCount;
            if (balanceData) {
                const rawBal = parseFloat(balanceData.balance);
                driver.balance = !isNaN(rawBal) ? `${Math.round(rawBal)} ₺` : driver.balance;
            }
        } catch (e) {
            console.error('[AuthService] Session veri çekme hatası:', e.message);
        }

        return driver;
    }

    /**
     * Session'ı sonlandırır (çıkış)
     */
    destroySession(token) {
        const existed = this.sessions.delete(token);
        if (existed) console.log('[AuthService] Oturum sonlandırıldı.');
        return existed;
    }
}

module.exports = new AuthService();

