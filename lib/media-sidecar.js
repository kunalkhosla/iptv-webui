// Media sidecar: trick-play thumbnails and intro/credits fingerprints, made
// WITHOUT ever opening an upstream (panel) stream.
//
//  1. Piggyback: every few seconds, look at the HLS segments that a viewer's
//     own VOD transcode has already written to local disk, and (one small
//     low-priority ffmpeg at a time) grab a keyframe thumbnail every
//     ~interval seconds and decode the audio of episodes for fingerprints.
//  2. Offline: Disk-library files (local drive) are analysed whole, one job
//     at a time, only while nobody is watching anything; a job is killed the
//     moment a viewer starts and retried later.
//
// Everything is injected, so tests can drive it with fakes.

const fs = require("fs");
const os = require("os");
const path = require("path");
const fpLib = require("./fingerprint");
const ma = require("./media-analysis");

function runFfmpeg(spawnFn, bin, args, { timeoutMs = 90_000, maxBytes = 64 * 1024 * 1024, isCancelled = () => false } = {}) {
  return new Promise((resolve) => {
    let proc;
    try {
      proc = spawnFn(bin, args, { stdio: ["ignore", "pipe", "pipe"] });
    } catch (e) {
      return resolve({ ok: false, error: e.message, out: Buffer.alloc(0) });
    }
    try { os.setPriority(proc.pid, 19); } catch {}
    const chunks = [];
    let size = 0;
    let err = "";
    let killedWhy = null;
    const kill = (why) => { if (!killedWhy) { killedWhy = why; try { proc.kill("SIGKILL"); } catch {} } };
    proc.stdout.on("data", (d) => { size += d.length; if (size > maxBytes) kill("too much output"); else chunks.push(d); });
    proc.stderr.on("data", (d) => { err = (err + d.toString()).slice(-600); });
    const timer = setTimeout(() => kill("timeout"), timeoutMs);
    const poll = setInterval(() => { if (isCancelled()) kill("cancelled"); }, 1000);
    if (timer.unref) timer.unref();
    if (poll.unref) poll.unref();
    proc.on("error", (e) => { err = e.message; });
    proc.on("close", (code) => {
      clearTimeout(timer); clearInterval(poll);
      resolve({ ok: code === 0 && !killedWhy, code, killed: killedWhy, error: killedWhy || err.trim(), out: Buffer.concat(chunks) });
    });
  });
}

function createMediaSidecar({
  trickplay,
  markers,
  listTranscodes,           // () => [{ entry, mode, id, dir, offsetSecs }]
  groupFor,                 // (mode, id) => { group, season, dur } | null
  viewerActive = () => false, // anyone streaming anything (offline jobs yield)
  spawnFn = require("child_process").spawn,
  ffmpegBin = "ffmpeg",
  interval = 10,
  thumbWidth = 240,
  maxLoad = Math.max(2, os.cpus().length * 0.75),
  loadAvg = () => os.loadavg()[0],
  log = () => {},
  now = Date.now,
} = {}) {
  const states = new Map();    // transcode entry -> state
  const queue = [];            // piggyback jobs (high) then offline (low)
  const offline = [];
  const offlineKeys = new Set();
  let running = false;
  let current = null;
  const stats = { thumbs: 0, audioBatches: 0, offlineDone: 0, offlineCancelled: 0, errors: 0, skippedLoad: 0 };

  function stateFor(t) {
    let s = states.get(t.entry);
    if (!s || s.dir !== t.dir) {
      const prev = s;
      s = {
        dir: t.dir, mode: t.mode, id: String(t.id), offset: t.offsetSecs || 0,
        lastN: -1, pendingThumbs: new Set(), lastThumbAbs: -Infinity,
        // Fingerprints carry over a dir reset (same title, content-timed).
        group: prev ? prev.group : undefined, head: prev ? prev.head : null,
        chunks: prev ? prev.chunks : [], ended: false, total: 0,
        audioPending: 0, persistedHeadCov: prev ? prev.persistedHeadCov : 0, tailDone: prev ? prev.tailDone : false,
        lastSeen: now(),
      };
      states.set(t.entry, s);
    }
    s.lastSeen = now();
    return s;
  }

  function wantsAudio(s) {
    if (s.mode !== "series" && s.mode !== "disk") return false;
    if (s.group === undefined) {
      let g = null;
      try { g = groupFor(s.mode, s.id); } catch { g = null; }
      s.group = g || null;
    }
    return !!s.group;
  }

  function scan() {
    let list = [];
    try { list = listTranscodes() || []; } catch { list = []; }
    const live = new Set();
    for (const t of list) {
      if (!t || !t.entry || !t.dir || !["movie", "series", "disk"].includes(t.mode)) continue;
      live.add(t.entry);
      const s = stateFor(t);
      let text;
      try { text = fs.readFileSync(path.join(t.dir, "index.m3u8"), "utf8"); } catch { continue; }
      const pl = ma.parsePlaylist(text);
      s.total = pl.segments.length ? pl.segments[pl.segments.length - 1].start + pl.segments[pl.segments.length - 1].dur : 0;
      const fresh = pl.segments.filter((g) => g.n > s.lastN);
      if (fresh.length) s.lastN = fresh[fresh.length - 1].n;
      const { times } = trickplay.list(s.mode, s.id);
      const audio = wantsAudio(s);
      const audioSegs = [];
      for (const g of fresh) {
        const abs = s.offset + g.start;
        if (abs - s.lastThumbAbs >= interval - 1) {
          const tt = ma.thumbWanted(times, abs, interval);
          if (tt != null && !s.pendingThumbs.has(tt)) {
            s.pendingThumbs.add(tt);
            s.lastThumbAbs = abs;
            queue.push({ kind: "thumb", s, file: path.join(t.dir, g.file), t: tt });
          } else if (tt == null) {
            s.lastThumbAbs = abs;
          }
        }
        if (audio) audioSegs.push({ ...g, abs });
      }
      if (audio && audioSegs.length) {
        for (const b of ma.batchSegments(audioSegs, 60)) {
          s.audioPending++;
          queue.push({ kind: "audio", s, files: b.map((g) => path.join(t.dir, g.file)), startAbs: b[0].abs });
        }
      }
      if (pl.ended) s.ended = true;
    }
    // Entries that went away (viewer left / title finished and reaped):
    // persist what was captured, then forget.
    for (const [entry, s] of states) {
      if (live.has(entry)) continue;
      states.delete(entry);
      finalize(s, true);
    }
    pump();
  }

  // Persist head (when it grew meaningfully) and, once the transcode reached
  // the end of the title, the tail. Then compare with the other episodes.
  function finalize(s, leaving = false) {
    if (!s.group || s.audioPending > 0) return;
    let changed = false;
    const put = {};
    if (s.head) {
      const cov = fpLib.coverageSec(s.head);
      if (cov >= 60 && (cov - s.persistedHeadCov >= 120 || (leaving && cov > s.persistedHeadCov) || cov >= ma.HEAD_SEC - 30)) {
        if (cov > s.persistedHeadCov) { put.head = s.head; s.persistedHeadCov = cov; changed = true; }
      }
    }
    if (s.ended && !s.tailDone && s.total > 0) {
      const dur = s.offset + s.total;
      if (dur > ma.TAIL_SEC + 60) {
        const tw = fpLib.createWindow(dur - ma.TAIL_SEC, ma.TAIL_SEC);
        for (const c of s.chunks) if (c.start + 70 >= dur - ma.TAIL_SEC) fpLib.placeHashes(tw, c.start, c.hashes);
        if (fpLib.coverageSec(tw) >= ma.TAIL_SEC * 0.6) { put.tail = tw; put.dur = dur; changed = true; }
      }
      s.tailDone = true;
    }
    if (!changed) return;
    const key = `${s.mode}:${s.id}`;
    try {
      markers.putWindows(key, { group: s.group.group, season: s.group.season ?? null, dur: put.dur || s.group.dur || null, head: put.head || null, tail: put.tail || null });
      const m = markers.analyse(key);
      log(`[sidecar] ${key} fingerprints saved (head ${Math.round(s.persistedHeadCov)}s${put.tail ? ", tail" : ""}); markers ${m ? JSON.stringify({ i: [m.introStart, m.introEnd], c: m.creditsStart }) : "none yet"}`);
    } catch (e) { stats.errors++; log(`[sidecar] ${key} save failed: ${e.message}`); }
  }

  async function runThumb(job) {
    const base = ["-nostdin", "-hide_banner", "-v", "error", "-threads", "1"];
    const tail = ["-i", job.file, "-frames:v", "1", "-an", "-sn", "-vf", `scale=${thumbWidth}:-2`, "-q:v", "7", "-f", "image2pipe", "-c:v", "mjpeg", "pipe:1"];
    let r = await runFfmpeg(spawnFn, ffmpegBin, [...base, "-skip_frame", "nokey", ...tail], { timeoutMs: 30_000, maxBytes: 2 * 1024 * 1024 });
    if (!r.out.length) r = await runFfmpeg(spawnFn, ffmpegBin, [...base, ...tail], { timeoutMs: 30_000, maxBytes: 2 * 1024 * 1024 });
    job.s.pendingThumbs.delete(job.t);
    if (r.out.length && trickplay.put(job.s.mode, job.s.id, job.t, r.out)) stats.thumbs++;
    else if (!/No such file/i.test(r.error || "")) stats.errors++;
  }

  async function runAudio(job) {
    try {
      const r = await runFfmpeg(spawnFn, ffmpegBin, [
        "-nostdin", "-hide_banner", "-v", "error", "-threads", "1",
        "-i", `concat:${job.files.join("|")}`, "-vn", "-sn", "-ac", "1", "-ar", String(fpLib.SAMPLE_RATE), "-f", "s16le", "pipe:1",
      ], { timeoutMs: 60_000, maxBytes: 16 * 1024 * 1024 });
      if (r.out.length < fpLib.FRAME * 4) return;
      const hashes = fpLib.fingerprintPcm(r.out);
      stats.audioBatches++;
      const s = job.s;
      if (job.startAbs < ma.HEAD_SEC) {
        if (!s.head) s.head = fpLib.createWindow(0, ma.HEAD_SEC);
        fpLib.placeHashes(s.head, job.startAbs, hashes);
      }
      s.chunks.push({ start: job.startAbs, hashes });
      // Keep memory bounded: only chunks that can still be in the tail (the
      // last TAIL_SEC + slack of what has been produced) are needed.
      const horizon = s.offset + s.total - ma.TAIL_SEC - 120;
      if (s.chunks.length > 20) s.chunks = s.chunks.filter((c) => c.start + 70 >= horizon);
    } finally {
      job.s.audioPending--;
      if (job.s.audioPending === 0) finalize(job.s);
    }
  }

  // ---- offline (Disk library) ----
  const offlineTried = new Map(); // key -> when it last finished (ok or not)
  const OFFLINE_RETRY_MS = 24 * 3600_000;
  function enqueueOffline(job) {
    if (!job || !job.key || offlineKeys.has(job.key)) return false;
    const tried = offlineTried.get(job.key);
    if (tried && now() - tried < OFFLINE_RETRY_MS) return false;
    offlineKeys.add(job.key);
    offline.push(job);
    pump();
    return true;
  }

  async function runOfflineThumbs(job) {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "trickplay-"));
    try {
      const r = await runFfmpeg(spawnFn, ffmpegBin, [
        "-nostdin", "-hide_banner", "-v", "error", "-threads", "2", "-skip_frame", "nokey",
        "-i", job.file, "-an", "-sn", "-vf", `fps=1/${interval},scale=${thumbWidth}:-2`, "-q:v", "7",
        "-f", "image2", "-start_number", "0", path.join(tmp, "%06d.jpg"),
      ], { timeoutMs: 45 * 60_000, isCancelled: () => viewerActive() });
      if (r.killed === "cancelled") return "cancelled";
      let n = 0;
      for (const f of fs.readdirSync(tmp).sort()) {
        const m = /^(\d{6})\.jpg$/.exec(f);
        if (!m) continue;
        try { if (trickplay.put(job.mode, job.id, parseInt(m[1], 10) * interval, fs.readFileSync(path.join(tmp, f)))) n++; } catch {}
      }
      if (r.ok && n) trickplay.markComplete(job.mode, job.id);
      log(`[sidecar] offline thumbnails ${job.mode}:${job.id}: ${n} frames${r.ok ? "" : ` (ffmpeg: ${r.error})`}`);
      return r.ok ? "ok" : "error";
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  }

  async function runOfflineFingerprint(job) {
    const grab = (pre, post) => runFfmpeg(spawnFn, ffmpegBin, [
      "-nostdin", "-hide_banner", "-v", "error", "-threads", "1", ...pre, "-i", job.file, ...post,
      "-vn", "-sn", "-ac", "1", "-ar", String(fpLib.SAMPLE_RATE), "-f", "s16le", "pipe:1",
    ], { timeoutMs: 10 * 60_000, isCancelled: () => viewerActive() });
    const h = await grab([], ["-t", String(ma.HEAD_SEC)]);
    if (h.killed === "cancelled") return "cancelled";
    let head = null, tail = null;
    if (h.out.length) { head = fpLib.createWindow(0, ma.HEAD_SEC); fpLib.placeHashes(head, 0, fpLib.fingerprintPcm(h.out)); }
    if (job.dur && job.dur > ma.TAIL_SEC + 60) {
      const t = await grab(["-ss", String(Math.max(0, job.dur - ma.TAIL_SEC))], []);
      if (t.killed === "cancelled") return "cancelled";
      if (t.out.length) { tail = fpLib.createWindow(job.dur - ma.TAIL_SEC, ma.TAIL_SEC); fpLib.placeHashes(tail, job.dur - ma.TAIL_SEC, fpLib.fingerprintPcm(t.out)); }
    }
    if (!head && !tail) return "error";
    const key = `${job.mode}:${job.id}`;
    markers.putWindows(key, { group: job.group, season: job.season ?? null, dur: job.dur || null, head, tail });
    const m = markers.analyse(key);
    log(`[sidecar] offline fingerprint ${key}: markers ${m ? JSON.stringify({ i: [m.introStart, m.introEnd], c: m.creditsStart }) : "none yet"}`);
    return "ok";
  }

  async function pump() {
    if (running) return;
    running = true;
    try {
      for (;;) {
        let job = queue.shift();
        if (!job) {
          if (!offline.length || viewerActive()) break;
          job = offline.shift();
        }
        // Back off when the box is busy (a transcode, a build): piggyback work
        // can wait a little, it is reading local files that stay until the
        // viewer leaves.
        if (loadAvg() > maxLoad) {
          stats.skippedLoad++;
          if (job.kind === "thumb" || job.kind === "audio") queue.unshift(job); else offline.unshift(job);
          setTimeout(() => pump(), 15_000).unref?.();
          break;
        }
        current = job;
        try {
          if (job.kind === "thumb") await runThumb(job);
          else if (job.kind === "audio") await runAudio(job);
          else {
            const r = job.kind === "offline-thumbs" ? await runOfflineThumbs(job) : await runOfflineFingerprint(job);
            if (r === "cancelled") {
              stats.offlineCancelled++;
              offline.unshift(job); // retry when idle again
              break;
            }
            offlineKeys.delete(job.key);
            offlineTried.set(job.key, now());
            stats.offlineDone++;
          }
        } catch (e) {
          stats.errors++;
          log(`[sidecar] ${job.kind} failed: ${e.message}`);
          if (job.key) { offlineKeys.delete(job.key); offlineTried.set(job.key, now()); }
        } finally {
          current = null;
        }
      }
    } finally {
      running = false;
    }
  }

  return {
    scan,
    pump,
    enqueueOffline,
    stats: () => ({ ...stats, queued: queue.length, offlineQueued: offline.length, tracking: states.size, current: current ? current.kind : null }),
  };
}

module.exports = { createMediaSidecar, runFfmpeg };
