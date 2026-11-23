const test = require("node:test");
const assert = require("node:assert/strict");
const { selectContinueAndHistory } = require("../lib/continue-rails");

const pm = (o) => new Map(Object.entries(o).map(([k, v]) => [Number(k), v]));

test("finished movie (no progress, in recents) goes to history only", () => {
  const r = selectContinueAndHistory({ mode: "movie", progressById: pm({ 1: { p: 600, d: 7000, t: 50 } }),
    recentIds: [2, 1], lpForMode: { 2: 100 } });
  assert.deepEqual(r.continueIds, [1]);
  assert.deepEqual(r.historyIds, [2]);
});

test("just-pressed movie (p<=5) is history, not continue", () => {
  const r = selectContinueAndHistory({ mode: "movie", progressById: pm({ 3: { p: 4, t: 9 } }), recentIds: [3] });
  assert.deepEqual(r.continueIds, []);
  assert.deepEqual(r.historyIds, [3]);
});

test("series with auto up-next pointer continues; plain pointer does not", () => {
  const r = selectContinueAndHistory({ mode: "series", progressById: pm({}), recentIds: [10, 11],
    lastEpisode: { 10: { auto: true, when: 5 }, 11: { when: 9 } } });
  assert.deepEqual(r.continueIds, [10]);
  assert.deepEqual(r.historyIds, [11]);
});

test("series with in-progress episode continues; ordering newest first; watched fills history", () => {
  const r = selectContinueAndHistory({ mode: "series",
    progressById: pm({ 20: { p: 100, t: 10 }, 21: { p: 100, t: 30 } }),
    recentIds: [22], lpForMode: { 22: 20 }, watchedIds: [23] });
  assert.deepEqual(r.continueIds, [21, 20]);
  assert.deepEqual(r.historyIds, [22, 23]);
});
