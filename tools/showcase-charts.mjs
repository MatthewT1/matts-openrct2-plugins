/**
 * README charts (#140): each plugin's own measure, plugins off vs defaults vs everything on.
 * Dependency-free SVGs with light/dark colours, so GitHub renders them in either theme.
 *
 *   node tools/showcase-charts.mjs [--run harness-runs/showcase-140] [--out docs/img/showcase]
 *
 * Reads <run>/<park>/<rep>/defaults/{off,on}/days.csv and <run>/<park>/<rep>/all/on/days.csv
 * (tools/headless/pool.mjs with tools/headless/showcase.jobs.json), averages each day across
 * every park and replicate that has all three arms, and prints an end-of-run table. Each mean line
 * has a shaded min/max band across parks (each park = mean of its replicates) so the spread shows.
 */

import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const argv = process.argv.slice(2);
const opt = (k, d) => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : d; };
const RUN = opt("--run", "harness-runs/showcase-140"), OUT = opt("--out", "docs/img/showcase");

const sum = (...keys) => (r) => keys.reduce((s, k) => s + r[k], 0);
const CHARTS = [
    { file: "overview", panels: [
        { title: "Guest happiness", unit: "%", get: (r) => (r.avgHappiness / 255) * 100 },
        { title: "Guests in the park", get: (r) => r.guests },
        { title: "Park rating", get: (r) => r.rating },
    ] },
    { file: "trash-manager", panels: [
        { title: "Litter and vomit on paths", get: sum("litter", "vomit") },
        { title: "Guests put off by dirty paths", get: sum("thLitter", "thPathDisgusting") },
    ] },
    { file: "auto-builder", panels: [
        { title: "Guests hungry, thirsty or needing a toilet", get: sum("thHungry", "thThirsty", "thToilet") },
        { title: "Guests who are lost", get: (r) => r.thLost },
    ] },
    { file: "wait-time-optimizer", panels: [
        { title: "Guests fed up with queuing", get: (r) => r.thQueuingAges },
    ] },
    { file: "mechanic-manager", panels: [
        { title: "Rides broken down", get: (r) => r.ridesBroken },
        { title: "Average ride downtime", unit: "%", get: (r) => r.avgDowntime },
    ] },
    { file: "staff-extras", panels: [
        { title: "Guest happiness", unit: "%", get: (r) => (r.avgHappiness / 255) * 100 },
        { title: "Guests fed up with queuing", get: (r) => r.thQueuingAges },
        { title: "Guests upset by vandalism", get: (r) => r.thVandalism },
    ] },
];
const ARMS = [
    { key: "off", label: "plugins off", path: ["defaults", "off"] },
    { key: "def", label: "defaults", path: ["defaults", "on"] },
    { key: "all", label: "every feature on", path: ["all", "on"] },
];

function readCsv(f) {
    const [head, ...lines] = readFileSync(f, "utf8").trim().split(/\r?\n/);
    const cols = head.split(",");
    return lines.map((l) => { const v = l.split(","); return Object.fromEntries(cols.map((c, i) => [c, Number(v[i])])); });
}

const runs = { off: [], def: [], all: [] };
const parks = new Set(), runPark = [];
for (const park of readdirSync(RUN)) {
    if (!existsSync(join(RUN, park)) || park.endsWith(".json")) continue;
    for (const rep of readdirSync(join(RUN, park))) {
        const files = ARMS.map((a) => join(RUN, park, rep, a.path[0], a.path[1], "days.csv"));
        if (!files.every(existsSync)) continue;
        ARMS.forEach((a, i) => runs[a.key].push(readCsv(files[i])));
        parks.add(park); runPark.push(park);
    }
}
const n = runs.off.length;
if (!n) throw new Error(`no complete runs under ${RUN}`);
const days = Math.min(...Object.values(runs).flat().map((r) => r.length));
const series = (key, panel) => Array.from({ length: days }, (_, d) => runs[key].reduce((s, r) => s + panel.get(r[d]), 0) / n);
const parkList = [...parks];
const reps = parkList.map((p) => runPark.filter((q) => q === p).length);
const runsLabel = reps.every((r) => r === reps[0])
    ? `${parkList.length} parks, ${reps[0]} perturbed replicates each` : `${parkList.length} parks, ${n} runs`;
/** Per day, min and max across parks of each park's replicate mean. */
function band(key, panel) {
    const per = parkList.map((p) => runs[key].filter((_, i) => runPark[i] === p));
    return Array.from({ length: days }, (_, d) => {
        const v = per.map((rs) => rs.reduce((s, r) => s + panel.get(r[d]), 0) / rs.length);
        return [Math.min(...v), Math.max(...v)];
    });
}

const W = 330, H = 180, PAD = { l: 50, r: 12, t: 34, b: 28 }, GAP = 16;
const fmt = (v) => Math.abs(v) >= 10000 ? `${Math.round(v / 1000)}k` : Math.abs(v) >= 100 ? `${Math.round(v)}` : v.toFixed(1).replace(/\.0$/, "");
mkdirSync(OUT, { recursive: true });
const table = [];

for (const chart of CHARTS) {
    const total = chart.panels.length * W + (chart.panels.length - 1) * GAP;
    const svg = [`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${total} ${H + 60}" width="${total}" height="${H + 60}" font-family="-apple-system, Segoe UI, Helvetica, Arial, sans-serif">`,
        `<style>
  .bg{fill:#ffffff} .ax{stroke:#d0d7de} .tx{fill:#57606a;font-size:11px} .tt{fill:#1f2328;font-size:13px;font-weight:600}
  .def{stroke:#1a7f37;fill:none;stroke-width:2.5} .all{stroke:#0969da;fill:none;stroke-width:2;stroke-dasharray:1 3;stroke-linecap:round}
  .off{stroke:#8c959f;fill:none;stroke-width:2;stroke-dasharray:5 4}
  .boff{fill:#8c959f;fill-opacity:.12} .bdef{fill:#1a7f37;fill-opacity:.14} .ball{fill:#0969da;fill-opacity:.10} .ldef{fill:#1a7f37} .lall{fill:#0969da} .loff{fill:#8c959f}
  @media (prefers-color-scheme: dark){ .bg{fill:#0d1117} .ax{stroke:#30363d} .tx{fill:#8b949e} .tt{fill:#e6edf3}
    .def{stroke:#3fb950} .bdef{fill:#3fb950} .ball{fill:#58a6ff} .boff{fill:#6e7681} .ldef{fill:#3fb950} .all{stroke:#58a6ff} .lall{fill:#58a6ff} .off{stroke:#6e7681} .loff{fill:#6e7681} }
</style>`, `<rect class="bg" width="100%" height="100%" rx="8"/>`];
    chart.panels.forEach((panel, i) => {
        const x0 = i * (W + GAP);
        const s = Object.fromEntries(ARMS.map((a) => [a.key, series(a.key, panel)]));
        const b = Object.fromEntries(ARMS.map((a) => [a.key, band(a.key, panel)]));
        const vals = [...Object.values(s).flat(), ...Object.values(b).flat(2)];
        let lo = Math.min(...vals), hi = Math.max(...vals);
        const span = hi - lo || 1;
        lo = Math.max(0, lo - span * 0.1); hi = hi + span * 0.1;
        const px = (d) => x0 + PAD.l + (d / (days - 1)) * (W - PAD.l - PAD.r);
        const py = (v) => PAD.t + (1 - (v - lo) / (hi - lo)) * (H - PAD.t - PAD.b);
        const path = (a) => a.map((v, d) => `${d ? "L" : "M"}${px(d).toFixed(1)},${py(v).toFixed(1)}`).join("");
        svg.push(`<text class="tt" x="${x0 + 12}" y="20">${panel.title}</text>`);
        for (const t of [lo, (lo + hi) / 2, hi]) {
            svg.push(`<line class="ax" x1="${x0 + PAD.l}" x2="${x0 + W - PAD.r}" y1="${py(t).toFixed(1)}" y2="${py(t).toFixed(1)}"/>`);
            svg.push(`<text class="tx" x="${x0 + PAD.l - 6}" y="${(py(t) + 4).toFixed(1)}" text-anchor="end">${fmt(t)}${panel.unit ?? ""}</text>`);
        }
        svg.push(`<text class="tx" x="${px(0)}" y="${H - 8}">day 0</text><text class="tx" x="${px(days - 1)}" y="${H - 8}" text-anchor="end">day ${days - 1}</text>`);
        const area = (a) => a.map(([, h], d) => `${d ? "L" : "M"}${px(d).toFixed(1)},${py(h).toFixed(1)}`).join("")
            + a.map((_, d) => d).reverse().map((d) => `L${px(d).toFixed(1)},${py(a[d][0]).toFixed(1)}`).join("") + "Z";
        for (const a of ARMS) svg.push(`<path class="b${a.key}" d="${area(b[a.key])}"/>`);
        svg.push(`<path class="off" d="${path(s.off)}"/><path class="all" d="${path(s.all)}"/><path class="def" d="${path(s.def)}"/>`);
        table.push(`| ${chart.file} | ${panel.title} | ${fmt(s.off[days - 1])} | ${fmt(s.def[days - 1])} | ${fmt(s.all[days - 1])} |`);
    });
    const ly = H + 16;
    let lx = 12;
    for (const a of ARMS) {
        svg.push(`<rect class="l${a.key}" x="${lx}" y="${ly - 9}" width="18" height="4" rx="2"/><text class="tx" x="${lx + 24}" y="${ly - 3}">${a.label}</text>`);
        lx += 24 + a.label.length * 6 + 14;
    }
    svg.push(`<text class="tx" x="12" y="${ly + 15}">line = mean, band = min-max across parks</text>`,
        `<text class="tx" x="12" y="${ly + 30}">${runsLabel}, ${days - 1} days</text>`, `</svg>`);
    writeFileSync(join(OUT, `${chart.file}.svg`), svg.join("\n") + "\n");
}
console.log(`${n} runs (${runsLabel}), ${days} days -> ${OUT}\n`);
console.log("| Chart | Measure | off | defaults | all on |\n|---|---|---|---|---|\n" + table.join("\n"));
