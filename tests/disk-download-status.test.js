const test = require("node:test");
const assert = require("node:assert");
const { projectDiskDownloadJob, diskJobWaitingFor, diskJobPct } = require("../lib/disk-download-status");

const base = { jobId: "j1", mode: "movie", id: 42, title: "Up", status: "queued", bytesWritten: 0, error: null, createdAt: 1 };

test("waiting_for: queued waits for the window, then for a running job, else starts", () => {
  assert.strictEqual(diskJobWaitingFor({ status: "queued" }, false), "window");
  assert.strictEqual(diskJobWaitingFor({ status: "queued" }, false, true), "window");
  assert.strictEqual(diskJobWaitingFor({ status: "queued" }, true, true), "queue");
  assert.strictEqual(diskJobWaitingFor({ status: "queued" }, true, false), null);
});

test("waiting_for: paused means a viewer holds the stream slot", () => {
  assert.strictEqual(diskJobWaitingFor({ status: "paused" }, true), "viewer");
  assert.strictEqual(diskJobWaitingFor({ status: "paused" }, false), "viewer");
});

test("waiting_for: null once moving or finished", () => {
  for (const status of ["downloading", "done", "failed"]) {
    assert.strictEqual(diskJobWaitingFor({ status }, true), null);
  }
});

test("pct: null without a known total, floor and capped at 99 until done", () => {
  assert.strictEqual(diskJobPct({ status: "downloading", bytesWritten: 10 }), null);
  assert.strictEqual(diskJobPct({ status: "downloading", bytesWritten: 10, totalBytes: 0 }), null);
  assert.strictEqual(diskJobPct({ status: "downloading", bytesWritten: 429, totalBytes: 1000 }), 42);
  assert.strictEqual(diskJobPct({ status: "downloading", bytesWritten: 1000, totalBytes: 1000 }), 99);
  assert.strictEqual(diskJobPct({ status: "downloading", bytesWritten: 5000, totalBytes: 1000 }), 99);
  assert.strictEqual(diskJobPct({ status: "done", bytesWritten: 1, totalBytes: null }), 100);
});

test("projection keeps the original fields and adds the new ones", () => {
  const p = projectDiskDownloadJob({ ...base, status: "downloading", bytesWritten: 250, totalBytes: 1000 }, { windowOpen: true });
  assert.deepStrictEqual(p, {
    id: "j1", mode: "movie", sourceId: 42, status: "downloading", title: "Up",
    seriesTitle: null, season: null, episodeNum: null,
    bytesWritten: 250, error: null, createdAt: 1, finishedAt: null,
    totalBytes: 1000, pct: 25, waiting_for: null,
  });
});

test("projection: episode title and window default closed", () => {
  const p = projectDiskDownloadJob({ ...base, mode: "series", title: undefined, episodeTitle: "Pilot", seriesTitle: "Show", season: 1, episodeNum: 2 });
  assert.strictEqual(p.title, "Pilot");
  assert.strictEqual(p.waiting_for, "window");
  assert.strictEqual(p.totalBytes, null);
  assert.strictEqual(p.pct, null);
});

const { selectDiskJobs, projectDiskJobs, parseIdsParam } = require("../lib/disk-download-status");

test("select: every active job survives the cap, finished ones are capped", () => {
  const jobs = [];
  for (let i = 0; i < 150; i++) jobs.push({ jobId: `q${i}`, mode: "series", id: 1000 + i, status: "queued", createdAt: i });
  for (let i = 0; i < 150; i++) jobs.push({ jobId: `d${i}`, mode: "movie", id: i, status: "done", createdAt: 500 + i });
  const out = selectDiskJobs(jobs, { cap: 100 });
  assert.strictEqual(out.filter((j) => j.status === "queued").length, 150);
  assert.strictEqual(out.filter((j) => j.status === "done").length, 100);
  assert.ok(out.every((j, i) => i === 0 || out[i - 1].createdAt >= j.createdAt));
});

test("select: mode + ids returns every job for those titles, uncapped", () => {
  const jobs = [];
  for (let i = 0; i < 300; i++) jobs.push({ jobId: `d${i}`, mode: "series", id: i, status: "done", createdAt: i });
  jobs.push({ jobId: "m", mode: "movie", id: 5, status: "done", createdAt: 999 });
  const out = selectDiskJobs(jobs, { mode: "series", ids: ["0", "5", "299"], cap: 100 });
  assert.deepStrictEqual(out.map((j) => j.jobId), ["d299", "d5", "d0"]);
});

test("projectDiskJobs: othersRunning excludes the job itself", () => {
  const a = { jobId: "a", mode: "movie", id: 1, status: "downloading", createdAt: 1 };
  const b = { jobId: "b", mode: "movie", id: 2, status: "queued", createdAt: 2 };
  const [pa, pb] = projectDiskJobs([a, b], [a, b], { windowOpen: true });
  assert.strictEqual(pa.waiting_for, null);
  assert.strictEqual(pb.waiting_for, "queue");
  assert.strictEqual(projectDiskJobs([b], [b], { windowOpen: true })[0].waiting_for, null);
});

test("parseIdsParam: digits only, empty -> null", () => {
  assert.deepStrictEqual(parseIdsParam("1, 22,x,333"), ["1", "22", "333"]);
  assert.strictEqual(parseIdsParam(""), null);
  assert.strictEqual(parseIdsParam(undefined), null);
  assert.strictEqual(parseIdsParam("a,b"), null);
});

test("select: mode without ids falls back to the default list", () => {
  const jobs = [{ jobId: "a", mode: "movie", id: 1, status: "done", createdAt: 1 }, { jobId: "b", mode: "series", id: 2, status: "queued", createdAt: 2 }];
  assert.deepStrictEqual(selectDiskJobs(jobs, { mode: "movie", ids: null }).map((j) => j.jobId), ["b", "a"]);
});

test("waiting_for: a queued job that is next waits for a viewer (no window configured = always open)", () => {
  assert.strictEqual(diskJobWaitingFor({ status: "queued" }, true, false, true), "viewer");
  assert.strictEqual(diskJobWaitingFor({ status: "queued" }, true, true, true), "queue");
  assert.strictEqual(diskJobWaitingFor({ status: "queued" }, true, false, false), null);
  assert.strictEqual(projectDiskDownloadJob({ ...base }, { windowOpen: true, viewerWaiting: true }).waiting_for, "viewer");
});
