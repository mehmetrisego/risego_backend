-- Banka iade eşitlemesi her UPTREF için bu alanı sorgular.
-- CONCURRENTLY üretimde tablo yazmalarını bloke etmeden indeks oluşturur.
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_payment_logs_tu_ref_active
ON payment_logs (tu_ref_number)
WHERE status <> 'bank_returned';
