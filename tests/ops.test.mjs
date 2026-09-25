import { createOpsController, CONFIRM_OBSERVATIONS, HIGH_QUEUE_MINUTES, LOW_QUEUE_MINUTES } from "./build/ops.mjs";
let pass=0, fail=0; const ok=(c,m)=>{ c?pass++:(fail++,console.log("FAIL:",m)); };
const R=(id,q,rt=60,intensity=400)=>({rideId:id,name:"R"+id,queueTime:q,rideTime:rt,intensity});
// Real call pattern: update() first (controller learns the ride + emits a probe),
// then noteProbe with the result. noteProbe on an unseen ride is a no-op by design.
function seedMax(ctrl, id, trueMax){
  for(let i=0;i<40;i++){
    const p=ctrl.update([R(id,0)]).filter(a=>a.kind==="probe")[0];
    if(!p) break;
    ctrl.noteProbe(id, p.value, p.value<=trueMax);
  }
  return ctrl.describe(id).max;
}

ok(createOpsController(32).update([]).length===0,"empty rides");

// --- probing terminates and finds the max ---
const c=createOpsController(32);
let val=null, steps=0, TRUE_MAX=10;
for(let i=0;i<40;i++){
  const acts=c.update([R(1,0)]);
  const probe=acts.filter(a=>a.kind==="probe")[0];
  if(!probe) break;
  steps++; val=probe.value;
  c.noteProbe(1, probe.value, probe.value<=TRUE_MAX);
}
ok(steps<=14,"probe terminates quickly, took "+steps+" steps");
ok(c.describe(1).max===TRUE_MAX,"binary search finds the TRUE max (not a lower bound), got "+c.describe(1).max+" expected "+TRUE_MAX);

// --- never SET before max is known ---
const c2=createOpsController(32);
let sets=0;
for(let i=0;i<20;i++){ for(const a of c2.update([R(2,30)])) if(a.kind==="set") sets++; }
ok(sets===0,"never sets while max unknown, got "+sets);

// --- hysteresis: needs CONFIRM_OBSERVATIONS consecutive readings ---
const c3=createOpsController(16);
seedMax(c3,3,16);
let firstSetAt=-1;
for(let i=0;i<12;i++){
  const acts=c3.update([R(3, HIGH_QUEUE_MINUTES+5)]);
  if(acts.some(a=>a.kind==="set") && firstSetAt<0) firstSetAt=i+1;
}
ok(firstSetAt>=CONFIRM_OBSERVATIONS, `set waited for hysteresis (${firstSetAt} >= ${CONFIRM_OBSERVATIONS})`);

// --- flapping pressure resets the streak: no set at all ---
const c4=createOpsController(16); seedMax(c4,4,16);
let flapSets=0;
for(let i=0;i<20;i++){
  const q = i%2===0 ? HIGH_QUEUE_MINUTES+5 : LOW_QUEUE_MINUTES;
  for(const a of c4.update([R(4,q)])) if(a.kind==="set") flapSets++;
}
ok(flapSets===0,"alternating pressure never acts, got "+flapSets);

// --- direction: HIGH queue shortens, LOW queue lengthens ---
const c5=createOpsController(16); seedMax(c5,5,16);
let s1=null; for(let i=0;i<8 && !s1;i++) s1=c5.update([R(5,HIGH_QUEUE_MINUTES+9)]).filter(a=>a.kind==="set")[0];
ok(!!s1,"high-queue produced a set");
// Calibration is DIRECTIONAL. With no known current value and a queue, the right answer
// is the shortest cycle the ride type allows - maximum throughput - not the midpoint.
// The midpoint is direction-blind and can LENGTHEN a congested ride, cutting throughput
// on exactly the ride that needed more of it (measured 2026-09-20).
ok(s1.value===1, "congested ride with unknown current calibrates to the MINIMUM, got "+s1.value);
c5.noteSet(5, s1.value);
// Already at the floor, so there is nothing further to do in that direction.
let s2=null; for(let i=0;i<8 && !s2;i++) s2=c5.update([R(5,HIGH_QUEUE_MINUTES+9)]).filter(a=>a.kind==="set")[0];
ok(!s2, "no further action once a congested ride is at its minimum");

// From a known value above the floor it steps down by exactly one, never jumping.
const c5b=createOpsController(16); seedMax(c5b,15,16); c5b.noteSet(15, 9);
let d1=null; for(let i=0;i<8 && !d1;i++) d1=c5b.update([R(15,HIGH_QUEUE_MINUTES+9)]).filter(a=>a.kind==="set")[0];
ok(d1 && d1.value===8, `high queue steps DOWN by one: 9 -> ${d1 && d1.value}`);

// An EMPTY ride still calibrates to the midpoint: a longer ride costs nothing when
// nobody is waiting, and may raise excitement.
const c6=createOpsController(16); seedMax(c6,6,16);
let l1=null; for(let i=0;i<8 && !l1;i++) l1=c6.update([R(6,0)]).filter(a=>a.kind==="set")[0];
ok(l1 && l1.value>1 && l1.value<16, "empty ride calibrates to the midpoint, got "+(l1&&l1.value));
c6.noteSet(6,l1.value);
let l2=null; for(let i=0;i<8 && !l2;i++) l2=c6.update([R(6,0)]).filter(a=>a.kind==="set")[0];
ok(l2 && l2.value > l1.value, `low queue steps UP: ${l1.value} -> ${l2 && l2.value}`);
ok(l2 && Math.abs(l2.value-l1.value)===1,"steps by exactly 1, got "+(l2&&Math.abs(l2.value-l1.value)));

// --- never repeats the known current value ---
const c7=createOpsController(16); seedMax(c7,7,16); c7.noteSet(7,1);
let repeats=0;
for(let i=0;i<20;i++) for(const a of c7.update([R(7,HIGH_QUEUE_MINUTES+9)])) if(a.kind==="set"&&a.value===1) repeats++;
ok(repeats===0,"never re-sets the same value (already at floor 1), got "+repeats);

// --- respects floor 1 and discovered max ---
const st=c7.describe(7); ok(st.current===1,"current tracked");
const c8=createOpsController(16); seedMax(c8,8,3); c8.noteSet(8,3);
let over=0;
for(let i=0;i<20;i++) for(const a of c8.update([R(8,0)])) if(a.kind==="set"&&a.value>3) over++;
ok(over===0,"never exceeds discovered max, got "+over);

// --- a ride absent from a pass KEEPS its discovered range ---
// Measured 2026-09-20: the controller used to delete the whole record for any ride
// missing from a pass. But a ride leaves the optimizable list whenever it closes or
// breaks down - 24 of 167 measured days - and every exit threw away the probed range,
// so probing restarted from scratch on its return. The log showed 192 probes with
// rangeKnown stuck at 8 and only one ride ever tuned.
const c9=createOpsController(16);
seedMax(c9, 10, 12);
ok(c9.describe(10).max===12, "range discovered, got "+JSON.stringify(c9.describe(10)));
c9.update([R(9,0)]);                       // ride 10 absent
ok(c9.describe(10)!==null, "an absent ride is not forgotten");
ok(c9.describe(10).max===12, "and keeps its discovered range, got "+c9.describe(10).max);
// ...but its queue trend does NOT survive the gap. A ride closed for a week has no
// meaningful recent history, and acting on a pre-closure streak is acting on stale
// evidence.
ok(c9.describe(10).streak===0, "the streak resets across an absence, got "+c9.describe(10).streak);

// A reused ride id must NOT inherit the previous ride's range: the legal range is per
// ride TYPE, so a swinging ship's 7-25 applied to a maze would be nonsense.
const cT=createOpsController(16);
seedMax(cT, 50, 12);
ok(cT.describe(50).max===12, "range discovered for the original ride");
cT.update([{rideId:50, name:"Something Else", queueTime:0, rideTime:60, intensity:400, rideType:99}]);
ok(cT.describe(50).max===null, "a changed ride type discards the range");
// A mere RENAME must not, though - players rename rides all the time.
const cU=createOpsController(16);
seedMax(cU, 51, 12);
cU.update([{rideId:51, name:"Renamed By Player", queueTime:0, rideTime:60, intensity:400}]);
ok(cU.describe(51).max===12, "renaming a ride keeps its range, got "+cU.describe(51).max);
c9.forget(9); ok(c9.describe(9)===null,"forget works");
ok(c9.describe(999)===null,"unknown ride -> null");
c9.reset(); ok(c9.describe(9)===null,"reset works");
// --- REGRESSION: fluctuating queues must still converge -----------------------
// Measured 2026-09-20: across 18 in-game days with queues oscillating either side of
// the 5-minute threshold, the consecutive-run counter meant ZERO rides were ever tuned.
// A mostly-congested ride with occasional dips must now accumulate and act.
const cF = createOpsController(16); seedMax(cF, 20, 16);
let fSets = 0;
for (let i = 0; i < 40; i++) {
  const q = (i % 4 === 3) ? 4 : HIGH_QUEUE_MINUTES + 3;   // 3 congested, 1 dip, repeat
  for (const a of cF.update([R(20, q)])) if (a.kind === "set") { fSets++; cF.noteSet(20, a.value); }
}
ok(fSets > 0, "mostly-congested ride with dips DOES converge (was 0 across 18 days), got " + fSets);

// ...but a ride genuinely flapping between extremes still cancels out and never acts.
const cG = createOpsController(16); seedMax(cG, 21, 16);
let gSets = 0;
for (let i = 0; i < 40; i++) {
  const q = i % 2 === 0 ? HIGH_QUEUE_MINUTES + 3 : LOW_QUEUE_MINUTES;
  for (const a of cG.update([R(21, q)])) if (a.kind === "set") { gSets++; cG.noteSet(21, a.value); }
}
ok(gSets === 0, "true high/low flapping still never acts, got " + gSets);

// Direction must follow the ACCUMULATED history, not the latest sample.
// Seeded with a known current value well above the floor, so the assertion is about
// DIRECTION rather than about calibration - a congested ride with an unknown current
// value now jumps straight to its minimum and has nowhere further to go.
const cH = createOpsController(16); seedMax(cH, 22, 16); cH.noteSet(22, 12);
let firstSet = null;
for (let i = 0; i < 30 && !firstSet; i++) {
  const q = (i % 5 === 4) ? 3 : HIGH_QUEUE_MINUTES + 4;
  firstSet = cH.update([R(22, q)]).filter(a => a.kind === "set")[0];
}
ok(firstSet && firstSet.value === 11, "congested-with-dips steps DOWN from 12, got " + (firstSet && firstSet.value));
cH.noteSet(22, firstSet.value);
let secondSet = null;
for (let i = 0; i < 30 && !secondSet; i++) {
  const q = (i % 5 === 4) ? 3 : HIGH_QUEUE_MINUTES + 4;
  secondSet = cH.update([R(22, q)]).filter(a => a.kind === "set")[0];
}
ok(secondSet && secondSet.value < firstSet.value,
   "acts on history not latest sample: " + firstSet.value + " -> " + (secondSet && secondSet.value));
// --- Community-informed guard: never lengthen an already-extreme ride ---------
// Consensus is intensity must stay BELOW 10 to stay exciting; past that, excitement is
// capped near 5.50. Lengthening raises intensity, so doing it to an empty extreme ride
// makes guests avoid it MORE - emptying the queue further and inviting another lengthen.
const cI = createOpsController(16); seedMax(cI, 30, 16);
let iSets = 0;
for (let i2 = 0; i2 < 40; i2++) {
  for (const a of cI.update([{ rideId: 30, name: "Extreme", queueTime: 0, rideTime: 60, intensity: 950 }]))
    if (a.kind === "set") { iSets++; cI.noteSet(30, a.value); }
}
ok(iSets === 0, "never lengthens a ride at intensity 9.50, got " + iSets);

// The same ride below the ceiling IS lengthened.
const cJ = createOpsController(16); seedMax(cJ, 31, 16);
let jSets = 0;
for (let i2 = 0; i2 < 40; i2++) {
  for (const a of cJ.update([{ rideId: 31, name: "Mild", queueTime: 0, rideTime: 60, intensity: 400 }]))
    if (a.kind === "set") { jSets++; cJ.noteSet(31, a.value); }
}
ok(jSets > 0, "still lengthens a mild ride, got " + jSets);

// An extreme ride with a LONG queue is still shortened - the guard is one-directional.
const cK = createOpsController(16); seedMax(cK, 32, 16);
let kSets = 0;
for (let i2 = 0; i2 < 40; i2++) {
  for (const a of cK.update([{ rideId: 32, name: "Extreme Busy", queueTime: HIGH_QUEUE_MINUTES + 5, rideTime: 60, intensity: 950 }]))
    if (a.kind === "set") { kSets++; cK.noteSet(32, a.value); }
}
ok(kSets > 0, "extreme ride with a queue is still shortened, got " + kSets);
// --- Per-ride MINIMUM discovery ----------------------------------------------
// Measured 2026-09-20: 2 sets were refused. Many ride types have a floor well above 1 —
// a swinging ship accepts 7-25 swings — and the old wiring reported a floor refusal as a
// probe failure, which HALVED the discovered maximum every time it happened.
const cM = createOpsController(32); seedMax(cM, 40, 25);
cM.noteSet(40, 10);
const maxBefore = cM.describe(40).max;
cM.noteSetRejected(40, 6);                       // refused while stepping DOWN from 10
ok(cM.describe(40).min === 7, "downward refusal raises the floor to 7, got " + cM.describe(40).min);
ok(cM.describe(40).max === maxBefore, "downward refusal does NOT touch the ceiling, got " + cM.describe(40).max);

// An upward refusal lowers the ceiling instead.
const cN = createOpsController(32); seedMax(cN, 41, 25);
cN.noteSet(41, 10);
const maxN = cN.describe(41).max;
cN.noteSetRejected(41, 20);                      // refused while stepping UP
ok(cN.describe(41).max === Math.min(maxN, 19), "upward refusal lowers the ceiling, got " + cN.describe(41).max);
ok(cN.describe(41).min === 1, "upward refusal leaves the floor alone, got " + cN.describe(41).min);

// Once the floor is known, the controller never proposes below it again.
const cO = createOpsController(32); seedMax(cO, 42, 25);
cO.noteSet(42, 8);
cO.noteSetRejected(42, 7);                       // floor is 8
let belowFloor = 0;
for (let i2 = 0; i2 < 60; i2++) {
  for (const a of cO.update([R(42, HIGH_QUEUE_MINUTES + 5)])) {
    if (a.kind === "set") {
      if (a.value < 8) belowFloor++;
      cO.noteSet(42, a.value);
    }
  }
}
ok(belowFloor === 0, "never proposes below the discovered floor, got " + belowFloor);

// Floor and ceiling must never cross.
const cP = createOpsController(32); seedMax(cP, 43, 5);
cP.noteSet(43, 3);
cP.noteSetRejected(43, 2);
cP.noteSetRejected(43, 9);
const st43 = cP.describe(43);
ok(st43.min <= st43.max, "floor never exceeds ceiling: " + st43.min + " <= " + st43.max);

// noteSetRejected on an unknown ride is a harmless no-op.
cP.noteSetRejected(9999, 5);
ok(cP.describe(9999) === null, "unknown ride stays unknown");

// --- probe ceiling: doubling must not settle for the last accepted value ----------
// Found by the 2026-09-20 scale audit. Doubling ran 32 -> 64 -> 128 -> 256; 256 exceeds
// PROBE_HARD_CEILING so the controller recorded `max = 128` and gave up. Real ride types
// break on that: Dodgems and Flying Saucers are {20, 180} (ride/rtd/gentle/Dodgems.h:38),
// Maze is {1, 64}, and several are {10, 40} or {30, 50}. The whole band above the last
// power of two was permanently unreachable.
//
// Probes are silent queryAction calls that change nothing, so an approximation was never
// necessary - bracket against the ceiling and binary search the gap instead.
const cDod = createOpsController(32);
ok(seedMax(cDod, 60, 180) === 180, "finds a max of 180 above the doubling ceiling, got " + cDod.describe(60).max);

const cMaze = createOpsController(32);
ok(seedMax(cMaze, 61, 64) === 64, "finds a Maze max of 64, got " + cMaze.describe(61).max);

const cMid = createOpsController(32);
ok(seedMax(cMid, 62, 50) === 50, "finds an awkward max of 50, got " + cMid.describe(62).max);

// A ride whose true max is below the starting ceiling is unaffected.
const cLow = createOpsController(32);
ok(seedMax(cLow, 63, 18) === 18, "a max below the start ceiling still works, got " + cLow.describe(63).max);

// Probing still terminates rather than climbing forever.
const cHuge = createOpsController(32);
const hugeMax = seedMax(cHuge, 64, 100000);
ok(hugeMax !== null && hugeMax <= 255, "a permissive ride is capped at the hard ceiling, got " + hugeMax);


// --- REGRESSION: a refusal at the assumed floor must NOT collapse the range ------
// Measured 2026-09-20: opsSetRejected rose 2 -> 30 against only 5 successful sets.
//
// Directional calibration sends a congested ride with no known baseline straight to
// `record.min`, which starts at the assumed 1. Many ride types have a far higher real
// floor (Dodgems {20,180}, Merry-Go-Round {4,25}), so that set is refused. With
// `current` still null, noteSetRejected used to read the refusal as "stepping up" and
// drop `max` to value-1 = 0, which the clamp then pinned to min. The range collapsed to
// [1,1] and the ride could never be tuned again.
const cFloorA = createOpsController(32); seedMax(cFloorA, 70, 25);
ok(cFloorA.describe(70).max === 25, "range discovered");
cFloorA.noteSetRejected(70, 1);                 // calibration to the assumed floor, refused
ok(cFloorA.describe(70).max === 25, "a floor refusal leaves the ceiling ALONE, got " + cFloorA.describe(70).max);
ok(cFloorA.describe(70).min === 2, "and raises the floor, got " + cFloorA.describe(70).min);

// It keeps converging on the true floor rather than overshooting it. Overshoot would
// permanently give up the fastest legal cycle - the throughput a congested ride needs.
const cFloorB = createOpsController(32); seedMax(cFloorB, 71, 180);
for (let v = 1; v < 20; v++) cFloorB.noteSetRejected(71, v);
ok(cFloorB.describe(71).min === 20, "converges on a real floor of 20, got " + cFloorB.describe(71).min);
ok(cFloorB.describe(71).max === 180, "without ever touching the ceiling, got " + cFloorB.describe(71).max);

// An upward refusal still lowers the ceiling - the other direction must keep working.
const cFloorC = createOpsController(32); seedMax(cFloorC, 72, 25);
cFloorC.noteSet(72, 10);
cFloorC.noteSetRejected(72, 20);
ok(cFloorC.describe(72).max === 19, "an upward refusal still lowers the ceiling, got " + cFloorC.describe(72).max);
ok(cFloorC.describe(72).min === 1, "and leaves the floor alone, got " + cFloorC.describe(72).min);

// The ride stays tunable after a floor refusal: min < max, and a set can still be made.
const cFloorD = createOpsController(32); seedMax(cFloorD, 73, 25);
cFloorD.noteSetRejected(73, 1);
const st73 = cFloorD.describe(73);
ok(st73.min < st73.max, "the ride remains tunable: " + st73.min + " < " + st73.max);

// --- #50: a known per-type range means no probing and no out-of-range values, ever.
// Every refused value (query or set) is an ERROR line in the game log.
{
  const RT = (id, q, rideType) => ({ ...R(id, q), rideType });
  const oracle = [7, 25]; // swinging ship, RIDE_TYPE 26
  const run = (ctrl) => {
    let refused = 0;
    for (let pass = 0; pass < 120; pass++) {
      const q = pass < 60 ? 0 : 20; // empty queue then congested: walks both ways
      for (const a of ctrl.update([RT(1, q, 26)])) {
        const okValue = a.value >= oracle[0] && a.value <= oracle[1];
        if (!okValue) refused++;
        if (a.kind === "probe") ctrl.noteProbe(1, a.value, okValue);
        else if (okValue) ctrl.noteSet(1, a.value); else ctrl.noteSetRejected(1, a.value);
      }
    }
    return refused;
  };
  const probed = run(createOpsController(32));
  const seeded = createOpsController(32, (t) => t === 26 ? [7, 25] : null);
  const refusedSeeded = run(seeded);
  ok(probed > 0, "#50 probing refuses values (the log noise), got " + probed);
  ok(refusedSeeded === 0, "#50 known range: zero refused values over 120 passes, got " + refusedSeeded);
  const d = seeded.describe(1);
  ok(d.min === 7 && d.max === 25, "#50 known range seeds min/max, got " + d.min + "-" + d.max);

  const first = createOpsController(32, () => [5, 18]).update([RT(2, 0, 0)]);
  ok(first.every(a => a.kind !== "probe"), "#50 known range emits no probe");
  const none = createOpsController(32, () => "untunable");
  let acts = 0; for (let i = 0; i < 30; i++) acts += none.update([RT(3, i % 2 ? 20 : 0, 60)]).length;
  ok(acts === 0, "#50 untunable type: no actions at all, got " + acts);
  const unknown = createOpsController(32, () => null).update([RT(4, 0, 200)]);
  ok(unknown.some(a => a.kind === "probe"), "#50 unknown type still probes");
}
{
  const { operationRange, isKnownRideType } = await import("./build/op-ranges.mjs");
  const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b);
  // Spot checks against gamesrc 6fb525e906 and the refusals seen in #50/#55 logs.
  ok(eq(operationRange(26), [7, 25]), "swinging ship 7-25");
  ok(eq(operationRange(33), [4, 25]), "merry-go-round 4-25 (#55 walked 13->25 and stopped)");
  ok(eq(operationRange(20), [1, 64]), "maze 1-64");
  ok(operationRange(29) === null && isKnownRideType(29), "dummy slot 29: known, untunable");
  ok(!isKnownRideType(500) && operationRange(500) === null, "out of table: unknown");
}

console.log(`\n${pass} passed, ${fail} failed`); if (fail) process.exitCode = 1;
