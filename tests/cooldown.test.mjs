import { createCooldown, TICKS_PER_DAY, MS_PER_DAY_AT_SPEED } from "./build/cooldown.mjs";
let pass=0, fail=0; const ok=(c,m)=>{ c?pass++:(fail++,console.log("FAIL:",m)); };

// Calls once per in-game day for `days` days at `speed`, like a day handler. Returns fire days.
function fires(cd, days, speed, t0=260968, ms0=1_000_000){
  const out=[];
  for(let d=0; d<days; d++){
    if(cd.ready(t0 + d*TICKS_PER_DAY, ms0 + d*MS_PER_DAY_AT_SPEED[speed])) out.push(d);
  }
  return out;
}

ok(TICKS_PER_DAY>500 && TICKS_PER_DAY<560, "a day is ~530 ticks");
ok(MS_PER_DAY_AT_SPEED[4] < MS_PER_DAY_AT_SPEED[1] / 7, "speed 4 is ~8x speed 1");

// First call always fires (0 forced a scan on the very first day before, too).
ok(createCooldown(2*TICKS_PER_DAY, 3000).ready(123, 0) === true, "first call fires");

// #48 core: the same days fire at every speed.
for (const [ticks, floor] of [[2*TICKS_PER_DAY, 3000], [TICKS_PER_DAY/2, 1000], [4*TICKS_PER_DAY, 5000]]) {
  const f1=fires(createCooldown(ticks, floor), 14, 1).join(","), f4=fires(createCooldown(ticks, floor), 14, 4).join(",");
  ok(f1===f4, `same fire days at speed 1 and 4 (${ticks} ticks, ${floor} ms): ${f1} vs ${f4}`);
}
ok(fires(createCooldown(2*TICKS_PER_DAY, 3000), 14, 1).length===7, "2-day cooldown fires on 7 of 14 days");
ok(fires(createCooldown(TICKS_PER_DAY/2, 1000), 14, 4).length===14, "half-day cooldown fires daily at speed 4");

// The old real-time cooldowns did not have this property (documents the bug being fixed).
function realOnly(ms, days, speed){ let last=-Infinity, n=0; for(let d=0; d<days; d++){ const t=d*MS_PER_DAY_AT_SPEED[speed]; if(t-last>=ms){last=t;n++;} } return n; }
ok(realOnly(30_000, 14, 1) === 5 && realOnly(30_000, 14, 4) === 1, "old 30 s tile scan: 5 scans at speed 1, 1 at speed 4");

// The real-time floor still bounds cost if game time runs faster than speed 4 (turbo/cheats).
{
  const cd=createCooldown(2*TICKS_PER_DAY, 3000); let n=0;
  for(let d=0; d<100; d++) if(cd.ready(d*TICKS_PER_DAY, d*100)) n++; // a day every 100 ms
  ok(n===4, `floor caps at one per 3 s over 10 s: ${n}`);
}
// Not ready does not reset the clock; reset() forces the next call.
{
  const cd=createCooldown(1000, 0);
  ok(cd.ready(0,0) && !cd.ready(500,0) && !cd.ready(999,0) && cd.ready(1000,0), "fires exactly at the cooldown");
  cd.reset(); ok(cd.ready(1001,0), "reset forces next call");
}
// ticksElapsed restarts at 0 on a park load: a clock that went backwards fires rather than stalls.
{
  const cd=createCooldown(1000, 0); cd.ready(50_000, 0);
  ok(cd.ready(10, 1) === true, "tick counter going backwards fires");
}
// Pause: ticks don't advance, so nothing fires however much real time passes.
{
  const cd=createCooldown(1000, 100); cd.ready(0,0);
  ok(!cd.ready(0, 600_000), "paused game (no ticks) does not fire");
}

// Watchdog use (facility build): reset + ready arms it; it then fires 5 days later at any speed.
for (const speed of [1, 4]) {
  const cd=createCooldown(5*TICKS_PER_DAY, 5000); cd.ready(0,0);
  cd.reset(); ok(cd.ready(TICKS_PER_DAY, MS_PER_DAY_AT_SPEED[speed]), "arming fires once");
  let fired=-1; for(let d=2; d<20 && fired<0; d++) if(cd.ready(d*TICKS_PER_DAY, d*MS_PER_DAY_AT_SPEED[speed])) fired=d;
  ok(fired===6, `watchdog fires 5 days after arming at speed ${speed}: day ${fired}`);
}

// Real day lengths vary (Dynamite Dunes days.csv: 464-547 ticks). "Every N days" must fire on
// day N, not N+1, when a span is a few ticks short of N*530 (#48 after-run: 3 scans instead of 5).
import { TILE_SCAN_TICKS, ENTERTAINER_CENSUS_TICKS, NEED_SAMPLE_TICKS, BUILD_WATCHDOG_TICKS } from "./build/cooldown.mjs";
const REAL = [260968,261432,261961,262489,263018,263546,264075,264603,265132,265660,266207,266753,267299,267845,268391];
function realFires(ticks){ const cd=createCooldown(ticks, 0); return REAL.map((t,d)=>cd.ready(t,d)?d:-1).filter(d=>d>=0).join(","); }
ok(realFires(TILE_SCAN_TICKS)==="0,3,6,9,12", `tile scan every 3 real days: ${realFires(TILE_SCAN_TICKS)}`);
ok(realFires(ENTERTAINER_CENSUS_TICKS)==="0,2,4,6,8,10,12,14", `census every 2 real days: ${realFires(ENTERTAINER_CENSUS_TICKS)}`);
ok(realFires(NEED_SAMPLE_TICKS)===REAL.map((_,d)=>d).join(","), `need sample every real day: ${realFires(NEED_SAMPLE_TICKS)}`);
{ const cd=createCooldown(BUILD_WATCHDOG_TICKS, 0); cd.ready(REAL[0],0); let f=-1; for(let d=1; d<REAL.length && f<0; d++) if(cd.ready(REAL[d],d)) f=d;
  ok(f===5, `watchdog trips 5 real days after arming: day ${f}`); }

console.log(`cooldown: ${pass} passed, ${fail} failed`);
if (fail) process.exitCode = 1;
