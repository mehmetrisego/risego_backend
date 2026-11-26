-- Banka adımı belirsiz kalan çekimler için otomatik 3 deneme ve admin kararı alanları.
-- Varsayılan değerli ADD COLUMN, PostgreSQL 11+ sürümünde tabloyu yeniden yazmaz.
ALTER TABLE payment_logs
  ADD COLUMN IF NOT EXISTS bank_retry_count integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS bank_retry_last_at timestamptz,
  ADD COLUMN IF NOT EXISTS bank_retry_last_result text,
  ADD COLUMN IF NOT EXISTS admin_decision varchar(16),
  ADD COLUMN IF NOT EXISTS admin_decision_result text,
  ADD COLUMN IF NOT EXISTS admin_decision_note text,
  ADD COLUMN IF NOT EXISTS admin_decided_at timestamptz,
  ADD COLUMN IF NOT EXISTS admin_decided_by varchar(32),
  ADD COLUMN IF NOT EXISTS admin_previous_status varchar(32),
  ADD COLUMN IF NOT EXISTS admin_lock_until timestamptz;

-- Yeniden deneme döngüsü yalnızca bu küçük kümeyi tarar.
CREATE INDEX IF NOT EXISTS idx_payment_logs_bank_retry
  ON payment_logs (created_at)
  WHERE status IN ('bank_unknown', 'pending_bank');

-- Admin kararı bekleyen ve işaretli kayıtlar.
CREATE INDEX IF NOT EXISTS idx_payment_logs_admin_queue
  ON payment_logs (created_at)
  WHERE status IN ('admin_review', 'admin_processing', 'bank_tr000_error', 'yandex_stuck_review');
