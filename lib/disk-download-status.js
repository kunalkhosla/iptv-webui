// Client-facing projection of a Save-to-Disk job (POST /api/disk-download,
// GET /api/disk-download/jobs). Pure: server.js passes in whether the
// overnight download window is open right now. Every field past the
// original set (totalBytes, pct, waiting_for) is additive; older clients
// ignore it.
//
// waiting_for — why a not-yet-finished job is not moving bytes right now:
//   "window"  queued; the overnight window (DISK_DOWNLOAD_WINDOW_*) is closed
//   "queue"   queued; window open, another Save-to-Disk job is running
//   "viewer"  paused; someone is watching (the household's one IPTV stream
//             slot is theirs), resumes on its own when they stop
//   null      downloading, done or failed, or queued and about to start
function diskJobWaitingFor(j, windowOpen, othersRunning = false) {
  if (j.status === "queued") return !windowOpen ? "window" : othersRunning ? "queue" : null;
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
function projectDiskDownloadJob(j, { windowOpen = false, othersRunning = false } = {}) {
  return {
    id: j.jobId, mode: j.mode, sourceId: j.id, status: j.status,
    title: j.mode === "movie" ? j.title : j.episodeTitle,
    seriesTitle: j.seriesTitle || null, season: j.season || null, episodeNum: j.episodeNum || null,
    bytesWritten: j.bytesWritten, error: j.error, createdAt: j.createdAt, finishedAt: j.finishedAt || null,
    totalBytes: Number(j.totalBytes) > 0 ? Number(j.totalBytes) : null,
    pct: diskJobPct(j),
    waiting_for: diskJobWaitingFor(j, windowOpen, othersRunning),
  };
}

module.exports = { projectDiskDownloadJob, diskJobWaitingFor, diskJobPct };
