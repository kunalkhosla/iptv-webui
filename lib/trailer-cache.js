// Native trailer cache (GET /api/trailer/:key.mp4).
//
// YouTube trailer keys (TMDB `trailer_key`) are downloaded once with yt-dlp
// into DATA_DIR/trailers/<key>.mp4 and then served from disk with Range
// support, so the apps play trailers natively instead of hopping to YouTube.
// This never touches the IPTV panel or its 1-connection stream admission.
//
// - ensure(key, {priority}) -> absolute file path, or null when the trailer
//   could not be fetched (negative-cached for negTtlMs).
// - Concurrent ensure() calls for the same key share one download.
// - At most `concurrency` downloads run at once; "high" (a viewer waiting)
//   jumps ahead of queued "low" (background prefetch) work.
// - Writes go to a private temp dir and are renamed into place (atomic).
// - Last use = file mtime (touched on every serve); evict() deletes files
//   unused for ttlMs and then the least recently used until the total is
//   under maxBytes.
//
// Pure apart from fs: the downloader and the clock are injected.
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const { spawn } = require("node:child_process");

const KEY_RE = /^[A-Za-z0-9_-]{6,20}$/;
const isValidTrailerKey = (k) => typeof k === "string" && KEY_RE.test(k);

function createTrailerCache({
  dir,
  download,                         // async (key, tmpDir, {timeoutMs}) -> path of the finished .mp4 inside tmpDir
  concurrency = 2,
  timeoutMs = 45_000,
  negTtlMs = 6 * 3600_000,
  timeoutNegTtlMs = 15 * 60_000,    // a timeout is often transient: shorter memory
  backstopMs = 15_000,              // extra grace before a hung download frees its slot
  touchEveryMs = 3600_000,          // refresh last-use (mtime) at most hourly
  ttlMs = 30 * 86400_000,
  maxBytes = 8 * 1024 ** 3,
  minBytes = 50 * 1024,             // smaller than this is not a real video
  now = Date.now,
  log = () => {},
} = {}) {
  if (!dir) throw new Error("trailer cache: dir required");
  if (typeof download !== "function") throw new Error("trailer cache: download fn required");
  const tmpRoot = path.join(dir, ".tmp");
  fs.mkdirSync(tmpRoot, { recursive: true });
  // Leftovers from a crash mid-download are never complete: drop them.
  for (const f of safeReaddir(tmpRoot)) fs.rmSync(path.join(tmpRoot, f), { recursive: true, force: true });

  const fileFor = (key) => path.join(dir, `${key}.mp4`);
  const negative = new Map();       // key -> {at, ttl}
  const inflight = new Map();       // key -> Promise<path|null>
  const waiting = { high: [], low: [] };
  let active = 0;
  const stats = { hits: 0, downloads: 0, failures: 0, negativeHits: 0, evicted: 0 };

  function isNegative(key) {
    const n = negative.get(key);
    if (n === undefined) return false;
    if (now() - n.at < n.ttl) return true;
    negative.delete(key);
    return false;
  }
  function cachedPath(key) {
    const f = fileFor(key);
    try { return fs.statSync(f).isFile() ? f : null; } catch { return null; }
  }
  // Last use = mtime. Throttled so a file's mtime (and anything derived
  // from it) does not change on every request.
  function touch(f, force = false) {
    try {
      if (!force && now() - fs.statSync(f).mtimeMs < touchEveryMs) return;
      const t = new Date(now());
      fs.utimesSync(f, t, t);
    } catch { /* best effort */ }
  }

  function acquire(priority) {
    if (active < concurrency) { active++; return Promise.resolve(); }
    return new Promise((resolve) => waiting[priority === "low" ? "low" : "high"].push(resolve));
  }
  function release() {
    const next = waiting.high.shift() || waiting.low.shift();
    if (next) next(); else active--;
  }

  async function fetchOne(key, priority) {
    await acquire(priority);
    const tmpDir = path.join(tmpRoot, `${key}-${crypto.randomBytes(4).toString("hex")}`);
    const t0 = now();
    try {
      // Another caller may have finished it while we queued.
      const already = cachedPath(key);
      if (already) return already;
      fs.mkdirSync(tmpDir, { recursive: true });
      // Backstop: if the downloader never settles, give the slot back anyway.
      let backstop;
      const out = await Promise.race([
        download(key, tmpDir, { timeoutMs }),
        new Promise((_, rej) => { backstop = setTimeout(() => rej(new Error("timed out (backstop)")), timeoutMs + backstopMs); }),
      ]).finally(() => clearTimeout(backstop));
      const st = out ? fs.statSync(out) : null;
      if (!st || !st.isFile() || st.size < minBytes) throw new Error(`no usable output${st ? ` (${st.size} B)` : ""}`);
      const dest = fileFor(key);
      fs.renameSync(out, dest);
      touch(dest, true);
      stats.downloads++;
      log(`[trailer] ${key} cached (${(st.size / 1048576).toFixed(1)} MB, ${((now() - t0) / 1000).toFixed(1)}s, ${priority})`);
      negative.delete(key);
      setImmediate(() => { try { evict(); } catch (e) { log(`[trailer] evict failed: ${e.message}`); } });
      return dest;
    } catch (e) {
      stats.failures++;
      const msg = String(e && e.message || e);
      negative.set(key, { at: now(), ttl: /timed out/i.test(msg) ? timeoutNegTtlMs : negTtlMs });
      if (negative.size > 5000) negative.delete(negative.keys().next().value);
      log(`[trailer] ${key} unavailable (${String(e && e.message || e).slice(0, 200)})`);
      return null;
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
      release();
    }
  }

  async function ensure(key, { priority = "high" } = {}) {
    if (!isValidTrailerKey(key)) return null;
    const hit = cachedPath(key);
    if (hit) { stats.hits++; touch(hit); return hit; }
    if (isNegative(key)) { stats.negativeHits++; return null; }
    const running = inflight.get(key);
    if (running) return running;
    const p = fetchOne(key, priority).finally(() => inflight.delete(key));
    inflight.set(key, p);
    return p;
  }

  function evict() {
    const files = [];
    let total = 0;
    for (const name of safeReaddir(dir)) {
      if (!name.endsWith(".mp4")) continue;
      const f = path.join(dir, name);
      let st;
      try { st = fs.statSync(f); } catch { continue; }
      if (!st.isFile()) continue;
      files.push({ f, size: st.size, used: st.mtimeMs });
      total += st.size;
    }
    files.sort((a, b) => a.used - b.used); // least recently used first
    let removed = 0;
    for (const x of files) {
      const stale = now() - x.used > ttlMs;
      if (!stale && total <= maxBytes) break;
      try { fs.rmSync(x.f, { force: true }); total -= x.size; removed++; } catch { /* ignore */ }
    }
    stats.evicted += removed;
    return { removed, totalBytes: total, files: files.length - removed };
  }

  return {
    ensure,
    evict,
    has: (key) => isValidTrailerKey(key) && !!cachedPath(key),
    isNegative,
    // Forget all failures (e.g. after yt-dlp was updated).
    clearNegative: () => { const n = negative.size; negative.clear(); return n; },
    busy: () => active > 0,
    stats: () => ({ ...stats, active, queued: waiting.high.length + waiting.low.length, negative: negative.size }),
  };
}

function safeReaddir(d) { try { return fs.readdirSync(d); } catch { return []; } }

// yt-dlp format: 720p H.264 video + AAC merged into mp4 (ffmpeg), else the
// best single pre-muxed mp4 <=720p (YouTube's 360p "18"), else anything <=720p
// remuxed to mp4.
const YTDLP_FORMAT = "bv*[height<=720][vcodec^=avc1]+ba[ext=m4a]/b[height<=720][ext=mp4]/b[height<=720]";
function ytDlpArgs(key) {
  return [
    "--ignore-config", "--no-playlist", "--no-progress", "--no-warnings", "--quiet",
    "--js-runtimes", "node",
    "-f", YTDLP_FORMAT,
    "--merge-output-format", "mp4", "--remux-video", "mp4",
    "--max-filesize", "300M",
    "--socket-timeout", "15",
    // moov atom first so playback starts before the whole file is read
    "--postprocessor-args", "ffmpeg:-movflags +faststart",
    "--no-mtime",
    "-o", "%(id)s.%(ext)s",
    "--", `https://www.youtube.com/watch?v=${key}`,
  ];
}

// yt-dlp gets a minimal environment: never the server's secrets.
function ytDlpEnv(tmpDir, src = process.env) {
  const env = {
    PATH: src.PATH || "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin",
    HOME: src.HOME || "/tmp",
    XDG_CACHE_HOME: path.join(tmpDir, "..", ".cache"),
  };
  if (src.LANG) env.LANG = src.LANG;
  return env;
}

// Real downloader: spawns yt-dlp in tmpDir with a hard timeout. `bin` is a
// function so a self-updated binary is picked up without a restart.
function makeYtDlpDownloader({ bin, spawnFn = spawn, onError = () => {} } = {}) {
  return (key, tmpDir, { timeoutMs }) => new Promise((resolve, reject) => {
    if (!isValidTrailerKey(key)) return reject(new Error("bad key"));
    let err = "";
    const child = spawnFn(typeof bin === "function" ? bin() : bin, ytDlpArgs(key), {
      cwd: tmpDir, stdio: ["ignore", "ignore", "pipe"],
      // Own process group so a timeout also kills yt-dlp's ffmpeg children
      // (they would otherwise hold the stderr pipe open past the kill).
      detached: true,
      env: ytDlpEnv(tmpDir),
    });
    const timer = setTimeout(() => {
      err += " timed out";
      try { process.kill(-child.pid, "SIGKILL"); } catch { try { child.kill("SIGKILL"); } catch {} }
    }, timeoutMs);
    child.stderr.on("data", (d) => { if (err.length < 4000) err += d.toString(); });
    child.on("error", (e) => { clearTimeout(timer); onError(e.message); reject(e); });
    child.on("close", (code) => {
      clearTimeout(timer);
      const mp4 = safeReaddir(tmpDir).find((f) => f.endsWith(".mp4") && !/\.f\d+\.mp4$/.test(f));
      if (code === 0 && mp4) return resolve(path.join(tmpDir, mp4));
      const msg = `yt-dlp exit ${code}: ${err.trim().split("\n").slice(-2).join(" | ")}`;
      onError(msg);
      reject(new Error(msg));
    });
  });
}

// Express handler for GET /api/trailer/:key.mp4. Cached -> sendFile (Range,
// 200/206, video/mp4). Not cached -> download now (shared with concurrent
// requests for the same key), then serve. Failure -> 404 trailer_unavailable
// (fast on a negative-cache hit). `available()` false and nothing cached ->
// 404 without trying (yt-dlp missing).
// `allowKey(key, req)` false -> 404 without downloading (only keys that are
// a TMDB trailer of a title the profile may see). HEAD never downloads: it
// answers from the cache state. ETag is stable per (key, size), so If-Range /
// If-None-Match keep working although the file's mtime tracks last use.
function trailerRouteHandler({ cache, available = () => true, allowKey = () => true }) {
  return async (req, res) => {
    const key = req.params.key;
    if (!isValidTrailerKey(key)) return res.status(400).json({ error: "bad_key" });
    const unavailable = () => {
      if (!res.headersSent) res.status(404).set("Cache-Control", "no-store").json({ error: "trailer_unavailable" });
    };
    let allowed = false;
    try { allowed = !!allowKey(key, req); } catch { allowed = false; }
    if (!allowed) return unavailable();
    if (!cache.has(key) && (req.method === "HEAD" || !available())) return unavailable();
    const file = await cache.ensure(key, { priority: "high" });
    if (!file) return unavailable();
    let size;
    try { size = fs.statSync(file).size; } catch { return unavailable(); }
    res.sendFile(file, {
      acceptRanges: true, lastModified: false, etag: false, dotfiles: "allow",
      headers: { "Content-Type": "video/mp4", "Cache-Control": "private, max-age=86400", "ETag": `"${key}-${size}"` },
    }, (err) => { if (err && !res.headersSent) unavailable(); });
  };
}

// Pick the newest of several yt-dlp binaries by `--version` (YYYY.MM.DD
// strings compare lexically). Missing/broken binaries are skipped.
function newestVersion(candidates) {
  let best = null;
  for (const c of candidates) {
    if (!c || !c.version) continue;
    if (!best || c.version > best.version) best = c;
  }
  return best;
}

module.exports = { createTrailerCache, isValidTrailerKey, trailerRouteHandler, ytDlpEnv, makeYtDlpDownloader, ytDlpArgs, newestVersion, YTDLP_FORMAT };
