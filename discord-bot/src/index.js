import { BOSSES, BOSS_MAP } from "./bosses.js";
import { COMMANDS } from "./commands.js";

const STATE_KEY = "state";
const COMMANDS_SYNC_KEY = "commands_sync";
const EVENTS_KEY = "events";
const BOARD_KEY = "board";
// Doğuştan kaç dakika önce kanala hatırlatma gitsin (REMIND_MIN ile değişir, 0 kapatır).
const DEFAULT_REMIND_MIN = 5;
// Discord etkinliği geçmişte başlayamaz; bu kadar yakın doğuşlar için etkinlik açılmaz.
const EVENT_LEAD_MS = 60_000;
// Doğuştan sonra etkinlik "şimdi oluyor" olarak bu kadar açık kalır.
const EVENT_LENGTH_MS = 2 * 60 * 60_000;
// Doğuştan bu kadar saniye sonra boss ölmüş sayılır ve sayaç yeni tura kurulur.
// wrangler.toml'daki AUTO_KILL_SEC ile değiştirilebilir.
const DEFAULT_AUTO_KILL_SEC = 40;
const DISCORD_API = "https://discord.com/api/v10";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
  "Access-Control-Max-Age": "86400",
};

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: CORS });
    }

    if (url.pathname === "/api/timers" && request.method === "GET") {
      return getTimers(request, env, ctx);
    }

    if (url.pathname === "/discord" && request.method === "POST") {
      return handleDiscord(request, env, ctx);
    }

    if ((url.pathname === "/" || url.pathname === "/health") && request.method === "GET") {
      return statusPage();
    }

    return json({ ok: false, error: "not_found" }, 404, CORS);
  },

  async scheduled(controller, env, ctx) {
    ctx.waitUntil(syncCommands(env).catch((err) => console.error("syncCommands failed", err)));
    // Sırayla: hepsi aynı state'i okuyup yazdığı için paralel çalışmamalı.
    ctx.waitUntil(
      (async () => {
        await announceReady(env).catch((err) => console.error("announceReady failed", err));
        await autoAdvance(env).catch((err) => console.error("autoAdvance failed", err));
        await syncEvents(env).catch((err) => console.error("syncEvents failed", err));
        await syncBoard(env).catch((err) => console.error("syncBoard failed", err));
      })(),
    );
  },
};

// ---------------------------------------------------------------------------
// Site API
// ---------------------------------------------------------------------------

async function getTimers(request, env, ctx) {
  const url = new URL(request.url);
  const fresh = url.searchParams.get("fresh") === "1";
  const cache = caches.default;
  const cacheKey = new Request(new URL("/__cache/timers", request.url).toString(), {
    method: "GET",
  });

  if (!fresh) {
    try {
      const hit = await cache.match(cacheKey);
      if (hit) return hit;
    } catch (_) {
      // Cache API desteklenmiyorsa doğrudan KV'den okumaya devam et.
    }
  }

  let state;
  try {
    state = await readState(env);
  } catch (err) {
    console.error("readState failed", err);
    return json({ ok: false, error: "storage_unavailable" }, 500, CORS);
  }

  const bosses = BOSSES.map((b) => {
    const s = state.bosses[b.id] || {};
    return {
      id: b.id,
      name: b.name,
      short: b.short,
      map: b.map,
      respawnMin: b.respawnMin,
      until: Number(s.until) || 0,
      updatedBy: s.updatedBy || null,
      updatedAt: Number(s.updatedAt) || 0,
    };
  });

  const res = json(
    { ok: true, updatedAt: state.updatedAt || 0, bosses },
    200,
    { ...CORS, "Cache-Control": "public, max-age=15" },
  );

  if (!fresh) {
    ctx.waitUntil(cache.put(cacheKey, res.clone()).catch(() => {}));
  }
  return res;
}

async function readState(env) {
  if (!env.TIMERS) throw new Error("TIMERS KV binding tanımlı değil");
  const raw = await env.TIMERS.get(STATE_KEY, "json");
  if (!raw || typeof raw !== "object") return { bosses: {}, updatedAt: 0 };
  return {
    bosses: raw.bosses && typeof raw.bosses === "object" ? raw.bosses : {},
    updatedAt: Number(raw.updatedAt) || 0,
  };
}

async function writeState(env, state) {
  if (!env.TIMERS) throw new Error("TIMERS KV binding tanımlı değil");
  await env.TIMERS.put(STATE_KEY, JSON.stringify(state));
}

// ---------------------------------------------------------------------------
// Discord interactions
// ---------------------------------------------------------------------------

async function handleDiscord(request, env, ctx) {
  const rawBody = await request.text();
  const valid = await verifyDiscordRequest(request, rawBody, env.DISCORD_PUBLIC_KEY);
  if (!valid) return new Response("invalid request signature", { status: 401 });

  let interaction;
  try {
    interaction = JSON.parse(rawBody);
  } catch (_) {
    return new Response("bad request", { status: 400 });
  }

  // Discord, endpoint'i kaydederken PING atar.
  if (interaction.type === 1) return json({ type: 1 });

  // Tablodaki "kesildi" butonları.
  if (interaction.type === 3) {
    try {
      return await handleButton(interaction, env);
    } catch (err) {
      console.error("button failed", err);
      return ephemeral("Bir hata oluştu. Biraz sonra tekrar dene.");
    }
  }

  if (interaction.type !== 2) {
    return ephemeral("Bu bot sadece slash komutlarını destekliyor.");
  }

  const name = interaction.data && interaction.data.name;

  try {
    let res;
    if (name === "durum") return await cmdStatus(env);
    else if (name === "kes") res = await cmdKill(interaction, env);
    else if (name === "sure") res = await cmdSet(interaction, env);
    else if (name === "sifirla") res = await cmdClear(interaction, env);
    else return ephemeral("Bilinmeyen komut.");

    // Sabit tabloyu hemen güncelle; cron'u beklemesin.
    if (ctx) {
      ctx.waitUntil(syncBoard(env, { fromCommand: true }).catch((err) => console.error("syncBoard failed", err)));
    }
    return res;
  } catch (err) {
    console.error("command failed", name, err);
    return ephemeral("Bir hata oluştu. Biraz sonra tekrar dene.");
  }
}

async function handleButton(interaction, env) {
  const customId = (interaction.data && interaction.data.custom_id) || "";
  if (!customId.startsWith("kill:")) return ephemeral("Bilinmeyen buton.");
  if (!isAdmin(interaction, env)) return adminDenied();

  const boss = BOSS_MAP[customId.slice(5)];
  if (!boss || !boss.respawnMin) return ephemeral("Boss bulunamadı.");

  await killBoss(env, boss, actorName(interaction));

  // Butonun bağlı olduğu mesajı (tabloyu) yerinde güncelle.
  const state = await readState(env);
  return json({ type: 7, data: renderBoard(state, Date.now(), env) });
}

async function verifyDiscordRequest(request, rawBody, publicKeyHex) {
  const signature = request.headers.get("X-Signature-Ed25519");
  const timestamp = request.headers.get("X-Signature-Timestamp");
  if (!signature || !timestamp || !publicKeyHex) return false;

  // Eski imzaların tekrar oynatılmasını engelle (5 dakika tolerans).
  const timestampSeconds = Number(timestamp);
  if (!Number.isFinite(timestampSeconds)) return false;
  if (Math.abs(Date.now() / 1000 - timestampSeconds) > 300) return false;

  const signatureBytes = hexToBytes(signature);
  const keyBytes = hexToBytes(publicKeyHex);
  if (!signatureBytes || !keyBytes) return false;

  try {
    const key = await crypto.subtle.importKey(
      "raw",
      keyBytes,
      { name: "Ed25519" },
      false,
      ["verify"],
    );
    return await crypto.subtle.verify(
      { name: "Ed25519" },
      key,
      signatureBytes,
      new TextEncoder().encode(timestamp + rawBody),
    );
  } catch (err) {
    console.error("signature verify failed", err);
    return false;
  }
}

function hexToBytes(hex) {
  if (typeof hex !== "string" || hex.length === 0 || hex.length % 2 !== 0) return null;
  if (!/^[0-9a-f]+$/i.test(hex)) return null;
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) {
    out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  }
  return out;
}

function isAdmin(interaction, env) {
  const member = interaction.member;
  if (!member) return false;

  const userId = member.user && member.user.id;

  // İzinli kişi listesi doluysa yalnızca onlar değiştirebilir (rol ve yönetici izni sayılmaz).
  const allowed = String(env.DISCORD_ALLOWED_USER_IDS || "")
    .split(",")
    .map((id) => id.trim())
    .filter(Boolean);
  if (allowed.length) return allowed.includes(userId);
  if (env.DISCORD_OWNER_ID && userId === env.DISCORD_OWNER_ID) return true;

  if (
    env.DISCORD_ADMIN_ROLE_ID &&
    Array.isArray(member.roles) &&
    member.roles.includes(env.DISCORD_ADMIN_ROLE_ID)
  ) {
    return true;
  }

  // Sunucuda "Yönetici" izni olanlar da kullanabilir.
  try {
    if (member.permissions && (BigInt(member.permissions) & 8n) === 8n) return true;
  } catch (_) {
    // permissions alanı yoksa sorun değil.
  }

  return false;
}

function adminDenied() {
  return ephemeral("⛔ Boss sürelerini sadece yetkili kişiler değiştirebilir.");
}

async function cmdKill(interaction, env) {
  if (!isAdmin(interaction, env)) return adminDenied();

  const boss = BOSS_MAP[getOption(interaction, "boss")];
  if (!boss) return ephemeral("Boss bulunamadı.");

  if (!boss.respawnMin) {
    return ephemeral("Bu boss için yeniden doğma süresi tanımlı değil. `/sure` ile elle ayarla.");
  }

  const until = await killBoss(env, boss, actorName(interaction));
  const unix = Math.floor(until / 1000);
  return ephemeral(
    `✅ **${boss.short}** kesildi.\nYeniden doğma: <t:${unix}:R> · <t:${unix}:t>`,
  );
}

// Bossu şu an kesilmiş sayar; yeni doğuş zamanını döner.
async function killBoss(env, boss, actor) {
  const now = Date.now();
  const until = now + boss.respawnMin * 60_000;
  const state = await readState(env);

  state.bosses[boss.id] = {
    until,
    updatedAt: now,
    updatedBy: actor,
    announced: false,
  };
  state.updatedAt = now;
  await writeState(env, state);
  return until;
}

async function cmdSet(interaction, env) {
  if (!isAdmin(interaction, env)) return adminDenied();

  const boss = BOSS_MAP[getOption(interaction, "boss")];
  if (!boss) return ephemeral("Boss bulunamadı.");

  const minutes = parseDurationMinutes(getOption(interaction, "sure"));
  if (minutes == null) {
    return ephemeral("Süreyi anlayamadım. Örnek: `6s15d`, `6:15`, `375` (dakika) veya `0` (hazır).");
  }
  if (minutes < 0) return ephemeral("Süre negatif olamaz.");
  if (minutes > 43_200) return ephemeral("Süre en fazla 30 gün olabilir.");

  const now = Date.now();
  const until = minutes === 0 ? now : now + minutes * 60_000;
  const state = await readState(env);

  state.bosses[boss.id] = {
    until,
    updatedAt: now,
    updatedBy: actorName(interaction),
    announced: false,
  };
  state.updatedAt = now;
  await writeState(env, state);

  if (minutes === 0) {
    return ephemeral(`🟢 **${boss.short}** hazır olarak işaretlendi.`);
  }

  const unix = Math.floor(until / 1000);
  return ephemeral(
    `⏱️ **${boss.short}** için süre ayarlandı.\nHazır: <t:${unix}:R> · <t:${unix}:t>`,
  );
}

async function cmdClear(interaction, env) {
  if (!isAdmin(interaction, env)) return adminDenied();

  const id = getOption(interaction, "boss");
  const now = Date.now();
  const actor = actorName(interaction);
  const state = await readState(env);

  if (id === "__all__") {
    for (const boss of BOSSES) {
      state.bosses[boss.id] = {
        until: 0,
        updatedAt: now,
        updatedBy: actor,
        announced: false,
      };
    }
    state.updatedAt = now;
    await writeState(env, state);
    return ephemeral("🧹 Tüm boss sayaçları temizlendi.");
  }

  const boss = BOSS_MAP[id];
  if (!boss) return ephemeral("Boss bulunamadı.");

  state.bosses[boss.id] = {
    until: 0,
    updatedAt: now,
    updatedBy: actor,
    announced: false,
  };
  state.updatedAt = now;
  await writeState(env, state);

  return ephemeral(`🧹 **${boss.short}** sayacı temizlendi.`);
}

async function cmdStatus(env) {
  const state = await readState(env);
  const now = Date.now();

  const lines = BOSSES.map((boss) => {
    const s = state.bosses[boss.id] || {};
    const until = Number(s.until) || 0;
    const respawn = boss.respawnMin >= 60
      ? `${Math.floor(boss.respawnMin / 60)} sa${boss.respawnMin % 60 ? " " + (boss.respawnMin % 60) + " dk" : ""}`
      : `${boss.respawnMin} dk`;

    let status;
    if (!until) {
      status = "❔ bilinmiyor";
    } else if (until <= now) {
      status = "🟢 hazır";
    } else {
      const unix = Math.floor(until / 1000);
      status = `⏳ <t:${unix}:R> · <t:${unix}:t>`;
    }

    const by = until && s.updatedBy ? ` · son: ${s.updatedBy}` : "";
    return `**${boss.short}** (${respawn}) — ${status}${by}`;
  });

  const data = {
    embeds: [
      {
        title: "Aion 2 · Boss sayaçları",
        description: lines.join("\n"),
        color: 0xe8c06a,
        footer: { text: "Discord'dan /kes · /sure · /sifirla" },
        timestamp: new Date().toISOString(),
      },
    ],
  };

  const site = String(env.SITE_URL || "").trim();
  if (/^https?:\/\//i.test(site)) {
    data.components = [
      {
        type: 1,
        components: [{ type: 2, style: 5, label: "Siteyi aç", url: site }],
      },
    ];
  }

  return json({ type: 4, data });
}

function getOption(interaction, name) {
  const options = (interaction.data && interaction.data.options) || [];
  const option = options.find((o) => o.name === name);
  return option ? option.value : undefined;
}

function actorName(interaction) {
  const user = (interaction.member && interaction.member.user) || interaction.user || {};
  const name = user.global_name || user.username || "bilinmiyor";
  return String(name)
    .replace(/[*_~`|>\u0000-\u001f]/g, "")
    .trim()
    .slice(0, 80) || "bilinmiyor";
}

// "6s15d", "6 saat 15 dakika", "6:15", "375" gibi girişleri dakikaya çevirir.
export function parseDurationMinutes(input) {
  if (input == null) return null;

  let s = String(input).trim().toLowerCase().replace(/,/g, ".");
  if (!s) return null;
  s = s.replace(/\s+/g, " ");
  // "6 saat 15 dakika kaldı" gibi doğal yazımları da kabul et.
  s = s.replace(/\s+(?:kald[ıi]|kaldi|var|sonra|later|remaining|left)\.?$/i, "").trim();
  if (!s) return null;

  // 6:15 veya 6.15 => 6 saat 15 dakika
  const hm = s.match(/^(\d{1,3})\s*[:.]\s*(\d{1,2})$/);
  if (hm) {
    const hours = parseInt(hm[1], 10);
    const minutes = parseInt(hm[2], 10);
    if (minutes >= 60) return null;
    return hours * 60 + minutes;
  }

  // Birimli girişler. "d" burada dakika (6s15d = 6 saat 15 dakika);
  // gün için "g" kullanılır, böylece "6d" yanlışlıkla 6 gün olmaz.
  const unitRe =
    /(\d+)\s*(gün|gun|g|days?|day|saat|sa|s|hours?|hr|h|dakika|dak|dk|d|minutes?|mins?|min|m)/g;

  let total = 0;
  let matched = false;
  let lastIndex = 0;
  let clean = true;
  let m;

  while ((m = unitRe.exec(s)) !== null) {
    const between = s.slice(lastIndex, m.index);
    if (between.replace(/[\s+.,]/g, "") !== "") {
      clean = false;
      break;
    }

    const amount = parseInt(m[1], 10);
    const unit = m[2];

    if (/^(gün|gun|g|days?|day)$/.test(unit)) total += amount * 1440;
    else if (/^(saat|sa|s|hours?|hr|h)$/.test(unit)) total += amount * 60;
    else total += amount;

    matched = true;
    lastIndex = unitRe.lastIndex;
  }

  if (matched && clean) {
    const tail = s.slice(lastIndex).replace(/[\s+.,]/g, "");
    if (tail === "") return total;
  }

  // Sadece sayı => dakika
  if (/^\d+$/.test(s)) {
    return parseInt(s, 10);
  }

  return null;
}

// ---------------------------------------------------------------------------
// Slash komutlarını otomatik kaydet
// ---------------------------------------------------------------------------

// Cron her dakika çağırır. Komut listesi değiştiyse Discord'a bir kez PUT eder;
// böylece `npm run register` çalıştırmak şart olmaz. DISCORD_GUILD_ID boşsa
// global komut olarak kaydeder (tüm sunucularda görünür).
async function syncCommands(env) {
  if (!env.TIMERS || !env.DISCORD_BOT_TOKEN || !env.DISCORD_APP_ID) return;

  const path = env.DISCORD_GUILD_ID
    ? `/applications/${env.DISCORD_APP_ID}/guilds/${env.DISCORD_GUILD_ID}/commands`
    : `/applications/${env.DISCORD_APP_ID}/commands`;
  const fingerprint = path + "\n" + JSON.stringify(COMMANDS);

  if ((await env.TIMERS.get(COMMANDS_SYNC_KEY)) === fingerprint) return;

  const res = await fetch(DISCORD_API + path, {
    method: "PUT",
    headers: {
      Authorization: `Bot ${env.DISCORD_BOT_TOKEN}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(COMMANDS),
  });

  if (!res.ok) {
    console.error("commands sync failed", res.status, await res.text());
    return;
  }

  await env.TIMERS.put(COMMANDS_SYNC_KEY, fingerprint);
}

// ---------------------------------------------------------------------------
// Otomatik döngü
// ---------------------------------------------------------------------------

// Doğuşun üzerinden AUTO_KILL_SEC saniye geçen bossu kesilmiş sayar ve sayacı
// bir sonraki doğuşa kurar. Uzun süre kimse bakmasa da döngü kaldığı yerden
// tutarlı devam eder. /kes ve /sure ile yapılan düzeltmeler döngüyü kaydırır.
async function autoAdvance(env) {
  if (!env.TIMERS) return;

  const raw = Number(env.AUTO_KILL_SEC);
  const killSec = env.AUTO_KILL_SEC !== undefined && env.AUTO_KILL_SEC !== "" && Number.isFinite(raw) && raw >= 0
    ? raw
    : DEFAULT_AUTO_KILL_SEC;
  const killMs = killSec * 1000;

  const state = await readState(env);
  const now = Date.now();
  let changed = false;

  for (const boss of BOSSES) {
    const s = state.bosses[boss.id];
    if (!s || !s.until || !boss.respawnMin) continue;

    let until = Number(s.until);
    if (until + killMs > now) continue;

    const cycle = killMs + boss.respawnMin * 60_000;
    while (until + killMs <= now) until += cycle;

    state.bosses[boss.id] = {
      until,
      updatedAt: now,
      updatedBy: `otomatik (${killSec} sn)`,
      announced: false,
    };
    changed = true;
  }

  if (changed) {
    state.updatedAt = now;
    await writeState(env, state);
  }
}

// ---------------------------------------------------------------------------
// Sunucu etkinlikleri (Discord'da "Etkinlikler" altında geri sayım)
// ---------------------------------------------------------------------------

// Cron her dakika çağırır. Her boss için doğuş anında başlayan bir etkinlik tutar:
// sayaç değişince eskisini silip yenisini açar, doğuş gelince etkinliği başlatır.
// Etkinlik bilgisi ayrı KV anahtarında durur, komutların yazdığı state'e dokunmaz.
async function syncEvents(env) {
  if (!env.TIMERS || !env.DISCORD_BOT_TOKEN || !env.DISCORD_GUILD_ID) return;

  const state = await readState(env);
  const events = (await env.TIMERS.get(EVENTS_KEY, "json")) || {};
  const now = Date.now();
  let changed = false;

  for (const boss of BOSSES) {
    const s = state.bosses[boss.id] || {};
    const until = Number(s.until) || 0;
    const ev = events[boss.id];

    if (!ev || ev.until !== until) {
      if (ev && ev.id) await deleteEvent(env, ev.id);

      let id = null;
      let recorded = until;
      if (until > now + EVENT_LEAD_MS) {
        id = await createEvent(env, boss, until, s);
        // Açılamadıysa kaydetme; sonraki dakika yeniden denensin.
        if (!id) recorded = null;
      }
      events[boss.id] = { until: recorded, id, active: false };
      changed = true;
      continue;
    }

    if (ev.id && !ev.active && until <= now) {
      const res = await discordApi(env, "PATCH", `/guilds/${env.DISCORD_GUILD_ID}/scheduled-events/${ev.id}`, {
        status: 2,
      });
      // Geçici hatada (429/5xx) sonraki dakika tekrar dene; kalıcı hatada bırak.
      if (res.ok || (res.status < 500 && res.status !== 429)) {
        if (!res.ok) console.error("event start failed", boss.id, res.status, await res.text());
        ev.active = true;
        changed = true;
      }
    }
  }

  if (changed) await env.TIMERS.put(EVENTS_KEY, JSON.stringify(events));
}

async function createEvent(env, boss, until, s) {
  const lines = [`${boss.name} · ${boss.map}`];
  if (s.updatedBy) lines.push(`Son güncelleyen: ${s.updatedBy}`);
  if (env.SITE_URL) lines.push(env.SITE_URL);

  const res = await discordApi(env, "POST", `/guilds/${env.DISCORD_GUILD_ID}/scheduled-events`, {
    name: `⚔️ ${boss.short} doğuyor`,
    description: lines.join("\n"),
    privacy_level: 2,
    entity_type: 3,
    entity_metadata: { location: boss.map },
    scheduled_start_time: new Date(until).toISOString(),
    scheduled_end_time: new Date(until + EVENT_LENGTH_MS).toISOString(),
  });

  if (!res.ok) {
    console.error("event create failed", boss.id, res.status, await res.text());
    return null;
  }
  const data = await res.json();
  return data.id || null;
}

async function deleteEvent(env, id) {
  const res = await discordApi(env, "DELETE", `/guilds/${env.DISCORD_GUILD_ID}/scheduled-events/${id}`);
  // 404: etkinlik zaten bitmiş ya da elle silinmiş.
  if (!res.ok && res.status !== 404) {
    console.error("event delete failed", id, res.status, await res.text());
  }
}

function discordApi(env, method, path, body) {
  return fetch(DISCORD_API + path, {
    method,
    headers: {
      Authorization: `Bot ${env.DISCORD_BOT_TOKEN}`,
      "Content-Type": "application/json",
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

// ---------------------------------------------------------------------------
// Sabit tablo ve hatırlatmalar (BOARD_CHANNEL_ID kanalında)
// ---------------------------------------------------------------------------

function bossStatus(until, now) {
  if (!until) return "unknown";
  return until <= now ? "ready" : "counting";
}

// Tablo mesajının gövdesi: geri sayımı Discord'un <t:..:R> etiketi kendisi yürütür,
// bu yüzden mesaj yalnızca durum değişince düzenlenir.
function renderBoard(state, now, env) {
  const lines = BOSSES.map((boss) => {
    const s = state.bosses[boss.id] || {};
    const until = Number(s.until) || 0;
    const status = bossStatus(until, now);
    const unix = Math.floor(until / 1000);
    let line;
    if (status === "unknown") line = "❔ bilinmiyor";
    else if (status === "ready") line = "🟢 **hazır!**";
    else line = `⏳ <t:${unix}:R> · **<t:${unix}:t>**`;
    const by = s.updatedBy ? ` · _${s.updatedBy}_` : "";
    return `**${boss.short}** · ${boss.map}\n${line}${status === "unknown" ? "" : by}`;
  });

  const embed = {
    title: "⚔️ Boss Sayacı",
    description: lines.join("\n\n"),
    color: 0xf5c542,
    footer: { text: "Butona basınca boss şu an kesilmiş sayılır · düzeltmek için /sure" },
  };
  if (env.SITE_URL) embed.url = env.SITE_URL;

  const buttons = BOSSES.map((boss) => {
    const status = bossStatus(Number((state.bosses[boss.id] || {}).until) || 0, now);
    return {
      type: 2,
      style: status === "ready" ? 3 : 2,
      label: `${boss.short} kesildi`,
      emoji: { name: "⚔️" },
      custom_id: `kill:${boss.id}`,
    };
  });
  const components = [{ type: 1, components: buttons }];
  if (env.SITE_URL) {
    components.push({ type: 1, components: [{ type: 2, style: 5, label: "Siteyi aç", url: env.SITE_URL }] });
  }

  return { content: "", embeds: [embed], components, allowed_mentions: { parse: [] } };
}

function boardSignature(state, now) {
  return JSON.stringify(
    BOSSES.map((boss) => {
      const s = state.bosses[boss.id] || {};
      const until = Number(s.until) || 0;
      return [boss.id, until, s.updatedBy || "", bossStatus(until, now)];
    }),
  );
}

// Cron her dakika çağırır: tablo mesajını açar ya da durum değiştiyse düzenler,
// doğuşa REMIND_MIN dakika kala hatırlatma atar ve tur bitince hatırlatmayı siler.
// Komutlardan çağrılınca (fromCommand) yalnızca var olan tabloyu düzenler.
async function syncBoard(env, { fromCommand = false } = {}) {
  const channel = env.BOARD_CHANNEL_ID;
  if (!env.TIMERS || !env.DISCORD_BOT_TOKEN || !channel) return;

  const state = await readState(env);
  const stored = (await env.TIMERS.get(BOARD_KEY, "json")) || {};
  // Kanal değiştiyse eski kayıtları bırak, yeni kanalda baştan başla.
  const board = stored.channelId === channel ? stored : { channelId: channel, reminders: {} };
  board.reminders = board.reminders || {};
  const now = Date.now();
  let changed = board !== stored;

  if (!fromCommand) changed = (await syncReminders(env, state, board, now)) || changed;

  const sig = boardSignature(state, now);

  // Tablonun altına başka mesaj geldiyse yenisini en alta at, eskisini sil;
  // böylece tablo kanalda hep son mesaj olarak kalır.
  if (!fromCommand && board.messageId && (await boardIsBuried(env, channel, board.messageId))) {
    const res = await discordApi(env, "POST", `/channels/${channel}/messages`, renderBoard(state, now, env));
    if (res.ok) {
      const oldId = board.messageId;
      board.messageId = (await res.json()).id;
      board.sig = sig;
      changed = true;
      const del = await discordApi(env, "DELETE", `/channels/${channel}/messages/${oldId}`);
      if (!del.ok && del.status !== 404) console.error("old board delete failed", del.status);
    } else {
      console.error("board repost failed", res.status, await res.text());
    }
  }

  if (!board.messageId || board.sig !== sig) {
    const body = renderBoard(state, now, env);
    let res = null;
    if (board.messageId) {
      res = await discordApi(env, "PATCH", `/channels/${channel}/messages/${board.messageId}`, body);
    }
    // Mesaj yoksa ya da elle silindiyse (404) yenisini at.
    if (!fromCommand && (!res || res.status === 404)) {
      res = await discordApi(env, "POST", `/channels/${channel}/messages`, body);
      if (res.ok) board.messageId = (await res.json()).id;
    }
    if (res && res.ok) {
      board.sig = sig;
      changed = true;
    } else if (res) {
      console.error("board update failed", res.status, await res.text());
    }
  }

  if (changed) await env.TIMERS.put(BOARD_KEY, JSON.stringify(board));
}

// Kanalın son mesajı tablo değilse true döner. Kanal okunamazsa tabloya dokunma.
async function boardIsBuried(env, channel, messageId) {
  const res = await discordApi(env, "GET", `/channels/${channel}`);
  if (!res.ok) return false;
  try {
    const info = await res.json();
    return Boolean(info.last_message_id) && info.last_message_id !== messageId;
  } catch (_) {
    return false;
  }
}

async function syncReminders(env, state, board, now) {
  const raw = Number(env.REMIND_MIN);
  const remindMin = env.REMIND_MIN !== undefined && env.REMIND_MIN !== "" && Number.isFinite(raw)
    ? raw
    : DEFAULT_REMIND_MIN;
  const channel = env.BOARD_CHANNEL_ID;
  let changed = false;

  for (const boss of BOSSES) {
    const until = Number((state.bosses[boss.id] || {}).until) || 0;
    const r = board.reminders[boss.id];

    // Tur değişti (kesildi ya da otomatik ilerledi): eski hatırlatmayı kaldır.
    if (r && r.until !== until) {
      if (r.messageId) {
        const res = await discordApi(env, "DELETE", `/channels/${channel}/messages/${r.messageId}`);
        if (!res.ok && res.status !== 404) console.error("reminder delete failed", res.status);
      }
      delete board.reminders[boss.id];
      changed = true;
    }

    if (remindMin <= 0 || !until || until <= now || until - now > remindMin * 60_000) continue;
    if (board.reminders[boss.id]) continue;

    const unix = Math.floor(until / 1000);
    const ping = env.DISCORD_PING_ROLE_ID ? `<@&${env.DISCORD_PING_ROLE_ID}> ` : "";
    const res = await discordApi(env, "POST", `/channels/${channel}/messages`, {
      content: `${ping}⏰ **${boss.short}** <t:${unix}:R> doğuyor · <t:${unix}:t>`,
      allowed_mentions: { parse: [], roles: env.DISCORD_PING_ROLE_ID ? [env.DISCORD_PING_ROLE_ID] : [] },
    });
    if (!res.ok) {
      console.error("reminder failed", boss.id, res.status, await res.text());
      continue;
    }
    board.reminders[boss.id] = { until, messageId: (await res.json()).id };
    changed = true;
  }

  return changed;
}

// ---------------------------------------------------------------------------
// Zamanlanmış duyurular
// ---------------------------------------------------------------------------

async function announceReady(env) {
  if (!env.TIMERS || !env.DISCORD_BOT_TOKEN || !env.DISCORD_CHANNEL_ID) return;

  const state = await readState(env);
  const now = Date.now();
  let changed = false;

  for (const boss of BOSSES) {
    const s = state.bosses[boss.id];
    if (!s || !s.until || s.announced) continue;
    if (Number(s.until) > now) continue;

    const unix = Math.floor(Number(s.until) / 1000);
    const ping = env.DISCORD_PING_ROLE_ID ? `<@&${env.DISCORD_PING_ROLE_ID}> ` : "";
    const body = {
      content:
        `${ping}🟢 **${boss.short} hazır!** ${boss.name} (${boss.map})\n` +
        `Son kesen: ${s.updatedBy || "bilinmiyor"} · <t:${unix}:t>`,
      allowed_mentions: {
        parse: [],
        roles: env.DISCORD_PING_ROLE_ID ? [env.DISCORD_PING_ROLE_ID] : [],
      },
    };

    const res = await fetch(`${DISCORD_API}/channels/${env.DISCORD_CHANNEL_ID}/messages`, {
      method: "POST",
      headers: {
        Authorization: `Bot ${env.DISCORD_BOT_TOKEN}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
    });

    if (!res.ok) {
      console.error("announce failed", boss.id, res.status, await res.text());
      continue;
    }

    s.announced = true;
    changed = true;
  }

  if (changed) {
    state.updatedAt = now;
    await writeState(env, state);
  }
}

// ---------------------------------------------------------------------------
// Yardımcılar
// ---------------------------------------------------------------------------

function json(data, status = 200, headers = {}) {
  const h = new Headers(headers);
  if (!h.has("content-type")) h.set("content-type", "application/json; charset=utf-8");
  if (!h.has("cache-control")) h.set("cache-control", "no-store");
  return new Response(JSON.stringify(data), { status, headers: h });
}

function ephemeral(content) {
  return json({ type: 4, data: { content, flags: 64 } });
}

function statusPage() {
  const html = `<!doctype html>
<html lang="tr">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Aion 2 Boss Timer API</title>
<style>
body{font:15px/1.5 system-ui,-apple-system,"Segoe UI",sans-serif;background:#0b0d12;color:#e7e9ef;max-width:640px;margin:48px auto;padding:0 20px}
a{color:#e8c06a}code{background:#1a1f2c;border:1px solid #262d3f;padding:2px 6px;border-radius:5px}
h1{font-size:22px}
</style>
</head>
<body>
<h1>Aion 2 Boss Timer API</h1>
<p>API çalışıyor. Site bu adresten okuyor:</p>
<p><code>GET /api/timers</code></p>
<p>Discord interactions endpoint: <code>POST /discord</code></p>
<p><a href="/api/timers">Sayaçları gör</a></p>
</body>
</html>`;
  return new Response(html, {
    headers: {
      "content-type": "text/html; charset=utf-8",
      "cache-control": "no-store",
    },
  });
}
