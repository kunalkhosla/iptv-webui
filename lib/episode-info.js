// Richer per-episode / per-season info for /api/episodes (pure helpers).
//
// Sources per episode: the TMDB season (default language, en-US), an optional
// TMDB season in the series' original language (only for languages the
// household reads, see FALLBACK_LANGS), and the panel's own plot.
// Overview choice: the first candidate that is "good" (non-empty, >= 25 chars,
// not repeated by another episode of the same season), else the first
// non-empty one. So a panel plot copied onto every episode loses to TMDB, and
// a TMDB overview copied onto every episode loses to a distinct panel plot.
const TMDB_IMG_BASE = "https://image.tmdb.org/t/p";
// Original-language fallback only for scripts the household reads (Hindi,
// Punjabi, Urdu, other Indian languages). A Korean/Spanish overview would be
// worse than none.
const FALLBACK_LANGS = new Set(["hi", "pa", "ur", "bn", "mr", "gu", "ta", "te", "kn", "ml"]);
const MIN_GOOD_LEN = 25;
const WRITER_JOBS = new Set(["Writer", "Screenplay", "Teleplay", "Story", "Novel"]);

function norm(s) {
  return typeof s === "string" ? s.replace(/\s+/g, " ").trim() : "";
}
function key(s) { return norm(s).toLowerCase(); }

// Texts (lower-cased) that appear on 2+ episodes of a list.
function repeatedTexts(texts) {
  const seen = new Map();
  for (const t of texts) {
    const k = key(t);
    if (!k) continue;
    seen.set(k, (seen.get(k) || 0) + 1);
  }
  return new Set([...seen].filter(([, n]) => n > 1).map(([k]) => k));
}

// candidates: [{ text, source }] in preference order; repeats: Set from
// repeatedTexts() per source (keyed by source name).
function pickOverview(candidates, repeats = {}) {
  let fallback = null;
  for (const c of candidates) {
    const t = norm(c && c.text);
    if (!t) continue;
    if (!fallback) fallback = { text: t, source: c.source };
    const rep = repeats[c.source];
    if (t.length >= MIN_GOOD_LEN && !(rep && rep.has(t.toLowerCase()))) return { text: t, source: c.source };
  }
  return fallback;
}

function personList(arr, n) {
  return [...new Set((arr || []).map((p) => norm(p && p.name)).filter(Boolean))].slice(0, n);
}

// Additive fields from a TMDB season episode object. Empty values omitted.
function episodeExtras(te) {
  if (!te || typeof te !== "object") return {};
  const out = {};
  if (Number.isFinite(te.runtime) && te.runtime > 0 && te.runtime < 600) out.runtime_mins = Math.round(te.runtime);
  // Episode votes are thin; a rating from 1-2 votes is noise.
  if (Number.isFinite(te.vote_average) && te.vote_average > 0 && Number.isFinite(te.vote_count) && te.vote_count >= 3) {
    out.rating = Math.round(te.vote_average * 10) / 10;
  }
  if (typeof te.still_path === "string" && te.still_path.startsWith("/")) out.still_large = `${TMDB_IMG_BASE}/w780${te.still_path}`;
  const crew = Array.isArray(te.crew) ? te.crew : [];
  const directors = personList(crew.filter((c) => c && c.job === "Director"), 3);
  const writers = personList(crew.filter((c) => c && WRITER_JOBS.has(c.job)), 3);
  if (directors.length) out.directors = directors;
  if (writers.length) out.writers = writers;
  const guests = (Array.isArray(te.guest_stars) ? te.guest_stars : [])
    .filter((g) => g && norm(g.name))
    .sort((a, b) => (Number.isFinite(a.order) ? a.order : 999) - (Number.isFinite(b.order) ? b.order : 999))
    .slice(0, 3)
    .map((g) => ({
      name: norm(g.name),
      character: norm(g.character) || null,
      profile: typeof g.profile_path === "string" && g.profile_path.startsWith("/") ? `${TMDB_IMG_BASE}/w185${g.profile_path}` : null,
    }));
  if (guests.length) out.guest_stars = guests;
  return out;
}

// Short title for an episode row ("Pilot", not "Breaking Bad (English) -
// S01E01 - Pilot"): the TMDB episode name unless it is a generic "Episode 3",
// else the panel title with a leading "<series> - S01E01 -" removed, else
// the panel title. null when nothing better than the panel title exists.
const GENERIC_EP_RE = /^(?:episode|episodio|épisode|folge|ep\.?|e)\s*\d+$/i;
const PANEL_PREFIX_RE = /^.*?\bS\d{1,3}\s*[-.]?\s*E\d{1,4}\b\s*[-:\u2013\u2014|.]*\s*/i;
function displayTitle(panelTitle, tmdbName) {
  const t = norm(tmdbName);
  if (t && !GENERIC_EP_RE.test(t) && t.length <= 200) return t;
  const p = norm(panelTitle);
  if (!p) return null;
  const rest = p.replace(PANEL_PREFIX_RE, "");
  if (rest && rest !== p && !GENERIC_EP_RE.test(rest)) return rest;
  return null;
}

// Season-level fields from a TMDB season response (and its fallback-language
// copy). Empty values omitted.
function seasonExtras(d, alt) {
  const out = {};
  if (!d || typeof d !== "object") return out;
  const name = norm(d.name);
  if (name) out.name = name;
  const ov = norm(d.overview) || norm(alt && alt.overview);
  if (ov) out.overview = ov;
  if (typeof d.poster_path === "string" && d.poster_path.startsWith("/")) out.poster = `${TMDB_IMG_BASE}/w342${d.poster_path}`;
  if (/^\d{4}-\d{2}-\d{2}$/.test(String(d.air_date || ""))) out.air_date = d.air_date;
  return out;
}

// Does this TMDB season need an original-language pass? (Some episode or the
// season itself has no overview, and the language is one we fall back to.)
function needsLangFallback(d, originalLanguage) {
  if (!d || !FALLBACK_LANGS.has(String(originalLanguage || ""))) return false;
  const eps = Array.isArray(d.episodes) ? d.episodes : [];
  return !norm(d.overview) || eps.some((e) => !norm(e && e.overview));
}

module.exports = { displayTitle, pickOverview, repeatedTexts, episodeExtras, seasonExtras, needsLangFallback, FALLBACK_LANGS, MIN_GOOD_LEN };
