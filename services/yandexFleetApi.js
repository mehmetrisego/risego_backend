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
        const limit = 300;
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

                console.log(`[YandexFleetApi] ${offset + drivers.length} / ${data.total} sürücü çekildi`);

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
                console.log(`[YandexFleetApi] Rate limit - 2 saniye bekleniyor...`);
                await new Promise(resolve => setTimeout(resolve, 2000));
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
            console.log(`[YandexFleetApi] Araç plakası güncellendi: ${vehicleId} -> ${newPlate}`);
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
            console.log('[YandexFleetApi] Leaderboard cache aktif.');
            return this._leaderboardCache;
        }

        if (this._leaderboardPending) {
            console.log('[YandexFleetApi] Leaderboard zaten yükleniyor, bekleniyor...');
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
        console.log('[YandexFleetApi] Aylık sıralama verisi çekiliyor...');

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
        console.log(`[YandexFleetApi] ${Object.keys(driverMap).length} sürücü profili yüklendi.`);

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

                if (pageNum === 1 && orders.length > 0) {
                    const sample = orders[0];
                    console.log(`[YandexFleetApi] Order yapısı: ${JSON.stringify(Object.keys(sample))}`);
                    if (sample.driver) console.log(`[YandexFleetApi] driver keys: ${JSON.stringify(Object.keys(sample.driver))}`);
                    if (sample.driver_profile) console.log(`[YandexFleetApi] driver_profile keys: ${JSON.stringify(Object.keys(sample.driver_profile))}`);
                }

                orders.forEach(order => {
                    const driverId = order.driver?.id || order.driver_profile?.id;
                    if (driverId && driverMap[driverId]) {
                        driverMap[driverId].tripCount++;
                    } else if (driverId) {
                        driverMap[driverId] = { id: driverId, initials: '?.', tripCount: 1 };
                    }
                });

                console.log(`[YandexFleetApi] Sayfa ${pageNum}: ${totalOrders} sipariş işlendi`);

                const nextCursor = response.data.cursor;
                if (orders.length < pageLimit || !nextCursor || nextCursor === '') {
                    break;
                }
                cursor = nextCursor;
            } catch (error) {
                if (error.response?.status === 429) {
                    console.log('[YandexFleetApi] Rate limit - 3 saniye bekleniyor...');
                    await new Promise(r => setTimeout(r, 3000));
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
        console.log(`[YandexFleetApi] Leaderboard hazır: ${drivers.length} aktif sürücü, ${totalOrders} sipariş (bu ay).`);
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
     * Tüm sürücülerin bilgilerini (telefon, araç, yolculuk sayısı) toplar
     * Yolculuk sayıları paralel olarak çekilir (hızlandırma için)
     */
    async getAllDriversInfo() {
        console.log('[YandexFleetApi] Sürücü profilleri çekiliyor...');
        const driverProfiles = await this.getDriverProfiles();
        console.log(`[YandexFleetApi] Toplam ${driverProfiles.length} sürücü bulundu.`);

        // Profilleri formatla
        const driversInfo = driverProfiles.map(p => this.formatDriverProfile(p));

        // Yolculuk sayılarını batch halinde çek (paralel, 5'er 5'er - rate limit koruması)
        const batchSize = 5;
        for (let i = 0; i < driversInfo.length; i += batchSize) {
            const batch = driversInfo.slice(i, i + batchSize);
            const promises = batch.map(driver =>
                this.getDriverOrderCount(driver.id)
            );

            const tripCounts = await Promise.all(promises);

            batch.forEach((driver, idx) => {
                driver.tripCount = tripCounts[idx];
            });

            console.log(`[YandexFleetApi] Yolculuk sayıları: ${Math.min(i + batchSize, driversInfo.length)} / ${driversInfo.length} sürücü tamamlandı`);

            // Rate limiting için bekleme (500ms)
            if (i + batchSize < driversInfo.length) {
                await new Promise(resolve => setTimeout(resolve, 500));
            }
        }

        return driversInfo;
    }

    /**
     * Sadece sürücü profillerini çeker (yolculuk sayısı olmadan - hızlı mod)
     */
    async getDriverProfilesFormatted() {
        console.log('[YandexFleetApi] Sürücü profilleri çekiliyor (hızlı mod)...');
        const driverProfiles = await this.getDriverProfiles();
        console.log(`[YandexFleetApi] Toplam ${driverProfiles.length} sürücü bulundu.`);

        return driverProfiles.map(p => {
            const info = this.formatDriverProfile(p);
            info.tripCount = 'N/A (hızlı mod)';
            return info;
        });
    }
}

module.exports = new YandexFleetApi();
