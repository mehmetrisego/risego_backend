const express = require('express');
const router = express.Router();
const adminController = require('../controllers/admin.controller');
const { requireAdminAuth } = require('../middlewares/auth.middleware');
const rateLimit = require('express-rate-limit');

// Güvenlik Katmanı 4: Özel Tarih Filtreleme (DDoS / Memory Leak Koruması)
const customLeaderboardLimiter = rateLimit({
    windowMs: 10 * 1000, // 10 saniye
    max: 1, // IP başına 1 istek
    message: { success: false, message: 'Çok sık tarih filtresi attınız. Lütfen 10 saniye bekleyip tekrar deneyiniz.' },
    skip: (req) => !req.query.from && !req.query.to
});

// Tüm route'larda admin yetkisi aranacak
router.use(requireAdminAuth);

// ============================================
// Admin Routes (/api/admin/...)
// ============================================
router.post('/campaign', adminController.saveCampaign);
router.get('/campaign', adminController.getCampaign);
router.delete('/campaign', adminController.deleteCampaign);

router.get('/upt-balance', adminController.getUptBalance);
router.get('/parks', adminController.getParks);

router.get('/leaderboard', customLeaderboardLimiter, adminController.getLeaderboard);
router.post('/leaderboard/resync', adminController.resyncLeaderboard);
router.get('/leaderboard/status', adminController.getLeaderboardStatus);

router.get('/payment-logs', adminController.getPaymentLogs);
router.get('/drivers/total-balance', adminController.getTotalBalance);

// Sürücü Banka Hesapları
router.get('/drivers/:driverId/bank-accounts', adminController.getDriverBankAccounts);
router.post('/drivers/:driverId/bank-accounts', adminController.addDriverBankAccount);
router.put('/bank-accounts/:accountId', adminController.updateBankAccount);
router.delete('/bank-accounts/:accountId', adminController.deleteBankAccount);

// Sistem Ayarları (Killswitch)
router.get('/killswitch', adminController.getKillswitch);
router.post('/killswitch', express.json(), adminController.updateKillswitch);

// Manuel Sürücü Senkronizasyonu
router.post('/sync-drivers', express.json(), adminController.syncDrivers);

module.exports = router;
