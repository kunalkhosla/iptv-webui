// Pure helpers for the media sidecar (trick-play thumbnails + intro/credits
// markers). No I/O here; server.js owns ffmpeg and the files.
//
// The sidecar never opens an upstream stream. It reads only:
//  - HLS segments a viewer's own transcode already wrote to local disk, or
//  - Disk-library files (local drive, no panel connection).

const fp = require("./fingerprint");

const HEAD_SEC = 600;  // intro search window: first 10 min
const TAIL_SEC = 480;  // credits search window: last 8 min
const INTRO_MIN_SEC = 12;
const INTRO_MAX_SEC = 150;
const CREDITS_MIN_SEC = 15;

// Parse a VOD HLS media playlist (as written by ffmpeg's hls muxer) into
// segments with their start time relative to the playlist's first segment.
// Returns { segments: [{ n, file, start, dur }], ended }.
function parsePlaylist(text) {
  const segments = [];
  let ended = false;
  if (typeof text !== "string") return { segments, ended };
  let dur = null;
  let t = 0;
  for (const raw of text.split("\n")) {
    const line = raw.trim();
    if (!line) continue;
    if (line.startsWith("#EXTINF:")) {
      const v = parseFloat(line.slice(8));
      dur = Number.isFinite(v) && v > 0 ? v : null;
    } else if (line === "#EXT-X-ENDLIST") {
      ended = true;
    } else if (!line.startsWith("#")) {
      if (dur == null) continue;
      const m = /(\d+)\.ts$/.exec(line);
      if (!m) { dur = null; continue; }
      // Only plain file names (no path, no URL): the sidecar opens these
      // inside the transcode dir.
      if (line.includes("/") || line.includes("\\") || line.includes("..")) { dur = null; continue; }
      segments.push({ n: parseInt(m[1], 10), file: line, start: t, dur });
      t += dur;
      dur = null;
    }
  }
  return { segments, ended };
}

// Which of `times` (sorted ascending, seconds) is within `tol` of t?
function hasNear(times, t, tol) {
  let lo = 0, hi = times.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (times[mid] < t - tol) lo = mid + 1;
    else if (times[mid] > t + tol) hi = mid - 1;
    else return true;
  }
  return false;
}

// Insert t into a sorted array (no duplicates).
function insertSorted(times, t) {
  let lo = 0, hi = times.length;
  while (lo < hi) { const mid = (lo + hi) >> 1; if (times[mid] < t) lo = mid + 1; else hi = mid; }
  if (times[lo] === t) return times;
  times.splice(lo, 0, t);
  return times;
}

// Thumbnail time for a segment: its start (segments begin on a keyframe),
// rounded to whole seconds. Wanted when no stored frame is within
// interval/2 of it.
function thumbWanted(times, segStartAbs, interval) {
  const t = Math.max(0, Math.round(segStartAbs));
  return hasNear(times, t, interval / 2) ? null : t;
}

// Group consecutive segments into decode batches of at most maxSec seconds.
function batchSegments(segs, maxSec = 60) {
  const out = [];
  let cur = [];
  let acc = 0;
  for (const s of segs) {
    const contiguous = !cur.length || cur[cur.length - 1].n + 1 === s.n;
    if (cur.length && (!contiguous || acc + s.dur > maxSec)) { out.push(cur); cur = []; acc = 0; }
    cur.push(s);
    acc += s.dur;
  }
  if (cur.length) out.push(cur);
  return out;
}

// Median of numbers.
function median(xs) {
  const a = [...xs].sort((x, y) => x - y);
  if (!a.length) return null;
  const m = a.length >> 1;
  return a.length % 2 ? a[m] : (a[m - 1] + a[m]) / 2;
}

// Cluster per-pair results for ONE episode and pick the consensus:
// pairs = [{ start, end }]. Returns { start, end, support } or null.
// A cluster = results whose start is within tol of each other. The biggest
// cluster wins (ties: the longer median span). Needs >= minSupport members.
function consensus(pairs, { tol = 4, minSupport = 1 } = {}) {
  if (!pairs.length) return null;
  const sorted = [...pairs].sort((a, b) => a.start - b.start);
  let best = null;
  for (let i = 0; i < sorted.length; i++) {
    const c = sorted.filter((p) => Math.abs(p.start - sorted[i].start) <= tol);
    const start = median(c.map((p) => p.start));
    const end = median(c.map((p) => p.end));
    const cand = { start, end, support: c.length };
    if (!best || cand.support > best.support || (cand.support === best.support && cand.end - cand.start > best.end - best.start)) best = cand;
  }
  if (!best || best.support < minSupport) return null;
  return { start: Math.round(best.start * 10) / 10, end: Math.round(best.end * 10) / 10, support: best.support };
}

// Episode record: { key, head: window|null, tail: window|null, dur: secs|null }.
// Compares `ep` against `others` (same series; caller orders same-season
// first and caps the list). Returns
// { intro: {start,end,support}|null, credits: {start,support}|null,
//   pairs: [{ otherKey, intro, credits }] } — `pairs` lets the caller update
// the other episodes' evidence too.
function analyseEpisode(ep, others, opts = {}) {
  const introPairs = [];
  const creditPairs = [];
  const pairs = [];
  for (const o of others) {
    if (!o || o.key === ep.key) continue;
    const rec = { otherKey: o.key, intro: null, credits: null };
    if (ep.head && o.head) {
      const m = fp.findSharedSegment(ep.head, o.head, { minSec: INTRO_MIN_SEC, ...(opts.match || {}) });
      if (m && m.aEnd - m.aStart <= INTRO_MAX_SEC + 30) {
        // Clamp an over-long shared stretch (e.g. identical recap + theme) to
        // the max intro length, keeping its end (the theme ends the stretch).
        const len = Math.min(m.aEnd - m.aStart, INTRO_MAX_SEC);
        rec.intro = { start: m.aEnd - len, end: m.aEnd, otherStart: m.bEnd - len, otherEnd: m.bEnd, ber: m.ber };
        introPairs.push({ start: rec.intro.start, end: rec.intro.end });
      }
    }
    if (ep.tail && o.tail && ep.dur && o.dur) {
      const m = fp.findSharedSegment(ep.tail, o.tail, { minSec: CREDITS_MIN_SEC, ...(opts.match || {}) });
      // Credits: the shared stretch must run to (near) the end in BOTH
      // episodes; a shared bit in the middle of the last 8 min is not credits.
      if (m && ep.dur - m.aEnd <= 45 && o.dur - m.bEnd <= 45) {
        rec.credits = { start: m.aStart, otherStart: m.bStart, ber: m.ber };
        creditPairs.push({ start: m.aStart, end: m.aEnd });
      }
    }
    pairs.push(rec);
  }
  const intro = consensus(introPairs);
  const credits = consensus(creditPairs, { tol: 6 });
  return {
    intro,
    credits: credits ? { start: credits.start, support: credits.support } : null,
    pairs,
  };
}

// Merge evidence: each episode keeps a map otherKey -> {intro:{start,end}|null,
// credits:{start}|null} from every comparison it took part in (either side),
// and its markers are the consensus over that map. Returns the public marker
// object (nulls when unsure).
// A marker backed by a single comparison must be a clean match (low bit
// error rate); two or more agreeing comparisons are trusted as they are.
const SINGLE_PAIR_MAX_BER = 0.25;
function markersFromEvidence(evidence, dur) {
  const intro = [], credits = [];
  for (const v of Object.values(evidence || {})) {
    if (v && v.intro && Number.isFinite(v.intro.start) && Number.isFinite(v.intro.end)) intro.push(v.intro);
    if (v && v.credits && Number.isFinite(v.credits.start)) credits.push({ start: v.credits.start, end: v.credits.start, ber: v.credits.ber });
  }
  const trusted = (cl, list) => {
    if (!cl) return null;
    if (cl.support >= 2) return cl;
    // support 1: the one member must be clean (ber unknown = not trusted).
    const m = list.find((p) => Math.abs(p.start - cl.start) < 0.2);
    return m && Number.isFinite(m.ber) && m.ber <= SINGLE_PAIR_MAX_BER ? cl : null;
  };
  const i = trusted(consensus(intro), intro);
  const c = trusted(consensus(credits, { tol: 6 }), credits);
  const out = { introStart: null, introEnd: null, recapStart: null, recapEnd: null, creditsStart: null, support: { intro: 0, credits: 0 } };
  if (i && i.end - i.start >= INTRO_MIN_SEC && i.end - i.start <= INTRO_MAX_SEC) {
    out.introStart = i.start; out.introEnd = i.end; out.support.intro = i.support;
  }
  // Credits shorter than 15 s (or starting in the first half) are not trusted.
  if (c && (!dur || (c.start > dur / 2 && dur - c.start >= CREDITS_MIN_SEC))) {
    out.creditsStart = c.start; out.support.credits = c.support;
  }
  return out;
}

module.exports = {
  HEAD_SEC, TAIL_SEC, INTRO_MIN_SEC, INTRO_MAX_SEC, CREDITS_MIN_SEC,
  parsePlaylist, hasNear, insertSorted, thumbWanted, batchSegments,
  median, consensus, analyseEpisode, markersFromEvidence, SINGLE_PAIR_MAX_BER,
};
