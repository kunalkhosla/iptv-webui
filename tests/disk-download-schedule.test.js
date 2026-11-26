const test = require("node:test");
const assert = require("node:assert");
const s = require("../lib/disk-download-schedule");

const map = (entries) => new Map(entries.map(([k, v]) => [k, { accountKey: "A", displaced: false, lastSeen: 0, ...v }]));

test("window: off unless both hours are set and differ", () => {
  assert.deepStrictEqual(s.parseWindowEnv(undefined, undefined), { enabled: false, startHour: null, endHour: null, invalid: false });
  assert.deepStrictEqual(s.parseWindowEnv("", " "), { enabled: false, startHour: null, endHour: null, invalid: false });
  assert.strictEqual(s.parseWindowEnv("1", undefined).enabled, false);
  assert.strictEqual(s.parseWindowEnv("1", undefined).invalid, true);
  assert.strictEqual(s.parseWindowEnv("1am", "6").invalid, true);
  assert.strictEqual(s.parseWindowEnv("24", "6").invalid, true);
  assert.strictEqual(s.parseWindowEnv("3", "3").invalid, true);
  assert.deepStrictEqual(s.parseWindowEnv("1", "6"), { enabled: true, startHour: 1, endHour: 6, invalid: false });
  assert.deepStrictEqual(s.parseWindowEnv("0", "6"), { enabled: true, startHour: 0, endHour: 6, invalid: false });
});

test("window hours, incl. wrapping midnight", () => {
  assert.strictEqual(s.hourInWindow(1, 1, 6), true);
  assert.strictEqual(s.hourInWindow(6, 1, 6), false);
  assert.strictEqual(s.hourInWindow(23, 22, 5), true);
  assert.strictEqual(s.hourInWindow(4, 22, 5), true);
  assert.strictEqual(s.hourInWindow(12, 22, 5), false);
});

test("decide: no window, nobody watching -> run now", () => {
  assert.deepStrictEqual(s.decideDiskDownload({ now: 1e9 }), { run: true, waitingFor: null });
  assert.deepStrictEqual(s.decideDiskDownload({ now: 1e9, lastViewerAt: 1e9 - 120_000, graceMs: 120_000 }), { run: true, waitingFor: null });
});

test("decide: a viewer holding the slot, or gone less than the grace ago, holds it back", () => {
  assert.deepStrictEqual(s.decideDiskDownload({ now: 1e9, holder: "viewer" }), { run: false, waitingFor: "viewer" });
  assert.deepStrictEqual(s.decideDiskDownload({ now: 1e9, lastViewerAt: 1e9 - 119_999, graceMs: 120_000 }), { run: false, waitingFor: "viewer" });
  assert.deepStrictEqual(s.decideDiskDownload({ now: 1e9, holder: "background" }), { run: false, waitingFor: "queue" });
});

test("decide: opt-in window closed wins; open window behaves like no window", () => {
  assert.deepStrictEqual(s.decideDiskDownload({ now: 1e9, windowEnabled: true, windowOpen: false }), { run: false, waitingFor: "window" });
  assert.deepStrictEqual(s.decideDiskDownload({ now: 1e9, windowEnabled: true, windowOpen: true }), { run: true, waitingFor: null });
  // windowOpen=false is ignored when no window is configured
  assert.deepStrictEqual(s.decideDiskDownload({ now: 1e9, windowEnabled: false, windowOpen: false }), { run: true, waitingFor: null });
});

test("slotHolder: viewers (incl. a paused keep-alive session or a Disk transcode) beat background; displaced, self, other accounts ignored", () => {
  const me = "disk-download:j1";
  assert.strictEqual(s.slotHolder(map([]), me, "A"), null);
  assert.strictEqual(s.slotHolder(map([[me, {}]]), me, "A"), null);
  assert.strictEqual(s.slotHolder(map([["s:abc", { displaced: true }]]), me, "A"), null);
  assert.strictEqual(s.slotHolder(map([["s:abc", { accountKey: "B" }]]), me, "A"), null);
  assert.strictEqual(s.slotHolder(map([["s:abc", { lastSeen: 1 }]]), me, "A"), "viewer"); // stale lastSeen still holds (paused / buffering)
  assert.strictEqual(s.slotHolder(map([["ip:1.2.3.4:x", { mode: "disk" }]]), me, "A"), "viewer");
  assert.strictEqual(s.slotHolder(map([["phone-download:k", {}]]), me, "A"), "background");
  assert.strictEqual(s.slotHolder(map([["phone-download:k", {}], ["s:abc", {}]]), me, "A"), "viewer");
  assert.strictEqual(s.slotHolder(map([["disk-download:j2", {}]]), null, "A"), "background");
});

test("latestViewerSeen ignores background transfers", () => {
  const m = map([["s:a", { lastSeen: 50 }], ["disk-download:j", { lastSeen: 900 }], ["phone-download:k", { lastSeen: 800 }]]);
  assert.strictEqual(s.latestViewerSeen(m, 10), 50);
  assert.strictEqual(s.latestViewerSeen(m, 70), 70);
});

test("owner key classification", () => {
  assert.strictEqual(s.isBackgroundOwner("disk-download:x"), true);
  assert.strictEqual(s.isBackgroundOwner("phone-download:x"), true);
  assert.strictEqual(s.isBackgroundOwner("s:disk-download"), false);
  assert.strictEqual(s.isDiskDownloadOwner("phone-download:x"), false);
  assert.strictEqual(s.isBackgroundOwner(undefined), false);
});

test("grace env", () => {
  assert.strictEqual(s.graceMsFrom(undefined), 120_000);
  assert.strictEqual(s.graceMsFrom("5000"), 5000);
  assert.strictEqual(s.graceMsFrom("0"), 0);
  assert.strictEqual(s.graceMsFrom("abc"), 120_000);
  assert.strictEqual(s.graceMsFrom(String(31 * 60_000)), 120_000);
});
