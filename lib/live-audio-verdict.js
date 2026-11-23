"use strict";
// Decides how /api/stream treats a live channel's audio-codec verdict so a
// zap never waits on a slow ffprobe for more than `waitMs`.
//
//   fresh entry            -> use it, no probe
//   stale alive entry      -> use it NOW (codecs don't change); no probe (a probe
//                             would compete with the viewer's own stream for the slot)
//   unknown / stale dead   -> probe, but only wait up to waitMs; the probe keeps
//                             running and caches for next time
//
// Returns { use, wait, background }:
//   use        entry to route on immediately (or null)
//   wait       true = await a probe bounded by waitMs before routing
//   background true = fire a probe without waiting (refresh a stale verdict)
function decideLiveAudio({ entry, fresh, sameKeyInflight, anyInflight }) {
  if (entry && fresh) return { use: entry, wait: false, background: false };
  if (entry && !entry.dead && entry.audio_codec) {
    return { use: entry, wait: false, background: false };
  }
  // Join this channel's own in-flight probe; never start a second parallel one.
  if (sameKeyInflight || !anyInflight) return { use: null, wait: true, background: false };
  return { use: null, wait: false, background: false };
}

// Resolve `promise` or null after ms; never rejects.
function withDeadline(promise, ms) {
  let t;
  const timeout = new Promise((resolve) => { t = setTimeout(() => resolve(null), ms); });
  return Promise.race([Promise.resolve(promise).catch(() => null), timeout]).finally(() => clearTimeout(t));
}

const LIVE_ALIVE_RECHECK_MS = 24 * 60 * 60 * 1000;
const LIVE_UNAVAILABLE = Object.freeze({
  error: "channel_unavailable",
  message: "This channel isn't available right now.",
});

// Only these failures mean "the channel is broken". Timeouts, fetch errors,
// 403 (anti-abuse / cap=1 slot busy), 429 and 5xx are INCONCLUSIVE: the
// channel may be fine, so they never produce a dead verdict or a 503.
const PERSISTENT_DEAD_REASONS = new Set(["empty-playlist", "http-404", "http-410"]);
function isPersistentDeadReason(reason) { return PERSISTENT_DEAD_REASONS.has(reason); }

// How long a dead verdict is trusted (and the 503 served without a network
// call). 404/410 are stable; an empty playlist can be a momentary restart.
const DEAD_TTL_HARD_MS = 10 * 60 * 1000;
const DEAD_TTL_EMPTY_MS = 60 * 1000;
function deadTtlMs(reason) {
  return reason === "http-404" || reason === "http-410" ? DEAD_TTL_HARD_MS : DEAD_TTL_EMPTY_MS;
}

// Liveness gate for /api/stream on a live channel.
//   no entry                          -> proceed (the audio probe checks liveness itself)
//   dead(persistent), inside its TTL  -> unavailable (fast 503; `retry` bypasses once)
//   dead(persistent) past TTL, or dead with a transient/legacy reason -> check
//   alive, checked < 24 h ago         -> proceed
//   alive, older                      -> check
// A check is skipped (proceed) while any viewer is streaming: it would open a
// second panel connection against a cap=1 slot. An entry's liveness age is the
// newer of `ts` (full probe) and `live_ts` (liveness-only refresh).
function decideLiveHealth({ entry, now = Date.now(), viewerActive = false, retry = false, aliveMs = LIVE_ALIVE_RECHECK_MS }) {
  if (!entry) return { action: "proceed" };
  const t = Math.max(Number(entry.ts) || 0, Number(entry.live_ts) || 0);
  const age = now - t;
  const check = { action: viewerActive ? "proceed" : "check" };
  if (entry.dead) {
    if (!isPersistentDeadReason(entry.dead_reason)) return check;
    if (!retry && t && age < deadTtlMs(entry.dead_reason)) return { action: "unavailable" };
    return check;
  }
  if (!t || age >= aliveMs) return check;
  return { action: "proceed" };
}

// Fold the outcome of a liveness check into the cached entry.
//   res = { alive: true } | { alive: false, reason } (persistent, confirmed) | { alive: null } (inconclusive)
// Returns { kind, entry }: kind is "dead" (cache entry, 503), "recovered" (drop
// entry, re-probe codec), "alive" (entry with live_ts bumped) or "inconclusive"
// (cache untouched, play).
function applyLiveCheck(entry, res, now = Date.now()) {
  if (res && res.alive === true) {
    if (entry && entry.dead) return { kind: "recovered", entry: undefined };
    return { kind: "alive", entry: entry ? { ...entry, live_ts: now } : entry };
  }
  if (res && res.alive === false && isPersistentDeadReason(res.reason)) {
    return { kind: "dead", entry: { ...(entry || {}), audio_codec: entry?.audio_codec ?? null,
      browser_safe: !!entry?.browser_safe, dead: true, dead_reason: res.reason, ts: now, live_ts: now } };
  }
  return { kind: "inconclusive", entry: entry && entry.dead ? undefined : entry };
}

// A playable HLS manifest lists segments (#EXTINF) or variants (#EXT-X-STREAM-INF).
function manifestHasContent(text) {
  return typeof text === "string" && /#EXTINF:|#EXT-X-STREAM-INF:/.test(text);
}

module.exports = { decideLiveAudio, withDeadline, decideLiveHealth, applyLiveCheck, isPersistentDeadReason, deadTtlMs, manifestHasContent, LIVE_UNAVAILABLE, LIVE_ALIVE_RECHECK_MS };
