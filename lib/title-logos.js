// Title-logo art (Netflix-style title treatment). TMDB /movie|/tv images.logos
// -> one chosen file_path string stored on the TMDB cache entry as `logo`.
// Pure: no I/O.

const LOGO_BASE = "https://image.tmdb.org/t/p/w500";
const MIN_WIDTH = 150; // px; narrower logos are icons/crops, not title art

// images: TMDB `images` object ({logos:[...]}) or the logos array itself.
// English first, then language-null (textless/universal), then nothing else.
// Within a language: highest vote_average, then width. PNG only (transparent).
function pickLogo(images) {
  const list = Array.isArray(images) ? images : (images && Array.isArray(images.logos) ? images.logos : []);
  const rank = (l) => (l.iso_639_1 === "en" ? 0 : (l.iso_639_1 == null || l.iso_639_1 === "xx") ? 1 : 2);
  const ok = list.filter((l) => l && typeof l.file_path === "string" && /^\/[\w.-]+\.png$/i.test(l.file_path)
    && rank(l) < 2 && (Number(l.width) || 0) >= MIN_WIDTH);
  ok.sort((a, b) => (rank(a) - rank(b))
    || ((Number(b.vote_average) || 0) - (Number(a.vote_average) || 0))
    || ((Number(b.width) || 0) - (Number(a.width) || 0))
    || (a.file_path < b.file_path ? -1 : 1));
  return ok.length ? ok[0].file_path : null;
}

function logoUrl(filePath) {
  return typeof filePath === "string" && /^\/[\w.-]+\.png$/i.test(filePath) ? `${LOGO_BASE}${filePath}` : null;
}

// Cache entries that still need a logo lookup: matched TMDB entries whose
// `logo` was never resolved (key absent; null = checked, none available).
// entries: iterable of [cacheKey, entry] (library titles only -- caller
// passes index members). One candidate per (kind, tmdb_id), capped at `max`.
function logoBackfillCandidates({ entries, max = 300 }) {
  const byTmdb = new Map();
  for (const [key, e] of entries) {
    if (!e || e.source !== "tmdb" || !e.tmdb_id || "logo" in e) continue;
    const kind = key.startsWith("series:") ? "series" : key.startsWith("movie:") ? "movie" : null;
    if (!kind) continue;
    const k = `${kind}:${e.tmdb_id}`;
    const c = byTmdb.get(k) || { tmdbId: e.tmdb_id, kind, keys: [] };
    c.keys.push(key);
    byTmdb.set(k, c);
  }
  return [...byTmdb.values()].slice(0, max);
}

function applyLogo(e, detail) {
  e.logo = pickLogo(detail && detail.images);
  return e;
}

module.exports = { pickLogo, logoUrl, logoBackfillCandidates, applyLogo, LOGO_BASE, MIN_WIDTH };
