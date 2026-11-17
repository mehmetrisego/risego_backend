ALTER TABLE driver_profiles
    ADD COLUMN IF NOT EXISTS work_status VARCHAR(32) DEFAULT 'working',
    ADD COLUMN IF NOT EXISTS source_updated_at TIMESTAMP WITH TIME ZONE;

CREATE INDEX IF NOT EXISTS idx_driver_profiles_park_phone_working
    ON driver_profiles (park_partner_id, phone)
    WHERE work_status = 'working' OR work_status IS NULL;

CREATE TABLE IF NOT EXISTS driver_profile_sync_state (
    park_partner_id      VARCHAR(64) PRIMARY KEY,
    delta_synced_through TIMESTAMP WITH TIME ZONE,
    reconciliation_offset INTEGER NOT NULL DEFAULT 0,
    last_full_sync_at    TIMESTAMP WITH TIME ZONE,
    last_error           TEXT,
    updated_at           TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW()
);
