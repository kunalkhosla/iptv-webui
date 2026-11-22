const test = require("node:test");
const assert = require("node:assert");
const { Readable } = require("node:stream");
const { pipeline } = require("node:stream/promises");
const { skipBytes } = require("../lib/skip-bytes");

async function run(chunks, n) {
  const out = [];
  await pipeline(Readable.from(chunks.map((c) => Buffer.from(c))), skipBytes(n),
    new (require("node:stream").Writable)({ write(c, _e, cb) { out.push(c); cb(); } }));
  return Buffer.concat(out).toString();
}

test("skips within a single chunk", async () => assert.strictEqual(await run(["abcdef"], 2), "cdef"));
test("skips across chunk boundaries", async () => assert.strictEqual(await run(["ab", "cd", "ef"], 3), "def"));
test("exact chunk boundary", async () => assert.strictEqual(await run(["ab", "cd"], 2), "cd"));
test("zero / invalid skip is a passthrough", async () => {
  assert.strictEqual(await run(["abc"], 0), "abc");
  assert.strictEqual(await run(["abc"], NaN), "abc");
});
test("skip longer than body yields nothing", async () => assert.strictEqual(await run(["abc"], 10), ""));
