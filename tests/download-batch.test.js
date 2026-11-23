// Static checks for the batch download queue (server.js is not importable).
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const S = fs.readFileSync(path.join(__dirname, "..", "server.js"), "utf8");

test("download caps raised, still one running job at a time", () => {
  assert.match(S, /DL_MAX_ACTIVE_PER_PROFILE = 5;/);
  assert.match(S, /DL_MAX_ACTIVE = 12;/);
  assert.match(S, /DL_BATCH_MAX = 10;/);
  assert.match(S, /if \(dlRunning\) return;/);
});

test("batch + queue routes exist and validate ids", () => {
  const i = S.indexOf('app.post("/api/download/prepare-batch"');
  assert.ok(i > 0);
  const body = S.slice(i, S.indexOf('app.get("/api/download/queue"'));
  assert.match(body, /DL_BATCH_MAX/);
  assert.match(body, /DL_ID_RE\.test\(id\)/);
  assert.match(body, /ensureDownloadJob\([^)]*true\)/);
  assert.ok(S.includes('app.get("/api/download/queue"'));
});

test("pending jobs are promoted when a job finishes or is cancelled", () => {
  const pump = S.slice(S.indexOf("function dlPump()"), S.indexOf("function pruneDownloadCache"));
  assert.match(pump, /dlRunning = false;[^\n]*dlPromotePending\(\)/);
  assert.match(S, /dlPromotePending\(\);\n\s+return res\.json\(\{ ok: true, cancelled: true \}\)/);
});
