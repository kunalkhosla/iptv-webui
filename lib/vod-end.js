// End-of-title decisions for a VOD transcode whose ffmpeg just exited.
//
// The transcode's playlist only covers [offsetSecs, offsetSecs + elapsed): a
// resumed play (?t=<secs>) starts ffmpeg with -ss offsetSecs, so the position
// in the TITLE where this exit happened is offsetSecs + elapsed, not elapsed.
// Comparing elapsed alone to the runtime never fired for a resumed movie, so
// its real end was treated as a dropped connection and respawned past EOF
// (extra upstream connections on a cap=1 account).
//
// Two duration sources:
//  - panel duration_secs (get_vod_info / episode info): exact. Treat the end
//    as reached within EXACT_TOLERANCE_SECS of it.
//  - TMDB runtime (movies only): whole minutes, can floor. Require
//    runtime*60 + RUNTIME_MARGIN_SECS so a mid-file drop just past the
//    rounded runtime is never mistaken for the end (that would truncate the
//    real ending).

const EXACT_TOLERANCE_SECS = 5;
const RUNTIME_MARGIN_SECS = 65;

function positiveNumber(v) {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : null;
}

// { offsetSecs, elapsedSecs, durationSecs?, runtimeMin? } ->
//   { done: boolean, by: "duration" | "runtime" | null, position }
function vodReachedEnd({ offsetSecs = 0, elapsedSecs = 0, durationSecs = null, runtimeMin = null } = {}) {
  const position = (Number(offsetSecs) || 0) + (Number(elapsedSecs) || 0);
  const dur = positiveNumber(durationSecs);
  if (dur != null && position >= dur - EXACT_TOLERANCE_SECS) return { done: true, by: "duration", position };
  const rt = positiveNumber(runtimeMin);
  if (rt != null && position >= rt * 60 + RUNTIME_MARGIN_SECS) return { done: true, by: "runtime", position };
  return { done: false, by: null, position };
}

// Label for a respawn that connected-failed ("no packets") on a title that
// was working. Right after a CLEAN exit 0 that is a seek past the end of the
// file, not the cap=1 slot still being held by our previous connection.
function noPacketsLabel({ previousExitCode, stderr }) {
  const noPackets = /received no packets|nothing was written/i.test(String(stderr || ""));
  if (noPackets && previousExitCode === 0) return "past end of file";
  return "slot-held";
}

module.exports = { vodReachedEnd, noPacketsLabel, EXACT_TOLERANCE_SECS, RUNTIME_MARGIN_SECS };
