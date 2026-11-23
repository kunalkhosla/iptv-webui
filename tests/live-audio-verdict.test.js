const test = require("node:test");
const assert = require("node:assert/strict");
const { decideLiveAudio, withDeadline } = require("../lib/live-audio-verdict");

const alive = { audio_codec: "mp2", browser_safe: false, dead: false, ts: 1 };

test("fresh verdict is used with no probe", () => {
  assert.deepEqual(decideLiveAudio({ entry: alive, fresh: true, anyInflight: false }), { use: alive, wait: false, background: false });
});
test("stale alive verdict is used immediately with no probe", () => {
  assert.deepEqual(decideLiveAudio({ entry: alive, fresh: false, anyInflight: false }), { use: alive, wait: false, background: false });
});
test("unknown channel waits (bounded) for a probe", () => {
  assert.deepEqual(decideLiveAudio({ entry: undefined, fresh: false, anyInflight: false }), { use: null, wait: true, background: false });
  const dead = { audio_codec: null, dead: true, ts: 1 };
  assert.equal(decideLiveAudio({ entry: dead, fresh: false, anyInflight: false }).wait, true);
});
test("joins own in-flight probe, skips when another channel is probing", () => {
  assert.equal(decideLiveAudio({ entry: null, fresh: false, sameKeyInflight: true, anyInflight: true }).wait, true);
  assert.equal(decideLiveAudio({ entry: null, fresh: false, sameKeyInflight: false, anyInflight: true }).wait, false);
});
test("withDeadline resolves null on timeout and swallows rejection", async () => {
  const t0 = Date.now();
  assert.equal(await withDeadline(new Promise(() => {}), 50), null);
  assert.ok(Date.now() - t0 < 500);
  assert.equal(await withDeadline(Promise.reject(new Error("x")), 50), null);
  assert.deepEqual(await withDeadline(Promise.resolve({ a: 1 }), 50), { a: 1 });
});
