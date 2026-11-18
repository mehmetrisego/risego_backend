require('dotenv').config({ quiet: true });

const config = require('../config');
const db = require('../db');
const yandexFleetApi = require('../services/yandexFleetApi');

const BATCH_SIZE = 50;
// 0 = başarı gelene kadar sınırsız deneme. Tek seferlik bakım scriptinde
// varsayılan budur; pozitif SYNC_MAX_ATTEMPTS ile sınırlandırılabilir.
const configuredMaxAttempts = Number(process.env.SYNC_MAX_ATTEMPTS || 0);
// Park seviyesi tekrar sayısı: genuine hata için sonlu (eskiden Infinity idi → sonsuz döngü riski).
const MAX_ATTEMPTS = configuredMaxAttempts > 0 ? Math.floor(configuredMaxAttempts) : 4;
// Tek sayfa (offset) için azami 429 denemesi; limit dolunca o sayfa atlanır, sonraki parka geçilir.
const PAGE_MAX_ATTEMPTS = Math.max(1, Number(process.env.SYNC_PAGE_MAX_ATTEMPTS || 8));
const RATE_LIMIT_DELAY_MS = Math.max(
    60 * 1000,
    Number(process.env.SYNC_RATE_LIMIT_DELAY_MS || 5 * 60 * 1000)
);
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

function retryDelayMs(error, attempt) {
    const raw = error.response?.headers?.['retry-after'];
    const seconds = Number(raw);
    if (Number.isFinite(seconds) && seconds >= 0) {
        return Math.min(Math.max(seconds * 1000, 1000), RATE_LIMIT_DELAY_MS);
    }

    const retryDate = Date.parse(raw);
    if (raw && Number.isFinite(retryDate)) {
        return Math.min(Math.max(retryDate - Date.now(), 1000), RATE_LIMIT_DELAY_MS);
    }

    if (error.response?.status === 429 || String(error.message).includes('429')) {
        return RATE_LIMIT_DELAY_MS;
    }
    return Math.min(30_000 * (2 ** (attempt - 1)), RATE_LIMIT_DELAY_MS);
}

async function fetchProfilesWithRetry(park, onPageComplete, onPageSkip) {
    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
        try {
            return await yandexFleetApi.fetchDriverProfilesForParkSource(park, {
                includeAccount: false,
                // Yalnızca aktif çalışan sürücüleri çek. Mevcut DB kayıtları
                // silinmediği için geçmiş kullanıcı verileri korunur.
                workStatuses: ['working'],
                pageRetryDelayMs: RATE_LIMIT_DELAY_MS,
                maxPageAttempts: PAGE_MAX_ATTEMPTS,
                onPageComplete: async page => {
                    console.log(
                        `[DriverProfileSync] ${park.label}: sayfa tamamlandı ` +
                        `(offset=${page.offset}, alınan=${page.received}, toplam=${page.total})`
                    );
                    await onPageComplete(page);
                },
                onPageRetry: ({ offset, attempt: pageAttempt, delayMs }) => {
                    console.warn(
                        `[DriverProfileSync] ${park.label}: offset=${offset} sayfası 429 aldı ` +
                        `(deneme ${pageAttempt}); ${Math.ceil(delayMs / 1000)} saniye sonra yalnızca bu sayfa yeniden denenecek.`
                    );
                },
                onPageSkip: info => {
                    if (typeof onPageSkip === 'function') onPageSkip(info);
                }
            });
        } catch (error) {
            if (attempt === MAX_ATTEMPTS) throw error;
            const delayMs = retryDelayMs(error, attempt);
            const attemptLabel = Number.isFinite(MAX_ATTEMPTS) ? `${attempt}/${MAX_ATTEMPTS}` : `${attempt}/∞`;
            console.warn(
                `[DriverProfileSync] ${park.label}: deneme ${attemptLabel} başarısız ` +
                `(${error.response?.status || error.message}); ${Math.ceil(delayMs / 1000)} saniye beklenecek.`
            );
            await sleep(delayMs);
        }
    }
    return [];
}

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
             (driver_id, phone, first_name, last_name, park_partner_id,
              car_id, car_number, car_name, created_at, updated_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, NOW(), NOW())
         ON CONFLICT (driver_id) DO UPDATE SET
             phone = EXCLUDED.phone,
             first_name = EXCLUDED.first_name,
             last_name = EXCLUDED.last_name,
             park_partner_id = EXCLUDED.park_partner_id,
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
            row.carId,
            row.carNumber,
            row.carName
        ]
    );
}

async function syncPark(park) {
    console.log(`[DriverProfileSync] ${park.label}: Yandex profilleri alınıyor...`);
    let profileCount = 0;
    let upserted = 0;
    let skipped = 0;
    let skippedPages = 0;
    const skippedOffsets = [];

    await fetchProfilesWithRetry(park, async ({ profiles, offset }) => {
        profileCount += profiles.length;
        const rows = profiles.map(profile => profileRow(profile, park.partnerId)).filter(Boolean);
        skipped += profiles.length - rows.length;

        for (let index = 0; index < rows.length; index += BATCH_SIZE) {
            const batch = rows.slice(index, index + BATCH_SIZE);
            const results = await Promise.allSettled(batch.map(upsertProfile));
            for (const result of results) {
                if (result.status === 'fulfilled') upserted++;
                else skipped++;
            }
        }
        console.log(
            `[DriverProfileSync] ${park.label}: offset=${offset} Railway'e yazıldı ` +
            `(toplam yazılan=${upserted}, atlanan=${skipped})`
        );
    }, ({ offset, attempts }) => {
        skippedPages++;
        skippedOffsets.push(offset);
        console.warn(
            `[DriverProfileSync] ${park.label}: offset=${offset} ${attempts} denemede alınamadı ` +
            `— SAYFA ATLANDI (sonraki tura bırakıldı).`
        );
    });

    const countResult = await db.query(
        'SELECT COUNT(*)::int AS count FROM driver_profiles WHERE park_partner_id = $1',
        [park.partnerId]
    );
    console.log(
        `[DriverProfileSync] ${park.label}: Yandex=${profileCount}, ` +
        `yazılan=${upserted}, atlanan=${skipped}, atlanan_sayfa=${skippedPages}` +
        `${skippedPages ? ` (offsetler: ${skippedOffsets.join(', ')})` : ''}, DB=${countResult.rows[0].count}`
    );
    return { profiles: profileCount, upserted, skipped, skippedPages };
}

async function main() {
    if (!db.isConfigured()) throw new Error('DATABASE_URL/DATABASE_PUBLIC_URL tanımlı değil.');
    if (!(await db.testConnection())) throw new Error('PostgreSQL bağlantısı kurulamadı.');

    const requestedParkIds = String(process.env.SYNC_PARK_IDS || '')
        .split(',')
        .map(value => value.trim())
        .filter(Boolean);
    const allParks = config.getYandexParkSources();
    const parks = requestedParkIds.length
        ? allParks.filter(park => requestedParkIds.includes(park.partnerId))
        : allParks;
    if (requestedParkIds.length && parks.length !== requestedParkIds.length) {
        throw new Error('SYNC_PARK_IDS içinde bilinmeyen park kimliği var.');
    }
    const totals = { profiles: 0, upserted: 0, skipped: 0, skippedPages: 0, failedParks: 0 };
    console.log(`[DriverProfileSync] ${parks.length} park için tam senkronizasyon başlıyor.`);

    for (const park of parks) {
        try {
            const result = await syncPark(park);
            totals.profiles += result.profiles;
            totals.upserted += result.upserted;
            totals.skipped += result.skipped;
            totals.skippedPages += result.skippedPages || 0;
        } catch (error) {
            totals.failedParks++;
            console.error(
                `[DriverProfileSync] ${park.label}: BAŞARISIZ ` +
                `(${error.response?.status || error.message})`
            );
        }
        await sleep(3000);
    }

    const finalCount = await db.query('SELECT COUNT(*)::int AS count FROM driver_profiles');
    console.log(`[DriverProfileSync] Bitti: ${JSON.stringify({ ...totals, dbTotal: finalCount.rows[0].count })}`);
    if (totals.failedParks > 0) process.exitCode = 1;
}

main()
    .catch(error => {
        console.error('[DriverProfileSync] Kritik hata:', error.message);
        process.exitCode = 1;
    })
    .finally(async () => {
        await db.closePool().catch(() => {});
    });
