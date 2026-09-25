import { createQueueTrendTracker, FLOOR_MINUTES, RISE_OBSERVATIONS,
    createInterventionTracker, ATTRIBUTION_WINDOW_DAYS, THROUGHPUT_QUEUE_MINUTES } from "./build/queues.mjs";
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

// ================= #15: throughput over queued days =================
// Feed one reading per day. spec(day) -> {q, c, b} (queue minutes, cumulative customers, broken).
function feed(it, from, to, spec) {
    for (let d = from; d <= to; d++) {
        const r = spec(d);
        it.observe(1, "Ride A", d, r.q, r.c, r.b);
        it.endPass();
    }
}

// --- steady ride, then capacity doubles after the intervention
{
    const it = createInterventionTracker();
    feed(it, 0, 10, d => ({ q: 4, c: d * 100 }));          // 100/day
    it.recordIntervention(1, 10, "ops-set");
    feed(it, 11, 15, d => ({ q: 4, c: 1000 + (d - 10) * 200 }));  // 200/day
    const r = it.summarize(15)[0];
    ok(r.throughputBefore === 100 && r.qualifyingDaysBefore === ATTRIBUTION_WINDOW_DAYS,
        "before = 100/day over 5 queued days, got " + r.throughputBefore + " / " + r.qualifyingDaysBefore);
    ok(r.throughputAfter === 200 && r.qualifyingDaysAfter === ATTRIBUTION_WINDOW_DAYS,
        "after = 200/day over 5 queued days, got " + r.throughputAfter + " / " + r.qualifyingDaysAfter);
    ok(r.throughputDeltaPct === 100, "delta +100%, got " + r.throughputDeltaPct);
}

// --- guest count changes do not matter: a ride whose queue grows but capacity is flat reads 0%
{
    const it = createInterventionTracker();
    feed(it, 0, 10, d => ({ q: 2 + d, c: d * 100 }));
    it.recordIntervention(1, 10, "w2-preemptive");
    feed(it, 11, 15, d => ({ q: 2 + d * 2, c: d * 100 }));
    const r = it.summarize(15)[0];
    ok(r.deltaMinutes > 0 && r.throughputDeltaPct === 0,
        "queue minutes rose but throughput is flat: 0%, got " + r.throughputDeltaPct + " (queue delta " + r.deltaMinutes + ")");
}

// --- unqueued days are excluded: they measure demand, not capacity
{
    const it = createInterventionTracker();
    // days 6..10: queued on 6, 8, 9, 10; day 7 below the threshold
    feed(it, 0, 10, d => ({ q: d === 7 ? THROUGHPUT_QUEUE_MINUTES - 0.5 : 3, c: d === 7 ? 700 - 90 : d * 100 }));
    it.recordIntervention(1, 10, "ops-set");
    const r = it.summarize(10)[0];
    // Day 7 (6->7) and day 8 (7->8) both touch the unqueued reading; 6, 9, 10 qualify.
    ok(r.qualifyingDaysBefore === 3, "days touching an unqueued reading are dropped, got " + r.qualifyingDaysBefore);
    ok(r.throughputBefore === 100, "remaining days average 100, got " + r.throughputBefore);
    ok(r.throughputAfter === null && r.throughputDeltaPct === null, "no after data yet -> nulls");
}

// --- breakdowns are excluded, including one flagged by a later same-day reading
{
    const it = createInterventionTracker();
    feed(it, 0, 10, d => ({ q: 3, c: d * 100 }));
    it.recordIntervention(1, 10, "ops-set");
    feed(it, 11, 12, d => ({ q: 3, c: 1000 + (d - 10) * 150 }));
    // Second read on day 12 (e.g. the window opened) reports a breakdown: sticky for day 12.
    it.observe(1, "Ride A", 12, 3, 99999, true); it.endPass();
    feed(it, 13, 15, d => ({ q: 3, c: 1000 + (d - 10) * 150 }));
    const r = it.summarize(15)[0];
    ok(r.qualifyingDaysAfter === 3, "days 12 and 13 touch the broken reading, 11/14/15 qualify, got " + r.qualifyingDaysAfter);
    ok(r.throughputAfter === 150, "a later same-day reading does not replace the customer count, got " + r.throughputAfter);
}

// --- a missing day breaks the chain rather than spanning two days as one
{
    const it = createInterventionTracker();
    for (const d of [5, 6, 8, 9, 10]) { it.observe(1, "Ride A", d, 3, d * 100); it.endPass(); }
    it.recordIntervention(1, 10, "ops-set");
    const r = it.summarize(10)[0];
    ok(r.qualifyingDaysBefore === 3 && r.throughputBefore === 100,
        "6, 9, 10 qualify; 8 (from 6) does not count double, got " + r.qualifyingDaysBefore + " / " + r.throughputBefore);
}

// --- counter going backwards (ride id reused) is skipped, not read as negative
{
    const it = createInterventionTracker();
    feed(it, 0, 10, d => ({ q: 3, c: d <= 8 ? d * 100 : (d - 8) * 100 }));
    it.recordIntervention(1, 10, "ops-set");
    const r = it.summarize(10)[0];
    ok(r.qualifyingDaysBefore === 4 && r.throughputBefore === 100, "the drop day is skipped, got " + r.qualifyingDaysBefore + " / " + r.throughputBefore);
}

// --- callers without customers keep the old behaviour
{
    const it = createInterventionTracker();
    for (let d = 0; d <= 10; d++) { it.observe(1, "Ride A", d, 3); it.endPass(); }
    it.recordIntervention(1, 10, "ops-set");
    const r = it.summarize(10)[0];
    ok(r.throughputBefore === null && r.qualifyingDaysBefore === 0 && r.beforeMinutes === 3,
        "no customers -> throughput null, queue fields unchanged");
}

// --- history trimming keeps the full after-window long after the intervention
{
    const it = createInterventionTracker();
    feed(it, 0, 10, d => ({ q: 3, c: d * 100 }));
    it.recordIntervention(1, 10, "ops-set");
    feed(it, 11, 40, d => ({ q: 3, c: 1000 + (d - 10) * 120 }));
    const r = it.summarize(40)[0];
    ok(r.throughputAfter === 120 && r.qualifyingDaysAfter === ATTRIBUTION_WINDOW_DAYS,
        "after-window survives 30 more days of readings, got " + r.throughputAfter + " / " + r.qualifyingDaysAfter);
    ok(r.throughputBefore === 100, "before stays frozen, got " + r.throughputBefore);
}

// --- memory stays bounded: a ride with an old intervention does not keep every day since
{
    const it = createInterventionTracker();
    feed(it, 0, 10, d => ({ q: 3, c: d * 100 }));
    it.recordIntervention(1, 10, "ops-set");
    feed(it, 11, 400, d => ({ q: 3, c: d * 100 }));
    // Several same-day reads (window open etc.) must not grow it either.
    for (let k = 0; k < 20; k++) { it.observe(1, "Ride A", 400, 3, 40000); it.endPass(); }
    const r = it.summarize(400)[0];
    ok(r.qualifyingDaysAfter === ATTRIBUTION_WINDOW_DAYS, "still reports the full after-window at day 400");
    // Fresh intervention on day 400 still sees its own before-window.
    it.recordIntervention(1, 400, "ops-set");
    const r2 = it.summarize(400)[0];
    ok(r2.qualifyingDaysBefore === ATTRIBUTION_WINDOW_DAYS && r2.throughputBefore === 100,
        "a new intervention after 390 days gets a full before-window, got " + r2.qualifyingDaysBefore);
}

console.log(`${pass} passed, ${fail} failed`);
