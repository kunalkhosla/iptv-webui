const test = require("node:test");
const assert = require("node:assert/strict");
const { createGuardedTmdbCache, normalizeOverrides, markGuardRejected } = require("../lib/tmdb-guard-view");
const { matchPlausible } = require("../lib/tmdb-match");

function setup({ overrides = {}, streams } = {}) {
  const store = {
    "movie:825105": { source: "tmdb", tmdb_id: 1170608, tmdb_title: "Dune: Part Three", original_language: "en", year: "2026", us_cert: "R" },
    "movie:1": { source: "tmdb", tmdb_id: 5, tmdb_title: "My Fault", original_language: "es", year: "2023" },
    "movie:2": { source: "no-match", tmdb_id: null, checked_at: 5 },
  };
  const info = streams || {
    "movie:825105": { name: "Hissa (2026) (Punjabi)", year: null, tags: ["punjabi"] },
    "movie:1": { name: "Culpa Mia (2023)", year: null, tags: ["english"] },
  };
  let judged = 0;
  const g = createGuardedTmdbCache({
    store, overrides, getInfo: (k) => info[k] || null, now: () => 1000,
    judge: (mode, i, e) => { judged++; return matchPlausible({ streamName: i.name, streamLangTag: i.tags[0], streamYear: i.year, tmdb: { title: e.tmdb_title, original_language: e.original_language, year: e.year } }); },
  });
  return { store, info, g, judged: () => judged, overrides };
}

test("implausible entry reads as no-match with checked_at 0; plausible entry untouched", () => {
  const { g, store } = setup();
  const v = g.cache["movie:825105"];
  assert.equal(v.source, "no-match");
  assert.equal(v.tmdb_id, null);
  assert.equal(v.checked_at, 0);
  assert.equal(v.implausible, true);
  assert.equal(g.cache["movie:1"], store["movie:1"]);
  assert.equal(g.cache["movie:2"], store["movie:2"]);
  assert.equal(g.cache["movie:missing"], undefined);
});

test("serializing the raw store never contains placeholders", () => {
  const { g, store } = setup();
  void g.cache["movie:825105"]; // force a synthesized view
  Object.entries(g.cache); // iterate through the view too
  const json = JSON.stringify(store);
  assert.ok(!json.includes("implausible"));
  assert.ok(!json.includes("override_pending"));
  assert.equal(store["movie:825105"].tmdb_title, "Dune: Part Three");
});

test("view identity is stable and memo is reused", () => {
  const { g, judged } = setup();
  const a = g.cache["movie:825105"];
  const n = judged();
  assert.equal(g.cache["movie:825105"], a);
  assert.equal(judged(), n);
});

test("memo invalidates when the entry object or stream name changes", () => {
  const { g, store, info } = setup();
  assert.equal(g.cache["movie:825105"].source, "no-match");
  info["movie:825105"] = { name: "Dune Part Three (2026)", year: null, tags: ["english"] };
  assert.equal(g.cache["movie:825105"].source, "tmdb"); // name changed -> re-judged
  info["movie:825105"] = { name: "Hissa (2026) (Punjabi)", year: null, tags: ["punjabi"] };
  assert.equal(g.cache["movie:825105"].source, "no-match");
  store["movie:825105"] = { ...store["movie:825105"], tmdb_title: "Hissa", tmdb_id: 7 }; // new entry object
  assert.equal(g.cache["movie:825105"].source, "tmdb");
});

test("year is part of the memo signature (view and resolver judge with the same year)", () => {
  const { g, info } = setup();
  info["movie:1"] = { name: "Zzzz", year: "2020", tags: ["english"] };
  const a = g.cache["movie:1"];
  info["movie:1"] = { name: "Zzzz", year: "2023", tags: ["english"] };
  assert.notEqual(g.cache["movie:1"].source === a.source && a.implausible, true);
});

test("guard_rejected raw entry keeps data but reads as no-match with its rejected_at", () => {
  const { g, store } = setup();
  store["movie:1"] = markGuardRejected(store["movie:1"], "because", 99, 4242);
  const v = g.cache["movie:1"];
  assert.equal(v.source, "no-match");
  assert.equal(v.checked_at, 4242);
  assert.equal(v.reason, "because");
  assert.equal(store["movie:1"].tmdb_title, "My Fault"); // data survives
  assert.equal(store["movie:1"].rejected_tmdb_id, 99);
});

test("override null => forced no-match, raw untouched", () => {
  const { g, store } = setup({ overrides: { "movie:1": null } });
  const v = g.cache["movie:1"];
  assert.equal(v.source, "no-match");
  assert.equal(v.override, true);
  assert.equal(store["movie:1"].tmdb_id, 5);
});

test("override number: bypasses the guard when the stored id matches, else pending", () => {
  const ok = setup({ overrides: { "movie:825105": 1170608 } });
  assert.equal(ok.g.cache["movie:825105"].tmdb_id, 1170608); // accepted despite implausible
  const pending = setup({ overrides: { "movie:825105": 42 } });
  const v = pending.g.cache["movie:825105"];
  assert.equal(v.source, "no-match");
  assert.equal(v.checked_at, 0);
  assert.equal(v.override_pending, true);
});

test("entries with no known stream name are never judged", () => {
  const { g, store } = setup({ streams: {} });
  assert.equal(g.cache["movie:825105"], store["movie:825105"]);
});

test("writes and deletes pass through to the store", () => {
  const { g, store } = setup();
  g.cache["movie:9"] = { source: "no-match", tmdb_id: null, checked_at: 1 };
  assert.ok(store["movie:9"]);
  delete g.cache["movie:9"];
  assert.equal(store["movie:9"], undefined);
});

test("normalizeOverrides coerces string ids and drops junk", () => {
  assert.deepEqual(normalizeOverrides({ "movie:1": "1234", "movie:2": null, "series:3": 55, "movie:4": "abc", "movie:5": -1, "bogus": 3, "movie:6": 1.5 }),
    { "movie:1": 1234, "movie:2": null, "series:3": 55 });
  assert.deepEqual(normalizeOverrides([1, 2]), {});
  assert.deepEqual(normalizeOverrides(null), {});
});
