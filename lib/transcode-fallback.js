"use strict";

// Per-stream software-encode fallback decision for the VOD transcoder.
//
// HW_ENCODE (Intel Quick Sync via VAAPI) is probed ONCE at boot with a
// minimal test encode. A pass there only proves the GPU can do a bare
// nv12 -> h264 upload; it does NOT prove every real source encodes. Some
// files carry video parameters the VAAPI encoder rejects at runtime
// (`h264_vaapi` exits with -22 "Invalid argument" and writes no packets)
// even though libx264 encodes them fine. Without a per-stream fallback such
// a file is permanently unplayable, contradicting the "libx264 as fallback"
// design. This predicate decides when a failed VOD run should be retried
// once in software.
//
// Gated tightly so it cannot perturb the live self-heal path or machine-gun
// a genuinely-dead panel input:
//   - VOD only (live has its own respawn/self-heal logic).
//   - the run must have USED hardware (nothing to fall back to otherwise).
//   - it must have exited with an error AND produced NO segment (a run that
//     produced output then died is a stream drop, not an encoder reject).
//   - retried at most once (alreadyTriedSoftware).
//   - a viewer must still be waiting and the stream not deliberately stopped.
function vodSoftwareFallbackEligible({
  mode,
  exitCode,
  usedHardware,
  alreadyTriedSoftware,
  producedSegment,
  viewerPresent,
  stopping,
} = {}) {
  return (
    mode !== "live" &&
    !stopping &&
    !!viewerPresent &&
    !!exitCode &&
    !!usedHardware &&
    !alreadyTriedSoftware &&
    !producedSegment
  );
}

// Circuit breaker for transcode sources that can't even be opened.
//
// When the upstream URL is invalid or the source file is broken, ffmpeg
// exits having NEVER produced a segment ("Invalid data found when
// processing input" — the input open fails, so the encoder never runs
// and the software fallback above can't help either). The source is
// unrecoverable, but nothing server-side remembers that across requests:
// the player re-requests the manifest every few seconds and each request
// spawns a fresh ffmpeg from scratch, machine-gunning a dead input
// forever (CPU + log flood, and it hammers the cap=1 panel).
//
// After such a give-up the key is held "unavailable" for a cooldown; a
// fresh request inside the window is refused fast instead of respawning.
// Any run that connects clears the record, so a genuinely transient
// failure recovers on the next attempt once the window passes.
function transcodeSourceUnavailable(lastFailureAt, now, cooldownMs) {
  return (
    typeof lastFailureAt === "number" &&
    lastFailureAt > 0 &&
    now - lastFailureAt < cooldownMs
  );
}

module.exports = { vodSoftwareFallbackEligible, transcodeSourceUnavailable };
