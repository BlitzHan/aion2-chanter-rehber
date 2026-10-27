import test from "node:test";
import assert from "node:assert/strict";
import worker from "../src/index.js";

const GARTUA = "Immortal Gartua";
const toHex = (b) => Array.from(new Uint8Array(b)).map((x) => x.toString(16).padStart(2, "0")).join("");

function fakeKV() {
  const m = new Map([["state", JSON.stringify({ bosses: {}, updatedAt: 0 })]]);
  return {
    m,
    async get(k, type) {
      const v = m.has(k) ? m.get(k) : null;
      return v != null && type === "json" ? JSON.parse(v) : v;
    },
    async put(k, v) { m.set(k, v); },
  };
}

// İzinli liste: "10" ve "20". Yönetici izni ("8") tek başına yetmemeli.
async function send(interaction) {
  const pair = await crypto.subtle.generateKey({ name: "Ed25519" }, true, ["sign", "verify"]);
  const env = {
    TIMERS: fakeKV(),
    DISCORD_PUBLIC_KEY: toHex(await crypto.subtle.exportKey("raw", pair.publicKey)),
    DISCORD_ALLOWED_USER_IDS: " 10, 20 ",
  };
  const body = JSON.stringify(interaction);
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
  return { payload: await res.json(), bosses: JSON.parse(env.TIMERS.m.get("state")).bosses };
}

const member = (id, permissions) => ({ user: { id, username: `u${id}` }, roles: [], permissions });
const button = (id, permissions) => ({ type: 3, data: { custom_id: `kill:${GARTUA}` }, member: member(id, permissions) });
const kes = (id, permissions) => ({
  type: 2,
  data: { name: "kes", options: [{ name: "boss", value: GARTUA }] },
  member: member(id, permissions),
});

test("izinli liste: listedeki kişi yönetici olmasa da butona basabilir", async () => {
  const { payload, bosses } = await send(button("20", "0"));
  assert.equal(payload.type, 7);
  assert.ok(bosses[GARTUA].until > Date.now());
});

test("izinli liste: listede olmayan yönetici butona basamaz", async () => {
  const { payload, bosses } = await send(button("99", "8"));
  assert.equal(payload.type, 4);
  assert.match(payload.data.content, /⛔/);
  assert.deepEqual(bosses, {});
});

test("izinli liste: /kes komutu da aynı kurala uyar", async () => {
  const denied = await send(kes("99", "8"));
  assert.match(denied.payload.data.content, /⛔/);
  assert.deepEqual(denied.bosses, {});

  const ok = await send(kes("10", "0"));
  assert.match(ok.payload.data.content, /kesildi/);
  assert.ok(ok.bosses[GARTUA].until > Date.now());
});

test("izinli liste: /durum herkese açık kalır", async () => {
  const { payload } = await send({ type: 2, data: { name: "durum" }, member: member("99", "0") });
  assert.equal(payload.type, 4);
  assert.doesNotMatch(JSON.stringify(payload), /⛔/);
});
