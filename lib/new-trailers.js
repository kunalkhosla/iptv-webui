// "New trailers" home rail + the TMDB release-date backfill it depends on.
// Pure: the index items, TMDB lookup, filters and clock are injected.

const DAY = 86400_000;
const MOVIE_WINDOW_DAYS = 120;
const SERIES_WINDOW_DAYS = 90;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

// TMDB "videos" -> YouTube key. First official Trailer, else any Trailer,
// else a Teaser, else any YouTube video. Shared with projectTmdbDetail.
function pickTrailerKey(videos) {
  const list = Array.isArray(videos) ? videos : (videos && Array.isArray(videos.results) ? videos.results : []);
  const yt = list.filter((v) => v && v.site === "YouTube" && v.key);
  const v = yt.find((x) => x.official && x.type === "Trailer")
    || yt.find((x) => x.type === "Trailer")
    || yt.find((x) => x.type === "Teaser")
    || yt[0];
  return v ? v.key : null;
}

// ms timestamp of a cached entry's release date (movie release_date /
// tv first_air_date, stored as `release_date`), or null.
function releaseMsOf(t) {
  const d = t && t.release_date;
  if (typeof d !== "string" || !DATE_RE.test(d)) return null;
  const ms = Date.parse(`${d}T00:00:00Z`);
  return Number.isFinite(ms) ? ms : null;
}

// TMDB kind of a cache entry: a `movie:<id>` key can hold a TV show id
// (tmdb_kind "series"), so the entry's own kind wins over the key prefix.
function entryKind(key, e) {
  if (!key.startsWith("series:") && !key.startsWith("movie:") && !key.startsWith("disk:")) return null;
  if (e && e.tmdb_kind === "series") return "series";
  if (key.startsWith("disk:")) return e && e.tmdb_kind === "movie" ? "movie" : null;
  return key.startsWith("series:") ? "series" : "movie";
}

function windowDays(mode) { return mode === "series" ? SERIES_WINDOW_DAYS : MOVIE_WINDOW_DAYS; }

// items: iterable of index items {id, ...}; tmdbFor(id) -> cache entry;
// passes(s) -> bool (language / variant / low-quality / kid gates).
// Returns [{s, t, releaseMs}] newest first, one per tmdb_id.
function selectNewTrailers({ items, tmdbFor, passes = () => true, mode, now = Date.now() }) {
  const cutoff = now - windowDays(mode) * DAY;
  const out = [];
  for (const s of items) {
    if (!s) continue;
    const t = tmdbFor(s.id);
    if (!t || t.source !== "tmdb" || !t.tmdb_id || !t.trailer_key) continue;
    const ms = releaseMsOf(t);
    if (ms === null || ms < cutoff || ms > now + DAY) continue; // released, and recently
    if (!passes(s)) continue;
    out.push({ s, t, releaseMs: ms });
  }
  // Newest first; among copies of the same release keep the one with a poster.
  out.sort((a, b) => (b.releaseMs - a.releaseMs) || ((b.t.poster_path ? 1 : 0) - (a.t.poster_path ? 1 : 0)) || (a.s.id - b.s.id));
  const seen = new Set();
  return out.filter((x) => {
    if (seen.has(x.t.tmdb_id)) return false;
    seen.add(x.t.tmdb_id);
    return true;
  });
}

// Which library entries need a TMDB detail call to fill release_date (and
// a missing trailer). Only titles that can possibly land in the rail: year
// >= last year (or unknown). A recent title still without a trailer is
// rechecked every `trailerRecheckMs` (trailers often appear after release).
// entries: iterable of [cacheKey, entry]. Returns [{tmdbId, kind, keys:[...]}],
// one per (kind, tmdb_id), capped at `max`.
function backfillCandidates({ entries, now = Date.now(), trailerRecheckMs = 7 * DAY, max = 1500 }) {
  const minYear = new Date(now).getUTCFullYear() - 1;
  const byTmdb = new Map();
  for (const [key, e] of entries) {
    if (!e || e.source !== "tmdb" || !e.tmdb_id) continue;
    const kind = entryKind(key, e);
    if (!kind) continue;
    const y = parseInt(e.year, 10);
    if (Number.isFinite(y) && y < minYear) continue;
    let need = !("release_date" in e);
    if (!need && !e.trailer_key) {
      const ms = releaseMsOf(e);
      const recent = ms !== null && ms >= now - windowDays(kind) * DAY;
      need = recent && now - (e.trailer_checked_at || 0) > trailerRecheckMs;
    }
    if (!need) continue;
    const k = `${kind}:${e.tmdb_id}`;
    const c = byTmdb.get(k) || { tmdbId: e.tmdb_id, kind, keys: [] };
    c.keys.push(key);
    byTmdb.set(k, c);
  }
  return [...byTmdb.values()].slice(0, max);
}

// Apply a TMDB /movie|/tv detail response (with videos appended) to an entry.
function applyReleaseInfo(e, kind, detail, now = Date.now()) {
  const d = kind === "series" ? detail.first_air_date : detail.release_date;
  e.release_date = typeof d === "string" && DATE_RE.test(d) ? d : null;
  const key = pickTrailerKey(detail.videos);
  if (key) e.trailer_key = key;
  else if (!("trailer_key" in e)) e.trailer_key = null;
  e.trailer_checked_at = now;
  return e;
}

// Allow-list for /api/trailer: trailer key -> Set of the effective certs of
// the titles that carry it ("" = unrated). `store` is the raw cache object;
// only raw entries with a trailer go through `view(key)` (the guarded read,
// which can hide implausible matches) — the view is the expensive part.
function buildTrailerKeyIndex(store, view = (k) => store[k], certOf = (e) => e.us_cert || "") {
  const idx = new Map();
  for (const k of Object.keys(store)) {
    const raw = store[k];
    if (!raw || !raw.trailer_key || raw.source !== "tmdb") continue;
    const e = view(k);
    if (!e || e.source !== "tmdb" || !e.tmdb_id || !e.trailer_key) continue;
    let set = idx.get(e.trailer_key);
    if (!set) idx.set(e.trailer_key, (set = new Set()));
    set.add(certOf(e) || "");
  }
  return idx;
}
// allowedCerts null = adult profile (any known trailer); else a kid profile
// needs at least one title with this trailer rated within its allowed certs.
function trailerKeyAllowed(idx, key, allowedCerts) {
  const certs = idx.get(key);
  if (!certs) return false;
  if (allowedCerts == null) return true;
  for (const c of certs) if (c && allowedCerts.has(c)) return true;
  return false;
}

module.exports = {
  entryKind,
  buildTrailerKeyIndex, trailerKeyAllowed,
  pickTrailerKey, releaseMsOf, selectNewTrailers, backfillCandidates, applyReleaseInfo,
  MOVIE_WINDOW_DAYS, SERIES_WINDOW_DAYS,
};
