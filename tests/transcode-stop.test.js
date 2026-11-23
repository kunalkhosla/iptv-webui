const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { parseStopRequest, noteOwner, ownStreamTarget, handleStopRequest, MAX_OWNERS } = require("../lib/transcode-stop");

test("no args = caller's own", () => {
  for (const b of [{}, undefined, "garbage", [1, 2], { mode: null, id: null }]) {
    assert.deepEqual(parseStopRequest(b), { ok: true, target: null });
  }
});

test("valid mode + id (string or number)", () => {
  assert.deepEqual(parseStopRequest({ mode: "movie", id: "123" }), { ok: true, target: { mode: "movie", id: "123" } });
  assert.deepEqual(parseStopRequest({ mode: "live", id: 42 }), { ok: true, target: { mode: "live", id: "42" } });
  assert.deepEqual(parseStopRequest({ mode: "disk", id: 5000000000 }), { ok: true, target: { mode: "disk", id: "5000000000" } });
});

test("partial or invalid args are rejected, never widened", () => {
  for (const body of [
    { mode: "movie" }, { id: "1" }, { mode: "movie", id: "" }, { mode: "movie", id: 0.5 },
    { mode: "movie", id: -1 }, { mode: "movie", id: "1-" }, { mode: "movie", id: "1x" },
    { mode: "movi", id: "1" }, { mode: "", id: "1" }, { mode: "movie-1", id: "1" },
    { mode: ["movie"], id: "1" }, { mode: "movie", id: { a: 1 } },
  ]) {
    assert.equal(parseStopRequest(body).ok, false, JSON.stringify(body));
  }
});

test("ownStreamTarget ignores missing/displaced/bogus entries", () => {
  assert.equal(ownStreamTarget(undefined), null);
  assert.equal(ownStreamTarget({ mode: "movie", id: "7", displaced: true }), null);
  assert.equal(ownStreamTarget({ mode: "bogus", id: "7" }), null);
  assert.deepEqual(ownStreamTarget({ mode: "series", id: "7", displaced: false }), { mode: "series", id: "7" });
});

test("noteOwner is bounded and keeps the most recent", () => {
  const t = {};
  for (let i = 0; i < MAX_OWNERS + 3; i++) noteOwner(t, `o${i}`);
  assert.equal(t.owners.size, MAX_OWNERS);
  assert.ok(!t.owners.has("o0"));
  noteOwner(t, "o3"); // refresh o3, then push one more: o4 is evicted, not o3
  noteOwner(t, "new");
  assert.ok(t.owners.has("o3"));
  assert.ok(!t.owners.has("o4"));
  noteOwner(t, ""); noteOwner(null, "x"); // no-ops
});

// Two owners: the web owner (cookie session) watching movie 12, and a
// friend-like caller (another account/session) watching live 99 via a
// shared ffmpeg it only fetched segments from. A Chromecast receiver (its own
// owner key) is also pulling movie 12.
function world() {
  const mk = (n) => ({ n, owners: new Set() });
  const transcoders = new Map([
    ["movie-12-high", mk("m12-high")],
    ["movie-12-low-t300", mk("m12-low")],
    ["movie-123-high", mk("m123")],
    ["live-99-auto", mk("l99")],
    ["series-5-high", mk("s5")],
  ]);
  noteOwner(transcoders.get("movie-12-high"), "s:web");
  noteOwner(transcoders.get("movie-12-high"), "ip:cast");
  noteOwner(transcoders.get("live-99-auto"), "s:friend");
  noteOwner(transcoders.get("series-5-high"), "s:web"); // stale one web still owns
  const streams = new Map([
    ["s:web", { mode: "movie", id: "12", displaced: false }],
    ["s:friend", { mode: "live", id: "99", displaced: false }],
  ]);
  const stopped = [];
  const stop = (t, reason) => stopped.push([t.n, reason]);
  return { transcoders, streams, stopped, stop };
}
const names = (w) => w.stopped.map(([n]) => n).sort();

test("no-arg stop from web kills only its own (admission title + owned)", () => {
  const w = world();
  const r = handleStopRequest({}, { ...w, owner: "s:web" });
  assert.equal(r.status, 200);
  assert.deepEqual(names(w), ["m12-high", "m12-low", "s5"]);
  assert.deepEqual(r.body, { ok: true, killed: 3 });
  assert.ok(w.stopped.every(([, reason]) => reason === "client-stop-own"));
});

test("no-arg stop from the friend never touches the web owner's transcoders", () => {
  const w = world();
  const r = handleStopRequest(undefined, { ...w, owner: "s:friend" });
  assert.deepEqual(names(w), ["l99"]);
  assert.equal(r.body.killed, 1);
});

test("no-arg stop from a stranger with nothing live stops nothing", () => {
  const w = world();
  const r = handleStopRequest({}, { ...w, owner: "s:nobody" });
  assert.deepEqual(r.body, { ok: true, killed: 0 });
  assert.equal(w.stopped.length, 0);
});

test("displaced owner's no-arg stop only hits transcoders it fetched", () => {
  const w = world();
  w.streams.get("s:web").displaced = true;
  handleStopRequest({}, { ...w, owner: "s:web" });
  assert.deepEqual(names(w), ["m12-high", "s5"]); // m12-low not owned, admission ignored
});

test("explicit {mode,id} stops every variant of that title, any owner (cast)", () => {
  const w = world();
  const r = handleStopRequest({ mode: "movie", id: 12 }, { ...w, owner: "s:phone" });
  assert.deepEqual(names(w), ["m12-high", "m12-low"]);
  assert.equal(r.body.killed, 2);
  assert.ok(w.stopped.every(([, reason]) => reason === "client-stop"));
});

test("invalid input is a 400 and stops nothing", () => {
  const w = world();
  const r = handleStopRequest({ mode: "movie", id: "" }, { ...w, owner: "s:web" });
  assert.equal(r.status, 400);
  assert.equal(r.body.ok, false);
  assert.ok(r.error);
  assert.equal(w.stopped.length, 0);
});

test("owners survive a respawn (entry object reused)", () => {
  const w = world();
  const entry = w.transcoders.get("live-99-auto");
  // spawnTranscoder's respawn path reuses the entry and swaps proc only.
  entry.proc = { pid: 2 }; entry.respawning = false;
  w.transcoders.set("live-99-auto", entry);
  handleStopRequest({}, { ...w, streams: new Map(), owner: "s:friend" });
  assert.deepEqual(names(w), ["l99"]);
});

test("server wires the handler and records owners", () => {
  const src = fs.readFileSync(path.join(__dirname, "..", "server.js"), "utf8");
  const i = src.indexOf('app.post("/api/transcode/stop"');
  assert.ok(i > 0);
  const route = src.slice(i, src.indexOf("\napp.", i + 10));
  assert.match(route, /handleStopRequest\(req\.body, \{ transcoders, streams, owner, stop: stopTranscoder \}\)/);
  assert.match(route, /console\.log\(`\[transcode-stop\] rejected/);
  assert.doesNotMatch(route, /transcoders\.values\(\)/);
  assert.doesNotMatch(src, /client-stop-all/);
  assert.match(src, /owners: new Set\(\),\n  \};\n  entry\.proc = ffmpeg;/);
  assert.equal((src.match(/noteOwner\(t, owner\);/g) || []).length, 2);
});
