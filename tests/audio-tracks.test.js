const test = require("node:test");
const assert = require("node:assert/strict");
const {
  parseFfmpegInputStreams, createInputStreamParser, splitLevel, isErrorLevel, lineSplitter,
  chooseAudioTrack, canonLang, normalizeAudioLangPrefs, effectiveAudioLangPrefs, isCommentaryTrack,
  DEFAULT_AUDIO_LANG_PREFS, publicTrack, resolveAudioTrackParam, effectiveAudioTrack,
  rekeyTranscoder, nameLangTag, copyAudioLang,
} = require("../lib/audio-tracks");

// Real ffmpeg 8.1 `-loglevel level+info` stderr (synthetic local MKV, same
// demuxer/dump code path as a panel 4K multi-audio MKV).
const MKV_STDERR = `[info] Input #0, matroska,webm, from 'http://panel.example/movie/u/p/796884.mkv':
[info]   Metadata:
[info]     title           : Dhurandhar The Revenge 2026 2160p
[info]     ENCODER         : Lavf62.12.103
[info]   Duration: 02:41:12.02, start: 0.000000, bitrate: 21972 kb/s
[info]   Stream #0:0: Video: hevc (Main 10), yuv420p10le(tv, bt2020nc/bt2020/smpte2084), 3840x1600 [SAR 1:1 DAR 12:5], 23.98 fps, 23.98 tbr, 1k tbn (default)
[info]     Metadata:
[info]       title           : 4K HDR
[info]       DURATION        : 02:41:12.000000000
[info]   Stream #0:1(tam): Audio: eac3, 48000 Hz, 5.1(side), fltp, 640 kb/s (default)
[info]     Metadata:
[info]       title           : Tamil DD+ 5.1
[info]       DURATION        : 02:41:12.001000000
[info]   Stream #0:2(tel): Audio: aac (LC), 48000 Hz, stereo, fltp
[info]     Metadata:
[info]       DURATION        : 02:41:12.023000000
[info]   Stream #0:3(hin): Audio: eac3, 48000 Hz, 5.1(side), fltp, 640 kb/s
[info]     Metadata:
[info]       title           : Hindi (Original) DD+ 5.1
[info]       DURATION        : 02:41:12.001000000
[info]   Stream #0:4(eng): Audio: aac (LC), 48000 Hz, stereo, fltp (comment)
[info]     Metadata:
[info]       title           : English Commentary
[info]   Stream #0:5: Audio: truehd, 48000 Hz, 7.1, s32 (24 bit)
[info]   Stream #0:6(eng): Subtitle: subrip (srt)
[info]     Metadata:
[info]       title           : English
[info]   Stream #0:7(und): Audio: dts (DTS-HD MA), 48000 Hz, 6 channels, s32p (24 bit)
[info] Stream mapping:
[info]   Stream #0:0 -> #0:0 (hevc (native) -> h264 (h264_vaapi))
[info]   Stream #0:1 -> #0:1 (eac3 (native) -> aac (native))
[info] Press [q] to stop, [?] for help
[hls @ 0x7b00e1d58400] [info] Opening '/tmp/t/seg_00000.ts' for writing
`;

const label = (c) => (c ? { tam: "Tamil", tel: "Telugu", hin: "Hindi", eng: "English" }[c] || c.toUpperCase() : null);

test("parses multi-audio MKV input dump into the ffprobe track shape", () => {
  const tracks = parseFfmpegInputStreams(MKV_STDERR, { labelFor: label });
  const f = { comment: false, visualImpaired: false };
  assert.deepEqual(tracks, [
    { index: 0, codec: "eac3", channels: 6, lang: "tam", label: "Tamil DD+ 5.1", default: true, ...f },
    { index: 1, codec: "aac", channels: 2, lang: "tel", label: "Telugu", default: false, ...f },
    { index: 2, codec: "eac3", channels: 6, lang: "hin", label: "Hindi (Original) DD+ 5.1", default: false, ...f },
    { index: 3, codec: "aac", channels: 2, lang: "eng", label: "English Commentary", default: false, ...f, comment: true },
    { index: 4, codec: "truehd", channels: 8, lang: null, label: "Audio 5", default: false, ...f },
    { index: 5, codec: "dts", channels: 6, lang: "und", label: "UND", default: false, ...f },
  ]);
  // The public /api/tracks shape drops the disposition-only fields.
  assert.deepEqual(Object.keys(publicTrack(tracks[3])), ["index", "codec", "channels", "lang", "label", "default"]);
});

test("index is the audio-only ordinal (= -map 0:a:N), ignoring video/subtitle streams", () => {
  const tracks = parseFfmpegInputStreams(MKV_STDERR);
  assert.equal(tracks[2].lang, "hin"); // Stream #0:3 is 0:a:2
  assert.equal(tracks[5].codec, "dts"); // Stream #0:7 (after a subtitle) is 0:a:5
});

test("output-section streams and metadata are not mistaken for input tracks", () => {
  const withOutput = MKV_STDERR.replace("[info] Stream mapping:", `[info] Output #0, hls, to 'x/index.m3u8':
[info]   Stream #0:1(hin): Audio: aac (LC), 48000 Hz, stereo, fltp, 128 kb/s
[info] Stream mapping:`);
  assert.equal(parseFfmpegInputStreams(withOutput).length, 6);
});

test("MPEG-TS style stream ids and HLS/mp4 without languages", () => {
  const ts = `[info] Input #0, mpegts, from 'http://x/1.ts':
[info]   Stream #0:0[0x100]: Video: h264 (High) ([27][0][0][0] / 0x001B), yuv420p(tv, bt709, progressive), 1920x1080, 25 fps
[info]   Stream #0:1[0x101](hin): Audio: ac3 ([129][0][0][0] / 0x0081), 48000 Hz, 5.1(side), fltp, 384 kb/s
[info]   Stream #0:2[0x102](eng): Audio: mp2 ([3][0][0][0] / 0x0003), 48000 Hz, stereo, fltp, 192 kb/s
[info] Stream mapping:`;
  assert.deepEqual(parseFfmpegInputStreams(ts).map((t) => [t.index, t.codec, t.channels, t.lang]), [
    [0, "ac3", 6, "hin"], [1, "mp2", 2, "eng"],
  ]);
  const mp4 = `[info] Input #0, mov,mp4,m4a,3gp,3g2,mj2, from 'http://x/2.mp4':
[info]   Stream #0:0[0x1](und): Video: h264 (High) (avc1 / 0x31637661), yuv420p, 1280x720, 1500 kb/s, 24 fps (default)
[info]   Stream #0:1[0x2](und): Audio: aac (LC) (mp4a / 0x6134706D), 44100 Hz, stereo, fltp, 128 kb/s (default)
[info]       Metadata:
[info]         handler_name    : SoundHandler
[info] Stream mapping:`;
  assert.deepEqual(parseFfmpegInputStreams(mp4), [
    { index: 0, codec: "aac", channels: 2, lang: "und", label: "UND", default: true, comment: false, visualImpaired: false },
  ]);
});

test("incremental parser: null until the dump completes, then once", () => {
  const p = createInputStreamParser();
  const lines = MKV_STDERR.split("\n").filter(Boolean).map((l) => splitLevel(l).msg);
  const results = lines.map((l) => p.feed(l)).filter(Boolean);
  assert.equal(results.length, 1);
  assert.equal(results[0].length, 6);
  assert.equal(p.done, true);
});

test("flush returns a partial-but-plausible dump when ffmpeg died before mapping", () => {
  const cut = MKV_STDERR.split("[info] Stream mapping:")[0];
  assert.equal(parseFfmpegInputStreams(cut).length, 6);
  assert.deepEqual(parseFfmpegInputStreams("[error] Error opening input: Server returned 404 Not Found"), []);
});

test("splitLevel keeps error lines as -loglevel error printed them", () => {
  assert.deepEqual(splitLevel("[in#0 @ 0x55d] [error] Error opening input: Input/output error"),
    { level: "error", msg: "[in#0 @ 0x55d] Error opening input: Input/output error" });
  assert.deepEqual(splitLevel("[info]   Stream #0:1(tam): Audio: eac3"), { level: "info", msg: "  Stream #0:1(tam): Audio: eac3" });
  assert.deepEqual(splitLevel("[fatal] Conversion failed!"), { level: "fatal", msg: "Conversion failed!" });
  assert.equal(isErrorLevel("error"), true);
  assert.equal(isErrorLevel("fatal"), true);
  assert.equal(isErrorLevel("warning"), false);
  assert.equal(isErrorLevel("info"), false);
});

test("lineSplitter joins lines split across chunks and handles \\r", () => {
  const got = [];
  const f = lineSplitter((l) => got.push(l));
  f(Buffer.from("[info] Inp")); f("ut #0, x\r\n[info]   Str"); f("eam #0:1: Audio: aac\n[err");
  assert.deepEqual(got, ["[info] Input #0, x", "[info]   Stream #0:1: Audio: aac"]);
});

// ---- selection -----------------------------------------------------------
const T = (index, lang, extra = {}) => ({ index, codec: "aac", channels: 2, lang, label: extra.label || lang || `Audio ${index + 1}`, default: !!extra.default });

test("Hindi film, tracks [tam, tel, hin, eng] -> hin", () => {
  const tracks = [T(0, "tam", { default: true }), T(1, "tel"), T(2, "hin"), T(3, "eng")];
  assert.deepEqual(chooseAudioTrack(tracks, { originalLang: "hi" }), { index: 2, reason: "original:hin" });
});

test("English film, tracks [eng, hin] -> eng (no Hindi dub for an English film)", () => {
  const tracks = [T(0, "eng"), T(1, "hin")];
  assert.equal(chooseAudioTrack(tracks, { originalLang: "en", prefs: ["hin", "eng"] }).index, 0);
  // even when the Hindi dub is first / flagged default
  assert.equal(chooseAudioTrack([T(0, "hin", { default: true }), T(1, "eng")], { originalLang: "en" }).index, 1);
});

test("Punjabi film, tracks [pan, hin] -> pan", () => {
  assert.equal(chooseAudioTrack([T(0, "hin"), T(1, "pan")], { originalLang: "pa" }).index, 1);
  assert.equal(chooseAudioTrack([T(0, "hin"), T(1, "pa")], { originalLang: "punjabi" }).index, 1);
});

test("Hindi film where only 'und' + eng -> file default (never the known dub)", () => {
  assert.deepEqual(chooseAudioTrack([T(0, "und"), T(1, "eng")], { originalLang: "hi" }), { index: 0, reason: "original-untagged" });
  assert.equal(chooseAudioTrack([T(0, "eng"), T(1, null, { default: true })], { originalLang: "hi" }).index, 1);
});

test("commentary / descriptive tracks are skipped", () => {
  const tracks = [T(0, "tam"), T(1, "hin", { label: "Hindi Director's Commentary" }), T(2, "hin", { label: "Hindi DD 5.1" })];
  assert.equal(chooseAudioTrack(tracks, { originalLang: "hi" }).index, 2);
  assert.equal(isCommentaryTrack({ label: "English - Audio Description" }), true);
  assert.equal(isCommentaryTrack({ label: "English AD" }), true);
  assert.equal(isCommentaryTrack({ label: "Hindi (Original)" }), false);
  assert.equal(isCommentaryTrack({ label: "Hindi Dubbed" }), false);
});

test("language named only in the track title counts", () => {
  const tracks = [T(0, "und", { label: "Tamil" }), T(1, "und", { label: "Hindi DD+ 5.1" })];
  assert.equal(chooseAudioTrack(tracks, { originalLang: "hi" }).index, 1);
});

test("unknown original language -> profile prefs, then file default", () => {
  const tracks = [T(0, "tam", { default: true }), T(1, "eng"), T(2, "hin")];
  assert.deepEqual(chooseAudioTrack(tracks, {}), { index: 2, reason: "pref:hin" });            // default prefs hin, eng
  assert.equal(chooseAudioTrack(tracks, { prefs: ["eng"] }).index, 1);
  assert.deepEqual(chooseAudioTrack([T(0, "tam"), T(1, "tel", { default: true })], {}), { index: 1, reason: "default" });
  // und never beats a known preferred language
  assert.equal(chooseAudioTrack([T(0, "und"), T(1, "eng")], {}).index, 1);
});

test("original language with no matching and no untagged track falls to prefs", () => {
  // Malayalam film, file only has dubs: the profile's language wins.
  assert.equal(chooseAudioTrack([T(0, "tam"), T(1, "hin")], { originalLang: "ml" }).index, 1);
});

test("single / empty track lists", () => {
  assert.equal(chooseAudioTrack([], { originalLang: "hi" }).index, 0);
  assert.equal(chooseAudioTrack([T(0, "eng")], { originalLang: "hi" }).index, 0);
});

test("lang normalization and prefs", () => {
  assert.equal(canonLang("hi"), "hin");
  assert.equal(canonLang("HIN"), "hin");
  assert.equal(canonLang("Hindi"), "hin");
  assert.equal(canonLang("und"), null);
  assert.equal(canonLang(""), null);
  assert.equal(canonLang("fre"), "fra");
  assert.deepEqual(normalizeAudioLangPrefs(["hi", "eng", "hindi", 5, "zz-bad", "pa"]), ["hin", "eng", "pan"]);
  assert.equal(normalizeAudioLangPrefs("hin"), null);
  assert.deepEqual(effectiveAudioLangPrefs(null), ["hin", "eng"]);
  assert.deepEqual(effectiveAudioLangPrefs([]), ["hin", "eng"]);
  assert.deepEqual(effectiveAudioLangPrefs(["tam"]), ["tam"]);
  assert.deepEqual([...DEFAULT_AUDIO_LANG_PREFS], ["hin", "eng"]);
});

// ---- cache population ----------------------------------------------------
const { createTrackLearner } = require("../lib/audio-tracks");

test("learned tracks populate the cache in the probe's shape and wake waiters", async () => {
  const cache = {};
  let saves = 0;
  const L = createTrackLearner({ cache, onSave: () => saves++, now: () => 1234 });
  const waiting = L.waitFor("movie", "796884", 5000);
  assert.equal(L.pendingWaiters("movie", "796884"), 1);
  const tracks = parseFfmpegInputStreams(MKV_STDERR, { labelFor: label });
  L.learn("movie", "796884", tracks);
  assert.deepEqual(cache["movie:796884"], { audioTracks: tracks, ts: 1234, source: "transcode" });
  assert.equal(saves, 1);
  assert.deepEqual((await waiting).audioTracks, tracks);
  assert.equal(L.pendingWaiters("movie", "796884"), 0);
  for (const t of cache["movie:796884"].audioTracks) {
    assert.deepEqual(Object.keys(t), ["index", "codec", "channels", "lang", "label", "default", "comment", "visualImpaired"]);
  }
});

test("empty dumps are not cached; waiters time out to null", async () => {
  const cache = {};
  const L = createTrackLearner({ cache });
  assert.equal(L.learn("series", "1", []), null);
  assert.deepEqual(cache, {});
  assert.equal(await L.waitFor("series", "1", 10), null);
  assert.equal(L.pendingWaiters("series", "1"), 0);
});

test("a learned list feeds the pick: Dhurandhar-like dump with Hindi original -> 0:a:2", () => {
  const tracks = parseFfmpegInputStreams(MKV_STDERR);
  assert.equal(chooseAudioTrack(tracks, { originalLang: "hi" }).index, 2);
  // Unknown original, Kunal-style default prefs: still Hindi, not the Tamil default.
  assert.equal(chooseAudioTrack(tracks, {}).index, 2);
});

// ---- review fixes --------------------------------------------------------
test("disposition-flagged commentary / visually-impaired tracks are skipped even with plain titles", () => {
  const tracks = [T(0, "hin"), T(1, "hin"), T(2, "eng")];
  tracks[0].comment = true;
  assert.equal(chooseAudioTrack(tracks, { originalLang: "hi" }).index, 1);
  tracks[1].visualImpaired = true;
  // both Hindi tracks flagged: no usable original, no untagged -> prefs: eng
  assert.equal(chooseAudioTrack(tracks, { originalLang: "hi" }).index, 2);
});

test("splitLevel classifies stacked ffmpeg 7/8 parent-context lines", () => {
  assert.deepEqual(splitLevel("[vist#0:1/hevc @ 0x1] [dec:hevc @ 0x2] [error] Error while decoding"),
    { level: "error", msg: "[vist#0:1/hevc @ 0x1] [dec:hevc @ 0x2] Error while decoding" });
  assert.equal(splitLevel("[aost#0:1/aac @ 0x3] [enc:aac @ 0x4] [info] x").level, "info");
});

test("at/ap parsing: repeated at -> last value wins, 0 is a valid explicit choice", () => {
  assert.deepEqual(resolveAudioTrackParam({ at: ["2", "0"] }), { explicit: 0, serverPick: null });
  assert.deepEqual(resolveAudioTrackParam({ at: "0" }), { explicit: 0, serverPick: null });
  assert.deepEqual(resolveAudioTrackParam({ ap: "2", at: "1" }), { explicit: 1, serverPick: 2 });
  assert.deepEqual(resolveAudioTrackParam({ ap: "2" }), { explicit: null, serverPick: 2 });
  assert.deepEqual(resolveAudioTrackParam({ at: "", ap: "x" }), { explicit: null, serverPick: null });
  assert.deepEqual(resolveAudioTrackParam({ at: "-1" }), { explicit: null, serverPick: null });
  assert.deepEqual(resolveAudioTrackParam({ at: "2,0" }), { explicit: null, serverPick: null });
  assert.deepEqual(resolveAudioTrackParam({}), { explicit: null, serverPick: null });
});

test("effective track precedence: at > ap > running auto transcoder > cache > learn", () => {
  const vod = true;
  assert.deepEqual(effectiveAudioTrack({ vod, explicit: 0, serverPick: 2, aliasedTrack: 2, cachedPick: 2 }), { audioTrack: 0, autoPick: false, auto: false });
  assert.deepEqual(effectiveAudioTrack({ vod, serverPick: 2, cachedPick: 1 }), { audioTrack: 2, autoPick: false, auto: false });
  assert.deepEqual(effectiveAudioTrack({ vod, aliasedTrack: 0, cachedPick: 2 }), { audioTrack: 0, autoPick: false, auto: true });
  assert.deepEqual(effectiveAudioTrack({ vod, cachedPick: 2 }), { audioTrack: 2, autoPick: false, auto: true });
  assert.deepEqual(effectiveAudioTrack({ vod }), { audioTrack: 0, autoPick: true, auto: true });
  assert.deepEqual(effectiveAudioTrack({ vod: false, explicit: 3 }), { audioTrack: 0, autoPick: false, auto: false });
});

test("re-keying moves the entry to its new track's key (key == mapping)", () => {
  const map = new Map();
  const e = { key: "movie-1-med" };
  map.set("movie-1-med", e);
  assert.equal(rekeyTranscoder(map, e, "movie-1-med", "movie-1-med-at2"), true);
  assert.equal(map.has("movie-1-med"), false);   // a later explicit at=0 can't reuse it
  assert.equal(map.get("movie-1-med-at2"), e);
  assert.equal(e.key, "movie-1-med-at2");
  // refuses when the target key is held by another transcoder, or the entry moved
  const other = {};
  map.set("movie-1-med-at3", other);
  assert.equal(rekeyTranscoder(map, e, "movie-1-med-at2", "movie-1-med-at3"), false);
  assert.equal(map.get("movie-1-med-at2"), e);
  assert.equal(rekeyTranscoder(map, e, "movie-1-med", "movie-1-med-at4"), false);
});

test("copy language: a '(Hindi)' stream name beats TMDB original_language", () => {
  const W = { hindi: "hi", english: "en", tamil: "ta" };
  assert.equal(nameLangTag("Oppenheimer (2023) (Hindi)", W), "hi");
  assert.equal(nameLangTag("Dhurandhar: The Revenge (2026)(4K)", W), null);
  assert.equal(nameLangTag("Some Film [Tel,Tam,Hin]", W), null);
  const lang = copyAudioLang({ nameLang: nameLangTag("Oppenheimer (2023) (Hindi)", W), originalLang: "en" });
  assert.equal(lang, "hi");
  // dual hin+eng Hindi copy of an English film plays Hindi
  assert.equal(chooseAudioTrack([T(0, "eng", { default: true }), T(1, "hin")], { originalLang: lang }).index, 1);
  // untagged copy: original language
  assert.equal(copyAudioLang({ nameLang: null, originalLang: "en", tagLang: "hi" }), "en");
  assert.equal(copyAudioLang({ tagLang: "hi" }), "hi");
  assert.equal(copyAudioLang({}), null);
});

test("unset prefs default to the profile's onboarded languages, then hin, eng", () => {
  assert.deepEqual(effectiveAudioLangPrefs(null, ["punjabi", "english"]), ["pan", "eng", "hin"]);
  assert.deepEqual(effectiveAudioLangPrefs(null, ["tamil"]), ["tam", "hin", "eng"]);
  assert.deepEqual(effectiveAudioLangPrefs(null, []), ["hin", "eng"]);
  assert.deepEqual(effectiveAudioLangPrefs(["eng"], ["punjabi"]), ["eng"]); // explicit wins
  // A Punjabi-onboarded profile, title of unknown language, [hin, pan] -> pan
  assert.equal(chooseAudioTrack([T(0, "hin"), T(1, "pan")], { prefs: effectiveAudioLangPrefs(null, ["punjabi"]) }).index, 1);
});

// ---- server/web wiring (source-level, like api-contract.test.js) ----------
const fs = require("node:fs");
const path = require("node:path");
const SERVER = fs.readFileSync(path.join(__dirname, "..", "server.js"), "utf8");
const APP = fs.readFileSync(path.join(__dirname, "..", "public", "app.js"), "utf8");

test("/api/stream puts the server pick in &ap= (never &at=) and returns audioTrack", () => {
  assert.match(SERVER, /serverPick != null \? `&ap=\$\{serverPick\}`/);
  assert.match(SERVER, /explicitAt != null \? `&at=\$\{explicitAt\}`/);
  assert.match(SERVER, /\n {4}audioTrack,\n/);
});

test("transcode route resolves at/ap via the lib and keys by the effective track", () => {
  assert.match(SERVER, /audioTracksLib\.resolveAudioTrackParam\(req\.query\)/);
  assert.match(SERVER, /audioTracksLib\.effectiveAudioTrack\(/);
  assert.match(SERVER, /const sameTrack = \(existing\?\.audioTrack \|\| 0\) === audioTrack/);
  assert.match(SERVER, /audioTracksLib\.rekeyTranscoder\(transcoders, entry, key, newKey\)/);
});

test("web client sends an explicit &at= (0 included) and adopts the server pick", () => {
  assert.match(APP, /p\.audioExplicit && Number\.isFinite\(p\.audioTrack\) \? `&at=\$\{p\.audioTrack\}`/);
  assert.match(APP, /state\.playing\.audioTrack = resolved\.audioTrack;/);
  assert.match(APP, /audioTrack >= 0;/);
});

// ---- key track vs mapped track (failover) ---------------------------------
const { keyTrackOf, clampTrack } = require("../lib/audio-tracks");
const { segmentQuery } = require("../lib/segment-query");

test("failover with ap=2: segment URLs carry the KEY's track and resolve to the same key", () => {
  // ap=2 play -> key ...-at2; its source dies and fails over to an alternate
  // that maps track 0 (audioTrack 0, trackReset) under the SAME key.
  const key = "movie-123-med-at2";
  const entry = { key, keyTrack: keyTrackOf(key), audioTrack: 0, trackReset: true };
  const qq = segmentQuery({ quality: "med", audioTrack: entry.keyTrack });
  assert.equal(qq, "q=med&at=2");
  const q = Object.fromEntries(new URLSearchParams(qq));
  assert.equal(resolveAudioTrackParam(q).explicit, 2);          // segment route -> ...-at2
  assert.equal(keyTrackOf("movie-123-med"), 0);
  assert.equal(keyTrackOf("movie-123-med-surround-t300-at11"), 11);
  // the mapped track (0) would have produced a key without -at2: the 404 bug
  assert.equal(segmentQuery({ quality: "med", audioTrack: entry.audioTrack }), "q=med");
});

test("re-keying updates keyTrack with the key", () => {
  const map = new Map();
  const e = { key: "series-9-low", keyTrack: 0 };
  map.set(e.key, e);
  rekeyTranscoder(map, e, "series-9-low", "series-9-low-at3");
  assert.equal(e.keyTrack, 3);
});

test("server wires keyTrack into segment URLs and the auto alias", () => {
  assert.match(SERVER, /segmentQuery\(\{ quality, offsetSecs, audio, diskSel, audioTrack: t\.keyTrack \|\| 0 \}\)/);
  assert.match(SERVER, /aliasedTrack: aliased && !aliased\.stopping \? \(aliased\.keyTrack \|\| 0\)/);
  assert.match(SERVER, /entry\.keyTrack = audioTracksLib\.keyTrackOf\(key\)/);
});

test("clampTrack: out-of-range explicit/server index falls back to 0", () => {
  assert.equal(clampTrack(5, 3), 0);
  assert.equal(clampTrack(2, 3), 2);
  assert.equal(clampTrack(2, null), 2);
  assert.equal(clampTrack(-1, 3), 0);
});
