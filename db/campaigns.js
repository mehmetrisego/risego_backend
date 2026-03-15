/**
 * Kampanya - PostgreSQL CRUD
 */
const db = require('./index');

async function getCampaign() {
    if (!db.isConfigured()) return { text: '', active: false, updatedAt: null };
    const result = await db.query(
        `SELECT text, active, updated_at AS "updatedAt" FROM campaigns WHERE active = true ORDER BY updated_at DESC LIMIT 1`
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
 * Kampanya kaydet - önce tümünü pasif yap, yeni ekle
 */
async function upsertCampaign(text) {
    if (!db.isConfigured()) return { text: '', active: false, updatedAt: null };
    await db.query('UPDATE campaigns SET active = false WHERE active = true');
    const result = await db.query(
        `INSERT INTO campaigns (text, active, updated_at) VALUES ($1, true, NOW()) RETURNING updated_at`,
        [text]
    );
    const updatedAt = result.rows[0]?.updated_at?.toISOString() || new Date().toISOString();
    return { text, active: true, updatedAt };
}

/**
 * Kampanya sil - aktif kampanyayı pasif yap
 */
async function deactivateCampaign() {
    if (!db.isConfigured()) return;
    await db.query('UPDATE campaigns SET active = false WHERE active = true');
}

module.exports = {
    getCampaign,
    upsertCampaign,
    deactivateCampaign
};
