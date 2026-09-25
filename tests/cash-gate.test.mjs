import { spendGate } from "./build/cash-gate.mjs";
let pass=0, fail=0; const ok=(c,m)=>{ c?pass++:(fail++,console.log("FAIL:",m)); };
const FLOOR = 10_000; // GBP 1,000 in raw tenths

// Money park: unchanged behaviour.
ok(spendGate(20_000, FLOOR, false, "build") === "spend", "rich money park spends");
ok(spendGate(FLOOR, FLOOR, false, "build") === "spend", "exactly at floor spends");
ok(spendGate(9_999, FLOOR, false, "build") === "lowCash", "below floor in a money park is low cash");

// #44: a no-money park never charges for building (Finance.cpp:62), so the floor means nothing.
ok(spendGate(0, FLOOR, true, "build") === "noMoneyPark", "no-money park with 0 cash still builds");
ok(spendGate(-50_000, FLOOR, true, "build") === "noMoneyPark", "negative cash in a no-money park still builds");
ok(spendGate(1e9, FLOOR, true, "build") === "noMoneyPark", "rich no-money park reports the park type");
const builds = (g) => g === "spend" || g === "noMoneyPark";
ok(builds(spendGate(0, FLOOR, true, "build")) && !builds(spendGate(0, FLOOR, false, "build")), "build gate: only no-money bypasses");

// Marketing: the game hides the Finances window in no-money parks (TopToolbar.cpp:1103), so a player
// cannot run campaigns there; the plugin must not either, however much cash the park shows.
ok(spendGate(1e9, FLOOR, true, "marketing") === "unavailable", "no-money park: marketing unavailable");
ok(spendGate(20_000, FLOOR, false, "marketing") === "spend", "money park marketing unchanged");
ok(spendGate(0, FLOOR, false, "marketing") === "lowCash", "money park marketing low cash unchanged");

console.log(`cash-gate: ${pass} passed, ${fail} failed`);
if (fail) process.exitCode = 1;
