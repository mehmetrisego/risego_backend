-- 008: driver_profiles tablosuna last_withdraw_at kolonu ekle
-- Para çekimi cooldown bilgisi DB'de tutulacak (restart sonrası silinmesin)

DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_name = 'driver_profiles' AND column_name = 'last_withdraw_at'
    ) THEN
        ALTER TABLE driver_profiles
            ADD COLUMN last_withdraw_at TIMESTAMP WITH TIME ZONE DEFAULT NULL;
    END IF;
END $$;
