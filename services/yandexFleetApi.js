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

/**
 * ✅ FIX-5: Savunmacı sürücü ID çıkarımı
 * Yandex Fleet farklı sipariş yapılarında farklı alan adları kullanabiliyor.
 * Tüm olası alanları sırayla dener, ilk bulunanı döner.
 */
function extractDriverId(order) {
    return (
        order.driver?.id ||
        order.driver_profile?.id ||
        order.driver_profile?.driver_profile_id ||
        null
    );
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
    }

    /**
     * Tarihi Türkiye saat dilimine (GMT+3) göre ISO formatında (+03:00) döndürür
     */
    _toLocalISOString(date) {
        const offsetMs = date.getTimezoneOffset() * 60 * 1000;
        const localDate = new Date(date.getTime() - offsetMs);
        let isoStr = localDate.toISOString();
        isoStr = isoStr.replace('Z', '');

        const offset = -date.getTimezoneOffset();
        const sign = offset >= 0 ? '+' : '-';
        const pad = (num) => String(num).padStart(2, '0');
        const offsetHours = pad(Math.floor(Math.abs(offset) / 60));
        const offsetMinutes = pad(Math.abs(offset) % 60);

        return `${isoStr}${sign}${offsetHours}:${offsetMinutes}`;
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

                // ✅ FIX-1: Başarısız parça sayacı — sessiz kayıp yerine eşik sistemi
                let failedChunkCount = 0;
                const MAX_ALLOWED_FAILURES = 1; // 2+ parça başarısız olursa tüm isteği hatayla fırlat

                for (let i = 0; i < chunks.length; i += CONCURRENCY) {
                    const batch = chunks.slice(i, i + CONCURRENCY);

                    const batchPromises = batch.map(chunk => {
                        const chunkPayload = structuredClone(basePayload);
                        if (chunkPayload.query?.park?.order) {
                            chunkPayload.query.park.order.booked_at = chunk;
                        }
                        return this._fetchSingleCursorRange(endpoint, chunkPayload, pageLimit)
                            .catch(err => {
                                failedChunkCount++;
                                console.error(`[YandexFleetApi] Parça başarısız (${chunk.from.slice(0, 10)} → ${chunk.to.slice(0, 10)}): ${err.message}. Toplam başarısız: ${failedChunkCount}`);
                                if (failedChunkCount > MAX_ALLOWED_FAILURES) {
                                    // Kritik kayıp eşiği aşıldı — tüm isteği hatayla sonlandır
                                    throw new Error(`[YandexFleetApi] Çok fazla parça başarısız oldu (${failedChunkCount}/${chunks.length}). Leaderboard eski cache'den servis edilecek.`);
                                }
                                return []; // İlk hatada tolerans ver, devam et
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
                // ✅ DÜZELTME: Yandex Fleet, filtrelediği querylerde (örn: sadece statuses: 'complete') 
                // pageLimit'ten (500) daha az data (örneğin 480) dönse bile cursor vermeye devam eder.
                // "items.length < pageLimit" kontrolü, sonraki sayfaları çöpe atıyordu. 
                // Artık sadece cursor'ın bitip bitmediğine bakar.
                if (!nextCursor || nextCursor === '') {
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
        const fromMs = new Date(this._getPeriodStartDate(period)).getTime();
        const toMs = Date.now();

        // ✅ Önce 45 günlük cache'den filtrele — Yandex'e ayrı istek atmaya gerek yok
        if (this._last45DaysOrdersCache && this._last45DaysOrdersCache.length > 0) {
            const cacheFromMs = this._last45DaysFrom ? this._last45DaysFrom.getTime() : Infinity;

            if (cacheFromMs <= fromMs) {
                const cacheToMs = this._last45DaysTo ? this._last45DaysTo.getTime() : 0;

                let count = this._last45DaysOrdersCache.filter(order => {
                    const dId = order.driver?.id || order.driver_profile?.id;
                    if (dId !== driverId) return false;
                    if (!order.booked_at) return false;
                    const t = new Date(order.booked_at).getTime();
                    return t >= fromMs && t <= cacheToMs;
                }).length;

                // Cache bitiş zamanından bu yana yeni sipariş varsa API'den tamamla
                if (cacheToMs < toMs) {
                    try {
                        const extraFrom = this._toLocalISOString(new Date(cacheToMs));
                        const extraTo = this._toLocalISOString(new Date(toMs));
                        const extraOrders = await this._fetchAllPagesWithCursor('/v1/parks/orders/list', {
                            query: {
                                park: {
                                    id: this.parkId,
                                    driver_profile: { id: driverId },
                                    order: {
                                        booked_at: { from: extraFrom, to: extraTo },
                                        statuses: ['complete']
                                    }
                                }
                            }
                        }, 500);
                        count += extraOrders.length;
                    } catch (err) {
                        console.warn(`[YandexFleetApi] Delta trip count tamamlanamadı (${driverId}):`, err.message);
                    }
                }

                return count;
            }
        }

        // Cache yoksa veya dönemi kapsamıyorsa doğrudan Yandex API'ye git
        const from = this._getPeriodStartDate(period);
        const to = new Date().toISOString();
        try {
            const allOrders = await this._fetchAllPagesWithCursor('/v1/parks/orders/list', {
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
            }, 500);
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
     * Tüm sürücülerin profil bilgilerini döner (araç + kimlik bilgileri).
     * Yolculuk sayısı artık leaderboardService tarafından yönetilmektedir.
     */
    async getAllDriversInfo() {
        const profiles = await this._getCachedDriverProfiles();
        return profiles.map(p => {
            const info = this.formatDriverProfile(p);
            info.tripCount = 0; // leaderboardService.getLeaderboard() ile birleştirin
            return info;
        });
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
