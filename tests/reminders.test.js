const test = require("node:test");
const assert = require("node:assert/strict");
const R = require("../lib/reminders");

const NOW = 1_790_000_000_000;
const M = 60e3;
const mk = (o) => ({ id: "a", profileId: "p1", streamId: "10", channel: "ZEE TV", title: "Show", start: NOW + 30 * M, stop: NOW + 60 * M, status: "pending", ...o });

test("validateCreate", () => {
  assert.equal(R.validateCreate({ stream_id: "x", title: "a", start_ts: 1 }, NOW).error, "bad stream_id");
  assert.equal(R.validateCreate({ stream_id: "1", title: " ", start_ts: 1 }, NOW).error, "title required");
  assert.equal(R.validateCreate({ stream_id: "1", title: "a", start_ts: NOW / 1000 - 1 }, NOW).error, "programme already started");
  const ok = R.validateCreate({ stream_id: 12, title: "a", start_ts: NOW / 1000 + 600, stop_ts: NOW / 1000 + 300 }, NOW);
  assert.equal(ok.streamId, "12");
  assert.equal(ok.stop, ok.start + 30 * M, "bad stop -> 30 min default");
});

test("duplicates match on profile + channel + start + title", () => {
  const list = [mk({})];
  assert.ok(R.findDuplicate(list, "p1", "10", NOW + 30 * M, "show"));
  assert.equal(R.findDuplicate(list, "p2", "10", NOW + 30 * M, "Show"), null);
  assert.equal(R.findDuplicate([mk({ status: "dropped" })], "p1", "10", NOW + 30 * M, "Show"), null);
});

test("fires 2 min before start, late fire up to 5 min after, then missed", () => {
  const r = mk({});
  assert.equal(R.dueTransitions([r], r.start - 3 * M).fire.length, 0);
  assert.equal(R.dueTransitions([r], r.start - 2 * M).fire.length, 1);
  assert.equal(R.dueTransitions([r], r.start + 4 * M).fire.length, 1);
  assert.equal(R.dueTransitions([r], r.start + 6 * M).miss.length, 1);
  assert.equal(R.dueTransitions([mk({ status: "fired" })], r.start).fire.length, 0);
});

test("due banners: fired, unacked, recent, own profile only", () => {
  const f = mk({ status: "fired", firedAt: NOW });
  assert.equal(R.dueForProfile([f], "p1", NOW + M).length, 1);
  assert.equal(R.dueForProfile([f], "p2", NOW + M).length, 0);
  assert.equal(R.dueForProfile([{ ...f, ackedAt: NOW }], "p1", NOW + M).length, 0);
  assert.equal(R.dueForProfile([f], "p1", NOW + 11 * M).length, 0);
});

test("rematch: keep, move by title, drop when the guide covers the slot, keep when it doesn't", () => {
  const r = mk({});
  assert.equal(R.rematch(r, null).action, "keep");
  const same = [{ title: "Show", start: r.start, stop: r.stop }];
  assert.equal(R.rematch(r, same).action, "keep");
  const moved = R.rematch(r, [{ title: "SHOW!", start: r.start + 15 * M, stop: r.stop + 15 * M }]);
  assert.deepEqual(moved, { action: "move", start: r.start + 15 * M, stop: r.stop + 15 * M });
  const gone = R.rematch(r, [{ title: "Other", start: NOW, stop: NOW + 120 * M }]);
  assert.equal(gone.action, "drop");
  const short = R.rematch(r, [{ title: "Other", start: NOW, stop: NOW + 10 * M }]);
  assert.equal(short.action, "keep");
  const far = R.rematch(r, [{ title: "x", start: NOW, stop: NOW + 5 * 3600e3 }, { title: "Show", start: r.start + 5 * 3600e3, stop: r.start + 6 * 3600e3 }]);
  assert.equal(far.action, "drop", "same title 5 h later is a different airing");
});

test("prune keeps pending, drops old finished", () => {
  const old = mk({ status: "fired", stop: NOW - 25 * 3600e3, start: NOW - 26 * 3600e3 });
  assert.deepEqual(R.prune([old, mk({})], NOW).map((r) => r.status), ["pending"]);
});

test("notify text", () => {
  const t = R.notifyText(mk({ start: NOW + 2 * M }), "Kunal", NOW);
  assert.equal(t.message, "Kunal: Show starts on ZEE TV in 2 min.");
  assert.equal(R.publicView(mk({}), NOW).starts_in_secs, 1800);
});

test("stop is clamped to start + 12 h (also on rematch)", () => {
  const v = R.validateCreate({ stream_id: "1", title: "a", start_ts: NOW / 1000 + 600, stop_ts: NOW / 1000 + 600 + 48 * 3600 }, NOW);
  assert.equal(v.stop, v.start + 12 * 3600e3);
  const r = mk({});
  const m = R.rematch(r, [{ title: "Show", start: r.start + 10 * M, stop: r.start + 10 * M + 30 * 3600e3 }]);
  assert.equal(m.action, "move");
  assert.equal(m.stop, m.start + 12 * 3600e3);
});

test("makeRoom: pending cap, total cap prunes oldest finished first", () => {
  const pend = Array.from({ length: R.MAX_PER_PROFILE }, (_, i) => mk({ id: `p${i}` }));
  assert.equal(R.makeRoom(pend, "p1"), null, "pending cap");
  assert.equal(R.makeRoom(pend, "p2"), pend, "other profile unaffected");
  const done = Array.from({ length: R.MAX_TOTAL_PER_PROFILE }, (_, i) => mk({ id: `d${i}`, status: "missed", start: NOW + i * M }));
  const out = R.makeRoom(done, "p1");
  assert.equal(out.length, R.MAX_TOTAL_PER_PROFILE - 1);
  assert.ok(!out.some((r) => r.id === "d0"), "oldest dropped");
  const few = [mk({ status: "fired" })];
  assert.equal(R.makeRoom(few, "p1"), few);
});

test("haServiceFor: owner user's profiles on the owner account only", () => {
  const owner = { id: "p1", nick: "Kunal", ownerUserId: "u1" };
  const base = { reminder: mk({ owner: true }), profile: owner, ownerUserId: "u1", profilesMap: "kunal=mobile_app_k, Vir=mobile_app_v", fallback: "mobile_app_owner" };
  assert.equal(R.haServiceFor(base), "mobile_app_k");
  assert.equal(R.haServiceFor({ ...base, profilesMap: "" }), "mobile_app_owner", "owner profile falls back");
  assert.equal(R.haServiceFor({ ...base, profilesMap: "p1=mobile_app_id" }), "mobile_app_id", "match on id");
  assert.equal(R.haServiceFor({ ...base, profile: null }), null, "deleted profile never pushes");
  // Another user's profile named like a mapped nick: no push, no fallback.
  assert.equal(R.haServiceFor({ ...base, profile: { id: "p1", nick: "Kunal", ownerUserId: "u2" } }), null);
  assert.equal(R.haServiceFor({ ...base, reminder: mk({ owner: false }) }), null, "non-owner account");
  assert.equal(R.haServiceFor({ ...base, reminder: mk({ owner: true, profileId: "p9" }) }), null, "profile mismatch");
  assert.equal(R.haServiceFor({ ...base, ownerUserId: null }), null);
});
