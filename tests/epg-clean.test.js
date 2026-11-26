const test = require("node:test");
const assert = require("node:assert/strict");
const { cleanEpgOverlaps, cleanEpgIndexOverlaps, calibrateEpgOffsets, shiftsToPersist, alignOffset, epgIdCountry } = require("../lib/epg-clean");

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

test("index cleanup: gutted channels are deleted, lightly-affected ones trimmed", () => {
  const clean10 = Array.from({ length: 10 }, (_, i) => P(i, 60, `S${i}`));
  const m = new Map([
    ["ok", [P(0, 30, "A")]],
    ["bad", [P(0, 60, "X"), P(0, 60, "Y")]],
    // 2 of 3 dropped (>25%) -> whole channel removed so streams can fall back
    ["mostlyBad", [P(0, 60, "X"), P(0, 60, "Y"), P(2, 60, "Z")]],
    // 2 of 12 dropped (<25%) and still has upcoming programmes -> trimmed
    ["light", [...clean10, P(20, 60, "X"), P(20, 60, "Y")]],
    // 2 of 12 dropped but nothing left in now..+6h -> removed
    ["noUpcoming", [P(0, 60, "X"), P(0, 60, "Y"), ...clean10.map((p) => ({ ...p, start: p.start + 10 * H, stop: p.stop + 10 * H }))]],
  ]);
  const st = cleanEpgIndexOverlaps(m, T0);
  assert.deepEqual([...m.keys()].sort(), ["light", "ok"]);
  assert.equal(m.get("light").length, 10);
  assert.equal(st.channels, 4);
  assert.equal(st.emptied, 3);
  assert.deepEqual(st.removed.sort(), ["bad", "mostlyBad", "noUpcoming"]);
});

test("index cleanup is idempotent", () => {
  const m = new Map([["light", [...Array.from({ length: 10 }, (_, i) => P(i, 60, `S${i}`)), P(20, 60, "X"), P(20, 60, "Y"), P(1, 60, "S1")]], ["bad", [P(0, 60, "X"), P(0, 60, "Y")]]]);
  cleanEpgIndexOverlaps(m, T0);
  const snap = JSON.stringify([...m]);
  const st = cleanEpgIndexOverlaps(m, T0);
  assert.equal(JSON.stringify([...m]), snap);
  assert.equal(st.channels + st.emptied, 0);
});

test("fallback after partial cleanup: gutted provider id disappears, the clean reference stays", () => {
  const m = new Map([
    ["colorsinfinityhd.in", [P(0, 60, "Shark Tank"), P(0, 60, "MasterChef Australia"), P(1, 60, "Game of Thrones"), P(1, 60, "Accused"), P(2, 60, "Veep")]],
    ["Colors.Infinity.SD.in", [P(0, 60, "Chesapeake Shores"), P(1, 60, "Billions")]],
  ]);
  cleanEpgIndexOverlaps(m, T0);
  assert.deepEqual([...m.keys()], ["Colors.Infinity.SD.in"]);
});

test("same-slot flag dedupe is tight: unrelated containing titles are not merged", () => {
  const r = cleanEpgOverlaps([P(0, 30, "News"), P(0, 30, "Business News Tonight")]);
  assert.equal(r.progs.length, 0); // a real conflict, not a flag variant
  assert.equal(r.dropped, 2);
  assert.equal(cleanEpgOverlaps([P(0, 30, "BBC News at Six"), P(0, 30, "BBC News at Six LIVE")]).progs.length, 1);
});

test("epgIdCountry handles numbered and @variant ids", () => {
  assert.equal(epgIdCountry("Sony.Max.Hd.in2"), "in");
  assert.equal(epgIdCountry("ATN.Colors.ca2"), "ca");
  assert.equal(epgIdCountry("bbcone.uk@HD"), "uk");
  assert.equal(epgIdCountry("colorshd.in"), "in");
  assert.equal(epgIdCountry("577081"), null);
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
  return { byChannel, names, sourceOf, isReference: (l) => /^epg_ripper_/.test(l), isCandidate: (l) => l === "provider", nameKey: (s) => String(s).replace(/^IN:\s*/, "").replace(/\bHD\b/, "").toLowerCase().replace(/[^a-z0-9]/g, "") };
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

test("reference outage: no evidence leaves data unchanged, or reuses the persisted shift", () => {
  const sc = scenario({ provShiftH: 5.5, n: 6 });
  for (const id of [...sc.sourceOf.keys()]) if (sc.sourceOf.get(id) !== "provider") { sc.byChannel.delete(id); sc.sourceOf.delete(id); }
  const before = JSON.stringify([...sc.byChannel]);
  assert.equal(calibrateEpgOffsets(sc).applied.size, 0);
  assert.equal(JSON.stringify([...sc.byChannel]), before);
  const r = calibrateEpgOffsets({ ...sc, previous: { "provider/in": -330 } });
  assert.equal(r.applied.size, 6);
  assert.equal(r.groups["provider/in"].reused, true);
  assert.deepEqual(shiftsToPersist(r.groups), { "provider/in": { shiftMin: -330, misses: 1 } });
});

test("persisted shift survives a build where the group is absent, and is cleared by a consensus of 0", () => {
  const empty = { byChannel: new Map(), names: new Map(), sourceOf: new Map(), isReference: () => false, isCandidate: () => true, nameKey: (s) => s };
  const r = calibrateEpgOffsets({ ...empty, previous: { "provider/in": -330 } });
  assert.deepEqual(shiftsToPersist(r.groups), { "provider/in": { shiftMin: -330, misses: 1 } });
  assert.deepEqual(r.absent, ["provider/in"]);
  const fixed = scenario({ provShiftH: 0, n: 6 }); // provider fixed its feed
  const r2 = calibrateEpgOffsets({ ...fixed, previous: { "provider/in": -330 } });
  assert.equal(r2.applied.size, 0);
  assert.deepEqual(shiftsToPersist(r2.groups), {});
});

test("conflicting references for a channel give it no vote", () => {
  const shows = SHOWS.map((s) => `${s} x`);
  const sc = scenario({ provShiftH: 0, n: 0, extra: {
    "x.in": { progs: day(0, shows), names: ["IN: X"], source: "provider" },
    "X.in": { progs: day(0, shows), names: ["X"], source: "epg_ripper_IN1" },
    "X.uk": { progs: day(2, shows), names: ["X"], source: "epg_ripper_UK1" },
  } });
  const r = calibrateEpgOffsets(sc);
  assert.equal(r.groups["provider/in"], undefined);
});

test("only candidate sources are calibrated (epg.pw-style feeds left alone)", () => {
  const sc = scenario({ provShiftH: 0, n: 0 });
  for (let i = 0; i < 6; i++) {
    const shows = SHOWS.map((s) => `${s} pw${i}`);
    sc.byChannel.set(`5770${i}`, day(8, shows)); sc.names.set(`5770${i}`, [`Pw ${i}`]); sc.sourceOf.set(`5770${i}`, "epg_IN");
    sc.byChannel.set(`Pw${i}.in`, day(0, shows)); sc.names.set(`Pw${i}.in`, [`Pw ${i}`]); sc.sourceOf.set(`Pw${i}.in`, "epg_ripper_IN1");
  }
  assert.equal(calibrateEpgOffsets(sc).applied.size, 0);
});

// Provider group where `fixed` channels measure 0 and `late` ones measure +5.5h.
function mixed(fixed, late) {
  const sc = scenario({ provShiftH: 0, n: 0 });
  const add = (tag, shiftH) => {
    const shows = SHOWS.map((x) => `${x} ${tag}`);
    sc.byChannel.set(`${tag}.in`, day(shiftH, shows)); sc.names.set(`${tag}.in`, [`IN: ${tag}`]); sc.sourceOf.set(`${tag}.in`, "provider");
    sc.byChannel.set(`R${tag}.in`, day(0, shows)); sc.names.set(`R${tag}.in`, [tag]); sc.sourceOf.set(`R${tag}.in`, "epg_ripper_IN1");
  };
  for (let i = 0; i < fixed; i++) add(`f${i}`, 0);
  for (let i = 0; i < late; i++) add(`l${i}`, 5.5);
  sc.byChannel.set("nomeas.in", [P(10, 30, "Unmatched")]); sc.names.set("nomeas.in", ["IN: Nothing"]); sc.sourceOf.set("nomeas.in", "provider");
  return sc;
}

test("stale shift: a few 0 votes below minGroup clear it (no double correction)", () => {
  const sc = mixed(2, 0);
  const r = calibrateEpgOffsets({ ...sc, previous: { "provider/in": { shiftMin: -330, misses: 0 } } });
  assert.equal(r.applied.size, 0);
  assert.equal(sc.byChannel.get("nomeas.in")[0].start, T0 + 10 * H);
  assert.deepEqual(shiftsToPersist(r.groups), {});
});

test("split votes: 0 as plurality clears; a minority of 0s blocks reuse but keeps the memory", () => {
  const plural = calibrateEpgOffsets({ ...mixed(2, 2), previous: { "provider/in": -330 } });
  assert.equal(plural.applied.size, 0);
  assert.deepEqual(shiftsToPersist(plural.groups), {});
  const minority = calibrateEpgOffsets({ ...mixed(1, 3), previous: { "provider/in": -330 } });
  assert.equal(minority.applied.size, 0); // contradicted -> not applied
  assert.deepEqual(shiftsToPersist(minority.groups), { "provider/in": { shiftMin: -330, misses: 1 } });
});

test("uncontradicted reuse expires after 4 builds without a fresh consensus", () => {
  let previous = { "provider/in": -330 };
  for (let build = 1; build <= 5; build++) {
    const sc = mixed(0, 2); // 2 channels agree on -330 but < minGroup: no consensus, no contradiction
    const r = calibrateEpgOffsets({ ...sc, previous });
    if (build <= 4) assert.equal(r.applied.size, 3, `build ${build}`);
    else assert.equal(r.applied.size, 0, `build ${build}`);
    previous = shiftsToPersist(r.groups);
  }
  assert.deepEqual(previous, {});
});

test("a fresh consensus resets the reuse counter", () => {
  const r = calibrateEpgOffsets({ ...mixed(0, 6), previous: { "provider/in": { shiftMin: -330, misses: 3 } } });
  assert.equal(r.applied.size, 7);
  assert.deepEqual(shiftsToPersist(r.groups), { "provider/in": { shiftMin: -330, misses: 0 } });
});

test("deletion rule needs enough dropped programmes", () => {
  const long = Array.from({ length: 6 }, (_, i) => P(i + 2, 60, `S${i}`));
  // 2 of 8 dropped (25%, <50%) with upcoming programmes -> trimmed, not deleted
  const m = new Map([["c", [P(0, 60, "X"), P(0, 60, "Y"), ...long]]]);
  cleanEpgIndexOverlaps(m, T0);
  assert.equal(m.get("c").length, 6);
});

test("fixPanelPrograms: panel fallback gets the measured provider/in shift, then overlap cleanup", () => {
  const { fixPanelPrograms } = require("../lib/epg-clean");
  // MN+ shape: IST labelled as UTC (Southpaw really airs 5.5h earlier), merged-schedule slot dropped.
  const rows = [P(0, 120, "Southpaw"), P(2, 120, "Woman in Gold"), P(4, 60, "Movie"), P(4, 60, "Ali")];
  const groups = { "provider/in": { shiftMin: -330 } };
  const out = fixPanelPrograms(rows, "mnplushd.in", groups);
  assert.deepEqual(out.map((p) => p.title), ["Southpaw", "Woman in Gold"]);
  assert.equal(out[0].start, T0 - 330 * M);
  // No measured shift for the group (or a different country): times untouched.
  assert.equal(fixPanelPrograms(rows, "bbc.uk", groups)[0].start, T0);
  assert.equal(fixPanelPrograms(rows, "mnplushd.in", undefined)[0].start, T0);
});
