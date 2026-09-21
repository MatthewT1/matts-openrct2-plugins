import { createStaffingController } from "./build/staffing.mjs";
let pass=0, fail=0; const ok=(c,m)=>{ c?pass++:(fail++,console.log("FAIL:",m)); };
// REGRESSION: replay the deadlock - oldLitter 1-7, fleetUnderworked, litter stable.
// Old gate (===0) never fired across 62 days. New gate must release.
const c=createStaffingController(40); let d;
for(let i=0;i<40;i++) d=c.update({oldLitter:3,totalLitter:10,parkRating:999,fleetUnderworked:true,formulaTarget:58,floor:12});
ok(d.target<40, "releases despite small non-zero oldLitter (was deadlocked at 40), got "+d.target);
// but NOT while litter is climbing
const c2=createStaffingController(40); let d2;
for(let i=0;i<40;i++) d2=c2.update({oldLitter:3,totalLitter:10+i,parkRating:999,fleetUnderworked:true,formulaTarget:58,floor:12});
ok(d2.target===40, "does not release while litter climbs, got "+d2.target);
// and still not when oldLitter is genuinely high
const c3=createStaffingController(40); let d3;
for(let i=0;i<40;i++) d3=c3.update({oldLitter:15,totalLitter:10,parkRating:999,fleetUnderworked:true,formulaTarget:58,floor:12});
ok(d3.target===40, "high oldLitter still blocks release, got "+d3.target);
console.log(`${pass} passed, ${fail} failed`); if (fail) process.exitCode = 1;
