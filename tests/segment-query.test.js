// Regression: HLS segment URLs must carry every param transcoderKey() keys
// on, notably &at=, or the segment route resolves the "-at0" transcoder and
// 404s for any transcode with audio track > 0. Plus a static scan that the
// probes are guarded by the single-connection check.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { segmentQuery } = require("../lib/segment-query");

test("segment query carries at for alternate audio track", () => {
  const q = new URLSearchParams(segmentQuery({ quality: "720", offsetSecs: 30, audio: "surround", diskSel: { a: 2, s: 1 }, audioTrack: 2 }));
  assert.equal(q.get("q"), "720");
  assert.equal(q.get("t"), "30");
  assert.equal(q.get("a"), "surround");
  assert.equal(q.get("da"), "2");
  assert.equal(q.get("ds"), "1");
  assert.equal(q.get("at"), "2");
});

test("segment query omits at for default track", () => {
  assert.equal(segmentQuery({ quality: "auto", audioTrack: 0 }), "q=auto");
});

const src = fs.readFileSync(path.join(__dirname, "..", "server.js"), "utf8");

test("server uses segmentQuery and guards probes", () => {
  assert.match(src, /const qq = segmentQuery\(\{/);
  assert.match(src, /if \(panelProbeBusy\(actx\)\) return Promise\.resolve\(\{ audioTracks: \[\] \}\)/);
  assert.match(src, /!isProbeFresh\(verdict\) && panelTracksProbeInflight\.size === 0 && audioProbeInflight\.size === 0/);
});
