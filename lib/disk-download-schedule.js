// When may a Save-to-Disk job move bytes? Pure helpers; server.js feeds them
// the live `streams` admission map (see admitStream) and the clock.
//
// The provider allows ONE connection for the whole household, so a job runs
// only while nobody is watching: it starts as soon as the slot is free, yields
// the moment a viewer asks for a stream (server.js preempts it), and resumes
// (HTTP Range from the .part file) once no viewer has been seen for a grace.
//
// An overnight window is opt-in: only when BOTH DISK_DOWNLOAD_WINDOW_START_HOUR
// and DISK_DOWNLOAD_WINDOW_END_HOUR are set (valid 0-23, different) are jobs
// held outside it.

// Owner keys of background transfers (not people watching). They hold the
// provider slot but never block the grace, and a viewer always displaces them.
const BACKGROUND_PREFIXES = ["disk-download:", "phone-download:"];
function isBackgroundOwner(owner) {
  return typeof owner === "string" && BACKGROUND_PREFIXES.some((p) => owner.startsWith(p));
}
function isDiskDownloadOwner(owner) {
  return typeof owner === "string" && owner.startsWith("disk-download:");
}

function parseHour(v) {
  if (v == null || String(v).trim() === "") return null;
  const n = Number(v);
  return Number.isInteger(n) && n >= 0 && n <= 23 ? n : NaN;
}

// -> { enabled, startHour, endHour, invalid }. `invalid` = something was set
// but not a usable window (one var only, a bad value, or start == end); the
// window is then off and the caller logs it.
function parseWindowEnv(startEnv, endEnv) {
  const s = parseHour(startEnv);
  const e = parseHour(endEnv);
  if (s === null && e === null) return { enabled: false, startHour: null, endHour: null, invalid: false };
  if (s === null || e === null || Number.isNaN(s) || Number.isNaN(e) || s === e) {
    return { enabled: false, startHour: null, endHour: null, invalid: true };
  }
  return { enabled: true, startHour: s, endHour: e, invalid: false };
}

function hourInWindow(h, startHour, endHour) {
  return startHour <= endHour
    ? h >= startHour && h < endHour
    : h >= startHour || h < endHour; // wraps midnight
}

// Who else holds the provider slot for `accountKey`: "viewer" (a person: any
// non-background entry, including a paused player kept alive by heartbeats
// and a Disk transcode, which counts against the cap), "background" (another
// download), or null. Displaced entries are already dead.
function slotHolder(streams, selfOwner, accountKey) {
  let holder = null;
  for (const [k, v] of streams) {
    if (k === selfOwner || v.displaced || v.accountKey !== accountKey) continue;
    if (!isBackgroundOwner(k)) return "viewer";
    holder = "background";
  }
  return holder;
}

// Newest viewer activity: max(prev, lastSeen of every non-background entry).
function latestViewerSeen(streams, prev = 0) {
  let t = prev || 0;
  for (const [k, v] of streams) {
    if (isBackgroundOwner(k)) continue;
    if (Number(v.lastSeen) > t) t = Number(v.lastSeen);
  }
  return t;
}

// -> { run: boolean, waitingFor: null | "window" | "viewer" | "queue" }
function decideDiskDownload({ now, windowEnabled = false, windowOpen = true, holder = null, lastViewerAt = 0, graceMs = 120_000 }) {
  if (windowEnabled && !windowOpen) return { run: false, waitingFor: "window" };
  if (holder === "viewer") return { run: false, waitingFor: "viewer" };
  if (holder === "background") return { run: false, waitingFor: "queue" };
  if (lastViewerAt && now - lastViewerAt < graceMs) return { run: false, waitingFor: "viewer" };
  return { run: true, waitingFor: null };
}

// "DISK_DOWNLOAD_RESUME_GRACE_MS" -> ms (default 2 min, 15 s..30 min). The
// floor keeps a preempted job from re-admitting before the player's first
// media request arrives.
const MIN_GRACE_MS = 15_000;
function graceMsFrom(v, fallback = 120_000) {
  if (v == null || String(v).trim() === "") return fallback;
  const n = Number(v);
  if (!Number.isFinite(n) || n < 0 || n > 30 * 60_000) return fallback;
  return Math.max(MIN_GRACE_MS, n);
}

module.exports = {
  isBackgroundOwner, isDiskDownloadOwner, parseWindowEnv, hourInWindow,
  slotHolder, latestViewerSeen, decideDiskDownload, graceMsFrom,
};
