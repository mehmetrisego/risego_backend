const axios = require('axios');
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
        this.headers = {
            'X-Client-ID': config.yandexFleet.clientId,
            'X-API-Key': config.yandexFleet.apiKey,
            'Content-Type': 'application/json',
            'Accept-Language': 'tr'
        };
        this.parkId = config.yandexFleet.partnerId;
    }

    /**
     * Sürücü profillerini listeler (ContractorProfiles)
     * POST /v1/parks/driver-profiles/list
     */
    async getDriverProfiles() {
        const allDrivers = [];
        let offset = 0;
        const limit = 1000;
        let hasMore = true;

        while (hasMore) {
            try {
                const response = await axios.post(
                    `${this.baseUrl}/v1/parks/driver-profiles/list`,
                    {
                        query: {
                            park: {
                                id: this.parkId
                            }
                        },
                        fields: {
                            account: ['balance'],
                            car: ['brand', 'model', 'number', 'year', 'color'],
                            driver_profile: [
                                'first_name',
                                'last_name',
                                'phones',
                                'id'
                            ]
                        },
                        limit: limit,
                        offset: offset,
                        sort_order: [
                            {
                                direction: 'asc',
                                field: 'driver_profile.created_date'
                            }
                        ]
                    },
                    { headers: this.headers }
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
     * Belirli bir sürücünün yolculuk sayısını getirir (cursor-based pagination)
     * POST /v1/parks/orders/list
     * API yanıtında total alanı yok; cursor ile sayfalama yapılmalı
     * @param {string} driverId
     * @param {string} period - 'daily' | 'weekly' | 'monthly' | 'all'
     */
    async getDriverOrderCount(driverId, period = 'all') {
        const from = this._getPeriodStartDate(period);
        const to = new Date().toISOString();
        const pageLimit = 500;
        let totalCount = 0;
        let cursor = undefined;

        try {
            while (true) {
                const requestBody = {
                    query: {
                        park: {
                            id: this.parkId,
                            driver_profile: {
                                id: driverId
                            },
                            order: {
                                booked_at: {
                                    from: from,
                                    to: to
                                },
                                statuses: ['complete']
                            }
                        }
                    },
                    limit: pageLimit
                };

                if (cursor) {
                    requestBody.cursor = cursor;
                }

                const response = await axios.post(
                    `${this.baseUrl}/v1/parks/orders/list`,
                    requestBody,
                    { headers: this.headers }
                );

                const orders = response.data.orders || [];
                totalCount += orders.length;

                const nextCursor = response.data.cursor;
                if (orders.length < pageLimit || !nextCursor || nextCursor === '') {
                    break;
                }

                cursor = nextCursor;
            }

            return totalCount;
        } catch (error) {
            const errorMsg = error.response?.data?.message || error.response?.data || error.message;
            if (error.response?.status === 429 || String(errorMsg).includes('Limit exceeded')) {
                await new Promise(resolve => setTimeout(resolve, 1000));
                try {
                    const retryBody = {
                        query: {
                            park: {
                                id: this.parkId,
                                driver_profile: { id: driverId },
                                order: {
                                    booked_at: { from, to },
                                    statuses: ['complete']
                                }
                            }
                        },
                        limit: pageLimit
                    };
                    const retryResponse = await axios.post(
                        `${this.baseUrl}/v1/parks/orders/list`,
                        retryBody,
                        { headers: this.headers }
                    );
                    return (retryResponse.data.orders || []).length;
                } catch (retryError) {
                    console.error(`[YandexFleetApi] Tekrar denemede de hata: ${retryError.response?.data?.message || retryError.message}`);
                    return 0;
                }
            }
            console.error(`[YandexFleetApi] Sürücü ${driverId} siparişleri çekilirken hata:`, errorMsg);
            return 0;
        }
    }

    /**
     * Sürücünün bakiyesini dedicated endpoint ile getirir
     * GET /v1/parks/contractors/blocked-balance
     * @param {string} driverId
     */
    async getDriverBalance(driverId) {
        try {
            const response = await axios.get(
                `${this.baseUrl}/v1/parks/contractors/blocked-balance`,
                {
                    params: { contractor_id: driverId },
                    headers: {
                        'X-Client-ID': config.yandexFleet.clientId,
                        'X-API-Key': config.yandexFleet.apiKey,
                        'X-Park-ID': this.parkId,
                        'Accept-Language': 'tr'
                    }
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
     * @param {string} vehicleId
     */
    async getCarDetails(vehicleId) {
        try {
            const response = await axios.get(
                `${this.baseUrl}/v2/parks/vehicles/car`,
                {
                    params: { vehicle_id: vehicleId },
                    headers: {
                        'X-Client-ID': config.yandexFleet.clientId,
                        'X-API-Key': config.yandexFleet.apiKey,
                        'X-Park-ID': this.parkId,
                        'Accept-Language': 'tr'
                    }
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
     * @param {string} [textSearch] - Plaka veya araç bilgisi ile arama
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

                const response = await axios.post(
                    `${this.baseUrl}/v1/parks/cars/list`,
                    body,
                    {
                        headers: {
                            ...this.headers,
                            'X-Park-ID': this.parkId
                        }
                    }
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
     * Plaka ile araç arar (sistemde kayıtlı mı)
     * @param {string} plate - Plaka numarası
     * @returns {Object|null} Bulunan araç bilgisi veya null
     */
    async findCarByPlate(plate) {
        const trimmed = (plate || '').trim().toUpperCase().replace(/\s/g, '');
        if (!trimmed || trimmed.length < 3) return null;

        const cars = await this.getCarsList(trimmed);

        const found = cars.find(c => {
            const carPlate = (c.number || '').trim().toUpperCase().replace(/\s/g, '');
            return carPlate === trimmed || carPlate.replace(/\s/g, '') === trimmed;
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
     * Çalışma kurallarını getirir (work_rule_id için)
     * GET /v1/parks/driver-work-rules
     */
    async getDriverWorkRules() {
        try {
            const response = await axios.get(
                `${this.baseUrl}/v1/parks/driver-work-rules`,
                {
                    params: { park_id: this.parkId },
                    headers: this.headers
                }
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

        const idempotencyToken = require('crypto').randomBytes(16).toString('hex');
        const headers = {
            ...this.headers,
            'X-Park-ID': this.parkId,
            'X-Idempotency-Token': idempotencyToken
        };

        try {
            const response = await axios.post(
                `${this.baseUrl}/v2/parks/contractors/driver-profile`,
                body,
                { headers }
            );
            const contractorProfileId = response.data?.contractor_profile_id;
            if (!contractorProfileId) {
                throw new Error('Sürücü oluşturuldu ancak profil ID alınamadı.');
            }
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
            const response = await axios.put(
                `${this.baseUrl}/v1/parks/driver-profiles/car-bindings`,
                {},
                {
                    params: {
                        park_id: this.parkId,
                        driver_profile_id: driverId,
                        car_id: carId
                    },
                    headers: {
                        ...this.headers,
                        'X-Park-ID': this.parkId
                    }
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
            const response = await axios.post(
                `${this.baseUrl}/v2/parks/vehicles/car`,
                body,
                {
                    headers: {
                        'X-Client-ID': config.yandexFleet.clientId,
                        'X-API-Key': config.yandexFleet.apiKey,
                        'X-Park-ID': this.parkId,
                        'X-Idempotency-Token': require('crypto').randomBytes(16).toString('hex'),
                        'Content-Type': 'application/json',
                        'Accept-Language': 'tr'
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
     * @param {string} vehicleId
     * @param {string} newPlate - Yeni plaka numarası
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
            await axios.put(
                `${this.baseUrl}/v2/parks/vehicles/car`,
                updateBody,
                {
                    params: { vehicle_id: vehicleId },
                    headers: {
                        'X-Client-ID': config.yandexFleet.clientId,
                        'X-API-Key': config.yandexFleet.apiKey,
                        'X-Park-ID': this.parkId,
                        'Content-Type': 'application/json',
                        'Accept-Language': 'tr'
                    }
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
     * Aylık sıralama tablosu: park genelinde tüm siparişleri bulk çeker,
     * sürücü başına sayar, profil isimleriyle eşleştirir.
     * 30 dakika cache'lenir. Her ay otomatik sıfırlanır.
     */
    async getLeaderboardData() {
        if (this._leaderboardCache && Date.now() < this._leaderboardExpiry) {
            return this._leaderboardCache;
        }

        if (this._leaderboardPending) {
            return this._leaderboardPending;
        }

        this._leaderboardPending = this._fetchLeaderboard();
        try {
            const result = await this._leaderboardPending;
            return result;
        } finally {
            this._leaderboardPending = null;
        }
    }

    async _fetchLeaderboard() {

        const profiles = await this.getDriverProfiles();
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

        const now = new Date();
        const monthStart = new Date(now.getFullYear(), now.getMonth(), 1);
        const from = monthStart.toISOString();
        const to = now.toISOString();

        let cursor = undefined;
        const pageLimit = 500;
        let totalOrders = 0;
        let pageNum = 0;

        while (true) {
            try {
                const requestBody = {
                    query: {
                        park: {
                            id: this.parkId,
                            order: {
                                booked_at: { from, to },
                                statuses: ['complete']
                            }
                        }
                    },
                    limit: pageLimit
                };
                if (cursor) requestBody.cursor = cursor;

                const response = await axios.post(
                    `${this.baseUrl}/v1/parks/orders/list`,
                    requestBody,
                    { headers: this.headers }
                );

                const orders = response.data.orders || [];
                pageNum++;
                totalOrders += orders.length;

                orders.forEach(order => {
                    const driverId = order.driver?.id || order.driver_profile?.id;
                    if (driverId && driverMap[driverId]) {
                        driverMap[driverId].tripCount++;
                    } else if (driverId) {
                        driverMap[driverId] = { id: driverId, initials: '?.', tripCount: 1 };
                    }
                });


                const nextCursor = response.data.cursor;
                if (orders.length < pageLimit || !nextCursor || nextCursor === '') {
                    break;
                }
                cursor = nextCursor;
            } catch (error) {
                if (error.response?.status === 429) {
                    await new Promise(r => setTimeout(r, 1000));
                    continue;
                }
                console.error('[YandexFleetApi] Sipariş çekilirken hata:', error.response?.data || error.message);
                break;
            }
        }

        const drivers = Object.values(driverMap).filter(d => d.tripCount > 0);
        drivers.sort((a, b) => b.tripCount - a.tripCount);
        drivers.forEach((d, i) => { d.rank = i + 1; });

        this._leaderboardCache = { drivers, totalDrivers: Object.keys(driverMap).length };
        this._leaderboardExpiry = Date.now() + 30 * 60 * 1000;
        return this._leaderboardCache;
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
     * Park genelinde tüm siparişleri çekip sürücü başına sayar (bulk - tek seferde)
     * @param {string} period - 'daily' | 'weekly' | 'monthly' | 'all'
     * @returns {Object} { driverId: count }
     */
    async _fetchOrderCountsByDriver(period = 'all') {
        const from = this._getPeriodStartDate(period);
        const to = new Date().toISOString();
        const pageLimit = 500;
        const countMap = {};
        let cursor = undefined;

        while (true) {
            try {
                const requestBody = {
                    query: {
                        park: {
                            id: this.parkId,
                            order: {
                                booked_at: { from, to },
                                statuses: ['complete']
                            }
                        }
                    },
                    limit: pageLimit
                };
                if (cursor) requestBody.cursor = cursor;

                const response = await axios.post(
                    `${this.baseUrl}/v1/parks/orders/list`,
                    requestBody,
                    { headers: this.headers }
                );

                const orders = response.data.orders || [];
                orders.forEach(order => {
                    const driverId = order.driver?.id || order.driver_profile?.id;
                    if (driverId) {
                        countMap[driverId] = (countMap[driverId] || 0) + 1;
                    }
                });

                const nextCursor = response.data.cursor;
                if (orders.length < pageLimit || !nextCursor || nextCursor === '') {
                    break;
                }
                cursor = nextCursor;
            } catch (error) {
                if (error.response?.status === 429) {
                    await new Promise(r => setTimeout(r, 1000));
                    continue;
                }
                console.error('[YandexFleetApi] Sipariş çekilirken hata:', error.response?.data?.message || error.message);
                break;
            }
        }

        return countMap;
    }

    /**
     * Tüm sürücülerin bilgilerini (telefon, araç, yolculuk sayısı) toplar
     * Leaderboard mantığı: tüm siparişler tek seferde çekilir, sürücü başına sayılır
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
     * Sadece sürücü profillerini çeker (yolculuk sayısı olmadan - hızlı mod)
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
