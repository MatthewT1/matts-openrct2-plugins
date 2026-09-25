// Rolling-window activity (#32 phase 1). The lifetime `fleetUnderworked` / `stuck`
// behaviour is covered in staffing.test.mjs; here we check the new read-only window
// and that it leaves the existing snapshot untouched.
import { createActivityTracker } from "./build/staff-activity.mjs";
let pass=0, fail=0;
const ok=(c,m)=>{ c?pass++:(fail++,console.log("FAIL:",m)); };

// Drive a tracker through `days` sweeps. work(id, day) -> cumulative counter.
function run(t, ids, days, work, hasWork = true) {
  const snaps = [];
  for (let day = 0; day < days; day++) {
    for (const id of ids) t.observe(id, work(id, day));
    snaps.push(t.endSweep(hasWork));
  }
  return snaps;
}

// --- warm-up: null until N sweeps of work are observable (first sweep is a baseline)
{
  const t = createActivityTracker(6);
  run(t, [1, 2], 7, (id, d) => d);
  ok(t.activeFractionWithin(7) === null, "7 sweeps = baseline + 6 observable days: still warming up for N=7");
  run(t, [1, 2], 1, (id, d) => 100);
  ok(t.activeFractionWithin(7) === 1, "8th sweep: N=7 window is valid and everyone worked, got " + t.activeFractionWithin(7));
}

// --- window expiry: a job 5 sweeps ago counts for N=7, not for N=3
{
  const t = createActivityTracker(6);
  // id 1 works once on day 10 only; id 2 never works.
  run(t, [1, 2], 16, (id, d) => (id === 1 && d >= 10) ? 1 : 0);
  // Job gained on sweep index 10; 16 sweeps done (0..15); age = 5.
  ok(t.activeFractionWithin(7) === 0.5, "job 5 sweeps ago is inside N=7, got " + t.activeFractionWithin(7));
  ok(t.activeFractionWithin(6) === 0.5, "job on sweep 10 is inside N=6 (sweeps 10..15), got " + t.activeFractionWithin(6));
  ok(t.activeFractionWithin(5) === 0, "job on sweep 10 is outside N=5 (sweeps 11..15), got " + t.activeFractionWithin(5));
}

// --- this is the #32 bug: lifetime says active forever, the window does not
{
  const t = createActivityTracker(6);
  // 4 mechanics each do one job in the first 10 days, then nothing for 30 days.
  const snaps = run(t, [1, 2, 3, 4], 40, (id, d) => d >= 2 + id * 2 ? 1 : 0);
  ok(snaps[39].fleetUnderworked === false, "lifetime definition: never underworked once everyone worked once");
  ok(t.activeFractionWithin(14) === 0, "window definition: nobody worked in the last 14 days, got " + t.activeFractionWithin(14));
}

// --- an idle new hire counts as inactive (the overstaff test in the plan relies on this)
{
  const t = createActivityTracker(6);
  run(t, [1, 2], 20, (id, d) => d);            // both busy every day
  run(t, [1, 2, 3], 1, (id, d) => id === 3 ? 0 : 100);   // hire id 3
  ok(Math.abs(t.activeFractionWithin(10) - 2 / 3) < 1e-9, "new idle hire lowers the fraction to 2/3, got " + t.activeFractionWithin(10));
}

// --- recycled peep id (counter goes down) forgets the old job
{
  const t = createActivityTracker(6);
  run(t, [1, 2], 12, (id, d) => d);                    // both busy: id 1 reaches 11
  ok(t.activeFractionWithin(7) === 1, "both active before the recycle");
  run(t, [1, 2], 1, (id, d) => id === 1 ? 2 : 100);    // id 1 drops 11 -> 2: a new peep
  ok(t.activeFractionWithin(7) === 0.5, "recycled id 1 is not active, id 2 is, got " + t.activeFractionWithin(7));
}

// --- departed staff leave the denominator
{
  const t = createActivityTracker(6);
  run(t, [1, 2, 3, 4], 12, (id, d) => id === 1 ? d : 0);
  ok(t.activeFractionWithin(7) === 0.25, "1 of 4 active, got " + t.activeFractionWithin(7));
  run(t, [1], 1, (id, d) => 100);               // 2, 3, 4 fired
  ok(t.activeFractionWithin(7) === 1, "after firing the idle three, 1 of 1, got " + t.activeFractionWithin(7));
}

// --- reset clears the warm-up as well
{
  const t = createActivityTracker(6);
  run(t, [1], 20, (id, d) => d);
  t.reset();
  ok(t.activeFractionWithin(7) === null, "reset restarts the warm-up");
}

// --- the handyman path is unchanged: reading the window never alters snapshots
{
  const work = (id, d) => (id % 3 === 0 ? 0 : Math.floor(d / (1 + id % 5)));
  const ids = Array.from({ length: 39 }, (_, i) => i);
  const a = createActivityTracker(6), b = createActivityTracker(6);
  let same = true;
  for (let day = 0; day < 60; day++) {
    for (const id of ids) { a.observe(id, work(id, day)); b.observe(id, work(id, day)); }
    const sa = a.endSweep(day % 2 === 0), sb = b.endSweep(day % 2 === 0);
    b.activeFractionWithin(7); b.activeFractionWithin(21);
    if (JSON.stringify(sa) !== JSON.stringify(sb)) same = false;
  }
  ok(same, "snapshots identical whether or not activeFractionWithin is called");
}

// --- #32 phase 2: fleetUnderworkedWithin (the mechanic release signal)
{
  const t = createActivityTracker(20);
  // Nobody ever works: the window says underworked, but not before it has warmed up.
  run(t, [1, 2, 3], 14, () => 0);
  ok(t.fleetUnderworkedWithin(14) === false, "warm-up gate: no release signal before 14 days are observable");
  run(t, [1, 2, 3], 1, () => 0);
  ok(t.fleetUnderworkedWithin(14) === true, "15th sweep: window valid, 0 of 3 active -> underworked");
}
{
  const t = createActivityTracker(20);
  // Exactly half active is NOT underworked (strict < 0.5, same as the lifetime flag).
  run(t, [1, 2], 15, (id, d) => id === 1 ? d : 0);
  ok(t.fleetUnderworkedWithin(14) === false, "1 of 2 active = 0.5 is not underworked");
}
{
  // The +2 overstaff case: 5 working mechanics, then two idle hires.
  const t = createActivityTracker(20);
  const work = (id, d) => id <= 5 ? Math.floor(d / 10) : 0;   // a job every 10 days
  run(t, [1, 2, 3, 4, 5], 20, work);
  ok(t.fleetUnderworkedWithin(14) === false, "5 of 5 active before the extra hires");
  run(t, [1, 2, 3, 4, 5, 6, 7], 1, (id, d) => work(id, d + 20));
  ok(t.fleetUnderworkedWithin(14) === false, "5 of 7 active: two idle extras alone do not trip it");
  ok(Math.abs(t.activeFractionWithin(14) - 5 / 7) < 1e-9, "fraction 5/7 with two idle extras");
}
{
  // Lifetime flag false, window flag true: the #32 bug, now acted on.
  const t = createActivityTracker(20);
  const snaps = run(t, [1, 2, 3], 30, (id, d) => d < 5 ? d : 5);
  ok(snaps[29].fleetUnderworked === false, "lifetime: everyone worked once, never underworked");
  ok(t.fleetUnderworkedWithin(14) === true, "window: nobody worked in 14 days, underworked");
}

// --- releaseOrder: idle first, then least recently active, ties in input order
{
  const t = createActivityTracker(20);
  // id 1 worked on sweep 2, ids 2 and 4 on sweep 8, id 3 never.
  run(t, [1, 2, 3, 4], 10, (id, d) =>
    id === 1 ? (d >= 2 ? 1 : 0) : id === 3 ? 0 : (d >= 8 ? 1 : 0));
  const order = t.releaseOrder([2, 1, 4, 3]);
  ok(JSON.stringify(order) === "[3,1,2,4]", "never-worked, then oldest job, ties keep input order; got " + JSON.stringify(order));
  ok(JSON.stringify(t.releaseOrder([9, 2])) === "[9,2]", "an untracked id (just hired) sorts first");
  const input = [4, 3];
  t.releaseOrder(input);
  ok(JSON.stringify(input) === "[4,3]", "input array is not mutated");
}
{
  // Releasing idle-first stops at the right fleet.
  const t = createActivityTracker(20);
  const work = (id, d) => id <= 3 ? Math.floor(d / 5) : 0;     // 1-3 busy, 4-6 idle
  run(t, [1, 2, 3, 4, 5, 6], 20, work);
  ok(t.fleetUnderworkedWithin(14) === false, "3 of 6 = 0.5: not underworked");
  run(t, [1, 2, 3, 4, 5, 6, 7], 1, (id, d) => work(id, d + 20));
  ok(t.fleetUnderworkedWithin(14) === true, "3 of 7 after one more idle hire: underworked");
  const fired = t.releaseOrder([1, 2, 3, 4, 5, 6, 7])[0];
  ok(fired >= 4, "the released mechanic is an idle one, got " + fired);
  run(t, [1, 2, 3, 4, 5, 6, 7].filter(id => id !== fired), 1, (id, d) => work(id, d + 21));
  ok(t.fleetUnderworkedWithin(14) === false, "after releasing an idle one the signal clears");
}

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) process.exitCode = 1;
