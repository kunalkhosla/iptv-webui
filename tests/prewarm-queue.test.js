const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");
const { createPrewarmQueue, buildDetailEntries } = require("../lib/prewarm-queue");
const { xtreamKey } = require("../lib/xtream-key");

// Injected timer: sleeps resolve on the next macrotask; clock is manual.
const mk = (opts = {}) => {
  const clock = { t: 1_000_000 };
  const q = createPrewarmQueue({
    now: () => clock.t,
    setTimeoutFn: (fn) => setImmediate(fn),
    ...opts,
  });
  return { q, clock };
};
// Poll until cond() holds (fails the test after timeoutMs) instead of a fixed
// settle delay, which flakes on a loaded box.
async function waitFor(cond, timeoutMs = 5000) {
  const end = Date.now() + timeoutMs;
  while (!cond()) {
    if (Date.now() > end) throw new Error("waitFor: timed out");
    await new Promise((r) => setTimeout(r, 5));
  }
}
// The queue has drained (nothing running, nothing queued).
const idle = (q) => waitFor(() => !q.running && q.size === 0);
// Only for asserting that something did NOT happen.
const brief = () => new Promise((r) => setTimeout(r, 25));

test("dedupes queued keys and runs serially", async () => {
  const calls = []; let active = 0, maxActive = 0;
  const { q } = mk({
    fetcher: async (e) => { active++; maxActive = Math.max(maxActive, active); await Promise.resolve(); calls.push(e.key); active--; },
  });
  assert.strictEqual(q.enqueue([{ key: "a" }, { key: "b" }, { key: "a" }]), 2);
  await idle(q);
  assert.deepStrictEqual(calls, ["a", "b"]);
  assert.strictEqual(maxActive, 1);
});

test("skips cached items at enqueue and at run time", async () => {
  const cached = new Set(["c"]); const calls = [];
  const { q } = mk({
    isCached: (e) => cached.has(e.key),
    fetcher: async (e) => { calls.push(e.key); cached.add("b"); },
  });
  assert.strictEqual(q.enqueue([{ key: "a" }, { key: "c" }, { key: "b" }]), 2);
  await idle(q);
  assert.deepStrictEqual(calls, ["a"]);
});

test("cap drops NEW entries, keeps the earliest", async () => {
  const calls = [];
  const { q } = mk({ cap: 3, fetcher: async (e) => { calls.push(e.key); } });
  q.enqueue([1, 2, 3, 4, 5].map((n) => ({ key: "k" + n })));
  assert.strictEqual(q.stats.dropped, 2);
  await idle(q);
  assert.deepStrictEqual(calls, ["k1", "k2", "k3"]);
});

test("failed key is not retried within cooldown, is after", async () => {
  const calls = [];
  const { q, clock } = mk({ fetcher: async (e) => { calls.push(e.key); throw new Error("boom"); } });
  q.enqueue([{ key: "x" }]);
  await idle(q);
  q.enqueue([{ key: "x" }]);
  await idle(q);
  assert.deepStrictEqual(calls, ["x"]);
  clock.t += 21 * 60_000;
  q.enqueue([{ key: "x" }]);
  await idle(q);
  assert.deepStrictEqual(calls, ["x", "x"]);
});

test("circuit breaker pauses after 5 consecutive errors, resumes later", async () => {
  const calls = [];
  const { q, clock } = mk({ fetcher: async (e) => { calls.push(e.key); throw new Error("5xx"); } });
  q.enqueue(["a", "b", "c", "d", "e", "f", "g"].map((key) => ({ key })));
  await idle(q);
  assert.strictEqual(calls.length, 5);
  assert.strictEqual(q.enqueue([{ key: "h" }]), 0); // paused
  clock.t += 11 * 60_000;
  assert.strictEqual(q.enqueue([{ key: "h" }]), 1);
  await idle(q);
  assert.strictEqual(calls[calls.length - 1], "h");
});

test("a success resets the consecutive-error count", async () => {
  const { q } = mk({ fetcher: async (e) => { if (e.key !== "ok") throw new Error("x"); } });
  q.enqueue([{ key: "1" }, { key: "2" }, { key: "3" }, { key: "4" }, { key: "ok" }, { key: "5" }, { key: "6" }, { key: "7" }, { key: "8" }]);
  await idle(q);
  assert.strictEqual(q.stats.errors, 8);
});

test("yields while a viewer is active, then resumes", async () => {
  let busy = true; const calls = [];
  const { q } = mk({ shouldYield: () => busy, fetcher: async (e) => { calls.push(e.key); } });
  q.enqueue([{ key: "a" }]);
  await brief();
  assert.deepStrictEqual(calls, []);
  busy = false;
  await idle(q);
  assert.deepStrictEqual(calls, ["a"]);
});

test("buildDetailEntries: validation, dedupe, cap, id key per mode", () => {
  const actx = { u: 1 };
  const e = buildDetailEntries("movie", [5, "5", "12", "abc", null, "1;2", -3, ...Array.from({ length: 20 }, (_, i) => 100 + i)], actx, "acct", 8);
  assert.strictEqual(e.length, 8);
  assert.deepStrictEqual(e.slice(0, 2).map((x) => x.id), ["5", "12"]);
  assert.ok(e.every((x) => x.idKey === "vod_id" && x.mode === "movie" && x.actx === actx));
  assert.strictEqual(new Set(e.map((x) => x.key)).size, 8);
  const s = buildDetailEntries("series", [7], actx, "acct");
  assert.strictEqual(s[0].idKey, "series_id");
  assert.deepStrictEqual(buildDetailEntries("live", [1], actx, "acct"), []);
});

test("xtream cache key: single helper, no hand-built keys in server.js", () => {
  assert.strictEqual(xtreamKey("a", "get_vod_info", { vod_id: "1" }), 'a\0get_vod_info{"vod_id":"1"}');
  const src = fs.readFileSync(path.join(__dirname, "..", "server.js"), "latin1");
  const m = src.match(/xtream\(action[\s\S]{0,700}/)[0];
  assert.ok(m.includes("xtreamKey(actx, action, params)"));
  // any template that builds `${accountKeyOf(actx)}<sep>${...info/action}` by hand is a regression
  assert.ok(!/accountKeyOf\(actx\)\}[ \0]\$\{/.test(src));
});
