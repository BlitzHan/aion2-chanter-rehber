import test from "node:test";
import assert from "node:assert/strict";
import worker from "../src/index.js";

const MIN = 60_000;

function fakeKV(init = {}) {
  const m = new Map(Object.entries(init).map(([k, v]) => [k, JSON.stringify(v)]));
  return {
    m,
    async get(k, type) {
      const v = m.has(k) ? m.get(k) : null;
      return v != null && type === "json" ? JSON.parse(v) : v;
    },
    async put(k, v) { m.set(k, v); },
  };
}

// Sadece etkinlik isteklerini kaydeder; diğer Discord çağrılarına (komut kaydı) 200 döner.
function mockDiscord(respond = () => null) {
  const calls = [];
  let nextId = 1;
  globalThis.fetch = async (url, init) => {
    if (!url.includes("/scheduled-events")) return new Response("[]", { status: 200 });
    const call = { url, method: init.method, body: init.body ? JSON.parse(init.body) : null };
    calls.push(call);
    const custom = respond(call);
    if (custom) return custom;
    if (call.method === "POST") return Response.json({ id: `ev${nextId++}` });
    return new Response(null, { status: 204 });
  };
  return calls;
}

async function runCron(env) {
  const jobs = [];
  await worker.scheduled({}, env, { waitUntil: (p) => jobs.push(p) });
  await Promise.all(jobs);
}

function envWith(bosses) {
  return {
    TIMERS: fakeKV({ state: { bosses, updatedAt: 1 } }),
    DISCORD_BOT_TOKEN: "t",
    DISCORD_GUILD_ID: "g1",
  };
}

const realFetch = globalThis.fetch;
const realErr = console.error;
test.afterEach(() => {
  globalThis.fetch = realFetch;
  console.error = realErr;
});

test("etkinlik: gelecekteki doğuş için bir kez açılır, değişmezse tekrar açılmaz", async () => {
  const calls = mockDiscord();
  const until = Date.now() + 90 * MIN;
  const env = envWith({ "Immortal Gartua": { until, updatedBy: "Ali" } });

  await runCron(env);
  await runCron(env);

  assert.equal(calls.length, 1);
  const [c] = calls;
  assert.equal(c.method, "POST");
  assert.match(c.url, /\/guilds\/g1\/scheduled-events$/);
  assert.equal(c.body.entity_type, 3);
  assert.equal(c.body.privacy_level, 2);
  assert.equal(c.body.entity_metadata.location, "Altgard");
  assert.equal(Date.parse(c.body.scheduled_start_time), until);
  assert.ok(Date.parse(c.body.scheduled_end_time) > until);
  assert.match(c.body.name, /Gartua/);
  assert.match(c.body.description, /Ali/);
});

test("etkinlik: sayaç değişince eskisi silinir, yenisi açılır", async () => {
  const calls = mockDiscord();
  const env = envWith({ "Immortal Gartua": { until: Date.now() + 90 * MIN } });
  await runCron(env);

  const state = JSON.parse(env.TIMERS.m.get("state"));
  const newUntil = Date.now() + 720 * MIN;
  state.bosses["Immortal Gartua"].until = newUntil;
  env.TIMERS.m.set("state", JSON.stringify(state));
  await runCron(env);

  assert.deepEqual(calls.map((c) => c.method), ["POST", "DELETE", "POST"]);
  assert.match(calls[1].url, /\/scheduled-events\/ev1$/);
  assert.equal(Date.parse(calls[2].body.scheduled_start_time), newUntil);
});

test("etkinlik: sıfırlanınca silinir ve yenisi açılmaz", async () => {
  const calls = mockDiscord();
  const env = envWith({ "Immortal Gartua": { until: Date.now() + 90 * MIN } });
  await runCron(env);

  env.TIMERS.m.set("state", JSON.stringify({ bosses: {}, updatedAt: 2 }));
  await runCron(env);
  await runCron(env);

  assert.deepEqual(calls.map((c) => c.method), ["POST", "DELETE"]);
});

test("etkinlik: doğuş anı gelince bir kez başlatılır (status 2)", async () => {
  const calls = mockDiscord();
  // Otomatik döngü 40 sn sonra devreye girer; doğuşun üzerinden daha az geçmiş olsun.
  const until = Date.now() - 20_000;
  const env = envWith({ "Immortal Gartua": { until } });
  env.TIMERS.m.set("events", JSON.stringify({ "Immortal Gartua": { until, id: "ev9", active: false } }));

  await runCron(env);
  await runCron(env);

  assert.equal(calls.length, 1);
  assert.equal(calls[0].method, "PATCH");
  assert.match(calls[0].url, /\/scheduled-events\/ev9$/);
  assert.deepEqual(calls[0].body, { status: 2 });
});

test("etkinlik: çok yakın ya da geçmiş doğuş için etkinlik açılmaz", async () => {
  const calls = mockDiscord();
  const env = envWith({
    "Immortal Gartua": { until: Date.now() + 10_000 },
    "Silent Dartan (Altgard)": { until: Date.now() - 20_000 },
  });
  await runCron(env);
  assert.equal(calls.length, 0);
});

test("etkinlik: açma başarısızsa sonraki dakikada yeniden dener", async () => {
  console.error = () => {};
  let fail = true;
  const calls = mockDiscord((c) => (c.method === "POST" && fail ? new Response("x", { status: 403 }) : null));
  const env = envWith({ "Immortal Gartua": { until: Date.now() + 90 * MIN } });

  await runCron(env);
  fail = false;
  await runCron(env);
  await runCron(env);

  assert.deepEqual(calls.map((c) => c.method), ["POST", "POST"]);
});

test("etkinlik: silinecek etkinlik zaten yoksa (404) yenisini yine açar", async () => {
  const calls = mockDiscord((c) => (c.method === "DELETE" ? new Response("", { status: 404 }) : null));
  const env = envWith({ "Immortal Gartua": { until: Date.now() + 300 * MIN } });
  env.TIMERS.m.set("events", JSON.stringify({ "Immortal Gartua": { until: 123, id: "old", active: true } }));

  await runCron(env);
  assert.deepEqual(calls.map((c) => c.method), ["DELETE", "POST"]);
});

test("etkinlik: sunucu ID'si yoksa hiç istek atmaz", async () => {
  const calls = mockDiscord();
  const env = envWith({ "Immortal Gartua": { until: Date.now() + 90 * MIN } });
  delete env.DISCORD_GUILD_ID;
  await runCron(env);
  assert.equal(calls.length, 0);
});
