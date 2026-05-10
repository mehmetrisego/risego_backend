-- Remove UNIQUE constraint from driver_id to allow multiple bank accounts per driver
ALTER TABLE driver_bank_accounts DROP CONSTRAINT IF EXISTS driver_bank_accounts_driver_id_key;
