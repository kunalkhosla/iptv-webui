const test = require("node:test");
const assert = require("node:assert/strict");
const col = require("../lib/collections");
const { posterUrl, tmdbPathFromIcon } = require("../lib/poster");

const T = (id, colId, extra = {}) => ({ source: "tmdb", tmdb_id: id, collection: colId ? { id: colId, name: `C${colId}`, poster_path: "/p.jpg" } : null, ...extra });

test("collections: group, one per title, release order, >=2 visible", () => {
  const items = [
    { id: 1, name: "HP 2", year: "2002" }, { id: 2, name: "HP 1", year: "2001" },
    { id: 3, name: "HP 1 (Hindi)", year: "2001", isAlt: true }, { id: 4, name: "Narnia", year: "2005" },
    { id: 5, name: "Other", year: "2010" },
  ];
  const tm = {
    1: T(11, 100, { release_date: "2002-11-15" }), 2: T(10, 100, { release_date: "2001-11-16" }),
    3: T(10, 100, { release_date: "2001-11-16" }), 4: T(20, 200), 5: T(30, null),
  };
  const idx = col.buildCollectionIndex(items, (s) => tm[s.id]);
  assert.equal(idx.size, 2);
  const vis = col.visibleMembers(idx.get(100), () => true, (s) => (s.isAlt ? 1 : 0));
  assert.deepEqual(vis.map((m) => m.s.id), [2, 1]);
  const list = col.collectionList(idx, () => true, { prefer: (s) => (s.isAlt ? 1 : 0) });
  assert.deepEqual(list.map((e) => e.col.id), [100]);
  assert.equal(list[0].firstYear, 2001);
  // Gate hides one title -> collection drops below 2.
  assert.equal(col.collectionList(idx, (s) => s.id !== 1).length, 0);
  // Affinity sorts first.
  idx.get(200).members.push({ s: { id: 6, year: "2008" }, t: T(21, 200) });
  const l2 = col.collectionList(idx, () => true, { affinity: (vis) => (vis.some((m) => m.s.id === 4) ? 1 : 0) });
  assert.equal(l2[0].col.id, 200);
});

test("releaseKey falls back to year", () => {
  assert.equal(col.releaseKey({ release_date: "2001-02-03" }), "2001-02-03");
  assert.equal(col.releaseKey({ year: "1999" }), "1999-99-99");
  assert.equal(col.releaseKey(null, {}), "9999-99-99");
});

test("posterUrl: TMDB, TMDB icon, https icon, never http/data/initials", () => {
  assert.equal(posterUrl({ poster_path: "/abc.jpg" }, "http://x/y.jpg"), "https://image.tmdb.org/t/p/w342/abc.jpg");
  assert.equal(posterUrl(null, "https://image.tmdb.org/t/p/w600_and_h900_bestv2/z5AQHYTTx7DzABCD.jpg"), "https://image.tmdb.org/t/p/w342/z5AQHYTTx7DzABCD.jpg");
  assert.equal(posterUrl({ source: "no-match" }, "https://www.themoviedb.org/t/p/w600_and_h900_face/vsxdWuHSR6abcdef.jpg"), "https://image.tmdb.org/t/p/w342/vsxdWuHSR6abcdef.jpg");
  assert.equal(posterUrl(null, "https://cdn.example.com/a.jpg"), "https://cdn.example.com/a.jpg");
  assert.equal(posterUrl(null, "http://panel:8080/images/a.jpg"), null);
  assert.equal(posterUrl(null, "data:image/png;base64,AAAA"), null);
  assert.equal(posterUrl(null, ""), null);
  assert.equal(posterUrl(null, null), null);
  assert.equal(tmdbPathFromIcon("https://image.tmdb.org/t/p/w500/../../x.jpg"), null);
});
