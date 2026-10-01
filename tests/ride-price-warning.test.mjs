import { rideValueWarnings, createRidePriceWatch } from "./build/marketing.mjs";
let pass=0, fail=0; const ok=(c,m)=>{ c?pass++:(fail++,console.log("FAIL:",m)); };

// Guest.cpp:2112-2132, raw tenths of a pound.
const R = (id, price, value, open = true) => ({ id, name: "Ride " + id, price, value, open });
{
  let w = rideValueWarnings([R(1, 40, 20)], false);
  ok(w.length === 0, "price exactly 2x value: paid (strict >)");
  w = rideValueWarnings([R(1, 41, 20)], false);
  ok(w.length === 1 && w[0].limit === 40 && w[0].times === 2.1, "just over 2x: refused, limit 2x value");
  w = rideValueWarnings([R(1, 20, 20)], true);
  ok(w.length === 1 && w[0].limit === 10 && w[0].times === 4, "paid entry: value quartered, so 1x value is refused");
  w = rideValueWarnings([R(1, 10, 20)], true);
  ok(w.length === 0, "paid entry: half the value is still paid");
  w = rideValueWarnings([R(1, 9, 19)], true);
  ok(w.length === 1 && w[0].limit === 8, "paid entry: integer division, floor(19/4)=4 -> limit 8");
  w = rideValueWarnings([R(1, 0, 0), R(2, 500, undefined), R(3, 500, 10, false)], false);
  ok(w.length === 0, "free ride, unrated ride and closed ride never warn");
  w = rideValueWarnings([R(1, 50, 20), R(2, 100, 20), R(3, 10, 0)], false);
  ok(w.map((x) => x.id).join() === "3,2,1", "worst first; a zero-value ride with a price tops the list");
}

{
  const w = createRidePriceWatch(3);
  ok(w.observe([7]).length === 0 && w.observe([7]).length === 0, "days 1-2: held back");
  ok(!w.held(7), "not held yet");
  ok(w.observe([7]).join() === "7" && w.held(7), "day 3: announced once");
  ok(w.observe([7]).length === 0, "day 4: not repeated");
  ok(w.observe([7, 8]).length === 0, "a second ride starts its own hold");
  ok(w.observe([]).length === 0 && !w.held(7), "fixed: cleared");
  w.observe([7]); w.observe([7]);
  ok(w.observe([7]).join() === "7", "over again after a fix: announced again after the hold");
}
{
  const w = createRidePriceWatch(3);
  w.observe([1]); w.observe([1]); w.observe([]);
  ok(w.observe([1]).length === 0, "a one-day dip back under resets the streak");
}

console.log(`${pass} passed, ${fail} failed`); if (fail) process.exitCode = 1;
