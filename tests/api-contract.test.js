// Public API contract — locks the response shape of every endpoint
// that an external client depends on. If a change to server.js
// drops or renames a field that one of the published clients
// (web UI, Android phone/TV, Home Assistant card) reads, this fails
// in CI before the deploy can happen.
//
// To add a new client integration: document the endpoint + the fields
// it consumes here. To rename or remove a field: update the consumer
// FIRST, ship it, only then drop the test entry.

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const SERVER = fs.readFileSync(
  path.join(__dirname, "..", "server.js"),
  "utf8",
);

// Slice server.js into per-handler bodies so each contract check can
// look at exactly one route. Reused from kids-filter.test.js.
function handlerFor(routePattern) {
  const positions = [];
  const re = /app\.(get|post|put|delete)\("/g;
  let m;
  while ((m = re.exec(SERVER)) !== null) positions.push(m.index);
  positions.push(SERVER.length);
  for (let i = 0; i < positions.length - 1; i++) {
    const body = SERVER.slice(positions[i], positions[i + 1]);
    if (routePattern.test(body)) return body;
  }
  return null;
}

// Asserts that a route's res.json() payload mentions every required
// key. We can't statically evaluate the JS, so we look for the field
// names appearing as object-literal keys inside the handler. False
// negatives are fine (a field could be set via spread); false
// positives are caught by other tests.
function expectFields(label, handler, fields) {
  assert.ok(handler, `${label}: handler not found in server.js`);
  for (const field of fields) {
    // Match either `field:` (explicit key) or `field,` / `field}` /
    // `field )` (ES6 shorthand object literal). Quoted variants too.
    const re = new RegExp(
      `["']?\\b${field}\\b["']?\\s*(?::|[,}\\)])`,
    );
    assert.match(
      handler,
      re,
      `${label}: response must include field "${field}" — external clients read it`,
    );
  }
}

// --- /api/search/:mode — consumed by Home Assistant's REST sensor
//
// HA's secrets.yaml + packages/iptv.yaml expect `count` (used as
// sensor value) and `results` (json_attributes). Each result row
// needs at minimum id, name, icon, category_id, category_name.
test("contract: /api/search/:mode returns { q, count, results }", () => {
  const h = handlerFor(/app\.get\("\/api\/search\/:mode/);
  expectFields("/api/search/:mode", h, ["q", "count", "results"]);
  // Each result row's fields — checked by literal property names
  // inside the handler's results.push(...) object.
  expectFields("/api/search/:mode result row", h, [
    "id", "name", "icon", "category_id", "category_name", "programme",
  ]);
});

// --- /api/search/all — consumed by the web's unified search and
// the Android phone's SearchScreen.
test("contract: /api/search/all returns { q, movie, series, live }", () => {
  const h = handlerFor(/app\.get\("\/api\/search\/all/);
  expectFields("/api/search/all", h, ["q", "movie", "series", "live"]);
  // Each item row fields.
  expectFields("/api/search/all item", h, [
    "id", "name", "icon", "poster", "year", "us_cert", "container", "programme",
  ]);
});

// --- /api/stream/:mode/:id.:ext — consumed by HA, web, Android.
// HA reads `transcode` (live) or `proxy` (vod) to feed the Cast
// media_content_id. Without these the cast fails silently.
test("contract: /api/stream/:mode/:id.:ext returns { direct, proxy, transcode, download, url }", () => {
  const h = handlerFor(/app\.get\("\/api\/stream\/:mode/);
  expectFields("/api/stream/...", h, ["direct", "proxy", "transcode", "download", "url"]);
});

// --- /api/home/:mode — consumed by web, Android phone, Android TV.
test("contract: /api/home/:mode returns { mode, rails, hero, chips }", () => {
  const h = handlerFor(/app\.get\("\/api\/home\/:mode/);
  expectFields("/api/home/:mode", h, ["mode", "rails", "hero", "chips", "ready"]);
});
// --- /api/collection/:lang/:mode — consumed by web, Android phone, TV
// (the dedicated single-language view, e.g. Hindi). Clients render its
// `rails` with the same rail/tile renderer as /api/home.
test("contract: /api/collection/:lang/:mode returns { lang, mode, rails }", () => {
  const h = handlerFor(/app\.get\("\/api\/collection\/:lang/);
  expectFields("/api/collection/:lang/:mode", h, ["lang", "mode", "rails", "ready"]);
  // Each rail row — clients read title/total/items (tiles).
  expectFields("/api/collection rail", h, ["title", "total", "items"]);
});
// --- /api/tracks/:mode/:id.:ext — consumed by web/phone/TV audio picker.
test("contract: /api/tracks/:mode/:id.:ext returns { audioTracks }", () => {
  const h = handlerFor(/app\.get\("\/api\/tracks\/:mode/);
  expectFields("/api/tracks/...", h, ["audioTracks"]);
});
test("contract: /api/home/:mode tile carries `container` for the MKV badge", () => {
  // Web/phone/TV tiles render a small "MKV" badge so the user knows
  // a title will go through the server transcoder before playback.
  // Drop this and the badge silently disappears.
  const src = require("fs").readFileSync(
    require("path").join(__dirname, "..", "server.js"), "utf8");
  if (!/container:\s*s\.container\s*\|\|\s*null/.test(src)) {
    throw new Error("home tileFor() no longer emits `container` — clients depend on it for the MKV badge");
  }
});

// --- /api/index/:mode — consumed by web, Android.
test("contract: /api/index/:mode returns { total, done, ready, streams }", () => {
  const h = handlerFor(/app\.get\("\/api\/index\/:mode/);
  expectFields("/api/index/:mode", h, ["total", "done", "ready", "streams"]);
});

// --- /api/bootstrap — consumed by every client at first load.
test("contract: /api/bootstrap returns profile + categories + userState + filterConfig", () => {
  const h = handlerFor(/app\.get\("\/api\/bootstrap/);
  expectFields("/api/bootstrap", h, [
    "categories", "profile", "userState", "filterConfig", "account",
  ]);
});

// --- /api/profiles, /api/profile/select — consumed by Android +
// web profile-picker.
test("contract: /api/profiles returns { profiles }", () => {
  const h = handlerFor(/app\.get\("\/api\/profiles/);
  expectFields("/api/profiles", h, ["profiles"]);
});

// --- /api/login — consumed by Android phone/TV login flow.
test("contract: POST /api/login returns { ok }", () => {
  const h = handlerFor(/app\.post\("\/api\/login/);
  expectFields("POST /api/login", h, ["ok"]);
});

// --- /api/epg/short/:streamId — consumed by web TV Guide + Android
// phone live tab.
test("contract: /api/epg/short/:streamId returns { stream_id, programs }", () => {
  const h = handlerFor(/app\.get\("\/api\/epg\/short/);
  expectFields("/api/epg/short", h, ["stream_id", "programs"]);
});

// --- /api/similar/:mode/:id — consumed by web detail modal, Android
// phone MoreLikeThisSection, Android TV detail screen. Uniform
// { ready, rails: [{kind, title, items}] } shape so every client
// just iterates rails[] without any local ordering / threshold logic.
test("contract: /api/similar/:mode/:id returns { ready, rails }", () => {
  const h = handlerFor(/app\.get\("\/api\/similar\/:mode/);
  expectFields("/api/similar/:mode/:id", h, ["ready", "rails"]);
  // Each rail carries kind / title / items — clients render exactly
  // these three. `kind` lets clients style collection vs. director
  // differently if they choose.
  expectFields("/api/similar rail", h, ["kind", "title", "items"]);
  // Each item is the standard tile shape (matches home/search/credits).
  expectFields("/api/similar tile", h, [
    "id", "name", "poster", "year", "us_cert", "tmdb_id", "container",
  ]);
});

// --- /api/:mode/streams — consumed by web (paginated grid) AND the
// Android app (bare List<Stream>). The bare-array default is load-bearing
// for Android: it deserializes the body straight to a list and would
// hard-fail on an object. Pagination is opt-in via ?limit only.
test("contract: /api/:mode/streams stays a bare array unless ?limit, else { items, total, hasMore }", () => {
  const h = handlerFor(/app\.get\("\/api\/:mode\(live\|movie\|series\|disk\)\/streams/);
  assert.ok(h, "/api/:mode/streams handler not found");
  // opt-in gate — pagination only when the caller passes ?limit
  if (!/hasPaging\s*=\s*req\.query\.limit\s*!==\s*undefined/.test(h)) {
    throw new Error("/streams pagination must be gated on ?limit (Android needs the bare-array default)");
  }
  // paginated branch shape
  expectFields("/api/:mode/streams paginated", h, ["items", "total", "hasMore"]);
  // bare-array default must remain (both index + panel-fallback paths)
  if (!/return res\.json\(deduped\)/.test(h) || !/res\.json\(mapped\)/.test(h)) {
    throw new Error("/streams must still return a bare array when ?limit is absent");
  }
});

// --- /api/refine/candidates/:mode — consumed by the web Refine modal +
// Android Refine screen (the diverse calibration batch). Clients render
// its `items` with the standard tile fields.
test("contract: /api/refine/candidates/:mode returns { mode, items }", () => {
  const h = handlerFor(/app\.get\("\/api\/refine\/candidates/);
  expectFields("/api/refine/candidates/:mode", h, ["mode", "items"]);
  expectFields("/api/refine/candidates item", h, [
    "id", "name", "icon", "year", "poster", "us_cert", "tags", "container",
  ]);
});

// --- /api/refine/rebuild — consumed by the web/Android Refine
// "Save & refresh". Clients branch on `ok` to decide whether to
// refetch home immediately or fall back to the overnight message.
test("contract: POST /api/refine/rebuild returns { ok, built }", () => {
  const h = handlerFor(/app\.post\("\/api\/refine\/rebuild/);
  expectFields("POST /api/refine/rebuild", h, ["ok", "built"]);
});

// --- userState.feedback — the per-profile thumbs / Refine store, read
// by every client (rides /api/bootstrap + PUT /api/user-state). Guard
// the wiring: it must be in the canonical shape AND accepted by the PUT.
test("contract: userState carries a `feedback` store the PUT accepts", () => {
  const src = require("fs").readFileSync(
    require("path").join(__dirname, "..", "server.js"), "utf8");
  if (!/feedback:\s*\{\s*up:\s*emptyModeBuckets\(\)/.test(src)) {
    throw new Error("emptyUserState() no longer seeds `feedback` — clients read userState.feedback");
  }
  const put = handlerFor(/app\.put\("\/api\/user-state/);
  assert.ok(put, "PUT /api/user-state handler not found");
  if (!/b\.feedback\b/.test(put)) {
    throw new Error("PUT /api/user-state no longer accepts `feedback` — clients push thumbs through it");
  }
});
