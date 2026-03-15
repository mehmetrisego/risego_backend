-- RiseGo: Yolculuk (sipariş) verisi - Leaderboard kalıcılığı
-- Sunucu reset'inde kaybolmayan 60 günlük sipariş verisi

CREATE TABLE IF NOT EXISTS orders (
    id VARCHAR(64) PRIMARY KEY,
    driver_id VARCHAR(64),
    booked_at TIMESTAMP WITH TIME ZONE NOT NULL,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_orders_driver_id ON orders(driver_id);
CREATE INDEX IF NOT EXISTS idx_orders_booked_at ON orders(booked_at);
