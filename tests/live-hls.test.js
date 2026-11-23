const test = require("node:test");
const assert = require("node:assert/strict");
const { liveHlsListSize, panelReconnectArgs, DEFAULT_LIST_SIZE } = require("../lib/live-hls");

test("live list size defaults and clamps", () => {
  assert.equal(liveHlsListSize(undefined), DEFAULT_LIST_SIZE);
  assert.equal(liveHlsListSize("abc"), DEFAULT_LIST_SIZE);
  assert.equal(liveHlsListSize("2"), 6);
  assert.equal(liveHlsListSize("500"), 60);
  assert.equal(liveHlsListSize("30"), 30);
});

test("panel reconnect args never retry 4xx or EOF", () => {
  const a = panelReconnectArgs();
  assert.ok(!a.includes("-reconnect_at_eof"));
  assert.equal(a[a.indexOf("-reconnect_on_http_error") + 1], "5xx");
  assert.ok(a.includes("-rw_timeout"));
});

test("panel reconnect retries are bounded", () => {
  const a = panelReconnectArgs();
  assert.equal(a[a.indexOf("-reconnect_delay_total_max") + 1], "10");
  assert.equal(a[a.indexOf("-reconnect_max_retries") + 1], "2");
});

test("live tolerant args raise max_error_rate", () => {
  const { liveTolerantArgs } = require("../lib/live-hls");
  const a = liveTolerantArgs();
  assert.equal(a[a.indexOf("-max_error_rate") + 1], "1");
  assert.ok(!a.includes("-xerror"));
});
