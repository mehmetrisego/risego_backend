module.exports = {
  apps: [{
    name: 'risego-backend',
    script: 'server.js',

    // ─── Log Ayarları ────────────────────────────────────────
    time: false, // Zaman damgasını merkezi logger ekler; çift tarih oluşmasını önler
    error_file: '~/.pm2/logs/risego-backend-error.log',
    out_file: '~/.pm2/logs/risego-backend-out.log',
    merge_logs: true,

    // ─── Yeniden Başlatma Politikası ─────────────────────────
    restart_delay: 3000,  // Çökünce 3 saniye bekle (RAM'in nefes alması için)
    max_restarts: 10,     // 10 üst üste çökme sonrası durdur (sonsuz döngüyü önle)
    min_uptime: '30s',    // 30 saniyeden kısa yaşayan çalıştırmalar "çökme" sayılır

    // ─── Ortam Değişkenleri ───────────────────────────────────
    env: {
      NODE_ENV: 'production',
      DEVMODE: 'disable',
      ADMIN_SESSION_TTL_MS: '43200000',
      TZ: 'Europe/Istanbul',
      LOG_LEVEL: 'info',
      LOG_STACK: 'true',
      LOG_DEDUPE_WINDOW_MS: '60000'
    }
  }]
};
