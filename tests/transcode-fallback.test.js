// Regression: a VOD source the VAAPI encoder rejects at runtime
// (`h264_vaapi` exits -22 "Invalid argument", no packets written) must
// fall back to software (libx264) instead of leaving the title
// permanently unplayable at every seek offset.
//
// The boot HW_ENCODE probe only proves a bare nv12->h264 upload works,
// NOT that every real source encodes. Before the fix, spawnTranscoder
// chose the encoder purely from the global HW_ENCODE flag and the VOD
// exit path had no software retry — so one bad file failed forever.
//
// Two layers, mirroring kids-filter.test.js:
//   1. Unit tests on the pure predicate `vodSoftwareFallbackEligible`.
//   2. A static scan of server.js proving the retry is actually wired in.

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const {
  vodSoftwareFallbackEligible,
  transcodeSourceUnavailable,
} = require("../lib/transcode-fallback");

// A VOD run that used the GPU, exited with an error, and wrote no
// segment while a viewer is still waiting: the exact incident shape.
const REJECTED_VAAPI_VOD = {
  mode: "movie",
  exitCode: 255,
  usedHardware: true,
  alreadyTriedSoftware: false,
  producedSegment: false,
  viewerPresent: true,
  stopping: false,
};

test("VAAPI-rejected VOD run is eligible for a software retry", () => {
  assert.equal(vodSoftwareFallbackEligible(REJECTED_VAAPI_VOD), true);
});

test("live never falls back here (it owns its own self-heal path)", () => {
  assert.equal(
    vodSoftwareFallbackEligible({ ...REJECTED_VAAPI_VOD, mode: "live" }),
    false,
  );
});

test("a software run that failed is NOT retried again (no loop)", () => {
  assert.equal(
    vodSoftwareFallbackEligible({ ...REJECTED_VAAPI_VOD, usedHardware: false }),
    false,
  );
  assert.equal(
    vodSoftwareFallbackEligible({ ...REJECTED_VAAPI_VOD, alreadyTriedSoftware: true }),
    false,
  );
});

test("a run that produced a segment then died is a drop, not an encoder reject", () => {
  assert.equal(
    vodSoftwareFallbackEligible({ ...REJECTED_VAAPI_VOD, producedSegment: true }),
    false,
  );
});

test("a clean exit (code 0) does not trigger a fallback", () => {
  assert.equal(
    vodSoftwareFallbackEligible({ ...REJECTED_VAAPI_VOD, exitCode: 0 }),
    false,
  );
});

test("no fallback when the viewer has gone or the stream was stopped", () => {
  assert.equal(
    vodSoftwareFallbackEligible({ ...REJECTED_VAAPI_VOD, viewerPresent: false }),
    false,
  );
  assert.equal(
    vodSoftwareFallbackEligible({ ...REJECTED_VAAPI_VOD, stopping: true }),
    false,
  );
});

// ---------------------------------------------------------------------
// Static contract scan: the fallback has to be wired into server.js, not
// just live in lib/. Guards against a future refactor silently dropping
// the per-stream retry (which is the whole fix).
// ---------------------------------------------------------------------
const SERVER = fs.readFileSync(
  path.join(__dirname, "..", "server.js"),
  "utf8",
);

test("server.js consults the fallback predicate on transcoder exit", () => {
  assert.match(SERVER, /vodSoftwareFallbackEligible\(/);
});

// ---------------------------------------------------------------------
// Regression: an unrecoverable VOD source (invalid/broken upstream →
// ffmpeg "Invalid data found when processing input", never produces a
// segment) must NOT be respawned on every player manifest retry. Before
// the fix there was no failure memory across requests, so a dead series
// source (127768 / 654643 in the incident) got a fresh ffmpeg spawn every
// ~7-9s indefinitely — CPU + log flood, and it hammered the cap=1 panel.
// A short cooldown circuit breaker refuses the key until the window passes.
// ---------------------------------------------------------------------
const COOLDOWN = 60_000;

test("a source that just gave up is held unavailable during the cooldown", () => {
  const failedAt = 1_000_000;
  assert.equal(transcodeSourceUnavailable(failedAt, failedAt + 5_000, COOLDOWN), true);
});

test("the breaker releases once the cooldown has elapsed", () => {
  const failedAt = 1_000_000;
  assert.equal(transcodeSourceUnavailable(failedAt, failedAt + COOLDOWN, COOLDOWN), false);
  assert.equal(transcodeSourceUnavailable(failedAt, failedAt + COOLDOWN + 1, COOLDOWN), false);
});

test("a key with no recorded failure is never gated", () => {
  assert.equal(transcodeSourceUnavailable(undefined, 1_000_000, COOLDOWN), false);
  assert.equal(transcodeSourceUnavailable(0, 1_000_000, COOLDOWN), false);
});

test("server.js trips + consults the circuit breaker and clears it on connect", () => {
  assert.match(SERVER, /transcodeSourceUnavailable\(/);
  // Recorded on give-up, cleared on a successful connect.
  assert.match(SERVER, /transcoderFailures\.set\(/);
  assert.match(SERVER, /transcoderFailures\.delete\(/);
});

test("startOrTouchTranscoder refuses a source still in cooldown before spawning", () => {
  const body = SERVER.slice(
    SERVER.indexOf("async function startOrTouchTranscoder"),
    SERVER.indexOf("async function spawnTranscoder"),
  );
  // The breaker check must run before the spawn call, not after.
  const guardAt = body.indexOf("transcodeSourceUnavailable(");
  const spawnAt = body.indexOf("spawnTranscoder(");
  assert.ok(guardAt > 0, "breaker check present in startOrTouchTranscoder");
  assert.ok(guardAt < spawnAt, "breaker check precedes the spawn");
});

test("encoder choice is per-run, not driven solely by the global HW_ENCODE flag", () => {
  // The fix threads a swFallback flag so a retry can force software even
  // when HW_ENCODE is globally true. The encode branches must key off the
  // per-run `hw` local, not `HW_ENCODE` directly.
  const spawnBody = SERVER.slice(
    SERVER.indexOf("async function spawnTranscoder"),
    SERVER.indexOf("setInterval", SERVER.indexOf("async function spawnTranscoder")),
  );
  assert.match(spawnBody, /const hw = HW_ENCODE && !swFallback/);
  // No encode branch inside spawnTranscoder should still gate on the raw
  // global flag (that would ignore the fallback).
  assert.doesNotMatch(spawnBody, /else if \(HW_ENCODE\)/);
});
