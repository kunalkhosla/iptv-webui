"use strict";
// Per-profile autoplay setting (lib/autoplay.js) + its wiring.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const AP = require("../lib/autoplay");
const NF = require("../public/nf-helpers.js");

const SERVER = fs.readFileSync(path.join(__dirname, "..", "server.js"), "utf8");
const APP = fs.readFileSync(path.join(__dirname, "..", "public", "app.js"), "utf8");
const PICK = fs.readFileSync(path.join(__dirname, "..", "public", "profile-pick.html"), "utf8");

test("defaults follow the profile kind until edited", () => {
  assert.deepEqual(AP.effective({ kidsBirthYear: null }), { next: true, stopAfter: 3, custom: false });
  assert.deepEqual(AP.effective({ kidsBirthYear: 2017 }), { next: true, stopAfter: 2, custom: false });
  assert.deepEqual(AP.effective(null), { next: true, stopAfter: 3, custom: false });
});

test("apply merges, validates, and null resets", () => {
  const p = { kidsBirthYear: 2017 };
  assert.equal(AP.apply(p, { next: false }), true);
  assert.deepEqual(p.autoplay, { next: false, stopAfter: 2 });
  assert.equal(AP.apply(p, { stopAfter: 5 }), true);
  assert.deepEqual(AP.effective(p), { next: false, stopAfter: 5, custom: true });
  assert.equal(AP.apply(p, { stopAfter: 4 }), false);
  assert.equal(AP.apply(p, { stopAfter: "2" }), false);
  assert.equal(AP.apply(p, "on"), false);
  assert.equal(AP.apply(p, [1]), false);
  assert.equal(AP.apply(p, {}), false);
  assert.equal(AP.apply(p, { next: "false" }), false);
  assert.equal(AP.apply(p, { next: 0, stopAfter: 2 }), false);
  assert.deepEqual(p.autoplay, { next: false, stopAfter: 5 });
  assert.equal(AP.apply(p, { stopAfter: 0 }), true);
  assert.equal(p.autoplay.stopAfter, 0);
  assert.equal(AP.apply(p, null), true);
  assert.equal(p.autoplay, undefined);
  assert.deepEqual(AP.effective(p), { next: true, stopAfter: 2, custom: false });
});

test("a stored value with a bad field falls back per field", () => {
  assert.deepEqual(AP.effective({ autoplay: { next: "x", stopAfter: 9 } }), { next: true, stopAfter: 3, custom: true });
});

test("client reading: missing = autoplay on, ask after 3", () => {
  assert.deepEqual(NF.autoplaySetting(null), { next: true, stopAfter: 3 });
  assert.deepEqual(NF.autoplaySetting({}), { next: true, stopAfter: 3 });
  assert.deepEqual(NF.autoplaySetting({ autoplay: { next: false, stopAfter: 0 } }), { next: false, stopAfter: 0 });
  assert.deepEqual(NF.autoplaySetting({ autoplay: { next: true, stopAfter: 2 } }), { next: true, stopAfter: 2 });
});

test("Still watching takes the profile limit; 0 never asks", () => {
  const sw = NF.createStillWatching(3);
  sw.noteAutoAdvance(); assert.equal(sw.onPlayerStart(1), true);
  sw.reset();
  for (let i = 0; i < 6; i++) { sw.noteAutoAdvance(); assert.equal(sw.onPlayerStart(0), false); }
  sw.reset();
  sw.noteAutoAdvance(); assert.equal(sw.onPlayerStart(2), false);
  sw.noteAutoAdvance(); assert.equal(sw.onPlayerStart(2), true);
});

test("server exposes and accepts autoplay on profiles + bootstrap", () => {
  assert.match(SERVER, /autoplay: autoplayPref\.effective\(p\)/);
  assert.match(SERVER, /autoplay: autoplayPref\.effective\(activeProfile\)/);
  assert.match(SERVER, /app\.patch\("\/api\/profiles\/:id"[\s\S]{0,600}autoplayPref\.apply\(\{ \.\.\.p \}, b\.autoplay\)/);
});

test("web player honours the setting", () => {
  assert.match(APP, /_stillWatching\.onPlayerStart\(KNf\.autoplaySetting\(state\.activeProfile\)\.stopAfter\)/);
  assert.match(APP, /function autoAdvanceToNext\(\) \{[\s\S]{0,200}autoplaySetting\(state\.activeProfile\)\.next\) return;/);
  assert.match(APP, /if \(!KNf\.autoplaySetting\(state\.activeProfile\)\.next\) \{ showUpNext\(null, true\); return; \}/);
  assert.match(PICK, /id="ap-next"/);
  assert.match(PICK, /id="ap-stop"/);
  assert.match(PICK, /if \(autoplayTouched\) \{\s*payload\.autoplay/);
  assert.match(APP, /else \{ state\.playing\._endedUpNext = true; showUpNext\(\); \}/);
  assert.match(APP, /!\(p && p\._endedUpNext\)\) \{/);
});
