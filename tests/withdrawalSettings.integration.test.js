const test = require('node:test');
const assert = require('node:assert/strict');

test('PostgreSQL safety settings persist and rollback conflicting admin edits', {
    skip: process.env.RUN_PAYMENT_DB_TESTS !== '1'
}, async () => {
    require('dotenv').config({ quiet: true });
    const db = require('../db');
    const realPool = db.pool;
    const originalQuery = db.query;
    const client = await realPool.connect();
    try {
        // Temporary session-local table: production system_settings is never touched.
        await client.query(`CREATE TEMP TABLE system_settings (
            key text PRIMARY KEY, value text NOT NULL, updated_at timestamptz DEFAULT NOW())`);
        db.query = client.query.bind(client);
        db.pool = { connect: async () => ({ query: client.query.bind(client), release() {} }) };
        const settings = require('../db/withdrawalSettings');
        const { createSafetyService } = require('../services/withdrawalSafetyService');
        let raw = '4.999,00', clock = 1000;
        const deps = { settings, now: () => ++clock, parkIds: () => ['izmir', 'ankara'],
            upt: { getUptBalance: async () => ({ success: true, tryBalanceRaw: raw }) } };
        const service = createSafetyService(deps);
        await service.checkBalance(true);
        const state = await settings.read();
        assert.deepEqual(state.cities, ['izmir', 'ankara']);
        await assert.rejects(service.saveCities([], 0), { status: 409 });
        assert.deepEqual((await settings.read()).cities, state.cities);
        await service.saveCities(['ankara'], state.guard.revision);
        const restarted = createSafetyService(deps);
        await restarted.checkBalance(true);
        assert.deepEqual((await settings.read()).cities, ['ankara']);
        raw = '6.000,00'; await restarted.checkBalance(true);
        assert.deepEqual((await settings.read()).cities, ['ankara']);
        raw = '0,00'; await restarted.checkBalance(true);
        assert.deepEqual(new Set((await settings.read()).cities), new Set(['izmir', 'ankara']));
    } finally {
        db.query = originalQuery; db.pool = realPool;
        // Closing this physical connection discards the temporary table.
        client.release(true);
        await db.closePool();
    }
});
