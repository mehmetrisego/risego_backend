/**
 * PostgreSQL veritabanı bağlantı havuzu
 * Railway: DATABASE_URL veya DATABASE_PUBLIC_URL kullanılır
 */
const { Pool } = require('pg');

const connectionString = process.env.DATABASE_URL || process.env.DATABASE_PUBLIC_URL;

const pool = connectionString
    ? new Pool({
          connectionString,
          ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false,
          max: 10,
          idleTimeoutMillis: 30000,
          connectionTimeoutMillis: 10000
      })
    : null;

/**
 * Veritabanı bağlantısını test eder
 */
async function testConnection() {
    if (!pool) {
        console.warn('[DB] DATABASE_URL veya DATABASE_PUBLIC_URL tanımlı değil. Oturum ve kampanya bellekte tutulacak.');
        return false;
    }
    try {
        const client = await pool.connect();
        await client.query('SELECT 1');
        client.release();
        console.log('[DB] PostgreSQL bağlantısı başarılı.');
        return true;
    } catch (err) {
        console.error('[DB] PostgreSQL bağlantı hatası:', err.message);
        return false;
    }
}

/**
 * Pool'u kapatır (graceful shutdown için)
 */
async function closePool() {
    if (pool) {
        await pool.end();
        console.log('[DB] Bağlantı havuzu kapatıldı.');
    }
}

module.exports = {
    pool,
    query: (text, params) => (pool ? pool.query(text, params) : Promise.reject(new Error('DB not configured'))),
    testConnection,
    closePool,
    isConfigured: () => !!pool
};
