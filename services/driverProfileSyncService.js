const config = require('../config');
const db = require('../db');
const yandexFleetApi = require('./yandexFleetApi');

const PAGE_SIZE = 1000;
const DB_BATCH_SIZE = 50;
const RATE_LIMIT_DELAY_MS = Math.max(60_000, Number(process.env.DRIVER_SYNC_RETRY_MS || 300_000));
const DELTA_INITIAL_LOOKBACK_MS = Math.max(
    60 * 60 * 1000,
    Number(process.env.DRIVER_SYNC_INITIAL_LOOKBACK_MS || 48 * 60 * 60 * 1000)
);
const RECONCILIATION_PAGES_PER_NIGHT = Math.max(
    1,
    Number(process.env.DRIVER_SYNC_RECONCILIATION_PAGES || 10)
);

function profileRow(profile, parkPartnerId) {
    const driver = profile.driver_profile || profile;
    const driverId = driver.id || driver.driver_profile_id;
    const phone = Array.isArray(driver.phones) && driver.phones.length
        ? String(driver.phones[0]).replace(/\D/g, '')
        : null;
    if (!driverId || !phone) return null;

    const car = profile.car || {};
    return {
        driverId,
        phone,
        firstName: String(driver.first_name || '').trim(),
        lastName: String(driver.last_name || '').trim(),
        parkPartnerId,
        workStatus: driver.work_status || 'working',
        sourceUpdatedAt: profile.updated_at || null,
        carId: car.id || null,
        carNumber: car.number || null,
        carName: car.number
            ? `${car.brand || ''} ${car.model || ''} (${car.year || ''}) - Plaka: ${car.number}`
            : 'Araç atanmamış'
    };
}

async function upsertProfile(row) {
    await db.query(
        `INSERT INTO driver_profiles
             (driver_id, phone, first_name, last_name, park_partner_id, work_status,
              source_updated_at, car_id, car_number, car_name, created_at, updated_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, NOW(), NOW())
         ON CONFLICT (driver_id) DO UPDATE SET
             phone = EXCLUDED.phone,
             first_name = EXCLUDED.first_name,
             last_name = EXCLUDED.last_name,
             park_partner_id = EXCLUDED.park_partner_id,
             work_status = EXCLUDED.work_status,
             source_updated_at = EXCLUDED.source_updated_at,
             car_id = EXCLUDED.car_id,
             car_number = EXCLUDED.car_number,
             car_name = EXCLUDED.car_name,
             updated_at = NOW()`,
        [
            row.driverId,
            row.phone,
            row.firstName,
            row.lastName,
            row.parkPartnerId,
            row.workStatus,
            row.sourceUpdatedAt,
            row.carId,
            row.carNumber,
            row.carName
        ]
    );
}

async function upsertPage(profiles, parkPartnerId) {
    const rows = profiles.map(profile => profileRow(profile, parkPartnerId)).filter(Boolean);
    let upserted = 0;
    let skipped = profiles.length - rows.length;

    for (let index = 0; index < rows.length; index += DB_BATCH_SIZE) {
        const batch = rows.slice(index, index + DB_BATCH_SIZE);
        const results = await Promise.allSettled(batch.map(upsertProfile));
        for (const result of results) {
            if (result.status === 'fulfilled') upserted++;
            else skipped++;
        }
    }
    return { upserted, skipped };
}

async function getState(parkPartnerId) {
    const result = await db.query(
        `INSERT INTO driver_profile_sync_state (park_partner_id)
         VALUES ($1)
         ON CONFLICT (park_partner_id) DO UPDATE SET park_partner_id = EXCLUDED.park_partner_id
         RETURNING *`,
        [parkPartnerId]
    );
    return result.rows[0];
}

async function saveError(parkPartnerId, error) {
    await db.query(
        `UPDATE driver_profile_sync_state
         SET last_error = $2, updated_at = NOW()
         WHERE park_partner_id = $1`,
        [parkPartnerId, String(error.response?.data?.message || error.message).slice(0, 1000)]
    ).catch(() => {});
}

async function syncDeltaForPark(park, deadlineAt) {
    const state = await getState(park.partnerId);
    const deltaTo = new Date();
    const savedFrom = state.delta_synced_through
        ? new Date(state.delta_synced_through).getTime() - 60 * 60 * 1000
        : deltaTo.getTime() - DELTA_INITIAL_LOOKBACK_MS;
    const deltaFrom = new Date(savedFrom);
    let complete = false;
    let upserted = 0;
    let skipped = 0;

    console.log(
        `[DriverProfileSync] ${park.label}: delta ${deltaFrom.toISOString()} → ${deltaTo.toISOString()}`
    );

    try {
        await yandexFleetApi.fetchDriverProfilesForParkSource(park, {
            includeAccount: false,
            updatedFrom: deltaFrom.toISOString(),
            updatedTo: deltaTo.toISOString(),
            pageRetryDelayMs: RATE_LIMIT_DELAY_MS,
            maxPageAttempts: Infinity,
            deadlineAt,
            onPageComplete: async page => {
                const result = await upsertPage(page.profiles, park.partnerId);
                upserted += result.upserted;
                skipped += result.skipped;
                complete = page.received === 0 || page.offset + PAGE_SIZE >= page.total;
                console.log(
                    `[DriverProfileSync] ${park.label}: delta offset=${page.offset}, ` +
                    `yazılan=${upserted}, atlanan=${skipped}`
                );
            },
            onPageRetry: ({ offset, delayMs }) => {
                console.warn(
                    `[DriverProfileSync] ${park.label}: delta offset=${offset} 429; ` +
                    `${Math.ceil(delayMs / 1000)} saniye sonra yeniden denenecek.`
                );
            }
        });

        if (!complete) throw new Error('Delta senkronizasyonu bakım süresi dolmadan tamamlanamadı.');
        await db.query(
            `UPDATE driver_profile_sync_state
             SET delta_synced_through = $2, last_error = NULL, updated_at = NOW()
             WHERE park_partner_id = $1`,
            [park.partnerId, deltaTo]
        );
        return { park: park.label, upserted, skipped, complete: true };
    } catch (error) {
        await saveError(park.partnerId, error);
        console.error(`[DriverProfileSync] ${park.label}: delta başarısız:`, error.message);
        return { park: park.label, upserted, skipped, complete: false, error: error.message };
    }
}

async function reconcilePark(park, deadlineAt) {
    const state = await getState(park.partnerId);
    const startOffset = Math.max(0, Number(state.reconciliation_offset || 0));
    let nextOffset = startOffset;
    let reachedEnd = false;
    let upserted = 0;
    let skipped = 0;

    console.log(`[DriverProfileSync] ${park.label}: tam denetim offset=${startOffset} noktasından devam ediyor.`);
    try {
        await yandexFleetApi.fetchDriverProfilesForParkSource(park, {
            includeAccount: false,
            workStatuses: ['working'],
            startOffset,
            maxPages: RECONCILIATION_PAGES_PER_NIGHT,
            pageRetryDelayMs: RATE_LIMIT_DELAY_MS,
            maxPageAttempts: Infinity,
            deadlineAt,
            onPageComplete: async page => {
                const result = await upsertPage(page.profiles, park.partnerId);
                upserted += result.upserted;
                skipped += result.skipped;
                reachedEnd = page.received === 0 || page.offset + PAGE_SIZE >= page.total;
                nextOffset = reachedEnd ? 0 : page.offset + PAGE_SIZE;
                await db.query(
                    `UPDATE driver_profile_sync_state
                     SET reconciliation_offset = $2,
                         last_full_sync_at = CASE WHEN $2 = 0 THEN NOW() ELSE last_full_sync_at END,
                         last_error = NULL,
                         updated_at = NOW()
                     WHERE park_partner_id = $1`,
                    [park.partnerId, nextOffset]
                );
                console.log(
                    `[DriverProfileSync] ${park.label}: denetim offset=${page.offset}, ` +
                    `sonraki=${nextOffset}, yazılan=${upserted}, atlanan=${skipped}`
                );
            },
            onPageRetry: ({ offset, delayMs }) => {
                console.warn(
                    `[DriverProfileSync] ${park.label}: denetim offset=${offset} 429; ` +
                    `${Math.ceil(delayMs / 1000)} saniye sonra yeniden denenecek.`
                );
            }
        });
        return { park: park.label, upserted, skipped, reachedEnd, nextOffset };
    } catch (error) {
        await saveError(park.partnerId, error);
        console.error(`[DriverProfileSync] ${park.label}: tam denetim durdu:`, error.message);
        return { park: park.label, upserted, skipped, reachedEnd: false, nextOffset, error: error.message };
    }
}

async function syncDeltas({ deadlineAt }) {
    if (!db.isConfigured()) throw new Error('Sürücü senkronizasyonu için veritabanı yapılandırılmamış.');
    const parks = config.getYandexParkSources();
    const results = [];
    // Tüm parkları aynı anda başlatmak Yandex profil endpointinde 429 dalgası
    // oluşturuyordu. Global throttle'a ek olarak parkları sıralı çalıştır.
    for (const park of parks) {
        if (deadlineAt && Date.now() >= deadlineAt) break;
        results.push(await syncDeltaForPark(park, deadlineAt));
    }
    return results;
}

async function reconcile({ deadlineAt }) {
    if (!db.isConfigured()) throw new Error('Sürücü senkronizasyonu için veritabanı yapılandırılmamış.');
    const parks = config.getYandexParkSources();
    const results = [];
    for (const park of parks) {
        if (deadlineAt && Date.now() >= deadlineAt) break;
        results.push(await reconcilePark(park, deadlineAt));
    }
    return results;
}

module.exports = {
    syncDeltas,
    reconcile,
    _test: { profileRow }
};
