-- Kampanyaları park (şehir) bazlı ayır
ALTER TABLE campaigns ADD COLUMN IF NOT EXISTS park_partner_id VARCHAR(128);

CREATE INDEX IF NOT EXISTS idx_campaigns_park_partner ON campaigns(park_partner_id);
CREATE INDEX IF NOT EXISTS idx_campaigns_park_active ON campaigns(park_partner_id, active);
