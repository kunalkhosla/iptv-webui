// Persistence for intro/credits detection.
//
//  <dir>/index.json         { "<mode>:<id>": { group, season, dur, head, tail,
//                              evidence, markers, updatedAt } }  (small)
//  <dir>/fp/<mode>-<id>.json { head: serializedWindow|null, tail: ... }
//
// `group` is a series key ("series:<seriesId>" or "disk:<seriesGroupId>");
// episodes are only ever compared within one group. `evidence` maps another
// episode key -> { intro: {start,end}|null, credits: {start}|null } from one
// comparison; `markers` is the consensus over it (media-analysis).

const fs = require("fs");
const path = require("path");
const fpLib = require("./fingerprint");
const ma = require("./media-analysis");

const KEY_RE = /^(movie|series|disk):\d{1,17}$/;

function createMarkerStore({ dir, log = () => {}, now = Date.now, saveDelayMs = 5000 } = {}) {
  if (!dir) throw new Error("marker store: dir required");
  const fpDir = path.join(dir, "fp");
  fs.mkdirSync(fpDir, { recursive: true });
  const indexFile = path.join(dir, "index.json");
  let index = {};
  try { index = JSON.parse(fs.readFileSync(indexFile, "utf8")) || {}; } catch { index = {}; }
  let saveTimer = null;
  function saveNow() {
    if (saveTimer) { clearTimeout(saveTimer); saveTimer = null; }
    const tmp = `${indexFile}.tmp`;
    try { fs.writeFileSync(tmp, JSON.stringify(index)); fs.renameSync(tmp, indexFile); } catch (e) { log(`[markers] save failed: ${e.message}`); }
  }
  function scheduleSave() {
    if (saveTimer) return;
    saveTimer = setTimeout(saveNow, saveDelayMs);
    if (saveTimer.unref) saveTimer.unref();
  }
  const fpFile = (key) => path.join(fpDir, `${key.replace(":", "-")}.json`);

  function get(key) { return KEY_RE.test(key) ? (index[key] || null) : null; }

  function loadWindows(key) {
    try {
      const o = JSON.parse(fs.readFileSync(fpFile(key), "utf8"));
      return { head: fpLib.deserializeWindow(o.head), tail: fpLib.deserializeWindow(o.tail) };
    } catch { return { head: null, tail: null }; }
  }

  // Save captured windows for an episode (either may be null = keep old).
  function putWindows(key, { group, season = null, dur = null, head = null, tail = null }) {
    if (!KEY_RE.test(key) || !group) return false;
    const old = loadWindows(key);
    const out = {
      head: head ? fpLib.serializeWindow(head) : (old.head ? fpLib.serializeWindow(old.head) : null),
      tail: tail ? fpLib.serializeWindow(tail) : (old.tail ? fpLib.serializeWindow(old.tail) : null),
    };
    const tmp = `${fpFile(key)}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(out));
    fs.renameSync(tmp, fpFile(key));
    const e = index[key] || { evidence: {}, markers: null };
    e.group = group;
    if (season != null) e.season = season;
    if (dur) e.dur = dur;
    e.head = !!out.head;
    e.headCoverage = head ? Math.round(fpLib.coverageSec(head)) : (e.headCoverage || 0);
    e.tail = !!out.tail;
    e.updatedAt = now();
    index[key] = e;
    scheduleSave();
    return true;
  }

  // Episodes of the same group, same season first, newest first; capped.
  function peers(key, max = 6) {
    const me = index[key];
    if (!me) return [];
    const all = Object.entries(index)
      .filter(([k, v]) => k !== key && v && v.group === me.group && (v.head || v.tail));
    all.sort(([, a], [, b]) => ((a.season === me.season ? 0 : 1) - (b.season === me.season ? 0 : 1)) || ((b.updatedAt || 0) - (a.updatedAt || 0)));
    return all.slice(0, max).map(([k]) => k);
  }

  // Compare `key` with its peers and record evidence on both sides.
  // Returns the episode's new markers.
  function analyse(key, opts = {}) {
    const me = index[key];
    if (!me) return null;
    const w = loadWindows(key);
    const ep = { key, head: w.head, tail: w.tail, dur: me.dur || null };
    const others = peers(key, opts.maxPeers || 6).map((k) => {
      const ow = loadWindows(k);
      return { key: k, head: ow.head, tail: ow.tail, dur: index[k].dur || null };
    });
    if (!others.length) return me.markers || null;
    const r = ma.analyseEpisode(ep, others);
    me.evidence = me.evidence || {};
    for (const p of r.pairs) {
      me.evidence[p.otherKey] = {
        intro: p.intro ? { start: p.intro.start, end: p.intro.end, ber: p.intro.ber } : null,
        credits: p.credits ? { start: p.credits.start, ber: p.credits.ber } : null,
      };
      const o = index[p.otherKey];
      if (!o) continue;
      o.evidence = o.evidence || {};
      o.evidence[key] = {
        intro: p.intro ? { start: Math.round(p.intro.otherStart * 10) / 10, end: Math.round(p.intro.otherEnd * 10) / 10, ber: p.intro.ber } : null,
        credits: p.credits ? { start: Math.round(p.credits.otherStart * 10) / 10, ber: p.credits.ber } : null,
      };
      o.markers = ma.markersFromEvidence(o.evidence, o.dur || null);
    }
    me.markers = ma.markersFromEvidence(me.evidence, me.dur || null);
    me.analysedAt = now();
    scheduleSave();
    return me.markers;
  }

  function stats() {
    const keys = Object.keys(index);
    let intro = 0, credits = 0;
    for (const k of keys) { if (index[k]?.markers?.introStart != null) intro++; if (index[k]?.markers?.creditsStart != null) credits++; }
    return { episodes: keys.length, withIntro: intro, withCredits: credits };
  }

  return { get, loadWindows, putWindows, peers, analyse, stats, saveNow };
}

module.exports = { createMarkerStore };
