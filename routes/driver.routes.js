const express = require('express');
const router = express.Router();
const rateLimit = require('express-rate-limit');
const driverController = require('../controllers/driver.controller');
const { requireAuth } = require('../middlewares/auth.middleware');

// Güvenlik Katmanı 4: Özel Tarih Filtreleme (DDoS / Memory Leak Koruması)
const customLeaderboardLimiter = rateLimit({
    windowMs: 10 * 1000, // 10 saniye
    max: 1, // IP başına 1 istek
    message: { success: false, message: 'Çok sık tarih filtresi attınız. Lütfen 10 saniye bekleyip tekrar deneyiniz.' },
    skip: (req) => !req.query.from && !req.query.to 
});

// ============================================
// Driver Routes (/api/drivers/...)
// ============================================
router.post('/drivers/trip-count', requireAuth, driverController.getTripCount);
router.get('/drivers/campaign', requireAuth, driverController.getCampaign);
router.post('/drivers/balance', requireAuth, driverController.getBalance);
router.get('/drivers/bank-account', requireAuth, driverController.getBankAccounts);
router.post('/drivers/bank-account', requireAuth, driverController.addBankAccount);
router.delete('/drivers/bank-account/:id', requireAuth, driverController.deleteBankAccount);

router.post('/drivers/withdraw', requireAuth, driverController.withdraw);
router.get('/drivers/withdraw-status', requireAuth, driverController.getWithdrawStatus);
router.get('/drivers/withdraw-history', requireAuth, driverController.getWithdrawHistory);

router.post('/drivers/check-plate', requireAuth, driverController.checkPlate);
router.post('/drivers/change-car', requireAuth, driverController.changeCar);

// Registration (Public but limited by authLimiter in app.js)
router.post('/drivers/register/request-otp', driverController.requestOtp);
router.post('/drivers/register/verify', driverController.verifyRegistration);

router.get('/drivers/car-brands', driverController.getCarBrands);

// ============================================
// Leaderboard (Driver View) (/api/leaderboard)
// ============================================
router.get('/leaderboard', requireAuth, customLeaderboardLimiter, driverController.getLeaderboard);

module.exports = router;
