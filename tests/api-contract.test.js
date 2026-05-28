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
    "id", "name", "icon", "category_id", "category_name",
  ]);
});

// --- /api/search/all — consumed by the web's unified search and
// the Android phone's SearchScreen.
test("contract: /api/search/all returns { q, movie, series, live }", () => {
  const h = handlerFor(/app\.get\("\/api\/search\/all/);
  expectFields("/api/search/all", h, ["q", "movie", "series", "live"]);
  // Each item row fields.
  expectFields("/api/search/all item", h, [
    "id", "name", "icon", "poster", "year", "us_cert", "container",
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
