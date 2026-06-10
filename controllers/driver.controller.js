const path = require('path');
const fsSync = require('fs');

const config = require('../config');
const db = require('../db');
const dbCampaigns = require('../db/campaigns');
const dbDriverBankAccounts = require('../db/driverBankAccounts');
const dbPaymentLogs = require('../db/paymentLogs');

const yandexFleetApi = require('../services/yandexFleetApi');
const leaderboardService = require('../services/leaderboardService');
const authService = require('../services/authService');
const paymentService = require('../services/paymentService');
const systemService = require('../services/systemService');

const { sessionParkPartnerId } = require('../middlewares/auth.middleware');

const WITHDRAW_FEE_TL = 4;
const WITHDRAW_COOLDOWN_MS = 10 * 60 * 1000;

exports.getTripCount = async (req, res) => {
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
        console.error('[DriverController] Trip count hatası:', error.message);
        res.status(500).json({ success: false, message: 'Yolculuk sayısı alınırken hata oluştu.' });
    }
};

exports.getCampaign = async (req, res) => {
    try {
        const parkPid = sessionParkPartnerId(req);
        const campaign = await dbCampaigns.getCampaign(parkPid);
        res.json({ success: true, campaign, parkPartnerId: parkPid });
    } catch (error) {
        console.error('[DriverController] Sürücü kampanya hatası:', error.message);
        res.status(500).json({ success: false, message: 'Kampanya yüklenemedi.' });
    }
};

exports.getBalance = async (req, res) => {
    try {
        const driverId = req.sessionDriver.id;
        // KULLANICI TALEBİ / OPTİMİZASYON:
        // Eskiden burada `true` (forceRefresh) vardı. Bu durum sürücü sayfaya her girdiğinde
        // Yandex'in cache'i yok sayarak tekrar sorgulanmasına ve 429 Rate Limit yemesine sebep oluyordu.
        // Artık `false` yaptık. Sürücü 2 dakikada 1 kez Yandex'e gidebilir, diğer girişlerinde cache'ten hızlıca yanıt alır.
        const balanceData = await yandexFleetApi.getDriverBalance(driverId, sessionParkPartnerId(req), false);

        if (balanceData) {
            res.json({
                success: true,
                balance: balanceData.balance,
                blockedBalance: balanceData.blockedBalance
            });
        } else {
            res.json({ success: false, message: 'Bakiye bilgisi alınamadı.' });
        }
    } catch (error) {
        console.error('[DriverController] Balance hatası:', error.message);
        res.status(500).json({ success: false, message: 'Bakiye alınırken hata oluştu.' });
    }
};

exports.getBankAccounts = async (req, res) => {
    try {
        if (!db.isConfigured()) {
            return res.status(503).json({ success: false, message: 'Veritabanı yapılandırılmamış.' });
        }
        const accounts = await dbDriverBankAccounts.getDriverBankAccounts(req.sessionDriver.id);
        res.json({ success: true, accounts });
    } catch (error) {
        console.error('[DriverController] Banka hesapları getirme hatası:', error.message);
        res.status(500).json({ success: false, message: 'Banka hesap bilgileri alınırken hata oluştu.' });
    }
};

exports.addBankAccount = async (req, res) => {
    try {
        if (!db.isConfigured()) return res.status(503).json({ success: false, message: 'Veritabanı yapılandırılmamış.' });

        const ibanRaw = req.body?.iban;
        const accountHolderNameRaw = req.body?.accountHolderName;
        const iban = dbDriverBankAccounts.normalizeIban(ibanRaw);
        const accountHolderName = String(accountHolderNameRaw || '').trim();

        if (!iban || !accountHolderName) return res.status(400).json({ success: false, message: 'IBAN ve hesap sahibinin adı soyadı zorunludur.' });
        if (!/^TR\d{24}$/.test(iban)) return res.status(400).json({ success: false, message: 'Geçerli bir TR IBAN giriniz (TR + 24 hane).' });

        const account = await dbDriverBankAccounts.addDriverBankAccount(req.sessionDriver.id, iban, accountHolderName);
        res.json({ success: true, message: 'Yeni hesap başarıyla eklendi.', account });
    } catch (error) {
        console.error('[DriverController] Banka hesabı ekleme hatası:', error.message, error);
        res.status(500).json({ success: false, message: 'Hesap bilgileri kaydedilirken hata oluştu: ' + error.message });
    }
};

exports.deleteBankAccount = async (req, res) => {
    try {
        if (!db.isConfigured()) return res.status(503).json({ success: false, message: 'Veritabanı yapılandırılmamış.' });
        const accountId = parseInt(req.params.id);
        const driverId = req.sessionDriver.id;
        const deleted = await dbDriverBankAccounts.deleteDriverBankAccount(driverId, accountId);
        if (deleted) res.json({ success: true, message: 'Banka hesabı silindi.' });
        else res.status(404).json({ success: false, message: 'Hesap bulunamadı veya silinemedi.' });
    } catch (error) {
        console.error('[DriverController] Banka hesabı silme hatası:', error.message);
        res.status(500).json({ success: false, message: 'Hesap silinirken hata oluştu.' });
    }
};

exports.withdraw = async (req, res) => {
    let client;
    const driverId = req.sessionDriver.id;
    const grossAmount = parseFloat(req.body?.amount);
    const parkPid = sessionParkPartnerId(req);

    try {
        if (!db.isConfigured()) return res.status(503).json({ success: false, message: 'Veritabanı yapılandırılmamış.' });

        const suspendedCities = systemService.getSuspendedCities();
        if (suspendedCities.includes(parkPid)) {
            return res.status(503).json({ success: false, message: 'Para çekme işlemleri bulunduğunuz şehir için geçici bir süreliğine askıya alınmıştır. Lütfen daha sonra tekrar deneyiniz.' });
        }

        // Gece bakım penceresi (06:00–07:00 TR): senkronizasyon çalışırken çekim bloke
        if (systemService.isMaintenanceWindowActive()) {
            return res.status(503).json({
                success: false,
                maintenanceWindow: true,
                message: 'Sistem gece bakımı sırasında (06:00–07:00) para çekimi geçici olarak kapalıdır. Lütfen saat 07:00\'dan sonra tekrar deneyiniz.'
            });
        }

        if (isNaN(grossAmount) || grossAmount <= 0) return res.status(400).json({ success: false, message: 'Geçerli bir tutar giriniz.' });
        if (grossAmount <= WITHDRAW_FEE_TL) return res.status(400).json({ success: false, message: `Çekim tutarı en az ${WITHDRAW_FEE_TL + 0.01} TL olmalıdır (${WITHDRAW_FEE_TL} TL çekim ücreti alınmaktadır).` });

        client = await db.pool.connect();
        await client.query('BEGIN');

        const profileRow = await client.query('SELECT last_withdraw_at FROM driver_profiles WHERE driver_id = $1 FOR UPDATE', [driverId]);
        const lastWithdrawAt = profileRow.rows[0]?.last_withdraw_at ? new Date(profileRow.rows[0].last_withdraw_at).getTime() : null;

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
                return res.status(429).json({ success: false, message: `Bekleme süresi dolmadı. Tekrar çekim yapabileceğiniz saat: ${hh}:${mm}.` });
            }
        }

        await client.query(`UPDATE driver_profiles SET last_withdraw_at = NOW(), updated_at = NOW() WHERE driver_id = $1`, [driverId]);
        await client.query('COMMIT');
        client.release();
        client = null;

        // Çift bakiye sorgusunu engellemek için cache kullan: Modal açılırken (getBalance) alınan güncel bakiye zaten 2 dk önbellekte.
        const yandexBalance = await yandexFleetApi.getDriverBalance(driverId, parkPid, false);
        const withdrawable = parseFloat(yandexBalance?.balance || 0);

        if (grossAmount > withdrawable + 0.01) {
            await db.query('UPDATE driver_profiles SET last_withdraw_at = $1 WHERE driver_id = $2', [profileRow.rows[0]?.last_withdraw_at || null, driverId]);
            return res.status(400).json({ success: false, message: `Yetersiz bakiye. Çekilebilir tutarınız (${withdrawable.toFixed(2).replace('.', ',')} TL) talep edilen tutardan düşük.` });
        }

        const netAmount = parseFloat((grossAmount - WITHDRAW_FEE_TL).toFixed(2));
        const bankAccountId = req.body?.bankAccountId;
        let account = null;

        if (bankAccountId) {
            const accRes = await db.query('SELECT iban, account_holder_name FROM driver_bank_accounts WHERE id = $1 AND driver_id = $2', [bankAccountId, driverId]);
            if (accRes.rows.length > 0) account = { iban: accRes.rows[0].iban, accountHolderName: accRes.rows[0].account_holder_name };
        } else {
            const accounts = await dbDriverBankAccounts.getDriverBankAccounts(driverId);
            if (accounts.length > 0) account = accounts[0];
        }
        
        if (!account || !account.iban || !account.accountHolderName) {
            await db.query('UPDATE driver_profiles SET last_withdraw_at = $1 WHERE driver_id = $2', [profileRow.rows[0]?.last_withdraw_at || null, driverId]);
            return res.status(400).json({ success: false, message: 'Geçerli bir banka hesabı seçilmedi.' });
        }

        const nameParts = account.accountHolderName.trim().split(/\s+/);
        const beneficiarySurname = nameParts.length > 1 ? nameParts.slice(1).join(' ') : nameParts[0];
        const beneficiaryName = nameParts[0];

        const result = await paymentService.sendPayment({
            driverId, beneficiaryName, beneficiarySurname, beneficiaryIban: account.iban, amount: netAmount, yandexAmount: grossAmount, parkPartnerId: parkPid
        });

        // Çekim başarılı oldu, Yandex'teki gerçek bakiye de değiştiği için cache'i temizle
        yandexFleetApi.invalidateBalanceCache(driverId, parkPid);

        const nextWithdrawTime = new Date(Date.now() + WITHDRAW_COOLDOWN_MS);
        res.json({
            success: true, message: `Para çekimi başarıyla gerçekleşti. Hesabınıza ${netAmount.toFixed(2).replace('.', ',')} TL aktarıldı.`,
            netAmount, grossAmount, tuRefNumber: result.tuRefNumber, warning: result.warning || null, nextWithdrawAt: nextWithdrawTime.toISOString()
        });

    } catch (error) {
        if (client) { await client.query('ROLLBACK'); client.release(); }
        console.error('[DriverController] Para çekimi hatası:', error.message);
        res.status(500).json({ success: false, message: error.message || 'Para çekimi sırasında hata oluştu.' });
    }
};

exports.getWithdrawStatus = async (req, res) => {
    try {
        // Gece bakım penceresi
        if (systemService.isMaintenanceWindowActive()) {
            return res.json({
                success: true,
                canWithdraw: false,
                maintenanceWindow: true,
                message: 'Sistem gece bakımı sırasında (06:00–07:00) para çekimi geçici olarak kapalıdır.'
            });
        }

        const driverId = req.sessionDriver.id;
        if (!db.isConfigured()) return res.json({ success: true, canWithdraw: true, cooldownUntil: null, minutesLeft: 0 });
        const profileRow = await db.query('SELECT last_withdraw_at FROM driver_profiles WHERE driver_id = $1', [driverId]);
        const lastWithdrawAt = profileRow.rows[0]?.last_withdraw_at ? new Date(profileRow.rows[0].last_withdraw_at).getTime() : null;

        if (!lastWithdrawAt) return res.json({ success: true, canWithdraw: true, cooldownUntil: null, hoursLeft: 0 });
        const elapsed = Date.now() - lastWithdrawAt;
        const remaining = WITHDRAW_COOLDOWN_MS - elapsed;
        if (remaining <= 0) return res.json({ success: true, canWithdraw: true, cooldownUntil: null, minutesLeft: 0 });
        const minutesLeft = Math.ceil(remaining / (1000 * 60));
        return res.json({ success: true, canWithdraw: false, cooldownUntil: new Date(lastWithdrawAt + WITHDRAW_COOLDOWN_MS).toISOString(), minutesLeft });
    } catch (err) {
        console.error('[DriverController] Withdraw status hatası:', err.message);
        return res.json({ success: true, canWithdraw: true, cooldownUntil: null, minutesLeft: 0 });
    }
};

exports.getWithdrawHistory = async (req, res) => {
    try {
        if (!db.isConfigured()) return res.status(503).json({ success: false, message: 'Veritabanı yapılandırılmamış.' });
        const logs = await dbPaymentLogs.getDriverPaymentLogs(req.sessionDriver.id);
        res.json({ success: true, logs });
    } catch (error) {
        console.error('[DriverController] Çekim geçmişi getirme hatası:', error.message);
        res.status(500).json({ success: false, message: 'Çekim geçmişi alınırken hata oluştu.' });
    }
};

exports.getLeaderboard = async (req, res) => {
    try {
        const driverId = req.sessionDriver.id;
        const { from, to } = req.query;

        if (!from || !to) return res.status(400).json({ success: false, message: 'Başlangıç ve bitiş tarihi gereklidir (from, to).' });
        if (!/^\d{4}-\d{2}-\d{2}$/.test(from) || !/^\d{4}-\d{2}-\d{2}$/.test(to)) return res.status(400).json({ success: false, message: 'Tarih formatı YYYY-MM-DD olmalıdır.' });

        const startDate = new Date(from);
        const endDate = new Date(to);
        if (isNaN(startDate.getTime()) || isNaN(endDate.getTime())) return res.status(400).json({ success: false, message: 'Geçersiz tarih.' });
        if (startDate > endDate) return res.status(400).json({ success: false, message: 'Başlangıç tarihi bitiş tarihinden sonra olamaz.' });
        const diffDays = Math.ceil((endDate - startDate) / (1000 * 60 * 60 * 24));
        if (diffDays > 31) return res.status(400).json({ success: false, message: 'En fazla 1 aylık (31 gün) dönem seçebilirsiniz.' });

        const data = await leaderboardService.getLeaderboard(from, to, { adminView: false, parkPartnerId: sessionParkPartnerId(req) });
        const { drivers, totalDrivers, totalOrders, periodLabel } = data;

        const top30 = drivers.slice(0, 30).map(d => ({ id: d.id, initials: d.initials, tripCount: d.tripCount, rank: d.rank }));
        let currentUser = null;
        const found = drivers.find(d => d.id === driverId);
        if (found) {
            if (found.rank > 30) currentUser = { id: found.id, initials: found.initials, tripCount: found.tripCount, rank: found.rank };
        } else {
            currentUser = { id: driverId, initials: '?', tripCount: 0, rank: drivers.length + 1 };
        }

        res.json({ success: true, leaderboard: top30, currentUser, totalDrivers, totalOrders: totalOrders || 0, periodLabel: periodLabel || '', syncedAt: data.syncedAt });
    } catch (error) {
        console.error('[DriverController] Leaderboard hatası:', error.message);
        res.status(500).json({ success: false, message: 'Sıralama tablosu yüklenirken hata oluştu.' });
    }
};

exports.checkPlate = async (req, res) => {
    try {
        const { plate } = req.body;
        if (!plate || typeof plate !== 'string') return res.status(400).json({ success: false, message: 'Plaka numarası gereklidir.' });
        const trimmed = plate.trim().toUpperCase();
        if (trimmed.length < 3) return res.status(400).json({ success: false, message: 'Geçerli bir plaka numarası giriniz.' });

        const car = await yandexFleetApi.findCarByPlate(trimmed, sessionParkPartnerId(req));
        if (car) {
            res.json({ success: true, found: true, car: { id: car.id, brand: car.brand, model: car.model, year: car.year, number: car.number } });
        } else {
            res.json({ success: true, found: false, car: null });
        }
    } catch (error) {
        console.error('[DriverController] Plaka kontrol hatası:', error.message);
        res.status(500).json({ success: false, message: error.message || 'Plaka kontrol edilirken hata oluştu.' });
    }
};

exports.changeCar = async (req, res) => {
    try {
        const { plate, carId, brand, model, year } = req.body;
        const driverId = req.sessionDriver.id;
        const trimmedPlate = (plate || '').trim().toUpperCase();
        if (trimmedPlate.length < 3) return res.status(400).json({ success: false, message: 'Geçerli bir plaka numarası giriniz.' });
        const parkPid = sessionParkPartnerId(req);

        if (carId) {
            await yandexFleetApi.bindCarToDriver(driverId, carId, parkPid);
            let car = null;
            try { car = await yandexFleetApi.findCarByPlate(trimmedPlate, parkPid); } catch (e) { }
            const carInfo = car ? { id: car.id || carId, brand: car.brand || brand || '', model: car.model || model || '', year: car.year || year || '', number: car.number || trimmedPlate } : { id: carId, brand: brand || '', model: model || '', year: year || '', number: trimmedPlate };
            
            if (db.isConfigured()) {
                const carText = carInfo.number
                    ? `${carInfo.brand || ''} ${carInfo.model || ''} (${carInfo.year || ''}) - Plaka: ${carInfo.number}`
                    : 'Araç atanmamış';
                await db.query(
                    `UPDATE driver_profiles 
                     SET car_id = $1, car_number = $2, car_name = $3, updated_at = NOW() 
                     WHERE driver_id = $4`,
                    [carInfo.id, carInfo.number, carText, driverId]
                ).catch(err => console.error('[DB] Araç güncelleme hatası (changeCar):', err.message));
            }

            res.json({ success: true, message: 'Araç başarıyla değiştirildi.', car: carInfo });
        } else {
            if (!brand || !model || !year) return res.status(400).json({ success: false, message: 'Yeni araç için marka, model ve yıl gereklidir.' });
            const result = await yandexFleetApi.createCarAndBind(trimmedPlate, brand, model, year, driverId, parkPid);
            const carInfo = { id: result.vehicleId, brand: result.brand, model: result.model, year: result.year, number: result.plate };

            if (db.isConfigured()) {
                const carText = carInfo.number
                    ? `${carInfo.brand || ''} ${carInfo.model || ''} (${carInfo.year || ''}) - Plaka: ${carInfo.number}`
                    : 'Araç atanmamış';
                await db.query(
                    `UPDATE driver_profiles 
                     SET car_id = $1, car_number = $2, car_name = $3, updated_at = NOW() 
                     WHERE driver_id = $4`,
                    [carInfo.id, carInfo.number, carText, driverId]
                ).catch(err => console.error('[DB] Araç güncelleme hatası (createCarAndBind):', err.message));
            }

            res.json({ success: true, message: 'Yeni araç kaydedildi ve size atandı.', car: carInfo });
        }
    } catch (error) {
        console.error('[DriverController] Araç değiştirme hatası:', error.message);
        res.status(500).json({ success: false, message: error.message || 'Araç değiştirilirken hata oluştu.' });
    }
};

exports.requestOtp = async (req, res) => {
    try {
        const { firstName, lastName, phone, city, taxIdentificationNumber, driverLicenseNumber, driverLicenseIssueDate, driverLicenseExpiryDate, birthDate, country } = req.body;
        if (!firstName || !lastName || !phone || !city || !taxIdentificationNumber || !driverLicenseNumber || !driverLicenseIssueDate || !driverLicenseExpiryDate || !birthDate) {
            return res.status(400).json({ success: false, message: 'Tüm zorunlu alanları doldurunuz.' });
        }
        if (taxIdentificationNumber.length !== 11) return res.status(400).json({ success: false, message: 'TC kimlik numarası 11 haneli olmalıdır.' });
        const phoneClean = phone.replace(/\D/g, '');
        if (phoneClean.length < 10) return res.status(400).json({ success: false, message: 'Geçerli bir telefon numarası giriniz.' });
        const normalizedPhone = phoneClean.startsWith('90') ? '+' + phoneClean : '+90' + phoneClean;

        const result = await authService.sendRegistrationOTP(normalizedPhone, city, {
            firstName: firstName.trim(), lastName: lastName.trim(), taxIdentificationNumber: taxIdentificationNumber.trim(),
            driverLicenseNumber: driverLicenseNumber.trim(), driverLicenseIssueDate, driverLicenseExpiryDate, birthDate, country: country || 'tur'
        });
        res.json(result);
    } catch (error) {
        console.error('[DriverController] Kayıt OTP hatası:', error.message);
        res.status(500).json({ success: false, message: error.message || 'Kod gönderilirken hata oluştu.' });
    }
};

exports.verifyRegistration = async (req, res) => {
    try {
        const { phone, otp } = req.body;
        if (!phone || !otp) return res.status(400).json({ success: false, message: 'Telefon numarası ve doğrulama kodu gereklidir.' });
        const phoneClean = phone.replace(/\D/g, '');
        const normalizedPhone = phoneClean.startsWith('90') ? '+' + phoneClean : '+90' + phoneClean;
        const result = await authService.verifyRegistrationOTP(normalizedPhone, otp);
        if (result.success) res.json({ success: true, driver: result.driver, sessionToken: result.sessionToken });
        else res.status(400).json({ success: false, message: result.message });
    } catch (error) {
        console.error('[DriverController] Kayıt doğrulama hatası:', error.message);
        res.status(500).json({ success: false, message: error.message || 'Doğrulama sırasında hata oluştu.' });
    }
};

let cachedCarBrandsPayload = null;
exports.getCarBrands = (req, res) => {
    if (cachedCarBrandsPayload) return res.json(cachedCarBrandsPayload);
    const refPath = path.join(__dirname, '../data', 'yandexVehicleReference.json');
    try {
        if (fsSync.existsSync(refPath)) {
            const raw = JSON.parse(fsSync.readFileSync(refPath, 'utf8'));
            if (raw.brandsWithModels && Array.isArray(raw.brandsWithModels) && raw.brandsWithModels.length > 0) {
                const brands = raw.brandsWithModels.map(b => b.brand);
                cachedCarBrandsPayload = { success: true, brands, brandsWithModels: raw.brandsWithModels };
                return res.json(cachedCarBrandsPayload);
            }
        }
    } catch (e) {
        console.error('[DriverController] yandexVehicleReference.json okunamadı:', e.message);
    }
    res.json({ success: false, message: 'Araç marka/model listesi yüklenemedi. Sunucuda data/yandexVehicleReference.json dosyası olmalı ve brandsWithModels dolu olmalı.', brands: [], brandsWithModels: [] });
};
