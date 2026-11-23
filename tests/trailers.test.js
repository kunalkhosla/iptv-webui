const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const http = require("node:http");
const express = require("express");
const {
  createTrailerCache, isValidTrailerKey, trailerRouteHandler, makeYtDlpDownloader, ytDlpArgs, newestVersion, ytDlpEnv,
} = require("../lib/trailer-cache");
const {
  buildTrailerKeyIndex, trailerKeyAllowed,
  pickTrailerKey, releaseMsOf, selectNewTrailers, backfillCandidates, applyReleaseInfo,
} = require("../lib/new-trailers");

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "trailers-"));
const DAY = 86400_000;
const BIG = 64 * 1024;

// Fake downloader: writes `bytes` into tmpDir/<key>.mp4 after `ms`.
function fakeDownload({ ms = 5, bytes = BIG, fail = new Set(), log = [] } = {}) {
  return async (key, tmpDir) => {
    log.push(key);
    await new Promise((r) => setTimeout(r, ms));
    if (fail.has(key)) throw new Error("boom");
    const f = path.join(tmpDir, `${key}.mp4`);
    fs.writeFileSync(f, Buffer.alloc(bytes, 7));
    return f;
  };
}

test("key validation", () => {
  for (const k of ["Way9Dexny3w", "abc_-12", "A".repeat(20)]) assert.ok(isValidTrailerKey(k), k);
  for (const k of ["abc", "A".repeat(21), "../etc", "a.b.c.d.e", "abc def", "", null, 123]) assert.ok(!isValidTrailerKey(k), String(k));
});

test("ensure downloads once, dedupes concurrent requests, then serves from disk", async () => {
  const dir = tmp(); const log = [];
  const c = createTrailerCache({ dir, download: fakeDownload({ ms: 30, log }) });
  const [a, b, d] = await Promise.all([c.ensure("aaaaaa1"), c.ensure("aaaaaa1"), c.ensure("aaaaaa1")]);
  assert.equal(a, path.join(dir, "aaaaaa1.mp4"));
  assert.equal(b, a); assert.equal(d, a);
  assert.deepEqual(log, ["aaaaaa1"]);
  assert.equal(await c.ensure("aaaaaa1"), a);
  assert.equal(log.length, 1);
  assert.ok(c.has("aaaaaa1"));
  assert.deepEqual(fs.readdirSync(path.join(dir, ".tmp")), []); // temp dir cleaned
});

test("failures are negative-cached for the TTL and leave nothing behind", async () => {
  const dir = tmp(); const log = []; let now = 1e12;
  const c = createTrailerCache({ dir, download: fakeDownload({ log, fail: new Set(["bad_key1"]) }), negTtlMs: 1000, now: () => now });
  assert.equal(await c.ensure("bad_key1"), null);
  assert.equal(await c.ensure("bad_key1"), null);
  assert.equal(log.length, 1, "second call is a negative-cache hit");
  assert.ok(c.isNegative("bad_key1"));
  now += 1001;
  assert.ok(!c.isNegative("bad_key1"));
  assert.equal(await c.ensure("bad_key1"), null);
  assert.equal(log.length, 2);
  assert.deepEqual(fs.readdirSync(dir).filter((f) => f.endsWith(".mp4")), []);
});

test("a tiny/empty output is treated as a failure", async () => {
  const dir = tmp();
  const c = createTrailerCache({ dir, download: fakeDownload({ bytes: 10 }) });
  assert.equal(await c.ensure("tinyfile"), null);
  assert.ok(!c.has("tinyfile"));
});

test("concurrency cap; viewer (high) requests jump queued prefetch (low)", async () => {
  const dir = tmp(); const order = []; let running = 0, peak = 0;
  const c = createTrailerCache({
    dir, concurrency: 2,
    download: async (key, tmpDir) => {
      running++; peak = Math.max(peak, running); order.push(key);
      await new Promise((r) => setTimeout(r, 20));
      running--;
      const f = path.join(tmpDir, "x.mp4"); fs.writeFileSync(f, Buffer.alloc(BIG)); return f;
    },
  });
  const ps = ["low_aaa1", "low_aaa2", "low_aaa3", "low_aaa4"].map((k) => c.ensure(k, { priority: "low" }));
  await new Promise((r) => setImmediate(r));
  ps.push(c.ensure("high_aaa", { priority: "high" }));
  await Promise.all(ps);
  assert.equal(peak, 2);
  assert.equal(order.indexOf("high_aaa"), 2, `high should run right after the first two: ${order}`);
});

test("evict: drops files unused for the TTL, then LRU until under the size cap", () => {
  const dir = tmp(); const now = 1e12;
  const c = createTrailerCache({ dir, download: fakeDownload(), ttlMs: 10 * DAY, maxBytes: 2 * BIG, now: () => now });
  const mk = (k, ageDays) => {
    const f = path.join(dir, `${k}.mp4`); fs.writeFileSync(f, Buffer.alloc(BIG));
    const t = new Date(now - ageDays * DAY); fs.utimesSync(f, t, t);
  };
  mk("stale_one", 11); mk("old_lru1", 5); mk("mid_lru2", 3); mk("new_lru3", 1);
  const r = c.evict();
  assert.equal(r.removed, 2);
  assert.deepEqual(fs.readdirSync(dir).filter((f) => f.endsWith(".mp4")).sort(), ["mid_lru2.mp4", "new_lru3.mp4"]);
  assert.equal(r.totalBytes, 2 * BIG);
});

test("serving touches mtime so a used trailer is not evicted", async () => {
  const dir = tmp(); let now = 1e12;
  const c = createTrailerCache({ dir, download: fakeDownload(), ttlMs: 10 * DAY, now: () => now });
  await c.ensure("keepme01");
  now += 9 * DAY; await c.ensure("keepme01"); // used again
  now += 9 * DAY;
  assert.equal(c.evict().removed, 0);
  now += 2 * DAY;
  assert.equal(c.evict().removed, 1);
});

test("crash leftovers in .tmp are cleared on start", () => {
  const dir = tmp();
  fs.mkdirSync(path.join(dir, ".tmp", "abcdef-1234"), { recursive: true });
  fs.writeFileSync(path.join(dir, ".tmp", "abcdef-1234", "x.mp4.part"), "x");
  createTrailerCache({ dir, download: fakeDownload() });
  assert.deepEqual(fs.readdirSync(path.join(dir, ".tmp")), []);
});

// --- HTTP: the real handler on an ephemeral express server -----------------
async function withServer(handler, fn) {
  const app = express();
  app.get("/api/trailer/:key.mp4", handler);
  const srv = http.createServer(app);
  await new Promise((r) => srv.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${srv.address().port}`;
  try { await fn(base); } finally { srv.close(); }
}

test("GET /api/trailer: download-then-serve, Range 206, 404 on failure, 400 on bad key", async () => {
  const dir = tmp(); const log = [];
  const c = createTrailerCache({ dir, download: fakeDownload({ log, fail: new Set(["nopenope"]) }) });
  await withServer(trailerRouteHandler({ cache: c }), async (base) => {
    let r = await fetch(`${base}/api/trailer/Way9Dexny3w.mp4`);
    assert.equal(r.status, 200);
    assert.equal(r.headers.get("content-type"), "video/mp4");
    assert.equal(r.headers.get("accept-ranges"), "bytes");
    assert.equal((await r.arrayBuffer()).byteLength, BIG);

    r = await fetch(`${base}/api/trailer/Way9Dexny3w.mp4`, { headers: { Range: "bytes=100-199" } });
    assert.equal(r.status, 206);
    assert.equal(r.headers.get("content-range"), `bytes 100-199/${BIG}`);
    assert.equal((await r.arrayBuffer()).byteLength, 100);
    assert.equal(log.length, 1);

    r = await fetch(`${base}/api/trailer/nopenope.mp4`);
    assert.equal(r.status, 404);
    assert.deepEqual(await r.json(), { error: "trailer_unavailable" });
    const t0 = Date.now();
    r = await fetch(`${base}/api/trailer/nopenope.mp4`);
    assert.equal(r.status, 404);
    assert.ok(Date.now() - t0 < 200, "negative cache answers fast");
    assert.equal(log.filter((k) => k === "nopenope").length, 1);

    r = await fetch(`${base}/api/trailer/a%2F..%2Fx.mp4`);
    assert.equal(r.status, 400);
  });
});

test("GET /api/trailer: yt-dlp unavailable -> 404 without trying, cached still served", async () => {
  const dir = tmp(); const log = [];
  const c = createTrailerCache({ dir, download: fakeDownload({ log }) });
  await c.ensure("cached01");
  await withServer(trailerRouteHandler({ cache: c, available: () => false }), async (base) => {
    assert.equal((await fetch(`${base}/api/trailer/cached01.mp4`)).status, 200);
    assert.equal((await fetch(`${base}/api/trailer/notcached.mp4`)).status, 404);
    assert.deepEqual(log, ["cached01"]);
  });
});

// --- yt-dlp wrapper with a fake binary -------------------------------------
test("yt-dlp downloader: args, success, failure and timeout", async (t) => {
  const bin = path.join(tmp(), "fake-yt-dlp");
  fs.writeFileSync(bin, `#!/bin/sh
url=""; for a in "$@"; do url="$a"; done
case "$url" in
  *v=okokok1) head -c 70000 /dev/zero > okokok1.mp4 ;;
  *v=slowww1) sleep 5 ;;
  *) echo "ERROR: [youtube] Video unavailable" >&2; exit 1 ;;
esac
`, { mode: 0o755 });
  const errors = [];
  const dl = makeYtDlpDownloader({ bin: () => bin, onError: (m) => errors.push(m) });
  const d1 = tmp();
  assert.equal(await dl("okokok1", d1, { timeoutMs: 5000 }), path.join(d1, "okokok1.mp4"));
  await assert.rejects(dl("missing1", tmp(), { timeoutMs: 5000 }), /Video unavailable/);
  const t0 = Date.now();
  await assert.rejects(dl("slowww1", tmp(), { timeoutMs: 300 }), /timed out/);
  assert.ok(Date.now() - t0 < 3000);
  assert.equal(errors.length, 2);
  const args = ytDlpArgs("okokok1");
  assert.equal(args[args.length - 1], "https://www.youtube.com/watch?v=okokok1");
  assert.equal(args[args.length - 2], "--", "url after -- so a key starting with '-' is not an option");
  assert.ok(args.includes("--js-runtimes"));
  assert.match(args[args.indexOf("-f") + 1], /height<=720/);
});

test("newestVersion picks the newest working yt-dlp", () => {
  assert.equal(newestVersion([{ bin: "a", version: "2026.10.26" }, { bin: "b", version: "2026.11.02" }, { bin: "c", version: null }]).bin, "b");
  assert.equal(newestVersion([{ bin: "c", version: null }]), null);
});

// --- New trailers rail + release-date backfill ------------------------------
test("pickTrailerKey prefers official trailer, then trailer, teaser, any YouTube", () => {
  const v = (type, key, official = false, site = "YouTube") => ({ type, key, official, site });
  assert.equal(pickTrailerKey({ results: [v("Teaser", "t"), v("Trailer", "x"), v("Trailer", "o", true)] }), "o");
  assert.equal(pickTrailerKey([v("Clip", "c"), v("Teaser", "t")]), "t");
  assert.equal(pickTrailerKey([v("Trailer", "vim", true, "Vimeo"), v("Clip", "c")]), "c");
  assert.equal(pickTrailerKey(null), null);
});

test("selectNewTrailers: window, trailer required, filters, tmdb dedupe, newest first", () => {
  const now = Date.parse("2026-11-23T12:00:00Z");
  const iso = (daysAgo) => new Date(now - daysAgo * DAY).toISOString().slice(0, 10);
  const cache = {
    1: { source: "tmdb", tmdb_id: 100, trailer_key: "k100", release_date: iso(10) },
    2: { source: "tmdb", tmdb_id: 100, trailer_key: "k100", release_date: iso(10), poster_path: "/p.jpg" }, // 4K copy, has poster
    3: { source: "tmdb", tmdb_id: 200, trailer_key: "k200", release_date: iso(3) },
    4: { source: "tmdb", tmdb_id: 300, trailer_key: null, release_date: iso(3) },   // no trailer
    5: { source: "tmdb", tmdb_id: 400, trailer_key: "k400", release_date: iso(150) }, // too old for movies
    6: { source: "tmdb", tmdb_id: 500, trailer_key: "k500", release_date: iso(-30) }, // not out yet
    7: { source: "tmdb", tmdb_id: 600, trailer_key: "k600", release_date: iso(20) },  // filtered
    8: { source: "tmdb", tmdb_id: 700, trailer_key: "k700", year: "2026" },           // no release_date yet
    9: { source: "tmdb", tmdb_id: 800, trailer_key: "k800", release_date: iso(100) },
  };
  const items = Object.keys(cache).map((id) => ({ id: Number(id), name: `t${id}` }));
  const r = selectNewTrailers({ items, tmdbFor: (id) => cache[id], mode: "movie", now, passes: (s) => s.id !== 7 });
  assert.deepEqual(r.map((x) => x.s.id), [3, 2, 9]);
  const rs = selectNewTrailers({ items, tmdbFor: (id) => cache[id], mode: "series", now, passes: (s) => s.id !== 7 });
  assert.deepEqual(rs.map((x) => x.s.id), [3, 2], "series window is 90 days");
});

test("releaseMsOf only accepts YYYY-MM-DD", () => {
  assert.equal(releaseMsOf({ release_date: "2026-11-01" }), Date.parse("2026-11-01T00:00:00Z"));
  assert.equal(releaseMsOf({ release_date: "2026" }), null);
  assert.equal(releaseMsOf({}), null);
});

test("backfillCandidates: only recent library entries missing release_date; one call per tmdb_id", () => {
  const now = Date.parse("2026-11-23T12:00:00Z");
  const entries = [
    ["movie:1", { source: "tmdb", tmdb_id: 10, year: "2026" }],
    ["movie:2", { source: "tmdb", tmdb_id: 10, year: "2026" }],            // same title, other copy
    ["movie:3", { source: "tmdb", tmdb_id: 11, year: "2019" }],            // too old to matter
    ["movie:4", { source: "tmdb", tmdb_id: 12, year: "2026", release_date: "2026-10-01", trailer_key: "x" }], // done
    ["series:5", { source: "tmdb", tmdb_id: 13, year: null }],             // unknown year -> check
    ["movie:6", { source: "no-match", tmdb_id: null }],
    ["movie:7", { source: "tmdb", tmdb_id: 14, year: "2026", release_date: "2026-11-01", trailer_key: null, trailer_checked_at: now - 8 * DAY }],
    ["movie:8", { source: "tmdb", tmdb_id: 15, year: "2026", release_date: "2026-11-01", trailer_key: null, trailer_checked_at: now - DAY }],
    ["disk:9", { source: "tmdb", tmdb_id: 16, year: "2026" }],
    ["movie:10", undefined],
  ];
  const c = backfillCandidates({ entries, now });
  assert.deepEqual(c.map((x) => `${x.kind}:${x.tmdbId}:${x.keys.join("+")}`),
    ["movie:10:movie:1+movie:2", "series:13:series:5", "movie:14:movie:7"]);
});

test("applyReleaseInfo stores the date and a trailer, keeps an existing trailer", () => {
  const e = { trailer_key: "old" };
  applyReleaseInfo(e, "series", { first_air_date: "2026-10-05", videos: { results: [] } }, 5);
  assert.deepEqual(e, { trailer_key: "old", release_date: "2026-10-05", trailer_checked_at: 5 });
  const m = {};
  applyReleaseInfo(m, "movie", { release_date: "", videos: { results: [{ site: "YouTube", type: "Trailer", key: "new" }] } }, 6);
  assert.deepEqual(m, { release_date: null, trailer_key: "new", trailer_checked_at: 6 });
});

test("timeouts are remembered briefly; clearNegative forgets all failures", async () => {
  const dir = tmp(); let now = 1e12; let mode = "timeout";
  const c = createTrailerCache({
    dir, now: () => now, negTtlMs: 6 * 3600_000, timeoutNegTtlMs: 15 * 60_000,
    download: async () => { throw new Error(mode === "timeout" ? "yt-dlp exit null:  timed out" : "Video unavailable"); },
  });
  assert.equal(await c.ensure("slowkey1"), null);
  mode = "gone";
  assert.equal(await c.ensure("gonekey1"), null);
  now += 16 * 60_000;
  assert.ok(!c.isNegative("slowkey1"), "timeout memory is 15 min");
  assert.ok(c.isNegative("gonekey1"), "hard failure memory is 6 h");
  assert.equal(c.clearNegative(), 1);
  assert.ok(!c.isNegative("gonekey1"));
});

test("backstop frees the slot when a download never settles", async () => {
  const dir = tmp();
  const c = createTrailerCache({ dir, concurrency: 1, timeoutMs: 20, backstopMs: 20, download: () => new Promise(() => {}) });
  const t0 = Date.now();
  assert.equal(await c.ensure("hungkey1"), null);
  assert.ok(Date.now() - t0 < 1000);
  assert.equal(c.busy(), false);
  assert.ok(c.isNegative("hungkey1"));
});

test("GET /api/trailer: stable ETag across requests; If-Range and If-None-Match work", async () => {
  const dir = tmp();
  const c = createTrailerCache({ dir, download: fakeDownload() });
  await withServer(trailerRouteHandler({ cache: c }), async (base) => {
    const u = `${base}/api/trailer/etagkey1.mp4`;
    const r1 = await fetch(u); await r1.arrayBuffer();
    const r2 = await fetch(u); await r2.arrayBuffer();
    const etag = r1.headers.get("etag");
    assert.equal(etag, `"etagkey1-${BIG}"`);
    assert.equal(r2.headers.get("etag"), etag);
    let r = await fetch(u, { headers: { Range: "bytes=10-19", "If-Range": etag } });
    assert.equal(r.status, 206); assert.equal((await r.arrayBuffer()).byteLength, 10);
    r = await fetch(u, { headers: { Range: "bytes=10-19", "If-Range": '"other"' } });
    assert.equal(r.status, 200); assert.equal((await r.arrayBuffer()).byteLength, BIG);
    // http.get, not fetch: fetch adds Cache-Control: no-cache to conditional requests.
    const status = await new Promise((resolve, reject) => {
      http.get(u, { headers: { "If-None-Match": etag } }, (resp) => { resp.resume(); resolve(resp.statusCode); }).on("error", reject);
    });
    assert.equal(status, 304);
  });
});

test("GET /api/trailer: allowKey gates keys (404, no download); HEAD never downloads", async () => {
  const dir = tmp(); const log = [];
  const c = createTrailerCache({ dir, download: fakeDownload({ log }) });
  const handler = trailerRouteHandler({ cache: c, allowKey: (k) => k !== "notallowed" });
  const app = express();
  app.get("/api/trailer/:key.mp4", handler);
  const srv = http.createServer(app);
  await new Promise((r) => srv.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${srv.address().port}`;
  try {
    let r = await fetch(`${base}/api/trailer/notallowed.mp4`);
    assert.equal(r.status, 404);
    assert.deepEqual(await r.json(), { error: "trailer_unavailable" });
    r = await fetch(`${base}/api/trailer/headkey1.mp4`, { method: "HEAD" });
    assert.equal(r.status, 404);
    assert.deepEqual(log, [], "neither a disallowed key nor HEAD downloads");
    await (await fetch(`${base}/api/trailer/headkey1.mp4`)).arrayBuffer();
    r = await fetch(`${base}/api/trailer/headkey1.mp4`, { method: "HEAD" });
    assert.equal(r.status, 200);
    assert.equal(r.headers.get("content-length"), String(BIG));
  } finally { srv.close(); }
});

test("trailer key allow-list: known keys only; kids need a title rated within their certs", () => {
  const idx = buildTrailerKeyIndex([
    ["movie:1", { source: "tmdb", tmdb_id: 1, trailer_key: "familyK", us_cert: "PG" }],
    ["movie:2", { source: "tmdb", tmdb_id: 2, trailer_key: "adultK1", us_cert: "R" }],
    ["movie:3", { source: "tmdb", tmdb_id: 3, trailer_key: "unratedK", us_cert: "" }],
    ["movie:4", { source: "no-match", tmdb_id: null, trailer_key: "ghostK1" }],
  ]);
  const kid = new Set(["G", "PG"]);
  assert.ok(trailerKeyAllowed(idx, "familyK", null));
  assert.ok(trailerKeyAllowed(idx, "adultK1", null));
  assert.ok(!trailerKeyAllowed(idx, "randomYT", null), "arbitrary YouTube ids are refused");
  assert.ok(!trailerKeyAllowed(idx, "ghostK1", null));
  assert.ok(trailerKeyAllowed(idx, "familyK", kid));
  assert.ok(!trailerKeyAllowed(idx, "adultK1", kid));
  assert.ok(!trailerKeyAllowed(idx, "unratedK", kid));
});

test("yt-dlp gets a minimal environment (no server secrets)", async () => {
  const env = ytDlpEnv("/x/tmp/k", { PATH: "/bin", HOME: "/root", LANG: "C.UTF-8", TMDB_API_KEY: "s", PROXY_SECRET: "s", IPTV_PASS: "s" });
  assert.deepEqual(Object.keys(env).sort(), ["HOME", "LANG", "PATH", "XDG_CACHE_HOME"]);
  // And the spawned process really sees only that.
  const bin = path.join(tmp(), "envdump");
  fs.writeFileSync(bin, "#!/bin/sh\nenv > env.txt\nhead -c 70000 /dev/zero > out.mp4\n", { mode: 0o755 });
  process.env.TRAILER_TEST_SECRET = "do-not-leak";
  try {
    const d = tmp();
    await makeYtDlpDownloader({ bin })("envkey01", d, { timeoutMs: 5000 });
    const dumped = fs.readFileSync(path.join(d, "env.txt"), "utf8");
    assert.doesNotMatch(dumped, /TRAILER_TEST_SECRET|do-not-leak/);
    assert.match(dumped, /^XDG_CACHE_HOME=/m);
  } finally { delete process.env.TRAILER_TEST_SECRET; }
});

// --- server.js wiring (static) ----------------------------------------------
test("server.js wires the trailer route, rail and release_date", () => {
  const s = fs.readFileSync(path.join(__dirname, "..", "server.js"), "utf8");
  assert.match(s, /app\.get\("\/api\/trailer\/:key\.mp4", trailerRouteHandler\(\{[\s\S]{0,200}allowKey: /);
  assert.match(s, /title: "New trailers",\s*\n\s*category_id: "__rail-new-trailers"/);
  assert.match(s, /tile\.trailer_key = t\.trailer_key/);
  assert.match(s, /release_date:\s+\/\^/);
  // The trailer route must sit behind the session-auth middleware.
  const auth = s.indexOf("if (PUBLIC_PATHS.has(req.path)) return next();");
  assert.ok(auth > 0 && s.indexOf('app.get("/api/trailer/') > auth);
  // Trailer code never touches stream admission.
  const block = s.slice(s.indexOf("// ── Native trailers"), s.indexOf('app.get("/api/home/'));
  assert.doesNotMatch(block, /admit|streams\.set|panelUrl|xtream/i);
});

test("Dockerfile installs a pinned, checksum-verified yt-dlp", () => {
  const d = fs.readFileSync(path.join(__dirname, "..", "Dockerfile"), "utf8");
  assert.match(d, /ARG YTDLP_VERSION=\d{4}\.\d{2}\.\d{2}/);
  assert.match(d, /sha256sum -c -/);
});
