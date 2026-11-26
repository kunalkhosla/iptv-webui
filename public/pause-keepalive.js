// Pause keep-alive controller (docs/PAUSE_KEEPALIVE.md). While a movie /
// episode / disk title is paused in the player, POST /api/stream/heartbeat
// { mode, id } right away and then every INTERVAL_MS so the server's idle
// reaper keeps the session (and its transcode) for the resume. Stops after
// MAX_MS of continuous pause, and on play / close / background / cast.
// Live never heartbeats. No DOM here, so tests can require() it. Same
// numbers as the phone and TV clients.
(function (root) {
  "use strict";

  const INTERVAL_MS = 60_000;
  const MAX_MS = 60 * 60_000;
  const MODES = new Set(["movie", "series", "disk"]);

  // deps = { post(target) -> Promise<{status, body}>, now(), setTimer(fn, ms),
  //          clearTimer(handle), intervalMs?, maxMs? }
  function create(deps) {
    const intervalMs = deps.intervalMs || INTERVAL_MS;
    const maxMs = deps.maxMs || MAX_MS;
    let target = null;    // { mode, id } while keeping alive
    let pausedAt = 0;
    let timer = null;
    let gen = 0;          // bumps on every stop/start so stale replies are ignored
    let stoppedBy = null;

    function clear() { if (timer != null) { deps.clearTimer(timer); timer = null; } }

    function stop(reason) {
      clear();
      if (target) stoppedBy = reason || "stop";
      target = null;
      gen++;
    }

    function beat(myGen) {
      timer = null;
      if (myGen !== gen || !target) return;
      if (deps.now() - pausedAt >= maxMs) { stop("cap"); return; }
      const t = target;
      Promise.resolve()
        .then(() => deps.post({ mode: t.mode, id: t.id }))
        .then((r) => {
          if (myGen !== gen) return;
          const status = r && r.status;
          const body = (r && r.body) || {};
          if (status === 410) { stop("displaced"); return; }
          if (status === 200 && body.kept === false) { stop(body.reason || "not-kept"); return; }
          // 400 bad body; 401/403 signed out; 404/405 a server without the endpoint.
          if (status === 400 || status === 401 || status === 403 || status === 404 || status === 405) { stop("rejected"); }
        }, () => { /* network blip: keep trying on the next interval */ });
      if (myGen === gen && target) {
        const left = maxMs - (deps.now() - pausedAt);
        timer = deps.setTimer(() => beat(myGen), Math.max(0, Math.min(intervalMs, left)));
      }
    }

    // The player paused `mode`/`id`. Starts (or keeps) the keep-alive; a new
    // title restarts the clock.
    function paused(mode, id, at) {
      if (!MODES.has(mode) || id == null || String(id) === "") { stop("unsupported"); return; }
      const sid = String(id);
      if (target && target.mode === mode && target.id === sid) return; // already running
      stop("retarget");
      target = { mode, id: sid };
      pausedAt = at != null ? at : deps.now();
      stoppedBy = null;
      const myGen = ++gen;
      beat(myGen);
    }

    // Foregrounded again while still paused: continue within the original
    // pause's 60-min budget (the clock is NOT reset by backgrounding).
    function resumeAfterBackground(mode, id, originalPausedAt) {
      if (originalPausedAt == null || deps.now() - originalPausedAt >= maxMs) return;
      paused(mode, id, originalPausedAt);
    }

    return {
      paused,
      resumeAfterBackground,
      stop,
      get active() { return !!target; },
      get pausedAt() { return target ? pausedAt : null; },
      get stoppedBy() { return stoppedBy; },
    };
  }

  const api = { create, INTERVAL_MS, MAX_MS };
  if (typeof module === "object" && module.exports) module.exports = api;
  else root.KPauseKeepalive = api;
})(typeof window !== "undefined" ? window : globalThis);
