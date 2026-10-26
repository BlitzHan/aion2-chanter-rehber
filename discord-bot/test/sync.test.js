import test from "node:test";
import assert from "node:assert/strict";
import worker from "../src/index.js";
import { COMMANDS } from "../src/commands.js";

function fakeKV() {
  const m = new Map();
  return {
    async get(k, type) {
      const v = m.has(k) ? m.get(k) : null;
      return v != null && type === "json" ? JSON.parse(v) : v;
    },
    async put(k, v) { m.set(k, v); },
  };
}

async function runCron(env) {
  const jobs = [];
  await worker.scheduled({}, env, { waitUntil: (p) => jobs.push(p) });
  await Promise.all(jobs);
}

test("cron: komutları bir kez global kaydeder, değişmediyse tekrar göndermez", async () => {
  const calls = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    calls.push({ url, init });
    return new Response("[]", { status: 200 });
  };
  try {
    const env = { TIMERS: fakeKV(), DISCORD_BOT_TOKEN: "t", DISCORD_APP_ID: "42" };
    await runCron(env);
    await runCron(env);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].url, "https://discord.com/api/v10/applications/42/commands");
    assert.equal(calls[0].init.method, "PUT");
    assert.deepEqual(JSON.parse(calls[0].init.body), COMMANDS);

    env.DISCORD_GUILD_ID = "7";
    await runCron(env);
    assert.equal(calls.length, 2);
    assert.equal(calls[1].url, "https://discord.com/api/v10/applications/42/guilds/7/commands");
  } finally {
    globalThis.fetch = realFetch;
  }
});

test("cron: Discord hata verirse kaydı işaretlemez, sonraki dakikada yeniden dener", async () => {
  let n = 0;
  const realFetch = globalThis.fetch;
  globalThis.fetch = async () => {
    n++;
    return new Response("err", { status: n === 1 ? 401 : 200 });
  };
  const realErr = console.error;
  console.error = () => {};
  try {
    const env = { TIMERS: fakeKV(), DISCORD_BOT_TOKEN: "t", DISCORD_APP_ID: "42" };
    await runCron(env);
    await runCron(env);
    await runCron(env);
    assert.equal(n, 2);
  } finally {
    globalThis.fetch = realFetch;
    console.error = realErr;
  }
});

test("cron: token yoksa Discord'a istek atmaz", async () => {
  let n = 0;
  const realFetch = globalThis.fetch;
  globalThis.fetch = async () => { n++; return new Response("[]"); };
  try {
    await runCron({ TIMERS: fakeKV(), DISCORD_APP_ID: "42" });
    assert.equal(n, 0);
  } finally {
    globalThis.fetch = realFetch;
  }
});
