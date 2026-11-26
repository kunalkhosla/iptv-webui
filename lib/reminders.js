"use strict";
// Programme reminders: pure logic (storage + timers live in server.js).
// A reminder never opens a stream: firing only notifies (HA push + in-app
// banner on open clients via GET /api/reminders).
//
// reminder = { id, profileId, streamId, channel, title, start, stop (ms),
//   status: "pending" | "fired" | "missed" | "dropped",
//   createdAt, firedAt?, ackedAt?, note? }

const LEAD_MS = 2 * 60e3;          // fire 2 min before start
const LATE_FIRE_MS = 5 * 60e3;     // still fire up to 5 min after start (server was down)
const DUE_WINDOW_MS = 10 * 60e3;   // banners show for 10 min after firing
const KEEP_MS = 24 * 3600e3;       // fired/missed/dropped kept a day after their stop
const MAX_PER_PROFILE = 100;        // pending
const MAX_TOTAL_PER_PROFILE = 200;  // every status
const MAX_DURATION_MS = 12 * 3600e3;
const REMATCH_WINDOW_MS = 3 * 3600e3;

function normTitle(t) {
  return String(t || "").normalize("NFKD").replace(/[̀-ͯ]/g, "").toLowerCase().replace(/[^\p{L}\p{N}]+/gu, "");
}

function validateCreate(body, now = Date.now()) {
  const b = body || {};
  const streamId = String(b.stream_id ?? "");
  if (!/^\d{1,12}$/.test(streamId)) return { error: "bad stream_id" };
  const title = String(b.title ?? "").trim().slice(0, 200);
  if (!title) return { error: "title required" };
  const start = Number(b.start_ts) * 1000;
  const stop = Number(b.stop_ts) * 1000;
  if (!Number.isFinite(start) || start <= 0) return { error: "bad start_ts" };
  if (start <= now) return { error: "programme already started" };
  if (start > now + 14 * 24 * 3600e3) return { error: "too far ahead" };
  return { streamId, title, start, stop: clampStop(start, stop) };
}

// A programme ends after it starts and lasts at most 12 h (prune keys on stop).
function clampStop(start, stop) {
  if (!Number.isFinite(stop) || stop <= start) return start + 30 * 60e3;
  return Math.min(stop, start + MAX_DURATION_MS);
}

// Same programme already has a reminder for this profile?
function findDuplicate(list, profileId, streamId, start, title) {
  const nt = normTitle(title);
  return list.find((r) => r.profileId === profileId && r.streamId === streamId && r.start === start && normTitle(r.title) === nt
    && (r.status === "pending" || r.status === "fired")) || null;
}

function countActive(list, profileId) {
  return list.filter((r) => r.profileId === profileId && r.status === "pending").length;
}

// Re-match a pending reminder against fresh guide data for its channel.
//   programmes: sorted [{ title, start, stop }] (ms) for the channel, or null
//   when the channel has no guide data (keep the reminder as it is).
// Returns { action: "keep" } | { action: "move", start, stop } | { action: "drop", note }.
function rematch(r, programmes) {
  if (!Array.isArray(programmes) || programmes.length === 0) return { action: "keep" };
  const nt = normTitle(r.title);
  let best = null;
  for (const p of programmes) {
    if (normTitle(p.title) !== nt) continue;
    const d = Math.abs(p.start - r.start);
    if (d > REMATCH_WINDOW_MS) continue;
    if (!best || d < best.d) best = { p, d };
  }
  if (best) {
    const stop = clampStop(best.p.start, best.p.stop);
    if (best.p.start === r.start && stop === r.stop) return { action: "keep" };
    return { action: "move", start: best.p.start, stop };
  }
  // Only drop when the guide actually covers that time; otherwise the guide
  // simply doesn't reach that far yet.
  const first = programmes[0].start;
  const last = programmes[programmes.length - 1].stop;
  if (r.start >= first && r.start < last) return { action: "drop", note: "No longer in the guide" };
  return { action: "keep" };
}

// Which reminders change state at `now`: fire (send) or miss (too late).
function dueTransitions(list, now = Date.now()) {
  const fire = [], miss = [];
  for (const r of list) {
    if (r.status !== "pending") continue;
    if (now < r.start - LEAD_MS) continue;
    if (now <= r.start + LATE_FIRE_MS) fire.push(r); else miss.push(r);
  }
  return { fire, miss };
}

// Reminders an open client should show a banner for.
function dueForProfile(list, profileId, now = Date.now()) {
  return list.filter((r) => r.profileId === profileId && r.status === "fired" && !r.ackedAt
    && r.firedAt && now - r.firedAt <= DUE_WINDOW_MS && now <= r.start + LATE_FIRE_MS + DUE_WINDOW_MS);
}

function prune(list, now = Date.now()) {
  return list.filter((r) => r.status === "pending" || now - Math.max(r.stop || 0, r.start || 0) < KEEP_MS);
}

// Room for one more reminder of this profile: drops its oldest non-pending
// ones while it holds MAX_TOTAL_PER_PROFILE or more. Returns the (possibly new)
// list, or null when the profile is full of pending reminders.
function makeRoom(list, profileId) {
  const mine = list.filter((r) => r.profileId === profileId);
  if (mine.filter((r) => r.status === "pending").length >= MAX_PER_PROFILE) return null;
  const excess = mine.length - (MAX_TOTAL_PER_PROFILE - 1);
  if (excess <= 0) return list;
  const drop = new Set(mine.filter((r) => r.status !== "pending")
    .sort((a, b) => (a.start || 0) - (b.start || 0)).slice(0, excess));
  const out = list.filter((r) => !drop.has(r));
  return out.filter((r) => r.profileId === profileId).length < MAX_TOTAL_PER_PROFILE ? out : null;
}

// Home Assistant notify service for a fired reminder, or null (in-app banner
// only). Only reminders set on the owner account by one of the owner user's
// own profiles push: HA_NOTIFY_PROFILES ("Nick=service,...", nick or profile
// id, case-insensitive) first, then HA_NOTIFY_SERVICE. Other users' profiles
// and deleted profiles never push.
function haServiceFor({ reminder, profile, ownerUserId, profilesMap, fallback }) {
  if (!reminder || !reminder.owner || !profile || !ownerUserId || profile.ownerUserId !== ownerUserId) return null;
  if (profile.id !== reminder.profileId) return null;
  const names = [profile.nick, profile.id].filter(Boolean).map((s) => String(s).toLowerCase());
  for (const pair of String(profilesMap || "").split(",")) {
    const i = pair.indexOf("=");
    if (i <= 0) continue;
    if (names.includes(pair.slice(0, i).trim().toLowerCase())) return pair.slice(i + 1).trim() || null;
  }
  return String(fallback || "").trim() || null;
}

function publicView(r, now = Date.now()) {
  return {
    id: r.id,
    stream_id: r.streamId,
    channel: r.channel || "",
    title: r.title,
    start_ts: Math.floor(r.start / 1000),
    stop_ts: Math.floor(r.stop / 1000),
    status: r.status,
    note: r.note || null,
    starts_in_secs: Math.round((r.start - now) / 1000),
  };
}

function notifyText(r, profileName, now = Date.now()) {
  const mins = Math.max(0, Math.round((r.start - now) / 60e3));
  const when = mins <= 0 ? "now" : `in ${mins} min`;
  const who = profileName ? `${profileName}: ` : "";
  return { title: "Khouch reminder", message: `${who}${r.title} starts on ${r.channel || "TV"} ${when}.` };
}

module.exports = {
  LEAD_MS, LATE_FIRE_MS, DUE_WINDOW_MS, MAX_PER_PROFILE, MAX_TOTAL_PER_PROFILE, MAX_DURATION_MS,
  normTitle, validateCreate, clampStop, makeRoom, haServiceFor, findDuplicate, countActive, rematch, dueTransitions, dueForProfile, prune, publicView, notifyText,
};
