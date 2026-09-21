import { createNeedAccumulator, createSampleRotation, findGaps, describeGap,
         HUNGER_THRESHOLD, THIRST_THRESHOLD, TOILET_THRESHOLD, VERY_SICK_THRESHOLD, SICK_THRESHOLD } from "./build/needs.mjs";
let pass=0, fail=0; const ok=(c,m)=>{ c?pass++:(fail++,console.log("FAIL:",m)); };
const T=32; // world units per tile

ok(HUNGER_THRESHOLD===10 && THIRST_THRESHOLD===25 && TOILET_THRESHOLD===160
   && SICK_THRESHOLD===140 && VERY_SICK_THRESHOLD===200, "source thresholds");

const a=createNeedAccumulator(8);
ok(a.top("hunger",3).length===0, "empty");
ok(a.counts().sampled===0, "empty counts");

// a content guest must register as sampled but need nothing
a.add(10*T,10*T, 200, 200, 10, 10);
let c=a.counts();
ok(c.sampled===1 && c.hunger===0 && c.thirst===0 && c.toilet===0 && c.verySick===0, "content guest needs nothing");

// INVERTED thresholds: low hunger = hungry
a.add(20*T,20*T, 5, 200, 10, 10);
ok(a.counts().hunger===1, "hunger<=10 counts, got "+a.counts().hunger);
a.add(20*T,20*T, 11, 200, 10, 10);
ok(a.counts().hunger===1, "hunger=11 does NOT count (boundary)");
a.add(21*T,21*T, 200, 25, 10, 10);
ok(a.counts().thirst===1, "thirst<=25 counts");
a.add(21*T,21*T, 200, 26, 10, 10);
ok(a.counts().thirst===1, "thirst=26 does NOT count (boundary)");

// toilet + urgent
a.add(30*T,30*T, 200,200, 160, 10);
a.add(30*T,30*T, 200,200, 195, 10);
c=a.counts();
ok(c.toilet===2 && c.toiletUrgent===1, `toilet=${c.toilet} urgent=${c.toiletUrgent}`);

// sick vs verySick: only verySick clusters
a.add(40*T,40*T, 200,200,10, 140);
a.add(40*T,40*T, 200,200,10, 200);
c=a.counts();
ok(c.sick===2 && c.verySick===1, `sick=${c.sick} verySick=${c.verySick}`);
ok(a.top("firstAid",5).reduce((n,x)=>n+x.count,0)===1, "only verySick creates firstAid clusters");

// one guest can hit several needs
const b=createNeedAccumulator(8);
b.add(5*T,5*T, 1, 1, 250, 250);
const bc=b.counts();
ok(bc.hunger===1&&bc.thirst===1&&bc.toilet===1&&bc.verySick===1, "one guest, many needs");

// clustering + ranking
const d=createNeedAccumulator(8);
for(let i=0;i<7;i++) d.add(64*T,64*T,1,200,10,10);
for(let i=0;i<3;i++) d.add(8*T,8*T,1,200,10,10);
const tops=d.top("hunger",5);
ok(tops.length===2 && tops[0].count===7, "ranked desc, got "+JSON.stringify(tops.map(t=>t.count)));
ok(tops[0].kind==="hunger", "kind tagged");

// findGaps: no facility at all sorts FIRST
const gaps=findGaps(tops,[{kind:"hunger",name:"Burger",x:70,y:70}]);
ok(gaps.length===2, "one gap per cluster");
const none=findGaps(tops,[]);
ok(none[0].nearest===null && none[0].distance===-1, "no facility -> null/-1");
const mixed=findGaps(tops,[{kind:"hunger",name:"Burger",x:1000,y:1000}]);
ok(mixed[0].distance>0, "distance computed");
// -1 outranks any finite distance
const both=findGaps(
  [{kind:"hunger",x:5,y:5,count:2},{kind:"toilet",x:9,y:9,count:9}],
  [{kind:"hunger",name:"B",x:99,y:99}]);
ok(both[0].cluster.kind==="toilet" && both[0].distance===-1, "missing facility sorts first, got "+both[0].cluster.kind);

// wrong-kind facility does not satisfy
const wrong=findGaps([{kind:"toilet",x:1,y:1,count:5}],[{kind:"hunger",name:"B",x:1,y:1}]);
ok(wrong[0].nearest===null, "wrong kind does not match");

// reset
d.reset();
ok(d.top("hunger",3).length===0 && d.counts().sampled===0, "reset clears");

const s1=describeGap(gaps[0]), s2=describeGap(none[0]);
ok(!s1.endsWith("\n") && s1.length>20, "describeGap non-trivial, no trailing newline");
ok(/no .*(toilet|food|drink|first aid)/i.test(s2)||/build|no /i.test(s2), "missing-facility wording");
console.log("\nSAMPLES:\n  "+s1+"\n  "+s2);

// --- rotating sample window -----------------------------------------------------
// REGRESSION (2026-09-20): the rotation decided "sweep finished?" at the start of the
// NEXT pass via `offset >= total`. The offset only ever advances to min(offset+window,
// total), so it can equal total but never exceed it - and on a GROWING park the next
// pass sees a larger total, so the sweep never completes. Measured over 78 in-game days
// on a park growing 99 -> 214 guests: the accumulator published exactly ZERO times, so
// every need read as 0 and the facility builder had nothing to act on. No error fired
// anywhere; every individual step did exactly what it said.
const rot=createSampleRotation(100);

// A roster smaller than the window completes in one pass.
let w=rot.next(60);
ok(w.start===0 && w.end===60 && w.sweepComplete===true, "small roster sweeps in one pass");
ok(rot.offset()===0, "and resets to the start");

// A roster larger than the window takes several, completing on the last.
const r2=createSampleRotation(100);
const wa=r2.next(250), wb=r2.next(250), wc=r2.next(250);
ok(wa.start===0   && wa.end===100 && !wa.sweepComplete, "pass 1");
ok(wb.start===100 && wb.end===200 && !wb.sweepComplete, "pass 2");
ok(wc.start===200 && wc.end===250 &&  wc.sweepComplete, "pass 3 completes");
ok(r2.next(250).start===0, "then wraps");

// THE BUG: a roster that grows every pass must still complete sweeps.
const r3=createSampleRotation(400);
let rtotal=200, sweeps=0;
for(let i=0;i<40;i++){ if(r3.next(rtotal).sweepComplete) sweeps++; rtotal+=6; }
ok(sweeps>=30, "a continuously growing roster still completes sweeps, got "+sweeps);

// Exactly-on-the-boundary is the case that used to fail on the FOLLOWING pass.
const r4=createSampleRotation(200);
ok(r4.next(200).sweepComplete===true, "window exactly equal to the roster completes");
const r5=createSampleRotation(200);
r5.next(200);
ok(r5.next(206).start===0, "next pass starts from the beginning, not the stale end");

// A SHRINKING roster must not strand the offset past the end.
const r6=createSampleRotation(50);
r6.next(500); r6.next(500);           // offset now 100
const shrunk=r6.next(60);
ok(shrunk.start<60 && shrunk.end<=60, "a shrinking roster re-bases, got "+JSON.stringify(shrunk));

// Degenerate inputs
const r7=createSampleRotation(10);
const emptyWin=r7.next(0);
ok(emptyWin.start===0 && emptyWin.end===0 && !emptyWin.sweepComplete, "empty roster is not a sweep");
ok(createSampleRotation(0).next(5).end===1, "window size is clamped to at least 1");

// Every entry is visited exactly once per sweep, with no gaps and no repeats.
const r8=createSampleRotation(30);
const seenIdx=[]; let guard=0;
while(guard++<10){ const win=r8.next(100); for(let i=win.start;i<win.end;i++) seenIdx.push(i); if(win.sweepComplete) break; }
ok(seenIdx.length===100 && seenIdx[0]===0 && seenIdx[99]===99, "a sweep covers every index once, got "+seenIdx.length);


// --- the clamp that creates phantom clusters, and why callers must filter ---------
// REGRESSION (2026-09-20): a guest riding a ride reports kLocationNull = -32768
// (world/Location.hpp:18). add() clamps negatives to 0 to protect its key packing, so
// every such guest landed in cell (0,0) and surfaced as a cluster at tile (4,4). That
// corner is unowned map edge and enormously far from any facility - 78, 111, 133 and
// 153 tiles across four parks - so it always ranked as the WORST gap, always won the
// planner's choice, and could never be built on. It monopolised the budget and no
// facility was ever built from a confirmed gap.
//
// The clamp is correct and must stay. These tests pin the behaviour so nobody "fixes"
// it in the wrong place: the CALLER filters.
const offmap = createNeedAccumulator(8);
offmap.add(-32768, -32768, 5, 200, 10, 10);     // a guest inside a ride, starving
const phantom = offmap.top("hunger", 1);
ok(phantom.length === 1, "an off-map guest still produces a cluster - the clamp is real");
ok(phantom[0].x === 4 && phantom[0].y === 4,
   "and it lands at (4,4), the corner cell centre, got ("+phantom[0].x+", "+phantom[0].y+")");

// The caller's guard is `x < 0 || y < 0`. With it applied, no phantom appears.
const guarded = createNeedAccumulator(8);
const feed = (x, y) => { if (x < 0 || y < 0) return; guarded.add(x, y, 5, 200, 10, 10); };
feed(-32768, -32768);
feed(60 * T, 92 * T);
const real = guarded.top("hunger", 4);
ok(real.length === 1, "the guard drops the phantom, got " + real.length + " clusters");
ok(real[0].x !== 4 || real[0].y !== 4, "and the surviving cluster is the real one at ("+real[0].x+", "+real[0].y+")");

// A single negative axis is enough to corrupt the cell, so both must be checked.
const oneAxis = createNeedAccumulator(8);
oneAxis.add(-32768, 92 * T, 5, 200, 10, 10);
ok(oneAxis.top("hunger", 1)[0].x === 4, "one negative axis alone still corrupts the cell");

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) process.exitCode = 1;
