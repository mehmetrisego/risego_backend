const authService = require('../services/authService');
const config = require('../config');

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
        console.error('[Middleware] Auth middleware hatası:', error.message);
        res.status(401).json({ success: false, message: 'Oturum doğrulanamadı.' });
    }
}

/** Oturumdaki sürücünün Yandex park kimliği (çoklu şehir API anahtarları) */
function sessionParkPartnerId(req) {
    return (req.sessionDriver && req.sessionDriver.parkPartnerId) || config.yandexFleet.partnerId;
}

// ============================================
// Admin panel oturum doğrulama
// ============================================
async function requireAdminAuth(req, res, next) {
    const token = req.headers['x-admin-token'];
    if (!token) {
        return res.status(401).json({ success: false, message: 'Oturum bulunamadı. Lütfen giriş yapın.' });
    }
    try {
        const session = await authService.validateAdminSession(token);
        if (!session) {
            return res.status(401).json({ success: false, message: 'Oturum geçersiz veya süresi dolmuş. Lütfen tekrar giriş yapın.' });
        }
        req.adminSession = session;
        next();
    } catch (error) {
        console.error('[Middleware] Admin auth middleware hatası:', error.message);
        res.status(401).json({ success: false, message: 'Oturum doğrulanamadı.' });
    }
}

module.exports = {
    requireAuth,
    sessionParkPartnerId,
    requireAdminAuth
};
