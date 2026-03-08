const axios = require('axios');
const crypto = require('crypto');
const config = require('../config');

// Rusça renk isimlerini Türkçe'ye çevir
const COLOR_MAP = {
    'Желтый': 'Sarı',
    'Белый': 'Beyaz',
    'Черный': 'Siyah',
    'Серый': 'Gri',
    'Серебряный': 'Gümüş',
    'Красный': 'Kırmızı',
    'Синий': 'Mavi',
    'Голубой': 'Açık Mavi',
    'Зеленый': 'Yeşil',
    'Коричневый': 'Kahverengi',
    'Оранжевый': 'Turuncu',
    'Бежевый': 'Bej',
    'Фиолетовый': 'Mor',
    'Розовый': 'Pembe',
    'Бордовый': 'Bordo',
    'Золотой': 'Altın',
    'Вишнёвый': 'Vişne',
    'Тёмно-синий': 'Koyu Mavi',
    'Тёмно-зелёный': 'Koyu Yeşil'
};

function translateColor(color) {
    return COLOR_MAP[color] || color;
}

class YandexFleetApi {
    constructor() {
        this.baseUrl = config.yandexFleet.baseUrl;
        this.parkId = config.yandexFleet.partnerId;

        // ✅ OPT-1: Tek bir axios instance — bağlantı havuzu (keep-alive) ve header tekrarını önler
        this.httpClient = axios.create({
            baseURL: this.baseUrl,
            timeout: 30000, // ✅ OPT-2: 30s timeout — asılı kalan istekler sunucuyu dondurmasın
            headers: {
                'X-Client-ID': config.yandexFleet.clientId,
                'X-API-Key': config.yandexFleet.apiKey,
                'Content-Type': 'application/json',
                'Accept-Language': 'tr'
            }
        });

        // ✅ OPT-3: Sürücü profilleri için 5 dakikalık in-memory cache
        // Her leaderboard veya yetkilendirme isteği bunu kullanır, tekrar çekmez
        this._profilesCache = null;
        this._profilesCacheExpiry = 0;
        this._profilesPending = null;
        this.PROFILES_TTL = 5 * 60 * 1000; // 5 dakika

        // Standart 10 günlük leaderboard cache'leri
        this._leaderboardCache = null;
        this._leaderboardCacheKey = null;
        this._leaderboardExpiry = 0;
        this._leaderboardPending = null;

        this._adminLeaderboardCache = null;
        this._adminLeaderboardCacheKey = null;
        this._adminLeaderboardExpiry = 0;
        this._adminLeaderboardPending = null;

        this._adminLeaderboardPrevCache = null;
        this._adminLeaderboardPrevCacheKey = null;
        this._adminLeaderboardPrevExpiry = 0;
        this._adminLeaderboardPrevPending = null;

        // ✅ OPT-8: Özel tarih aralığı LRU cache (5 dk TTL, max 20 giriş)
        // Aynı from+to sorgusu 5 dk içinde tekrar gelirse aninda döner
        this._customRangeCache = new Map(); // key -> { result, expiry, pending }
        this.CUSTOM_RANGE_TTL = 5 * 60 * 1000; // 5 dakika
        this.CUSTOM_RANGE_MAX = 20; // En fazla 20 farklı sorgu sakla

        // 1 Ay geriye dönük tüm siparişleri tutacak olan in-memory cache
        this._lastMonthOrdersCache = null;
        this._lastMonthFrom = null;
        this._lastMonthTo = null;
        this._lastMonthPending = null;
    }

    /**
     * ✅ OPT-3: Merkezi, cache'li sürücü profil çekici
     * Her çağrıda API yerine cache kullanır — leaderboard için kritik
     * Paralel çağrılar için promise deduplication (tek istek, N bekleyen)
     */
    async _getCachedDriverProfiles() {
        const now = Date.now();
        if (this._profilesCache && now < this._profilesCacheExpiry) {
            return this._profilesCache;
        }
        if (this._profilesPending) return this._profilesPending;

        this._profilesPending = this._fetchDriverProfilesFromAPI()
            .then(profiles => {
                this._profilesCache = profiles;
                this._profilesCacheExpiry = Date.now() + this.PROFILES_TTL;
                return profiles;
            })
            .finally(() => { this._profilesPending = null; });

        return this._profilesPending;
    }

    /**
     * Sürücü profillerini Yandex API'sinden çeker (offset pagination)
     * POST /v1/parks/driver-profiles/list
     */
    async _fetchDriverProfilesFromAPI() {
        const allDrivers = [];
        let offset = 0;
        const limit = 1000;
        let hasMore = true;

        while (hasMore) {
            try {
                const response = await this.httpClient.post(
                    '/v1/parks/driver-profiles/list',
                    {
                        query: {
                            park: { id: this.parkId }
                        },
                        fields: {
                            account: ['balance'],
                            car: ['brand', 'model', 'number', 'year', 'color', 'id'],
                            driver_profile: [
                                'first_name',
                                'last_name',
                                'phones',
                                'id'
                            ]
                        },
                        limit,
                        offset,
                        sort_order: [{ direction: 'asc', field: 'driver_profile.created_date' }]
                    }
                );

                const data = response.data;
                const drivers = data.driver_profiles || [];
                allDrivers.push(...drivers);

                if (offset + limit >= data.total || drivers.length === 0) {
                    hasMore = false;
                } else {
                    offset += limit;
                }
            } catch (error) {
                console.error('[YandexFleetApi] Sürücü profilleri çekilirken hata:', error.response?.data || error.message);
                throw error;
            }
        }

        return allDrivers;
    }

    /**
     * Public: sürücü profillerini döner (cache'li)
     */
    async getDriverProfiles() {
        return this._getCachedDriverProfiles();
    }

    /**
     * Profile cache'ini geçersiz kılar (yeni sürücü oluşturulunca çağrılmalı)
     */
    invalidateProfileCache() {
        this._profilesCache = null;
        this._profilesCacheExpiry = 0;
        this._profilesPending = null;
    }

    /**
     * ✅ OPT-8: Özel tarih aralığı LRU cache
     * @param {string} cacheKey - Benzersiz sorgu anahtarı (from:to)
     * @param {Function} fetcher - Asıl veriyi çeken async fonksiyon
     * @returns {Promise<any>}
     *
     * Davranış:
     *  - Cache HIT (5dk içinde): Anında döner, Yandex'e gitme
     *  - Cache MISS: fetcher çağrılır, sonuç cache'lenir
     *  - Paralel istek (pending): Tek fetch promise'ine bağlanır (dedup)
     *  - Max 20 girişi geçince en eski silinir (LRU eviction)
     */
    async _cachedCustomLeaderboard(cacheKey, fetcher) {
        const now = Date.now();
        const entry = this._customRangeCache.get(cacheKey);

        // Cache HIT — geçerli sonuç var, anında dön
        if (entry && entry.result && now < entry.expiry) {
            console.log(`[YandexFleetApi] Custom range cache HIT: ${cacheKey}`);
            return entry.result;
        }

        // Zaten fetch ediliyor — aynı promise'e bağlan (deduplicate)
        if (entry && entry.pending) {
            console.log(`[YandexFleetApi] Custom range fetch zaten sürüyor, bekleniyor: ${cacheKey}`);
            return entry.pending;
        }

        // Cache MISS — yeni fetch başlat
        console.log(`[YandexFleetApi] Custom range cache MISS, fetch başlatılıyor: ${cacheKey}`);

        const pending = fetcher()
            .then(result => {
                this._customRangeCache.set(cacheKey, {
                    result,
                    expiry: Date.now() + this.CUSTOM_RANGE_TTL,
                    pending: null
                });
                return result;
            })
            .catch(err => {
                // Hata durumunda cache'den sil ki tekrar denesin
                this._customRangeCache.delete(cacheKey);
                throw err;
            });

        // Pending durumunu kaydet (paralel istekler beklesin)
        this._customRangeCache.set(cacheKey, { result: null, expiry: 0, pending });

        // LRU Eviction: max 20 girişi aş, en eskiyi sil
        if (this._customRangeCache.size > this.CUSTOM_RANGE_MAX) {
            const oldestKey = this._customRangeCache.keys().next().value;
            this._customRangeCache.delete(oldestKey);
            console.log(`[YandexFleetApi] Custom range cache doldu, silindi: ${oldestKey}`);
        }

        return pending;
    }

    /**
     * Dönem başlangıç tarihini hesaplar
     */
    _getPeriodStartDate(period) {
        const now = new Date();
        switch (period) {
            case 'daily': {
                return new Date(now.getFullYear(), now.getMonth(), now.getDate()).toISOString();
            }
            case 'weekly': {
                const day = now.getDay();
                const diff = day === 0 ? 6 : day - 1;
                return new Date(now.getFullYear(), now.getMonth(), now.getDate() - diff).toISOString();
            }
            case 'monthly': {
                return new Date(now.getFullYear(), now.getMonth(), 1).toISOString();
            }
            default:
                return '2020-01-01T00:00:00+0000';
        }
    }

    /**
     * @description Merkezi Cursor Sayfalama ve Üstel Gecikmeli (Exponential Backoff) Fetch Motoru
     * @param {string} endpoint - İstek atılacak URL yolu
     * @param {Object} basePayload - Query, fields vb. barındıran asıl gövde
     * @param {number} pageLimit - Her sayfada çekilecek veri sayısı
     * @returns {Promise<Array>}
     */
    async _fetchAllPagesWithCursor(endpoint, basePayload, pageLimit = 1000) {
        const bookedAt = basePayload?.query?.park?.order?.booked_at;
        const isSingleDriver = !!basePayload?.query?.park?.driver_profile?.id;

        // Park geneli büyük veri isteklerinde zaman dilimine böl
        if (bookedAt && bookedAt.from && bookedAt.to && !isSingleDriver) {
            const startMs = new Date(bookedAt.from).getTime();
            const endMs = new Date(bookedAt.to).getTime();

            const MAX_CHUNK_DAYS = 7; // ✅ 5→7 gün: daha az parça = daha az istek
            const chunkMs = MAX_CHUNK_DAYS * 24 * 60 * 60 * 1000;

            if (endMs - startMs > chunkMs) {
                const chunks = [];
                for (let cur = startMs; cur < endMs; cur += chunkMs) {
                    const nextMs = Math.min(cur + chunkMs, endMs);
                    const isLastChunk = nextMs === endMs;
                    chunks.push({
                        from: new Date(cur).toISOString(),
                        to: new Date(isLastChunk ? nextMs : nextMs - 1).toISOString()
                    });
                }

                // ✅ OPT-8: Kontrollü Paralel Çekim (concurrency = 2)
                // Sıralı yerine 2'li gruplar halinde paralel — yarı süre, API patlamaz
                const CONCURRENCY = 2;
                console.log(`[YandexFleetApi] Paralel Parçalayıcı (x${CONCURRENCY}): ${chunks.length} parçaya bölündü.`);
                let allResults = [];

                for (let i = 0; i < chunks.length; i += CONCURRENCY) {
                    const batch = chunks.slice(i, i + CONCURRENCY);

                    const batchPromises = batch.map(chunk => {
                        const chunkPayload = structuredClone(basePayload);
                        if (chunkPayload.query?.park?.order) {
                            chunkPayload.query.park.order.booked_at = chunk;
                        }
                        return this._fetchSingleCursorRange(endpoint, chunkPayload, pageLimit)
                            .catch(err => {
                                console.error(`[YandexFleetApi] Parça atlanıyor (${chunk.from.slice(0, 10)})...`);
                                return [];
                            });
                    });

                    const batchResults = await Promise.all(batchPromises);
                    batchResults.forEach(r => allResults.push(...r));

                    // Gruplar arasında kısa nefes (son grupta bekleme yok)
                    if (i + CONCURRENCY < chunks.length) {
                        await new Promise(r => setTimeout(r, 400));
                    }
                }

                return allResults;
            }
        }

        return this._fetchSingleCursorRange(endpoint, basePayload, pageLimit);
    }

    /**
     * @description Tekil bir cursor döngüsü
     */
    async _fetchSingleCursorRange(endpoint, basePayload, pageLimit = 1000) {
        let cursor = undefined;
        let retries = 0;
        const MAX_RETRIES = 5;  // ✅ 4→5 deneme
        const results = [];

        while (true) {
            try {
                const requestBody = { ...basePayload, limit: pageLimit };
                if (cursor) {
                    requestBody.cursor = cursor;
                }

                const response = await this.httpClient.post(endpoint, requestBody);

                const dataKey = Object.keys(response.data).find(k => k !== 'cursor' && Array.isArray(response.data[k]));
                const items = dataKey ? response.data[dataKey] : [];

                results.push(...items);
                retries = 0;

                const nextCursor = response.data.cursor;
                if (items.length < pageLimit || !nextCursor || nextCursor === '') {
                    break;
                }
                cursor = nextCursor;

            } catch (error) {
                const status = error.response?.status;
                const errorMsg = error.response?.data?.message || error.response?.data || error.message;

                if ((status === 429 || status >= 500 || String(errorMsg).includes('Limit exceeded')) && retries < MAX_RETRIES) {
                    retries++;

                    // ✅ Yandex'in Retry-After header'ını önce dene (varsa onu kullan)
                    const retryAfterSec = parseInt(error.response?.headers?.['retry-after'] || '0', 10);
                    const backoffTime = retryAfterSec > 0
                        ? retryAfterSec * 1000
                        : Math.min((Math.pow(2, retries) * 1500) + Math.floor(Math.random() * 1000), 20000);
                    // ✅ Backoff: 3s → 6s → 12s → 20s (max) — önceki: 2s → 4s → 8s → 16s
                    console.warn(`[YandexFleetApi] API tıkandı (${status || 'Limit'}). ${Math.round(backoffTime / 1000)}s bekleniyor... (${retries}/${MAX_RETRIES})`);


                    await new Promise(r => setTimeout(r, backoffTime));
                    continue;
                }

                console.error(`[YandexFleetApi] Cursor Motoru Hatası (${endpoint}):`, errorMsg);
                throw error;
            }
        }

        return results;
    }

    /**
     * Belirli bir sürücünün yolculuk sayısını getirir (cursor-based pagination)
     * POST /v1/parks/orders/list
     */
    async getDriverOrderCount(driverId, period = 'daily') {
        const from = this._getPeriodStartDate(period);
        const to = new Date().toISOString();

        const basePayload = {
            query: {
                park: {
                    id: this.parkId,
                    driver_profile: { id: driverId },
                    order: {
                        booked_at: { from, to },
                        statuses: ['complete']
                    }
                }
            }
        };

        try {
            const allOrders = await this._fetchAllPagesWithCursor('/v1/parks/orders/list', basePayload, 500);
            return allOrders.length;
        } catch (error) {
            console.error(`[YandexFleetApi] Sürücü ${driverId} siparişleri çekilirken hata oluştu.`);
            return 0;
        }
    }

    /**
     * Sürücünün bakiyesini getirir
     * GET /v1/parks/contractors/blocked-balance
     */
    async getDriverBalance(driverId) {
        try {
            const response = await this.httpClient.get(
                '/v1/parks/contractors/blocked-balance',
                {
                    params: { contractor_id: driverId },
                    headers: { 'X-Park-ID': this.parkId }
                }
            );
            return {
                balance: response.data.balance || '0',
                blockedBalance: response.data.blocked_balance || '0'
            };
        } catch (error) {
            console.error(`[YandexFleetApi] Bakiye çekilirken hata (${driverId}):`, error.response?.data?.message || error.message);
            return null;
        }
    }

    /**
     * Araç detaylarını getirir
     * GET /v2/parks/vehicles/car
     */
    async getCarDetails(vehicleId) {
        try {
            const response = await this.httpClient.get(
                '/v2/parks/vehicles/car',
                {
                    params: { vehicle_id: vehicleId },
                    headers: { 'X-Park-ID': this.parkId }
                }
            );
            return response.data;
        } catch (error) {
            console.error(`[YandexFleetApi] Araç detayı çekilirken hata (${vehicleId}):`, error.response?.data?.message || error.message);
            return null;
        }
    }

    /**
     * Parktaki araç listesini getirir
     * POST /v1/parks/cars/list
     */
    async getCarsList(textSearch = '') {
        const allCars = [];
        let offset = 0;
        const limit = 1000;

        try {
            while (true) {
                const body = {
                    query: {
                        park: { id: this.parkId },
                        text: (textSearch || '').trim()
                    },
                    fields: {
                        car: ['id', 'brand', 'model', 'year', 'number', 'status', 'color']
                    },
                    limit,
                    offset
                };

                const response = await this.httpClient.post(
                    '/v1/parks/cars/list',
                    body,
                    { headers: { 'X-Park-ID': this.parkId } }
                );

                const data = response.data;
                const cars = data.cars || [];
                allCars.push(...cars);

                if (offset + cars.length >= (data.total || 0) || cars.length === 0) {
                    break;
                }
                offset += limit;
            }
            return allCars;
        } catch (error) {
            console.error('[YandexFleetApi] Araç listesi çekilirken hata:', error.response?.data?.message || error.message);
            throw error;
        }
    }

    /**
     * Plaka ile araç arar
     */
    async findCarByPlate(plate) {
        const trimmed = (plate || '').trim().toUpperCase().replace(/\s/g, '');
        if (!trimmed || trimmed.length < 3) return null;

        const cars = await this.getCarsList(trimmed);

        const found = cars.find(c => {
            const carPlate = (c.number || '').trim().toUpperCase().replace(/\s/g, '');
            return carPlate === trimmed;
        });

        if (found) {
            return {
                id: found.id,
                brand: found.brand || '',
                model: found.model || '',
                year: found.year || '',
                number: found.number || trimmed,
                color: translateColor(found.color || '')
            };
        }
        return null;
    }

    /**
     * Çalışma kurallarını getirir
     * GET /v1/parks/driver-work-rules
     */
    async getDriverWorkRules() {
        try {
            const response = await this.httpClient.get(
                '/v1/parks/driver-work-rules',
                { params: { park_id: this.parkId } }
            );
            const rules = response.data?.rules || [];
            return rules.filter(r => r.is_enabled).map(r => r.id);
        } catch (error) {
            console.error('[YandexFleetApi] Work rules hatası:', error.response?.data || error.message);
            throw error;
        }
    }

    /**
     * Yeni taksi sürücüsü profili oluşturur
     * POST /v2/parks/contractors/driver-profile
     */
    async createDriverProfile(data) {
        let workRuleId = config.yandexFleet.workRuleId;
        if (!workRuleId) {
            const rules = await this.getDriverWorkRules();
            workRuleId = rules[0];
        }
        if (!workRuleId) {
            throw new Error('Çalışma kuralı bulunamadı. YANDEX_WORK_RULE_ID .env dosyasında tanımlayın.');
        }

        const body = {
            person: {
                full_name: {
                    first_name: data.firstName,
                    last_name: data.lastName
                },
                contact_info: {
                    phone: data.phone
                },
                driver_license: {
                    number: data.driverLicenseNumber,
                    birth_date: data.birthDate,
                    country: data.country || 'tur',
                    issue_date: data.driverLicenseIssueDate,
                    expiry_date: data.driverLicenseExpiryDate
                },
                driver_license_experience: {
                    total_since_date: data.driverLicenseIssueDate
                },
                tax_identification_number: data.taxIdentificationNumber
            },
            account: {
                work_rule_id: workRuleId
            },
            order_provider: {
                platform: true,
                partner: true
            }
        };

        // ✅ OPT-5: crypto artık top-level import, require() içinde çağrılmıyor
        const idempotencyToken = crypto.randomBytes(16).toString('hex');

        try {
            const response = await this.httpClient.post(
                '/v2/parks/contractors/driver-profile',
                body,
                {
                    headers: {
                        'X-Park-ID': this.parkId,
                        'X-Idempotency-Token': idempotencyToken
                    }
                }
            );
            const contractorProfileId = response.data?.contractor_profile_id;
            if (!contractorProfileId) {
                throw new Error('Sürücü oluşturuldu ancak profil ID alınamadı.');
            }

            // ✅ Yeni sürücü oluşunca profil cache'ini temizle
            this.invalidateProfileCache();

            return { contractorProfileId };
        } catch (error) {
            const errData = error.response?.data;
            const msg = errData?.message || errData?.code || error.message;
            console.error('[YandexFleetApi] Sürücü oluşturma hatası:', msg, JSON.stringify(errData || {}));
            throw new Error(msg);
        }
    }

    /**
     * Araçı sürücüye bağlar
     * PUT /v1/parks/driver-profiles/car-bindings
     */
    async bindCarToDriver(driverId, carId) {
        try {
            await this.httpClient.put(
                '/v1/parks/driver-profiles/car-bindings',
                {},
                {
                    params: {
                        park_id: this.parkId,
                        driver_profile_id: driverId,
                        car_id: carId
                    },
                    headers: { 'X-Park-ID': this.parkId }
                }
            );
            return true;
        } catch (error) {
            const errData = error.response?.data;
            const msg = errData?.message || errData?.error?.text || error.message;
            console.error(`[YandexFleetApi] Araç bağlama hatası:`, msg);
            console.error(`[YandexFleetApi] Hata detayı:`, JSON.stringify(errData || {}));
            throw new Error(`Araç bağlama hatası: ${msg}`);
        }
    }

    /**
     * Yeni araç oluşturur ve sürücüye bağlar
     * POST /v2/parks/vehicles/car
     */
    async createCarAndBind(plate, brand, model, year, driverId) {
        const trimmedPlate = (plate || '').trim().toUpperCase();
        const body = {
            vehicle_specifications: {
                brand: (brand || '').trim(),
                model: (model || '').trim(),
                year: parseInt(year, 10) || new Date().getFullYear(),
                color: 'Черный',
                transmission: 'automatic',
                vin: trimmedPlate.replace(/\D/g, '').padEnd(17, '0').substring(0, 17) || '0'.repeat(17),
                body_number: trimmedPlate,
                mileage: 0
            },
            vehicle_licenses: {
                licence_plate_number: trimmedPlate,
                registration_certificate: trimmedPlate,
                licence_number: trimmedPlate
            },
            park_profile: {
                callsign: trimmedPlate,
                status: 'working',
                categories: ['econom'],
                fuel_type: 'petrol'
            }
        };

        try {
            const response = await this.httpClient.post(
                '/v2/parks/vehicles/car',
                body,
                {
                    headers: {
                        'X-Park-ID': this.parkId,
                        // ✅ OPT-5: crypto top-level
                        'X-Idempotency-Token': crypto.randomBytes(16).toString('hex')
                    }
                }
            );

            const vehicleId = response.data?.vehicle_id;
            if (!vehicleId) {
                throw new Error('Araç oluşturuldu ancak ID alınamadı.');
            }

            await this.bindCarToDriver(driverId, vehicleId);
            return { vehicleId, plate: trimmedPlate, brand, model, year };
        } catch (error) {
            const msg = error.response?.data?.message || error.message;
            console.error('[YandexFleetApi] Araç oluşturma hatası:', msg);
            throw new Error(msg);
        }
    }

    /**
     * Araç plakasını günceller
     * PUT /v2/parks/vehicles/car
     */
    async updateCarPlate(vehicleId, newPlate) {
        const carData = await this.getCarDetails(vehicleId);
        if (!carData) {
            throw new Error('Araç bilgileri alınamadı.');
        }

        const updateBody = {
            vehicle_specifications: carData.vehicle_specifications || {},
            vehicle_licenses: {
                ...(carData.vehicle_licenses || {}),
                licence_plate_number: newPlate
            },
            park_profile: carData.park_profile || {}
        };

        try {
            await this.httpClient.put(
                '/v2/parks/vehicles/car',
                updateBody,
                {
                    params: { vehicle_id: vehicleId },
                    headers: { 'X-Park-ID': this.parkId }
                }
            );
            return true;
        } catch (error) {
            const msg = error.response?.data?.message || error.message;
            console.error(`[YandexFleetApi] Plaka güncelleme hatası (${vehicleId}):`, msg);
            throw new Error(msg);
        }
    }

    /**
     * 10 günlük dönem hesaplayıcı
     */
    _get10DayPeriod() {
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

        const monthNames = ['Ocak', 'Şubat', 'Mart', 'Nisan', 'Mayıs', 'Haziran',
            'Temmuz', 'Ağustos', 'Eylül', 'Ekim', 'Kasım', 'Aralık'];

        const label = `${periodStart.getDate()} - ${periodEnd.getDate()} ${monthNames[month]} ${year}`;

        return { from: periodStart.toISOString(), to: periodEnd.toISOString(), label };
    }

    /**
     * Önceki 10 günlük dönemi hesaplar
     */
    _getPrev10DayPeriod() {
        const now = new Date();
        const year = now.getFullYear();
        const month = now.getMonth();
        const day = now.getDate();

        const monthNames = ['Ocak', 'Şubat', 'Mart', 'Nisan', 'Mayıs', 'Haziran',
            'Temmuz', 'Ağustos', 'Eylül', 'Ekim', 'Kasım', 'Aralık'];

        let periodStart, periodEnd, labelMonth, labelYear;

        if (day <= 10) {
            periodStart = new Date(year, month - 1, 21);
            periodEnd = new Date(year, month, 0, 23, 59, 59, 999);
            labelMonth = month - 1;
            labelYear = year;
            if (labelMonth < 0) { labelMonth = 11; labelYear = year - 1; }
        } else if (day <= 20) {
            periodStart = new Date(year, month, 1);
            periodEnd = new Date(year, month, 10, 23, 59, 59, 999);
            labelMonth = month;
            labelYear = year;
        } else {
            periodStart = new Date(year, month, 11);
            periodEnd = new Date(year, month, 20, 23, 59, 59, 999);
            labelMonth = month;
            labelYear = year;
        }

        const label = `${periodStart.getDate()} - ${periodEnd.getDate()} ${monthNames[labelMonth]} ${labelYear}`;

        return { from: periodStart.toISOString(), to: periodEnd.toISOString(), label };
    }

    /**
     * Cache Isıtma (Server başlarken çağrılır)
     */
    async initiateCacheWarming() {
        console.log('[YandexFleetApi] Arka planda önyükleme (cache warming) başlatılıyor...');
        try {
            // İlk açılışta 1 aylık veriyi çek
            await this._fetchLastMonthOrders();
            await this.getLeaderboardData();
            await this.getAdminLeaderboardData(false);
            await this.getAdminLeaderboardData(true);
            console.log('[YandexFleetApi] Önyükleme başarıyla tamamlandı!');
        } catch (e) {
            console.error('[Cache Warming Error]:', e.message);
        }

        // Her 15 dakikada bir cache'leri tazele
        setInterval(async () => {
            try {
                console.log('[YandexFleetApi] Arka plan cache tazeleme rutini çalışıyor...');
                // 1 aylık veriyi her 15 dakikada bir yenile
                await this._fetchLastMonthOrders();

                await this._fetchLeaderboardForPeriod(this._get10DayPeriod()).catch(() => { });
                await new Promise(r => setTimeout(r, 2000));
                await this._fetchAdminLeaderboard(this._get10DayPeriod(), false).catch(() => { });
                await new Promise(r => setTimeout(r, 2000));
                await this._fetchAdminLeaderboard(this._getPrev10DayPeriod(), true).catch(() => { });
            } catch (e) {
                console.error('[Cache Update Error] Periyodik güncelleştirme başarısız', e.message);
            }
        }, 15 * 60 * 1000);
    }

    /**
     * Son 1 aya ait tüm tamamlanmış siparişleri getirir ve in-memory cache'e yazar
     */
    async _fetchLastMonthOrders() {
        if (this._lastMonthPending) return this._lastMonthPending;

        this._lastMonthPending = (async () => {
            try {
                const now = new Date();
                const fromDate = new Date(now);
                fromDate.setMonth(now.getMonth() - 1);
                // Bir nebze daha erken başlasın ki zaman farklarında kayıp olmasın
                fromDate.setDate(fromDate.getDate() - 1); 
                
                const from = fromDate.toISOString();
                const to = now.toISOString();

                console.log(`[YandexFleetApi] Son 1 aylık siparişler belleğe yükleniyor... (${from} - ${to})`);

                const allOrders = await this._fetchAllPagesWithCursor('/v1/parks/orders/list', {
                    query: {
                        park: {
                            id: this.parkId,
                            order: {
                                booked_at: { from, to },
                                statuses: ['complete']
                            }
                        }
                    }
                }, 500);

                this._lastMonthOrdersCache = allOrders;
                this._lastMonthFrom = fromDate;
                this._lastMonthTo = now;

                console.log(`[YandexFleetApi] Son 1 aylık siparişler belleğe yüklendi. Toplam sipariş: ${allOrders.length}`);
                return allOrders;
            } catch (error) {
                console.error('[YandexFleetApi] Son 1 aylık siparişler çekilemedi:', error.message);
                return [];
            } finally {
                this._lastMonthPending = null;
            }
        })();

        return this._lastMonthPending;
    }

    /**
     * İstenilen dönemdeki siparişleri döner.
     * Mümkünse _lastMonthOrdersCache'den süzülerek döner, değilse doğrudan Yandex API çağırır.
     */
    async _getOrdersForPeriod(period) {
        const fromDate = new Date(period.from);
        const toDate = new Date(period.to);

        // Cache mevcutsa ve istenen tarihleri tamamen kapsıyorsa
        if (this._lastMonthOrdersCache && this._lastMonthFrom && this._lastMonthTo) {
            if (fromDate >= this._lastMonthFrom && toDate <= this._lastMonthTo) {
                console.log(`[YandexFleetApi] Siparişler bellekten(cache) filtreleniyor (${period.label})`);
                // Bellekten dön
                return this._lastMonthOrdersCache.filter(order => {
                    if (!order.booked_at) return false;
                    const orderDate = new Date(order.booked_at);
                    return orderDate >= fromDate && orderDate <= toDate;
                });
            }
        }

        console.log(`[YandexFleetApi] Siparişler API'den çekiliyor (${period.label})`);
        return this._fetchAllPagesWithCursor('/v1/parks/orders/list', {
            query: {
                park: {
                    id: this.parkId,
                    order: {
                        booked_at: { from: period.from, to: period.to },
                        statuses: ['complete']
                    }
                }
            }
        }, 500);
    }

    /**
     * Admin paneli için 10 günlük leaderboard
     * Stale-while-revalidate cache stratejisi
     */
    async getAdminLeaderboardData(previousPeriod = false, customFrom = null, customTo = null) {
        if (customFrom && customTo) {
            const startDate = new Date(customFrom);
            const endDate = new Date(customTo);
            endDate.setHours(23, 59, 59, 999);

            const monthNames = ['Ocak', 'Şubat', 'Mart', 'Nisan', 'Mayıs', 'Haziran',
                'Temmuz', 'Ağustos', 'Eylül', 'Ekim', 'Kasım', 'Aralık'];
            const label = `${startDate.getDate()} ${monthNames[startDate.getMonth()]} ${startDate.getFullYear()} - ${endDate.getDate()} ${monthNames[endDate.getMonth()]} ${endDate.getFullYear()}`;

            const period = {
                from: startDate.toISOString(),
                to: endDate.toISOString(),
                label
            };

            // ✅ OPT-8: Özel aralık cache — admin için de aynı ortak LRU
            return this._cachedCustomLeaderboard(`admin:${customFrom}:${customTo}`, () =>
                this._fetchAdminLeaderboard(period, false, true)
            );
        }

        const period = previousPeriod ? this._getPrev10DayPeriod() : this._get10DayPeriod();
        const cacheKey = period.label;

        if (previousPeriod) {
            if (this._adminLeaderboardPrevCache && this._adminLeaderboardPrevCacheKey === cacheKey) {
                if (Date.now() >= this._adminLeaderboardPrevExpiry && !this._adminLeaderboardPrevPending) {
                    this._adminLeaderboardPrevPending = this._fetchAdminLeaderboard(period, true).finally(() => this._adminLeaderboardPrevPending = null);
                }
                return this._adminLeaderboardPrevCache;
            }
            if (this._adminLeaderboardPrevPending) return this._adminLeaderboardPrevPending;

            this._adminLeaderboardPrevPending = this._fetchAdminLeaderboard(period, true).finally(() => this._adminLeaderboardPrevPending = null);
            return this._adminLeaderboardPrevPending;
        }

        if (this._adminLeaderboardCache && this._adminLeaderboardCacheKey === cacheKey) {
            if (Date.now() >= this._adminLeaderboardExpiry && !this._adminLeaderboardPending) {
                this._adminLeaderboardPending = this._fetchAdminLeaderboard(period, false).finally(() => this._adminLeaderboardPending = null);
            }
            return this._adminLeaderboardCache;
        }
        if (this._adminLeaderboardPending) return this._adminLeaderboardPending;

        this._adminLeaderboardPending = this._fetchAdminLeaderboard(period, false).finally(() => this._adminLeaderboardPending = null);
        return this._adminLeaderboardPending;
    }

    /**
     * Admin leaderboard verisini çeker
     * ✅ OPT-6: Profil + siparişler PARALEL çekiliyor (Promise.all)
     */
    async _fetchAdminLeaderboard(period, isPrevious = false, skipCache = false) {
        // ✅ OPT-6: Profiller ve siparişleri aynı anda başlat
        const [profiles, allOrders] = await Promise.all([
            this._getCachedDriverProfiles(),
            this._getOrdersForPeriod(period).catch(error => {
                console.error('[YandexFleetApi] Admin leaderboard siparişleri çekilemedi:', error.message);
                return [];
            })
        ]);

        const driverMap = {};
        profiles.forEach(p => {
            const dp = p.driver_profile || {};
            const id = dp.id;
            if (!id) return;
            const firstName = dp.first_name || '';
            const lastName = dp.last_name || '';
            const fullName = [firstName, lastName].filter(Boolean).join(' ') || 'İsimsiz';
            driverMap[id] = { id, fullName, tripCount: 0 };
        });

        const totalOrders = allOrders.length;
        allOrders.forEach(order => {
            const driverId = order.driver?.id || order.driver_profile?.id;
            if (driverId && driverMap[driverId]) {
                driverMap[driverId].tripCount++;
            } else if (driverId) {
                driverMap[driverId] = { id: driverId, fullName: 'Bilinmeyen Sürücü', tripCount: 1 };
            }
        });

        const drivers = Object.values(driverMap).filter(d => d.tripCount > 0);
        drivers.sort((a, b) => b.tripCount - a.tripCount);
        const top10 = drivers.slice(0, 10).map((d, i) => ({ ...d, rank: i + 1 }));

        const result = {
            top10,
            periodLabel: period.label,
            totalOrders,
            totalDrivers: Object.keys(driverMap).length
        };

        if (!skipCache) {
            if (isPrevious) {
                this._adminLeaderboardPrevCache = result;
                this._adminLeaderboardPrevCacheKey = period.label;
                this._adminLeaderboardPrevExpiry = Date.now() + 15 * 60 * 1000;
            } else {
                this._adminLeaderboardCache = result;
                this._adminLeaderboardCacheKey = period.label;
                this._adminLeaderboardExpiry = Date.now() + 15 * 60 * 1000;
            }
        }

        console.log(`[YandexFleetApi] Admin leaderboard yüklendi: ${period.label}, ${totalOrders} sipariş, ${top10.length} sürücü`);
        return result;
    }

    /**
     * Sürücü sıralama tablosu (public leaderboard)
     * Stale-while-revalidate cache stratejisi
     */
    async getLeaderboardData(previousPeriod = false, customFrom = null, customTo = null) {
        if (customFrom && customTo) {
            const startDate = new Date(customFrom);
            const endDate = new Date(customTo);
            endDate.setHours(23, 59, 59, 999);

            const monthNames = ['Ocak', 'Şubat', 'Mart', 'Nisan', 'Mayıs', 'Haziran',
                'Temmuz', 'Ağustos', 'Eylül', 'Ekim', 'Kasım', 'Aralık'];
            const label = `${startDate.getDate()} ${monthNames[startDate.getMonth()]} ${startDate.getFullYear()} - ${endDate.getDate()} ${monthNames[endDate.getMonth()]} ${endDate.getFullYear()}`;

            const period = {
                from: startDate.toISOString(),
                to: endDate.toISOString(),
                label
            };

            // ✅ OPT-8: Özel aralık cache — aynı from+to 5 dk içinde tekrar gelirse anında döner
            return this._cachedCustomLeaderboard(`lb:${customFrom}:${customTo}`, () =>
                this._fetchLeaderboardForPeriod(period)
            );
        }

        const period = previousPeriod ? this._getPrev10DayPeriod() : this._get10DayPeriod();

        if (this._leaderboardCache && this._leaderboardCacheKey === period.label && !previousPeriod) {
            if (Date.now() >= this._leaderboardExpiry && !this._leaderboardPending) {
                this._leaderboardPending = this._fetchLeaderboardForPeriod(period).then(r => {
                    this._leaderboardCache = r;
                    this._leaderboardCacheKey = period.label;
                    this._leaderboardExpiry = Date.now() + 30 * 60 * 1000;
                    return r;
                }).finally(() => { this._leaderboardPending = null; });
            }
            return this._leaderboardCache;
        }

        if (this._leaderboardPending) return this._leaderboardPending;

        this._leaderboardPending = this._fetchLeaderboardForPeriod(period).then(r => {
            if (!previousPeriod) {
                this._leaderboardCache = r;
                this._leaderboardCacheKey = period.label;
                this._leaderboardExpiry = Date.now() + 30 * 60 * 1000;
            }
            return r;
        }).finally(() => { this._leaderboardPending = null; });
        return this._leaderboardPending;
    }

    /**
     * Belirli bir dönem için sürücü leaderboard verisini çeker
     * ✅ OPT-6: Profil + siparişler PARALEL çekiliyor (Promise.all)
     */
    async _fetchLeaderboardForPeriod(period) {
        // ✅ OPT-6: Paralel fetch (eskiden sıralıydı, şimdi eş zamanlı)
        const [profiles, allOrders] = await Promise.all([
            this._getCachedDriverProfiles(),
            this._getOrdersForPeriod(period).catch(error => {
                console.error('[YandexFleetApi] Leaderboard siparişleri çekilemedi:', error.message);
                return [];
            })
        ]);

        const driverMap = {};
        profiles.forEach(p => {
            const dp = p.driver_profile || {};
            const id = dp.id;
            if (!id) return;
            const firstName = dp.first_name || '';
            const lastName = dp.last_name || '';
            const parts = [firstName, lastName].filter(Boolean);
            const initials = parts.length >= 2
                ? `${parts[0][0].toUpperCase()}. ${parts[parts.length - 1][0].toUpperCase()}.`
                : (firstName || 'X').substring(0, 1).toUpperCase() + '.';
            driverMap[id] = { id, initials, tripCount: 0 };
        });

        const totalOrders = allOrders.length;
        allOrders.forEach(order => {
            const driverId = order.driver?.id || order.driver_profile?.id;
            if (driverId && driverMap[driverId]) {
                driverMap[driverId].tripCount++;
            } else if (driverId) {
                driverMap[driverId] = { id: driverId, initials: '?.', tripCount: 1 };
            }
        });

        const drivers = Object.values(driverMap).filter(d => d.tripCount > 0);
        drivers.sort((a, b) => b.tripCount - a.tripCount);
        drivers.forEach((d, i) => { d.rank = i + 1; });

        return {
            drivers,
            totalDrivers: Object.keys(driverMap).length,
            totalOrders,
            periodLabel: period.label
        };
    }

    /**
     * Sürücü profil verisini düzenli formata çevirir
     */
    formatDriverProfile(profile) {
        const dp = profile.driver_profile || {};
        const car = profile.car || {};

        const carBrand = car.brand || '';
        const carModel = car.model || '';
        const carNumber = car.number || '';
        const carYear = car.year || '';
        const carColor = translateColor(car.color || '');

        return {
            id: dp.id,
            name: `${dp.first_name || ''} ${dp.last_name || ''}`.trim(),
            phones: dp.phones || [],
            car: carNumber
                ? `${carBrand} ${carModel} (${carYear}) - ${carColor} - Plaka: ${carNumber}`
                : 'Araç atanmamış',
            tripCount: 0
        };
    }

    /**
     * Park genelinde tüm siparişleri çekip sürücü başına sayar (bulk)
     */
    async _fetchOrderCountsByDriver(period = 'all') {
        const from = this._getPeriodStartDate(period);
        const to = new Date().toISOString();
        const countMap = {};

        const basePayload = {
            query: {
                park: {
                    id: this.parkId,
                    order: {
                        booked_at: { from, to },
                        statuses: ['complete']
                    }
                }
            }
        };

        try {
            const allOrders = await this._fetchAllPagesWithCursor('/v1/parks/orders/list', basePayload, 500);

            allOrders.forEach(order => {
                const driverId = order.driver?.id || order.driver_profile?.id;
                if (driverId) {
                    countMap[driverId] = (countMap[driverId] || 0) + 1;
                }
            });
        } catch (error) {
            console.error('[YandexFleetApi] Genel siparişler çekilirken hata oluştu:', error.message);
        }

        return countMap;
    }

    /**
     * Tüm sürücülerin bilgilerini toplar (paralel)
     */
    async getAllDriversInfo() {
        const [driverProfiles, tripCountMap] = await Promise.all([
            this.getDriverProfiles(),
            this._fetchOrderCountsByDriver('all')
        ]);

        const driversInfo = driverProfiles.map(p => {
            const info = this.formatDriverProfile(p);
            info.tripCount = tripCountMap[info.id] || 0;
            return info;
        });

        return driversInfo;
    }

    /**
     * Sadece sürücü profillerini çeker (hızlı mod)
     */
    async getDriverProfilesFormatted() {
        const driverProfiles = await this.getDriverProfiles();

        return driverProfiles.map(p => {
            const info = this.formatDriverProfile(p);
            info.tripCount = 'N/A (hızlı mod)';
            return info;
        });
    }
}

module.exports = new YandexFleetApi();
