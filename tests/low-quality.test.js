const test = require("node:test");
const assert = require("node:assert/strict");
const { isLowQualityText, isLowQuality, lowQualityLast } = require("../lib/low-quality");

test("camera-recorded markers are detected", () => {
  for (const n of [
    "Nata Ratnalu (2024) (Hindi)(CAM)", "Movie HDCAM", "Movie TS", "Movie (TS)", "Movie TELESYNC",
    "Movie PreDVD", "Movie PRE-DVD", "Movie CAMRip", "Movie [HDTS]", "Movie HD-TS 2024", "Movie DVDScr",
    "Movie [CAM-Rip]", "INDIAN (2026) (CAM)", "Movie HDTC",
  ]) assert.equal(isLowQualityText(n), true, n);
});

test("ordinary titles are not flagged", () => {
  for (const n of [
    "Camera", "Camp Rock", "Cameron Crowe's Elizabethtown", "Tsunami", "Scam 1992", "The Camera Man (2020)",
    "Scampers", "Streets (2024)", "Cast Away", "Ts", "Mr & Mrs TSX", "Discord", "", null, undefined,
  ]) assert.equal(isLowQualityText(n), false, String(n));
});

test("category name also counts", () => {
  assert.equal(isLowQuality({ name: "Some Film (2025)" }, "NEW RELEASES CAM"), true);
  assert.equal(isLowQuality({ name: "Some Film (2025)" }, "Movies"), false);
  assert.equal(isLowQuality(null), false);
});

test("lowQualityLast is a stable partition", () => {
  const a = [{ name: "A CAM" }, { name: "B" }, { name: "C HDTS" }, { name: "D" }];
  assert.deepEqual(lowQualityLast(a).map((s) => s.name), ["B", "D", "A CAM", "C HDTS"]);
  const clean = [{ name: "x" }];
  assert.equal(lowQualityLast(clean), clean);
});
