const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

test('suspended or unverifiable withdrawals stay disabled after amount edits', async () => {
    for (const status of [
        { success: true, canWithdraw: false, suspended: true, message: 'Şehir kapalı' },
        { success: false, canWithdraw: false, message: 'Doğrulanamadı' },
        { success: true, canWithdraw: true }
    ]) {
        const elements = new Map();
        const get = id => {
            if (!elements.has(id)) elements.set(id, { value: '1', style: {}, classList: { add() {}, remove() {} },
                addEventListener(name, fn) { this[name] = fn; }, removeEventListener() {} });
            return elements.get(id);
        };
        const context = vm.createContext({ console, API_BASE: '/api',
            document: { getElementById: get }, closeAllModals() {},
            driverBankAccounts: [{ id: 1, iban: 'TR000000000000000000000000', accountHolderName: 'Test' }],
            authenticatedFetch: async url => ({ json: async () => url.endsWith('/balance')
                ? { success: true, balance: '1000' } : status })
        });
        vm.runInContext(fs.readFileSync(path.join(__dirname, '../risego_frontend/js/withdraw.js'), 'utf8'), context);
        await context.openWithdrawModal();
        assert.equal(get('withdrawBtn').disabled, !status.canWithdraw);
        get('withdrawAmountInput').value = '500';
        get('withdrawAmountInput').input();
        assert.equal(get('withdrawBtn').disabled, !status.canWithdraw);
        if (!status.canWithdraw) assert.equal(get('withdrawCooldownInfo').textContent, status.message);
    }
});
