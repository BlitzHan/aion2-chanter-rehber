import { BOSSES, BOSS_MAP } from "./bosses.js";
import { COMMANDS } from "./commands.js";

const STATE_KEY = "state";
const COMMANDS_SYNC_KEY = "commands_sync";
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
      return handleDiscord(request, env);
    }

    if ((url.pathname === "/" || url.pathname === "/health") && request.method === "GET") {
      return statusPage();
    }

    return json({ ok: false, error: "not_found" }, 404, CORS);
  },

  async scheduled(controller, env, ctx) {
    ctx.waitUntil(syncCommands(env).catch((err) => console.error("syncCommands failed", err)));
    ctx.waitUntil(announceReady(env));
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

async function handleDiscord(request, env) {
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

  if (interaction.type !== 2) {
    return ephemeral("Bu bot sadece slash komutlarını destekliyor.");
  }

  const name = interaction.data && interaction.data.name;

  try {
    if (name === "durum") return await cmdStatus(env);
    if (name === "kes") return await cmdKill(interaction, env);
    if (name === "sure") return await cmdSet(interaction, env);
    if (name === "sifirla") return await cmdClear(interaction, env);
    return ephemeral("Bilinmeyen komut.");
  } catch (err) {
    console.error("command failed", name, err);
    return ephemeral("Bir hata oluştu. Biraz sonra tekrar dene.");
  }
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
  return ephemeral("⛔ Bu komutu sadece yetkili rol kullanabilir.");
}

async function cmdKill(interaction, env) {
  if (!isAdmin(interaction, env)) return adminDenied();

  const boss = BOSS_MAP[getOption(interaction, "boss")];
  if (!boss) return ephemeral("Boss bulunamadı.");

  if (!boss.respawnMin) {
    return ephemeral("Bu boss için yeniden doğma süresi tanımlı değil. `/sure` ile elle ayarla.");
  }

  const now = Date.now();
  const until = now + boss.respawnMin * 60_000;
  const state = await readState(env);

  state.bosses[boss.id] = {
    until,
    updatedAt: now,
    updatedBy: actorName(interaction),
    announced: false,
  };
  state.updatedAt = now;
  await writeState(env, state);

  const unix = Math.floor(until / 1000);
  return ephemeral(
    `✅ **${boss.short}** kesildi.\nYeniden doğma: <t:${unix}:R> · <t:${unix}:t>`,
  );
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
