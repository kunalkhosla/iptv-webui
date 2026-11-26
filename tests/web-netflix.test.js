"use strict";
// Web client Netflix-style extras: pure helpers (public/nf-helpers.js) plus
// source-level wiring checks on public/app.js / index.html.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const NF = require("../public/nf-helpers.js");

const APP = fs.readFileSync(path.join(__dirname, "..", "public", "app.js"), "utf8");
const HTML = fs.readFileSync(path.join(__dirname, "..", "public", "index.html"), "utf8");
const SERVER = fs.readFileSync(path.join(__dirname, "..", "server.js"), "utf8");

test("frameFor: largest frame <= position, else the next one, gaps hidden", () => {
  const frames = [0, 12, 24, 36];
  assert.equal(NF.frameFor(frames, 0, 10), 0);
  assert.equal(NF.frameFor(frames, 13, 10), 12);
  assert.equal(NF.frameFor(frames, 36, 10), 36);
  assert.equal(NF.frameFor(frames, 60, 10), 36); // 24 s after the last frame, within 3 x 10
  assert.equal(NF.frameFor(frames, 67, 10), null); // past the gap
  assert.equal(NF.frameFor([100, 110], 80, 10), 100); // before the first frame, close
  assert.equal(NF.frameFor([100, 110], 50, 10), null);
  assert.equal(NF.frameFor([0, 10, 500], 300, 10), null); // hole nothing encoded
  assert.equal(NF.frameFor([], 10, 10), null);
  assert.equal(NF.frameFor(null, 10, 10), null);
  assert.equal(NF.frameFor([0, 10], NaN, 10), null);
});

test("frameUrl fills the {t} template", () => {
  assert.equal(NF.frameUrl({ url: "/api/trickplay/disk/abc/{t}.jpg" }, 24), "/api/trickplay/disk/abc/24.jpg");
  assert.equal(NF.frameUrl({}, 24), null);
});

test("previewLeft keeps the preview inside the container", () => {
  assert.equal(NF.previewLeft(0, 10, 500, 100, 520), 0);
  assert.equal(NF.previewLeft(1, 10, 500, 100, 520), 420);
  assert.equal(NF.previewLeft(0.5, 10, 500, 100, 520), 210);
});

test("skipAction: intro / recap spans, credits only with a next episode", () => {
  const m = { introStart: 30, introEnd: 61, recapStart: null, recapEnd: null, creditsStart: 2500 };
  assert.equal(NF.skipAction(m, 10, 2600, true), null);
  assert.deepEqual(NF.skipAction(m, 31, 2600, true), { kind: "intro", target: 61, label: "Skip intro" });
  assert.equal(NF.skipAction(m, 60.5, 2600, true), null); // last second: no-op seek
  assert.deepEqual(NF.skipAction(m, 2501, 2600, true), { kind: "credits", target: null, label: "Next episode" });
  assert.equal(NF.skipAction(m, 2501, 2600, false), null);
  assert.equal(NF.skipAction({ ...m, creditsStart: 2700 }, 2650, 2600, true), null); // past the known end
  assert.equal(NF.skipAction({ introStart: 10, introEnd: 12 }, 11, 100, false), null); // < 5 s span
  assert.equal(NF.skipAction(null, 11, 100, false), null);
  assert.equal(NF.skipAction({ introStart: null, introEnd: null, creditsStart: null }, 11, 100, true), null);
  const recap = NF.skipAction({ recapStart: 0, recapEnd: 40, introStart: 30, introEnd: 70 }, 35, 1000, false);
  assert.equal(recap.kind, "recap");
});

test("credits countdown and marker re-fetch rule", () => {
  assert.equal(NF.countdownLeft(0), 10);
  assert.equal(NF.countdownLeft(3500), 7);
  assert.equal(NF.countdownLeft(20000), 0);
  assert.equal(NF.markersWorthRefetch({ introStart: null, creditsStart: null, analysed: { head: false } }), true);
  assert.equal(NF.markersWorthRefetch({ introStart: null, creditsStart: null, analysed: { head: true } }), false);
  assert.equal(NF.markersWorthRefetch({ introStart: 3, creditsStart: null, analysed: { head: false } }), false);
  assert.equal(NF.markersSupported("movie"), false);
  assert.equal(NF.markersSupported("disk"), true);
});

test("Still watching: prompt on the 3rd consecutive auto-play, input resets", () => {
  const sw = NF.createStillWatching(3);
  assert.equal(sw.onPlayerStart(), false); // manual
  for (let i = 1; i <= 2; i++) { sw.noteAutoAdvance(); assert.equal(sw.onPlayerStart(), false); }
  sw.noteAutoAdvance();
  assert.equal(sw.onPlayerStart(), true);
  sw.onUserInteraction();
  sw.noteAutoAdvance();
  assert.equal(sw.onPlayerStart(), false);
  sw.noteAutoAdvance(); sw.onPlayerStart(); sw.noteAutoAdvance();
  sw.cancelPendingAutoStart();
  assert.equal(sw.onPlayerStart(), false); // cast took it; and this manual start resets
  assert.equal(sw.count(), 0);
});

test("displayTitle cleans panel names like the Android TitleCard", () => {
  assert.equal(NF.displayTitle("EN: Peter Pan (1953)"), "Peter Pan");
  assert.equal(NF.displayTitle("Bajirao Mastani (2015)(4k)(Hindi)"), "Bajirao Mastani");
  assert.equal(NF.displayTitle("4K - Dune Part Two 2024"), "Dune Part Two");
  assert.equal(NF.displayTitle("Up - The Movie"), "Up - The Movie");
  assert.equal(NF.displayTitle("1917"), "1917");
  assert.equal(NF.displayTitle("(2019)"), "(2019)");
  assert.equal(NF.displayTitle(""), "");
  assert.equal(NF.displayTitle(null), "");
});

test("title-card palette: stable, in range, Java hashCode compatible", () => {
  // Java: "hello".hashCode() == 99162322
  assert.equal(NF.javaHash("hello"), 99162322);
  for (const t of ["Peter Pan", "PE", "Zz", "", "Harry Potter (2001)"]) {
    const i = NF.paletteIndex(t);
    assert.ok(i >= 0 && i < NF.TITLE_CARD_PALETTE.length);
    assert.equal(NF.paletteIndex(t), i);
  }
  assert.equal(NF.paletteIndex("EN: Peter Pan (1953)"), NF.paletteIndex("Peter Pan"));
});

test("preview policy + URL", () => {
  assert.equal(NF.previewAllowed({}), true);
  assert.equal(NF.previewAllowed({ connection: { saveData: true } }), false);
  assert.equal(NF.previewAllowed({ connection: { effectiveType: "2g" } }), false);
  assert.equal(NF.previewAllowed({ connection: { effectiveType: "4g" } }), true);
  assert.equal(NF.previewUrlFor("Way9Dexny3w"), "/api/trailer/Way9Dexny3w/preview.mp4");
  assert.equal(NF.previewUrlFor("../etc"), null);
  assert.equal(NF.previewUrlFor(null), null);
});

test("web wiring: helpers loaded before app.js and cache-busted", () => {
  assert.ok(HTML.indexOf('src="/nf-helpers.js"') > 0);
  assert.ok(HTML.indexOf('src="/nf-helpers.js"') < HTML.indexOf('src="/app.js"'));
  assert.match(SERVER, /nf-helpers\\\.js/);
  for (const id of ["player-trickplay", "player-skip", "player-still", "player-upnext-credits", "series-part-of"]) {
    assert.match(HTML, new RegExp(`id="${id}"`));
  }
});

test("web wiring: endpoints and no initials tiles", () => {
  assert.match(APP, /\/api\/trickplay\/\$\{p\.mode\}/);
  assert.match(APP, /\/api\/markers\/\$\{p\.mode\}/);
  assert.match(APP, /\/api\/episodes\/\$\{mode\}/);
  assert.match(APP, /\/api\/collections\/\$\{encodeURIComponent\(id\)\}/);
  assert.match(APP, /serverHome\.collections/);
  assert.doesNotMatch(APP, /function initials\(/);
  assert.doesNotMatch(APP, /logo-initials/);
  // A re-play of the same title must not reset / trigger "Still watching?".
  assert.match(APP, /sameTitle \? false : _stillWatching\.onPlayerStart\(\)/);
  // Auto-advance paths count toward the prompt.
  assert.match(APP, /_stillWatching\.noteAutoAdvance\(\);\n  playNextEpisode\(\);/);
});
