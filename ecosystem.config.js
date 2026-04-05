module.exports = {
  apps: [{
    name: 'risego-backend',
    script: 'npm',
    args: 'start',

    // ─── Log Ayarları ────────────────────────────────────────
    log_date_format: 'YYYY-MM-DD HH:mm:ss', // Her log satırına tarih-saat damgası
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
      TZ: 'Europe/Istanbul'
    }
  }]
};
