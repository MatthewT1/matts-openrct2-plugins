/**
 * Randomized ablation trial (#133): per park, all default-on plugins vs all minus ONE plugin
 * (its toggles off via a per-job --settings JSON), for each of the 5 default-on plugins, plus
 * all off (the run.mjs "off" arm: no plugins). Seeded park draw as in soak.mjs. Writes one
 * compact results.md with a verdict per plugin.
 *
 *   node tools/headless/ablation.mjs --plugin-dir dist [--tag ablation-133] [--seed 133] [--parks 16] [--scenarios 3] [--pool census|old] [--k 8] [--days 30] [--report]
 *
 * Rules (pre-registered in #133). Delta per park = full minus ablated, signed so + = better with the plugin.
 * - Works: the plugin's primary claim metric (run mean) is better with it in >= 70% of parks.
 * - Harms: a park-health metric (end of run) is worse with it in >= 75% of parks, or its median
 *   is worse than the limit (rating 20, happiness 3, guests 50, cash GBP 500).
 * - Silent: the plugin's activity metric is identical with and without it in >= 75% of parks.
 * - Otherwise: no effect.
 */

import { existsSync, readdirSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { homedir } from "node:os";
import { runPool } from "./pool.mjs";
import { TOGGLES } from "./settings.mjs";

const POOL = "harness-runs/viability-seed63", CENSUS = "harness-runs/pool-v2/pool.json";
const ALWAYS = ["rct2-Six_Flags_Magic_Mountain", "scenario-Jetlag_Heights"];
const argv = process.argv.slice(2);
const opt = (k, d) => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : d; };
const PDIR = opt("--plugin-dir"), TAG = opt("--tag", "ablation-133"), SEED = Number(opt("--seed", 133));
const NPARKS = Number(opt("--parks", 16)), NSCEN = Number(opt("--scenarios", 3)), POOL_MODE = opt("--pool", "census"), K = Number(opt("--k", 8)), DAYS = Number(opt("--days", 30));
if (!PDIR) throw new Error("--plugin-dir <dir> is required");
const OUT = join("harness-runs", TAG);

/** Each ablated plugin: primary claim metric (mean over the run), support metrics, activity metric. */
const PLUGINS = [
    { name: "Trash Manager", arm: "no-trash", primary: ["litter", "vomit"], support: ["thPathDisgusting", "thLitter"], activity: "handymen" },
    { name: "Auto-Builder", arm: "no-builder", primary: ["thHungry", "thThirsty", "thToilet"], support: ["avgHappiness", "salesCum"], activity: "buildCum" },
    { name: "Mechanic Manager", arm: "no-mechanic", primary: ["avgDowntime"], support: ["ridesBroken", "avgReliability"], activity: "mechanics" },
    { name: "Wait Time Optimizer", arm: "no-wto", primary: ["thQueuingAges"], support: ["thCrowded", "rideTicketsCum"], activity: "rideTicketsCum" },
    { name: "Staff Extras", arm: "no-staff", primary: ["thQueuingAges"], support: ["avgHappiness"], activity: "entertainers" },
];
/** Lower is better for these; everything else here is higher-is-better. */
const LOWER = new Set(["litter", "vomit", "thPathDisgusting", "thLitter", "thHungry", "thThirsty", "thToilet", "avgDowntime", "ridesBroken", "thQueuingAges", "thCrowded"]);
const HEALTH = { rating: 20, guests: 50, avgHappiness: 3, cash: 5000, companyValue: null }; // money limits in tenths of GBP

function rng(seed) {
    let a = seed >>> 0;
    return () => { a = (a + 0x6d2b79f5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}
const rand = rng(SEED);
// Pool (#160): the census pool (harness-runs/pool-v2/pool.json, made by census.mjs): the first
// --scenarios fixed scenarios, then a seeded draw of saves, as in soak.mjs. --pool old keeps the
// #133 draw for comparison.
const shuffle = (xs) => xs.map((x) => [rand(), x]).sort((a, b) => a[0] - b[0]).map((x) => x[1]);
let pool, parks;
if (POOL_MODE === "old") {
    // Pool: every save + scenario the #63 viability walk could draw (tools/headless/pool.local.json for the
    // RCT1/RCT2 folders), minus parks it skipped for too few open rides. Mature = saves, new = scenarios.
    const userDir = join(homedir(), "Documents", "OpenRCT2");
    const local = existsSync("tools/headless/pool.local.json") ? JSON.parse(readFileSync("tools/headless/pool.local.json", "utf8")) : {};
    const skipped = new Set(JSON.parse(readFileSync(join(POOL, "state.json"), "utf8")).skipped.map((x) => x.file));
    pool = [];
    for (const [src, dir, re] of [["save", join(userDir, "save"), /\.(park|sv6)$/i], ["scenario", join(userDir, "scenario"), /\.(park|sc6|sc4)$/i], ["rct2", local.rct2, /\.sc6$/i], ["rct1", local.rct1, /\.sc4$/i]]) {
        if (!dir || !existsSync(dir)) continue;
        for (const f of readdirSync(dir).filter((x) => re.test(x)).sort()) {
            const file = join(dir, f);
            if (!skipped.has(file)) pool.push({ dir: `${src}-${f.replace(/[^\w.-]+/g, "_")}`, save: file });
        }
    }
    const always = pool.filter((p) => ALWAYS.some((s) => p.dir.startsWith(s)));
    const saves = shuffle(pool.filter((p) => !always.includes(p) && p.dir.startsWith("save-")));
    const scen = shuffle(pool.filter((p) => !always.includes(p) && !p.dir.startsWith("save-")));
    parks = [...always];
    while (parks.length < NPARKS && (saves.length || scen.length)) {
        if (saves.length) parks.push(saves.shift());
        if (parks.length < NPARKS && scen.length) parks.push(scen.shift());
    }
} else {
    if (!existsSync(CENSUS)) throw new Error(`${CENSUS} not found: run node tools/headless/census.mjs first`);
    pool = JSON.parse(readFileSync(CENSUS, "utf8")).parks.filter((p) => p.inPool);
    const scen = pool.filter((p) => p.kind === "scenario").slice(0, Math.min(NSCEN, NPARKS));
    parks = [...scen, ...shuffle(pool.filter((p) => p.kind === "save")).slice(0, Math.max(0, NPARKS - scen.length))];
}
for (const p of parks) p.perturb = 1 + Math.floor(rand() * 9);

// Arms: full (defaults), one per ablated plugin, all off.
mkdirSync(OUT, { recursive: true });
const defaults = {};
for (const t of TOGGLES) (defaults[t.plugin] ??= {})[t.key] = t.defaultOn;
const ARMS = [{ arm: "full", settings: "defaults" }];
for (const pl of PLUGINS) {
    const s = structuredClone(defaults);
    for (const key of Object.keys(s[pl.name])) s[pl.name][key] = false;
    const f = resolve(OUT, `${pl.arm}.settings.json`);
    writeFileSync(f, JSON.stringify(s));
    ARMS.push({ arm: pl.arm, settings: f });
}
ARMS.push({ arm: "all-off", settings: "defaults", arms: ["off"] });

if (!argv.includes("--report")) {
    const jobs = [];
    for (const p of parks) for (const a of ARMS) jobs.push({ save: p.save, out: join(OUT, a.arm, p.dir), pluginDir: PDIR, perturb: p.perturb, days: DAYS, settings: a.settings, arms: a.arms, minOpenRides: 5 });
    const t = Date.now();
    const res = await runPool(jobs, K, (r, n) => console.log(`[${n + 1}/${jobs.length}] ${r.status} ${r.seconds.toFixed(0)} s ${r.job.out}`));
    writeFileSync(join(OUT, "pool.json"), JSON.stringify({ seed: SEED, k: K, wallSeconds: (Date.now() - t) / 1000, results: res.map((r) => ({ out: r.job.out, status: r.status, seconds: r.seconds })) }, null, 2));
}

// ---- report ----
const load = (a, p) => {
    const f = join(OUT, a.arm, p.dir, "summary.json");
    if (!existsSync(f)) return null;
    const j = JSON.parse(readFileSync(f, "utf8")).arms;
    return j[a.arms ? a.arms[0] : "on"] ?? null;
};
const R = Object.fromEntries(ARMS.map((a) => [a.arm, parks.map((p) => load(a, p))]));
const mean = (r, k) => r?.summary.metrics[k]?.mean;
const end = (r, k) => r?.summary.metrics[k]?.end;
const sumMean = (r, ks) => { const v = ks.map((k) => mean(r, k)); return v.some((x) => typeof x !== "number") ? null : v.reduce((a, b) => a + b, 0); };
const errs = (r) => Object.values(r?.errors ?? {}).reduce((a, b) => a + b, 0);

/** Per-park deltas (with minus without, + = better with); tally + median. */
function tally(armA, armB, value, lowerBetter, money) {
    const d = [];
    parks.forEach((_, i) => {
        const a = value(R[armA][i]), b = value(R[armB][i]);
        if (typeof a !== "number" || typeof b !== "number") return;
        d.push((a - b) * (lowerBetter ? -1 : 1) / (money ? 10 : 1));
    });
    const better = d.filter((x) => x > 0).length, worse = d.filter((x) => x < 0).length, same = d.length - better - worse;
    const med = d.length ? [...d].sort((x, y) => x - y)[Math.floor(d.length / 2)] : null;
    return { n: d.length, better, worse, same, med };
}
const cell = (t) => t.n ? `${t.better}+/${t.worse}-/${t.same}= med ${t.med >= 0 ? "+" : ""}${t.med.toFixed(1)}` : "-";

const poolInfo = existsSync(join(OUT, "pool.json")) ? JSON.parse(readFileSync(join(OUT, "pool.json"), "utf8")) : null;
const L = [`# Ablation trial \`${TAG}\` (#133): ${ARMS.length} arms x ${parks.length} parks, ${DAYS} d, seed ${SEED}`, ""];
if (poolInfo) L.push(`Wall time ${(poolInfo.wallSeconds / 60).toFixed(1)} min at K=${poolInfo.k}; ${poolInfo.results.filter((r) => r.status.startsWith("failed")).length} failed, ${poolInfo.results.filter((r) => r.status === "skipped").length} skipped.`, "");
L.push(`Parks (perturb): ${parks.map((p) => `${p.dir} (${p.perturb})`).join(", ")}`, "");
L.push("Cells: parks better with the plugin + / worse - / identical =, median delta (with minus without, + = better with; money GBP). Claim metrics use the run mean, health the end of run.", "");
L.push(`| Arm | runs ok | game-log errors |`, `|---|---|---|`);
for (const a of ARMS) L.push(`| ${a.arm} | ${R[a.arm].filter(Boolean).length}/${parks.length} | ${R[a.arm].reduce((n, r) => n + errs(r), 0)} |`);
L.push("");

const verdicts = [];
for (const pl of PLUGINS) {
    L.push(`## ${pl.name} (full vs ${pl.arm})`, "", "| Metric | Result |", "|---|---|");
    const prim = tally("full", pl.arm, (r) => sumMean(r, pl.primary), true, false);
    L.push(`| **primary** ${pl.primary.join("+")} (mean) | ${cell(prim)} |`);
    for (const k of pl.support) L.push(`| ${k} (mean) | ${cell(tally("full", pl.arm, (r) => mean(r, k), LOWER.has(k), k.endsWith("Cum")))} |`);
    const act = tally("full", pl.arm, (r) => mean(r, pl.activity), false, pl.activity.endsWith("Cum"));
    L.push(`| activity ${pl.activity} (mean, identical =) | ${cell(act)} |`);
    const harms = [];
    for (const [k, lim] of Object.entries(HEALTH)) {
        const t = tally("full", pl.arm, (r) => end(r, k), false, k === "cash" || k === "companyValue");
        const limGBP = k === "cash" ? lim / 10 : lim;
        const bad = t.n && (t.worse >= Math.ceil(0.75 * t.n) || (limGBP != null && t.med < -limGBP));
        if (bad) harms.push(k);
        L.push(`| health ${k} (end) | ${bad ? "**HARM** " : ""}${cell(t)} |`);
    }
    const works = prim.n && prim.better >= Math.ceil(0.7 * prim.n);
    const silent = act.n && act.same >= Math.ceil(0.75 * act.n);
    const v = harms.length ? `harms (${harms.join(", ")})` : works ? "works" : "no effect";
    verdicts.push(`| ${pl.name} | ${v}${silent ? " + silent" : ""} | ${prim.better}/${prim.n} parks better on ${pl.primary.join("+")} |`);
    L.push("");
}
L.push("## Suite: full vs all-off", "", "| Metric | Result |", "|---|---|");
for (const k of Object.keys(HEALTH)) L.push(`| ${k} (end) | ${cell(tally("full", "all-off", (r) => end(r, k), false, k === "cash" || k === "companyValue"))} |`);
L.push("", "## Verdicts", "", "| Plugin | Verdict | Primary |", "|---|---|---|", ...verdicts, "");
writeFileSync(join(OUT, "results.md"), L.join("\n") + "\n");
console.log(`written ${join(OUT, "results.md")}`);
