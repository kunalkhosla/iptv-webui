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
