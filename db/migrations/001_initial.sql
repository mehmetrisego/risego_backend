-- ============================================================
--  RiseGo Tam Şema — Tüm tabloları sıfırdan oluşturur
--  (Mevcut tablolar DROP edilip yeniden oluşturulur)
-- ============================================================

-- Bağımlılık sırasına göre tüm tabloları temizle
DROP TABLE IF EXISTS driver_profiles        CASCADE;
DROP TABLE IF EXISTS driver_bank_accounts   CASCADE;
DROP TABLE IF EXISTS orders                 CASCADE;
DROP TABLE IF EXISTS sessions               CASCADE;
DROP TABLE IF EXISTS admin_sessions         CASCADE;
DROP TABLE IF EXISTS campaigns              CASCADE;

-- ── Sürücü oturumları ─────────────────────────────────────
CREATE TABLE sessions (
    id          SERIAL PRIMARY KEY,
    token       VARCHAR(64) UNIQUE NOT NULL,
    driver_id   VARCHAR(64) NOT NULL,
    phone       VARCHAR(20) NOT NULL,
    city        VARCHAR(50) DEFAULT '',
    park_partner_id VARCHAR(64) DEFAULT '',
    created_at  TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    expires_at  TIMESTAMP WITH TIME ZONE NOT NULL
);
CREATE INDEX idx_sessions_token      ON sessions(token);
CREATE INDEX idx_sessions_expires_at ON sessions(expires_at);

-- ── Admin oturumları ──────────────────────────────────────
CREATE TABLE admin_sessions (
    id          SERIAL PRIMARY KEY,
    token       VARCHAR(64) UNIQUE NOT NULL,
    phone       VARCHAR(20) NOT NULL,
    created_at  TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    expires_at  TIMESTAMP WITH TIME ZONE NOT NULL
);
CREATE INDEX idx_admin_sessions_token      ON admin_sessions(token);
CREATE INDEX idx_admin_sessions_expires_at ON admin_sessions(expires_at);

-- ── Kampanya (aktif kampanya tek satır) ───────────────────
CREATE TABLE campaigns (
    id             SERIAL PRIMARY KEY,
    text           TEXT    NOT NULL DEFAULT '',
    active         BOOLEAN NOT NULL DEFAULT false,
    park_partner_id VARCHAR(64) DEFAULT '',
    updated_at     TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);
INSERT INTO campaigns (text, active, updated_at) VALUES ('', false, NOW());

-- ── Siparişler (leaderboard kalıcılığı) ───────────────────
CREATE TABLE orders (
    id              VARCHAR(64) NOT NULL,
    driver_id       VARCHAR(64),
    booked_at       TIMESTAMP WITH TIME ZONE NOT NULL,
    park_partner_id VARCHAR(64) DEFAULT '',
    created_at      TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    UNIQUE (id, park_partner_id)
);
CREATE INDEX idx_orders_driver_id       ON orders(driver_id);
CREATE INDEX idx_orders_booked_at       ON orders(booked_at);
CREATE INDEX idx_orders_park_partner_id ON orders(park_partner_id);

-- ── Sürücü banka hesapları ────────────────────────────────
CREATE TABLE driver_bank_accounts (
    id                  SERIAL PRIMARY KEY,
    driver_id           VARCHAR(64) NOT NULL UNIQUE,
    iban                VARCHAR(34) NOT NULL,
    account_holder_name VARCHAR(150) NOT NULL,
    created_at          TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    updated_at          TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);
CREATE INDEX idx_driver_bank_accounts_driver_id ON driver_bank_accounts(driver_id);

-- ── Sürücü profilleri (telefon ↔ Yandex ID eşlemesi) ─────
CREATE TABLE driver_profiles (
    id              SERIAL PRIMARY KEY,
    driver_id       VARCHAR(64)  NOT NULL UNIQUE,
    phone           VARCHAR(20)  NOT NULL UNIQUE,
    first_name      VARCHAR(100) DEFAULT '',
    last_name       VARCHAR(100) DEFAULT '',
    city            VARCHAR(50)  DEFAULT '',
    park_partner_id VARCHAR(64)  DEFAULT '',
    created_at      TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    updated_at      TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);
CREATE INDEX idx_driver_profiles_driver_id ON driver_profiles(driver_id);
CREATE INDEX idx_driver_profiles_phone     ON driver_profiles(phone);
