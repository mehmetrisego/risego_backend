const test = require('node:test');
const assert = require('node:assert/strict');
const { parseUptBalance } = require('../services/uptBalanceParser');
const { createSafetyService } = require('../services/withdrawalSafetyService');

function fixture() {
    let state = { cities: ['manual'], guard: { armed: true, revision: 0, lastObservationAt: 0, lastAutomaticStop: null } };
    let raw = '5.000,00', clock = 100000, calls = 0;
    const settings = {
        read: async () => structuredClone(state),
        update: async fn => { const next = structuredClone(state); await fn(next); state = next; return structuredClone(state); }
    };
    const deps = { settings, now: () => clock, parkIds: () => ['izmir', 'ankara', 'manual'],
        upt: { getUptBalance: async () => { calls++; return { success: true, tryBalanceRaw: raw }; } } };
    return { service: createSafetyService(deps), restart: () => createSafetyService(deps),
        balance: value => { raw = value; clock += 60000; }, calls: () => calls };
}

test('parses UPT amounts strictly; missing or invalid amounts are never zero', () => {
    for (const [raw, expected] of [['4.999,99',4999.99], ['4999.99',4999.99], ['4,999.99',4999.99],
        ['5.000,00',5000], ['0,00',0], ['-25,50',-25.5], ['162.312,56',162312.56], ['5.000',5000]]) {
        assert.equal(parseUptBalance(raw), expected);
    }
    for (const invalid of [null, '', 'error', '4.99,00', '5000oops', NaN, Infinity]) assert.equal(parseUptBalance(invalid), null);
});

test('only below 5000 closes all cities, and recovery never reopens them', async () => {
    const f = fixture();
    await f.service.checkBalance();
    assert.deepEqual((await f.service.getState()).cities, ['manual']);
    f.balance('4.999,99'); await f.service.checkBalance();
    assert.deepEqual(new Set((await f.service.getState()).cities), new Set(['manual','izmir','ankara']));
    await assert.rejects(f.service.assertAllowed('izmir'), { status: 503 });
    f.balance('10.000,00'); await f.service.checkBalance();
    await assert.rejects(f.service.assertAllowed('izmir'), { status: 503 });
});

test('admin can reopen individual cities; sustained low balance and restart preserve choice', async () => {
    const f = fixture(); f.balance('4.000,00'); await f.service.checkBalance();
    const state = await f.service.getState();
    await f.service.saveCities(['manual','ankara'], state.guard.revision);
    const restarted = f.restart(); f.balance('3.500,00'); await restarted.checkBalance();
    await restarted.assertAllowed('izmir');
    await assert.rejects(restarted.assertAllowed('ankara'), { status: 503 });
    f.balance('5.000,00'); await restarted.checkBalance();
    assert.deepEqual((await restarted.getState()).cities, ['manual','ankara']);
    f.balance('4.999,00'); await restarted.checkBalance();
    await assert.rejects(restarted.assertAllowed('izmir'), { status: 503 });
});

test('stale admin saves cannot undo a new automatic stop', async () => {
    const f = fixture(); const old = await f.service.getState();
    f.balance('0,00'); await f.service.checkBalance();
    await assert.rejects(f.service.saveCities([], old.guard.revision), { status: 409 });
    await assert.rejects(f.service.saveCities(['unknown'], 1), { status: 400 });
    assert.equal((await f.service.getState()).cities.length, 3);
});

test('failed bank lookup prevents withdrawal without permanently changing city settings', async () => {
    const f = fixture(); f.balance('invalid');
    await assert.rejects(f.service.assertAllowed('izmir'), /doğrulanamadı/);
    assert.deepEqual((await f.service.getState()).cities, ['manual']);
});

test('nearby checks reuse bank balance to limit traffic', async () => {
    const f = fixture();
    await f.service.assertAllowed('izmir'); await f.service.assertAllowed('ankara');
    assert.equal(f.calls(), 1);
    await f.service.checkBalance(true); assert.equal(f.calls(), 2);
});
