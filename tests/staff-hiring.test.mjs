import { createStaffHirer, HIRE_BACKOFF_DAYS, wantsAwardGuard } from "./build/staff-hiring.mjs";
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

console.log(`${pass} passed, ${fail} failed`); if (fail) process.exitCode = 1;
