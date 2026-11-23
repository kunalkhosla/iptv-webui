#!/usr/bin/env node
// Offline, read-only: run matchPlausible over a copy of index-movie.json + tmdb-cache.json.
// usage: node scripts/tmdb-mismatch-report.js <data-dir> [mode=movie] [samples=30]
const fs = require("fs");
const path = require("path");
const { matchPlausible, hasOverlap, parseStreamName } = require("../lib/tmdb-match");
const dir = process.argv[2] || "/opt/docker/iptv-webui/data";
const mode = process.argv[3] || "movie";
const N = parseInt(process.argv[4] || "30", 10);
const idx = JSON.parse(fs.readFileSync(path.join(dir, `index-${mode}.json`), "utf8"));
const cache = JSON.parse(fs.readFileSync(path.join(dir, "tmdb-cache.json"), "utf8"));
let total = 0, zero = 0; const flagged = [], keptZero = [];
for (const s of idx.streams) {
  const e = cache[`${mode}:${s.id}`];
  if (!e || e.source !== "tmdb" || !e.tmdb_id) continue;
  total++;
  const lang = (s.tags || []).find((t) => ["hindi","punjabi","urdu","tamil","telugu","malayalam","kannada","marathi","gujarati","bengali","arabic","turkish","english"].includes(t)) || null;
  const r = matchPlausible({ streamName: s.name, streamLangTag: lang, streamYear: null, tmdb: { title: e.tmdb_title, original_language: e.original_language, year: e.year } });
  const row = { id: s.id, name: s.name, lang, tmdb_title: e.tmdb_title, ol: e.original_language, reason: r.reason };
  if (!r.ok) flagged.push(row);
  else if (r.reason.startsWith("zero-overlap")) keptZero.push(row);
}
const pick = (a) => { const o = []; const step = Math.max(1, Math.floor(a.length / N)); for (let i = 0; i < a.length && o.length < N; i += step) o.push(a[i]); return o; };
console.log(JSON.stringify({ mode, totalMatched: total, flagged: flagged.length, zeroOverlapKept: keptZero.length }));
console.log("--- FLAGGED samples"); for (const r of pick(flagged)) console.log(`${r.id}\t${r.name}\t[${r.lang||"-"}]\t=> ${r.tmdb_title} (${r.ol})\t${r.reason}`);
console.log("--- NOT FLAGGED zero-overlap samples"); for (const r of pick(keptZero)) console.log(`${r.id}\t${r.name}\t[${r.lang||"-"}]\t=> ${r.tmdb_title} (${r.ol})\t${r.reason}`);
