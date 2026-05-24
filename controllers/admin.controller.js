const config = require('../config');
const db = require('../db');
const dbCampaigns = require('../db/campaigns');
const dbDriverBankAccounts = require('../db/driverBankAccounts');
const dbPaymentLogs = require('../db/paymentLogs');

const yandexFleetApi = require('../services/yandexFleetApi');
const authService = require('../services/authService');
const uptService = require('../services/uptService');
const leaderboardService = require('../services/leaderboardService');
const systemService = require('../services/systemService');

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

exports.saveCampaign = async (req, res) => {
    try {
        const parkPid = resolveAdminCampaignPark(req, res);
        if (!parkPid) return;

        const { text } = req.body;

        if (!text || typeof text !== 'string' || text.trim().length === 0) {
            return res.status(400).json({ success: false, message: 'Kampanya metni boş olamaz.' });
        }

        const trimmed = text.trim();
        if (db.isConfigured()) {
            const campaign = await dbCampaigns.upsertCampaign(trimmed, parkPid);
            console.log(`[AdminController] Kampanya DB'ye kaydedildi (${parkPid}): "${trimmed}"`);
            return res.json({ success: true, message: 'Kampanya başarıyla kaydedildi.', campaign });
        }
        res.status(503).json({ success: false, message: 'Veritabanı yapılandırılmamış.' });
    } catch (error) {
        console.error('[AdminController] Kampanya kaydetme hatası:', error.message);
        res.status(500).json({ success: false, message: 'Kampanya kaydedilirken hata oluştu.' });
    }
};

exports.getCampaign = async (req, res) => {
    try {
        const parkPid = resolveAdminCampaignPark(req, res);
        if (!parkPid) return;

        const campaign = db.isConfigured() ? await dbCampaigns.getCampaign(parkPid) : null;
        res.json({ success: true, campaign });
    } catch (error) {
        console.error('[AdminController] Kampanya okuma hatası:', error.message);
        res.json({ success: true, campaign: null });
    }
};

exports.deleteCampaign = async (req, res) => {
    try {
        const parkPid = resolveAdminCampaignPark(req, res);
        if (!parkPid) return;

        if (db.isConfigured()) {
            await dbCampaigns.deactivateCampaign(parkPid);
        }
        console.log(`[AdminController] Kampanya silindi (${parkPid}).`);
        res.json({ success: true, message: 'Kampanya başarıyla silindi.' });
    } catch (error) {
        console.error('[AdminController] Kampanya silme hatası:', error.message);
        res.status(500).json({ success: false, message: 'Kampanya silinirken hata oluştu.' });
    }
};

exports.getUptBalance = async (req, res) => {
    try {
        const result = await uptService.getUptBalance();
        res.json({ success: result.success, tryBalanceRaw: result.tryBalanceRaw, balances: result.balances, error: result.error || null });
    } catch (err) {
        console.error('[AdminController] UPT bakiye hatası:', err.message);
        res.status(500).json({ success: false, error: err.message });
    }
};

exports.getParks = async (req, res) => {
    try {
        const parks = config.getYandexParkSources().map(s => ({ label: s.label, partnerId: s.partnerId }));
        res.json({ success: true, parks });
    } catch (error) {
        console.error('[AdminController] Admin parks hatası:', error.message);
        res.status(500).json({ success: false, message: 'Park listesi alınamadı.' });
    }
};

exports.getLeaderboard = async (req, res) => {
    try {
        let { from, to } = req.query;

        if (!from || !to) {
            const today = new Date();
            const yyyy = today.getFullYear();
            const mm = String(today.getMonth() + 1).padStart(2, '0');
            const dd = String(today.getDate()).padStart(2, '0');
            from = `${yyyy}-${mm}-${dd}`;
            to = `${yyyy}-${mm}-${dd}`;
        }

        if (!/^\d{4}-\d{2}-\d{2}$/.test(from) || !/^\d{4}-\d{2}-\d{2}$/.test(to)) {
            return res.status(400).json({ success: false, message: 'Tarih formatı YYYY-MM-DD olmalıdır.' });
        }

        const parkPid = (req.query.parkPartnerId || '').trim() || config.yandexFleet.partnerId;
        const data = await leaderboardService.getLeaderboard(from, to, { adminView: true, parkPartnerId: parkPid });
        const driversArray = data.drivers || [];

        res.json({
            success: true,
            leaderboard: driversArray.map(d => ({ id: d.id, fullName: d.fullName, tripCount: d.tripCount, rank: d.rank })),
            periodLabel: data.periodLabel,
            totalOrders: data.totalOrders,
            totalDrivers: data.totalDrivers,
            syncedAt: data.syncedAt
        });
    } catch (error) {
        console.error('[AdminController] Admin leaderboard hatası:', error.message);
        res.status(500).json({ success: false, message: 'Leaderboard verisi yüklenirken hata oluştu.' });
    }
};

exports.getPaymentLogs = async (req, res) => {
    try {
        if (!db.isConfigured()) return res.status(503).json({ success: false, message: 'Veritabanı yapılandırılmamış.' });
        const result = await db.query(`SELECT * FROM payment_logs ORDER BY created_at DESC LIMIT 500`);
        res.json({ success: true, logs: result.rows });
    } catch (err) {
        console.error('[AdminController] Payment logs hatası:', err.message);
        res.status(500).json({ success: false, message: err.message });
    }
};

exports.getTotalBalance = async (req, res) => {
    try {
        if (!db.isConfigured()) return res.json({ success: true, totalBalance: 0 });
        const result = await db.query('SELECT SUM(balance) as total FROM park_driver_balances');
        const total = parseFloat(result.rows[0]?.total || 0);
        res.json({ success: true, totalBalance: total });
    } catch (err) {
        console.error('[AdminController] Toplam sürücü bakiyesi hesaplanamadı:', err.message);
        res.status(500).json({ success: false, message: err.message });
    }
};

exports.getDriverBankAccounts = async (req, res) => {
    try {
        const { driverId } = req.params;
        const accounts = await dbDriverBankAccounts.getDriverBankAccounts(driverId);
        res.json({ success: true, accounts });
    } catch (error) {
        console.error('[AdminController] Sürücü banka hesapları çekilemedi:', error.message);
        res.status(500).json({ success: false, message: 'Banka hesapları alınırken hata oluştu.' });
    }
};

exports.addDriverBankAccount = async (req, res) => {
    try {
        const { driverId } = req.params;
        const ibanRaw = req.body?.iban;
        const accountHolderNameRaw = req.body?.accountHolderName;

        const iban = dbDriverBankAccounts.normalizeIban(ibanRaw);
        const accountHolderName = String(accountHolderNameRaw || '').trim();

        if (!iban || !accountHolderName) return res.status(400).json({ success: false, message: 'IBAN ve hesap sahibi adı zorunludur.' });
        if (!/^TR\d{24}$/.test(iban)) return res.status(400).json({ success: false, message: 'Geçerli bir TR IBAN giriniz (TR + 24 hane).' });

        const account = await dbDriverBankAccounts.addDriverBankAccount(driverId, iban, accountHolderName);
        res.json({ success: true, message: 'Hesap başarıyla eklendi.', account });
    } catch (error) {
        console.error('[AdminController] Sürücü banka hesabı eklenemedi:', error.message);
        res.status(500).json({ success: false, message: 'Banka hesabı eklenirken hata oluştu: ' + error.message });
    }
};

exports.updateBankAccount = async (req, res) => {
    try {
        const accountId = parseInt(req.params.accountId);
        const ibanRaw = req.body?.iban;
        const accountHolderNameRaw = req.body?.accountHolderName;

        const iban = dbDriverBankAccounts.normalizeIban(ibanRaw);
        const accountHolderName = String(accountHolderNameRaw || '').trim();

        if (!iban || !accountHolderName) return res.status(400).json({ success: false, message: 'IBAN ve hesap sahibi adı zorunludur.' });
        if (!/^TR\d{24}$/.test(iban)) return res.status(400).json({ success: false, message: 'Geçerli bir TR IBAN giriniz (TR + 24 hane).' });

        const account = await dbDriverBankAccounts.updateDriverBankAccount(accountId, iban, accountHolderName);
        if (account) {
            res.json({ success: true, message: 'Banka hesabı başarıyla güncellendi.', account });
        } else {
            res.status(404).json({ success: false, message: 'Güncellenecek banka hesabı bulunamadı.' });
        }
    } catch (error) {
        console.error('[AdminController] Sürücü banka hesabı güncellenemedi:', error.message);
        res.status(500).json({ success: false, message: 'Banka hesabı güncellenirken hata oluştu.' });
    }
};

exports.deleteBankAccount = async (req, res) => {
    try {
        const accountId = parseInt(req.params.accountId);
        if (!db.isConfigured()) return res.status(503).json({ success: false, message: 'Veritabanı yapılandırılmamış.' });
        const result = await db.query('DELETE FROM driver_bank_accounts WHERE id = $1 RETURNING id', [accountId]);
        if (result.rowCount > 0) {
            res.json({ success: true, message: 'Banka hesabı silindi.' });
        } else {
            res.status(404).json({ success: false, message: 'Hesap bulunamadı veya silinemedi.' });
        }
    } catch (error) {
        console.error('[AdminController] Sürücü banka hesabı silinemedi:', error.message);
        res.status(500).json({ success: false, message: 'Banka hesabı silinirken hata oluştu.' });
    }
};

exports.getKillswitch = (req, res) => {
    res.json({ success: true, suspendedCities: systemService.getSuspendedCities() });
};

exports.updateKillswitch = async (req, res) => {
    const { suspendedCities: newSuspended } = req.body;
    if (!Array.isArray(newSuspended)) return res.status(400).json({ success: false, message: 'Geçersiz parametre.' });
    
    try {
        await db.query("UPDATE system_settings SET value = $1, updated_at = NOW() WHERE key = 'suspended_cities'", [JSON.stringify(newSuspended)]);
        systemService.setSuspendedCities(newSuspended);
        console.log(`[AdminController] Killswitch durumu veritabanında değiştirildi. Askıya alınan şehirler: ${systemService.getSuspendedCities().join(', ')}`);
        res.json({ success: true, suspendedCities: systemService.getSuspendedCities(), message: 'Para çekme kısıtlamaları güncellendi.' });
    } catch (err) {
        console.error('[AdminController] Killswitch güncelleme hatası:', err.message);
        res.status(500).json({ success: false, message: 'Ayarlar güncellenirken veritabanı hatası oluştu.' });
    }
};

exports.resyncLeaderboard = async (req, res) => {
    try {
        console.log('[AdminController] Admin tarafından zorla yeniden senkronizasyon talep edildi.');
        leaderboardService.forceResync().catch(err => console.error('[AdminController] Yeniden senkronizasyon arka plan hatası:', err.message));
        res.json({ success: true, message: 'Yeniden senkronizasyon arka planda başlatıldı. 1-5 dakika içinde veriler güncellenecek.' });
    } catch (error) {
        console.error('[AdminController] Resync hatası:', error.message);
        res.status(500).json({ success: false, message: 'Yeniden senkronizasyon başlatılamadı.' });
    }
};

exports.getLeaderboardStatus = async (req, res) => {
    try {
        const status = await leaderboardService.getStatus();
        res.json({ success: true, status });
    } catch (err) {
        res.status(500).json({ success: false, message: err.message });
    }
};

exports.syncDrivers = async (req, res) => {
    const { parkIds } = req.body;
    if (!Array.isArray(parkIds) || parkIds.length === 0) {
        return res.status(400).json({ success: false, message: 'Lütfen en az bir şehir seçin.' });
    }

    try {
        let totalInserted = 0;
        let totalUpdated = 0;
        let totalNoPhone = 0;

        for (const parkId of parkIds) {
            const park = config.findYandexParkByPartnerId(parkId);
            if (!park) continue;

            console.log(`[AdminSync] ${park.label} için sürücüler senkronize ediliyor...`);
            const profiles = await yandexFleetApi.fetchDriverProfilesForParkSource(park);

            // 50'şerli batch halinde DB güncellemeleri
            const BATCH_SIZE = 50;
            for (let i = 0; i < profiles.length; i += BATCH_SIZE) {
                const chunk = profiles.slice(i, i + BATCH_SIZE);
                await Promise.all(chunk.map(async (profile) => {
                    const dp        = profile.driver_profile || profile;
                    const drvId     = dp.id || dp.driver_profile_id;
                    if (!drvId) return;

                    const firstName = (dp.first_name || '').trim();
                    const lastName  = (dp.last_name  || '').trim();
                    const phone     = Array.isArray(dp.phones) && dp.phones.length
                        ? String(dp.phones[0]).replace(/\D/g, '')  // sadece rakam
                        : null;

                    if (!phone) {
                        totalNoPhone++;
                        return;
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
                        else totalUpdated++;
                    } catch (insertErr) {
                        totalUpdated++;
                    }
                }));
            }
        }

        // Başarılı senkronizasyon sonrası bellek cache'ini temizleyelim ki veriler taze gözüksün
        authService.invalidateDriverCache();

        res.json({
            success: true,
            inserted: totalInserted,
            updated: totalUpdated,
            noPhone: totalNoPhone,
            message: 'Seçilen şehirlerdeki sürücüler başarıyla senkronize edildi.'
        });
    } catch (error) {
        console.error('[AdminController] Manuel senkronizasyon hatası:', error.message);
        res.status(500).json({ success: false, message: 'Senkronizasyon işlemi sırasında hata oluştu: ' + error.message });
    }
};
