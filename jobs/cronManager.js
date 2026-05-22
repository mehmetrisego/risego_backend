const leaderboardService = require('../services/leaderboardService');
const uptStatusService   = require('../services/uptStatusService');
const systemService      = require('../services/systemService');

// ─── Gece Sync Durumu ──────────────────────────────────────────────────
// TZ=Europe/Istanbul → new Date().getHours() doğrudan İstanbul saati döner.
// 06:00–07:00 → bakım penceresi + delta sync
// 07:00       → bakım biter
// 08:00       → hasRunToday sıfırlanır (ertesi gece için)

let _hasRunToday       = false;
let _nightSyncScheduler = null;

function _checkNightWindow() {
    const h = new Date().getHours();
    const m = new Date().getMinutes();

    // 06:XX — bakım başlat + sync tetikle (günde bir kez)
    if (h === 6 && !_hasRunToday) {
        _hasRunToday = true;
        console.log('[NightSync] ⏰ 06:00 TR — bakım penceresi açılıyor, delta sync başlıyor...');
        systemService.setMaintenanceWindow(true);
        leaderboardService.runNightlySync().catch(err => {
            console.error('[NightSync] ❌ Gece delta sync hatası:', err.message);
        });
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
    // 1. LeaderboardService ilk sync (server start)
    leaderboardService.startCron().catch(err => {
        console.error('[CronManager] LeaderboardService başlatma hatası:', err.message);
    });

    // 2. UPT durum takip (her 5 dk)
    global._paymentCheckCron = setInterval(async () => {
        try {
            await uptStatusService.checkPendingPayments();
            await uptStatusService.syncRefundsFromBank();
        } catch (err) {
            console.error('[CronManager] UptStatus cron hatası:', err.message);
        }
    }, 5 * 60 * 1000);

    // İlk UPT check — restart sonrası bekleyenleri yakala
    setTimeout(async () => {
        try {
            await uptStatusService.checkPendingPayments();
            await uptStatusService.syncRefundsFromBank();
        } catch (err) {
            console.error('[CronManager] UptStatus ilk çalışma hatası:', err.message);
        }
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
            leaderboardService.runNightlySync().catch(err => {
                console.error('[NightSync] Başlangıç gece sync hatası:', err.message);
            });
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
    if (leaderboardService && typeof leaderboardService.stopCron === 'function') {
        leaderboardService.stopCron();
    }
    if (global._paymentCheckCron) {
        clearInterval(global._paymentCheckCron);
        global._paymentCheckCron = null;
    }
    if (_nightSyncScheduler) {
        clearInterval(_nightSyncScheduler);
        _nightSyncScheduler = null;
    }
    systemService.setMaintenanceWindow(false);
    console.log('[CronManager] Tüm periyodik görevler durduruldu.');
}

module.exports = { startAllCrons, stopAllCrons };
