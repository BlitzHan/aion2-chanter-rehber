# aion2-boss-timer

Aion 2 boss sayacı: Cloudflare Worker + KV. Discord slash komutlarıyla güncellenir, site `GET /api/timers` ile okur.

- `src/index.js` — Worker: `fetch` (/api/timers, /discord, /health), `scheduled` (hazır duyurusu), `export parseDurationMinutes`
- `src/bosses.js` — `BOSSES` (4 boss, `respawnMin` dakika), `BOSS_MAP`
- `src/commands.js` — slash komut tanımları (/kes, /sure, /sifirla, /durum)
- `scripts/register-commands.mjs` — komutları Discord'a kaydeder
- Testler: `test/*.test.js`, Node yerleşik `node:test` + `node:assert/strict`, ek paket yok. Çalıştırma: `npm test`
- Sözdizimi kontrolü: `npm run check`
- ES modül (`"type": "module"`). Kod yorumları Türkçe.
- Secret'lar (`.dev.vars`, token) asla dosyaya yazılmaz. Deploy ve `wrangler` komutlarını çalıştırma.
