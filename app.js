const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');

const app = express();

// Güvenlik Katmanı 1: Helmet - Başlıkları güvenlik altına alır
app.use(helmet());

// Güvenlik Katmanı 2: CORS
const allowedOrigins = [
    'https://risegodriver.com',
    'https://www.risegodriver.com',
    'https://admin.risegodriver.com',
    'https://mehmetrisego.github.io',
    'https://risegobackend-production-2e58.up.railway.app',
    'http://localhost:3000',
    'http://127.0.0.1:3000',
    'http://127.0.0.1:5500',
    'http://localhost:5500',
    'http://192.168.1.102:5500',
    'null'  // file:// ile açılan sayfalar
];
app.use(cors({
    origin: (origin, callback) => {
        if (!origin) return callback(null, true);  // Postman, curl vb.
        if (allowedOrigins.includes(origin)) return callback(null, true);
        if (origin.endsWith('.risegodriver.com') || origin.endsWith('.github.io')) return callback(null, true);
        callback(null, false);  // İzin verilmedi
    },
    methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Origin', 'X-Requested-With', 'Content-Type', 'Accept', 'x-session-token', 'x-park-partner-id', 'x-admin-token'],
    credentials: true
}));

app.use(express.json({ limit: '32kb' }));

// Uygulama bu sunucuda yalnızca yerel Nginx proxy'sine güvenir.
// Nginx, X-Forwarded-For ile gerçek istemci IP'sini ilettiğinde rate limiter
// tüm kullanıcıları 127.0.0.1 olarak değil ayrı ayrı değerlendirir.
app.set('trust proxy', 'loopback');

// Güvenlik Katmanı 3: Rate Limiting - SMS Brute Force engellemek için
const authLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 10,
    standardHeaders: 'draft-8',
    legacyHeaders: false,
    message: { success: false, message: 'Çok fazla giriş denemesi yaptınız, lütfen daha sonra tekrar deneyin.' }
});

const otpVerifyLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 20,
    standardHeaders: 'draft-8',
    legacyHeaders: false,
    message: { success: false, message: 'Çok fazla doğrulama denemesi yaptınız. Lütfen daha sonra tekrar deneyin.' }
});

// Login, OTP ve Admin limitlerini bağla
app.use('/api/auth/login', authLimiter);
app.use('/api/admin/auth/login', authLimiter);
app.use('/api/auth/verify-otp', otpVerifyLimiter);
app.use('/api/admin/auth/verify-otp', otpVerifyLimiter);

// ─── API Routes ───
const apiRoutes = require('./routes/index');
app.use('/api', apiRoutes);

// Root path documentation
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
            driverCampaign: 'GET /api/drivers/campaign (oturum — profil ile aynı şehir/park)',
            adminCampaign: 'POST|GET|DELETE /api/admin/campaign (?parkPartnerId & body.parkPartnerId)',
            adminParks: 'GET /api/admin/parks',
            adminLeaderboard: 'GET /api/admin/leaderboard'
        }
    });
});

module.exports = app;
