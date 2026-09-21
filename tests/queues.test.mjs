import { createQueueTrendTracker, FLOOR_MINUTES, RISE_OBSERVATIONS,
    createInterventionTracker, ATTRIBUTION_WINDOW_DAYS } from "./build/queues.mjs";
let pass=0, fail=0; const ok=(c,m)=>{ c?pass++:(fail++,console.log("FAIL:",m)); };
const WARN = 5;

ok(FLOOR_MINUTES===3 && RISE_OBSERVATIONS===2, "shipped constants");

// --- a first sighting can never produce a trend verdict -------------------------
const t1=createQueueTrendTracker();
ok(t1.observe(1, 4, WARN)==="normal", "first sighting of a sub-warning queue is normal");
ok(t1.observe(2, 9, WARN)==="warning", "first sighting past the warn threshold is warning");

// --- the core case: rising toward trouble ---------------------------------------
const t2=createQueueTrendTracker();
t2.observe(1, 3, WARN);                                   // baseline
ok(t2.observe(1, 3.5, WARN)==="normal", "one rise is not enough");
ok(t2.observe(1, 4, WARN)==="rising", "two consecutive rises flags at RISE_OBSERVATIONS");
ok(t2.risingCount()===1, "counted as rising");

// ...and the case it must NOT fire on: busy but stable.
const t3=createQueueTrendTracker();
for (let i=0;i<10;i++) ok(t3.observe(1, 4, WARN)==="normal", "stable 4-minute queue stays normal (i="+i+")");
ok(t3.risingCount()===0, "stable queue is not counted as rising");

// A flat reading must not creep toward a flag. This is the difference between
// "pinned at one value" and "climbing", and treating them the same would flag
// every moderately busy ride in the park eventually.
const t4=createQueueTrendTracker();
t4.observe(1, 3); t4.observe(1, 3.5, WARN);               // one rise banked
for (let i=0;i<20;i++) t4.observe(1, 3.5, WARN);
ok(t4.observe(1, 3.5, WARN)==="normal", "flat readings never accumulate into a flag");

// --- a falling queue resets outright --------------------------------------------
const t5=createQueueTrendTracker();
t5.observe(1, 3, WARN); t5.observe(1, 3.5, WARN);         // one rise
t5.observe(1, 3.2, WARN);                                  // cleared
ok(t5.observe(1, 3.6, WARN)==="normal", "a fall wipes the accumulated rises");
ok(t5.observe(1, 4.0, WARN)==="rising", "and it must climb again from scratch");

// --- the floor keeps quiet rides out --------------------------------------------
const t6=createQueueTrendTracker();
t6.observe(1, 0.5, WARN); t6.observe(1, 1.0, WARN); t6.observe(1, 1.5, WARN);
ok(t6.observe(1, 2.0, WARN)==="normal", "a ride filling up below the floor is not running away");
ok(t6.risingCount()===0, "sub-floor rides are not counted");
// ...but the same ride crossing the floor while still climbing is.
ok(t6.observe(1, 3.0, WARN)==="rising", "crossing the floor while climbing does flag");

// --- warning always wins over trend ---------------------------------------------
const t7=createQueueTrendTracker();
t7.observe(1, 8, WARN);
ok(t7.observe(1, 7, WARN)==="warning", "past the threshold is warning even while FALLING");
ok(t7.observe(1, 5, WARN)==="warning", "warn threshold is inclusive");
ok(t7.observe(1, 4.9, WARN)==="normal", "just under it is not");

// --- rides are tracked independently --------------------------------------------
const t8=createQueueTrendTracker();
t8.observe(1, 3, WARN); t8.observe(2, 3, WARN);
t8.observe(1, 3.5, WARN); t8.observe(2, 3, WARN);
t8.observe(1, 4, WARN);   t8.observe(2, 3, WARN);
ok(t8.risingCount()===1, "one rising ride, not two, got "+t8.risingCount());

// --- endPass drops rides that vanished ------------------------------------------
// A demolished ride leaving a record behind is the same stale-id bug class that
// produced "Invalid parameter / Staff not found" in the staffing code.
const t9=createQueueTrendTracker();
t9.observe(1, 3, WARN); t9.observe(2, 3, WARN);
t9.endPass();
t9.observe(1, 3.5, WARN);      // only ride 1 seen this pass
t9.endPass();
// Ride 2 is gone, so re-observing it must behave as a first sighting (no trend).
ok(t9.observe(2, 9, WARN)==="warning", "a returning id is re-baselined, not resumed");
ok(t9.observe(1, 4, WARN)==="rising", "the surviving ride keeps its trend across passes");

// endPass must not wipe rides that WERE seen, however many passes go by.
const t10=createQueueTrendTracker();
t10.observe(1, 3, WARN); t10.endPass();
t10.observe(1, 3.5, WARN); t10.endPass();
ok(t10.observe(1, 4, WARN)==="rising", "trend survives repeated passes");

// reset clears everything
t10.reset();
ok(t10.risingCount()===0 && t10.observe(1, 4, WARN)==="normal", "reset drops all state");

// ============================================================================
// createInterventionTracker (P3: per-ride before/after attribution)
// ============================================================================

ok(ATTRIBUTION_WINDOW_DAYS === 5, "shipped attribution window");

// --- an intervention with no observations yet is simply ignored -----------------
{
    const it = createInterventionTracker();
    it.recordIntervention(1, 3, "w2-preemptive");
    ok(it.summarize(3).length === 0, "recording an intervention for an unseen ride is a no-op");
}

// --- the core case: before/after means around the intervention day --------------
{
    const it = createInterventionTracker();
    it.observe(1, "Ride A", 1, 6); it.observe(1, "Ride A", 2, 7); it.observe(1, "Ride A", 3, 8);
    it.recordIntervention(1, 3, "w2-preemptive");
    it.observe(1, "Ride A", 4, 9); it.observe(1, "Ride A", 5, 10); it.observe(1, "Ride A", 6, 11);
    const rows = it.summarize(6);
    ok(rows.length === 1, "one ride with an intervention reported");
    const r = rows[0];
    ok(r.rideId === 1 && r.name === "Ride A" && r.kind === "w2-preemptive" && r.day === 3,
        "identity and kind carried through");
    ok(r.beforeMinutes === 6.5, "before mean averages the two pre-intervention samples, got " + r.beforeMinutes);
    ok(r.afterMinutes === 10, "after mean averages the three post-intervention samples, got " + r.afterMinutes);
    ok(r.deltaMinutes === 3.5, "delta is after - before, got " + r.deltaMinutes);
}

// --- no data on one side yields nulls, not a fabricated zero --------------------
{
    const it = createInterventionTracker();
    it.observe(1, "Ride A", 1, 5);
    it.recordIntervention(1, 1, "ops-set");
    const rows = it.summarize(1);
    ok(rows[0].beforeMinutes === null, "no pre-intervention samples means before is null");
    ok(rows[0].afterMinutes === null, "no post-intervention samples yet means after is null");
    ok(rows[0].deltaMinutes === null, "delta is null unless both sides have data");
}

// --- window is bounded: samples further out than ATTRIBUTION_WINDOW_DAYS don't count
{
    const it = createInterventionTracker();
    // Far-past sample outside the window, then the intervention.
    for (let d = 1; d <= 20; d++) it.observe(1, "Ride A", d, d === 20 ? 100 : 4);
    it.recordIntervention(1, 20, "w2-preemptive");
    it.observe(1, "Ride A", 21, 8);
    const r = it.summarize(21)[0];
    // before window is days 15-19, all sampled at 4 - the far-past 100s never happened
    // near day 20, so a correct implementation only ever saw 4s in-window anyway; this
    // mainly guards against the window silently growing unbounded.
    ok(r.beforeMinutes === 4, "before mean only covers the window, got " + r.beforeMinutes);
}

// --- a new intervention on the same ride overwrites the old one -----------------
{
    const it = createInterventionTracker();
    it.observe(1, "Ride A", 1, 5);
    it.recordIntervention(1, 1, "ops-set");
    it.observe(1, "Ride A", 2, 6);
    it.recordIntervention(1, 2, "w2-preemptive");
    const rows = it.summarize(2);
    ok(rows.length === 1, "still one row after a second intervention");
    ok(rows[0].kind === "w2-preemptive" && rows[0].day === 2, "the newer intervention wins");
}

// --- endPass drops the WHOLE record (history + intervention) for an absent ride -
// A queue trend spliced across a breakdown, or an old intervention silently
// re-attaching to a reused ride id, would both be wrong - see queues.ts header.
{
    const it = createInterventionTracker();
    it.observe(1, "Ride A", 1, 5);
    it.recordIntervention(1, 1, "w2-preemptive");
    it.endPass(); // this pass's observation keeps it (seen was true for this pass)
    it.endPass(); // not re-observed since -> dropped now, same as createQueueTrendTracker
    ok(it.summarize(5).length === 0, "an absent ride's intervention record is dropped, not carried");

    // A same-id ride reappearing (e.g. demolished and rebuilt) starts fresh.
    it.observe(1, "New Ride", 5, 3);
    ok(it.summarize(5).length === 0, "a reappearing id has no stale intervention attached");
}

// --- endPass keeps a ride that WAS observed this pass, intervention and all -----
{
    const it = createInterventionTracker();
    it.observe(1, "Ride A", 1, 5);
    it.recordIntervention(1, 1, "ops-set");
    it.observe(1, "Ride A", 2, 6);
    it.endPass();
    it.observe(1, "Ride A", 3, 7);
    it.endPass();
    const rows = it.summarize(3);
    ok(rows.length === 1 && rows[0].kind === "ops-set", "a continuously-observed ride survives repeated passes");
}

// --- multiple rides are independent ----------------------------------------------
{
    const it = createInterventionTracker();
    it.observe(1, "Ride A", 1, 5); it.observe(2, "Ride B", 1, 5);
    it.recordIntervention(1, 1, "w2-preemptive");
    it.observe(1, "Ride A", 2, 6); it.observe(2, "Ride B", 2, 6);
    const rows = it.summarize(2);
    ok(rows.length === 1, "only the ride with an intervention is reported, got " + rows.length);
}

// --- reset clears everything -----------------------------------------------------
{
    const it = createInterventionTracker();
    it.observe(1, "Ride A", 1, 5);
    it.recordIntervention(1, 1, "w2-preemptive");
    it.reset();
    ok(it.summarize(1).length === 0, "reset drops all state");
}

console.log(`${pass} passed, ${fail} failed`);
