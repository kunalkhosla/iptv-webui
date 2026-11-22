const test = require("node:test");
const assert = require("node:assert");
const { createPrewarmQueue } = require("../lib/prewarm-queue");

const idle = () => new Promise((r) => setTimeout(r, 30));
const fast = { gapMs: 0, yieldMs: 5 };

test("dedupes queued keys and runs serially", async () => {
  const calls = []; let active = 0, maxActive = 0;
  const q = createPrewarmQueue({
    ...fast,
    fetcher: async (e) => { active++; maxActive = Math.max(maxActive, active); await idle(); calls.push(e.key); active--; },
  });
  assert.strictEqual(q.enqueue([{ key: "a" }, { key: "b" }, { key: "a" }]), 2);
  await new Promise((r) => setTimeout(r, 150));
  assert.deepStrictEqual(calls, ["a", "b"]);
  assert.strictEqual(maxActive, 1);
});

test("skips cached items at enqueue and at run time", async () => {
  const cached = new Set(["c"]); const calls = [];
  const q = createPrewarmQueue({
    ...fast,
    isCached: (e) => cached.has(e.key),
    fetcher: async (e) => { calls.push(e.key); cached.add("b"); },
  });
  assert.strictEqual(q.enqueue([{ key: "a" }, { key: "c" }, { key: "b" }]), 2);
  await new Promise((r) => setTimeout(r, 50));
  assert.deepStrictEqual(calls, ["a"]); // b became cached before its turn
});

test("cap drops oldest", async () => {
  const calls = [];
  const q = createPrewarmQueue({ ...fast, cap: 3, fetcher: async (e) => { calls.push(e.key); } });
  q.enqueue([1, 2, 3, 4, 5].map((n) => ({ key: "k" + n })));
  assert.strictEqual(q.stats.dropped, 2);
  await new Promise((r) => setTimeout(r, 50));
  assert.deepStrictEqual(calls, ["k3", "k4", "k5"]);
});

test("errors swallowed, no retry, queue continues", async () => {
  const calls = [];
  const q = createPrewarmQueue({ ...fast, fetcher: async (e) => { calls.push(e.key); if (e.key === "x") throw new Error("boom"); } });
  q.enqueue([{ key: "x" }, { key: "y" }]);
  await new Promise((r) => setTimeout(r, 50));
  assert.deepStrictEqual(calls, ["x", "y"]);
  assert.strictEqual(q.stats.errors, 1);
});

test("yields while a viewer is active, then resumes", async () => {
  let busy = true; const calls = [];
  const q = createPrewarmQueue({ ...fast, shouldYield: () => busy, fetcher: async (e) => { calls.push(e.key); } });
  q.enqueue([{ key: "a" }]);
  await new Promise((r) => setTimeout(r, 40));
  assert.deepStrictEqual(calls, []);
  busy = false;
  await new Promise((r) => setTimeout(r, 40));
  assert.deepStrictEqual(calls, ["a"]);
});
