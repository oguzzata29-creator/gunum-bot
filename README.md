# Günüm Telegram Bot

## Kurulum

### 1. Telegram Bot Oluştur
- @BotFather'a yaz → /newbot → isim ver → token al

### 2. Telegram User ID Al
- @userinfobot'a yaz → ID'ni al

### 3. Google Refresh Token Al
- Google Cloud Console → OAuth Playground
- Calendar API scope ekle → token al

### 4. Firebase Service Account
- Firebase Console → Settings → Service Accounts
- "Generate new private key" → JSON indir

### 5. Railway'e Deploy
- railway.app → New Project → Deploy from GitHub
- Environment variables ekle (aşağıdaki)

## Environment Variables

```
TELEGRAM_BOT_TOKEN=your_bot_token
TELEGRAM_USER_ID=your_telegram_user_id
OPENAI_API_KEY=sk-...
GOOGLE_CLIENT_ID=...
GOOGLE_CLIENT_SECRET=...
GOOGLE_REFRESH_TOKEN=...
FIREBASE_SERVICE_ACCOUNT={"type":"service_account",...}
WEBHOOK_URL=https://your-railway-url.railway.app
```

## Kullanım

- 📸 **Fotoğraf gönder** → AI kitap özetlesin
- 🔗 **Link gönder** → Ürün olarak kaydet
- 📅 **"takvim: yarın 09:00 spor"** → Takvime ekle
- /yardim → Tüm komutlar
