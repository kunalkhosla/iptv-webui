"use strict";
// Panel VOD audio tracks: learn the track list from the transcoder's own
// ffmpeg stderr (zero extra provider connections), and choose which track
// to play when the client didn't ask for one.
//
// The track shape matches runPanelTracksProbe in server.js exactly:
//   { index, codec, channels, lang, label, default }
// `index` is the audio-only ordinal (ffmpeg `-map 0:a:N`), i.e. the Nth
// audio stream in input #0, in file order.

// ISO 639-1 -> the 639-2 tag muxers write. Plus spelled-out names, so
// "hindi" in a track title or a "(Hindi)" stream name resolves too.
const ISO1_TO_3 = {
  hi: "hin", en: "eng", pa: "pan", ta: "tam", te: "tel", ml: "mal", kn: "kan",
  ur: "urd", bn: "ben", mr: "mar", gu: "guj", ar: "ara", tr: "tur", es: "spa",
  fr: "fra", de: "deu", ja: "jpn", ko: "kor", zh: "zho", ru: "rus", th: "tha",
  id: "ind", it: "ita", pt: "por",
};
const LANG_NAMES = {
  hindi: "hin", english: "eng", punjabi: "pan", tamil: "tam", telugu: "tel",
  malayalam: "mal", kannada: "kan", urdu: "urd", bengali: "ben", bangla: "ben",
  marathi: "mar", gujarati: "guj", arabic: "ara", turkish: "tur", spanish: "spa",
  french: "fra", german: "deu", japanese: "jpn", korean: "kor", chinese: "zho",
  mandarin: "zho", russian: "rus", thai: "tha", indonesian: "ind", italian: "ita",
  portuguese: "por",
};
// 639-2/B variants and other spellings muxers emit for the same language.
const ISO3_ALIASES = { fre: "fra", ger: "deu", chi: "zho", panjabi: "pan", pnb: "pan" };
const KNOWN3 = new Set([...Object.values(ISO1_TO_3), ...Object.values(LANG_NAMES)]);
const UNKNOWN = new Set(["und", "unk", "mul", "mis", "zxx", "xxx", "multi", "none", ""]);

const DEFAULT_AUDIO_LANG_PREFS = Object.freeze(["hin", "eng"]);

// Any language spelling -> canonical 3-letter code, or null (unknown/und).
function canonLang(x) {
  if (x == null) return null;
  const s = String(x).trim().toLowerCase();
  if (UNKNOWN.has(s)) return null;
  if (ISO1_TO_3[s]) return ISO1_TO_3[s];
  if (LANG_NAMES[s]) return LANG_NAMES[s];
  if (ISO3_ALIASES[s]) return ISO3_ALIASES[s];
  if (KNOWN3.has(s)) return s;
  if (/^[a-z]{3}$/.test(s)) return s; // some other real 639-2 code
  return null;
}

// A language name spelled out in free text ("Hindi DD+ 5.1", "Tamil (Org)").
function langFromText(text) {
  if (!text) return null;
  const words = String(text).toLowerCase().match(/[a-z]+/g) || [];
  for (const w of words) if (LANG_NAMES[w]) return LANG_NAMES[w];
  return null;
}

// Commentary / audio-description tracks are never auto-picked.
const COMMENTARY_RE = /\b(commentary|comment|descriptive|description|described|narrat(ed|ion)|visually\s+impaired|AD)\b/i;
function isCommentaryTrack(t) {
  return !!(t && t.label && COMMENTARY_RE.test(String(t.label)));
}

// The track's language: its tag when known, else a language named in its
// title/label. null = unknown ("und" or nothing).
function trackLang(t) {
  if (!t) return null;
  return canonLang(t.lang) || langFromText(t.label);
}

function normalizeAudioLangPrefs(v) {
  if (!Array.isArray(v)) return null;
  const out = [];
  for (const x of v) {
    const c = typeof x === "string" ? canonLang(x) : null;
    if (c && !out.includes(c)) out.push(c);
    if (out.length >= 10) break;
  }
  return out;
}

function effectiveAudioLangPrefs(v) {
  const n = normalizeAudioLangPrefs(v);
  return n && n.length ? n : [...DEFAULT_AUDIO_LANG_PREFS];
}

function fileDefaultIndex(tracks) {
  const d = tracks.find((t) => t && t.default);
  return d ? d.index : (tracks[0] ? tracks[0].index : 0);
}

// Choose the audio track for a play with no explicit ?at=.
//   1. the title's ORIGINAL language (TMDB original_language, else the
//      stream name's language tag) — a Hindi film plays Hindi, not a dub;
//      if no track is tagged with it but some track is untagged ("und"),
//      that untagged one may well be the original: keep the file default
//      rather than reach for a known dub;
//   2. the profile's audioLangPrefs, in order;
//   3. the file's default track (disposition default, else track 0).
// Commentary/AD tracks are skipped in 1 and 2. Returns { index, reason }.
function chooseAudioTrack(tracks, { originalLang = null, prefs = null } = {}) {
  if (!Array.isArray(tracks) || !tracks.length) return { index: 0, reason: "none" };
  const def = fileDefaultIndex(tracks);
  const usable = tracks.filter((t) => t && !isCommentaryTrack(t));
  const orig = canonLang(originalLang);
  if (orig) {
    const hit = usable.find((t) => trackLang(t) === orig);
    if (hit) return { index: hit.index, reason: `original:${orig}` };
    if (usable.some((t) => trackLang(t) == null)) return { index: def, reason: "original-untagged" };
  }
  for (const p of effectiveAudioLangPrefs(prefs)) {
    const hit = usable.find((t) => trackLang(t) === p);
    if (hit) return { index: hit.index, reason: `pref:${p}` };
  }
  return { index: def, reason: "default" };
}

// ---- ffmpeg stderr parsing ------------------------------------------------
// The transcoder runs with `-loglevel level+info`, so every line carries its
// level ("[info] ...", "[hls @ 0x..] [error] ..."). splitLevel separates it.
const LEVEL_RE = /^(?:\[[^\]]*@[^\]]*\]\s*)?\[(quiet|panic|fatal|error|warning|info|verbose|debug|trace)\]\s?/;
function splitLevel(line) {
  const m = LEVEL_RE.exec(line);
  if (!m) return { level: null, msg: line };
  // Keep a "[ctx @ ptr]" prefix on the message (error lines read like before).
  const ctx = /^(\[[^\]]*@[^\]]*\]\s*)/.exec(line);
  return { level: m[1], msg: (ctx ? ctx[1] : "") + line.slice(m[0].length) };
}
const ERROR_LEVELS = new Set(["panic", "fatal", "error"]);
function isErrorLevel(level) {
  // Unprefixed text (shouldn't happen with level+info) is kept, like before.
  return level == null || ERROR_LEVELS.has(level);
}

// Chunk -> complete lines (handles \r too, and lines split across chunks).
function lineSplitter(onLine) {
  let rest = "";
  return (chunk) => {
    rest += chunk.toString();
    const parts = rest.split(/\r?\n|\r/);
    rest = parts.pop();
    if (rest.length > 8192) rest = rest.slice(-8192);
    for (const p of parts) if (p) onLine(p);
  };
}

const LAYOUT_CHANNELS = {
  mono: 1, stereo: 2, "2.1": 3, "3.0": 3, "3.0(back)": 3, "4.0": 4, quad: 4, "quad(side)": 4,
  "3.1": 4, "5.0": 5, "5.0(side)": 5, "4.1": 5, "5.1": 6, "5.1(side)": 6, "6.0": 6,
  "6.0(front)": 6, hexagonal: 6, "6.1": 7, "6.1(back)": 7, "6.1(front)": 7, "7.0": 7,
  "7.0(front)": 7, "7.1": 8, "7.1(wide)": 8, "7.1(wide-side)": 8, "7.1(top)": 8, octagonal: 8,
  downmix: 2, "5.1.2": 8, "5.1.4": 10, "7.1.2": 10, "7.1.4": 12, "22.2": 24,
};
function channelsFrom(fields) {
  for (const f of fields) {
    const s = f.trim().toLowerCase();
    const n = /^(\d+)\s+channels?\b/.exec(s);
    if (n) return parseInt(n[1], 10);
    const base = s.split(/\s/)[0];
    if (LAYOUT_CHANNELS[base] != null) return LAYOUT_CHANNELS[base];
  }
  return null;
}

// Incremental parser for ffmpeg's input dump. Feed it de-levelled info
// lines; it returns the audio tracks once the Input #0 section is complete
// ("Stream mapping:" / "Output #0" / "Input #1" seen), else null.
//   Input #0, matroska,webm, from '...':
//     Stream #0:1(tam): Audio: eac3, 48000 Hz, 5.1(side), fltp, 640 kb/s (default)
//       Metadata:
//         title           : Tamil DD+ 5.1
function createInputStreamParser({ labelFor = (c) => (c ? String(c).toUpperCase() : null) } = {}) {
  let inInput0 = false;
  let done = false;
  let cur = null;        // the stream whose Metadata block we're inside
  const audio = [];
  const finish = () => {
    done = true;
    return audio.map((a, i) => ({
      index: i,
      codec: a.codec,
      channels: a.channels,
      lang: a.lang,
      label: a.title || labelFor(a.lang) || `Audio ${i + 1}`,
      default: a.default,
    }));
  };
  return {
    get done() { return done; },
    feed(msg) {
      if (done) return null;
      if (/^Input #0[,:]/.test(msg)) { inInput0 = true; return null; }
      if (!inInput0) return null;
      if (/^(Stream mapping:|Output #\d|Input #[1-9])/.test(msg) || /^Press \[q\]/.test(msg)) return finish();
      const st = /^\s+Stream #0:(\d+)(?:\[[^\]]*\])?(?:\(([^)]*)\))?(?:\[[^\]]*\])?:\s*(\w+):\s*(.*)$/.exec(msg);
      if (st) {
        cur = null;
        if (st[3] !== "Audio") return null;
        const rest = st[4];
        const fields = rest.split(/,(?![^()]*\))/);
        const codec = (/^([A-Za-z0-9_\-]+)/.exec(fields[0].trim()) || [])[1] || null;
        const flags = (rest.match(/\(([a-z ]+)\)/g) || []).map((x) => x.slice(1, -1));
        cur = {
          codec,
          channels: channelsFrom(fields.slice(1)),
          lang: st[2] || null,
          title: null,
          default: flags.includes("default"),
        };
        audio.push(cur);
        return null;
      }
      if (cur) {
        const md = /^\s+title\s*:\s*(.*?)\s*$/.exec(msg);
        if (md && md[1]) cur.title = md[1];
      }
      return null;
    },
    // ffmpeg exited before printing a mapping (e.g. died right after the
    // dump): return what was seen, if the stream list is plausibly complete.
    flush() { return (!done && inInput0 && audio.length) ? finish() : null; },
  };
}

function parseFfmpegInputStreams(text, opts) {
  const p = createInputStreamParser(opts);
  for (const raw of String(text).split(/\r?\n|\r/)) {
    const { msg } = splitLevel(raw);
    const r = p.feed(msg);
    if (r) return r;
  }
  return p.flush() || [];
}

// Learned-track store over the persisted panelTracksCache: learn() writes a
// non-empty list (same entry shape as the ffprobe path, plus source) and
// wakes parked waitFor() callers (an /api/tracks request waiting for the
// running transcoder's dump).
function createTrackLearner({ cache, onSave = () => {}, now = Date.now }) {
  const waiters = new Map(); // key -> Set<done>
  return {
    learn(mode, id, audioTracks) {
      if (!Array.isArray(audioTracks) || !audioTracks.length) return null;
      const key = `${mode}:${id}`;
      const entry = { audioTracks, ts: now(), source: "transcode" };
      cache[key] = entry;
      onSave();
      const ws = waiters.get(key);
      if (ws) { waiters.delete(key); for (const done of [...ws]) done(entry); }
      return entry;
    },
    waitFor(mode, id, ms) {
      const key = `${mode}:${id}`;
      return new Promise((resolve) => {
        let ws = waiters.get(key);
        if (!ws) { ws = new Set(); waiters.set(key, ws); }
        const done = (v) => {
          clearTimeout(timer);
          ws.delete(done);
          if (!ws.size && waiters.get(key) === ws) waiters.delete(key);
          resolve(v);
        };
        const timer = setTimeout(() => done(null), ms);
        ws.add(done);
      });
    },
    pendingWaiters(mode, id) { return waiters.get(`${mode}:${id}`)?.size || 0; },
  };
}

module.exports = {
  createTrackLearner,
  DEFAULT_AUDIO_LANG_PREFS,
  canonLang,
  langFromText,
  trackLang,
  isCommentaryTrack,
  normalizeAudioLangPrefs,
  effectiveAudioLangPrefs,
  chooseAudioTrack,
  splitLevel,
  isErrorLevel,
  lineSplitter,
  createInputStreamParser,
  parseFfmpegInputStreams,
};
