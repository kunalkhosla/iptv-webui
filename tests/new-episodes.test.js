const test = require("node:test");
const assert = require("node:assert/strict");
const N = require("../lib/new-episodes");

const NOW = 1_790_000_000_000;
const D = 86400e3;
const info = (eps) => ({ episodes: eps.reduce((acc, [s, e, id, added]) => {
  (acc[s] ||= []).push({ id, season: s, episode_num: e, title: `E${e}`, added: String(added || 0) });
  return acc;
}, {}) });

test("markFor / newEpisodes: episodes after the mark, specials sort first", () => {
  const a = info([[1, 1, 11], [1, 2, 12], [2, 1, 21]]);
  const m = N.markFor(a, NOW);
  assert.deepEqual(m, { s: 2, e: 1, at: NOW });
  assert.deepEqual(N.newEpisodes(a, m), []);
  const b = info([[0, 1, 1], [1, 1, 11], [1, 2, 12], [2, 1, 21], [2, 2, 22], [3, 1, 31]]);
  assert.deepEqual(N.newEpisodes(b, m).map((x) => x.id), ["22", "31"]);
  assert.deepEqual(N.newEpisodes(b, null), []);
  assert.equal(N.markFor({ episodes: {} }), null);
  assert.equal(N.markFor(null), null);
});

test("flatEpisodes skips malformed rows and sorts numerically", () => {
  const x = { episodes: { 1: [{ id: 3, episode_num: "10" }, { id: 2, episode_num: "9" }, { episode_num: 1 }, { id: 9, episode_num: "x" }] } };
  assert.deepEqual(N.flatEpisodes(x).map((e) => e.id), ["2", "3"]);
});

test("trackedSeries: recent pointers newest first, old ones dropped", () => {
  const st = {
    lastEpisode: {
      100: { episode_id: "5", when: NOW - 2 * D },
      200: { episode_id: "6", when: NOW - 200 * D },
      300: { episode_id: "7" },
      abc: { episode_id: "8", when: NOW },
      400: { episode_id: "9" },
      500: { episode_id: "10", when: NOW - 3 * D, auto: false, cwRemovedAt: NOW - D },
      600: { episode_id: "11", when: NOW, cwRemovedAt: NOW - D },
      700: { episode_id: "12", playedAt: NOW - 4 * D },
    },
    progress: { "series:7": { p: 100, t: NOW - D } },
  };
  // 400: no known time; 500: removed from Continue Watching, not played since; 600: played again.
  assert.deepEqual(N.trackedSeries(st, NOW), ["600", "300", "100", "700"]);
});

test("newEpisodeMap / railOrder use cached infos and marks", () => {
  const st = {
    lastEpisode: { 100: { episode_id: "11", when: NOW - D }, 200: { episode_id: "21", when: NOW - D }, 300: { episode_id: "31", when: NOW } },
    progress: {},
    seriesSeen: { 100: { s: 1, e: 1, at: NOW - 3 * D }, 200: { s: 1, e: 1, at: NOW - 3 * D } },
  };
  const infos = {
    100: info([[1, 1, 11], [1, 2, 12, 1_790_000_100]]),
    200: info([[1, 1, 21], [1, 2, 22, 1_790_000_500], [1, 3, 23, 1_790_000_400]]),
    300: info([[1, 1, 31], [1, 2, 32]]), // no mark yet: never "new"
  };
  const map = N.newEpisodeMap(st, (sid) => infos[sid] || null, NOW);
  assert.equal(map.size, 2);
  assert.equal(map.get("100").count, 1);
  assert.equal(map.get("200").count, 2);
  assert.equal(map.get("200").latest.e, 3);
  assert.deepEqual(N.railOrder(map), ["200", "100"]);
  assert.equal(N.badgeLabel(1), "New episode");
  assert.equal(N.badgeLabel(3), "3 new episodes");
});

test("pruneSeen keeps followed series and caps the rest", () => {
  const st = { lastEpisode: { 1: { episode_id: "a", when: NOW } }, progress: {} };
  const seen = { 1: { s: 1, e: 1, at: NOW - 300 * D } };
  for (let i = 2; i < 2 + N.SEEN_MAX + 5; i++) seen[i] = { s: 1, e: 1, at: NOW - i * 1000 };
  seen[999] = { s: 1, e: 1, at: NOW - 200 * D };
  const out = N.pruneSeen(seen, st, NOW);
  assert.equal(Object.keys(out).length, N.SEEN_MAX);
  assert.ok(out[1], "followed series kept even when old");
  assert.ok(!out[999], "old unfollowed mark dropped");
  const small = { 1: seen[1] };
  assert.equal(N.pruneSeen(small, st, NOW), small);
});
