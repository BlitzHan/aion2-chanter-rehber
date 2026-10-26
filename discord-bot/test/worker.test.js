import test from "node:test";
import assert from "node:assert/strict";

import worker from "../src/index.js";

// Node'da Cloudflare Cache API yok; getTimers'ın kullandığı caches.default'u taklit et.
globalThis.caches = {
  default: {
    match: async () => undefined,
    put: async () => {},
  },
};

// ctx.waitUntil: arka plan promise'lerini yut.
const ctx = {
  waitUntil(_promise) {
    /* yut */
  },
};

// ---------------------------------------------------------------------------
// Yardımcılar
// ---------------------------------------------------------------------------

// Map tabanlı sahte KV: anahtar "state".
function makeKV() {
  const store = new Map();
  return {
    store,
    async get(key, type) {
      const value = store.has(key) ? store.get(key) : null;
      if (value == null) return null;
      return type === "json" ? JSON.parse(value) : value;
    },
    async put(key, value) {
      store.set(key, value);
    },
  };
}

function makeEnv(publicKeyHex) {
  return { TIMERS: makeKV(), DISCORD_PUBLIC_KEY: publicKeyHex };
}

function toHex(bytes) {
  return Array.from(new Uint8Array(bytes))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

async function makeKeyPair() {
  const pair = await crypto.subtle.generateKey({ name: "Ed25519" }, true, ["sign", "verify"]);
  const raw = await crypto.subtle.exportKey("raw", pair.publicKey);
  return { privateKey: pair.privateKey, publicKeyHex: toHex(raw) };
}

async function sign(keyPair, timestamp, body) {
  const data = new TextEncoder().encode(timestamp + body);
  const signature = await crypto.subtle.sign({ name: "Ed25519" }, keyPair.privateKey, data);
  return toHex(signature);
}

function commandBody(name, options, permissions = "8") {
  return JSON.stringify({
    type: 2,
    data: { name, options },
    member: { user: { id: "1", username: "test" }, roles: [], permissions },
  });
}

// Doğru imzalı POST /discord isteği gönderir.
async function signedPost(env, keyPair, body, { timestamp, signWith } = {}) {
  const ts = timestamp ?? String(Math.floor(Date.now() / 1000));
  const signature = await sign(signWith ?? keyPair, ts, body);
  const request = new Request("https://worker.test/discord", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "X-Signature-Ed25519": signature,
      "X-Signature-Timestamp": ts,
    },
    body,
  });
  return worker.fetch(request, env, ctx);
}

async function getTimers(env) {
  const res = await worker.fetch(
    new Request("https://worker.test/api/timers?fresh=1", { method: "GET" }),
    env,
    ctx,
  );
  return { res, body: await res.json() };
}

function findBoss(body, id) {
  return body.bosses.find((b) => b.id === id);
}

const MIN = 60_000;

// ---------------------------------------------------------------------------
// Testler
// ---------------------------------------------------------------------------

test("GET /api/timers: 200, CORS başlığı ve boş sayaçlar", async () => {
  const { publicKeyHex } = await makeKeyPair();
  const env = makeEnv(publicKeyHex);

  const res = await worker.fetch(
    new Request("https://worker.test/api/timers", { method: "GET" }),
    env,
    ctx,
  );
  assert.equal(res.status, 200);
  assert.equal(res.headers.get("Access-Control-Allow-Origin"), "*");

  const body = await res.json();
  assert.equal(body.ok, true);
  assert.equal(body.bosses.length, 4);
  for (const boss of body.bosses) {
    assert.equal(boss.until, 0, `${boss.id} başlangıçta until 0 olmalı`);
  }
});

test("OPTIONS /api/timers: 204", async () => {
  const { publicKeyHex } = await makeKeyPair();
  const env = makeEnv(publicKeyHex);

  const res = await worker.fetch(
    new Request("https://worker.test/api/timers", { method: "OPTIONS" }),
    env,
    ctx,
  );
  assert.equal(res.status, 204);
});

test("GET /bilinmeyen: 404", async () => {
  const { publicKeyHex } = await makeKeyPair();
  const env = makeEnv(publicKeyHex);

  const res = await worker.fetch(
    new Request("https://worker.test/bilinmeyen", { method: "GET" }),
    env,
    ctx,
  );
  assert.equal(res.status, 404);
});

test("GET /health: 200", async () => {
  const { publicKeyHex } = await makeKeyPair();
  const env = makeEnv(publicKeyHex);

  const res = await worker.fetch(
    new Request("https://worker.test/health", { method: "GET" }),
    env,
    ctx,
  );
  assert.equal(res.status, 200);
});

test("POST /discord: imzasız istek 401", async () => {
  const { publicKeyHex } = await makeKeyPair();
  const env = makeEnv(publicKeyHex);

  const res = await worker.fetch(
    new Request("https://worker.test/discord", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ type: 1 }),
    }),
    env,
    ctx,
  );
  assert.equal(res.status, 401);
});

test("POST /discord: yanlış anahtarla imzalı istek 401", async () => {
  const keyPair = await makeKeyPair();
  const wrongPair = await makeKeyPair();
  const env = makeEnv(keyPair.publicKeyHex);

  const res = await signedPost(env, keyPair, JSON.stringify({ type: 1 }), {
    signWith: wrongPair,
  });
  assert.equal(res.status, 401);
});

test("POST /discord: 10 dakikadan eski timestamp 401", async () => {
  const keyPair = await makeKeyPair();
  const env = makeEnv(keyPair.publicKeyHex);
  const oldTimestamp = String(Math.floor(Date.now() / 1000) - 600);

  const res = await signedPost(env, keyPair, JSON.stringify({ type: 1 }), {
    timestamp: oldTimestamp,
  });
  assert.equal(res.status, 401);
});

test("POST /discord: doğru imzalı PING {type:1} döner", async () => {
  const keyPair = await makeKeyPair();
  const env = makeEnv(keyPair.publicKeyHex);

  const res = await signedPost(env, keyPair, JSON.stringify({ type: 1 }));
  assert.equal(res.status, 200);

  const body = await res.json();
  assert.deepEqual(body, { type: 1 });
});

test("/kes (yönetici): Gartua sayacı ~720 dk sonrasına kurulur", async () => {
  const keyPair = await makeKeyPair();
  const env = makeEnv(keyPair.publicKeyHex);
  const body = commandBody("kes", [{ name: "boss", value: "Immortal Gartua" }], "8");

  const res = await signedPost(env, keyPair, body);
  assert.equal(res.status, 200);
  const payload = await res.json();
  assert.equal(payload.type, 4);

  const { body: timers } = await getTimers(env);
  const gartua = findBoss(timers, "Immortal Gartua");
  assert.ok(gartua, "Gartua kaydı dönmeli");
  const diff = gartua.until - Date.now();
  assert.ok(
    Math.abs(diff - 720 * MIN) <= MIN,
    `Gartua until ~720 dk sonrası olmalı, fark: ${Math.round(diff / MIN)} dk`,
  );
});

test("/kes (yetkisiz üye): ⛔ döner, KV değişmez", async () => {
  const keyPair = await makeKeyPair();
  const env = makeEnv(keyPair.publicKeyHex);
  const before = JSON.stringify([...env.TIMERS.store.entries()]);
  const body = commandBody("kes", [{ name: "boss", value: "Immortal Gartua" }], "0");

  const res = await signedPost(env, keyPair, body);
  assert.equal(res.status, 200);

  const payload = await res.json();
  assert.ok(
    String(payload.data && payload.data.content).includes("⛔"),
    `yetkisiz cevap ⛔ içermeli: ${JSON.stringify(payload)}`,
  );

  const after = JSON.stringify([...env.TIMERS.store.entries()]);
  assert.equal(after, before, "yetkisiz istek KV'yi değiştirmemeli");
});

test("/sure (yönetici): Dartan sayacı 1s30d = ~90 dk sonrasına kurulur", async () => {
  const keyPair = await makeKeyPair();
  const env = makeEnv(keyPair.publicKeyHex);
  const body = commandBody(
    "sure",
    [
      { name: "boss", value: "Silent Dartan (Altgard)" },
      { name: "sure", value: "1s30d" },
    ],
    "8",
  );

  const res = await signedPost(env, keyPair, body);
  assert.equal(res.status, 200);

  const { body: timers } = await getTimers(env);
  const dartan = findBoss(timers, "Silent Dartan (Altgard)");
  assert.ok(dartan, "Dartan kaydı dönmeli");
  const diff = dartan.until - Date.now();
  assert.ok(
    Math.abs(diff - 90 * MIN) <= MIN,
    `Dartan until ~90 dk sonrası olmalı, fark: ${Math.round(diff / MIN)} dk`,
  );
});

test("/sifirla boss=__all__ (yönetici): tüm sayaçlar 0 olur", async () => {
  const keyPair = await makeKeyPair();
  const env = makeEnv(keyPair.publicKeyHex);

  // Önce bir sayaç kur ki temizleme anlamlı olsun.
  const killBody = commandBody("kes", [{ name: "boss", value: "Immortal Gartua" }], "8");
  const killRes = await signedPost(env, keyPair, killBody);
  assert.equal(killRes.status, 200);

  const { body: before } = await getTimers(env);
  assert.ok(findBoss(before, "Immortal Gartua").until > 0, "temizlemeden önce sayaç dolu olmalı");

  // src/commands.js'te "Hepsi" seçeneğinin değeri "__all__".
  const clearBody = commandBody("sifirla", [{ name: "boss", value: "__all__" }], "8");
  const clearRes = await signedPost(env, keyPair, clearBody);
  assert.equal(clearRes.status, 200);

  const { body: after } = await getTimers(env);
  for (const boss of after.bosses) {
    assert.equal(boss.until, 0, `${boss.id} temizlendikten sonra until 0 olmalı`);
  }
});
