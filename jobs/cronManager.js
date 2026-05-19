const leaderboardService = require('../services/leaderboardService');
const uptStatusService = require('../services/uptStatusService');

function startAllCrons() {
    // 1. Leaderboard Cron
    leaderboardService.startCron().catch(err => {
        console.error('[CronManager] LeaderboardService başlatma hatası:', err.message);
    });

    // 2. Uption İşlem Durum Takip Cron'u (her 5 dakikada bir)
    global._paymentCheckCron = setInterval(async () => {
        try {
            await uptStatusService.checkPendingPayments();
            await uptStatusService.syncRefundsFromBank();
        } catch (err) {
            console.error('[CronManager] UptStatus cron hatası:', err.message);
        }
    }, 5 * 60 * 1000);

    // Başlangıçta 5 sn sonra bir kez çalıştır (restart sonrası bekleyenleri yakala)
    setTimeout(async () => {
        try {
            await uptStatusService.checkPendingPayments();
            await uptStatusService.syncRefundsFromBank();
        } catch (err) {
            console.error('[CronManager] UptStatus ilk çalışma hatası:', err.message);
        }
    }, 5000);
    
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
    console.log('[CronManager] Tüm periyodik görevler durduruldu.');
}

module.exports = {
    startAllCrons,
    stopAllCrons
};
