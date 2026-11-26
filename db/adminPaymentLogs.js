const db = require('./index');

// Keep this expression identical to the payment_logs search index.
const SEARCH_EXPRESSION = `lower(translate(
    coalesce(beneficiary_name, '') || ' ' || coalesce(driver_id, '') || ' ' ||
    coalesce(tu_ref_number, '') || ' ' || coalesce(beneficiary_iban, ''), 'İIı', 'iii'))`;
const STATUSES = new Set(['success', 'pending_bank', 'bank_returned', 'error', 'refunded',
    'yandex_failed', 'yandex_stuck_review', 'bank_unknown', 'yandex_pending', 'bank_starting',
    'bank_returned_refund_pending', 'pending', 'grp_action', 'grp_delayed', 'grp_processing']);

// Panel durum gruplari. Esikler panelle ortak; yanitta `thresholds` olarak doner.
const THRESHOLDS = { yandexDelayMinutes: 30, bankStuckMinutes: 120 };
const ACTION_SQL = `status IN ('bank_returned_refund_pending', 'error', 'yandex_stuck_review')`;
const DELAYED_SQL = `(status = 'bank_unknown'
    OR (status = 'yandex_pending' AND created_at < NOW() - INTERVAL '${THRESHOLDS.yandexDelayMinutes} minutes')
    OR (status = 'pending_bank' AND COALESCE(bank_started_at, created_at) < NOW() - INTERVAL '${THRESHOLDS.bankStuckMinutes} minutes'))`;
const PROCESSING_SQL = `(status IN ('yandex_pending', 'bank_starting', 'pending_bank') AND NOT ${DELAYED_SQL})`;
// 'pending' eski panel surumunun gonderdigi deger; geriye uyumluluk icin "islemde" grubuna eslenir.
const GROUP_SQL = { grp_action: ACTION_SQL, grp_delayed: DELAYED_SQL, grp_processing: PROCESSING_SQL, pending: PROCESSING_SQL };
const OPEN_STATUSES_SQL = `status IN ('bank_returned_refund_pending', 'error', 'yandex_stuck_review',
    'bank_unknown', 'yandex_pending', 'bank_starting', 'pending_bank')`;

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
    if (status) conditions.push(GROUP_SQL[status] ? `(${GROUP_SQL[status]})` : `status = ${param(status)}`);
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
            bank_status_code, bank_status_checked_at, return_reason_code, yandex_refund_at, bank_started_at,
            to_char(created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS cursor_at
            FROM payment_logs ${conditions.length ? `WHERE ${conditions.join(' AND ')}` : ''}
            ORDER BY created_at DESC, id DESC LIMIT ${param(limit + 1)}`,
        values, limit
    };
}

/** Acik (sonuclanmamis) kayitlarin grup sayilari; sehir filtresine uyar. */
function buildPaymentSummaryQuery(query = {}) {
    const park = stringParam(query, 'parkPartnerId', 100);
    const values = park ? [park] : [];
    return {
        text: `SELECT COUNT(*) FILTER (WHERE ${ACTION_SQL})::int AS action,
            COUNT(*) FILTER (WHERE ${DELAYED_SQL})::int AS delayed,
            COUNT(*) FILTER (WHERE ${PROCESSING_SQL})::int AS processing
            FROM payment_logs WHERE ${OPEN_STATUSES_SQL}${park ? ' AND park_partner_id = $1' : ''}`,
        values
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
    const summaryQuery = buildPaymentSummaryQuery(query);
    const client = await db.pool.connect();
    try {
        await client.query('BEGIN READ ONLY');
        await client.query("SET LOCAL statement_timeout = '5s'");
        const result = await client.query(text, values);
        const summary = (await client.query(summaryQuery.text, summaryQuery.values)).rows[0];
        await client.query('COMMIT');
        return { ...paymentLogsPage(result.rows, limit), summary, thresholds: THRESHOLDS };
    } catch (error) {
        await client.query('ROLLBACK');
        throw error;
    } finally { client.release(); }
}

module.exports = { getPaymentLogs, buildPaymentLogsQuery, buildPaymentSummaryQuery, paymentLogsPage, THRESHOLDS };
