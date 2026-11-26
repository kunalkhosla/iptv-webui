const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { parseHeartbeat, ipOfOwnerKey, ownerMatchesCaller, maxMsFrom, handleHeartbeat, DEFAULT_MAX_MS } = require("../lib/pause-keepalive");
const { vodReachedEnd, noPacketsLabel } = require("../lib/vod-end");

const MIN = 60_000;

function setup({ owner = "ip:192.168.0.214:abcd1234", mode = "movie", id = "77", since = 0, mediaSeen = 0, displaced = false } = {}) {
  const entry = { mode, id, since, lastSeen: mediaSeen, mediaSeen, displaced, killers: new Set() };
  const streams = new Map([[owner, entry]]);
  const t = { lastAccess: mediaSeen, owners: new Set([owner]), stopping: false };
  const other = { lastAccess: mediaSeen, owners: new Set(["ip:10.0.0.9:ffffffff"]), stopping: false };
  const transcoders = new Map([[`${mode}-${id}-med-0`, t], [`${mode}-${id}-high-0`, other], [`${mode}-${id}9-med-0`, { lastAccess: 0, owners: new Set([owner]) }]]);
  return { entry, streams, transcoders, t, other };
}

test("parseHeartbeat: modes, ids, live refused", () => {
  assert.deepEqual(parseHeartbeat({ mode: "movie", id: 12 }), { ok: true, mode: "movie", id: "12" });
  assert.deepEqual(parseHeartbeat({ mode: "series", id: "34" }), { ok: true, mode: "series", id: "34" });
  assert.deepEqual(parseHeartbeat({ mode: "disk", id: 5000000000 }), { ok: true, mode: "disk", id: "5000000000" });
  assert.deepEqual(parseHeartbeat({ mode: "disk", id: "410824192356479" }), { ok: true, mode: "disk", id: "410824192356479" });
  assert.equal(parseHeartbeat({ mode: "disk", id: "123456789012345678" }).ok, false);
  assert.equal(parseHeartbeat({ mode: "live", id: 1 }).ok, false);
  for (const b of [{}, null, "x", [1], { mode: "movie" }, { mode: "movie", id: "1;2" }, { mode: "movie", id: -1 }, { mode: "MOVIE", id: 1 }, { mode: "movie", id: 1.5 }]) {
    assert.equal(parseHeartbeat(b).ok, false, JSON.stringify(b));
  }
});

test("ipOfOwnerKey handles IPv4, IPv6, cookie owners", () => {
  assert.equal(ipOfOwnerKey("ip:1.2.3.4:abcd1234"), "1.2.3.4");
  assert.equal(ipOfOwnerKey("ip:::1:abcd1234"), "::1");
  assert.equal(ipOfOwnerKey("ip:::ffff:10.0.0.1:abcd1234"), "::ffff:10.0.0.1");
  assert.equal(ipOfOwnerKey("s:abc"), null);
  assert.equal(ipOfOwnerKey(null), null);
});

test("ownerMatchesCaller: exact owner or same IP; no prefix confusion", () => {
  assert.equal(ownerMatchesCaller("s:tok", "s:tok", "1.1.1.1"), true);
  assert.equal(ownerMatchesCaller("s:tok", "s:other", "1.1.1.1"), false);
  assert.equal(ownerMatchesCaller("ip:1.2.3.4:aaaa0000", "s:tok", "1.2.3.4"), true);
  assert.equal(ownerMatchesCaller("ip:1.2.3.45:aaaa0000", "s:tok", "1.2.3.4"), false);
  assert.equal(ownerMatchesCaller("ip:::1:5:aaaa0000", "s:tok", "::1"), false);
});

test("maxMsFrom: env override, default", () => {
  assert.equal(maxMsFrom(undefined), DEFAULT_MAX_MS);
  assert.equal(maxMsFrom("abc"), DEFAULT_MAX_MS);
  assert.equal(maxMsFrom("0"), DEFAULT_MAX_MS);
  assert.equal(maxMsFrom("120000"), 120000);
  assert.ok(DEFAULT_MAX_MS >= 60 * MIN);
});

test("heartbeat keeps the caller's paused session and its transcoders", () => {
  const { entry, streams, transcoders, t, other } = setup();
  const now = 4 * MIN;
  const r = handleHeartbeat({ mode: "movie", id: 77 }, { streams, transcoders, callerOwner: "s:tok", callerIp: "192.168.0.214", now, maxMs: 60 * MIN });
  assert.equal(r.status, 200);
  assert.equal(r.body.kept, true);
  assert.equal(entry.lastSeen, now);
  assert.equal(entry.mediaSeen, 0, "heartbeat never counts as media");
  assert.equal(t.lastAccess, now);
  assert.equal(other.lastAccess, 0, "someone else's transcoder untouched");
  assert.equal(transcoders.get("movie-779-med-0").lastAccess, 0, "id prefix must not bleed into 779");
});

test("heartbeat never creates or touches a different title / other caller", () => {
  const { entry, streams, transcoders } = setup();
  let r = handleHeartbeat({ mode: "movie", id: 78 }, { streams, transcoders, callerOwner: "s:tok", callerIp: "192.168.0.214", now: MIN, maxMs: 60 * MIN });
  assert.deepEqual(r.body, { ok: true, kept: false, reason: "no-session" });
  r = handleHeartbeat({ mode: "series", id: 77 }, { streams, transcoders, callerOwner: "s:tok", callerIp: "192.168.0.214", now: MIN, maxMs: 60 * MIN });
  assert.equal(r.body.kept, false);
  r = handleHeartbeat({ mode: "movie", id: 77 }, { streams, transcoders, callerOwner: "s:tok", callerIp: "192.168.0.99", now: MIN, maxMs: 60 * MIN });
  assert.equal(r.body.kept, false);
  assert.equal(entry.lastSeen, 0);
  assert.equal(streams.size, 1);
});

test("heartbeat is capped by time since the last real media request", () => {
  const { entry, streams, transcoders } = setup();
  const ctx = { streams, transcoders, callerOwner: "s:tok", callerIp: "192.168.0.214", maxMs: 60 * MIN };
  assert.equal(handleHeartbeat({ mode: "movie", id: 77 }, { ...ctx, now: 60 * MIN }).body.kept, true);
  const r = handleHeartbeat({ mode: "movie", id: 77 }, { ...ctx, now: 60 * MIN + 1 });
  assert.deepEqual(r.body, { ok: true, kept: false, reason: "cap" });
  assert.equal(entry.lastSeen, 60 * MIN);
});

test("displaced session answers 410; live answers 400", () => {
  const { streams, transcoders } = setup({ owner: "s:tok", displaced: true });
  assert.equal(handleHeartbeat({ mode: "movie", id: 77 }, { streams, transcoders, callerOwner: "s:tok", callerIp: "x", now: 1, maxMs: MIN }).status, 410);
  assert.equal(handleHeartbeat({ mode: "live", id: 77 }, { streams, transcoders, callerOwner: "s:tok", callerIp: "x", now: 1, maxMs: MIN }).status, 400);
});

test("vodReachedEnd: resumed transcodes count their offset", () => {
  // The Dil Se shape: resumed at 1h40m, 47 min encoded, 160-min runtime.
  const r = vodReachedEnd({ offsetSecs: 6000, elapsedSecs: 3700, runtimeMin: 160 });
  assert.equal(r.done, true);
  assert.equal(r.by, "runtime");
  assert.equal(r.position, 9700);
  // Old (elapsed-only) behaviour would have said no — regression guard.
  assert.equal(vodReachedEnd({ offsetSecs: 0, elapsedSecs: 3700, runtimeMin: 160 }).done, false);
  // Mid-file drop just past the rounded runtime: not the end.
  assert.equal(vodReachedEnd({ offsetSecs: 6000, elapsedSecs: 3600 + 30, runtimeMin: 160 }).done, false);
});

test("vodReachedEnd: exact panel duration wins, with a small tolerance", () => {
  assert.deepEqual(vodReachedEnd({ offsetSecs: 600, elapsedSecs: 5396, durationSecs: 6000 }), { done: true, by: "duration", position: 5996 });
  assert.equal(vodReachedEnd({ offsetSecs: 600, elapsedSecs: 5300, durationSecs: 6000 }).done, false);
  assert.equal(vodReachedEnd({ offsetSecs: 0, elapsedSecs: 6000, durationSecs: "6000" }).done, true);
  // Bad inputs never declare an end.
  assert.equal(vodReachedEnd({ offsetSecs: 0, elapsedSecs: 100, durationSecs: 0, runtimeMin: null }).done, false);
  assert.equal(vodReachedEnd({ offsetSecs: NaN, elapsedSecs: 100, durationSecs: "x", runtimeMin: -3 }).done, false);
  assert.equal(vodReachedEnd().done, false);
});

test("noPacketsLabel: past end of file only right after a clean exit", () => {
  assert.equal(noPacketsLabel({ previousExitCode: 0, stderr: "Output file #0 does not contain any stream\nreceived no packets" }), "past end of file");
  assert.equal(noPacketsLabel({ previousExitCode: 0, stderr: "nothing was written into output file" }), "past end of file");
  assert.equal(noPacketsLabel({ previousExitCode: 1, stderr: "received no packets" }), "slot-held");
  assert.equal(noPacketsLabel({ previousExitCode: undefined, stderr: "received no packets" }), "slot-held");
  assert.equal(noPacketsLabel({ previousExitCode: 0, stderr: "Connection refused" }), "slot-held");
});

test("server.js wires the heartbeat and the offset-aware end check", () => {
  const src = fs.readFileSync(path.join(__dirname, "..", "server.js"), "utf8");
  assert.match(src, /app\.post\("\/api\/stream\/heartbeat"/);
  assert.match(src, /vodReachedEnd\(\{\s*offsetSecs,/);
  assert.doesNotMatch(src, /playlistElapsedSecs\(dir\) >= knownDurationSecs/);
});
