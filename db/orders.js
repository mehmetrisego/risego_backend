/**
 * Yolculuk (sipariş) verisi - PostgreSQL CRUD
 * LeaderboardService tarafından kullanılır
 */
const db = require('./index');

const BATCH_SIZE = 500;

/**
 * Siparişleri toplu olarak DB'ye yazar (upsert - duplicate önleme)
 * @param {Array<{id: string, driverId: string|null, bookedAt: Date}>} orders
 */
async function upsertOrders(orders) {
    if (!db.isConfigured() || !orders.length) return 0;

    let inserted = 0;
    for (let i = 0; i < orders.length; i += BATCH_SIZE) {
        const batch = orders.slice(i, i + BATCH_SIZE);
        const values = batch.map((o, idx) => {
            const base = idx * 3;
            return `($${base + 1}, $${base + 2}, $${base + 3})`;
        }).join(', ');
        const params = batch.flatMap(o => [o.id, o.driverId || null, o.bookedAt]);

        await db.query(
            `INSERT INTO orders (id, driver_id, booked_at)
             VALUES ${values}
             ON CONFLICT (id) DO UPDATE SET
               driver_id = EXCLUDED.driver_id,
               booked_at = EXCLUDED.booked_at`,
            params
        );
        inserted += batch.length;
    }
    return inserted;
}

/**
 * Tarih aralığındaki siparişleri döner (driver_id, booked_at)
 * @param {Date} fromDate
 * @param {Date} toDate
 * @returns {Promise<Array<{driverId: string|null, bookedAt: Date}>>}
 */
async function getOrdersInRange(fromDate, toDate) {
    if (!db.isConfigured()) return [];
    const result = await db.query(
        `SELECT driver_id AS "driverId", booked_at AS "bookedAt"
         FROM orders
         WHERE booked_at >= $1 AND booked_at <= $2`,
        [fromDate, toDate]
    );
    return result.rows.map(r => ({
        driverId: r.driverId,
        bookedAt: r.bookedAt
    }));
}

/**
 * Tarih aralığındaki toplam sipariş sayısı ve sürücüsüz (orphaned) sayısı
 */
async function getOrderStatsInRange(fromDate, toDate) {
    if (!db.isConfigured()) return { total: 0, orphaned: 0 };
    const totalRes = await db.query(
        `SELECT COUNT(*)::int AS total FROM orders WHERE booked_at >= $1 AND booked_at <= $2`,
        [fromDate, toDate]
    );
    const orphanRes = await db.query(
        `SELECT COUNT(*)::int AS orphaned FROM orders WHERE booked_at >= $1 AND booked_at <= $2 AND driver_id IS NULL`,
        [fromDate, toDate]
    );
    return {
        total: totalRes.rows[0]?.total || 0,
        orphaned: orphanRes.rows[0]?.orphaned || 0
    };
}

/**
 * Tarih aralığında sürücü bazlı yolculuk sayıları
 * @param {Date} fromDate
 * @param {Date} toDate
 * @returns {Promise<Array<{driverId: string, tripCount: number}>>}
 */
async function getTripCountsByDriver(fromDate, toDate) {
    if (!db.isConfigured()) return [];
    const result = await db.query(
        `SELECT driver_id AS "driverId", COUNT(*)::int AS "tripCount"
         FROM orders
         WHERE booked_at >= $1 AND booked_at <= $2 AND driver_id IS NOT NULL
         GROUP BY driver_id`,
        [fromDate, toDate]
    );
    return result.rows;
}

/**
 * Belirli sürücünün belirli tarihten sonraki yolculuk sayısı
 */
async function getDriverTripCountInRange(driverId, fromDate) {
    if (!db.isConfigured()) return 0;
    const result = await db.query(
        `SELECT COUNT(*)::int AS count
         FROM orders
         WHERE driver_id = $1 AND booked_at >= $2`,
        [driverId, fromDate]
    );
    return result.rows[0]?.count || 0;
}

/**
 * DB'deki en son sipariş tarihi (delta sync başlangıcı için)
 */
async function getLatestBookedAt() {
    if (!db.isConfigured()) return null;
    const result = await db.query(
        `SELECT MAX(booked_at) AS "maxAt" FROM orders`
    );
    const val = result.rows[0]?.maxAt;
    return val ? new Date(val) : null;
}

/**
 * DB'deki sipariş sayısı
 */
async function getOrderCount() {
    if (!db.isConfigured()) return 0;
    const result = await db.query(`SELECT COUNT(*)::int AS count FROM orders`);
    return result.rows[0]?.count || 0;
}

/**
 * CACHE_DAYS'tan eski siparişleri siler
 */
async function pruneOldOrders(cutoffDate) {
    if (!db.isConfigured()) return 0;
    const result = await db.query(
        `DELETE FROM orders WHERE booked_at < $1`,
        [cutoffDate]
    );
    return result.rowCount || 0;
}

/**
 * Tüm siparişleri siler (forceResync için)
 */
async function clearAllOrders() {
    if (!db.isConfigured()) return;
    await db.query('TRUNCATE TABLE orders');
}

module.exports = {
    upsertOrders,
    getOrdersInRange,
    getOrderStatsInRange,
    getTripCountsByDriver,
    getDriverTripCountInRange,
    getLatestBookedAt,
    getOrderCount,
    pruneOldOrders,
    clearAllOrders
};
