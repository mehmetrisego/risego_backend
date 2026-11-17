/**
 * Sürücü oturumları - PostgreSQL CRUD
 */
const db = require('./index');

async function createSession(token, driverId, phone, city, expiresAt, parkPartnerId = '') {
    if (!db.isConfigured()) return;
    // Oturum sızıntısını önle: aynı sürücünün önceki oturumlarını kapat
    // (sürücü başına tek aktif oturum — yeni giriş eskisini geçersiz kılar)
    if (driverId) {
        await db.query('DELETE FROM sessions WHERE driver_id = $1', [driverId]);
    }
    await db.query(
        `INSERT INTO sessions (token, driver_id, phone, city, expires_at, park_partner_id) VALUES ($1, $2, $3, $4, $5, $6)`,
        [token, driverId, phone, city || '', new Date(expiresAt), parkPartnerId || '']
    );
}

async function getSession(token) {
    if (!db.isConfigured()) return null;
    const result = await db.query(
        `SELECT token, driver_id, phone, city, park_partner_id, created_at FROM sessions WHERE token = $1 AND expires_at > NOW()`,
        [token]
    );
    return result.rows[0] || null;
}

async function deleteSession(token) {
    if (!db.isConfigured()) return;
    await db.query('DELETE FROM sessions WHERE token = $1', [token]);
}

async function deleteExpiredSessions() {
    if (!db.isConfigured()) return;
    await db.query('DELETE FROM sessions WHERE expires_at <= NOW()');
}

async function getActiveSessionCount() {
    if (!db.isConfigured()) return 0;
    const result = await db.query('SELECT COUNT(DISTINCT driver_id)::int AS count FROM sessions WHERE expires_at > NOW()');
    return result.rows[0]?.count || 0;
}

/** Sürücü başına yalnızca en yeni oturumu bırakır; mükerrer/eski oturumları siler. Silinen satır sayısını döner. */
async function cleanupDuplicateSessions() {
    if (!db.isConfigured()) return 0;
    const res = await db.query(`
        DELETE FROM sessions
        WHERE id IN (
            SELECT id FROM (
                SELECT id, ROW_NUMBER() OVER (PARTITION BY driver_id ORDER BY created_at DESC, id DESC) AS rn
                FROM sessions
            ) t WHERE t.rn > 1
        )`);
    return res.rowCount || 0;
}

module.exports = {
    createSession,
    getSession,
    deleteSession,
    deleteExpiredSessions,
    getActiveSessionCount,
    cleanupDuplicateSessions
};
