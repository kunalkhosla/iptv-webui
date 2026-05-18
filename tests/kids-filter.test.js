// Hard guarantee: kid profiles must NEVER see R / NC-17 / TV-MA
// content. The web (and by extension the TV / phone clients that
// consume the same /api/* endpoints) must filter server-side; no
// client is allowed to be the gate.
//
// CI runs `npm test` BEFORE the build step, so a regression that
// would leak adult content to a kid profile fails the deploy and
// never reaches a panel.
//
// Two layers:
//   1. Unit tests on the pure predicate `makeKidsBlocker`
//   2. Static contract scan of server.js — every endpoint that
//      ships streams to the client MUST call `makeKidsBlocker`

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const {
  KIDS_CERT_TIERS,
  ALWAYS_ADULT_CERTS,
  allowedCertsForAge,
  kidAgeFromProfile,
  makeKidsBlocker,
} = require("../lib/kids-filter");

// ---------------------------------------------------------------------
// Pure-predicate tests
// ---------------------------------------------------------------------

test("non-kid profile blocks nothing", () => {
  const block = makeKidsBlocker({ id: "p1", nick: "Kunal" });
  assert.equal(block({ us_cert: "R" }), false);
  assert.equal(block({ us_cert: "TV-MA" }), false);
  assert.equal(block({ us_cert: "NC-17" }), false);
  assert.equal(block({ us_cert: "G" }), false);
  assert.equal(block({}), false);
  assert.equal(block(null), false);
});

test("undefined / null profile blocks nothing", () => {
  assert.equal(makeKidsBlocker(undefined)({ us_cert: "R" }), false);
  assert.equal(makeKidsBlocker(null)({ us_cert: "R" }), false);
});

test("kid profile (age 8) — only G / PG / kid-TV certs pass", () => {
  const thisYear = new Date().getFullYear();
  const block = makeKidsBlocker({ kidsBirthYear: thisYear - 8 });
  for (const ok of ["G", "TV-G", "TV-Y", "PG", "TV-Y7", "TV-PG"]) {
    assert.equal(block({ us_cert: ok }), false, `should allow ${ok}`);
  }
  assert.equal(block({ us_cert: "PG-13" }), true);   // not yet (10+)
  assert.equal(block({ us_cert: "TV-14" }),  true);  // not yet (13+)
  for (const bad of ["R", "NC-17", "TV-MA"]) {
    assert.equal(block({ us_cert: bad }), true, `must block ${bad}`);
  }
  // No cert: blocked (strict allow-list)
  assert.equal(block({}), true);
  assert.equal(block({ us_cert: null }), true);
  assert.equal(block({ us_cert: "" }), true);
});

test("kid profile (age 12) — PG-13 included; R / TV-MA still blocked", () => {
  const thisYear = new Date().getFullYear();
  const block = makeKidsBlocker({ kidsBirthYear: thisYear - 12 });
  assert.equal(block({ us_cert: "PG-13" }), false);
  assert.equal(block({ us_cert: "TV-14" }),  true); // not yet (13+)
  assert.equal(block({ us_cert: "R" }), true);
  assert.equal(block({ us_cert: "TV-MA" }), true);
  assert.equal(block({ us_cert: "NC-17" }), true);
});

test("kid profile (age 15) — TV-14 included; R / TV-MA still blocked", () => {
  const thisYear = new Date().getFullYear();
  const block = makeKidsBlocker({ kidsBirthYear: thisYear - 15 });
  assert.equal(block({ us_cert: "TV-14" }), false);
  assert.equal(block({ us_cert: "R" }), true);
  assert.equal(block({ us_cert: "TV-MA" }), true);
  assert.equal(block({ us_cert: "NC-17" }), true);
});

test("ALWAYS_ADULT_CERTS is blocked at every kid age 0..17", () => {
  const thisYear = new Date().getFullYear();
  for (let age = 0; age <= 17; age++) {
    const block = makeKidsBlocker({ kidsBirthYear: thisYear - age });
    for (const cert of ALWAYS_ADULT_CERTS) {
      assert.equal(
        block({ us_cert: cert }),
        true,
        `age ${age} must block ${cert}`,
      );
    }
  }
});

test("KIDS_CERT_TIERS never lists an adult cert", () => {
  for (const tier of KIDS_CERT_TIERS) {
    for (const cert of tier.add) {
      assert.equal(
        ALWAYS_ADULT_CERTS.has(cert),
        false,
        `tier minAge=${tier.minAge} must not include ${cert}`,
      );
    }
  }
});

test("kidAgeFromProfile rejects garbage birth years", () => {
  assert.equal(kidAgeFromProfile({ kidsBirthYear: 0 }), null);
  assert.equal(kidAgeFromProfile({ kidsBirthYear: null }), null);
  assert.equal(kidAgeFromProfile({}), null);
  assert.equal(kidAgeFromProfile({ kidsBirthYear: "abc" }), null);
});

test("allowedCertsForAge: empty when age is invalid", () => {
  assert.equal(allowedCertsForAge(null).size, 0);
  assert.equal(allowedCertsForAge(NaN).size, 0);
});

// ---------------------------------------------------------------------
// Static contract: every endpoint shipping streams MUST apply
// `makeKidsBlocker`. The thin Android / phone clients trust the
// server entirely; if the server forgets to filter on a new endpoint,
// this test fails before the deploy can happen.
// ---------------------------------------------------------------------

test("contract: server.js wires makeKidsBlocker into every stream endpoint", () => {
  const src = fs.readFileSync(
    path.join(__dirname, "..", "server.js"),
    "utf8",
  );

  // Every endpoint that surfaces streams / tiles to the client.
  // Each entry: a regex that locates the route handler, plus a check
  // function that asserts `makeKidsBlocker` (or its predicate) is
  // applied inside that handler's body.
  const endpoints = [
    { name: "/api/home/:mode",          marker: /app\.get\("\/api\/home\/:mode/ },
    { name: "/api/index/:mode",         marker: /app\.get\("\/api\/index\/:mode/ },
    { name: "/api/:mode/streams",       marker: /app\.get\("\/api\/:mode\(live\|movie\|series\)\/streams/ },
    { name: "/api/search/all",          marker: /app\.get\("\/api\/search\/all/ },
    { name: "/api/search/:mode",        marker: /app\.get\("\/api\/search\/:mode/ },
  ];

  // Split source into per-handler bodies by tracking `app.get(` positions.
  const handlerBodies = (() => {
    const out = [];
    const positions = [];
    const re = /app\.(get|post|put|delete)\("/g;
    let m;
    while ((m = re.exec(src)) !== null) positions.push(m.index);
    positions.push(src.length);
    for (let i = 0; i < positions.length - 1; i++) {
      out.push(src.slice(positions[i], positions[i + 1]));
    }
    return out;
  })();

  for (const ep of endpoints) {
    const body = handlerBodies.find((b) => ep.marker.test(b));
    assert.ok(body, `endpoint ${ep.name} not found in server.js`);
    assert.match(
      body,
      /makeKidsBlocker\s*\(|isKidBlocked\s*\(|isKidSafe\s*\(/,
      `endpoint ${ep.name} ships streams but never calls makeKidsBlocker / isKidBlocked / isKidSafe — kids could leak through`,
    );
  }
});

test("contract: server.js imports makeKidsBlocker from lib/kids-filter", () => {
  const src = fs.readFileSync(
    path.join(__dirname, "..", "server.js"),
    "utf8",
  );
  assert.match(
    src,
    /require\(["']\.\/lib\/kids-filter["']\)/,
    "server.js must import from ./lib/kids-filter (single source of truth)",
  );
  assert.match(
    src,
    /makeKidsBlocker/,
    "server.js must reference makeKidsBlocker",
  );
});

test("contract: NO duplicate KIDS_CERT_TIERS definition outside lib/", () => {
  // If someone re-defines the tier table locally in server.js it'll
  // drift from the test source-of-truth. Allow exactly one
  // assignment, and only in lib/kids-filter.js.
  const root = path.join(__dirname, "..");
  const files = ["server.js"];
  for (const f of files) {
    const src = fs.readFileSync(path.join(root, f), "utf8");
    assert.equal(
      /const\s+KIDS_CERT_TIERS\s*=\s*\[/.test(src),
      false,
      `${f} re-defines KIDS_CERT_TIERS — must import from lib/kids-filter`,
    );
  }
});
