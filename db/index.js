/**
 * PostgreSQL veritabanı bağlantı havuzu
 * Railway: DATABASE_URL veya DATABASE_PUBLIC_URL kullanılır
 */
const { Pool } = require('pg');

const connectionString = process.env.DATABASE_URL || process.env.DATABASE_PUBLIC_URL;

/** Railway public proxy (rlwy.net) ve üretim ortamı genelde TLS ister; localhost Postgres için ssl kapalı kalır */
function poolSslOption(connStr) {
    if (!connStr) return false;
    if (process.env.NODE_ENV === 'production') return { rejectUnauthorized: false };
    if (/rlwy\.net|proxy\.rlwy/i.test(connStr)) return { rejectUnauthorized: false };
    return false;
}

const pool = connectionString
    ? new Pool({
          connectionString,
          ssl: poolSslOption(connectionString),
          max: 20,
          idleTimeoutMillis: 30000,
          connectionTimeoutMillis: 10000,
          // TCP keepalive — sunucu/NAT tarafından öldürülen bağlantıları tespit eder
          keepAlive: true,
          keepAliveInitialDelayMillis: 30000,
          // Boşta kalan havuzun process'i kilitlemesini engeller
          allowExitOnIdle: true
      })
    : null;

// ─── Havuz Hata Yönetimi ─────────────────────────────────────────────────────
// Boşta bekleyen bir client koptuğunda pool'u zehirlemesini engelle
if (pool) {
    pool.on('error', (err) => {
        console.error('[DB] Havuzdaki boşta bağlantı koptu (otomatik kaldırıldı):', err.message);
        // pg Pool zaten kopan client'ı otomatik atar, burada sadece logluyoruz
    });
}

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
