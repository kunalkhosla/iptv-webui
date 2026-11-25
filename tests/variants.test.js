const test = require("node:test");
const assert = require("node:assert/strict");
const { detectLang, qualityOf, buildVariantIndex, resolveGroup, tileVariantFields, variantsPayload, createVariantIndexCache } = require("../lib/variants");
const { makeKidsBlocker } = require("../lib/kids-filter");

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

test("qualityOf: 4K only from the (probe-demoted) tag; probe wins", () => {
  assert.equal(qualityOf("X", "TAMIL", ["4k"]), "4K");
  assert.equal(qualityOf("X (4K)", "TAMIL 4K", []), null); // tag demoted by the resolution probe
  assert.equal(qualityOf("X (Hindi)", "INDIAN | FHD 2026", []), "FHD");
  assert.equal(qualityOf("X 720p", "", []), "HD");
  assert.equal(qualityOf("X", "TAMIL | 2026", []), null);
  assert.equal(qualityOf("X (4K)", "", ["4k"], "FHD"), "FHD");
  const { groupOf } = buildVariantIndex([S(1, "F (2026) (4K)", 838, ["4k"])], { ...opts(), probedQuality: () => "HD" });
  assert.equal(resolveGroup(groupOf.get(1), {}).variants[0].quality, "HD");
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

// Title check inside one TMDB id: probe cases from the live catalog, in both
// iteration orders.
const plainKey = (s) => s.name.replace(/\((\d{4})\).*$/, "").replace(/[^a-z0-9 ]/gi, " ").replace(/\s+/g, " ").trim().toLowerCase()
  + "|" + ((/\((\d{4})\)/.exec(s.name) || [])[1] || "");
const plainNorm = (x) => x.replace(/[^a-z0-9 ]/gi, " ").replace(/\s+/g, " ").trim().toLowerCase();
function groupsBoth(streams, tm) {
  const out = [];
  for (const list of [streams, streams.slice().reverse()]) {
    const o = opts(Object.fromEntries(list.map((x) => [x.id, tm])));
    o.titleKeyOf = plainKey; o.normTitle = plainNorm;
    out.push(buildVariantIndex(list, o).groupOf);
  }
  return out;
}
test("title check: TMDB title present -> only it stays (both orders)", () => {
  const revenge = { tmdb_id: 1582770, tmdb_title: "Dhurandhar: The Revenge", source: "tmdb", original_language: "hi", year: "2026" };
  const d = [
    S(1, "Dhurandhar (2025) (Hindi)", 599, ["hindi"]), S(2, "Dhurandhar (2025) (Tamil)", 768, ["tamil"]),
    S(3, "Dhurandhar (2025) (Telugu)", 770, ["telugu"]),
    S(4, "Dhurandhar: The Revenge (2026) (Hindi)", 766, ["hindi"]), S(5, "Dhurandhar: The Revenge (2026)(4K)", 838, ["4k"]),
  ];
  for (const g of groupsBoth(d, revenge)) {
    assert.equal(g.get(4).key, "t:1582770");
    assert.equal(g.get(5), g.get(4));
    assert.equal(g.get(1).key, "n:dhurandhar|2025");
    assert.equal(g.get(2), g.get(1));
    assert.equal(g.get(3), g.get(1));
  }
  const blinkTm = { tmdb_id: 840705, tmdb_title: "Blink Twice", source: "tmdb", original_language: "en", year: "2024" };
  const blink = [S(10, "Blink (2024)", 766, []), S(11, "Blink (2024) (Hindi)", 766, []), S(12, "Blink Twice (2024)", 766, [])];
  for (const g of groupsBoth(blink, blinkTm)) {
    assert.equal(g.get(12).key, "t:840705");
    assert.equal(g.get(12).members.length, 1);
    assert.equal(g.get(10).key, "n:blink|2024");
    assert.equal(g.get(11), g.get(10));
  }
  const avatar = { tmdb_id: 83533, tmdb_title: "Avatar: Fire and Ash", source: "tmdb", original_language: "en", year: "2025" };
  const av = [S(20, "Ash (2025)", 766, []), S(21, "Avatar: Fire and Ash (2025) (Hindi)", 766, [])];
  for (const g of groupsBoth(av, avatar)) {
    assert.equal(g.get(21).key, "t:83533");
    assert.equal(g.get(20).key, "n:ash|2025");
  }
});

test("title check: no TMDB title among them -> majority, ties stable (both orders)", () => {
  const tm = { tmdb_id: 9, tmdb_title: "Something Else", source: "tmdb", original_language: "en", year: "2025" };
  const maj = [S(1, "Ash (2025)", 766, []), S(2, "Avatar: Fire and Ash (2025)", 766, []), S(3, "Avatar: Fire and Ash (2025) (Hindi)", 766, [])];
  for (const g of groupsBoth(maj, tm)) {
    assert.equal(g.get(2).key, "t:9");
    assert.equal(g.get(3), g.get(2));
    assert.equal(g.get(1).key, "n:ash|2025");
  }
  const tie = [S(1, "Ash (2025)", 766, []), S(2, "Avatar: Fire and Ash (2025)", 766, [])];
  const [a, b] = groupsBoth(tie, tm);
  assert.equal(a.get(1).key, b.get(1).key);
  assert.equal(a.get(2).key, b.get(2).key);
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

test("detectLang: subtitle categories, bracket lists, non-language brackets", () => {
  assert.deepEqual(detectLang("X (2024)", "ENGLISH SUBTITLED"), { lang: null, source: null });
  assert.deepEqual(detectLang("X (2024)", "KOREAN SUBS"), { lang: null, source: null });
  assert.deepEqual(detectLang("X [2024, Remastered]", "MOVIES"), { lang: null, source: null });
  assert.deepEqual(detectLang("Fast X (2023)(Hindi, English)", null), { lang: "multi", source: "title" });
  assert.deepEqual(detectLang("Fast X (2023)[Tam, Tel, Hin, Eng)", null), { lang: "multi", source: "title" });
  assert.deepEqual(detectLang("Furiosa (2024) (Multi Languages)", null), { lang: "multi", source: "title" });
  assert.deepEqual(detectLang("Kingdom (2024) ( Tamil )", null), { lang: "ta", source: "title" });
  assert.deepEqual(detectLang("Spanish Affair (Ocho Apellidos)", null), { lang: null, source: null });
});

test("unmatched copy joins a TMDB group only when its title key has a year", () => {
  const tm = { tmdb_id: 77, source: "tmdb", original_language: "hi", year: "2020" };
  const streams = [S(1, "Show (Hindi)", 766, []), S(2, "Show (Tamil)", 768, [])];
  const o = opts({ 1: tm, 2: { source: "no-match" } });
  o.titleKeyOf = () => "show|";
  const { groupOf } = buildVariantIndex(streams, o);
  assert.equal(groupOf.get(1).key, "t:77");
  assert.equal(groupOf.get(2).key, "n:show|");
});

test("unknown copy: TMDB original language beats a region-default tag", () => {
  const telugu = { tmdb_id: 88, source: "tmdb", original_language: "te", year: "2026" };
  const streams = [S(1, "Pushpa 3 (2026)(4K)", 838, ["india", "hindi", "4k"])];
  const { groupOf } = buildVariantIndex(streams, opts({ 1: telugu }));
  const v = resolveGroup(groupOf.get(1), {}).variants[0];
  assert.equal(v.lang, null);
  assert.equal(v.langGuess, "te");
  // No TMDB language: fall back to the tag.
  const g2 = buildVariantIndex(streams, opts({ 1: { source: "no-match" } })).groupOf;
  assert.equal(resolveGroup(g2.get(1), {}).variants[0].langGuess, "hi");
});

test("same-language ties: more episodes, then the home canonical, then quality", () => {
  const tm = { tmdb_id: 5, source: "tmdb", original_language: "hi", year: "2023" };
  const streams = [S(1, "Show (2023) (Hindi) FHD", 766, []), S(2, "Show (2023) (Hindi)", 766, []), S(3, "Show (2023) (Hindi) HD", 766, [])];
  const base = opts({ 1: tm, 2: tm, 3: tm });
  base.titleKeyOf = () => "show|2023";
  assert.equal(resolveGroup(buildVariantIndex(streams, base).groupOf.get(1), {}).primary.id, 1);
  const canon = { ...base, isCanonical: (s) => s.id === 3 };
  assert.equal(resolveGroup(buildVariantIndex(streams, canon).groupOf.get(1), {}).primary.id, 3);
  const eps = { ...canon, episodeCountOf: (s) => (s.id === 2 ? 40 : 8) };
  assert.equal(resolveGroup(buildVariantIndex(streams, eps).groupOf.get(1), {}).primary.id, 2);
  // A definite-language copy still beats a canonical guessed one.
  const g = buildVariantIndex(STREAMS, { ...opts(), isCanonical: (s) => s.id === 796884 }).groupOf;
  assert.equal(resolveGroup(g.get(729968), {}).primary.id, 729968);
});

test("query language facet outranks the original language", () => {
  const { groupOf } = buildVariantIndex(STREAMS, opts());
  const r = resolveGroup(groupOf.get(729968), { firstLang: "ta" });
  assert.equal(r.primary.id, 787206);
});

// Route payload for GET /api/variants/:mode/:id (the handler only wires
// profile gates into this function).
test("variantsPayload: kids never see a non-kid-safe copy", () => {
  const streams = STREAMS.map((s) => (s.id === 729973 || s.id === 729974 ? { ...s, us_cert: "PG" } : s));
  const o = opts();
  const index = buildVariantIndex(streams, o);
  const kid = makeKidsBlocker({ id: "k", kidsBirthYear: new Date().getFullYear() - 9 });
  const byId = new Map(streams.map((s) => [s.id, s]));
  const blocked = variantsPayload({ mode: "movie", s: byId.get(729968), index, opts: o, isKidBlocked: kid });
  assert.deepEqual(blocked.variants, []);
  assert.equal(blocked.variantCount, 0);
  assert.equal(blocked.tmdb_id, null);
  assert.equal(blocked.primaryId, null);
  const ok = variantsPayload({ mode: "movie", s: byId.get(729973), index, opts: o, isKidBlocked: kid });
  assert.deepEqual(ok.variants.map((v) => v.id).sort(), [729973, 729974]);
  assert.equal(ok.tmdb_id, 1582770);
  const adult = variantsPayload({ mode: "movie", s: byId.get(729973), index, opts: o });
  assert.equal(adult.variantCount, 9);
  assert.equal(adult.primaryId, 729968);
  assert.equal(adult.originalLanguage, "hi");
});

test("variantsPayload: language chips and the title guard; requested copy always listed", () => {
  const o = opts();
  const index = buildVariantIndex(STREAMS, o);
  const byId = new Map(STREAMS.map((s) => [s.id, s]));
  const hiEn = { profileLangs: new Set(["hi", "en"]), preferLangs: ["hi", "en"] };
  const guard = (name) => !/\b(tamil|telugu|malayalam|kannada)\b/i.test(name);
  const p = variantsPayload({ mode: "movie", s: byId.get(787206), index, opts: o, titleLangPasses: guard, ctx: hiEn });
  assert.deepEqual(p.variants.map((v) => v.id), [729968, 796884, 787206]);
  assert.equal(p.variants.filter((v) => v.isPrimary).length, 1);
  const q = variantsPayload({ mode: "movie", s: byId.get(729973), index, opts: o, titleLangPasses: guard, ctx: hiEn });
  assert.deepEqual(q.variants.map((v) => v.id), [729968, 796884, 729973]);
  // Not built yet: the copy alone.
  const solo = variantsPayload({ mode: "movie", s: byId.get(729973), index: null, opts: o });
  assert.deepEqual(solo.variants.map((v) => v.id), [729973]);
});

test("title check: subtitle form of the TMDB title stays when the year matches (both orders)", () => {
  const stree = { tmdb_id: 835113, tmdb_title: "Stree 2: Sarkate Ka Aatank", source: "tmdb", original_language: "hi", year: "2024" };
  const list = [
    S(1, "Stree 2 (2024) (Hindi)", 766, []), S(2, "Stree 2 (2024) (4K)", 838, ["4k"]),
    S(3, "Stree 2 (2024) (Tamil)", 768, []), S(4, "Stree 2: Sarkate Ka Aatank (2024)", 766, []),
  ];
  for (const g of groupsBoth(list, stree)) {
    assert.equal(g.get(4).key, "t:835113");
    for (const id of [1, 2, 3]) assert.equal(g.get(id), g.get(4), String(id));
  }
  // Reverse: TMDB has the short title, one panel copy carries the subtitle.
  const short = { ...stree, tmdb_title: "Stree 2" };
  const rev = [S(1, "Stree 2 (2024) (Hindi)", 766, []), S(4, "Stree 2: Sarkate Ka Aatank (2024)", 766, [])];
  for (const g of groupsBoth(rev, short)) assert.equal(g.get(4), g.get(1));
  // One year off is NOT the same film: Dhurandhar (2025) vs The Revenge (2026).
  const revenge = { tmdb_id: 1582770, tmdb_title: "Dhurandhar: The Revenge", source: "tmdb", original_language: "hi", year: "2026" };
  const d = [S(1, "Dhurandhar (2025) (Hindi)", 599, []), S(4, "Dhurandhar: The Revenge (2026) (Hindi)", 766, [])];
  for (const g of groupsBoth(d, revenge)) {
    assert.equal(g.get(4).key, "t:1582770");
    assert.equal(g.get(1).key, "n:dhurandhar|2025");
  }
  // Same year, but "Dhurandhar" is the head of the TMDB title: stays.
  const d2 = [S(1, "Dhurandhar (2026) (Hindi)", 599, []), S(4, "Dhurandhar: The Revenge (2026) (Hindi)", 766, [])];
  for (const g of groupsBoth(d2, revenge)) assert.equal(g.get(1), g.get(4));
});

test("a copy the profile already started wins inside the top language bucket", () => {
  const { groupOf } = buildVariantIndex(STREAMS, opts());
  const g = groupOf.get(729968);
  assert.equal(resolveGroup(g, {}).primary.id, 729968);
  assert.equal(resolveGroup(g, { startedIds: new Set(["796884"]) }).primary.id, 796884);
  // ...but not across languages: a started Tamil copy does not beat Hindi.
  assert.equal(resolveGroup(g, { startedIds: new Set(["787206"]) }).primary.id, 729968);
  // A started CAM copy is still the primary.
  const cam = [S(1, "Film (2026) (Hindi) (CAM)", 900, ["cam"]), S(2, "Film (2026) (Hindi)", 766, [])];
  const o = opts({ 1: TMDB[1582770], 2: TMDB[1582770] });
  const cg = buildVariantIndex(cam, o).groupOf;
  assert.equal(resolveGroup(cg.get(1), {}).primary.id, 2);
  assert.equal(resolveGroup(cg.get(1), { startedIds: new Set(["1"]) }).primary.id, 1);
});

test("variant index cache: never builds in the request or on a filling index", () => {
  let builds = 0, gen = 1, t = 0;
  const queue = [];
  const cache = createVariantIndexCache({
    build: () => { builds++; return { vix: { groups: new Map(), groupOf: new Map() }, opts: {} }; },
    getGen: () => gen, schedule: (fn) => queue.push(fn), now: () => t, minRebuildMs: 1000,
  });
  const ix = { ready: false, byId: new Map([[1, { id: 1 }]]) };
  assert.equal(cache.get("movie", ix), null); // filling: nothing, nothing scheduled
  assert.equal(queue.length, 0);
  ix.ready = true;
  assert.equal(cache.get("movie", ix), null); // cold: null now, build scheduled
  assert.equal(builds, 0);
  assert.equal(cache.get("movie", ix), null);
  assert.equal(queue.length, 1); // deduped
  queue.shift()();
  assert.equal(builds, 1);
  const e = cache.get("movie", ix);
  assert.ok(e && e.vix);
  gen = 2; // stale: keeps serving; rebuild only after minRebuildMs
  assert.equal(cache.get("movie", ix), e);
  assert.equal(queue.length, 0);
  t = 1000;
  assert.equal(cache.get("movie", ix), e);
  assert.equal(queue.length, 1);
  ix.ready = false; // index refilling before the scheduled build runs: skipped
  queue.shift()();
  assert.equal(builds, 1);
  assert.equal(cache.get("movie", ix), e); // still the old build while filling
  assert.equal(cache.get("live", ix), null);
  const fresh = { ready: true, byId: new Map([[2, { id: 2 }]]) }; // new Map = new index
  assert.equal(cache.get("series", fresh), null);
});

// Dil Se (TMDB 21210, 1998): the bare "Dil Se" in a HINDI DUBBED category was
// matched by title only and is a different film.
const DILSE_CATS = { 33: "INDIAN | GENERAL", 151: "HINDI | OLD MOVIES", 223: "MYANMAR | MOVIES", 93: "SOUTH INDIAN | HINDI DUBBED" };
function dilSe(list, extra = {}) {
  const tm = { tmdb_id: 21210, tmdb_title: "Dil Se..", source: "tmdb", original_language: "hi", year: "1998", ...extra };
  const o = opts(Object.fromEntries(list.map((x) => [x.id, tm])));
  // Like dedupTitleKey: language/quality parens stripped, year kept.
  o.titleKeyOf = (s) => plainKey({ name: s.name.replace(/\((?!\d{4}\))[^)]*\)/g, " ") });
  o.normTitle = plainNorm; o.mode = "movie";
  o.catNameOf = (s) => DILSE_CATS[s.category_id] || CATS[s.category_id] || null;
  return buildVariantIndex(list, o).groupOf;
}
test("Dil Se: the undated dubbed copy splits off; the dated copies stay (both orders)", () => {
  const list = [
    S(72547, "Dil Se.. (1998)", 33, ["india", "hindi"]), S(24805, "Dil Se.. (1998)", 151, ["hindi"]),
    S(42441, "Dil Se.. (1998)", 223, []), S(54241, "Dil Se", 93, ["hindi"]),
  ];
  for (const order of [list, list.slice().reverse()]) {
    const g = dilSe(order);
    assert.equal(g.get(72547).key, "t:21210");
    assert.equal(g.get(24805), g.get(72547));
    assert.equal(g.get(42441), g.get(72547));
    assert.notEqual(g.get(54241), g.get(72547));
    assert.equal(g.get(54241).members.length, 1);
    const r = resolveGroup(g.get(72547), {});
    assert.deepEqual(r.variants.map((v) => v.id).sort(), [24805, 42441, 72547]);
    assert.equal(r.variants.find((v) => v.id === 42441).langName, "Burmese");
  }
});
test("year rules: exact year stays, one off needs the same title, undated needs the narrow exception", () => {
  // One year off, same title text as an exact-year copy: stays.
  let g = dilSe([S(1, "Dil Se.. (1998)", 151, []), S(2, "Dil Se.. (1999) (Tamil)", 151, [])]);
  assert.equal(g.get(2), g.get(1));
  // One year off with a different title: splits.
  g = dilSe([S(1, "Dil Se.. (1998)", 151, []), S(2, "Dil Se Dil Tak (1999)", 151, [])], {});
  assert.notEqual(g.get(2), g.get(1));
  // Undated, exact TMDB title, "(Hindi)" tag, not dubbed, one dated copy: joins.
  g = dilSe([S(1, "Dil Se.. (1998)", 151, []), S(2, "Dil Se.. (Hindi)", 151, [])]);
  assert.equal(g.get(2), g.get(1));
  // Same but in a dubbed category, or with two dated copies: stays alone.
  g = dilSe([S(1, "Dil Se.. (1998)", 151, []), S(2, "Dil Se.. (Hindi)", 93, [])]);
  assert.notEqual(g.get(2), g.get(1));
  g = dilSe([S(1, "Dil Se.. (1998)", 151, []), S(3, "Dil Se.. (1998)", 33, []), S(2, "Dil Se.. (Hindi)", 151, [])]);
  assert.notEqual(g.get(2), g.get(1));
  // No language tag: alone.
  g = dilSe([S(1, "Dil Se.. (1998)", 151, []), S(2, "Dil Se..", 151, [])]);
  assert.notEqual(g.get(2), g.get(1));
  // Series-style: no copy carries a year -> all group as before.
  const tm = { tmdb_id: 9, tmdb_title: "Citadel", source: "tmdb", original_language: "en", year: "2023" };
  const ser = [S(1, "Citadel", 108, []), S(2, "Citadel (Hindi)", 108, []), S(3, "Citadel (Tamil)", 108, [])];
  const o = opts(Object.fromEntries(ser.map((x) => [x.id, tm]))); o.titleKeyOf = (s) => plainKey({ name: s.name.replace(/\([^)]*\)/g, " ") }); o.normTitle = plainNorm; o.mode = "series";
  const sg = buildVariantIndex(ser, o).groupOf;
  assert.equal(sg.get(2), sg.get(1)); assert.equal(sg.get(3), sg.get(1));
});

test("year rules: consistent off-by-one panel year, repeated year, undated-dubbed-only groups", () => {
  // Every copy says 2024, TMDB says 2025: the copies' own year is the reference.
  let g = dilSe([S(1, "Trouble (2024)", 151, []), S(2, "Trouble (2024) (Hindi)", 93, []), S(3, "Trouble (2024) (Tamil)", 768, [])],
    { tmdb_title: "Strul", year: "2025" });
  assert.equal(g.get(1).key, "t:21210");
  assert.equal(g.get(2), g.get(1)); assert.equal(g.get(3), g.get(1));
  // Two dated copies of the same year (datedOk.size 2): a bare "(Hindi)" copy stays alone.
  g = dilSe([S(1, "Dil Se.. (1998)", 151, []), S(2, "Dil Se.. (1998)", 33, []), S(3, "Dil Se.. (Hindi)", 151, [])]);
  assert.equal(g.get(2), g.get(1));
  assert.notEqual(g.get(3), g.get(1));
  // Only undated copies, all in dubbed categories: keep the TMDB link together.
  g = dilSe([S(1, "Dil Se", 93, []), S(2, "Dil Se (Tamil)", 93, [])]);
  assert.equal(g.get(1).key, "t:21210");
  assert.equal(g.get(2), g.get(1));
  assert.equal(g.get(1).origLang, "hi");
  // Undated: a dubbed copy next to a non-dubbed one splits off.
  g = dilSe([S(1, "Dil Se", 151, []), S(2, "Dil Se", 93, [])]);
  assert.equal(g.get(1).key, "t:21210");
  assert.notEqual(g.get(2), g.get(1));
});
