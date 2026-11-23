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

// A live liveness check is one playlist GET (~0.3 s, no segments), so an alive
// verdict is re-verified often: channels die at the provider without warning,
// and a stale "alive" must not hide a dead one for long.
const LIVE_ALIVE_RECHECK_MS = 30 * 60 * 1000;
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
//   no entry                          -> check (first play of a dead channel must 503 fast)
//   dead(persistent), inside its TTL  -> unavailable (fast 503; `retry` bypasses once)
//   dead(persistent) past TTL, or dead with a transient/legacy reason -> check
//   alive, checked < aliveMs ago      -> proceed (`retry` -> check: the client saw it fail)
//   alive, older                      -> check
// A check is skipped (proceed) while any viewer is streaming: it would open a
// second panel connection against a cap=1 slot. An entry's liveness age is the
// newer of `ts` (full probe) and `live_ts` (liveness-only refresh).
function decideLiveHealth({ entry, now = Date.now(), viewerActive = false, retry = false, aliveMs = LIVE_ALIVE_RECHECK_MS }) {
  const check = { action: viewerActive ? "proceed" : "check" };
  if (!entry) return check;
  const t = Math.max(Number(entry.ts) || 0, Number(entry.live_ts) || 0);
  const age = now - t;
  if (entry.dead) {
    if (!isPersistentDeadReason(entry.dead_reason)) return check;
    if (!retry && t && age < deadTtlMs(entry.dead_reason)) return { action: "unavailable" };
    return check;
  }
  if (retry || !t || age >= aliveMs) return check;
  return { action: "proceed" };
}

// Fold the outcome of a liveness check into the cached entry.
//   res = { alive: true } | { alive: false, reason } (persistent, confirmed) | { alive: null } (inconclusive)
// Returns { kind, entry }: kind is "dead" (cache entry, 503), "recovered" (drop
// entry, re-probe codec), "alive" (entry with live_ts bumped) or "inconclusive"
// (cache untouched, play).
// An alive result on a channel with no usable entry (first play, or recovered
// from dead) yields a liveness-only entry: codec unknown (ts 0, so the codec
// probe still runs for clients that route on it), liveness fresh, so the next
// zap within LIVE_ALIVE_RECHECK_MS skips the network check.
function livenessOnlyEntry(now) {
  return { audio_codec: null, browser_safe: false, dead: false, ts: 0, live_ts: now };
}
function applyLiveCheck(entry, res, now = Date.now()) {
  if (res && res.alive === true) {
    if (entry && entry.dead) return { kind: "recovered", entry: livenessOnlyEntry(now) };
    return { kind: "alive", entry: entry ? { ...entry, live_ts: now } : livenessOnlyEntry(now) };
  }
  if (res && res.alive === false && isPersistentDeadReason(res.reason)) {
    return { kind: "dead", entry: { ...(entry || {}), audio_codec: entry?.audio_codec ?? null,
      browser_safe: !!entry?.browser_safe, dead: true, dead_reason: res.reason, ts: now, live_ts: now } };
  }
  return { kind: "inconclusive", entry: entry && entry.dead ? undefined : entry };
}

// Clients that pick direct vs transcode themselves and never read
// forceTranscode / url (the Android TV + phone apps: Retrofit/okhttp with the
// default UA), or any client sending ?probe=0. For them the live codec ffprobe
// is pure latency (up to LIVE_AUDIO_PROBE_WAIT_MS) plus an extra panel
// connection right before their own stream opens on a cap=1 account.
function clientRoutesLiveAudio({ userAgent, probe } = {}) {
  if (probe === "0") return true;
  return /^okhttp\//i.test(String(userAgent || ""));
}

// True when this /api/stream answer already reflects a liveness verdict the
// client can trust (fresh cached alive, or a check that just came back alive),
// so a client need not spend its own manifest GET on a pre-play check. False
// when the gate was bypassed (another viewer streaming) or the check was
// inconclusive.
function liveVerdictTrusted({ viewerActive, healthAction, checkKind }) {
  if (viewerActive) return false;
  if (healthAction === "proceed") return true;
  return checkKind === "alive" || checkKind === "recovered";
}

// A playable HLS manifest lists at least one segment (#EXTINF followed by a
// URI line) or variant (#EXT-X-STREAM-INF followed by a URI line). The
// provider's dead-channel playlist has a bare "#EXTINF:10.0," with NO URI
// (then #EXT-X-ENDLIST); ExoPlayer throws IndexOutOfBounds on it and spins.
function manifestHasContent(text) {
  if (typeof text !== "string") return false;
  let pending = false; // saw #EXTINF / #EXT-X-STREAM-INF, waiting for its URI
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) continue;
    if (line.startsWith("#EXTINF:") || line.startsWith("#EXT-X-STREAM-INF:")) { pending = true; continue; }
    if (line.startsWith("#")) continue; // other tags (BYTERANGE, PROGRAM-DATE-TIME, ...) may sit in between
    if (pending) return true;
  }
  return false;
}

// First variant URI of a master playlist, or null for a media playlist.
function firstVariantUri(text) {
  if (typeof text !== "string" || /#EXTINF:/.test(text)) return null;
  const lines = text.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].startsWith("#EXT-X-STREAM-INF:")) {
      for (let j = i + 1; j < lines.length; j++) {
        const u = lines[j].trim();
        if (u && !u.startsWith("#")) return u;
      }
    }
  }
  return null;
}

module.exports = { liveVerdictTrusted, clientRoutesLiveAudio, livenessOnlyEntry, firstVariantUri, decideLiveAudio, withDeadline, decideLiveHealth, applyLiveCheck, isPersistentDeadReason, deadTtlMs, manifestHasContent, LIVE_UNAVAILABLE, LIVE_ALIVE_RECHECK_MS };
