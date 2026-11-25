const test = require("node:test");
const assert = require("node:assert/strict");
const { detectLang, qualityOf, buildVariantIndex, resolveGroup, tileVariantFields } = require("../lib/variants");

// Real panel rows for "Dhurandhar: The Revenge (2026)" (TMDB 1582770, original
// language Hindi), plus the 2025 film and an unmatched spin-off.
const CATS = {
  838: "INDIAN 2026 4K", 766: "INDIAN | FHD 2026", 829: "TAMIL | 2026 4K", 768: "TAMIL | 2026",
  831: "TELUGU | 2026 4K ", 770: "TELUGU | 2026", 833: "MALAYALAM 2026 (4K)", 783: "MALAYALAM | 2026",
  789: "KANNADA | 2026", 599: "INDIAN | FHD 2025", 900: "INDIAN CAM 2026",
};
const S = (id, name, cat, tags, us_cert = "NR") => ({ id, name, category_id: String(cat), tags, us_cert });
const STREAMS = [
  S(796884, "Dhurandhar: The Revenge (2026)(4K)", 838, ["india", "hindi", "4k", "entertainment"]),
  S(729968, "Dhurandhar: The Revenge (2026) (Hindi)", 766, ["india", "hindi", "entertainment"]),
  S(787206, "Dhurandhar: The Revenge (2026) (4K)", 829, ["tamil", "4k", "entertainment"]),
  S(729973, "Dhurandhar: The Revenge (2026) (Tamil)", 768, ["tamil", "entertainment"]),
  S(787663, "Dhurandhar: The Revenge (2026) (4K)", 831, ["telugu", "4k", "entertainment"]),
  S(729974, "Dhurandhar: The Revenge (2026) (Telugu)", 770, ["telugu", "entertainment"]),
  S(787791, "Dhurandhar: The Revenge (2026) (4K)", 833, ["malayalam", "4k", "entertainment"]),
  S(729970, "Dhurandhar: The Revenge (2026) (Malayalam)", 783, ["malayalam", "entertainment"]),
  S(729969, "Dhurandhar: The Revenge (2026) (Kannada)", 789, ["kannada", "entertainment"]),
  S(639080, "Dhurandhar (2025) (Hindi)", 599, ["india", "hindi", "entertainment"]),
  S(735258, "Dhurandhar Raw and Undekha (2026) (Hindi)", 766, ["india", "hindi", "entertainment"]),
];
const TMDB = {
  1582770: { tmdb_id: 1582770, source: "tmdb", original_language: "hi", year: "2026" },
  1291608: { tmdb_id: 1291608, source: "tmdb", original_language: "hi", year: "2025" },
};
const TMDB_OF = { 639080: 1291608, 735258: null };
const ISO = { hindi: "hi", tamil: "ta", telugu: "te", malayalam: "ml", kannada: "kn", english: "en" };
const titleKey = (s) => s.name.replace(/\((?:\d{4})\).*$/, "").replace(/\(.*?\)/g, "").trim().toLowerCase() + "|" + ((/\((\d{4})\)/.exec(s.name) || [])[1] || "");

function opts(tmdbOverride = {}) {
  return {
    tmdbOf: (s) => {
      if (s.id in tmdbOverride) return tmdbOverride[s.id];
      if (s.id in TMDB_OF) return TMDB_OF[s.id] ? TMDB[TMDB_OF[s.id]] : { source: "no-match" };
      return TMDB[1582770];
    },
    catNameOf: (s) => CATS[s.category_id] || null,
    titleKeyOf: titleKey,
    isLowQuality: (s) => /\bCAM\b/.test(CATS[s.category_id] || "") || /\(CAM\)/.test(s.name),
    tagLangOf: (s) => { for (const t of s.tags || []) if (ISO[t]) return ISO[t]; return null; },
  };
}

test("detectLang: title suffix, category name, and unknown", () => {
  assert.deepEqual(detectLang("X (2026) (Hindi)", "INDIAN | FHD 2026"), { lang: "hi", source: "title" });
  assert.deepEqual(detectLang("X (2026) (Teugu)", null), { lang: "te", source: "title" });
  assert.deepEqual(detectLang("X (2026) [Tel,Tam,Hin]", null), { lang: "multi", source: "title" });
  assert.deepEqual(detectLang("X (2026) (4K)", "TAMIL | 2026 4K"), { lang: "ta", source: "category" });
  assert.deepEqual(detectLang("X (2026)(4K)", "INDIAN 2026 4K"), { lang: null, source: null });
  assert.deepEqual(detectLang("X (2026)", "HINDI DUBBED"), { lang: "hi", source: "category" });
  assert.deepEqual(detectLang("X (2026)", "TAMIL TELUGU MIX"), { lang: null, source: null });
});

test("qualityOf", () => {
  assert.equal(qualityOf("X (4K)", "TAMIL", []), "4K");
  assert.equal(qualityOf("X", "TAMIL", ["4k"]), "4K");
  assert.equal(qualityOf("X (Hindi)", "INDIAN | FHD 2026", []), "FHD");
  assert.equal(qualityOf("X 720p", "", []), "HD");
  assert.equal(qualityOf("X", "TAMIL | 2026", []), null);
});

test("Dhurandhar: one group, Hindi primary, 4K Hindi guess labelled likely", () => {
  const { groupOf, groups } = buildVariantIndex(STREAMS, opts());
  const g = groupOf.get(729973);
  assert.equal(g.key, "t:1582770");
  assert.equal(g.members.length, 9);
  assert.equal(groupOf.get(796884), g);
  assert.notEqual(groupOf.get(639080), g); // the 2025 film is its own title
  assert.ok(groups.get(groupOf.get(735258).key)); // unmatched spin-off groups by name
  assert.notEqual(groupOf.get(735258), g);

  const r = resolveGroup(g, {});
  // Definite Hindi beats the 4K copy whose Hindi is only a guess.
  assert.equal(r.primary.id, 729968);
  const v = r.variants;
  assert.equal(v[0].id, 729968);
  assert.deepEqual(
    { lang: v[0].lang, langName: v[0].langName, quality: v[0].quality, isPrimary: v[0].isPrimary, langGuess: v[0].langGuess },
    { lang: "hi", langName: "Hindi", quality: "FHD", isPrimary: true, langGuess: null },
  );
  const four = v.find((x) => x.id === 796884);
  assert.equal(v[1].id, 796884); // Hindi-likely 4K right after the definite Hindi
  assert.deepEqual({ lang: four.lang, langName: four.langName, langGuess: four.langGuess, langGuessName: four.langGuessName, quality: four.quality },
    { lang: null, langName: null, langGuess: "hi", langGuessName: "Hindi", quality: "4K" });
  const tamil4k = v.find((x) => x.id === 787206);
  assert.equal(tamil4k.lang, "ta");
  assert.equal(tamil4k.langName, "Tamil");
  assert.equal(tamil4k.quality, "4K");
  assert.equal(v.filter((x) => x.isPrimary).length, 1);
  // Within a language the 4K copy comes before the plain one.
  const ix = (id) => v.findIndex((x) => x.id === id);
  assert.ok(ix(787206) < ix(729973));
  const tile = tileVariantFields(r);
  assert.equal(tile.langName, "Hindi");
  assert.equal(tile.variantCount, 9);
  assert.equal(tile.variants, v);
});

test("profile languages: drop non-chosen languages, sort onboarded first", () => {
  const { groupOf } = buildVariantIndex(STREAMS, opts());
  const g = groupOf.get(729968);
  const r = resolveGroup(g, { profileLangs: new Set(["hi", "en"]), preferLangs: ["en", "hi"] });
  assert.deepEqual(r.variants.map((x) => x.id).sort(), [729968, 796884].sort());
  const r2 = resolveGroup(g, { profileLangs: new Set(["hi", "ta"]), preferLangs: ["ta", "hi", "en"] });
  assert.equal(r2.primary.id, 729968); // original language still primary
  assert.deepEqual(r2.variants.map((x) => x.lang || x.langGuess), ["hi", "hi", "ta", "ta"]);
});

test("profile without the original language gets its own language first", () => {
  const { groupOf } = buildVariantIndex(STREAMS, opts());
  const r = resolveGroup(groupOf.get(729968), { profileLangs: new Set(["ta"]), preferLangs: ["ta", "hi", "en"] });
  assert.equal(r.primary.id, 787206); // Tamil 4K
  assert.ok(r.variants.every((x) => !x.lang || x.lang === "ta"));
});

test("passes gate: kid-blocked copies never appear; all blocked -> null", () => {
  const streams = STREAMS.map((s) => (s.id === 729973 ? { ...s, us_cert: "PG" } : s));
  const { groupOf } = buildVariantIndex(streams, opts());
  const kidOk = (s) => s.us_cert === "PG";
  const r = resolveGroup(groupOf.get(729968), { passes: kidOk });
  assert.deepEqual(r.variants.map((x) => x.id), [729973]);
  assert.equal(resolveGroup(groupOf.get(639080), { passes: kidOk }), null);
});

test("CAM copies are primary only when nothing else", () => {
  const streams = [
    S(1, "Film (2026) (Hindi)", 900, ["hindi"]),
    S(2, "Film (2026) (Tamil)", 768, ["tamil"]),
  ];
  const o = opts({ 1: TMDB[1582770], 2: TMDB[1582770] });
  const { groupOf } = buildVariantIndex(streams, o);
  const r = resolveGroup(groupOf.get(1), {});
  assert.equal(r.primary.id, 2);
  assert.equal(r.variants[0].id, 2);
  assert.equal(r.variants[1].lowQuality, true);
  const solo = buildVariantIndex([streams[0]], o);
  assert.equal(resolveGroup(solo.groupOf.get(1), {}).primary.id, 1);
});

test("unmatched twin joins its title's TMDB group; year mismatch does not", () => {
  const streams = [
    S(10, "Movie X (2020) (Hindi)", 766, ["hindi"]),
    S(11, "Movie X (2020) (Tamil)", 768, ["tamil"]),
    S(12, "Movie X (2014)", 766, ["hindi"]),
  ];
  const tm = { tmdb_id: 55, source: "tmdb", original_language: "hi", year: "2020" };
  const { groupOf } = buildVariantIndex(streams, opts({ 10: tm, 11: { source: "no-match" }, 12: tm }));
  assert.equal(groupOf.get(11), groupOf.get(10));
  assert.notEqual(groupOf.get(12), groupOf.get(10));
});

test("wrong TMDB matches with a different panel title split off", () => {
  const avatar = { tmdb_id: 83533, tmdb_title: "Avatar: Fire and Ash", source: "tmdb", original_language: "en", year: "2025" };
  const streams = [
    S(30, "Avatar: Fire and Ash (2025)(English)(4K)", 838, ["4k"]),
    S(31, "Avatar: Fire and Ash (2025) (Hindi)", 766, ["hindi"]),
    S(32, "Ash (2025)", 766, ["hindi"]),
    S(33, "Ash (2025) (Hindi)", 766, ["hindi"]),
    S(34, "Fire (2025) (Tamil)", 768, ["tamil"]),
  ];
  const o = opts(Object.fromEntries(streams.map((x) => [x.id, avatar])));
  o.titleKeyOf = (s) => s.name.replace(/\((?:\d{4})\).*$/, "").replace(/[^a-z0-9 ]/gi, " ").replace(/\s+/g, " ").trim().toLowerCase() + "|2025";
  o.normTitle = (x) => x.replace(/[^a-z0-9 ]/gi, " ").replace(/\s+/g, " ").trim().toLowerCase();
  const { groupOf } = buildVariantIndex(streams, o);
  assert.equal(groupOf.get(30), groupOf.get(31));
  assert.equal(groupOf.get(30).key, "t:83533");
  assert.equal(groupOf.get(32), groupOf.get(33));
  assert.equal(groupOf.get(32).key, "n:ash|2025");
  assert.notEqual(groupOf.get(34), groupOf.get(30));
  // Most common panel title wins when it is not the TMDB title.
  const o2 = opts(Object.fromEntries(streams.map((x) => [x.id, { ...avatar, tmdb_title: "Something Else" }])));
  o2.titleKeyOf = o.titleKeyOf; o2.normTitle = o.normTitle;
  const r2 = buildVariantIndex(streams, o2);
  assert.equal(r2.groupOf.get(30), r2.groupOf.get(31));
  assert.equal(r2.groupOf.get(30).key, "t:83533");
});

test("no TMDB original language: unknown copies get no guess", () => {
  const streams = [S(20, "Thing (2021)", 838, ["4k"]), S(21, "Thing (2021) (English)", 766, [])];
  const { groupOf } = buildVariantIndex(streams, opts({ 20: { source: "no-match" }, 21: { source: "no-match" } }));
  const r = resolveGroup(groupOf.get(20), {});
  assert.equal(groupOf.get(20), groupOf.get(21));
  const unk = r.variants.find((x) => x.id === 20);
  assert.equal(unk.lang, null);
  assert.equal(unk.langGuess, null);
  assert.equal(r.primary.id, 21);
});

test("build is fast on a catalog-sized index", () => {
  const streams = [];
  for (let i = 0; i < 70000; i++) streams.push(S(i, `Film ${i % 20000} (20${10 + (i % 15)}) (${["Hindi", "Tamil", "Telugu"][i % 3]})`, 766, ["hindi"]));
  const o = opts();
  o.tmdbOf = (s) => ({ tmdb_id: s.id % 20000, source: "tmdb", original_language: "hi", year: String(2010 + (s.id % 15)) });
  const t0 = Date.now();
  const { groups } = buildVariantIndex(streams, o);
  const ms = Date.now() - t0;
  assert.ok(groups.size > 0);
  assert.ok(ms < 2000, `build took ${ms}ms`);
});
