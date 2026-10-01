import { createStaffHirer, HIRE_BACKOFF_DAYS, wantsAwardGuard, planAwardCrew, awardStaffLine, awardCrewStatusText, DEFAULT_AWARD_CREW_OPTIONS as CREW } from "./build/staff-hiring.mjs";
let pass = 0, fail = 0;
const ok = (c, m) => { c ? pass++ : (fail++, console.log("FAIL:", m)); };

function rig(result, backoffDays = HIRE_BACKOFF_DAYS) {
    const calls = [], counts = {}, logs = [];
    const hirer = createStaffHirer({
        staffType: 1, orders: 3, noun: "mechanic", plugin: "Mechanic Manager",
        counterPrefix: "mechanic", backoffDays,
        execute: (action, args, cb) => { calls.push({ action, args }); cb(result()); },
        count: (name, n) => { counts[name] = (counts[name] || 0) + (n === undefined ? 1 : n); },
        log: (m) => logs.push(m),
    });
    return { hirer, calls, counts, logs };
}

// Successful hire: args match what the plugins used to send, onHired gets the id.
{
    const r = rig(() => ({ error: 0, peep: 42 }));
    let got = null;
    r.hirer.hire((id) => { got = id; });
    const a = r.calls[0];
    ok(a.action === "staffhire", "hire issues staffhire");
    ok(a.args.autoPosition === true && a.args.staffType === 1 && a.args.costumeIndex === 0 && a.args.staffOrders === 3,
        "hire args unchanged: " + JSON.stringify(a.args));
    ok(got === 42, "onHired receives peep id");
    ok(!r.hirer.blocked(), "not blocked after success");
    ok(Object.keys(r.counts).length === 0, "no counters on success");
}

// Costume index is passed through (entertainers).
{
    const r = rig(() => ({}));
    r.hirer.hire(undefined, 7);
    ok(r.calls[0].args.costumeIndex === 7, "costume passed through");
}

// Refused hire: counted, logged once, blocks for exactly HIRE_BACKOFF_DAYS calls.
{
    const r = rig(() => ({ error: 1 }));
    r.hirer.hire(); r.hirer.hire();
    ok(r.counts.mechanicHireFailed === 2, "each refusal counted");
    ok(r.logs.length === 1, "backoff message logged once, got " + r.logs.length);
    ok(r.logs[0] === "[Mechanic Manager] Could not hire a mechanic - the park is at its entity limit. Pausing hiring for 10 days.",
        "log text unchanged: " + r.logs[0]);
    let blockedDays = 0;
    while (r.hirer.blocked()) blockedDays++;
    ok(blockedDays === HIRE_BACKOFF_DAYS, "blocked for " + HIRE_BACKOFF_DAYS + " days, got " + blockedDays);
    ok(r.counts.mechanicHireBlocked === HIRE_BACKOFF_DAYS, "each blocked day counted");
}

// backoffDays 0 (entertainers): refusal counted, never blocks, never logs.
{
    const r = rig(() => ({ error: 1 }), 0);
    r.hirer.hire();
    ok(r.counts.mechanicHireFailed === 1, "refusal counted with no backoff");
    ok(!r.hirer.blocked() && r.logs.length === 0, "no backoff, no log");
}

// Fire: success is silent; refusal is counted and logged.
{
    const r = rig(() => ({ error: 0 }));
    r.hirer.fire(5);
    ok(r.calls[0].action === "stafffire" && r.calls[0].args.id === 5, "fire issues stafffire with id");
    ok(r.logs.length === 0, "successful fire is silent");
    const f = rig(() => ({ error: 2, errorMessage: "Staff not found" }));
    f.hirer.fire(9);
    ok(f.counts.mechanicFireFailed === 1, "refused fire counted");
    ok(f.logs[0] === "[Mechanic Manager] Could not fire mechanic #9: Staff not found", "fire log: " + f.logs[0]);
}

// --- wantsAwardGuard (#92: Best Staff needs a security guard)
{
    const roster = (n, extra = []) => [...Array(n - extra.length).fill("handyman"), ...extra];
    ok(wantsAwardGuard(roster(20, ["mechanic", "entertainer"])) === true, "20 staff, no security -> hire");
    ok(wantsAwardGuard(roster(19, ["mechanic", "entertainer"])) === false, "19 staff -> not yet");
    ok(wantsAwardGuard(roster(25, ["security"])) === false, "already has a guard -> no");
    ok(wantsAwardGuard([]) === false, "empty roster -> no");
}

// #136: under a server, actions run next tick. A fire is pending until its callback
// runs, so patrol actions can skip that id; single player (immediate callback) never is.
{
    const queued = [];
    const hirer = createStaffHirer({
        staffType: 0, orders: 7, noun: "handyman", plugin: "Trash Manager",
        counterPrefix: "handyman", backoffDays: HIRE_BACKOFF_DAYS,
        execute: (action, args, cb) => queued.push(() => cb({ error: 0 })),
        count: () => {}, log: () => {},
    });
    hirer.fire(12);
    ok(hirer.firePending(12), "queued fire is pending");
    ok(!hirer.firePending(13), "other ids are not");
    queued.forEach((run) => run());
    ok(!hirer.firePending(12), "pending clears once the fire runs");
    const r = rig(() => ({ error: 0 }));
    r.hirer.fire(5);
    ok(!r.hirer.firePending(5), "immediate (single player) fire is never pending");
    const f = rig(() => ({ error: 1, errorMessage: "x" }));
    f.hirer.fire(6);
    ok(!f.hirer.firePending(6), "refused fire clears pending too");
}

// --- award crew (#163): guards that hold the Best Staff line -----------------------------
{
    const I = (handymen, mechanics, security, entertainers, guestEntities, ownedGuards = 0) => ({ handymen, mechanics, security, entertainers, guestEntities, ownedGuards });
    ok(awardStaffLine(400, CREW) === 20, "small park: the line is 20");
    ok(awardStaffLine(1280, CREW) === 41, "1280 guests: 40 + 1 spare");
    let p = planAwardCrew(I(10, 4, 1, 4, 490), CREW);
    ok(p.action === "hire" && p.target === 1 && p.line === 20, "Dynamite Dunes: 19 of 20 -> hire one");
    p = planAwardCrew(I(10, 3, 1, 4, 373), CREW);
    ok(p.action === "hire" && p.target === 2, "Jetlag Heights: 18 of 20 -> target two");
    p = planAwardCrew(I(10, 4, 2, 4, 490, 1), CREW);
    ok(p.action === "none" && p.target === 1, "gap closed by our guard: hold");
    p = planAwardCrew(I(20, 8, 2, 7, 1322), CREW);
    ok(p.action === "hire" && p.target === 5 && p.line === 42, "37 of 42 (41 + 1 spare): 5 short is still chased");
    p = planAwardCrew(I(20, 8, 1, 6, 1322), CREW);
    ok(p.action === "none" && p.target === 0, "Fort Anachronism, 35 of 42: 7 short is past maxExtra, nothing hired");
    p = planAwardCrew(I(25, 10, 1, 7, 3041), CREW);
    ok(p.action === "none", "Amity Airfield: 43 of 96, never chased");
    p = planAwardCrew(I(0, 4, 1, 4, 300), CREW);
    ok(p.action === "none" && p.target === 0, "no handyman: extra guards cannot earn the award");
    p = planAwardCrew(I(10, 4, 1, 0, 300), CREW);
    ok(p.action === "none", "no entertainer: same");
    p = planAwardCrew(I(14, 4, 4, 4, 490, 3), CREW);
    ok(p.action === "fire" && p.target === 0, "others grew to 23 without ours: 3 owned -> let one go");
    p = planAwardCrew(I(14, 4, 2, 4, 490, 1), CREW);
    ok(p.action === "none", "one owned over target is slack, not fired");
    p = planAwardCrew(I(10, 4, 4, 4, 1600, 3), CREW);
    ok(p.action === "fire", "park outgrew it (51 needed, 19 without ours): release");
    p = planAwardCrew(I(10, 4, 2, 4, 1600, 1), CREW);
    ok(p.action === "fire", "out of reach: released down to none");
    p = planAwardCrew(I(10, 4, 1, 4, 1600, 0), CREW);
    ok(p.action === "none", "nothing owned: never asks to fire");
    p = planAwardCrew(I(10, 4, 6, 4, 780, 5), CREW);
    ok(p.action === "hire" && p.target === 6, "gap grew to 6 while we own 5: hold and follow it, not release");
    p = planAwardCrew(I(10, 4, 6, 4, 880, 5), CREW);
    ok(p.action === "fire" && p.target === 0, "gap of 9 is past maxExtra + holdExtra: release");
    p = planAwardCrew(I(10, 4, 1, 4, 780, 0), CREW);
    ok(p.action === "none", "the same 6 gap with nothing owned is not started");
    p = planAwardCrew(I(12, 4, 3, 4, 490, 2), CREW);
    ok(p.action === "fire" && p.target === 0, "21 staff without ours and two owned: one is let go");

    // Reason + window line (#163 telemetry).
    p = planAwardCrew(I(10, 4, 1, 4, 490), CREW);
    ok(p.reason === "short" && p.staff === 19 && p.shortBy === 1, "19 of 20: short by 1");
    ok(awardCrewStatusText(p, 0) === "Best Staff: 19/20, hiring guards", "short text");
    p = planAwardCrew(I(10, 4, 2, 4, 490, 1), CREW);
    ok(p.reason === "met" && p.shortBy === 0, "our guard closes the gap: met");
    ok(awardCrewStatusText(p, 1) === "Best Staff: 20/20, line met (1 hired)", "met text names our guard");
    p = planAwardCrew(I(25, 10, 1, 7, 3041), CREW);
    ok(p.reason === "outOfReach" && p.shortBy === 53, "43 of 96: out of reach");
    ok(awardCrewStatusText(p, 0) === "Best Staff: 43/96, out of reach", "out-of-reach text");
    p = planAwardCrew(I(0, 4, 1, 4, 300), CREW);
    ok(p.reason === "missingType", "no handyman: missing type");
    ok(awardCrewStatusText(p, 0) === "Best Staff: 9/20, needs every type", "missing-type text");
    p = planAwardCrew(I(14, 4, 4, 4, 490, 3), CREW);
    ok(p.reason === "met" && awardCrewStatusText(p, 3).indexOf("(3 hired)") > 0, "over the line: met, guards counted");
    p = planAwardCrew(I(10, 4, 2, 4, 490, 1), CREW);
    ok(awardCrewStatusText(p, 1, 4) === "Best Staff: 20/20, award held 4 mo (1 hired)", "award held: months left shown");
    ok(awardCrewStatusText(p, 0, 1) === "Best Staff: 20/20, award held 1 mo", "one month");
    ok(awardCrewStatusText(p, 1, 0) === "Best Staff: 20/20, line met (1 hired)", "0 months = not held");
    for (const q of [planAwardCrew(I(40, 20, 12, 7, 3041, 12), CREW), planAwardCrew(I(25, 10, 1, 7, 3041), CREW), planAwardCrew(I(60, 20, 14, 5, 3100, 5), CREW)]) {
        ok(awardCrewStatusText(q, 12, 5).length <= 46 && awardCrewStatusText(q, 12).length <= 46, "fits the window: " + awardCrewStatusText(q, 12));
    }
    p = planAwardCrew(I(10, 4, 1, 4, 490), CREW);
    ok(awardCrewStatusText(p, 0, 3).indexOf("award held 3 mo") > 0, "held from earlier while 1 short now: still says held");
}

console.log(`${pass} passed, ${fail} failed`); if (fail) process.exitCode = 1;
