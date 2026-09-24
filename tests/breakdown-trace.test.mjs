import { createBreakdownTracer, MAX_TRACE_TICKS, MAX_SAMPLES } from "./build/breakdown-trace.mjs";
let pass = 0, fail = 0;
const ok = (c, m) => { c ? pass++ : (fail++, console.log("FAIL:", m)); };

const T = 32;
const ride = (breakdown) => ({ id: 4, name: "Woodchip", breakdown, exit: { x: 10 * T, y: 10 * T } });
const mech = (id, tx, ty, animation = "walking", ridesFixed = 0, ridesInspected = 0) =>
    ({ id, x: tx * T, y: ty * T, animation, ridesFixed, ridesInspected });

// Idle until a breakdown starts.
{
    const tr = createBreakdownTracer();
    ok(!tr.active(), "inactive with nothing traced");
    ok(tr.sample(0, [ride("none")], []).length === 0, "sampling with nothing traced returns nothing");
}

// Full story: pending -> broken -> mechanic walks in -> fixes -> fixed.
{
    const tr = createBreakdownTracer();
    tr.start(4, "safety_cut_out", 1000);
    tr.start(4, "safety_cut_out", 1010); // duplicate event ignored
    ok(tr.active(), "active after start");

    // Pending: the event fired but brokenDown isn't set yet. Must not count as fixed.
    let out = tr.sample(1064, [ride("none")], [mech(1, 30, 10), mech(2, 10, 40, "walking", 0, 5)]);
    ok(out.length === 0, "pending breakdown is not reported as fixed");
    out = tr.sample(1128, [ride("safety_cut_out")], [mech(1, 20, 10, "staffAnswerCall"), mech(2, 10, 40)]);
    out = tr.sample(1192, [ride("safety_cut_out")], [mech(1, 11, 10), mech(2, 10, 40)]);
    out = tr.sample(1256, [ride("safety_cut_out")], [mech(1, 10, 10, "staffFix"), mech(2, 10, 40, "walking", 0, 6)]);
    out = tr.sample(1320, [ride("none")], [mech(1, 10, 10, "walking", 1), mech(2, 10, 40, "walking", 0, 7)]);
    ok(out.length === 1 && !tr.active(), "fixed trace reported once and cleared");
    const r = out[0];
    ok(r.outcome === "fixed" && r.ride === "Woodchip" && r.reason === "safety_cut_out", "identity/outcome");
    ok(r.ticksToBroken === 128, "ticksToBroken " + r.ticksToBroken);
    ok(r.ticksToArrive === 192, "ticksToArrive " + r.ticksToArrive);
    ok(r.ticksToFixAnim === 256, "ticksToFixAnim " + r.ticksToFixAnim);
    ok(r.ticksToFixed === 256, "ticksToFixed = last sample seen broken: " + r.ticksToFixed);
    ok(r.startNearest === 20 && r.mechanics === 2, "start nearest 20 tiles of 2 mechanics: " + r.startNearest);
    ok(r.fixedBy === 1 && r.fixerStartDistance === 20, "fixer identified with start distance");
    ok(r.inspectionsDuring === 2, "inspections during breakdown: " + r.inspectionsDuring);
    ok(r.samples.length === 4, "one sample per broken/pending tick: " + r.samples.length);
    ok(r.samples[1].answering === 1 && r.samples[3].fixing === 1 && r.samples[3].atRide === 1, "animations counted");
}

// Fixer walk: distance actually walked vs the straight-line start, from the broken flag.
{
    const tr = createBreakdownTracer();
    tr.start(4, "safety_cut_out", 0);
    const R = () => [ride("safety_cut_out")];
    tr.sample(64, [ride("none")], [mech(1, 14, 10)]);        // pending: not counted
    tr.sample(128, R(), [mech(1, 16, 10)]);                  // broken: walk starts here, 6 tiles away
    tr.sample(192, R(), [mech(1, 18, 10)]);                  // detour away: +2
    tr.sample(256, R(), [mech(1, 18, 14)]);                  // +4
    tr.sample(320, R(), [mech(1, 12, 10)]);                  // +10, within 2 tiles: arrived
    tr.sample(384, R(), [mech(1, 10, 10, "staffFix")]);      // moves after arrival: not counted
    const out = tr.sample(448, [ride("none")], [mech(1, 10, 10, "walking", 1)]);
    const r = out[0];
    ok(r.fixedBy === 1, "fixer found");
    ok(r.fixerWalkTiles === 16, "walked tiles from broken flag to arrival: " + r.fixerWalkTiles);
    ok(r.fixerWalkTicks === 192, "walk ticks broken->arrival: " + r.fixerWalkTicks);
    ok(r.fixerTicksPerTile === 12, "ticks per tile: " + r.fixerTicksPerTile);
}

// No fixer: walk fields are -1.
{
    const tr = createBreakdownTracer();
    tr.start(4, "safety_cut_out", 0);
    tr.sample(64, [ride("safety_cut_out")], [mech(1, 30, 10)]);
    const r = tr.sample(128, [ride("none")], [mech(1, 30, 10)])[0];
    ok(r.fixerWalkTiles === -1 && r.fixerWalkTicks === -1 && r.fixerTicksPerTile === -1, "walk fields -1 without a fixer");
}

// Ride removed or without an exit mid-trace.
{
    const tr = createBreakdownTracer();
    tr.start(4, "brakes_failure", 0);
    const out = tr.sample(64, [], [mech(1, 0, 0)]);
    ok(out.length === 1 && out[0].outcome === "gone", "missing ride reported as gone");
}

// Gives up after MAX_TRACE_TICKS, and samples stay capped.
{
    const tr = createBreakdownTracer();
    tr.start(4, "vehicle_malfunction", 0);
    let out = [];
    for (let t = 64; out.length === 0 && t < MAX_TRACE_TICKS * 2; t += 16) {
        out = tr.sample(t, [ride("vehicle_malfunction")], [mech(1, 50, 50)]);
    }
    ok(out.length === 1 && out[0].outcome === "unfinished", "times out as unfinished");
    ok(out[0].samples.length === MAX_SAMPLES, "samples capped at " + MAX_SAMPLES + ": " + out[0].samples.length);
    ok(out[0].fixedBy === -1, "no fixer when nobody's counter moved");
}

console.log(`${pass} passed, ${fail} failed`); if (fail) process.exitCode = 1;
