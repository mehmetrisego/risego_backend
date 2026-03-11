'use strict';
// ============================================================
//  LeaderboardService — Yandex Fleet API Entegrasyon Servisi
//  Versiyon: 2.1.0
//
//  Özellikler:
//   - POST /v1/parks/orders/list — cursor tabanlı eksiksiz sayfalama
//   - Cursor boşalana kadar tarar — HİÇBİR yolculuk atlamaz
//   - Throttling: istekler arası minimum bekleme (rate limit koruması)
//   - Exponential backoff: 429/5xx hatalarında otomatik yeniden deneme
//   - Otomatik: Sunucu başlayınca tam senkronizasyon, 15 dakikada bir delta
//   - İlk sync tamamlanmadan gelen istekler otomatik olarak beklenir
//   - .env'den: YANDEX_API_KEY, YANDEX_PARTNER_ID — asla koda yazılmaz
//   - Hem 'complete' hem 'finished' status desteği
// ============================================================

const axios  = require('axios');
const config = require('../config');

// ─── Sabitler ──────────────────────────────────────────────────────────
const BASE_URL     = config.yandexFleet.baseUrl;    // .env → YANDEX_BASE_URL
const PARK_ID      = config.yandexFleet.partnerId;  // .env → YANDEX_PARTNER_ID
const CLIENT_ID    = config.yandexFleet.clientId;   // .env → YANDEX_CLIENT_ID
const API_KEY      = config.yandexFleet.apiKey;     // .env → YANDEX_API_KEY

const PAGE_LIMIT       = 500;              // Her sayfada max sipariş (Yandex max 1000, 500 güvenli)
const THROTTLE_MS      = 200;             // İstekler arası minimum bekleme (ms)
const MAX_RETRIES      = 5;               // Hata durumunda max yeniden deneme
const REQUEST_TIMEOUT  = 30_000;          // 30 saniye HTTP timeout
const DELTA_INTERVAL   = 15 * 60 * 1000; // 15 dakikada bir delta güncelleme
const CACHE_DAYS       = 60;             // Bellekte tutulacak sipariş aralığı (gün)

// Türkçe ay isimleri
const MONTHS = ['Ocak','Şubat','Mart','Nisan','Mayıs','Haziran',
                 'Temmuz','Ağustos','Eylül','Ekim','Kasım','Aralık'];

// ─── HTTP İstemcisi ────────────────────────────────────────────────────
const http = axios.create({
    baseURL: BASE_URL,
    timeout: REQUEST_TIMEOUT,
    headers: {
        'X-Client-ID':    CLIENT_ID,
        'X-API-Key':      API_KEY,
        'Content-Type':   'application/json',
        'Accept-Language':'tr'
    }
});

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
 * Sipariş nesnesinden sürücü ID'sini güvenli biçimde çıkarır.
 * Yandex Fleet farklı API sürümlerinde farklı alan adları kullanabiliyor.
 */
function extractDriverId(order) {
    return (
        order?.driver?.id                          ||
        order?.driver_profile?.id                  ||
        order?.driver_profile?.driver_profile_id   ||
        null
    );
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

        /** Sürücü profil cache'i (5 dk TTL) */
        this._profilesCache       = null;
        this._profilesCacheExpiry = 0;

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
    async _fetchAllPages(endpoint, payload, dataKey = 'orders') {
        const all    = [];
        let cursor   = undefined;
        let retries  = 0;
        let page     = 0;

        while (true) {
            if (page > 0) await sleep(THROTTLE_MS); // rate limit koruması
            page++;

            const body = { ...payload, limit: PAGE_LIMIT, ...(cursor ? { cursor } : {}) };

            try {
                const res  = await http.post(endpoint, body, { headers: { 'X-Park-ID': PARK_ID } });
                const data = res.data;
                const items = data[dataKey] || [];

                all.push(...items);
                retries = 0;

                const next = data.cursor;

                // ✅ KRİTİK: items.length < limit kontrolü YAPILMAZ.
                // Yandex filtreli sorgularda az eleman döndürse de cursor verebiliyor.
                // Sadece cursor boşaldığında dur.
                if (!next || next === '') {
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
                        ? retryAfter * 1000
                        : Math.min(Math.pow(2, retries) * 1500 + Math.random() * 500, 20_000);
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

    async _getDriverProfiles() {
        const now = Date.now();
        if (this._profilesCache && now < this._profilesCacheExpiry) {
            return this._profilesCache;
        }

        console.log('[LeaderboardService] Sürücü profilleri çekiliyor...');
        const all    = [];
        let offset   = 0;
        const limit  = 1000;

        while (true) {
            const res      = await http.post(
                '/v1/parks/driver-profiles/list',
                {
                    query: { park: { id: PARK_ID } },
                    fields: { driver_profile: ['first_name', 'last_name', 'id'] },
                    limit, offset,
                    sort_order: [{ direction: 'asc', field: 'driver_profile.created_date' }]
                },
                { headers: { 'X-Park-ID': PARK_ID } }
            );
            const profiles = res.data.driver_profiles || [];
            all.push(...profiles);
            if (offset + limit >= (res.data.total || 0) || profiles.length === 0) break;
            offset += limit;
            await sleep(THROTTLE_MS);
        }

        this._profilesCache       = all;
        this._profilesCacheExpiry = now + 5 * 60 * 1000;
        console.log(`[LeaderboardService] ${all.length} sürücü profili yüklendi.`);
        return all;
    }

    /** Yeni sürücü oluşturulduğunda profil cache'ini temizler */
    invalidateProfileCache() {
        this._profilesCache       = null;
        this._profilesCacheExpiry = 0;
    }

    // ════════════════════════════════════════════════════════════
    //  SİPARİŞ ÇEKME
    // ════════════════════════════════════════════════════════════

    /**
     * fromDate–toDate arasındaki tamamlanmış siparişleri parçalar halinde çeker.
     * Büyük aralıklarda (örn 60 gün) 429 hatalarını önlemek için 7 günlük 'Time-Slıcıng' uygular.
     */
    async _fetchOrders(fromDate, toDate) {
        const startMs = fromDate.getTime();
        const endMs   = toDate.getTime();
        const CHUNK_SIZE_MS = 7 * 24 * 60 * 60 * 1000; // 7 gün

        // Parçala
        const chunks = [];
        for (let cur = startMs; cur < endMs; cur += CHUNK_SIZE_MS) {
            const nextMs = Math.min(cur + CHUNK_SIZE_MS, endMs);
            const isLast = nextMs === endMs;
            chunks.push({
                from: new Date(cur),
                to: new Date(isLast ? nextMs : nextMs - 1)
            });
        }

        console.log(`[LeaderboardService] Siparişler çekiliyor: ${chunks.length} parçaya bölündü.`);

        const CONCURRENCY = 2; // Yandex'i yormamak için 2 eşzamanlı istek
        const allOrders = [];

        for (let i = 0; i < chunks.length; i += CONCURRENCY) {
            const batch = chunks.slice(i, i + CONCURRENCY);
            const batchPromises = batch.map(async chunk => {
                const fromStr = toTurkeyISO(chunk.from);
                const toStr   = toTurkeyISO(chunk.to);
                
                return this._fetchAllPages(
                    '/v1/parks/orders/list',
                    {
                        query: {
                            park: {
                                id: PARK_ID,
                                order: {
                                    booked_at: { from: fromStr, to: toStr },
                                    statuses: ['complete']
                                }
                            }
                        }
                    },
                    'orders'
                );
            });

            const results = await Promise.all(batchPromises);
            for (const res of results) allOrders.push(...res);
        }

        return allOrders;
    }

    /** Ham sipariş → { id, driverId, bookedAt } özeti (bellek tasarrufu) */
    _mapOrder(raw) {
        const id       = raw.id;
        const driverId = extractDriverId(raw);
        const rawDate  = raw.booked_at || raw.updated_at || raw.finished_at;
        if (!id || !rawDate) return null;
        const bookedAt = new Date(rawDate);
        if (isNaN(bookedAt.getTime())) return null;
        return { id, driverId, bookedAt };
    }

    // ════════════════════════════════════════════════════════════
    //  SENKRONIZASYON
    // ════════════════════════════════════════════════════════════

    /**
     * TAM SENKRONIZASYON: Son CACHE_DAYS günlük tüm siparişleri çeker.
     * Sunucu başlayışında çalışır; sonuç ready olana kadar getLeaderboard() bekler.
     */
    async _fullSync() {
        if (this._syncLock) {
            console.log('[LeaderboardService] Senkronizasyon devam ediyor, atlanıyor.');
            return;
        }
        this._syncLock = true;
        try {
            const now      = new Date();
            const fromDate = new Date(now.getFullYear(), now.getMonth(), now.getDate() - CACHE_DAYS, 0, 0, 0, 0);

            console.log(`[LeaderboardService] ▶ TAM SENKRONIZASYON başladı (${fromDate.toLocaleDateString('tr-TR')} → bugün)`);

            const raw    = await this._fetchOrders(fromDate, now);
            const mapped = raw.map(o => this._mapOrder(o)).filter(Boolean);

            const map = new Map();
            mapped.forEach(o => map.set(o.id, o));

            this._orders     = Array.from(map.values());
            this._ordersFrom = fromDate;
            this._ordersTo   = now;
            this._lastSyncAt = now;
            this._resultCache.clear();

            console.log(`[LeaderboardService] ✅ TAM SENKRONIZASYON tamamlandı: ${this._orders.length} sipariş`);
        } catch (err) {
            console.error('[LeaderboardService] Tam senkronizasyon hatası:', err.message);
            throw err; // _readyPromise'i reddettirmek için fırlat
        } finally {
            this._syncLock = false;
        }
    }

    /**
     * DELTA SENKRONIZASYON: Son sync'ten bu yana gelen yeni siparişleri ekler.
     * Yandex'in yazma gecikmesini (30s) absorbe etmek için 3 dk geriden başlar.
     */
    async _deltaSync() {
        if (this._syncLock) return;
        this._syncLock = true;
        try {
            const now       = new Date();
            const deltaFrom = new Date(this._ordersTo.getTime() - 3 * 60 * 1000); // 3 dk overlap

            console.log(`[LeaderboardService] ⏳ DELTA: ${deltaFrom.toLocaleTimeString('tr-TR')} → şimdi`);

            const raw    = await this._fetchOrders(deltaFrom, now);
            const mapped = raw.map(o => this._mapOrder(o)).filter(Boolean);

            if (mapped.length > 0) {
                const map = new Map(this._orders.map(o => [o.id, o]));
                let added = 0;
                for (const o of mapped) {
                    if (!map.has(o.id)) { map.set(o.id, o); added++; }
                }
                // Eski kayıtları belekten buda
                const cutoff = new Date(now.getFullYear(), now.getMonth(), now.getDate() - CACHE_DAYS, 0, 0, 0, 0);
                const before = map.size;
                for (const [id, o] of map) { if (o.bookedAt < cutoff) map.delete(id); }
                const pruned = before - map.size;

                this._orders = Array.from(map.values());
                console.log(`[LeaderboardService] ✅ Delta: +${added} yeni, -${pruned} budandı. Toplam: ${this._orders.length}`);
            } else {
                console.log('[LeaderboardService] Delta: Yeni sipariş yok.');
            }

            this._ordersTo   = now;
            this._lastSyncAt = now;
            this._resultCache.clear(); // son veriler için cache temizle
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

        // İlk tam senkronizasyon — promise'i kaydet, getLeaderboard() bunu bekleyecek
        this._readyPromise = this._fullSync();

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
                if (this._orders.length === 0 || !this._ordersTo) {
                    await this._fullSync();
                } else {
                    await this._deltaSync();
                }
            } catch (e) {
                console.error('[LeaderboardService] Periyodik senkronizasyon hatası:', e.message);
            }
        }, DELTA_INTERVAL);

        console.log(`[LeaderboardService] Cron aktif (her ${DELTA_INTERVAL / 60_000} dakikada delta güncelleme).`);
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
     * @returns {Promise<Object>}
     */
    async getLeaderboard(fromStr, toStr, { adminView = false } = {}) {
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
        const cacheKey = `${adminView ? 'a' : 'd'}:${fromStr}:${toStr}`;
        const nowMs    = Date.now();
        const hit      = this._resultCache.get(cacheKey);
        if (hit && nowMs < hit.expiry) {
            console.log(`[LeaderboardService] Cache HIT: ${cacheKey}`);
            return hit.result;
        }

        // ── Veri kaynağı seçimi ───────────────────────────────
        let orders;
        const cacheCoversRequest =
            this._orders.length > 0 &&
            this._ordersFrom     &&
            this._ordersTo       &&
            startDate >= new Date(this._ordersFrom.getTime() - 60_000); // 1 dk tolerans

        if (cacheCoversRequest) {
            orders = this._orders.filter(o => o.bookedAt >= startDate && o.bookedAt <= endDate);
            console.log(`[LeaderboardService] Cache'den filtrelendi: ${orders.length} sipariş (${fromStr}→${toStr})`);
        } else {
            // Cache yoksa (örn. ilk sync başarısız) doğrudan API'den çek
            console.log('[LeaderboardService] Cache yetersiz, API\'den çekiliyor...');
            const raw = await this._fetchOrders(startDate, endDate);
            orders = raw.map(o => this._mapOrder(o)).filter(Boolean);
        }

        // ── Profil haritası ───────────────────────────────────
        const profiles   = await this._getDriverProfiles();
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

        // ── Sayım ─────────────────────────────────────────────
        const driverMap = { ...profileMap };
        for (const { driverId } of orders) {
            if (!driverId) continue;
            if (driverMap[driverId]) {
                driverMap[driverId].tripCount++;
            } else {
                driverMap[driverId] = { id: driverId, fullName: 'Bilinmeyen Sürücü', initials: '?.', tripCount: 1 };
            }
        }

        // ── Sıralama ──────────────────────────────────────────
        const ranked = Object.values(driverMap)
            .filter(d => d.tripCount > 0)
            .sort((a, b) => b.tripCount !== a.tripCount
                ? b.tripCount - a.tripCount
                : a.fullName.localeCompare(b.fullName, 'tr-TR'))
            .map((d, i) => ({ ...d, rank: i + 1 }));

        const result = {
            drivers:      ranked,
            totalOrders:  orders.length,
            totalDrivers: Object.keys(driverMap).length,
            periodLabel:  periodLabel(startDate, endDate),
            syncedAt:     this._lastSyncAt ? this._lastSyncAt.toISOString() : null
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
     * Servis durumu — GET /api/admin/leaderboard/status için
     */
    getStatus() {
        return {
            ready:           this._orders.length > 0,
            ordersInMemory:  this._orders.length,
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
        this._profilesCache       = null;
        this._profilesCacheExpiry = 0;
        this._readyPromise        = this._fullSync();
        await this._readyPromise;
    }
}

module.exports = new LeaderboardService();
