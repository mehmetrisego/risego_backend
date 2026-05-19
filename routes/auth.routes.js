const express = require('express');
const router = express.Router();
const authController = require('../controllers/auth.controller');

// ============================================
// Driver Auth Routes
// ============================================
router.post('/auth/login', authController.login);
router.post('/auth/verify-otp', authController.verifyOtp);
router.get('/auth/session', authController.getSession);
router.delete('/auth/session', authController.logout);

// ============================================
// Admin Auth Routes
// ============================================
router.post('/admin/auth/login', authController.adminLogin);
router.post('/admin/auth/verify-otp', authController.adminVerifyOtp);
router.get('/admin/auth/session', authController.getAdminSession);
router.post('/admin/auth/logout', authController.adminLogout); // Note: Original was POST, I put it as POST here

module.exports = router;
