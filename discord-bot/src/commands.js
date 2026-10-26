import { BOSSES } from "./bosses.js";

const bossChoices = BOSSES.map((b) => ({
  name: `${b.short} (${b.map})`,
  value: b.id,
}));

export const COMMANDS = [
  {
    name: "durum",
    description: "Boss sayaçlarını ve kalan süreleri göster",
    type: 1,
    dm_permission: false,
  },
  {
    name: "kes",
    description: "Boss kesildi: sayacı yeniden doğma süresine göre başlat",
    type: 1,
    dm_permission: false,
    options: [
      {
        type: 3,
        name: "boss",
        description: "Hangi boss?",
        required: true,
        choices: bossChoices,
      },
    ],
  },
  {
    name: "sure",
    description: "Kalan süreyi elle ayarla (0 = şu an hazır)",
    type: 1,
    dm_permission: false,
    options: [
      {
        type: 3,
        name: "boss",
        description: "Hangi boss?",
        required: true,
        choices: bossChoices,
      },
      {
        type: 3,
        name: "sure",
        description: "Kalan süre: 6s15d, 6:15, 375 (dk) veya 0 (hazır)",
        required: true,
      },
    ],
  },
  {
    name: "sifirla",
    description: "Boss sayacını temizle (bilinmiyor durumuna döner)",
    type: 1,
    dm_permission: false,
    options: [
      {
        type: 3,
        name: "boss",
        description: "Hangi boss? (Hepsi seçilebilir)",
        required: true,
        choices: [...bossChoices, { name: "Hepsi", value: "__all__" }],
      },
    ],
  },
];
