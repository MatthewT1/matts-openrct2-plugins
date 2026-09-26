import { repairQuota, pickRepairs } from "./build/repairs.mjs";
let pass=0, fail=0; const ok=(c,m)=>{ c?pass++:(fail++,console.log("FAIL:",m)); };

ok(repairQuota(0, true) === 0, "nothing broken, nothing to do");
ok(repairQuota(1, false) === 1 && repairQuota(3, false) === 1, "at least 1");
ok(repairQuota(40, true) === 11, "first day ~28%");
ok(repairQuota(40, false) === 8, "later days 20%");

// 40 broken: day 1 fixes 11, then 20% of what's left each day; all fixed within ~3 weeks.
let left = 40, days = 0;
for (let first = true; left > 0; first = false) { left -= repairQuota(left, first); days++; }
ok(days > 5 && days < 25, "gradual, but finishes: " + days + " days");

const t = (x, y) => ({ x, y, z: 0, addition: 1 });
const tiles = [t(50, 50), t(11, 10), t(30, 30)];
ok(pickRepairs(tiles, { x: 10, y: 10 }, 2).map(a => a.x).join() === "11,30", "nearest the entrance first");
ok(pickRepairs(tiles, null, 5).length === 3, "no entrance: scan order, capped by what's there");
ok(tiles[0].x === 50, "input not reordered");

console.log(`${pass} passed, ${fail} failed`);
