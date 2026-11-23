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

// A panel answer worth keeping/serving. Panels return `[]` or
// `{info: [], episodes: []}` for unknown ids — never let one of those
// overwrite a good copy.
function isUsableInfo(v) {
  if (!v || typeof v !== "object" || Array.isArray(v)) return false;
  const info = v.info;
  const hasInfo = info && typeof info === "object" && !Array.isArray(info) && Object.keys(info).length > 0;
  const eps = v.episodes;
  const hasEps = eps && typeof eps === "object" && Object.keys(eps).length > 0;
  const movie = v.movie_data;
  const hasMovie = movie && typeof movie === "object" && !Array.isArray(movie) && Object.keys(movie).length > 0;
  return !!(hasInfo || hasEps || hasMovie);
}

function createInfoStore({
  dir,
  maxEntries = 3000,
  rewriteAfterMs = 6 * 60 * 60 * 1000,
  now = () => Date.now(),
} = {}) {
  if (!dir) throw new Error("createInfoStore: dir required");
  const savedAt = new Map(); // key -> last write time (this process)
  let putsSincePrune = 0;
  const fileFor = (key) => path.join(dir, crypto.createHash("sha1").update(key).digest("hex") + ".json");

  async function get(key) {
    try {
      const raw = await fs.promises.readFile(fileFor(key), "utf8");
      const rec = JSON.parse(raw);
      return rec && rec.v !== undefined ? rec : null;
    } catch {
      return null;
    }
  }

  async function prune() {
    let names;
    try { names = await fs.promises.readdir(dir); } catch { return; }
    names = names.filter((n) => n.endsWith(".json"));
    if (names.length <= maxEntries) return;
    const stats = [];
    for (const n of names) {
      try { stats.push({ n, m: (await fs.promises.stat(path.join(dir, n))).mtimeMs }); } catch {}
    }
    stats.sort((a, b) => a.m - b.m);
    for (const { n } of stats.slice(0, stats.length - maxEntries)) {
      try { await fs.promises.unlink(path.join(dir, n)); } catch {}
    }
  }

  // Best-effort; never throws. Skips the write when this process already
  // saved the key recently (repeat opens are in-memory cache hits).
  async function put(key, v) {
    if (!isUsableInfo(v)) return false;
    const t = now();
    const last = savedAt.get(key);
    if (last && t - last < rewriteAfterMs) return false;
    savedAt.set(key, t);
    const file = fileFor(key);
    const tmp = `${file}.${process.pid}.${t}.tmp`;
    try {
      await fs.promises.mkdir(dir, { recursive: true });
      await fs.promises.writeFile(tmp, JSON.stringify({ t, v }));
      await fs.promises.rename(tmp, file);
    } catch (e) {
      savedAt.delete(key);
      try { await fs.promises.unlink(tmp); } catch {}
      return false;
    }
    if (++putsSincePrune >= 50) { putsSincePrune = 0; prune().catch(() => {}); }
    return true;
  }

  return { get, put, prune, fileFor };
}

// fetchLive: () => Promise<v>  (the normal xtream() call)
// memStale: () => v | undefined (in-memory entry, even past TTL)
// Returns { v, stale, source: "live" | "memory" | "disk", t? }.
// Throws InfoUnavailableError when the live call fails and no good copy exists.
async function getInfoStaleIfError({ key, fetchLive, memStale, store, onStale }) {
  let live;
  let liveErr;
  try {
    live = await fetchLive();
    if (isUsableInfo(live)) {
      store.put(key, live).catch(() => {});
      return { v: live, stale: false, source: "live" };
    }
  } catch (e) {
    liveErr = e;
  }
  // Live call failed, or the panel answered with an empty shell for a
  // title we previously had real data for: serve the last good copy.
  const why = liveErr || new Error("empty panel answer");
  const mem = pickStale(memStale);
  if (mem) {
    const r = { v: mem, stale: true, source: "memory" };
    if (onStale) onStale(r, why);
    return r;
  }
  const rec = await store.get(key);
  if (rec && isUsableInfo(rec.v)) {
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

function pickStale(memStale) {
  try {
    const v = memStale && memStale();
    return isUsableInfo(v) ? v : null;
  } catch {
    return null;
  }
}

module.exports = { createInfoStore, getInfoStaleIfError, isUsableInfo, InfoUnavailableError };
