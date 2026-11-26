"use strict";
// Buffering rescue for live channels: group the copies of one channel
// ("IN: ZEE TV HD", "IN: ZEE TV (FHD)", "IN: ZEE TV (4K).") and rank the other
// copies by a health score learned from real viewing (clients report stalls,
// reconnects and time-to-first-frame per session). No synthetic probing.
//
// Grouping keeps the region: "UK: ZEE TV" is a different feed from
// "IN: ZEE TV". Names with no recognised prefix only group within their own
// panel category.

const PREFIX_RE = /^\s*\|?\s*([A-Za-z][A-Za-z0-9+]{1,9})\s*(?:\|{1,2}|:)\s*/;
// Prefixes that name the same region/language. Anything else stays as-is.
const PREFIX_ALIASES = {
  UKFHD: "UK", UKHD: "UK", UKSD: "UK", GB: "UK",
  USA: "US",
  TM: "TAMIL",
  KAND: "KANNADA", KN: "KANNADA",
  MAL: "MALAYALAM", ML: "MALAYALAM",
  TG: "TELUGU", TE: "TELUGU",
  MR: "MARATHI",
  GUJ: "GUJARATI", GU: "GUJARATI",
  PB: "PUNJABI", PA: "PUNJABI",
};
// \b is ASCII-only, so non-Latin names keep their letters (see channelNameKey).
const QUALITY_WORDS = /\b(?:uhd|fhd|hd|sd|4k|8k|hevc|h265|h264|backup|raw|50fps|60fps|2160p?|1080p?|720p?|576p?|hdr)\b/g;

function splitPrefix(name) {
  const s = String(name || "");
  const m = PREFIX_RE.exec(s);
  if (!m) return { prefix: null, rest: s };
  const p = m[1].toUpperCase();
  return { prefix: PREFIX_ALIASES[p] || p, rest: s.slice(m[0].length) };
}

function plain(s) {
  return String(s || "").normalize("NFKD").replace(/[̀-ͯ]/g, "").toLowerCase();
}

// "" when the name has nothing to group on.
function channelNameKey(rest) {
  let n = plain(rest).replace(/[_\-.]+/g, " ");
  n = n.replace(QUALITY_WORDS, " ");
  return n.replace(/[^\p{L}\p{N}+]+/gu, "");
}

// Group key for a live stream, or null when it can't be grouped.
function groupKeyOf(stream) {
  if (!stream || !stream.name) return null;
  const { prefix, rest } = splitPrefix(stream.name);
  const key = channelNameKey(rest);
  if (!key) return null;
  const region = prefix ? `r:${prefix}` : `c:${stream.category_id ?? ""}`;
  return `${region}|${key}`;
}

// 1 SD, 2 HD (also unknown), 3 FHD/1080, 4 4K/UHD.
function qualityTier(name) {
  const n = plain(name);
  if (/\b(?:4k|uhd|2160p?|8k)\b/.test(n)) return 4;
  if (/\b(?:fhd|1080p?)\b/.test(n)) return 3;
  if (/\bsd\b|\b576p?\b/.test(n)) return 1;
  return 2;
}
const QUALITY_LABEL = { 1: "SD", 2: "HD", 3: "FHD", 4: "4K" };

// Map<groupKey, id[]> + Map<id, groupKey>, only for groups with 2+ copies.
function buildGroups(streamsIterable) {
  const byKey = new Map();
  for (const s of streamsIterable) {
    const k = groupKeyOf(s);
    if (!k) continue;
    const arr = byKey.get(k);
    if (arr) arr.push(s.id); else byKey.set(k, [s.id]);
  }
  const groups = new Map();
  const keyOfId = new Map();
  for (const [k, ids] of byKey) {
    if (ids.length < 2) continue;
    groups.set(k, ids);
    for (const id of ids) keyOfId.set(String(id), k);
  }
  return { groups, keyOfId };
}

// ── Health store ──────────────────────────────────────────────────────────
// Per stream: 24 hour-of-day buckets of decayed sums. Reports older than a
// couple of weeks fade out (half-life), so a copy that got fixed recovers.
const HALF_LIFE_MS = 14 * 24 * 3600e3;
const NEUTRAL = 65;
const SCORE_FLOOR = 55;
const FIELDS = ["n", "sec", "stalls", "stallSec", "reconn", "ttffSum", "ttffN", "fails"];

function emptyBucket() { return { n: 0, sec: 0, stalls: 0, stallSec: 0, reconn: 0, ttffSum: 0, ttffN: 0, fails: 0 }; }

function decayRecord(rec, now) {
  if (!rec || !rec.ts || now <= rec.ts) return rec;
  const f = Math.pow(0.5, (now - rec.ts) / HALF_LIFE_MS);
  for (const b of rec.b) if (b) for (const k of FIELDS) b[k] *= f;
  rec.ts = now;
  return rec;
}

const clampNum = (v, lo, hi) => {
  const n = Number(v);
  if (!Number.isFinite(n)) return 0;
  return Math.min(hi, Math.max(lo, n));
};

// Validate a client session report. Returns null when it carries nothing.
function sanitizeReport(r) {
  if (!r || typeof r !== "object") return null;
  const out = {
    watchedSec: clampNum(r.watchedMs, 0, 12 * 3600e3) / 1000,
    stalls: Math.round(clampNum(r.stalls, 0, 500)),
    stallSec: clampNum(r.stallMs, 0, 12 * 3600e3) / 1000,
    reconnects: Math.round(clampNum(r.reconnects, 0, 500)),
    ttffMs: r.ttffMs == null ? null : clampNum(r.ttffMs, 0, 120e3),
    failed: r.failed === true,
  };
  if (!out.failed && out.watchedSec < 1 && out.stalls === 0 && out.reconnects === 0 && out.ttffMs == null) return null;
  return out;
}

function recordReport(store, key, report, now = Date.now(), hour = new Date(now).getHours()) {
  let rec = store[key];
  if (!rec || !Array.isArray(rec.b) || rec.b.length !== 24) rec = store[key] = { ts: now, b: new Array(24).fill(null) };
  decayRecord(rec, now);
  const b = rec.b[hour] || (rec.b[hour] = emptyBucket());
  b.n += 1;
  b.sec += report.watchedSec;
  b.stalls += report.stalls;
  b.stallSec += report.stallSec;
  b.reconn += report.reconnects;
  if (report.ttffMs != null && !report.failed) { b.ttffSum += report.ttffMs; b.ttffN += 1; }
  if (report.failed) b.fails += 1;
  rec.ts = now;
  return rec;
}

function sumBuckets(buckets, weights) {
  const s = emptyBucket();
  buckets.forEach((b, i) => {
    if (!b) return;
    const w = weights ? weights[i] : 1;
    for (const k of FIELDS) s[k] += b[k] * w;
  });
  return s;
}

// 0-100 from aggregated stats (no confidence blending).
function rawScore(s) {
  const hours = Math.max(s.sec, 60) / 3600;
  const stallsPerHour = s.stalls / hours;
  const stallRatio = s.stallSec / Math.max(s.sec + s.stallSec, 1);
  const failRate = s.fails / Math.max(s.n, 1);
  const reconnPerHour = s.reconn / hours;
  const ttff = s.ttffN > 0 ? s.ttffSum / s.ttffN : 0;
  let score = 100;
  score -= Math.min(35, stallsPerHour * 5);
  score -= Math.min(30, stallRatio * 200);
  score -= Math.min(15, Math.max(0, (ttff - 2500) / 500));
  score -= Math.min(60, failRate * 80);
  score -= Math.min(15, reconnPerHour * 3);
  return Math.max(0, Math.min(100, score));
}

function confidenceOf(s) {
  return Math.min(1, s.sec / 1200 + s.n / 4);
}

// { score, confidence, measured } for a stream at `now`'s hour of day.
// Uses the hour and its neighbours (1-2-1); falls back to the whole day.
function scoreFor(store, key, now = Date.now(), hour = new Date(now).getHours()) {
  const rec = store[key];
  if (!rec || !Array.isArray(rec.b)) return { score: NEUTRAL, confidence: 0, measured: false };
  const f = rec.ts && now > rec.ts ? Math.pow(0.5, (now - rec.ts) / HALF_LIFE_MS) : 1;
  const window = [(hour + 23) % 24, hour, (hour + 1) % 24].map((h) => rec.b[h]);
  let s = sumBuckets(window, [0.5, 1, 0.5]);
  let conf = confidenceOf(s) * f;
  if (conf < 0.3) {
    const day = sumBuckets(rec.b);
    const dayConf = confidenceOf(day) * f * 0.7;
    if (dayConf > conf) { s = day; conf = dayConf; }
  }
  if (s.n <= 0) return { score: NEUTRAL, confidence: 0, measured: false };
  const measured = rawScore(s);
  const score = conf * measured + (1 - conf) * NEUTRAL;
  return { score: Math.round(score * 10) / 10, confidence: Math.round(conf * 100) / 100, measured: true };
}

// Rank the other copies of a channel.
//   candidates: [{ id, name }]   (the current copy excluded by the caller or here)
//   health(id) -> { score, confidence, measured }
//   deadState(id) -> "unavailable" (known dead, skip) | "stale-dead" | null
// Lighter copies get a bonus and heavier ones a penalty: the current copy is
// struggling, so less bitrate is the likelier fix. Copies under the floor are
// never offered.
function rankAlternates({ currentId, currentName, candidates, health, deadState, floor = SCORE_FLOOR, limit = 5 }) {
  const curTier = qualityTier(currentName);
  const out = [];
  for (const c of candidates) {
    if (String(c.id) === String(currentId)) continue;
    const dead = deadState ? deadState(c.id) : null;
    if (dead === "unavailable") continue;
    const h = health(c.id);
    if (h.score < floor) continue;
    const tier = qualityTier(c.name);
    let rank = h.score;
    if (tier < curTier) rank += 6;
    else if (tier > curTier) rank -= 12;
    if (dead === "stale-dead") rank -= 15;
    out.push({
      id: c.id,
      name: c.name,
      quality: QUALITY_LABEL[tier],
      score: h.score,
      confidence: h.confidence,
      measured: h.measured,
      rank: Math.round(rank * 10) / 10,
    });
  }
  out.sort((a, b) => b.rank - a.rank || b.confidence - a.confidence || String(a.id).localeCompare(String(b.id)));
  return out.slice(0, limit);
}

module.exports = {
  splitPrefix, channelNameKey, groupKeyOf, qualityTier, buildGroups,
  sanitizeReport, recordReport, scoreFor, rawScore, rankAlternates, decayRecord,
  NEUTRAL, SCORE_FLOOR, HALF_LIFE_MS,
};
