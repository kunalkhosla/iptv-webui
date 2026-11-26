const test = require("node:test");
const assert = require("node:assert/strict");
const S = require("../lib/surround");

test("badge: channels and Atmos", () => {
  assert.equal(S.audioBadge(2), null);
  assert.equal(S.audioBadge(5), null);
  assert.equal(S.audioBadge(6), "5.1");
  assert.equal(S.audioBadge(7), "5.1");
  assert.equal(S.audioBadge(8), "7.1");
  assert.equal(S.audioBadge(8, true), "Atmos");
  assert.equal(S.audioBadge(2, true), null, "stereo is never Atmos");
  assert.equal(S.audioBadge(null), null);
});

test("audioFields: unknown is all null, formats", () => {
  assert.deepEqual(S.audioFields(null), { audio_channels: null, audio_codec: null, audio_format: null, audio_badge: null });
  assert.deepEqual(S.audioFields({ channels: 6, codec: "eac3" }), { audio_channels: 6, audio_codec: "eac3", audio_format: "E-AC3", audio_badge: "5.1" });
  assert.equal(S.audioFields({ channels: 8, codec: "truehd", profile: "Dolby TrueHD + Dolby Atmos" }).audio_badge, "Atmos");
  assert.equal(S.audioFields({ channels: 8, codec: "truehd", profile: "Dolby TrueHD + Dolby Atmos" }).audio_format, "Atmos");
  assert.equal(S.audioFields({ channels: 2, codec: "aac" }).audio_badge, null);
  assert.equal(S.audioFields({ channels: 2, codec: "aac" }).audio_format, "AAC");
  assert.equal(S.codecLabel("dts", "DTS-HD MA"), "DTS-HD MA");
  assert.equal(S.codecLabel("dts", null), "DTS");
  assert.equal(S.codecLabel("pcm_s24be"), "PCM");
  assert.equal(S.codecLabel(""), null);
});

test("summarizeTracks: max channels, codec of widest, atmos from labels", () => {
  const sum = S.summarizeTracks([
    { channels: 2, codec: "aac", label: "Hindi" },
    { channels: 6, codec: "eac3", label: "English Atmos" },
    { channels: null, codec: "ac3" },
  ]);
  assert.deepEqual(sum, { channels: 6, codec: "eac3", atmos: true });
  assert.equal(S.summarizeTracks([]), null);
  assert.equal(S.summarizeTracks(null), null);
  assert.equal(S.summarizeTracks([{ channels: 0 }]), null);
});

test("fromPanelAudio: ignores empty panel answers", () => {
  assert.equal(S.fromPanelAudio([]), null);
  assert.equal(S.fromPanelAudio({}), null);
  assert.equal(S.fromPanelAudio(null), null);
  assert.deepEqual(S.fromPanelAudio({ codec_name: "ac3", channels: 6 }), { channels: 6, codec: "ac3", profile: null, atmos: false });
  assert.equal(S.fromPanelAudio({ codec_name: "eac3", channels: "8", profile: "Dolby Digital Plus + Dolby Atmos" }).atmos, true);
});

test("summarizeSeries: max over episodes, learned tracks win", () => {
  const eps = {
    1: [{ id: "a", info: { audio: { channels: 2, codec_name: "aac" } } }, { id: "b", info: { audio: [] } }],
    2: [{ id: "c", info: { audio: { channels: 6, codec_name: "ac3" } } }],
  };
  const s = S.summarizeSeries(eps);
  assert.equal(s.channels, 6);
  assert.equal(s.known, 2);
  assert.equal(s.surround, 1);
  const learned = S.summarizeSeries(eps, (id) => (id === "b" ? { channels: 8, codec: "truehd", atmos: false } : null));
  assert.equal(learned.channels, 8);
  assert.equal(learned.known, 3);
  assert.equal(S.summarizeSeries({}), null);
  assert.equal(S.summarizeSeries(null), null);
});

test("sweepOrder: 4K first, then newest", () => {
  const ids = S.sweepOrder([
    { id: 1, tags: [], added: "100" },
    { id: 2, tags: ["4k"], added: "50" },
    { id: 3, tags: [], added: "300" },
    { id: 4, tags: ["4k"], added: "70" },
    { id: null },
  ]);
  assert.deepEqual(ids, [4, 2, 3, 1]);
});

function fakeCrawler(opts) {
  const known = new Set(opts.known || []);
  const probed = [];
  let sleeps = 0;
  let stopAfter = opts.stopAfter ?? 5;
  let crawler;
  crawler = S.createAudioCrawler({
    candidates: () => opts.sweep || [],
    isKnown: (id) => known.has(id),
    probe: async (id) => {
      probed.push(id);
      known.add(id);
      if (opts.fail && opts.fail.includes(id)) { known.delete(id); throw new Error("panel down"); }
      return "found";
    },
    sleep: async () => { sleeps++; if (probed.length >= stopAfter || sleeps > 50) crawler.stop(); },
    intervalMs: 1,
  });
  return { crawler, probed, known };
}

test("crawler: boosted ids first (newest boost first), then sweep, skips known", async () => {
  const { crawler, probed } = fakeCrawler({ sweep: [10, 11, 12], known: [11], stopAfter: 4 });
  crawler.boost([20, 21]);
  crawler.boost([22, 11]);
  assert.equal(crawler.stats().queued, 3, "known id not queued");
  crawler.start();
  await new Promise((r) => setTimeout(r, 20));
  assert.deepEqual(probed, [22, 21, 20, 10]);
});

test("crawler: transient failure backs off and continues", async () => {
  const { crawler, probed } = fakeCrawler({ sweep: [1, 2], fail: [1], stopAfter: 2 });
  crawler.start();
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(probed[0], 1);
  assert.equal(probed[1], 2);
  assert.equal(crawler.stats().errors, 1);
});

test("crawler: requires its callbacks", () => {
  assert.throws(() => S.createAudioCrawler({}));
});
