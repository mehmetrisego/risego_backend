require('dotenv').config();
const express = require('express');
const config = require('./config');
const yandexFleetApi = require('./services/yandexFleetApi');
const { writeDriversToFile } = require('./services/fileWriter');
const authService = require('./services/authService');

const app = express();
app.use(express.json());

// CORS ayarları (frontend GitHub Pages'ten API çağrıları için)
app.use((req, res, next) => {
    res.header('Access-Control-Allow-Origin', '*');
    res.header('Access-Control-Allow-Headers', 'Origin, X-Requested-With, Content-Type, Accept, X-Session-Token');
    res.header('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');
    if (req.method === 'OPTIONS') {
        return res.sendStatus(200);
    }
    next();
});

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

        console.log(`\n[Server] Giriş isteği: ${phone} - ${city}`);
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

        console.log(`[Server] OTP doğrulama isteği: ${phone}`);
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

        console.log('[Server] Oturum doğrulama istendi...');
        const driver = await authService.validateSession(token);

        if (driver) {
            console.log(`[Server] Oturum geçerli: ${driver.name}`);
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
 * Belirli bir sürücünün dönem bazlı yolculuk sayısını döner
 */
app.post('/api/drivers/trip-count', async (req, res) => {
    try {
        const { driverId, period } = req.body;

        if (!driverId) {
            return res.status(400).json({
                success: false,
                message: 'Sürücü ID gereklidir.'
            });
        }

        const validPeriods = ['daily', 'weekly', 'monthly', 'all'];
        const selectedPeriod = validPeriods.includes(period) ? period : 'all';

        console.log(`[Server] Yolculuk sayısı istendi: ${driverId} - ${selectedPeriod}`);
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
 * Belirli bir sürücünün bakiyesini döner
 */
app.post('/api/drivers/balance', async (req, res) => {
    try {
        const { driverId } = req.body;

        if (!driverId) {
            return res.status(400).json({
                success: false,
                message: 'Sürücü ID gereklidir.'
            });
        }

        console.log(`[Server] Bakiye istendi: ${driverId}`);
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
 * Sıralama tablosu: top 30 + kullanıcının sırası
 */
app.get('/api/leaderboard', async (req, res) => {
    try {
        const driverId = req.query.driverId;
        console.log('[Server] Leaderboard istendi...');

        const { drivers, totalDrivers } = await yandexFleetApi.getLeaderboardData();

        const top30 = drivers.slice(0, 30);

        let currentUser = null;
        if (driverId) {
            const found = drivers.find(d => d.id === driverId);
            if (found) {
                if (found.rank > 30) {
                    currentUser = found;
                }
            } else {
                currentUser = { id: driverId, initials: '?', tripCount: 0, rank: drivers.length + 1 };
            }
        }

        res.json({
            success: true,
            leaderboard: top30,
            currentUser: currentUser,
            totalDrivers: totalDrivers
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
 * Plakanın sistemde kayıtlı olup olmadığını kontrol eder
 */
app.post('/api/drivers/check-plate', async (req, res) => {
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
 * Sürücünün aracını değiştirir: kayıtlı araç varsa bağlar, yoksa yeni araç oluşturup bağlar
 */
app.post('/api/drivers/change-car', async (req, res) => {
    try {
        const { driverId, plate, carId, brand, model, year } = req.body;

        if (!driverId) {
            return res.status(400).json({
                success: false,
                message: 'Sürücü ID gereklidir.'
            });
        }

        const trimmedPlate = (plate || '').trim().toUpperCase();
        if (trimmedPlate.length < 3) {
            return res.status(400).json({
                success: false,
                message: 'Geçerli bir plaka numarası giriniz.'
            });
        }

        if (carId) {
            await yandexFleetApi.bindCarToDriver(driverId, carId);
            const car = await yandexFleetApi.findCarByPlate(trimmedPlate);
            res.json({
                success: true,
                message: 'Araç başarıyla değiştirildi.',
                car: car ? {
                    id: car.id,
                    brand: car.brand,
                    model: car.model,
                    year: car.year,
                    number: car.number
                } : null
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
 * Sürücünün araç plakasını günceller (eski akış - geriye uyumluluk)
 */
app.post('/api/drivers/update-car', async (req, res) => {
    try {
        const { carId, newPlate } = req.body;

        if (!carId || !newPlate) {
            return res.status(400).json({
                success: false,
                message: 'Araç ID ve yeni plaka gereklidir.'
            });
        }

        const trimmedPlate = newPlate.trim().toUpperCase();
        if (trimmedPlate.length < 3) {
            return res.status(400).json({
                success: false,
                message: 'Geçerli bir plaka numarası giriniz.'
            });
        }

        console.log(`[Server] Plaka güncelleme istendi: ${carId} -> ${trimmedPlate}`);
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
        console.log('\n[Server] Sürücü bilgileri istendi...');
        const driversInfo = await yandexFleetApi.getAllDriversInfo();

        // Dosyaya yaz
        const filePath = writeDriversToFile(driversInfo);

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
        console.log('\n[Server] Sürücü profilleri çekiliyor (hızlı mod)...');
        const driversInfo = await yandexFleetApi.getDriverProfilesFormatted();

        const filePath = writeDriversToFile(driversInfo);

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
            leaderboard: 'GET /api/leaderboard'
        }
    });
});

// Sunucuyu başlat
const PORT = config.server.port;
app.listen(PORT, () => {
    console.log('='.repeat(50));
    console.log(`  RiseGo Backend - Yandex Fleet Sürücü Sistemi`);
    console.log(`  Sunucu http://localhost:${PORT} adresinde çalışıyor`);
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
});


