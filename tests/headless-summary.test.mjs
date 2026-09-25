import { summariseMetric, summariseRun, compareRuns, toCsv, markdownReport, countLogErrors, classifyEffect, metricValue, METRICS } from "../tools/headless/summary.mjs";
let pass = 0, fail = 0;
const ok = (c, m) => { c ? pass++ : (fail++, console.log("FAIL:", m)); };

const rows = [
    { type: "day", day: 0, rating: 900, guests: 100, cash: 1000 },
    { type: "day", day: 1, rating: 880, guests: 120, cash: 500 },
    { type: "day", day: 2, rating: 910, guests: 110, cash: 1500 },
];

// Start/end/change/min/max/mean over the day rows.
{
    const s = summariseMetric(rows, "rating");
    ok(s.start === 900 && s.end === 910 && s.change === 10, "start/end/change: " + JSON.stringify(s));
    ok(s.min === 880 && s.max === 910, "min/max");
    ok(Math.abs(s.mean - 896.6667) < 0.001, "mean " + s.mean);
}

// A metric no row has is null, not zeros.
ok(summariseMetric(rows, "litter") === null, "missing metric is null");

// Run summary records the last day number.
{
    const r = summariseRun(rows);
    ok(r.days === 2, "days " + r.days);
    ok(r.metrics.guests.change === 10, "guests change");
    ok(r.metrics.litter === null, "missing metric null in run");
}

// On minus off, at the end and on average.
{
    const on = summariseRun(rows);
    const off = summariseRun(rows.map((r) => ({ ...r, guests: r.guests - 20 })));
    const c = compareRuns(on, off);
    ok(c.guests.diffEnd === 20 && c.guests.diffMean === 20, "guests diff " + JSON.stringify(c.guests));
    ok(c.litter === null, "diff null when metric missing");
}

// CSV drops the message type and keeps column order.
{
    const csv = toCsv(rows).split("\n");
    ok(csv[0] === "day,rating,guests,cash", "header " + csv[0]);
    ok(csv[1] === "0,900,100,1000", "first row " + csv[1]);
    ok(toCsv([]) === "", "empty csv");
}

// Report: money shown in currency units, differences signed.
{
    const md = markdownReport({ on: summariseRun(rows), off: summariseRun(rows.map((r) => ({ ...r, cash: r.cash + 100 }))) });
    const cash = md.split("\n").find((l) => l.startsWith("| Cash"));
    ok(cash.includes("| 100 | 150 | +50 |"), "on cash in units: " + cash);
    ok(cash.includes("| -10 | -10 |"), "on-off cash diff: " + cash);
    const rating = md.split("\n").find((l) => l.startsWith("| Park rating"));
    ok(rating.includes("| 0 | 0 |"), "zero diff unsigned: " + rating);
}

// Log errors are grouped with colour codes, source prefix and numbers stripped.
{
    const log = [
        "\x1b[31mERROR[D:\\a\\src\\RideSetSettingAction.cpp:98 (Query)]: Invalid operation option value: 32\x1b[0m",
        "\x1b[31mERROR[D:\\a\\src\\RideSetSettingAction.cpp:98 (Query)]: Invalid operation option value: 8\x1b[0m",
        "[Trash Manager] Started",
        "ERROR[x.cpp:1 (f)]: Staff entity not found for spriteID 164",
    ].join("\r\n");
    const c = countLogErrors(log);
    ok(c["Invalid operation option value: N"] === 2, "grouped ride errors " + JSON.stringify(c));
    ok(c["Staff entity not found for spriteID N"] === 1, "staff error");
    ok(Object.keys(c).length === 2, "only ERROR lines counted");
}

// #63 verdicts: effect vs same-arm replicate spread.
{
    const a = classifyEffect([110, 114], [100, 102], 1);
    ok(a.effect === 11 && a.noise === 4 && a.verdict === "improved", "improved " + JSON.stringify(a));
    ok(classifyEffect([110, 114], [100, 102], -1).verdict === "worse", "lower-is-better flips the verdict");
    ok(classifyEffect([100, 110], [102, 104], 1).verdict === "noise", "effect 2 within spread 10 is noise");
    ok(classifyEffect([5, 5], [5, 5], 1).verdict === "noise", "identical arms are noise, not a win");
    ok(classifyEffect([1, 1], [5, 5], 0).verdict === "down", "unjudged metric reports direction only");
    ok(classifyEffect([1], [5, 5], 1) === null, "needs two replicates per arm");
    ok(classifyEffect([1, null], [5, 5], 1) === null, "missing value is null");
}

// Roll-up value: end by default, mean for per-day counts.
{
    const sum = summariseRun([{ day: 0, breakdowns: 0, vomit: 1 }, { day: 1, breakdowns: 4, vomit: 3 }]);
    const byKey = Object.fromEntries(METRICS.map((m) => [m.key, m]));
    ok(metricValue(sum, byKey.breakdowns) === 2, "breakdowns use the mean");
    ok(metricValue(sum, byKey.vomit) === 3, "vomit uses the end value");
    ok(METRICS.every((m) => m.better === 1 || m.better === -1 || m.better === 0), "every metric has a direction");
}

console.log(`${pass} passed, ${fail} failed`);
if (fail > 0) process.exitCode = 1;
