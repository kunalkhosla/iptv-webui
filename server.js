const express = require("express");
const path = require("path");
const fs = require("fs");
const os = require("os");
const crypto = require("crypto");
const { spawn } = require("child_process");
const { Readable } = require("stream");

const PROXY_SECRET = process.env.PROXY_SECRET || crypto.randomBytes(32).toString("hex");
function signProxyUrl(direct) {
  const sig = crypto.createHmac("sha256", PROXY_SECRET).update(direct).digest("hex").slice(0, 16);
  return `/api/proxy?u=${encodeURIComponent(direct)}&s=${sig}`;
}
function verifyProxySig(direct, sig) {
  if (!sig) return false;
  const expected = crypto.createHmac("sha256", PROXY_SECRET).update(direct).digest("hex").slice(0, 16);
  return sig === expected;
}

const {
  APP_USER,
  APP_PASS,
  TMDB_API_KEY,
  PORT = 3000,
} = process.env;

// Panel credentials: try disk first (data/panel-config.json), fall
// back to env. On first boot when the disk file is absent, env values
// get auto-seeded onto disk so the user can subsequently wipe their
// env file and edit creds entirely from the UI. Variables are
// mutable so the /api/panel/config PUT endpoint can apply a live
// change without restarting the process.
let IPTV_HOST, IPTV_HOST_FALLBACK, IPTV_USER, IPTV_PASS;
let PANEL_PRIMARY, PANEL_FALLBACKS, PANEL_CANDIDATES, PANEL;
const panelConfigFile = path.join(process.env.DATA_DIR || path.join(__dirname, "data"), "panel-config.json");

// Symmetric encryption for the panel-config file at rest. AES-256-GCM
// with a key derived from PROXY_SECRET via scrypt. This protects
// against:
//   - data-dir leaks (backups, snapshots, accidentally-committed dirs)
//   - someone with read access to data/ but not the running process
// It does NOT protect against:
//   - a fully-compromised server (the key is derivable from env)
//   - PROXY_SECRET rotation — old ciphertext becomes unreadable. The
//     reader logs a clear error in that case and falls back to env.
//
// File shape (v1): { v:1, iv:<hex>, tag:<hex>, data:<base64 cipher> }
// Old plaintext files (no `v` field) are still read, then re-encrypted
// on the next write — automatic migration with zero user action.
const PANEL_CONFIG_KEY = (() => {
  // PROXY_SECRET is the only stable per-install secret we have. If a
  // user runs the default random-per-process secret, encryption keys
  // change every restart and ciphertext becomes unreadable — they'd
  // need to re-enter creds via the UI after every reboot. That's a
  // worse UX than the current plaintext-on-disk setup. Refuse to
  // encrypt in that case (boot warning) and persist plaintext instead.
  if (!process.env.PROXY_SECRET) return null;
  return crypto.scryptSync(process.env.PROXY_SECRET, "khouch-panel-config", 32);
})();

function encryptPanelConfig(obj) {
  if (!PANEL_CONFIG_KEY) return { plaintext: obj }; // fallback marker
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", PANEL_CONFIG_KEY, iv);
  const data = Buffer.concat([cipher.update(JSON.stringify(obj), "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return {
    v: 1,
    iv: iv.toString("hex"),
    tag: tag.toString("hex"),
    data: data.toString("base64"),
  };
}
function decryptPanelConfig(env) {
  if (!env || env.v !== 1) return null;
  if (!PANEL_CONFIG_KEY) {
    console.warn("[panel] panel-config is encrypted but PROXY_SECRET is not set — cannot decrypt; falling back to env");
    return null;
  }
  try {
    const iv = Buffer.from(env.iv, "hex");
    const tag = Buffer.from(env.tag, "hex");
    const cipher = crypto.createDecipheriv("aes-256-gcm", PANEL_CONFIG_KEY, iv);
    cipher.setAuthTag(tag);
    const data = Buffer.concat([cipher.update(Buffer.from(env.data, "base64")), cipher.final()]);
    return JSON.parse(data.toString("utf8"));
  } catch (e) {
    console.warn(`[panel] panel-config decrypt failed (${e.message}); falling back to env. Did PROXY_SECRET change?`);
    return null;
  }
}

function readPanelConfigFromDisk() {
  try {
    const raw = fs.readFileSync(panelConfigFile, "utf8");
    const d = JSON.parse(raw);
    if (d && d.v === 1) return decryptPanelConfig(d);
    // Legacy plaintext file. Accept once; the next write will encrypt.
    return d && typeof d === "object" ? d : null;
  } catch { return null; }
}
function writePanelConfigToDisk(cfg) {
  try {
    fs.mkdirSync(path.dirname(panelConfigFile), { recursive: true });
    const wrapped = encryptPanelConfig(cfg);
    const onDisk = wrapped.plaintext ? wrapped.plaintext : wrapped;
    // Ownership-only read perms so even a casual disk peek requires
    // the same access the running server already has.
    fs.writeFileSync(panelConfigFile + ".tmp", JSON.stringify(onDisk), { mode: 0o600 });
    fs.renameSync(panelConfigFile + ".tmp", panelConfigFile);
  } catch (e) {
    console.warn(`save panel-config failed: ${e.message}`);
  }
}
function recomputePanelDerived() {
  PANEL_PRIMARY = IPTV_HOST ? IPTV_HOST.replace(/\/$/, "") : null;
  PANEL_FALLBACKS = (IPTV_HOST_FALLBACK || "")
    .split(",").map(s => s.trim().replace(/\/$/, "")).filter(Boolean);
  PANEL_CANDIDATES = [PANEL_PRIMARY, ...PANEL_FALLBACKS].filter(Boolean);
  if (!PANEL || !PANEL_CANDIDATES.includes(PANEL)) PANEL = PANEL_PRIMARY;
}
function loadInitialPanelConfig() {
  const disk = readPanelConfigFromDisk();
  IPTV_HOST          = (disk && disk.host)         || process.env.IPTV_HOST          || null;
  IPTV_HOST_FALLBACK = (disk && disk.hostFallback) || process.env.IPTV_HOST_FALLBACK || "";
  IPTV_USER          = (disk && disk.user)         || process.env.IPTV_USER          || null;
  IPTV_PASS          = (disk && disk.pass)         || process.env.IPTV_PASS          || null;
  // Migration: if no disk config existed but env had everything, seed
  // it so the user can drop the env file afterward.
  if (!disk && IPTV_HOST && IPTV_USER && IPTV_PASS) {
    writePanelConfigToDisk({
      host: IPTV_HOST, hostFallback: IPTV_HOST_FALLBACK,
      user: IPTV_USER, pass: IPTV_PASS,
    });
    console.log("[panel] seeded data/panel-config.json from env vars (one-time migration)");
  }
  recomputePanelDerived();
}
loadInitialPanelConfig();

for (const [k, v] of Object.entries({ IPTV_HOST, IPTV_USER, IPTV_PASS, APP_USER, APP_PASS })) {
  if (!v) {
    console.error(`Missing required value (env or data/panel-config.json): ${k}`);
    process.exit(1);
  }
}

// Probe a panel host for auth+health. Defaults to the currently-
// configured creds so the existing callers (boot, periodic refresh,
// manual host switch) stay one-arg; the /api/panel/config validation
// endpoint passes proposed user/pass to test a config change before
// committing it.
async function probePanel(host, user = IPTV_USER, pass = IPTV_PASS) {
  const url = `${host}/player_api.php?username=${encodeURIComponent(user)}&password=${encodeURIComponent(pass)}`;
  try {
    const res = await fetch(url, {
      headers: {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
        "Accept": "application/json",
      },
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) return { ok: false, reason: `HTTP ${res.status}` };
    const data = await res.json().catch(() => null);
    if (!data?.user_info) return { ok: false, reason: "no user_info" };
    if (Number(data.user_info.auth) !== 1) return { ok: false, reason: "auth=0" };
    return { ok: true, account: data };
  } catch (e) {
    return { ok: false, reason: e.message };
  }
}

async function pickPanel() {
  for (const host of PANEL_CANDIDATES) {
    const r = await probePanel(host);
    if (r.ok) {
      if (PANEL !== host) {
        console.log(`switched panel: ${PANEL} → ${host}`);
        cache.clear();
        for (const ix of Object.values(indexes)) ix.ready = false;
      }
      PANEL = host;
      return { active: host, reason: "ok" };
    }
    console.warn(`panel probe failed for ${host}: ${r.reason}`);
  }
  console.error("all panels failed; staying on", PANEL);
  return { active: PANEL, reason: "all-failed" };
}

async function switchToHost(host) {
  if (!PANEL_CANDIDATES.includes(host)) return { active: PANEL, reason: "unknown-host" };
  if (host === PANEL) return { active: PANEL, reason: "already-active" };
  const r = await probePanel(host);
  if (!r.ok) return { active: PANEL, reason: `unhealthy: ${r.reason}` };
  console.log(`manual switch: ${PANEL} → ${host}`);
  PANEL = host;
  cache.clear();
  await clearDiskIndexes();
  for (const ix of Object.values(indexes)) {
    ix.ready = false;
    ix.byId = new Map();
    ix.done = 0;
    ix.total = 0;
  }
  buildAllIndexes();
  return { active: PANEL, reason: "ok" };
}

const MODES = {
  live: {
    cats: "get_live_categories",
    list: "get_live_streams",
    pathSeg: "live",
    defaultExt: "m3u8",
  },
  movie: {
    cats: "get_vod_categories",
    list: "get_vod_streams",
    info: "get_vod_info",
    pathSeg: "movie",
  },
  series: {
    cats: "get_series_categories",
    list: "get_series",
    info: "get_series_info",
    pathSeg: "series",
  },
};

const cache = new Map();
const TTL_MS = 24 * 60 * 60 * 1000;
const inflight = new Map();

const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, "data");
fs.mkdirSync(DATA_DIR, { recursive: true });
const indexFilePath = (mode) => path.join(DATA_DIR, `index-${mode}.json`);
const categoriesFilePath = (mode) => path.join(DATA_DIR, `categories-${mode}.json`);

// Serialize concurrent saves per-mode. Two callers (buildIndex and the
// /api/bootstrap pickCats path) can fire saveCategoriesToDisk for the
// same mode within the same millisecond on a cold boot, racing on the
// shared `.tmp` filename and leaving one rename to ENOENT-fail. Queue
// per-mode so writes happen back-to-back.
const _categorySaveInflight = new Map(); // mode → Promise
async function saveCategoriesToDisk(mode, cats) {
  if (!Array.isArray(cats) || !cats.length) return;
  const prev = _categorySaveInflight.get(mode) || Promise.resolve();
  const p = prev.then(async () => {
    try {
      await fs.promises.writeFile(categoriesFilePath(mode) + ".tmp", JSON.stringify(cats));
      await fs.promises.rename(categoriesFilePath(mode) + ".tmp", categoriesFilePath(mode));
    } catch (e) {
      // ENOENT-on-rename means a concurrent writer beat us and the
      // file IS in place — harmless. Anything else is real (perms,
      // disk full, etc.) and worth logging.
      if (e.code !== "ENOENT") {
        console.warn(`[${mode}] save categories failed: ${e.message}`);
      }
    }
  });
  _categorySaveInflight.set(mode, p);
  return p;
}

function loadCategoriesFromDiskSync(mode) {
  try {
    const raw = fs.readFileSync(categoriesFilePath(mode), "utf8");
    const data = JSON.parse(raw);
    return Array.isArray(data) ? data : [];
  } catch { return []; }
}

const lastPlayedFile = path.join(DATA_DIR, "last-played.json");
const lastPlayed = (() => {
  try {
    const raw = fs.readFileSync(lastPlayedFile, "utf8");
    const d = JSON.parse(raw);
    return {
      live: d.live && typeof d.live === "object" ? d.live : {},
      movie: d.movie && typeof d.movie === "object" ? d.movie : {},
      series: d.series && typeof d.series === "object" ? d.series : {},
    };
  } catch { return { live: {}, movie: {}, series: {} }; }
})();
let lastPlayedSaveTimer = null;
function scheduleLastPlayedSave() {
  if (lastPlayedSaveTimer) return;
  // Debounce so a burst of play events writes the file once.
  lastPlayedSaveTimer = setTimeout(async () => {
    lastPlayedSaveTimer = null;
    try {
      await fs.promises.writeFile(lastPlayedFile + ".tmp", JSON.stringify(lastPlayed));
      await fs.promises.rename(lastPlayedFile + ".tmp", lastPlayedFile);
    } catch (e) {
      console.warn(`save last-played failed: ${e.message}`);
    }
  }, 500);
}
function recordLastPlayed(mode, id, ts = Date.now()) {
  if (!lastPlayed[mode]) return;
  lastPlayed[mode][String(id)] = ts;
  scheduleLastPlayedSave();
}

// --- TMDB poster + metadata cache -------------------------------------
// On-disk cache keyed by `${mode}:${id}` for primary movie/series
// lookups, and `series-season:${id}:${n}` for episode-still maps.
// Positive entries persist forever (TMDB posters rarely change).
// Negative ("no-match") entries get re-checked after 7 days. The
// shorter TTL is supported by a separate nightly retry cron (see
// scheduleTmdbRetry below) — between the cron and the TTL-driven
// retry inside prewarmTmdbCache, no-match entries recover faster.
const TMDB_NEGATIVE_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const TMDB_IMG_BASE = "https://image.tmdb.org/t/p";
const tmdbCacheFile = path.join(DATA_DIR, "tmdb-cache.json");
const tmdbCache = (() => {
  try {
    const raw = fs.readFileSync(tmdbCacheFile, "utf8");
    const d = JSON.parse(raw);
    return d && typeof d === "object" ? d : {};
  } catch { return {}; }
})();
let tmdbCacheSaveTimer = null;
function scheduleTmdbCacheSave() {
  if (tmdbCacheSaveTimer) return;
  tmdbCacheSaveTimer = setTimeout(async () => {
    tmdbCacheSaveTimer = null;
    try {
      await fs.promises.writeFile(tmdbCacheFile + ".tmp", JSON.stringify(tmdbCache));
      await fs.promises.rename(tmdbCacheFile + ".tmp", tmdbCacheFile);
    } catch (e) {
      console.warn(`save tmdb-cache failed: ${e.message}`);
    }
  }, 500);
}

// ──────────────────────────────────────────────────────────────────
// Real-4K cache. Panels routinely label a movie "(4K)" in the title /
// category even when the actual file is 1080p or — observed — a 600x900
// JPEG poster. get_vod_info exposes real resolution via info.video.
// {width,height}. We verify items currently tagged "4k" once and
// demote the tag when actual resolution is sub-4K. Persisted to disk
// so we don't re-probe on every boot.
//
// Cache shape: { "movie:<id>": { w, h, codec, bitrate, is4k, checked_at } }
// Definition: is4k = (height >= 2000) || (width >= 3200). Covers 16:9
// UHD (3840x2160), 2.4:1 cinema (3840x1600), ultra-wide 4K-class
// (3940x816), etc. Excludes 1080p HEVC and poster-only entries.
const QUALITY_CACHE_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30d re-check
const qualityCacheFile = path.join(DATA_DIR, "quality-cache.json");
const qualityCache = (() => {
  try {
    const raw = fs.readFileSync(qualityCacheFile, "utf8");
    const d = JSON.parse(raw);
    return d && typeof d === "object" ? d : {};
  } catch { return {}; }
})();
let qualityCacheSaveTimer = null;
function scheduleQualityCacheSave() {
  if (qualityCacheSaveTimer) return;
  qualityCacheSaveTimer = setTimeout(async () => {
    qualityCacheSaveTimer = null;
    try {
      await fs.promises.writeFile(qualityCacheFile + ".tmp", JSON.stringify(qualityCache));
      await fs.promises.rename(qualityCacheFile + ".tmp", qualityCacheFile);
    } catch (e) {
      console.warn(`save quality-cache failed: ${e.message}`);
    }
  }, 500);
}
// Audio codec cache for live channels. Sports panels routinely ship
// MP2 / AC3 / E-AC3 audio with H.264 video — the video parses cleanly
// in hls.js but MSE can't decode the audio, leaving the user with a
// silent black-box player. ffprobe the first segment once per channel,
// remember the verdict, and when the audio codec is browser-unsafe
// hand the client the transcode URL up front (no manifest-load-then-
// fail-then-retry round-trip).
const audioCodecCacheFile = path.join(DATA_DIR, "audio-codec-cache.json");
const audioCodecCache = (() => {
  try {
    const raw = fs.readFileSync(audioCodecCacheFile, "utf8");
    const d = JSON.parse(raw);
    return d && typeof d === "object" ? d : {};
  } catch { return {}; }
})();
let audioCodecCacheSaveTimer = null;
function scheduleAudioCodecCacheSave() {
  if (audioCodecCacheSaveTimer) return;
  audioCodecCacheSaveTimer = setTimeout(async () => {
    audioCodecCacheSaveTimer = null;
    try {
      await fs.promises.writeFile(audioCodecCacheFile + ".tmp", JSON.stringify(audioCodecCache));
      await fs.promises.rename(audioCodecCacheFile + ".tmp", audioCodecCacheFile);
    } catch (e) {
      console.warn(`save audio-codec-cache failed: ${e.message}`);
    }
  }, 500);
}
// Codecs MSE cannot decode (or hls.js silently mis-routes through an
// incompatible decoder). Anything in this set forces a transcode.
const BROWSER_UNSAFE_AUDIO = new Set([
  "mp1", "mp2", "ac3", "eac3", "dts", "dca", "truehd", "pcm_s16le", "pcm_s24le",
]);
// Alive verdicts are stable (codecs don't change for a given channel)
// so we keep them for a week. Dead verdicts can flip back the moment
// the panel rotates CDN hosts or frees a slot, so we re-probe much
// more often — a permanent "off-air" marker on a channel that's
// since come back would be worse than a brief stale-marker window.
const PROBE_ALIVE_TTL_MS = 7 * 24 * 60 * 60 * 1000;
// Dead TTL is short because IPTV panels rotate CDN hosts every few
// minutes — a channel that 403'd 5 min ago is often back. We retry
// inside the probe before marking dead, so a confirmed-dead verdict
// is already "3 consecutive fails", which justifies caching it for
// a few minutes rather than re-probing every refresh.
const PROBE_DEAD_TTL_MS  = 5 * 60 * 1000;
function isProbeFresh(entry) {
  if (!entry || typeof entry.ts !== "number") return false;
  const ttl = entry.dead ? PROBE_DEAD_TTL_MS : PROBE_ALIVE_TTL_MS;
  return Date.now() - entry.ts < ttl;
}
const audioProbeInflight = new Map();
// Manifest liveness check — short GET with redirect follow. Catches
// the panel-side 403 / 404 / "empty body" failure modes BEFORE we
// pay 1s of ffprobe runtime on a dead channel.
async function _probeManifestOnce(direct) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 3500);
  try {
    const r = await fetch(direct, {
      method: "GET",
      redirect: "follow",
      headers: { "User-Agent": "Mozilla/5.0 (Linux; Android 12; Smart TV) AppleWebKit/537.36" },
      signal: controller.signal,
    });
    if (!r.ok) return { alive: false, reason: `http-${r.status}` };
    const text = await r.text();
    if (!text || text.length < 20 || !text.includes("#EXTM3U")) {
      return { alive: false, reason: "empty-manifest" };
    }
    return { alive: true };
  } catch (e) {
    return { alive: false, reason: e?.name === "AbortError" ? "timeout" : "fetch-error" };
  } finally {
    clearTimeout(timer);
  }
}
// Panels flap. A single 403 / timeout from the upstream CDN host is
// not enough to call a channel dead — Cloudflare's anti-abuse layer
// hands those out under load, and the panel's max_connections=1 cap
// throws them when another session displaces the probe slot. Three
// consecutive misses with a small gap is the threshold: a genuinely
// off-air channel keeps failing, a flap recovers on attempt 2 or 3.
async function probeManifestLiveness(direct) {
  let lastReason = "unknown";
  for (let attempt = 0; attempt < 3; attempt++) {
    if (attempt > 0) await new Promise(r => setTimeout(r, 600));
    const v = await _probeManifestOnce(direct);
    if (v.alive) return v;
    lastReason = v.reason;
  }
  return { alive: false, reason: lastReason };
}
function probeChannelAudioCodec(mode, id) {
  const key = `${mode}:${id}`;
  if (audioProbeInflight.has(key)) return audioProbeInflight.get(key);
  const direct = streamUrl(mode, id, "m3u8");
  const p = (async () => {
    // First: is the channel even responding? A dead panel host
    // means ffprobe would just block until our 6s timeout — wasteful
    // and starves the parallel-probe queue. Cheap manifest fetch
    // first; ffprobe only runs on confirmed-alive channels.
    const live = await probeManifestLiveness(direct);
    if (!live.alive) {
      const entry = {
        audio_codec: null,
        browser_safe: false,
        dead: true,
        dead_reason: live.reason,
        ts: Date.now(),
      };
      audioCodecCache[key] = entry;
      scheduleAudioCodecCacheSave();
      audioProbeInflight.delete(key);
      return entry;
    }
    return new Promise((resolve) => {
      const args = [
        "-v", "error",
        "-user_agent", "Mozilla/5.0 (Linux; Android 12; Smart TV) AppleWebKit/537.36",
        "-select_streams", "a:0",
        "-show_entries", "stream=codec_name",
        "-of", "default=noprint_wrappers=1:nokey=1",
        "-read_intervals", "%+1",
        direct,
      ];
      const proc = spawn("ffprobe", args);
      let buf = "";
      proc.stdout.on("data", d => { buf += d.toString(); });
      proc.stderr.on("data", () => {});
      const killTimer = setTimeout(() => { try { proc.kill("SIGKILL"); } catch {} }, 6000);
      proc.on("close", () => {
        clearTimeout(killTimer);
        const codec = (buf.trim().split("\n")[0] || "").trim().toLowerCase();
        const entry = {
          audio_codec: codec || null,
          browser_safe: !!codec && !BROWSER_UNSAFE_AUDIO.has(codec),
          dead: false,
          ts: Date.now(),
        };
        // Don't cache failed probes — let the next request retry.
        if (codec) {
          audioCodecCache[key] = entry;
          scheduleAudioCodecCacheSave();
        }
        audioProbeInflight.delete(key);
        resolve(entry);
      });
    });
  })();
  audioProbeInflight.set(key, p);
  return p;
}

function classifyAs4k(width, height) {
  const w = Number(width) || 0;
  const h = Number(height) || 0;
  return h >= 2000 || w >= 3200;
}

// Strip the "4k" tag when the quality cache has a verified "not 4k"
// verdict for this item. Pure — returns a possibly-new array, never
// mutates input. Only demotes (never promotes) so live and unverified
// items keep whatever the panel-name regex assigned.
function applyQualityDemotion(mode, id, tags) {
  if (mode !== "movie") return tags;
  if (!Array.isArray(tags) || !tags.includes("4k")) return tags;
  const v = qualityCache[`movie:${id}`];
  if (v && v.is4k === false) return tags.filter(t => t !== "4k");
  return tags;
}

// Verify a single movie's actual resolution from the panel. Returns
// the cached entry or null on transient panel failure (don't poison
// the cache on transient errors — try again next prewarm).
async function verifyQuality4k(movieId) {
  const key = `movie:${movieId}`;
  const cached = qualityCache[key];
  if (cached && (Date.now() - (cached.checked_at || 0)) < QUALITY_CACHE_TTL_MS) {
    return cached;
  }
  let info;
  try {
    info = await xtream(MODES.movie.info, { vod_id: movieId });
  } catch {
    return null;
  }
  const video = (info && info.info && info.info.video) || {};
  const w = Number(video.width) || 0;
  const h = Number(video.height) || 0;
  // Reject zero-dimension entries — they're "panel didn't ffprobe"
  // states that'd otherwise demote a possibly-real-4K title because
  // we can't see the resolution. Re-check on the next prewarm.
  if (!w && !h) return null;
  const entry = {
    w, h,
    codec: video.codec_name || null,
    bitrate: Number(info?.info?.bitrate) || null,
    is4k: classifyAs4k(w, h),
    checked_at: Date.now(),
  };
  qualityCache[key] = entry;
  scheduleQualityCacheSave();
  return entry;
}

// Background pass that walks every in-memory movie tagged "4k" and
// verifies it against the panel's video metadata. Demotes the in-
// memory s.tags directly when not real 4K so subsequent
// /api/index/{mode} emissions reflect the truth without a rebuild.
// Fires on boot + after each movie buildIndex completes. Skips
// series (per-episode resolution would need a separate per-season
// probe) and live (no API-level resolution metadata).
const QUALITY_PREWARM_CONCURRENCY = 3;
async function prewarmQualityCache() {
  const ix = indexes.movie;
  if (!ix?.ready) return;
  const candidates = [...ix.byId.values()].filter(s =>
    Array.isArray(s.tags) && s.tags.includes("4k")
  );
  if (!candidates.length) return;
  const startedAt = Date.now();
  console.log(`[quality] movie: verifying ${candidates.length} items tagged 4k`);
  let i = 0;
  let demoted = 0;
  let verified = 0;
  let failed = 0;
  await Promise.all(Array.from({ length: QUALITY_PREWARM_CONCURRENCY }, async () => {
    while (i < candidates.length) {
      const s = candidates[i++];
      const v = await verifyQuality4k(s.id).catch(() => null);
      if (!v) { failed++; continue; }
      verified++;
      if (v.is4k === false) {
        const idx = s.tags.indexOf("4k");
        if (idx >= 0) { s.tags.splice(idx, 1); demoted++; }
      }
    }
  }));
  console.log(`[quality] movie: verified ${verified}, demoted ${demoted}, failed ${failed} in ${((Date.now()-startedAt)/1000).toFixed(1)}s`);
}

// In-memory call cache + dedup, mirrors xtream(). 24h TTL — TMDB
// search results are stable enough.
const tmdbMemCache = new Map();
const tmdbInflight = new Map();
const TMDB_TTL_MS = 24 * 60 * 60 * 1000;
async function tmdb(action, params = {}) {
  if (!TMDB_API_KEY) return null;
  const qs = new URLSearchParams(params).toString();
  const key = action + (qs ? `?${qs}` : "");
  const hit = tmdbMemCache.get(key);
  if (hit && Date.now() - hit.t < TMDB_TTL_MS) return hit.v;
  if (tmdbInflight.has(key)) return tmdbInflight.get(key);
  const url = `https://api.themoviedb.org/3${action}${qs ? `?${qs}` : ""}`;
  const p = (async () => {
    for (let attempt = 0; attempt < 4; attempt++) {
      try {
        const res = await fetch(url, {
          headers: {
            "Authorization": `Bearer ${TMDB_API_KEY}`,
            "Accept": "application/json",
          },
          signal: AbortSignal.timeout(15_000),
        });
        if (res.status === 429) {
          const wait = Math.max(parseInt(res.headers.get("Retry-After") || "10", 10), 5) * 1000;
          console.warn(`tmdb ${action} → 429, retrying in ${wait / 1000}s`);
          await new Promise(r => setTimeout(r, wait));
          continue;
        }
        if (!res.ok) {
          console.warn(`tmdb ${action} → HTTP ${res.status}`);
          return null;
        }
        const v = await res.json();
        tmdbMemCache.set(key, { t: Date.now(), v });
        return v;
      } catch (e) {
        console.warn(`tmdb ${action} failed: ${e.message}`);
        return null;
      }
    }
    console.warn(`tmdb ${action} → gave up after repeated 429s`);
    return null;
  })().finally(() => tmdbInflight.delete(key));
  tmdbInflight.set(key, p);
  return p;
}

// Project a TMDB movie/tv detail response into the shape we cache and
// return to clients. Centralized so the /movie and /tv variants stay
// consistent.
// Pull a US-region certification out of TMDB's release_dates (movies)
// or content_ratings (TV) blocks. Falls back to "" if absent. We only
// look at US ratings — TMDB has per-country certs but US ones are the
// most consistently populated and the rating ladder is well-known
// (G, PG, PG-13, R, NC-17 / TV-Y, TV-Y7, TV-G, TV-PG, TV-14, TV-MA).
function extractUsCert(mode, detail) {
  if (!detail) return "";
  if (mode === "movie") {
    const rd = detail.release_dates;
    const us = rd && Array.isArray(rd.results) ? rd.results.find(r => r.iso_3166_1 === "US") : null;
    if (!us || !Array.isArray(us.release_dates)) return "";
    for (const r of us.release_dates) {
      if (r.certification && r.certification.trim()) return r.certification.trim();
    }
    return "";
  }
  // TV
  const cr = detail.content_ratings;
  const us = cr && Array.isArray(cr.results) ? cr.results.find(r => r.iso_3166_1 === "US") : null;
  return us && typeof us.rating === "string" ? us.rating.trim() : "";
}

function projectTmdbDetail(mode, detail, baseTitle) {
  if (!detail || !detail.id) return null;
  const isMovie = mode === "movie";
  const dateStr = isMovie ? detail.release_date : detail.first_air_date;

  // append_to_response payloads. Each is optional — older callers that
  // didn't request the append simply get an empty array / null.
  const credits = detail.credits || {};
  const cast = Array.isArray(credits.cast)
    ? credits.cast.slice(0, 10).map(c => ({
        name: c.name || "",
        character: c.character || "",
        profile_path: c.profile_path || null,
      })).filter(c => c.name)
    : [];
  // Director (movies) / Creator (TV). Some movies have multiple
  // directors (Coens, Wachowskis) so we return an array.
  const directors = (() => {
    const crew = Array.isArray(credits.crew) ? credits.crew : [];
    if (isMovie) {
      return crew.filter(c => c.job === "Director").map(c => c.name).filter(Boolean);
    }
    return Array.isArray(detail.created_by)
      ? detail.created_by.map(c => c.name).filter(Boolean)
      : [];
  })();

  // Trailer — first official YouTube "Trailer", else first Teaser,
  // else first YouTube video of any type. Stored as the YouTube key
  // so the client can embed via https://www.youtube.com/embed/<key>.
  const videos = (detail.videos && Array.isArray(detail.videos.results))
    ? detail.videos.results : [];
  const trailerKey = (() => {
    const ytOnly = videos.filter(v => v.site === "YouTube" && v.key);
    const off = ytOnly.find(v => v.official && v.type === "Trailer")
            || ytOnly.find(v => v.type === "Trailer")
            || ytOnly.find(v => v.type === "Teaser")
            || ytOnly[0];
    return off ? off.key : null;
  })();

  // Top 1-2 reviews — author + a clipped excerpt. Full review URLs
  // and content are too big for the cache; we keep what's useful for
  // an at-a-glance pull quote.
  const reviews = (detail.reviews && Array.isArray(detail.reviews.results))
    ? detail.reviews.results.slice(0, 2).map(r => ({
        author: r.author || "Anonymous",
        rating: r.author_details?.rating || null,
        excerpt: (r.content || "").slice(0, 400),
      }))
    : [];

  // Semantic tags. TMDB API names the inner array differently per
  // mode: `keywords` for movies, `results` for tv.
  const kwSrc = detail.keywords || {};
  const keywords = (kwSrc.keywords || kwSrc.results || [])
    .slice(0, 15)
    .map(k => k.name)
    .filter(Boolean);

  // Recommendations and similar — just store the tmdb_ids; the client
  // resolves them back to panel items via the existing index lookup
  // (tmdb_id → panel id). Top 20 per type.
  const recIds = (detail.recommendations && Array.isArray(detail.recommendations.results))
    ? detail.recommendations.results.slice(0, 20).map(r => r.id).filter(Boolean)
    : [];
  const similarIds = (detail.similar && Array.isArray(detail.similar.results))
    ? detail.similar.results.slice(0, 20).map(r => r.id).filter(Boolean)
    : [];

  // Franchise / saga membership. Marvel, Bond, MI, John Wick etc.
  // Only present for movies that TMDB has tagged into a collection.
  const collection = detail.belongs_to_collection ? {
    id:            detail.belongs_to_collection.id,
    name:          detail.belongs_to_collection.name,
    poster_path:   detail.belongs_to_collection.poster_path || null,
    backdrop_path: detail.belongs_to_collection.backdrop_path || null,
  } : null;

  return {
    tmdb_id: detail.id,
    tmdb_title: isMovie ? (detail.title || detail.original_title || baseTitle)
                        : (detail.name  || detail.original_name || baseTitle),
    poster_path:   detail.poster_path   || null,
    backdrop_path: detail.backdrop_path || null,
    plot:          detail.overview || null,
    year:          dateStr ? String(dateStr).slice(0, 4) : null,
    rating:        Number.isFinite(detail.vote_average) ? Number(detail.vote_average.toFixed(1)) : null,
    vote_count:    Number.isFinite(detail.vote_count) ? detail.vote_count : 0,
    popularity:    Number.isFinite(detail.popularity) ? Number(detail.popularity.toFixed(2)) : 0,
    runtime:       isMovie ? (Number.isFinite(detail.runtime) ? detail.runtime : null)
                           : (Array.isArray(detail.episode_run_time) && detail.episode_run_time[0]) || null,
    genres:        Array.isArray(detail.genres) ? detail.genres.map(g => g.name).filter(Boolean) : [],
    tagline:       detail.tagline || null,
    original_language: detail.original_language || null,
    imdb_id:       (detail.external_ids && detail.external_ids.imdb_id) || detail.imdb_id || null,
    // US-region content certification ("PG", "TV-MA", etc.). Used by
    // kids profiles to filter age-inappropriate content. Empty string
    // when TMDB has no rating for this title — kids profiles treat
    // unrated as "hide" by default.
    us_cert:       extractUsCert(mode, detail),
    collection,
    cast,
    directors,
    keywords,
    trailer_key:   trailerKey,
    reviews,
    recommendations: recIds,
    similar:       similarIds,
  };
}

// Public response shape (same fields, but URLs absolutized + flagged
// with source/timestamp metadata callers may want).
function tmdbToResponse(entry) {
  if (!entry) return null;
  // Resolve cast profile paths to absolute URLs at response time so
  // the client doesn't have to know about TMDB_IMG_BASE. w185 is the
  // right size for the ~96px-wide chip the detail page will render.
  const cast = Array.isArray(entry.cast) ? entry.cast.map(c => ({
    name: c.name,
    character: c.character,
    profile: c.profile_path ? `${TMDB_IMG_BASE}/w185${c.profile_path}` : null,
  })) : [];
  return {
    tmdb_id:     entry.tmdb_id || null,
    tmdb_title:  entry.tmdb_title || null,
    poster:      entry.poster_path   ? `${TMDB_IMG_BASE}/w500${entry.poster_path}`   : null,
    backdrop:    entry.backdrop_path ? `${TMDB_IMG_BASE}/w1280${entry.backdrop_path}` : null,
    plot:        entry.plot   || null,
    year:        entry.year   || null,
    rating:      entry.rating || null,
    vote_count:  entry.vote_count || 0,
    popularity:  entry.popularity || 0,
    runtime:     entry.runtime || null,
    genres:      entry.genres || [],
    tagline:     entry.tagline || null,
    original_language: entry.original_language || null,
    imdb_id:     entry.imdb_id || null,
    us_cert:     entry.us_cert || "",
    collection:  entry.collection || null,
    cast,
    directors:   entry.directors || [],
    keywords:    entry.keywords || [],
    trailer_key: entry.trailer_key || null,
    reviews:     entry.reviews || [],
    recommendations: entry.recommendations || [],
    similar:     entry.similar || [],
  };
}

// Find the best TMDB match for a panel-named title. Two-pass: search,
// then full detail fetch to populate runtime/genres/etc.
// Strip panel cruft from a title so TMDB's search relevance scorer
// gets a clean query. Handles in priority order:
//   • trailing year ("(2024)", " 2024.", ".2024")
//   • bracketed quality / language / release tags
//   • dot-separated filename style ("Drive-Away.Dolls" → "Drive-Away Dolls")
//   • trailing single dots / leftover dashes
//   • collapsed whitespace
// Tried in two passes — strict (drop everything after the first
// year), then loose (just normalize separators) — so findTmdbMatch
// can retry if the first pass yields no hits.
function cleanPanelTitle(name, opts = {}) {
  let s = String(name || "");
  // Drop everything after first year-in-parens
  if (opts.strict !== false) {
    s = s.replace(/\((\d{4})\).*$/, "");
  }
  // Strip bracketed tags + commonly-appended quality words
  s = s.replace(/\[[^\]]*\]/g, " ")
       .replace(/\((Hindi|Tamil|Telugu|Malayalam|Kannada|Bengali|Gujarati|Marathi|Punjabi|Urdu|Dubbed|Sub|Subs|Subbed|Multi|Dual|DVD|BluRay|HDR|HEVC|x264|x265|HEVC10)\)/gi, " ")
       .replace(/\b(4K|FHD|UHD|HD|SD|CAM|HDRIP|DVDRIP|BLURAY|WEBRIP|WEBDL|WEB-DL|2160P|1080P|720P|480P|HDR|HEVC|x264|x265|DUAL|MULTI|DUBBED|SUB|SUBS)\b/gi, " ");
  // Dot-separated filename style → spaces (but preserve final ".0" decimals)
  s = s.replace(/\.(?=\D)/g, " ");
  // Trailing standalone year ("Title 1985") — strip when the year is
  // not part of the title proper. We pass year separately to TMDB so
  // the year-in-name is redundant noise.
  s = s.replace(/\s+(19|20)\d{2}\s*$/, "");
  // Tidy
  s = s.replace(/\s+/g, " ").replace(/^[-\s.]+|[-\s.]+$/g, "").trim();
  return s;
}

async function findTmdbMatch(mode, name, hintYear) {
  const action = mode === "movie" ? "/search/movie" : "/search/tv";
  // Try the strict cleanup first; if it returns nothing, fall back to
  // a looser one. Many panel titles use ".Title.YYYY" style filenames
  // that the strict pass leaves as garbage; the loose pass collapses
  // dot-separators into spaces and tries again.
  for (const strict of [true, false]) {
    const cleaned = cleanPanelTitle(name, { strict });
    if (!cleaned) continue;
    const params = { query: cleaned };
    const yearStr = hintYear ? String(hintYear).slice(0, 4) : null;
    if (yearStr && /^\d{4}$/.test(yearStr)) {
      params[mode === "movie" ? "year" : "first_air_date_year"] = yearStr;
    }
    const searchRes = await tmdb(action, params);
    const results = searchRes && Array.isArray(searchRes.results) ? searchRes.results : [];
    if (!results.length) continue;
    // Fetch the full detail for the top result so runtime/genres etc.
    // populate. append_to_response folds certification + credits +
    // videos + reviews + keywords + recommendations + similar +
    // external_ids (imdb_id) into the same call — TMDB allows up to
    // 20 appends per request, and one call vs eight is the difference
    // between catalog backfill taking 2 hours vs all night.
    const top = results[0];
    const detailAction = mode === "movie" ? `/movie/${top.id}` : `/tv/${top.id}`;
    const detail = await tmdb(detailAction, { append_to_response: TMDB_DETAIL_APPENDS(mode) });
    return projectTmdbDetail(mode, detail || top, cleaned);
  }
  return null;
}

// All the append_to_response payloads we want bundled into the base
// detail call. Cert is mode-specific (movies use release_dates,
// TV uses content_ratings); everything else is the same shape on
// both endpoints, so we can share one comma-joined string.
const TMDB_DETAIL_APPENDS = (mode) => {
  const cert = mode === "movie" ? "release_dates" : "content_ratings";
  return [
    cert,
    "credits",
    "videos",
    "reviews",
    "keywords",
    "recommendations",
    "similar",
    "external_ids",
  ].join(",");
};

// Re-fetch TMDB detail for an already-matched item by tmdb_id. Used
// to backfill new fields on old cache entries without re-running the
// search step. Returns the projected entry, or null on failure.
async function refetchTmdbDetail(mode, tmdbId) {
  const detailAction = mode === "movie" ? `/movie/${tmdbId}` : `/tv/${tmdbId}`;
  const detail = await tmdb(detailAction, { append_to_response: TMDB_DETAIL_APPENDS(mode) });
  if (!detail) return null;
  return projectTmdbDetail(mode, detail, detail.title || detail.name || "");
}

// Entry point used by the /api/poster routes. Reads cache (with negative
// TTL respect), searches if needed, persists, returns the public shape.
async function ensureTmdbForItem(mode, id, panelHints) {
  const cacheKey = `${mode}:${id}`;
  const existing = tmdbCache[cacheKey];
  // Cache entries written before the kids-profile feature lack the
  // `us_cert` field. We can backfill by re-hitting the detail endpoint
  // for the known tmdb_id (skipping the search step entirely). After
  // backfill we won't re-fetch again — entries with empty us_cert get
  // stored explicitly.
  const needsCertBackfill = existing
    && existing.source === "tmdb"
    && existing.tmdb_id
    && !("us_cert" in existing);
  if (needsCertBackfill) {
    const refreshed = await refetchTmdbDetail(mode, existing.tmdb_id);
    if (refreshed) {
      const entry = { ...refreshed, source: "tmdb", checked_at: Date.now() };
      tmdbCache[cacheKey] = entry;
      scheduleTmdbCacheSave();
      return entry;
    }
    // Detail fetch failed — keep the old entry but stamp us_cert as ""
    // so we don't busy-loop the backfill. The next manual "Refresh
    // poster" will retry properly.
    existing.us_cert = "";
    scheduleTmdbCacheSave();
    return existing;
  }
  if (existing && existing.source === "tmdb") return existing;
  if (existing && existing.source === "no-match"
      && (Date.now() - (existing.checked_at || 0)) < TMDB_NEGATIVE_TTL_MS) {
    return existing;
  }
  // Shortcut: the panel sometimes ships a TMDB id alongside the title
  // (get_vod_info.info.tmdb_id, get_series_info.info.tmdb_id). When
  // present, skip the TMDB title-search step entirely and go straight
  // to the detail fetch — saves one HTTP round-trip per item AND
  // avoids the search-result ambiguity that bit ambiguous titles.
  const hintedId = panelHints && panelHints.tmdbId;
  if (hintedId) {
    const refreshed = await refetchTmdbDetail(mode, hintedId);
    if (refreshed) {
      const entry = { ...refreshed, source: "tmdb", checked_at: Date.now() };
      tmdbCache[cacheKey] = entry;
      scheduleTmdbCacheSave();
      return entry;
    }
    // Detail fetch with the panel-supplied id failed — fall through
    // to the search-based path rather than caching a bad miss.
  }
  const match = await findTmdbMatch(mode, panelHints.name, panelHints.year);
  const entry = match
    ? { ...match, source: "tmdb", checked_at: Date.now() }
    : { tmdb_id: null, source: "no-match", checked_at: Date.now() };
  tmdbCache[cacheKey] = entry;
  scheduleTmdbCacheSave();
  return entry;
}

// Background TMDB pre-warm. Fired after a movie / series index finishes
// so the home endpoint has posters + backdrops ready instead of waiting
// for clients to fan out per-tile lookups. Skips items already in
// tmdbCache; only spends an upstream call on the unknown ones. Run at
// a low concurrency so it doesn't interfere with live request latency
// — TMDB tolerates ~50 req/s but we want headroom for actual UI fetches.
const TMDB_PREWARM_CONCURRENCY = 2;
async function prewarmTmdbCache(mode) {
  if (!TMDB_API_KEY) return;
  if (mode === "live") return;
  const ix = indexes[mode];
  if (!ix?.ready) return;
  const items = [...ix.byId.values()];
  const startedAt = Date.now();
  const startCacheSize = Object.keys(tmdbCache).length;
  let i = 0;
  let resolved = 0;
  let lastLog = 0;
  console.log(`[${mode}] tmdb prewarm started: ${items.length} items, ${startCacheSize} cache entries on disk`);
  await new Promise((done) => {
    let active = 0;
    const next = () => {
      if (i >= items.length && active === 0) return done();
      while (active < TMDB_PREWARM_CONCURRENCY && i < items.length) {
        const it = items[i++];
        active++;
        ensureTmdbForItem(mode, it.id, { name: it.name, year: it.year })
          .catch(() => {})
          .finally(() => {
            active--;
            resolved++;
            // Heartbeat every 1000 items so a multi-minute prewarm
            // doesn't go silent.
            if (resolved - lastLog >= 1000) {
              lastLog = resolved;
              const pct = Math.round((resolved / items.length) * 100);
              console.log(`[${mode}] tmdb prewarm: ${resolved}/${items.length} (${pct}%)`);
            }
            next();
          });
      }
    };
    next();
  });
  const added = Object.keys(tmdbCache).length - startCacheSize;
  const took = Math.round((Date.now() - startedAt) / 1000);
  console.log(`[${mode}] tmdb prewarm done: ${resolved} items checked, ${added} new cache entries, ${took}s`);
}

// ──────────────────────────────────────────────────────────────────
// XMLTV bulk EPG indexer. The panel's `xmltv.php` endpoint returns the
// entire EPG for every channel in a single (large) document. Pulling
// it once a night and parsing into an in-memory map means
// /api/epg/short/{streamId} becomes a pure in-memory slice — no panel
// round-trip per visible TV-Guide row. Falls back gracefully to the
// per-channel get_simple_data_table path when a channel isn't covered.
// ──────────────────────────────────────────────────────────────────
const epgIndex = new Map(); // epg_channel_id → sorted [{ start, stop, title, desc }]
let epgIndexBuiltAt = 0;
const epgIndexFile = path.join(DATA_DIR, "epg-xmltv.json");
const EPG_XMLTV_TIMEOUT_MS = 5 * 60 * 1000;   // 5 min — file can be 5–15 MB
const EPG_XMLTV_STALE_MS   = 24 * 60 * 60 * 1000; // 24h — re-fetch if older
const EPG_NIGHTLY_HOUR     = 3; // 3 AM local for the daily refresh

function xmltvToMs(str) {
  if (!str || str.length < 14) return 0;
  const y  = +str.slice(0, 4);
  const mo = +str.slice(4, 6) - 1;
  const d  = +str.slice(6, 8);
  const h  = +str.slice(8, 10);
  const mi = +str.slice(10, 12);
  const s  = +str.slice(12, 14);
  let ms = Date.UTC(y, mo, d, h, mi, s);
  const tz = /([+-])(\d{2})(\d{2})\s*$/.exec(str);
  if (tz) {
    const sign = tz[1] === "+" ? 1 : -1;
    ms -= sign * ((+tz[2]) * 60 + (+tz[3])) * 60 * 1000;
  }
  return ms;
}
function decodeXmlEntities(s) {
  return String(s)
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&apos;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(+n));
}
async function loadEpgIndexFromDisk() {
  try {
    const raw = await fs.promises.readFile(epgIndexFile, "utf8");
    const data = JSON.parse(raw);
    if (!data || typeof data.byChannel !== "object") return;
    epgIndex.clear();
    for (const [k, v] of Object.entries(data.byChannel)) {
      if (Array.isArray(v)) epgIndex.set(k, v);
    }
    epgIndexBuiltAt = data.builtAt || 0;
    const totalProgs = [...epgIndex.values()].reduce((a, b) => a + b.length, 0);
    console.log(`[epg] loaded ${epgIndex.size} channels / ${totalProgs} programmes from disk`);
  } catch {}
}
async function saveEpgIndexToDisk() {
  try {
    const obj = { builtAt: epgIndexBuiltAt, byChannel: Object.fromEntries(epgIndex) };
    await fs.promises.writeFile(epgIndexFile + ".tmp", JSON.stringify(obj));
    await fs.promises.rename(epgIndexFile + ".tmp", epgIndexFile);
  } catch (e) {
    console.warn(`[epg] save failed: ${e.message}`);
  }
}
async function prewarmEpg() {
  if (!PANEL) return false;
  const url = `${PANEL}/xmltv.php?username=${encodeURIComponent(IPTV_USER)}&password=${encodeURIComponent(IPTV_PASS)}`;
  console.log(`[epg] fetching xmltv.php …`);
  const t0 = Date.now();
  let response;
  try {
    response = await fetch(url, {
      signal: AbortSignal.timeout(EPG_XMLTV_TIMEOUT_MS),
      headers: { "User-Agent": "Mozilla/5.0 (Linux; Android 12; Smart TV) AppleWebKit/537.36" },
    });
  } catch (e) {
    console.warn(`[epg] xmltv fetch failed: ${e.message}`);
    return false;
  }
  if (!response.ok) {
    console.warn(`[epg] xmltv returned HTTP ${response.status}`);
    return false;
  }
  let text;
  try { text = await response.text(); }
  catch (e) {
    console.warn(`[epg] xmltv body read failed: ${e.message}`);
    return false;
  }
  console.log(`[epg] downloaded ${(text.length / 1024 / 1024).toFixed(1)} MB in ${((Date.now() - t0) / 1000).toFixed(1)}s — parsing …`);

  // Single-pass regex scan. XMLTV is well-formed enough that this is
  // dramatically faster (and dependency-free) vs. a SAX parser.
  const PROG_RE = /<programme start="([^"]+)" stop="([^"]+)" channel="([^"]+)">([\s\S]*?)<\/programme>/g;
  const TITLE_RE = /<title[^>]*>([\s\S]*?)<\/title>/;
  const DESC_RE  = /<desc[^>]*>([\s\S]*?)<\/desc>/;
  const next = new Map();
  let total = 0;
  let m;
  while ((m = PROG_RE.exec(text)) !== null) {
    const startMs = xmltvToMs(m[1]);
    const stopMs  = xmltvToMs(m[2]);
    if (!startMs || !stopMs) continue;
    const channelId = m[3];
    if (!channelId) continue;
    const body = m[4];
    const tM = TITLE_RE.exec(body);
    const dM = DESC_RE.exec(body);
    const arr = next.get(channelId) || [];
    arr.push({
      start: startMs,
      stop:  stopMs,
      title: tM ? decodeXmlEntities(tM[1].trim()) : "",
      desc:  dM ? decodeXmlEntities(dM[1].trim()) : "",
    });
    next.set(channelId, arr);
    total++;
  }
  for (const arr of next.values()) arr.sort((a, b) => a.start - b.start);
  epgIndex.clear();
  for (const [k, v] of next) epgIndex.set(k, v);
  epgIndexBuiltAt = Date.now();
  console.log(`[epg] indexed ${next.size} channels / ${total} programmes in ${((Date.now() - t0) / 1000).toFixed(1)}s total`);
  saveEpgIndexToDisk();
  return true;
}
function msUntilNextLocalHour(targetHour) {
  const now = new Date();
  const target = new Date(now);
  target.setHours(targetHour, 0, 0, 0);
  if (target <= now) target.setDate(target.getDate() + 1);
  return target - now;
}
function scheduleEpgNightlyRefresh() {
  const ms = msUntilNextLocalHour(EPG_NIGHTLY_HOUR);
  console.log(`[epg] next xmltv refresh in ${Math.round(ms / 60000)} min`);
  setTimeout(() => {
    prewarmEpg().catch(e => console.warn(`[epg] nightly: ${e.message}`));
    setInterval(() => {
      prewarmEpg().catch(e => console.warn(`[epg] nightly: ${e.message}`));
    }, 24 * 60 * 60 * 1000);
  }, ms);
}

// User state PER PROFILE. Netflix-style profiles share one household
// login (APP_USER/APP_PASS) but each profile has its OWN favorites,
// recents, watched, progress, lastEpisode, myList, filter, theme,
// quality, etc. Storage shape on disk:
//
//   data/user-state.json = { "<profileId>": <state>, "<profileId>": <state> }
//
// The legacy shape (top-level state keys directly on the root object)
// is detected on boot and auto-migrated into a default "p1" profile.
const userStateFile = path.join(DATA_DIR, "user-state.json");
const profilesFile  = path.join(DATA_DIR, "users.json");

function emptyUserState() {
  return {
    favorites: { live: [], movie: [], series: [] },
    myList:    { live: [], movie: [], series: [] },
    recents:   { live: [], movie: [], series: [] },
    watched:   [],
    lastEpisode: {},
    progress: {},
    filter: {
      onboarded: false,
      groups: { live: [], movie: [], series: [] },
    },
    remoteEnabled: false,
    // Forward hours of EPG to slice from the panel into /api/epg/short.
    // Settable from the Settings UI (cycle pill: 2 / 3 / 5 / 8 / 12 / 24).
    // Default 3h — covers "what's on now and next" without padding the
    // payload on weak TV clients. Capped at 24h server-side. The
    // 1h backward lookback is fixed (programmes already in progress
    // need their block when a row first renders).
    epgWindowHoursForward: 3,
  };
}
// Normalize the on-disk shape into the canonical structure (so old
// files with missing keys upgrade safely).
function normalizeUserState(d) {
  const e = emptyUserState();
  if (!d || typeof d !== "object") return e;
  return {
    favorites: {
      live:   Array.isArray(d?.favorites?.live)   ? d.favorites.live   : e.favorites.live,
      movie:  Array.isArray(d?.favorites?.movie)  ? d.favorites.movie  : e.favorites.movie,
      series: Array.isArray(d?.favorites?.series) ? d.favorites.series : e.favorites.series,
    },
    myList: {
      live:   Array.isArray(d?.myList?.live)   ? d.myList.live   : e.myList.live,
      movie:  Array.isArray(d?.myList?.movie)  ? d.myList.movie  : e.myList.movie,
      series: Array.isArray(d?.myList?.series) ? d.myList.series : e.myList.series,
    },
    recents: {
      live:   Array.isArray(d?.recents?.live)   ? d.recents.live   : e.recents.live,
      movie:  Array.isArray(d?.recents?.movie)  ? d.recents.movie  : e.recents.movie,
      series: Array.isArray(d?.recents?.series) ? d.recents.series : e.recents.series,
    },
    watched:     Array.isArray(d?.watched)         ? d.watched         : e.watched,
    lastEpisode: d?.lastEpisode && typeof d.lastEpisode === "object" ? d.lastEpisode : e.lastEpisode,
    progress:    d?.progress    && typeof d.progress    === "object" ? d.progress    : e.progress,
    filter:      d?.filter      && typeof d.filter      === "object" ? {
      onboarded: !!d.filter.onboarded,
      groups: {
        live:   Array.isArray(d.filter.groups?.live)   ? d.filter.groups.live   : [],
        movie:  Array.isArray(d.filter.groups?.movie)  ? d.filter.groups.movie  : [],
        series: Array.isArray(d.filter.groups?.series) ? d.filter.groups.series : [],
      },
    } : e.filter,
    remoteEnabled: typeof d?.remoteEnabled === "boolean" ? d.remoteEnabled : e.remoteEnabled,
    epgWindowHoursForward: Math.min(Math.max(parseInt(d?.epgWindowHoursForward, 10) || e.epgWindowHoursForward, 1), 24),
  };
}

// Profile portraits are hand-illustrated theatre characters
// served as SVG by public/theatre-portraits.js. The server
// stores only the chosen portrait id; the SVG itself lives
// entirely in the client. Keep this list in sync with the
// PORTRAITS map in public/theatre-portraits.js.
const PORTRAIT_IDS = new Set([
  "chanteuse", "magician", "cat", "strongman", "mime",
  "ringmaster", "lady", "child", "acrobat",
]);
function normalizeAvatar(v) {
  return (typeof v === "string" && PORTRAIT_IDS.has(v)) ? v : null;
}

// In-memory state. Map<profileId, normalized userState>. Loaded at
// boot from disk; mutations call scheduleUserStateSave() to flush.
const profileStates = new Map();

// Profiles registry: { profiles: [...], nextId }. The first profile
// auto-created during migration is "p1" / "You". Future profile IDs
// are assigned sequentially as "p2", "p3", etc.
const profiles = { profiles: [], nextId: 2 };

function loadProfilesFromDisk() {
  try {
    const raw = fs.readFileSync(profilesFile, "utf8");
    const d = JSON.parse(raw);
    if (d && Array.isArray(d.profiles)) {
      profiles.profiles = d.profiles;
      profiles.nextId = Number.isFinite(d.nextId) ? d.nextId : (profiles.profiles.length + 1);
      return true;
    }
  } catch {}
  return false;
}
function saveProfilesToDisk() {
  try {
    fs.writeFileSync(profilesFile + ".tmp", JSON.stringify(profiles));
    fs.renameSync(profilesFile + ".tmp", profilesFile);
  } catch (e) {
    console.warn(`save users.json failed: ${e.message}`);
  }
}

(function loadUserStatesAndMigrate() {
  let raw;
  try { raw = fs.readFileSync(userStateFile, "utf8"); } catch { raw = null; }
  let parsed = null;
  try { parsed = raw ? JSON.parse(raw) : null; } catch { parsed = null; }
  // Heuristic: legacy shape has `favorites` at the top level. New
  // shape has profile-ID keys ("p1", "p2", …) at the top.
  const isLegacy = parsed && (parsed.favorites || parsed.recents || parsed.myList);
  const hadProfiles = loadProfilesFromDisk();
  if (isLegacy && !hadProfiles) {
    // Single-user data, no profile registry yet → wrap into a default
    // "p1" profile named "You" so the existing user's data carries over.
    const state = normalizeUserState(parsed);
    profileStates.set("p1", state);
    profiles.profiles = [{
      id: "p1",
      nick: "You",
      kidsBirthYear: null,
      createdAt: Date.now(),
    }];
    profiles.nextId = 2;
    saveProfilesToDisk();
    console.log("[profiles] migrated legacy user-state.json into profile p1 (\"You\")");
  } else if (parsed && typeof parsed === "object" && !isLegacy) {
    // Already in the new shape — load each profile's state.
    for (const id of Object.keys(parsed)) {
      profileStates.set(id, normalizeUserState(parsed[id]));
    }
  }
  // If we still have no profiles, seed one for fresh installs.
  if (!profiles.profiles.length) {
    profiles.profiles = [{
      id: "p1",
      nick: "You",
      kidsBirthYear: null,
      createdAt: Date.now(),
    }];
    profiles.nextId = 2;
    saveProfilesToDisk();
  }
  // Make sure every profile has a state entry.
  for (const p of profiles.profiles) {
    if (!profileStates.has(p.id)) profileStates.set(p.id, emptyUserState());
  }
})();

// Helpers for the rest of the server to read/write a profile's state
// without thinking about disk layout.
function getProfileState(profileId) {
  let s = profileStates.get(profileId);
  if (!s) { s = emptyUserState(); profileStates.set(profileId, s); }
  return s;
}
function findProfile(id) {
  return profiles.profiles.find(p => p.id === id) || null;
}
function profileIdsOnDisk() { return Object.fromEntries(profileStates); }

let userStateSaveTimer = null;
function scheduleUserStateSave() {
  if (userStateSaveTimer) return;
  userStateSaveTimer = setTimeout(async () => {
    userStateSaveTimer = null;
    try {
      await fs.promises.writeFile(userStateFile + ".tmp", JSON.stringify(profileIdsOnDisk()));
      await fs.promises.rename(userStateFile + ".tmp", userStateFile);
    } catch (e) {
      console.warn(`save user-state failed: ${e.message}`);
    }
  }, 500);
}

async function saveIndexToDisk(mode) {
  const ix = indexes[mode];
  if (!ix.byId.size) return;
  const data = {
    savedAt: Date.now(),
    panel: PANEL,
    total: ix.total,
    done: ix.done,
    streams: [...ix.byId.values()],
  };
  try {
    await fs.promises.writeFile(indexFilePath(mode) + ".tmp", JSON.stringify(data));
    await fs.promises.rename(indexFilePath(mode) + ".tmp", indexFilePath(mode));
  } catch (e) {
    console.warn(`[${mode}] save failed: ${e.message}`);
  }
}

async function loadIndexFromDisk(mode) {
  try {
    const raw = await fs.promises.readFile(indexFilePath(mode), "utf8");
    const data = JSON.parse(raw);
    if (!Array.isArray(data.streams)) return null;
    // Re-tag against the current CHANNEL_GROUPS regex table. Old
    // on-disk indexes from before the tagging system was added won't
    // have `tags` baked in; a pattern table update should also
    // re-flow tags without forcing a full re-index. Cheap (one Map
    // lookup per stream).
    const cats = loadCategoriesFromDiskSync(mode);
    if (cats && cats.length) rebuildCategoryTags(mode, cats);
    const tagMap = tagsByCategory[mode];
    const byId = new Map();
    for (const s of data.streams) {
      const cat = tagMap?.get(String(s.category_id)) || ["other"];
      s.tags = applyQualityDemotion(mode, s.id, streamTagsFor(s.name, cat));
      if (mode !== "live") {
        const tmdbEntry = tmdbCache[`${mode}:${s.id}`];
        s.us_cert = tmdbEntry?.us_cert || null;
        s.tmdb_id = tmdbEntry?.tmdb_id || null;
      }
      byId.set(s.id, s);
    }
    indexes[mode].byId = byId;
    indexes[mode].total = data.total || data.streams.length;
    indexes[mode].done = data.done || data.streams.length;
    indexes[mode].ready = true;
    return data;
  } catch {
    return null;
  }
}

async function clearDiskIndexes() {
  for (const mode of Object.keys(indexes)) {
    try { await fs.promises.unlink(indexFilePath(mode)); } catch {}
  }
}

async function xtream(action, params = {}, { timeout = 90_000 } = {}) {
  const key = action + JSON.stringify(params);
  const hit = cache.get(key);
  if (hit && Date.now() - hit.t < TTL_MS) return hit.v;
  if (inflight.has(key)) return inflight.get(key);

  const qs = new URLSearchParams({
    username: IPTV_USER,
    password: IPTV_PASS,
    ...(action ? { action } : {}),
    ...params,
  }).toString();

  const url = `${PANEL}/player_api.php?${qs}`;
  const p = (async () => {
    const res = await fetch(url, {
      headers: {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
        "Accept": "application/json,text/plain,*/*",
      },
      signal: AbortSignal.timeout(timeout),
    });
    if (!res.ok) throw new Error(`Panel ${res.status} for ${action || "auth"}`);
    const v = await res.json();
    // Do not cache auth-rejection bodies — they're transient (panel is
    // rate-limiting or briefly unhappy) and a 24-hour TTL would lock the
    // app into a broken state long after the panel recovers. Lets every
    // subsequent call retry against the live panel until it answers.
    const isAuthReject = !Array.isArray(v) && v && v.user_info && Number(v.user_info.auth) === 0;
    if (!isAuthReject) cache.set(key, { t: Date.now(), v });
    return v;
  })().finally(() => inflight.delete(key));

  inflight.set(key, p);
  return p;
}

// Most-recently observed panel account info. Populated by /api/bootstrap
// (which calls xtream("") to refresh it). Used to honor
// user_info.allowed_output_formats — some panels only allow m3u8 and
// reject .ts requests, so a client asking for "/live/.../X.ts" would
// get a broken URL. When the panel hasn't whitelisted "ts", we silently
// fall back to m3u8 for live mode. movie/series streams use the
// container ext from the panel metadata so this guard doesn't apply.
let lastAccountInfo = null;
function panelAllowsExt(ext) {
  const allowed = lastAccountInfo?.user_info?.allowed_output_formats;
  if (!Array.isArray(allowed) || !allowed.length) return true; // unknown → allow
  return allowed.map(s => String(s).toLowerCase()).includes(String(ext).toLowerCase());
}
function streamUrl(mode, id, ext) {
  const m = MODES[mode];
  if (!m) throw new Error(`Bad mode ${mode}`);
  let e = ext || m.defaultExt || "mp4";
  if (mode === "live" && e === "ts" && !panelAllowsExt("ts")) e = "m3u8";
  return `${PANEL}/${m.pathSeg}/${IPTV_USER}/${IPTV_PASS}/${id}.${e}`;
}

function projectStream(mode, s) {
  const catId = String(s.category_id);
  // Pre-computed tags for this stream's category. Both web and TV
  // chip filters consume `tags` as a flat string array so toggling
  // chips is an O(1) Set lookup instead of running every GROUPS regex
  // against the category name on each click. Falls back to ["other"]
  // when categories haven't been indexed yet (boot ordering).
  const catTags = tagsByCategory[mode]?.get(catId) || ["other"];
  // Per-stream synthetic markers. "4k", "movies", and "music" often
  // appear in the channel name even when the category is generic —
  // e.g. category "INDIA SPORTS HD" containing both "Star Sports 1"
  // and "Star Sports 1 (4K)". Without this pass, the 4K chip would
  // miss those streams. Always layered on top of category tags.
  // Real-4K demotion sits on the very end — see applyQualityDemotion.
  const projectedId = mode === "series" ? s.series_id : (s.stream_id || s.id);
  const tags = applyQualityDemotion(mode, projectedId, streamTagsFor(s.name, catTags));
  const tmdbEntry = mode !== "live" ? tmdbCache[`${mode}:${projectedId}`] : null;
  const us_cert = tmdbEntry?.us_cert || null;
  const tmdb_id = tmdbEntry?.tmdb_id || null;
  if (mode === "series") {
    return {
      id: s.series_id,
      name: s.name,
      icon: s.cover,
      category_id: catId,
      year: s.year || s.releaseDate || null,
      rating: s.rating || s.rating_5based || null,
      plot: s.plot || null,
      us_cert,
      tmdb_id,
      tags,
    };
  }
  return {
    id: s.stream_id,
    name: s.name,
    icon: s.stream_icon || s.cover,
    category_id: catId,
    container: s.container_extension || null,
    year: s.year || s.releaseDate || null,
    rating: s.rating || s.rating_5based || null,
    added: s.added || null,
    // For live streams: panel returns epg_channel_id when EPG data exists
    // for this channel (empty string / null otherwise). The TV Guide uses
    // it to split channels into "with program data" / "without".
    epg_channel_id: mode === "live"
      ? (s.epg_channel_id ? String(s.epg_channel_id) : "")
      : undefined,
    us_cert,
    tmdb_id,
    tags,
  };
}

const indexes = {
  live:   { total: 0, done: 0, ready: false, running: false, byId: new Map() },
  movie:  { total: 0, done: 0, ready: false, running: false, byId: new Map() },
  series: { total: 0, done: 0, ready: false, running: false, byId: new Map() },
};

async function buildIndex(mode) {
  const ix = indexes[mode];
  if (ix.running) return;
  ix.running = true;
  const m = MODES[mode];
  const t = Date.now();
  try {
    const cats = await xtream(m.cats);
    if (!Array.isArray(cats)) {
      console.warn(`[${mode}] index build skipped: panel returned non-array categories (${typeof cats})`);
      return;
    }
    saveCategoriesToDisk(mode, cats);
    rebuildCategoryTags(mode, cats);
    ix.total = cats.length;
    ix.done = 0;
    ix.byId = new Map();
    console.log(`[${mode}] indexing ${cats.length} categories…`);
    for (const c of cats) {
      try {
        const list = await xtream(m.list, { category_id: c.category_id }, { timeout: 60_000 });
        for (const s of list) {
          const p = projectStream(mode, s);
          if (!ix.byId.has(p.id)) ix.byId.set(p.id, p);
        }
      } catch (e) {
        console.warn(`  [${mode}] cat ${c.category_id} (${c.category_name}) failed: ${e.message}`);
      }
      ix.done++;
    }
    ix.ready = true;
    console.log(`[${mode}] index ready: ${ix.byId.size} items in ${Date.now() - t}ms`);
    saveIndexToDisk(mode);
    // Fire-and-forget TMDB pre-warm so the home endpoint's tiles get
    // posters/backdrops/cert ready before the user opens the app.
    // No-op for live (no TMDB enrichment) and skipped without an API
    // key. Errors inside are already caught per-item.
    if (mode !== "live") {
      prewarmTmdbCache(mode).catch(e => {
        console.warn(`[${mode}] tmdb prewarm errored: ${e.message}`);
      });
    }
    if (mode === "movie") {
      prewarmQualityCache().catch(e => {
        console.warn(`[movie] quality prewarm errored: ${e.message}`);
      });
    }
  } finally {
    ix.running = false;
  }
}

async function buildAllIndexes() {
  await Promise.all([
    buildIndex("live"),
    buildIndex("movie"),
    buildIndex("series"),
  ]);
}

const app = express();

// Honor X-Forwarded-Proto so `req.secure` reflects the upstream
// (Traefik terminates TLS and forwards HTTP to us). This drives the
// conditional `Secure` attribute on session/profile cookies — Secure
// breaks non-browser clients on HTTP (OkHttp follows the RFC and
// drops them on the next request), so we only set it when the
// client actually reached us over HTTPS.
app.set("trust proxy", true);

app.get("/healthz", (_req, res) => res.json({ ok: true, sha: process.env.GIT_SHA || "dev" }));

// --- signed media routes (no app auth required, validated by HMAC) ---
// These are placed BEFORE the session-auth middleware so the browser's
// <video> element can fetch them without sending a session cookie or
// re-prompting for credentials.

function alternateHosts(target) {
  if (PANEL_CANDIDATES.length < 2) return [];
  let url; try { url = new URL(target); } catch { return []; }
  return PANEL_CANDIDATES
    .filter(panel => new URL(panel).host !== url.host)
    .map(panel => {
      const p = new URL(panel);
      const alt = new URL(target);
      alt.protocol = p.protocol; alt.host = p.host; alt.port = p.port;
      return alt.href;
    });
}

async function fetchUpstream(target, range, externalSignal) {
  // Compose the external (client-disconnect) signal with our own
  // timeout so closing the browser tab tears down the upstream fetch
  // instantly — otherwise Node fetch happily keeps reading data into
  // the void after the client goes away, holding the panel's
  // max_connections=1 slot through the natural drain.
  const signal = externalSignal
    ? AbortSignal.any([externalSignal, AbortSignal.timeout(30_000)])
    : AbortSignal.timeout(30_000);
  return fetch(target, {
    redirect: "follow",
    headers: {
      "User-Agent": "Mozilla/5.0 (Linux; Android 12; Smart TV) AppleWebKit/537.36",
      "Accept": "*/*",
      ...(range ? { "Range": range } : {}),
    },
    signal,
  });
}

app.get("/api/proxy", async (req, res, _next) => {
  const target = req.query.u;
  if (!target) return res.status(400).end();
  let parsed;
  try { parsed = new URL(target); } catch { return res.status(400).end(); }
  if (!/^https?:$/.test(parsed.protocol)) return res.status(400).end();
  const host = parsed.hostname;
  if (host === "localhost" || host === "127.0.0.1" || /^10\.|^192\.168\.|^172\.(1[6-9]|2\d|3[01])\./.test(host)) {
    return res.status(403).end();
  }
  if (!verifyProxySig(target, req.query.s)) return res.status(403).end();

  const isManifestPath = target.includes(".m3u8");

  // Tie the upstream fetch lifetime to the client connection. As soon as
  // the browser disconnects (tab close, hard refresh, channel switch),
  // we abort the panel-side fetch so its connection slot is released
  // immediately rather than draining the rest of the segment.
  const ac = new AbortController();
  const onClose = () => ac.abort();
  res.on("close", onClose);

  // Admission control. If the URL identifies a stream (manifest or
  // direct VOD URL or live segment with chid), claim a slot on behalf
  // of this request's owner. Sub-segments without an obvious mode/id
  // just bump lastSeen on the existing entry — refused if the owner
  // was displaced.
  const owner = ownerKeyOf(req);
  const parsed2 = parseStreamFromPanelUrl(target);
  const killer = () => { try { ac.abort(); } catch {} };
  if (parsed2) {
    const ad = admitStream(owner, parsed2.mode, parsed2.id, killer, currentAccountKey());
    if (!ad.ok) return sendDisplaced(res);
  } else {
    if (!touchStream(owner)) return sendDisplaced(res);
  }
  res.on("close", () => dropStreamKiller(owner, killer));

  try {
    let upstream = await fetchUpstream(target, req.headers.range, ac.signal);
    let effectiveTarget = target;
    let fellBack = false;

    if (isManifestPath) {
      const looksEmpty = (h) => h.headers.get("content-length") === "0" || !h.ok;
      if (looksEmpty(upstream)) {
        for (const alt of alternateHosts(target)) {
          const upstream2 = await fetchUpstream(alt, req.headers.range, ac.signal);
          if (!looksEmpty(upstream2)) {
            upstream = upstream2;
            effectiveTarget = alt;
            fellBack = true;
            break;
          }
        }
      }
    }

    res.status(upstream.status);
    res.setHeader("Access-Control-Allow-Origin", "*");
    const ct = upstream.headers.get("content-type") || "application/octet-stream";
    res.setHeader("Content-Type", ct);
    for (const h of ["content-length", "content-range", "accept-ranges", "cache-control"]) {
      const v = upstream.headers.get(h);
      if (v) res.setHeader(h, v);
    }

    if (target.includes(".m3u8") || ct.includes("mpegurl")) {
      const baseForRelatives = upstream.url || target;
      const text = await upstream.text();
      const rewritten = text.split(/\r?\n/).map(line => {
        if (!line || line.startsWith("#")) {
          return line.replace(/URI="([^"]+)"/g, (_m, u) => {
            const abs = new URL(u, baseForRelatives).href;
            return `URI="${signProxyUrl(abs)}"`;
          });
        }
        const t = line.trim();
        if (!t) return line;
        const abs = new URL(t, baseForRelatives).href;
        return signProxyUrl(abs);
      }).join("\n");
      res.removeHeader("content-length");
      res.send(rewritten);
    } else if (upstream.body) {
      Readable.fromWeb(upstream.body).on("error", () => res.end()).pipe(res);
    } else {
      res.end();
    }
  } catch (e) {
    if (!res.headersSent) res.status(502);
    res.end();
  }
});

app.get("/api/transcode/:mode(live|movie|series)/:id/index.m3u8", async (req, res, next) => {
  // The source-seek offset (?t=<secs>) IS part of the HMAC so a
  // client can't ask for an arbitrary anchor without a fresh signed
  // URL from /api/stream. t=0 (the common case) signs the same as
  // before, so old client URLs keep working.
  const offsetSecs = normalizeOffsetSecs(req.query.t);
  const sigInput = offsetSecs > 0
    ? `transcode:${req.params.mode}:${req.params.id}:${offsetSecs}`
    : `transcode:${req.params.mode}:${req.params.id}`;
  const expected = crypto.createHmac("sha256", PROXY_SECRET).update(sigInput).digest("hex").slice(0, 16);
  if (req.query.s !== expected) return res.status(403).end();
  // Quality is *not* baked into the HMAC — it's a UX setting, not an
  // authorization concern. Default to "med" (the original quality) so
  // legacy callers without ?q= keep working.
  const quality = normalizeQuality(req.query.q);
  // Admission control. The killer here SIGTERMs the ffmpeg so the
  // upstream panel slot is freed when this owner gets displaced.
  const owner = ownerKeyOf(req);
  const killer = () => {
    const t = transcoders.get(transcoderKey(req.params.mode, req.params.id, quality, offsetSecs));
    if (t) { try { t.proc.kill("SIGTERM"); } catch {} }
  };
  const ad = admitStream(owner, req.params.mode, req.params.id, killer, currentAccountKey());
  if (!ad.ok) return sendDisplaced(res);
  try {
    const t = await startOrTouchTranscoder(req.params.mode, req.params.id, quality, offsetSecs);
    const playlistPath = path.join(t.dir, "index.m3u8");
    for (let i = 0; i < 60; i++) {
      if (fs.existsSync(playlistPath) && fs.readFileSync(playlistPath, "utf8").includes("#EXTINF")) {
        let content = fs.readFileSync(playlistPath, "utf8");
        // Segment URLs carry the same quality tag AND offset so the
        // segment route can route to the right ffmpeg dir even when
        // the user has flipped quality or re-anchored mid-stream.
        const qq = `q=${quality}` + (offsetSecs > 0 ? `&t=${offsetSecs}` : "");
        content = content.replace(/^seg_(\d+)\.ts$/gm,
          `/api/transcode/${req.params.mode}/${req.params.id}/seg_$1.ts?${qq}`);
        res.setHeader("Content-Type", "application/vnd.apple.mpegurl");
        res.setHeader("Access-Control-Allow-Origin", "*");
        res.setHeader("Cache-Control", "no-cache");
        return res.send(content);
      }
      await new Promise(r => setTimeout(r, 250));
    }
    res.status(504).json({ error: "transcoder startup timeout" });
  } catch (e) { next(e); }
});

app.get("/api/transcode/:mode(live|movie|series)/:id/seg_:n.ts", (req, res) => {
  const owner = ownerKeyOf(req);
  // Bump lastSeen on the existing stream record. If the owner was
  // displaced between segments, this is where they learn about it.
  if (!touchStream(owner)) return sendDisplaced(res);
  const quality = normalizeQuality(req.query.q);
  const offsetSecs = normalizeOffsetSecs(req.query.t);
  const t = transcoders.get(transcoderKey(req.params.mode, req.params.id, quality, offsetSecs));
  if (!t) return res.status(404).end();
  t.lastAccess = Date.now();
  const segPath = path.join(t.dir, `seg_${req.params.n}.ts`);
  if (!fs.existsSync(segPath)) return res.status(404).end();
  res.setHeader("Content-Type", "video/mp2t");
  res.setHeader("Access-Control-Allow-Origin", "*");
  fs.createReadStream(segPath).on("error", () => res.end()).pipe(res);
});

// Single-file 720p MP4 piped live from ffmpeg. Used by the Android
// phone's DownloadManager to save a watchable, ~1 GB-per-2-hour
// copy of a movie or episode for offline playback.
//
// Why this exists instead of letting the phone pull through
// /api/proxy: panel CDN URLs are throwaway (see whois on the
// resolved IP — Rackdog VPS + a Spanish hoster, domain registered
// 2 weeks ago through a privacy proxy) and they routinely drop
// long-lived connections mid-file. The proxy can't transparently
// resume because the upstream HMAC signature is HEAD-vs-GET
// asymmetric and DownloadManager's Range-on-resume fails. Routing
// through ffmpeg here means the panel→server hop is ffmpeg's
// problem (which can re-open + seek) and the server→phone hop is a
// stable HTTP/200 stream from the same origin DownloadManager
// already trusts.
//
// Quality is fixed at 720p — phones can't physically resolve the
// extra pixels of a 1080p source on a 6" screen, and the panel's
// native bitrate makes raw downloads 4-5 GB per movie. CRF 22 +
// veryfast preset gives Netflix-Standard-ish file sizes (≈ 1 GB
// for a 2-hour movie at 24fps).
//
// HMAC-signed (like /api/proxy and /api/transcode) so the URL can
// be handed to a non-auth'd client like DownloadManager. Lives
// BEFORE the auth middleware below for that reason — see the
// session-auth middleware at the next section.
app.get("/api/download/:mode(movie|series)/:id.mp4", async (req, res) => {
  const { mode, id } = req.params;
  const expected = crypto.createHmac("sha256", PROXY_SECRET)
    .update(`download:${mode}:${id}`).digest("hex").slice(0, 16);
  if (req.query.s !== expected) return res.status(403).end("bad signature");

  // The output is always MP4 (ffmpeg transcodes regardless), but the
  // panel-side URL MUST use the source's actual container. The panel
  // stores each title as either .mp4 or .mkv (or rarely .avi) and
  // requesting the wrong extension returns 200 OK + text/html + 0
  // bytes — same pattern as a missing file.
  //
  // For movies the index lookup is authoritative (movies.byId is
  // keyed by movie id). For series the index is keyed by series id,
  // NOT episode id, so any per-episode container lookup misses and
  // falls back to mp4 — which fails for the (very common) panels
  // that store episodes as mkv. Rather than fetching get_series_info
  // for every download request, probe the candidate containers in
  // order and use the first that returns real bytes.
  const indexExt = (mode === "movie"
    ? indexes.movie.byId.get(parseInt(id, 10))?.container
    : null);
  const candidates = indexExt
    ? [indexExt, ...["mp4", "mkv", "avi"].filter(x => x !== indexExt)]
    : ["mp4", "mkv", "avi"];

  // Pre-flight check: panel returns 200 OK with Content-Type
  // text/html and an empty body for the wrong container as well as
  // for files no longer on the reseller's CDN. Without this probe
  // we spawn ffmpeg which immediately fails, then pipe 0 bytes
  // back to the client; DownloadManager calls that "SUCCESSFUL"
  // and we get an empty file.
  let sourceUrl = null;
  let lastProbeErr = "no candidates";
  for (const ext of candidates) {
    const url = streamUrl(mode, id, ext);
    if (!url) continue;
    try {
      const probe = await fetch(url, {
        method: "GET",
        headers: {
          "User-Agent": "Mozilla/5.0 (Linux; Android 12; Smart TV)",
          "Range": "bytes=0-1024",
        },
        redirect: "follow",
        signal: AbortSignal.timeout(4000),
      });
      const ct = probe.headers.get("content-type") || "";
      const buf = Buffer.from(await probe.arrayBuffer());
      if (!ct.startsWith("text/") && buf.length > 0) {
        sourceUrl = url;
        break;
      }
      lastProbeErr = `${ext}: ct=${ct} bytes=${buf.length}`;
    } catch (e) {
      lastProbeErr = `${ext}: ${e.message}`;
    }
  }
  if (!sourceUrl) {
    return res.status(502).type("text/plain")
      .end(`panel says this file isn't available on the active CDN — try again later or pick a different title (${lastProbeErr})`);
  }

  res.setHeader("Content-Type", "video/mp4");
  res.setHeader("Content-Disposition",
    `attachment; filename="khouch_${mode}_${id}_720p.mp4"`);

  const args = [
    "-hide_banner", "-loglevel", "warning",
    "-fflags", "+genpts",
    "-user_agent", "Mozilla/5.0 (Linux; Android 12; Smart TV)",
    "-i", sourceUrl,
    "-map", "0:v:0", "-map", "0:a:0?",
    "-c:v", "libx264", "-preset", "veryfast",
    "-profile:v", "high", "-level", "4.1", "-pix_fmt", "yuv420p",
    "-crf", "22",
    "-vf", "scale=-2:720",
    "-c:a", "aac", "-b:a", "192k", "-ac", "2",
    "-movflags", "+frag_keyframe+empty_moov+default_base_moof",
    "-f", "mp4",
    "pipe:1",
  ];
  const ff = spawn("ffmpeg", args, { stdio: ["ignore", "pipe", "pipe"] });
  let stderrBuf = "";
  ff.stderr.on("data", (chunk) => {
    stderrBuf += chunk.toString();
    if (stderrBuf.length > 8192) stderrBuf = stderrBuf.slice(-4096);
  });
  ff.stdout.pipe(res);
  res.on("close", () => {
    if (!ff.killed) {
      try { ff.kill("SIGKILL"); } catch {}
    }
  });
  ff.on("close", (code) => {
    if (code !== 0 && code !== null) {
      console.warn(`[download] ${mode}/${id} ffmpeg exit ${code}\n${stderrBuf.slice(-1024)}`);
    }
  });
});

// --- Session auth ---------------------------------------------------------
// HTTP Basic Auth as the only gate worked but exposed the browser's
// system password dialog on every fresh tab — ugly for a polished
// streaming app. Replace with a signed-cookie session in front of
// Basic Auth: browsers get a styled HTML login page, while non-browser
// API clients (curl scripts, future Android TV app) can still use
// Basic Auth headers as a fallback.
//
// Cookie: HMAC(APP_USER + ":" + issued_at, PROXY_SECRET) — no PII,
// no DB, just a self-verifying token. Server has nothing to store.
const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 days
const SESSION_COOKIE = "khouch_session";

function signSession(issuedAt) {
  return crypto.createHmac("sha256", PROXY_SECRET)
    .update(`${APP_USER}:${issuedAt}`)
    .digest("hex").slice(0, 32);
}
function makeSessionToken() {
  const issuedAt = Date.now();
  return `${issuedAt}.${signSession(issuedAt)}`;
}
function verifySessionToken(token) {
  if (!token || typeof token !== "string") return false;
  const idx = token.indexOf(".");
  if (idx <= 0) return false;
  const issuedAt = Number(token.slice(0, idx));
  const sig = token.slice(idx + 1);
  if (!Number.isFinite(issuedAt)) return false;
  if (Date.now() - issuedAt > SESSION_TTL_MS) return false;
  return sig === signSession(issuedAt);
}
function parseSessionCookie(req) {
  const raw = req.headers.cookie || "";
  for (const part of raw.split(/;\s*/)) {
    if (part.startsWith(SESSION_COOKIE + "=")) {
      return decodeURIComponent(part.slice(SESSION_COOKIE.length + 1));
    }
  }
  return null;
}
// Build the cookie suffix. Secure is opt-in based on the request
// because non-browser clients on HTTP drop Secure cookies entirely
// (Android TV app via OkHttp, dev curls, etc.). Production traffic
// always comes in over HTTPS via Traefik, so this keeps the Secure
// flag on for browsers in real deployments.
function cookieAttrs(req, maxAge) {
  const secure = req && req.secure ? "; Secure" : "";
  return `Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}${secure}`;
}
function setSessionCookie(req, res) {
  const token = makeSessionToken();
  res.setHeader("Set-Cookie",
    `${SESSION_COOKIE}=${encodeURIComponent(token)}; ${cookieAttrs(req, SESSION_TTL_MS / 1000)}`);
}
function clearSessionCookie(req, res) {
  res.setHeader("Set-Cookie", `${SESSION_COOKIE}=; ${cookieAttrs(req, 0)}`);
}

// Profile selection cookie. Set after the user picks a profile from
// /profile/pick. HMAC-signed so it can't be forged; the payload is
// the profile id ("p1", "p2", …). Browsers without a valid profile
// cookie get bounced to the picker.
const PROFILE_COOKIE = "khouch_profile";
function signProfile(id) {
  return crypto.createHmac("sha256", PROXY_SECRET)
    .update(`profile:${id}`)
    .digest("hex").slice(0, 24);
}
function makeProfileToken(id) { return `${id}.${signProfile(id)}`; }
function parseProfileToken(token) {
  if (!token || typeof token !== "string") return null;
  const idx = token.indexOf(".");
  if (idx <= 0) return null;
  const id = token.slice(0, idx);
  const sig = token.slice(idx + 1);
  if (sig !== signProfile(id)) return null;
  return id;
}
function parseProfileCookie(req) {
  const raw = req.headers.cookie || "";
  for (const part of raw.split(/;\s*/)) {
    if (part.startsWith(PROFILE_COOKIE + "=")) {
      return decodeURIComponent(part.slice(PROFILE_COOKIE.length + 1));
    }
  }
  return null;
}
function setProfileCookie(req, res, id) {
  res.append("Set-Cookie",
    `${PROFILE_COOKIE}=${encodeURIComponent(makeProfileToken(id))}; ${cookieAttrs(req, SESSION_TTL_MS / 1000)}`);
}
function clearProfileCookie(req, res) {
  res.append("Set-Cookie", `${PROFILE_COOKIE}=; ${cookieAttrs(req, 0)}`);
}

// Pull the active profile id from the request (cookie). Returns the
// profile id if valid AND that profile still exists in the registry.
function getRequestProfileId(req) {
  const tok = parseProfileCookie(req);
  if (!tok) return null;
  const id = parseProfileToken(tok);
  if (!id) return null;
  if (!findProfile(id)) return null;
  return id;
}

// Verify a Basic Auth header against APP_USER/APP_PASS without
// challenging the browser. Returns true on a valid match.
function verifyBasicAuth(req) {
  const h = req.headers.authorization || "";
  if (!h.startsWith("Basic ")) return false;
  let decoded;
  try { decoded = Buffer.from(h.slice(6), "base64").toString("utf8"); }
  catch { return false; }
  const idx = decoded.indexOf(":");
  if (idx < 0) return false;
  return decoded.slice(0, idx) === APP_USER && decoded.slice(idx + 1) === APP_PASS;
}

// Public routes that bypass auth: the login page itself, the form
// POST endpoint, the favicon (so the login page can render its tab
// icon without an extra round-trip), and /healthz (so external
// uptime checks don't need creds).
const PUBLIC_PATHS = new Set(["/login", "/login/", "/api/login", "/favicon.svg", "/healthz"]);
// Paths reachable after household sign-in but before picking a
// profile. Anything else requires the profile cookie too.
const PROFILE_GATED_BYPASS = new Set([
  "/profile", "/profile/", "/profile/pick", "/profile/pick/",
  "/api/profiles", "/api/profile/select", "/api/logout",
]);

app.use((req, res, next) => {
  if (PUBLIC_PATHS.has(req.path)) return next();
  // Theatre-portrait SVGs are unauthenticated static assets so
  // they render on the login page (future) and the Android phone
  // app's pre-login profile picker — Coil's SVG decoder fetches
  // them without a session cookie. There's nothing sensitive in
  // an SVG, and they're cacheable forever (the file content is
  // the only thing that changes when we add a new portrait).
  if (req.path.startsWith("/portraits/")) return next();
  // Session cookie wins.
  const sessionToken = parseSessionCookie(req);
  const sessionOk = sessionToken && verifySessionToken(sessionToken);
  // Basic Auth fallback for API clients (curl, scripts, the future
  // Android TV app). Don't *challenge* (no WWW-Authenticate header) —
  // that would re-trigger the browser dialog we're trying to replace.
  const basicOk = !sessionOk && verifyBasicAuth(req);
  if (!sessionOk && !basicOk) {
    const wantsHtml = (req.headers.accept || "").includes("text/html");
    if (wantsHtml) {
      const next = encodeURIComponent(req.originalUrl || "/");
      return res.redirect(302, `/login?next=${next}`);
    }
    return res.status(401).json({ error: "auth required" });
  }
  // Household login is good. Now require a profile selection for
  // anything other than the profile-pick page itself and the
  // /api/profiles bootstrap endpoints. Basic-Auth clients skip this
  // check — they're scripts that don't have a session-cookie context
  // anyway. We attach a default profile id (first one in the list)
  // for those so existing server-side state lookups keep working.
  //
  // BUT: if the browser ALSO sends a valid khouch_profile cookie
  // (e.g. session cookie went stale across a PROXY_SECRET rotation,
  // browser fell back to cached Basic Auth, but the user keeps
  // hitting profile-pick to switch profiles), we MUST honor the
  // cookie. Otherwise profile-switch is permanently broken for that
  // user — every request silently resolves to profile #1.
  const cookieProfileId = getRequestProfileId(req);
  if (basicOk) {
    req.profileId = cookieProfileId || profiles.profiles[0]?.id || null;
    return next();
  }
  if (cookieProfileId) { req.profileId = cookieProfileId; return next(); }
  if (PROFILE_GATED_BYPASS.has(req.path)) return next();
  const wantsHtml = (req.headers.accept || "").includes("text/html");
  if (wantsHtml) return res.redirect(302, "/profile/pick");
  return res.status(401).json({ error: "profile required" });
});

// Login form handler. Verifies APP_USER/APP_PASS, sets the session
// cookie, redirects (or returns JSON for fetch-style submits).
app.post("/api/login", express.json(), express.urlencoded({ extended: false }), (req, res) => {
  const u = (req.body && (req.body.user || req.body.username)) || "";
  const p = (req.body && (req.body.pass || req.body.password)) || "";
  if (u === APP_USER && p === APP_PASS) {
    setSessionCookie(req, res);
    const next = (req.body && req.body.next) || (req.query && req.query.next) || "/";
    // Allow only same-origin paths in `next` so an attacker can't
    // craft a login link that redirects to evil.com after success.
    const safeNext = (typeof next === "string" && next.startsWith("/") && !next.startsWith("//")) ? next : "/";
    if ((req.headers.accept || "").includes("application/json")) {
      return res.json({ ok: true, next: safeNext });
    }
    return res.redirect(302, safeNext);
  }
  if ((req.headers.accept || "").includes("application/json")) {
    return res.status(401).json({ ok: false, error: "Wrong username or password" });
  }
  return res.redirect(302, `/login?error=1${req.body && req.body.next ? `&next=${encodeURIComponent(req.body.next)}` : ""}`);
});

// Logout — clears the cookie and bounces back to the login page.
app.post("/api/logout", (req, res) => {
  clearSessionCookie(req, res);
  clearProfileCookie(req, res);
  if ((req.headers.accept || "").includes("application/json")) {
    return res.json({ ok: true });
  }
  res.redirect(302, "/login");
});

// The styled login page itself. Lives at public/login.html so it can
// be edited without touching server code.
app.get("/login", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "login.html"));
});

// Profile picker page — served after household sign-in if the user
// hasn't picked a profile yet (or wants to switch).
app.get("/profile/pick", (_req, res) => {
  res.sendFile(path.join(__dirname, "public", "profile-pick.html"));
});

// List all profiles (used by both the picker page and the settings
// management UI).
app.get("/api/profiles", (_req, res) => {
  // `avatar` is the chosen portrait id (e.g. "magician"). The
  // client maps it to an SVG via public/theatre-portraits.js
  // and falls back to a hash-pick when the field is null —
  // see TheatrePortraits.resolve().
  res.json({
    profiles: profiles.profiles.map(p => ({
      id: p.id,
      nick: p.nick,
      avatar: normalizeAvatar(p.avatar),
      kidsBirthYear: p.kidsBirthYear || null,
    })),
  });
});

// Create a new profile. Returns the new id so the picker can flip to
// it immediately. No role enforcement yet — anyone with household
// access can add a profile (matches Netflix's model where any
// household member can add a profile on the picker).
// Birth year is stored instead of age so the child's profile ages
// up automatically (an 8-year-old today is a 10-year-old in two
// years without anyone touching settings). Accept anything from
// 1980 to next year; the client decides the resulting age bucket.
function normalizeBirthYear(v) {
  const thisYear = new Date().getFullYear();
  if (!Number.isFinite(v)) return null;
  const n = Math.floor(v);
  if (n < 1980 || n > thisYear + 1) return null;
  return n;
}

app.post("/api/profiles", express.json(), (req, res) => {
  const b = req.body || {};
  const nick = String(b.nick || "").trim().slice(0, 32);
  if (!nick) return res.status(400).json({ error: "nick required" });
  const avatar = normalizeAvatar(b.avatar);
  const kidsBirthYear = normalizeBirthYear(b.kidsBirthYear);
  const id = `p${profiles.nextId++}`;
  profiles.profiles.push({ id, nick, avatar, kidsBirthYear, createdAt: Date.now() });
  profileStates.set(id, emptyUserState());
  saveProfilesToDisk();
  scheduleUserStateSave();
  res.json({ ok: true, id });
});

// Update an existing profile's nickname / avatar / kidsBirthYear.
app.patch("/api/profiles/:id", express.json(), (req, res) => {
  const p = findProfile(req.params.id);
  if (!p) return res.status(404).json({ error: "unknown profile" });
  const b = req.body || {};
  if (typeof b.nick === "string") {
    const nick = b.nick.trim().slice(0, 32);
    if (nick) p.nick = nick;
  }
  if (typeof b.avatar === "string") {
    const a = normalizeAvatar(b.avatar);
    if (a) p.avatar = a;
  }
  if (b.kidsBirthYear === null) p.kidsBirthYear = null;
  else if (Number.isFinite(b.kidsBirthYear)) {
    const y = normalizeBirthYear(b.kidsBirthYear);
    if (y !== null) p.kidsBirthYear = y;
  }
  saveProfilesToDisk();
  res.json({ ok: true });
});

// Delete a profile + wipe its state. Refuses if it's the last
// remaining profile — there's always at least one.
app.delete("/api/profiles/:id", (req, res) => {
  const idx = profiles.profiles.findIndex(p => p.id === req.params.id);
  if (idx < 0) return res.status(404).json({ error: "unknown profile" });
  if (profiles.profiles.length === 1) {
    return res.status(400).json({ error: "cannot delete last profile" });
  }
  profiles.profiles.splice(idx, 1);
  profileStates.delete(req.params.id);
  saveProfilesToDisk();
  scheduleUserStateSave();
  // If the requester was on this profile, clear their cookie so the
  // next request bounces them back to the picker.
  if (getRequestProfileId(req) === req.params.id) clearProfileCookie(req, res);
  res.json({ ok: true });
});

// Pick a profile. Sets the cookie and redirects (or JSON-replies).
app.post("/api/profile/select", express.json(), (req, res) => {
  const id = String(req.body?.id || req.query?.id || "");
  if (!findProfile(id)) return res.status(404).json({ error: "unknown profile" });
  setProfileCookie(req, res, id);
  if ((req.headers.accept || "").includes("application/json")) {
    return res.json({ ok: true });
  }
  res.redirect(302, "/");
});

// Force browsers to revalidate static assets on every request via
// ETag rather than serving stale bytes from disk cache. Without this,
// app.js / style.css / profile-pick.html can stick around for hours
// after a deploy and a user can hit a half-deployed app — exactly the
// kind of bug that lets the OLD profile-pick.html (no localStorage
// wipe) leak the previous profile's data into the new one even after
// the fix has shipped. ETags do their job; no-cache just guarantees
// the browser asks every time.
app.use(express.static(path.join(__dirname, "public"), {
  setHeaders: (res) => {
    res.setHeader("Cache-Control", "no-cache, must-revalidate");
  },
}));

app.get("/api/account", async (_req, res, next) => {
  try { res.json(await xtream("")); } catch (e) { next(e); }
});

app.get("/api/bootstrap", async (req, res, next) => {
  // No browser cache for the same reasons as /api/home — bootstrap
  // carries the active profile + userState and a stale response leaks
  // the previous profile's data after a switch.
  res.set("Cache-Control", "no-store");
  try {
    const [account, liveCats, movieCats, seriesCats] = await Promise.all([
      xtream("").catch(() => null),
      xtream(MODES.live.cats).catch(() => null),
      xtream(MODES.movie.cats).catch(() => null),
      xtream(MODES.series.cats).catch(() => null),
    ]);
    // Update the cached account snapshot — used by streamUrl() to honor
    // user_info.allowed_output_formats and by clients to surface
    // exp_date as a "panel expires in N days" hint.
    if (account && account.user_info) lastAccountInfo = account;
    const pickCats = (mode, fresh) => {
      if (Array.isArray(fresh)) {
        saveCategoriesToDisk(mode, fresh);
        rebuildCategoryTags(mode, fresh);
        return fresh;
      }
      const fromDisk = loadCategoriesFromDiskSync(mode);
      if (fromDisk && fromDisk.length) rebuildCategoryTags(mode, fromDisk);
      return fromDisk;
    };
    // Bootstrap returns ONLY the active profile's state. Profile list
    // is fetched separately via /api/profiles when the picker / settings
    // page needs it.
    const activeProfile = findProfile(req.profileId) || profiles.profiles[0];
    res.json({
      account,
      categories: {
        live:   pickCats("live",   liveCats),
        movie:  pickCats("movie",  movieCats),
        series: pickCats("series", seriesCats),
      },
      index: {
        live:   { total: indexes.live.total,   done: indexes.live.done,   ready: indexes.live.ready },
        movie:  { total: indexes.movie.total,  done: indexes.movie.done,  ready: indexes.movie.ready },
        series: { total: indexes.series.total, done: indexes.series.done, ready: indexes.series.ready },
      },
      lastPlayed,
      profile: activeProfile && {
        id: activeProfile.id,
        nick: activeProfile.nick,
        avatar: normalizeAvatar(activeProfile.avatar),
        kidsBirthYear: activeProfile.kidsBirthYear || null,
      },
      userState: getProfileState(activeProfile ? activeProfile.id : "p1"),
      // Authoritative chip-filter and kids-cert configuration. Both
      // web and Android TV clients consume this — they hold a fallback
      // table for graceful degradation against an older server, but
      // when this field is present it wins. Adding a new language /
      // country / genre is a server-only change after this.
      filterConfig: {
        groups: [
          ...CHANNEL_GROUPS.map(g => ({
            key: g.key,
            label: CHIP_LABELS[g.key] || g.key,
            kind: CHIP_KINDS[g.key] || "other",
          })),
          // Residual bucket for streams whose category matches no
          // CHANNEL_GROUPS regex. categoryTagsFor returns ["other"]
          // for these, and we want users to be able to pick it as a
          // filter chip just like any other group. Tail-position
          // matches the historical client-side ordering.
          { key: "other", label: "Other", kind: "residual" },
        ],
        syntheticTags: ["4k", "movies", "entertainment"],
        nonEntertainmentTags: [...NON_ENTERTAINMENT_KEYS],
        kidsCertTiers: KIDS_CERT_TIERS,
      },
    });
  } catch (e) { next(e); }
});

// Pre-built home rails per profile. Mirrors what the web client's
// renderRails() composes — Continue Watching, My List, Favorites,
// Recently Played, then one rail per onboarded-filtered category —
// but does the work server-side so weak TV clients don't have to
// download the full 19.7 MB catalog and iterate it in Compose.
//
// Each item carries a pre-sized TMDB poster URL (w185 for tiles,
// w342/w780 on hero) so the client doesn't fan out one /api/poster
// fetch per visible tile. Cap is 12 items per rail to keep the JSON
// payload small (~50 KB end-to-end vs 19.7 MB).
//
// Server-side category-group matching uses the same regex table the
// web client has in public/app.js — kept in lockstep so a category
// that ends up under "USA" on the web shows up under "USA" on the TV.
// Source of truth: this list. The web's GROUPS array mirrors it.
const CHANNEL_GROUPS = [
  // Languages
  { key: "english", patterns: [/\benglish\b/i, /\bblockbuster\b/i, /\boscar\b/i] },
  { key: "hindi", patterns: [
    /\bhindi\b/i, /bollywood/i,
    /\bstar plus\b/i, /\bstar bharat\b/i, /\bzee tv\b/i, /\bcolors hindi\b/i,
    /\bsony \(set\)\b/i, /\bsab\b/i, /\band tv\b/i, /\bmtv hindi\b/i, /\bepic tv\b/i,
    /\bsony liv\b/i, /\bdisney.*hotstar\b/i, /\bzee5\b/i, /\bjio cinema\b/i,
    /\bvoot\b/i, /\bmx player\b/i, /\bhungama play\b/i,
    /\btvf\b/i, /\bullu\b/i, /\beros now\b/i, /\bjio\b/i,
    /\baandetv\b/i, /\bbigg boss\b/i, /shemaroo/i, /\bhangama\b/i,
    /\baddatimes\b/i, /\bgreen tv\b/i, /\bsony aath\b/i, /amazon mini\b/i,
    /\bwaves ott\b/i, /\bsaregama\b/i, /lionsgate play/i,
    /\bgemplex\b/i, /\bnews nation\b/i,
  ]},
  { key: "punjabi", patterns: [/punjabi/i] },
  { key: "tamil",   patterns: [/\btamil\b/i, /\bstar vijay\b/i, /\bsun tamil\b/i, /\bzee tamil\b/i] },
  { key: "telugu",  patterns: [/\btelugu\b/i, /\bgemini\b/i, /\bstar maa\b/i, /\bzee telugu\b/i, /\betv\b/i, /\baha\b/i] },
  { key: "malayalam", patterns: [/malayalam/i, /asianet/i, /\bsurya\b/i] },
  { key: "kannada", patterns: [/kannada/i, /star suvarna/i] },
  { key: "marathi", patterns: [/marathi/i, /star pravah/i] },
  { key: "gujarati", patterns: [/gujarati/i] },
  { key: "bengali", patterns: [/\bbangla\b/i, /bengali/i, /jalsha/i] },
  { key: "urdu",    patterns: [/\burdu\b/i] },
  { key: "arabic",  patterns: [/arabic/i, /\bbein\b/i, /\bmbc\b/i] },
  // Countries
  { key: "us",      patterns: [/\busa?\b/i, /america/i, /\bnfl\b/i, /\bmlb\b/i, /\bnba\b/i, /\bmls\b/i, /\bnhl\b/i, /netflix/i, /\bhbo\b/i, /amazon prime/i, /\bdisney\b/i, /starz/i, /\bhulu\b/i, /\bpeacock\b/i] },
  { key: "india",   patterns: [/\bindia\b/i, /\bindian\b/i, /\bipl\b/i, /\bhub premier\b/i, /cricket/i] },
  { key: "pakistan", patterns: [/pakistan/i, /\bptv\b/i, /\bary\b/i, /\bgeo\b/i, /\bhum tv\b/i, /\bexpress tv\b/i, /aplus/i, /\baan\b/i, /aur life/i, /play entertainment/i, /\bmun tv\b/i, /\btv one\b/i, /apna/i, /kashmir/i, /dunya/i, /\bsamaa\b/i, /\burdu\b/i, /cricket/i, /\bpsl\b/i] },
  { key: "uk",      patterns: [/\buk\b/i, /\bbritish\b/i, /\bbbc\b/i, /sky uk/i] },
  { key: "canada",  patterns: [/canada/i, /canadian/i, /\bctv\b/i] },
  { key: "australia", patterns: [/australia/i, /australian/i, /fox australia/i, /\bdstv\b/i] },
  // Genres
  { key: "sports", patterns: [/\bsports?\b/i, /cricket/i, /football/i, /soccer/i, /tennis/i, /\bgolf\b/i, /rugby/i, /racing/i, /\bf1\b/i, /motogp/i, /\bnfl\b/i, /\bmlb\b/i, /\bnba\b/i, /\bmls\b/i, /\bnhl\b/i, /\bepl\b/i, /\bipl\b/i, /\bpsl\b/i, /world cup/i, /\bfifa\b/i, /\bufc\b/i, /boxing/i, /wrestling/i, /\bwwe\b/i] },
  { key: "kids",   patterns: [/\bkids\b/i, /cartoon/i, /\bcbeebies\b/i, /nickelodeon/i, /\bnick jr\b/i, /\bbaby\b/i, /\btoddler\b/i] },
  { key: "news",   patterns: [/\bnews\b/i] },
  { key: "music",  patterns: [/\bmusic\b/i, /\bmtv\b/i, /\bvh1\b/i, /\bvevo\b/i, /\bmusik\b/i, /\b9xm\b/i, /\bb4u music\b/i, /\bsangeet\b/i] },
];

// Synthetic chip patterns (not in CHANNEL_GROUPS — they're guide-only
// flags layered on top of group membership). Movies + 4K become extra
// tags; "entertainment" is derived as "not movies AND no non-ent group".
const MOVIES_PATTERNS = [/\bmovies?\b/i, /\bcinema\b/i];
const FOURK_PATTERNS = [/\b4k\b/i, /\buhd\b/i, /\b2160p?\b/i, /\(2160\)/i];
const NON_ENTERTAINMENT_KEYS = new Set(["sports", "news", "kids", "music", "movies"]);
// CHANNEL_GROUPS keys whose names also appear as language indicators
// inside title strings (e.g. "Mufasa (2024) [Telugu]"). Used by the
// home endpoint to drop dub items that the user's profile didn't opt
// into. Country / genre keys are excluded — "USA" / "kids" rarely
// appears in the title to indicate exclusion.
const LANGUAGE_GROUP_KEYS = [
  "english", "hindi", "tamil", "telugu", "malayalam", "kannada",
  "marathi", "gujarati", "bengali", "urdu", "punjabi", "arabic",
];
const LANGUAGE_GROUP_KEYS_SET = new Set(LANGUAGE_GROUP_KEYS);

// Alternate title words that panels use for the same language.
// Key = LANGUAGE_GROUP_KEYS entry, value = extra words to block.
const LANGUAGE_TITLE_ALIASES = {
  bengali: ["bangla"],
};

// Returns a function that returns false when a title contains a language
// word the user hasn't opted into. Used by /api/home, /api/streams, and
// /api/index so the title-language guard is consistently applied to all clients.
function makeTitleLangFilter(onboardedKeys) {
  if (!onboardedKeys || onboardedKeys.size === 0) return () => true;
  // Pre-build one regex per unselected language (key + aliases).
  const patterns = [];
  for (const lang of LANGUAGE_GROUP_KEYS) {
    if (onboardedKeys.has(lang)) continue;
    const words = [lang, ...(LANGUAGE_TITLE_ALIASES[lang] || [])];
    patterns.push(new RegExp(`\\b(${words.join("|")})\\b`, "i"));
  }
  if (!patterns.length) return () => true;
  return (name) => {
    if (!name) return true;
    for (const re of patterns) if (re.test(name)) return false;
    return true;
  };
}

// Region → default language fallback. Panels routinely file content
// under a country bucket ("INDIAN NEWS", "PAKISTAN NEWS", "UAE") with
// no language hint in the category name. The vast majority of channels
// in those buckets are the region's primary language by default, so we
// add it automatically — but ONLY when no language tag is already
// present. "INDIAN ENGLISH MOVIES" stays English; "INDIAN ENTERTAINMENT"
// gets Hindi. The XX:-prefix layer at the per-channel level overrides
// this for individual channels that aren't actually in the default
// language.
const REGION_DEFAULT_LANGUAGE = {
  india:     "hindi",
  pakistan:  "urdu",
};

// Per-channel name-prefix → tags. Many panel feeds prefix the channel
// name with a 1–5-letter language/country code, either at the start
// ("IN: REPUBLIC BHARAT", "TM: KAIRALI NEWS HD") or after a pipe in
// the alternate "<genre> | <lang>: <name>" form ("News | Ar: Al
// Jazeera", "Kids | En: NickToons HD"). The capture is the strongest
// per-channel language signal the panel gives us — much more reliable
// than category regex when the panel files everything under a generic
// bucket like INDIAN NEWS. Order: more-specific codes first so KAND
// is checked before KA, USA before US, etc.
const CHANNEL_NAME_PREFIX_MAP = [
  // South Asian languages
  { codes: ["IN"],                  tags: ["hindi",     "india"] },
  { codes: ["TAMIL", "TM"],         tags: ["tamil",     "india"] },
  { codes: ["TG", "TE"],            tags: ["telugu",    "india"] },
  { codes: ["MAL", "ML"],           tags: ["malayalam", "india"] },
  { codes: ["MY"],                  tags: ["malayalam", "india"] },
  { codes: ["KAND", "KN"],          tags: ["kannada",   "india"] },
  { codes: ["MR"],                  tags: ["marathi",   "india"] },
  { codes: ["GUJ", "GU"],           tags: ["gujarati",  "india"] },
  { codes: ["BNG", "BN", "BD"],     tags: ["bengali"] },
  { codes: ["PB", "PA"],            tags: ["punjabi",   "india"] },
  { codes: ["URDU", "UR"],          tags: ["urdu"] },
  // Pakistan
  { codes: ["PK"],                  tags: ["urdu",      "pakistan"] },
  // Arabic
  { codes: ["UAE"],                 tags: ["arabic"] },
  { codes: ["AR"],                  tags: ["arabic"] },
  // Anglophone
  { codes: ["USA", "US"],           tags: ["english",   "us"] },
  { codes: ["UKFHD", "UKHD", "UKSD", "UK"], tags: ["english", "uk"] },
  { codes: ["CA"],                  tags: ["english",   "canada"] },
  { codes: ["AU"],                  tags: ["english",   "australia"] },
  { codes: ["EN"],                  tags: ["english"] },
];
const CHANNEL_PREFIX_CODE_INDEX = (() => {
  const m = new Map();
  for (const entry of CHANNEL_NAME_PREFIX_MAP) {
    for (const code of entry.codes) m.set(code.toUpperCase(), entry.tags);
  }
  return m;
})();
// Match either start-of-name ("IN: …") OR after a pipe ("News | Ar:
// …"). The 1–5-letter cap rejects long words like "INDIAN" or "BANGLA"
// (those are caught by category regex anyway). Whitespace allowance
// on both sides of the colon accepts "UK : SKY SPORTS"-style spacing.
const CHANNEL_PREFIX_RE = /(?:^|\|\s*)([A-Za-z]{1,5})\s*:\s/;

// Display labels for every CHANNEL_GROUPS key, plus a `kind`
// classification that lets the chip strip group buckets visually
// (languages | countries | genres) in onboarding. This is the single
// source of truth for chip labels — both clients (web + Android TV)
// read these via the filterConfig field on /api/bootstrap. Adding a
// new CHANNEL_GROUPS entry only requires adding a matching label + kind
// here; no client release needed.
const CHIP_LABELS = {
  english: "English", hindi: "Hindi", punjabi: "Punjabi", tamil: "Tamil",
  telugu: "Telugu", malayalam: "Malayalam", kannada: "Kannada", marathi: "Marathi",
  gujarati: "Gujarati", bengali: "Bengali", urdu: "Urdu", arabic: "Arabic",
  us: "USA", india: "India", pakistan: "Pakistan", uk: "UK",
  canada: "Canada", australia: "Australia",
  sports: "Sports", kids: "Kids", news: "News", music: "Music",
};
const CHIP_KINDS = {
  english: "language", hindi: "language", punjabi: "language", tamil: "language",
  telugu: "language", malayalam: "language", kannada: "language", marathi: "language",
  gujarati: "language", bengali: "language", urdu: "language", arabic: "language",
  us: "country", india: "country", pakistan: "country", uk: "country",
  canada: "country", australia: "country",
  sports: "genre", kids: "genre", news: "genre", music: "genre",
};

// Kids cert filtering lives in lib/kids-filter.js so it can be
// unit-tested in isolation. KIDS_CERT_TIERS is the source of truth
// for which us_cert values are allowed at each age. Exposed in
// filterConfig so the client doesn't have to ship a copy of the
// table. `makeKidsBlocker(profile)` is the predicate factory used
// by every endpoint that ships streams to the client so kid
// filtering is uniform across rails, search, index, and per-mode
// streams.
const { KIDS_CERT_TIERS, makeKidsBlocker } = require("./lib/kids-filter");

// "<genre> | <lang>: <name>" is a common alternate convention where
// the word BEFORE the pipe is the genre hint ("News | Ar: Al Jazeera",
// "Sport | Ar: Abu Dhabi Sports", "Kids | En: NickToons"). The pre-pipe
// text is run against CHANNEL_GROUPS so news/sports/kids/music get
// surfaced even when the category bucket is generic ("SPORTS | ARABIC"
// doesn't say news, but every Al-Jazeera-style channel in it does).
const CHANNEL_PREPIPE_RE = /^([A-Za-z]{2,12})\s*\|\s*[A-Za-z]{1,5}\s*:\s/;

// Compute the full tag set for a category name in one regex pass. Tags
// returned: language/country/genre group keys + synthetic flags
// ("movies", "4k", "entertainment"). Always returns at least one tag
// — "other" when nothing matches. Both clients consume this set as a
// flat string array on each stream so chip toggles become O(1)
// membership checks instead of running regexes in the UI thread.
function categoryTagsFor(catName) {
  if (!catName) return ["other"];
  const s = String(catName);
  const groups = [];
  for (const g of CHANNEL_GROUPS) {
    if (g.patterns.some(re => re.test(s))) groups.push(g.key);
  }
  // Regional-default language. "INDIAN NEWS" / "PAKISTAN NEWS" / "UAE"
  // have a country tag but no language; selecting hindi+news / urdu+news
  // would return zero. Default the country's primary language ONLY when
  // no language is already in the set (so "INDIAN ENGLISH MOVIES" stays
  // English). The per-channel XX:-prefix layer further refines this for
  // individual channels that aren't in the regional default.
  const hasLang = groups.some(k => LANGUAGE_GROUP_KEYS_SET.has(k));
  if (!hasLang) {
    for (const k of groups) {
      const def = REGION_DEFAULT_LANGUAGE[k];
      if (def && !groups.includes(def)) groups.push(def);
    }
  }
  const isMovies = MOVIES_PATTERNS.some(re => re.test(s));
  const is4k = FOURK_PATTERNS.some(re => re.test(s));
  const out = [...groups];
  // Residual "other" tag — surfaces categories that match no explicit
  // language/country/genre group. Lets users opt into the long-tail via
  // the Region/language filter modal's "Other" chip. Separate concern
  // from the entertainment derivation below — a category can be both
  // "other" (no group key matched) AND "entertainment" (no non-ent
  // marker fired). Example: "BRASIL", "FRENCH", "RUSSIAN MUSIC TV".
  if (!groups.length) out.push("other");
  if (isMovies) out.push("movies");
  if (is4k) out.push("4k");
  // "entertainment" = neither a movies channel nor part of any other
  // "utility" genre (sports/news/kids/music). Means general programming
  // — what shows on the chip filter when the user wants the residual.
  const hasNonEnt = isMovies || groups.some(k => NON_ENTERTAINMENT_KEYS.has(k));
  if (!hasNonEnt) out.push("entertainment");
  return out.length ? out : ["other"];
}

// Merge category-derived tags with stream-name-derived synthetic
// flags. Some markers (4K resolution, music channels, movies) sit in
// the channel name even when the category is a generic bucket — so
// we scan both. The "entertainment" derived tag is re-evaluated
// against the combined set so e.g. "Sun Music" leaves the entertainment
// bucket once "music" is added.
function streamTagsFor(streamName, catTags) {
  const name = String(streamName || "");
  const set = new Set(catTags);
  // Music channels often live in language buckets ("Tamil – Movies &
  // Music"), so their category alone doesn't carry the music tag.
  // Group regexes have their own music patterns; reuse them here.
  const musicGroup = CHANNEL_GROUPS.find(g => g.key === "music");
  const has4k = FOURK_PATTERNS.some(re => re.test(name));
  const hasMovies = MOVIES_PATTERNS.some(re => re.test(name));
  const hasMusic = musicGroup ? musicGroup.patterns.some(re => re.test(name)) : false;
  if (has4k) set.add("4k");
  if (hasMovies) set.add("movies");
  if (hasMusic) set.add("music");
  // XX:-prefix layer. Per-channel language code is the strongest signal
  // the panel gives us. When present, the language tag is authoritative
  // — strip any other language tag inherited from the category (so a
  // "TE: …" Telugu channel filed under "INDIA HINDI MOVIES" drops the
  // hindi tag and gains telugu). Country tags are additive.
  const prefixMatch = name.match(CHANNEL_PREFIX_RE);
  if (prefixMatch) {
    const tags = CHANNEL_PREFIX_CODE_INDEX.get(prefixMatch[1].toUpperCase());
    if (tags) {
      const langFromPrefix = tags.filter(t => LANGUAGE_GROUP_KEYS_SET.has(t));
      if (langFromPrefix.length) {
        for (const lang of LANGUAGE_GROUP_KEYS) {
          if (!langFromPrefix.includes(lang)) set.delete(lang);
        }
      }
      for (const t of tags) set.add(t);
    }
  }
  // Pre-pipe genre hint. "News | Ar: Al Jazeera HD" tells us the
  // channel is news even though category "SPORTS | ARABIC" only says
  // sports. Run the word before the pipe against CHANNEL_GROUPS so the
  // matching genre key (news/sports/kids/music) lands as a tag.
  const prePipeMatch = name.match(CHANNEL_PREPIPE_RE);
  if (prePipeMatch) {
    const word = prePipeMatch[1];
    for (const g of CHANNEL_GROUPS) {
      if (g.patterns.some(re => re.test(word))) set.add(g.key);
    }
  }
  // Recompute "entertainment" against the merged set: any
  // non-entertainment marker (sports/news/kids/music/movies)
  // disqualifies the channel from the residual bucket.
  let isEnt = !(set.has("movies") || set.has("sports") || set.has("news") || set.has("kids") || set.has("music"));
  if (isEnt) set.add("entertainment"); else set.delete("entertainment");
  return [...set];
}

// Per-mode lookup table: category_id (as string) → tag array. Rebuilt
// every time a category list lands (boot, periodic refresh, /refresh).
// Populated synchronously so projectStream() can hit it on the hot
// path without async fan-out per stream.
const tagsByCategory = { live: new Map(), movie: new Map(), series: new Map() };

function rebuildCategoryTags(mode, cats) {
  if (!Array.isArray(cats)) return;
  const m = new Map();
  for (const c of cats) {
    if (c?.category_id == null) continue;
    m.set(String(c.category_id), categoryTagsFor(c.category_name));
  }
  tagsByCategory[mode] = m;
}

// Backwards-compat shim — the home endpoint still calls homeGroupKeysOf
// against onboarded language/country keys. Returns just the GROUP
// keys (no synthetic flags) so the existing onboarded-filter logic
// keeps the same semantics.
function homeGroupKeysOf(catName) {
  if (!catName) return ["other"];
  const out = [];
  for (const g of CHANNEL_GROUPS) if (g.patterns.some(re => re.test(catName))) out.push(g.key);
  return out.length ? out : ["other"];
}

app.get("/api/home/:mode(live|movie|series)", (req, res) => {
  // No browser cache — the response varies per profile + per filter
  // change + per server-side rule update (e.g. title-language guard).
  // Without this, browsers serve stale rails after a profile switch
  // or a deploy, and users see content the new code would have
  // filtered out.
  res.set("Cache-Control", "no-store");
  const mode = req.params.mode;
  const userState = getProfileState(req.profileId);
  const activeProfile = findProfile(req.profileId);
  const kidsAge = (() => {
    const by = activeProfile?.kidsBirthYear;
    if (!by) return null;
    const age = new Date().getFullYear() - by;
    return Number.isFinite(age) ? age : null;
  })();
  const allowedKidCerts = kidsAge === null ? null : (() => {
    const s = new Set();
    for (const tier of KIDS_CERT_TIERS) {
      if (kidsAge >= tier.minAge) tier.add.forEach(c => s.add(c));
    }
    return s;
  })();
  // Allow-list: hero needs an explicit kid-safe cert (used only for
  // the most prominent placement). Block-list (`isKidBlocked`) is
  // used for everything else — see `makeKidsBlocker`.
  const isKidSafe = (tile) => {
    if (allowedKidCerts === null) return true;
    if (!tile.us_cert) return false;
    return allowedKidCerts.has(tile.us_cert);
  };
  const isKidBlocked = makeKidsBlocker(activeProfile);
  const ix = indexes[mode];

  // Cheap poster URL lookups out of the existing TMDB cache so the
  // client gets a CDN URL inline and never has to fan out a request
  // per tile. Sizes follow TMDB's API: w185 ≈ 2:3 tile at 140 dp,
  // w342 for slightly larger detail-poster, w780 for backdrops.
  const tmdbFor = (id) => tmdbCache[`${mode}:${id}`];
  // Soft-NR: when TMDB has no US cert but the rail's category name
  // strongly implies kid content, treat the item as "G" so kid
  // profiles see the rail at all. Conservative — we only fire on
  // explicit kid markers (kids/cartoon/animation/toddler/family etc.),
  // not on general "entertainment" buckets, and never overrides a
  // real cert (TMDB's R-rated answer always wins).
  const KID_CAT_RE = /\bkids?\b|\bcartoon\b|\banimat|\btoddler\b|\bbaby\b|\bfamily\b|disney|pixar|nick\s*jr|cbeebies|nickelodeon|toon/i;
  const tileFor = (s, catName) => {
    if (!s) return null;
    const t = tmdbFor(s.id);
    let cert = t?.us_cert || null;
    if (!cert && mode === "movie" && catName && KID_CAT_RE.test(catName)) {
      cert = "G";
    }
    return {
      id: s.id,
      name: s.name,
      icon: s.icon || null,
      year: s.year || null,
      // w154 ≈ 154 px wide vs the 140-dp tile, so 1:1 with minimal
      // upscale. Earlier w185 forced the TV's Coil to decode bitmaps
      // ~40% larger than the tile needs, which the GC measurements
      // pinned as the main jank source on Chromecast silicon.
      poster: t?.poster_path ? `https://image.tmdb.org/t/p/w154${t.poster_path}` : null,
      us_cert: cert,
      // Pre-computed group/genre/4K tags. Lets the chip strip on
      // Movies / Series filter rails client-side without re-running
      // the GROUPS regex table per tile.
      tags: s.tags || ["other"],
      // The container ext (mp4 / mkv / avi). Clients use this to
      // surface an "MKV" badge on tiles that will go through the
      // server transcoder — sets expectations for the slower start.
      container: s.container || null,
    };
  };
  const heroFor = (s) => {
    if (!s) return null;
    const t = tmdbFor(s.id);
    return {
      id: s.id,
      name: s.name,
      icon: s.icon || null,
      year: s.year || null,
      plot: t?.plot || s.plot || null,
      poster: t?.poster_path ? `https://image.tmdb.org/t/p/w342${t.poster_path}` : null,
      // w1280 (vs w780) — at the taller hero size, w780 was visibly
      // upscaled on wide monitors. w1280 is the next TMDB step up
      // and is the right size for a 1440p-ish hero with the 1.05
      // zoom transform applied.
      backdrop: t?.backdrop_path ? `https://image.tmdb.org/t/p/w1280${t.backdrop_path}` : null,
      rating: t?.rating || null,
      runtime: t?.runtime || null,
      us_cert: t?.us_cert || null,
    };
  };

  // Onboarded category filter. Same shape the web's
  // filteredLiveChannels() uses — only categories whose group keys
  // intersect the user's picks are eligible. Falls through to "all
  // visible" if the user never onboarded or picked nothing.
  // Onboarding always sets live picks first; movie/series may be left
  // blank if the user finished onboarding without filling those tabs.
  // Treating empty as "no filter" dumped every category into the home
  // rails — e.g. a kids profile that picked English/US/Kids on Live
  // would still see Tamil / Hindi movie rails. Fall back to the live
  // picks for movie/series when the per-mode list is empty.
  const modeKeys = (() => {
    const own = userState.filter?.groups?.[mode];
    if (Array.isArray(own) && own.length) return own;
    const liveKeys = userState.filter?.groups?.live;
    if (Array.isArray(liveKeys) && liveKeys.length) return liveKeys;
    return [];
  })();
  const onboardedKeys = new Set(modeKeys);
  const onboarded = !!userState.filter?.onboarded && onboardedKeys.size > 0;
  const cats = loadCategoriesFromDiskSync(mode); // array of {category_id, category_name}
  const allowedCatIds = new Set();
  if (!onboarded) {
    for (const c of cats) allowedCatIds.add(String(c.category_id));
  } else {
    for (const c of cats) {
      if (homeGroupKeysOf(c.category_name).some(k => onboardedKeys.has(k))) {
        allowedCatIds.add(String(c.category_id));
      }
    }
  }

  const titleLangPasses = onboarded ? makeTitleLangFilter(onboardedKeys) : () => true;

  // Group eligible items by category in one pass over the index.
  const byCat = new Map();
  for (const s of ix.byId.values()) {
    const cid = String(s.category_id || "");
    if (!allowedCatIds.has(cid)) continue;
    if (!titleLangPasses(s.name)) continue;
    let bucket = byCat.get(cid);
    if (!bucket) { bucket = []; byCat.set(cid, bucket); }
    bucket.push(s);
  }
  // For kid profiles: sort each bucket so cert-passing items come first,
  // then slice to 12. Without this the cap picks the first 12 by index
  // insertion order and kid-safe items (e.g. WrestleMania PG) that sit
  // beyond position 12 never make it into the rail.
  const sliceBucket = (bucket, catName) => {
    if (allowedKidCerts !== null) {
      const isKidCategory = !!catName && KID_CAT_RE.test(catName);
      bucket = bucket.filter(s => {
        if (s.us_cert) return allowedKidCerts.has(s.us_cert);
        return isKidCategory;
      });
    }
    // Walk the bucket dedup'ing by tmdb_id; track the eligible total
    // (post-filter, post-dedup) so the client can show "12 of 87"
    // counts on each rail. Cap the visible window at 12.
    const seenTmdb = new Set();
    const out = [];
    let totalEligible = 0;
    for (const s of bucket) {
      if (s.tmdb_id) {
        if (seenTmdb.has(s.tmdb_id)) continue;
        seenTmdb.add(s.tmdb_id);
      }
      totalEligible++;
      if (out.length < 12) out.push(s);
    }
    return { items: out, total: totalEligible };
  };
  const catName = new Map(cats.map(c => [String(c.category_id), c.category_name]));
  // Stash the sliced items + the full eligible total per category so
  // rails can render "(N)" next to the title.
  const bucketTotals = new Map();
  for (const [cid, bucket] of byCat) {
    const r = sliceBucket(bucket, catName.get(String(cid)));
    byCat.set(cid, r.items);
    bucketTotals.set(cid, r.total);
  }

  const rails = [];

  // Continue Watching — newest-first by `t`. progress is per-profile,
  // keyed as "mode:id". Live mode has no concept of position so
  // it's skipped there. Title-language guard applies here too so a
  // wrong-language item left over in progress / favorites / recents
  // (e.g. from a previous profile-state leak) doesn't keep showing.
  // User-curated rails: gate by `isKidSafe` (strict allow-list) so a
  // leftover R/TV-MA in My List or progress can't surface on a kid
  // profile. Also gated by the title-language guard.
  //
  // For the on-rail "total" count, we report the full eligible set
  // size (post-filtering) — i.e. how many CW/MyList/Favs items in
  // this mode survive the kid-cert + title-language gates — so the
  // header can say "My List (87)" even though the rail only shows 12.
  const eligibleFromIds = (ids) => (ids || [])
    .map(id => ix.byId.get(id))
    .filter(s => s && titleLangPasses(s.name))
    .map(s => tileFor(s))
    .filter(t => t && isKidSafe(t));

  if (mode !== "live") {
    const cwIds = Object.entries(userState.progress || {})
      .filter(([k]) => k.startsWith(mode + ":"))
      .sort((a, b) => (b[1]?.t || 0) - (a[1]?.t || 0))
      .map(([k]) => parseInt(k.split(":", 2)[1], 10));
    const cwEligible = eligibleFromIds(cwIds);
    if (cwEligible.length) {
      rails.push({
        title: "Continue Watching",
        total: cwEligible.length,
        items: cwEligible.slice(0, 12),
      });
    }
  }

  const userRail = (title, ids) => {
    const eligible = eligibleFromIds(ids);
    if (!eligible.length) return null;
    return { title, total: eligible.length, items: eligible.slice(0, 12) };
  };
  const myListRail  = userRail("My List",          userState.myList?.[mode]);
  const favsRail    = userRail("Favorites",        userState.favorites?.[mode]);
  const recentsRail = userRail("Recently Played",  userState.recents?.[mode]);
  if (myListRail)  rails.push(myListRail);
  if (favsRail)    rails.push(favsRail);
  if (recentsRail) rails.push(recentsRail);

  // ── Smart (TMDB-derived) rails ─────────────────────────────────────
  // Replaces the panel's gunky category soup ("INDIAN MOVIES HINDI
  // OLD 80'S") with a curated, Netflix-style mix sourced from the
  // tmdbCache we already populate for posters / metadata: by genre,
  // by decade, by quality bucket. Items that survive the kid + title-
  // language gates AND have a TMDB hit go into the candidate pool.
  // Rails with fewer than `minRail` items are skipped so the home
  // doesn't render half-empty rows on small / niche slices.
  //
  // Each item gets surfaced in exactly ONE smart rail (highest-
  // priority one wins, see surfacedIds) so the home doesn't feel
  // repetitive. The panel-category rails below the smart block still
  // include everything regardless — that's where items without TMDB
  // data ultimately land, and where users who *want* to browse by
  // panel taxonomy can still do so.
  if (mode !== "live") {
    const tmdbBy = (s) => tmdbFor(s.id);
    // Build the pool, deduplicating by tmdb_id so a movie that the
    // panel ships in 5 quality / language / dub variants doesn't take
    // 5 tiles in every smart rail. First eligible variant wins —
    // panel ordering is stable enough that the "primary" listing
    // tends to land first. Items without tmdb_id are skipped entirely
    // (the smart rails are TMDB-driven).
    const pool = [];
    const seenTmdb = new Set();
    for (const s of ix.byId.values()) {
      if (!titleLangPasses(s.name)) continue;
      const t = tmdbBy(s);
      if (!t || t.source === "no-match") continue;
      if (t.tmdb_id) {
        if (seenTmdb.has(t.tmdb_id)) continue;
        seenTmdb.add(t.tmdb_id);
      }
      // Reuse tileFor for the kid-cert + soft-NR logic. catName is
      // null because these tiles came from the smart pool, not a
      // specific panel category.
      const tile = tileFor(s, null);
      if (!tile) continue;
      if (isKidBlocked(tile)) continue;
      pool.push({ s, t, tile });
    }
    // TV Movie is a TMDB genre that lumps in straight-to-streaming
    // / made-for-cable productions, which would crowd out theatrical
    // titles on every genre rail if left in. Drop them from the
    // discovery layer entirely; they still surface via panel rails.
    const notTvMovie = (p) =>
      !(Array.isArray(p.t.genres) && p.t.genres.includes("TV Movie"));

    const surfacedIds = new Set();
    const RAIL_CAP = 40;
    const MIN_RAIL = 15;
    const addRail = (title, items) => {
      const filtered = items.filter(p => !surfacedIds.has(p.s.id)).slice(0, RAIL_CAP);
      if (filtered.length < MIN_RAIL) return;
      for (const p of filtered) surfacedIds.add(p.s.id);
      rails.push({
        title,
        total: items.length,
        items: filtered.map(p => p.tile),
      });
    };

    // Most popular this year — current year by vote_count
    // (popularity isn't in the cache; vote_count is the closest
    // proxy and TMDB scrapes both from the same engagement signal).
    const thisYear = String(new Date().getFullYear());
    addRail(
      `New on Khouch · ${thisYear}`,
      pool
        .filter(p => p.t.year === thisYear)
        .filter(notTvMovie)
        .sort((a, b) => (b.t.vote_count || 0) - (a.t.vote_count || 0)),
    );

    // Critically acclaimed — high rating, real audience size
    addRail(
      "Critically Acclaimed",
      pool
        .filter(p => (p.t.rating || 0) >= 7.5 && (p.t.vote_count || 0) >= 500)
        .filter(notTvMovie)
        .sort((a, b) => (b.t.rating || 0) - (a.t.rating || 0)),
    );

    // Per-genre rails. Order is rough "broad → niche" so the most
    // crowd-pleasing genres land highest on the home. Each title only
    // gets used once across smart rails, so a film tagged Action +
    // Thriller goes into Action (which comes first) and not both.
    for (const g of ["Action", "Comedy", "Drama", "Thriller", "Horror",
                     "Romance", "Science Fiction", "Animation", "Family",
                     "Documentary"]) {
      addRail(g, pool
        .filter(p => Array.isArray(p.t.genres) && p.t.genres.includes(g))
        .filter(notTvMovie)
        .sort((a, b) => (b.t.vote_count || 0) - (a.t.vote_count || 0)));
    }

    // Decade flashbacks — only the most distinctive decades show.
    // Skip 2020s because "New on Khouch" already pulls from there.
    for (const [start, title] of [
      [2010, "Of the 2010s"],
      [1990, "Of the 90s"],
      [1980, "Of the 80s"],
    ]) {
      addRail(title, pool
        .filter(p => {
          const y = parseInt(p.t.year, 10);
          return y >= start && y < start + 10;
        })
        .filter(notTvMovie)
        .sort((a, b) => (b.t.rating || 0) - (a.t.rating || 0)));
    }

    // "Because you watched <title>" — pulls TMDB's recommendations
    // list for the user's most recent play in this mode and surfaces
    // only the items that exist in our catalog. The personalized rail
    // sits high in the smart block because intent-matched
    // recommendations are higher-signal than any genre slice.
    const lastPlayId = (() => {
      const lp = userState.lastPlayed?.[mode];
      if (!lp || typeof lp !== "object") return null;
      let bestId = null, bestT = 0;
      for (const [k, t] of Object.entries(lp)) {
        if (t > bestT) { bestT = t; bestId = parseInt(k, 10); }
      }
      return bestId;
    })();
    if (lastPlayId) {
      const lpEntry = tmdbFor(lastPlayId);
      const recIds = lpEntry && Array.isArray(lpEntry.recommendations) ? lpEntry.recommendations : [];
      if (recIds.length) {
        const recSet = new Set(recIds);
        const recItems = pool
          .filter(p => recSet.has(p.t.tmdb_id))
          .filter(notTvMovie)
          // Preserve TMDB's recommended order (which is itself rough
          // popularity-weighted).
          .sort((a, b) => recIds.indexOf(a.t.tmdb_id) - recIds.indexOf(b.t.tmdb_id));
        const refName = ix.byId.get(lastPlayId)?.name || lpEntry?.tmdb_title || "what you watched";
        const refClean = lpEntry?.tmdb_title || refName.replace(/\s*\(.*$/, "").trim();
        addRail(`Because you watched ${refClean}`, recItems);
      }
    }

    // Franchise rails. TMDB's belongs_to_collection groups items
    // into sagas (MCU, Bond, MI, John Wick, Harry Potter, etc.). We
    // surface a rail per collection that has at least 3 items in
    // the catalog. The collections are ranked by total catalog size
    // so a household with most MCU films sees MCU near the top, but
    // a household with just two Bond films won't get a half-empty
    // "Bond" rail.
    const collMap = new Map(); // id -> { name, items: [] }
    for (const p of pool) {
      const col = p.t.collection;
      if (!col || !col.name) continue;
      if (!collMap.has(col.id)) collMap.set(col.id, { name: col.name, items: [] });
      collMap.get(col.id).items.push(p);
    }
    const ranked = [...collMap.values()]
      .filter(c => c.items.length >= 3)
      .sort((a, b) => b.items.length - a.items.length)
      .slice(0, 6);  // cap so they don't dominate the home
    for (const c of ranked) {
      // Sort within the franchise by year ascending — feels right
      // for sagas (Bond 1, Bond 2, ...). Year is a string in the
      // cache so compare via parseInt with a safe fallback.
      c.items.sort((a, b) => (parseInt(a.t.year, 10) || 0) - (parseInt(b.t.year, 10) || 0));
      addRail(c.name, c.items);
    }

    // Long-tail discovery — high-quality stuff most people haven't
    // heard of (low vote_count). Pinned to the bottom of the smart
    // block so the user has already seen the safer big-name rails.
    addRail("Hidden Gems", pool
      .filter(p => (p.t.rating || 0) >= 7 && (p.t.vote_count || 0) >= 50 && (p.t.vote_count || 0) < 500)
      .filter(notTvMovie)
      .sort((a, b) => (b.t.rating || 0) - (a.t.rating || 0)));
  }

  // Per-category rails, ordered by the original category list so the
  // sequence is stable across reloads.
  for (const c of cats) {
    const items = byCat.get(String(c.category_id));
    if (!items?.length) continue;
    rails.push({
      title: c.category_name,
      // category_id lets the Android / phone clients open a "See all"
      // view for that rail. The web client doesn't use this — it has
      // the full index in memory and navigates via its own routing.
      category_id: String(c.category_id),
      total: bucketTotals.get(String(c.category_id)) || items.length,
      items: items.map(s => tileFor(s, c.category_name)),
    });
  }

  // Hero pool — *discovery* only. Continue-Watching items are
  // deliberately excluded: the resume CTA on the user's currently-
  // playing title was eating every hero slot, so for weeks the hero
  // was the same handful of in-progress movies. The Continue
  // Watching rail still surfaces them; the hero is for "what's
  // new I haven't tried yet".
  //
  // Skim 5 items per filtered category (up to 40), then shuffle
  // with a per-day, per-profile, per-mode seed. Same all day so
  // caching/intra-day re-renders are stable; different next day,
  // and different across members of the same household.
  const seen = new Set();
  // Exclude in-progress titles from candidates so they never sneak
  // back in via the category skim.
  if (mode !== "live") {
    for (const k of Object.keys(userState.progress || {})) {
      if (!k.startsWith(mode + ":")) continue;
      seen.add(parseInt(k.split(":", 2)[1], 10));
    }
  }
  const heroPool = [];
  outer: for (const items of byCat.values()) {
    for (const s of items.slice(0, 5)) {
      if (!seen.has(s.id) && s.icon) { heroPool.push(s); seen.add(s.id); }
      if (heroPool.length >= 40) break outer;
    }
  }
  // Seed = today's date + active profile id + mode. Mulberry32 is
  // a small fast PRNG, deterministic from the seed.
  const daySeed = (() => {
    const now = new Date();
    return `${now.getFullYear()}-${now.getMonth()}-${now.getDate()}:${req.profileId || "p1"}:${mode}`;
  })();
  let seedState = 0;
  for (const c of daySeed) seedState = (seedState * 31 + c.charCodeAt(0)) | 0;
  const rng = () => {
    seedState |= 0;
    seedState = (seedState + 0x6D2B79F5) | 0;
    let t = seedState;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  for (let i = heroPool.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [heroPool[i], heroPool[j]] = [heroPool[j], heroPool[i]];
  }
  const hero = heroPool.map(heroFor).filter(isKidSafe).slice(0, 8);

  // Active chip list for this profile + mode. Walk every tile in the
  // built rails, collect their tags, then intersect with the master
  // chip catalog (filterConfig groups + synthetic 4k/movies) so the
  // client only renders chips that can actually narrow the result
  // set. Without this, Vir's Series tab would surface chips like
  // "Tamil" even though his rails have no Tamil items.
  const tagsPresent = new Set();
  for (const r of rails) {
    for (const it of r.items) {
      if (Array.isArray(it.tags)) for (const t of it.tags) tagsPresent.add(t);
    }
  }
  // Language chips are gated by the user's onboarded language set.
  // Without this, a single mis-tagged item could surface "Tamil" on
  // a profile that never picked Tamil — `titleLangPasses` blocks
  // names that *contain* the word, but item tags can carry the
  // language via category-name regex or XX:-prefix even when the
  // visible name doesn't, leaving Tamil in `tagsPresent`.
  const onboardedSet = new Set(modeKeys);
  const chips = [];
  for (const [key, label] of [["4k", "4K"], ["movies", "Movies"]]) {
    if (tagsPresent.has(key)) chips.push({ key, label, kind: "synthetic" });
  }
  for (const g of CHANNEL_GROUPS) {
    if (!tagsPresent.has(g.key)) continue;
    const kind = CHIP_KINDS[g.key] || "other";
    if (kind === "language" && !onboardedSet.has(g.key)) continue;
    chips.push({
      key:   g.key,
      label: CHIP_LABELS[g.key] || g.key,
      kind,
    });
  }

  res.json({
    mode,
    ready: ix.ready,
    rails,
    hero,
    chips,
  });
});

// Records a play event. The frontend hits this when starting playback so the
// "last played" timestamp is shared across browsers / devices.
app.post("/api/play-event/:mode(live|movie|series)/:id", express.json(), (req, res) => {
  recordLastPlayed(req.params.mode, req.params.id);
  res.json({ ok: true, ts: lastPlayed[req.params.mode][String(req.params.id)] });
});

// Saves playback position for a movie or series episode so playback can
// resume on the same or a different device. Live is excluded — its
// position has no meaning in a sliding-window stream. Position near the
// start (< 30s) or near the end (within 30s or past 95%) deletes the
// entry: nothing useful to resume to.
app.post("/api/progress/:mode(movie|series)/:id", express.json(), (req, res) => {
  const userState = getProfileState(req.profileId);
  const { mode, id } = req.params;
  const position = Number(req.body?.position);
  const duration = Number(req.body?.duration);
  if (!Number.isFinite(position) || position < 0) {
    return res.status(400).json({ error: "bad position" });
  }
  const key = `${mode}:${id}`;
  const validDur = Number.isFinite(duration) && duration > 0 ? duration : null;
  const finished = validDur != null && (position >= validDur - 30 || position >= validDur * 0.95);
  if (position < 30 || finished) {
    delete userState.progress[key];
  } else {
    userState.progress[key] = { p: position, d: validDur, t: Date.now() };
  }
  scheduleUserStateSave();
  res.json({ ok: true });
});

// Whole-state PUT for cross-device sync. Scoped to the active profile
// — same household password, isolated state per profile.
app.put("/api/user-state", express.json({ limit: "256kb" }), (req, res) => {
  const userState = getProfileState(req.profileId);
  const b = req.body || {};
  if (b.favorites && typeof b.favorites === "object") {
    for (const m of ["live", "movie", "series"]) {
      if (Array.isArray(b.favorites[m])) {
        userState.favorites[m] = b.favorites[m].slice(0, 5000);
      }
    }
  }
  if (b.myList && typeof b.myList === "object") {
    for (const m of ["live", "movie", "series"]) {
      if (Array.isArray(b.myList[m])) {
        userState.myList[m] = b.myList[m].slice(0, 5000);
      }
    }
  }
  if (b.recents && typeof b.recents === "object") {
    for (const m of ["live", "movie", "series"]) {
      if (Array.isArray(b.recents[m])) {
        userState.recents[m] = b.recents[m].slice(0, 100);
      }
    }
  }
  if (Array.isArray(b.watched)) {
    userState.watched = b.watched.slice(0, 50000);
  }
  if (b.lastEpisode && typeof b.lastEpisode === "object") {
    userState.lastEpisode = b.lastEpisode;
  }
  if (b.filter && typeof b.filter === "object") {
    const next = {
      onboarded: !!b.filter.onboarded,
      groups: { live: [], movie: [], series: [] },
    };
    if (b.filter.groups && typeof b.filter.groups === "object") {
      for (const m of ["live", "movie", "series"]) {
        if (Array.isArray(b.filter.groups[m])) {
          next.groups[m] = b.filter.groups[m]
            .filter(x => typeof x === "string")
            .slice(0, 200);
        }
      }
    }
    userState.filter = next;
  }
  if (typeof b.remoteEnabled === "boolean") {
    userState.remoteEnabled = b.remoteEnabled;
  }
  if (Number.isFinite(b.epgWindowHoursForward)) {
    userState.epgWindowHoursForward = Math.min(Math.max(Math.round(b.epgWindowHoursForward), 1), 24);
  }
  scheduleUserStateSave();
  res.json({ ok: true });
});

// Search across the in-memory index for a mode. Case-insensitive name
// substring; bounded result count. Designed for HA / external clients
// that want to drive a search-as-you-type UI without pulling the whole
// index. Works for live, movie, and series.
app.get("/api/search/all", (req, res) => {
  const q = String(req.query.q || "").trim().toLowerCase();
  const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 20, 1), 60);
  if (!q) return res.json({ q, movie: [], series: [], live: [] });

  const userState = getProfileState(req.profileId);
  const activeProfile = profiles.profiles.find(p => p.id === req.profileId) || null;
  const modeKeys = (() => {
    const own = userState.filter?.groups?.movie;
    if (Array.isArray(own) && own.length) return own;
    return userState.filter?.groups?.live || [];
  })();
  const onboarded = !!userState.filter?.onboarded && modeKeys.length > 0;
  const titleLangPasses = onboarded ? makeTitleLangFilter(new Set(modeKeys)) : () => true;
  const kidBlocker = makeKidsBlocker(activeProfile);

  // Resolve the query to a canonical TMDB genre when applicable, so
  // typing "thriller" surfaces every thriller-tagged title in the
  // catalog — not just those whose name happens to contain the word.
  // Matched on the full query (after trim/lower); also handles common
  // synonyms users type ("sci-fi" for Science Fiction, etc).
  // Maps common synonyms / informal terms onto TMDB's canonical
  // genre names. TMDB doesn't have "Suspense" (filed under Thriller),
  // doesn't split out Anime from Animation, etc. — without these,
  // perfectly reasonable searches like "suspense" or "anime" return
  // only title-substring matches.
  const GENRE_ALIASES = {
    // Thriller
    "thrillers": "Thriller",
    "suspense": "Thriller",
    "psychological": "Thriller",
    // Sci-Fi
    "sci-fi": "Science Fiction",
    "scifi": "Science Fiction",
    "sci fi": "Science Fiction",
    "science-fiction": "Science Fiction",
    // Animation
    "anime": "Animation",
    "cartoon": "Animation",
    "cartoons": "Animation",
    "animated": "Animation",
    // Comedy
    "comedies": "Comedy",
    "funny": "Comedy",
    "rom-com": "Romance",
    "romcom": "Romance",
    "rom com": "Romance",
    // Horror
    "scary": "Horror",
    "horror movies": "Horror",
    // Family / Kids
    "kids": "Family",
    "kid": "Family",
    "children": "Family",
    "family-friendly": "Family",
    // Documentary
    "doc": "Documentary",
    "docs": "Documentary",
    "documentaries": "Documentary",
    "true story": "Documentary",
    // Crime / Mystery
    "true crime": "Crime",
    "detective": "Mystery",
    "whodunit": "Mystery",
    // Action / Adventure
    "actions": "Action",
    "fights": "Action",
    "adventures": "Adventure",
    // Romance
    "romances": "Romance",
    "love": "Romance",
    "love story": "Romance",
    // Music
    "musical": "Music",
    "musicals": "Music",
    "concert": "Music",
    // Misc
    "war movies": "War",
    "westerns": "Western",
    "historical": "History",
    "fantasy movies": "Fantasy",
  };
  const KNOWN_GENRES = [
    "Action", "Adventure", "Animation", "Comedy", "Crime", "Documentary",
    "Drama", "Family", "Fantasy", "History", "Horror", "Music", "Mystery",
    "Romance", "Science Fiction", "Thriller", "War", "Western",
  ];
  const matchedGenre = (() => {
    if (GENRE_ALIASES[q]) return GENRE_ALIASES[q];
    const direct = KNOWN_GENRES.find(g => g.toLowerCase() === q);
    return direct || null;
  })();

  // Multi-token faceted parse. "thriller hindi 2024 ajay devgan"
  // splits into facets (Thriller / Hindi / 2024) AND a residual name
  // phrase ("ajay devgan") that matches against title OR cast. AND
  // combined across facets so the result is everything that is a
  // 2024 Hindi thriller featuring Ajay Devgan.
  const LANG_ALIASES = {
    hindi: "hi", english: "en", tamil: "ta", telugu: "te",
    kannada: "kn", malayalam: "ml", marathi: "mr", gujarati: "gu",
    punjabi: "pa", bengali: "bn", urdu: "ur", arabic: "ar",
    spanish: "es", french: "fr", german: "de", italian: "it",
    portuguese: "pt", japanese: "ja", korean: "ko", chinese: "zh",
    russian: "ru", turkish: "tr",
  };
  const parseQuery = (qq) => {
    const tokens = qq.split(/\s+/).filter(Boolean);
    let year = null, decadeStart = null, genre = null, lang = null;
    const nameTokens = [];
    for (const tok of tokens) {
      if (!year && /^(19|20)\d{2}$/.test(tok)) { year = tok; continue; }
      // decade tokens: "90s", "80s", "2010s". Normalize to a
      // 4-digit decade start.
      const dm = /^(?:(19|20)?(\d0))s$/.exec(tok);
      if (!decadeStart && dm) {
        const dd = parseInt(dm[2], 10);
        const century = dm[1] ? parseInt(dm[1] + "00", 10)
                              : (dd >= 30 ? 1900 : 2000);
        decadeStart = century + dd;
        continue;
      }
      const g = GENRE_ALIASES[tok] || KNOWN_GENRES.find(x => x.toLowerCase() === tok);
      if (!genre && g) { genre = g; continue; }
      if (!lang && LANG_ALIASES[tok]) { lang = LANG_ALIASES[tok]; continue; }
      nameTokens.push(tok);
    }
    return { year, decadeStart, genre, lang, name: nameTokens.join(" ") };
  };
  const parsed = parseQuery(q);
  const hasFacets = !!(parsed.year || parsed.decadeStart || parsed.genre || parsed.lang);
  // Multi-token query with no parsed facets is almost certainly a
  // person name ("ranveer singh", "christopher nolan"). Run those
  // through the faceted matcher too so the cast lookup engages —
  // panel titles never include cast names, so the plain substring
  // pass would return zero.
  const couldBeName = !hasFacets && /\s/.test(q);

  const searchMode = (mode) => {
    const ix = indexes[mode];
    if (!ix.ready || ix.byId.size === 0) return [];
    // Live channels have no us_cert; running the strict allow-list
    // on them would zero out the live-search bucket for kid profiles.
    const isKidBlocked = mode === "live" ? () => false : kidBlocker;
    const seenTmdb = new Set();
    const seenIds = new Set();
    const results = [];
    const projectTile = (s) => {
      const t = mode !== "live" ? tmdbCache[`${mode}:${s.id}`] : null;
      return {
        id: s.id,
        name: s.name,
        icon: s.icon || null,
        poster: t?.poster_path ? `${TMDB_IMG_BASE}/w154${t.poster_path}` : null,
        year: s.year || null,
        rating: s.rating || null,
        us_cert: s.us_cert || null,
        tmdb_id: s.tmdb_id || null,
        category_id: s.category_id,
        tags: s.tags || [],
        container: s.container || null,
      };
    };
    const eligible = (s) => {
      if (!titleLangPasses(s.name)) return false;
      if (isKidBlocked(s)) return false;
      if (s.tmdb_id) {
        if (seenTmdb.has(s.tmdb_id)) return false;
        seenTmdb.add(s.tmdb_id);
      }
      if (seenIds.has(s.id)) return false;
      seenIds.add(s.id);
      return true;
    };
    // Faceted match — when the user typed multiple tokens that
    // resolve to facets (year + language + genre, etc.), AND-combine
    // them. The residual `parsed.name` runs against BOTH the panel
    // title AND the cached TMDB cast list, so "ajay devgan" matches
    // his films without him being in the title.
    if ((hasFacets || couldBeName) && mode !== "live") {
      const nameLow = parsed.name || "";
      const matches = [];
      for (const s of ix.byId.values()) {
        const t = tmdbCache[`${mode}:${s.id}`];
        if (!t || t.source === "no-match") continue;
        // Year facet — strict 4-digit match.
        if (parsed.year && t.year !== parsed.year) continue;
        // Decade — TMDB year falls in [start, start+10).
        if (parsed.decadeStart) {
          const y = parseInt(t.year, 10);
          if (!(y >= parsed.decadeStart && y < parsed.decadeStart + 10)) continue;
        }
        if (parsed.genre) {
          if (!Array.isArray(t.genres) || !t.genres.includes(parsed.genre)) continue;
        }
        if (parsed.lang && t.original_language !== parsed.lang) {
          // Fallback: when original_language isn't yet populated by
          // the v2 backfill, also accept the panel-derived tag.
          if (!(Array.isArray(s.tags) && s.tags.includes(parsed.lang === "hi" ? "hindi" : parsed.lang))) continue;
        }
        // Name residual — fuzzy AND-match against the panel title
        // + TMDB cast names + TMDB director names. Each user token
        // becomes a 4-char prefix (full token if shorter) so spelling
        // variants like "Ajay Devgan" → "Ajay Devgn" still match.
        // Every token must hit somewhere in the haystack; this avoids
        // "ajay devgan" matching every film that has either a random
        // "Ajay X" or "Y Devgan" in any role.
        if (nameLow) {
          const userTokens = nameLow.split(/\s+/).filter(Boolean);
          const prefixes = userTokens.map(tok => tok.length >= 5 ? tok.slice(0, 4) : tok);
          const haystackParts = [(s.name || "").toLowerCase()];
          if (Array.isArray(t.cast)) {
            for (const c of t.cast) haystackParts.push((c.name || "").toLowerCase());
          }
          if (Array.isArray(t.directors)) {
            for (const d of t.directors) haystackParts.push((d || "").toLowerCase());
          }
          const haystack = haystackParts.join(" | ");
          if (!prefixes.every(p => haystack.includes(p))) continue;
        }
        if (!eligible(s)) continue;
        matches.push({ s, t });
        if (matches.length >= limit * 3) break; // collect a bit extra to sort
      }
      // Sort by audience size (vote_count) — bigger / more-watched
      // titles first so the user sees recognizable matches up top.
      matches.sort((a, b) => (b.t.vote_count || 0) - (a.t.vote_count || 0));
      for (const m of matches) {
        if (results.length >= limit) break;
        results.push(projectTile(m.s));
      }
      return results;
    }

    // Pass 1 — title substring matches (the historical single-token
    // behavior). Triggers when no facets were parsed out of the
    // query, so "bajirao" or "marvel" still works the way it did.
    for (const s of ix.byId.values()) {
      if (results.length >= limit) break;
      if (!(s.name || "").toLowerCase().includes(q)) continue;
      if (!eligible(s)) continue;
      results.push(projectTile(s));
    }
    // Pass 2 — genre matches, only when the query mapped to a
    // canonical TMDB genre and we still have room under the limit.
    // Sorted by audience size (vote_count) so the most-known titles
    // show first; users with niche taste can scroll. Live items have
    // no TMDB data, so this pass is a no-op for that mode.
    if (matchedGenre && mode !== "live" && results.length < limit) {
      const tagged = [];
      for (const s of ix.byId.values()) {
        if (seenIds.has(s.id)) continue;
        const t = tmdbCache[`${mode}:${s.id}`];
        if (!t || t.source === "no-match") continue;
        if (!Array.isArray(t.genres) || !t.genres.includes(matchedGenre)) continue;
        if (!titleLangPasses(s.name)) continue;
        if (isKidBlocked(s)) continue;
        if (s.tmdb_id) {
          if (seenTmdb.has(s.tmdb_id)) continue;
          seenTmdb.add(s.tmdb_id);
        }
        tagged.push({ s, vc: t.vote_count || 0 });
      }
      tagged.sort((a, b) => b.vc - a.vc);
      for (const { s } of tagged) {
        if (results.length >= limit) break;
        seenIds.add(s.id);
        results.push(projectTile(s));
      }
    }
    return results;
  };

  res.json({
    q,
    movie: searchMode("movie"),
    series: searchMode("series"),
    live: searchMode("live"),
    // Clients render a "Genre: Thriller" header above the results
    // when this is set — gives the user a visual cue that the
    // results were broadened beyond plain title matching.
    genre: matchedGenre || parsed.genre || null,
    // Echo back the parsed facets so the UI can render a chip strip
    // showing "Thriller · Hindi · 2024 · ajay devgan" and the user
    // immediately sees how their multi-token query was understood.
    parsed: hasFacets ? {
      year: parsed.year,
      decadeStart: parsed.decadeStart,
      genre: parsed.genre,
      lang: parsed.lang,
      name: parsed.name || null,
    } : null,
  });
});

app.get("/api/search/:mode(live|movie|series)", (req, res) => {
  const mode = req.params.mode;
  const q = String(req.query.q || "").trim().toLowerCase();
  const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 30, 1), 100);
  const ix = indexes[mode];
  if (!ix.ready || ix.byId.size === 0) return res.json({ q, results: [] });

  const cats = loadCategoriesFromDiskSync(mode);
  const catName = new Map(cats.map((c) => [String(c.category_id), c.category_name]));
  const activeProfile = profiles.profiles.find(p => p.id === req.profileId) || null;
  const isKidBlocked = mode === "live" ? () => false : makeKidsBlocker(activeProfile);

  const results = [];
  for (const s of ix.byId.values()) {
    if (results.length >= limit) break;
    if (q && !(s.name || "").toLowerCase().includes(q)) continue;
    if (isKidBlocked(s)) continue;
    if (!q && results.length >= limit) break;
    results.push({
      id: s.id,
      name: s.name,
      icon: s.icon || null,
      category_id: s.category_id,
      category_name: catName.get(String(s.category_id)) || null,
    });
  }
  res.json({ q, count: results.length, results });
});

// EPG: programs for a live channel in a time window. Used by the
// TV-Guide view (lazy-loaded per visible channel) and the "Now playing"
// badge on live rail cards.
//
// Source: the panel's `get_simple_data_table` action returns the full
// week-ahead EPG (often 50–80 entries). The legacy `get_short_epg`
// action returned just 1–2 entries on many channels — that's why the
// guide grid looked starved. We slice server-side to the requested
// window so payloads stay small (~3–6 entries per channel, ~600 bytes).
//
// Titles and descriptions come back base64-encoded from the panel; we
// decode them here so clients get clean JSON. xtream() caches for 24h
// and dedupes concurrent identical requests, so heavy bursts from the
// guide grid hit the panel at most once per channel per day.
app.get("/api/epg/short/:streamId", async (req, res, next) => {
  try {
    const streamId = req.params.streamId;
    // Window: 1h-back / Nh-forward. Default N = 5h (matches the
    // userState default); client can override via ?hours=N or its
    // saved epgWindowHoursForward preference. Capped at 24h.
    const hours  = Math.min(Math.max(parseInt(req.query.hours, 10) || 3, 1), 24);
    const nowSec = Math.floor(Date.now() / 1000);
    const fromSec = nowSec - 3600;
    const toSec   = nowSec + hours * 3600;

    // 1) Try the xmltv bulk index first. One-time nightly fetch
    // populated this; subsequent reads are pure in-memory slices.
    const stream = indexes.live.byId.get(parseInt(streamId, 10))
                || indexes.live.byId.get(streamId);
    const chId = stream?.epg_channel_id;
    if (chId && epgIndex.has(chId)) {
      const all = epgIndex.get(chId);
      const fromMs = fromSec * 1000;
      const toMs   = toSec   * 1000;
      const out = [];
      for (const p of all) {
        if (p.stop <= fromMs) continue;
        if (p.start >= toMs)  break; // array is sorted by start
        out.push({
          title:       p.title || "",
          description: p.desc  || "",
          start_ts:    Math.floor(p.start / 1000),
          stop_ts:     Math.floor(p.stop  / 1000),
        });
      }
      return res.json({ stream_id: streamId, programs: out, source: "xmltv" });
    }

    // 2) Fallback — per-channel panel fetch. Still cached by xtream()
    // for 24h + deduped, so heavy bursts from the guide grid hit the
    // panel at most once per channel per day.
    const v = await xtream("get_simple_data_table", { stream_id: streamId });
    const list = Array.isArray(v?.epg_listings) ? v.epg_listings
               : Array.isArray(v) ? v
               : [];
    const decode = (s) => {
      if (!s) return "";
      try { return Buffer.from(String(s), "base64").toString("utf8"); }
      catch { return String(s); }
    };
    const out = list
      .map(p => ({
        title:       decode(p.title),
        description: decode(p.description),
        start_ts:    Number(p.start_timestamp) || (p.start ? Math.floor(new Date(p.start).getTime() / 1000) : null),
        stop_ts:     Number(p.stop_timestamp)  || (p.end   ? Math.floor(new Date(p.end).getTime()   / 1000) : null),
      }))
      .filter(p => p.start_ts && p.stop_ts && p.stop_ts > fromSec && p.start_ts < toSec)
      .sort((a, b) => a.start_ts - b.start_ts);
    res.json({ stream_id: streamId, programs: out, source: "panel" });
  } catch (e) { next(e); }
});

app.get("/api/:mode(live|movie|series)/streams", async (req, res, next) => {
  try {
    const mode = req.params.mode;
    const ix = indexes[mode];
    const catId = req.query.category_id ? String(req.query.category_id) : null;

    // Prefer the in-memory index (already built and persisted). Per-category
    // panel queries can return non-array bodies under load — typically right
    // after a container restart while the panel rate-limits fresh traffic.
    if (ix.ready && ix.byId.size > 0) {
      const all = [...ix.byId.values()];
      const userState = getProfileState(req.profileId);
      const activeProfile = profiles.profiles.find(p => p.id === req.profileId) || null;
      const modeKeys = (() => {
        const own = userState.filter?.groups?.[mode];
        if (Array.isArray(own) && own.length) return own;
        return userState.filter?.groups?.live || [];
      })();
      const onboarded = !!userState.filter?.onboarded && modeKeys.length > 0;
      const titleLangPasses = onboarded
        ? makeTitleLangFilter(new Set(modeKeys))
        : () => true;
      const isKidBlocked = mode === "live" ? () => false : makeKidsBlocker(activeProfile);
      const catFiltered = catId ? all.filter(s => s.category_id === catId) : all;
      const seenTmdb = new Set();
      const deduped = catFiltered.filter(s => {
        if (!titleLangPasses(s.name)) return false;
        if (isKidBlocked(s)) return false;
        if (!s.tmdb_id) return true;
        if (seenTmdb.has(s.tmdb_id)) return false;
        seenTmdb.add(s.tmdb_id);
        return true;
      });
      return res.json(deduped);
    }

    const m = MODES[mode];
    const v = await xtream(m.list, catId ? { category_id: catId } : {});
    if (!Array.isArray(v)) {
      console.warn(`[streams] panel returned non-array for ${mode} cat=${catId}: ${typeof v}`);
      return res.json([]);
    }
    res.json(v.map(s => projectStream(mode, s)));
  } catch (e) { next(e); }
});

app.get("/api/:mode(movie|series)/info/:id", async (req, res, next) => {
  try {
    const mode = req.params.mode;
    const m = MODES[mode];
    const key = mode === "series" ? "series_id" : "vod_id";
    const v = await xtream(m.info, { [key]: req.params.id });
    // Opportunistic TMDB shortcut: panel ships info.tmdb_id alongside
    // VOD / series detail. Caching it here means the next ensureTmdb
    // for this item (poster / kids cert lookup) skips the title-search
    // round-trip and goes straight to the TMDB detail fetch. Best-
    // effort — failures are swallowed.
    const panelTmdbId = v && v.info && v.info.tmdb_id ? Number(v.info.tmdb_id) : null;
    if (panelTmdbId && TMDB_API_KEY) {
      const cacheKey = `${mode}:${req.params.id}`;
      const existing = tmdbCache[cacheKey];
      const haveGoodEntry = existing && existing.source === "tmdb" && existing.tmdb_id;
      if (!haveGoodEntry) {
        const item = indexes[mode]?.byId?.get(parseInt(req.params.id, 10))
                  || indexes[mode]?.byId?.get(req.params.id);
        ensureTmdbForItem(mode, req.params.id, {
          name: item?.name,
          year: item?.year,
          tmdbId: panelTmdbId,
        }).catch(() => {});
      }
    }
    // Panel mpaa_rating fallback. TMDB sometimes returns a tmdb_id with
    // an empty us_cert (no rating data on TMDB's side). The panel
    // itself often carries the original MPAA / TV rating in
    // info.mpaa_rating — when we have nothing better, write it into
    // the cache so the kids-cert filter has something to work with.
    const panelCert = v && v.info && typeof v.info.mpaa_rating === "string"
      ? v.info.mpaa_rating.trim().toUpperCase().replace(/\s+/g, "-")
      : "";
    if (panelCert && mode === "movie") {
      const cacheKey = `${mode}:${req.params.id}`;
      const existing = tmdbCache[cacheKey];
      // Only fill the gap — never overwrite a TMDB-derived cert.
      if (existing && existing.source === "tmdb" && !existing.us_cert) {
        existing.us_cert = panelCert;
        scheduleTmdbCacheSave();
      }
    }
    res.json(v);
  } catch (e) { next(e); }
});

// TMDB poster + metadata for a movie or series. Returns null TMDB
// fields when no key is configured or when nothing matches — the
// client falls back to the panel artwork in either case. We pull the
// panel name+year from the in-memory index so the lookup happens
// server-side without the client needing to know the title.
app.get("/api/poster/:mode(movie|series)/:id", async (req, res, next) => {
  try {
    if (!TMDB_API_KEY) return res.json(tmdbToResponse(null));
    const { mode, id } = req.params;
    const numId = parseInt(id, 10);
    const item = (indexes[mode].byId.get(numId) || indexes[mode].byId.get(id));
    if (!item) return res.status(404).json({ error: "unknown id" });
    const entry = await ensureTmdbForItem(mode, id, { name: item.name, year: item.year });
    res.json(tmdbToResponse(entry));
  } catch (e) { next(e); }
});

// TMDB episode stills for a series's season. We look up the series's
// tmdb_id (calling ensureTmdbForItem if needed), fetch the season
// detail, and project a { panel_episode_id → still URL } map by
// matching `episode_number`. Cached under series-season:<id>:<n>.
app.get("/api/poster/series/:id/season/:n", async (req, res, next) => {
  try {
    if (!TMDB_API_KEY) return res.json({ stills: {} });
    const seriesId = req.params.id;
    const seasonNum = parseInt(req.params.n, 10);
    if (!Number.isFinite(seasonNum)) return res.status(400).json({ error: "bad season" });
    const cacheKey = `series-season:${seriesId}:${seasonNum}`;
    const cached = tmdbCache[cacheKey];
    if (cached && cached.fetched_at && (Date.now() - cached.fetched_at) < TMDB_TTL_MS) {
      return res.json({ stills: cached.stills || {} });
    }
    // Resolve the series's tmdb_id first.
    const seriesItem = indexes.series.byId.get(parseInt(seriesId, 10))
                    || indexes.series.byId.get(seriesId);
    if (!seriesItem) return res.status(404).json({ error: "unknown series" });
    const seriesEntry = await ensureTmdbForItem("series", seriesId, { name: seriesItem.name, year: seriesItem.year });
    if (!seriesEntry || !seriesEntry.tmdb_id) return res.json({ stills: {} });
    // Pull panel episode list to build the panel_ep_id → episode_number map.
    const panelInfo = await xtream(MODES.series.info, { series_id: seriesId });
    const panelEpisodes = panelInfo && panelInfo.episodes && panelInfo.episodes[String(seasonNum)];
    if (!Array.isArray(panelEpisodes) || !panelEpisodes.length) return res.json({ stills: {} });
    const tmdbSeason = await tmdb(`/tv/${seriesEntry.tmdb_id}/season/${seasonNum}`);
    const tmdbEps = tmdbSeason && Array.isArray(tmdbSeason.episodes) ? tmdbSeason.episodes : [];
    const byNum = new Map();
    for (const e of tmdbEps) byNum.set(e.episode_number, e.still_path);
    const stills = {};
    for (const ep of panelEpisodes) {
      const still = byNum.get(Number(ep.episode_num));
      if (still) stills[String(ep.id)] = `${TMDB_IMG_BASE}/w400${still}`;
    }
    tmdbCache[cacheKey] = { fetched_at: Date.now(), stills };
    scheduleTmdbCacheSave();
    res.json({ stills });
  } catch (e) { next(e); }
});

// Wipe a TMDB cache entry so the next poster request re-searches.
// Used by the "Fix poster" override in the detail modal. Also clears
// any series-season:<id>:* entries when called for a series.
app.delete("/api/poster/:mode(movie|series)/:id", (req, res) => {
  const { mode, id } = req.params;
  let cleared = 0;
  const primaryKey = `${mode}:${id}`;
  if (tmdbCache[primaryKey]) { delete tmdbCache[primaryKey]; cleared++; }
  if (mode === "series") {
    const prefix = `series-season:${id}:`;
    for (const k of Object.keys(tmdbCache)) {
      if (k.startsWith(prefix)) { delete tmdbCache[k]; cleared++; }
    }
  }
  if (cleared) scheduleTmdbCacheSave();
  res.json({ ok: true, cleared });
});

// Walks tmdbCache for entries where source === "no-match", looks up
// the panel item by mode+id, and re-runs findTmdbMatch on each. TMDB
// occasionally fixes a title mapping or adds metadata after the
// original prewarm ran, so a periodic retry promotes anything that's
// matchable now without users having to click "Refresh poster" per
// title. `onProgress({phase, ...})` is called for each hit + start +
// done — used by the admin endpoint to stream NDJSON, and by the
// nightly cron just for logging.
async function retryTmdbNoMatches({ onProgress } = {}) {
  if (!TMDB_API_KEY) return { ok: false, error: "no TMDB_API_KEY configured" };
  const tally = { scanned: 0, retried: 0, promoted: 0, stillMissing: 0, errors: 0 };
  const candidates = [];
  for (const [key, entry] of Object.entries(tmdbCache)) {
    if (!entry || entry.source !== "no-match") continue;
    const [mode, id] = key.split(":");
    if (!["movie", "series"].includes(mode) || !id) continue;
    candidates.push({ key, mode, id });
  }
  tally.scanned = candidates.length;
  onProgress?.({ phase: "start", candidates: candidates.length });

  // Low concurrency to leave headroom for live UI / boot prewarm.
  const CONC = 3;
  let i = 0;
  await Promise.all(Array.from({ length: CONC }, async () => {
    while (i < candidates.length) {
      const c = candidates[i++];
      tally.retried++;
      try {
        const ix = indexes[c.mode];
        const item = ix?.byId?.get(parseInt(c.id, 10)) || ix?.byId?.get(c.id);
        const name = item?.name;
        const year = item?.year;
        if (!name) { tally.errors++; continue; }
        const match = await findTmdbMatch(c.mode, name, year);
        if (match && match.tmdb_id) {
          tmdbCache[c.key] = { ...match, source: "tmdb", checked_at: Date.now() };
          tally.promoted++;
          onProgress?.({ phase: "hit", id: c.id, mode: c.mode, name, tmdb_id: match.tmdb_id, us_cert: match.us_cert || "" });
        } else {
          // Refresh checked_at so the next cron pass doesn't re-retry
          // immediately — keep the no-match status.
          tmdbCache[c.key] = { tmdb_id: null, source: "no-match", checked_at: Date.now() };
          tally.stillMissing++;
        }
      } catch (e) {
        tally.errors++;
      }
    }
  }));
  scheduleTmdbCacheSave();
  onProgress?.({ phase: "done", ...tally });
  return { ok: true, ...tally };
}

// Nightly retry cron. Fires at 3:30 AM local — 30 minutes after the
// xmltv pull, so the two heavy tasks don't fight for panel headroom.
// Mirrors scheduleEpgNightlyRefresh's "msUntilNextLocalHour + then
// setInterval 24h" pattern.
function scheduleTmdbNightlyRetry() {
  if (!TMDB_API_KEY) return;
  const fireHour = 3;
  const fireMin = 30;
  const now = new Date();
  const target = new Date(now);
  target.setHours(fireHour, fireMin, 0, 0);
  if (target <= now) target.setDate(target.getDate() + 1);
  const ms = target - now;
  console.log(`[tmdb] next no-match retry in ${Math.round(ms / 60000)} min`);
  setTimeout(() => {
    const summary = { promoted: 0, stillMissing: 0 };
    retryTmdbNoMatches({
      onProgress: (e) => {
        if (e.phase === "done") {
          summary.promoted = e.promoted;
          summary.stillMissing = e.stillMissing;
          console.log(`[tmdb] nightly retry: ${e.promoted} promoted, ${e.stillMissing} still missing (scanned ${e.scanned})`);
        }
      },
    }).catch(e => console.warn(`[tmdb] nightly retry failed: ${e.message}`));
    setInterval(() => {
      retryTmdbNoMatches({
        onProgress: (e) => {
          if (e.phase === "done") {
            console.log(`[tmdb] nightly retry: ${e.promoted} promoted, ${e.stillMissing} still missing (scanned ${e.scanned})`);
          }
        },
      }).catch(e => console.warn(`[tmdb] nightly retry failed: ${e.message}`));
    }, 24 * 60 * 60 * 1000);
  }, ms);
}

// One-time backfill for the expanded TMDB cache fields. Earlier
// entries only stored {genres, rating, poster, ...}; the projected
// shape now also includes cast / directors / trailer_key / keywords
// / vote_count / popularity / tagline / original_language / imdb_id
// / collection / reviews / recommendations. Re-fetching with the
// new append_to_response payloads via refetchTmdbDetail() upgrades
// each entry in place.
//
// "Done" sentinel: an entry has `vote_count` once backfilled, since
// vote_count wasn't in the old projection at all. Entries lacking it
// are still on the legacy shape and queued for refresh.
async function backfillTmdbCacheV2({ onProgress } = {}) {
  if (!TMDB_API_KEY) return { ok: false, error: "no TMDB_API_KEY configured" };
  const tally = { scanned: 0, retried: 0, upgraded: 0, errors: 0 };
  const candidates = [];
  for (const [key, entry] of Object.entries(tmdbCache)) {
    if (!entry || entry.source !== "tmdb" || !entry.tmdb_id) continue;
    if ("vote_count" in entry) continue; // already upgraded
    const [mode, id] = key.split(":");
    if (!["movie", "series"].includes(mode) || !id) continue;
    candidates.push({ key, mode, id, tmdb_id: entry.tmdb_id });
  }
  tally.scanned = candidates.length;
  onProgress?.({ phase: "start", candidates: candidates.length });

  // 5-way concurrency. TMDB allows ~50 req/s on a single key; at 5
  // concurrent requests the throughput is still well within limits,
  // but we don't saturate so live UI / boot prewarm can interleave.
  const CONC = 5;
  let i = 0;
  await Promise.all(Array.from({ length: CONC }, async () => {
    while (i < candidates.length) {
      const c = candidates[i++];
      tally.retried++;
      try {
        const fresh = await refetchTmdbDetail(c.mode, c.tmdb_id);
        if (fresh && fresh.tmdb_id) {
          tmdbCache[c.key] = { ...fresh, source: "tmdb", checked_at: Date.now() };
          tally.upgraded++;
          if (tally.retried % 500 === 0) {
            // Progress heartbeat for long runs + flush to disk
            // periodically so a crash mid-backfill doesn't lose
            // hours of work.
            scheduleTmdbCacheSave();
            onProgress?.({ phase: "heartbeat", ...tally });
          }
        } else {
          tally.errors++;
        }
      } catch (e) {
        tally.errors++;
      }
    }
  }));
  scheduleTmdbCacheSave();
  onProgress?.({ phase: "done", ...tally });
  return { ok: true, ...tally };
}

// "More from <actor>" — resolves an actor name to a TMDB person_id,
// pulls their full filmography (movies + TV), and intersects with
// our local index by tmdb_id so we only return titles the user can
// actually play. Cached per-name in memory for a week so popular
// actors don't burn TMDB calls on every click.
const personCache = new Map();
const PERSON_CACHE_MS = 7 * 24 * 60 * 60 * 1000;

app.get("/api/person/credits", async (req, res) => {
  const name = String(req.query.name || "").trim();
  if (!name) return res.status(400).json({ error: "name required" });
  const cacheKey = name.toLowerCase();

  const cached = personCache.get(cacheKey);
  if (cached && Date.now() - cached.ts < PERSON_CACHE_MS) {
    return res.json(cached.payload);
  }
  if (!TMDB_API_KEY) {
    return res.json({ name, person: null, items: { movie: [], series: [] } });
  }

  try {
    // Search for the person — TMDB returns matches ordered by their
    // own popularity score, so [0] is the right pick for "Ranveer
    // Singh" but also for ambiguous names like "Will Smith" (the
    // actor wins over the boxer).
    const search = await tmdb("/search/person", { query: name });
    const person = (search?.results || [])[0];
    if (!person) {
      const payload = { name, person: null, items: { movie: [], series: [] } };
      personCache.set(cacheKey, { ts: Date.now(), payload });
      return res.json(payload);
    }

    // combined_credits = movie + tv in one call; we still split them
    // into the buckets the client renders separately.
    const credits = await tmdb(`/person/${person.id}/combined_credits`);
    const cast = Array.isArray(credits?.cast) ? credits.cast : [];
    const movieIds = new Set();
    const seriesIds = new Set();
    // role label by tmdb_id, so we can show "as Bajirao" / "as
    // Mastani" next to each title.
    const roleBy = new Map();
    for (const c of cast) {
      if (c.media_type === "movie") movieIds.add(c.id);
      else if (c.media_type === "tv") seriesIds.add(c.id);
      if (c.character) roleBy.set(`${c.media_type}:${c.id}`, c.character);
    }

    const findItems = (mode, idSet) => {
      const ix = indexes[mode];
      if (!ix?.ready) return [];
      const out = [];
      // Dedupe by tmdb_id within the result — the panel ships
      // multiple variants of every popular title (Hindi dub, Tamil
      // dub, CAM rip, HD, etc.) all sharing one TMDB id. Without
      // this, "Ryan Gosling" returned 14 Project Hail Marys.
      const seenTmdb = new Set();
      // Scan the index once. ix.byId is a Map, so this is O(n) on
      // the catalog (~70k worst case) — fine for an on-click action,
      // and the personCache makes it a one-shot per unique actor.
      for (const s of ix.byId.values()) {
        if (!s.tmdb_id || !idSet.has(s.tmdb_id)) continue;
        if (seenTmdb.has(s.tmdb_id)) continue;
        seenTmdb.add(s.tmdb_id);
        const t = tmdbCache[`${mode}:${s.id}`];
        out.push({
          id: s.id,
          name: s.name,
          icon: s.icon || null,
          poster: t?.poster_path ? `${TMDB_IMG_BASE}/w154${t.poster_path}` : null,
          year: s.year || (t?.year || null),
          us_cert: s.us_cert || null,
          rating: s.rating || (t?.rating || null),
          tags: s.tags || [],
          container: s.container || null,
          tmdb_id: s.tmdb_id,
          character: roleBy.get(`${mode === "movie" ? "movie" : "tv"}:${s.tmdb_id}`) || null,
        });
      }
      // Newest first — feels more useful than TMDB's default order.
      out.sort((a, b) => String(b.year || "").localeCompare(String(a.year || "")));
      return out;
    };

    const payload = {
      name: person.name,
      person: {
        id: person.id,
        name: person.name,
        profile: person.profile_path ? `${TMDB_IMG_BASE}/w185${person.profile_path}` : null,
        known_for_department: person.known_for_department || null,
      },
      items: {
        movie: findItems("movie", movieIds),
        series: findItems("series", seriesIds),
      },
    };
    personCache.set(cacheKey, { ts: Date.now(), payload });
    res.json(payload);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post("/api/admin/backfill-tmdb-v2", (req, res) => {
  if (!TMDB_API_KEY) {
    return res.status(400).json({ ok: false, error: "no TMDB_API_KEY configured" });
  }
  res.set("Content-Type", "application/x-ndjson");
  res.set("Cache-Control", "no-store");
  backfillTmdbCacheV2({
    onProgress: (e) => res.write(JSON.stringify(e) + "\n"),
  }).then(() => res.end()).catch(e => {
    res.write(JSON.stringify({ phase: "fatal", error: e.message }) + "\n");
    res.end();
  });
});

// Streams progress over a single NDJSON response. Same heavy lifting
// as the nightly cron, just with live feedback to the caller.
app.post("/api/admin/retry-tmdb-no-matches", (req, res) => {
  if (!TMDB_API_KEY) {
    return res.status(400).json({ ok: false, error: "no TMDB_API_KEY configured" });
  }
  res.set("Content-Type", "application/x-ndjson");
  res.set("Cache-Control", "no-store");
  retryTmdbNoMatches({
    onProgress: (e) => res.write(JSON.stringify(e) + "\n"),
  }).then(() => res.end()).catch(e => {
    res.write(JSON.stringify({ phase: "fatal", error: e.message }) + "\n");
    res.end();
  });
});

const TRANSCODE_DIR = path.join(os.tmpdir(), "iptv-transcode");
fs.mkdirSync(TRANSCODE_DIR, { recursive: true });
const transcoders = new Map();
const TRANSCODE_IDLE_MS = 90_000;

// --- Server-side panel concurrency enforcement ----------------------------
// The Xtream panel locks the account when active connections exceed
// `max_connections`. The previous safety story was per-browser-session
// (each device tore down its own previous stream before starting a new
// one). That fails when multiple family members on different devices
// independently start streams: each thinks it's behaving correctly but
// together they trip the cap.
//
// This middleware makes the Node server the single arbiter. It tracks
// every panel-touching request, attributes it to an "owner" (cookie
// session for browsers, IP+UA for non-browser clients), and enforces a
// configurable cap. When a new stream would exceed the cap, the OLDEST
// active stream gets killed (not the new one) — the user pressing play
// in front of them always wins.
//
// A displaced session is tagged so its next in-flight request returns
// HTTP 410 Gone with a `Khouch-Displaced: 1` header — the client can
// then toast "Another device started watching."
const MAX_CONCURRENT_STREAMS = (() => {
  const n = parseInt(process.env.MAX_CONCURRENT_STREAMS, 10);
  return Number.isFinite(n) && n > 0 ? n : 1;
})();
const STREAM_IDLE_MS = 60_000; // a stream with no requests for 60s is dead

// streams: Map<ownerKey, { mode, id, accountKey, since, lastSeen, killers, displaced }>
// One slot per owner — switching streams within the same owner just
// replaces the entry rather than counting twice.
//
// `accountKey` identifies which IPTV upstream this stream is hitting,
// so the concurrency cap is partitioned per panel-credential.
// Different IPTV accounts have independent `max_connections` budgets;
// owner A's stream against account X must not be displaced by owner
// B's stream against account Y. Today the server has a single global
// IPTV account from .env so accountKey is global; when PR 14 + PR 15
// land with per-user panel credentials, accountKey will be derived
// per-request and this Map's partitioning still works unchanged.
const streams = new Map();

function currentAccountKey() {
  // Identity of the upstream panel account currently in use. Both the
  // host and the panel user matter — same user across two hosts is two
  // separate accounts, two users on one host are also separate.
  return `${IPTV_USER}@${PANEL}`;
}

function ownerKeyOf(req) {
  // Prefer the session cookie so a single browser session is one owner
  // even across hard refreshes. Fall back to IP+UA hash for non-browser
  // clients (curl scripts, the Android TV app pre-cookie).
  const cookie = parseSessionCookie(req);
  if (cookie) return `s:${cookie.slice(0, 24)}`;
  const xff = (req.headers["x-forwarded-for"] || "").split(",")[0].trim();
  const ip = xff || req.socket.remoteAddress || "unknown";
  const ua = (req.headers["user-agent"] || "").slice(0, 64);
  return `ip:${ip}:${crypto.createHash("sha1").update(ua).digest("hex").slice(0, 8)}`;
}

// Pull mode + id out of a panel-direct URL so a /api/proxy request can
// be attributed to a specific stream. Pattern matches:
//   /<mode>/USER/PASS/<id>.<ext>          (direct VOD or live manifest)
//   /hlsr/<token>/USER/PASS/<chid>/...    (live segment URLs)
function parseStreamFromPanelUrl(panelUrl) {
  let parsed;
  try { parsed = new URL(panelUrl); } catch { return null; }
  let m = parsed.pathname.match(/^\/(live|movie|series)\/[^/]+\/[^/]+\/(\d+)\.[a-z0-9]+$/i);
  if (m) return { mode: m[1].toLowerCase(), id: m[2] };
  m = parsed.pathname.match(/^\/hlsr\/[^/]+\/[^/]+\/[^/]+\/(\d+)\//);
  if (m) return { mode: "live", id: m[1] };
  return null;
}

// Admit a request as starting/sustaining a stream for (mode, id) on
// behalf of `owner`, scoped to the panel `accountKey`. Registers a
// killer the admission layer can invoke if it later needs to displace
// this owner. Cap check counts ONLY entries that share the same
// accountKey — different IPTV accounts have independent budgets and
// don't displace each other. Returns:
//   { ok: true } — proceed
//   { ok: false, reason: "displaced" } — owner was already displaced
function admitStream(owner, mode, id, killer, accountKey) {
  const existing = streams.get(owner);
  if (existing && existing.displaced) {
    // The previous request from this owner was displaced; the client
    // hasn't yet learned. Reject so it surfaces.
    return { ok: false, reason: "displaced" };
  }
  if (existing && existing.mode === mode && String(existing.id) === String(id) && existing.accountKey === accountKey) {
    // Same owner, same stream, same account — just bump and add the killer.
    existing.lastSeen = Date.now();
    if (killer) existing.killers.add(killer);
    return { ok: true };
  }
  if (existing) {
    // Same owner switched streams (or accounts) — release the old
    // killers so any panel slot it held is freed before the new fetch.
    for (const k of existing.killers) { try { k(); } catch {} }
    streams.delete(owner);
  }
  // Per-account cap: only entries sharing this accountKey count
  // against the new request's budget. Owner A on account X never
  // displaces owner B on account Y.
  const sameAccount = [];
  for (const [k, v] of streams) {
    if (v.accountKey === accountKey && !v.displaced) sameAccount.push([k, v]);
  }
  if (sameAccount.length >= MAX_CONCURRENT_STREAMS) {
    let oldest = sameAccount[0];
    for (const [k, v] of sameAccount) {
      if (v.since < oldest[1].since) oldest = [k, v];
    }
    const [oldKey, oldEntry] = oldest;
    oldEntry.displaced = true; // tag survives until the entry is reaped
    for (const k of oldEntry.killers) { try { k(); } catch {} }
    console.log(`[concurrency] displaced ${oldKey} (acct=${accountKey}) for ${owner} (${mode}:${id}) — cap=${MAX_CONCURRENT_STREAMS}`);
  }
  streams.set(owner, {
    mode, id: String(id),
    accountKey,
    since: Date.now(),
    lastSeen: Date.now(),
    killers: new Set(killer ? [killer] : []),
    displaced: false,
  });
  return { ok: true };
}

// Bump lastSeen for a request that's part of an existing stream but
// doesn't carry mode/id (a segment fetch from /api/proxy with a hashed
// segment path). Returns false if the owner has been displaced — the
// caller should 410 the request.
function touchStream(owner) {
  const entry = streams.get(owner);
  if (!entry) return true; // no record = first request for this owner
  if (entry.displaced) return false;
  entry.lastSeen = Date.now();
  return true;
}

function dropStreamKiller(owner, killer) {
  const entry = streams.get(owner);
  if (entry) entry.killers.delete(killer);
}

// Idle reaper for the streams map. Drops entries with no recent
// requests (handles ungraceful client disconnects) and clears the
// stale "displaced" tag after the original session has had a chance
// to learn about it.
setInterval(() => {
  const now = Date.now();
  for (const [k, v] of streams) {
    if (now - v.lastSeen > STREAM_IDLE_MS) {
      for (const kill of v.killers) { try { kill(); } catch {} }
      streams.delete(k);
    }
  }
}, 15_000);

// Send a uniform 410 Gone response when a request is rejected because
// the owner has been displaced. Headers + body let the client toast.
function sendDisplaced(res) {
  res.status(410)
     .setHeader("Khouch-Displaced", "1")
     .setHeader("Cache-Control", "no-store");
  res.json({ error: "displaced", message: "Another device started watching." });
}

// Quality presets driving the ffmpeg args. "med" is the historical
// default and what auto-fallback (codec-error retry) uses. Each preset
// is bound by what a 2-vCPU VPS can comfortably encode in real time —
// "high" (1080p) is feasible for one stream but drops frames if a
// second one piggybacks.
const QUALITY_PRESETS = {
  source: { copy: true,                                                              label: "Source" },
  low:    { vf: "scale='min(854,iw)':-2:flags=lanczos",  crf: "26", preset: "veryfast", aBitrate: "128k", label: "480p" },
  med:    { vf: "scale='min(1280,iw)':-2:flags=lanczos", crf: "22", preset: "fast",     aBitrate: "192k", label: "720p" },
  high:   { vf: "scale='min(1920,iw)':-2:flags=lanczos", crf: "20", preset: "fast",     aBitrate: "192k", label: "1080p" },
};
function normalizeQuality(q) {
  return QUALITY_PRESETS[q] ? q : "med";
}

// `offsetSecs` is the source-side seek anchor: when the client asks
// to skip forward past the encoded edge, we restart ffmpeg with
// `-ss <offsetSecs>` so the new playlist starts there. Including it
// in the key lets two concurrent viewers of the same title at
// different offsets get their own ffmpeg + segment dir without
// stepping on each other.
function transcoderKey(mode, id, quality, offsetSecs = 0) {
  const off = Number(offsetSecs) || 0;
  const suffix = off > 0 ? `-t${off}` : "";
  return `${mode}-${id}-${normalizeQuality(quality)}${suffix}`;
}

// Normalize the `?t=` query param: float seconds, non-negative, max
// 24h (anything past that is almost certainly a client bug, and the
// suffix gets unwieldy in cache keys). 0 means "from the start".
function normalizeOffsetSecs(raw) {
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) return 0;
  return Math.min(Math.floor(n), 86400);
}

// Kill all transcoders for a given (mode, id) regardless of quality
// AND wait for each ffmpeg process to actually exit. Used before
// spawning a new transcoder so the panel's max_connections=1 slot is
// released BEFORE the new ffmpeg's upstream fetch — without this
// serialization the new ffmpeg races against the dying one and gets
// an Input/output error from the panel (manifest never completes,
// player wheel spins forever).
async function killAllTranscodersForId(mode, id) {
  const prefix = `${mode}-${id}-`;
  const waits = [];
  for (const [k, t] of transcoders) {
    if (!k.startsWith(prefix)) continue;
    waits.push(new Promise((resolve) => t.proc.once("exit", resolve)));
    try { t.proc.kill("SIGTERM"); } catch {}
  }
  if (!waits.length) return;
  // 3s safety cap: if ffmpeg refuses to exit we don't hang the new
  // request forever. The panel will then briefly see two connections
  // but that's still better than the alternative of waiting indefinitely.
  await Promise.race([
    Promise.all(waits),
    new Promise(resolve => setTimeout(resolve, 3000)),
  ]);
}

async function startOrTouchTranscoder(mode, id, quality, offsetSecs = 0) {
  quality = normalizeQuality(quality);
  offsetSecs = normalizeOffsetSecs(offsetSecs);
  const preset = QUALITY_PRESETS[quality];
  const key = transcoderKey(mode, id, quality, offsetSecs);
  // Reuse the existing same-key ffmpeg if it's still alive — same
  // owner re-hitting the manifest for the same quality during normal
  // segment fetching shouldn't restart anything.
  const existing = transcoders.get(key);
  if (existing && !existing.proc.killed) {
    existing.lastAccess = Date.now();
    return existing;
  }
  // Quality switch (or stale entry) → drain any other transcoders for
  // this id and await their exit so the panel slot is free.
  await killAllTranscodersForId(mode, id);
  const dir = path.join(TRANSCODE_DIR, key);
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true });
  // Source container ext. Live is always HLS; VOD has to match the
  // actual file on the panel — mp4 hardcode was breaking ALL .mkv
  // titles (Bajirao Mastani 4K, etc.) with "Invalid data found when
  // processing input" because the panel returns 0 bytes for the
  // wrong-extension request. For movies the index is authoritative;
  // for series the index keys by series_id (not episode_id), so the
  // lookup misses and we fall back to mp4 — matches the equivalent
  // probe-fallback in /api/download for the same reason.
  let ext;
  if (mode === "live") {
    ext = "m3u8";
  } else if (mode === "movie") {
    ext = indexes.movie.byId.get(parseInt(id, 10))?.container || "mp4";
  } else {
    ext = "mp4"; // series — see comment above
  }
  const sourceUrl = streamUrl(mode, id, ext);
  // Common ffmpeg flags. Codec/scaling args diverge between the
  // re-encode presets and the source-passthrough preset.
  //
  // -ss BEFORE -i is an input-side seek: ffmpeg uses byte-range
  // requests against the panel to land near the requested keyframe.
  // Skipped for live (the stream has no concept of source offset)
  // and skipped at offset 0 to keep the cold-start path identical to
  // pre-feature behavior.
  const args = [
    "-hide_banner", "-loglevel", "error",
    "-fflags", "+genpts",
    "-user_agent", "Mozilla/5.0 (Linux; Android 12; Smart TV)",
  ];
  if (offsetSecs > 0 && mode !== "live") {
    args.push("-ss", String(offsetSecs));
  }
  args.push(
    "-i", sourceUrl,
    "-map", "0:v:0", "-map", "0:a:0?",
  );
  if (preset.copy) {
    // Source passthrough: video unchanged (saves a lot of CPU); audio
    // still gets re-encoded to AAC stereo because many panels ship
    // AC3 / E-AC3 / MP2 which Safari + some Chromecasts can't play.
    // Won't work for MPEG-2 sources (browser can't decode) — that's a
    // user-choice trade-off; they picked "Source" knowing it.
    args.push(
      "-c:v", "copy",
      "-c:a", "aac", "-b:a", "192k", "-ac", "2",
    );
  } else {
    args.push(
      "-c:v", "libx264", "-preset", preset.preset,
      "-profile:v", "high", "-level", "4.1", "-pix_fmt", "yuv420p",
      "-crf", preset.crf,
      "-g", "48", "-keyint_min", "48", "-sc_threshold", "0",
      "-vf", preset.vf,
      "-c:a", "aac", "-b:a", preset.aBitrate, "-ac", "2",
      "-af", "aresample=async=1000:first_pts=0",
    );
  }
  args.push(
    "-max_muxing_queue_size", "1024",
    "-f", "hls",
    "-hls_time", "4",
    "-hls_segment_filename", path.join(dir, "seg_%05d.ts"),
  );
  if (mode === "live") {
    // Live: tight 40-second sliding window. Old segments age out
    // because there's no concept of rewinding past the live edge,
    // and disk space matters more than seek-back range.
    args.push(
      "-hls_list_size", "10",
      "-hls_flags", "delete_segments+independent_segments+omit_endlist",
    );
  } else {
    // VOD (movie / series): keep all segments and grow the playlist
    // without deletion. The 40-second live-style window was making
    // ExoPlayer throw BehindLiveWindowException on any pause/rewind
    // past 40s — the segments behind the player had been deleted.
    // The 90s idle reaper still cleans the whole dir when the user
    // navigates away, so this doesn't leak disk across sessions.
    args.push(
      "-hls_list_size", "0",
      "-hls_flags", "independent_segments",
    );
  }
  args.push(path.join(dir, "index.m3u8"));
  const ffmpeg = spawn("ffmpeg", args, { stdio: ["ignore", "ignore", "pipe"] });
  let stderrBuf = "";
  ffmpeg.stderr.on("data", (b) => { stderrBuf = (stderrBuf + b.toString()).slice(-4000); });
  ffmpeg.on("exit", (code) => {
    // Log a longer tail of stderr so transcoder-startup failures (panel
    // I/O errors, missing codec, etc.) are diagnosable from the boot log
    // without needing to attach a debugger.
    const tail = stderrBuf.split("\n").filter(Boolean).slice(-3).join(" | ");
    console.log(`[transcode ${key}] exit ${code}${tail ? ": " + tail : ""}`);
    transcoders.delete(key);
    fs.rmSync(dir, { recursive: true, force: true });
  });
  const entry = { proc: ffmpeg, lastAccess: Date.now(), dir, sourceUrl, mode, id, quality };
  transcoders.set(key, entry);
  console.log(`[transcode ${key}] started → ${sourceUrl}`);
  return entry;
}

setInterval(() => {
  const now = Date.now();
  for (const [key, t] of transcoders) {
    if (now - t.lastAccess > TRANSCODE_IDLE_MS) {
      console.log(`[transcode ${key}] idle, killing`);
      try { t.proc.kill("SIGTERM"); } catch {}
    }
  }
}, 30_000);

// Kills the transcoder for a specific (mode, id), or all transcoders
// when neither is given. Called by the client immediately before
// switching streams so that the previous ffmpeg process — which would
// otherwise hold an upstream panel connection for TRANSCODE_IDLE_MS
// (90s) — does not collide with the new stream against the panel's
// max_connections=1 limit.
app.post("/api/transcode/stop", express.json(), (req, res) => {
  const { mode, id } = req.body || {};
  let killed = 0;
  if (mode && id) {
    // Prefix-match so a quality switch (which spawns a new transcoder
    // under a different key) and the kill-prev call from the client
    // both clean up *any* transcoder for this id, not just one
    // quality variant.
    const prefix = `${mode}-${id}-`;
    for (const [k, t] of transcoders) {
      if (k.startsWith(prefix)) {
        try { t.proc.kill("SIGTERM"); killed++; } catch {}
      }
    }
  } else {
    for (const t of transcoders.values()) {
      try { t.proc.kill("SIGTERM"); killed++; } catch {}
    }
  }
  res.json({ ok: true, killed });
});

app.get("/api/stream/:mode(live|movie|series)/:id.:ext", async (req, res) => {
  // Reject ids that aren't in this mode's index — most often this is
  // a stale URL or a mode-mixed-up link (e.g. clicking a series tile
  // in a unified search and ending up at /movie/.../<series_id>.mp4).
  // Without this guard streamUrl() happily builds a panel URL for an
  // id that lives in a different bucket; the panel then 4xx's the
  // download with no useful client error. For movies the index is
  // authoritative; for series the index keys by series_id (not
  // episode_id), so a per-episode lookup would always 404 here —
  // hence series is exempt and we let the panel decide.
  const idInt = parseInt(req.params.id, 10);
  if (req.params.mode === "movie" && Number.isFinite(idInt)) {
    if (!indexes.movie?.byId?.has(idInt)) {
      return res.status(404).json({
        error: "not in catalog",
        hint: "This id isn't in the current index — likely a stale link or a mode mismatch (e.g. a series id opened as a movie).",
      });
    }
  }
  const direct = streamUrl(req.params.mode, req.params.id, req.params.ext);
  // ?t=<secs> requests a transcode URL anchored at that source
  // offset — used when the client wants to fast-forward past the
  // already-encoded portion of the HLS playlist. t is part of the
  // HMAC so a stale URL with a different offset gets a 403. Omitting
  // t (the common case) signs identically to before so legacy
  // clients keep working.
  const offsetSecs = normalizeOffsetSecs(req.query.t);
  const transcodeSigInput = offsetSecs > 0
    ? `transcode:${req.params.mode}:${req.params.id}:${offsetSecs}`
    : `transcode:${req.params.mode}:${req.params.id}`;
  const transcodeSig = crypto.createHmac("sha256", PROXY_SECRET)
    .update(transcodeSigInput).digest("hex").slice(0, 16);
  const transcodeUrl = offsetSecs > 0
    ? `/api/transcode/${req.params.mode}/${req.params.id}/index.m3u8?s=${transcodeSig}&t=${offsetSecs}`
    : `/api/transcode/${req.params.mode}/${req.params.id}/index.m3u8?s=${transcodeSig}`;
  // /api/download produces a single-file 720p mp4 piped from ffmpeg.
  // Consumed by the Android phone's DownloadManager. HMAC-signed
  // with a dedicated prefix so it can't be forged from the proxy
  // signature or vice-versa.
  const downloadSig = crypto.createHmac("sha256", PROXY_SECRET)
    .update(`download:${req.params.mode}:${req.params.id}`).digest("hex").slice(0, 16);
  // Live channels with non-browser-decodable audio (MP2 / AC3 / EAC3
  // — common on sports feeds) get auto-routed through the transcoder
  // so the client never sees the silent-black-box failure mode. The
  // verdict is cached per channel; first hit blocks on ffprobe for
  // up to ~3s, subsequent hits are free. Movies / series skip this
  // path — they're already transcoded for MKV / unsupported codec
  // via the existing /api/stream → fragParsingError fallback.
  let forceTranscode = false;
  let forceReason = null;
  if (req.params.mode === "live" && req.params.ext === "m3u8") {
    const key = `${req.params.mode}:${req.params.id}`;
    let verdict = audioCodecCache[key];
    if (!isProbeFresh(verdict)) {
      try {
        const probed = await Promise.race([
          probeChannelAudioCodec(req.params.mode, req.params.id),
          new Promise((resolve) => setTimeout(() => resolve(null), 3500)),
        ]);
        if (probed) verdict = probed;
      } catch {}
    }
    if (verdict && verdict.audio_codec && !verdict.browser_safe) {
      forceTranscode = true;
      forceReason = `audio:${verdict.audio_codec}`;
    }
  }
  const primaryUrl = forceTranscode ? transcodeUrl : direct;
  res.json({
    direct,
    proxy: signProxyUrl(direct),
    transcode: transcodeUrl,
    download: `/api/download/${req.params.mode}/${req.params.id}.mp4?s=${downloadSig}`,
    url: primaryUrl,
    transcodeAnchorSecs: offsetSecs,
    forceTranscode,
    forceReason,
  });
});

// (moved earlier in the file so it sits ahead of the auth middleware
// — see `app.get("/api/download/...")` near the transcode routes.)

app.get("/api/index/:mode(live|movie|series)", (req, res) => {
  const mode = req.params.mode;
  const ix = indexes[mode];
  const userState = getProfileState(req.profileId);
  const activeProfile = profiles.profiles.find(p => p.id === req.profileId) || null;
  const modeKeys = (() => {
    const own = userState.filter?.groups?.[mode];
    if (Array.isArray(own) && own.length) return own;
    return userState.filter?.groups?.live || [];
  })();
  const onboarded = !!userState.filter?.onboarded && modeKeys.length > 0;
  const titleLangPasses = onboarded ? makeTitleLangFilter(new Set(modeKeys)) : () => true;
  // Skip kid-cert filter for live — broadcast channels don't ship a
  // us_cert, so a strict allow-list would hide every channel. Live
  // safety relies on the onboarded language/country/genre filter and
  // the kid-category regex baked into channel tags.
  const isKidBlocked = mode === "live" ? () => false : makeKidsBlocker(activeProfile);
  const seenTmdb = new Set();
  const streams = [];
  for (const s of ix.byId.values()) {
    if (!titleLangPasses(s.name)) continue;
    if (isKidBlocked(s)) continue;
    if (s.tmdb_id) {
      if (seenTmdb.has(s.tmdb_id)) continue;
      seenTmdb.add(s.tmdb_id);
    }
    streams.push(s);
  }
  res.json({ total: ix.total, done: ix.done, ready: ix.ready, streams });
});

app.get("/api/index/status", (_req, res) => {
  res.json({
    live:   { total: indexes.live.total,   done: indexes.live.done,   ready: indexes.live.ready },
    movie:  { total: indexes.movie.total,  done: indexes.movie.done,  ready: indexes.movie.ready },
    series: { total: indexes.series.total, done: indexes.series.done, ready: indexes.series.ready },
  });
});

// Batched on-demand channel probe. The TV-Guide UI calls this with
// whatever channel ids just scrolled into view; we return the
// current cache state immediately and fire-and-forget probes for
// anything missing or stale at controlled concurrency. The client
// polls every few seconds while uncached entries remain — late
// verdicts populate the inline "off-air" marker as they land.
//
// The panel max_connections=1 cap means we have to pace ourselves:
// concurrency=2 + a soft yield, and only when nothing is actively
// streaming (the caller passes `playing: true` to pause the queue).
const probeQueue = [];
let probeWorkers = 0;
const PROBE_CONCURRENCY = 2;
function enqueueProbe(mode, id) {
  const key = `${mode}:${id}`;
  if (audioProbeInflight.has(key)) return;
  if (isProbeFresh(audioCodecCache[key])) return;
  if (probeQueue.some(([m, i]) => m === mode && i === id)) return;
  probeQueue.push([mode, id]);
  pumpProbeQueue();
}
function pumpProbeQueue() {
  while (probeWorkers < PROBE_CONCURRENCY && probeQueue.length) {
    const [mode, id] = probeQueue.shift();
    probeWorkers++;
    probeChannelAudioCodec(mode, id).finally(() => {
      probeWorkers--;
      // Tiny yield so the panel doesn't see us as a hammer — same
      // host that enforces max_connections=1 also rate-limits
      // bursts of "probe a channel, drop the slot, probe another".
      setTimeout(pumpProbeQueue, 250);
    });
  }
}
// PROBE_CHANNELS_ENABLED guards the visible-channel probe sweep. With
// the panel's max_connections=1 cap and slow-reaping ghost sessions,
// even short-lived probes climb the panel's active_cons counter
// faster than it can decrement. Default OFF so the TV Guide doesn't
// hammer the panel. The /api/stream play-time probe (single hit, only
// when the user actually clicks a channel) stays on regardless —
// that's what auto-routes MP2 / AC3 channels through the transcoder.
const PROBE_CHANNELS_ENABLED = process.env.PROBE_CHANNELS_ENABLED === "1"
  || process.env.PROBE_CHANNELS_ENABLED === "true";
app.post("/api/probe-channels", express.json({ limit: "32kb" }), (req, res) => {
  if (!PROBE_CHANNELS_ENABLED) {
    return res.json({ verdicts: {}, pending: 0, disabled: true });
  }
  const mode = String(req.body?.mode || "live");
  const ids = Array.isArray(req.body?.ids) ? req.body.ids.slice(0, 200) : [];
  if (mode !== "live") return res.status(400).json({ error: "live-only for now" });
  const verdicts = {};
  for (const raw of ids) {
    const id = parseInt(raw, 10);
    if (!Number.isFinite(id)) continue;
    const key = `live:${id}`;
    const entry = audioCodecCache[key];
    if (entry && isProbeFresh(entry)) {
      verdicts[id] = entry;
    } else {
      enqueueProbe("live", id);
    }
  }
  res.json({ verdicts, pending: probeQueue.length });
});

app.post("/api/refresh", async (_req, res) => {
  const picked = await pickPanel();
  cache.clear();
  await clearDiskIndexes();
  for (const ix of Object.values(indexes)) {
    ix.ready = false;
    ix.byId = new Map();
    ix.done = 0;
    ix.total = 0;
  }
  buildAllIndexes();
  res.json({ ok: true, active_host: picked.active });
});

// Inventory of currently-tracked panel-touching streams. Useful for
// debugging concurrency issues and (in a follow-up) a UI showing who
// else in the household is currently streaming.
app.get("/api/streams", (_req, res) => {
  const list = [];
  for (const [owner, v] of streams) {
    list.push({
      owner_hash: crypto.createHash("sha1").update(owner).digest("hex").slice(0, 10),
      account_hash: crypto.createHash("sha1").update(v.accountKey || "").digest("hex").slice(0, 10),
      mode: v.mode, id: v.id,
      since_ms: Date.now() - v.since,
      last_seen_ms: Date.now() - v.lastSeen,
      displaced: v.displaced,
    });
  }
  res.json({
    cap_per_account: MAX_CONCURRENT_STREAMS,
    active: list.length,
    streams: list,
  });
});

app.get("/api/panel", (_req, res) => {
  res.json({
    active: PANEL,
    primary: PANEL_PRIMARY,
    fallbacks: PANEL_FALLBACKS,
    candidates: PANEL_CANDIDATES,
    using_primary: PANEL === PANEL_PRIMARY,
  });
});

app.post("/api/panel/switch", async (req, res) => {
  const host = req.query.host;
  if (!host) return res.status(400).json({ error: "host param required" });
  const r = await switchToHost(host);
  res.json({ active: r.active, reason: r.reason });
});

// Return the current panel config (no password). Used by the settings
// UI to pre-fill the form with the active values.
app.get("/api/panel/config", (_req, res) => {
  res.json({
    host: IPTV_HOST,
    host_fallback: IPTV_HOST_FALLBACK,
    user: IPTV_USER,
    // Indicate a password is configured without exposing it. The form
    // shows a placeholder so the user knows they can leave it blank to
    // keep the current password.
    has_pass: !!IPTV_PASS,
  });
});

// "Test" a proposed config without committing it. Probes the primary
// host with the proposed user/pass. Returns { ok, reason }.
app.post("/api/panel/config/test", express.json(), async (req, res) => {
  const b = req.body || {};
  const host = String(b.host || "").trim().replace(/\/$/, "");
  const user = String(b.user || "").trim();
  // Treat empty pass as "use current password" — same logic as the
  // save endpoint — so test from the settings form works without
  // re-typing the password every time.
  const pass = b.pass === "" || b.pass == null ? IPTV_PASS : String(b.pass);
  if (!host || !user || !pass) {
    return res.status(400).json({ ok: false, reason: "host, user, and pass required" });
  }
  const r = await probePanel(host, user, pass);
  res.json({ ok: r.ok, reason: r.reason || null });
});

// Save a new panel config to disk + mutate the live state. Validates
// the primary host first; if it fails, returns 400 and the old config
// stays active. On success: writes disk, flips creds, clears caches,
// kicks off a fresh index build in the background.
app.put("/api/panel/config", express.json(), async (req, res) => {
  const b = req.body || {};
  const host         = String(b.host || "").trim().replace(/\/$/, "");
  const hostFallback = String(b.host_fallback || b.hostFallback || "").trim();
  const user         = String(b.user || "").trim();
  // Empty password = keep current (lets the user edit host/user
  // without re-entering the password).
  const pass = (b.pass === "" || b.pass == null) ? IPTV_PASS : String(b.pass);
  if (!host || !user || !pass) {
    return res.status(400).json({ ok: false, reason: "host, user, and pass required" });
  }
  const probe = await probePanel(host, user, pass);
  if (!probe.ok) {
    return res.status(400).json({ ok: false, reason: `panel probe failed: ${probe.reason}` });
  }
  // Commit.
  IPTV_HOST          = host;
  IPTV_HOST_FALLBACK = hostFallback;
  IPTV_USER          = user;
  IPTV_PASS          = pass;
  writePanelConfigToDisk({ host, hostFallback, user, pass });
  recomputePanelDerived();
  PANEL = PANEL_PRIMARY; // start from primary on a fresh config
  // Wipe in-memory + on-disk caches so we don't serve stale stuff
  // belonging to the previous panel.
  cache.clear();
  try { await clearDiskIndexes(); } catch {}
  for (const ix of Object.values(indexes)) {
    ix.ready = false;
    ix.byId = new Map();
    ix.done = 0;
    ix.total = 0;
  }
  buildAllIndexes().catch(() => {});
  console.log(`[panel] config updated → ${PANEL}`);
  res.json({ ok: true, active: PANEL });
});

app.get(/^\/(live|movie|series)(\/.*)?$/, (_req, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

app.use((err, _req, res, _next) => {
  console.error(err);
  res.status(500).json({ error: err.message });
});

app.listen(PORT, async () => {
  console.log(`khouch potato listening on :${PORT}`);
  console.log(`  primary:    ${PANEL_PRIMARY}`);
  console.log(`  fallbacks:  ${PANEL_FALLBACKS.join(", ") || "(none)"}`);
  console.log(`  data dir:   ${DATA_DIR}`);
  console.log(`  tmdb:       ${TMDB_API_KEY ? "enabled" : "disabled (set TMDB_API_KEY to enable)"}`);
  console.log(`  concurrency cap: ${MAX_CONCURRENT_STREAMS} concurrent stream(s) per IPTV account`);
  console.log(`  panel-config:    ${PANEL_CONFIG_KEY ? "encrypted (AES-256-GCM)" : "plaintext (set PROXY_SECRET in env to encrypt at rest)"}`);

  for (const mode of Object.keys(indexes)) {
    const data = await loadIndexFromDisk(mode);
    if (data) {
      const ageH = ((Date.now() - data.savedAt) / 3_600_000).toFixed(1);
      console.log(`[${mode}] loaded ${data.streams.length} items from disk (${ageH}h old)`);
    }
  }

  await pickPanel();
  console.log(`  active:     ${PANEL}`);

  const STALE_MS = TTL_MS;
  const needsRebuild = (mode) => {
    const f = indexFilePath(mode);
    try {
      const stat = fs.statSync(f);
      return Date.now() - stat.mtimeMs > STALE_MS;
    } catch {
      return true;
    }
  };
  const stale = new Set(Object.keys(indexes).filter(needsRebuild));
  // The live index gained an `epg_channel_id` field; if the cached copy
  // pre-dates that addition, force a rebuild so the TV Guide can split
  // channels into "with EPG" / "without EPG" without an extra fetch.
  if (indexes.live.byId.size > 0) {
    const sample = indexes.live.byId.values().next().value;
    if (sample && !("epg_channel_id" in sample)) {
      console.log("[live] cached index pre-dates epg_channel_id field; rebuilding");
      indexes.live.ready = false;
      indexes.live.byId = new Map();
      indexes.live.done = 0;
      indexes.live.total = 0;
      stale.add("live");
    }
  }
  if (stale.size) {
    const list = [...stale];
    console.log(`rebuilding stale indexes in background: ${list.join(", ")}`);
    Promise.all(list.map(buildIndex)).catch(() => {});
  } else {
    console.log("all indexes fresh; no rebuild needed at boot");
    // No rebuild planned → make sure TMDB cache is warm for any
    // movie/series items added since the last prewarm pass. Skipped
    // items already in cache return cheaply; new ones get fetched at
    // low concurrency in the background.
    if (indexes.movie.ready) {
      prewarmQualityCache().catch(e => console.warn(`[movie] quality boot prewarm: ${e.message}`));
    }
    if (TMDB_API_KEY) {
      for (const m of ["movie", "series"]) {
        if (indexes[m].ready) {
          prewarmTmdbCache(m).catch(e => console.warn(`[${m}] boot prewarm: ${e.message}`));
        }
      }
    }
  }

  setInterval(async () => {
    await pickPanel();
    buildAllIndexes();
  }, TTL_MS);

  // EPG bulk index: load any cached xmltv from disk; refresh now if
  // it's older than 24h; then schedule a nightly 3 AM refresh. The
  // boot-time refresh is fire-and-forget — every other code path
  // gracefully falls back to per-channel get_simple_data_table while
  // the xmltv download / parse is in flight.
  loadEpgIndexFromDisk().then(() => {
    if (Date.now() - epgIndexBuiltAt > EPG_XMLTV_STALE_MS) {
      prewarmEpg().catch(e => console.warn(`[epg] boot prewarm: ${e.message}`));
    }
    scheduleEpgNightlyRefresh();
  });

  // TMDB no-match retry — runs at 3:30 AM local, 30 min after the
  // xmltv pull so the two heavy panel-adjacent jobs don't fight for
  // headroom. Promotes any cached "no-match" entry that TMDB now
  // resolves (titles get added / fixed there over time).
  scheduleTmdbNightlyRetry();
});
