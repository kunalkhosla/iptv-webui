// Surround-sound metadata: badge labels for tiles/detail and a gentle
// background crawler that fills panel movie audio info (get_vod_info, a
// metadata call: never a stream). See docs/SURROUND.md.
"use strict";

const SURROUND_MIN_CHANNELS = 6;

const isSurround = (ch) => Number(ch) >= SURROUND_MIN_CHANNELS;

const ATMOS_RE = /atmos/i;
function mentionsAtmos(...parts) {
  for (const p of parts) if (typeof p === "string" && ATMOS_RE.test(p)) return true;
  return false;
}

// Display name for an ffprobe codec_name (+ profile when the panel sent it).
const CODEC_LABELS = {
  truehd: "TrueHD", mlp: "TrueHD",
  dts: "DTS", eac3: "E-AC3", ac3: "AC3", aac: "AAC",
  flac: "FLAC", opus: "Opus", mp3: "MP3", vorbis: "Vorbis",
  pcm_s16le: "PCM", pcm_s24le: "PCM", pcm_s32le: "PCM",
};
function codecLabel(codec, profile) {
  const c = String(codec || "").toLowerCase();
  if (!c) return null;
  if (c === "dts" && typeof profile === "string") {
    if (/\bma\b|master/i.test(profile)) return "DTS-HD MA";
    if (/dts:x/i.test(profile)) return "DTS:X";
    if (/hd/i.test(profile)) return "DTS-HD";
  }
  return CODEC_LABELS[c] || (c.startsWith("pcm_") ? "PCM" : c.toUpperCase());
}

// Tile/detail badge: "Atmos" | "7.1" | "5.1" | null (stereo/mono/unknown).
function audioBadge(channels, atmos) {
  const ch = Number(channels) || 0;
  if (!isSurround(ch)) return null;
  if (atmos) return "Atmos";
  return ch >= 8 ? "7.1" : "5.1";
}

// Additive API fields for one title. `a` = { channels, codec, profile?, atmos? }.
// Unknown -> all null (clients show nothing).
function audioFields(a) {
  const ch = Number(a && a.channels) || 0;
  if (!ch) return { audio_channels: null, audio_codec: null, audio_format: null, audio_badge: null };
  const atmos = !!(a.atmos || mentionsAtmos(a.profile));
  return {
    audio_channels: ch,
    audio_codec: a.codec || null,
    audio_format: atmos && isSurround(ch) ? "Atmos" : codecLabel(a.codec, a.profile),
    audio_badge: audioBadge(ch, atmos),
  };
}

// Max-channel summary of a track list ({channels, codec, label|title}).
// The codec reported is the one of the widest track.
function summarizeTracks(tracks) {
  let best = null;
  let atmos = false;
  for (const t of Array.isArray(tracks) ? tracks : []) {
    if (!t) continue;
    const ch = Number(t.channels) || 0;
    if (mentionsAtmos(t.label, t.title, t.profile)) atmos = true;
    if (ch && (!best || ch > best.channels)) best = { channels: ch, codec: t.codec || null };
  }
  return best ? { ...best, atmos } : null;
}

// Panel get_vod_info `info.audio` (one ffprobe stream object) -> summary.
function fromPanelAudio(audio) {
  if (!audio || typeof audio !== "object" || Array.isArray(audio)) return null;
  const ch = Number(audio.channels) || 0;
  if (!ch) return null;
  return {
    channels: ch,
    codec: audio.codec_name || null,
    profile: typeof audio.profile === "string" ? audio.profile : null,
    atmos: mentionsAtmos(audio.profile, audio.tags && audio.tags.title),
  };
}

// Series summary from get_series_info episodes ({season: [ep...]}) plus an
// optional lookup of learned transcode tracks per episode id. Returns the
// max over episodes (a show mixing stereo and 5.1 episodes reads "5.1"),
// with counts so callers can tell how much was known.
function summarizeSeries(episodes, learnedFor) {
  let best = null;
  let known = 0;
  let surround = 0;
  let atmos = false;
  const lists = episodes && typeof episodes === "object" ? Object.values(episodes) : [];
  for (const list of lists) {
    if (!Array.isArray(list)) continue;
    for (const ep of list) {
      if (!ep) continue;
      const learned = learnedFor ? learnedFor(ep.id) : null;
      const s = learned || fromPanelAudio(ep.info && ep.info.audio);
      if (!s) continue;
      known++;
      if (isSurround(s.channels)) surround++;
      if (s.atmos) atmos = true;
      if (!best || s.channels > best.channels) best = { channels: s.channels, codec: s.codec || null, profile: s.profile || null };
    }
  }
  return best ? { ...best, atmos, known, surround } : null;
}

// ── Crawler ────────────────────────────────────────────────────────
// One get_vod_info at a time, `intervalMs` apart. Order: boosted ids
// (titles a client was just shown without audio data, newest boost first),
// then the sweep list (`candidates()`: caller-ordered, re-read every
// `sweepRefreshMs`). `isKnown(id)` skips titles already covered (cached
// audio or a recent "panel has no audio info" verdict).
// `probe(id)` -> "found" | "none" | "skip" (resolved) or throws (transient:
// back off, the id is retried on a later sweep).
function createAudioCrawler({
  probe,
  candidates,
  isKnown,
  intervalMs = 4000,
  sweepRefreshMs = 30 * 60 * 1000,
  idleMs = 10 * 60 * 1000,
  maxBoost = 2000,
  backoffMs = 60 * 1000,
  maxBackoffMs = 15 * 60 * 1000,
  now = () => Date.now(),
  sleep = (ms) => new Promise((r) => { const t = setTimeout(r, ms); if (t.unref) t.unref(); }),
  log = () => {},
} = {}) {
  if (typeof probe !== "function" || typeof candidates !== "function" || typeof isKnown !== "function") {
    throw new Error("createAudioCrawler: probe, candidates, isKnown required");
  }
  const boosted = new Set(); // insertion order; next() takes the newest
  let sweep = [];
  let sweepPos = 0;
  let sweepAt = -Infinity;
  let running = false;
  let stopped = false;
  let wake = null;
  const stats = { probed: 0, found: 0, none: 0, errors: 0, boosted: 0, lastId: null, lastAt: null, startedAt: null };

  function boost(ids) {
    let added = 0;
    for (const id of ids || []) {
      if (id == null || isKnown(id)) continue;
      if (boosted.has(id)) boosted.delete(id); // re-insert = newest
      boosted.add(id);
      added++;
    }
    while (boosted.size > maxBoost) boosted.delete(boosted.values().next().value);
    if (added) { stats.boosted += added; if (wake) wake(); }
    return added;
  }

  function next() {
    while (boosted.size) {
      const id = [...boosted].pop();
      boosted.delete(id);
      if (!isKnown(id)) return id;
    }
    if (sweepPos >= sweep.length || now() - sweepAt > sweepRefreshMs) {
      try { sweep = [...(candidates() || [])]; } catch { sweep = []; }
      sweepPos = 0;
      sweepAt = now();
    }
    while (sweepPos < sweep.length) {
      const id = sweep[sweepPos++];
      if (!isKnown(id)) return id;
    }
    return null;
  }

  async function loop() {
    let backoff = 0;
    while (!stopped) {
      const id = next();
      if (id == null) {
        // Nothing left: idle until a boost or the next sweep refresh.
        sweepAt = -Infinity;
        await Promise.race([sleep(idleMs), new Promise((r) => { wake = r; })]);
        wake = null;
        continue;
      }
      try {
        const r = await probe(id);
        stats.probed++;
        stats.lastId = id;
        stats.lastAt = now();
        if (r === "found") stats.found++;
        else if (r === "none") stats.none++;
        backoff = 0;
        await sleep(intervalMs);
      } catch (e) {
        stats.errors++;
        backoff = backoff ? Math.min(backoff * 2, maxBackoffMs) : backoffMs;
        log(`[surround] crawl ${id} failed (${e && e.message ? e.message : e}); backing off ${Math.round(backoff / 1000)}s`);
        await sleep(backoff);
      }
    }
    running = false;
  }

  function start() {
    if (running) return;
    running = true;
    stopped = false;
    stats.startedAt = now();
    loop().catch((e) => { running = false; log(`[surround] crawler stopped: ${e && e.message}`); });
  }
  function stop() { stopped = true; if (wake) wake(); }

  return {
    start, stop, boost,
    stats: () => ({ ...stats, queued: boosted.size, sweepRemaining: Math.max(0, sweep.length - sweepPos), running }),
    _next: next, // tests
  };
}

// Sweep order for movies: 4K-tagged first, then everything else, each newest
// `added` first. `items` = index streams ({id, tags, added}).
function sweepOrder(items) {
  const arr = [];
  for (const s of items) {
    if (!s || s.id == null) continue;
    const is4k = Array.isArray(s.tags) && s.tags.includes("4k") ? 1 : 0;
    arr.push({ id: s.id, is4k, added: parseInt(s.added, 10) || 0 });
  }
  arr.sort((a, b) => (b.is4k - a.is4k) || (b.added - a.added));
  return arr.map((x) => x.id);
}

module.exports = {
  SURROUND_MIN_CHANNELS,
  isSurround,
  mentionsAtmos,
  codecLabel,
  audioBadge,
  audioFields,
  summarizeTracks,
  fromPanelAudio,
  summarizeSeries,
  createAudioCrawler,
  sweepOrder,
};
