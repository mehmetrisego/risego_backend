-- UPT para gönderimini transaction başına tek bir yürütücüye atomik olarak verir.
ALTER TABLE payment_logs
  ADD COLUMN IF NOT EXISTS bank_started_at TIMESTAMP WITH TIME ZONE,
  ADD COLUMN IF NOT EXISTS upt_correspondent_ref VARCHAR(64);

CREATE INDEX IF NOT EXISTS idx_payment_logs_bank_unknown
  ON payment_logs (status, bank_started_at)
  WHERE status IN ('bank_starting', 'bank_unknown');
