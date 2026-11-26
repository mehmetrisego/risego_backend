const test = require('node:test');
const assert = require('node:assert/strict');
const { evaluateOptions } = require('../services/adminDecisionService');

const base = { yandexDeducted: true, cancelEnabled: false, gross: 1883.12, net: 1879.12 };

test('bank already paid blocks refund and send (double payment)', () => {
    const o = evaluateOptions({ ...base, bankState: 'paid' });
    assert.equal(o.bankPaid, true);
    assert.equal(o.refund.allowed, false);
    assert.equal(o.send.allowed, false);
    assert.equal(o.none.allowed, true);
});

test('no Yandex deduction (or already refunded) allows only "none"', () => {
    const o = evaluateOptions({ ...base, yandexDeducted: false, bankState: 'not_found' });
    assert.equal(o.refund.allowed, false);
    assert.equal(o.send.allowed, false);
    assert.equal(o.none.allowed, true);
});

test('bank still processing blocks refund and send', () => {
    const o = evaluateOptions({ ...base, bankState: 'in_progress' });
    assert.equal(o.refund.allowed, false);
    assert.equal(o.send.allowed, false);
});

test('TR000 waiting transfer: send confirms the SAME transfer; refund needs a tested cancel', () => {
    const off = evaluateOptions({ ...base, bankState: 'needs_confirm' });
    assert.deepEqual({ allowed: off.send.allowed, mode: off.send.mode, amount: off.send.amount }, { allowed: true, mode: 'confirm', amount: 1879.12 });
    assert.equal(off.refund.allowed, false);
    assert.match(off.refund.reason, /iptal/);
    const on = evaluateOptions({ ...base, cancelEnabled: true, bankState: 'needs_confirm' });
    assert.deepEqual({ allowed: on.refund.allowed, needsCancel: on.refund.needsCancel, amount: on.refund.amount }, { allowed: true, needsCancel: true, amount: 1883.12 });
});

test('no transfer at bank (or returned): refund gross without cancel, send creates a new transfer for net', () => {
    for (const bankState of ['not_found', 'returned']) {
        const o = evaluateOptions({ ...base, bankState });
        assert.deepEqual({ allowed: o.refund.allowed, needsCancel: o.refund.needsCancel, amount: o.refund.amount }, { allowed: true, needsCancel: false, amount: 1883.12 }, bankState);
        assert.deepEqual({ allowed: o.send.allowed, mode: o.send.mode, amount: o.send.amount }, { allowed: true, mode: 'create', amount: 1879.12 }, bankState);
    }
});
