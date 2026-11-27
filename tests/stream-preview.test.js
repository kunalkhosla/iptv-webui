const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const sp = require("../lib/stream-preview");

const MIN = 60_000;
const GRACE = 180_000;
const acct = "A";
const bg = (k) => k.startsWith("disk-download:") || k.startsWith("phone-download:");
const dd = (k) => k.startsWith("disk-download:");
const decide = (streams, signals, requester, now) => sp.decideAdmission({
  streams, signals, requester, accountKey: acct, now, idleGraceMs: GRACE, isBackgroundOwner: bg, isDiskDownloadOwner: dd,
});
const entry = (o = {}) => ({ mode: "movie", id: "1", accountKey: acct, lastSeen: 0, displaced: false, ...o });

test("admission: empty house is admitted", () => {
  assert.deepEqual(decide(new Map(), new Map(), "s:tv", 10 * MIN), { ok: true });
});

test("admission: any live viewer entry blocks, including Disk and a paused keep-alive", () => {
  const now = 10 * MIN;
  for (const e of [entry({ lastSeen: now - 1000 }), entry({ mode: "disk", lastSeen: now - 1000 }), entry({ lastSeen: now - 170_000 })]) {
    assert.equal(decide(new Map([["ip:1.2.3.4:aa", e]]), new Map(), "s:tv", now).ok, false);
  }
  // The requester's own media entries are not exempt (ip owners are ambiguous).
  assert.equal(decide(new Map([["s:tv", entry({ lastSeen: now })]]), new Map(), "s:tv", now).ok, false);
});

test("admission: stale, displaced, other-account, preview and Save-to-Disk entries do not block", () => {
  const now = 10 * MIN;
  const streams = new Map([
    ["ip:a", entry({ lastSeen: now - GRACE - 1 })],
    ["ip:b", entry({ lastSeen: now, displaced: true })],
    ["ip:c", entry({ lastSeen: now, accountKey: "B" })],
    ["preview:p0123456789abcdef", entry({ lastSeen: now, preview: true })],
    ["disk-download:1", entry({ lastSeen: now })],
  ]);
  assert.deepEqual(decide(streams, new Map(), "s:tv", now), { ok: true });
});

test("admission: a phone download blocks (reason download)", () => {
  const now = 10 * MIN;
  assert.deepEqual(decide(new Map([["phone-download:x", entry({ lastSeen: now })]]), new Map(), "s:tv", now), { ok: false, reason: "download" });
});

test("signals: another device's VOD play / progress / heartbeat blocks for 3 min", () => {
  const sig = new Map();
  sp.noteSignal(sig, "s:phone", "play-vod", 0);
  assert.equal(decide(new Map(), sig, "s:tv", 2 * MIN).ok, false);
  assert.equal(decide(new Map(), sig, "s:tv", 3 * MIN + 1).ok, true);
  sp.noteSignal(sig, "s:phone", "activity", 5 * MIN);
  assert.equal(decide(new Map(), sig, "s:tv", 7 * MIN).ok, false);
  assert.equal(decide(new Map(), sig, "s:tv", 9 * MIN).ok, true);
});

test("signals: the requester's own older signals don't block it", () => {
  const sig = new Map();
  sp.noteSignal(sig, "s:tv", "play-vod", 0);
  sp.noteSignal(sig, "s:tv2", "play-vod", 0);
  assert.equal(decide(new Map(), sig, "s:tv", 20_000).ok, false); // tv2's
  assert.equal(decide(new Map(), new Map([["s:tv", sig.get("s:tv")]]), "s:tv", 20_000).ok, true);
});

test("signals: the requester's own very recent play blocks it (direct play leaves no streams entry)", () => {
  const sig = new Map();
  sp.noteSignal(sig, "s:tv", "play-vod", 0);
  assert.deepEqual(decide(new Map(), sig, "s:tv", 1000), { ok: false, reason: "viewer" });
  assert.equal(decide(new Map(), sig, "s:tv", sp.OWN_GRACE_MS - 1).ok, false);
  assert.equal(decide(new Map(), sig, "s:tv", sp.OWN_GRACE_MS).ok, true);
  // Own progress / heartbeat counts the same way.
  sp.noteSignal(sig, "s:tv", "activity", 100_000);
  assert.equal(decide(new Map(), sig, "s:tv", 105_000).ok, false);
  assert.equal(decide(new Map(), sig, "s:tv", 100_000 + sp.OWN_GRACE_MS).ok, true);
});

test("signals: the requester's own un-ended live play blocks it for OWN_LIVE_GRACE_MS", () => {
  const sig = new Map();
  sp.noteSignal(sig, "s:tv", "play-live", 0);
  assert.deepEqual(decide(new Map(), sig, "s:tv", 1000), { ok: false, reason: "live-viewer" });
  assert.equal(decide(new Map(), sig, "s:tv", sp.OWN_LIVE_GRACE_MS - 1).ok, false);
  assert.equal(decide(new Map(), sig, "s:tv", sp.OWN_LIVE_GRACE_MS).ok, true);
  // Ended (health report past the race window): only the short grace applies.
  const sig2 = new Map();
  sp.noteSignal(sig2, "s:tv", "play-live", 0);
  sp.noteSignal(sig2, "s:tv", "live-end", 11_000);
  assert.equal(decide(new Map(), sig2, "s:tv", 12_000).ok, false);
  assert.equal(decide(new Map(), sig2, "s:tv", 20_000).ok, true);
});

test("signals: a live play on another device blocks until its health report (session end)", () => {
  const sig = new Map();
  sp.noteSignal(sig, "s:phone", "play-live", 0);
  assert.deepEqual(decide(new Map(), sig, "s:tv", 60 * MIN), { ok: false, reason: "live-viewer" });
  // A report racing the play (zap) is the previous session's: ignored.
  sp.noteSignal(sig, "s:phone", "live-end", 5_000);
  assert.equal(decide(new Map(), sig, "s:tv", 60 * MIN).ok, false);
  sp.noteSignal(sig, "s:phone", "live-end", 61 * MIN);
  assert.equal(decide(new Map(), sig, "s:tv", 62 * MIN).ok, true);
  // A new live play re-arms it.
  sp.noteSignal(sig, "s:phone", "play-live", 63 * MIN);
  assert.equal(decide(new Map(), sig, "s:tv", 64 * MIN).ok, false);
});

test("signals: progress / heartbeat never drop an un-ended live hold", () => {
  const sig = new Map();
  sp.noteSignal(sig, "s:phone", "play-live", 0);
  sp.noteSignal(sig, "s:phone", "activity", 60_000);
  assert.equal(decide(new Map(), sig, "s:tv", 30 * MIN).ok, false);
  sp.noteSignal(sig, "s:phone", "live-end", 40 * MIN);
  sp.noteSignal(sig, "s:phone", "activity", 41 * MIN);
  assert.equal(decide(new Map(), sig, "s:tv", 43 * MIN).ok, false);
  assert.equal(decide(new Map(), sig, "s:tv", 45 * MIN).ok, true);
});

test("signals: an unreported live play stops blocking after the 3 h cap", () => {
  const sig = new Map();
  sp.noteSignal(sig, "s:web", "play-live", 0);
  assert.equal(decide(new Map(), sig, "s:tv", sp.LIVE_HOLD_MS - 1).ok, false);
  assert.equal(decide(new Map(), sig, "s:tv", sp.LIVE_HOLD_MS + 1).ok, true);
});

test("signals: preview owners and empty owners are ignored; map stays bounded", () => {
  const sig = new Map();
  sp.noteSignal(sig, "preview:p0", "play-vod", 0);
  sp.noteSignal(sig, "", "play-vod", 0);
  assert.equal(sig.size, 0);
  for (let i = 0; i < 600; i++) sp.noteSignal(sig, `s:${i}`, "play-vod", i < 300 ? 0 : 4 * 3600_000);
  assert.ok(sig.size <= 501, String(sig.size));
});

test("previewStartSecs: resume point, else ~10 % (60 s .. 15 min), 5 min when unknown", () => {
  assert.equal(sp.previewStartSecs({ progressSecs: 1234.6, durationSecs: 6000 }), 1234);
  assert.equal(sp.previewStartSecs({ progressSecs: 30, durationSecs: 6000 }), 600);
  assert.equal(sp.previewStartSecs({ progressSecs: 5900, durationSecs: 6000 }), 600); // near the end
  assert.equal(sp.previewStartSecs({ durationSecs: 6000 }), 600);
  assert.equal(sp.previewStartSecs({ durationSecs: 300 }), 60);
  assert.equal(sp.previewStartSecs({ durationSecs: 20000 }), 900);
  assert.equal(sp.previewStartSecs({}), 300);
  assert.equal(sp.previewStartSecs({ progressSecs: 700 }), 700);
});

test("pickSeriesEpisode: continue pointer, else S1E1 (specials last), skips bad ids", () => {
  const info = { episodes: {
    "0": [{ id: "900", episode_num: 1, container_extension: "mkv" }],
    "2": [{ id: "21", episode_num: 1 }, { id: "22", episode_num: 2, info: { duration_secs: 2500 } }],
    "1": [{ id: "12", episode_num: 2 }, { id: "11", episode_num: 1, container_extension: "MKV", info: { duration_secs: 2700 } }, { id: "x;1", episode_num: 3 }],
  } };
  assert.deepEqual(sp.pickSeriesEpisode(info, null), { id: "11", season: 1, episodeNum: 1, ext: "mkv", durationSecs: 2700 });
  assert.equal(sp.pickSeriesEpisode(info, { episode_id: 22 }).id, "22");
  assert.equal(sp.pickSeriesEpisode(info, { episode_id: "999" }).id, "11");
  assert.equal(sp.pickSeriesEpisode({ episodes: { "0": [{ id: "5" }] } }, null).id, "5");
  assert.equal(sp.pickSeriesEpisode(null, null), null);
  assert.equal(sp.pickSeriesEpisode({ episodes: {} }, null), null);
});

test("sids + ffmpeg args", () => {
  const sid = sp.newSid((n) => "ab".repeat(n));
  assert.equal(sid, "pabababababababab");
  assert.ok(sp.isValidSid(sid));
  for (const bad of ["", "p123", "P0123456789abcdef", "p0123456789abcdeg", null, 5, "p0123456789abcdef0"]) assert.equal(sp.isValidSid(bad), false);
  const a = sp.previewFfmpegArgs({ sourceUrl: "http://x/y.mkv", startSecs: 600.7, durationSecs: 90, audioTrack: 2, dir: "/tmp/d" });
  const s = a.join(" ");
  assert.match(s, /-ss 600 -i http:\/\/x\/y\.mkv -t 90 /);
  assert.match(s, /-map 0:a:2\?/);
  assert.match(s, /-threads 2 -filter_threads 1 .*libx264/);
  assert.match(s, /-c:a aac -ac 2/);
  assert.ok(s.endsWith("/tmp/d/index.m3u8"));
  assert.ok(!a.includes("-readrate"));
  const h = sp.previewFfmpegArgs({ sourceUrl: "u", startSecs: 0, durationSecs: 90, hw: true, vaapiDevice: "/dev/dri/renderD128", dir: "/d" }).join(" ");
  assert.match(h, /-hwaccel vaapi/);
  assert.match(h, /h264_vaapi/);
  assert.ok(!h.includes("-ss"));
});

test("server wiring: preview never counts as a viewer and anything real stops it", () => {
  const src = fs.readFileSync(path.join(__dirname, "..", "server.js"), "utf8");
  // Real play requests stop previews before the player starts.
  assert.match(src, /const previewGone = req\.params\.mode === "disk" \? stopPreviews\("play disk"\)\n\s*: previewViewerActivity\(ownerKeyOf\(req\), req\.params\.mode === "live" \? "play-live" : "play-vod"\);\n\s*if \(previewGone\) await previewGone;/);
  assert.ok(src.indexOf("const previewGone = previewViewerActivity") < src.indexOf("const direct = streamUrl(req.params.mode, req.params.id, req.params.ext);"));
  // Any real admission stops a preview; previews never count against the cap.
  assert.match(src, /if \(!diskDlSchedule\.isDiskDownloadOwner\(owner\)\) stopPreviews\(`admit \$\{mode\}`\);/);
  assert.match(src, /!v\.displaced && !v\.preview\) sameAccount\.push/);
  // /api/streams: previews excluded from `active`.
  assert.match(src, /active: list\.filter\(\(x\) => !x\.background && !x\.preview\)\.length/);
  // Progress + heartbeat + live-health hooks.
  assert.match(src, /previewViewerActivity\(ownerKeyOf\(req\), "progress"\)/);
  assert.match(src, /if \(pauseKeepalive\.parseHeartbeat\(req\.body\)\.ok\) previewViewerActivity\(ownerKeyOf\(req\), "heartbeat"\)/);
  // A real play during the preview request's awaits makes it give up.
  assert.match(src, /if \(previewPlayEpoch !== epoch0\) \{ res\.status\(409\)/);
  // A phone download waits for the preview's ffmpeg to exit first.
  assert.match(src, /const previewGone = stopPreviews\("phone download"\);\n\s*if \(previewGone\) \{ await previewGone; continue; \}/);
  assert.match(src, /streamPreview\.noteSignal\(previewSignals, ok, "live-end", now\)/);
  // The preview route writes no history / progress / recents.
  const route = src.slice(src.indexOf('app.get("/api/preview/:mode(movie|series)'), src.indexOf('app.post("/api/preview/stop"'));
  assert.ok(route.length > 500);
  for (const w of ["scheduleUserStateSave", "pushRecent", "recents", "lastEpisode[", "userState.progress["]) assert.ok(!route.includes(w), w);
  // A stale request (abandoned / superseded / play started) gives up after the
  // series-info await, after each gap sleep, before stopping the current
  // preview or preempting Save to Disk, after each replaced-stop, and at claim.
  const at = (needle, from = 0) => { const i = route.indexOf(needle, from); assert.ok(i >= 0, needle); return i; };
  const bails = []; for (let i = route.indexOf("if (bailIfStale()) return;"); i >= 0; i = route.indexOf("if (bailIfStale()) return;", i + 1)) bails.push(i);
  const infoAwait = at("await infoStore.get(infoKey)");
  const replaced = at('stopPreviews("replaced")');
  const preempt = at('preemptDiskDownloadsForViewer("preview")');
  const claim = at("const sid = streamPreview.newSid(");
  assert.ok(bails.some((b) => b > infoAwait && b < at("for (let gap;")), "after info await");
  assert.ok(bails.some((b) => b > at("for (let gap;") && b < replaced - 200 && b > infoAwait), "before replaced loop");
  assert.ok(bails.some((b) => b > replaced && b < preempt), "inside replaced loop");
  assert.ok(bails.some((b) => b > preempt && b < claim), "before claim");
  assert.ok(route.includes("seq !== previewReqSeq") && route.includes("previewPlayEpoch !== epoch0"));
  // Media routes are registered before the auth middleware (cookie-less players).
  assert.ok(src.indexOf('app.get("/api/preview/:sid(p[0-9a-f]{16})/index.m3u8"') < src.indexOf("app.use((req, res, next) => {\n  if (PUBLIC_PATHS.has(req.path))"));
});
