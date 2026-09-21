// Validates the MECHANIC signal mapping onto the shared staffing controller.
//
//   oldLitter   -> rides broken for >= 2 CONSECUTIVE DAYS (unattended)
//   totalLitter -> rides broken right now (fast, noisy leading indicator)
//
// WHY THIS FILE WAS REWRITTEN (2026-09-20):
//   The original mapping fed `ridesBroken` into a controller whose thresholds are
//   calibrated in PIECES OF LITTER — urgent at 25, release blocked above 8. A park has
//   nowhere near 25 rides broken at once, so the urgent-hire path was arithmetically
//   unreachable and the release gate was always satisfied. The controller became a
//   one-way ratchet: measured over 163 in-game days it went 5 -> 4 -> 3 against a
//   formula target of 6, while a ride sat broken for 11 consecutive days and minimum
//   reliability decayed 59% -> 36%.
//
//   The old test asserted "one broken ride does not trigger hiring", which looked
//   reasonable and was encoding the bug. It is inverted below: one ride left broken for
//   two days is exactly the emergency this controller exists to answer.
import { createStaffingController, MECHANIC_THRESHOLDS, DEFAULT_THRESHOLDS,
         URGENT_OLD_LITTER, RELEASE_OLD_LITTER_MAX } from "./build/staffing.mjs";
let pass=0, fail=0; const ok=(c,m)=>{ c?pass++:(fail++,console.log("FAIL:",m)); };
// mechanic-shaped signals; floor 2, formula 7 (17 rides / 4 + 2)
const M=(o={})=>({oldLitter:0,totalLitter:0,parkRating:999,fleetUnderworked:true,formulaTarget:7,floor:2,...o});
const mech=(t)=>createStaffingController(t, MECHANIC_THRESHOLDS);

// --- the thresholds are in the right units --------------------------------------
ok(MECHANIC_THRESHOLDS.urgentAt===1, "one unattended ride is urgent");
ok(MECHANIC_THRESHOLDS.releaseMaxUrgent===0, "no release while anything is unattended");
ok(DEFAULT_THRESHOLDS.urgentAt===URGENT_OLD_LITTER
   && DEFAULT_THRESHOLDS.releaseMaxUrgent===RELEASE_OLD_LITTER_MAX,
   "litter defaults are unchanged, so handyman behaviour is untouched");
// The regression that started all this: a ride-count signal can never reach 25.
ok(MECHANIC_THRESHOLDS.urgentAt < 13, "urgent threshold is reachable on a 13-ride park");

// --- it still releases when genuinely idle ---------------------------------------
const c=mech(7); let d;
for(let i=0;i<400;i++) d=c.update(M());
ok(d.target===2,"releases to the mechanic floor when nothing ever breaks, got "+d.target);
ok(d.target>=2,"never below the 2-mechanic floor");

// --- THE BUG: an unattended ride must force a hire -------------------------------
const c2=mech(3); let d2;
for(let i=0;i<10;i++) d2=c2.update(M({oldLitter:1, totalLitter:1, fleetUnderworked:false}));
ok(d2.target>3,"ONE ride broken 2+ days hires (was impossible before), got "+d2.target);
ok(d2.target<=7,"but never past the formula ceiling, got "+d2.target);

// A ride broken RIGHT NOW but not yet unattended is not an emergency — mechanics are
// presumably on their way, and panicking on day one would re-create the overshoot the
// handyman controller was rewritten to avoid.
const c3=mech(4); let d3;
for(let i=0;i<10;i++) d3=c3.update(M({oldLitter:0, totalLitter:1, fleetUnderworked:false}));
ok(d3.target===4,"a same-day breakdown does not trigger hiring, got "+d3.target);

// --- the one-way ratchet is closed -----------------------------------------------
// An idle fleet WITH an unattended ride is not slack. It is a reachability problem, and
// firing into it makes it worse. This is the exact state the measured park was in:
// mechanicFleetUnderworked fired on 60 of 167 days while a ride sat broken.
const c4=mech(5); let d4;
for(let i=0;i<200;i++) d4=c4.update(M({oldLitter:1, totalLitter:1, fleetUnderworked:true}));
ok(d4.target>=5,"never releases while a ride is unattended, even with an idle fleet, got "+d4.target);

// ...and once the ride is finally fixed, releasing resumes.
const c5=mech(5); let d5;
for(let i=0;i<40;i++) c5.update(M({oldLitter:1, totalLitter:1, fleetUnderworked:true}));
const held=c5.target();
for(let i=0;i<400;i++) d5=c5.update(M());
ok(d5.target<held,"resumes releasing once nothing is unattended, "+held+" -> "+d5.target);

// --- a hire is remembered as a floor, then relaxes slowly -------------------------
// The level that allowed a ride to sit broken is a STRONG PRIOR, not a life sentence.
// Making it permanent produces a one-way ratchet UP: a ride broken because no mechanic
// can reach it raises the floor on every urgent hire until the floor hits the formula
// ceiling, and every saving the controller found is gone for the rest of the game.
const c6=mech(3);
for(let i=0;i<10;i++) c6.update(M({oldLitter:1, totalLitter:1, fleetUnderworked:false}));
const raised=c6.target();
ok(raised>3, "hired in response to the unattended ride, got "+raised);

// Held through a quiet stretch shorter than the decay window.
let d6; for(let i=0;i<MECHANIC_THRESHOLDS.floorDecayDays-1;i++) d6=c6.update(M());
ok(d6.discoveredFloor>=raised, "the floor holds through a short quiet spell, got "+d6.discoveredFloor);

// ...and relaxes once the park has been genuinely quiet for a long time.
let d6b; for(let i=0;i<400;i++) d6b=c6.update(M());
ok(d6b.discoveredFloor<raised, "the floor relaxes after a long quiet stretch, got "+d6b.discoveredFloor);
ok(d6b.target<raised, "so it can probe lower again, got "+d6b.target+" vs "+raised);

// Decay must never run while something is still unattended.
const c6c=mech(3);
for(let i=0;i<10;i++) c6c.update(M({oldLitter:1, totalLitter:1, fleetUnderworked:false}));
let d6c; for(let i=0;i<400;i++) d6c=c6c.update(M({oldLitter:1, totalLitter:1, fleetUnderworked:true}));
ok(d6c.discoveredFloor>=raised, "an unattended ride freezes the decay, got "+d6c.discoveredFloor);

// Handymen are deliberately excluded from decay: the failure is measured only for
// mechanics, and this controller is demonstrably working.
ok(DEFAULT_THRESHOLDS.floorDecayDays===0, "litter defaults have decay disabled");

// --- urgent hires are PACED -------------------------------------------------------
// Measured 2026-09-20: a single unattended ride made the controller hire four times in
// four days, 2 -> 6, straight to the formula ceiling. The ride stayed broken for 8 days
// regardless, so the extra hires bought nothing, tripled the wage bill, and (because
// every urgent hire raises discoveredFloor) left the controller pinned at the ceiling.
ok(MECHANIC_THRESHOLDS.urgentHirePaceDays > 0, "mechanics pace their urgent hires");
ok(DEFAULT_THRESHOLDS.urgentHirePaceDays === 0, "handymen do not, preserving their behaviour");

const cp=mech(2);
const emergency=M({oldLitter:1, totalLitter:1, fleetUnderworked:false});
const seen=[];
for(let i=0;i<12;i++) seen.push(cp.update(emergency).target);
// One hire, then a wait, rather than one per day.
const hires=seen.filter((v,i)=> i>0 && v>seen[i-1]).length;
ok(hires < 12, "does not hire every single day, got "+hires+" in 12: "+seen.join(","));
ok(hires >= 2, "but does keep hiring while the problem persists, got "+hires);
ok(seen[0]===3, "first observation still hires immediately, got "+seen[0]);
ok(seen[1]===3 && seen[2]===3, "then waits before the next, got "+seen.slice(0,4).join(","));

// Pacing must NOT unblock releasing - the emergency is still an emergency while we wait.
const cq=mech(5); let dq;
for(let i=0;i<200;i++) dq=cq.update(M({oldLitter:1, totalLitter:1, fleetUnderworked:true}));
ok(dq.target>=5, "releasing stays blocked during the paced wait, got "+dq.target);

// A fresh emergency after a quiet spell acts immediately rather than inheriting the wait.
const cr=mech(3);
cr.update(M({oldLitter:1, totalLitter:1, fleetUnderworked:false}));
const after=cr.target();
for(let i=0;i<3;i++) cr.update(M());                    // quiet
const resumed=cr.update(M({oldLitter:1, totalLitter:1, fleetUnderworked:false})).target;
ok(resumed>after, "a new emergency hires immediately, "+after+" -> "+resumed);

// --- park rating still overrides everything ---------------------------------------
const c7=mech(3); let d7;
for(let i=0;i<10;i++) d7=c7.update(M({oldLitter:1, parkRating:800, fleetUnderworked:true}));
ok(d7.target>3,"a falling park rating hires, got "+d7.target);

// --- the formula ceiling and floor still bound it ---------------------------------
const c8=mech(2); let d8;
for(let i=0;i<500;i++) d8=c8.update(M({oldLitter:5, totalLitter:5, fleetUnderworked:false}));
ok(d8.target===7,"clamps at the formula ceiling however bad it gets, got "+d8.target);

const c9=mech(9); let d9;
for(let i=0;i<5;i++) d9=c9.update(M({formulaTarget:4}));
ok(d9.target<=4,"a shrinking formula target pulls it down, got "+d9.target);

// --- settle windows are shorter than the litter ones ------------------------------
// Mechanic signals have no equivalent of the 14.5-day old-litter lag.
ok(MECHANIC_THRESHOLDS.settleDays < DEFAULT_THRESHOLDS.settleDays,
   "mechanic release settle is shorter than litter's");
ok(MECHANIC_THRESHOLDS.urgentSettleDays < DEFAULT_THRESHOLDS.urgentSettleDays,
   "mechanic hire settle is shorter than litter's");

console.log(`${pass} passed, ${fail} failed`);
