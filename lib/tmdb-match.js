// Pure plausibility guard for panel-stream -> TMDB matches. No I/O.
//
// Catches the clearly-wrong class ("Hissa (2026) (Punjabi)" -> "Dune: Part
// Three") without rejecting legitimately localized titles ("Culpa Mia" ->
// "My Fault"). Deliberately conservative: when in doubt, ok:true.

// Language-name tag (as it appears in a stream name or index tag) -> ISO 639-1.
const LANG_NAME_TO_ISO = {
  hindi: "hi", punjabi: "pa", urdu: "ur", tamil: "ta", telugu: "te", teugu: "te",
  malayalam: "ml", malyalam: "ml", kannada: "kn", kannda: "kn", marathi: "mr",
  gujarati: "gu", gujrati: "gu", bengali: "bn", bangla: "bn", english: "en",
  spanish: "es", french: "fr", german: "de", italian: "it", portuguese: "pt",
  russian: "ru", turkish: "tr", arabic: "ar", korean: "ko", japanese: "ja",
  chinese: "zh", mandarin: "zh", cantonese: "zh", thai: "th", indonesian: "id",
  malay: "ms", persian: "fa", farsi: "fa", nepali: "ne", dutch: "nl", polish: "pl",
  swedish: "sv", vietnamese: "vi", filipino: "tl", tagalog: "tl", bhojpuri: "hi",
  odia: "or", assamese: "as", pashto: "ps",
};
const INDIC = new Set(["hi", "pa", "ur", "ta", "te", "ml", "kn", "mr", "gu", "bn", "ne", "or", "as", "bho", "sa"]);
// Tags whose catalog titles are rarely translated, so a zero-overlap match to
// a film of a different language family is almost certainly wrong.
// ("english" is excluded: the panel's English bucket also holds untranslated foreign films.)
const STRICT_TAGS = new Set(["hindi", "punjabi", "urdu", "tamil", "telugu", "malayalam", "kannada",
  "marathi", "gujarati", "bengali", "arabic", "turkish"]);
// ISO codes TMDB uses that are equivalent for our comparison.
const ISO_ALIASES = { cn: "zh", iw: "he", in: "id", jw: "jv", tl: "fil" };

const STOP = new Set(["the", "a", "an", "of", "and", "de", "la", "el", "le", "les", "los", "las",
  "y", "e", "et", "in", "on", "to", "for", "du", "des", "del", "di", "da", "der", "die", "das"]);

const strip = (s) => String(s || "").normalize("NFD").replace(/[̀-ͯ]/g, "");

function tokens(s) {
  return strip(s).toLowerCase().replace(/&/g, " and ").replace(/[^a-z0-9Ѐ-ӿ؀-ۿऀ-ॿ぀-ヿ一-鿿]+/g, " ")
    .split(" ").filter(Boolean);
}

// Extract language tag + clean title from a raw stream name.
function parseStreamName(name) {
  let s = String(name || "");
  let lang = null;
  s = s.replace(/\(([^)]*)\)/g, (m, inner) => {
    for (const w of strip(inner).toLowerCase().split(/[^a-z]+/)) {
      if (LANG_NAME_TO_ISO[w] && !lang) lang = w;
    }
    return " ";
  });
  s = s.replace(/\[[^\]]*\]/g, " ")
    .replace(/\b(4K|FHD|UHD|HD|SD|CAM|HDRIP|DVDRIP|BLURAY|WEBRIP|WEBDL|WEB-DL|2160P|1080P|720P|480P|HDR|HEVC|X264|X265|DUAL|MULTI|DUBBED|SCREENER)\b/gi, " ")
    .replace(/\.(?=\D)/g, " ")
    .replace(/\s+(19|20)\d{2}\s*$/, " ");
  const year = (String(name || "").match(/\((19|20)\d{2}\)/) || [])[0];
  return { title: s.replace(/\s+/g, " ").trim(), lang, year: year ? parseInt(year.slice(1, 5), 10) : null };
}

const sigTokens = (s) => {
  const all = tokens(s).filter((t) => t.length > 1 || /\d/.test(t));
  const sig = all.filter((t) => !STOP.has(t));
  return sig.length ? sig : all;
};
const singular = (t) => (t.length > 3 && t.endsWith("s") ? t.slice(0, -1) : t);

function hasOverlap(streamTitle, candidates) {
  const st = sigTokens(streamTitle);
  if (!st.length) return true; // nothing to judge on
  const sset = new Set(st.map(singular));
  const scompact = st.join("");
  for (const c of candidates) {
    const ct = sigTokens(c);
    if (!ct.length) continue;
    const cset = ct.map(singular);
    if (cset.some((t) => sset.has(t))) return true;
    const ccompact = ct.join("");
    // "spider man" vs "spiderman" (compact equality / single-token equality only;
    // never substring, or "Agra" would match "Agradecer").
    if (scompact.length >= 3 && (scompact === ccompact || ct.includes(scompact))) return true;
    if (ccompact.length >= 3 && st.includes(ccompact)) return true;
  }
  return false;
}

const FESTIVAL_RE = /(\bfestival\b|\blive at\b|\blive in\b|\blive from\b|\bin concert\b|\bdj set\b|\bsets?\b|\bmix\b|\btour\b|\bhighlights\b|\bcompilation\b| @ )/i;
const DASH_RE = / - /;
// strictDash: also treat "Artist - Title" dash titles as live-event style (only
// used when the stream carries a real, non-English language tag).
const looksLikeLiveEvent = (title, strictDash = false) =>
  FESTIVAL_RE.test(String(title || "")) || (strictDash && DASH_RE.test(String(title || "")));

const normIso = (c) => { const x = String(c || "").toLowerCase(); return ISO_ALIASES[x] || x; };

// matchPlausible({streamName, streamLangTag, streamYear, tmdb, viaPanelId})
//   tmdb: {title, original_title?, original_language, year, genres?, runtime?, alternative_titles?}
//   streamLangTag: language NAME ("Punjabi"), ISO code ("pa"), or null; falls back to
//   the "(Language)" tag parsed from the stream name.
// Returns {ok, reason}.
function matchPlausible({ streamName, streamLangTag, streamYear, tmdb, viaPanelId } = {}) {
  if (!tmdb) return { ok: true, reason: "no-tmdb" };
  const parsed = parseStreamName(streamName);
  if (!parsed.title) return { ok: true, reason: "no-stream-name" };
  const names = [tmdb.title, tmdb.original_title, tmdb.name, tmdb.original_name, tmdb.tmdb_title]
    .concat(Array.isArray(tmdb.alternative_titles) ? tmdb.alternative_titles : [])
    .filter((x) => typeof x === "string" && x.trim());
  if (!names.length) return { ok: true, reason: "no-tmdb-title" };
  if (hasOverlap(parsed.title, names)) return { ok: true, reason: "overlap" };

  // ---- zero token overlap from here on ----
  // The "(Language)" tag in the stream name is more specific than the panel's
  // bucket tag (an Italian film dubbed to Hindi sits in the English bucket).
  let tagName = null;
  let tagIso = null;
  const rawTag = streamLangTag ? String(streamLangTag).toLowerCase() : null;
  if (parsed.lang) { tagName = parsed.lang; tagIso = LANG_NAME_TO_ISO[parsed.lang]; }
  else if (rawTag && LANG_NAME_TO_ISO[rawTag]) { tagName = rawTag; tagIso = LANG_NAME_TO_ISO[rawTag]; }
  else if (rawTag && /^[a-z]{2}$/.test(rawTag)) {
    tagIso = rawTag;
    tagName = Object.keys(LANG_NAME_TO_ISO).find((k) => LANG_NAME_TO_ISO[k] === rawTag) || null;
  }

  const y = streamYear ? parseInt(String(streamYear).slice(0, 4), 10) : parsed.year;
  const ty = tmdb.year ? parseInt(String(tmdb.year).slice(0, 4), 10) : null;
  if (Number.isFinite(y) && Number.isFinite(ty) && Math.abs(y - ty) >= 2) {
    return { ok: false, reason: `zero-overlap, year ${y} vs ${ty}` };
  }

  const streamNameLooksLive = looksLikeLiveEvent(parsed.title);
  const dashSignal = !!tagName && tagName !== "english";
  if (!streamNameLooksLive && names.some((n) => looksLikeLiveEvent(n, dashSignal))) {
    return { ok: false, reason: "zero-overlap, festival/concert-style tmdb title" };
  }

  if (tagIso && tmdb.original_language) {
    const ol = normIso(tmdb.original_language);
    if (ol === normIso(tagIso)) return { ok: true, reason: "zero-overlap, language consistent" };
    if (tagName && STRICT_TAGS.has(tagName)) {
      // Indic <-> Indic (cross-language dubs with transliterated titles) stays ok.
      if (INDIC.has(normIso(tagIso)) && INDIC.has(ol)) return { ok: true, reason: "zero-overlap, indic cross-language" };
      // Only the failure pattern actually seen: an English-language film hijacking
      // a regional-language stream. Other languages are often untranslated /
      // transliterated legit titles, so they stay ok.
      if (ol === "en") return { ok: false, reason: `zero-overlap, ${tagName} stream vs original_language en` };
      return { ok: true, reason: "zero-overlap, foreign original language" };
    }
    return { ok: true, reason: "zero-overlap, lenient language" };
  }
  return { ok: true, reason: viaPanelId ? "zero-overlap, panel id, no language signal" : "zero-overlap, no language tag" };
}

module.exports = { matchPlausible, parseStreamName, hasOverlap, looksLikeLiveEvent, LANG_NAME_TO_ISO };
