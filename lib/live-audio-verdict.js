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
const LIVE_DEAD_RECHECK_MS = 10 * 60 * 1000;
const LIVE_UNAVAILABLE = Object.freeze({
  error: "channel_unavailable",
  message: "This channel isn't available right now.",
});

// Liveness gate for /api/stream on a live channel.
//   no entry                      -> proceed (the audio probe checks liveness itself)
//   dead, checked < 10 min ago    -> unavailable (fast 503, cheap repeat zaps)
//   dead, older                   -> check (so channels can recover)
//   alive, checked < 24 h ago     -> proceed
//   alive, older                  -> check
// A check is skipped (proceed) while another viewer is streaming on the account:
// it would open a second panel connection against a cap=1 slot.
// An entry's liveness age is the newer of `ts` (full probe) and `live_ts`
// (liveness-only refresh).
function decideLiveHealth({ entry, now = Date.now(), viewerActive = false, aliveMs = LIVE_ALIVE_RECHECK_MS, deadMs = LIVE_DEAD_RECHECK_MS }) {
  if (!entry) return { action: "proceed" };
  const t = Math.max(Number(entry.ts) || 0, Number(entry.live_ts) || 0);
  const age = now - t;
  if (entry.dead) {
    if (t && age < deadMs) return { action: "unavailable" };
    return { action: viewerActive ? "proceed" : "check" };
  }
  if (!t || age >= aliveMs) return { action: viewerActive ? "proceed" : "check" };
  return { action: "proceed" };
}

// A playable HLS manifest lists segments (#EXTINF) or variants (#EXT-X-STREAM-INF).
function manifestHasContent(text) {
  return typeof text === "string" && /#EXTINF:|#EXT-X-STREAM-INF:/.test(text);
}

module.exports = { decideLiveAudio, withDeadline, decideLiveHealth, manifestHasContent, LIVE_UNAVAILABLE, LIVE_ALIVE_RECHECK_MS, LIVE_DEAD_RECHECK_MS };
