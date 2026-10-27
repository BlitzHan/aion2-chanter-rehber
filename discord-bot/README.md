# Aion 2 Boss Timer — Discord bot + site API

Aion 2 Chanter rehberindeki boss sayacını **herkese açık, tek ortak sayaç** yapar.
Yetkililer Discord'dan günceller; sitedeki herkes aynı geri sayımı görür.

- Site: https://blitzhan.github.io/aion2-chanter-rehber/#boss
- Altyapı: **Cloudflare Workers + KV** (ücretsiz plan yeterli)
- Site sadece **okur**; yazma yetkisi Discord'daki yetkili roldedir.
- Süre dolunca Discord kanalına "hazır" duyurusu atılabilir.

```
Discord /kes, /sure, /sifirla
        │
        ▼
Cloudflare Worker ── KV (ortak state)
        │
        ▼
GET /api/timers  ──►  GitHub Pages (index.html)
```

## 1. Gereksinimler

- Node.js 20+
- Cloudflare hesabı (ücretsiz)
- Discord sunucusunda yönetici yetkisi
- Discord Developer Portal'da uygulama oluşturma

## 2. Cloudflare tarafı

```bash
cd discord-bot
npm install
npx wrangler login
```

KV namespace oluştur:

```bash
npx wrangler kv namespace create TIMERS
```

Çıktıdaki `id = "..."` değerini `wrangler.toml` içindeki
`REPLACE_KV_NAMESPACE_ID` yerine yapıştır.

## 3. Discord uygulaması

1. https://discord.com/developers/applications → **New Application**
2. **General Information**:
   - `Application ID` → `.dev.vars` içine `DISCORD_APP_ID`
   - `Public Key` → `.dev.vars` içine `DISCORD_PUBLIC_KEY`
3. **Bot** → **Reset Token** → tokeni `.dev.vars` içine `DISCORD_BOT_TOKEN`
4. **OAuth2 → URL Generator**:
   - Scopes: `bot`, `applications.commands`
   - Bot Permissions: `Send Messages`, `Embed Links`, `Manage Events`
   - (Rol etiketlemesi kullanacaksan `Mention Everyone` da ekle.)
   - Oluşan URL ile botu sunucuna davet et.
5. Sunucuda:
   - Yetkili rolünü oluştur (örn. `Boss Timer Yetkili`) ve rol ID'sini kopyala.
   - Duyuru kanalının ID'sini kopyala.
   - Discord'da **Ayarlar → Gelişmiş → Geliştirici Modu** açık olmalı.

`.dev.vars` dosyasını oluştur:

```bash
cp .dev.vars.example .dev.vars
```

İçini doldur. Bu dosya `.gitignore` içinde, GitHub'a gitmez.

## 4. Değişkenler

`wrangler.toml` içindeki `[vars]` bölümünü düzenle:

| Değişken | Açıklama |
| --- | --- |
| `SITE_URL` | Discord'daki "Siteyi aç" butonu |
| `DISCORD_ALLOWED_USER_IDS` | Doluysa süreleri yalnızca bu kullanıcı ID'leri değiştirir (virgülle ayır); rol ve yönetici izni sayılmaz |
| `DISCORD_ADMIN_ROLE_ID` | Komutları kullanabilecek rolün ID'si (boşsa sunucu yöneticileri) |
| `DISCORD_CHANNEL_ID` | "Hazır" duyurularının gideceği kanal (boşsa duyuru kapalı) |
| `DISCORD_PING_ROLE_ID` | İsteğe bağlı; duyuruda etiketlenecek rol |
| `DISCORD_OWNER_ID` | İsteğe bağlı; bot sahibinin kullanıcı ID'si |

## 5. Deploy ve secret'lar

Önce Worker'ı oluştur:

```bash
npm run deploy
```

Wrangler sana bir URL verir, örneğin:

```
https://aion2-boss-timer.abc123.workers.dev
```

Şimdi secret'ları yükle (Worker artık var olduğu için bu adım deploy'dan sonra):

```bash
npx wrangler secret put DISCORD_PUBLIC_KEY
npx wrangler secret put DISCORD_BOT_TOKEN
```

Discord Developer Portal → **General Information → Interactions Endpoint URL**:

```
https://aion2-boss-timer.abc123.workers.dev/discord
```

Kaydet'e bas. Discord otomatik PING atar; imza doğrulanınca "Verified" olur.
Olmuyorsa `npx wrangler tail` ile canlı loga bak.

Komutlar otomatik kaydedilir: `DISCORD_BOT_TOKEN` secret'ı yüklendikten sonra cron
bir dakika içinde Discord'a gönderir (`wrangler.toml` içinde `DISCORD_APP_ID` dolu olmalı;
`DISCORD_GUILD_ID` boşsa global kaydeder). Elle kaydetmek istersen (guild komutu anında görünür):

```bash
npm run register
```

## 6. Siteyi bağla

`index.html` içinde boss sayacı bölümünün başındaki şu satırı bul:

```js
const BOSS_API = "";
```

Worker URL'sini yaz:

```js
const BOSS_API = "https://aion2-boss-timer.abc123.workers.dev";
```

İsteğe bağlı, "Discord'dan güncelle" yazısını link yap:

```js
const BOSS_DISCORD_INVITE = "https://discord.gg/sunucu-davetin";
```

Değişiklikleri commit'leyip push et. Site 30 saniyede bir API'yi yeniler.

## 7. Kullanım

| Komut | Kim kullanır | Ne yapar |
| --- | --- | --- |
| `/durum` | Herkes | 4 bossun kalan süresini gösterir |
| `/kes boss:Gartua` | Yetkili | Kestiğin an sayacı yeniden doğma süresine kurar |
| `/sure boss:Dartan sure:6s15d` | Yetkili | Kalan süreyi elle ayarlar |
| `/sure boss:Gartua sure:0` | Yetkili | Boss şu an hazır olarak işaretler |
| `/sifirla boss:Lagta` | Yetkili | Sayacı temizler ("bilinmiyor") |
| `/sifirla boss:Hepsi` | Yetkili | 4 sayacı birden temizler |

`/sure` biçimleri:

- `6s15d` → 6 saat 15 dakika
- `6 saat 15 dakika` (veya `6 saat 15 dakika kaldı`)
- `6:15` → 6 saat 15 dakika
- `375` → 375 dakika
- `0` → şu an hazır
- `6h15m`, `1g 2s` de çalışır

## 8. Boss listesi ve süreleri

`src/bosses.js` dosyasını düzenle. `id` alanı sitedeki boss adıyla **birebir aynı** olmalı:

```js
{
  id: "Immortal Gartua",
  name: "Immortal Gartua",
  short: "Gartua",
  map: "Altgard",
  respawnMin: 720,
}
```

Varsayılan olarak **Asmodian / Altgard** favorileri tanımlı:
Gartua (12s), Dartan (6s), Kashapa (6s), Lagta (12s).

Global satırlarda sitedeki "Yeniden doğma" sütunu da API'deki `respawnMin`
değerini kullanır; yani süreyi burada değiştirmen yeterli.

Elyos / Verteron oynuyorsan `src/bosses.js` içindeki yorumda yazan 4 ID'yi kullan.
Süre değiştirdikten sonra `npm run deploy` ve `npm run register` çalıştır.

## 9. Hazır duyurusu

`wrangler.toml` içindeki cron her dakika çalışır. Süresi dolan boss için
`DISCORD_CHANNEL_ID` kanalına bir kez "🟢 Gartua hazır!" mesajı atar.
Aynı boss tekrar kesilene kadar tekrar duyuru gitmez.

Kanal ID'si boşsa duyuru kapalıdır; bot yine çalışır.

## 9c. Sabit tablo, "kesildi" butonları ve hatırlatma

`BOARD_CHANNEL_ID` doluysa bot o kanala tek bir **Boss Sayacı** mesajı atar
(sabitle). Geri sayımı Discord kendisi yürütür; mesaj yalnızca durum değişince
düzenlenir. Altındaki **"⚔️ Gartua kesildi"** gibi butonlar `/kes` ile aynı işi
yapar (sadece yetkililer basabilir) ve tabloyu anında günceller.

- `/kes`, `/sure`, `/sifirla` ve otomatik döngü de tabloyu günceller.
- Tablo mesajı silinirse bot bir dakika içinde yenisini atar (yeniden sabitle).
- `REMIND_MIN` (varsayılan 5): doğuşa bu kadar dakika kala kanala
  "⏰ Gartua 5 dk sonra doğuyor" atılır; tur bitince mesaj silinir. `0` kapatır.
  `DISCORD_PING_ROLE_ID` doluysa hatırlatma o rolü etiketler.
- Kapatmak için `BOARD_CHANNEL_ID`'yi boşaltıp deploy et.

## 9a. Otomatik döngü

Boss doğduktan `AUTO_KILL_SEC` saniye sonra (varsayılan 40) kesilmiş sayılır ve
sayaç kendiliğinden bir sonraki doğuşa kurulur: Gartua/Lagta 12 saat,
Dartan/Kashapa 6 saat sonra. Kimse bakmasa da döngü sürer.

- Gerçek kesiliş saati farklıysa `/kes` ya da `/sure` ile düzelt; döngü oradan devam eder.
- `/sifirla` bossu döngüden çıkarır (sayaç "bilinmiyor" olur).
- Cron dakikada bir çalıştığından geçiş doğuştan en geç ~1-2 dk sonra görünür; yeni
  doğuş saati yine `doğuş + AUTO_KILL_SEC + respawn` olarak tam hesaplanır, kayma olmaz.
- Süreyi değiştirmek için `wrangler.toml` içindeki `AUTO_KILL_SEC` değerini düzenleyip deploy et.

## 9b. Discord etkinlikleri

`DISCORD_GUILD_ID` doluysa bot her boss için sunucuda bir **etkinlik** açar
(sol üstte "Etkinlikler"). Etkinlik doğuş anında başlar; Discord kendi geri
sayımını gösterir ve isteyen "İlgileniyorum" deyip bildirim alır.

- `/kes` ya da `/sure` sonrası en geç 1 dakikada etkinlik açılır veya güncellenir.
- Doğuş anı gelince etkinlik "şimdi oluyor" olur, 2 saat açık kalır.
- `/sifirla` etkinliği siler.
- Bota `Manage Events` (Etkinlikleri Yönet) izni gerekir.

## 10. Maliyet ve sınırlar

- Workers ücretsiz plan: günde 100.000 istek.
- KV ücretsiz plan: günde 100.000 okuma, 1.000 yazma.
- Site 30 saniyede bir okur; API yanıtı 15 saniye edge cache'lenir.
- KV dünya genelinde eventual consistent'dır: bir güncelleme diğer bölgelere
  genelde saniyeler içinde, en geç ~60 saniyede yansır. Site zaten 30 saniyede
  bir yenilediği için pratikte sorun olmaz.
- Aynı anda iki yetkili farklı bossları güncellerse son yazan kazanır. 4 boss ve
  küçük bir ekip için yeterli.

## 11. Sorun giderme

| Belirti | Çözüm |
| --- | --- |
| Discord endpoint "Verified" olmuyor | `DISCORD_PUBLIC_KEY` doğru mu, `npx wrangler tail` loglarına bak |
| Komutlar görünmüyor | `npm run register`; bot `applications.commands` scope'uyla davet edildi mi? |
| "yetkili rol" hatası | `DISCORD_ADMIN_ROLE_ID` rol ID'si mi? Değiştirdikten sonra `npm run deploy` |
| Site "Global sayaç kapalı" diyor | `BOSS_API` URL'si doğru mu, worker deploy edildi mi, CORS açık mı? |
| Site eski süreyi gösteriyor | 15 sn cache + 30 sn poll; en fazla ~45 sn gecikir |
| Duyuru gelmiyor | `DISCORD_CHANNEL_ID`, botun kanal izni ve `DISCORD_BOT_TOKEN` kontrol et |

## 12. Güvenlik

- Sitede token/secret yok; sadece public `GET /api/timers` var.
- Discord istekleri Ed25519 imzasıyla doğrulanır; imzasız istek 401 döner.
- Yazma komutları rol kontrolünden geçer.
- `DISCORD_BOT_TOKEN` ve `.dev.vars` asla commit'lenmemeli.
- Bot token sızarsa Developer Portal'dan resetle ve `wrangler secret put` ile güncelle.
