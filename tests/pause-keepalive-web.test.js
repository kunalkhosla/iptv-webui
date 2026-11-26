"use strict";
// Web pause keep-alive: the pure controller (public/pause-keepalive.js) with a
// fake clock, plus source-level wiring checks on public/app.js.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const K = require("../public/pause-keepalive.js");

const APP = fs.readFileSync(path.join(__dirname, "..", "public", "app.js"), "utf8");
const HTML = fs.readFileSync(path.join(__dirname, "..", "public", "index.html"), "utf8");
const MIN = 60_000;

function harness(reply = () => ({ status: 200, body: { ok: true, kept: true } }), opts = {}) {
  let now = 0;
  let timers = [];
  const posts = [];
  const ka = K.create({
    post: (t) => { posts.push({ at: now, ...t }); return Promise.resolve(reply(t, now)); },
    now: () => now,
    setTimer: (fn, ms) => { const h = { fn, at: now + ms }; timers.push(h); return h; },
    clearTimer: (h) => { timers = timers.filter((x) => x !== h); },
    ...opts,
  });
  async function advance(ms) {
    const end = now + ms;
    for (;;) {
      timers.sort((a, b) => a.at - b.at);
      const next = timers[0];
      if (!next || next.at > end) break;
      timers.shift();
      now = next.at;
      next.fn();
      await new Promise((r) => setImmediate(r));
    }
    now = end;
    await new Promise((r) => setImmediate(r));
  }
  return { ka, posts, advance, get timers() { return timers; }, setNow: (n) => { now = n; } };
}

test("beats immediately and every minute while paused", async () => {
  const h = harness();
  h.ka.paused("movie", 42);
  await h.advance(0);
  assert.equal(h.posts.length, 1);
  assert.deepEqual(h.posts[0], { at: 0, mode: "movie", id: "42" });
  await h.advance(4 * MIN);
  assert.equal(h.posts.length, 5);
  assert.ok(h.ka.active);
});

test("stops at the 60-minute cap", async () => {
  const h = harness();
  h.ka.paused("series", "7");
  await h.advance(90 * MIN);
  assert.equal(h.ka.active, false);
  assert.equal(h.ka.stoppedBy, "cap");
  assert.ok(h.posts.every((p) => p.at < 60 * MIN));
  assert.equal(h.posts.length, 60);
  assert.equal(h.timers.length, 0);
});

test("cap override (test-time) is honoured", async () => {
  const h = harness(undefined, { maxMs: 3 * MIN, intervalMs: MIN });
  h.ka.paused("disk", "410824192356479");
  await h.advance(10 * MIN);
  assert.equal(h.posts.length, 3);
  assert.equal(h.ka.stoppedBy, "cap");
});

test("live and bad targets never beat", async () => {
  const h = harness();
  h.ka.paused("live", 1);
  h.ka.paused("movie", null);
  h.ka.paused("movie", "");
  await h.advance(5 * MIN);
  assert.equal(h.posts.length, 0);
});

test("play / close / background stop it; no further posts", async () => {
  for (const reason of ["play", "close", "background", "cast"]) {
    const h = harness();
    h.ka.paused("movie", 1);
    await h.advance(2 * MIN);
    const n = h.posts.length;
    h.ka.stop(reason);
    await h.advance(10 * MIN);
    assert.equal(h.posts.length, n, reason);
    assert.equal(h.ka.stoppedBy, reason);
  }
});

test("server refusal ends it: kept:false, 410, 400", async () => {
  for (const [r, why] of [
    [{ status: 200, body: { ok: true, kept: false, reason: "no-session" } }, "no-session"],
    [{ status: 200, body: { ok: true, kept: false, reason: "cap" } }, "cap"],
    [{ status: 410, body: {} }, "displaced"],
    [{ status: 400, body: {} }, "rejected"],
  ]) {
    const h = harness(() => r);
    h.ka.paused("movie", 1);
    await h.advance(0); // the reply lands well inside the first minute
    await h.advance(5 * MIN);
    assert.equal(h.posts.length, 1, why);
    assert.equal(h.ka.stoppedBy, why);
  }
});

test("network errors keep trying", async () => {
  let n = 0;
  const h = harness();
  const k = K.create({
    post: () => { n++; return Promise.reject(new Error("offline")); },
    now: () => 0, setTimer: () => null, clearTimer: () => {},
  });
  k.paused("movie", 1);
  await new Promise((r) => setImmediate(r));
  assert.equal(n, 1);
  assert.ok(k.active);
  void h;
});

test("same title re-pause does not reset the clock; background resume keeps the budget", async () => {
  const h = harness();
  h.ka.paused("movie", 1);
  await h.advance(30 * MIN);
  h.ka.paused("movie", 1);
  assert.equal(h.ka.pausedAt, 0);
  const at = h.ka.pausedAt;
  h.ka.stop("background");
  await h.advance(20 * MIN);
  h.ka.resumeAfterBackground("movie", 1, at);
  await h.advance(15 * MIN);
  assert.equal(h.ka.active, false);
  assert.equal(h.ka.stoppedBy, "cap");
  const h2 = harness();
  h2.setNow(61 * MIN);
  h2.ka.resumeAfterBackground("movie", 1, 0);
  await h2.advance(0);
  assert.equal(h2.posts.length, 0, "past the budget: no beat");
  h2.ka.resumeAfterBackground("movie", 1, 59 * MIN);
  await h2.advance(0);
  assert.equal(h2.posts.length, 1, "within the budget: beats");
});

test("a stale reply from a previous pause cannot stop the new one", async () => {
  let release;
  const k = K.create({
    post: () => new Promise((r) => { release = r; }),
    now: () => 0, setTimer: () => null, clearTimer: () => {},
  });
  k.paused("movie", 1);
  await new Promise((r) => setImmediate(r));
  k.stop("play");
  k.paused("movie", 2);
  release({ status: 200, body: { kept: false, reason: "no-session" } });
  await new Promise((r) => setImmediate(r));
  assert.ok(k.active);
});

test("app.js wiring: pause/play/close/cast/visibility and script order", () => {
  assert.match(HTML, /<script defer src="\/pause-keepalive\.js"><\/script>/);
  assert.ok(HTML.indexOf("/pause-keepalive.js") < HTML.indexOf("/app.js"));
  assert.match(APP, /KPauseKeepalive\.create\(/);
  assert.match(APP, /"\/api\/stream\/heartbeat"/);
  assert.match(APP, /function closePlayer\(\) \{\n  _pauseKA\.stop\("close"\);/);
  assert.match(APP, /state\.castSession = ctx\.getCurrentSession\(\);\n\s+_pauseKA\.stop\("cast"\);/);
  assert.match(APP, /p\.mode === "live" \|\| state\.castSession/);
  assert.match(APP, /_pauseKA\.stop\("background"\)/);
  const SRV = fs.readFileSync(path.join(__dirname, "..", "server.js"), "utf8");
  assert.match(SRV, /rescue-logic\\\.js\|pause-keepalive\\\.js/);
});
