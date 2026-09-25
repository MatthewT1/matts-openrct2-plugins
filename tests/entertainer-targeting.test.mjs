import {
    selectEntertainerTargets, censusQueues, entertainerStaffingSignals,
    QUEUE_FLOOR_MINUTES, QUEUE_URGENT_MINUTES, MAX_TARGETED_ENTERTAINERS,
    PATROL_RADIUS_TILES, TILE_SIZE, ENTERTAINER_THRESHOLDS, planEntertainerRoster, costumeCandidates,
} from "./build/entertainer-targeting.mjs";
import { createStaffingController } from "./build/staffing.mjs";

let pass = 0, fail = 0;
const ok = (c, m) => { c ? pass++ : (fail++, console.log("FAIL:", m)); };

const ride = (rideId, name, queueMinutes, stationX = 1000, stationY = 2000) =>
    ({ rideId, name, queueMinutes, stationX, stationY });

// --- selection: below floor never selected, however many slots available
{
    const rides = [ride(1, "Teacups", QUEUE_FLOOR_MINUTES - 1)];
    const out = selectEntertainerTargets(rides, 4);
    ok(out.length === 0, "queue below floor not selected, got " + out.length);
}

// --- selection: worst queue first, capped by maxEntertainers
{
    const rides = [
        ride(1, "A", 3), ride(2, "B", 8), ride(3, "C", 5), ride(4, "D", 4),
    ];
    const out = selectEntertainerTargets(rides, 2);
    ok(out.length === 2, "capped to maxEntertainers, got " + out.length);
    ok(out[0].name === "B" && out[1].name === "C", "worst queue first, got " + out.map(o => o.name).join(","));
}

// --- selection: never exceeds MAX_TARGETED_ENTERTAINERS even if caller asks for more
{
    const rides = [ride(1, "A", 9), ride(2, "B", 9), ride(3, "C", 9), ride(4, "D", 9), ride(5, "E", 9), ride(6, "F", 9)];
    const out = selectEntertainerTargets(rides, 999);
    ok(out.length === MAX_TARGETED_ENTERTAINERS, "hard cap respected, got " + out.length);
}

// --- patrol rectangle is a fixed box around the station, in game units
{
    const rides = [ride(1, "A", 9, 1000, 2000)];
    const out = selectEntertainerTargets(rides, 1);
    const r = PATROL_RADIUS_TILES * TILE_SIZE;
    ok(out[0].patrol.x1 === 1000 - r, "x1 correct");
    ok(out[0].patrol.x2 === 1000 + r, "x2 correct");
    ok(out[0].patrol.y1 === 2000 - r, "y1 correct");
    ok(out[0].patrol.y2 === 2000 + r, "y2 correct");
}

// --- census: urgent and eligible counts, worst queue
{
    const rides = [ride(1, "A", 1), ride(2, "B", QUEUE_FLOOR_MINUTES), ride(3, "C", QUEUE_URGENT_MINUTES), ride(4, "D", 12)];
    const c = censusQueues(rides);
    ok(c.eligibleCount === 3, "eligible counts floor+, got " + c.eligibleCount);
    ok(c.urgentCount === 2, "urgent counts warn+, got " + c.urgentCount);
    ok(c.worstMinutes === 12, "worst tracked, got " + c.worstMinutes);
}

// --- census: empty park
{
    const c = censusQueues([]);
    ok(c.eligibleCount === 0 && c.urgentCount === 0 && c.worstMinutes === 0, "empty rides -> all zero");
}

// --- signal mapping feeds the staffing controller sensibly: quiet park never hires
{
    const c = censusQueues([ride(1, "A", 1)]);
    const sig = entertainerStaffingSignals(c, 999);
    ok(sig.oldLitter === 0 && sig.totalLitter === 0, "quiet park maps to zero signals");
    ok(sig.fleetUnderworked === true, "quiet park is underworked");

    const controller = createStaffingController(0, ENTERTAINER_THRESHOLDS);
    let d;
    for (let i = 0; i < 10; i++) d = controller.update(sig);
    ok(d.target === 0, "never hires when nothing qualifies, got " + d.target);
}

// --- signal mapping: a real congestion problem drives a hire
{
    const rides = [ride(1, "A", 9), ride(2, "B", 6)];
    const c = censusQueues(rides);
    const sig = entertainerStaffingSignals(c, 999);
    ok(sig.oldLitter === 2, "two urgent rides -> oldLitter 2, got " + sig.oldLitter);
    ok(sig.formulaTarget === 2, "formula target matches eligible count, got " + sig.formulaTarget);

    const controller = createStaffingController(0, ENTERTAINER_THRESHOLDS);
    const d = controller.update(sig);
    ok(d.target === 1, "urgent congestion hires one entertainer, got " + d.target);
}

// --- formula target never exceeds MAX_TARGETED_ENTERTAINERS regardless of eligible count
{
    const rides = [ride(1, "A", 9), ride(2, "B", 9), ride(3, "C", 9), ride(4, "D", 9), ride(5, "E", 9), ride(6, "F", 9)];
    const c = censusQueues(rides);
    const sig = entertainerStaffingSignals(c, 999);
    ok(sig.formulaTarget === MAX_TARGETED_ENTERTAINERS, "formula target capped, got " + sig.formulaTarget);
}

// --- #54 roster plan: hire = max(0, min(target, cap) - live)
{
    ok(planEntertainerRoster(3, [10], {}).hire === 2, "hires the deficit from the live count");
    ok(planEntertainerRoster(4, [1, 2, 3, 4], {}).hire === 0, "at target: no hire");
    ok(planEntertainerRoster(20, [], {}).hire === MAX_TARGETED_ENTERTAINERS, "target clamped to cap");
    ok(planEntertainerRoster(-3, [], {}).hire === 0, "negative target hires nothing");
}

// --- #54 regression: daily passes over the LIVE roster never pass the cap. The bug fed a
// roster cached for ~7 in-game days, so each day re-hired the same deficit (0 -> 22).
{
    const roster = []; let nextId = 100, peak = 0;
    for (let day = 0; day < 10; day++) {
        const plan = planEntertainerRoster(4, roster.slice(), {});
        for (let i = 0; i < plan.hire; i++) roster.push(nextId++);
        peak = Math.max(peak, roster.length);
    }
    ok(peak === 4, "live roster peaks at cap over 10 days, got " + peak);

    // The stale shape, for contrast: the same plan fed a frozen empty list overshoots.
    const stale = []; let staleRoster = 0;
    for (let day = 0; day < 10; day++) staleRoster += planEntertainerRoster(4, stale, {}).hire;
    ok(staleRoster > MAX_TARGETED_ENTERTAINERS, "stale input is what overshoots (documents the bug)");
}

// --- #54 firing: only owned ids, surplus of player staff reported as protected
{
    const owned = { "5": true, "7": true };
    const plan = planEntertainerRoster(1, [4, 5, 6, 7], owned);
    ok(plan.hire === 0, "no hire when over target");
    ok(plan.fireIds.join(",") === "5,7", "fires only owned ids, got " + plan.fireIds.join(","));
    ok(plan.protectedCount === 1, "player surplus protected, got " + plan.protectedCount);
    const none = planEntertainerRoster(0, [1, 2], {});
    ok(none.fireIds.length === 0 && none.protectedCount === 2, "never fires a hand-hired entertainer");
    const clamp = planEntertainerRoster(9, [1, 2, 3, 4, 5, 6], { "6": true, "5": true });
    ok(clamp.fireIds.join(",") === "5,6", "over cap trims owned back to cap, got " + clamp.fireIds.join(","));
}

// --- #50 costume candidates: entertainer objects first, known non-entertainers never.
{
  const objs = [
    { index: 0, identifier: "rct2.peep_animations.guest" },
    { index: 1, identifier: "rct2.peep_animations.handyman" },
    { index: 2, identifier: "rct2.peep_animations.mechanic" },
    { index: 3, identifier: "rct2.peep_animations.security" },
    { index: 5, identifier: "rct2.peep_animations.entertainer_elephant" },
    { index: 4, identifier: "rct2.peep_animations.entertainer_panda" },
    { index: 6, identifier: "someone.custom_mascot" },
  ];
  const c = costumeCandidates(objs, 10);
  ok(c[0] === 4 && c[1] === 5, "#50 entertainer objects first, got " + c.slice(0, 3).join(","));
  ok(![0, 1, 2, 3].some(i => c.includes(i)), "#50 guest/handyman/mechanic/security never queried");
  ok(c.includes(6) && c.indexOf(6) > 1, "#50 custom-named object still tried after the named ones");
  ok(c.length === 7, "#50 each index once (4,5,6..10), got " + c.length);
  const bare = costumeCandidates([], 3);
  ok(bare.join(",") === "0,1,2,3", "#50 no object list: falls back to the full walk");
}

console.log(`entertainer-targeting: ${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
