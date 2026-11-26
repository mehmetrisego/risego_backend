const test = require('node:test');
const assert = require('node:assert/strict');
const db = require('../db');
const upt = require('../services/uptStatusService');
const { handleBankState, RETRY_OFFSETS_MIN } = require('../services/bankRetryService');

function stub(t, { after = null, confirmOk = true } = {}) {
    const calls = { sql: [], confirm: 0, process: 0 };
    t.mock.method(db, 'query', async (sql) => { calls.sql.push(sql); return { rowCount: 1, rows: [] }; });
    t.mock.method(upt, 'confirmTransfer', async () => { calls.confirm++; return { ok: confirmOk, response: confirmOk ? 'Success' : 'Error', message: confirmOk ? '' : 'İşlem statüsü onaya uygun değil.' }; });
    t.mock.method(upt, 'queryByCorrespondentRef', async () => after);
    t.mock.method(upt, 'processSinglePayment', async () => { calls.process++; });
    return calls;
}
const row = { id: 7, transaction_id: 'wd_test', driver_id: 'd1', gross_amount: '101.30', park_partner_id: 'p' };
const tr000 = { found: true, uptref: '879', statusCode: 'TR000' };

test('all retries fall inside the 10-minute withdrawal cooldown', () => {
    assert.equal(RETRY_OFFSETS_MIN.length, 3);
    assert.ok(Math.max(...RETRY_OFFSETS_MIN) < 10);
});

test('TR000: confirm is sent once and a paid result marks the record successful', async (t) => {
    const calls = stub(t, { after: { found: true, uptref: '879', statusCode: 'TR010' } });
    const r = await handleBankState(row, tr000, { allowConfirm: true });
    assert.equal(r.state, 'paid');
    assert.equal(calls.confirm, 1);
    assert.ok(calls.sql.some(s => /status = 'success'/.test(s)));
});

test('TR000: a rejected confirm leaves the record waiting for the next attempt', async (t) => {
    const calls = stub(t, { after: tr000, confirmOk: false });
    const r = await handleBankState(row, tr000, { allowConfirm: true });
    assert.equal(r.state, 'needs_confirm');
    assert.match(r.text, /Onay reddedildi/);
    assert.ok(!calls.sql.some(s => /status = 'success'/.test(s)));
});

test('final check before escalation never sends a confirm', async (t) => {
    const calls = stub(t, { after: tr000 });
    const r = await handleBankState(row, tr000, { allowConfirm: false });
    assert.equal(r.state, 'needs_confirm');
    assert.equal(calls.confirm, 0);
});

test('not found at bank: nothing is written', async (t) => {
    const calls = stub(t);
    const r = await handleBankState(row, { found: false }, { allowConfirm: true });
    assert.equal(r.state, 'not_found');
    assert.equal(calls.sql.length, 0);
    assert.equal(calls.confirm, 0);
});

test('bank returned the transfer: the existing refund flow handles it', async (t) => {
    const calls = stub(t);
    const r = await handleBankState(row, { found: true, uptref: '879', statusCode: 'TR006' }, { allowConfirm: true });
    assert.equal(r.state, 'returned');
    assert.equal(calls.process, 1);
    assert.equal(calls.confirm, 0);
});
