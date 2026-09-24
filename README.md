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

## Yönetici ödeme geçmişinde arama

`GET /api/admin/payment-logs` yönetici oturumu (`X-Admin-Token`) gerektirir.
Son 500 kayıt sınırı yerine tüm geçmişte filtreleme ve imleçli sayfalama kullanır.

- `q`: alıcı adı, sürücü ID'si, IBAN, UPT referansı veya sayısal işlem ID'si.
  Metin araması en az 3 karakterdir; 1–2 haneli sayılar yalnızca işlem ID'si olarak aranır.
- `from`, `to`: isteğe bağlı `YYYY-MM-DD`; Türkiye saatiyle iki gün de dahildir.
- `parkPartnerId`, `status`: isteğe bağlı şehir ve işlem durumu filtreleri.
- `limit`: 1–50 (varsayılan 50).
- `cursor`: aynı filtrelerle önceki yanıttan alınan `nextCursor`.

Yanıt: `{ success, logs, hasMore, nextCursor }`. Toplam kayıt sayımı yapılmaz.
Sıralama `created_at DESC, id DESC`; imleç tarihinin mikrosaniyeleri korunur.
Her sorgunun veritabanı çalışma süresi 5 saniye ile sınırlıdır.

017–020 migration'ları `pg_trgm` ve üç indeks ekler. Her indeks ayrı dosyada
`CONCURRENTLY` oluşturulur; bu dosyaları transaction içine almayın.
Veritabanı kullanıcısının `pg_trgm` kurma yetkisi olmalıdır.
Yayınlama sırası: migration'lar/backend, ardından ayrı admin panel deposu.

Testler:

```sh
node --test tests/adminPaymentLogs.test.js
```

PostgreSQL entegrasyon testi için `RUN_PAYMENT_DB_TESTS=1` ortam değişkeniyle
`node --test tests/adminPaymentLogs.integration.test.js` çalıştırın.
Test yalnızca geçici bir tabloda yapay veriler kullanır ve sonunda geri alır;
uygulamayı, ödeme görevlerini veya migration'ları başlatmaz.

## UPT düşük bakiye koruması

UPT TL bakiyesi **5.000 TL altına** düştüğünde yapılandırılmış tüm şehirlerin
çekimleri otomatik durdurulur. Tam 5.000 TL kapatma tetiklemez.
Kontrol sunucu açılışında, dakikada bir ve çekim akışında çalışır. Yakın
çekim kontrolleri banka sorgu yükünü azaltmak için en fazla 15 saniyelik
bakiyeyi paylaşır; ödeme sonrası zorunlu yenileme yapılır. Başlamış banka
işlemleri geri çağrılmaz.

Bakiye yükselse bile şehirler otomatik açılmaz. Admin **Sistem** ekranında
istediği şehirlerin işaretini kaldırıp kaydederek çekimleri tek tek açabilir.
Aynı düşük bakiye olayı bu manuel seçimi tekrar kapatmaz. Bakiye en az
5.000 TL olarak gözlemlenip yeniden altına düştüğünde yeni kapatma tetiklenir.

Durum mevcut `system_settings` tablosundaki `suspended_cities` ve
`upt_withdrawal_guard` anahtarlarında saklanır; yeniden başlatmada korunur.
Ek migration gerekmez. Otomatik kapatma ve admin değişiklikleri ortak
satır kilidiyle işlenir; eski admin pencerelerinin kaydı 409 ile reddedilir.
Banka bakiyesi doğrulanamazsa ilgili çekim reddedilir; hata sıfır bakiye
olarak kaydedilmez. Backend ile admin paneli birlikte yayınlanmalıdır;
sürücü panelindeki kapalı durum mesajı için frontend de güncellenmelidir.

`node --test tests/withdrawalSafety.test.js` temel senaryoları doğrular.
`RUN_PAYMENT_DB_TESTS=1` ile `tests/withdrawalSettings.integration.test.js`
yalnızca bağlantıya özel geçici tabloda kalıcılık ve çakışma kontrolü yapar.

## Lisans

ISC
