"use strict";
// Title variants: the panel lists one film/show once per audio language and
// quality ("Dhurandhar: The Revenge (2026) (Hindi)", "... (Tamil)", four
// "(4K)" copies filed under per-language 4K categories). This module groups
// those copies into one title, labels each copy's language honestly, and
// picks the copy a profile should see first. Pure: server.js injects the
// catalog lookups. Contract: docs/VARIANTS.md.

// Language words seen in panel titles / category names -> ISO 639-1.
// Includes the panel's misspellings.
const LANG_WORDS = {
  english: "en", hindi: "hi", tamil: "ta", telugu: "te", teugu: "te", malayalam: "ml", malyalam: "ml",
  kannada: "kn", kannda: "kn", bengali: "bn", bangla: "bn", gujarati: "gu", gujrati: "gu", marathi: "mr",
  punjabi: "pa", urdu: "ur", turkish: "tr", korean: "ko", japanese: "ja", chinese: "zh", mandarin: "zh",
  arabic: "ar", spanish: "es", french: "fr", german: "de", russian: "ru", thai: "th", indonesian: "id",
};
// Abbreviations used only inside multi-language lists ("[Tel,Tam,Hin,Eng]").
const LANG_ABBR = {
  eng: "en", hin: "hi", tam: "ta", tel: "te", mal: "ml", kan: "kn", ben: "bn", mar: "mr", guj: "gu",
  pun: "pa", urd: "ur",
};
const LANG_NAMES = {
  en: "English", hi: "Hindi", ta: "Tamil", te: "Telugu", ml: "Malayalam", kn: "Kannada", bn: "Bengali",
  gu: "Gujarati", mr: "Marathi", pa: "Punjabi", ur: "Urdu", tr: "Turkish", ko: "Korean", ja: "Japanese",
  zh: "Chinese", ar: "Arabic", es: "Spanish", fr: "French", de: "German", ru: "Russian", th: "Thai",
  id: "Indonesian", it: "Italian", pt: "Portuguese", multi: "Multi-audio",
};
const langName = (iso) => (iso && LANG_NAMES[iso]) || null;

const LANG_WORD_RE = new RegExp(`\\b(${Object.keys(LANG_WORDS).join("|")})\\b`, "gi");
// Subtitle categories name the subtitle language, not the audio.
const SUBTITLE_RE = /\bsub(?:s|bed|titled|titles?)?\b/i;

// Language of one stream, with how we know it:
//   source "title"    - the title says so: a "(Hindi)" group, or a list of 2+
//                       languages in one bracket ("[Tel,Tam,Hin]", "(Hindi, English)",
//                       "(Multi Languages)") -> "multi"
//   source "category" - the category NAME names exactly one language ("TAMIL | 2026 4K"),
//                       a Hindi-dubbed category, or a multi-audio category
//   null              - unknown (a region-default tag like INDIAN -> hindi is only a guess)
function detectLang(name, catName) {
  const n = String(name || "");
  // Bracket/paren groups, incl. an unterminated trailing "[Tam, Tel, Hin, Eng)".
  for (const m of n.matchAll(/[[(]([^[\]()]*)(?:[\])]|$)/g)) {
    const toks = m[1].toLowerCase().split(/[\s,/&+-]+/).filter(Boolean);
    if (!toks.length) continue;
    if (toks.includes("multi")) return { lang: "multi", source: "title" };
    const langs = new Set();
    for (const t of toks) { const iso = LANG_WORDS[t] || (toks.length > 1 ? LANG_ABBR[t] : null); if (iso) langs.add(iso); }
    if (langs.size >= 2) return { lang: "multi", source: "title" };
    if (toks.length === 1 && langs.size === 1) return { lang: [...langs][0], source: "title" };
  }
  const cn = String(catName || "");
  if (!cn || SUBTITLE_RE.test(cn)) return { lang: null, source: null };
  if (/dubbed/i.test(cn)) {
    if (/hindi/i.test(cn)) return { lang: "hi", source: "category" };
    if (/multi/i.test(cn)) return { lang: "multi", source: "category" };
    return { lang: null, source: null };
  }
  if (/multi/i.test(cn) && /language|audio/i.test(cn)) return { lang: "multi", source: "category" };
  const found = new Set();
  for (const m of cn.matchAll(LANG_WORD_RE)) found.add(LANG_WORDS[m[1].toLowerCase()]);
  if (found.size === 1) return { lang: [...found][0], source: "category" };
  return { lang: null, source: null };
}

// Quality label. `tags` carry "4k" only after the quality-cache probe
// demotion (applyQualityDemotion), so 4K comes from the tag alone, never from
// the raw title/category text. `probed` (a verified label from the probe
// cache) wins over everything.
function qualityOf(name, catName, tags, probed) {
  if (probed) return probed;
  const t = Array.isArray(tags) ? tags : [];
  if (t.includes("4k")) return "4K";
  const hay = `${name || ""} ${catName || ""}`;
  if (/\b(FHD|1080P?)\b/i.test(hay)) return "FHD";
  if (/\b(HD|720P?)\b/i.test(hay)) return "HD";
  if (/\b(SD|480P?)\b/i.test(hay)) return "SD";
  return null;
}
const QUALITY_RANK = { "4K": 0, FHD: 1, HD: 2, SD: 4 };
const qualityRank = (q) => QUALITY_RANK[q] ?? 3;

// Group a catalog's streams into titles. Precompute once per catalog
// generation; per-request work is resolveGroup() on the few groups a search
// actually returns.
//
// opts:
//   tmdbOf(s)        -> tmdb cache entry or null ({tmdb_id, tmdb_title, source, original_language, year})
//   catNameOf(s)     -> category name or null
//   titleKeyOf(s)    -> normalized "title|year" key or null (fallback grouping)
//   normTitle(str)   -> the title part of that key for a bare string (TMDB title check)
//   isLowQuality(s)  -> CAM / pre-retail copy
//   tagLangOf(s)     -> ISO from the stream's language tags (region defaults included), or null
//   probedQuality(s) -> verified quality label from the resolution probe, or null
//   isCanonical(s)   -> the copy the home rails show for this title (assignVariants)
//   episodeCountOf(s)-> known episode count (series), or null
//   memo             -> optional WeakMap reused across builds (caches the per-stream regex work)
//
// TMDB matches are not trusted blindly: "Ash (2025)" is cached as Avatar:
// Fire and Ash, "Dhurandhar (2025)" as its 2026 sequel. Inside one TMDB id,
// when some copies carry the TMDB title only those stay; otherwise the most
// common panel title stays. The rest group by their own title+year
// (splitting is the safe direction: worst case a title shows twice, as before).
function buildVariantIndex(streams, opts) {
  const {
    tmdbOf, catNameOf, titleKeyOf, isLowQuality = () => false, tagLangOf = () => null,
    probedQuality = () => null, isCanonical = () => false, episodeCountOf = () => null,
  } = opts;
  const normTitle = opts.normTitle || ((x) => String(x || "").toLowerCase().replace(/[^\p{L}\p{N}\p{M}\s]/gu, " ").replace(/\s+/g, " ").trim());
  const groups = new Map(); // key -> group
  const groupOf = new Map(); // stream id -> group
  const nameToTmdb = new Map(); // titleKey -> tmdb group key (null when ambiguous)
  const byTmdb = new Map(); // tmdb key -> { t, origLang, items: [[member, titleKey]] }
  const pending = []; // [member, titleKey, splitOff] for streams outside a TMDB group
  const add = (key, tmdbId, member) => {
    let g = groups.get(key);
    if (!g) { g = { key, tmdbId, origLang: null, members: [] }; groups.set(key, g); }
    g.members.push(member);
    groupOf.set(member.id, g);
    return g;
  };
  const memo = opts.memo || null; // optional WeakMap: s -> text-derived fields (rebuilds skip the regexes)
  for (const s of streams) {
    if (!s || s.id == null) continue;
    let d = memo && memo.get(s);
    if (!d || d.name !== s.name || d.cat !== s.category_id || d.tags !== s.tags) {
      const catName = catNameOf(s);
      d = {
        name: s.name, cat: s.category_id, tags: s.tags,
        lang: detectLang(s.name, catName).lang, textQuality: qualityOf(s.name, catName, s.tags),
        lq: !!isLowQuality(s), tagLang: tagLangOf(s) || null,
      };
      if (memo) memo.set(s, d);
    }
    const member = {
      id: s.id, s, lang: d.lang, tagLang: d.tagLang,
      quality: probedQuality(s) || d.textQuality,
      lq: d.lq, canon: !!isCanonical(s), episodes: episodeCountOf(s),
    };
    const t = tmdbOf(s);
    const tk = titleKeyOf(s);
    let usable = !!(t && t.source !== "no-match" && t.tmdb_id);
    if (usable) {
      // A panel year more than one off TMDB's is a wrong match: never fold it.
      const ny = /\(((?:19|20)\d{2})\)/.exec(s.name || "");
      const ty = parseInt(t.year, 10);
      if (ny && Number.isFinite(ty) && Math.abs(parseInt(ny[1], 10) - ty) > 1) usable = false;
    }
    if (!usable) { pending.push([member, tk, false]); continue; }
    const key = `t:${t.tmdb_id}`;
    let e = byTmdb.get(key);
    if (!e) { e = { t, origLang: null, items: [] }; byTmdb.set(key, e); }
    if (!e.origLang && t.original_language) e.origLang = t.original_language;
    e.items.push([member, tk]);
  }
  const titleOf = (tk) => (tk ? tk.slice(0, tk.lastIndexOf("|")) : null);
  for (const [key, e] of byTmdb) {
    const counts = new Map();
    for (const [, tk] of e.items) { const ti = titleOf(tk); if (ti) counts.set(ti, (counts.get(ti) || 0) + 1); }
    let keep = null; // accepted panel title (null = accept all)
    if (counts.size > 1) {
      const tt = e.t.tmdb_title ? normTitle(e.t.tmdb_title) : null;
      if (tt && counts.has(tt)) keep = tt;
      else {
        // Most common panel title; ties break on the title itself (stable
        // whatever order the catalog iterates in).
        for (const [ti, c] of counts) {
          if (keep === null || c > counts.get(keep) || (c === counts.get(keep) && ti < keep)) keep = ti;
        }
      }
    }
    // Subtitle forms: "Stree 2 (2024)" is TMDB's "Stree 2: Sarkate Ka Aatank"
    // (and the reverse). Only with the SAME year: "Dhurandhar (2025)" is not
    // "Dhurandhar: The Revenge" (2026), and "Blink" (no colon) is not "Blink Twice".
    const tmdbTitle = e.t.tmdb_title ? normTitle(e.t.tmdb_title) : null;
    const tmdbHead = e.t.tmdb_title && e.t.tmdb_title.includes(":") ? normTitle(e.t.tmdb_title.split(":")[0]) : null;
    const tmdbYear = String(e.t.year || "");
    const accepts = (member, tk, ti) => {
      if (keep === null || !ti || ti === keep) return true;
      if (!tmdbYear || tk.slice(tk.lastIndexOf("|") + 1) !== tmdbYear) return false;
      if (tmdbHead && ti === tmdbHead) return true;
      const raw = String(member.s.name || "").split("(")[0];
      return !!tmdbTitle && raw.includes(":") && normTitle(raw.split(":")[0]) === tmdbTitle;
    };
    for (const [member, tk] of e.items) {
      const ti = titleOf(tk);
      if (!accepts(member, tk, ti)) { pending.push([member, tk, true]); continue; }
      const g = add(key, e.t.tmdb_id, member);
      if (!g.origLang) g.origLang = e.origLang;
      if (tk) {
        const prev = nameToTmdb.get(tk);
        if (prev === undefined) nameToTmdb.set(tk, key);
        else if (prev !== key) nameToTmdb.set(tk, null);
      }
    }
  }
  // An unmatched copy joins the TMDB group of the same title + (non-empty)
  // year when exactly one exists; otherwise, and for split-off copies always,
  // copies group by title+year among themselves.
  for (const [member, tk, split] of pending) {
    const hasYear = tk && !tk.endsWith("|");
    const tkey = hasYear && !split ? nameToTmdb.get(tk) : null;
    if (tkey) { const g = groups.get(tkey); g.members.push(member); groupOf.set(member.id, g); continue; }
    add(tk ? `n:${tk}` : `id:${member.id}`, null, member);
  }
  return { groups, groupOf };
}

// Per-request view of one group.
// ctx:
//   passes(s)     -> profile gates (kid cert, title-language guard); members failing are never returned
//   profileLangs  -> Set of ISO codes the profile onboarded, or null (not onboarded)
//   preferLangs   -> ordered ISO codes for sorting after the original language
//   firstLang     -> ISO code that outranks even the original language (a
//                    language facet in the query: "hindi action")
//   startedIds    -> Set of String ids the profile already started (progress /
//                    recents): inside the top language bucket a started copy
//                    wins, so search reopens the copy with the resume point
// Returns null when no member passes, else { primary, variants, origLang, tmdbId }.
function resolveGroup(group, ctx) {
  if (!group) return null;
  const { passes = () => true, profileLangs = null, preferLangs = ["hi", "en"], firstLang = null, startedIds = null } = ctx || {};
  const started = (m) => !!startedIds && startedIds.has(String(m.id));
  let members = group.members.filter((m) => passes(m.s));
  if (!members.length) return null;
  // Profile language chips: drop copies KNOWN to be in a language the profile
  // did not pick, unless that would drop the whole title.
  if (profileLangs && profileLangs.size) {
    const kept = members.filter((m) => !m.lang || m.lang === "multi" || profileLangs.has(m.lang));
    if (kept.length) members = kept;
  }
  const orig = group.origLang || null;
  const origOk = !!orig && (!profileLangs || !profileLangs.size || profileLangs.has(orig));
  // Unknown copy: TMDB's original language is the better hint; a region
  // default tag (INDIAN -> hindi) only when TMDB has none.
  const guessOf = (m) => (m.lang ? null : (orig || m.tagLang || null));
  const effLang = (m) => m.lang || guessOf(m);
  const langRank = (m) => {
    const l = effLang(m);
    if (!l) return 999;
    if (firstLang && l === firstLang) return -1;
    if (l === orig && origOk) return 0;
    const i = preferLangs.indexOf(l);
    if (i >= 0) return 1 + i;
    if (l === orig) return 100; // the profile excludes it: still ahead of other languages
    if (l === "multi") return 300;
    return 200;
  };
  // Language bucket, then a copy the profile already started, then inside one language: non-CAM, definite before
  // guessed, more episodes (series dubs carry partial seasons), the home
  // rails' canonical copy (same id on home and search), best quality.
  const key = (m) => [
    langRank(m), started(m) ? 0 : 1, effLang(m) || "~", m.lq ? 1 : 0, m.lang ? 0 : 1,
    -(m.episodes || 0), m.canon ? 0 : 1, qualityRank(m.quality), String(m.id),
  ];
  const cmp = (a, b) => {
    const x = key(a), y = key(b);
    for (let i = 0; i < x.length; i++) if (x[i] !== y[i]) return x[i] < y[i] ? -1 : 1;
    return 0;
  };
  const sorted = members.slice().sort(cmp);
  // Primary: first non-CAM (or already started) copy in that order (CAM only
  // when nothing else).
  const primary = sorted.find((m) => !m.lq || started(m)) || sorted[0];
  const ordered = [primary, ...sorted.filter((m) => m !== primary)];
  const variants = ordered.map((m) => {
    const guess = guessOf(m);
    return {
      id: m.id,
      lang: m.lang,
      langName: langName(m.lang),
      langGuess: guess,
      langGuessName: langName(guess),
      quality: m.quality,
      lowQuality: m.lq,
      name: m.s.name,
      isPrimary: m === primary,
    };
  });
  return { primary, variants, origLang: orig, tmdbId: group.tmdbId };
}

// Fields added to a result tile for its group (additive).
function tileVariantFields(resolved) {
  const p = resolved.variants[0];
  return {
    lang: p.lang,
    langName: p.langName,
    langGuess: p.langGuess,
    langGuessName: p.langGuessName,
    quality: p.quality,
    variantCount: resolved.variants.length,
    variants: resolved.variants,
  };
}

// GET /api/variants/:mode/:id payload for stream `s`.
//   index        -> buildVariantIndex result, or null (not built yet: the copy alone)
//   opts         -> the buildVariantIndex opts (to describe a copy outside the index)
//   isKidBlocked -> kid cert gate; a blocked requested copy yields an empty list
//   titleLangPasses(name), ctx -> same gates/order as search
function variantsPayload({ mode, s, index, opts, isKidBlocked = () => false, titleLangPasses = () => true, ctx = {} }) {
  const empty = { mode, id: s.id, tmdb_id: null, originalLanguage: null, primaryId: null, variantCount: 0, variants: [] };
  if (isKidBlocked(s)) return empty;
  const solo = () => buildVariantIndex([s], opts).groupOf.get(s.id);
  const group = (index && index.groupOf.get(s.id)) || solo();
  // The requested copy is always listed (the viewer is already on it); its
  // siblings go through the profile's kid + title-language gates.
  const resolved = resolveGroup(group, {
    ...ctx, passes: (x) => !isKidBlocked(x) && (x === s || titleLangPasses(x.name)),
  });
  let variants = resolved.variants;
  if (!variants.some((v) => v.id === s.id)) {
    // Dropped by the profile's language chips: append it.
    variants = [...variants, { ...resolveGroup(solo(), {}).variants[0], isPrimary: false }];
  }
  const t = opts.tmdbOf(s);
  return {
    mode,
    id: s.id,
    tmdb_id: resolved.tmdbId || (t && t.source !== "no-match" && t.tmdb_id) || null,
    originalLanguage: resolved.origLang,
    primaryId: resolved.primary.id,
    variantCount: variants.length,
    variants,
  };
}

// Per-index cache of buildVariantIndex results. Requests only READ it: a
// missing or stale build is scheduled in the background, never built inline,
// and nothing builds while the index is still filling (`ix.ready` false).
//   build(mode, ix, actx) -> { vix, opts }   (the heavy part)
//   getGen()              -> current catalog generation
//   schedule(fn)          -> defer fn off the request path (setImmediate)
function createVariantIndexCache({ build, getGen, schedule = setImmediate, minRebuildMs = 2 * 60 * 1000, now = Date.now, log = () => {} }) {
  const cache = new WeakMap(); // ix.byId -> { gen, at, vix, opts }
  const pending = new WeakSet();
  const buildNow = (mode, ix, actx) => {
    const gen = getGen();
    const entry = { gen, at: now(), ...build(mode, ix, actx) };
    cache.set(ix.byId, entry);
    return entry;
  };
  const scheduleBuild = (mode, ix, actx) => {
    const byId = ix.byId;
    if (!byId || pending.has(byId)) return;
    pending.add(byId);
    schedule(() => {
      try { if (ix.byId === byId && ix.ready) buildNow(mode, ix, actx); }
      catch (e) { log(`[${mode}] variant index build failed: ${e.message}`); }
      finally { pending.delete(byId); }
    });
  };
  const get = (mode, ix, actx) => {
    if ((mode !== "movie" && mode !== "series") || !ix?.byId?.size) return null;
    const c = cache.get(ix.byId);
    if (!ix.ready) return c || null;
    if (!c) { scheduleBuild(mode, ix, actx); return null; }
    if (c.gen !== getGen() && now() - c.at >= minRebuildMs) scheduleBuild(mode, ix, actx);
    return c;
  };
  return { get, scheduleBuild };
}

module.exports = {
  createVariantIndexCache,
  LANG_WORDS, LANG_NAMES, langName, detectLang, qualityOf, buildVariantIndex, resolveGroup,
  tileVariantFields, variantsPayload,
};
