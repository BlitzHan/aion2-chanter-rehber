import { existsSync, readFileSync } from "node:fs";
import { COMMANDS } from "../src/commands.js";

// Yerelde .dev.vars varsa oradan oku (git'e girmez).
const devVarsPath = new URL("../.dev.vars", import.meta.url);
if (existsSync(devVarsPath)) {
  for (const line of readFileSync(devVarsPath, "utf8").split("\n")) {
    const match = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (match && !process.env[match[1]]) {
      process.env[match[1]] = match[2].replace(/^["']|["']$/g, "").trim();
    }
  }
}

const APP_ID = process.env.DISCORD_APP_ID;
const GUILD_ID = process.env.DISCORD_GUILD_ID;
const TOKEN = process.env.DISCORD_BOT_TOKEN;

if (!APP_ID || !GUILD_ID || !TOKEN) {
  console.error(
    "Eksik değişken. .dev.vars içine DISCORD_APP_ID, DISCORD_GUILD_ID ve DISCORD_BOT_TOKEN yaz " +
      "veya ortam değişkeni olarak ver.",
  );
  process.exit(1);
}

// Guild komutu anında güncellenir; global komut 1 saate kadar gecikebilir.
const url = `https://discord.com/api/v10/applications/${APP_ID}/guilds/${GUILD_ID}/commands`;

const res = await fetch(url, {
  method: "PUT",
  headers: {
    Authorization: `Bot ${TOKEN}`,
    "Content-Type": "application/json",
  },
  body: JSON.stringify(COMMANDS),
});

const text = await res.text();
if (!res.ok) {
  console.error(`Komutlar kaydedilemedi (HTTP ${res.status}):`);
  console.error(text);
  process.exit(1);
}

let saved = [];
try {
  saved = JSON.parse(text);
} catch (_) {
  // yanıt JSON değilse sadece başarı mesajı ver
}

console.log(
  saved.length
    ? `Komutlar kaydedildi: ${saved.map((c) => "/" + c.name).join(", ")}`
    : "Komutlar kaydedildi.",
);
