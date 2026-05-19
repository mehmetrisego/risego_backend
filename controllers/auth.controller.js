const authService = require('../services/authService');

// ─── Driver Auth Controllers ───

exports.login = async (req, res) => {
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
        console.error('[AuthController] Login hatası:', error.message);
        res.status(500).json({ success: false, message: 'Sunucu hatası oluştu. Lütfen tekrar deneyin.' });
    }
};

exports.verifyOtp = async (req, res) => {
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
        console.error('[AuthController] OTP doğrulama hatası:', error.message);
        res.status(500).json({ success: false, message: 'Sunucu hatası oluştu. Lütfen tekrar deneyin.' });
    }
};

exports.getSession = async (req, res) => {
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
        console.error('[AuthController] Session doğrulama hatası:', error.message);
        res.json({ success: false });
    }
};

exports.logout = (req, res) => {
    const token = req.headers['x-session-token'];
    if (token) {
        authService.destroySession(token);
    }
    res.json({ success: true });
};


// ─── Admin Auth Controllers ───

exports.adminLogin = async (req, res) => {
    try {
        const { phone } = req.body;
        if (!phone) {
            return res.status(400).json({ success: false, message: 'Telefon numarası gereklidir.' });
        }
        const result = await authService.adminLogin(phone);
        res.json(result);
    } catch (error) {
        console.error('[AuthController] Admin login hatası:', error.message);
        res.status(500).json({ success: false, message: 'Sunucu hatası oluştu.' });
    }
};

exports.adminVerifyOtp = async (req, res) => {
    try {
        const { phone, otp } = req.body;
        if (!phone || !otp) {
            return res.status(400).json({ success: false, message: 'Telefon numarası ve doğrulama kodu gereklidir.' });
        }
        const result = await authService.adminVerifyOTP(phone, otp);
        res.json(result);
    } catch (error) {
        console.error('[AuthController] Admin OTP hatası:', error.message);
        res.status(500).json({ success: false, message: 'Sunucu hatası oluştu.' });
    }
};

exports.getAdminSession = async (req, res) => {
    try {
        const token = req.headers['x-admin-token'];
        if (!token) {
            return res.json({ success: false, message: 'Oturum bulunamadı.' });
        }
        const session = await authService.validateAdminSession(token);
        if (!session) {
            return res.json({ success: false, message: 'Oturum geçersiz.' });
        }
        const activeDriverSessions = await authService.getActiveDriverSessionCount();
        res.json({ success: true, activeDriverSessions });
    } catch (error) {
        console.error('[AuthController] Admin session hatası:', error.message);
        res.json({ success: false, message: 'Oturum doğrulanamadı.' });
    }
};

exports.adminLogout = (req, res) => {
    const token = req.headers['x-admin-token'];
    if (token) {
        authService.destroyAdminSession(token);
    }
    res.json({ success: true });
};
