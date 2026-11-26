const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const ma = require("../lib/media-analysis");
const { createMarkerStore } = require("../lib/marker-store");
const { createTrickplayStore, jpegSize } = require("../lib/trickplay");
const fp = require("../lib/fingerprint");

test("parsePlaylist: segments, start times, ENDLIST, rejects paths", () => {
  const text = "#EXTM3U\n#EXT-X-VERSION:3\n#EXT-X-TARGETDURATION:5\n#EXTINF:4.004000,\nseg_00000.ts\n#EXTINF:3.5,\nseg_00001.ts\n#EXTINF:4,\n../etc/seg_00002.ts\n#EXTINF:4,\nseg_00003.ts\n#EXT-X-ENDLIST\n";
  const r = ma.parsePlaylist(text);
  assert.equal(r.ended, true);
  assert.deepEqual(r.segments.map((s) => s.n), [0, 1, 3]);
  assert.equal(r.segments[1].start, 4.004);
  assert.equal(r.segments[2].start, 7.504);
  assert.deepEqual(ma.parsePlaylist("#EXTM3U\n#EXTINF:4,\nseg_00000.ts\n").ended, false);
  assert.deepEqual(ma.parsePlaylist(null).segments, []);
});

test("thumbWanted / hasNear / insertSorted", () => {
  const times = [0, 10, 20];
  assert.equal(ma.thumbWanted(times, 12, 10), null);
  assert.equal(ma.thumbWanted(times, 26.4, 10), 26);
  ma.insertSorted(times, 15); ma.insertSorted(times, 15);
  assert.deepEqual(times, [0, 10, 15, 20]);
});

test("batchSegments splits at gaps and at maxSec", () => {
  const segs = [0, 1, 2, 3, 5, 6].map((n) => ({ n, dur: 4 }));
  const b = ma.batchSegments(segs, 10);
  assert.deepEqual(b.map((x) => x.map((s) => s.n)), [[0, 1], [2, 3], [5, 6]]);
});

test("consensus picks the biggest agreeing cluster", () => {
  const c = ma.consensus([{ start: 100, end: 130 }, { start: 101, end: 131 }, { start: 300, end: 320 }, { start: 99.5, end: 129 }]);
  assert.equal(c.support, 3);
  assert.equal(c.start, 100);
  assert.equal(c.end, 130);
  assert.equal(ma.consensus([]), null);
});

test("markersFromEvidence: single comparison needs a clean match; credits late only", () => {
  const clean = { a: { intro: { start: 50, end: 80, ber: 0.1 }, credits: { start: 2500, ber: 0.05 } } };
  const m = ma.markersFromEvidence(clean, 2600);
  assert.equal(m.introStart, 50); assert.equal(m.introEnd, 80); assert.equal(m.creditsStart, 2500);
  assert.equal(m.recapStart, null);
  const noisy = { a: { intro: { start: 50, end: 80, ber: 0.3 }, credits: null } };
  assert.equal(ma.markersFromEvidence(noisy, 2600).introStart, null);
  const two = { a: { intro: { start: 50, end: 80, ber: 0.3 } }, b: { intro: { start: 51, end: 81, ber: 0.29 } } };
  assert.equal(ma.markersFromEvidence(two, 2600).support.intro, 2);
  // Credits in the first half of the episode are not trusted.
  assert.equal(ma.markersFromEvidence({ a: { credits: { start: 500, ber: 0.01 } } }, 2600).creditsStart, null);
  // Too long to be an intro.
  assert.equal(ma.markersFromEvidence({ a: { intro: { start: 0, end: 400, ber: 0.01 } } }, 2600).introStart, null);
});

// A tiny valid JPEG header: SOI + SOF0 (h=136, w=240) + EOI, padded.
function fakeJpeg() {
  const sof = Buffer.from([0xff, 0xc0, 0x00, 0x11, 0x08, 0x00, 0x88, 0x00, 0xf0, 0x03, 1, 0x22, 0, 2, 0x11, 1, 3, 0x11, 1]);
  return Buffer.concat([Buffer.from([0xff, 0xd8]), sof, Buffer.alloc(200), Buffer.from([0xff, 0xd9])]);
}

test("jpegSize reads SOF dimensions", () => {
  assert.deepEqual(jpegSize(fakeJpeg()), { width: 240, height: 136 });
  assert.equal(jpegSize(Buffer.from("nope")), null);
});

test("trickplay store: put/list/filePath/complete/evict", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tp-"));
  try {
    const st = createTrickplayStore({ dir, maxBytes: 300 });
    assert.equal(st.put("movie", "12", 20, fakeJpeg()), true);
    assert.equal(st.put("movie", "12", 0, fakeJpeg()), true);
    assert.equal(st.put("movie", "12", 5, Buffer.from("not a jpeg, definitely not a jpeg at all".repeat(5))), false);
    assert.equal(st.put("live", "12", 0, fakeJpeg()), false);
    assert.equal(st.put("movie", "../x", 0, fakeJpeg()), false);
    const l = st.list("movie", "12");
    assert.deepEqual(l.times, [0, 20]);
    assert.deepEqual(l.size, { width: 240, height: 136 });
    assert.ok(st.filePath("movie", "12", "20"));
    assert.equal(st.filePath("movie", "12", "21"), null);
    assert.equal(st.filePath("movie", "12", "../../etc/passwd"), null);
    st.markComplete("movie", "12");
    assert.equal(st.list("movie", "12").complete, true);
    // A fresh store reads the same from disk.
    const st2 = createTrickplayStore({ dir });
    assert.deepEqual(st2.list("movie", "12").times, [0, 20]);
    assert.equal(st2.list("movie", "12").complete, true);
    const r = st.evict(); // 2 x ~221 B > 300 B -> the title goes
    assert.equal(r.removed, 1);
    assert.deepEqual(st.list("movie", "12").times, []);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test("marker store: windows persist, comparisons update both episodes", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mk-"));
  try {
    const st = createMarkerStore({ dir, saveDelayMs: 1 });
    // Synthetic hashes: a shared 30 s block at 100 s in A and 40 s in B.
    let x = 12345;
    const rnd = () => { x ^= x << 13; x >>>= 0; x ^= x >>> 17; x ^= x << 5; x >>>= 0; return x; };
    const shared = Uint32Array.from({ length: Math.round(30 * fp.RATE) }, rnd);
    const mk = (at) => {
      const w = fp.createWindow(0, 600);
      fp.placeHashes(w, 0, Uint32Array.from({ length: w.hashes.length }, rnd));
      fp.placeHashes(w, at, shared);
      return w;
    };
    st.putWindows("series:1", { group: "series:9", season: 1, dur: 2400, head: mk(100) });
    st.putWindows("series:2", { group: "series:9", season: 1, dur: 2400, head: mk(40) });
    st.putWindows("series:3", { group: "series:8", season: 1, dur: 2400, head: mk(40) }); // other show
    assert.deepEqual(st.peers("series:1"), ["series:2"]);
    const m = st.analyse("series:1");
    assert.ok(Math.abs(m.introStart - 100) <= 1 && Math.abs(m.introEnd - 130) <= 1, JSON.stringify(m));
    const m2 = st.get("series:2").markers;
    assert.ok(Math.abs(m2.introStart - 40) <= 1 && Math.abs(m2.introEnd - 70) <= 1, JSON.stringify(m2));
    assert.equal(st.get("series:3").markers, null);
    st.saveNow();
    const again = createMarkerStore({ dir });
    assert.ok(again.get("series:1").markers.introStart != null);
    assert.ok(again.loadWindows("series:2").head);
    assert.equal(again.get("bogus:1"), null);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
