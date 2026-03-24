-- Çoklu şehir/park: sipariş satırına park kimliği + bileşik anahtar

ALTER TABLE orders ADD COLUMN IF NOT EXISTS park_partner_id VARCHAR(64) NOT NULL DEFAULT '';

ALTER TABLE orders DROP CONSTRAINT IF EXISTS orders_pkey;

ALTER TABLE orders ADD PRIMARY KEY (id, park_partner_id);

CREATE INDEX IF NOT EXISTS idx_orders_park_booked ON orders (park_partner_id, booked_at);
CREATE INDEX IF NOT EXISTS idx_orders_park_driver_booked ON orders (park_partner_id, driver_id, booked_at);
