-- 009_payment_logs.sql
-- Para çekme işlemlerinin detaylı loglanması için tablo

CREATE TABLE IF NOT EXISTS payment_logs (
    id SERIAL PRIMARY KEY,
    driver_id VARCHAR(100) NOT NULL,
    beneficiary_name VARCHAR(255),
    beneficiary_iban VARCHAR(34),
    amount NUMERIC(15, 2) NOT NULL,           -- Sürücüye giden net tutar
    gross_amount NUMERIC(15, 2) NOT NULL,     -- Yandex'ten düşülen brüt tutar
    fee NUMERIC(15, 2) DEFAULT 4.00,          -- İşlem ücreti
    tu_ref_number VARCHAR(100),               -- Uption Referans No
    status VARCHAR(50) NOT NULL,              -- 'success', 'error', 'refunded', 'pending'
    error_message TEXT,                       -- Hata mesajı (varsa)
    park_partner_id VARCHAR(100),             -- Hangi park üzerinden yapıldı
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- Hızlı sorgulama için indexler
CREATE INDEX IF NOT EXISTS idx_payment_logs_driver_id ON payment_logs(driver_id);
CREATE INDEX IF NOT EXISTS idx_payment_logs_status ON payment_logs(status);
CREATE INDEX IF NOT EXISTS idx_payment_logs_created_at ON payment_logs(created_at DESC);
