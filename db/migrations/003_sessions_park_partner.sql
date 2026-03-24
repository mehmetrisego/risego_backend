-- Sürücü oturumunda hangi Yandex park (şehir) API anahtarı kullanılacak
ALTER TABLE sessions ADD COLUMN IF NOT EXISTS park_partner_id VARCHAR(64) DEFAULT '';
