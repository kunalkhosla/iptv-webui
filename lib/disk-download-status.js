// Client-facing projection of a Save-to-Disk job (POST /api/disk-download,
// GET /api/disk-download/jobs). Pure: server.js passes in whether the
// opt-in overnight window is open (always true when no window is set) and
// whether a viewer is holding jobs back (lib/disk-download-schedule.js). Every field past the
// original set (totalBytes, pct, waiting_for) is additive; older clients
// ignore it.
//
// waiting_for — why a not-yet-finished job is not moving bytes right now:
//   "window"  queued; the opt-in overnight window (DISK_DOWNLOAD_WINDOW_*)
//             is set and closed. Never sent when no window is configured.
//   "queue"   queued behind another running Save-to-Disk job
//   "viewer"  paused, or queued and next: someone is watching (the
//             household's one IPTV stream slot is theirs) or stopped less
//             than the resume grace ago; starts/resumes on its own
//   null      downloading, done or failed, or queued and about to start
function diskJobWaitingFor(j, windowOpen, othersRunning = false, viewerWaiting = false) {
  if (j.status === "queued") return !windowOpen ? "window" : othersRunning ? "queue" : viewerWaiting ? "viewer" : null;
  if (j.status === "paused") return "viewer";
  return null;
}

// Whole percent, or null when the total size is unknown (the source sent no
// Content-Length, or the transfer has not started). Never 100 before "done":
// a finished byte count is still renamed + indexed before it is playable.
function diskJobPct(j) {
  if (j.status === "done") return 100;
  const total = Number(j.totalBytes);
  const got = Number(j.bytesWritten) || 0;
  if (!Number.isFinite(total) || total <= 0) return null;
  return Math.max(0, Math.min(99, Math.floor((got / total) * 100)));
}

// othersRunning: some job is downloading or paused (the queue runs one at a time).
function projectDiskDownloadJob(j, { windowOpen = false, othersRunning = false, viewerWaiting = false } = {}) {
  return {
    id: j.jobId, mode: j.mode, sourceId: j.id, status: j.status,
    title: j.mode === "movie" ? j.title : j.episodeTitle,
    seriesTitle: j.seriesTitle || null, season: j.season || null, episodeNum: j.episodeNum || null,
    bytesWritten: j.bytesWritten, error: j.error, createdAt: j.createdAt, finishedAt: j.finishedAt || null,
    totalBytes: Number(j.totalBytes) > 0 ? Number(j.totalBytes) : null,
    pct: diskJobPct(j),
    waiting_for: diskJobWaitingFor(j, windowOpen, othersRunning, viewerWaiting),
  };
}

const ACTIVE = new Set(["queued", "downloading", "paused"]);

// Which jobs GET /api/disk-download/jobs lists, newest first.
// - `mode` + `ids` (a detail page asking about its own titles): every job for
//   those source ids, uncapped, so a big series never loses its state.
// - otherwise: every queued/downloading/paused job (a client must never
//   re-queue one of those) plus the newest `cap` done/failed.
// Done/failed history is only kept for the newest 200 (saveDiskDownloadJobs).
function selectDiskJobs(all, { mode = null, ids = null, cap = 100 } = {}) {
  const byNewest = [...all].sort((a, b) => b.createdAt - a.createdAt);
  if (mode && ids) {
    const want = new Set([...ids].map(String));
    return byNewest.filter((j) => j.mode === mode && want.has(String(j.id)));
  }
  const active = byNewest.filter((j) => ACTIVE.has(j.status));
  const terminal = byNewest.filter((j) => !ACTIVE.has(j.status)).slice(0, cap);
  return [...active, ...terminal].sort((a, b) => b.createdAt - a.createdAt);
}

// Projects `list`; `all` is the whole job set (for "is another job running").
function projectDiskJobs(list, all, { windowOpen = false, viewerWaiting = false } = {}) {
  const running = [...all].filter((o) => o.status === "downloading" || o.status === "paused");
  return list.map((j) => projectDiskDownloadJob(j, { windowOpen, viewerWaiting, othersRunning: running.some((o) => o !== j) }));
}

// "?ids=1,2,3" -> ["1","2","3"] (digits only, max 5000), or null when absent/empty.
function parseIdsParam(q) {
  if (typeof q !== "string" || !q.trim()) return null;
  const ids = q.split(",").map((x) => x.trim()).filter((x) => /^\d{1,19}$/.test(x)).slice(0, 5000);
  return ids.length ? ids : null;
}

module.exports = { projectDiskDownloadJob, projectDiskJobs, selectDiskJobs, parseIdsParam, diskJobWaitingFor, diskJobPct };
