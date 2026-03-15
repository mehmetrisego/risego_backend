/**
 * Admin oturumları - PostgreSQL CRUD
 */
const db = require('./index');

async function createAdminSession(token, phone, expiresAt) {
    if (!db.isConfigured()) return;
    await db.query(
        `INSERT INTO admin_sessions (token, phone, expires_at) VALUES ($1, $2, $3)`,
        [token, phone, new Date(expiresAt)]
    );
}

async function getAdminSession(token) {
    if (!db.isConfigured()) return null;
    const result = await db.query(
        `SELECT token, phone, created_at FROM admin_sessions WHERE token = $1 AND expires_at > NOW()`,
        [token]
    );
    return result.rows[0] || null;
}

async function deleteAdminSession(token) {
    if (!db.isConfigured()) return;
    await db.query('DELETE FROM admin_sessions WHERE token = $1', [token]);
}

async function deleteExpiredAdminSessions() {
    if (!db.isConfigured()) return;
    await db.query('DELETE FROM admin_sessions WHERE expires_at <= NOW()');
}

module.exports = {
    createAdminSession,
    getAdminSession,
    deleteAdminSession,
    deleteExpiredAdminSessions
};
