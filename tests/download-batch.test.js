const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { createDownloadQueue, waitingFor } = require("../lib/download-queue");
const S = fs.readFileSync(path.join(__dirname, "..", "server.js"), "utf8");

const mk = (o) => createDownloadQueue({ maxActive: 12, maxPerProfile: 5, maxPending: 50, ...o });
const add = (q, id, prof, defer = true) => q.admit(`movie_${id}`, "movie", String(id), null, prof, { defer });
const finish = (q, id) => { const j = q.jobs.get(`movie_${id}`); j.state = "ready"; q.removeFromQueue(j); };

test("per-profile cap parks the rest; promotion is FIFO", () => {
  const q = mk();
  const r = [1, 2, 3, 4, 5, 6, 7].map((i) => add(q, i, "a").result);
  assert.deepEqual(r, ["started", "started", "started", "started", "started", "pending", "pending"]);
  assert.equal(q.promote().length, 0);
  finish(q, 1);
  assert.deepEqual(q.promote().map((j) => j.id), ["6"]);
  finish(q, 2);
  assert.deepEqual(q.promote().map((j) => j.id), ["7"]);
});

test("a capped profile is skipped without blocking another profile", () => {
  const q = mk({ maxPerProfile: 1, maxActive: 2 });
  add(q, 1, "a"); add(q, 2, "a"); // 2 pending for a
  add(q, 3, "b");                 // b started (global 2/2)
  add(q, 4, "c");                 // c pending (global cap)
  finish(q, 3);                   // b frees a global slot
  const p = q.promote().map((j) => j.id);
  assert.deepEqual(p, ["4"]);     // a's #2 skipped (a at own cap), c promoted
});

test("global cap stops promotion", () => {
  const q = mk({ maxPerProfile: 5, maxActive: 2 });
  add(q, 1, "a"); add(q, 2, "b"); add(q, 3, "c"); add(q, 4, "d");
  assert.equal(q.pending.size, 2);
  assert.equal(q.promote().length, 0);
  finish(q, 1);
  assert.deepEqual(q.promote().map((j) => j.id), ["3"]);
});

test("cancel pending removes it; cancel active then promote", () => {
  const q = mk({ maxPerProfile: 1 });
  add(q, 1, "a"); add(q, 2, "a"); add(q, 3, "a");
  assert.ok(q.cancelPending("movie_2"));
  const j = q.jobs.get("movie_1"); j.cancelled = true; q.jobs.delete("movie_1"); q.removeFromQueue(j);
  assert.deepEqual(q.promote().map((x) => x.id), ["3"]);
});

test("pending cap is per profile; non-defer reports capped", () => {
  const q = mk({ maxPerProfile: 1, maxPending: 50 });
  add(q, 0, "a");
  for (let i = 1; i <= 50; i++) assert.equal(add(q, i, "a").result, "pending");
  assert.equal(add(q, 51, "a").result, "full");
  assert.equal(add(q, 99, "b").result, "started");
  assert.equal(add(q, 100, "a", false).result, "capped");
  assert.equal(add(q, 1, "a").result, "pending"); // duplicate stays parked
});

test("queue_position counts only the owning profile", () => {
  const q = mk({ maxPerProfile: 1 });
  add(q, 1, "a");           // running slot (queued state here)
  add(q, 2, "b");           // b's own job
  add(q, 3, "a");           // pending, a
  add(q, 4, "a");           // pending, a
  assert.equal(q.position("movie_2"), 1);          // not behind a's job
  assert.equal(q.position("movie_3"), 1 + 1);      // a's queued job + itself
  assert.equal(q.position("movie_4"), 1 + 2);
});

test("dropJob only deletes the job it owns", () => {
  const q = mk();
  add(q, 1, "a");
  const old = q.jobs.get("movie_1");
  const fresh = { ...old }; q.jobs.set("movie_1", fresh);
  q.dropJob(old);
  assert.equal(q.jobs.get("movie_1"), fresh);
});

test("server wiring: batch route validates ids, caps are 5/12, one runner", () => {
  assert.match(S, /maxActive: 12, maxPerProfile: 5, maxPending: 50/);
  const body = S.slice(S.indexOf('app.post("/api/download/prepare-batch"'), S.indexOf('app.get("/api/download/queue"'));
  assert.match(body, /DL_ID_RE\.test\(id\)/);
  assert.match(body, /DL_BATCH_MAX/);
  assert.match(S, /if \(dlRunning\) return;/);
  assert.doesNotMatch(S, /state: "pending"/);
});

test("download status: waiting_for viewer field, startedAt-based age cap, log lines", () => {
  assert.match(S, /waiting_for: waitingFor/);
  assert.match(S, /stage = "failed"; job\.error = "timed out/);
  assert.match(S, /dlCurrent = job;/);
  assert.match(S, /dlCurrent = null;/);
  assert.match(S, /job\.startedAt = Date\.now\(\);/);
  assert.match(S, /Date\.now\(\) - job\.startedAt > DL_MAX_JOB_AGE_MS/);
  assert.doesNotMatch(S, /Date\.now\(\) - job\.createdAt > DL_MAX_JOB_AGE_MS/);
  assert.match(S, /DL_MAX_QUEUE_AGE_MS = 3 \* 24/);
  assert.match(S, /\[download\] \$\{mode\} \$\{id\} waiting for viewer/);
  assert.match(S, /\[download\] \$\{mode\} \$\{id\} resumed after viewer/);
});

test("waitingFor: only live waits and jobs queued behind them", () => {
  const w = { state: "waiting", stage: "waiting-for-viewer" };
  assert.equal(waitingFor(w, w), "viewer");
  assert.equal(waitingFor({ state: "failed", stage: "failed" }, null), null);
  assert.equal(waitingFor({ state: "failed", stage: "waiting-for-viewer" }, null), null);
  assert.equal(waitingFor({ state: "queued" }, w), "viewer");
  assert.equal(waitingFor({ state: "queued" }, { ...w, cancelled: true }), null);
  assert.equal(waitingFor({ state: "queued" }, { state: "running", stage: "fetching" }), null);
  assert.equal(waitingFor({ state: "queued" }, null), null);
});
