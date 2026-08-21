const axios = require('axios');
const crypto = require('crypto');
const http = require('http');
const https = require('https');
const config = require('../config');

const keepAliveAgentOptions = {
    keepAlive: true,
    maxSockets: 100,
    maxFreeSockets: 10,
    timeout: 60000,
    freeSocketTimeout: 30000
};
const httpAgent = new http.Agent(keepAliveAgentOptions);
const httpsAgent = new https.Agent(keepAliveAgentOptions);

const sleep = ms => new Promise(r => setTimeout(r, ms));

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

/** Yandex POST /v2/parks/vehicles/car — vehicle_specifications.color (Rusça sabit isim) */
const DEFAULT_NEW_CAR_COLOR = 'Желтый'; // Sarı

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
            httpAgent,
            httpsAgent,
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
        /** Çoklu şehir: partnerId -> axios (X-Client-ID / X-API-Key parka özel) */
        this._partnerHttpClients = new Map();
        // ✅ OPT-4: Sürücü bakiyesi için 2 dakikalık cache — tekrar eden balance isteklerini azaltır
        // driverId -> { balance, blockedBalance, expiry }
        this._balanceCache = new Map();
        this.BALANCE_TTL = 8 * 60 * 1000; // Kullanıcı talebi: 8 dakika
        this._cacheLookupFn = null;

        // ✅ Global Throttle: TÜM Yandex API istekleri arasına minimum 500ms boşluk koy
        // Farklı sürücülerin eşzamanlı isteklerinin + sync işlemlerinin 429 tetiklemesini engeller
        this._lastYandexRequestTime = 0;
        this._yandexThrottleQueue = Promise.resolve();
        this.YANDEX_MIN_INTERVAL = 500; // ms
    }

    registerCacheLookup(fn) {
        this._cacheLookupFn = fn;
    }

    /**
     * @param {string} [parkPartnerId] - boş / yoksa birinci park (config.yandexFleet)
     * @returns {{ http: import('axios').AxiosInstance, parkId: string }}
     */
    _resolveParkContext(parkPartnerId) {
        const defaultPid = this.parkId;
        if (!parkPartnerId || parkPartnerId === defaultPid) {
            return { http: this.httpClient, parkId: defaultPid };
        }
        const src = config.findYandexParkByPartnerId(parkPartnerId);
        if (!src) {
            console.warn('[YandexFleetApi] Bilinmeyen park_partner_id:', parkPartnerId);
            return { http: this.httpClient, parkId: defaultPid };
        }
        if (!this._partnerHttpClients.has(parkPartnerId)) {
            this._partnerHttpClients.set(
                parkPartnerId,
                axios.create({
                    baseURL: src.baseUrl || config.yandexFleet.baseUrl,
                    timeout: 30000,
                    httpAgent,
                    httpsAgent,
                    headers: {
                        'X-Client-ID': src.clientId,
                        'X-API-Key': src.apiKey,
                        'Content-Type': 'application/json',
                        'Accept-Language': 'tr'
                    }
                })
            );
        }
        return { http: this._partnerHttpClients.get(parkPartnerId), parkId: src.partnerId };
    }

    /**
     * Tek park için sürücü listesi (telefon doğrulama; önbellek authService'te)
     */
    async fetchDriverProfilesForParkSource(parkSource) {
        const { http, parkId } = this._resolveParkContext(parkSource.partnerId);
        const allDrivers = [];
        let offset = 0;
        const limit = 1000;
        let hasMore = true;

        while (hasMore) {
            if (offset > 0) {
                await sleep(1500); // 1.5s delay between pages to prevent 429
            }
            // Global throttle üzerinden geçir
            const response = await this._throttledYandexRequest(() => http.post(
                '/v1/parks/driver-profiles/list',
                {
                    query: { park: { id: parkId } },
                    fields: {
                        account: ['balance'],
                        car: ['brand', 'model', 'number', 'year', 'color', 'id'],
                        driver_profile: ['first_name', 'last_name', 'phones', 'id']
                    },
                    limit,
                    offset
                }
            ));

            const data = response.data;
            const drivers = data.driver_profiles || [];
            allDrivers.push(...drivers);

            if (offset + limit >= (data.total || 0) || drivers.length === 0) {
                hasMore = false;
            } else {
                offset += limit;
            }
        }

        return allDrivers;
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
        const { http, parkId } = this._resolveParkContext();
        const allDrivers = [];
        let offset = 0;
        const limit = 1000;
        let hasMore = true;

        while (hasMore) {
            try {
                if (offset > 0) {
                    await sleep(1500); // 1.5s delay between pages to prevent 429
                }
                const response = await http.post(
                    '/v1/parks/driver-profiles/list',
                    {
                        query: {
                            park: { id: parkId }
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
     * Sürücünün bakiyesini getirir
     * GET /v1/parks/contractors/blocked-balance
     */
    async getDriverBalance(driverId, parkPartnerId, forceRefresh = false) {
        // ✅ OPT-4: 8 dakikalık cache — aynı sürücü için Yandex API'ye tekrar istek atılmaz
        const cacheKey = `${driverId}:${parkPartnerId || 'default'}`;
        const now = Date.now();
        const cached = this._balanceCache.get(cacheKey);
        
        // Eğer önbellekte geçerli bir veri varsa; 
        // Ya zorla yenileme istenmemiş olmalı (forceRefresh == false)
        // Ya da sürücü için çekim sonrası bakiye kilidi / rate limit kalkanı aktif olmalı.
        if (cached) {
            if (now < cached.expiry) {
                if (!forceRefresh || cached.isRateLimited || cached.isPostWithdrawOverride) {
                    return { balance: cached.balance, blockedBalance: cached.blockedBalance };
                } else {
                    console.log(`[Yandex API] Önbellek yenileniyor (Zorunlu): Sürücü=${driverId}`);
                }
            }
        }

        // KULLANICI TALEBİ: authService üzerindeki önbellekte kalan bakiyeler eski (stale) olabildiği için,
        // bakiye cache süresi dolduğunda doğrudan Yandex'e gitmesi istendi. Bu yüzden authService fallback'i kaldırıldı.

        // ✅ Global Throttle: Yandex'e gitmeden önce son isteğin üstünden yeterince zaman geçmesini bekle
        const balanceResult = await this._throttledBalanceRequest(driverId, parkPartnerId, cacheKey, now, cached);
        return balanceResult;
    }

    /**
     * TÜM Yandex API isteklerini global throttle ile sıraya sokar.
     * İstekler arasında minimum 500ms boşluk olur. (bakiye, profil, sipariş vs.)
     */
    async _throttledYandexRequest(requestFn) {
        const result = new Promise((resolve, reject) => {
            this._yandexThrottleQueue = this._yandexThrottleQueue.then(async () => {
                // Son istekten bu yana yeterince zaman geçmesini bekle
                const elapsed = Date.now() - this._lastYandexRequestTime;
                if (elapsed < this.YANDEX_MIN_INTERVAL) {
                    await sleep(this.YANDEX_MIN_INTERVAL - elapsed);
                }
                this._lastYandexRequestTime = Date.now();

                try {
                    resolve(await requestFn());
                } catch (err) {
                    reject(err);
                }
            }).catch(() => {});
        });
        return result;
    }

    /**
     * Yandex bakiye isteğini global throttle ile sıraya sokar.
     * Ayrıca kuyrukta beklerken cache dolmuşsa Yandex'e hiç gitmez.
     */
    async _throttledBalanceRequest(driverId, parkPartnerId, cacheKey, now, cached) {
        // Kuyruğa ekle — önceki istek bitmeden yenisi başlamaz
        const result = new Promise((resolve) => {
            this._yandexThrottleQueue = this._yandexThrottleQueue.then(async () => {
                // Kuyrukta beklerken cache dolmuş olabilir (başka istek çekmiş olabilir)
                const freshCached = this._balanceCache.get(cacheKey);
                if (freshCached && Date.now() < freshCached.expiry) {
                    resolve({ balance: freshCached.balance, blockedBalance: freshCached.blockedBalance });
                    return;
                }

                // Son istekten bu yana yeterince zaman geçmesini bekle
                const elapsed = Date.now() - this._lastYandexRequestTime;
                if (elapsed < this.YANDEX_MIN_INTERVAL) {
                    await sleep(this.YANDEX_MIN_INTERVAL - elapsed);
                }
                this._lastYandexRequestTime = Date.now();

                resolve(await this._doBalanceRequest(driverId, parkPartnerId, cacheKey, cached));
            }).catch(() => {});
        });
        return result;
    }

    async _doBalanceRequest(driverId, parkPartnerId, cacheKey, cached) {
        const now = Date.now();
        const { http, parkId } = this._resolveParkContext(parkPartnerId);
        
        let firstTrySuccess = false;
        let balance = null;
        let blockedBalance = '0';
        let firstTryError429 = false;
        let firstTryErrorMsg = '';

        try {
            console.log(`[Yandex API] Bakiye sorgulanıyor (driver-profiles/list): Sürücü=${driverId}`);
            const response = await http.post(
                '/v1/parks/driver-profiles/list',
                {
                    query: {
                        park: {
                            id: parkId,
                            driver_profile: {
                                id: [driverId]
                            }
                        }
                    },
                    fields: {
                        account: ['balance']
                    },
                    limit: 1
                },
                {
                    headers: { 'X-Park-ID': parkId }
                }
            );

            const profiles = response.data?.driver_profiles || [];
            if (profiles.length > 0) {
                balance = profiles[0].accounts?.[0]?.balance;
                if (balance !== undefined && balance !== null) {
                    firstTrySuccess = true;
                    balance = String(balance);
                } else {
                    firstTryErrorMsg = 'driver-profiles response accounts/balance empty';
                }
            } else {
                firstTryErrorMsg = 'driver-profiles response profiles empty';
            }
        } catch (error) {
            const status = error.response?.status;
            if (status === 429) {
                firstTryError429 = true;
            }
            firstTryErrorMsg = error.response?.data?.message || error.message;
            console.warn(`[Yandex API] Sürücü bakiye sorgusu başarısız (driver-profiles/list): Sürücü=${driverId}, Hata Kodu=${status || 'Bilinmiyor'}, Hata=${firstTryErrorMsg}. Yedek sorgu denenecek.`);
        }

        if (firstTrySuccess) {
            // Çekim sonrası kilit kontrolü: Yandex API henüz kendi bakiyesini güncellemediyse (stale data), kilitli bakiyeyi koru
            if (cached && cached.isPostWithdrawOverride && now < cached.expiry) {
                const yandexVal = parseFloat(balance) || 0;
                const overrideVal = parseFloat(cached.balance) || 0;
                if (yandexVal > overrideVal) {
                    console.warn(`[Yandex API KORUMA] Sürücü=${driverId} için Yandex gecikmeli bakiye döndü (${balance} TL). Kilitli bakiye (${cached.balance} TL) korundu.`);
                    return { balance: cached.balance, blockedBalance: cached.blockedBalance };
                }
            }

            const result = {
                balance,
                blockedBalance: '0'
            };
            console.log(`[Yandex API] Bakiye sorgulama başarılı (driver-profiles/list): Sürücü=${driverId}, Bakiye=${result.balance} TL`);
            this._balanceCache.set(cacheKey, { ...result, expiry: now + this.BALANCE_TTL });
            if (this._balanceCache.size > 500) {
                const firstKey = this._balanceCache.keys().next().value;
                this._balanceCache.delete(firstKey);
            }
            return result;
        }

        // driver-profiles/list başarısız olduysa veya bakiye dönmediyse, blocked-balance ile şansımızı deneyelim:
        try {
            console.log(`[Yandex API] Bakiye sorgulanıyor (Yedek - blocked-balance): Sürücü=${driverId}`);
            const response = await http.get(
                '/v1/parks/contractors/blocked-balance',
                {
                    params: { contractor_id: driverId },
                    headers: { 'X-Park-ID': parkId }
                }
            );

            balance = response.data?.balance;
            
            if (balance !== undefined && balance !== null) {
                if (cached && cached.isPostWithdrawOverride && now < cached.expiry) {
                    const yandexVal = parseFloat(balance) || 0;
                    const overrideVal = parseFloat(cached.balance) || 0;
                    if (yandexVal > overrideVal) {
                        console.warn(`[Yandex API KORUMA] Sürücü=${driverId} için Yandex (yedek) gecikmeli bakiye döndü (${balance} TL). Kilitli bakiye (${cached.balance} TL) korundu.`);
                        return { balance: cached.balance, blockedBalance: cached.blockedBalance };
                    }
                }

                const result = {
                    balance: String(balance),
                    blockedBalance: '0'
                };
                console.log(`[Yandex API] Bakiye sorgulama başarılı (blocked-balance): Sürücü=${driverId}, Bakiye=${result.balance} TL`);
                this._balanceCache.set(cacheKey, { ...result, expiry: now + this.BALANCE_TTL });
                if (this._balanceCache.size > 500) {
                    const firstKey = this._balanceCache.keys().next().value;
                    this._balanceCache.delete(firstKey);
                }
                return result;
            } else {
                throw new Error('blocked-balance response balance empty');
            }
        } catch (error) {
            const status = error.response?.status;
            const errorMsg = error.response?.data?.message || error.message;
            console.error(`[Yandex API HATA] Yedek bakiye sorgusu da başarısız oldu: Sürücü=${driverId}, Hata Kodu=${status || 'Bilinmiyor'}, Hata=${errorMsg}`);

            // Eğer ilk istek veya ikinci istekten biri 429 rate-limit hatası aldıysa, rate limit kalkanını çalıştır
            const isAny429 = firstTryError429 || (status === 429);
            
            if (isAny429) {
                const fallback = cached
                    ? { balance: cached.balance, blockedBalance: cached.blockedBalance }
                    : { balance: '0', blockedBalance: '0' };
                
                this._balanceCache.set(cacheKey, { ...fallback, expiry: now + 10 * 60 * 1000, isRateLimited: true });
                console.warn(`[Yandex API KORUMA] Sürücü=${driverId} için 10 dakika istek kalkanı (Rate Limit - Hata Kodu: 429) aktif edildi.`);
                return fallback;
            }

            return null;
        }
    }

    /**
     * Belirli bir sürücü için bakiye önbelleğini temizler veya yeni bakiyeyi kilitler
     * @param {string} driverId
     * @param {string} [parkPartnerId]
     * @param {number|string|null} [knownNewBalance] - Çekim sonrası bilinen kalan net bakiye (örn. 0)
     */
    invalidateBalanceCache(driverId, parkPartnerId, knownNewBalance = null) {
        const cacheKey = `${driverId}:${parkPartnerId || 'default'}`;
        if (knownNewBalance !== null && knownNewBalance !== undefined) {
            const newBalStr = String(Math.max(0, parseFloat(knownNewBalance) || 0));
            this._balanceCache.set(cacheKey, {
                balance: newBalStr,
                blockedBalance: '0',
                expiry: Date.now() + 15 * 60 * 1000, // 15 dakika kilit
                isPostWithdrawOverride: true
            });
            console.log(`[Yandex API] Sürücü=${driverId} için çekim sonrası bakiye kilitlendi: ${newBalStr} TL (15 dk)`);
        } else {
            this._balanceCache.delete(cacheKey);
        }
    }

    /**
     * Sürücü bakiyesinden kesinti yapar — Global Throttle üzerinden geçer.
     * PaymentService bu metodu kullanarak Yandex rate limit bütçesini korur.
     *
     * @param {string} driverId - Yandex sürücü profil ID
     * @param {string} amount   - Kesilecek tutar (negatif string: "-1216.7")
     * @param {string} parkPartnerId - Park UUID
     * @param {string} description - İşlem açıklaması
     * @returns {Promise<Object>}
     */
    async deductBalance(driverId, amount, parkPartnerId, description = 'Para çekimi') {
        const { http, parkId } = this._resolveParkContext(parkPartnerId);
        const crypto = require('crypto');
        const idempotencyToken = crypto.randomBytes(16).toString('hex');

        const body = {
            park_id: parkId,
            driver_profile_id: driverId,
            category_id: 'partner_service_manual',
            amount: String(amount),
            description
        };

        // Global throttle kuyruğundan geçir
        const resp = await this._throttledYandexRequest(() =>
            http.post(
                '/v2/parks/driver-profiles/transactions',
                body,
                {
                    headers: {
                        'X-Park-ID': parkId,
                        'X-Idempotency-Token': idempotencyToken,
                    },
                    timeout: 30000
                }
            )
        );
        return resp.data;
    }


    /**
     * Araç detaylarını getirir
     * GET /v2/parks/vehicles/car
     */
    async getCarDetails(vehicleId, parkPartnerId) {
        const { http, parkId } = this._resolveParkContext(parkPartnerId);
        try {
            const response = await http.get(
                '/v2/parks/vehicles/car',
                {
                    params: { vehicle_id: vehicleId },
                    headers: { 'X-Park-ID': parkId }
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
    async getCarsList(textSearch = '', parkPartnerId) {
        const { http, parkId } = this._resolveParkContext(parkPartnerId);
        const allCars = [];
        let offset = 0;
        const limit = 1000;

        try {
            while (true) {
                const body = {
                    query: {
                        park: { id: parkId },
                        text: (textSearch || '').trim()
                    },
                    fields: {
                        car: ['id', 'brand', 'model', 'year', 'number', 'status', 'color']
                    },
                    limit,
                    offset
                };

                const response = await http.post(
                    '/v1/parks/cars/list',
                    body,
                    { headers: { 'X-Park-ID': parkId } }
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
    async findCarByPlate(plate, parkPartnerId) {
        const trimmed = (plate || '').trim().toUpperCase().replace(/\s/g, '');
        if (!trimmed || trimmed.length < 3) return null;

        const cars = await this.getCarsList(trimmed, parkPartnerId);

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
    async getDriverWorkRules(parkPartnerId) {
        const { http, parkId } = this._resolveParkContext(parkPartnerId);
        try {
            const response = await http.get(
                '/v1/parks/driver-work-rules',
                { params: { park_id: parkId } }
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
    async createDriverProfile(data, parkPartnerId) {
        const { http, parkId } = this._resolveParkContext(parkPartnerId);
        let workRuleId = config.yandexFleet.workRuleId;
        if (!workRuleId) {
            const rules = await this.getDriverWorkRules(parkPartnerId);
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
            const response = await http.post(
                '/v2/parks/contractors/driver-profile',
                body,
                {
                    headers: {
                        'X-Park-ID': parkId,
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
    async bindCarToDriver(driverId, carId, parkPartnerId) {
        const { http, parkId } = this._resolveParkContext(parkPartnerId);
        try {
            await http.put(
                '/v1/parks/driver-profiles/car-bindings',
                {},
                {
                    params: {
                        park_id: parkId,
                        driver_profile_id: driverId,
                        car_id: carId
                    },
                    headers: { 'X-Park-ID': parkId }
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
    async createCarAndBind(plate, brand, model, year, driverId, parkPartnerId) {
        const trimmedPlate = (plate || '').trim().toUpperCase();
        const body = {
            vehicle_specifications: {
                brand: (brand || '').trim(),
                model: (model || '').trim(),
                year: parseInt(year, 10) || new Date().getFullYear(),
                color: DEFAULT_NEW_CAR_COLOR,
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

        const { http, parkId } = this._resolveParkContext(parkPartnerId);
        try {
            const response = await http.post(
                '/v2/parks/vehicles/car',
                body,
                {
                    headers: {
                        'X-Park-ID': parkId,
                        // ✅ OPT-5: crypto top-level
                        'X-Idempotency-Token': crypto.randomBytes(16).toString('hex')
                    }
                }
            );

            const vehicleId = response.data?.vehicle_id;
            if (!vehicleId) {
                throw new Error('Araç oluşturuldu ancak ID alınamadı.');
            }

            await this.bindCarToDriver(driverId, vehicleId, parkPartnerId);
            return { vehicleId, plate: trimmedPlate, brand, model, year };
        } catch (error) {
            const msg = error.response?.data?.message || error.message;
            console.error('[YandexFleetApi] Araç oluşturma hatası:', msg);
            throw new Error(msg);
        }
    }

    /**
     * Tek bir sürücünün profil ve araç detaylarını Yandex'ten çeker
     */
    async getDriverProfile(driverId, parkPartnerId) {
        const { http, parkId } = this._resolveParkContext(parkPartnerId);
        try {
            const response = await http.post(
                '/v1/parks/driver-profiles/list',
                {
                    query: {
                        park: {
                            id: parkId,
                            driver_profile: {
                                id: [driverId]
                            }
                        }
                    },
                    fields: {
                        account: ['balance'],
                        car: ['brand', 'model', 'number', 'year', 'color', 'id'],
                        driver_profile: ['first_name', 'last_name', 'phones', 'id']
                    },
                    limit: 1
                }
            );

            const profiles = response.data?.driver_profiles || [];
            if (profiles.length === 0) return null;
            return profiles[0];
        } catch (error) {
            console.error(`[YandexFleetApi] Tekil sürücü profili çekilirken hata (${driverId}):`, error.response?.data || error.message);
            return null;
        }
    }





}

module.exports = new YandexFleetApi();
