"use strict";
// EPG cleanup applied to every freshly built guide index, before it is
// served (/api/epg/short, live rails, Tonight, search all read the same
// index, so cleaning here covers every client).
//
// 1) calibrateEpgOffsets: some XMLTV sources stamp local wall-clock times
//    with the wrong UTC offset (the panel's own xmltv.php labels Indian
//    channels' IST times as UTC, so they land 5h30m late). Detected, not
//    assumed: each channel of a non-reference source is title-aligned
//    against same-named channels from trusted reference sources; a shift is
//    applied only for a source+country group whose calibrated channels
//    near-unanimously agree on it (a channel measured at 0 is left alone).
// 2) cleanEpgOverlaps: some channels carry several schedules merged under
//    one id (two programmes in the same slot). Which one is real can't be
//    told from the data, so both sides of a material overlap are dropped
//    (the client shows no guide for that slot) rather than guessing.

const MIN = 60 * 1000;
const OVERLAP_MIN_MS = 5 * MIN;     // overlaps up to this are rounding/overrun noise
const OVERLAP_MIN_FRAC = 0.25;      // ...or under this fraction of the shorter programme

function cleanEpgOverlaps(progs) {
  const s = (Array.isArray(progs) ? progs : []).filter((p) => p && p.stop > p.start).slice().sort((a, b) => a.start - b.start || a.stop - b.stop);
  // Collapse duplicates within an identical slot: same title, or one title
  // containing the other ("BBC News" vs "NewBBC News" — a flag glued onto
  // the title). The shorter title wins.
  const uniq = [];
  const bySlot = new Map();
  for (const p of s) {
    const slot = `${p.start}|${p.stop}`;
    const k = titleKey(p.title);
    const same = bySlot.get(slot) || [];
    const hit = same.find((q) => q.k === k || (k.length >= 4 && q.k.length >= 4 && (q.k.includes(k) || k.includes(q.k))));
    if (hit) {
      if (k.length < hit.k.length) { uniq[hit.i] = p; hit.k = k; }
      continue;
    }
    same.push({ k, i: uniq.length });
    bySlot.set(slot, same);
    uniq.push(p);
  }
  const bad = new Set();
  for (let i = 0; i < uniq.length; i++) {
    const a = uniq[i];
    for (let j = i + 1; j < uniq.length && uniq[j].start < a.stop; j++) {
      const b = uniq[j];
      const ov = Math.min(a.stop, b.stop) - b.start;
      const shorter = Math.min(a.stop - a.start, b.stop - b.start);
      if (ov > OVERLAP_MIN_MS && ov >= OVERLAP_MIN_FRAC * shorter) { bad.add(i); bad.add(j); }
    }
  }
  if (!bad.size && uniq.length === s.length && s.every((p, i) => p === progs[i])) return { progs, dropped: 0, dupes: 0 };
  return { progs: uniq.filter((_, i) => !bad.has(i)), dropped: bad.size, dupes: s.length - uniq.length };
}

// Clean every channel in a Map(id -> programmes) in place. Channels left
// with nothing are deleted so live-stream matching can point the stream at
// another guide channel instead of a blank one.
function cleanEpgIndexOverlaps(byChannel) {
  const stats = { channels: 0, programmesDropped: 0, emptied: 0, examples: [] };
  for (const [id, arr] of byChannel) {
    const r = cleanEpgOverlaps(arr);
    if (r.progs === arr) continue;
    if (r.dropped) {
      stats.channels++;
      stats.programmesDropped += r.dropped;
      if (stats.examples.length < 10) stats.examples.push(id);
    }
    if (r.progs.length) byChannel.set(id, r.progs);
    else { byChannel.delete(id); stats.emptied++; }
  }
  return stats;
}

const titleKey = (t) => String(t || "").normalize("NFKC").toLowerCase().replace(/[^\p{L}\p{N}]+/gu, "");
const SHIFT_STEP = 30 * MIN, SHIFT_MAX = 12 * 60 * MIN, MATCH_TOL = 6 * MIN;

// Best shift X (ms) such that ref programmes start at p.start + X, or null
// when the evidence is weak/ambiguous. Positive X = the channel runs early.
function alignOffset(progs, refProgs) {
  const byTitle = new Map();
  for (const r of refProgs) {
    const k = titleKey(r.title);
    if (k.length < 4) continue;
    let a = byTitle.get(k);
    if (!a) byTitle.set(k, (a = []));
    a.push(r.start);
  }
  if (!byTitle.size) return null;
  const score = new Map();
  for (const p of progs) {
    const starts = byTitle.get(titleKey(p.title));
    if (!starts) continue;
    for (let sh = -SHIFT_MAX; sh <= SHIFT_MAX; sh += SHIFT_STEP) {
      const t = p.start + sh;
      if (starts.some((s) => Math.abs(s - t) <= MATCH_TOL)) score.set(sh, (score.get(sh) || 0) + 1);
    }
  }
  const ranked = [...score.entries()].sort((a, b) => b[1] - a[1]);
  if (!ranked.length || ranked[0][1] < 4) return null;
  if (ranked[1] && ranked[0][1] < 1.5 * ranked[1][1]) return null;
  return ranked[0][0];
}

const countryOf = (id) => { const m = /\.([a-z]{2,3})\d*$/i.exec(String(id)); return m ? m[1].toLowerCase() : "?"; };

// byChannel: Map(id -> sorted programmes); names: Map(id -> [display names]);
// sourceOf: Map(id -> source label); isReference(label) -> bool;
// nameKey(name) -> normalised channel-name key.
// Shifts programmes in place; returns {applied: Map(id -> ms), groups}.
function calibrateEpgOffsets({ byChannel, names, sourceOf, isReference, nameKey, minGroup = 5, groupAgree = 0.9 }) {
  const refsByName = new Map();
  for (const [id, src] of sourceOf) {
    if (!isReference(src) || !byChannel.has(id)) continue;
    for (const n of names.get(id) || []) {
      const k = nameKey(n);
      if (!k) continue;
      let a = refsByName.get(k);
      if (!a) refsByName.set(k, (a = []));
      if (!a.includes(id)) a.push(id);
    }
  }
  const own = new Map();             // id -> measured offset (incl. 0)
  const groups = new Map();          // "source/country" -> {ids, votes: Map(offset -> n)}
  for (const [id, src] of sourceOf) {
    if (isReference(src) || !byChannel.has(id)) continue;
    const gk = `${src}/${countryOf(id)}`;
    let g = groups.get(gk);
    if (!g) groups.set(gk, (g = { ids: [], votes: new Map() }));
    g.ids.push(id);
    const refIds = new Set();
    for (const n of names.get(id) || []) for (const r of refsByName.get(nameKey(n)) || []) refIds.add(r);
    if (!refIds.size) continue;
    const offs = [...refIds].map((r) => alignOffset(byChannel.get(id), byChannel.get(r))).filter((x) => x !== null);
    if (!offs.length || offs.some((o) => o !== offs[0])) continue; // no evidence, or references disagree
    own.set(id, offs[0]);
    g.votes.set(offs[0], (g.votes.get(offs[0]) || 0) + 1);
  }
  const applied = new Map();
  const groupReport = {};
  for (const [gk, g] of groups) {
    const total = [...g.votes.values()].reduce((a, b) => a + b, 0);
    const [top, n] = [...g.votes.entries()].sort((a, b) => b[1] - a[1])[0] || [0, 0];
    const groupShift = total >= minGroup && n >= groupAgree * total && top !== 0 ? top : 0;
    if (total) groupReport[gk] = { channels: g.ids.length, calibrated: total, votes: Object.fromEntries([...g.votes].map(([k, v]) => [k / MIN, v])), shiftMin: groupShift / MIN };
    for (const id of g.ids) {
      // Only the group consensus is applied. A channel's own measurement can
      // veto it (measured 0 = already right), but a lone non-zero
      // measurement is never applied on its own: single-channel alignments
      // pick up repeats and different regional feeds (spurious shifts).
      const sh = own.get(id) === 0 ? 0 : groupShift;
      if (!sh) continue;
      byChannel.set(id, byChannel.get(id).map((p) => ({ ...p, start: p.start + sh, stop: p.stop + sh })));
      applied.set(id, sh);
    }
  }
  return { applied, groups: groupReport };
}

module.exports = { cleanEpgOverlaps, cleanEpgIndexOverlaps, calibrateEpgOffsets, alignOffset, titleKey };
