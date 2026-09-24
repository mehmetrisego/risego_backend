const test = require('node:test');
const assert = require('node:assert/strict');

// Explicit opt-in. Uses a temporary table and rolls back all fixture data.
test('PostgreSQL: searches beyond 500, paginates without gaps, filters Turkish dates', {
    skip: process.env.RUN_PAYMENT_DB_TESTS !== '1'
}, async () => {
    require('dotenv').config({ quiet: true });
    const db = require('../db');
    const { buildPaymentLogsQuery: build, paymentLogsPage: page } = require('../db/adminPaymentLogs');
    const client = await db.pool.connect();
    try {
        await client.query('BEGIN');
        await client.query("SET LOCAL statement_timeout='10s'");
        await client.query('CREATE TEMP TABLE payment_logs (LIKE public.payment_logs INCLUDING DEFAULTS) ON COMMIT DROP');
        await client.query(`INSERT INTO pg_temp.payment_logs
            (id,driver_id,beneficiary_name,beneficiary_iban,tu_ref_number,amount,gross_amount,status,park_partner_id,created_at)
            SELECT n, 'driver-' || n, CASE WHEN n=1 THEN 'Orhan Gencebay' ELSE 'Sürücü ' || n END,
            'TR140004600605888000154617', 'REF-' || n, 10, 14,
            CASE WHEN n % 2=0 THEN 'success' ELSE 'refunded' END, 'izmir',
            '2026-09-01T00:00:00+03:00'::timestamptz + ((n / 3)::text || ' microseconds')::interval
            FROM generate_series(1,650) n`);
        const run = async filters => {
            const q = build(filters);
            return page((await client.query(q.text, q.values)).rows, q.limit);
        };
        const found = await run({ q: 'Orhan Gencebay' });
        assert.deepEqual(found.logs.map(r => r.id), [1]);
        assert.equal((await run({ q: 'TR14 0004 6006 0588 8000 1546 17' })).logs.length, 50);
        assert.equal((await run({ q: '1' })).logs[0].id, 1);
        assert.equal((await run({ q: "%' OR 1=1 --" })).logs.length, 0);
        const seen = []; let cursor;
        do {
            const result = await run(cursor ? { cursor } : {});
            seen.push(...result.logs.map(r => r.id));
            cursor = result.nextCursor;
        } while (cursor);
        assert.equal(seen.length, 650);
        assert.equal(new Set(seen).size, 650);
        assert.deepEqual(seen, Array.from({ length: 650 }, (_, i) => 650 - i));
        assert.equal((await run({ parkPartnerId: 'ankara' })).logs.length, 0);
        assert.ok((await run({ status: 'success' })).logs.every(r => r.status === 'success'));
        assert.equal((await run({ to: '2026-08-31' })).logs.length, 0);
        assert.equal((await run({ from: '2026-09-01', to: '2026-09-01' })).logs.length, 50);
        assert.equal((await run({ from: '2026-09-02' })).logs.length, 0);
        await client.query(`UPDATE pg_temp.payment_logs SET beneficiary_name='Gürhan Yığın' WHERE id=1`);
        assert.equal((await run({ q: 'GÜRHAN YIĞIN' })).logs[0].id, 1);
    } finally {
        await client.query('ROLLBACK');
        client.release();
        await db.closePool();
    }
});
