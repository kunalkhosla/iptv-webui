const test = require("node:test");
const assert = require("node:assert/strict");
const { redactUrl, installConsoleRedaction } = require("../lib/redact");

test("redacts xtream path credentials", () => {
  assert.equal(redactUrl("started → http://markethelp1.com:8080/live/bob/s3cret/98846.m3u8"),
    "started → http://markethelp1.com:8080/live/<u>/<p>/98846.m3u8");
  assert.equal(redactUrl("http://h/movie/bob/s3cret/123.mkv?_=17"), "http://h/movie/<u>/<p>/123.mkv?_=17");
  assert.equal(redactUrl("https://h/series/a/b/9.mp4 and /timeshift/a/b/60/x"), "https://h/series/<u>/<p>/9.mp4 and /timeshift/<u>/<p>/60/x");
});
test("redacts query params and userinfo", () => {
  assert.equal(redactUrl("http://h/player_api.php?username=bob&password=s3cret&action=x"),
    "http://h/player_api.php?username=<u>&password=<p>&action=x");
  assert.equal(redactUrl("https://user:pw@host/path"), "https://<u>:<p>@host/path");
});
test("leaves safe text and non-strings alone", () => {
  assert.equal(redactUrl("/api/live/12/index.m3u8"), "/api/live/12/index.m3u8");
  assert.equal(redactUrl(null), "");
  assert.equal(redactUrl(undefined), "");
  assert.equal(redactUrl(42), "42");
});
test("console patch redacts strings and Errors", () => {
  const out = [];
  const fake = { log: (...a) => out.push(a), info() {}, warn() {}, error() {} };
  installConsoleRedaction(fake);
  const e = new Error("fail http://h/live/u1/p1/5.m3u8");
  fake.log("x http://h/live/u1/p1/5.m3u8", e, { a: 1 });
  assert.equal(out[0][0], "x http://h/live/<u>/<p>/5.m3u8");
  assert.ok(!out[0][1].message.includes("u1"));
});
