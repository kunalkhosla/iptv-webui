const test = require("node:test");
const assert = require("node:assert/strict");
const fp = require("../lib/fingerprint");

// Deterministic PRNG.
function rng(seed) { let x = seed >>> 0; return () => { x ^= x << 13; x >>>= 0; x ^= x >>> 17; x ^= x << 5; x >>>= 0; return x / 4294967296; }; }
const SR = fp.SAMPLE_RATE;
// "Theme": broadband (seeded noise with a gain that changes every 0.2 s) plus
// 2 tones whose pitches change every 0.4 s: the same seed = the same audio.
function theme(sec, seed) {
  const r = rng(seed); const n = Math.round(sec * SR); const out = new Float64Array(n);
  let f = [0, 0], g = 0.5;
  for (let i = 0; i < n; i++) {
    if (i % Math.round(0.4 * SR) === 0) f = [300 + r() * 1700, 300 + r() * 1700];
    if (i % Math.round(0.2 * SR) === 0) g = 0.1 + r() * 0.5;
    const t = i / SR;
    out[i] = g * (r() * 2 - 1) + 0.2 * Math.sin(2 * Math.PI * f[0] * t) + 0.2 * Math.sin(2 * Math.PI * f[1] * t);
  }
  return out;
}
function noise(sec, seed, amp) { const r = rng(seed); const n = Math.round(sec * SR); const o = new Float64Array(n); for (let i = 0; i < n; i++) o[i] = (r() * 2 - 1) * amp; return o; }
// Background (other content) with the theme inserted at `at` seconds.
function episode(totalSec, at, th, seed, gain = 1) {
  const bg = theme(totalSec, seed); // unrelated "music/dialogue"
  const nz = noise(totalSec, seed + 7, 0.05);
  const pcm = new Int16Array(bg.length);
  const s0 = Math.round(at * SR);
  for (let i = 0; i < bg.length; i++) {
    let v = 0.6 * bg[i] + nz[i];
    if (i >= s0 && i - s0 < th.length) v = gain * th[i - s0] + nz[i];
    pcm[i] = Math.max(-32767, Math.min(32767, Math.round(v * 12000)));
  }
  return pcm;
}

test("fingerprintPcm: rate and determinism", () => {
  const pcm = episode(20, 5, theme(5, 1), 2);
  const a = fp.fingerprintPcm(pcm), b = fp.fingerprintPcm(Buffer.from(pcm.buffer));
  assert.equal(a.length, Math.floor((pcm.length - fp.FRAME) / fp.HOP));
  assert.deepEqual([...a], [...b]);
  assert.equal(fp.fingerprintPcm(new Int16Array(10)).length, 0);
});

test("popcount32", () => {
  assert.equal(fp.popcount32(0), 0);
  assert.equal(fp.popcount32(0xffffffff), 32);
  assert.equal(fp.popcount32(0x80000001), 2);
});

test("findSharedSegment finds a shared 30 s theme at different offsets", () => {
  const th = theme(30, 99);
  const A = episode(180, 40, th, 11);
  const B = episode(180, 100, th, 23, 0.8); // quieter copy, different background
  const wa = fp.createWindow(0, 180); fp.placeHashes(wa, 0, fp.fingerprintPcm(A));
  const wb = fp.createWindow(0, 180); fp.placeHashes(wb, 0, fp.fingerprintPcm(B));
  const m = fp.findSharedSegment(wa, wb);
  assert.ok(m, "match expected");
  assert.ok(Math.abs(m.aStart - 40) <= 1.5 && Math.abs(m.aEnd - 70) <= 1.5, JSON.stringify(m));
  assert.ok(Math.abs(m.bStart - 100) <= 1.5 && Math.abs(m.bEnd - 130) <= 1.5, JSON.stringify(m));
  assert.ok(m.ber < 0.25);
});

test("findSharedSegment: unrelated audio -> null", () => {
  const A = episode(120, 10, theme(30, 1), 3);
  const B = episode(120, 10, theme(30, 2), 4);
  const wa = fp.createWindow(0, 120); fp.placeHashes(wa, 0, fp.fingerprintPcm(A));
  const wb = fp.createWindow(0, 120); fp.placeHashes(wb, 0, fp.fingerprintPcm(B));
  assert.equal(fp.findSharedSegment(wa, wb), null);
});

test("chunks placed out of order with gaps still match; times are absolute", () => {
  const th = theme(25, 5);
  const A = episode(200, 120, th, 31);
  const B = episode(200, 60, th, 41);
  // A captured as 4 s "segments", one missing early on, window starting at t0=100.
  const wa = fp.createWindow(100, 100);
  for (let t = 100; t < 200; t += 4) {
    if (t === 104) continue; // gap
    const seg = A.subarray(Math.round(t * SR), Math.round((t + 4) * SR));
    fp.placeHashes(wa, t, fp.fingerprintPcm(seg));
  }
  const wb = fp.createWindow(0, 200); fp.placeHashes(wb, 0, fp.fingerprintPcm(B));
  assert.ok(fp.coverageSec(wa) > 80 && fp.coverageSec(wa) < 100);
  const m = fp.findSharedSegment(wa, wb);
  assert.ok(m, "match expected");
  assert.ok(Math.abs(m.aStart - 120) <= 1.5 && Math.abs(m.aEnd - 145) <= 1.5, JSON.stringify(m));
  assert.ok(Math.abs(m.bStart - 60) <= 1.5, JSON.stringify(m));
});

test("serialize / deserialize round trip", () => {
  const w = fp.createWindow(12.5, 10);
  fp.placeHashes(w, 13, Uint32Array.from([1, 2, 0xffffffff, 4]));
  const o = JSON.parse(JSON.stringify(fp.serializeWindow(w)));
  const r = fp.deserializeWindow(o);
  assert.equal(r.t0, 12.5);
  assert.deepEqual([...r.hashes], [...w.hashes]);
  assert.deepEqual([...r.valid], [...w.valid]);
  assert.equal(fp.deserializeWindow({ t0: 0, n: 3, h: "AAAA" }), null); // length mismatch
  assert.equal(fp.deserializeWindow(null), null);
});
