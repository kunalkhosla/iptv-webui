const test = require("node:test");
const assert = require("node:assert/strict");
const M = require("../lib/notify-me");

const NOW = 1_790_000_000_000;
const D = 86400e3;
const P = "https://image.tmdb.org/t/p/w342/abc.jpg";

test("validateAdd", () => {
  assert.equal(M.validateAdd({ tmdb_id: "x", kind: "movie", title: "a" }).error, "bad tmdb_id");
  assert.equal(M.validateAdd({ tmdb_id: 1, kind: "person", title: "a" }).error, "bad kind");
  assert.equal(M.validateAdd({ tmdb_id: 1, kind: "movie", title: " " }).error, "title required");
  assert.deepEqual(M.validateAdd({ tmdb_id: "42", kind: "series", title: " Show ", year: "2026", poster: P }),
    { tmdb_id: 42, kind: "tv", title: "Show", year: "2026", poster: P });
  const v = M.validateAdd({ tmdb_id: 1, kind: "movie", title: "a", year: "26", poster: "javascript:alert(1)" });
  assert.equal(v.year, null);
  assert.equal(v.poster, null);
});

test("add dedupes, keeps newest first, caps", () => {
  let l = M.add([], { tmdb_id: 1, kind: "movie", title: "A" }, NOW);
  l = M.add(l, { tmdb_id: 2, kind: "tv", title: "B" }, NOW + 1);
  l = M.add(l, { tmdb_id: 1, kind: "movie", title: "A2" }, NOW + 2);
  assert.deepEqual(l.map((e) => e.title), ["A2", "B"]);
  assert.equal(l[0].addedAt, NOW, "re-adding a pending title keeps its added time");
  assert.deepEqual(M.remove(l, "tv", 2).map((e) => e.tmdb_id), [1]);
  let full = [];
  for (let i = 1; i <= M.MAX_ENTRIES; i++) full.push({ tmdb_id: i, kind: "movie", title: "t", addedAt: NOW });
  assert.equal(M.add(full, { tmdb_id: 9999, kind: "movie", title: "x" }, NOW), null);
  full[5].landed = { mode: "movie", id: 1, at: NOW };
  const made = M.add(full, { tmdb_id: 9999, kind: "movie", title: "x" }, NOW);
  assert.equal(made.length, M.MAX_ENTRIES);
  assert.equal(made.some((e) => e.tmdb_id === 6), false, "oldest landed entry made room");
});

test("match lands pending entries once; nowOnKhouch / prune windows", () => {
  const l = [
    { tmdb_id: 1, kind: "movie", title: "A" },
    { tmdb_id: 2, kind: "tv", title: "B" },
    { tmdb_id: 3, kind: "movie", title: "C" },
  ];
  const lookup = (kind, id) => (id === 1 ? { mode: "movie", id: 501 } : id === 2 ? { mode: "series", id: 777 } : null);
  const landed = M.match(l, lookup, NOW);
  assert.deepEqual(landed.map((e) => e.tmdb_id), [1, 2]);
  assert.deepEqual(M.match(l, lookup, NOW + 1), [], "already landed: no second push");
  assert.deepEqual(M.nowOnKhouch(l, "movie", NOW + D).map((e) => e.tmdb_id), [1]);
  assert.deepEqual(M.nowOnKhouch(l, "series", NOW + D).map((e) => e.tmdb_id), [2]);
  assert.deepEqual(M.nowOnKhouch(l, "movie", NOW + (M.NOW_ON_DAYS + 1) * D), []);
  assert.deepEqual(M.prune(l, NOW + (M.KEEP_LANDED_DAYS + 1) * D).map((e) => e.tmdb_id), [3]);
  assert.equal(M.publicView(l[0]).landed.id, 501);
  assert.equal(M.notifyText({ title: "Dune", year: "2026" }, "Kunal").message, "Kunal: Dune (2026) is now on Khouch.");
});

test("normalizeList drops junk and duplicates", () => {
  const l = M.normalizeList([null, { tmdb_id: 1, kind: "movie", title: "A", landed: { mode: "movie", id: "5", at: NOW } },
    { tmdb_id: 1, kind: "movie", title: "dup" }, { tmdb_id: 2, kind: "x", title: "B" }]);
  assert.equal(l.length, 1);
  assert.deepEqual(l[0].landed, { mode: "movie", id: 5, at: NOW });
  assert.deepEqual(M.normalizeList("nope"), []);
});
