const test = require('node:test');
const assert = require('node:assert/strict');
const { buildPaymentLogsQuery: build, paymentLogsPage: page, buildPaymentSummaryQuery: summary } = require('../db/adminPaymentLogs');

test('bounds page size and rejects malformed filters', () => {
    assert.equal(build().values.at(-1), 51);
    for (const q of [{ limit: '500' }, { limit: '0' }, { q: 'ab' }, { q: ['abc'] },
        { from: '2026-02-30' }, { from: '2026-09-15', to: '2026-09-01' },
        { status: 'invalid' }, { cursor: 'invalid' },
        { cursor: Buffer.from(JSON.stringify({ at: '2026-02-30T00:00:00.000000Z', id: 1 })).toString('base64url') }]) {
        assert.throws(() => build(q), { status: 400 });
    }
    assert.equal(build({ q: '12' }).values[0], 12);
});

test('user input remains a bound literal, including SQL/LIKE characters', () => {
    const input = "O'Connor%_\\";
    const query = build({ q: input });
    assert.ok(!query.text.includes(input));
    assert.equal(query.values[0], "%o'connor\\%\\_\\\\%");
    assert.equal(build({ q: '  TR14 0004 6006 0588 8000 1546 17  ' }).values[0], '%tr140004600605888000154617%');
    assert.equal(build({ q: 'GÜRHAN YIĞIN' }).values[0], '%gürhan yiğin%');
});

test('cursor preserves microsecond precision and uses a stable ID tie breaker', () => {
    const rows = [
        { id: 9, cursor_at: '2026-09-21T18:27:40.551999Z' },
        { id: 8, cursor_at: '2026-09-21T18:27:40.551998Z' }
    ];
    const result = page(rows, 1);
    assert.equal(result.logs[0].cursor_at, undefined);
    assert.equal(result.hasMore, true);
    const query = build({ cursor: result.nextCursor });
    assert.deepEqual(query.values.slice(0, 2), [rows[0].cursor_at, 9]);
    assert.match(query.text, /\(created_at, id\) </);
    assert.equal(page(rows, 2).nextCursor, null);
});

test('date boundaries are interpreted in Istanbul and the end date is inclusive', () => {
    const query = build({ from: '2026-09-01', to: '2026-09-15', status: 'success', parkPartnerId: 'izmir' });
    assert.deepEqual(query.values, ['2026-09-01', '2026-09-15', 'success', 'izmir', 51]);
    assert.match(query.text, /date \+ 1/);
    assert.match(query.text, /Europe\/Istanbul/);
});

test('status groups map to fixed SQL conditions and never bind user input', () => {
    for (const status of ['grp_action', 'grp_delayed', 'grp_processing', 'pending']) {
        const query = build({ status });
        assert.deepEqual(query.values, [51]);
        assert.match(query.text, /WHERE \(/);
    }
    assert.match(build({ status: 'grp_delayed' }).text, /yandex_pending' AND created_at < NOW\(\) - INTERVAL '30 minutes'/);
    assert.match(build({ status: 'grp_delayed' }).text, /COALESCE\(bank_started_at, created_at\) < NOW\(\) - INTERVAL '120 minutes'/);
    assert.match(build({ status: 'grp_processing' }).text, /AND NOT \(\(status = 'yandex_pending'/);
    assert.match(build({ status: 'grp_processing' }).text, /'bank_unknown', 'admin_processing'/);
    assert.match(build({ status: 'grp_action' }).text, /'admin_review'/);
    const single = build({ status: 'yandex_failed' });
    assert.deepEqual(single.values, ['yandex_failed', 51]);
    assert.match(single.text, /status = \$1/);
});

test('summary counts only open records and respects the city filter', () => {
    const all = summary();
    assert.deepEqual(all.values, []);
    assert.match(all.text, /AS action[\s\S]*AS delayed[\s\S]*AS processing/);
    assert.doesNotMatch(all.text, /park_partner_id/);
    const city = summary({ parkPartnerId: 'izmir', status: 'success', q: 'abc' });
    assert.deepEqual(city.values, ['izmir']);
    assert.match(city.text, /park_partner_id = \$1/);
    assert.throws(() => summary({ parkPartnerId: ['x'] }), { status: 400 });
});

test('TR000 error records are filterable but are not counted as open', () => {
    const query = build({ status: 'bank_tr000_error' });
    assert.deepEqual(query.values, ['bank_tr000_error', 51]);
    assert.doesNotMatch(summary().text, /bank_tr000_error/);
});
