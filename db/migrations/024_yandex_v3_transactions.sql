-- Yandex Fleet v3 işlem oluşturma ve asenkron durum takibi.
ALTER TABLE payment_logs
  ADD COLUMN IF NOT EXISTS yandex_transaction_id VARCHAR(1000),
  ADD COLUMN IF NOT EXISTS yandex_event_id VARCHAR(1000),
  ADD COLUMN IF NOT EXISTS yandex_idempotency_token VARCHAR(64),
  ADD COLUMN IF NOT EXISTS yandex_version INTEGER,
  ADD COLUMN IF NOT EXISTS yandex_status VARCHAR(32),
  ADD COLUMN IF NOT EXISTS yandex_status_description TEXT,
  ADD COLUMN IF NOT EXISTS yandex_status_checked_at TIMESTAMP WITH TIME ZONE,
  ADD COLUMN IF NOT EXISTS yandex_attempt_count INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS yandex_reconciliation_required BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS yandex_refund_transaction_id VARCHAR(1000),
  ADD COLUMN IF NOT EXISTS yandex_refund_status VARCHAR(32);

CREATE INDEX IF NOT EXISTS idx_payment_logs_yandex_pending
  ON payment_logs (yandex_status, created_at)
  WHERE yandex_status IN ('in_progress', 'unknown');

CREATE INDEX IF NOT EXISTS idx_payment_logs_yandex_transaction_id
  ON payment_logs (yandex_transaction_id)
  WHERE yandex_transaction_id IS NOT NULL;
