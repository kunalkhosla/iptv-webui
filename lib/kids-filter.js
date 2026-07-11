// Kids cert filtering — single source of truth for which TMDB / panel
// us_cert values are allowed for a kid profile at a given age. Lives
// here (not inside server.js) so it can be unit-tested in isolation
// and so the rule is documented in one place.
//
// "Kid profile" means `profile.kidsBirthYear` is set; non-kid profiles
// see everything. The check is strict allow-list: items without a
// us_cert are blocked too ("we can't verify it's kid-safe → don't
// show it"). The home endpoint's `tileFor` separately applies a
// soft-NR rescue that promotes no-cert items in kid-themed categories
// to "G" before this check fires — so kid-cartoon channels still
// surface even when TMDB hasn't matched them.

// Each tier ADDS its certs at or above its minAge — so age 7 ends up
// with the union of the 0 and 7 tiers; age 10 adds PG-13; age 13 adds
// TV-14. R / NC-17 / TV-MA are never in any tier.
const KIDS_CERT_TIERS = [
  { minAge: 0,  add: ["G", "TV-Y", "TV-G"] },
  { minAge: 7,  add: ["PG", "TV-Y7", "TV-PG"] },
  { minAge: 10, add: ["PG-13"] },
  { minAge: 13, add: ["TV-14"] },
];

// Hard-blocked certs that must never reach a kid profile regardless
// of age. Used by the test suite as an absolute floor — if any of
// these slip through a kid endpoint, that's a security failure.
const ALWAYS_ADULT_CERTS = new Set(["R", "NC-17", "TV-MA"]);

// Compute the allowed cert set for a kid profile at the given age.
// Returns a Set. Empty set when age is null/NaN.
function allowedCertsForAge(age) {
  const out = new Set();
  if (!Number.isFinite(age)) return out;
  for (const tier of KIDS_CERT_TIERS) {
    if (age >= tier.minAge) tier.add.forEach((c) => out.add(c));
  }
  return out;
}

// Compute kid age from a profile object. Returns null for non-kid
// profiles (no kidsBirthYear) or invalid values.
function kidAgeFromProfile(profile) {
  const by = profile?.kidsBirthYear;
  if (!by) return null;
  const age = new Date().getFullYear() - by;
  return Number.isFinite(age) && age >= 0 && age < 100 ? age : null;
}

// Predicate factory: returns true if the stream/tile should be
// hidden from this profile. Non-kid → always false. Kid + no cert →
// true (block). Kid + cert in allowed tier → false (allow). Kid +
// cert outside allowed tier → true (block).
function makeKidsBlocker(profile) {
  const age = kidAgeFromProfile(profile);
  if (age === null) return () => false;
  const allowed = allowedCertsForAge(age);
  return (s) => {
    if (!s?.us_cert) return true;
    return !allowed.has(s.us_cert);
  };
}

module.exports = {
  KIDS_CERT_TIERS,
  ALWAYS_ADULT_CERTS,
  allowedCertsForAge,
  kidAgeFromProfile,
  makeKidsBlocker,
};
