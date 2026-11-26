const test = require("node:test");
const assert = require("node:assert");
const { displayTitle, pickOverview, repeatedTexts, episodeExtras, seasonExtras, needsLangFallback } = require("../lib/episode-info");

const LONG_A = "A forensic officer goes into personal turmoil after the murder.";
const LONG_B = "The mayor of Satara city gets murdered and the case reopens.";

test("pickOverview prefers TMDB when the panel plot is empty or short", () => {
  assert.deepStrictEqual(pickOverview([{ text: LONG_A, source: "tmdb" }, { text: "", source: "panel" }]), { text: LONG_A, source: "tmdb" });
  assert.strictEqual(pickOverview([{ text: null, source: "tmdb" }, { text: "Ep 3", source: "panel" }, { text: LONG_B, source: "tmdb_alt" }]).text, LONG_B);
  assert.strictEqual(pickOverview([{ text: null, source: "tmdb" }, { text: "Ep 3", source: "panel" }]).text, "Ep 3");
  assert.strictEqual(pickOverview([{ text: "Ep 3", source: "panel" }, { text: LONG_B, source: "tmdb" }]).text, LONG_B);
});

test("pickOverview skips a text repeated across the season", () => {
  const repeats = { tmdb: repeatedTexts([LONG_A, LONG_A, LONG_B]), panel: repeatedTexts([LONG_B]) };
  assert.strictEqual(pickOverview([{ text: LONG_A, source: "tmdb" }, { text: LONG_B, source: "panel" }], repeats).text, LONG_B);
  // Nothing better: the repeated text still beats nothing.
  assert.strictEqual(pickOverview([{ text: LONG_A, source: "tmdb" }, { text: "", source: "panel" }], repeats).text, LONG_A);
  assert.strictEqual(pickOverview([{ text: "  ", source: "tmdb" }]), null);
});

test("repeatedTexts ignores case/whitespace and empties", () => {
  const r = repeatedTexts(["Same  text", "same text", "", null, "other"]);
  assert.deepStrictEqual([...r], ["same text"]);
});

test("episodeExtras projects runtime, rating, crew, top-3 guests", () => {
  const e = episodeExtras({
    runtime: 52, vote_average: 7.86, vote_count: 12, still_path: "/s.jpg",
    crew: [{ job: "Director", name: "D1" }, { job: "Writer", name: "W1" }, { job: "Teleplay", name: "W2" }, { job: "Writer", name: "W1" }, { job: "Editor", name: "X" }],
    guest_stars: [
      { name: "G4", order: 4 }, { name: "G1", character: "Cop", order: 0, profile_path: "/p.jpg" },
      { name: "G2", order: 1 }, { name: "G3", order: 2 },
    ],
  });
  assert.deepStrictEqual(e, {
    runtime_mins: 52, rating: 7.9, still_large: "https://image.tmdb.org/t/p/w780/s.jpg",
    directors: ["D1"], writers: ["W1", "W2"],
    guest_stars: [
      { name: "G1", character: "Cop", profile: "https://image.tmdb.org/t/p/w185/p.jpg" },
      { name: "G2", character: null, profile: null },
      { name: "G3", character: null, profile: null },
    ],
  });
});

test("episodeExtras omits thin ratings and empty values", () => {
  assert.deepStrictEqual(episodeExtras({ runtime: 0, vote_average: 9, vote_count: 1, crew: [], guest_stars: [] }), {});
  assert.deepStrictEqual(episodeExtras(null), {});
});

test("seasonExtras uses the fallback-language overview when the default is empty", () => {
  assert.deepStrictEqual(
    seasonExtras({ name: "Season 1", overview: "", poster_path: "/x.jpg", air_date: "2020-01-02" }, { overview: "Hindi overview" }),
    { name: "Season 1", overview: "Hindi overview", poster: "https://image.tmdb.org/t/p/w342/x.jpg", air_date: "2020-01-02" },
  );
  assert.deepStrictEqual(seasonExtras(null), {});
});

test("needsLangFallback only for household-readable languages with gaps", () => {
  const gap = { overview: "x", episodes: [{ overview: "a" }, { overview: "" }] };
  const full = { overview: "x", episodes: [{ overview: "a" }] };
  assert.strictEqual(needsLangFallback(gap, "hi"), true);
  assert.strictEqual(needsLangFallback(gap, "ko"), false);
  assert.strictEqual(needsLangFallback(full, "hi"), false);
  assert.strictEqual(needsLangFallback({ overview: "", episodes: [] }, "pa"), true);
  assert.strictEqual(needsLangFallback(null, "hi"), false);
});

test("displayTitle: TMDB name, else the panel title without its series/SxxEyy prefix", () => {
  assert.strictEqual(displayTitle("Breaking Bad (English) - S01E01 - Pilot", "Pilot"), "Pilot");
  assert.strictEqual(displayTitle("Breaking Bad (English) - S01E01 - Pilot", "Episode 1"), "Pilot");
  assert.strictEqual(displayTitle("Fauda S05E02 Chapter Two", null), "Chapter Two");
  assert.strictEqual(displayTitle("Show - S01E03", "Episode 3"), null);
  assert.strictEqual(displayTitle("Plain Title", null), null);
  assert.strictEqual(displayTitle("", "  "), null);
});
