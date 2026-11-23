"use strict";
// Decides how /api/stream treats a live channel's audio-codec verdict so a
// zap never waits on a slow ffprobe for more than `waitMs`.
//
//   fresh entry            -> use it, no probe
//   stale alive entry      -> use it NOW (codecs don't change), revalidate in background
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
    return { use: entry, wait: false, background: !anyInflight };
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

module.exports = { decideLiveAudio, withDeadline };
