const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { EventEmitter } = require("node:events");
const { PassThrough } = require("node:stream");
const { createMediaSidecar } = require("../lib/media-sidecar");
const { createTrickplayStore } = require("../lib/trickplay");
const { createMarkerStore } = require("../lib/marker-store");

function fakeJpeg() {
  const sof = Buffer.from([0xff, 0xc0, 0x00, 0x11, 0x08, 0x00, 0x88, 0x00, 0xf0, 0x03, 1, 0x22, 0, 2, 0x11, 1, 3, 0x11, 1]);
  return Buffer.concat([Buffer.from([0xff, 0xd8]), sof, Buffer.alloc(200), Buffer.from([0xff, 0xd9])]);
}
// Fake ffmpeg: records args; thumbnails -> a JPEG, audio -> 4 s of PCM noise,
// offline jobs -> hang until killed.
function fakeSpawn(calls) {
  return (bin, args) => {
    calls.push(args);
    const p = new EventEmitter();
    p.pid = 0;
    p.stdout = new PassThrough(); p.stderr = new PassThrough();
    let done = false;
    const finish = (code) => { if (done) return; done = true; p.stdout.end(); p.stderr.end(); setImmediate(() => p.emit("close", code)); };
    p.kill = () => finish(null);
    setImmediate(() => {
      if (args.includes("image2pipe")) { p.stdout.write(fakeJpeg()); finish(0); }
      else if (args.includes("s16le") && !args.some((a) => String(a).startsWith("/media"))) { const b = Buffer.alloc(5512 * 2 * 4); for (let i = 0; i < b.length; i += 2) b.writeInt16LE((Math.random() * 20000 - 10000) | 0, i); p.stdout.write(b); finish(0); }
      // offline: never finishes on its own
    });
    return p;
  };
}
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
// Poll until cond() holds (fails after timeoutMs) instead of a fixed delay.
async function waitFor(cond, timeoutMs = 5000) {
  const end = Date.now() + timeoutMs;
  while (!cond()) {
    if (Date.now() > end) throw new Error("waitFor: timed out");
    await wait(10);
  }
}

test("piggyback: thumbnails every ~interval and audio for episodes in a known series", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "sc-"));
  try {
    const dir = path.join(root, "tx"); fs.mkdirSync(dir);
    const pl = ["#EXTM3U"];
    for (let i = 0; i < 8; i++) { pl.push("#EXTINF:4,", `seg_${String(i).padStart(5, "0")}.ts`); fs.writeFileSync(path.join(dir, `seg_${String(i).padStart(5, "0")}.ts`), "x"); }
    fs.writeFileSync(path.join(dir, "index.m3u8"), pl.join("\n") + "\n");
    const calls = [];
    const trick = createTrickplayStore({ dir: path.join(root, "tp") });
    const markers = createMarkerStore({ dir: path.join(root, "mk"), saveDelayMs: 1 });
    const entry = {};
    const sc = createMediaSidecar({
      trickplay: trick, markers, spawnFn: fakeSpawn(calls), loadAvg: () => 0,
      listTranscodes: () => [{ entry, mode: "series", id: "77", dir, offsetSecs: 100 }],
      groupFor: () => ({ group: "series:5", season: 1 }),
    });
    sc.scan();
    await waitFor(() => trick.list("series", "77").times.length >= 3 && calls.some((a) => a.includes("s16le")));
    const thumbs = trick.list("series", "77").times;
    // segments at 100,104,...,128 -> thumbnails at 100, 112 (>= 9 s apart), 124
    assert.deepEqual(thumbs, [100, 112, 124]);
    assert.ok(calls.some((a) => a.includes("s16le") && a.some((x) => String(x).startsWith("concat:"))));
    // A second scan with no new segments queues nothing.
    const n = calls.length; sc.scan(); await wait(100);
    assert.equal(calls.length, n);
    assert.equal(sc.stats().errors, 0);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test("offline jobs wait for idle and are cancelled when a viewer starts", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "sc-"));
  try {
    let viewer = true;
    const calls = [];
    const sc = createMediaSidecar({
      trickplay: createTrickplayStore({ dir: path.join(root, "tp") }),
      markers: createMarkerStore({ dir: path.join(root, "mk") }),
      spawnFn: fakeSpawn(calls), loadAvg: () => 0,
      listTranscodes: () => [], groupFor: () => null, viewerActive: () => viewer,
    });
    assert.equal(sc.enqueueOffline({ kind: "offline-thumbs", key: "k1", mode: "disk", id: "1", file: "/media/a.mkv" }), true);
    assert.equal(sc.enqueueOffline({ kind: "offline-thumbs", key: "k1", mode: "disk", id: "1", file: "/media/a.mkv" }), false);
    await wait(50);
    assert.equal(calls.length, 0); // viewer active: not started
    viewer = false; sc.scan(); await waitFor(() => calls.length >= 1);
    assert.equal(calls.length, 1); // started
    viewer = true; await waitFor(() => sc.stats().offlineCancelled >= 1); // poll notices within ~1 s and kills it
    assert.equal(sc.stats().offlineCancelled, 1);
    assert.equal(sc.stats().offlineQueued, 1); // requeued
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
