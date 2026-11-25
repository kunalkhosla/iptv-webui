const test = require("node:test");
const assert = require("node:assert/strict");
const { pickLogo, logoUrl, logoBackfillCandidates, applyLogo } = require("../lib/title-logos");

const L = (file_path, iso_639_1, vote_average, width) => ({ file_path, iso_639_1, vote_average, width, height: 100 });

test("english beats null-language beats others", () => {
  const imgs = { logos: [L("/de.png", "de", 9, 900), L("/nul.png", null, 8, 800), L("/en.png", "en", 1, 400)] };
  assert.equal(pickLogo(imgs), "/en.png");
  assert.equal(pickLogo({ logos: [L("/de.png", "de", 9, 900), L("/nul.png", null, 1, 400)] }), "/nul.png");
  assert.equal(pickLogo({ logos: [L("/de.png", "de", 9, 900)] }), null);
});
test("within language: vote_average then width; narrow and non-png skipped", () => {
  const logos = [L("/a.png", "en", 5, 300), L("/b.png", "en", 5.5, 200), L("/c.png", "en", 5.5, 500),
    L("/tiny.png", "en", 10, 100), L("/x.svg", "en", 10, 900)];
  assert.equal(pickLogo({ logos }), "/c.png");
  assert.equal(pickLogo(logos), "/c.png");
});
test("empty / junk input", () => {
  for (const v of [null, undefined, {}, { logos: [] }, { logos: [null, {}] }, []]) assert.equal(pickLogo(v), null);
});
test("logoUrl", () => {
  assert.equal(logoUrl("/abc.png"), "https://image.tmdb.org/t/p/w500/abc.png");
  for (const v of [null, "", "abc.png", "/../x.png", "/a.svg", 5]) assert.equal(logoUrl(v), null);
});
test("backfill candidates: unresolved only, dedup by tmdb id, cap", () => {
  const entries = [
    ["movie:1", { source: "tmdb", tmdb_id: 10 }],
    ["movie:2", { source: "tmdb", tmdb_id: 10 }],
    ["movie:3", { source: "tmdb", tmdb_id: 11, logo: null }],
    ["movie:4", { source: "tmdb", tmdb_id: 12, logo: "/x.png" }],
    ["series:5", { source: "tmdb", tmdb_id: 10 }],
    ["live:6", { source: "tmdb", tmdb_id: 13 }],
    ["movie:7", { source: "none" }],
    ["movie:8", null],
  ];
  const c = logoBackfillCandidates({ entries });
  assert.deepEqual(c.map((x) => `${x.kind}:${x.tmdbId}:${x.keys.join("+")}`), ["movie:10:movie:1+movie:2", "series:10:series:5"]);
  assert.equal(logoBackfillCandidates({ entries, max: 1 }).length, 1);
});
test("applyLogo stores only the path string (null when none)", () => {
  const e = {};
  applyLogo(e, { images: { logos: [L("/en.png", "en", 1, 300)] } });
  assert.equal(e.logo, "/en.png");
  applyLogo(e, { images: { logos: [] } });
  assert.equal(e.logo, null);
  assert.ok(!("logos" in e));
});
