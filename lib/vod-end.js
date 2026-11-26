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
//    Ignored when more than 10% shorter than TMDB's runtime (or over 2x it);
//    otherwise it decides alone.
//  - TMDB runtime (movies only): whole minutes, can floor. Require
//    runtime*60 + RUNTIME_MARGIN_SECS so a mid-file drop just past the
//    rounded runtime is never mistaken for the end (that would truncate the
//    real ending).

const EXACT_TOLERANCE_SECS = 5;
const RUNTIME_MARGIN_SECS = 65;
// Stream copy (-c copy, "source" quality) seeks each -ss to the keyframe
// BEFORE it, so every anchored run can add up to a GOP of material already
// covered: the summed position overstates the truth by up to this much per
// such seek. Raise the bar by it (a missed end falls back to the
// no-packets end-of-title path; a false end would truncate the film).
const COPY_SEEK_SLACK_SECS = 10;
// A panel duration SHORTER than TMDB's runtime by more than this is a different
// cut / upload: don't trust it. Longer is fine (extended cut) up to
// DURATION_MAX_RATIO x the runtime (beyond that it's a bad value).
const DURATION_MISMATCH = 0.1;
const DURATION_MAX_RATIO = 2;

function positiveNumber(v) {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : null;
}

// { offsetSecs, elapsedSecs, durationSecs?, runtimeMin?, copySeeks? } ->
//   { done: boolean, by: "duration" | "runtime" | null, position }
function vodReachedEnd({ offsetSecs = 0, elapsedSecs = 0, durationSecs = null, runtimeMin = null, copySeeks = 0 } = {}) {
  const position = (Number(offsetSecs) || 0) + (Number(elapsedSecs) || 0);
  const slack = Math.max(0, Number(copySeeks) || 0) * COPY_SEEK_SLACK_SECS;
  const rt = positiveNumber(runtimeMin);
  let dur = positiveNumber(durationSecs);
  // A panel duration well SHORTER than TMDB's runtime is a different (cut)
  // upload: distrust it. A longer one (extended cut) is the real length.
  if (dur != null && rt != null && (dur < (1 - DURATION_MISMATCH) * rt * 60 || dur > DURATION_MAX_RATIO * rt * 60)) dur = null;
  // A trusted exact duration decides alone (the rounded runtime would end an
  // extended cut early).
  if (dur != null) {
    return position >= dur - EXACT_TOLERANCE_SECS + slack
      ? { done: true, by: "duration", position }
      : { done: false, by: null, position };
  }
  if (rt != null && position >= rt * 60 + RUNTIME_MARGIN_SECS + slack) return { done: true, by: "runtime", position };
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
