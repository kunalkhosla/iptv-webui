"use strict";

// OpenSubtitles.com subtitle fetcher with a disk cache. Free accounts get
// ~20 downloads/day, so: every VTT is cached on disk, "none found" is
// negative-cached for 7 days, failures are cached briefly, the remaining quota
// is tracked (a reserve is kept), and all API traffic is serialized with a
// bounded queue. Nothing here retries in a loop.

const fs = require("node:fs");
const path = require("node:path");

const API = "https://api.opensubtitles.com/api/v1";
const LANGS = { en: "English", hi: "Hindi" };
const NEG_TTL_MS = 7 * 24 * 3600 * 1000;
const LOGIN_FAIL_MS = 10 * 60 * 1000;
const NAME_FAIL_MS = 15 * 60 * 1000;
const GARBAGE_FAIL_MS = 60 * 60 * 1000;
const MAX_BYTES = 2 * 1024 * 1024;
const MAX_PENDING = 3;
const QUOTA_RESERVE = 3;

function srtToVtt(srt) {
  let s = String(srt).replace(/^﻿/, "").replace(/\r\n?/g, "\n");
  const T = String.raw`(\d{1,2}):(\d{2}):(\d{2})[,.](\d{1,3})`;
  // Only timing lines are rewritten (commas in dialogue are untouched). Arrow
  // spacing is normalized, hours padded, SRT "X1:.. Y1:.." coordinates dropped.
  const timing = new RegExp(`^[ \\t]*${T}[ \\t]*-->[ \\t]*${T}[^\\n]*$`, "gm");
  s = s.replace(timing, (_m, h1, m1, s1, ms1, h2, m2, s2, ms2) =>
    `${h1.padStart(2, "0")}:${m1}:${s1}.${ms1.padEnd(3, "0")} --> ${h2.padStart(2, "0")}:${m2}:${s2}.${ms2.padEnd(3, "0")}`);
  // ASS-style override tags like {\an8} are not valid in WebVTT.
  s = s.replace(/\{\\[^}]*\}/g, "");
  return "WEBVTT\n\n" + s.trim() + "\n";
}

// <mode>_<id>_<lang>.vtt, or for series <mode>_<id>_s<S>e<E>_<lang>.vtt.
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

// Bytes -> text. Handles UTF-8 (with/without BOM) and UTF-16 BOMs; falls back
// to windows-1252 for invalid UTF-8. Throws if the result still contains NULs.
function decodeSubtitle(buf) {
  let text;
  if (buf.length >= 2 && buf[0] === 0xff && buf[1] === 0xfe) text = new TextDecoder("utf-16le").decode(buf.subarray(2));
  else if (buf.length >= 2 && buf[0] === 0xfe && buf[1] === 0xff) text = new TextDecoder("utf-16be").decode(buf.subarray(2));
  else {
    text = new TextDecoder("utf-8").decode(buf);
    if (text.includes("�")) text = new TextDecoder("windows-1252").decode(buf);
  }
  if (text.includes("\0")) throw new Error("subtitle decode produced NUL bytes");
  return text;
}

function createSubtitleService({ dataDir, env = process.env, fetchImpl = fetch, now = () => Date.now() }) {
  const dir = path.join(dataDir, "subtitles");
  const stateFile = path.join(dir, "_state.json");
  let token = null, tokenAt = 0, baseUrl = API;
  let chain = Promise.resolve();
  let pending = 0;
  let loginFailUntil = 0, rateLimitedUntil = 0;
  const failUntil = new Map();
  const inflight = new Map();

  const enabled = () => !!(env.OPENSUBTITLES_API_KEY && env.OPENSUBTITLES_USER && env.OPENSUBTITLES_PASS);
  const ensureDir = () => fs.promises.mkdir(dir, { recursive: true });
  const readState = () => { try { return JSON.parse(fs.readFileSync(stateFile, "utf8")); } catch { return {}; } };
  const writeState = (st) => { try { fs.mkdirSync(dir, { recursive: true }); fs.writeFileSync(stateFile, JSON.stringify(st)); } catch {} };
  const nextUtcMidnight = () => { const d = new Date(now()); return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() + 1); };
  const quotaExhausted = () => { const st = readState(); return !!(st.exhaustedUntil && now() < st.exhaustedUntil); };

  const headers = (extra) => ({ "Api-Key": env.OPENSUBTITLES_API_KEY, "User-Agent": "Khouch v1", "Content-Type": "application/json", Accept: "application/json", ...extra });

  const rateLimit = (r) => {
    const ra = Number(r.headers && r.headers.get && r.headers.get("retry-after"));
    const secs = Math.min(60, Math.max(1, Number.isFinite(ra) && ra > 0 ? ra : 5));
    rateLimitedUntil = now() + secs * 1000;
  };

  async function login() {
    if (now() < loginFailUntil) throw new Error("opensubtitles login backoff");
    try {
      const r = await fetchImpl(`${API}/login`, { method: "POST", headers: headers(), body: JSON.stringify({ username: env.OPENSUBTITLES_USER, password: env.OPENSUBTITLES_PASS }), signal: AbortSignal.timeout(15000) });
      if (r.status === 429) { rateLimit(r); throw new Error("opensubtitles login HTTP 429"); }
      if (!r.ok) throw new Error(`opensubtitles login HTTP ${r.status}`);
      const j = await r.json();
      if (!j.token) throw new Error("opensubtitles login: no token");
      token = j.token; tokenAt = now();
      baseUrl = j.base_url ? `https://${String(j.base_url).replace(/^https?:\/\//, "")}/api/v1` : API;
    } catch (e) {
      if (!/429/.test(e.message)) loginFailUntil = now() + LOGIN_FAIL_MS;
      throw e;
    }
  }
  async function authed(fn) {
    if (!token || now() - tokenAt > 23 * 3600 * 1000) await login();
    let r = await fn();
    if (r.status === 401) { token = null; await login(); r = await fn(); } // single re-login, no loop
    return r;
  }
  const enqueue = (fn) => { const p = chain.then(fn, fn); chain = p.catch(() => {}); return p; };

  // Search needs only the Api-Key (no login).
  async function search(tmdbId, lang, ctx) {
    const q = new URLSearchParams();
    if (ctx.mode === "series") {
      q.set("parent_tmdb_id", String(tmdbId)); q.set("type", "episode");
      q.set("season_number", String(ctx.season)); q.set("episode_number", String(ctx.episode));
    } else { q.set("tmdb_id", String(tmdbId)); q.set("type", "movie"); }
    q.set("languages", lang); q.set("order_by", "download_count"); q.set("order_direction", "desc");
    const r = await fetchImpl(`${API}/subtitles?${q}`, { headers: headers(), signal: AbortSignal.timeout(15000) });
    if (r.status === 429) { rateLimit(r); throw Object.assign(new Error("opensubtitles search HTTP 429"), { transient: true }); }
    if (!r.ok) throw new Error(`opensubtitles search HTTP ${r.status}`);
    return (await r.json()).data || [];
  }

  async function download(fileId) {
    const r = await authed(() => fetchImpl(`${baseUrl}/download`, { method: "POST", headers: headers({ Authorization: `Bearer ${token}` }), body: JSON.stringify({ file_id: fileId, sub_format: "srt" }), signal: AbortSignal.timeout(15000) }));
    if (r.status === 429) { rateLimit(r); throw Object.assign(new Error("opensubtitles download HTTP 429"), { transient: true }); }
    if (r.status === 406) { writeState({ ...readState(), exhaustedUntil: nextUtcMidnight() }); throw Object.assign(new Error("opensubtitles download HTTP 406 (quota)"), { transient: true }); }
    if (!r.ok) throw new Error(`opensubtitles download HTTP ${r.status}`);
    const j = await r.json();
    if (typeof j.remaining === "number") {
      // Keep a small reserve: lock out the rest of the UTC day at <= QUOTA_RESERVE.
      writeState({ ...readState(), remaining: j.remaining, exhaustedUntil: j.remaining <= QUOTA_RESERVE ? nextUtcMidnight() : 0 });
    }
    if (!j.link) throw new Error("opensubtitles download: no link");
    const f = await fetchImpl(j.link, { signal: AbortSignal.timeout(20000) });
    if (!f.ok) throw new Error(`subtitle file HTTP ${f.status}`);
    const cl = Number(f.headers && f.headers.get && f.headers.get("content-length"));
    if (cl > MAX_BYTES) throw new Error("subtitle file too large");
    const buf = Buffer.from(await f.arrayBuffer());
    if (buf.length > MAX_BYTES) throw new Error("subtitle file too large");
    return decodeSubtitle(buf);
  }

  // "hit" | "none" (fresh negative) | "miss"
  function status(name) {
    if (fs.existsSync(path.join(dir, name))) return "hit";
    try { if (now() - fs.statSync(path.join(dir, name + ".none")).mtimeMs < NEG_TTL_MS) return "none"; } catch {}
    return "miss";
  }
  const failed = (name) => (failUntil.get(name) || 0) > now();

  // Returns the cached file path, or null (none / quota / backoff / disabled /
  // error). Throws {busy:true, retryAfter} when the queue is full.
  async function getVtt({ mode, id, lang, season, episode, tmdbId, year }) {
    const name = cacheName(mode, id, lang, season, episode);
    if (!name || !tmdbId) return null;
    const st = status(name);
    if (st === "hit") return path.resolve(dir, name);
    if (st === "none" || !enabled() || quotaExhausted() || failed(name) || now() < rateLimitedUntil) return null;
    if (inflight.has(name)) return inflight.get(name);
    if (pending >= MAX_PENDING) throw Object.assign(new Error("subtitle queue full"), { busy: true, retryAfter: 10 });
    pending++;
    const p = enqueue(async () => {
      if (status(name) === "hit") return path.resolve(dir, name);
      if (quotaExhausted() || failed(name) || now() < rateLimitedUntil) return null;
      try {
        const results = await search(tmdbId, lang, { mode, season, episode });
        const fileId = pickBest(results, { lang, year });
        await ensureDir();
        if (!fileId) { await fs.promises.writeFile(path.join(dir, name + ".none"), ""); return null; }
        const vtt = srtToVtt(await download(fileId));
        if (!vtt.includes("-->")) { failUntil.set(name, now() + GARBAGE_FAIL_MS); throw new Error("no cues in downloaded subtitle"); }
        const tmp = path.join(dir, name + ".tmp");
        await fs.promises.writeFile(tmp, vtt);
        await fs.promises.rename(tmp, path.join(dir, name));
        return path.resolve(dir, name);
      } catch (e) {
        console.warn(`subtitles ${name}: ${e.message}`);
        if (!e.transient && !failed(name) && !/login backoff|login HTTP/.test(e.message)) failUntil.set(name, now() + NAME_FAIL_MS);
        return null;
      }
    }).finally(() => { pending--; inflight.delete(name); });
    inflight.set(name, p);
    return p;
  }

  function listLangs({ mode, id, season, episode }) {
    return Object.keys(LANGS).filter((lang) => {
      const name = cacheName(mode, id, lang, season, episode);
      return name && status(name) !== "none";
    });
  }

  return { getVtt, listLangs, enabled, LANGS };
}

module.exports = { srtToVtt, cacheName, pickBest, decodeSubtitle, createSubtitleService, LANGS };
