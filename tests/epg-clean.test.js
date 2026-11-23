const test = require("node:test");
const assert = require("node:assert/strict");
const { cleanEpgOverlaps, cleanEpgIndexOverlaps, calibrateEpgOffsets, alignOffset } = require("../lib/epg-clean");

const H = 3600e3, M = 60e3;
const T0 = Date.UTC(2026, 10, 23, 17, 0);
const P = (h, dur, title) => ({ start: T0 + h * H, stop: T0 + h * H + dur * M, title, desc: "" });

test("merged schedules: both sides of an overlapping slot are dropped, clean slots kept", () => {
  // The Colors INFINITY shape: two programmes per hour slot in places.
  const progs = [
    P(0, 60, "Veep"), P(0, 60, "MasterChef Australia"),
    P(1, 60, "Chesapeake Shores"),
    P(3, 60, "Shark Tank"), P(3, 60, "MasterChef Australia"),
    P(4, 60, "Game of Thrones"), P(4, 60, "Accused"),
    P(5, 60, "The Gilded Age"),
  ];
  const r = cleanEpgOverlaps(progs);
  assert.deepEqual(r.progs.map((p) => p.title), ["Chesapeake Shores", "The Gilded Age"]);
  assert.equal(r.dropped, 6);
});

test("partial overlaps: big ones dropped, small overruns tolerated", () => {
  const r = cleanEpgOverlaps([P(0, 63, "A"), P(1, 60, "B"), P(2, 60, "C"), P(2.5, 60, "D")]);
  // A overruns B by 3 min -> fine; C/D overlap by 30 min -> both dropped.
  assert.deepEqual(r.progs.map((p) => p.title), ["A", "B"]);
});

test("a long envelope programme spanning others is ambiguous -> dropped with them", () => {
  const r = cleanEpgOverlaps([P(0, 600, "Real Tevar"), P(1, 120, "Suriya S3"), P(11, 60, "Bharat")]);
  assert.deepEqual(r.progs.map((p) => p.title), ["Bharat"]);
});

test("same-slot duplicates collapse (exact, or a flag glued onto the title)", () => {
  const r = cleanEpgOverlaps([P(0, 30, "BBC News"), P(0, 30, "NewBBC News"), P(0, 30, "BBC News"), P(0.5, 30, "Newsnight")]);
  assert.deepEqual(r.progs.map((p) => p.title), ["BBC News", "Newsnight"]);
  assert.equal(r.dropped, 0);
});

test("a clean channel is returned untouched (same array)", () => {
  const arr = [P(0, 30, "A"), P(0.5, 30, "B")];
  assert.equal(cleanEpgOverlaps(arr).progs, arr);
});

test("index cleanup deletes channels left empty and reports stats", () => {
  const m = new Map([["ok", [P(0, 30, "A")]], ["bad", [P(0, 60, "X"), P(0, 60, "Y")]], ["mixed", [P(0, 60, "X"), P(0, 60, "Y"), P(2, 60, "Z")]]]);
  const st = cleanEpgIndexOverlaps(m);
  assert.deepEqual([...m.keys()].sort(), ["mixed", "ok"]);
  assert.deepEqual(m.get("mixed").map((p) => p.title), ["Z"]);
  assert.equal(st.channels, 2);
  assert.equal(st.emptied, 1);
  assert.equal(st.programmesDropped, 4);
});

const day = (shiftH, names) => names.map((t, i) => P(i * 0.5 + shiftH, 30, t));
const SHOWS = ["Alpha Show", "Bravo Hour", "Charlie Live", "Delta Drama", "Echo Report", "Foxtrot Talk", "Golf Weekly", "Hotel Story"];

test("alignOffset finds a constant shift, and refuses weak evidence", () => {
  assert.equal(alignOffset(day(5.5, SHOWS), day(0, SHOWS)), -5.5 * H);
  assert.equal(alignOffset(day(0, SHOWS), day(0, SHOWS)), 0);
  assert.equal(alignOffset(day(0, SHOWS.slice(0, 3)), day(0, SHOWS.slice(0, 3))), null); // < 4 matches
});

function scenario({ provShiftH, n, extra = {} }) {
  const byChannel = new Map(), names = new Map(), sourceOf = new Map();
  for (let i = 0; i < n; i++) {
    const shows = SHOWS.map((s) => `${s} ${i}`);
    byChannel.set(`chan${i}.in`, day(provShiftH, shows)); names.set(`chan${i}.in`, [`IN: Chan ${i} HD`]); sourceOf.set(`chan${i}.in`, "provider");
    byChannel.set(`Chan${i}.in`, day(0, shows)); names.set(`Chan${i}.in`, [`Chan ${i}`]); sourceOf.set(`Chan${i}.in`, "epg_ripper_IN1");
  }
  for (const [id, v] of Object.entries(extra)) { byChannel.set(id, v.progs); names.set(id, v.names); sourceOf.set(id, v.source); }
  return { byChannel, names, sourceOf, isReference: (l) => /^epg_ripper_/.test(l), nameKey: (s) => String(s).replace(/^IN:\s*/, "").replace(/\bHD\b/, "").toLowerCase().replace(/[^a-z0-9]/g, "") };
}

test("group consensus shifts the whole source+country group, incl. uncalibrated channels", () => {
  const sc = scenario({ provShiftH: 5.5, n: 6, extra: { "nomatch.in": { progs: [P(10, 30, "Lonely")], names: ["IN: Nothing Like It"], source: "provider" } } });
  const r = calibrateEpgOffsets(sc);
  assert.equal(r.applied.size, 7);
  assert.equal(r.groups["provider/in"].shiftMin, -330);
  assert.equal(sc.byChannel.get("chan0.in")[0].start, T0);
  assert.equal(sc.byChannel.get("nomatch.in")[0].start, T0 + 4.5 * H);
  assert.equal(sc.byChannel.get("Chan0.in")[0].start, T0); // references never move
});

test("a channel measured at 0 vetoes the group shift", () => {
  const shows = SHOWS.map((s) => `${s} dw`);
  const sc = scenario({ provShiftH: 5.5, n: 6, extra: {
    "dw.in": { progs: day(0, shows), names: ["IN: DW"], source: "provider" },
    "DW.ca2": { progs: day(0, shows), names: ["DW"], source: "epg_ripper_CA2" },
  } });
  const r = calibrateEpgOffsets(sc);
  assert.equal(r.applied.has("dw.in"), false);
  assert.equal(sc.byChannel.get("dw.in")[0].start, T0);
});

test("no shift without enough agreeing channels (too few, or split votes)", () => {
  const few = scenario({ provShiftH: 5.5, n: 3 });
  assert.equal(calibrateEpgOffsets(few).applied.size, 0);
  const sc = scenario({ provShiftH: 5.5, n: 5 });
  for (let i = 5; i < 9; i++) { // 4 more channels that are already correct
    const shows = SHOWS.map((s) => `${s} ok${i}`);
    sc.byChannel.set(`ok${i}.in`, day(0, shows)); sc.names.set(`ok${i}.in`, [`IN: Ok ${i}`]); sc.sourceOf.set(`ok${i}.in`, "provider");
    sc.byChannel.set(`Ok${i}.in`, day(0, shows)); sc.names.set(`Ok${i}.in`, [`Ok ${i}`]); sc.sourceOf.set(`Ok${i}.in`, "epg_ripper_IN1");
  }
  const r = calibrateEpgOffsets(sc);
  assert.equal(r.applied.size, 0);
  assert.equal(r.groups["provider/in"].shiftMin, 0);
});

test("a lone non-zero single-channel measurement is not applied", () => {
  const sc = scenario({ provShiftH: 0, n: 6, extra: {
    "odd.in": { progs: day(1.5, SHOWS.map((s) => `${s} odd`)), names: ["IN: Odd"], source: "provider" },
    "Odd.uk": { progs: day(0, SHOWS.map((s) => `${s} odd`)), names: ["Odd"], source: "epg_ripper_UK1" },
  } });
  const r = calibrateEpgOffsets(sc);
  assert.equal(r.applied.size, 0);
});
