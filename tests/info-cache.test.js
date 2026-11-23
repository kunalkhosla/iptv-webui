const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { createInfoStore, getInfoStaleIfError, isUsableInfo, InfoUnavailableError } = require("../lib/info-cache");

const tmpDir = () => fs.mkdtempSync(path.join(os.tmpdir(), "info-cache-"));
const GOOD = { seasons: [], info: { name: "Koffee with Karan" }, episodes: { 1: [{ id: "1" }] } };
const panel500 = () => Promise.reject(new Error("Panel 500 for get_series_info"));
const waitFor = async (fn) => {
  for (let i = 0; i < 200; i++) { const v = await fn(); if (v) return v; await new Promise((r) => setTimeout(r, 5)); }
  return null;
};

test("isUsableInfo rejects empty panel shells", () => {
  assert.strictEqual(isUsableInfo(GOOD), true);
  assert.strictEqual(isUsableInfo({ info: { name: "x" } }), true);
  assert.strictEqual(isUsableInfo({ movie_data: { stream_id: 1 } }), true);
  for (const v of [null, undefined, [], {}, { info: [], episodes: [] }, { info: {}, episodes: {} }, "x"]) {
    assert.strictEqual(isUsableInfo(v), false, JSON.stringify(v));
  }
});

test("live success returns live and persists to disk", async () => {
  const store = createInfoStore({ dir: tmpDir() });
  const r = await getInfoStaleIfError({ key: "k", fetchLive: async () => GOOD, memStale: () => undefined, store });
  assert.deepStrictEqual(r, { v: GOOD, stale: false, source: "live" });
  const rec = await waitFor(() => store.get("k"));
  assert.deepStrictEqual(rec.v, GOOD);
});

test("panel failure serves in-memory copy past TTL", async () => {
  const store = createInfoStore({ dir: tmpDir() });
  const seen = [];
  const r = await getInfoStaleIfError({
    key: "k", fetchLive: panel500, memStale: () => GOOD, store,
    onStale: (s, e) => seen.push([s.source, e.message]),
  });
  assert.strictEqual(r.stale, true);
  assert.strictEqual(r.source, "memory");
  assert.deepStrictEqual(r.v, GOOD);
  assert.deepStrictEqual(seen, [["memory", "Panel 500 for get_series_info"]]);
});

test("panel failure after restart (empty memory) serves disk copy", async () => {
  const dir = tmpDir();
  await createInfoStore({ dir }).put("k", GOOD);
  const store = createInfoStore({ dir }); // fresh process
  const r = await getInfoStaleIfError({ key: "k", fetchLive: panel500, memStale: () => undefined, store });
  assert.strictEqual(r.stale, true);
  assert.strictEqual(r.source, "disk");
  assert.deepStrictEqual(r.v, GOOD);
  assert.ok(r.t > 0);
});

test("panel failure with no copy throws info_unavailable", async () => {
  const store = createInfoStore({ dir: tmpDir() });
  await assert.rejects(
    getInfoStaleIfError({ key: "k", fetchLive: panel500, memStale: () => undefined, store }),
    (e) => e instanceof InfoUnavailableError && e.code === "info_unavailable" && /Panel 500/.test(e.cause.message),
  );
});

test("timeout/network errors also fail over", async () => {
  const dir = tmpDir();
  await createInfoStore({ dir }).put("k", GOOD);
  const store = createInfoStore({ dir });
  const r = await getInfoStaleIfError({
    key: "k", fetchLive: () => Promise.reject(Object.assign(new Error("aborted"), { name: "TimeoutError" })),
    memStale: () => undefined, store,
  });
  assert.strictEqual(r.source, "disk");
});

test("empty panel answer does not clobber good disk copy; stale copy is served", async () => {
  const dir = tmpDir();
  await createInfoStore({ dir }).put("k", GOOD);
  const store = createInfoStore({ dir });
  const empty = { info: [], episodes: [] };
  const r = await getInfoStaleIfError({ key: "k", fetchLive: async () => empty, memStale: () => empty, store });
  assert.strictEqual(r.stale, true);
  assert.strictEqual(r.source, "disk");
  assert.deepStrictEqual((await store.get("k")).v, GOOD);
});

test("empty panel answer with no copy passes through unchanged", async () => {
  const store = createInfoStore({ dir: tmpDir() });
  const r = await getInfoStaleIfError({ key: "k", fetchLive: async () => [], memStale: () => undefined, store });
  assert.deepStrictEqual(r, { v: [], stale: false, source: "live" });
  assert.strictEqual(await store.get("k"), null);
});

test("corrupt disk file is treated as missing", async () => {
  const dir = tmpDir();
  const store = createInfoStore({ dir });
  fs.writeFileSync(store.fileFor("k"), "{not json");
  await assert.rejects(
    getInfoStaleIfError({ key: "k", fetchLive: panel500, memStale: () => undefined, store }),
    { code: "info_unavailable" },
  );
});

test("keys are account-scoped (distinct files)", () => {
  const store = createInfoStore({ dir: tmpDir() });
  assert.notStrictEqual(store.fileFor("acctA\0get_series_info{}"), store.fileFor("acctB\0get_series_info{}"));
});

test("put throttles rewrites of the same key within rewriteAfterMs", async () => {
  const clock = { t: 1000 };
  const store = createInfoStore({ dir: tmpDir(), rewriteAfterMs: 100, now: () => clock.t });
  assert.strictEqual(await store.put("k", GOOD), true);
  clock.t += 50;
  assert.strictEqual(await store.put("k", GOOD), false);
  clock.t += 100;
  assert.strictEqual(await store.put("k", GOOD), true);
});

test("prune keeps only the newest maxEntries files", async () => {
  const dir = tmpDir();
  const store = createInfoStore({ dir, maxEntries: 2 });
  for (const [i, k] of ["a", "b", "c"].entries()) {
    await store.put(k, GOOD);
    const t = new Date(Date.now() - (10 - i) * 1000);
    fs.utimesSync(store.fileFor(k), t, t);
  }
  await store.prune();
  assert.strictEqual(await store.get("a"), null);
  assert.ok(await store.get("b"));
  assert.ok(await store.get("c"));
});
