const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { parseStopRequest, ownStreamTarget, selectTranscodersToStop } = require("../lib/transcode-stop");

test("no args = caller's own stream", () => {
  assert.deepEqual(parseStopRequest({}), { ok: true, target: null });
  assert.deepEqual(parseStopRequest(undefined), { ok: true, target: null });
  assert.deepEqual(parseStopRequest("garbage"), { ok: true, target: null });
  assert.deepEqual(parseStopRequest([1, 2]), { ok: true, target: null });
  assert.deepEqual(parseStopRequest({ mode: null, id: null }), { ok: true, target: null });
});

test("valid mode + id (string or number)", () => {
  assert.deepEqual(parseStopRequest({ mode: "movie", id: "123" }), { ok: true, target: { mode: "movie", id: "123" } });
  assert.deepEqual(parseStopRequest({ mode: "live", id: 42 }), { ok: true, target: { mode: "live", id: "42" } });
  assert.deepEqual(parseStopRequest({ mode: "disk", id: 5000000000 }), { ok: true, target: { mode: "disk", id: "5000000000" } });
});

test("partial or invalid args are rejected, never widened", () => {
  for (const body of [
    { mode: "movie" },
    { id: "1" },
    { mode: "movie", id: "" },
    { mode: "movie", id: 0.5 },
    { mode: "movie", id: -1 },
    { mode: "movie", id: "1-" },
    { mode: "movie", id: "1x" },
    { mode: "movi", id: "1" },
    { mode: "", id: "1" },
    { mode: "movie-1", id: "1" },
    { mode: ["movie"], id: "1" },
    { mode: "movie", id: { a: 1 } },
  ]) {
    assert.equal(parseStopRequest(body).ok, false, JSON.stringify(body));
  }
});

test("ownStreamTarget", () => {
  assert.equal(ownStreamTarget(undefined), null);
  assert.equal(ownStreamTarget({ mode: "movie", id: "7", displaced: true }), null);
  assert.equal(ownStreamTarget({ mode: "bogus", id: "7" }), null);
  assert.deepEqual(ownStreamTarget({ mode: "series", id: "7", displaced: false }), { mode: "series", id: "7" });
});

function map() {
  return new Map([
    ["movie-12-high", { n: "a-high", accountKey: "A" }],
    ["movie-12-low-t300", { n: "a-low", accountKey: "A" }],
    ["movie-123-high", { n: "a-123", accountKey: "A" }],
    ["movie-12-auto", { n: "b-12", accountKey: "B" }],
    ["live-12-high", { n: "a-live", accountKey: "A" }],
    ["movie-12-legacy", { n: "noacct" }],
  ]);
}

test("selects every variant of the title on the caller's account only", () => {
  const got = selectTranscodersToStop(map(), { mode: "movie", id: "12" }, "A").map((t) => t.n).sort();
  assert.deepEqual(got, ["a-high", "a-low"]);
  const b = selectTranscodersToStop(map(), { mode: "movie", id: "12" }, "B").map((t) => t.n);
  assert.deepEqual(b, ["b-12"]);
});

test("no target or no account selects nothing", () => {
  assert.deepEqual(selectTranscodersToStop(map(), null, "A"), []);
  assert.deepEqual(selectTranscodersToStop(map(), { mode: "movie", id: "12" }, ""), []);
  assert.deepEqual(selectTranscodersToStop(map(), { mode: "movie", id: "12" }, undefined), []);
});

test("server route is scoped (no global stop-all) and entries record the account", () => {
  const src = fs.readFileSync(path.join(__dirname, "..", "server.js"), "utf8");
  const i = src.indexOf('app.post("/api/transcode/stop"');
  assert.ok(i > 0);
  const route = src.slice(i, src.indexOf("\napp.", i + 10));
  assert.match(route, /parseStopRequest\(req\.body\)/);
  assert.match(route, /status\(400\)/);
  assert.match(route, /ownStreamTarget\(streams\.get\(ownerKeyOf\(req\)\)\)/);
  assert.match(route, /selectTranscodersToStop\(transcoders, target, accountKeyOf\(currentAccount\(\)\)\)/);
  assert.match(route, /killed: victims\.length/);
  assert.doesNotMatch(route, /transcoders\.values\(\)/);
  assert.doesNotMatch(src, /client-stop-all/);
  assert.match(src, /accountKey: accountKeyOf\(currentAccount\(\)\),\n  \};\n  entry\.proc = ffmpeg;/);
});
