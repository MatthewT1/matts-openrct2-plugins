import { monthAllowance, createExtrasBudget, DEFAULT_EXTRAS_BUDGET } from "./build/extras-budget.mjs";
let pass=0, fail=0; const ok=(c,m)=>{ c?pass++:(fail++,console.log("FAIL:",m)); };
const O = DEFAULT_EXTRAS_BUDGET; // £1,000 floor, 5%

ok(monthAllowance(500 * 10, O) === 0, "below the floor: nothing");
ok(monthAllowance(1_000 * 10, O) === 0, "at the floor: nothing");
ok(monthAllowance(11_000 * 10, O) === 500 * 10, "5% of £10,000 above the floor = £500");

const b = createExtrasBudget(O);
b.update(1, 11_000 * 10, false);
ok(b.affordable(150) === 33, "£500 buys 33 TVs at £15");
b.spend(150 * 30);
ok(b.affordable(150) === 3, "spent 30, 3 left");
b.update(1, 50_000 * 10, false);
ok(b.affordable(150) === 3, "same month: allowance fixed at month start");
b.update(2, 3_000 * 10, false);
ok(b.spent() === 0 && b.allowance() === 100 * 10, "new month resets from current cash");
b.update(3, -5_000 * 10, false);
ok(b.affordable(150) === 0, "in debt: nothing");
b.update(3, -5_000 * 10, true);
ok(b.open() && b.affordable(150) > 1000, "no-money park: open");

console.log(`${pass} passed, ${fail} failed`);
