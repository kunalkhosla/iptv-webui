"use strict";
// Per-profile autoplay setting (docs/NETFLIX_FEATURES.md "Autoplay next
// episode"). Stored on the profile record as `autoplay: { next, stopAfter }`
// only once someone edits it; until then the effective value follows the
// profile kind, so a profile that becomes a kid profile picks up the kid
// default. stopAfter N = after N episodes in a row with no input, the next one
// (the N-th consecutive auto-advance) opens behind "Still watching?" (0 = never).

const STOP_AFTER_CHOICES = [0, 1, 2, 3, 5];

function defaults(isKid) {
  return { next: true, stopAfter: isKid ? 2 : 3 };
}

function isKidProfile(p) {
  return !!(p && p.kidsBirthYear);
}

// Effective setting for a profile: { next, stopAfter, custom }.
function effective(p) {
  const d = defaults(isKidProfile(p));
  const s = p && p.autoplay;
  if (!s || typeof s !== "object") return { ...d, custom: false };
  return {
    next: typeof s.next === "boolean" ? s.next : d.next,
    stopAfter: STOP_AFTER_CHOICES.includes(s.stopAfter) ? s.stopAfter : d.stopAfter,
    custom: true,
  };
}

// Apply a request body's `autoplay` to a profile record. null resets to the
// default; an object merges valid fields over the current effective value.
// Returns false (nothing changed) for a malformed value.
function apply(p, body) {
  if (body === null) { delete p.autoplay; return true; }
  if (!body || typeof body !== "object" || Array.isArray(body)) return false;
  const cur = effective(p);
  if (body.next !== undefined && typeof body.next !== "boolean") return false;
  if (body.next === undefined && body.stopAfter === undefined) return false;
  const next = body.next !== undefined ? body.next : cur.next;
  let stopAfter = cur.stopAfter;
  if (body.stopAfter !== undefined) {
    if (!STOP_AFTER_CHOICES.includes(body.stopAfter)) return false;
    stopAfter = body.stopAfter;
  }
  p.autoplay = { next, stopAfter };
  return true;
}

module.exports = { STOP_AFTER_CHOICES, defaults, effective, apply };
