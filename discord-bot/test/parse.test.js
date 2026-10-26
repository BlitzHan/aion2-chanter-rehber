import test from "node:test";
import assert from "node:assert/strict";

import { parseDurationMinutes } from "../src/index.js";
import { BOSSES, BOSS_MAP } from "../src/bosses.js";

test("parseDurationMinutes: birimli girişler dakikaya çevrilir", () => {
  const cases = [
    ["6s15d", 375],
    ["6 saat 15 dakika", 375],
    ["6 saat 15 dakika kaldı", 375],
    ["6h15m", 375],
    ["1g 2s", 1560],
    ["2 gün", 2880],
    ["45dk", 45],
    ["  6S15D  ", 375],
  ];

  for (const [input, expected] of cases) {
    assert.equal(parseDurationMinutes(input), expected, `giriş: ${JSON.stringify(input)}`);
  }
});

test("parseDurationMinutes: saat/dakika ve düz sayı biçimleri", () => {
  const cases = [
    ["6:15", 375],
    ["6.15", 375],
    ["375", 375],
    ["0", 0],
  ];

  for (const [input, expected] of cases) {
    assert.equal(parseDurationMinutes(input), expected, `giriş: ${JSON.stringify(input)}`);
  }
});

test("parseDurationMinutes: geçersiz girişler null döner", () => {
  const inputs = ["", "   ", null, undefined, "abc", "6:75", "6s abc", "kaldı"];

  for (const input of inputs) {
    assert.equal(parseDurationMinutes(input), null, `giriş: ${JSON.stringify(input)}`);
  }
});

test("BOSSES: 4 dolu boss ve benzersiz id", () => {
  assert.equal(BOSSES.length, 4);

  for (const boss of BOSSES) {
    for (const field of ["id", "name", "short", "map"]) {
      assert.equal(typeof boss[field], "string", `${boss.id} alanı: ${field}`);
      assert.ok(boss[field].trim().length > 0, `${boss.id} alanı boş: ${field}`);
    }

    assert.ok(Number.isInteger(boss.respawnMin), `${boss.id} respawnMin tam sayı değil`);
    assert.ok(boss.respawnMin > 0, `${boss.id} respawnMin pozitif değil`);
  }

  const ids = BOSSES.map((b) => b.id);
  assert.equal(new Set(ids).size, ids.length, "id'ler benzersiz değil");

  for (const boss of BOSSES) {
    assert.equal(BOSS_MAP[boss.id], boss, `BOSS_MAP kaydı yanlış: ${boss.id}`);
  }
});
