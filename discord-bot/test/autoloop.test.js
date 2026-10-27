import test from "node:test";
import assert from "node:assert/strict";
import worker from "../src/index.js";

const MIN = 60_000;

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

async function runCron(env) {
  const jobs = [];
  await worker.scheduled({}, env, { waitUntil: (p) => jobs.push(p) });
  await Promise.all(jobs);
}

const stateOf = (env) => JSON.parse(env.TIMERS.m.get("state")).bosses;

test("döngü: doğuştan 40 sn geçince boss kesilmiş sayılır, sayaç yeni tura kurulur", async () => {
  const until = Date.now() - 2 * MIN;
  const env = { TIMERS: fakeKV({ bosses: { "Immortal Gartua": { until, announced: true } }, updatedAt: 1 }) };
  await runCron(env);
  const g = stateOf(env)["Immortal Gartua"];
  assert.equal(g.until, until + 40_000 + 720 * MIN);
  assert.equal(g.announced, false);
  assert.match(g.updatedBy, /otomatik/);
});

test("döngü: doğuştan 40 sn geçmeden dokunmaz", async () => {
  const until = Date.now() - 20_000;
  const env = { TIMERS: fakeKV({ bosses: { "Silent Dartan (Altgard)": { until } }, updatedAt: 1 }) };
  await runCron(env);
  assert.equal(stateOf(env)["Silent Dartan (Altgard)"].until, until);
});

test("döngü: uzun süre bakılmasa da turları atlayıp geleceğe kurar", async () => {
  const until = Date.now() - 25 * 60 * MIN;
  const env = { TIMERS: fakeKV({ bosses: { "Soul Ruler Kashapa (Altgard)": { until } }, updatedAt: 1 }) };
  await runCron(env);
  const next = stateOf(env)["Soul Ruler Kashapa (Altgard)"].until;
  const cycle = 40_000 + 360 * MIN;
  assert.ok(next + 40_000 > Date.now(), "yeni sayaç güncel turda olmalı");
  assert.ok(next - cycle + 40_000 <= Date.now(), "bir tur fazla atlanmamalı");
  assert.equal((next - until) % cycle, 0);
});

test("döngü: sıfırlanmış (bilinmeyen) boss döngüye girmez", async () => {
  const env = { TIMERS: fakeKV({ bosses: {}, updatedAt: 1 }) };
  await runCron(env);
  assert.deepEqual(stateOf(env), {});
});

test("döngü: AUTO_KILL_SEC ayarı kullanılır", async () => {
  const until = Date.now() - 11 * MIN;
  const env = {
    AUTO_KILL_SEC: "600",
    TIMERS: fakeKV({ bosses: { "High Commander Lagta (Altgard)": { until } }, updatedAt: 1 }),
  };
  await runCron(env);
  assert.equal(stateOf(env)["High Commander Lagta (Altgard)"].until, until + 10 * MIN + 720 * MIN);
});
