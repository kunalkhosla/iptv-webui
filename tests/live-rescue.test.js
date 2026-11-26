const test = require("node:test");
const assert = require("node:assert/strict");
const L = require("../lib/live-rescue");

const S = (id, name, category_id = "1") => ({ id, name, category_id });

test("copies group by region + name, quality words ignored", () => {
  const items = [
    S(1, "IN: ZEE TV HD"), S(2, "IN: ZEE TV (FHD)"), S(3, "IN: ZEETV (4K)."), S(4, "UK: ZEE TV HD"),
    S(5, "IN: Zee Cinema HD"), S(6, "CRIC || STAR SPORTS 1 HINDI ᶠᴴᴰ"), S(7, "CRIC || STAR SPORTS 1 HINDI ⁴ᵏ"),
    S(8, "UKHD : Sky Cinema Premiere"), S(9, "UK: SKY CINEMA PREMIERE FHD"), S(10, "IN : STAR PLUS"), S(11, "IN: Star Plus HD"),
  ];
  const { groups, keyOfId } = L.buildGroups(items);
  const g = (id) => keyOfId.get(String(id));
  assert.equal(g(1), g(2));
  assert.equal(g(1), g(3));
  assert.notEqual(g(1), g(4), "UK ZEE TV is a different feed");
  assert.equal(g(4), undefined, "single copy -> not grouped");
  assert.equal(g(5), undefined);
  assert.equal(g(6), g(7));
  assert.equal(g(8), g(9), "UKHD/UK alias");
  assert.equal(g(10), g(11));
  assert.equal(groups.get(g(1)).length, 3);
});

test("no prefix groups only within its category; non-Latin names keep letters", () => {
  const items = [S(1, "StarzPlay Sports 1 HD", "156"), S(2, "StarzPlay Sports 1 SD", "156"), S(3, "StarzPlay Sports 1 SD", "99"),
    S(4, "RU: Cinema, Киносемья HD"), S(5, "RU: Cinema, Кинохит HD"), S(6, "UK: ZEE TV +1"), S(7, "UK: ZEE TV")];
  const { keyOfId } = L.buildGroups(items);
  assert.equal(keyOfId.get("1"), keyOfId.get("2"));
  assert.equal(keyOfId.get("3"), undefined);
  assert.equal(keyOfId.get("4"), undefined);
  assert.equal(keyOfId.get("6"), undefined, "+1 timeshift is a different feed");
});

test("quality tier", () => {
  assert.equal(L.qualityTier("IN: ZEE TV (4K)."), 4);
  assert.equal(L.qualityTier("CRIC || X ⁴ᵏ"), 4);
  assert.equal(L.qualityTier("IN: ZEE TV FHD"), 3);
  assert.equal(L.qualityTier("IN: ZEE TV HD"), 2);
  assert.equal(L.qualityTier("IN: ZEE TV"), 2);
  assert.equal(L.qualityTier("PT: Sport TV 1 SD"), 1);
});

test("sanitizeReport clamps and drops empty reports", () => {
  assert.equal(L.sanitizeReport(null), null);
  assert.equal(L.sanitizeReport({ watchedMs: 10 }), null);
  const r = L.sanitizeReport({ watchedMs: 1e12, stalls: -3, stallMs: "x", reconnects: 2.6, ttffMs: 5000, failed: true });
  assert.equal(r.watchedSec, 12 * 3600);
  assert.equal(r.stalls, 0);
  assert.equal(r.stallSec, 0);
  assert.equal(r.reconnects, 3);
  assert.equal(r.failed, true);
});

const NOW = Date.UTC(2026, 10, 26, 20, 0, 0);
const H = 20;
test("unknown copy scores neutral; clean viewing scores high; stalls and failures score low", () => {
  const store = {};
  assert.deepEqual(L.scoreFor(store, "1", NOW, H), { score: L.NEUTRAL, confidence: 0, measured: false });
  for (let i = 0; i < 4; i++) L.recordReport(store, "good", L.sanitizeReport({ watchedMs: 1800e3, ttffMs: 1500 }), NOW, H);
  for (let i = 0; i < 4; i++) L.recordReport(store, "bad", L.sanitizeReport({ watchedMs: 300e3, stalls: 6, stallMs: 60e3, reconnects: 2, ttffMs: 9000 }), NOW, H);
  for (let i = 0; i < 4; i++) L.recordReport(store, "dead", L.sanitizeReport({ failed: true }), NOW, H);
  const good = L.scoreFor(store, "good", NOW, H), bad = L.scoreFor(store, "bad", NOW, H), dead = L.scoreFor(store, "dead", NOW, H);
  assert.ok(good.score > 95, JSON.stringify(good));
  assert.equal(good.confidence, 1);
  assert.ok(bad.score < L.SCORE_FLOOR, JSON.stringify(bad));
  assert.ok(dead.score < L.SCORE_FLOOR, JSON.stringify(dead));
});

test("hour-of-day buckets: a copy that chokes at 8 pm is fine at noon", () => {
  const store = {};
  for (let i = 0; i < 6; i++) L.recordReport(store, "x", L.sanitizeReport({ watchedMs: 600e3, stalls: 8, stallMs: 90e3 }), NOW, 20);
  for (let i = 0; i < 6; i++) L.recordReport(store, "x", L.sanitizeReport({ watchedMs: 1800e3 }), NOW, 12);
  assert.ok(L.scoreFor(store, "x", NOW, 20).score < L.SCORE_FLOOR);
  assert.ok(L.scoreFor(store, "x", NOW, 12).score > 90);
  // An hour with no data of its own falls back to the whole day (lower confidence).
  const mid = L.scoreFor(store, "x", NOW, 4);
  assert.ok(mid.measured && mid.confidence < 1);
});

test("old reports fade toward neutral (half-life)", () => {
  const store = {};
  for (let i = 0; i < 4; i++) L.recordReport(store, "x", L.sanitizeReport({ failed: true }), NOW, H);
  const later = NOW + 8 * L.HALF_LIFE_MS;
  const s = L.scoreFor(store, "x", later, H);
  assert.ok(s.score > 60, JSON.stringify(s));
});

test("rankAlternates: excludes current, dead and below-floor copies; lighter preferred", () => {
  const scores = { 2: 80, 3: 80, 4: 40, 5: 90, 6: 80 };
  const out = L.rankAlternates({
    currentId: 1, currentName: "IN: ZEE TV FHD",
    candidates: [{ id: 1, name: "IN: ZEE TV FHD" }, { id: 2, name: "IN: ZEE TV HD" }, { id: 3, name: "IN: ZEE TV (4K)." },
      { id: 4, name: "IN: ZEE TV SD" }, { id: 5, name: "IN: ZEE TV (FHD)" }, { id: 6, name: "IN: ZEE TV" }],
    health: (id) => ({ score: scores[id], confidence: 1, measured: true }),
    deadState: (id) => (id === 5 ? "unavailable" : id === 6 ? "stale-dead" : null),
  });
  // 6: HD (+6) but stale-dead (-15) = 71; 3: 4K heavier (-12) = 68.
  assert.deepEqual(out.map((a) => a.id), [2, 6, 3]);
  assert.equal(out[0].quality, "HD");
  assert.ok(!out.some((a) => a.id === 1 || a.id === 4 || a.id === 5));
});

test("pruneHealth drops faded records and keeps live ones", () => {
  const now = 1_790_000_000_000;
  const store = {};
  L.recordReport(store, "old", { watchedSec: 60, stalls: 0, stallSec: 0, reconnects: 0, ttffMs: 900, failed: false }, now - 200 * 24 * 3600e3, 3);
  L.recordReport(store, "new", { watchedSec: 60, stalls: 0, stallSec: 0, reconnects: 0, ttffMs: 900, failed: false }, now - 3600e3, 3);
  store.bad = { ts: now };
  assert.equal(L.pruneHealth(store, now), 2);
  assert.deepEqual(Object.keys(store), ["new"]);
});

test("buildGroups byKey keeps single copies", () => {
  const g = L.buildGroups([{ id: 1, name: "IN: ZEE TV HD" }, { id: 2, name: "IN: ZEE TV" }, { id: 3, name: "UK: SKY ONE" }]);
  assert.deepEqual(g.byKey.get(L.groupKeyOf({ name: "UK: SKY ONE" })), [3]);
  assert.equal(g.groups.has(L.groupKeyOf({ name: "UK: SKY ONE" })), false);
});
