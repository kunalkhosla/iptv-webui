const test = require("node:test");
const assert = require("node:assert/strict");
const { selectContinueAndHistory, clearAutoPointer } = require("../lib/continue-rails");

const pm = (o) => new Map(Object.entries(o).map(([k, v]) => [Number(k), v]));

test("finished movie (no progress, in recents) goes to history only", () => {
  const r = selectContinueAndHistory({ mode: "movie", progressById: pm({ 1: { p: 600, d: 7000, t: 50 } }),
    recentIds: [2, 1], lpForMode: { 2: 100 } });
  assert.deepEqual(r.continueIds, [1]);
  assert.deepEqual(r.historyIds, [2]);
});

test("just-pressed movie (p<=5) is history, not continue", () => {
  const r = selectContinueAndHistory({ mode: "movie", progressById: pm({ 3: { p: 20, t: 9 } }), recentIds: [3] });
  assert.deepEqual(r.continueIds, []);
  assert.deepEqual(r.historyIds, [3]);
});

test("series with auto up-next pointer continues; plain pointer does not", () => {
  const r = selectContinueAndHistory({ mode: "series", progressById: pm({}), recentIds: [10, 11],
    lastEpisode: { 10: { auto: true, when: Date.now() }, 11: { when: 9 } } });
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

test("clearAutoPointer drops up-next flag so a finished series leaves Continue", () => {
  const le = { auto: true, when: Date.now() };
  clearAutoPointer(le);
  const r = selectContinueAndHistory({ mode: "series", progressById: pm({}), recentIds: [30], lastEpisode: { 30: le } });
  assert.deepEqual(r.continueIds, []);
  assert.deepEqual(r.historyIds, [30]);
});

test("stale auto pointer (>45d) expires", () => {
  const r = selectContinueAndHistory({ mode: "series", progressById: pm({}), recentIds: [31],
    lastEpisode: { 31: { auto: true, when: Date.now() - 46 * 864e5 } } });
  assert.deepEqual(r.continueIds, []);
});

test("direct-play finished (d>0, p>=95%) and p<30 are not Continue", () => {
  const r = selectContinueAndHistory({ mode: "movie",
    progressById: pm({ 40: { p: 6800, d: 7000, t: 5 }, 41: { p: 10, d: 7000, t: 4 }, 42: { p: 100, d: 0, t: 3 } }),
    recentIds: [] });
  assert.deepEqual(r.continueIds, [42]);
  assert.deepEqual(r.historyIds.sort(), [40, 41]);
});
