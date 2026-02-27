# RiseGo Backend - Deploy Rehberi

## GitHub'a Push Öncesi Kontrol Listesi

- [x] `.gitignore` mevcut (node_modules, .env hariç)
- [x] API anahtarları `.env` dosyasında (asla config.js'de değil)
- [ ] `.env` dosyası **kesinlikle** commit edilmemeli
- [ ] `risego_frontend` klasörü backend push'unda **dahil edilmemeli** (ayrı repo için)

## Backend Repo İçeriği (GitHub'a push edilecekler)

- server.js, config.js, package.json
- services/ (authService, netgsmService, yandexFleetApi, fileWriter)
- fetchDrivers.js
- .env.example, .gitignore, DEPLOY.md
- **risego_frontend YOK** - frontend ayrı repoda

## Railway Deploy

1. GitHub repo'yu Railway'e bağlayın (backend repo)
2. **Variables** sekmesinde şu değişkenleri ekleyin:
   - `YANDEX_CLIENT_ID`
   - `YANDEX_API_KEY`
   - `YANDEX_PARTNER_ID`
   - `NETGSM_USERNAME` (OTP SMS için)
   - `NETGSM_USERCODE` (OTP SMS için)
   - `NETGSM_MSGHEADER` (örn: RISE LTD)
3. Deploy tamamlandığında URL alacaksınız: `https://xxx.up.railway.app`

## Frontend (GitHub Pages) - Ayrı Repo

1. `risego_frontend` klasörünün içeriğini yeni bir repo'ya kopyalayın
2. `js/app.js` içinde `YOUR-RAILWAY-APP` ifadesini Railway URL'inizle değiştirin
3. GitHub Pages'i etkinleştirin

## Önemli Güvenlik Notları

- `.env` asla GitHub'a push edilmemeli
- API anahtarlarınızı kimseyle paylaşmayın
- Railway'de environment variables kullanın, kod içine yazmayın
