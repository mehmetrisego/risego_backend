# Railway PostgreSQL Kurulumu

Backend'i Railway'de PostgreSQL ile çalıştırmak için:

## 1. Variable Reference Ekleme

1. Railway projenizde **risego_backend** servisine tıklayın
2. **Variables** sekmesine gidin
3. **+ New Variable** → **Add Variable Reference** seçin
4. **Postgres** servisini seçin
5. `DATABASE_URL` veya `DATABASE_PUBLIC_URL` değişkenini ekleyin

   - **DATABASE_URL**: Railway internal network (önerilen, daha hızlı)
   - **DATABASE_PUBLIC_URL**: Harici bağlantı (localhost'tan test için)

## 2. Deploy

Değişken eklendikten sonra backend otomatik yeniden deploy olur. Loglarda şunları göreceksiniz:

```
[DB] PostgreSQL bağlantısı başarılı.
[DB] Migration tamamlandı: 001_initial.sql
Veritabanı: PostgreSQL (aktif)
```

## 3. Fallback

`DATABASE_URL` tanımlı değilse uygulama **bellek modunda** çalışır (eski davranış). Oturum ve kampanya sunucu yeniden başlatıldığında sıfırlanır.
