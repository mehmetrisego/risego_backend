const db = require('./index');

// Keep this expression identical to the payment_logs search index.
const SEARCH_EXPRESSION = `lower(translate(
    coalesce(beneficiary_name, '') || ' ' || coalesce(driver_id, '') || ' ' ||
    coalesce(tu_ref_number, '') || ' ' || coalesce(beneficiary_iban, ''), 'İIı', 'iii'))`;
const STATUSES = new Set(['success', 'pending_bank', 'bank_returned', 'error', 'refunded', 'pending']);

function invalid(message) {
    const error = new Error(message);
    error.status = 400;
    throw error;
}

function stringParam(query, key, max = 160) {
    const value = query[key];
    if (value === undefined) return '';
    if (typeof value !== 'string' || value.length > max) invalid(`Geçersiz ${key} parametresi.`);
    return value.trim();
}

function dateParam(query, key) {
    const value = stringParam(query, key, 10);
    if (!value) return '';
    const parsed = new Date(`${value}T00:00:00Z`);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(value) || !Number.isFinite(parsed.getTime()) ||
        parsed.toISOString().slice(0, 10) !== value) invalid('Geçerli bir tarih giriniz (YYYY-MM-DD).');
    return value;
}

function buildPaymentLogsQuery(query = {}) {
    const values = [];
    const conditions = [];
    const param = value => { values.push(value); return `$${values.length}`; };
    let search = stringParam(query, 'q').replace(/\s+/g, ' ');
    if (/^TR[\d\s]+$/i.test(search)) search = search.replace(/\s/g, '');
    const from = dateParam(query, 'from');
    const to = dateParam(query, 'to');
    if (from && to && from > to) invalid('Başlangıç tarihi bitiş tarihinden sonra olamaz.');
    const status = stringParam(query, 'status', 30);
    if (status && !STATUSES.has(status)) invalid('Geçersiz işlem durumu.');
    const park = stringParam(query, 'parkPartnerId', 100);
    const limitText = stringParam(query, 'limit', 3);
    const limit = limitText ? Number(limitText) : 50;
    if (!Number.isInteger(limit) || limit < 1 || limit > 50) invalid('Sayfa boyutu 1–50 arasında olmalıdır.');

    if (search) {
        const numericId = /^\d+$/.test(search) && Number(search) <= 2147483647;
        if (search.length < 3) {
            if (!numericId) invalid('Arama için en az 3 karakter yazınız.');
            conditions.push(`id = ${param(Number(search))}`);
        } else {
            // LIKE metacharacters are literal user input, never wildcards.
            const normalized = search.replace(/[İIı]/g, 'i').toLowerCase();
            const escaped = normalized.replace(/[\\%_]/g, '\\$&');
            const textMatch = `${SEARCH_EXPRESSION} LIKE ${param(`%${escaped}%`)}`;
            conditions.push(numericId ? `(${textMatch} OR id = ${param(Number(search))})` : textMatch);
        }
    }
    if (from) conditions.push(`created_at >= (${param(from)}::date::timestamp AT TIME ZONE 'Europe/Istanbul')`);
    if (to) conditions.push(`created_at < ((${param(to)}::date + 1)::timestamp AT TIME ZONE 'Europe/Istanbul')`);
    if (status) conditions.push(`status = ${param(status)}`);
    if (park) conditions.push(`park_partner_id = ${param(park)}`);

    const cursor = stringParam(query, 'cursor', 256);
    if (cursor) {
        let decoded;
        try { decoded = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')); }
        catch (_) { invalid('Geçersiz sayfalama bilgisi.'); }
        if (!decoded || typeof decoded.at !== 'string' ||
            !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/.test(decoded.at) ||
            !Number.isFinite(Date.parse(decoded.at)) ||
            new Date(decoded.at).toISOString().slice(0, 19) !== decoded.at.slice(0, 19) || !Number.isInteger(decoded.id) ||
            decoded.id < 1 || decoded.id > 2147483647) invalid('Geçersiz sayfalama bilgisi.');
        conditions.push(`(created_at, id) < (${param(decoded.at)}::timestamptz, ${param(decoded.id)}::integer)`);
    }
    return {
        text: `SELECT id, driver_id, beneficiary_name, beneficiary_iban, amount, gross_amount,
            fee, tu_ref_number, status, error_message, park_partner_id, created_at,
            bank_status_code, bank_status_checked_at, return_reason_code, yandex_refund_at,
            to_char(created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS cursor_at
            FROM payment_logs ${conditions.length ? `WHERE ${conditions.join(' AND ')}` : ''}
            ORDER BY created_at DESC, id DESC LIMIT ${param(limit + 1)}`,
        values, limit
    };
}

function paymentLogsPage(rows, limit) {
    const hasMore = rows.length > limit;
    const page = rows.slice(0, limit);
    const last = page[page.length - 1];
    return {
        logs: page.map(({ cursor_at, ...record }) => record),
        hasMore,
        nextCursor: hasMore ? Buffer.from(JSON.stringify({ at: last.cursor_at, id: last.id })).toString('base64url') : null
    };
}

async function getPaymentLogs(query) {
    const { text, values, limit } = buildPaymentLogsQuery(query);
    const client = await db.pool.connect();
    try {
        await client.query('BEGIN READ ONLY');
        await client.query("SET LOCAL statement_timeout = '5s'");
        const result = await client.query(text, values);
        await client.query('COMMIT');
        return paymentLogsPage(result.rows, limit);
    } catch (error) {
        await client.query('ROLLBACK');
        throw error;
    } finally { client.release(); }
}

module.exports = { getPaymentLogs, buildPaymentLogsQuery, paymentLogsPage };
