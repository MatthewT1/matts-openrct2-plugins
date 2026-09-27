/**
 * README chart: plugins on vs off, mean per day across the parks of an ablation trial.
 * Dependency-free SVG with light/dark colours, so GitHub renders it in either theme.
 *
 *   node tools/readme-chart.mjs [--run harness-runs/ablation-133] [--out docs/img/plugins-on-vs-off.svg]
 *
 * Reads <run>/full/<park>/on/days.csv and <run>/all-off/<park>/off/days.csv; parks missing
 * either arm are left out.
 */

import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

const argv = process.argv.slice(2);
const opt = (k, d) => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : d; };
const RUN = opt("--run", "harness-runs/ablation-133"), OUT = opt("--out", "docs/img/plugins-on-vs-off.svg");

const PANELS = [
    { key: "avgHappiness", title: "Guest happiness", unit: "%", scale: (v) => (v / 255) * 100 },
    { key: "litter", title: "Litter on paths", unit: "", scale: (v) => v },
    { key: "rating", title: "Park rating", unit: "", scale: (v) => v },
];

function readCsv(f) {
    const [head, ...lines] = readFileSync(f, "utf8").trim().split(/\r?\n/);
    const cols = head.split(",");
    return lines.map((l) => { const v = l.split(","); return Object.fromEntries(cols.map((c, i) => [c, Number(v[i])])); });
}

const parks = readdirSync(join(RUN, "full")).filter((p) =>
    existsSync(join(RUN, "full", p, "on", "days.csv")) && existsSync(join(RUN, "all-off", p, "off", "days.csv")));
const on = parks.map((p) => readCsv(join(RUN, "full", p, "on", "days.csv")));
const off = parks.map((p) => readCsv(join(RUN, "all-off", p, "off", "days.csv")));
const days = Math.min(...on.map((r) => r.length), ...off.map((r) => r.length));

/** Mean of a metric across parks, per day. */
const series = (runs, panel) => Array.from({ length: days }, (_, d) =>
    runs.reduce((s, r) => s + panel.scale(r[d][panel.key]), 0) / runs.length);

const W = 300, H = 170, PAD = { l: 44, r: 12, t: 34, b: 28 }, GAP = 16;
const total = PANELS.length * W + (PANELS.length - 1) * GAP;
const svg = [];
svg.push(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${total} ${H + 30}" width="${total}" height="${H + 30}" font-family="-apple-system, Segoe UI, Helvetica, Arial, sans-serif">`);
svg.push(`<style>
  .bg{fill:#ffffff} .ax{stroke:#d0d7de} .tx{fill:#57606a;font-size:11px} .tt{fill:#1f2328;font-size:13px;font-weight:600}
  .on{stroke:#1a7f37;fill:none;stroke-width:2.5} .off{stroke:#8c959f;fill:none;stroke-width:2;stroke-dasharray:5 4}
  .lon{fill:#1a7f37} .loff{fill:#8c959f}
  @media (prefers-color-scheme: dark){ .bg{fill:#0d1117} .ax{stroke:#30363d} .tx{fill:#8b949e} .tt{fill:#e6edf3}
    .on{stroke:#3fb950} .lon{fill:#3fb950} .off{stroke:#6e7681} .loff{fill:#6e7681} }
</style>`);
svg.push(`<rect class="bg" width="100%" height="100%" rx="8"/>`);

PANELS.forEach((panel, i) => {
    const x0 = i * (W + GAP);
    const a = series(on, panel), b = series(off, panel);
    let lo = Math.min(...a, ...b), hi = Math.max(...a, ...b);
    const span = hi - lo || 1;
    lo = Math.max(0, lo - span * 0.1); hi = hi + span * 0.1;
    const px = (d) => x0 + PAD.l + (d / (days - 1)) * (W - PAD.l - PAD.r);
    const py = (v) => PAD.t + (1 - (v - lo) / (hi - lo)) * (H - PAD.t - PAD.b);
    const path = (s) => s.map((v, d) => `${d ? "L" : "M"}${px(d).toFixed(1)},${py(v).toFixed(1)}`).join("");
    svg.push(`<text class="tt" x="${x0 + PAD.l}" y="20">${panel.title}</text>`);
    for (const t of [lo, (lo + hi) / 2, hi]) {
        svg.push(`<line class="ax" x1="${x0 + PAD.l}" x2="${x0 + W - PAD.r}" y1="${py(t).toFixed(1)}" y2="${py(t).toFixed(1)}"/>`);
        svg.push(`<text class="tx" x="${x0 + PAD.l - 6}" y="${(py(t) + 4).toFixed(1)}" text-anchor="end">${Math.round(t)}${panel.unit}</text>`);
    }
    svg.push(`<text class="tx" x="${px(0)}" y="${H - 8}">day 0</text><text class="tx" x="${px(days - 1)}" y="${H - 8}" text-anchor="end">day ${days - 1}</text>`);
    svg.push(`<path class="off" d="${path(b)}"/><path class="on" d="${path(a)}"/>`);
});

const ly = H + 16;
svg.push(`<rect class="lon" x="${PAD.l}" y="${ly - 9}" width="18" height="4" rx="2"/><text class="tx" x="${PAD.l + 24}" y="${ly - 3}">plugins on (defaults)</text>`);
svg.push(`<rect class="loff" x="${PAD.l + 160}" y="${ly - 9}" width="18" height="4" rx="2"/><text class="tx" x="${PAD.l + 184}" y="${ly - 3}">plugins off</text>`);
svg.push(`<text class="tx" x="${total - PAD.r}" y="${ly - 3}" text-anchor="end">mean of ${parks.length} parks, headless runs, same parks and seeds</text>`);
svg.push(`</svg>`);

mkdirSync(dirname(OUT), { recursive: true });
writeFileSync(OUT, svg.join("\n") + "\n");
console.log(`written ${OUT} (${parks.length} parks, ${days} days)`);
