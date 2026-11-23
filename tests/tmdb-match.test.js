const test = require("node:test");
const assert = require("node:assert/strict");
const { matchPlausible, parseStreamName, hasOverlap, looksLikeLiveEvent } = require("../lib/tmdb-match");

// Exact reason strings are asserted so a heuristic change shows up as a diff here.
const EXPECTED_REASONS = {
  "Hissa (2026) (Punjabi)|Dune: Part Three": "zero-overlap, punjabi stream vs original_language en",
  "Agra (2023) (Hindi)|Divididos en Vélez - Agradecer y Seguir": "zero-overlap, festival/concert-style tmdb title",
  "Freedom (2024)|Hardwell @ Ultra Miami 2024": "zero-overlap, festival/concert-style tmdb title",
  "Maria (2024)|Tomorrowland Festival - Live Set": "zero-overlap, festival/concert-style tmdb title",
  "Vaasta (2021)|Connection": "zero-overlap, hindi stream vs original_language en",
  "The Bad Boy and Me  (2025) (Tamil)|Sidelined 2: Intercepted": "zero-overlap, tamil stream vs original_language en",
  "Kho Kho (2012)|Les Misérables": "zero-overlap, telugu stream vs original_language en",
  "Talismi Jazeera (1992) (Urdu)|Zorro the Gay Blade": "zero-overlap, year 1992 vs 1981",
  "Berlin (2023)|Brandt Brauer Frick @ Berlinale 2023": "zero-overlap, festival/concert-style tmdb title",
  "Neha (2021) Telugu|Never Rarely Sometimes Always": "zero-overlap, telugu stream vs original_language en",
  "Some Film (2010)|Totally Different": "zero-overlap, year 2010 vs 2015",
  "Mystery (2020) (Punjabi)|Unrelated Hollywood": "zero-overlap, punjabi stream vs original_language en",
  "Culpa Mia (2023)(4K)|My Fault": "zero-overlap, no language tag",
  "Madres (2021)|Parallel Mothers": "zero-overlap, no language tag",
  "Dhurandhar (2025) (Hindi)|Dhurandhar": "overlap",
  "Aithrí (2018)|Penance": "zero-overlap, lenient language",
  "Tre uomini e un fantasma (2022) (Hindi)|Three Man And A Ghost": "zero-overlap, foreign original language",
  "Man Hua Xiong Xin (2021) (Hindi)|Comic Ambition": "zero-overlap, foreign original language",
  "Nieobliczalna (2024) (Hindi) (CAM)|Unpredictable": "zero-overlap, foreign original language",
  "Putulnacher Itikatha (2025) (Bangla)|The Puppet’s Tale": "zero-overlap, language consistent",
  "Navarathri (1964)|Navarathiri": "similar",
  "Baahubali (2017)|Bāhubali 2: The Conclusion": "zero-overlap, indic cross-language",
  "Tegimpu (2023)|Thunivu": "zero-overlap, indic cross-language",
  "Um Ano Inesquecivel Primavera (2023)(4K)|An Unforgettable Year - Spring": "zero-overlap, lenient language",
  "La Ermita (2023) (Telugu)|The Chapel": "zero-overlap, foreign original language",
  "Acide (2023)|Acid": "zero-overlap, no language tag",
  "Cici Anne (2024) (Turkish)|Step Mom": "zero-overlap, language consistent",
  "Aranyer Din Ratri (1970)|Days and Nights in the Forest": "zero-overlap, language consistent",
  "Dune Part Two (2024)|Dune: Part Two": "overlap",
  "Wonder Woman 1984 (2020)(4K)|Wonder Woman 1984": "overlap",
  "Spiderman (2002)|Spider-Man": "overlap",
  "MY3 (2023) (Tamil)|My 3": "overlap",
  "The.Gift.2015.1080p|The Gift": "overlap",
  "Amélie (2001)|Amelie": "overlap",
  "Fast & Furious (2009)|Fast and Furious": "overlap",
  "Toy Stories (1995)|Toy Story": "overlap",
  "1917 (2019)|1917": "overlap",
  "Avatar (2009) (Hindi)|Avatar": "overlap",
  "The Expendables 4 (2023) (Tamil)|Expend4bles": "similar",
  "Se7en (1995)|Seven": "similar",
  "Bahubali (2015)|Baahubali": "similar",
  "Fast Four (2009) (Hindi)|Fast 4": "overlap",
  "Star Wars Episode IV (1977) (Hindi)|A New Hope": "zero-overlap, hindi stream vs original_language en",
  "Raju (1978)|We Will All Meet in Paradise": "zero-overlap, foreign original language",
  "Kasa Kasa (2021)|Paydirt": "zero-overlap, no language tag",
  "Gem (2024) (Telugu)|GEMNIBUS Volume 1": "zero-overlap, foreign original language",
  "Rocky (1976)|": "no-tmdb-title"
};
const mp = (streamName, tmdb, extra = {}) => matchPlausible({ streamName, tmdb, ...extra });

// [stream name, lang tag, tmdb {title, original_language, year}, expected ok]
const CASES = [
  // --- the reported wrong ones ---
  ["Hissa (2026) (Punjabi)", "punjabi", { title: "Dune: Part Three", original_language: "en", year: "2026" }, false],
  ["Agra (2023) (Hindi)", "hindi", { title: "Divididos en Vélez - Agradecer y Seguir", original_language: "es", year: "2023" }, false],
  ["Freedom (2024)", null, { title: "Hardwell @ Ultra Miami 2024", original_language: "en", year: "2024" }, false],
  ["Maria (2024)", null, { title: "Tomorrowland Festival - Live Set", original_language: "en", year: "2024" }, false],
  ["Vaasta (2021)", "hindi", { title: "Connection", original_language: "en", year: "2021" }, false],
  ["The Bad Boy and Me  (2025) (Tamil)", "tamil", { title: "Sidelined 2: Intercepted", original_language: "en", year: "2025" }, false],
  ["Kho Kho (2012)", "telugu", { title: "Les Misérables", original_language: "en", year: "2012" }, false],
  ["Talismi Jazeera (1992) (Urdu)", "urdu", { title: "Zorro the Gay Blade", original_language: "en", year: "1981" }, false],
  ["Berlin (2023)", "hindi", { title: "Brandt Brauer Frick @ Berlinale 2023", original_language: "en", year: "2023" }, false],
  ["Neha (2021) Telugu", "telugu", { title: "Never Rarely Sometimes Always", original_language: "en", year: "2020" }, false],
  ["Some Film (2010)", null, { title: "Totally Different", original_language: "en", year: "2015" }, false], // year gap >= 2, zero overlap
  ["Mystery (2020) (Punjabi)", "pa", { title: "Unrelated Hollywood", original_language: "en", year: "2020" }, false], // ISO tag
  // --- legit localized titles ---
  ["Culpa Mia (2023)(4K)", null, { title: "My Fault", original_language: "es", year: "2023" }, true],
  ["Madres (2021)", null, { title: "Parallel Mothers", original_language: "es", year: "2021" }, true],
  ["Dhurandhar (2025) (Hindi)", "hindi", { title: "Dhurandhar", original_language: "hi", year: "2025" }, true],
  ["Aithrí (2018)", "english", { title: "Penance", original_language: "ga", year: "2018" }, true],
  ["Tre uomini e un fantasma (2022) (Hindi)", "english", { title: "Three Man And A Ghost", original_language: "it", year: "2022" }, true],
  ["Man Hua Xiong Xin (2021) (Hindi)", "hindi", { title: "Comic Ambition", original_language: "zh", year: "2021" }, true],
  ["Nieobliczalna (2024) (Hindi) (CAM)", "hindi", { title: "Unpredictable", original_language: "pl", year: "2024" }, true],
  ["Putulnacher Itikatha (2025) (Bangla)", "bengali", { title: "The Puppet’s Tale", original_language: "bn", year: "2025" }, true],
  ["Navarathri (1964)", "tamil", { title: "Navarathiri", original_language: "ta", year: "1964" }, true],
  ["Baahubali (2017)", "tamil", { title: "Bāhubali 2: The Conclusion", original_language: "te", year: "2017" }, true],
  ["Tegimpu (2023)", "telugu", { title: "Thunivu", original_language: "ta", year: "2023" }, true], // indic cross-language
  ["Um Ano Inesquecivel Primavera (2023)(4K)", "english", { title: "An Unforgettable Year - Spring", original_language: "pt", year: "2023" }, true],
  ["La Ermita (2023) (Telugu)", "telugu", { title: "The Chapel", original_language: "es", year: "2023" }, true],
  ["Acide (2023)", null, { title: "Acid", original_language: "fr", year: "2023" }, true],
  ["Cici Anne (2024) (Turkish)", "turkish", { title: "Step Mom", original_language: "tr", year: "2024" }, true],
  ["Aranyer Din Ratri (1970)", "bengali", { title: "Days and Nights in the Forest", original_language: "bn", year: "1970" }, true],
  // --- overlap / normalization ---
  ["Dune Part Two (2024)", null, { title: "Dune: Part Two", original_language: "en", year: "2024" }, true],
  ["Wonder Woman 1984 (2020)(4K)", null, { title: "Wonder Woman 1984", original_language: "en", year: "2020" }, true],
  ["Spiderman (2002)", null, { title: "Spider-Man", original_language: "en", year: "2002" }, true],
  ["MY3 (2023) (Tamil)", "tamil", { title: "My 3", original_language: "en", year: "2023" }, true],
  ["The.Gift.2015.1080p", null, { title: "The Gift", original_language: "en", year: "2015" }, true],
  ["Amélie (2001)", null, { title: "Amelie", original_language: "fr", year: "2001" }, true],
  ["Fast & Furious (2009)", null, { title: "Fast and Furious", original_language: "en", year: "2009" }, true],
  ["Toy Stories (1995)", null, { title: "Toy Story", original_language: "en", year: "1995" }, true],
  ["1917 (2019)", null, { title: "1917", original_language: "en", year: "2019" }, true],
  ["Avatar (2009) (Hindi)", "hindi", { title: "Avatar", original_language: "en", year: "2009" }, true],
  // --- fuzzy accept path (compacted / leetspeak / numerals / trigram Dice) ---
  ["The Expendables 4 (2023) (Tamil)", "tamil", { title: "Expend4bles", original_language: "en", year: "2023" }, true],
  ["Se7en (1995)", "english", { title: "Seven", original_language: "en", year: "1995" }, true],
  ["Bahubali (2015)", "telugu", { title: "Baahubali", original_language: "te", year: "2015" }, true],
  ["Fast Four (2009) (Hindi)", "hindi", { title: "Fast 4", original_language: "en", year: "2009" }, true],
  // documented limitation: a subtitle-only title ("A New Hope") shares nothing with
  // "Star Wars Episode IV"; with a regional tag + original_language en it is rejected.
  ["Star Wars Episode IV (1977) (Hindi)", "hindi", { title: "A New Hope", original_language: "en", year: "1977" }, false],
  ["Hissa (2026) (Punjabi)", "punjabi", { title: "Dune: Part Three", original_language: "en", year: "2026", genres: ["Science Fiction"] }, false],
  // --- conservative: no signal => ok ---
  ["Raju (1978)", "punjabi", { title: "We Will All Meet in Paradise", original_language: "fr", year: "1978" }, true],
  ["Kasa Kasa (2021)", null, { title: "Paydirt", original_language: "en", year: "2021" }, true], // no lang tag
  ["Gem (2024) (Telugu)", "telugu", { title: "GEMNIBUS Volume 1", original_language: "ja", year: "2024" }, true],
  ["Rocky (1976)", null, { title: "", original_language: "en", year: "1976" }, true],
];

for (const [name, tag, tmdb, expected] of CASES) {
  test(`${name} -> ${tmdb.title || "(empty)"} => ${expected ? "ok" : "NOT ok"}`, () => {
    const r = mp(name, tmdb, { streamLangTag: tag });
    assert.equal(r.ok, expected, r.reason);
    assert.equal(r.reason, EXPECTED_REASONS[`${name}|${tmdb.title}`], "reason");
  });
}

test("alternative titles count as overlap", () => {
  assert.equal(mp("Hissa (2026) (Punjabi)", { title: "Dune: Part Three", original_language: "en", year: "2026", alternative_titles: ["Hissa"] }).ok, true);
});
test("original_title counts as overlap", () => {
  assert.equal(mp("Sen to Chihiro (2001)", { title: "Spirited Away", original_title: "千と千尋の神隠し", alternative_titles: ["Sen to Chihiro no Kamikakushi"], original_language: "ja", year: "2001" }).ok, true);
});
test("missing tmdb -> ok", () => {
  assert.equal(matchPlausible({ streamName: "X (2020)" }).ok, true);
});
test("empty stream name -> ok", () => {
  assert.equal(matchPlausible({ streamName: "", tmdb: { title: "Anything" } }).ok, true);
});
test("explicit streamYear param is honored", () => {
  const t = { title: "Unrelated", original_language: "en", year: "2010" };
  assert.equal(mp("Zzzz", t, { streamYear: 2020 }).ok, false);
  assert.equal(mp("Zzzz", t, { streamYear: 2011 }).ok, true);
});
test("viaPanelId with no language signal stays ok (conservative)", () => {
  const r = mp("Zzzz (2020)", { title: "Unrelated", original_language: "en", year: "2020" }, { viaPanelId: true });
  assert.equal(r.ok, true);
});
test("name-embedded language tag beats panel bucket tag", () => {
  // bucket says english, name says (Hindi): Hindi vs 'en' + zero overlap => not ok
  assert.equal(mp("Qqqq (2020) (Hindi)", { title: "Wwww", original_language: "en", year: "2020" }, { streamLangTag: "english" }).ok, false);
});
test("english-bucket stream with foreign original is ok", () => {
  assert.equal(mp("Qqqq (2020)", { title: "Wwww", original_language: "sv", year: "2020" }, { streamLangTag: "english" }).ok, true);
});
test("festival-style tmdb title with a stream that is itself live-event style is ok", () => {
  assert.equal(mp("Tomorrowland Live at Boom (2019)", { title: "Qqq @ Zzz Festival", original_language: "en", year: "2019" }).ok, true);
});

test("parseStreamName strips year, quality and language tags", () => {
  const p = parseStreamName("Culpa Mia (2023)(4K)");
  assert.equal(p.title, "Culpa Mia");
  assert.equal(p.year, 2023);
  const q = parseStreamName("Hissa (2026) (Punjabi)");
  assert.equal(q.lang, "punjabi");
  assert.equal(q.title, "Hissa");
  assert.equal(parseStreamName("Nieobliczalna (2024) (Hindi) (CAM)").title, "Nieobliczalna");
});
test("hasOverlap never matches substrings", () => {
  assert.equal(hasOverlap("Agra", ["Divididos en Vélez - Agradecer y Seguir"]), false);
  assert.equal(hasOverlap("Spiderman", ["Spider-Man"]), true);
});
test("looksLikeLiveEvent", () => {
  assert.equal(looksLikeLiveEvent("Hardwell @ Freedom Festival"), true);
  assert.equal(looksLikeLiveEvent("Dune: Part Three"), false);
  assert.equal(looksLikeLiveEvent("A - B"), false);
  assert.equal(looksLikeLiveEvent("A - B", true), true);
});
