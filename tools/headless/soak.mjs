/**
 * Per-PR soak test for a stack of branches: every build x a seeded draw of parks, 30 d, run in
 * parallel through pool.mjs, then one report comparing each arm with the PREVIOUS arm.
 *
 *   node tools/headless/soak.mjs --builds <dir> [--tag soak] [--seed 12] [--parks 12] [--k 4] [--days 30]
 *   node tools/headless/soak.mjs --builds <dir> --report     (report only, from finished runs)
 *
 * <dir> holds one plugin folder per arm, run in name order (e.g. 0-main, 1-cheap-builds-81, ...),
 * each with the seven built plugin .js files. Parks come from the #63 viability pool
 * (harness-runs/viability-seed63, parks with verdicts.json); Magic Mountain and Jetlag Heights
 * are always in. Each park gets one random RNG perturb (1-9) shared by all arms.
 * Output: harness-runs/<tag>/<arm>/<park>/ and harness-runs/<tag>/report.md.
 */

import { existsSync, readdirSync, readFileSync, statSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { METRICS, metricValue } from "./summary.mjs";
import { runPool } from "./pool.mjs";

const POOL = "harness-runs/viability-seed63";
const ALWAYS = ["Magic_Mountain", "Jetlag_Heights"];
/** Metric keys checked, and how much worse the median may be before the arm fails (money in GBP). */
const LIMITS = { rating: 20, avgHappiness: 3, guests: 50, cash: 500, salesCum: 500, thQueuingAges: 20, thCrowded: 20, thHungry: 20, thThirsty: 20, thLost: 20 };
/** An arm fails a metric when it is worse than the previous arm in at least this share of parks. */
const WORSE_SHARE = 0.75;

const argv = process.argv.slice(2);
const opt = (k, d) => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : d; };
const BUILDS = opt("--builds"), TAG = opt("--tag", "soak"), SEED = Number(opt("--seed", 12));
const NPARKS = Number(opt("--parks", 12)), K = Number(opt("--k", 4)), DAYS = Number(opt("--days", 30));
if (!BUILDS) throw new Error("--builds <dir> is required");
const OUT = join("harness-runs", TAG);

/** mulberry32: small seeded RNG so the park draw and perturbs repeat for a seed. */
function rng(seed) {
    let a = seed >>> 0;
    return () => { a = (a + 0x6d2b79f5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}

const arms = readdirSync(BUILDS).filter((d) => statSync(join(BUILDS, d)).isDirectory()).sort();
const rand = rng(SEED);
const pool = readdirSync(POOL).filter((d) => existsSync(join(POOL, d, "verdicts.json")))
    .map((d) => ({ dir: d, save: JSON.parse(readFileSync(join(POOL, d, "verdicts.json"), "utf8")).park.file }));
// Stratified draw: always-in parks first, then alternate between mature saves and scenarios.
const always = pool.filter((p) => ALWAYS.some((s) => p.dir.includes(s)));
const shuffle = (xs) => xs.map((x) => [rand(), x]).sort((a, b) => a[0] - b[0]).map((x) => x[1]);
const saves = shuffle(pool.filter((p) => !always.includes(p) && p.dir.startsWith("save-")));
const scen = shuffle(pool.filter((p) => !always.includes(p) && !p.dir.startsWith("save-")));
const parks = [...always];
while (parks.length < NPARKS && (saves.length || scen.length)) {
    if (saves.length) parks.push(saves.shift());
    if (parks.length < NPARKS && scen.length) parks.push(scen.shift());
}
for (const p of parks) p.perturb = 1 + Math.floor(rand() * 9);

if (!argv.includes("--report")) {
    const jobs = [];
    for (const p of parks) for (const arm of arms) jobs.push({ save: p.save, out: join(OUT, arm, p.dir), pluginDir: join(BUILDS, arm), perturb: p.perturb, days: DAYS, settings: "defaults" });
    mkdirSync(OUT, { recursive: true });
    const t = Date.now();
    const res = await runPool(jobs, K, (r, n) => console.log(`[${n + 1}/${jobs.length}] ${r.status} ${r.seconds.toFixed(0)} s ${r.job.out}`));
    writeFileSync(join(OUT, "pool.json"), JSON.stringify({ seed: SEED, k: K, wallSeconds: (Date.now() - t) / 1000, results: res.map((r) => ({ out: r.job.out, status: r.status, seconds: r.seconds })) }, null, 2));
}

// ---- report ----
const load = (arm, p) => { const f = join(OUT, arm, p.dir, "summary.json"); return existsSync(f) ? JSON.parse(readFileSync(f, "utf8")).arms.on : null; };
const R = Object.fromEntries(arms.map((arm) => [arm, parks.map((p) => load(arm, p))]));
const poolInfo = existsSync(join(OUT, "pool.json")) ? JSON.parse(readFileSync(join(OUT, "pool.json"), "utf8")) : null;
const L = [`# Soak test \`${TAG}\`: ${arms.length} arms x ${parks.length} parks, ${DAYS} d, --settings defaults, seed ${SEED}`, ""];
if (poolInfo) L.push(`Wall time ${(poolInfo.wallSeconds / 60).toFixed(1)} min at K=${poolInfo.k}.`, "");
L.push(`Parks (perturb): ${parks.map((p) => `${p.dir} (${p.perturb})`).join(", ")}`, "");

L.push("## Health and firing", "", "Deltas are summed over parks (end of run minus day 0). Runs are not exact repeats: scenario parks are seeded from the clock (Scenario.cpp:78), so treat single-park differences as noise.", "",
    "| Arm | runs ok | game-log errors | kiosks + | ATMs + | umbrella stalls + | queue TVs + | stalls + | court stalls/amenities/toilets + | entertainers + |", "|---|---|---|---|---|---|---|---|---|---|");
const health = {};
let prevErrs = null;
for (const arm of arms) {
    const rs = R[arm], ok = rs.filter(Boolean);
    const errs = ok.reduce((n, r) => n + Object.values(r.errors ?? {}).reduce((a, b) => a + b, 0), 0);
    const d = (k) => ok.reduce((n, r) => n + ((r.census?.end?.[k] ?? 0) - (r.census?.start?.[k] ?? 0)), 0);
    const ent = ok.reduce((n, r) => n + (r.summary.metrics.entertainers?.change ?? 0), 0);
    // Game-log errors fail an arm only when there are clearly more than in the previous arm
    // (main already logs a few "Staff entity not found" per run).
    health[arm] = { ok: ok.length === parks.length && (prevErrs === null || errs <= prevErrs + parks.length / 2) };
    prevErrs = errs;
    L.push(`| ${arm} | ${ok.length}/${parks.length} | ${errs} | ${d("kiosks")} | ${d("atms")} | ${d("umbrellaStalls")} | ${d("queueTvs")} | ${d("stalls")} | ${d("courtStalls")}/${d("courtAmenities")}/${d("courtToilets")} | ${ent} |`);
}
L.push("", "Invariants: kiosks built per park <= 6; plugin entertainer cap 7 (only checked where the park started with none).", "");
const inv = [];
for (const arm of arms) R[arm].forEach((r, i) => {
    if (!r?.census?.end) return;
    const kd = r.census.end.kiosks - r.census.start.kiosks;
    if (kd > 6) inv.push(`${arm} ${parks[i].dir}: ${kd} kiosks built`);
    const e0 = r.summary.metrics.entertainers?.start ?? 0, emax = r.summary.metrics.entertainers?.max ?? 0;
    if (e0 === 0 && emax > 7) inv.push(`${arm} ${parks[i].dir}: ${emax} entertainers`);
});
L.push(inv.length ? inv.map((x) => `- BROKEN: ${x}`).join("\n") : "- all held", "");

L.push("## Each arm vs the previous arm", "", `Fail = worse in >= ${Math.round(WORSE_SHARE * 100)}% of parks, or median worse by more than the limit (money in GBP).`, "",
    `| Metric (limit) | ${arms.slice(1).join(" | ")} |`, `|---|${arms.slice(1).map(() => "---").join("|")}|`);
const verdict = Object.fromEntries(arms.slice(1).map((a) => [a, []]));
for (const [key, limit] of Object.entries(LIMITS)) {
    const m = METRICS.find((x) => x.key === key);
    const cells = arms.slice(1).map((arm, j) => {
        const prev = arms[j];
        const deltas = [];
        parks.forEach((_, i) => {
            const a = R[arm][i], b = R[prev][i];
            if (!a || !b) return;
            const va = metricValue(a.summary, m), vb = metricValue(b.summary, m);
            if (va == null || vb == null) return;
            deltas.push(((va - vb) * m.better) / (m.money ? 10 : 1)); // + = better
        });
        if (!deltas.length) return "-";
        const worse = deltas.filter((x) => x < 0).length, better = deltas.filter((x) => x > 0).length;
        const med = [...deltas].sort((x, y) => x - y)[Math.floor(deltas.length / 2)];
        const fail = worse >= Math.ceil(WORSE_SHARE * deltas.length) || med < -limit;
        if (fail) verdict[arm].push(key);
        return `${fail ? "**FAIL** " : ""}${better}+/${worse}- med ${med >= 0 ? "+" : ""}${med.toFixed(1)}`;
    });
    L.push(`| ${m.label} (${limit}) | ${cells.join(" | ")} |`);
}
L.push("", "## Verdict", "");
for (const arm of arms.slice(1)) {
    const bad = [...verdict[arm], ...(health[arm].ok ? [] : ["health"])];
    L.push(`- ${arm}: ${bad.length ? `**FAIL** (${bad.join(", ")})` : "pass"}`);
}
writeFileSync(join(OUT, "report.md"), L.join("\n") + "\n");
console.log(`written ${join(OUT, "report.md")}`);
