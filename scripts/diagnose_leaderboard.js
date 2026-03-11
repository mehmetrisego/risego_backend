/**
 * ================================================================
 * RiseGo — Leaderboard Tanılama Scripti (Diagnosis Script)
 * ================================================================
 * Amacı: Yandex Fleet API'den doğrudan ham veri çekip,
 * backend'in /api/leaderboard endpoint'i ile karşılaştırarak
 * hangi sürücülerde kaç yolculuk eksik olduğunu raporlar.
 *
 * Kullanım:
 *   cd C:\Users\youtu\Desktop\risego\risego_backend-main
 *   node scripts/diagnose_leaderboard.js
 *
 * Not: Backend sunucusunun çalışıyor OLMASI GEREKMİYOR.
 * Sadece .env dosyasının mevcut olması gerekir.
 * ================================================================
 */

'use strict';
process.env.TZ = 'Europe/Istanbul';
require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });

const axios = require('axios');

// ──────────────────────────────────────────────
// Config
// ──────────────────────────────────────────────
const PARK_ID = process.env.YANDEX_PARK_ID || process.env.YANDEX_PARTNER_ID;
const CLIENT_ID = process.env.YANDEX_CLIENT_ID;
const API_KEY = process.env.YANDEX_API_KEY;
const BASE_URL = process.env.YANDEX_BASE_URL || 'https://fleet-api.taxi.yandex.net';

// Backend URL — sunucu çalışıyorsa endpoint karşılaştırması da yapılır
const BACKEND_URL = process.env.BACKEND_URL || 'https://risegobackend-production-bf6d.up.railway.app';

if (!PARK_ID || !CLIENT_ID || !API_KEY) {
    console.error('\n[HATA] .env dosyasında YANDEX_PARK_ID/PARTNER_ID, YANDEX_CLIENT_ID ve YANDEX_API_KEY tanımlı olmalı!\n');
    process.exit(1);
}

const http = axios.create({
    baseURL: BASE_URL,
    timeout: 60000,
    headers: {
        'X-Client-ID': CLIENT_ID,
        'X-API-Key': API_KEY,
        'Content-Type': 'application/json',
        'Accept-Language': 'tr'
    }
});

// ──────────────────────────────────────────────
// Yardımcı: 10-günlük dönem hesaplayıcı
// ──────────────────────────────────────────────
function get10DayPeriod() {
    const now = new Date();
    const year = now.getFullYear();
    const month = now.getMonth();
    const day = now.getDate();
    let periodStart, periodEnd;
    if (day <= 10) {
        periodStart = new Date(year, month, 1);
        periodEnd = new Date(year, month, 10, 23, 59, 59, 999);
    } else if (day <= 20) {
        periodStart = new Date(year, month, 11);
        periodEnd = new Date(year, month, 20, 23, 59, 59, 999);
    } else {
        periodStart = new Date(year, month, 21);
        periodEnd = new Date(year, month + 1, 0, 23, 59, 59, 999);
    }
    return {
        from: periodStart.toISOString(),
        to: (periodEnd > now ? now : periodEnd).toISOString(),  // Gelecek tarih kullanma
        start: periodStart,
        end: periodEnd
    };
}

// ──────────────────────────────────────────────
// Yardımcı: Sürücü ID çıkarımı (FIX-5 ile aynı mantık)
// ──────────────────────────────────────────────
function extractDriverId(order) {
    return (
        order.driver?.id ||
        order.driver_profile?.id ||
        order.driver_profile?.driver_profile_id ||
        null
    );
}

// ──────────────────────────────────────────────
// Yardımcı: Cursor tabanlı toplama
// ──────────────────────────────────────────────
async function fetchAllWithCursor(endpoint, payload, pageLimit = 500) {
    const results = [];
    let cursor = undefined;
    let page = 0;

    while (true) {
        page++;
        const body = { ...payload, limit: pageLimit };
        if (cursor) body.cursor = cursor;

        let retries = 0;
        let response;

        while (retries <= 5) {
            try {
                response = await http.post(endpoint, body);
                break;
            } catch (err) {
                const status = err.response?.status;
                const isRetry = status === 429 || (status >= 500) || String(err.message).includes('Limit');
                if (isRetry && retries < 5) {
                    retries++;
                    const wait = Math.min(Math.pow(2, retries) * 1500 + Math.random() * 500, 20000);
                    process.stdout.write(`  [retry ${retries}/5, ${Math.round(wait / 1000)}s] `);
                    await new Promise(r => setTimeout(r, wait));
                    continue;
                }
                throw err;
            }
        }

        const dataKey = Object.keys(response.data).find(k => k !== 'cursor' && Array.isArray(response.data[k]));
        const items = dataKey ? response.data[dataKey] : [];
        results.push(...items);

        const nextCursor = response.data.cursor;
        if (!nextCursor || nextCursor === '') break;
        cursor = nextCursor;

        process.stdout.write('.');
    }

    return results;
}

// ──────────────────────────────────────────────
// Yandex'ten ham sipariş sayılarını çek (tek büyük sorgu — chunk YOK)
// ──────────────────────────────────────────────
async function fetchRawOrdersByDriver(period) {
    console.log(`\n[1/3] Yandex Fleet API'den ham siparişler çekiliyor...`);
    console.log(`      Dönem: ${period.from.slice(0, 10)} → ${period.to.slice(0, 10)}`);
    process.stdout.write('      İlerleme: ');

    const orders = await fetchAllWithCursor('/v1/parks/orders/list', {
        query: {
            park: {
                id: PARK_ID,
                order: {
                    booked_at: { from: period.from, to: period.to },
                    statuses: ['complete']
                }
            }
        }
    });

    console.log(`\n      ✅ Toplam ham sipariş: ${orders.length}`);

    // Sürücü bazlı say
    const countByDriver = {};
    orders.forEach(order => {
        const dId = extractDriverId(order);
        if (dId) countByDriver[dId] = (countByDriver[dId] || 0) + 1;
    });

    return { orders, countByDriver };
}

// ──────────────────────────────────────────────
// Yandex'ten sürücü profillerini çek
// ──────────────────────────────────────────────
async function fetchDriverProfiles() {
    console.log(`\n[2/3] Sürücü profilleri çekiliyor...`);
    const allDrivers = [];
    let offset = 0;
    const limit = 1000;

    while (true) {
        const response = await http.post('/v1/parks/driver-profiles/list', {
            query: { park: { id: PARK_ID } },
            fields: {
                driver_profile: ['first_name', 'last_name', 'id'],
                car: ['number']
            },
            limit,
            offset,
            sort_order: [{ direction: 'asc', field: 'driver_profile.created_date' }]
        });

        const drivers = response.data.driver_profiles || [];
        allDrivers.push(...drivers);
        if (offset + limit >= response.data.total || drivers.length === 0) break;
        offset += limit;
    }

    console.log(`      ✅ Toplam sürücü: ${allDrivers.length}`);
    return allDrivers;
}

// ──────────────────────────────────────────────
// Ana karşılaştırma
// ──────────────────────────────────────────────
async function compareWithBackend(period, rawCountByDriver, profiles) {
    console.log(`\n[3/3] Backend leaderboard karşılaştırması...`);

    // Backend'i bulmaya çalış — sunucu çalışmıyorsa atla
    let backendCountByDriver = null;
    try {
        const lbResponse = await axios.get(
            `${BACKEND_URL}/api/leaderboard?from=${period.from.slice(0, 10)}&to=${period.to.slice(0, 10)}`,
            {
                timeout: 30000,
                headers: {
                    // Sürücü oturumu yoksa admin endpoint yerine ham API kullan
                    'x-admin-token': process.env.ADMIN_TOKEN || ''
                },
                validateStatus: () => true
            }
        );

        if (lbResponse.status === 200 && lbResponse.data?.leaderboard) {
            backendCountByDriver = {};
            lbResponse.data.leaderboard.forEach(d => {
                backendCountByDriver[d.id] = d.tripCount;
            });
            console.log(`      ✅ Backend leaderboard alındı: ${lbResponse.data.leaderboard.length} sürücü`);
        } else {
            console.log(`      ⚠️  Backend leaderboard alınamadı (${lbResponse.status}) — yalnızca ham Yandex verisi raporlanacak`);
        }
    } catch (err) {
        console.log(`      ⚠️  Backend'e bağlanılamadı (${err.message}) — yalnızca ham Yandex verisi raporlanacak`);
    }

    return backendCountByDriver;
}

// ──────────────────────────────────────────────
// Raporu yazdır
// ──────────────────────────────────────────────
function printReport(period, rawCountByDriver, profiles, backendCountByDriver) {
    const nameMap = {};
    profiles.forEach(p => {
        const dp = p.driver_profile || {};
        const name = [dp.first_name, dp.last_name].filter(Boolean).join(' ') || 'İsimsiz';
        const plate = p.car?.number || '-';
        nameMap[dp.id] = { name, plate };
    });

    const rawTotal = Object.values(rawCountByDriver).reduce((s, c) => s + c, 0);
    const allDriverIds = new Set([
        ...Object.keys(rawCountByDriver),
        ...(backendCountByDriver ? Object.keys(backendCountByDriver) : [])
    ]);

    const issues = [];
    allDriverIds.forEach(dId => {
        const rawCount = rawCountByDriver[dId] || 0;
        const backendCount = backendCountByDriver ? (backendCountByDriver[dId] || 0) : null;
        const diff = backendCount !== null ? rawCount - backendCount : null;

        if (diff !== null && diff !== 0) {
            issues.push({ dId, rawCount, backendCount, diff });
        }
    });

    issues.sort((a, b) => Math.abs(b.diff) - Math.abs(a.diff));

    const separator = '─'.repeat(85);

    console.log('\n\n' + '═'.repeat(85));
    console.log('  RiseGo Leaderboard Tanılama Raporu');
    console.log(`  Dönem: ${period.from.slice(0, 10)} → ${period.to.slice(0, 10)}`);
    console.log(`  Oluşturulma: ${new Date().toLocaleString('tr-TR')}`);
    console.log('═'.repeat(85));

    console.log(`\n  📊 ÖZET`);
    console.log(separator);
    console.log(`  Yandex ham toplam sipariş : ${rawTotal}`);
    if (backendCountByDriver !== null) {
        const backendTotal = Object.values(backendCountByDriver).reduce((s, c) => s + c, 0);
        const totalDiff = rawTotal - backendTotal;
        console.log(`  Backend toplam sipariş   : ${backendTotal}`);
        console.log(`  Toplam fark              : ${totalDiff > 0 ? '+' : ''}${totalDiff} ${totalDiff === 0 ? '✅' : '⚠️'}`);
        console.log(`  Sorunlu sürücü sayısı    : ${issues.length} ${issues.length === 0 ? '✅' : '⚠️'}`);
    }

    // Sürücü bazlı durum tablosu
    console.log(`\n  🧑‍✈️  SÜRÜCÜ BAZLI DURUM (Sadece Yandex'te kayıt olan sürücüler)`);
    console.log(separator);

    const allInYandex = Object.entries(rawCountByDriver)
        .sort(([, a], [, b]) => b - a);

    if (backendCountByDriver !== null) {
        console.log(`  ${'Sürücü Adı'.padEnd(28)} ${'Plaka'.padEnd(12)} ${'Yandex'.padStart(7)} ${'Backend'.padStart(8)} ${'Fark'.padStart(6)} Durum`);
        console.log(separator);

        allInYandex.forEach(([dId, rawCount]) => {
            const info = nameMap[dId] || { name: 'Bilinmeyen', plate: '-' };
            const backendCount = backendCountByDriver[dId] || 0;
            const diff = rawCount - backendCount;
            const status = diff === 0 ? '✅' : diff > 0 ? '❌ EKSİK' : '⚠️ FAZLA?';
            console.log(`  ${info.name.padEnd(28)} ${info.plate.padEnd(12)} ${String(rawCount).padStart(7)} ${String(backendCount).padStart(8)} ${(diff > 0 ? '+' + diff : String(diff)).padStart(6)} ${status}`);
        });
    } else {
        console.log(`  ${'Sürücü Adı'.padEnd(28)} ${'Plaka'.padEnd(12)} ${'Yandex Sayısı'.padStart(14)}`);
        console.log(separator);
        allInYandex.forEach(([dId, rawCount]) => {
            const info = nameMap[dId] || { name: 'Bilinmeyen', plate: '-' };
            console.log(`  ${info.name.padEnd(28)} ${info.plate.padEnd(12)} ${String(rawCount).padStart(14)}`);
        });
    }

    if (issues.length > 0) {
        console.log(`\n  ❌  SORUNLU SÜRÜCÜLER (Fark > 0)`);
        console.log(separator);
        issues.forEach(({ dId, rawCount, backendCount, diff }) => {
            const info = nameMap[dId] || { name: 'Bilinmeyen', plate: '-' };
            console.log(`  ${info.name} (${info.plate}) — Yandex: ${rawCount}, Backend: ${backendCount}, Kayıp: ${diff}`);
        });
    } else if (backendCountByDriver !== null) {
        console.log(`\n  ✅  Tüm sürücüler için yolculuk sayıları eşleşiyor!`);
    }

    console.log('\n' + '═'.repeat(85) + '\n');
}

// ──────────────────────────────────────────────
// Entry point
// ──────────────────────────────────────────────
(async () => {
    console.log('\n╔══════════════════════════════════════════╗');
    console.log('║  RiseGo Leaderboard Tanılama Başlıyor   ║');
    console.log('╚══════════════════════════════════════════╝');

    const period = get10DayPeriod();
    console.log(`\n  Park ID  : ${PARK_ID}`);
    console.log(`  Dönem    : ${period.from.slice(0, 10)} → ${period.to.slice(0, 10)}`);
    console.log(`  Backend  : ${BACKEND_URL}`);

    try {
        const { countByDriver: rawCountByDriver } = await fetchRawOrdersByDriver(period);
        const profiles = await fetchDriverProfiles();
        const backendCountByDriver = await compareWithBackend(period, rawCountByDriver, profiles);

        printReport(period, rawCountByDriver, profiles, backendCountByDriver);

    } catch (err) {
        console.error('\n[HATA]', err.message);
        if (err.response) {
            console.error('  API Yanıtı:', JSON.stringify(err.response.data, null, 2));
        }
        process.exit(1);
    }
})();
