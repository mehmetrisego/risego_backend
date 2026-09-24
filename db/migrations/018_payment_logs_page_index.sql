CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_payment_logs_page
ON payment_logs (created_at DESC, id DESC);
