/**
 * Sürücü oturumları - PostgreSQL CRUD
 */
const db = require('./index');

async function createSession(token, driverId, phone, city, expiresAt, parkPartnerId = '') {
    if (!db.isConfigured()) return;
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
    const result = await db.query('SELECT COUNT(*)::int AS count FROM sessions WHERE expires_at > NOW()');
    return result.rows[0]?.count || 0;
}

module.exports = {
    createSession,
    getSession,
    deleteSession,
    deleteExpiredSessions,
    getActiveSessionCount
};
