const test = require("node:test");
const assert = require("node:assert/strict");
const { srtToVtt, cacheName, pickBest } = require("../lib/subtitles");

test("srtToVtt converts header, commas and strips BOM/CRLF", () => {
  const out = srtToVtt("﻿1\r\n00:00:01,000 --> 00:00:02,500\r\nHello, world\r\n\r\n2\r\n0:00:03,5 --> 0:00:04,25\r\nBye\r\n");
  assert.ok(out.startsWith("WEBVTT\n\n1\n00:00:01.000 --> 00:00:02.500\nHello, world\n"));
  assert.match(out, /\n00:00:03\.500 --> 00:00:04\.250\nBye\n$/);
  assert.ok(!out.includes("\r"));
});
test("srtToVtt leaves dialogue commas alone", () => {
  assert.match(srtToVtt("1\n00:00:01,000 --> 00:00:02,000\nWell, 10:30:15,5 ok\n"), /Well, 10:30:15\.5 ok/);
});
test("cacheName accepts valid input", () => {
  assert.equal(cacheName("movie", "123", "en"), "movie_123_en.vtt");
  assert.equal(cacheName("series", "9", "hi", "2", "05"), "series_9_s2e5_hi.vtt");
});
test("cacheName rejects traversal / bad input", () => {
  for (const [m, id, l, s, e] of [
    ["movie", "../etc/passwd", "en"], ["movie", "1/2", "en"], ["movie", "1", "../en"], ["movie", "1", "fr"],
    ["movie", "", "en"], ["disk", "1", "en"], ["series", "1", "en"], ["series", "1", "en", "1/..", "2"],
    ["movie", "1", "__proto__"], ["movie", "1", "constructor"],
  ]) assert.equal(cacheName(m, id, l, s, e), null, [m, id, l].join());
});
test("pickBest prefers year, non-HI, then downloads; exact language", () => {
  const r = (language, hi, dl, year, fid) => ({ attributes: { language, hearing_impaired: hi, download_count: dl, feature_details: { year }, files: [{ file_id: fid }] } });
  assert.equal(pickBest([r("en", true, 999, 1999, 1), r("en", false, 5, 1999, 2), r("en", false, 50, 2005, 3), r("hi", false, 9, 1999, 4)], { lang: "en", year: 1999 }), 2);
  assert.equal(pickBest([r("en", false, 1, 1999, 1)], { lang: "hi", year: 1999 }), null);
  assert.equal(pickBest([r("en", true, 9, 1999, 1)], { lang: "en", year: 1999 }), 1);
});
