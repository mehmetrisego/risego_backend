-- 014_payment_logs_status.sql
-- payment_logs tablosuna banka durum takibi ve iade sebebi alanları eklenir
-- status değerleri artık şunlardır:
--   'pending_bank'   → Banka sıraya aldı, nihai sonuç bekleniyor
--   'success'        → TR010/011/012 geldi, para gerçekten ulaştı
--   'bank_returned'  → Banka iade etti, Yandex'e para geri yüklendi
--   'error'          → Sistem/API hatası
--   'refunded'       → Yandex'e manuel/otomatik iade (eski fallback)

ALTER TABLE payment_logs
  ADD COLUMN IF NOT EXISTS bank_status_code VARCHAR(20),
  ADD COLUMN IF NOT EXISTS bank_status_checked_at TIMESTAMP WITH TIME ZONE,
  ADD COLUMN IF NOT EXISTS return_reason_code VARCHAR(10),
  ADD COLUMN IF NOT EXISTS yandex_refund_at TIMESTAMP WITH TIME ZONE;

-- Bekleyen kayıtları hızlı bulmak için index
CREATE INDEX IF NOT EXISTS idx_payment_logs_pending
  ON payment_logs(status, created_at)
  WHERE status = 'pending_bank';
