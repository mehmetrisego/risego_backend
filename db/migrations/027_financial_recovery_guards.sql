-- Aynı uygulama transaction kimliğinin iki ayrı ödeme satırına dönüşmesini engeller.
-- Üretim ön kontrolünde tekrar eden transaction_id bulunmadığı doğrulanmıştır.
CREATE UNIQUE INDEX IF NOT EXISTS idx_payment_logs_transaction_id_unique
  ON payment_logs (transaction_id)
  WHERE transaction_id IS NOT NULL;

-- Belirsiz banka sonuçları ve tamamlanamamış Yandex iadeleri periyodik olarak izlenir.
CREATE INDEX IF NOT EXISTS idx_payment_logs_financial_recovery
  ON payment_logs (status, created_at)
  WHERE status IN ('pending_bank', 'bank_unknown', 'bank_returned_refund_pending');

