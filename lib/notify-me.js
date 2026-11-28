"use strict";
// "Notify me when it lands on Khouch" (pure). Per profile, a list of TMDB
// titles that are not in the catalog yet (userState.notifyMe). After each
// index build the server matches pending entries against the catalog's
// tmdb_id map; a match marks the entry landed (push + "Now on Khouch" rail).
//
// entry = { tmdb_id, kind: "movie" | "tv", title, year, poster, addedAt,
//           landed?: { mode: "movie" | "series", id, at } }

const MAX_ENTRIES = 200;
const NOW_ON_DAYS = 21;    // a landed title stays in the "Now on Khouch" rail this long
const KEEP_LANDED_DAYS = 60;
const POSTER_RE = /^https:\/\/image\.tmdb\.org\/t\/p\/w\d{2,4}\/[A-Za-z0-9_.-]{1,80}$/;

const modeOfKind = (kind) => (kind === "tv" ? "series" : "movie");
const kindOfMode = (mode) => (mode === "series" ? "tv" : "movie");

function validateAdd(body) {
  const b = body || {};
  const tmdbId = Number(b.tmdb_id);
  if (!Number.isInteger(tmdbId) || tmdbId <= 0 || tmdbId > 1e9) return { error: "bad tmdb_id" };
  const kind = b.kind === "tv" || b.kind === "series" ? "tv" : b.kind === "movie" ? "movie" : null;
  if (!kind) return { error: "bad kind" };
  const title = String(b.title ?? "").trim().slice(0, 200);
  if (!title) return { error: "title required" };
  const year = /^(19|20)\d{2}$/.test(String(b.year ?? "")) ? String(b.year) : null;
  const poster = POSTER_RE.test(String(b.poster ?? "")) ? String(b.poster) : null;
  return { tmdb_id: tmdbId, kind, title, year, poster };
}

function normalizeList(v) {
  if (!Array.isArray(v)) return [];
  const out = [];
  const seen = new Set();
  for (const e of v) {
    if (!e || typeof e !== "object") continue;
    const ok = validateAdd(e);
    if (ok.error) continue;
    const k = `${ok.kind}:${ok.tmdb_id}`;
    if (seen.has(k)) continue;
    seen.add(k);
    const entry = { ...ok, addedAt: Number(e.addedAt) || 0 };
    const l = e.landed;
    if (l && (l.mode === "movie" || l.mode === "series") && Number.isFinite(Number(l.id)) && Number(l.at) > 0) {
      entry.landed = { mode: l.mode, id: Number(l.id), at: Number(l.at) };
    }
    out.push(entry);
    if (out.length >= MAX_ENTRIES) break;
  }
  return out;
}

// Returns the new list (newest first), or null when full of pending entries.
function add(list, v, now = Date.now()) {
  const cur = Array.isArray(list) ? list : [];
  const rest = cur.filter((e) => !(e.kind === v.kind && e.tmdb_id === v.tmdb_id));
  const existing = cur.find((e) => e.kind === v.kind && e.tmdb_id === v.tmdb_id);
  const entry = existing && !existing.landed ? { ...existing, ...v } : { ...v, addedAt: now };
  let next = [entry, ...rest];
  if (next.length > MAX_ENTRIES) {
    // Make room by dropping the oldest landed entries.
    const landed = next.filter((e) => e.landed).sort((a, b) => a.landed.at - b.landed.at);
    const drop = new Set(landed.slice(0, next.length - MAX_ENTRIES));
    next = next.filter((e) => !drop.has(e));
    if (next.length > MAX_ENTRIES) return null;
  }
  return next;
}

function remove(list, kind, tmdbId) {
  return (Array.isArray(list) ? list : []).filter((e) => !(e.kind === kind && e.tmdb_id === tmdbId));
}

// Marks pending entries the catalog now has. lookup(kind, tmdbId) ->
// { mode, id } | null. Returns the entries that just landed (mutated in place).
function match(list, lookup, now = Date.now()) {
  const landed = [];
  for (const e of Array.isArray(list) ? list : []) {
    if (e.landed) continue;
    const hit = lookup(e.kind, e.tmdb_id);
    if (!hit) continue;
    e.landed = { mode: hit.mode, id: Number(hit.id), at: now };
    landed.push(e);
  }
  return landed;
}

// Drops landed entries older than KEEP_LANDED_DAYS (the list is the history).
function prune(list, now = Date.now()) {
  return (Array.isArray(list) ? list : []).filter((e) => !e.landed || now - e.landed.at < KEEP_LANDED_DAYS * 86400e3);
}

// Landed entries for the "Now on Khouch" rail of one mode, newest first.
function nowOnKhouch(list, mode, now = Date.now()) {
  return (Array.isArray(list) ? list : [])
    .filter((e) => e.landed && e.landed.mode === mode && now - e.landed.at < NOW_ON_DAYS * 86400e3)
    .sort((a, b) => b.landed.at - a.landed.at);
}

function publicView(e) {
  return {
    tmdb_id: e.tmdb_id, kind: e.kind, title: e.title, year: e.year || null, poster: e.poster || null,
    added_at: e.addedAt || null,
    landed: e.landed ? { mode: e.landed.mode, id: e.landed.id, at: e.landed.at } : null,
  };
}

function notifyText(e, profileName) {
  const who = profileName ? `${profileName}: ` : "";
  const what = e.year ? `${e.title} (${e.year})` : e.title;
  return { title: "Now on Khouch", message: `${who}${what} is now on Khouch.` };
}

module.exports = {
  MAX_ENTRIES, NOW_ON_DAYS, KEEP_LANDED_DAYS, modeOfKind, kindOfMode,
  validateAdd, normalizeList, add, remove, match, prune, nowOnKhouch, publicView, notifyText,
};
