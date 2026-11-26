// Pure logic for the live buffering rescue (docs/LIVE_RESCUE.md): per-session
// health counters, struggle detection, the auto-switch rate limit and the
// undo cooldown. No DOM here, so tests/rescue-logic.test.js can require() it.
// Same numbers as the phone and TV clients.
(function (root) {
  "use strict";

  const STALLS_WINDOW_MS = 90_000;
  const LONG_STALL_MS = 7_000;
  const RECONNECTS_WINDOW_MS = 180_000;
  const NO_FRAME_MS = 15_000;
  const MAX_AUTO_SWITCHES = 2;
  const SWITCH_WINDOW_MS = 10 * 60_000;
  const UNDO_COOLDOWN_MS = 10 * 60_000;
  const UNDO_WINDOW_MS = 10_000;
  // After an alternates query that offered nothing, the same session waits
  // this long before asking again (a struggle condition stays true for a while).
  const REQUERY_MS = 60_000;

  // One session = one channel copy played until stop / zap / rescue / exit.
  function createSession(id, now) {
    return {
      id: String(id),
      playAt: now,
      firstFrameAt: null,
      stalls: 0,
      stallStarts: [],
      stallMs: 0,
      stallSince: null,
      reconnectsAt: [],
      watchedMs: 0,
      playingSince: null,
      lastQueryAt: null,
    };
  }

  function onFirstFrame(s, now) {
    if (s.firstFrameAt != null) return;
    s.firstFrameAt = now;
    if (s.playingSince == null) s.playingSince = now;
  }

  // Watched time only accrues once a frame has been shown.
  function onPlaying(s, now) {
    if (s.stallSince != null) onStallEnd(s, now);
    if (s.firstFrameAt != null && s.playingSince == null) s.playingSince = now;
  }

  // Paused, ended, torn down: watched time stops accruing.
  function onNotPlaying(s, now) {
    if (s.playingSince != null) {
      s.watchedMs += Math.max(0, now - s.playingSince);
      s.playingSince = null;
    }
  }

  // Rebuffer. Only counted after the first frame; the caller filters out
  // user pauses.
  function onStallStart(s, now) {
    if (s.firstFrameAt == null || s.stallSince != null) return;
    onNotPlaying(s, now);
    s.stallSince = now;
    s.stalls += 1;
    s.stallStarts.push(now);
  }

  function onStallEnd(s, now) {
    if (s.stallSince == null) return;
    s.stallMs += Math.max(0, now - s.stallSince);
    s.stallSince = null;
  }

  function onReconnect(s, now) {
    s.reconnectsAt.push(now);
  }

  // null, or the reason string the server logs.
  function struggleReason(s, now) {
    if (s.firstFrameAt == null) {
      return now - s.playAt >= NO_FRAME_MS ? "noframe" : null;
    }
    if (s.stallSince != null && now - s.stallSince >= LONG_STALL_MS) return "stall7s";
    const starts = s.stallStarts;
    for (let i = 1; i < starts.length; i++) {
      if (starts[i] - starts[i - 1] <= STALLS_WINDOW_MS && now - starts[i - 1] <= STALLS_WINDOW_MS) return "stalls";
    }
    const rc = s.reconnectsAt;
    for (let i = 1; i < rc.length; i++) {
      if (rc[i] - rc[i - 1] <= RECONNECTS_WINDOW_MS && now - rc[i - 1] <= RECONNECTS_WINDOW_MS) return "reconnects";
    }
    return null;
  }

  function mayQuery(s, now) {
    return s.lastQueryAt == null || now - s.lastQueryAt >= REQUERY_MS;
  }

  // POST /api/live/health body, or null when there is nothing to report.
  // `reason` is the struggle reason on a rescue switch; `error` marks a
  // session the player gave up on.
  function buildReport(s, now, reason, error) {
    const stallMs = s.stallMs + (s.stallSince != null ? Math.max(0, now - s.stallSince) : 0);
    const watchedMs = s.watchedMs + (s.playingSince != null ? Math.max(0, now - s.playingSince) : 0);
    const failed = s.firstFrameAt == null;
    const reconnects = s.reconnectsAt.length;
    // Zapping away while a channel is still loading says nothing about the
    // copy: only a give-up, a rescue or the no-frame timeout counts as failed.
    if (failed && !error && !reason && !reconnects && now - s.playAt < NO_FRAME_MS) return null;
    if (!failed && watchedMs <= 0 && !s.stalls && !reconnects) return null;
    return {
      ttffMs: failed ? null : Math.max(0, s.firstFrameAt - s.playAt),
      stalls: s.stalls,
      stallMs: Math.round(stallMs),
      reconnects,
      watchedMs: Math.round(watchedMs),
      failed,
      reason: reason || "end",
    };
  }

  // Auto-switch budget (sliding window), per-channel undo cooldown, and the
  // copies a switch just left (not offered again inside the switch window, so
  // a struggling A -> B never bounces back B -> A).
  function createLimiter() {
    const switches = [];
    const cooldownUntil = new Map();
    const leftUntil = new Map();
    return {
      canAutoSwitch(channelId, now) {
        const until = cooldownUntil.get(String(channelId));
        if (until != null) {
          if (now < until) return false;
          cooldownUntil.delete(String(channelId));
        }
        while (switches.length && now - switches[0] >= SWITCH_WINDOW_MS) switches.shift();
        return switches.length < MAX_AUTO_SWITCHES;
      },
      recordSwitch(now, fromId) {
        switches.push(now);
        if (fromId != null) leftUntil.set(String(fromId), now + SWITCH_WINDOW_MS);
      },
      isExcluded(channelId, now) {
        const until = leftUntil.get(String(channelId));
        if (until == null) return false;
        if (now < until) return true;
        leftUntil.delete(String(channelId));
        return false;
      },
      recordUndo(channelId, now) { cooldownUntil.set(String(channelId), now + UNDO_COOLDOWN_MS); },
    };
  }

  // The best-ranked alternate of a GET /api/live/alternates payload that clears
  // the floor and isn't excluded (isExcluded(id) -> true skips it).
  function pickAlternate(payload, isExcluded) {
    const list = payload && Array.isArray(payload.alternates) ? payload.alternates : [];
    const floor = Number.isFinite(payload && payload.floor) ? payload.floor : 55;
    for (const alt of list) {
      if (!alt || alt.id == null) continue;
      if (isExcluded && isExcluded(alt.id)) continue;
      if (Number(alt.score) >= floor) return alt;
    }
    return null;
  }

  const api = {
    STALLS_WINDOW_MS, LONG_STALL_MS, RECONNECTS_WINDOW_MS, NO_FRAME_MS,
    MAX_AUTO_SWITCHES, SWITCH_WINDOW_MS, UNDO_COOLDOWN_MS, UNDO_WINDOW_MS, REQUERY_MS,
    createSession, onFirstFrame, onPlaying, onNotPlaying, onStallStart, onStallEnd, onReconnect,
    struggleReason, mayQuery, buildReport, createLimiter, pickAlternate,
  };
  if (typeof module === "object" && module.exports) module.exports = api;
  else root.KRescue = api;
})(typeof window !== "undefined" ? window : globalThis);
