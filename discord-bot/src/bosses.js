// Global takip edilen 4 boss.
// id alanı, sitedeki BOSS_DEFAULTS kaydındaki isimle BİREBİR aynı olmalı.
//
// Varsayılan: Asmodian / Altgard favorileri.
// Elyos / Verteron oynuyorsan id'leri şunlarla değiştir:
//   "Eternal Gartua"
//   "Silent Dartan (Verteron)"
//   "Soul Ruler Kashapa (Verteron)"
//   "High Commander Lagta (Verteron)"
//
// respawnMin: boss kesildikten sonra yeniden doğması kaç dakika sürüyorsa onu yaz.
export const BOSSES = [
  {
    id: "Immortal Gartua",
    name: "Immortal Gartua",
    short: "Gartua",
    map: "Altgard",
    respawnMin: 720,
  },
  {
    id: "Silent Dartan (Altgard)",
    name: "Silent Dartan (Altgard)",
    short: "Dartan",
    map: "Altgard",
    respawnMin: 360,
  },
  {
    id: "Soul Ruler Kashapa (Altgard)",
    name: "Soul Ruler Kashapa (Altgard)",
    short: "Kashapa",
    map: "Altgard",
    respawnMin: 360,
  },
  {
    id: "High Commander Lagta (Altgard)",
    name: "High Commander Lagta (Altgard)",
    short: "Lagta",
    map: "Altgard",
    respawnMin: 720,
  },
];

export const BOSS_MAP = Object.fromEntries(BOSSES.map((b) => [b.id, b]));
