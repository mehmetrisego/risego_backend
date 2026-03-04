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
        this.parkId = config.yandexFleet.partnerId;
        this.headers = {
            'X-Client-ID': config.yandexFleet.clientId,
            'X-API-Key': config.yandexFleet.apiKey,
            'Content-Type': 'application/json',
            'Accept-Language': 'tr'
        };
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
     * 10 günlük dönem hesaplayıcı
     * 1-10, 11-20, 21-ay sonu şeklinde dönemler oluşturur
     * @returns {{ from: string, to: string, label: string }}
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
            // Ay sonunu hesapla
            periodEnd = new Date(year, month + 1, 0, 23, 59, 59, 999);
        }

        const monthNames = ['Ocak', 'Şubat', 'Mart', 'Nisan', 'Mayıs', 'Haziran',
            'Temmuz', 'Ağustos', 'Eylül', 'Ekim', 'Kasım', 'Aralık'];

        const label = `${periodStart.getDate()} - ${periodEnd.getDate()} ${monthNames[month]} ${year}`;

        return {
            from: periodStart.toISOString(),
            to: periodEnd.toISOString(),
            label
        };
    }

    /**
     * Önceki 10 günlük dönemi hesaplar (sonlanmış kampanya)
     * Örn: Şu an 11-20 Haziran ise → 1-10 Haziran döner
     * @returns {{ from: string, to: string, label: string }}
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
            // Şu an 1-10 arası → Önceki: geçen ay 21-son
            periodStart = new Date(year, month - 1, 21);
            periodEnd = new Date(year, month, 0, 23, 59, 59, 999);
            labelMonth = month - 1;
            labelYear = year;
            if (labelMonth < 0) {
                labelMonth = 11;
                labelYear = year - 1;
            }
        } else if (day <= 20) {
            // Şu an 11-20 arası → Önceki: 1-10
            periodStart = new Date(year, month, 1);
            periodEnd = new Date(year, month, 10, 23, 59, 59, 999);
            labelMonth = month;
            labelYear = year;
        } else {
            // Şu an 21-son arası → Önceki: 11-20
            periodStart = new Date(year, month, 11);
            periodEnd = new Date(year, month, 20, 23, 59, 59, 999);
            labelMonth = month;
            labelYear = year;
        }

        const label = `${periodStart.getDate()} - ${periodEnd.getDate()} ${monthNames[labelMonth]} ${labelYear}`;

        return {
            from: periodStart.toISOString(),
            to: periodEnd.toISOString(),
            label
        };
    }

    /**
     * Cache Isıtma (Server başlarken çağrılır)
     */
    async initiateCacheWarming() {
        console.log('[YandexFleetApi] Arka planda önyükleme (cache warming) başlatılıyor...');
        try {
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
     * Admin paneli için 10 günlük leaderboard: park genelinde siparişleri çeker,
     * sürücü başına sayar, profil isimleri (Ad Soyad) ile eşleştirir.
     * İlk 10 sürücüyü döner. 15 dakika cache'lenir. Stale-while-revalidate kullanır.
     * @param {boolean} [previousPeriod=false] - true ise sonlanmış önceki dönemi döner
     * @param {string} [customFrom=null] - İsteğe bağlı filtreleme için başlangıç tarihi
     * @param {string} [customTo=null] - İsteğe bağlı filtreleme için bitiş tarihi
     */
    async getAdminLeaderboardData(previousPeriod = false, customFrom = null, customTo = null) {
        if (customFrom && customTo) {
            const startDate = new Date(customFrom);
            const endDate = new Date(customTo);
            // Bitiş tarihini günün sonuna ayarla
            endDate.setHours(23, 59, 59, 999);

            const monthNames = ['Ocak', 'Şubat', 'Mart', 'Nisan', 'Mayıs', 'Haziran',
                'Temmuz', 'Ağustos', 'Eylül', 'Ekim', 'Kasım', 'Aralık'];
            const label = `${startDate.getDate()} ${monthNames[startDate.getMonth()]} ${startDate.getFullYear()} - ${endDate.getDate()} ${monthNames[endDate.getMonth()]} ${endDate.getFullYear()}`;

            const period = {
                from: startDate.toISOString(),
                to: endDate.toISOString(),
                label
            };

            // Özel filtreleme için cache kullanmadan direkt çek (skipCache = true)
            return await this._fetchAdminLeaderboard(period, false, true);
        }

        const period = previousPeriod ? this._getPrev10DayPeriod() : this._get10DayPeriod();
        const cacheKey = period.label;

        if (previousPeriod) {
            if (this._adminLeaderboardPrevCache && this._adminLeaderboardPrevCacheKey === cacheKey) {
                // Cache var, ancak süresi dolmuşsa arka planda yenile
                if (Date.now() >= this._adminLeaderboardPrevExpiry && !this._adminLeaderboardPrevPending) {
                    this._adminLeaderboardPrevPending = this._fetchAdminLeaderboard(period, true).finally(() => this._adminLeaderboardPrevPending = null);
                }
                return this._adminLeaderboardPrevCache; // Anında yanıt dön
            }
            if (this._adminLeaderboardPrevPending) return this._adminLeaderboardPrevPending;

            this._adminLeaderboardPrevPending = this._fetchAdminLeaderboard(period, true).finally(() => this._adminLeaderboardPrevPending = null);
            return this._adminLeaderboardPrevPending;
        }

        if (this._adminLeaderboardCache && this._adminLeaderboardCacheKey === cacheKey) {
            // Cache var, ancak süresi dolmuşsa arka planda yenile
            if (Date.now() >= this._adminLeaderboardExpiry && !this._adminLeaderboardPending) {
                this._adminLeaderboardPending = this._fetchAdminLeaderboard(period, false).finally(() => this._adminLeaderboardPending = null);
            }
            return this._adminLeaderboardCache; // Anında yanıt dön
        }
        if (this._adminLeaderboardPending) return this._adminLeaderboardPending;

        this._adminLeaderboardPending = this._fetchAdminLeaderboard(period, false).finally(() => this._adminLeaderboardPending = null);
        return this._adminLeaderboardPending;
    }

    /**
     * Admin leaderboard verisini çeker (10 günlük dönem, top 10, Ad Soyad)
     * @param {{ from: string, to: string, label: string }} period
     * @param {boolean} [isPrevious=false] - Önceki dönem cache'i için
     * @param {boolean} [skipCache=false] - Özel dönem için cache atla
     */
    async _fetchAdminLeaderboard(period, isPrevious = false, skipCache = false) {
        // Sürücü profillerini çek (Ad Soyad bilgisi için)
        const profiles = await this.getDriverProfiles();
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

        // Dönem içindeki siparişleri çek
        let cursor = undefined;
        const pageLimit = 500;
        let totalOrders = 0;
        let retries = 0;
        const MAX_RETRIES = 3;

        while (true) {
            try {
                const requestBody = {
                    query: {
                        park: {
                            id: this.parkId,
                            order: {
                                booked_at: { from: period.from, to: period.to },
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
                totalOrders += orders.length;

                orders.forEach(order => {
                    const driverId = order.driver?.id || order.driver_profile?.id;
                    if (driverId && driverMap[driverId]) {
                        driverMap[driverId].tripCount++;
                    } else if (driverId) {
                        driverMap[driverId] = { id: driverId, fullName: 'Bilinmeyen Sürücü', tripCount: 1 };
                    }
                });

                retries = 0;
                const nextCursor = response.data.cursor;
                if (orders.length < pageLimit || !nextCursor || nextCursor === '') {
                    break;
                }
                cursor = nextCursor;
            } catch (error) {
                if (error.response?.status === 429 && retries < MAX_RETRIES) {
                    retries++;
                    await new Promise(r => setTimeout(r, retries * 1000));
                    continue;
                }
                console.error('[YandexFleetApi] Admin leaderboard sipariş hatası:', error.response?.data || error.message);
                break;
            }
        }

        // Sıralama: en çok yolculuk yapan ilk 10
        const drivers = Object.values(driverMap).filter(d => d.tripCount > 0);
        drivers.sort((a, b) => b.tripCount - a.tripCount);
        const top10 = drivers.slice(0, 10).map((d, i) => ({ ...d, rank: i + 1 }));

        const result = {
            top10,
            periodLabel: period.label,
            totalOrders,
            totalDrivers: Object.keys(driverMap).length
        };

        // Cache: 15 dakika (mevcut / önceki dönem ayrı cache, özel dönem cache'lenmez)
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
     * Sürücü sıralama tablosu: park genelinde siparişleri çeker, sürücü başına sayar.
     * Admin paneli ile aynı 10 günlük dönem mantığını kullanır.
     * @param {boolean} [previousPeriod=false] - true ise sonlanmış önceki dönem
     * @param {string} [customFrom=null] - Özel filtreleme için başlangıç tarihi (YYYY-MM-DD)
     * @param {string} [customTo=null] - Özel filtreleme için bitiş tarihi (YYYY-MM-DD)
     * @returns {{ drivers, totalDrivers, totalOrders, periodLabel }}
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
            return await this._fetchLeaderboardForPeriod(period);
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
     * Belirli bir dönem için sürücü leaderboard verisini çeker (top 30, initials formatı)
     * @param {{ from: string, to: string, label: string }} period
     */
    async _fetchLeaderboardForPeriod(period) {
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

        let cursor = undefined;
        const pageLimit = 500;
        let totalOrders = 0;
        let retries = 0;
        const MAX_RETRIES = 3;

        while (true) {
            try {
                const requestBody = {
                    query: {
                        park: {
                            id: this.parkId,
                            order: {
                                booked_at: { from: period.from, to: period.to },
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
                totalOrders += orders.length;

                orders.forEach(order => {
                    const driverId = order.driver?.id || order.driver_profile?.id;
                    if (driverId && driverMap[driverId]) {
                        driverMap[driverId].tripCount++;
                    } else if (driverId) {
                        driverMap[driverId] = { id: driverId, initials: '?.', tripCount: 1 };
                    }
                });

                retries = 0;
                const nextCursor = response.data.cursor;
                if (orders.length < pageLimit || !nextCursor || nextCursor === '') {
                    break;
                }
                cursor = nextCursor;
            } catch (error) {
                if (error.response?.status === 429 && retries < MAX_RETRIES) {
                    retries++;
                    await new Promise(r => setTimeout(r, retries * 1000));
                    continue;
                }
                console.error('[YandexFleetApi] Sipariş çekilirken hata:', error.response?.data || error.message);
                break;
            }
        }

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
        let retries = 0;
        const MAX_RETRIES = 3;

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

                retries = 0;
                const nextCursor = response.data.cursor;
                if (orders.length < pageLimit || !nextCursor || nextCursor === '') {
                    break;
                }
                cursor = nextCursor;
            } catch (error) {
                if (error.response?.status === 429 && retries < MAX_RETRIES) {
                    retries++;
                    await new Promise(r => setTimeout(r, retries * 1000));
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
