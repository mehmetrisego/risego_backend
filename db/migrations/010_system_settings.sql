CREATE TABLE IF NOT EXISTS system_settings (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL,
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

-- Varsayılan olarak para çekme işlemleri aktif (false) olarak başlar
INSERT INTO system_settings (key, value) 
VALUES ('is_withdraw_suspended', 'false')
ON CONFLICT (key) DO NOTHING;
