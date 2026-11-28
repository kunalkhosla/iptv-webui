"use strict";
// New-episode detection (pure). A profile's "seen" mark per series is the
// last episode (season, episode number) the panel listed when the profile
// last opened or played the series; episodes listed after it are new.
// Specials (season 0) sort first, so a new special never counts.
//
// mark = { s, e, at }   (userState.seriesSeen[seriesId])

const TRACK_DAYS = 120;   // series watched within this many days are polled
const TRACK_MAX = 30;     // per profile
const RAIL_MAX = 20;

function flatEpisodes(info) {
  const seasons = info && info.episodes && typeof info.episodes === "object" ? info.episodes : null;
  if (!seasons) return [];
  const out = [];
  for (const [sn, eps] of Object.entries(seasons)) {
    if (!Array.isArray(eps)) continue;
    for (const e of eps) {
      if (!e || e.id == null) continue;
      const s = Number(e.season ?? sn);
      const n = Number(e.episode_num);
      if (!Number.isFinite(s) || !Number.isFinite(n)) continue;
      out.push({ id: String(e.id), s, e: n, title: e.title || null, added: Number(e.added) || 0 });
    }
  }
  out.sort((a, b) => a.s - b.s || a.e - b.e);
  return out;
}

// Mark for "the profile has now seen everything the panel lists", or null
// when the info has no episodes.
function markFor(info, now = Date.now()) {
  const all = flatEpisodes(info);
  if (!all.length) return null;
  const last = all[all.length - 1];
  return { s: last.s, e: last.e, at: now };
}

const after = (ep, mark) => ep.s > mark.s || (ep.s === mark.s && ep.e > mark.e);

// Episodes listed after the mark (oldest first). [] without a valid mark.
function newEpisodes(info, mark) {
  if (!mark || !Number.isFinite(mark.s) || !Number.isFinite(mark.e)) return [];
  return flatEpisodes(info).filter((ep) => after(ep, mark));
}

// Series ids (strings) this profile is following: a lastEpisode pointer
// played within TRACK_DAYS (when = pointer time or that episode's progress
// time), newest first. Pointers with no known time come last.
function trackedSeries(userState, now = Date.now()) {
  const le = userState && userState.lastEpisode && typeof userState.lastEpisode === "object" ? userState.lastEpisode : {};
  const progress = (userState && userState.progress) || {};
  const rows = [];
  for (const [sid, p] of Object.entries(le)) {
    if (!/^\d{1,12}$/.test(sid) || !p || typeof p !== "object") continue;
    const epT = p.episode_id != null ? Number(progress[`series:${p.episode_id}`]?.t) || 0 : 0;
    const t = Math.max(Number(p.when) || 0, epT);
    if (t && now - t > TRACK_DAYS * 86400e3) continue;
    rows.push({ sid, t });
  }
  rows.sort((a, b) => b.t - a.t);
  return rows.slice(0, TRACK_MAX).map((r) => r.sid);
}

// { seriesId: { count, latest: ep, recency } } for the profile, from cached
// infos only. infoFor(sid) -> info | null.
function newEpisodeMap(userState, infoFor, now = Date.now()) {
  const seen = (userState && userState.seriesSeen) || {};
  const out = new Map();
  for (const sid of trackedSeries(userState, now)) {
    const mark = seen[sid];
    if (!mark) continue;
    const info = infoFor(sid);
    if (!info) continue;
    const fresh = newEpisodes(info, mark);
    if (!fresh.length) continue;
    const latest = fresh[fresh.length - 1];
    const addedMax = Math.max(...fresh.map((x) => x.added || 0)) * 1000;
    out.set(sid, { count: fresh.length, first: fresh[0], latest, recency: addedMax || mark.at || 0 });
  }
  return out;
}

// Series ids for the rail, newest new episode first.
function railOrder(map) {
  return [...map.entries()].sort((a, b) => b[1].recency - a[1].recency).slice(0, RAIL_MAX).map(([sid]) => sid);
}

function badgeLabel(n) {
  return n > 1 ? `${n} new episodes` : "New episode";
}

module.exports = { TRACK_DAYS, TRACK_MAX, RAIL_MAX, flatEpisodes, markFor, newEpisodes, trackedSeries, newEpisodeMap, railOrder, badgeLabel };
