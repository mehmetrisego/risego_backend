CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_payment_logs_search
ON payment_logs USING gin ((lower(translate(
    coalesce(beneficiary_name, '') || ' ' || coalesce(driver_id, '') || ' ' ||
    coalesce(tu_ref_number, '') || ' ' || coalesce(beneficiary_iban, ''), 'İIı', 'iii'))) gin_trgm_ops);
