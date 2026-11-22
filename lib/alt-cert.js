"use strict";

// Foreign age rating -> US-scale equivalent, for titles TMDB has no US rating
// for (56% of the catalog; the kid allow-list hides every one of them).
//
// Safety rules (this feeds a KID allow-list, so every ambiguity errs strict):
//   - Ratings are bucketed by age (0 / 6 / 12 / 15 / 16 / 18), per country.
//   - The most restrictive country wins.
//   - A lenient verdict (anything <= 12) needs TWO countries to agree. A single
//     country only grants PG (never G, never PG-13): Indian "UA" and German
//     FSK 12 are known to be looser than the US "R" for violent films.
//   - Ratings we cannot map (any country) never grant anything and suppress
//     the Family-genre heuristic: some rating exists, we just don't understand it.

const TABLES = {
  GB: { U: 0, PG: 6, "12": 12, "12A": 12, "15": 15, "18": 18, R18: 18 },
  DE: { "0": 0, "6": 6, "12": 12, "16": 16, "18": 18 },
  IN: { U: 0, "U/A": 12, UA: 12, A: 18, S: 18 },
  AU: { G: 0, PG: 6, M: 15, "MA15+": 15, "R18+": 18, "X18+": 18 },
  CA: { G: 0, PG: 6, "14A": 12, "18A": 16, R: 18, A: 18 },
  IE: { G: 0, PG: 6, "12A": 12, "12": 12, "15A": 15, "16": 16, "18": 18 },
  FR: { U: 0, "10": 6, "12": 12, "16": 16, "18": 18 },
  NL: { AL: 0, "6": 6, "9": 6, "12": 12, "14": 15, "16": 16, "18": 18 },
  BR: { L: 0, "10": 6, "12": 12, "14": 15, "16": 16, "18": 18 },
};
const IGNORE = /^(NR|N\/R|UNRATED|NOT RATED|UR|NONE|TBC|TBA|--|-)$/;
const ADULT = /^(NC-?17|X|XXX|R-?18\+?|R18\+?|18\+?|ADULT|ADULTS|RC|BPJM|MA|TV-MA|AO)$/;

// Returns an age bucket (0|6|12|15|16|18), "ignore" (carries no information), or null (unmappable).
function bucketFor(country, raw) {
  const c = String(raw || "").trim().toUpperCase().replace(/\s+/g, "");
  if (!c) return "ignore";
  if (IGNORE.test(c)) return "ignore";
  const t = TABLES[country];
  if (t && c in t) return t[c];
  if (ADULT.test(c)) return 18;
  const us = { G: 0, "TV-Y": 0, "TV-G": 0, PG: 6, "TV-Y7": 6, "TV-PG": 6, "PG-13": 12, "TV-14": 15, R: 16 };
  if (c in us) return us[c];
  const m = /^(\d{1,2})\+?$/.exec(c);
  if (m) {
    const n = parseInt(m[1], 10);
    return n <= 5 ? 0 : n <= 11 ? 6 : n <= 13 ? 12 : n <= 15 ? 15 : n <= 17 ? 16 : 18;
  }
  return null;
}

function usEquivalent(mode, bucket, singleCountry) {
  const tv = mode === "series";
  if (bucket >= 18) return tv ? "TV-MA" : "NC-17";
  if (bucket >= 16) return tv ? "TV-MA" : "R";
  if (bucket >= 15) return tv ? "TV-14" : "R";
  // bucket <= 12: lenient — needs corroboration
  if (singleCountry) {
    if (bucket <= 6) return tv ? "TV-PG" : "PG";
    return tv ? "TV-14" : "R";
  }
  if (bucket === 0) return tv ? "TV-G" : "G";
  if (bucket <= 6) return tv ? "TV-PG" : "PG";
  return tv ? "TV-14" : "PG-13";
}

// results: TMDB `release_dates.results` (movie) or `content_ratings.results` (tv).
// Returns { cert, anyData, unmapped }.
function altCertFromTmdb(mode, results) {
  const perCountry = new Map();
  let anyData = false, unmapped = false;
  for (const r of results || []) {
    const country = r.iso_3166_1;
    const raws = mode === "series" ? [r.rating] : (r.release_dates || []).map((d) => d.certification);
    for (const raw of raws) {
      const b = bucketFor(country, raw);
      if (b === "ignore") continue;
      anyData = true;
      if (b === null) { unmapped = true; continue; }
      perCountry.set(country, Math.max(perCountry.get(country) ?? 0, b));
    }
  }
  if (!perCountry.size) return { cert: "", anyData, unmapped };
  const maxBucket = Math.max(...perCountry.values());
  return { cert: usEquivalent(mode, maxBucket, perCountry.size === 1), anyData, unmapped };
}

const FAMILY_EXCLUDE = ["Horror", "Crime", "Thriller", "War", "War & Politics", "Mystery", "Romance", "Reality"];
// Last resort when NO rating exists anywhere: a Family-genre title (Kids /
// Animation+Family for TV) with no dark genres and no adult-looking name.
function familyHeuristicCert(mode, genres, name) {
  const g = Array.isArray(genres) ? genres : [];
  if (g.some((x) => FAMILY_EXCLUDE.includes(x))) return "";
  if (/\b(adult|xxx|porn|erotic|18\+|nsfw|hentai|sex|nude|naked)\b/i.test(name || "")) return "";
  if (mode === "series") return g.includes("Kids") || (g.includes("Family") && g.includes("Animation")) ? "TV-PG" : "";
  return g.includes("Family") ? "PG" : "";
}

module.exports = { bucketFor, usEquivalent, altCertFromTmdb, familyHeuristicCert };
