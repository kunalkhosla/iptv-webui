const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { createInfoStore, getInfoStaleIfError, isUsableInfo, InfoUnavailableError, withTimeout } = require("../lib/info-cache");

const tmpDir = () => fs.mkdtempSync(path.join(os.tmpdir(), "info-cache-"));
const GOOD = { seasons: [], info: { name: "Koffee with Karan" }, episodes: { 1: [{ id: "1" }] } };
const DEGRADED = { seasons: [], info: { name: "Koffee with Karan" }, episodes: {} };
const MOVIE = { info: { name: "M" }, movie_data: { stream_id: 1 } };
const panel500 = () => Promise.reject(new Error("Panel 500 for get_series_info"));
const waitFor = async (fn) => {
  for (let i = 0; i < 200; i++) { const v = await fn(); if (v) return v; await new Promise((r) => setTimeout(r, 5)); }
  return null;
};
const run = (o) => getInfoStaleIfError({ key: "k", mode: "series", memStale: undefined, ...o });

test("isUsableInfo: series need episodes, movies need info/movie_data", () => {
  assert.strictEqual(isUsableInfo(GOOD, "series"), true);
  assert.strictEqual(isUsableInfo(DEGRADED, "series"), false);
  assert.strictEqual(isUsableInfo({ info: { a: 1 }, episodes: { 1: [] } }, "series"), false);
  assert.strictEqual(isUsableInfo(MOVIE, "movie"), true);
  assert.strictEqual(isUsableInfo({ movie_data: { stream_id: 1 } }, "movie"), true);
  for (const v of [null, undefined, [], {}, { info: [], episodes: [] }, { info: {}, episodes: {} }, "x"]) {
    assert.strictEqual(isUsableInfo(v, "series"), false, JSON.stringify(v));
    assert.strictEqual(isUsableInfo(v, "movie"), false, JSON.stringify(v));
  }
});

test("live success returns live and persists to disk", async () => {
  const store = createInfoStore({ dir: tmpDir() });
  const r = await run({ fetchLive: async () => GOOD, store });
  assert.deepStrictEqual(r, { v: GOOD, stale: false, source: "live" });
  const rec = await waitFor(() => store.get("k"));
  assert.deepStrictEqual(rec.v, GOOD);
});

test("panel failure serves in-memory copy past TTL", async () => {
  const store = createInfoStore({ dir: tmpDir() });
  const seen = [];
  const r = await run({ fetchLive: panel500, memStale: GOOD, store, onStale: (s, e) => seen.push([s.source, e.message]) });
  assert.strictEqual(r.stale, true);
  assert.strictEqual(r.source, "memory");
  assert.deepStrictEqual(r.v, GOOD);
  assert.deepStrictEqual(seen, [["memory", "Panel 500 for get_series_info"]]);
});

test("panel failure after restart (empty memory) serves disk copy", async () => {
  const dir = tmpDir();
  await createInfoStore({ dir }).put("k", GOOD, "series");
  const r = await run({ fetchLive: panel500, store: createInfoStore({ dir }) });
  assert.strictEqual(r.source, "disk");
  assert.deepStrictEqual(r.v, GOOD);
  assert.ok(r.t > 0);
});

test("panel failure with no copy throws info_unavailable", async () => {
  await assert.rejects(
    run({ fetchLive: panel500, store: createInfoStore({ dir: tmpDir() }) }),
    (e) => e instanceof InfoUnavailableError && e.code === "info_unavailable" && /Panel 500/.test(e.cause.message),
  );
});

test("timeoutMs caps a slow (e.g. shared 90 s prewarm) live call", async () => {
  const dir = tmpDir();
  await createInfoStore({ dir }).put("k", GOOD, "series");
  let resolveSlow;
  const slow = new Promise((r) => { resolveSlow = r; });
  const t0 = Date.now();
  const r = await run({ fetchLive: () => slow, timeoutMs: 40, store: createInfoStore({ dir }) });
  assert.ok(Date.now() - t0 < 1000);
  assert.strictEqual(r.source, "disk");
  resolveSlow(GOOD);
  await assert.rejects(
    run({ fetchLive: () => new Promise(() => {}), timeoutMs: 20, store: createInfoStore({ dir: tmpDir() }) }),
    (e) => e.code === "info_unavailable" && e.cause.name === "TimeoutError",
  );
});

test("withTimeout passes through fast results", async () => {
  assert.strictEqual(await withTimeout(Promise.resolve(7), 1000), 7);
  assert.strictEqual(await withTimeout(Promise.resolve(8), 0), 8);
});

test("degraded series answer never overwrites a good copy; good copy served; cache hook fires", async () => {
  const dir = tmpDir();
  await createInfoStore({ dir }).put("k", GOOD, "series");
  const store = createInfoStore({ dir });
  let unusable = 0;
  const r = await run({ fetchLive: async () => DEGRADED, store, onUnusableLive: () => unusable++ });
  assert.strictEqual(r.stale, true);
  assert.strictEqual(r.source, "disk");
  assert.deepStrictEqual(r.v, GOOD);
  assert.strictEqual(unusable, 1);
  assert.strictEqual(await store.put("k", DEGRADED, "series"), false);
  assert.deepStrictEqual((await store.get("k")).v, GOOD);
});

test("degraded answer prefers the pre-call in-memory snapshot", async () => {
  const r = await run({ fetchLive: async () => DEGRADED, memStale: GOOD, store: createInfoStore({ dir: tmpDir() }) });
  assert.strictEqual(r.source, "memory");
  assert.deepStrictEqual(r.v, GOOD);
});

test("empty panel answer with no copy passes through unchanged", async () => {
  const store = createInfoStore({ dir: tmpDir() });
  const r = await run({ fetchLive: async () => [], store });
  assert.deepStrictEqual(r, { v: [], stale: false, source: "live" });
  assert.strictEqual(await store.get("k"), null);
});

test("movie mode", async () => {
  const dir = tmpDir();
  const r1 = await getInfoStaleIfError({ key: "m", mode: "movie", fetchLive: async () => MOVIE, store: createInfoStore({ dir }) });
  assert.strictEqual(r1.source, "live");
  await waitFor(() => createInfoStore({ dir }).get("m"));
  const r2 = await getInfoStaleIfError({ key: "m", mode: "movie", fetchLive: panel500, store: createInfoStore({ dir }) });
  assert.strictEqual(r2.source, "disk");
});

test("corrupt disk file is treated as missing", async () => {
  const store = createInfoStore({ dir: tmpDir() });
  fs.writeFileSync(store.fileFor("k"), "{not json");
  await assert.rejects(run({ fetchLive: panel500, store }), { code: "info_unavailable" });
});

test("disk copies older than maxAgeMs are ignored", async () => {
  const dir = tmpDir();
  const clock = { t: 1_000_000 };
  await createInfoStore({ dir, now: () => clock.t }).put("k", GOOD, "series");
  clock.t += 31 * 24 * 3600 * 1000;
  assert.strictEqual(await createInfoStore({ dir, now: () => clock.t }).get("k"), null);
});

test("keys are account-scoped (distinct files)", () => {
  const store = createInfoStore({ dir: tmpDir() });
  assert.notStrictEqual(store.fileFor("acctA\0get_series_info{}"), store.fileFor("acctB\0get_series_info{}"));
});

test("put throttles rewrites of the same key, unless the file is gone", async () => {
  const clock = { t: 1000 };
  const store = createInfoStore({ dir: tmpDir(), rewriteAfterMs: 100, now: () => clock.t });
  assert.strictEqual(await store.put("k", GOOD, "series"), true);
  clock.t += 50;
  assert.strictEqual(await store.put("k", GOOD, "series"), false);
  fs.unlinkSync(store.fileFor("k"));
  assert.strictEqual(await store.put("k", GOOD, "series"), true);
  clock.t += 100;
  assert.strictEqual(await store.put("k", GOOD, "series"), true);
});

test("prune: keeps newest maxEntries, drops expired copies and stale tmp files", async () => {
  const dir = tmpDir();
  const store = createInfoStore({ dir, maxEntries: 2 });
  const age = (f, ms) => { const t = new Date(Date.now() - ms); fs.utimesSync(f, t, t); };
  for (const [i, k] of ["a", "b", "c"].entries()) {
    await store.put(k, GOOD, "series");
    age(store.fileFor(k), (10 - i) * 1000);
  }
  await store.put("old", GOOD, "series");
  age(store.fileFor("old"), 40 * 24 * 3600 * 1000);
  const tmpOld = path.join(dir, "x.json.1.1.tmp");
  const tmpNew = path.join(dir, "y.json.1.2.tmp");
  fs.writeFileSync(tmpOld, "{}"); age(tmpOld, 2 * 3600 * 1000);
  fs.writeFileSync(tmpNew, "{}");
  await store.prune();
  assert.strictEqual(fs.existsSync(store.fileFor("old")), false);
  assert.strictEqual(await store.get("a"), null);
  assert.ok(await store.get("b"));
  assert.ok(await store.get("c"));
  assert.strictEqual(fs.existsSync(tmpOld), false);
  assert.strictEqual(fs.existsSync(tmpNew), true);
});
