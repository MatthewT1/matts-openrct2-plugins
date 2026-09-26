import { entranceFeePenalty, createFeeWatch, FEE_WARNING_HOLD_DAYS } from "./build/marketing.mjs";
let pass=0, fail=0; const ok=(c,m)=>{ c?pass++:(fail++,console.log("FAIL:",m)); };

// Park.cpp:185-194 thresholds, raw tenths of a pound.
ok(entranceFeePenalty(0, 0) === 1, "free entry, no rides: no penalty");
ok(entranceFeePenalty(500, 500) === 1, "fee equal to value: no penalty (strict >)");
ok(entranceFeePenalty(501, 500) === 4, "fee just above value: /4");
ok(entranceFeePenalty(1001, 500) === 4, "floor(1001/2)=500 is not > 500: still /4");
ok(entranceFeePenalty(1002, 500) === 16, "floor(1002/2)=501 > 500: /16");
ok(entranceFeePenalty(100, 0) === 16, "any fee with no open rides: /16");

// Debounce: a 1-2 day dip (breakdown) never warns.
{
  const w = createFeeWatch(3);
  const seq = [1,4,4,1,4,4,1];
  ok(seq.map(p=>w.observe(p)).every(r=>r===null), "short dips do not warn");
  ok(w.held() === 1, "nothing held after dips");
}
// Warns once after the hold, again only on worsening, re-arms after recovery.
{
  const w = createFeeWatch(3);
  const r = [4,4,4,4,4,16,16,16,16,4,4,4,1,1,1,4,4,4].map(p=>w.observe(p));
  ok(r[2] === 4, "warns on day 3 of /4");
  ok(r.filter(x=>x===4).length === 2, "warns /4 once, then again only after re-arming");
  ok(r[7] === 16 && r.filter(x=>x===16).length === 1, "worsening to /16 warns once");
  ok(r[11] === null, "easing 16 -> 4 does not warn");
  ok(r[17] === 4, "after 3 clear days it re-arms");
  ok(w.held() === 4, "held reports current level");
}
ok(FEE_WARNING_HOLD_DAYS === 3, "hold is 3 days");

console.log(`\n${pass} passed, ${fail} failed`);
