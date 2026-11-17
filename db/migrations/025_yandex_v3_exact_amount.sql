-- Idempotent retry, ilk POST gövdesindeki tutarı byte düzeyinde korumalıdır.
ALTER TABLE payment_logs
  ADD COLUMN IF NOT EXISTS yandex_requested_amount VARCHAR(32);

-- Eski bekleyen kayıtlar iki ondalıklı gross_amount üzerinden oluşturulmuştu.
UPDATE payment_logs
SET yandex_requested_amount = '-' || to_char(gross_amount, 'FM999999999999990.00')
WHERE yandex_requested_amount IS NULL
  AND status = 'yandex_pending';
