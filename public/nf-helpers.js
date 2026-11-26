// Pure helpers for the web's Netflix-style extras (scrub thumbnails, skip
// intro / credits, "Still watching?", generated title cards). No DOM here,
// so tests/web-netflix.test.js can require() this file. Mirrors the phone
// (iptv-android-companion-private core/playback/Trickplay.kt, SkipMarkers.kt,
// core/util/TitleCard.kt) so every client behaves the same.
// Server contract: docs/NETFLIX_FEATURES.md.
(function (root) {
  "use strict";

  // ---- 1. Trick-play thumbnails ------------------------------------------
  const TRICKPLAY_REFRESH_MS = 30_000;
  const MAX_GAP_INTERVALS = 3;

  // The frame to show at `pos` seconds: the largest frame <= pos, else the
  // next one. null when there are none, or both are more than 3 x interval
  // away (a part nothing encoded: a far-off frame would mislead).
  function frameFor(frames, pos, interval) {
    if (!Array.isArray(frames) || !frames.length || !Number.isFinite(pos)) return null;
    let lo = 0, hi = frames.length - 1, best = -1;
    while (lo <= hi) {
      const mid = (lo + hi) >>> 1;
      if (frames[mid] <= pos) { best = mid; lo = mid + 1; } else hi = mid - 1;
    }
    const gap = Math.max(Number(interval) || 10, 1) * MAX_GAP_INTERVALS;
    if (best >= 0 && pos - frames[best] <= gap) return frames[best];
    const after = frames[best + 1];
    if (after == null) return null;
    return after - pos <= gap ? after : null;
  }

  // Server-relative frame URL from the template ("/api/trickplay/m/id/{t}.jpg").
  function frameUrl(info, t) {
    if (!info || typeof info.url !== "string" || !Number.isFinite(t)) return null;
    return info.url.split("{t}").join(encodeURIComponent(String(t)));
  }

  // Left edge (px) of a preview `previewW` wide centred on `fraction` of the
  // bar, kept inside [0, containerW - previewW].
  function previewLeft(fraction, barLeft, barWidth, previewW, containerW) {
    const f = Math.min(1, Math.max(0, Number(fraction) || 0));
    const center = barLeft + f * barWidth;
    const maxLeft = Math.max(0, containerW - previewW);
    return Math.min(maxLeft, Math.max(0, center - previewW / 2));
  }

  function trickplaySupported(mode) { return mode === "movie" || mode === "series" || mode === "disk"; }

  // ---- 2. Skip intro / credits ------------------------------------------
  const CREDITS_COUNTDOWN_SEC = 10;
  const MARKERS_REFETCH_AFTER_MS = 120_000;
  const MIN_SPAN_SEC = 5;

  function markersSupported(mode) { return mode === "series" || mode === "disk"; }

  function num(v) { return typeof v === "number" && Number.isFinite(v) ? v : null; }

  function span(start, end, pos) {
    start = num(start); end = num(end);
    if (start == null || end == null) return null;
    if (end - start < MIN_SPAN_SEC || start < 0) return null;
    // Hide 1 s before the end: a click there would be a no-op seek.
    return pos >= start && pos < end - 1 ? end : null;
  }

  function inCredits(m, pos, duration) {
    const c = num(m && m.creditsStart);
    if (c == null || c <= 0) return false;
    if (duration > 0 && c >= duration) return false;
    return pos >= c;
  }

  // The skip action at `pos`, or null: { kind: "recap"|"intro", target, label }
  // or { kind: "credits", target: null, label } (credits only with a next
  // episode; the action plays it).
  function skipAction(m, pos, duration, hasNext) {
    if (!m || !Number.isFinite(pos) || pos < 0) return null;
    let t = span(m.recapStart, m.recapEnd, pos);
    if (t != null) return { kind: "recap", target: t, label: "Skip recap" };
    t = span(m.introStart, m.introEnd, pos);
    if (t != null) return { kind: "intro", target: t, label: "Skip intro" };
    if (hasNext && inCredits(m, pos, duration)) return { kind: "credits", target: null, label: "Next episode" };
    return null;
  }

  function countdownLeft(playedMs) {
    const elapsed = Math.floor(Math.max(0, playedMs || 0) / 1000);
    return Math.max(0, CREDITS_COUNTDOWN_SEC - elapsed);
  }

  // All-null markers whose head was not analysed yet: re-fetch once later.
  function markersWorthRefetch(m) {
    return !!m && num(m.introStart) == null && num(m.creditsStart) == null && !(m.analysed && m.analysed.head === true);
  }

  // ---- 8. "Still watching?" ----------------------------------------------
  // After LIMIT consecutive auto-played episodes with no user input, the next
  // one opens paused behind a prompt. One instance per page.
  function createStillWatching(limit) {
    const LIMIT = limit || 3;
    let autoPlays = 0;
    let pending = false;
    return {
      LIMIT,
      noteAutoAdvance() { autoPlays++; pending = true; },
      // A player start: true when it must open behind the prompt. A start
      // not caused by an auto-advance (a manual pick) resets the run.
      onPlayerStart() {
        const auto = pending;
        pending = false;
        if (!auto) autoPlays = 0;
        return auto && autoPlays >= LIMIT;
      },
      cancelPendingAutoStart() { pending = false; },
      onUserInteraction() { autoPlays = 0; },
      count() { return autoPlays; },
      reset() { autoPlays = 0; pending = false; },
    };
  }

  // ---- 7. Generated title cards ------------------------------------------
  // Gradient pairs (top-left, bottom-right). Muted, dark enough for white text.
  const TITLE_CARD_PALETTE = [
    ["#3A1C71", "#0D1124"], ["#1D4E5F", "#0B1A24"], ["#6B2D2D", "#1A0E12"], ["#2B4C2F", "#0E1A10"],
    ["#4A3B6B", "#14102A"], ["#5C4421", "#1C140A"], ["#22416B", "#0A1428"], ["#5A2350", "#1A0B19"],
  ];

  function isDigit(c) { return c >= "0" && c <= "9"; }
  function isUpper(c) { return c >= "A" && c <= "Z"; }
  function isYear(w) {
    return w.length === 4 && [...w].every(isDigit) && (w.startsWith("19") || w.startsWith("20"));
  }
  function prefixEnd(s) {
    // Upper-case tags only ("EN", "4K", "HIN"): "Up - The Movie" keeps its title.
    let i = 0;
    while (i < s.length && i < 5 && (isDigit(s[i]) || isUpper(s[i]))) i++;
    if (i < 2 || i > 4 || i >= s.length) return 0;
    const rest = s.slice(i);
    if (rest.startsWith(": ")) return i + 2;
    if (rest.startsWith(":")) return i + 1;
    if (rest.startsWith(" - ") || rest.startsWith(" | ")) return i + 3;
    return 0;
  }

  // The title as a person would write it: trailing "(...)" / "[...]" groups
  // and a trailing year removed, plus a leading upper-case tag ("EN: ").
  function displayTitle(raw) {
    const orig = String(raw == null ? "" : raw).trim();
    let s = orig;
    const p = prefixEnd(s);
    if (p > 0) s = s.slice(p).trim();
    let changed = true;
    while (changed && s.length) {
      changed = false;
      const last = s[s.length - 1];
      if (last === ")" || last === "]") {
        const open = s.lastIndexOf(last === ")" ? "(" : "[");
        if (open > 0) { s = s.slice(0, open).trim(); changed = true; }
      } else {
        const sp = s.lastIndexOf(" ");
        if (sp > 0 && isYear(s.slice(sp + 1))) { s = s.slice(0, sp).trim(); changed = true; }
      }
      while (s.length && "-|:".includes(s[s.length - 1])) { s = s.slice(0, -1).trim(); changed = true; }
    }
    return s || orig;
  }

  // Java String.hashCode, so web and Android pick the same colours.
  function javaHash(str) {
    let h = 0;
    for (let i = 0; i < str.length; i++) h = (Math.imul(31, h) + str.charCodeAt(i)) | 0;
    return h;
  }
  function paletteIndex(title) {
    const n = TITLE_CARD_PALETTE.length;
    return ((javaHash(displayTitle(title).toLowerCase()) % n) + n) % n;
  }
  function titleCardColors(title) { return TITLE_CARD_PALETTE[paletteIndex(title)]; }

  // ---- 3. Trailer previews -----------------------------------------------
  const PREVIEW_FAIL_RETRY_MS = 2 * 60 * 1000;
  // A preview is worth starting: not on a metered / Data Saver connection.
  function previewAllowed(nav) {
    const c = nav && nav.connection;
    if (!c) return true;
    if (c.saveData) return false;
    if (typeof c.effectiveType === "string" && /^(slow-2g|2g)$/.test(c.effectiveType)) return false;
    return true;
  }
  function previewUrlFor(key) {
    return typeof key === "string" && /^[A-Za-z0-9_-]{6,20}$/.test(key) ? `/api/trailer/${key}/preview.mp4` : null;
  }

  const api = {
    TRICKPLAY_REFRESH_MS, frameFor, frameUrl, previewLeft, trickplaySupported,
    CREDITS_COUNTDOWN_SEC, MARKERS_REFETCH_AFTER_MS, markersSupported, skipAction, inCredits,
    countdownLeft, markersWorthRefetch,
    createStillWatching,
    TITLE_CARD_PALETTE, displayTitle, paletteIndex, titleCardColors, javaHash,
    PREVIEW_FAIL_RETRY_MS, previewAllowed, previewUrlFor,
  };
  if (typeof module === "object" && module.exports) module.exports = api;
  else root.KNf = api;
})(typeof window !== "undefined" ? window : globalThis);
