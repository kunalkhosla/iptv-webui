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
const LANG_NAMES = {
  en: "English", hi: "Hindi", ta: "Tamil", te: "Telugu", ml: "Malayalam", kn: "Kannada", bn: "Bengali",
  gu: "Gujarati", mr: "Marathi", pa: "Punjabi", ur: "Urdu", tr: "Turkish", ko: "Korean", ja: "Japanese",
  zh: "Chinese", ar: "Arabic", es: "Spanish", fr: "French", de: "German", ru: "Russian", th: "Thai",
  id: "Indonesian", it: "Italian", pt: "Portuguese", multi: "Multi-audio",
};
const langName = (iso) => (iso && LANG_NAMES[iso]) || null;

const LANG_WORD_RE = new RegExp(`\\b(${Object.keys(LANG_WORDS).join("|")})\\b`, "gi");

// Language of one stream, with how we know it:
//   source "title"    - the title says so: "(Hindi)" suffix or a "[Tel,Tam,Hin]" bundle (-> "multi")
//   source "category" - the category NAME names exactly one language ("TAMIL | 2026 4K"),
//                       a Hindi-dubbed category, or a multi-audio category
//   null              - unknown (a region-default tag like INDIAN -> hindi is only a guess)
function detectLang(name, catName) {
  const n = String(name || "");
  if (/\[[^\]]*,[^\]]*\]/.test(n)) return { lang: "multi", source: "title" };
  // Any "(Word)" group that is a language word, e.g. "X (2026) (Hindi)" or "X (Hindi) (4K)".
  for (const m of n.matchAll(/\(\s*([A-Za-z]+)\s*\)/g)) {
    const iso = LANG_WORDS[m[1].toLowerCase()];
    if (iso) return { lang: iso, source: "title" };
  }
  const cn = String(catName || "");
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

// Quality label from the stream's tags / title / category name.
function qualityOf(name, catName, tags) {
  const t = Array.isArray(tags) ? tags : [];
  const hay = `${name || ""} ${catName || ""}`;
  if (t.includes("4k") || /\b(4K|UHD|2160P?)\b/i.test(hay)) return "4K";
  if (/\b(FHD|1080P?)\b/i.test(hay)) return "FHD";
  if (/\b(HD|720P?)\b/i.test(hay)) return "HD";
  if (/\b(SD|480P?)\b/i.test(hay)) return "SD";
  return null;
}
const QUALITY_RANK = { "4K": 0, FHD: 1, HD: 2, null: 3, SD: 4 };

// Group a catalog's streams into titles. Precompute once per catalog
// generation; per-request work is resolveGroup() on the few groups a search
// actually returns.
//
// opts:
//   tmdbOf(s)       -> tmdb cache entry or null ({tmdb_id, tmdb_title, source, original_language, year})
//   catNameOf(s)    -> category name or null
//   titleKeyOf(s)   -> normalized "title|year" key or null (fallback grouping)
//   normTitle(str)  -> the title part of that key for a bare string (TMDB title check)
//   isLowQuality(s) -> CAM / pre-retail copy
//   tagLangOf(s)    -> ISO from the stream's language tags (region defaults included), or null
//
// TMDB matches are not trusted blindly: "Ash (2025)" and "Fire (2025)
// (Tamil)" are cached as Avatar: Fire and Ash. Inside one TMDB id only copies
// whose panel title equals the TMDB title or the group's most common panel
// title stay; the rest group by their own title+year (splitting is the safe
// direction: worst case a title shows twice, as before).
function buildVariantIndex(streams, opts) {
  const { tmdbOf, catNameOf, titleKeyOf, isLowQuality = () => false, tagLangOf = () => null } = opts;
  const normTitle = opts.normTitle || ((x) => String(x || "").toLowerCase().replace(/[^\p{L}\p{N}\p{M}\s]/gu, " ").replace(/\s+/g, " ").trim());
  const groups = new Map(); // key -> group
  const groupOf = new Map(); // stream id -> group
  const nameToTmdb = new Map(); // titleKey -> tmdb group key (null when ambiguous)
  const byTmdb = new Map(); // tmdb key -> { t, items: [[member, titleKey]] }
  const pending = []; // [member, titleKey] for streams without a usable TMDB match
  const add = (key, tmdbId, member) => {
    let g = groups.get(key);
    if (!g) { g = { key, tmdbId, origLang: null, members: [] }; groups.set(key, g); }
    g.members.push(member);
    groupOf.set(member.id, g);
    return g;
  };
  for (const s of streams) {
    if (!s || s.id == null) continue;
    const catName = catNameOf(s);
    const { lang, source } = detectLang(s.name, catName);
    const member = {
      id: s.id, s, lang, langSource: source, tagLang: tagLangOf(s) || null,
      quality: qualityOf(s.name, catName, s.tags), lq: !!isLowQuality(s),
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
    if (!usable) { pending.push([member, tk]); continue; }
    const key = `t:${t.tmdb_id}`;
    let e = byTmdb.get(key);
    if (!e) { e = { t, origLang: null, items: [] }; byTmdb.set(key, e); }
    if (!e.origLang && t.original_language) e.origLang = t.original_language;
    e.items.push([member, tk]);
  }
  for (const [key, e] of byTmdb) {
    const titleOf = (tk) => (tk ? tk.slice(0, tk.lastIndexOf("|")) : null);
    let keep = null; // Set of accepted panel titles (null = accept all)
    const counts = new Map();
    for (const [, tk] of e.items) { const ti = titleOf(tk); if (ti) counts.set(ti, (counts.get(ti) || 0) + 1); }
    if (counts.size > 1) {
      let top = null, n = 0;
      for (const [ti, c] of counts) if (c > n) { top = ti; n = c; }
      keep = new Set([top]);
      const tt = e.t.tmdb_title ? normTitle(e.t.tmdb_title) : null;
      if (tt && counts.has(tt)) keep.add(tt);
    }
    for (const [member, tk] of e.items) {
      const ti = titleOf(tk);
      if (keep && ti && !keep.has(ti)) { pending.push([member, tk, true]); continue; }
      const g = add(key, e.t.tmdb_id, member);
      if (!g.origLang) g.origLang = e.origLang;
      if (tk) {
        const prev = nameToTmdb.get(tk);
        if (prev === undefined) nameToTmdb.set(tk, key);
        else if (prev !== key) nameToTmdb.set(tk, null);
      }
    }
  }
  // Unmatched twins join the TMDB group of the same title+year when that is
  // unambiguous; otherwise (and split-off copies always) they group by
  // title+year among themselves.
  for (const [member, tk, split] of pending) {
    const tkey = tk && !split ? nameToTmdb.get(tk) : null;
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
// Returns null when no member passes, else { primary, variants }.
function resolveGroup(group, ctx) {
  if (!group) return null;
  const { passes = () => true, profileLangs = null, preferLangs = ["hi", "en"] } = ctx || {};
  let members = group.members.filter((m) => passes(m.s));
  if (!members.length) return null;
  // Profile language chips: drop copies KNOWN to be in a language the profile
  // did not pick, unless that would drop the whole title.
  if (profileLangs && profileLangs.size) {
    const kept = members.filter((m) => !m.lang || m.lang === "multi" || profileLangs.has(m.lang));
    if (kept.length) members = kept;
  }
  const orig = group.origLang || null;
  const origOk = orig && (!profileLangs || !profileLangs.size || profileLangs.has(orig));
  const guessOf = (m) => (m.lang ? null : (m.tagLang || orig || null));
  const effLang = (m) => m.lang || guessOf(m);
  const langRank = (m) => {
    const l = effLang(m);
    if (!l) return 999;
    if (l === orig && origOk) return 0;
    const i = preferLangs.indexOf(l);
    if (i >= 0) return 1 + i;
    if (l === orig) return 100;
    return l === "multi" ? 300 : 200;
  };
  // language bucket, then (inside one language) non-CAM, definite before
  // guessed, best quality.
  const key = (m) => [langRank(m), effLang(m) || "~", m.lq ? 1 : 0, m.lang ? 0 : 1, QUALITY_RANK[m.quality] ?? 3, String(m.id)];
  const cmp = (a, b) => {
    const x = key(a), y = key(b);
    for (let i = 0; i < x.length; i++) if (x[i] !== y[i]) return x[i] < y[i] ? -1 : 1;
    return 0;
  };
  const sorted = members.slice().sort(cmp);
  // Primary: first non-CAM copy in that order (CAM only when nothing else).
  const primary = sorted.find((m) => !m.lq) || sorted[0];
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
  if (!resolved) return {};
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

module.exports = { LANG_WORDS, LANG_NAMES, langName, detectLang, qualityOf, buildVariantIndex, resolveGroup, tileVariantFields };
