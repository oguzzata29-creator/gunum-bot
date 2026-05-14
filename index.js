const express = require('express');
const TelegramBot = require('node-telegram-bot-api');
const OpenAI = require('openai');
const admin = require('firebase-admin');
const axios = require('axios');

// ── Config ────────────────────────────────────────────────────────────────────
const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const OPENAI_KEY = process.env.OPENAI_API_KEY;
const ALLOWED_USER_ID = parseInt(process.env.TELEGRAM_USER_ID || '0');
const GOOGLE_CLIENT_ID = process.env.GOOGLE_CLIENT_ID;
const GOOGLE_CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET;
const GOOGLE_REFRESH_TOKEN = process.env.GOOGLE_REFRESH_TOKEN;
const PORT = process.env.PORT || 3000;

// ── Firebase ──────────────────────────────────────────────────────────────────
const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT || '{}');
if (serviceAccount.project_id) {
  admin.initializeApp({
    credential: admin.credential.cert(serviceAccount),
  });
}
const db = serviceAccount.project_id ? admin.firestore() : null;

// ── OpenAI ────────────────────────────────────────────────────────────────────
let _openai = null;
function getOpenAI() {
  if (!_openai) {
    _openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
  }
  return _openai;
}

// ── Bot ───────────────────────────────────────────────────────────────────────
const app = express();
app.use(express.json());

const bot = new TelegramBot(BOT_TOKEN, { polling: false });

// Kullanıcı durumları (bekleyen sorular)
const userState = {};

// ── Yardımcı fonksiyonlar ─────────────────────────────────────────────────────
function yetkiKontrol(userId) {
  if (ALLOWED_USER_ID && userId !== ALLOWED_USER_ID) return false;
  return true;
}

async function googleAccessToken() {
  const res = await axios.post('https://oauth2.googleapis.com/token', {
    client_id: GOOGLE_CLIENT_ID,
    client_secret: GOOGLE_CLIENT_SECRET,
    refresh_token: GOOGLE_REFRESH_TOKEN,
    grant_type: 'refresh_token',
  });
  return res.data.access_token;
}

async function calendarEkle(baslik, baslangic, bitis, notlar = '') {
  const token = await googleAccessToken();
  const etkinlik = {
    summary: baslik,
    description: notlar,
    start: { dateTime: baslangic, timeZone: 'Europe/Istanbul' },
    end: { dateTime: bitis, timeZone: 'Europe/Istanbul' },
  };
  const res = await axios.post(
    'https://www.googleapis.com/calendar/v3/calendars/primary/events',
    etkinlik,
    { headers: { Authorization: `Bearer ${token}` } }
  );
  return res.data;
}

function tarihParse(metin) {
  // "yarın 09:00", "bugün 14:30", "15:00 spor" gibi metinleri parse et
  const bugun = new Date();
  bugun.setHours(0, 0, 0, 0);

  let tarih = new Date(bugun);
  let saat = null;

  if (metin.toLowerCase().includes('yarın') || metin.toLowerCase().includes('yarin')) {
    tarih.setDate(tarih.getDate() + 1);
  }

  // Saat bul
  const saatMatch = metin.match(/(\d{1,2})[:.:](\d{2})/);
  if (saatMatch) {
    saat = { saat: parseInt(saatMatch[1]), dakika: parseInt(saatMatch[2]) };
  }

  // Sadece saat yazılmışsa (ör: "15:00")
  const sadeceSaat = metin.match(/^(\d{1,2})[:.:](\d{2})/);
  if (sadeceSaat && !metin.toLowerCase().includes('bugün') && !metin.toLowerCase().includes('yarın')) {
    tarih = new Date(bugun);
  }

  return { tarih, saat };
}

async function gorselAnaliz(imageUrl, kitapAdi = '') {
  const response = await getOpenAI().chat.completions.create({
    model: 'gpt-4o-mini',
    max_tokens: 1500,
    messages: [{
      role: 'user',
      content: [
        { type: 'image_url', image_url: { url: imageUrl } },
        {
          type: 'text',
          text: `Bu kitap sayfasını Türkçe olarak özetle${kitapAdi ? ` (Kitap: ${kitapAdi})` : ''}. 
Şu formatta yaz:
**Başlık:** [ana konu]
**Ana Fikirler:**
- [madde 1]
- [madde 2]
- [madde 3]
**Önemli Alıntı:** [varsa bir alıntı]
**Notum:** [bu fikirden ne öğrendim]`
        }
      ]
    }]
  });
  return response.choices[0].message.content;
}

async function firebaseKaydet(koleksiyon, id, veri) {
  if (!db) return;
  // Firebase'deki ilk kullanıcıyı bul
  const usersSnap = await db.collection('users').limit(1).get();
  if (usersSnap.empty) return;
  const userId = usersSnap.docs[0].id;
  await db.collection('users').doc(userId)
    .collection(koleksiyon).doc(id).set(veri, { merge: true });
}

function uid() {
  return Math.random().toString(36).slice(2, 10);
}

// ── Mesaj işleme ──────────────────────────────────────────────────────────────
async function mesajisle(msg) {
  const chatId = msg.chat.id;
  const userId = msg.from.id;
  const metin = msg.text || '';

  if (!yetkiKontrol(userId)) {
    bot.sendMessage(chatId, '❌ Bu bot sadece yetkili kullanıcılar içindir.');
    return;
  }

  // Kullanıcı durumu kontrol et (bekleyen sorular)
  if (userState[userId]) {
    const state = userState[userId];

    if (state.tip === 'urun_ad_bekle') {
      state.urun.ad = metin;
      userState[userId] = { tip: 'urun_not_bekle', urun: state.urun };
      bot.sendMessage(chatId, '📝 Kısa bir not eklemek ister misin? (Geçmek için "yok" yaz)');
      return;
    }

    if (state.tip === 'urun_not_bekle') {
      state.urun.not = metin === 'yok' ? '' : metin;
      // Ürünü kaydet
      const urun = { ...state.urun, id: uid(), tarih: new Date().toLocaleDateString('tr-TR') };
      await firebaseKaydet('urunler', urun.id, urun);
      delete userState[userId];
      bot.sendMessage(chatId,
        `✅ Ürün kaydedildi!\n\n🛍️ *${urun.ad}*\n${urun.videoLink ? `▶️ ${urun.videoLink}\n` : ''}${urun.sosyalLink ? `📱 ${urun.sosyalLink}\n` : ''}${urun.not ? `📝 ${urun.not}` : ''}`,
        { parse_mode: 'Markdown' }
      );
      return;
    }

    if (state.tip === 'takvim_sure_bekle') {
      const sure = parseInt(metin) || 60;
      const baslangic = new Date(state.baslangic);
      const bitis = new Date(baslangic.getTime() + sure * 60000);
      try {
        await calendarEkle(
          state.baslik,
          baslangic.toISOString(),
          bitis.toISOString(),
          state.notlar
        );
        delete userState[userId];
        bot.sendMessage(chatId,
          `✅ Takvime eklendi!\n\n📅 *${state.baslik}*\n🕐 ${baslangic.toLocaleString('tr-TR')} (${sure} dk)`,
          { parse_mode: 'Markdown' }
        );
      } catch (e) {
        bot.sendMessage(chatId, `❌ Takvim hatası: ${e.message}`);
      }
      return;
    }

    if (state.tip === 'kitap_ad_bekle') {
      state.kitapAdi = metin === 'yok' ? '' : metin;
      bot.sendMessage(chatId, '🤖 Analiz ediliyor...');
      try {
        const ozet = await gorselAnaliz(state.imageUrl, state.kitapAdi);
        const not = {
          id: uid(),
          tarih: new Date().toLocaleDateString('tr-TR'),
          kitap: state.kitapAdi,
          baslik: state.kitapAdi || `Not ${new Date().toLocaleTimeString('tr-TR')}`,
          ozet,
        };
        await firebaseKaydet('notlar', not.id, not);
        delete userState[userId];
        bot.sendMessage(chatId, `📚 *${not.baslik}*\n\n${ozet}\n\n✅ Uygulamana kaydedildi!`, { parse_mode: 'Markdown' });
      } catch (e) {
        bot.sendMessage(chatId, `❌ Analiz hatası: ${e.message}`);
      }
      return;
    }
  }

  // Link geldi → ürün olarak kaydet
  if (metin.startsWith('http://') || metin.startsWith('https://')) {
    const url = metin.trim();
    const isTikTok = url.includes('tiktok.com');
    const isInstagram = url.includes('instagram.com');
    const isYoutube = url.includes('youtube.com') || url.includes('youtu.be');

    userState[userId] = {
      tip: 'urun_ad_bekle',
      urun: {
        videoLink: (isTikTok || isYoutube) ? url : '',
        sosyalLink: isInstagram ? url : (!isTikTok && !isYoutube ? url : ''),
      }
    };
    bot.sendMessage(chatId, `🛍️ Link alındı! Ürünün adı ne?`);
    return;
  }

  // Takvim komutu: "takvim: yarın 09:00 spor 60dk" veya "📅 yarın 09:00 spor"
  if (metin.toLowerCase().startsWith('takvim:') || metin.startsWith('📅') || metin.toLowerCase().startsWith('/takvim')) {
    const icerik = metin.replace(/^(takvim:|📅|\/takvim)/i, '').trim();
    const { tarih, saat } = tarihParse(icerik);

    if (!saat) {
      bot.sendMessage(chatId, '⏰ Saat belirtmedin. Örnek: "takvim: yarın 09:00 spor"');
      return;
    }

    tarih.setHours(saat.saat, saat.dakika, 0, 0);

    // Başlığı bul (saat ve tarih kelimelerini çıkar)
    const baslik = icerik
      .replace(/yarın|yarin|bugün|bugun/gi, '')
      .replace(/\d{1,2}[:.]\d{2}/g, '')
      .replace(/\d+\s*dk/gi, '')
      .trim() || 'Aktivite';

    userState[userId] = { tip: 'takvim_sure_bekle', baslik, baslangic: tarih, notlar: '' };
    bot.sendMessage(chatId, `📅 *${baslik}* - ${tarih.toLocaleString('tr-TR')}\n\nKaç dakika sürecek? (Varsayılan: 60)`, { parse_mode: 'Markdown' });
    return;
  }

  // Yardım
  if (metin === '/start' || metin === '/yardim' || metin === '/help') {
    bot.sendMessage(chatId,
      `👋 *Günüm Bot'a Hoş Geldin!*\n\n` +
      `📸 *Kitap Notu:* Bir fotoğraf gönder, AI özetlesin\n\n` +
      `🛍️ *Ürün Ekle:* Bir link gönder, sana soru sorarak kaydedeyim\n\n` +
      `📅 *Takvim:* "takvim: yarın 09:00 spor" yaz\n` +
      `veya: "📅 bugün 15:30 toplantı"\n\n` +
      `Tüm veriler otomatik uygulamana kaydedilir 🚀`,
      { parse_mode: 'Markdown' }
    );
    return;
  }

  // Bilinmeyen mesaj
  bot.sendMessage(chatId,
    `Anlamadım 🤔\n\n• Fotoğraf gönder → kitap notu\n• Link gönder → ürün kaydet\n• "takvim: yarın 09:00 spor" → takvime ekle\n• /yardim → tüm komutlar`
  );
}

async function fotografisle(msg) {
  const chatId = msg.chat.id;
  const userId = msg.from.id;

  if (!yetkiKontrol(userId)) return;

  bot.sendMessage(chatId, '📚 Kitap adını yazar mısın? (Geçmek için "yok" yaz)');

  // En büyük fotoğrafı al
  const foto = msg.photo[msg.photo.length - 1];
  const fileInfo = await bot.getFile(foto.file_id);
  const imageUrl = `https://api.telegram.org/file/bot${BOT_TOKEN}/${fileInfo.file_path}`;

  userState[userId] = { tip: 'kitap_ad_bekle', imageUrl };
}

// ── Webhook ───────────────────────────────────────────────────────────────────
app.post('/webhook', (req, res) => {
  const update = req.body;
  res.sendStatus(200);

  if (update.message) {
    const msg = update.message;
    if (msg.photo) {
      fotografisle(msg).catch(console.error);
    } else if (msg.text) {
      mesajisle(msg).catch(console.error);
    }
  }
});

app.get('/', (req, res) => res.send('Günüm Bot çalışıyor 🚀'));

app.listen(PORT, () => {
  console.log(`Server port ${PORT} üzerinde çalışıyor`);
  // Webhook'u ayarla
  if (process.env.RAILWAY_STATIC_URL || process.env.WEBHOOK_URL) {
    const url = process.env.WEBHOOK_URL || `https://${process.env.RAILWAY_STATIC_URL}`;
    bot.setWebHook(`${url}/webhook`)
      .then(() => console.log('Webhook ayarlandı:', url))
      .catch(console.error);
  }
});
