const { parseUptBalance } = require('./uptBalanceParser');
const THRESHOLD = 5000;
// Islem-basi havuz bakiye on-kontrolu icin guvenlik tamponu (yapilandirilabilir).
const BALANCE_BUFFER_TL = Math.max(0, Number(process.env.UPT_BALANCE_BUFFER_TL || 250));

function observeBalance(state, balance, observedAt, parks) {
    if (observedAt <= (state.guard.lastObservationAt || 0)) return;
    state.guard.lastObservationAt = observedAt;
    if (balance >= THRESHOLD) {
        // Rearm for a new low-balance incident. Never reopen a city automatically.
        state.guard.armed = true;
    } else if (state.guard.armed) {
        if (!parks.length) throw new Error('Çekim güvenliği için park listesi bulunamadı.');
        state.cities = [...new Set([...state.cities, ...parks])];
        state.guard.armed = false;
        state.guard.revision++;
        state.guard.lastAutomaticStop = { balance, at: new Date(observedAt).toISOString() };
    }
}

function createSafetyService({ settings, upt, parkIds, now = Date.now }) {
    let cached, pending;
    async function balanceSample(force) {
        if (pending) return pending;
        if (!force && cached && now() - cached.observedAt < 15000) return cached;
        pending = (async () => {
            const observedAt = now();
            const result = await upt.getUptBalance();
            const balance = result.success ? parseUptBalance(result.tryBalanceRaw) : null;
            if (balance === null) {
                cached = null;
                throw new Error('UPT bakiyesi doğrulanamadı. Lütfen daha sonra tekrar deneyiniz.');
            }
            cached = { result, balance, observedAt };
            return cached;
        })();
        try { return await pending; }
        catch (error) { cached = null; throw error; }
        finally { pending = null; }
    }
    async function checkBalance(force = false) {
        const sample = await balanceSample(force);
        const state = await settings.update(state => observeBalance(state, sample.balance, sample.observedAt, parkIds()));
        return { result: sample.result, state };
    }
    async function assertAllowed(parkId) {
        // Check persisted closures first; closed cities don't generate bank traffic.
        let state = await settings.read();
        if (!state.cities.includes(parkId)) state = (await checkBalance()).state;
        if (state.cities.includes(parkId)) {
            const error = new Error('Para çekme işlemleri bulunduğunuz şehir için askıya alınmıştır. Yönetici onayı bekleniyor.');
            error.status = 503;
            throw error;
        }
    }
    // Havuz (Uption) bakiyesi bu tutari karsiliyor mu? Karsilamazsa HICBIR istek atilmaz.
    // Boylece "bakiye bulunmamasi" kaynakli TR000 askida islemler olusmaz.
    async function assertSufficientBalance(amount) {
        const need = Number(amount);
        if (!Number.isFinite(need) || need <= 0) {
            const error = new Error('Gecersiz tutar.'); error.status = 400; throw error;
        }
        let sample;
        try {
            sample = await balanceSample(true); // taze (force) havuz bakiyesi
        } catch (e) {
            // fail-closed: havuz bakiyesi dogrulanamazsa cekim ALMA
            const error = new Error('Para cekme islemi su anda alinamiyor, lutfen birazdan tekrar deneyiniz.');
            error.status = 503; error.balanceUnavailable = true; throw error;
        }
        if (sample.balance < need + BALANCE_BUFFER_TL) {
            const error = new Error('Para cekme islemleri su anda gecici olarak alinamiyor. Lutfen daha sonra tekrar deneyiniz.');
            error.status = 503; error.insufficientPool = true; throw error;
        }
        return { pool: sample.balance };
    }
    async function saveCities(cities, revision) {
        const allowed = new Set(parkIds());
        if (!Array.isArray(cities) || cities.some(c => typeof c !== 'string' || !allowed.has(c))) {
            const error = new Error('Geçersiz şehir seçimi.'); error.status = 400; throw error;
        }
        return settings.update(state => {
            if (!Number.isInteger(revision) || state.guard.revision !== revision) {
                const error = new Error('Sistem durumu değişti. Pencereyi yeniden açıp şehirleri kontrol edin.');
                error.status = 409; throw error;
            }
            state.cities = [...new Set(cities)];
            state.guard.revision++;
        });
    }
    return { checkBalance, assertAllowed, assertSufficientBalance, saveCities, getState: () => settings.read() };
}

const service = createSafetyService({
    settings: require('../db/withdrawalSettings'),
    upt: require('./uptService'),
    parkIds: () => require('../config').getYandexParkSources().map(p => p.partnerId)
});
module.exports = { ...service, createSafetyService, observeBalance, THRESHOLD };
