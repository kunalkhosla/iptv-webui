// Stale-if-error for movie/series detail info (get_vod_info /
// get_series_info). The panel occasionally 500s or times out on a single
// title; the in-memory xtream cache is wiped on every restart/deploy, so
// a transient panel error right after a restart left the detail screen
// with nothing. This module keeps the last good response on disk and
// serves it when the live panel call fails.
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");

class InfoUnavailableError extends Error {
  constructor(cause) {
    super(`info unavailable: ${cause && cause.message ? cause.message : cause}`);
    this.code = "info_unavailable";
    this.cause = cause;
  }
}

const nonEmptyObj = (o) => !!o && typeof o === "object" && !Array.isArray(o) && Object.keys(o).length > 0;
const hasEpisodes = (v) =>
  nonEmptyObj(v.episodes) && Object.values(v.episodes).some((eps) => Array.isArray(eps) && eps.length > 0);

// A panel answer worth keeping/serving. Panels return `[]`,
// `{info: [], episodes: []}`, or (degraded) series info with no
// episodes — never let one of those overwrite or beat a good copy.
// Series must carry at least one episode; movies need info or movie_data.
function isUsableInfo(v, mode) {
  if (!v || typeof v !== "object" || Array.isArray(v)) return false;
  if (mode === "series") return hasEpisodes(v);
  if (mode === "movie") return nonEmptyObj(v.info) || nonEmptyObj(v.movie_data);
  return nonEmptyObj(v.info) || hasEpisodes(v) || nonEmptyObj(v.movie_data);
}

const DAY = 24 * 60 * 60 * 1000;

function createInfoStore({
  dir,
  maxEntries = 3000,
  maxAgeMs = 30 * DAY,
  rewriteAfterMs = 6 * 60 * 60 * 1000,
  tmpMaxAgeMs = 60 * 60 * 1000,
  now = () => Date.now(),
} = {}) {
  if (!dir) throw new Error("createInfoStore: dir required");
  const savedAt = new Map(); // file basename -> last write time (this process)
  let putsSincePrune = 0;
  const nameFor = (key) => crypto.createHash("sha1").update(key).digest("hex") + ".json";
  const fileFor = (key) => path.join(dir, nameFor(key));

  async function get(key) {
    try {
      const raw = await fs.promises.readFile(fileFor(key), "utf8");
      const rec = JSON.parse(raw);
      if (!rec || rec.v === undefined) return null;
      if (Number.isFinite(rec.t) && now() - rec.t > maxAgeMs) return null;
      return rec;
    } catch {
      return null;
    }
  }

  async function unlinkQuiet(name) {
    savedAt.delete(name);
    try { await fs.promises.unlink(path.join(dir, name)); } catch {}
  }

  // Drops leftover *.tmp files, copies older than maxAgeMs, then the
  // oldest copies beyond maxEntries.
  async function prune() {
    let names;
    try { names = await fs.promises.readdir(dir); } catch { return; }
    const t = now();
    const live = [];
    for (const n of names) {
      let m;
      try { m = (await fs.promises.stat(path.join(dir, n))).mtimeMs; } catch { continue; }
      if (n.endsWith(".tmp")) { if (t - m > tmpMaxAgeMs) await unlinkQuiet(n); continue; }
      if (!n.endsWith(".json")) continue;
      if (t - m > maxAgeMs) { await unlinkQuiet(n); continue; }
      live.push({ n, m });
    }
    if (live.length <= maxEntries) return;
    live.sort((a, b) => a.m - b.m);
    for (const { n } of live.slice(0, live.length - maxEntries)) await unlinkQuiet(n);
  }

  // Best-effort; never throws. Skips the write when this process already
  // saved the key recently and the file is still there.
  async function put(key, v, mode) {
    if (!isUsableInfo(v, mode)) return false;
    const t = now();
    const name = nameFor(key);
    const file = path.join(dir, name);
    const last = savedAt.get(name);
    if (last && t - last < rewriteAfterMs && fs.existsSync(file)) return false;
    savedAt.set(name, t);
    const tmp = `${file}.${process.pid}.${t}.tmp`;
    try {
      await fs.promises.mkdir(dir, { recursive: true });
      await fs.promises.writeFile(tmp, JSON.stringify({ t, v }));
      await fs.promises.rename(tmp, file);
    } catch {
      savedAt.delete(name);
      try { await fs.promises.unlink(tmp); } catch {}
      return false;
    }
    if (++putsSincePrune >= 50) { putsSincePrune = 0; prune().catch(() => {}); }
    return true;
  }

  return { get, put, prune, fileFor };
}

// Rejects with a TimeoutError after `ms` (the underlying promise keeps
// running — e.g. a shared 90 s prewarm fetch still fills the cache).
function withTimeout(promise, ms) {
  if (!ms) return promise;
  let timer;
  const t = new Promise((_, reject) => {
    timer = setTimeout(() => reject(Object.assign(new Error(`info timed out after ${ms} ms`), { name: "TimeoutError" })), ms);
  });
  return Promise.race([promise, t]).finally(() => clearTimeout(timer));
}

// fetchLive: () => Promise<v>   (the normal xtream() call)
// memStale:  v | undefined      (in-memory copy snapshotted BEFORE the live
//                                call, so a shell the live call just cached
//                                can't masquerade as the good copy)
// onUnusableLive: () => void    (live answered with an unusable shell; the
//                                caller should drop it from its cache)
// Returns { v, stale, source: "live" | "memory" | "disk", t? }.
// Throws InfoUnavailableError when the live call fails and no good copy exists.
async function getInfoStaleIfError({ key, mode, fetchLive, memStale, store, timeoutMs, onStale, onUnusableLive }) {
  let live;
  let liveErr;
  try {
    live = await withTimeout(Promise.resolve().then(fetchLive), timeoutMs);
    if (isUsableInfo(live, mode)) {
      store.put(key, live, mode).catch(() => {});
      return { v: live, stale: false, source: "live" };
    }
    if (onUnusableLive) onUnusableLive();
  } catch (e) {
    liveErr = e;
  }
  // Live call failed, or the panel answered with an empty shell for a
  // title we previously had real data for: serve the last good copy.
  const why = liveErr || new Error("empty panel answer");
  if (isUsableInfo(memStale, mode)) {
    const r = { v: memStale, stale: true, source: "memory" };
    if (onStale) onStale(r, why);
    return r;
  }
  const rec = await store.get(key);
  if (rec && isUsableInfo(rec.v, mode)) {
    const r = { v: rec.v, stale: true, source: "disk", t: rec.t };
    if (onStale) onStale(r, why);
    return r;
  }
  // No good copy. An empty-but-successful panel answer passes through
  // unchanged (pre-existing behavior for unknown ids); a failure is a
  // structured "unavailable".
  if (!liveErr) return { v: live, stale: false, source: "live" };
  throw new InfoUnavailableError(liveErr);
}

module.exports = { createInfoStore, getInfoStaleIfError, isUsableInfo, InfoUnavailableError, withTimeout };
