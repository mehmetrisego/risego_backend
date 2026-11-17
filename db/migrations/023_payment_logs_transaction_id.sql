ALTER TABLE payment_logs
    ADD COLUMN IF NOT EXISTS transaction_id VARCHAR(64);

CREATE INDEX IF NOT EXISTS idx_payment_logs_transaction_id
    ON payment_logs (transaction_id)
    WHERE transaction_id IS NOT NULL;
