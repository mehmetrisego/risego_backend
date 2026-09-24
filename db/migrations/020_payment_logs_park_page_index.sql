CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_payment_logs_park_page
ON payment_logs (park_partner_id, created_at DESC, id DESC);
