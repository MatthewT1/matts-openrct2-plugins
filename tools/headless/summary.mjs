/**
 * Pure summary maths for the headless harness (#46). No I/O, unit-tested in
 * tests/headless-summary.test.mjs.
 */

/** Metrics compared between arms, in report order. `money` ones are in game units (tenths of a currency unit). */
export const METRICS = [
    { key: "rating", label: "Park rating" },
    { key: "guests", label: "Guests" },
    { key: "avgHappiness", label: "Avg happiness" },
    { key: "cash", label: "Cash", money: true },
    { key: "companyValue", label: "Company value", money: true },
    { key: "totalAdmissions", label: "Admissions" },
    { key: "litter", label: "Litter" },
    { key: "handymen", label: "Handymen" },
    { key: "mechanics", label: "Mechanics" },
    { key: "entertainers", label: "Entertainers" },
    { key: "openRides", label: "Open rides" },
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
