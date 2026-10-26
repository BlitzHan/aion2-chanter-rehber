// Global takip edilen 4 boss. Dizideki sıra Discord'da ve sitede gösterilen sıradır.
// id alanı, sitedeki BOSS_DEFAULTS kaydındaki isimle BİREBİR aynı olmalı.
//
// Varsayılan: Asmodian / Altgard favorileri.
// Elyos / Verteron oynuyorsan id'leri şunlarla değiştir:
//   "Eternal Gartua"
//   "High Commander Lagta (Verteron)"
//   "Soul Ruler Kashapa (Verteron)"
//   "Silent Dartan (Verteron)"
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
    id: "High Commander Lagta (Altgard)",
    name: "High Commander Lagta (Altgard)",
    short: "Lagta",
    map: "Altgard",
    respawnMin: 720,
  },
  {
    id: "Soul Ruler Kashapa (Altgard)",
    name: "Soul Ruler Kashapa (Altgard)",
    short: "Kashapa",
    map: "Altgard",
    respawnMin: 360,
  },
  {
    id: "Silent Dartan (Altgard)",
    name: "Silent Dartan (Altgard)",
    short: "Dartan",
    map: "Altgard",
    respawnMin: 360,
  },
];

export const BOSS_MAP = Object.fromEntries(BOSSES.map((b) => [b.id, b]));
