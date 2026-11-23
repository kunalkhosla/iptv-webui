"use strict";
// Detects camera-recorded / pre-retail prints (CAM, HDCAM, TS, TELESYNC,
// PreDVD, ...) from a stream title or category name. Pure; token-bounded so
// "Camera", "Camp", "Cameron", "Tsunami", "Scam" never match.
const NB_BEFORE = "(?<![A-Za-z0-9])";
const NB_AFTER = "(?![A-Za-z0-9])";
// Long tokens: case-insensitive (CAM-Rip / cam rip / Cam Rip all fold in).
const LONG_RE = new RegExp(
  `${NB_BEFORE}(?:hd[ -]?cam|cam[ -]?rip|cam|hd[ -]?ts|hd[ -]?tc|tele[ -]?sync|tele[ -]?cine|pre[ -]?dvd|dvd[ -]?scr(?:eener)?|hd[ -]?scr|scr(?:eener)?)${NB_AFTER}`,
  "i",
);
// Two-letter tokens collide with ordinary words/initials, so require them
// uppercase as standalone tokens.
const SHORT_RE = new RegExp(`${NB_BEFORE}(?:TS|TC)${NB_AFTER}`);

function isLowQualityText(text) {
  const s = String(text || "");
  if (!s) return false;
  return LONG_RE.test(s) || SHORT_RE.test(s);
}

// stream: { name, tags? }; categoryName optional.
function isLowQuality(stream, categoryName) {
  if (!stream) return false;
  return isLowQualityText(stream.name) || isLowQualityText(categoryName);
}

// Stable partition: non-low-quality first, order otherwise preserved.
function lowQualityLast(list, categoryNameOf) {
  const good = [], bad = [];
  for (const s of list) (isLowQuality(s, categoryNameOf ? categoryNameOf(s) : null) ? bad : good).push(s);
  return bad.length ? good.concat(bad) : list;
}

module.exports = { isLowQualityText, isLowQuality, lowQualityLast };
