# RiseGo Sürücü Paneli

Yandex Fleet API entegrasyonlu taksi sürücü yönetim paneli. Sürücüler giriş yapabilir, yolculuk sayılarını ve bakiyelerini görüntüleyebilir, araç değiştirebilir ve sıralama tablosuna erişebilir.

## Özellikler

- **Giriş:** Telefon + OTP doğrulama
- **Kayıt:** Yeni sürücü kaydı (telefon doğrulama sonrası)
- **Profil:** Bakiye, yolculuk sayısı, araç bilgisi
- **Araç değiştirme:** Plaka ile araç atama
- **Sıralama tablosu:** Aylık yolculuk sıralaması

## Kurulum

```bash
npm install
cp .env.example .env
# .env dosyasını düzenleyin (Yandex Fleet, NetGSM bilgileri)
npm start
```

Uygulama `http://localhost:3000` adresinde çalışır.

## Ortam Değişkenleri

`.env.example` dosyasına bakın. Gerekli değişkenler:

- `YANDEX_CLIENT_ID`, `YANDEX_API_KEY`, `YANDEX_PARTNER_ID` – Yandex Fleet API
- `NETGSM_USERNAME`, `NETGSM_USERCODE` – OTP SMS (NetGSM)
- `PORT` – Sunucu portu (varsayılan: 3000)

## Yandex marka/model (yeni araç)

`GET /api/drivers/car-brands` yalnızca `data/yandexVehicleReference.json` kullanır (`brandsWithModels` dolu olmalı). Listeyi bu dosyadan düzenleyerek güncellersiniz.

## API Endpointleri

- `POST /api/auth/login` – Giriş (OTP gönderir)
- `POST /api/auth/verify-otp` – OTP doğrulama
- `GET /api/auth/session` – Oturum kontrolü
- `POST /api/drivers/register/request-otp` – Kayıt OTP isteği
- `POST /api/drivers/register/verify` – Kayıt OTP doğrulama + sürücü oluşturma
- `POST /api/drivers/trip-count` – Yolculuk sayısı
- `GET /api/leaderboard` – Sıralama tablosu

## Lisans

ISC
