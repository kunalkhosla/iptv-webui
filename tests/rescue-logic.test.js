"use strict";
// Web client live buffering rescue: pure detection / rate-limit logic
// (public/rescue-logic.js) plus source-level wiring checks on public/app.js.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const R = require("../public/rescue-logic.js");

const APP = fs.readFileSync(path.join(__dirname, "..", "public", "app.js"), "utf8");
const HTML = fs.readFileSync(path.join(__dirname, "..", "public", "index.html"), "utf8");

function started(at = 0, frameAt = 2000) {
  const s = R.createSession(220, at);
  R.onFirstFrame(s, frameAt);
  R.onPlaying(s, frameAt);
  return s;
}

test("no first frame: noframe only once 15 s have passed", () => {
  const s = R.createSession(220, 1000);
  assert.equal(R.struggleReason(s, 15_999), null);
  assert.equal(R.struggleReason(s, 16_000), "noframe");
});

test("stalls before the first frame are ignored", () => {
  const s = R.createSession(220, 0);
  R.onStallStart(s, 1000);
  R.onStallStart(s, 2000);
  assert.equal(s.stalls, 0);
  assert.equal(R.struggleReason(s, 5000), null);
});

test("two stalls starting within 90 s", () => {
  const s = started();
  R.onStallStart(s, 10_000); R.onPlaying(s, 11_000);
  assert.equal(R.struggleReason(s, 11_000), null);
  R.onStallStart(s, 99_000); R.onPlaying(s, 100_000);
  assert.equal(R.struggleReason(s, 100_000), "stalls");
});

test("two stalls more than 90 s apart are not a struggle", () => {
  const s = started();
  R.onStallStart(s, 10_000); R.onPlaying(s, 11_000);
  R.onStallStart(s, 101_000); R.onPlaying(s, 102_000);
  assert.equal(R.struggleReason(s, 102_000), null);
});

test("old stall pair ages out of the window", () => {
  const s = started();
  R.onStallStart(s, 10_000); R.onPlaying(s, 11_000);
  R.onStallStart(s, 20_000); R.onPlaying(s, 21_000);
  assert.equal(R.struggleReason(s, 21_000), "stalls");
  assert.equal(R.struggleReason(s, 200_000), null);
});

test("one continuous stall of 7 s", () => {
  const s = started();
  R.onStallStart(s, 10_000);
  assert.equal(R.struggleReason(s, 16_999), null);
  assert.equal(R.struggleReason(s, 17_000), "stall7s");
  R.onPlaying(s, 18_000);
  assert.equal(s.stallMs, 8000);
  assert.equal(R.struggleReason(s, 18_000), null, "a single ended stall is not a struggle");
});

test("two reconnects within 180 s, not further apart", () => {
  const a = started();
  R.onReconnect(a, 10_000);
  assert.equal(R.struggleReason(a, 10_000), null);
  R.onReconnect(a, 189_000);
  assert.equal(R.struggleReason(a, 189_000), "reconnects");
  const b = started();
  R.onReconnect(b, 10_000);
  R.onReconnect(b, 191_000);
  assert.equal(R.struggleReason(b, 191_000), null);
});

test("limiter: at most 2 auto switches per sliding 10 min", () => {
  const L = R.createLimiter();
  assert.ok(L.canAutoSwitch(1, 0));
  L.recordSwitch(0);
  assert.ok(L.canAutoSwitch(2, 1000));
  L.recordSwitch(1000);
  assert.equal(L.canAutoSwitch(3, 2000), false);
  assert.equal(L.canAutoSwitch(3, 599_999), false);
  assert.ok(L.canAutoSwitch(3, 600_000), "first switch left the window");
  L.recordSwitch(600_000);
  assert.equal(L.canAutoSwitch(3, 600_500), false);
});

test("limiter: undo puts that channel in a 10 min cooldown", () => {
  const L = R.createLimiter();
  L.recordUndo(220, 5000);
  assert.equal(L.canAutoSwitch(220, 6000), false);
  assert.equal(L.canAutoSwitch("220", 604_999), false);
  assert.ok(L.canAutoSwitch(161, 6000), "other channels unaffected");
  assert.ok(L.canAutoSwitch(220, 605_000));
});

test("pickAlternate: best copy only when it clears the floor", () => {
  assert.equal(R.pickAlternate({ floor: 55, alternates: [] }), null);
  assert.equal(R.pickAlternate(null), null);
  assert.equal(R.pickAlternate({ floor: 55, alternates: [{ id: 161, score: 54.9 }] }), null);
  assert.deepEqual(R.pickAlternate({ floor: 55, alternates: [{ id: 161, name: "IN: ZEE TV HD", score: 72.5 }, { id: 9, score: 90 }] }),
    { id: 161, name: "IN: ZEE TV HD", score: 72.5 });
});

test("requery back-off after an empty alternates answer", () => {
  const s = started();
  assert.ok(R.mayQuery(s, 0));
  s.lastQueryAt = 10_000;
  assert.equal(R.mayQuery(s, 69_999), false);
  assert.ok(R.mayQuery(s, 70_000));
});

test("report: counters, ttff, watched time and the reason", () => {
  const s = R.createSession(220, 0);
  R.onFirstFrame(s, 2300);
  R.onPlaying(s, 2300);
  R.onStallStart(s, 10_000);
  R.onPlaying(s, 14_000);
  R.onReconnect(s, 20_000);
  const r = R.buildReport(s, 30_000, "stalls");
  assert.deepEqual(r, { ttffMs: 2300, stalls: 1, stallMs: 4000, reconnects: 1, watchedMs: 23_700, failed: false, reason: "stalls" });
});

test("report: an ongoing stall and user pause", () => {
  const s = started(0, 1000);
  R.onNotPlaying(s, 5000); // user pause
  R.onPlaying(s, 8000);
  R.onStallStart(s, 9000);
  const r = R.buildReport(s, 12_000);
  assert.equal(r.watchedMs, 5000);
  assert.equal(r.stallMs, 3000);
  assert.equal(r.reason, "end");
});

test("report: empty / abandoned-while-loading sessions are skipped, real failures are not", () => {
  assert.equal(R.buildReport(R.createSession(1, 0), 2000), null, "zapped away while loading");
  const nf = R.buildReport(R.createSession(1, 0), 16_000, "noframe");
  assert.equal(nf.failed, true);
  assert.equal(nf.ttffMs, null);
  assert.equal(R.buildReport(R.createSession(1, 0), 2000, null, true).failed, true, "player gave up");
  assert.equal(R.buildReport(R.createSession(1, 0), 16_000).failed, true, "never started in 15 s");
});

test("app wiring: script tag, alternates call, health post, test hook, reminders", () => {
  assert.match(HTML, /<script defer src="\/rescue-logic\.js"><\/script>/);
  assert.ok(HTML.indexOf("/rescue-logic.js") < HTML.indexOf("/app.js"));
  assert.ok(APP.includes("/api/live/alternates/"));
  assert.ok(APP.includes("/api/live/health/"));
  assert.ok(APP.includes("rescueTest"));
  assert.ok(APP.includes("__khouchRescueTest"));
  assert.ok(APP.includes("/api/reminders"));
  assert.ok(APP.includes("OK to undo, 10 s"));
});

test("limiter: the copy a switch left is excluded for the switch window", () => {
  const L = R.createLimiter();
  L.recordSwitch(1000, 7);
  assert.equal(L.isExcluded("7", 2000), true);
  assert.equal(L.isExcluded(8, 2000), false);
  assert.equal(L.isExcluded(7, 1000 + R.SWITCH_WINDOW_MS), false);
  L.recordSwitch(5000);
  assert.equal(L.isExcluded("undefined", 5000), false);
});

test("pickAlternate skips excluded copies (no A -> B -> A)", () => {
  const payload = { floor: 55, alternates: [{ id: 1, score: 90 }, { id: 2, score: 60 }, { id: 3, score: 50 }] };
  assert.equal(R.pickAlternate(payload, (id) => id === 1).id, 2);
  assert.equal(R.pickAlternate(payload, (id) => id !== 3), null, "remaining copy under the floor");
  assert.equal(R.pickAlternate(payload).id, 1);
});
