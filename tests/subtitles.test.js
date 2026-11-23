const test = require("node:test");
const assert = require("node:assert/strict");
const { srtToVtt, cacheName, pickBest, createSubtitleService } = require("../lib/subtitles");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

test("srtToVtt converts header, commas and strips BOM/CRLF", () => {
  const out = srtToVtt("﻿1\r\n00:00:01,000 --> 00:00:02,500\r\nHello, world\r\n\r\n2\r\n0:00:03,5 --> 0:00:04,25\r\nBye\r\n");
  assert.ok(out.startsWith("WEBVTT\n\n1\n00:00:01.000 --> 00:00:02.500\nHello, world\n"));
  assert.match(out, /\n00:00:03\.500 --> 00:00:04\.250\nBye\n$/);
  assert.ok(!out.includes("\r"));
});
test("srtToVtt leaves dialogue commas alone", () => {
  assert.match(srtToVtt("1\n00:00:01,000 --> 00:00:02,000\nWell, 10:30:15,5 ok\n"), /Well, 10:30:15,5 ok/);
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

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { decodeSubtitle, createSubtitleService } = require("../lib/subtitles");

test("srtToVtt strips {\\an8} tags, normalizes arrows, drops X1: coords, timing-only comma fix", () => {
  const out = srtToVtt("1\n00:00:01,000-->00:00:02,000 X1:100 X2:200 Y1:10 Y2:20\n{\\an8}Top, 12:00:00,500 text\n");
  assert.match(out, /\n00:00:01\.000 --> 00:00:02\.000\n/);
  assert.ok(!out.includes("X1:") && !out.includes("{\\an8}"));
  assert.match(out, /Top, 12:00:00,500 text/);
});
test("decodeSubtitle handles UTF-16 BOMs, cp1252 fallback, rejects NULs", () => {
  const le = Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from("hi नमस्ते", "utf16le")]);
  assert.equal(decodeSubtitle(le), "hi नमस्ते");
  const be = Buffer.from(le.subarray(2)); be.swap16();
  assert.equal(decodeSubtitle(Buffer.concat([Buffer.from([0xfe, 0xff]), be])), "hi नमस्ते");
  assert.equal(decodeSubtitle(Buffer.from([0x63, 0x61, 0x66, 0xe9])), "café");
  assert.throws(() => decodeSubtitle(Buffer.from("a\0b")));
});

function mockSvc(handler, clock = { t: 1_700_000_000_000 }) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "subs-"));
  const calls = [];
  const fetchImpl = async (url, opts = {}) => {
    calls.push({ url: String(url), method: opts.method || "GET", headers: opts.headers });
    return handler(String(url), opts);
  };
  const svc = createSubtitleService({ dataDir, env: { OPENSUBTITLES_API_KEY: "k", OPENSUBTITLES_USER: "u", OPENSUBTITLES_PASS: "p" }, fetchImpl, now: () => clock.t });
  return { svc, calls, dataDir, clock };
}
const J = (o, status = 200, h = {}) => ({ ok: status < 300, status, headers: { get: (k) => h[k.toLowerCase()] ?? null }, json: async () => o, arrayBuffer: async () => Buffer.from(JSON.stringify(o)) });
const searchHit = J({ data: [{ attributes: { language: "en", files: [{ file_id: 7 }], feature_details: { year: 1999 } } }] });
const SRT = "1\n00:00:01,000 --> 00:00:02,000\nHi\n";
const happy = (u, o) => {
  if (u.endsWith("/login")) return J({ token: "t", base_url: "api.opensubtitles.com" });
  if (u.includes("/subtitles?")) return searchHit;
  if (u.endsWith("/download")) return J({ link: "http://f/x.srt", remaining: 15 });
  return { ok: true, status: 200, headers: { get: () => null }, arrayBuffer: async () => Buffer.from(SRT) };
};
const req = { mode: "movie", id: "1", lang: "en", tmdbId: 603, year: 1999 };

test("search does not login; login happens only for download; result cached", async () => {
  const { svc, calls } = mockSvc(happy);
  const f = await svc.getVtt(req);
  assert.ok(fs.readFileSync(f, "utf8").startsWith("WEBVTT"));
  assert.ok(calls[0].url.includes("/subtitles?") && !calls[0].headers.Authorization);
  assert.ok(calls[1].url.endsWith("/login"));
  const n = calls.length;
  await svc.getVtt(req);
  assert.equal(calls.length, n);
});
test("login failure backs off globally for ~10 min", async () => {
  const { svc, calls, clock } = mockSvc((u) => (u.endsWith("/login") ? J({}, 401) : happy(u)));
  assert.equal(await svc.getVtt(req), null);
  const n = calls.length;
  assert.equal(await svc.getVtt({ ...req, id: "2" }), null);
  assert.equal(calls.filter((c) => c.url.endsWith("/login")).length, 1);
  assert.equal(calls.length, n); // no search, no login during backoff
  clock.t += 11 * 60 * 1000;
  await svc.getVtt({ ...req, id: "3" });
  assert.equal(calls.filter((c) => c.url.endsWith("/login")).length, 2);
});
test("per-name failure is cached 15 min; 429 is a short rate limit, not a quota lockout", async () => {
  let mode = "bad";
  const { svc, calls, clock, dataDir } = mockSvc((u) => (u.endsWith("/download") ? (mode === "bad" ? J({}, 500) : J({}, 429, { "retry-after": "3" })) : happy(u)));
  assert.equal(await svc.getVtt(req), null);
  const n = calls.length;
  assert.equal(await svc.getVtt(req), null);
  assert.equal(calls.length, n);
  clock.t += 16 * 60 * 1000;
  mode = "429";
  assert.equal(await svc.getVtt(req), null);
  const m = calls.length;
  assert.equal(await svc.getVtt({ ...req, id: "9" }), null); // rate limited
  assert.equal(calls.length, m);
  assert.ok(!fs.existsSync(path.join(dataDir, "subtitles", "_state.json")) || !JSON.parse(fs.readFileSync(path.join(dataDir, "subtitles", "_state.json"), "utf8")).exhaustedUntil);
  clock.t += 5000;
  mode = "ok";
  const f = await mockSvc(happy).svc.getVtt(req); assert.ok(f);
});
test("406 or remaining<=3 locks out downloads until next UTC day", async () => {
  const { svc, calls, clock } = mockSvc((u) => (u.endsWith("/download") ? J({ link: "http://f/x", remaining: 3 }) : happy(u)));
  assert.ok(await svc.getVtt(req));
  const n = calls.length;
  assert.equal(await svc.getVtt({ ...req, id: "2" }), null);
  assert.equal(calls.length, n);
  clock.t += 25 * 3600 * 1000;
  assert.ok(await svc.getVtt({ ...req, id: "2" }) !== undefined);
  assert.ok(calls.length > n);
});
test("oversize and cue-less downloads are not cached", async () => {
  const big = mockSvc((u) => (u.startsWith("http://f/") ? { ok: true, status: 200, headers: { get: (k) => (k === "content-length" ? "3000000" : null) }, arrayBuffer: async () => Buffer.alloc(10) } : happy(u)));
  assert.equal(await big.svc.getVtt(req), null);
  const junk = mockSvc((u) => (u.startsWith("http://f/") ? { ok: true, status: 200, headers: { get: () => null }, arrayBuffer: async () => Buffer.from("<html>nope</html>") } : happy(u)));
  assert.equal(await junk.svc.getVtt(req), null);
  assert.ok(!fs.existsSync(path.join(junk.dataDir, "subtitles", "movie_1_en.vtt")));
});
test("queue depth over 3 throws busy", async () => {
  let release; const gate = new Promise((r) => (release = r));
  const { svc } = mockSvc(async (u, o) => { if (u.includes("/subtitles?")) await gate; return happy(u, o); });
  const ps = [1, 2, 3].map((i) => svc.getVtt({ ...req, id: String(i) }));
  await assert.rejects(svc.getVtt({ ...req, id: "4" }), (e) => e.busy === true);
  release(); await Promise.all(ps);
});

test("search 401/403 triggers global backoff with no further upstream calls", async () => {
  const { svc, calls } = mockSvc((u) => (u.includes("/subtitles?") ? J({}, 403) : happy(u)));
  assert.equal(await svc.getVtt(req), null);
  const n = calls.length;
  assert.equal(await svc.getVtt({ ...req, id: "2" }), null);
  assert.equal(await svc.getVtt({ ...req, id: "3", lang: "hi" }), null);
  assert.equal(calls.length, n);
});

test("isCached is true only when the VTT file exists", () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "subs-"));
  const svc = createSubtitleService({ dataDir, env: {} });
  const ctx = { mode: "movie", id: "42" };
  assert.equal(svc.isCached({ ...ctx, lang: "en" }), false);
  const dir = path.join(dataDir, "subtitles");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, cacheName("movie", "42", "en")), "WEBVTT\n");
  assert.equal(svc.isCached({ ...ctx, lang: "en" }), true);
  assert.equal(svc.isCached({ ...ctx, lang: "hi" }), false);
  assert.equal(svc.isCached({ mode: "movie", id: "../x", lang: "en" }), false);
});
