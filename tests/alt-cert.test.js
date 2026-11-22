const test = require("node:test");
const assert = require("node:assert/strict");
const { bucketFor, altCertFromTmdb, familyHeuristicCert } = require("../lib/alt-cert");

const rd = (country, ...certs) => ({ iso_3166_1: country, release_dates: certs.map((c) => ({ certification: c })) });
const cr = (country, rating) => ({ iso_3166_1: country, rating });

test("a single lenient country never grants G or PG-13", () => {
  assert.equal(altCertFromTmdb("movie", [rd("IN", "UA")]).cert, "R");          // UA alone: strict
  assert.equal(altCertFromTmdb("movie", [rd("AU", "M")]).cert, "R");           // AU M = 15
  assert.equal(altCertFromTmdb("movie", [rd("CA", "14A")]).cert, "R");
  assert.equal(altCertFromTmdb("movie", [rd("DE", "12")]).cert, "R");
  assert.equal(altCertFromTmdb("movie", [rd("IN", "U")]).cert, "PG");          // U alone: PG, not G
  assert.equal(altCertFromTmdb("movie", [rd("GB", "U")]).cert, "PG");
  assert.equal(altCertFromTmdb("movie", [rd("DE", "0")]).cert, "PG");
});

test("two agreeing lenient countries grant the lenient US rating", () => {
  assert.equal(altCertFromTmdb("movie", [rd("GB", "U"), rd("DE", "0")]).cert, "G");
  assert.equal(altCertFromTmdb("movie", [rd("GB", "PG"), rd("DE", "6")]).cert, "PG");
  assert.equal(altCertFromTmdb("movie", [rd("GB", "12A"), rd("DE", "12")]).cert, "PG-13");
});

test("most restrictive country wins", () => {
  assert.equal(altCertFromTmdb("movie", [rd("GB", "U"), rd("DE", "0"), rd("IN", "A")]).cert, "NC-17");
  assert.equal(altCertFromTmdb("movie", [rd("GB", "15"), rd("IN", "UA")]).cert, "R");
  assert.equal(altCertFromTmdb("movie", [rd("GB", "PG"), rd("DE", "16")]).cert, "R");
  assert.equal(altCertFromTmdb("series", [cr("DE", "6"), cr("GB", "18")]).cert, "TV-MA");
});

test("unconsulted-country and odd adult ratings count as adult", () => {
  for (const [country, raw] of [["KR", "19"], ["JP", "R18+"], ["NZ", "R18"], ["ES", "18"], ["SE", "15"], ["RU", "18+"], ["TR", "18+"], ["AU", "R18+"], ["AU", "X18+"], ["US", "NC-17"], ["XX", "X"]]) {
    const out = altCertFromTmdb("movie", [rd(country, raw)]);
    assert.ok(["R", "NC-17"].includes(out.cert), `${country} ${raw} -> ${out.cert}`);
  }
});

test("unmappable ratings grant nothing and flag unmapped", () => {
  const out = altCertFromTmdb("movie", [rd("MX", "C")]);
  assert.equal(out.cert, "");
  assert.equal(out.anyData, true);
  assert.equal(out.unmapped, true);
  assert.equal(altCertFromTmdb("movie", [rd("AU", "RC")]).cert, "NC-17"); // refused classification = adult
});

test("empty / NR ratings carry no information", () => {
  const out = altCertFromTmdb("movie", [rd("GB", ""), rd("IN", "NR"), rd("DE", "Unrated")]);
  assert.deepEqual(out, { cert: "", anyData: false, unmapped: false });
});

test("numeric buckets are conservative", () => {
  assert.equal(bucketFor("XX", "13"), 12);
  assert.equal(bucketFor("XX", "14"), 15);
  assert.equal(bucketFor("XX", "16"), 16);
  assert.equal(bucketFor("XX", "18"), 18);
  assert.equal(bucketFor("XX", "7"), 6);
});

test("series scale", () => {
  assert.equal(altCertFromTmdb("series", [cr("GB", "15")]).cert, "TV-14");
  assert.equal(altCertFromTmdb("series", [cr("GB", "U"), cr("DE", "0")]).cert, "TV-G");
});

test("family heuristic: conservative", () => {
  assert.equal(familyHeuristicCert("movie", ["Family", "Comedy"], "Buen Camino"), "PG");
  assert.equal(familyHeuristicCert("movie", ["Family", "Horror"], "x"), "");
  assert.equal(familyHeuristicCert("movie", ["Family", "Romance"], "x"), "");
  assert.equal(familyHeuristicCert("movie", ["Family"], "Adult Swim Movie"), "");
  assert.equal(familyHeuristicCert("series", ["Family", "Drama"], "x"), "");
  assert.equal(familyHeuristicCert("series", ["Kids"], "x"), "TV-PG");
  assert.equal(familyHeuristicCert("series", ["Family", "Animation", "War & Politics"], "x"), "");
});

test("an unparsable rating vetoes a lenient verdict", () => {
  assert.equal(altCertFromTmdb("movie", [rd("GB", "U"), rd("DE", "FSK 18")]).cert, "");
  assert.equal(altCertFromTmdb("movie", [rd("GB", "U"), rd("NZ", "M")]).cert, "");
  // ...but an already-restrictive verdict stands.
  assert.equal(altCertFromTmdb("movie", [rd("GB", "15"), rd("NZ", "M")]).cert, "R");
  assert.equal(familyHeuristicCert("movie", ["Family"], "Hot 18+"), "");
});
