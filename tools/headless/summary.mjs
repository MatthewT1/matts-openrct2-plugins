/**
 * Pure summary maths for the headless harness (#46). No I/O, unit-tested in
 * tests/headless-summary.test.mjs.
 */

/**
 * Metrics compared between arms, in report order. `money` ones are in game units (tenths of a
 * currency unit). `better` is the good direction (1 higher, -1 lower, 0 not judged), used by the
 * #63 roll-up, which compares the end value, or the mean over days when `agg` is "mean" (per-day
 * counts, where one day's value says little). `*Cum` money rows are totals since day 0 (costs negative).
 */
export const METRICS = [
    { key: "rating", label: "Park rating", better: 1 },
    { key: "guests", label: "Guests", better: 1 },
    { key: "avgHappiness", label: "Avg happiness", better: 1 },
    { key: "cash", label: "Cash", money: true, better: 1 },
    { key: "companyValue", label: "Company value", money: true, better: 1 },
    { key: "totalAdmissions", label: "Admissions", better: 1 },
    { key: "litter", label: "Litter", better: -1 },
    { key: "vomit", label: "Vomit", better: -1 },
    { key: "avgReliability", label: "Avg ride reliability", better: 1 },
    { key: "avgDowntime", label: "Avg ride downtime", better: -1 },
    { key: "ridesBroken", label: "Rides broken now", better: -1, agg: "mean" },
    { key: "breakdowns", label: "Breakdowns that day", better: -1, agg: "mean" },
    { key: "thoughtsNeg", label: "Negative thoughts", better: -1 },
    { key: "thoughtsPos", label: "Positive thoughts", better: 1 },
    { key: "thPathDisgusting", label: "Thought: path disgusting", better: -1 },
    { key: "thLitter", label: "Thought: litter", better: -1 },
    { key: "thVandalism", label: "Thought: vandalism", better: -1 },
    { key: "thSick", label: "Thought: sick", better: -1 },
    { key: "thHungry", label: "Thought: hungry", better: -1 },
    { key: "thThirsty", label: "Thought: thirsty", better: -1 },
    { key: "thToilet", label: "Thought: toilet", better: -1 },
    { key: "thTired", label: "Thought: tired", better: -1 },
    { key: "thLost", label: "Thought: lost / can't find", better: -1 },
    { key: "lostFresh", label: "Lost, award rule (#93)", better: -1 },
    { key: "confusingAward", label: "Confusing-layout rule met (share of days)", better: -1, agg: "mean" },
    { key: "thCrowded", label: "Thought: crowded", better: -1 },
    { key: "thQueuingAges", label: "Thought: queuing ages", better: -1 },
    { key: "thBadValue", label: "Thought: bad value", better: -1 },
    { key: "thCantAfford", label: "Thought: can't afford", better: -1 },
    { key: "thGoodValue", label: "Thought: good value", better: 1 },
    { key: "thVeryClean", label: "Thought: very clean", better: 1 },
    { key: "thScenery", label: "Thought: scenery", better: 1 },
    { key: "thWasGreat", label: "Thought: was great", better: 1 },
    { key: "incomeCum", label: "Income (cum)", money: true, better: 1 },
    { key: "expenseCum", label: "Expenses (cum)", money: true, better: 1 },
    { key: "entranceCum", label: "Entrance tickets (cum)", money: true, better: 1 },
    { key: "rideTicketsCum", label: "Ride tickets (cum)", money: true, better: 1 },
    { key: "salesCum", label: "Shop + food sales (cum)", money: true, better: 1 },
    { key: "stockCum", label: "Shop + food stock (cum)", money: true, better: 0 },
    { key: "wagesCum", label: "Wages (cum)", money: true, better: 0 },
    { key: "runningCostsCum", label: "Ride running costs (cum)", money: true, better: 0 },
    { key: "buildCum", label: "Build + landscape (cum)", money: true, better: 0 },
    { key: "marketingCum", label: "Marketing (cum)", money: true, better: 0 },
    { key: "handymen", label: "Handymen", better: 0 },
    { key: "mechanics", label: "Mechanics", better: 0 },
    { key: "entertainers", label: "Entertainers", better: 0 },
    { key: "openRides", label: "Open rides", better: 0 },
];

/** start / end / change / min / max / mean for one metric over a run's day rows. */
export function summariseMetric(rows, key) {
    const vals = rows.map((r) => r[key]).filter((v) => typeof v === "number");
    if (vals.length === 0) return null;
    let min = vals[0], max = vals[0], sum = 0;
    for (const v of vals) {
        if (v < min) min = v;
        if (v > max) max = v;
        sum += v;
    }
    return {
        start: vals[0],
        end: vals[vals.length - 1],
        change: vals[vals.length - 1] - vals[0],
        min,
        max,
        mean: sum / vals.length,
    };
}

export function summariseRun(rows) {
    const out = { days: rows.length > 0 ? rows[rows.length - 1].day : 0, metrics: {} };
    for (const m of METRICS) out.metrics[m.key] = summariseMetric(rows, m.key);
    return out;
}

/**
 * Compare two arms' summaries. `diffEnd` / `diffMean` are on minus off, null when
 * either side is missing the metric.
 */
export function compareRuns(on, off) {
    const out = {};
    for (const m of METRICS) {
        const a = on.metrics[m.key], b = off.metrics[m.key];
        out[m.key] = a && b ? { diffEnd: a.end - b.end, diffMean: a.mean - b.mean } : null;
    }
    return out;
}

/** CSV text for day rows, columns taken from the first row. */
export function toCsv(rows) {
    if (rows.length === 0) return "";
    const cols = Object.keys(rows[0]).filter((k) => k !== "type");
    const lines = [cols.join(",")];
    for (const r of rows) lines.push(cols.map((c) => String(r[c] ?? "")).join(","));
    return lines.join("\n") + "\n";
}

function fmt(v, money) {
    if (v === null || v === undefined) return "-";
    if (money) return (v / 10).toFixed(0);
    return Number.isInteger(v) ? String(v) : v.toFixed(1);
}

function signed(v, money) {
    if (v === null || v === undefined) return "-";
    const s = fmt(v, money);
    return v > 0 ? "+" + s : s;
}

/** Markdown table: one row per metric, start/end per arm and the on-off difference. */
export function markdownReport(arms) {
    const names = Object.keys(arms);
    const head = ["Metric"];
    for (const n of names) head.push(`${n}: start`, `${n}: end`, `${n}: change`);
    const both = arms.on && arms.off ? compareRuns(arms.on, arms.off) : null;
    if (both) head.push("on - off (end)", "on - off (mean)");
    const lines = ["| " + head.join(" | ") + " |", "|" + head.map(() => "---").join("|") + "|"];
    for (const m of METRICS) {
        const row = [m.label + (m.money ? " (money)" : "")];
        for (const n of names) {
            const s = arms[n].metrics[m.key];
            row.push(fmt(s?.start, m.money), fmt(s?.end, m.money), signed(s?.change, m.money));
        }
        if (both) row.push(signed(both[m.key]?.diffEnd, m.money), signed(both[m.key]?.diffMean, m.money));
        lines.push("| " + row.join(" | ") + " |");
    }
    return lines.join("\n") + "\n";
}

/** Count ERROR lines in a game log, grouped by message with the file/line prefix and ids stripped. */
export function countLogErrors(logText) {
    const counts = {};
    for (const raw of logText.split(/\r?\n/)) {
        // eslint-disable-next-line no-control-regex
        const line = raw.replace(/\x1b\[[0-9;]*m/g, "");
        if (!line.startsWith("ERROR")) continue;
        const msg = line.replace(/^ERROR\[[^\]]*\]:\s*/, "").replace(/\d+/g, "N");
        counts[msg] = (counts[msg] ?? 0) + 1;
    }
    return counts;
}

/**
 * #63 verdict for one park and metric from two replicates (RNG perturbed) of each arm.
 * effect = mean(on) - mean(off); noise = the larger same-arm spread. Within noise when
 * |effect| <= noise; otherwise improved / worse by the metric's good direction (`better`).
 */
export function classifyEffect(on, off, better) {
    if (on.length !== 2 || off.length !== 2 || [...on, ...off].some((v) => typeof v !== "number")) return null;
    const effect = (on[0] + on[1]) / 2 - (off[0] + off[1]) / 2;
    const noise = Math.max(Math.abs(on[0] - on[1]), Math.abs(off[0] - off[1]));
    let verdict;
    if (Math.abs(effect) <= noise) verdict = "noise";
    else if (!better) verdict = effect > 0 ? "up" : "down";
    else verdict = effect * better > 0 ? "improved" : "worse";
    return { effect, noise, verdict };
}

/** The value the roll-up compares for a metric: end, or mean when `agg` is "mean". */
export function metricValue(summary, m) {
    const s = summary.metrics[m.key];
    if (!s) return null;
    return m.agg === "mean" ? s.mean : s.end;
}
