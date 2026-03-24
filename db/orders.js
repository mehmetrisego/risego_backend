/**
 * Yolculuk (sipariş) verisi - PostgreSQL CRUD
 * LeaderboardService tarafından kullanılır (park_partner_id = Yandex park UUID)
 */
const db = require('./index');

const BATCH_SIZE = 500;

/**
 * Aynı (id, park_partner_id) birden fazla kez gelirse Postgres
 * "ON CONFLICT DO UPDATE command cannot affect row a second time" verir; tek satırda birleştirir.
 */
function dedupeOrders(orders) {
    const map = new Map();
    for (const o of orders) {
        if (!o || !o.id) continue;
        const key = `${o.id}|${o.parkPartnerId || ''}`;
        map.set(key, o);
    }
    return Array.from(map.values());
}

/**
 * Siparişleri toplu olarak DB'ye yazar (upsert)
 * @param {Array<{id: string, driverId: string|null, bookedAt: Date, parkPartnerId: string}>} orders
 */
async function upsertOrders(orders) {
    if (!db.isConfigured() || !orders.length) return 0;

    const deduped = dedupeOrders(orders);
    let inserted = 0;
    for (let i = 0; i < deduped.length; i += BATCH_SIZE) {
        const batch = deduped.slice(i, i + BATCH_SIZE);
        const values = batch.map((o, idx) => {
            const base = idx * 4;
            return `($${base + 1}, $${base + 2}, $${base + 3}, $${base + 4})`;
        }).join(', ');
        const params = batch.flatMap(o => [
            o.id,
            o.driverId || null,
            o.bookedAt,
            o.parkPartnerId || ''
        ]);

        await db.query(
            `INSERT INTO orders (id, driver_id, booked_at, park_partner_id)
             VALUES ${values}
             ON CONFLICT (id, park_partner_id) DO UPDATE SET
               driver_id = EXCLUDED.driver_id,
               booked_at = EXCLUDED.booked_at`,
            params
        );
        inserted += batch.length;
    }
    return inserted;
}

/**
 * Eski tek-park satırları (park_partner_id boş) birincil parka bağlanır
 */
async function backfillLegacyParkToPrimary(primaryParkId) {
    if (!db.isConfigured() || !primaryParkId) return 0;
    const result = await db.query(
        `UPDATE orders SET park_partner_id = $1
         WHERE park_partner_id = '' OR park_partner_id IS NULL`,
        [primaryParkId]
    );
    return result.rowCount || 0;
}

/**
 * Tarih aralığındaki siparişleri döner
 */
async function getOrdersInRange(fromDate, toDate, parkPartnerId) {
    if (!db.isConfigured()) return [];
    let sql = `SELECT driver_id AS "driverId", booked_at AS "bookedAt"
         FROM orders
         WHERE booked_at >= $1 AND booked_at <= $2`;
    const params = [fromDate, toDate];
    if (parkPartnerId) {
        sql += ` AND park_partner_id = $3`;
        params.push(parkPartnerId);
    }
    const result = await db.query(sql, params);
    return result.rows.map(r => ({
        driverId: r.driverId,
        bookedAt: r.bookedAt
    }));
}

/**
 * Tarih aralığındaki toplam sipariş sayısı ve sürücüsüz (orphaned) sayısı
 */
async function getOrderStatsInRange(fromDate, toDate, parkPartnerId) {
    if (!db.isConfigured()) return { total: 0, orphaned: 0 };
    let where = `booked_at >= $1 AND booked_at <= $2`;
    const params = [fromDate, toDate];
    if (parkPartnerId) {
        where += ` AND park_partner_id = $3`;
        params.push(parkPartnerId);
    }
    const totalRes = await db.query(
        `SELECT COUNT(*)::int AS total FROM orders WHERE ${where}`,
        params
    );
    const orphanRes = await db.query(
        `SELECT COUNT(*)::int AS orphaned FROM orders WHERE ${where} AND driver_id IS NULL`,
        params
    );
    return {
        total: totalRes.rows[0]?.total || 0,
        orphaned: orphanRes.rows[0]?.orphaned || 0
    };
}

/**
 * Tarih aralığında sürücü bazlı yolculuk sayıları
 */
async function getTripCountsByDriver(fromDate, toDate, parkPartnerId) {
    if (!db.isConfigured()) return [];
    const params = [fromDate, toDate];
    let where = `booked_at >= $1 AND booked_at <= $2 AND driver_id IS NOT NULL`;
    if (parkPartnerId) {
        where += ` AND park_partner_id = $3`;
        params.push(parkPartnerId);
    }
    const result = await db.query(
        `SELECT driver_id AS "driverId", COUNT(*)::int AS "tripCount"
         FROM orders
         WHERE ${where}
         GROUP BY driver_id`,
        params
    );
    return result.rows;
}

/**
 * Belirli sürücünün belirli tarihten sonraki yolculuk sayısı (park içinde)
 */
async function getDriverTripCountInRange(driverId, fromDate, parkPartnerId) {
    if (!db.isConfigured()) return 0;
    const params = [driverId, fromDate];
    let where = `driver_id = $1 AND booked_at >= $2`;
    if (parkPartnerId) {
        where += ` AND park_partner_id = $3`;
        params.push(parkPartnerId);
    }
    const result = await db.query(
        `SELECT COUNT(*)::int AS count
         FROM orders
         WHERE ${where}`,
        params
    );
    return result.rows[0]?.count || 0;
}

/**
 * Belirli park için en son sipariş tarihi (delta sync)
 */
async function getLatestBookedAtForPark(parkPartnerId) {
    if (!db.isConfigured() || !parkPartnerId) return null;
    const result = await db.query(
        `SELECT MAX(booked_at) AS "maxAt" FROM orders WHERE park_partner_id = $1`,
        [parkPartnerId]
    );
    const val = result.rows[0]?.maxAt;
    return val ? new Date(val) : null;
}

/**
 * Belirli park için sipariş sayısı
 */
async function getOrderCountForPark(parkPartnerId) {
    if (!db.isConfigured() || !parkPartnerId) return 0;
    const result = await db.query(
        `SELECT COUNT(*)::int AS count FROM orders WHERE park_partner_id = $1`,
        [parkPartnerId]
    );
    return result.rows[0]?.count || 0;
}

/**
 * DB'deki en son sipariş tarihi (tüm parklar)
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
 * CACHE_DAYS'tan eski siparişleri siler (tüm parklar)
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
    backfillLegacyParkToPrimary,
    getOrdersInRange,
    getOrderStatsInRange,
    getTripCountsByDriver,
    getDriverTripCountInRange,
    getLatestBookedAt,
    getLatestBookedAtForPark,
    getOrderCount,
    getOrderCountForPark,
    pruneOldOrders,
    clearAllOrders
};
