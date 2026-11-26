const test = require('node:test');
const assert = require('node:assert/strict');
const { evaluateOptions } = require('../services/adminDecisionService');

const base = { yandexDeducted: true, net: 1879.12 };

test('only "send" and "none" exist; there is no Yandex refund option', () => {
    for (const bankState of ['paid', 'in_progress', 'needs_confirm', 'not_found', 'returned']) {
        assert.deepEqual(Object.keys(evaluateOptions({ ...base, bankState })).filter(k => k !== 'bankPaid').sort(), ['none', 'send'], bankState);
    }
});

test('bank already paid blocks sending again (double payment)', () => {
    const o = evaluateOptions({ ...base, bankState: 'paid' });
    assert.equal(o.bankPaid, true);
    assert.equal(o.send.allowed, false);
    assert.equal(o.none.allowed, true);
});

test('no Yandex deduction (or already refunded) allows only "none"', () => {
    const o = evaluateOptions({ ...base, yandexDeducted: false, bankState: 'not_found' });
    assert.equal(o.send.allowed, false);
    assert.equal(o.none.allowed, true);
});

test('bank still processing blocks sending', () => {
    assert.equal(evaluateOptions({ ...base, bankState: 'in_progress' }).send.allowed, false);
});

test('TR000 waiting transfer is confirmed, never duplicated', () => {
    const o = evaluateOptions({ ...base, bankState: 'needs_confirm' });
    assert.deepEqual({ allowed: o.send.allowed, mode: o.send.mode, amount: o.send.amount }, { allowed: true, mode: 'confirm', amount: 1879.12 });
});

test('no transfer at bank (or returned): a new transfer is created for the net amount', () => {
    for (const bankState of ['not_found', 'returned']) {
        const o = evaluateOptions({ ...base, bankState });
        assert.deepEqual({ allowed: o.send.allowed, mode: o.send.mode, amount: o.send.amount }, { allowed: true, mode: 'create', amount: 1879.12 }, bankState);
    }
});
