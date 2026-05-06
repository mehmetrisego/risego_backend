-- 000_mark_applied.sql
-- Bu dosya schema_migrations tablosu oluşturulmadan önce çalışan migration'ları
-- "zaten uygulandı" olarak işaretler. Veriler korunur, tablolar yeniden oluşturulmaz.
-- NOT: runMigrations.js schema_migrations'ı CREATE TABLE IF NOT EXISTS ile oluşturur,
--       ardından bu dosya çalışır ve mevcut dosyaları kayıtlar.

INSERT INTO schema_migrations (filename) VALUES
    ('001_initial.sql'),
    ('002_orders.sql'),
    ('003_sessions_park_partner.sql'),
    ('004_orders_park_partner.sql'),
    ('005_campaigns_park_partner.sql'),
    ('006_driver_bank_accounts.sql'),
    ('007_driver_profiles.sql')
ON CONFLICT (filename) DO NOTHING;
