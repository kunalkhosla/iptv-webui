"use strict";
// Detects camera-recorded / pre-retail prints from a stream title or category
// name. Pure and deliberately conservative: bare words like "Cam", "TS",
// "Screener" are real titles/names, so they only count when bracketed.
const NB_BEFORE = "(?<![A-Za-z0-9])";
const NB_AFTER = "(?![A-Za-z0-9])";
// Unambiguous multi-letter tokens (case-insensitive).
const STRONG = "hd[ -]?cam|cam[ -]?rip|hd[ -]?ts|hd[ -]?tc|tele[ -]?sync|tele[ -]?cine|pre[ -]?dvd|dvd[ -]?scr(?:eener)?";
const STRONG_RE = new RegExp(`${NB_BEFORE}(?:${STRONG})${NB_AFTER}`, "i");
// Category names: only the most distinctive tokens.
const CATEGORY_RE = new RegExp(`${NB_BEFORE}(?:hdcam|camrip|cam-rip|telesync|hdts|pre-?dvd)${NB_AFTER}`, "i");
// Short tokens only when parenthesised/bracketed ("(CAM)", "[TS]") or a
// trailing " - CAM" suffix.
const BRACKETED_RE = /[(\[]\s*(?:CAM|TS|TC)\s*[)\]]|\s-\s*CAM\s*$/i;

function isLowQualityText(text) {
  const s = String(text || "");
  if (!s) return false;
  return STRONG_RE.test(s) || BRACKETED_RE.test(s);
}

function isLowQualityCategory(name) {
  const s = String(name || "");
  return !!s && CATEGORY_RE.test(s);
}

// stream: { name }; categoryName optional.
function isLowQuality(stream, categoryName) {
  if (!stream) return false;
  return isLowQualityText(stream.name) || isLowQualityCategory(categoryName);
}

// Stable partition: non-low-quality first, order otherwise preserved.
function lowQualityLast(list, categoryNameOf) {
  const good = [], bad = [];
  for (const s of list) (isLowQuality(s, categoryNameOf ? categoryNameOf(s) : null) ? bad : good).push(s);
  return bad.length ? good.concat(bad) : list;
}

module.exports = { isLowQualityText, isLowQualityCategory, isLowQuality, lowQualityLast };
