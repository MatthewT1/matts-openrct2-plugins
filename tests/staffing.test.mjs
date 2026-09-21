import { createStaffingController, SETTLE_DAYS, RELEASE_DAYS } from "./build/staffing.mjs";
import { createActivityTracker } from "./build/staff-activity.mjs";
let pass=0, fail=0;
const ok=(c,m)=>{ c?pass++:(fail++,console.log("FAIL:",m)); };
const S=(o={})=>({oldLitter:0,totalLitter:2,parkRating:999,fleetUnderworked:true,formulaTarget:48,floor:12,...o});

// --- REGRESSION: replay the real overshoot. oldLitter 1-4, rating pinned at 999.
// Old controller hired 34 -> 40. New one must NOT react at all.
const c = createStaffingController(34);
let d;
for (let i=0;i<40;i++) d = c.update(S({oldLitter: 1 + (i%4), totalLitter: 15, fleetUnderworked:false, parkRating:999}));
ok(d.target===34, "no hiring for trivial oldLitter at full rating (was 34->40), got "+d.target);

// --- urgent: old litter that actually costs rating DOES hire
const c2 = createStaffingController(20);
const d2 = c2.update(S({oldLitter:40, totalLitter:60, fleetUnderworked:false}));
ok(d2.target===21, "large oldLitter hires, got "+d2.target);
ok(d2.discoveredFloor===21, "failed level remembered as floor, got "+d2.discoveredFloor);

// --- urgent: falling park rating hires even with small oldLitter
const c3 = createStaffingController(20);
const d3 = c3.update(S({oldLitter:3, parkRating:850, fleetUnderworked:false}));
ok(d3.target===21, "falling rating hires, got "+d3.target);

// --- release happens when clean+underworked, then SETTLES
const c4 = createStaffingController(36);
let d4; for(let i=0;i<RELEASE_DAYS;i++) d4=c4.update(S());
ok(d4.target===35, "releases after RELEASE_DAYS, got "+d4.target);
ok(d4.settling===SETTLE_DAYS, "enters settle window, got "+d4.settling);
// during settle it must not release again no matter how clean
for(let i=0;i<SETTLE_DAYS-1;i++) d4=c4.update(S());
ok(d4.target===35, "no further release while settling, got "+d4.target);

// --- regression detection: litter doubles after a release -> hire back + floor
const c5 = createStaffingController(30);
let d5; for(let i=0;i<RELEASE_DAYS;i++) d5=c5.update(S({totalLitter:5}));
ok(d5.target===29, "released, got "+d5.target);
for(let i=0;i<SETTLE_DAYS;i++) d5=c5.update(S({totalLitter:30, fleetUnderworked:false}));
d5=c5.update(S({totalLitter:30, fleetUnderworked:false}));
ok(d5.target===30, "hires back after litter regression, got "+d5.target);
ok(d5.discoveredFloor===30, "learned floor 30, got "+d5.discoveredFloor);
// and must never probe below that learned floor again
for(let i=0;i<200;i++) d5=c5.update(S({totalLitter:1}));
ok(d5.target===30, "never re-probes below discovered floor, got "+d5.target);

// --- successful release: litter stays low -> keeps descending to floor
const c6 = createStaffingController(36);
let d6; for(let i=0;i<900;i++) d6=c6.update(S({totalLitter:3}));
ok(d6.target===12, "descends to floor when genuinely clean, got "+d6.target);

// --- ceiling still respected
const c7 = createStaffingController(60);
const d7 = c7.update(S({oldLitter:99, formulaTarget:48, fleetUnderworked:false}));
ok(d7.target===48, "formula remains a ceiling, got "+d7.target);

// --- ACTIVITY regression: 26% of fleet with zero work must NOT be flagged
const t = createActivityTracker(6);
for (let day=0; day<40; day++){
  for (let i=0;i<39;i++) t.observe(i, i<29 ? day : 0);   // 10 of 39 (26%) never work
  var snap = t.endSweep(true);
}
ok(snap.stuck.length===0, "26% zero-work is a distribution tail, not stuck (was 10), got "+snap.stuck.length);
// but a true rare outlier still surfaces
const t2 = createActivityTracker(6);
for (let day=0; day<40; day++){
  for (let i=0;i<39;i++) t2.observe(i, i===5 ? 0 : day);  // 1 of 39 = 2.5%
  var s2 = t2.endSweep(true);
}
ok(s2.stuck.length===1 && s2.stuck[0]===5, "lone outlier still caught, got "+JSON.stringify(s2.stuck));

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) process.exitCode = 1;

// --- convergence time, reported for the record ---
const cc = createStaffingController(36); let ccDay = 0;
while (cc.target() > 12 && ccDay < 3000) { cc.update(S({totalLitter:3})); ccDay++; }
console.log('convergence 36 -> 12 : ' + ccDay + ' in-game days ('
  + (RELEASE_DAYS + SETTLE_DAYS) + ' per step)');
