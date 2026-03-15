/**
 * Migration'ları çalıştırır - sunucu başlarken otomatik çağrılır
 */
const fs = require('fs');
const path = require('path');
const { pool } = require('./index');

async function runMigrations() {
    if (!pool) return;

    const migrationsDir = path.join(__dirname, 'migrations');
    const files = fs.readdirSync(migrationsDir).filter(f => f.endsWith('.sql')).sort();

    for (const file of files) {
        const filePath = path.join(migrationsDir, file);
        const sql = fs.readFileSync(filePath, 'utf8');
        try {
            await pool.query(sql);
            console.log(`[DB] Migration tamamlandı: ${file}`);
        } catch (err) {
            console.error(`[DB] Migration hatası (${file}):`, err.message);
            throw err;
        }
    }
}

module.exports = { runMigrations };
