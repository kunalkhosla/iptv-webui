// Pure bookkeeping for the download job queue + the per-profile "pending"
// list used by the batch endpoint. No I/O: server.js owns files and running.
// Everything here is synchronous, so callers cannot interleave inside it.
const ACTIVE = new Set(["queued", "waiting", "running"]);

function createDownloadQueue({ maxActive = 12, maxPerProfile = 5, maxPending = 50 } = {}) {
  const jobs = new Map();     // key -> job
  const queue = [];           // jobs not yet started (state "queued"), FIFO
  const pending = new Map();  // key -> {mode,id,actx,profileId}, FIFO, not yet jobs

  const active = () => [...jobs.values()].filter((j) => ACTIVE.has(j.state));
  function atCap(profileId) {
    const a = active();
    return a.length >= maxActive || a.filter((j) => j.profileId === profileId).length >= maxPerProfile;
  }
  const pendingCount = (profileId) => { let n = 0; for (const p of pending.values()) if (p.profileId === profileId) n++; return n; };
  function makeJob(key, mode, id, actx, profileId) {
    const job = { key, mode, id, actx, profileId, state: "queued", stage: "queued", pct: 0, bytes: 0, error: null, createdAt: Date.now(), cancelled: false, abort: null };
    jobs.set(key, job);
    queue.push(job);
    return job;
  }
  // Returns {result: "existing"|"started"|"pending"|"capped"|"full", job?}.
  function admit(key, mode, id, actx, profileId, { defer = false } = {}) {
    const cur = jobs.get(key);
    if (cur && cur.state !== "failed") return { result: "existing", job: cur };
    if (pending.has(key)) return { result: "pending" };
    if (atCap(profileId)) {
      if (!defer) return { result: "capped" };
      if (pendingCount(profileId) >= maxPending) return { result: "full" };
      pending.set(key, { mode, id, actx, profileId });
      return { result: "pending" };
    }
    return { result: "started", job: makeJob(key, mode, id, actx, profileId) };
  }
  // FIFO; a profile at its own cap is skipped without blocking others; stops at
  // the global cap. Returns the jobs it started (caller kicks the pump).
  function promote(shouldSkip = () => false) {
    const started = [];
    for (const [k, p] of [...pending]) {
      if (active().length >= maxActive) break;
      if (atCap(p.profileId)) continue;
      pending.delete(k);
      if (shouldSkip(k, p)) continue; // e.g. file became ready meanwhile
      const cur = jobs.get(k);
      if (cur && cur.state !== "failed") continue;
      started.push(makeJob(k, p.mode, p.id, p.actx, p.profileId));
    }
    return started;
  }
  const cancelPending = (key) => pending.delete(key);
  function removeFromQueue(job) { const i = queue.indexOf(job); if (i >= 0) queue.splice(i, 1); }
  // Only drop the map entry if it still belongs to this job (a re-enqueue may
  // have replaced it).
  function dropJob(job) { if (jobs.get(job.key) === job) jobs.delete(job.key); }
  // 1-based position within the owning profile's own not-yet-started work
  // (its queued jobs, then its pending items). 0 if neither.
  function position(key) {
    const j = jobs.get(key);
    if (j) {
      if (j.state !== "queued") return 0;
      return queue.filter((q) => q.profileId === j.profileId).indexOf(j) + 1;
    }
    const p = pending.get(key);
    if (!p) return 0;
    const mine = [...pending.entries()].filter(([, v]) => v.profileId === p.profileId).map(([k]) => k);
    return queue.filter((q) => q.profileId === p.profileId).length + mine.indexOf(key) + 1;
  }
  return { jobs, queue, pending, admit, promote, cancelPending, removeFromQueue, dropJob, position, atCap, active };
}
// "viewer" when the job, or the running job it is queued behind, is paused for a live viewer.
function waitingFor(job, current) {
  if (job.state === "waiting" && job.stage === "waiting-for-viewer") return "viewer";
  if (job.state === "queued" && current && current !== job && !current.cancelled
      && current.state === "waiting" && current.stage === "waiting-for-viewer") return "viewer";
  return null;
}
module.exports = { createDownloadQueue, waitingFor };
