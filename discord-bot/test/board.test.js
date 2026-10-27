import test from "node:test";
import assert from "node:assert/strict";
import worker from "../src/index.js";

const MIN = 60_000;
const GARTUA = "Immortal Gartua";

function fakeKV(state) {
  const m = new Map([["state", JSON.stringify(state)]]);
  return {
    m,
    async get(k, type) {
      const v = m.has(k) ? m.get(k) : null;
      return v != null && type === "json" ? JSON.parse(v) : v;
    },
    async put(k, v) { m.set(k, v); },
  };
}

// Kanal mesajı isteklerini kaydeder; diğer Discord çağrılarına 200 döner.
function mockDiscord(respond = () => null) {
  const calls = [];
  let nextId = 1;
  globalThis.fetch = async (url, init) => {
    if (!url.includes("/channels/")) return new Response("[]", { status: 200 });
    const call = { url, method: init.method, body: init.body ? JSON.parse(init.body) : null };
    calls.push(call);
    const custom = respond(call);
    if (custom) return custom;
    if (call.method === "POST") return Response.json({ id: `m${nextId++}` });
    if (call.method === "PATCH") return Response.json({ id: url.split("/").pop() });
    return new Response(null, { status: 204 });
  };
  return calls;
}

async function runCron(env) {
  const jobs = [];
  await worker.scheduled({}, env, { waitUntil: (p) => jobs.push(p) });
  await Promise.all(jobs);
}

function envWith(bosses, extra = {}) {
  return {
    TIMERS: fakeKV({ bosses, updatedAt: 1 }),
    DISCORD_BOT_TOKEN: "t",
    BOARD_CHANNEL_ID: "c1",
    SITE_URL: "https://site.test/#boss",
    ...extra,
  };
}

function setUntil(env, id, until) {
  const state = JSON.parse(env.TIMERS.m.get("state"));
  state.bosses[id] = { ...(state.bosses[id] || {}), until };
  env.TIMERS.m.set("state", JSON.stringify(state));
}

const realFetch = globalThis.fetch;
const realErr = console.error;
test.afterEach(() => {
  globalThis.fetch = realFetch;
  console.error = realErr;
});

test("tablo: ilk çalışmada kanala bir kez atılır, değişmezse dokunulmaz", async () => {
  const calls = mockDiscord();
  const until = Date.now() + 90 * MIN;
  const env = envWith({ [GARTUA]: { until, updatedBy: "Ali" } });

  await runCron(env);
  await runCron(env);

  assert.equal(calls.length, 1);
  const [c] = calls;
  assert.equal(c.method, "POST");
  assert.match(c.url, /\/channels\/c1\/messages$/);
  const desc = c.body.embeds[0].description;
  assert.match(desc, new RegExp(`<t:${Math.floor(until / 1000)}:R>`));
  assert.match(desc, /Ali/);
  assert.match(desc, /bilinmiyor/);
  // Gartua, Lagta, Kashapa, Dartan sırası
  assert.ok(desc.indexOf("Gartua") < desc.indexOf("Lagta"));
  assert.ok(desc.indexOf("Kashapa") < desc.indexOf("Dartan"));
  const buttons = c.body.components[0].components;
  assert.deepEqual(buttons.map((b) => b.custom_id), [
    "kill:Immortal Gartua",
    "kill:High Commander Lagta (Altgard)",
    "kill:Soul Ruler Kashapa (Altgard)",
    "kill:Silent Dartan (Altgard)",
  ]);
  assert.equal(c.body.components[1].components[0].url, "https://site.test/#boss");
});

test("tablo: sayaç değişince aynı mesaj düzenlenir", async () => {
  const calls = mockDiscord();
  const env = envWith({ [GARTUA]: { until: Date.now() + 90 * MIN } });
  await runCron(env);

  setUntil(env, GARTUA, Date.now() + 300 * MIN);
  await runCron(env);

  assert.deepEqual(calls.map((c) => c.method), ["POST", "PATCH"]);
  assert.match(calls[1].url, /\/channels\/c1\/messages\/m1$/);
});

test("tablo: mesaj elle silindiyse (404) yenisi atılır", async () => {
  const calls = mockDiscord((c) => (c.method === "PATCH" ? new Response("", { status: 404 }) : null));
  const env = envWith({ [GARTUA]: { until: Date.now() + 90 * MIN } });
  await runCron(env);
  setUntil(env, GARTUA, Date.now() + 300 * MIN);
  await runCron(env);

  assert.deepEqual(calls.map((c) => c.method), ["POST", "PATCH", "POST"]);
  assert.equal(JSON.parse(env.TIMERS.m.get("board")).messageId, "m2");
});

test("tablo: kanal ayarı yoksa hiç istek atmaz", async () => {
  const calls = mockDiscord();
  const env = envWith({ [GARTUA]: { until: Date.now() + 3 * MIN } }, { BOARD_CHANNEL_ID: "" });
  await runCron(env);
  assert.equal(calls.length, 0);
});

test("hatırlatma: doğuşa 5 dk kala bir kez atılır, tur değişince silinir", async () => {
  const calls = mockDiscord();
  const until = Date.now() + 3 * MIN;
  const env = envWith({ [GARTUA]: { until } });

  await runCron(env);
  await runCron(env);
  const reminders = calls.filter((c) => c.method === "POST" && c.body.content);
  assert.equal(reminders.length, 1);
  assert.match(reminders[0].body.content, /⏰ \*\*Gartua\*\*/);

  setUntil(env, GARTUA, Date.now() + 720 * MIN);
  await runCron(env);
  const del = calls.filter((c) => c.method === "DELETE");
  assert.equal(del.length, 1);
  assert.match(del[0].url, /\/channels\/c1\/messages\/m\d+$/);
});

test("hatırlatma: 5 dk'dan uzaksa ya da REMIND_MIN 0 ise atılmaz", async () => {
  const calls = mockDiscord();
  await runCron(envWith({ [GARTUA]: { until: Date.now() + 20 * MIN } }));
  await runCron(envWith({ [GARTUA]: { until: Date.now() + 3 * MIN } }, { REMIND_MIN: "0" }));
  assert.equal(calls.filter((c) => c.body && c.body.content).length, 0);
});

// ---------------------------------------------------------------------------
// Butonlar (imzalı Discord isteği)
// ---------------------------------------------------------------------------

const toHex = (b) => Array.from(new Uint8Array(b)).map((x) => x.toString(16).padStart(2, "0")).join("");

async function signedButton(customId, permissions) {
  const pair = await crypto.subtle.generateKey({ name: "Ed25519" }, true, ["sign", "verify"]);
  const publicKeyHex = toHex(await crypto.subtle.exportKey("raw", pair.publicKey));
  const env = { TIMERS: fakeKV({ bosses: {}, updatedAt: 0 }), DISCORD_PUBLIC_KEY: publicKeyHex };
  const body = JSON.stringify({
    type: 3,
    data: { custom_id: customId, component_type: 2 },
    member: { user: { id: "1", username: "ali" }, roles: [], permissions },
  });
  const ts = String(Math.floor(Date.now() / 1000));
  const sig = toHex(await crypto.subtle.sign({ name: "Ed25519" }, pair.privateKey, new TextEncoder().encode(ts + body)));
  const res = await worker.fetch(
    new Request("https://worker.test/discord", {
      method: "POST",
      headers: { "X-Signature-Ed25519": sig, "X-Signature-Timestamp": ts },
      body,
    }),
    env,
    { waitUntil() {} },
  );
  return { env, res, payload: await res.json() };
}

test("buton: yetkili basınca boss kesilir ve tablo yerinde güncellenir (type 7)", async () => {
  const { env, res, payload } = await signedButton(`kill:${GARTUA}`, "8");
  assert.equal(res.status, 200);
  assert.equal(payload.type, 7);
  assert.match(payload.data.embeds[0].description, /Gartua/);
  const g = JSON.parse(env.TIMERS.m.get("state")).bosses[GARTUA];
  assert.ok(Math.abs(g.until - (Date.now() + 720 * MIN)) <= MIN);
  assert.equal(g.updatedBy, "ali");
});

test("buton: yetkisiz basınca ⛔ döner ve sayaç değişmez", async () => {
  const { env, payload } = await signedButton(`kill:${GARTUA}`, "0");
  assert.equal(payload.type, 4);
  assert.match(payload.data.content, /⛔/);
  assert.deepEqual(JSON.parse(env.TIMERS.m.get("state")).bosses, {});
});

test("buton: bilinmeyen boss reddedilir", async () => {
  const { payload } = await signedButton("kill:Yok Boyle Boss", "8");
  assert.equal(payload.type, 4);
  assert.equal(payload.data.flags, 64);
});
