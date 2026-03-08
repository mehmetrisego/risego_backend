// Sunucunun saat dilimini Türkiye (İstanbul) olarak ayarla
process.env.TZ = 'Europe/Istanbul';

require('dotenv').config();
const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');

const config = require('./config');
const yandexFleetApi = require('./services/yandexFleetApi');
const { writeDriversToFile } = require('./services/fileWriter');
const authService = require('./services/authService');

const path = require('path');
const app = express();

// Güvenlik Katmanı 1: Helmet - Başlıkları güvenlik altına alır
app.use(helmet());

// Güvenlik Katmanı 2: CORS - Sadece belirtilen domainlere izin verilir (Tarayıcı saldırı koruması)
const allowedOrigins = [
    'https://risegodriver.com',
    'https://www.risegodriver.com',
    'https://mehmetrisego.github.io',
    'http://localhost:3000',
    'http://127.0.0.1:3000',
    'http://127.0.0.1:5500',
    'http://localhost:5500',
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
    allowedHeaders: ['Origin', 'X-Requested-With', 'Content-Type', 'Accept', 'x-session-token', 'x-admin-token'],
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

// ============================================
// Kampanya State (in-memory - sunucu yeniden başlatılana kadar kalır)
// Prodüksiyon ortamında veritabanına taşınmalı
// ============================================
let activeCampaign = {
    text: '',       // Kampanya metni
    active: false,  // Kampanya aktif mi?
    updatedAt: null // Son güncelleme tarihi
};

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

// Admin panel oturum doğrulama
function requireAdminAuth(req, res, next) {
    const token = req.headers['x-admin-token'];
    if (!token) {
        return res.status(401).json({ success: false, message: 'Oturum bulunamadı. Lütfen giriş yapın.' });
    }
    const session = authService.validateAdminSession(token);
    if (!session) {
        return res.status(401).json({ success: false, message: 'Oturum geçersiz veya süresi dolmuş. Lütfen tekrar giriş yapın.' });
    }
    req.adminSession = session;
    next();
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

        const tripCount = await yandexFleetApi.getDriverOrderCount(driverId, selectedPeriod);

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
 * POST /api/drivers/balance
 * Belirli bir sürücünün bakiyesini döner (oturum gerekli)
 */
app.post('/api/drivers/balance', requireAuth, async (req, res) => {
    try {
        const driverId = req.sessionDriver.id;

        const balanceData = await yandexFleetApi.getDriverBalance(driverId);

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
 * GET /api/leaderboard
 * Sıralama tablosu: top 30 + kullanıcının sırası (oturum gerekli)
 * Query: ?from=YYYY-MM-DD&to=YYYY-MM-DD → tarih aralığı (zorunlu, en fazla 31 gün)
 */
app.get('/api/leaderboard', requireAuth, async (req, res) => {
    try {
        const driverId = req.sessionDriver.id;
        const { from, to } = req.query;

        if (!from || !to) {
            return res.status(400).json({
                success: false,
                message: 'Başlangıç ve bitiş tarihi gereklidir (from, to).'
            });
        }

        const startDate = new Date(from);
        const endDate = new Date(to);
        if (isNaN(startDate.getTime()) || isNaN(endDate.getTime())) {
            return res.status(400).json({
                success: false,
                message: 'Geçersiz tarih formatı.'
            });
        }
        if (startDate > endDate) {
            return res.status(400).json({
                success: false,
                message: 'Başlangıç tarihi bitiş tarihinden sonra olamaz.'
            });
        }

        const diffMs = endDate - startDate;
        const diffDays = Math.ceil(diffMs / (1000 * 60 * 60 * 24));
        if (diffDays > 31) {
            return res.status(400).json({
                success: false,
                message: 'En fazla 1 aylık (31 gün) dönem seçebilirsiniz.'
            });
        }

        const data = await yandexFleetApi.getLeaderboardData(false, from, to);
        const { drivers, totalDrivers, totalOrders, periodLabel } = data;

        const top30 = drivers.slice(0, 30);

        let currentUser = null;
        const found = drivers.find(d => d.id === driverId);
        if (found) {
            if (found.rank > 30) {
                currentUser = found;
            }
        } else {
            currentUser = { id: driverId, initials: '?', tripCount: 0, rank: drivers.length + 1 };
        }

        res.json({
            success: true,
            leaderboard: top30,
            currentUser: currentUser,
            totalDrivers: totalDrivers,
            totalOrders: totalOrders || 0,
            periodLabel: periodLabel || ''
        });
    } catch (error) {
        console.error('[Server] Leaderboard hatası:', error.message);
        res.status(500).json({
            success: false,
            message: 'Sıralama tablosu yüklenirken hata oluştu.'
        });
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

        const car = await yandexFleetApi.findCarByPlate(trimmed);

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

        if (carId) {
            await yandexFleetApi.bindCarToDriver(driverId, carId);

            // Araç bilgilerini plaka ile ara (findCarByPlate düz formatta döner)
            let car = null;
            try {
                car = await yandexFleetApi.findCarByPlate(trimmedPlate);
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
            const result = await yandexFleetApi.createCarAndBind(trimmedPlate, brand, model, year, driverId);
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
 * Yeni araç kaydı için marka listesi
 */
app.get('/api/drivers/car-brands', (req, res) => {
    const brands = [
        'Toyota', 'Honda', 'Ford', 'Volkswagen', 'Renault', 'Fiat', 'Peugeot',
        'BMW', 'Mercedes-Benz', 'Audi', 'Hyundai', 'Kia', 'Nissan', 'Mazda',
        'Opel', 'Skoda', 'Dacia', 'Chevrolet', 'Citroën', 'Seat', 'Volvo',
        'Togg', 'Diğer'
    ];
    res.json({ success: true, brands });
});

/**
 * POST /api/drivers/update-car
 * Sürücünün araç plakasını günceller (eski akış - geriye uyumluluk, oturum gerekli)
 */
app.post('/api/drivers/update-car', requireAuth, async (req, res) => {
    try {
        const { carId, newPlate } = req.body;
        const driverId = req.sessionDriver.id;

        if (!carId || !newPlate) {
            return res.status(400).json({
                success: false,
                message: 'Araç ID ve yeni plaka gereklidir.'
            });
        }

        // Araç sadece oturumdaki sürücüye ait olduğunda güncellenebilir
        if (req.sessionDriver.carId !== carId) {
            return res.status(403).json({
                success: false,
                message: 'Bu aracı güncelleme yetkiniz yok.'
            });
        }

        const trimmedPlate = newPlate.trim().toUpperCase();
        if (trimmedPlate.length < 3) {
            return res.status(400).json({
                success: false,
                message: 'Geçerli bir plaka numarası giriniz.'
            });
        }

        await yandexFleetApi.updateCarPlate(carId, trimmedPlate);

        res.json({
            success: true,
            message: 'Plaka başarıyla güncellendi.',
            newPlate: trimmedPlate
        });
    } catch (error) {
        console.error('[Server] Plaka güncelleme hatası:', error.message);
        res.status(500).json({
            success: false,
            message: error.message || 'Plaka güncellenirken hata oluştu.'
        });
    }
});

/**
 * GET /api/drivers
 * Yandex Fleet'ten sürücülerin bilgilerini çeker ve JSON olarak döner
 */
app.get('/api/drivers', async (req, res) => {
    try {
        const driversInfo = await yandexFleetApi.getAllDriversInfo();

        // Dosyaya yaz
        const filePath = await writeDriversToFile(driversInfo);

        res.json({
            success: true,
            message: `${driversInfo.length} sürücü bilgisi başarıyla çekildi ve sürücüler.txt dosyasına yazıldı.`,
            filePath: filePath,
            totalDrivers: driversInfo.length,
            drivers: driversInfo
        });
    } catch (error) {
        console.error('[Server] Hata:', error.message);
        res.status(500).json({
            success: false,
            message: 'Sürücü bilgileri çekilirken hata oluştu.',
            error: error.message
        });
    }
});

/**
 * GET /api/drivers/fetch
 * Sadece sürücüleri çekip dosyaya yazar (hızlı endpoint)
 */
app.get('/api/drivers/fetch', async (req, res) => {
    try {
        const driversInfo = await yandexFleetApi.getDriverProfilesFormatted();

        const filePath = await writeDriversToFile(driversInfo);

        res.json({
            success: true,
            message: `${driversInfo.length} sürücü profili çekildi ve sürücüler.txt dosyasına yazıldı.`,
            filePath: filePath,
            totalDrivers: driversInfo.length,
            drivers: driversInfo
        });
    } catch (error) {
        console.error('[Server] Hata:', error.message);
        res.status(500).json({
            success: false,
            message: 'Sürücü profilleri çekilirken hata oluştu.',
            error: error.message
        });
    }
});

/**
 * GET /api/health
 * Sunucu durumunu kontrol eder
 */
app.get('/api/health', (req, res) => {
    res.json({
        status: 'ok',
        service: 'RiseGo Backend - Yandex Fleet Sürücü Bilgi Sistemi',
        timestamp: new Date().toISOString()
    });
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
app.get('/api/admin/auth/session', (req, res) => {
    const token = req.headers['x-admin-token'];
    if (!token) {
        return res.json({ success: false, message: 'Oturum bulunamadı.' });
    }
    const session = authService.validateAdminSession(token);
    if (!session) {
        return res.json({ success: false, message: 'Oturum geçersiz.' });
    }
    res.json({ success: true });
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
 */
app.post('/api/admin/campaign', requireAdminAuth, (req, res) => {
    try {
        const { text } = req.body;

        if (!text || typeof text !== 'string' || text.trim().length === 0) {
            return res.status(400).json({
                success: false,
                message: 'Kampanya metni boş olamaz.'
            });
        }

        activeCampaign = {
            text: text.trim(),
            active: true,
            updatedAt: new Date().toISOString()
        };

        console.log(`[Server] Kampanya güncellendi: "${activeCampaign.text}"`);

        res.json({
            success: true,
            message: 'Kampanya başarıyla kaydedildi.',
            campaign: activeCampaign
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
 */
app.get('/api/admin/campaign', requireAdminAuth, (req, res) => {
    res.json({
        success: true,
        campaign: activeCampaign
    });
});

/**
 * DELETE /api/admin/campaign
 * Admin panelinden kampanyayı silme
 */
app.delete('/api/admin/campaign', requireAdminAuth, (req, res) => {
    activeCampaign = {
        text: '',
        active: false,
        updatedAt: new Date().toISOString()
    };

    console.log('[Server] Kampanya silindi.');

    res.json({
        success: true,
        message: 'Kampanya başarıyla silindi.'
    });
});

/**
 * GET /api/campaign
 * Sürücü frontend'i için aktif kampanyayı okuma (public endpoint)
 */
app.get('/api/campaign', (req, res) => {
    res.json({
        success: true,
        campaign: activeCampaign
    });
});

/**
 * GET /api/admin/leaderboard
 * Admin paneli için 10 günlük dönem leaderboard (top 10, Ad Soyad)
 * Query: ?previous=1 → sonlanmış önceki dönem
 */
app.get('/api/admin/leaderboard', requireAdminAuth, async (req, res) => {
    try {
        const previous = req.query.previous === '1' || req.query.previous === 'true';
        const { from, to } = req.query;

        const data = await yandexFleetApi.getAdminLeaderboardData(previous, from, to);

        res.json({
            success: true,
            leaderboard: data.top10,
            periodLabel: data.periodLabel,
            totalOrders: data.totalOrders,
            totalDrivers: data.totalDrivers
        });
    } catch (error) {
        console.error('[Server] Admin leaderboard hatası:', error.message);
        res.status(500).json({
            success: false,
            message: 'Leaderboard verisi yüklenirken hata oluştu.'
        });
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
            adminCampaign: 'POST|GET|DELETE /api/admin/campaign',
            adminLeaderboard: 'GET /api/admin/leaderboard'
        }
    });
});

// Sunucuyu başlat
const PORT = config.server.port;
app.listen(PORT, () => {
    console.log('='.repeat(50));
    console.log(`  RiseGo Backend - Yandex Fleet Sürücü Sistemi`);
    console.log(`  Sunucu http://localhost:${PORT} adresinde çalışıyor`);
    console.log(`  Uygulama: http://localhost:${PORT} adresinden açın`);
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

    // Leaderboard önbelleklerini (cache) sunucu başlarken arka planda ısıt
    yandexFleetApi.initiateCacheWarming();
});


