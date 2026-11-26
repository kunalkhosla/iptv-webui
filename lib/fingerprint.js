// Audio fingerprints for intro / credits detection (pure, no I/O).
//
// Input is mono signed 16-bit PCM at SAMPLE_RATE (ffmpeg: -ac 1 -ar 5512
// -f s16le). Each hop of audio yields one 32-bit sub-fingerprint in the
// style of Haitsma & Kalker ("Philips" fingerprint): the energies of 33
// log-spaced bands between 300 and 2000 Hz, and bit m is the sign of the
// change (over time) of the energy difference between bands m and m+1.
// The same audio re-encoded (different AAC encoder / bitrate / loudness)
// keeps most bits; unrelated audio differs in ~half of them.
//
// Matching two windows (e.g. the first 10 minutes of two episodes of a
// season) finds the time offset at which many sub-fingerprints coincide,
// then the longest stretch at that offset where the bit error rate stays
// low: that stretch is audio both episodes share (the intro theme, or the
// end-credits music).

const SAMPLE_RATE = 5512;
const FRAME = 1024;
const HOP = 256;
const HOP_SEC = HOP / SAMPLE_RATE; // ~0.0464 s
const RATE = 1 / HOP_SEC;          // ~21.5 sub-fingerprints / s
const BANDS = 33;
const F_LO = 300;
const F_HI = 2000;

// ---- FFT (radix-2, in place) ----
const fftCache = new Map();
function fftTables(n) {
  let t = fftCache.get(n);
  if (t) return t;
  const rev = new Uint32Array(n);
  const bits = Math.log2(n);
  for (let i = 0; i < n; i++) {
    let r = 0;
    for (let b = 0; b < bits; b++) r |= ((i >> b) & 1) << (bits - 1 - b);
    rev[i] = r;
  }
  const cos = new Float64Array(n / 2), sin = new Float64Array(n / 2);
  for (let i = 0; i < n / 2; i++) { cos[i] = Math.cos(-2 * Math.PI * i / n); sin[i] = Math.sin(-2 * Math.PI * i / n); }
  const win = new Float64Array(n);
  for (let i = 0; i < n; i++) win[i] = 0.5 - 0.5 * Math.cos(2 * Math.PI * i / (n - 1));
  t = { rev, cos, sin, win };
  fftCache.set(n, t);
  return t;
}
function fft(re, im) {
  const n = re.length;
  const { rev, cos, sin } = fftTables(n);
  for (let i = 0; i < n; i++) {
    const j = rev[i];
    if (j > i) { let x = re[i]; re[i] = re[j]; re[j] = x; x = im[i]; im[i] = im[j]; im[j] = x; }
  }
  for (let size = 2; size <= n; size <<= 1) {
    const half = size >> 1, step = n / size;
    for (let start = 0; start < n; start += size) {
      for (let k = 0; k < half; k++) {
        const wr = cos[k * step], wi = sin[k * step];
        const a = start + k, b = a + half;
        const tr = re[b] * wr - im[b] * wi, ti = re[b] * wi + im[b] * wr;
        re[b] = re[a] - tr; im[b] = im[a] - ti;
        re[a] += tr; im[a] += ti;
      }
    }
  }
}

// Band edges as FFT bin indices (log-spaced, BANDS bands).
const BAND_EDGES = (() => {
  const edges = [];
  for (let m = 0; m <= BANDS; m++) {
    const f = F_LO * Math.pow(F_HI / F_LO, m / BANDS);
    edges.push(Math.round(f * FRAME / SAMPLE_RATE));
  }
  return edges;
})();

// PCM (Int16Array, or a Buffer of s16le) -> Uint32Array of sub-fingerprints.
// Sub-fingerprint k covers samples [k*HOP, k*HOP+FRAME). The first frame has
// no predecessor, so it is dropped: output index k describes the frame that
// starts at (k+1)*HOP samples. Silence (all bands ~0) hashes to 0.
function toInt16(pcm) {
  if (pcm instanceof Int16Array) return pcm;
  if (Buffer.isBuffer(pcm)) {
    const n = Math.floor(pcm.length / 2);
    const out = new Int16Array(n);
    for (let i = 0; i < n; i++) out[i] = pcm.readInt16LE(i * 2);
    return out;
  }
  throw new TypeError("pcm must be Int16Array or Buffer");
}
function fingerprintPcm(pcm) {
  const s = toInt16(pcm);
  const frames = s.length >= FRAME ? Math.floor((s.length - FRAME) / HOP) + 1 : 0;
  if (frames < 2) return new Uint32Array(0);
  const { win } = fftTables(FRAME);
  const re = new Float64Array(FRAME), im = new Float64Array(FRAME);
  let prev = null;
  const out = new Uint32Array(frames - 1);
  const cur = new Float64Array(BANDS);
  for (let f = 0; f < frames; f++) {
    const off = f * HOP;
    for (let i = 0; i < FRAME; i++) { re[i] = s[off + i] * win[i]; im[i] = 0; }
    fft(re, im);
    for (let m = 0; m < BANDS; m++) {
      let e = 0;
      for (let k = BAND_EDGES[m]; k < BAND_EDGES[m + 1]; k++) e += re[k] * re[k] + im[k] * im[k];
      cur[m] = e;
    }
    if (prev) {
      let h = 0;
      for (let m = 0; m < 32; m++) {
        const d = (cur[m] - cur[m + 1]) - (prev[m] - prev[m + 1]);
        if (d > 0) h |= (1 << m);
      }
      out[f - 1] = h >>> 0;
    } else {
      prev = new Float64Array(BANDS);
    }
    prev.set(cur);
  }
  return out;
}

function popcount32(x) {
  x = x - ((x >>> 1) & 0x55555555);
  x = (x & 0x33333333) + ((x >>> 2) & 0x33333333);
  return (((x + (x >>> 4)) & 0x0f0f0f0f) * 0x01010101) >>> 24;
}

// A fingerprint "window" is { t0, hashes: Uint32Array, valid: Uint8Array }:
// hashes[i] describes time t0 + i*HOP_SEC; valid[i]=0 marks a gap (part of the
// window that was never captured). createWindow/placeHashes build one from
// out-of-order chunks (e.g. HLS segments decoded separately).
function createWindow(t0, durSec) {
  const n = Math.max(0, Math.ceil(durSec * RATE));
  return { t0, hashes: new Uint32Array(n), valid: new Uint8Array(n) };
}
function placeHashes(win, chunkStartSec, hashes) {
  // hashes[k] describes the frame starting (k+1)*HOP samples into the chunk.
  const base = Math.round((chunkStartSec - win.t0) * RATE) + 1;
  let placed = 0;
  for (let k = 0; k < hashes.length; k++) {
    const i = base + k;
    if (i < 0 || i >= win.hashes.length) continue;
    win.hashes[i] = hashes[k];
    win.valid[i] = 1;
    placed++;
  }
  return placed;
}
function coverageSec(win) {
  let n = 0;
  for (let i = 0; i < win.valid.length; i++) n += win.valid[i];
  return n / RATE;
}

// Serialization (for persistence): base64 of the hashes + a run-length list of
// valid ranges [[start,len],...].
function serializeWindow(win) {
  const ranges = [];
  let i = 0;
  while (i < win.valid.length) {
    if (!win.valid[i]) { i++; continue; }
    const s = i;
    while (i < win.valid.length && win.valid[i]) i++;
    ranges.push([s, i - s]);
  }
  return { t0: win.t0, n: win.hashes.length, ranges, h: Buffer.from(win.hashes.buffer, win.hashes.byteOffset, win.hashes.byteLength).toString("base64") };
}
function deserializeWindow(o) {
  if (!o || typeof o.h !== "string" || !Number.isFinite(o.n) || !Number.isFinite(o.t0)) return null;
  const buf = Buffer.from(o.h, "base64");
  if (buf.length !== o.n * 4) return null;
  const hashes = new Uint32Array(o.n);
  for (let i = 0; i < o.n; i++) hashes[i] = buf.readUInt32LE(i * 4);
  const valid = new Uint8Array(o.n);
  for (const r of o.ranges || []) {
    if (!Array.isArray(r)) continue;
    const [s, len] = r;
    for (let i = Math.max(0, s); i < Math.min(o.n, s + len); i++) valid[i] = 1;
  }
  return { t0: o.t0, hashes, valid };
}

// Find the longest stretch of shared audio between windows a and b.
// Returns null or { aStart, aEnd, bStart, bEnd, ber, votes } (seconds,
// absolute: window t0 included). Options:
//   minSec: shortest stretch that counts (default 15)
//   maxBer: bit error rate (0..1) a stretch must stay under, after smoothing
//   smoothSec: smoothing window for the per-frame bit error rate
//   candidates: how many top offsets to verify
//   maxGapSec: a run may bridge short noisy dips (dialogue over the theme)
function findSharedSegment(a, b, opts = {}) {
  const minSec = opts.minSec ?? 15;
  const maxBer = opts.maxBer ?? 0.32;
  const smoothSec = opts.smoothSec ?? 2;
  const nCand = opts.candidates ?? 6;
  const maxGapSec = opts.maxGapSec ?? 3;
  const A = a.hashes, B = b.hashes, Av = a.valid, Bv = b.valid;
  if (!A.length || !B.length) return null;
  // Index b by the top 20 bits: tolerant of bit errors in the low (high
  // frequency) bands, rare enough that chance collisions stay negligible.
  const KEY_SHIFT = 12;
  const index = new Map();
  for (let j = 0; j < B.length; j++) {
    if (!Bv[j] || B[j] === 0) continue;
    const k = B[j] >>> KEY_SHIFT;
    const arr = index.get(k);
    if (arr) { if (arr.length < 64) arr.push(j); } else index.set(k, [j]);
  }
  // Vote on offsets d = j - i. Shift so it can index an array.
  const span = A.length + B.length;
  const votes = new Uint32Array(span);
  for (let i = 0; i < A.length; i++) {
    if (!Av[i] || A[i] === 0) continue;
    const arr = index.get(A[i] >>> KEY_SHIFT);
    if (!arr) continue;
    for (const j of arr) votes[j - i + A.length]++;
  }
  // Pick peaks (merge +-2 neighbors).
  const cands = [];
  const taken = new Uint8Array(span);
  for (let c = 0; c < nCand; c++) {
    let best = -1, bv = 2;
    for (let d = 0; d < span; d++) {
      if (taken[d]) continue;
      const v = votes[d] + (d > 0 ? votes[d - 1] : 0) + (d + 1 < span ? votes[d + 1] : 0);
      if (v > bv) { bv = v; best = d; }
    }
    if (best < 0) break;
    for (let d = Math.max(0, best - 3); d <= Math.min(span - 1, best + 3); d++) taken[d] = 1;
    cands.push({ off: best - A.length, votes: bv });
  }
  const smoothN = Math.max(1, Math.round(smoothSec * RATE));
  const minN = Math.round(minSec * RATE);
  const gapN = Math.round(maxGapSec * RATE);
  let bestRun = null;
  for (const { off, votes: v } of cands) {
    // Try the exact offset and +-1 (frame alignment of separately decoded audio).
    for (const d of [off, off - 1, off + 1]) {
      const i0 = Math.max(0, -d), i1 = Math.min(A.length, B.length - d);
      if (i1 - i0 < minN) continue;
      const len = i1 - i0;
      const err = new Float64Array(len);
      const ok = new Uint8Array(len);
      for (let k = 0; k < len; k++) {
        const i = i0 + k, j = i + d;
        if (Av[i] && Bv[j]) { err[k] = popcount32((A[i] ^ B[j]) >>> 0) / 32; ok[k] = 1; }
      }
      // Moving average over valid frames.
      const sm = new Float64Array(len);
      let se = 0, sc = 0;
      const half = smoothN >> 1;
      for (let k = 0; k < Math.min(len, half); k++) { if (ok[k]) { se += err[k]; sc++; } }
      for (let k = 0; k < len; k++) {
        const add = k + half, rem = k - half - 1;
        if (add < len && ok[add]) { se += err[add]; sc++; }
        if (rem >= 0 && ok[rem]) { se -= err[rem]; sc--; }
        sm[k] = sc >= smoothN / 2 ? se / sc : 1;
      }
      // Runs where smoothed BER <= maxBer, bridging dips up to gapN.
      let k = 0;
      while (k < len) {
        if (sm[k] > maxBer) { k++; continue; }
        const s = k;
        let e = k, gap = 0;
        while (k < len) {
          if (sm[k] <= maxBer) { e = k; gap = 0; } else if (++gap > gapN) break;
          k++;
        }
        const runN = e - s + 1;
        if (runN >= minN && (!bestRun || runN > bestRun.n)) {
          let tot = 0, cnt = 0;
          for (let q = s; q <= e; q++) if (ok[q]) { tot += err[q]; cnt++; }
          const ber = cnt ? tot / cnt : 1;
          if (ber <= maxBer + 0.04) bestRun = { n: runN, s: i0 + s, e: i0 + e, d, ber, votes: v };
        }
        k = e + 1 + gapN;
      }
    }
  }
  if (!bestRun) return null;
  const toSec = (w, idx) => Math.round((w.t0 + idx * HOP_SEC) * 10) / 10;
  return {
    aStart: toSec(a, bestRun.s), aEnd: toSec(a, bestRun.e + 1),
    bStart: toSec(b, bestRun.s + bestRun.d), bEnd: toSec(b, bestRun.e + 1 + bestRun.d),
    ber: Math.round(bestRun.ber * 1000) / 1000, votes: bestRun.votes,
  };
}

module.exports = {
  SAMPLE_RATE, FRAME, HOP, HOP_SEC, RATE,
  fingerprintPcm, popcount32,
  createWindow, placeHashes, coverageSec, serializeWindow, deserializeWindow,
  findSharedSegment,
};
