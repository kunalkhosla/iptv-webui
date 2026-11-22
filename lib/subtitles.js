"use strict";

// OpenSubtitles.com subtitle fetcher with a disk cache. Free accounts get
// ~20 downloads/day, so: every VTT is cached on disk, "none found" is
// negative-cached for 7 days, the remaining quota is tracked and /download is
// not called once exhausted (until the next UTC day), and all API traffic is
// serialized. Nothing here retries in a loop.

const fs = require("node:fs");
const path = require("node:path");

const API = "https://api.opensubtitles.com/api/v1";
const LANGS = { en: "English", hi: "Hindi" };
const NEG_TTL_MS = 7 * 24 * 3600 * 1000;

function srtToVtt(srt) {
  let s = String(srt).replace(/^﻿/, "").replace(/\r\n?/g, "\n");
  // Cue timing lines: 00:00:01,000 --> 00:00:02,500 (comma -> dot).
  s = s.replace(/(\d{1,2}:\d{2}:\d{2}),(\d{1,3})/g, "$1.$2");
  // SRT allows 1-digit hours / 1-3 digit millis loosely; normalize to HH:MM:SS.mmm.
  s = s.replace(/(^|\n)(\d{1,2}):(\d{2}):(\d{2})\.(\d{1,3}) --> (\d{1,2}):(\d{2}):(\d{2})\.(\d{1,3})/g,
    (_m, pre, h1, m1, s1, ms1, h2, m2, s2, ms2) =>
      `${pre}${h1.padStart(2, "0")}:${m1}:${s1}.${ms1.padEnd(3, "0")} --> ${h2.padStart(2, "0")}:${m2}:${s2}.${ms2.padEnd(3, "0")}`);
  return "WEBVTT\n\n" + s.trim() + "\n";
}

// <mode>_<id>_<lang>.vtt, or for series <mode>_<id>_s<S>e<E>_<lang>.vtt.
// Returns null on anything that isn't strictly digits / known lang / known mode.
function cacheName(mode, id, lang, season, episode) {
  if (mode !== "movie" && mode !== "series") return null;
  if (!/^\d{1,12}$/.test(String(id))) return null;
  if (!Object.prototype.hasOwnProperty.call(LANGS, lang)) return null;
  if (mode === "series") {
    if (!/^\d{1,4}$/.test(String(season)) || !/^\d{1,5}$/.test(String(episode))) return null;
    return `series_${id}_s${Number(season)}e${Number(episode)}_${lang}.vtt`;
  }
  return `movie_${id}_${lang}.vtt`;
}

// Rank OpenSubtitles results: exact language, matching year, non-HI, then downloads.
function pickBest(results, { lang, year }) {
  const rows = (results || []).map((r) => r && r.attributes).filter((a) =>
    a && a.language === lang && Array.isArray(a.files) && a.files[0] && a.files[0].file_id);
  if (!rows.length) return null;
  const y = Number(year) || 0;
  const score = (a) => {
    const ay = Number(a.feature_details && a.feature_details.year) || 0;
    return (y && ay === y ? 4 : 0) + (a.hearing_impaired ? 0 : 2) + (a.ai_translated || a.machine_translated ? -1 : 0);
  };
  rows.sort((a, b) => score(b) - score(a) || (b.download_count || 0) - (a.download_count || 0));
  return rows[0].files[0].file_id;
}

function decode(buf) {
  const utf8 = new TextDecoder("utf-8").decode(buf);
  if (!utf8.includes("�")) return utf8;
  return new TextDecoder("windows-1252").decode(buf);
}

function createSubtitleService({ dataDir, env = process.env, fetchImpl = fetch, now = () => Date.now() }) {
  const dir = path.join(dataDir, "subtitles");
  const stateFile = path.join(dir, "_state.json");
  let token = null, tokenAt = 0, baseUrl = API;
  let chain = Promise.resolve();
  const inflight = new Map();

  const enabled = () => !!(env.OPENSUBTITLES_API_KEY && env.OPENSUBTITLES_USER && env.OPENSUBTITLES_PASS);
  const ensureDir = () => fs.promises.mkdir(dir, { recursive: true });
  const readState = () => { try { return JSON.parse(fs.readFileSync(stateFile, "utf8")); } catch { return {}; } };
  const writeState = (st) => { try { fs.mkdirSync(dir, { recursive: true }); fs.writeFileSync(stateFile, JSON.stringify(st)); } catch {} };
  const nextUtcMidnight = () => { const d = new Date(now()); return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() + 1); };
  const quotaExhausted = () => { const st = readState(); return !!(st.exhaustedUntil && now() < st.exhaustedUntil); };

  const headers = (extra) => ({ "Api-Key": env.OPENSUBTITLES_API_KEY, "User-Agent": "Khouch v1", "Content-Type": "application/json", Accept: "application/json", ...extra });

  async function login() {
    const r = await fetchImpl(`${API}/login`, { method: "POST", headers: headers(), body: JSON.stringify({ username: env.OPENSUBTITLES_USER, password: env.OPENSUBTITLES_PASS }), signal: AbortSignal.timeout(15000) });
    if (!r.ok) throw new Error(`opensubtitles login HTTP ${r.status}`);
    const j = await r.json();
    if (!j.token) throw new Error("opensubtitles login: no token");
    token = j.token; tokenAt = now();
    baseUrl = j.base_url ? `https://${String(j.base_url).replace(/^https?:\/\//, "")}/api/v1` : API;
  }
  async function authed(fn) {
    if (!token || now() - tokenAt > 23 * 3600 * 1000) await login();
    let r = await fn();
    if (r.status === 401) { await login(); r = await fn(); } // single re-login, no loop
    return r;
  }
  const serialize = (fn) => { const p = chain.then(fn, fn); chain = p.catch(() => {}); return p; };

  async function search(tmdbId, lang, ctx) {
    const q = new URLSearchParams();
    if (ctx.mode === "series") {
      q.set("parent_tmdb_id", String(tmdbId)); q.set("type", "episode");
      q.set("season_number", String(ctx.season)); q.set("episode_number", String(ctx.episode));
    } else { q.set("tmdb_id", String(tmdbId)); q.set("type", "movie"); }
    q.set("languages", lang); q.set("order_by", "download_count"); q.set("order_direction", "desc");
    const r = await authed(() => fetchImpl(`${baseUrl}/subtitles?${q}`, { headers: headers({ Authorization: `Bearer ${token}` }), signal: AbortSignal.timeout(15000) }));
    if (!r.ok) throw new Error(`opensubtitles search HTTP ${r.status}`);
    return (await r.json()).data || [];
  }

  async function download(fileId) {
    const r = await authed(() => fetchImpl(`${baseUrl}/download`, { method: "POST", headers: headers({ Authorization: `Bearer ${token}` }), body: JSON.stringify({ file_id: fileId, sub_format: "srt" }), signal: AbortSignal.timeout(15000) }));
    if (r.status === 406 || r.status === 429) { writeState({ ...readState(), exhaustedUntil: nextUtcMidnight() }); throw new Error(`opensubtitles download HTTP ${r.status} (quota)`); }
    if (!r.ok) throw new Error(`opensubtitles download HTTP ${r.status}`);
    const j = await r.json();
    if (typeof j.remaining === "number") {
      writeState({ ...readState(), remaining: j.remaining, exhaustedUntil: j.remaining <= 0 ? nextUtcMidnight() : 0 });
    }
    if (!j.link) throw new Error("opensubtitles download: no link");
    const f = await fetchImpl(j.link, { signal: AbortSignal.timeout(20000) });
    if (!f.ok) throw new Error(`subtitle file HTTP ${f.status}`);
    return decode(Buffer.from(await f.arrayBuffer()));
  }

  // Cache status for a (mode,id,lang): "hit" | "none" (fresh negative) | "miss"
  function status(name) {
    const p = path.join(dir, name);
    if (fs.existsSync(p)) return "hit";
    const n = path.join(dir, name + ".none");
    try { if (now() - fs.statSync(n).mtimeMs < NEG_TTL_MS) return "none"; } catch {}
    return "miss";
  }

  // Returns the absolute cached path, or null (none found / quota / disabled / error).
  async function getVtt({ mode, id, lang, season, episode, tmdbId, year }) {
    const name = cacheName(mode, id, lang, season, episode);
    if (!name || !tmdbId) return null;
    const st = status(name);
    if (st === "hit") return path.join(dir, name);
    if (st === "none" || !enabled() || quotaExhausted()) return null;
    if (inflight.has(name)) return inflight.get(name);
    const p = serialize(async () => {
      if (status(name) === "hit") return path.join(dir, name);
      if (quotaExhausted()) return null;
      try {
        const results = await search(tmdbId, lang, { mode, season, episode });
        const fileId = pickBest(results, { lang, year });
        await ensureDir();
        if (!fileId) { await fs.promises.writeFile(path.join(dir, name + ".none"), ""); return null; }
        const vtt = srtToVtt(await download(fileId));
        const tmp = path.join(dir, name + ".tmp");
        await fs.promises.writeFile(tmp, vtt);
        await fs.promises.rename(tmp, path.join(dir, name));
        return path.join(dir, name);
      } catch (e) {
        console.warn(`subtitles ${name}: ${e.message}`);
        return null;
      }
    }).finally(() => inflight.delete(name));
    inflight.set(name, p);
    return p;
  }

  // Languages worth offering for a title: not known-absent (fresh negative cache).
  function listLangs({ mode, id, season, episode }) {
    return Object.keys(LANGS).filter((lang) => {
      const name = cacheName(mode, id, lang, season, episode);
      return name && status(name) !== "none";
    });
  }

  return { getVtt, listLangs, enabled, LANGS };
}

module.exports = { srtToVtt, cacheName, pickBest, createSubtitleService, LANGS };
