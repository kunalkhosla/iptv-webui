#!/usr/bin/env node
// Standalone audio-metadata prober. Reads IPTV_HOST / USER / PASS from
// .env, walks every movie in data/index-movie.json, hits
// /player_api.php?action=get_vod_info on each, and writes the
// resulting audio + video metadata into data/quality-cache.json so
// the badge feature on home rails populates without forcing the
// production server to do the work over many CI-deploy cycles.
//
// Resumable: only probes movies whose qualityCache entry has no
// audio_channels field (or has none at all). Ctrl-C-safe — saves
// every 50 probes.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(__dirname, "..");
const DATA = path.join(REPO, "data");

const envFile = fs.readFileSync(path.join(REPO, ".env"), "utf8");
const env = Object.fromEntries(
  envFile.split("\n")
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith("#") && l.includes("="))
    .map((l) => { const i = l.indexOf("="); return [l.slice(0, i), l.slice(i + 1)]; })
);
const HOST = (env.IPTV_HOST || "").replace(/\/+$/, "");
const USER = env.IPTV_USER || "";
const PASS = env.IPTV_PASS || "";
if (!HOST || !USER || !PASS) { console.error("Missing IPTV_HOST/USER/PASS in .env"); process.exit(1); }

const indexPath = path.join(DATA, "index-movie.json");
const cachePath = path.join(DATA, "quality-cache.json");
const ix = JSON.parse(fs.readFileSync(indexPath, "utf8"));
const cache = (() => {
  try { return JSON.parse(fs.readFileSync(cachePath, "utf8")); } catch { return {}; }
})();

const movies = ix.streams.map((s) => s.id);
const todo = movies.filter((id) => {
  const c = cache[`movie:${id}`];
  return !c || !("audio_channels" in c);
});
console.log(`movies=${movies.length} cached=${movies.length - todo.length} todo=${todo.length}`);

const CONC = 6;
const SAVE_EVERY = 50;
let done = 0, hit = 0, fail = 0, surround = 0, sinceSave = 0;
const startedAt = Date.now();

function classifyAs4k(w, h) {
  return (h >= 2000) || (w >= 3200);
}

async function getInfo(id) {
  const url = `${HOST}/player_api.php?username=${encodeURIComponent(USER)}` +
    `&password=${encodeURIComponent(PASS)}` +
    `&action=get_vod_info&vod_id=${encodeURIComponent(id)}`;
  const r = await fetch(url, {
    headers: { "User-Agent": "Mozilla/5.0 (Linux; Android 12; Smart TV) AppleWebKit/537.36" },
  });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  return r.json();
}

function saveCache() {
  fs.writeFileSync(cachePath + ".tmp", JSON.stringify(cache));
  fs.renameSync(cachePath + ".tmp", cachePath);
}

let i = 0;
async function worker() {
  while (i < todo.length) {
    const id = todo[i++];
    try {
      const info = await getInfo(id);
      const video = info?.info?.video || {};
      const audio = info?.info?.audio || {};
      const w = Number(video.width) || 0;
      const h = Number(video.height) || 0;
      const ch = Number(audio.channels) || 0;
      if (!w && !h && !ch) { fail++; continue; }
      cache[`movie:${id}`] = {
        w, h,
        codec: video.codec_name || null,
        bitrate: Number(info?.info?.bitrate) || null,
        is4k: classifyAs4k(w, h),
        audio_codec: audio.codec_name || null,
        audio_channels: ch,
        audio_layout: audio.channel_layout || null,
        checked_at: Date.now(),
      };
      hit++;
      if (ch >= 6) surround++;
    } catch (e) {
      fail++;
    }
    done++;
    sinceSave++;
    if (sinceSave >= SAVE_EVERY) {
      saveCache();
      sinceSave = 0;
      const rate = done / ((Date.now() - startedAt) / 1000);
      const remaining = Math.round((todo.length - done) / Math.max(rate, 0.01));
      process.stdout.write(
        `\r[${done}/${todo.length}] hit=${hit} fail=${fail} surround=${surround} ` +
        `rate=${rate.toFixed(1)}/s eta=${remaining}s   `,
      );
    }
  }
}

let interrupted = false;
process.on("SIGINT", () => {
  if (interrupted) process.exit(1);
  interrupted = true;
  console.log("\n[interrupt] flushing cache and exiting...");
  saveCache();
  process.exit(0);
});

await Promise.all(Array.from({ length: CONC }, worker));
saveCache();
console.log(`\ndone: hit=${hit} fail=${fail} surround=${surround} in ${((Date.now()-startedAt)/1000).toFixed(0)}s`);
