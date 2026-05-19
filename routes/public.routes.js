const express = require('express');
const router = express.Router();
const config = require('../config');
const dbCampaigns = require('../db/campaigns');
const authService = require('../services/authService');

async function resolvePublicCampaignPark(req) {
    const token = req.headers['x-session-token'];
    if (token) {
        try {
            const parkPid = await authService.getSessionParkPartnerId(token);
            if (parkPid && String(parkPid).trim().length > 0) {
                return String(parkPid).trim();
            }
        } catch (_) { /* yoksay */ }
    }
    const q = (req.query.parkPartnerId || '').trim();
    if (q && config.findYandexParkByPartnerId(q)) return q;
    const cityParam = (req.query.city || '').trim();
    if (cityParam) {
        const src = config.findYandexParkByCity(cityParam);
        if (src) return src.partnerId;
    }
    const hdrPark = (req.headers['x-park-partner-id'] || '').trim();
    if (hdrPark && config.findYandexParkByPartnerId(hdrPark)) return hdrPark;
    return config.yandexFleet.partnerId;
}

router.get('/campaign', async (req, res) => {
    try {
        const parkPid = await resolvePublicCampaignPark(req);
        const campaign = await dbCampaigns.getCampaign(parkPid);
        res.json({ success: true, campaign });
    } catch (error) {
        console.error('[PublicRoutes] Kampanya okuma hatası:', error.message);
        res.json({ success: true, campaign: { text: '', active: false, updatedAt: null } });
    }
});

// Ana sayfa
router.get('/', (req, res) => {
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

module.exports = router;
