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

const { decideLiveHealth, applyLiveCheck, deadTtlMs, isPersistentDeadReason, manifestHasContent, LIVE_UNAVAILABLE } = require("../lib/live-audio-verdict");
const H = 3600e3, M = 60e3, NOW = 1e12;

test("health: no entry proceeds", () => {
  assert.equal(decideLiveHealth({ entry: undefined, now: NOW }).action, "proceed");
});
test("health: persistent dead honors per-reason TTL; retry bypasses; viewer skips check", () => {
  const d404 = { dead: true, dead_reason: "http-404", ts: NOW - 9 * M };
  assert.equal(decideLiveHealth({ entry: d404, now: NOW }).action, "unavailable");
  assert.equal(decideLiveHealth({ entry: { ...d404, ts: NOW - 11 * M }, now: NOW }).action, "check");
  const empty = { dead: true, dead_reason: "empty-playlist", ts: NOW - 30e3 };
  assert.equal(decideLiveHealth({ entry: empty, now: NOW }).action, "unavailable");
  assert.equal(decideLiveHealth({ entry: { ...empty, ts: NOW - 61e3 }, now: NOW }).action, "check");
  assert.equal(decideLiveHealth({ entry: d404, now: NOW, retry: true }).action, "check");
  assert.equal(decideLiveHealth({ entry: d404, now: NOW, retry: true, viewerActive: true }).action, "proceed");
  // viewerActive + dead + old: no network check, play
  assert.equal(decideLiveHealth({ entry: { ...d404, ts: NOW - 11 * M }, now: NOW, viewerActive: true }).action, "proceed");
  // viewerActive + dead + recent still 503 (no network call needed)
  assert.equal(decideLiveHealth({ entry: d404, now: NOW, viewerActive: true }).action, "unavailable");
});
test("health: dead with transient/legacy reason never 503s", () => {
  for (const r of ["timeout", "fetch-error", "http-403", "http-429", "http-502", undefined]) {
    assert.equal(decideLiveHealth({ entry: { dead: true, dead_reason: r, ts: NOW - 1000 }, now: NOW }).action, "check");
  }
});
test("dead reasons and TTLs", () => {
  assert.ok(["empty-playlist", "http-404", "http-410"].every(isPersistentDeadReason));
  assert.ok(!["timeout", "fetch-error", "http-403", "http-429", "http-500", "empty-manifest"].some(isPersistentDeadReason));
  assert.equal(deadTtlMs("http-404"), 10 * M);
  assert.equal(deadTtlMs("empty-playlist"), 60e3);
});
test("applyLiveCheck: persistent vs transient vs recovery", () => {
  const e = { audio_codec: "aac", browser_safe: true, dead: false, ts: 1 };
  const dead = applyLiveCheck(e, { alive: false, reason: "http-404" }, NOW);
  assert.equal(dead.kind, "dead"); assert.equal(dead.entry.dead, true); assert.equal(dead.entry.dead_reason, "http-404");
  for (const r of ["timeout", "fetch-error", "http-403", "http-429", "http-503", "empty-manifest"]) {
    const t = applyLiveCheck(e, { alive: false, reason: r }, NOW);
    assert.equal(t.kind, "inconclusive"); assert.equal(t.entry, e);
    assert.equal(applyLiveCheck(e, { alive: null, reason: r }, NOW).kind, "inconclusive");
  }
  assert.equal(applyLiveCheck({ ...e, dead: true, dead_reason: "http-404" }, { alive: null }, NOW).entry, undefined);
  const ok = applyLiveCheck(e, { alive: true }, NOW);
  assert.equal(ok.kind, "alive"); assert.equal(ok.entry.live_ts, NOW);
  assert.equal(applyLiveCheck({ ...e, dead: true, dead_reason: "http-404" }, { alive: true }, NOW).kind, "recovered");
});
test("health: alive stale >24h -> check, fresh proceeds, live_ts counts", () => {
  assert.equal(decideLiveHealth({ entry: { audio_codec: "aac", ts: NOW - 25 * H }, now: NOW }).action, "check");
  assert.equal(decideLiveHealth({ entry: { audio_codec: "aac", ts: NOW - 25 * H }, now: NOW, viewerActive: true }).action, "proceed");
  assert.equal(decideLiveHealth({ entry: { audio_codec: "aac", ts: NOW - 23 * H }, now: NOW }).action, "proceed");
  assert.equal(decideLiveHealth({ entry: { audio_codec: "aac", ts: NOW - 25 * H, live_ts: NOW - H }, now: NOW }).action, "proceed");
});
test("manifest content detection and 503 contract", () => {
  assert.equal(manifestHasContent("#EXTM3U\n#EXT-X-VERSION:3\n"), false);
  assert.equal(manifestHasContent("#EXTM3U\n#EXTINF:4.0,\nseg.ts\n"), true);
  assert.equal(manifestHasContent("#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=1\nv.m3u8\n"), true);
  assert.equal(manifestHasContent("#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=1\nhttp://x/rel/v.m3u8\n"), true); // master
  assert.equal(manifestHasContent("#EXTM3U\n#EXT-X-ENDLIST\n"), false);
  assert.equal(manifestHasContent("#EXTM3U\n#EXT-X-PART-INF:PART-TARGET=0.5\n#EXTINF:4.0,\na.ts\n#EXT-X-PART:DURATION=0.5,URI=\"p.ts\"\n"), true); // LL-HLS
  assert.equal(manifestHasContent("<html><body>Not found</body></html>"), false);
  assert.equal(manifestHasContent(undefined), false);
  assert.equal(LIVE_UNAVAILABLE.error, "channel_unavailable");
});

test("recent-stream: excludeOwner ignores own stream, respects other owners, ignores stale", () => {
  const { streamingRecently } = require("../lib/recent-stream");
  const now = 1e12;
  const mk = (o) => new Map(Object.entries(o));
  const own = mk({ "ip:a": { mode: "live", accountKey: "k", lastSeen: now - 1000 } });
  assert.equal(streamingRecently(own, null, 180e3, now, "ip:a"), false);
  assert.equal(streamingRecently(own, null, 180e3, now), true);
  const both = mk({ "ip:a": { mode: "live", accountKey: "k", lastSeen: now - 1000 }, "ip:b": { mode: "live", accountKey: "k", lastSeen: now - 5000 } });
  assert.equal(streamingRecently(both, null, 180e3, now, "ip:a"), true);
  const stale = mk({ "ip:a": { mode: "live", accountKey: "k", lastSeen: now - 1000 }, "ip:b": { mode: "live", accountKey: "k", lastSeen: now - 400e3 } });
  assert.equal(streamingRecently(stale, null, 180e3, now, "ip:a"), false);
});
