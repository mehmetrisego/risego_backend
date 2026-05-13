-- 015_upt_balance_logs.sql
-- Uption (Aktif Bank) kurumsal cüzdan bakiye değişiklik geçmişi
-- Her bakiye artışı burada kaydedilir:
--   - Manuel yükleme (admin Uption'a para yüklediğinde)
--   - Başarısız EFT iadesi (sürücü çekimi reddedilince para geri döndüğünde)

CREATE TABLE IF NOT EXISTS upt_balance_logs (
    id              SERIAL PRIMARY KEY,
    balance_before  NUMERIC(12, 2)  NOT NULL DEFAULT 0,   -- Önceki bakiye (TL)
    balance_after   NUMERIC(12, 2)  NOT NULL,              -- Yeni bakiye (TL)
    change_amount   NUMERIC(12, 2)  NOT NULL,              -- Fark (her zaman pozitif, sadece artışlar)
    note            VARCHAR(255),                           -- Opsiyonel açıklama (örn: "Sürücü iadesi")
    checked_at      TIMESTAMP WITH TIME ZONE DEFAULT NOW() -- Tespit zamanı
);

-- Son kayda hızlı erişim için
CREATE INDEX IF NOT EXISTS idx_upt_balance_logs_checked_at
    ON upt_balance_logs(checked_at DESC);
