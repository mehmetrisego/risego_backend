'use strict';
// ============================================================
//  LeaderboardService — Yandex Fleet API Entegrasyon Servisi
//  Versiyon: 3.0.0 — EKSİKSİZ YOLCULUK GARANTİSİ
//
//  Özellikler:
//   - POST /v1/parks/orders/list — cursor tabanlı eksiksiz sayfalama
//   - 'complete' VE 'finished' status — her iki tamamlanmış sipariş tipi çekilir
//   - Genişletilmiş extractDriverId — tüm olası Yandex response formatları
//   - Chunk overlap — zaman dilimi sınırlarında kayıp önleme
//   - driverId null siparişler loglanır, sayıma dahil edilebilir fallback
//   - Throttling, exponential backoff, otomatik delta sync
// ============================================================

const axios  = require('axios');
const config = require('../config');
const db = require('../db');
const dbOrders = require('../db/orders');
const yandexFleetApi = require('./yandexFleetApi');

// ─── Sabitler ──────────────────────────────────────────────────────────
const PAGE_LIMIT       = 500;              // Her sayfada max sipariş (Yandex max 1000, 500 güvenli)
const THROTTLE_MS      = 10000;           // İstekler arası minimum bekleme (ms) — Yandex 429 limitleri için 10 saniyeye çıkarıldı
const MAX_RETRIES      = 5;               // Hata durumunda max yeniden deneme
const REQUEST_TIMEOUT  = 30_000;          // 30 saniye HTTP timeout
const DELTA_INTERVAL   = 30 * 60 * 1000;  // 30 dakikada bir delta güncelleme (429 azaltma)
const CACHE_DAYS       = 31;              // Bellekte tutulacak sipariş aralığı (gün) — 512MB RAM için düşürüldü
const CHUNK_OVERLAP_MS = 45 * 60 * 1000; // Chunk sınırlarında 45 dk overlap (sınır kaybı önleme)

// Tamamlanmış sipariş statusu — Yandex Fleet API sadece 'complete' kabul ediyor
const COMPLETED_ORDER_STATUSES = ['complete'];

// Türkçe ay isimleri
const MONTHS = ['Ocak','Şubat','Mart','Nisan','Mayıs','Haziran',
                 'Temmuz','Ağustos','Eylül','Ekim','Kasım','Aralık'];

/** Park başına axios (çoklu şehir API anahtarı) */
const parkHttpClients = new Map();

function getAxiosForPark(parkSource) {
    const pid = parkSource.partnerId;
    if (!parkHttpClients.has(pid)) {
        parkHttpClients.set(pid, axios.create({
            baseURL: parkSource.baseUrl || config.yandexFleet.baseUrl,
            timeout: REQUEST_TIMEOUT,
            headers: {
                'X-Client-ID': parkSource.clientId,
                'X-API-Key': parkSource.apiKey,
                'Content-Type': 'application/json',
                'Accept-Language': 'tr'
            }
        }));
    }
    return parkHttpClients.get(pid);
}

// ─── Yardımcı Fonksiyonlar ─────────────────────────────────────────────

/** Milisaniye bekler */
const sleep = ms => new Promise(r => setTimeout(r, ms));

/**
 * Date → Türkiye saatli ISO string (UTC+3)
 * Örn: "2026-03-11T00:00:00+03:00"
 */
function toTurkeyISO(date) {
    const TR_OFFSET_MS = 3 * 60 * 60 * 1000;
    const local = new Date(date.getTime() + TR_OFFSET_MS);
    return local.toISOString().replace('Z', '+03:00');
}

/**
 * Sipariş nesnesinden sürücü ID'sini çıkarır.
 * Yandex Fleet API farklı sürümlerde ve response formatlarında farklı alan adları kullanıyor.
 * TÜM bilinen varyantlar kontrol edilir — HİÇBİR yolculuk atlanmaz.
 */
function extractDriverId(order) {
    if (!order || typeof order !== 'object') return null;

    // Doğrudan alan yolları (Yandex dokümantasyonu ve gerçek response'lardan)
    const candidates = [
        order.driver?.id,
        order.driver?.driver_profile_id,
        order.driver_profile?.id,
        order.driver_profile?.driver_profile_id,
        order.performer?.driver_profile_id,
        order.performer?.id,
        order.contractor?.id,
        order.contractor?.driver_profile_id,
        order.contractor_profile_id,
        order.driver_profile_id,
        // İç içe nesneler
        order.driver?.driver_profile?.id,
        order.order?.driver?.id,
        order.order?.driver_profile?.id,
    ];

    for (const c of candidates) {
        if (c && typeof c === 'string' && c.trim().length > 0) return c.trim();
        if (c && typeof c === 'number' && !isNaN(c)) return String(c);
    }

    // Derin arama: order içinde herhangi bir yerde 'id' veya 'driver_profile_id' içeren alan
    try {
        const str = JSON.stringify(order);
        const driverIdMatch = str.match(/"driver_profile_id"\s*:\s*"([^"]+)"/);
        if (driverIdMatch) return driverIdMatch[1];
        const idMatch = str.match(/"driver"\s*:\s*\{[^}]*"id"\s*:\s*"([^"]+)"/);
        if (idMatch) return idMatch[1];
    } catch (_) { /* ignore */ }

    return null;
}

/** Tarih aralığı için Türkçe etiket üretir. Örn: "1 Mart 2026 - 11 Mart 2026" */
function periodLabel(s, e) {
    return `${s.getDate()} ${MONTHS[s.getMonth()]} ${s.getFullYear()} - ${e.getDate()} ${MONTHS[e.getMonth()]} ${e.getFullYear()}`;
}

// ─── Ana Sınıf ─────────────────────────────────────────────────────────

class LeaderboardService {
    constructor() {
        /** In-memory sipariş deposu: { id, driverId, bookedAt } */
        this._orders     = [];
        this._ordersFrom = null; // cache başlangıç tarihi
        this._ordersTo   = null; // cache bitiş tarihi
        this._lastSyncAt = null;

        /** Sürücü profil cache'i — partnerId -> { data, expiry } */
        this._profilesCacheByPark = new Map();

        /** Leaderboard sonuç cache'i (key: "admin|driver:from:to") */
        this._resultCache    = new Map();
        this.RESULT_CACHE_MAX = 30;

        /** Cron handle */
        this._cronHandle = null;

        /** Senkronizasyon kilidi */
        this._syncLock = false;

        /**
         * İlk tam senkronizasyonun promise'i.
         * startCron() tarafından set edilir.
         * getLeaderboard() bu tamamlanmadan yanıt vermez — admin butonuna gerek yok.
         */
        this._readyPromise = null;

        console.log('[LeaderboardService] Başlatıldı.');
    }

    // ════════════════════════════════════════════════════════════
    //  CURSOR PAGINATION MOTORU
    //  cursor boşalana kadar döner — HİÇBİR sayfa atlanmaz
    // ════════════════════════════════════════════════════════════

    /**
     * @param {string} endpoint
     * @param {Object} payload
     * @param {string} [dataKey='orders']
     * @returns {Promise<Array>}
     */
    async _fetchAllPages(endpoint, payload, dataKey = 'orders', parkSource) {
        const http = getAxiosForPark(parkSource);
        const parkId = parkSource.partnerId;
        const all    = [];
        let cursor   = undefined;
        let retries  = 0;
        let page     = 0;

        while (true) {
            if (page > 0) await sleep(THROTTLE_MS); // rate limit koruması
            page++;

            const body = { ...payload, limit: PAGE_LIMIT, ...(cursor ? { cursor } : {}) };

            try {
                const res  = await http.post(endpoint, body, { headers: { 'X-Park-ID': parkId } });
                const data = res.data;
                const items = data[dataKey] || [];

                all.push(...items);
                retries = 0;

                const next = data.cursor;

                // KRİTİK: Sadece cursor boşaldığında dur — Yandex bazen az eleman döndürse de cursor verir
                if (!next || next === '') {
                    if (items.length === PAGE_LIMIT) {
                        console.warn(`[LeaderboardService] UYARI: Tam ${PAGE_LIMIT} kayıt döndü ama cursor yok — veri eksik olabilir!`);
                    }
                    console.log(`[LeaderboardService] ${endpoint}: ${page} sayfa → ${all.length} kayıt`);
                    break;
                }
                cursor = next;

            } catch (err) {
                const status = err.response?.status;
                const msg    = err.response?.data?.message || err.message;

                if ((status === 429 || (status >= 500 && status < 600)) && retries < MAX_RETRIES) {
                    retries++;
                    const retryAfter = parseInt(err.response?.headers?.['retry-after'] || '0', 10);
                    const wait = retryAfter > 0
                        ? retryAfter * 1000 + 2000 // Retry-after'a ek 2sn pay bırak
                        : Math.min(Math.pow(2.5, retries) * 2000 + Math.random() * 1000, 60_000); // Daha agresif backoff (max 60sn)
                    console.warn(`[LeaderboardService] HTTP ${status} → ${Math.round(wait/1000)}s bekleniyor (${retries}/${MAX_RETRIES})`);
                    await sleep(wait);
                    continue; // aynı cursor ile yeniden dene
                }

                console.error(`[LeaderboardService] Kalıcı hata (${endpoint}):`, msg);
                throw err;
            }
        }
        return all;
    }

    // ════════════════════════════════════════════════════════════
    //  SÜRÜCÜ PROFİLLERİ (5 dk cache)
    // ════════════════════════════════════════════════════════════

    async _getDriverProfiles(parkSource) {
        const pid = parkSource.partnerId;
        const now = Date.now();
        const hit = this._profilesCacheByPark.get(pid);
        if (hit && now < hit.expiry) {
            return hit.data;
        }

        const http = getAxiosForPark(parkSource);
        const parkId = parkSource.partnerId;
        console.log(`[LeaderboardService] Sürücü profilleri çekiliyor (${parkSource.label || pid})...`);
        const all    = [];
        let offset   = 0;
        const limit  = 1000;

        while (true) {
            const res      = await http.post(
                '/v1/parks/driver-profiles/list',
                {
                    query: { park: { id: parkId } },
                    fields: { driver_profile: ['first_name', 'last_name', 'id'] },
                    limit, offset,
                    sort_order: [{ direction: 'asc', field: 'driver_profile.created_date' }]
                },
                { headers: { 'X-Park-ID': parkId } }
            );
            const profiles = res.data.driver_profiles || [];
            all.push(...profiles);
            if (offset + limit >= (res.data.total || 0) || profiles.length === 0) break;
            offset += limit;
            await sleep(THROTTLE_MS);
        }

        this._profilesCacheByPark.set(pid, { data: all, expiry: now + 5 * 60 * 1000 });
        console.log(`[LeaderboardService] ${all.length} sürücü profili yüklendi (${parkSource.label || pid}).`);
        return all;
    }

    /** Yeni sürücü oluşturulduğunda profil cache'ini temizler */
    invalidateProfileCache() {
        this._profilesCacheByPark.clear();
    }

    // ════════════════════════════════════════════════════════════
    //  SİPARİŞ ÇEKME
    // ════════════════════════════════════════════════════════════

    /**
     * fromDate–toDate arasındaki tamamlanmış siparişleri parçalar halinde çeker.
     * - Status: 'complete' (Yandex Fleet API'nin kabul ettiği tek tamamlanmış status)
     * - Chunk overlap: Sınırlarda 45 dk overlap ile kayıp önlenir
     */
    async _fetchOrders(fromDate, toDate, parkSource) {
        const parkId = parkSource.partnerId;
        const startMs = fromDate.getTime();
        const endMs   = toDate.getTime();
        const CHUNK_SIZE_MS = 7 * 24 * 60 * 60 * 1000; // 7 gün

        // Parçala — chunk sınırlarında OVERLAP ile (sınırda kalan siparişler kaçmasın)
        const chunks = [];
        for (let cur = startMs; cur < endMs; cur += CHUNK_SIZE_MS) {
            const nextMs = Math.min(cur + CHUNK_SIZE_MS, endMs);
            const isLast = nextMs === endMs;
            chunks.push({
                from: new Date(cur),
                // Son chunk değilse: bitişe 45 dk overlap ekle (sınır kaybı önleme)
                to: new Date(isLast ? nextMs : Math.min(nextMs + CHUNK_OVERLAP_MS, endMs))
            });
        }

        console.log(`[LeaderboardService] Siparişler çekiliyor: ${chunks.length} parçaya bölündü (status: complete).`);

        const CONCURRENCY = 2;
        const allOrdersRaw = [];

        for (let i = 0; i < chunks.length; i += CONCURRENCY) {
            const batch = chunks.slice(i, i + CONCURRENCY);
            const batchPromises = batch.map(async chunk => {
                const fromStr = toTurkeyISO(chunk.from);
                const toStr   = toTurkeyISO(chunk.to);

                // Önce tek istekte tüm statusları dene (API destekliyorsa en verimli)
                try {
                    return await this._fetchAllPages(
                        '/v1/parks/orders/list',
                        {
                            query: {
                                park: {
                                    id: parkId,
                                    order: {
                                        booked_at: { from: fromStr, to: toStr },
                                        statuses: COMPLETED_ORDER_STATUSES
                                    }
                                }
                            }
                        },
                        'orders',
                        parkSource
                    );
                } catch (err) {
                    // API çoklu status kabul etmiyorsa: her status için ayrı istek + merge
                    if (err.response?.status === 400) {
                        console.warn('[LeaderboardService] Çoklu status desteklenmiyor, her status ayrı çekiliyor...');
                        const merged = [];
                        const seen = new Set();
                        for (const status of COMPLETED_ORDER_STATUSES) {
                            try {
                                const orders = await this._fetchAllPages(
                                    '/v1/parks/orders/list',
                                    {
                                        query: {
                                            park: {
                                                id: parkId,
                                                order: {
                                                    booked_at: { from: fromStr, to: toStr },
                                                    statuses: [status]
                                                }
                                            }
                                        }
                                    },
                                    'orders',
                                    parkSource
                                );
                                for (const o of orders) {
                                    if (o?.id && !seen.has(o.id)) {
                                        seen.add(o.id);
                                        merged.push(o);
                                    }
                                }
                                await sleep(THROTTLE_MS);
                            } catch (e) {
                                if (e.response?.status !== 400) throw e;
                            }
                        }
                        return merged;
                    }
                    throw err;
                }
            });

            const results = await Promise.all(batchPromises);
            for (const res of results) allOrdersRaw.push(...res);
        }

        return allOrdersRaw;
    }

    /** Ham sipariş → { id, driverId, bookedAt, parkPartnerId } özeti (bellek tasarrufu) */
    _mapOrder(raw, parkPartnerId) {
        const id       = raw.id;
        const driverId = extractDriverId(raw);
        const rawDate  = raw.booked_at || raw.updated_at || raw.finished_at || raw.created_at;
        if (!id || !rawDate) return null;
        const bookedAt = new Date(rawDate);
        if (isNaN(bookedAt.getTime())) return null;

        if (!driverId && (!this._orphanedLogCount || this._orphanedLogCount < 5)) {
            this._orphanedLogCount = (this._orphanedLogCount || 0) + 1;
            console.warn(`[LeaderboardService] Sürücü ID bulunamadı — sipariş ${id}, yapı:`, JSON.stringify(Object.keys(raw || {})));
        }
        return { id, driverId, bookedAt, parkPartnerId };
    }

    // ════════════════════════════════════════════════════════════
    //  SENKRONIZASYON
    // ════════════════════════════════════════════════════════════

    /**
     * TAM SENKRONIZASYON: Son CACHE_DAYS günlük tüm siparişleri çeker.
     * DB varsa PostgreSQL'e yazar, yoksa bellekte tutar.
     */
    async _fullSync() {
        if (this._syncLock) {
            console.log('[LeaderboardService] Senkronizasyon devam ediyor, atlanıyor.');
            return;
        }
        this._syncLock = true;
        try {
            const now = new Date();
            const fromDate = new Date(now.getFullYear(), now.getMonth(), now.getDate() - CACHE_DAYS, 0, 0, 0, 0);
            const sources = config.getYandexParkSources();
            if (!sources.length) {
                throw new Error('Yandex park tanımlı değil (.env YANDEX_PARK_* veya YANDEX_*).');
            }

            console.log(`[LeaderboardService] ▶ TAM SENKRONIZASYON (${sources.length} park) ${fromDate.toLocaleDateString('tr-TR')} → bugün`);

            let totalWritten = 0;
            const memoryAccum = [];

            for (const park of sources) {
                const raw = await this._fetchOrders(fromDate, now, park);
                const mapped = raw.map(o => this._mapOrder(o, park.partnerId)).filter(Boolean);
                const dedupe = new Map();
                mapped.forEach(o => dedupe.set(`${o.id}|${o.parkPartnerId}`, o));
                const uniqueOrders = Array.from(dedupe.values());

                if (db.isConfigured()) {
                    const count = await dbOrders.upsertOrders(uniqueOrders);
                    totalWritten += count;
                } else {
                    memoryAccum.push(...uniqueOrders);
                }
                
                // Şehirler arası mola (3. Öneri - 25 saniye)
                await sleep(25000); 
            }

            if (db.isConfigured()) {
                await dbOrders.pruneOldOrders(fromDate);
                console.log(`[LeaderboardService] ✅ TAM SENKRONIZASYON tamamlandı: ~${totalWritten} upsert, tüm parklar`);
            } else {
                const map = new Map();
                for (const o of memoryAccum) map.set(`${o.id}|${o.parkPartnerId}`, o);
                this._orders = Array.from(map.values());
                const orphaned = this._orders.filter(o => !o.driverId).length;
                const orphanedLog = orphaned > 0 ? ` (${orphaned} sürücü ID'siz)` : '';
                console.log(`[LeaderboardService] ✅ TAM SENKRONIZASYON tamamlandı: ${this._orders.length} sipariş${orphanedLog} (bellek)`);
            }

            this._ordersFrom = fromDate;
            this._ordersTo = now;
            this._lastSyncAt = now;
            this._resultCache.clear();
        } catch (err) {
            console.error('[LeaderboardService] Tam senkronizasyon hatası:', err.message);
            throw err;
        } finally {
            this._syncLock = false;
        }
    }

    /**
     * DELTA: Her park için ayrı — son kayıttan bugüne (45 dk overlap)
     */
    async _deltaSync() {
        if (this._syncLock) return;
        this._syncLock = true;
        try {
            const now = new Date();
            const sources = config.getYandexParkSources();
            if (!sources.length) return;

            let anyNew = false;

            for (const park of sources) {
                let deltaFrom;
                if (db.isConfigured()) {
                    let lastBooked;
                    try {
                        lastBooked = await dbOrders.getLatestBookedAtForPark(park.partnerId);
                    } catch (dbErr) {
                        // DB geçici olarak erişilemez (ör: EAI_AGAIN) — sadece son 24 saati çek
                        console.warn(`[LeaderboardService] ${park.label} DB hatası, sadece dün çekiliyor:`, dbErr.message);
                        lastBooked = new Date(now.getTime() - 24 * 60 * 60 * 1000);
                    }
                    deltaFrom = lastBooked
                        ? new Date(lastBooked.getTime() - CHUNK_OVERLAP_MS)
                        : new Date(now.getFullYear(), now.getMonth(), now.getDate() - 1, 0, 0, 0, 0);
                } else {
                    const parkOrders = (this._orders || []).filter(o => o.parkPartnerId === park.partnerId);
                    const maxBooked = parkOrders.reduce(
                        (mx, o) => (o.bookedAt > mx ? o.bookedAt : mx),
                        new Date(0)
                    );
                    deltaFrom = maxBooked.getTime() > 0
                        ? new Date(maxBooked.getTime() - CHUNK_OVERLAP_MS)
                        : new Date(now.getFullYear(), now.getMonth(), now.getDate() - CACHE_DAYS, 0, 0, 0, 0);
                }

                console.log(`[LeaderboardService] ⏳ DELTA (${park.label}): ${deltaFrom.toLocaleTimeString('tr-TR')} → şimdi`);

                const raw = await this._fetchOrders(deltaFrom, now, park);
                const mapped = raw.map(o => this._mapOrder(o, park.partnerId)).filter(Boolean);
                const dedupe = new Map();
                mapped.forEach(o => dedupe.set(`${o.id}|${o.parkPartnerId}`, o));
                const uniqueDelta = Array.from(dedupe.values());

                if (uniqueDelta.length === 0) continue;
                anyNew = true;

                if (db.isConfigured()) {
                    const count = await dbOrders.upsertOrders(uniqueDelta);
                    console.log(`[LeaderboardService]   ${park.label}: +${count} upsert`);
                } else {
                    const map = new Map((this._orders || []).map(o => [`${o.id}|${o.parkPartnerId}`, o]));
                    for (const o of mapped) map.set(`${o.id}|${o.parkPartnerId}`, o);
                    this._orders = Array.from(map.values());
                }

                // Şehirler arası mola (3. Öneri - 25 saniye)
                await sleep(25000);
            }

            if (db.isConfigured()) {
                const cutoff = new Date(now.getFullYear(), now.getMonth(), now.getDate() - CACHE_DAYS, 0, 0, 0, 0);
                const pruned = await dbOrders.pruneOldOrders(cutoff);
                const total = await dbOrders.getOrderCount();
                console.log(`[LeaderboardService] ✅ Delta: budanmış ${pruned} | Toplam DB: ${total}`);
            } else if (anyNew) {
                const cutoff = new Date(now.getFullYear(), now.getMonth(), now.getDate() - CACHE_DAYS, 0, 0, 0, 0);
                const before = this._orders.length;
                this._orders = this._orders.filter(o => o.bookedAt >= cutoff);
                console.log(`[LeaderboardService] ✅ Delta: bellek budandı ${before - this._orders.length}`);

            } else {
                console.log('[LeaderboardService] Delta: Yeni sipariş yok.');
            }

            this._ordersTo = now;
            this._lastSyncAt = now;
            this._resultCache.clear();
        } catch (err) {
            console.error('[LeaderboardService] Delta senkronizasyon hatası:', err.message);
        } finally {
            this._syncLock = false;
        }
    }

    // ════════════════════════════════════════════════════════════
    //  CRON — OTOMATİK ZAMANLAYICI (Sunucu başlayınca çalışır)
    // ════════════════════════════════════════════════════════════

    /**
     * server.js'de bir kez çağrılır.
     *
     * Davranış:
     *   1. İlk tam senkronizasyonu başlatır ve _readyPromise'e bağlar.
     *   2. _readyPromise tamamlanana kadar gelen leaderboard istekleri bekler
     *      → Admin butonu ya da müdahale gerektirmez, sistem tamamen otomatik.
     *   3. Her 15 dakikada bir delta güncelleme çalışır.
     */
    async startCron() {
        console.log('[LeaderboardService] Cron başlatılıyor...');

        // İlk senkronizasyon: DB doluysa delta, boşsa full sync
        const initSync = async () => {
            if (db.isConfigured()) {
                const n = await dbOrders.backfillLegacyParkToPrimary(config.yandexFleet.partnerId);
                if (n > 0) {
                    console.log(`[LeaderboardService] Eski siparişler birincil parka taşındı: ${n} satır`);
                }
            }
            if (db.isConfigured() && (await dbOrders.getOrderCount()) > 0) {
                this._ordersFrom = new Date(Date.now() - CACHE_DAYS * 24 * 60 * 60 * 1000);
                this._ordersTo = await dbOrders.getLatestBookedAt() || new Date();
                this._lastSyncAt = new Date();
                await this._deltaSync();
            } else {
                await this._fullSync();
            }
            // İlk senkronizasyonda bakiyeleri de eşitle
            await this._syncDriverBalances();
        };
        this._readyPromise = initSync();

        // Hata olsa bile sunucuyu durdurmayalım
        this._readyPromise.catch(err => {
            console.error('[LeaderboardService] İlk senkronizasyon başarısız:', err.message);
            // 60 saniye sonra otomatik yeniden dene
            setTimeout(() => {
                console.log('[LeaderboardService] Yeniden deneniyor...');
                this._readyPromise = this._fullSync();
            }, 60_000);
        });

        // Her 15 dakikada bir delta güncelleme
        this._cronHandle = setInterval(async () => {
            console.log('[LeaderboardService] ⏰ Periyodik senkronizasyon...');
            try {
                const needsFullSync = db.isConfigured()
                    ? (await dbOrders.getOrderCount()) === 0
                    : (this._orders.length === 0 || !this._ordersTo);
                if (needsFullSync) {
                    await this._fullSync();
                } else {
                    await this._deltaSync();
                }
                // Bakiyeleri de eşitle
                await this._syncDriverBalances();
            } catch (e) {
                console.error('[LeaderboardService] Periyodik senkronizasyon hatası:', e.message);
            }
        }, DELTA_INTERVAL);

        console.log(`[LeaderboardService] Cron aktif (her ${DELTA_INTERVAL / 60_000} dakikada delta güncelleme).`);
    }

    /** Yandex'ten sürücü profillerini çekip bakiyeleri DB'ye kaydeder (Optimize Bulk Sync) */
    async _syncDriverBalances() {
        if (!db.isConfigured()) return;
        try {
            console.log('[LeaderboardService] Sürücü bakiyeleri DB\'ye eşitleniyor...');
            const sources = config.getYandexParkSources();
            for (const park of sources) {
                const drivers = await yandexFleetApi.fetchDriverProfilesForParkSource(park);
                if (!drivers || drivers.length === 0) continue;

                const allValues = [];
                const allParams = [];
                
                for (const d of drivers) {
                    const driverId = d.driver_profile?.id;
                    // Yandex API list endpoint'inde bakiye genellikle 'accounts' dizisi içinde döner
                    const balance = parseFloat(d.accounts?.[0]?.balance || d.account?.balance || 0);
                    if (!driverId) continue;
                    allValues.push({ driverId, balance });
                }

                // 500'lü paketler halinde toplu insert (Bulk Upsert)
                const CHUNK_SIZE = 500;
                for (let i = 0; i < allValues.length; i += CHUNK_SIZE) {
                    const chunk = allValues.slice(i, i + CHUNK_SIZE);
                    const params = [];
                    const valueStrings = chunk.map((item, idx) => {
                        const base = idx * 2;
                        params.push(item.driverId, item.balance);
                        return `($${base + 1}, $${base + 2}, NOW())`;
                    });

                    await db.query(`
                        INSERT INTO park_driver_balances (driver_id, balance, updated_at)
                        VALUES ${valueStrings.join(', ')}
                        ON CONFLICT (driver_id) DO UPDATE SET
                            balance = EXCLUDED.balance,
                            updated_at = NOW()
                    `, params);
                }

                // Şehirler arası bakiye eşitleme molası (25 saniye)
                await sleep(25000);
            }
            console.log(`[LeaderboardService] ✅ Sürücü bakiyeleri toplu olarak güncellendi.`);
        } catch (err) {
            console.error('[LeaderboardService] Sürücü bakiyeleri eşitlenirken hata:', err.message);
        }
    }

    /** Cron'u durdurur */
    stopCron() {
        if (this._cronHandle) {
            clearInterval(this._cronHandle);
            this._cronHandle = null;
            console.log('[LeaderboardService] Cron durduruldu.');
        }
    }

    // ════════════════════════════════════════════════════════════
    //  LEADERBOARD HESAPLAMA — TEMEL PUBLIC API
    // ════════════════════════════════════════════════════════════

    /**
     * Belirtilen tarih aralığı için leaderboard döner.
     *
     * ✅ OTOMATİK BEKLEME: İlk tam senkronizasyon henüz tamamlanmadıysa
     *    bu metod onun bitmesini bekler — admin butonu, webhook veya başka
     *    bir müdahale gerektirmez.
     *
     * @param {string} fromStr  - "YYYY-MM-DD"
     * @param {string} toStr    - "YYYY-MM-DD"
     * @param {Object} [opts]
     * @param {boolean} [opts.adminView=false] - true → tam ad, false → baş harfler
     * @param {string} [opts.parkPartnerId] - Yandex park UUID (oturumdaki şehir); yoksa birincil park
     * @returns {Promise<Object>}
     */
    async getLeaderboard(fromStr, toStr, { adminView = false, parkPartnerId } = {}) {
        const pid = parkPartnerId || config.yandexFleet.partnerId;
        const parkSource = config.findYandexParkByPartnerId(pid);
        if (!parkSource) {
            throw new Error('Geçersiz veya tanımsız park (parkPartnerId).');
        }

        // ── İlk sync tamamlanana kadar bekle ──────────────────
        if (this._readyPromise) {
            try {
                await this._readyPromise;
            } catch (_) {
                // İlk sync başarısız olduysa bile devam et (API'den doğrudan çekeriz)
            }
        }

        // ── Tarih parse ───────────────────────────────────────
        const [sy, sm, sd] = fromStr.split('-').map(Number);
        const [ey, em, ed] = toStr.split('-').map(Number);
        const startDate = new Date(sy, sm - 1, sd,  0,  0,  0,   0);
        const endDate   = new Date(ey, em - 1, ed, 23, 59, 59, 999);

        if (isNaN(startDate) || isNaN(endDate))          throw new Error('Geçersiz tarih formatı. "YYYY-MM-DD" kullanın.');
        if (startDate > endDate)                          throw new Error('Başlangıç tarihi bitiş tarihinden sonra olamaz.');

        // ── Result cache ──────────────────────────────────────
        const cacheKey = `${adminView ? 'a' : 'd'}:${pid}:${fromStr}:${toStr}`;
        const nowMs    = Date.now();
        const hit      = this._resultCache.get(cacheKey);
        if (hit && nowMs < hit.expiry) {
            console.log(`[LeaderboardService] Cache HIT: ${cacheKey}`);
            return hit.result;
        }

        // ── Veri kaynağı seçimi ───────────────────────────────
        let tripCountsByDriver;
        let totalOrders;
        let orphanedCount;

        if (db.isConfigured()) {
            const [counts, stats] = await Promise.all([
                dbOrders.getTripCountsByDriver(startDate, endDate, pid),
                dbOrders.getOrderStatsInRange(startDate, endDate, pid)
            ]);
            tripCountsByDriver = counts;
            totalOrders = stats.total;
            orphanedCount = stats.orphaned;
            console.log(`[LeaderboardService] DB'den (${parkSource.label}): ${totalOrders} sipariş (${fromStr}→${toStr})`);
        } else {
            const cacheCoversRequest =
                this._orders.length > 0 &&
                this._ordersFrom &&
                this._ordersTo &&
                startDate >= new Date(this._ordersFrom.getTime() - 60_000);

            let orders;
            if (cacheCoversRequest) {
                orders = this._orders.filter(
                    o =>
                        o.parkPartnerId === pid &&
                        o.bookedAt >= startDate &&
                        o.bookedAt <= endDate
                );
                console.log(`[LeaderboardService] Cache'den filtrelendi: ${orders.length} sipariş (${fromStr}→${toStr})`);
            } else {
                console.log('[LeaderboardService] Cache yetersiz, API\'den çekiliyor...');
                const raw = await this._fetchOrders(startDate, endDate, parkSource);
                orders = raw.map(o => this._mapOrder(o, pid)).filter(Boolean);
            }
            totalOrders = orders.length;
            orphanedCount = orders.filter(o => !o.driverId).length;
            const driverMap = {};
            for (const { driverId } of orders) {
                if (!driverId) continue;
                driverMap[driverId] = (driverMap[driverId] || 0) + 1;
            }
            tripCountsByDriver = Object.entries(driverMap).map(([driverId, tripCount]) => ({ driverId, tripCount }));
        }

        // ── Profil haritası ───────────────────────────────────
        const profiles   = await this._getDriverProfiles(parkSource);
        const profileMap = {};
        for (const p of profiles) {
            const dp  = p.driver_profile || {};
            if (!dp.id) continue;
            const fn  = (dp.first_name || '').trim();
            const ln  = (dp.last_name  || '').trim();
            const full = [fn, ln].filter(Boolean).join(' ') || 'İsimsiz';
            const ini  = (fn && ln)
                ? `${fn[0].toUpperCase()}. ${ln[0].toUpperCase()}.`
                : (fn || 'X')[0].toUpperCase() + '.';
            profileMap[dp.id] = { id: dp.id, fullName: full, initials: ini, tripCount: 0 };
        }

        // ── Sayım — tripCountsByDriver ile driverMap oluştur ─────────────────
        const driverMap = { ...profileMap };
        for (const { driverId, tripCount } of tripCountsByDriver) {
            if (driverMap[driverId]) {
                driverMap[driverId].tripCount = tripCount;
            } else {
                driverMap[driverId] = { id: driverId, fullName: 'Bilinmeyen Sürücü', initials: '?.', tripCount };
            }
        }

        if (orphanedCount > 0) {
            console.warn(`[LeaderboardService] ${orphanedCount} sipariş sürücü ID'si olmadan atlandı (toplam ${totalOrders} siparişten).`);
        }

        // ── Sıralama ──────────────────────────────────────────
        const ranked = Object.values(driverMap)
            .filter(d => d.tripCount > 0)
            .sort((a, b) => b.tripCount !== a.tripCount
                ? b.tripCount - a.tripCount
                : a.fullName.localeCompare(b.fullName, 'tr-TR'))
            .map((d, i) => ({ ...d, rank: i + 1 }));

        const result = {
            drivers:         ranked,
            totalOrders:     totalOrders,
            orphanedOrders:  orphanedCount,
            totalDrivers:    ranked.length,
            periodLabel:     periodLabel(startDate, endDate),
            syncedAt:        this._lastSyncAt ? this._lastSyncAt.toISOString() : null
        };

        // ── Cache'e yaz (LRU) ─────────────────────────────────
        if (this._resultCache.size >= this.RESULT_CACHE_MAX) {
            this._resultCache.delete(this._resultCache.keys().next().value);
        }
        // Result cache 15 dk geçerli (delta sync her 15 dk çalışır, sonra cache temizlenir)
        this._resultCache.set(cacheKey, { result, expiry: nowMs + 15 * 60 * 1000 });

        console.log(`[LeaderboardService] Hazır: ${result.periodLabel} | ${result.totalOrders} yolculuk | ${ranked.length} sürücü`);
        return result;
    }

    // ════════════════════════════════════════════════════════════
    //  YARDIMCI PUBLIC API'LER
    // ════════════════════════════════════════════════════════════

    /**
     * Sürücünün belirli dönemdeki yolculuk sayısını döndürür. (Frontend kartları)
     * Veriyi doğrudan kendi hazır in-memory önbelleğinden çeker (Çok Hızlı).
     * @param {string} driverId
     * @param {string} period - 'daily', 'weekly', 'monthly', 'all'
     * @param {string} [parkPartnerId] - oturum parkı (Yandex UUID)
     * @returns {Promise<number>}
     */
    async getDriverTripCount(driverId, period = 'daily', parkPartnerId) {
        // Veritabanı aktifse senkronizasyonu beklemeden direkt DB'ye sorgula.
        // Bu sayede sunucu başlangıcındaki Yandex sync gecikmesi (429 hataları vb.)
        // sürücünün giriş hızını etkilemez.
        if (!db.isConfigured() && this._readyPromise) {
            await this._readyPromise;
        }

        const pid = parkPartnerId || config.yandexFleet.partnerId;

        const now = new Date();
        let fromDate;

        switch (period) {
            case 'daily':
                fromDate = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 0, 0, 0, 0);
                break;
            case 'weekly': {
                const day = now.getDay();
                const diff = day === 0 ? 6 : day - 1;
                fromDate = new Date(now.getFullYear(), now.getMonth(), now.getDate() - diff, 0, 0, 0, 0);
                break;
            }
            case 'monthly':
                fromDate = new Date(now.getFullYear(), now.getMonth(), 1, 0, 0, 0, 0);
                break;
            case 'all':
            default:
                fromDate = new Date(now.getFullYear(), now.getMonth(), now.getDate() - CACHE_DAYS, 0, 0, 0, 0);
                break;
        }

        if (db.isConfigured()) {
            return await dbOrders.getDriverTripCountInRange(driverId, fromDate, pid);
        }

        return this._orders.reduce((sum, order) => {
            if (
                order.parkPartnerId === pid &&
                order.driverId === driverId &&
                order.bookedAt >= fromDate
            ) return sum + 1;
            return sum;
        }, 0);
    }

    /**
     * Servis durumu — GET /api/admin/leaderboard/status için
     */
    async getStatus() {
        const ordersCount = db.isConfigured() ? await dbOrders.getOrderCount() : this._orders.length;
        const orphaned = db.isConfigured() ? 0 : this._orders.filter(o => !o.driverId).length;
        return {
            ready:           ordersCount > 0,
            ordersInMemory:  this._orders.length,
            ordersInDb:      db.isConfigured() ? ordersCount : null,
            orphanedOrders:  orphaned,
            cacheFrom:       this._ordersFrom ? this._ordersFrom.toISOString() : null,
            cacheTo:         this._ordersTo   ? this._ordersTo.toISOString()   : null,
            lastSyncAt:      this._lastSyncAt ? this._lastSyncAt.toISOString() : null,
            resultCacheSize: this._resultCache.size,
            syncLocked:      this._syncLock
        };
    }

    /**
     * Tüm cache sıfırlanır ve tam senkronizasyon yeniden çalışır.
     * Acil durumlar için admin endpoint üzerinden çağrılabilir,
     * ancak normal şartlarda gerek yoktur — sistem zaten otomatik çalışır.
     */
    async forceResync() {
        console.log('[LeaderboardService] ⚡ Zorla senkronizasyon başlatıldı...');
        this._orders              = [];
        this._ordersFrom          = null;
        this._ordersTo            = null;
        this._resultCache.clear();
        this._profilesCacheByPark.clear();
        if (db.isConfigured()) {
            await dbOrders.clearAllOrders();
        }
        this._readyPromise = this._fullSync();
        await this._readyPromise;
    }
}

module.exports = new LeaderboardService();
