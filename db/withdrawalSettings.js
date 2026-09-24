const db = require('./index');
const GUARD_KEY = 'upt_withdrawal_guard';

function decode(rows) {
    const values = Object.fromEntries(rows.map(r => [r.key, JSON.parse(r.value)]));
    const cities = values.suspended_cities ?? [];
    const guard = values[GUARD_KEY] ?? { armed: true, revision: 0, lastObservationAt: 0, lastAutomaticStop: null };
    if (!Array.isArray(cities) || cities.some(c => typeof c !== 'string') ||
        !guard || typeof guard.armed !== 'boolean' || !Number.isInteger(guard.revision)) {
        throw new Error('Çekim güvenlik ayarları geçersiz.');
    }
    return { cities, guard };
}

async function read() {
    const result = await db.query('SELECT key, value FROM system_settings WHERE key = ANY($1::text[])', [['suspended_cities', GUARD_KEY]]);
    return decode(result.rows);
}

// Both the automatic guard and admin edits lock the same row across processes.
async function update(change) {
    const client = await db.pool.connect();
    try {
        await client.query('BEGIN');
        await client.query("SET LOCAL lock_timeout='5s'");
        await client.query("INSERT INTO system_settings (key,value) VALUES ('suspended_cities','[]') ON CONFLICT DO NOTHING");
        const city = await client.query("SELECT key,value FROM system_settings WHERE key='suspended_cities' FOR UPDATE");
        const guard = await client.query('SELECT key,value FROM system_settings WHERE key=$1', [GUARD_KEY]);
        const state = decode([...city.rows, ...guard.rows]);
        const beforeCities = JSON.stringify(state.cities);
        const beforeGuard = JSON.stringify(state.guard);
        await change(state);
        if (JSON.stringify(state.cities) !== beforeCities) {
            await client.query("UPDATE system_settings SET value=$1,updated_at=NOW() WHERE key='suspended_cities'", [JSON.stringify(state.cities)]);
        }
        if (JSON.stringify(state.guard) !== beforeGuard) {
            await client.query(`INSERT INTO system_settings (key,value) VALUES ($1,$2)
                ON CONFLICT (key) DO UPDATE SET value=EXCLUDED.value,updated_at=NOW()`, [GUARD_KEY, JSON.stringify(state.guard)]);
        }
        await client.query('COMMIT');
        return state;
    } catch (error) {
        await client.query('ROLLBACK');
        throw error;
    } finally { client.release(); }
}
module.exports = { read, update };
