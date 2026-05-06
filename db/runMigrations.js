/**
 * Migration'ları çalıştırır - sunucu başlarken otomatik çağrılır.
 * Her migration dosyası yalnızca BİR KEZ çalışır (schema_migrations tablosu ile takip edilir).
 */
const fs   = require('fs');
const path = require('path');
const { pool } = require('./index');

async function runMigrations() {
    if (!pool) return;

    // Migration takip tablosunu oluştur (yoksa)
    await pool.query(`
        CREATE TABLE IF NOT EXISTS schema_migrations (
            filename   VARCHAR(255) PRIMARY KEY,
            applied_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
        )
    `);

    // Hangi migration'ların çalıştığını öğren
    const { rows } = await pool.query('SELECT filename FROM schema_migrations');
    const applied = new Set(rows.map(r => r.filename));

    const migrationsDir = path.join(__dirname, 'migrations');
    const files = fs.readdirSync(migrationsDir)
        .filter(f => f.endsWith('.sql'))
        .sort();

    for (const file of files) {
        if (applied.has(file)) {
            // Zaten çalıştı — atla
            continue;
        }

        const filePath = path.join(migrationsDir, file);
        const sql = fs.readFileSync(filePath, 'utf8');
        try {
            await pool.query(sql);
            await pool.query(
                'INSERT INTO schema_migrations (filename) VALUES ($1) ON CONFLICT DO NOTHING',
                [file]
            );
            console.log(`[DB] Migration tamamlandı: ${file}`);
        } catch (err) {
            console.error(`[DB] Migration hatası (${file}):`, err.message);
            throw err;
        }
    }
}

module.exports = { runMigrations };
