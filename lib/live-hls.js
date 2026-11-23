// Live HLS transcode tuning (pure helpers, unit-tested).
//
// The server-side live playlist is a sliding window of 4 s segments. A client
// that holds a 20-30 s live offset (see live-buffer notes) needs the window to
// be comfortably larger than that, otherwise any rebuffer pushes it behind the
// window (BehindLiveWindowException). Default 20 segments = 80 s.
const LIVE_SEGMENT_SECS = 4;
const MIN_LIST_SIZE = 6;
const MAX_LIST_SIZE = 60;
const DEFAULT_LIST_SIZE = 20;

function liveHlsListSize(env = process.env.LIVE_HLS_LIST_SIZE) {
  const n = parseInt(env, 10);
  if (!Number.isFinite(n)) return DEFAULT_LIST_SIZE;
  return Math.max(MIN_LIST_SIZE, Math.min(MAX_LIST_SIZE, n));
}

// Extra ffmpeg input flags for panel sources. NOT -reconnect_at_eof (a real EOF
// is the genuine end; it would reconnect-loop). 4xx is deliberately excluded:
// the panel answers 4xx for the connection cap / auth, and retrying inside
// ffmpeg would hammer a cap=1 account. 5xx and socket-level errors are safe.
function panelReconnectArgs() {
  return [
    "-rw_timeout", "15000000",
    "-reconnect", "1",
    "-reconnect_streamed", "1",
    "-reconnect_on_network_error", "1",
    "-reconnect_on_http_error", "5xx",
    "-reconnect_delay_max", "5",
    // Bound in-ffmpeg retries: a dead/rotated host must fall through to the
    // respawn path (which rebuilds the URL), not retry the same URL for minutes.
    "-reconnect_delay_total_max", "10",
    "-reconnect_max_retries", "2",
  ];
}

module.exports = { liveHlsListSize, panelReconnectArgs, LIVE_SEGMENT_SECS, DEFAULT_LIST_SIZE };
