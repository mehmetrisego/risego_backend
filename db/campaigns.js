/**
 * Kampanya - PostgreSQL CRUD (park / şehir bazlı)
 */
const db = require('./index');

async function getCampaign(parkPartnerId) {
    if (!db.isConfigured()) return { text: '', active: false, updatedAt: null };
    const pid = parkPartnerId || '';
    const result = await db.query(
        `SELECT text, active, updated_at AS "updatedAt"
         FROM campaigns
         WHERE active = true AND park_partner_id = $1
         ORDER BY updated_at DESC
         LIMIT 1`,
        [pid]
    );
    if (result.rows[0]) {
        return {
            text: result.rows[0].text || '',
            active: result.rows[0].active,
            updatedAt: result.rows[0].updatedAt ? result.rows[0].updatedAt.toISOString() : null
        };
    }
    return { text: '', active: false, updatedAt: null };
}

/**
 * Kampanya kaydet — sadece ilgili parktaki aktif kayıtları pasif yapar, yeni ekler
 */
async function upsertCampaign(text, parkPartnerId) {
    if (!db.isConfigured()) return { text: '', active: false, updatedAt: null };
    const pid = parkPartnerId || '';
    await db.query(
        'UPDATE campaigns SET active = false WHERE active = true AND park_partner_id = $1',
        [pid]
    );
    const result = await db.query(
        `INSERT INTO campaigns (text, active, updated_at, park_partner_id)
         VALUES ($1, true, NOW(), $2)
         RETURNING updated_at`,
        [text, pid]
    );
    const updatedAt = result.rows[0]?.updated_at?.toISOString() || new Date().toISOString();
    return { text, active: true, updatedAt };
}

/**
 * Kampanya sil — ilgili parktaki aktif kampanyayı pasif yapar
 */
async function deactivateCampaign(parkPartnerId) {
    if (!db.isConfigured()) return;
    const pid = parkPartnerId || '';
    await db.query(
        'UPDATE campaigns SET active = false WHERE active = true AND park_partner_id = $1',
        [pid]
    );
}

module.exports = {
    getCampaign,
    upsertCampaign,
    deactivateCampaign
};
