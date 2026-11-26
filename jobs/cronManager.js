const config = require('../config');
const withdrawalSafety = require('../services/withdrawalSafetyService');
const leaderboardService = require('../services/leaderboardService');
const uptStatusService   = require('../services/uptStatusService');
const bankRetryService   = require('../services/bankRetryService');
const systemService      = require('../services/systemService');
const driverProfileSyncService = require('../services/driverProfileSyncService');
const yandexTransactionReconciliationService = require('../services/yandexTransactionReconciliationService');

// Gündüz periyodik delta sync ayarları (eksik yolculukları gün içinde telafi eder)
const DAYTIME_DELTA_ENABLED = String(process.env.YANDEX_DELTA_DAYTIME_ENABLED || 'true').toLowerCase() !== 'false';
const DAYTIME_DELTA_INTERVAL_MS = Math.max(10 * 60 * 1000, Number(process.env.YANDEX_DELTA_INTERVAL_MIN || 60) * 60 * 1000);

// ─── Gece Sync Durumu ──────────────────────────────────────────────────
// TZ=Europe/Istanbul → new Date().getHours() doğrudan İstanbul saati döner.
// 06:00–07:00 → bakım penceresi + delta sync
// 07:00       → bakım biter
// 08:00       → hasRunToday sıfırlanır (ertesi gece için)

let _balanceGuardTimer = null;
let _balanceGuardRunning = false;
let _paymentCheckRunning = false;
let _paymentInitialTimer = null;

async function checkWithdrawalSafety() {
    if (_balanceGuardRunning) return;
    _balanceGuardRunning = true;
    try { await withdrawalSafety.checkBalance(true); }
    catch (err) { console.error('[WithdrawalSafety] Bakiye kontrolü başarısız:', err.message); }
    finally { _balanceGuardRunning = false; }
}

async function _runPaymentChecks(source) {
    if (_paymentCheckRunning) {
        console.warn(`[CronManager] UptStatus ${source} çalışması atlandı; önceki çalışma hâlâ devam ediyor.`);
        return;
    }

    _paymentCheckRunning = true;
    try {
        await yandexTransactionReconciliationService.reconcilePendingTransactions();
        await uptStatusService.checkPendingPayments();
        await uptStatusService.syncRefundsFromBank();
    } catch (err) {
        console.error(`[CronManager] UptStatus ${source} hatası:`, err.message);
    } finally {
        _paymentCheckRunning = false;
    }
}

let _deltaCron = null;
let _daytimeDeltaRunning = false;
async function _runDaytimeDelta() {
    if (_daytimeDeltaRunning) return;
    if (systemService.isMaintenanceWindowActive()) return; // gece bakımıyla çakışmasın
    _daytimeDeltaRunning = true;
    try {
        console.log('[CronManager] Gündüz delta sync tetiklendi.');
        await leaderboardService.runNightlySync();
    } catch (err) {
        console.error('[CronManager] Gündüz delta sync hatası:', err.message);
    } finally {
        _daytimeDeltaRunning = false;
    }
}

let _reconcileFastRunning = false;
async function _runFastReconcile() {
    if (_reconcileFastRunning) return;
    _reconcileFastRunning = true;
    try {
        await yandexTransactionReconciliationService.reconcilePendingTransactions();
    } catch (err) {
        console.error('[CronManager] Hizli Yandex reconcile hatasi:', err.message);
    } finally {
        _reconcileFastRunning = false;
    }
}

let _hasRunToday       = false;
let _nightSyncScheduler = null;
let _nightMaintenanceRunning = false;

function _nightDeadline() {
    const deadline = new Date();
    deadline.setHours(6, 58, 0, 0);
    return deadline.getTime();
}

async function _runNightMaintenance() {
    if (_nightMaintenanceRunning) {
        console.warn('[NightSync] Önceki gece bakım çalışması hâlâ devam ediyor; yeni çalışma atlandı.');
        return;
    }
    _nightMaintenanceRunning = true;
    const deadlineAt = _nightDeadline();
    try {
        if (Date.now() >= deadlineAt) {
            console.warn('[NightSync] Bakım bitişine çok geç kalındı; profil senkronizasyonu ertesi gece devam edecek.');
            return;
        }
        console.log('[NightSync] 1/3 sürücü profil delta senkronizasyonu başlıyor...');
        await driverProfileSyncService.syncDeltas({ deadlineAt });

        if (Date.now() < deadlineAt) {
            console.log('[NightSync] 2/3 yolculuk delta senkronizasyonu başlıyor...');
            await leaderboardService.runNightlySync();
        }

        if (Date.now() < deadlineAt) {
            console.log('[NightSync] 3/3 sürücü profil tam denetimi kaldığı yerden devam ediyor...');
            await driverProfileSyncService.reconcile({ deadlineAt });
        }
        console.log('[NightSync] Gece bakım görevleri tamamlandı veya zaman bütçesine ulaşıldı.');
    } catch (error) {
        console.error('[NightSync] Gece bakım zinciri hatası:', error.message);
    } finally {
        _nightMaintenanceRunning = false;
    }
}

function _checkNightWindow() {
    const h = new Date().getHours();
    const m = new Date().getMinutes();

    // 06:XX — bakım başlat + sync tetikle (günde bir kez)
    if (h === 6 && !_hasRunToday) {
        _hasRunToday = true;
        console.log('[NightSync] ⏰ 06:00 TR — bakım penceresi açılıyor, delta sync başlıyor...');
        systemService.setMaintenanceWindow(true);
        void _runNightMaintenance();
    }

    // 07:00 — bakım kapat
    if (h === 7 && m === 0 && systemService.isMaintenanceWindowActive()) {
        console.log('[NightSync] ✅ 07:00 TR — bakım penceresi kapanıyor.');
        systemService.setMaintenanceWindow(false);
    }

    // 08:00 — flag sıfırla (ertesi gece çalışsın)
    if (h === 8) {
        _hasRunToday = false;
    }
}

function startAllCrons() {
    void checkWithdrawalSafety();
    if (_balanceGuardTimer) clearInterval(_balanceGuardTimer);
    _balanceGuardTimer = setInterval(checkWithdrawalSafety, 60 * 1000);
    // 1. LeaderboardService ilk sync (server start)
    leaderboardService.startCron().catch(err => {
        console.error('[CronManager] LeaderboardService başlatma hatası:', err.message);
    });

    // 2. UPT durum takip (her 5 dk)
    if (global._paymentCheckCron) clearInterval(global._paymentCheckCron);
    global._paymentCheckCron = setInterval(() => {
        void _runPaymentChecks('cron');
    }, 5 * 60 * 1000);

    // 2b. Hizli Yandex reconcile (takilan odemeleri cabuk bankaya aktar + esikte alarm)
    if (global._reconcileFastCron) clearInterval(global._reconcileFastCron);
    global._reconcileFastCron = setInterval(() => {
        void _runFastReconcile();
    }, config.alerts?.reconcileFastIntervalMs || 30000);

    // 2d. Banka adimi belirsiz kalan cekimler: 10 dk icinde 3 deneme, sonra admin karari (her 1 dk)
    if (global._bankRetryCron) clearInterval(global._bankRetryCron);
    global._bankRetryCron = setInterval(() => {
        void bankRetryService.runBankRetries();
    }, 60 * 1000);

    // 2c. Gündüz periyodik delta — eksik kalan yolculukları gün içinde telafi eder;
    // resumable (DB watermark'ından devam eder), bakım penceresinde atlanır.
    if (_deltaCron) clearInterval(_deltaCron);
    if (DAYTIME_DELTA_ENABLED) {
        _deltaCron = setInterval(() => { void _runDaytimeDelta(); }, DAYTIME_DELTA_INTERVAL_MS);
        console.log(`[CronManager] Gündüz delta sync etkin (her ${Math.round(DAYTIME_DELTA_INTERVAL_MS / 60000)} dk).`);
    }

    // İlk UPT check — restart sonrası bekleyenleri yakala
    if (_paymentInitialTimer) clearTimeout(_paymentInitialTimer);
    _paymentInitialTimer = setTimeout(() => {
        _paymentInitialTimer = null;
        void _runPaymentChecks('ilk çalışma');
    }, 5000);

    // 3. Gece sync scheduler — her dakika saat kontrol eder
    // Sunucu 06:00–07:00 arasında yeniden başladıysa bakımı hemen uygula
    const startHour = new Date().getHours();
    if (startHour === 6) {
        console.log('[NightSync] Sunucu 06:00–07:00 penceresinde başlatıldı — bakım aktif.');
        _hasRunToday = true;
        systemService.setMaintenanceWindow(true);
        // startCron ilk sync'ini tamamlasın, sonra delta çek
        setTimeout(() => {
            void _runNightMaintenance();
        }, 15000);
    } else if (startHour === 7) {
        // 07:XX'de başladı → sync bugün zaten yapıldı (ya da yapılmıyor), bakım kapalı
        _hasRunToday = true;
        systemService.setMaintenanceWindow(false);
    }

    _nightSyncScheduler = setInterval(_checkNightWindow, 60 * 1000);

    console.log('[CronManager] Tüm periyodik görevler başlatıldı.');
}

function stopAllCrons() {
    if (_balanceGuardTimer) clearInterval(_balanceGuardTimer);
    _balanceGuardTimer = null;
    if (leaderboardService && typeof leaderboardService.stopCron === 'function') {
        leaderboardService.stopCron();
    }
    if (global._paymentCheckCron) {
        clearInterval(global._paymentCheckCron);
        global._paymentCheckCron = null;
    }
    if (global._reconcileFastCron) {
        clearInterval(global._reconcileFastCron);
        global._reconcileFastCron = null;
    }
    if (_deltaCron) {
        clearInterval(_deltaCron);
        _deltaCron = null;
    }
    if (_paymentInitialTimer) {
        clearTimeout(_paymentInitialTimer);
        _paymentInitialTimer = null;
    }
    if (_nightSyncScheduler) {
        clearInterval(_nightSyncScheduler);
        _nightSyncScheduler = null;
    }
    systemService.setMaintenanceWindow(false);
    console.log('[CronManager] Tüm periyodik görevler durduruldu.');
}

module.exports = { startAllCrons, stopAllCrons };
