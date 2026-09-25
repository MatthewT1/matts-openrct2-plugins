// #63 viability study driver: seeded random parks, plugins on vs off, noise from RNG-perturbed replicates.
//   node tools/headless/viability.mjs run --parks 5 [--seed 63] [--days 60] [--settings all] [--post]
//     Walks a seeded shuffle of the pool (saves + scenarios), skipping parks already done or skipped,
//     until --parks new parks are done. Each park = 4 arms: off/on x perturb 0/1 (~8 min at 60 d).
//     Parks with < 5 open rides on day 0 are skipped (the plugins manage parks, they don't build rides).
//   node tools/headless/viability.mjs rollup [--seed 63] [--post]
//     Per metric: parks improved / worse / within noise, from every park done so far.
// Output: harness-runs/viability-seed<seed>/. --post comments on #63.
import { readdirSync, readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { join, dirname, basename } from "node:path";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";
import { METRICS, classifyEffect, metricValue } from "./summary.mjs";

const CMD = process.argv[2];
const flag = (name, def) => { const i = process.argv.indexOf(name); return i > 0 ? process.argv[i + 1] : def; };
const SEED = Number(flag("--seed", "63")), PARKS = Number(flag("--parks", "5")), DAYS = Number(flag("--days", "60"));
const SETTINGS = flag("--settings", "all"), POST = process.argv.includes("--post"), MIN_RIDES = 5, ISSUE = "63";
if (CMD !== "run" && CMD !== "rollup") { console.error("usage: node viability.mjs run|rollup [--parks N] [--seed S] [--post]"); process.exit(1); }

const repo = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const outRoot = join(repo, "harness-runs", `viability-seed${SEED}`);
// The original RCT2/RCT1 scenario folders are wherever the games are installed: set them with
// RCT2_SCENARIOS / RCT1_SCENARIOS or in tools/headless/pool.local.json (gitignored), e.g.
// {"rct2": "D:/Games/RCT2/Scenarios", "rct1": "D:/Games/RCT1/Scenarios"}. A missing folder is
// skipped, which changes the pool and so the seeded park order; #63 used all four.
const userDir = join(homedir(), "Documents", "OpenRCT2");
const localPool = existsSync(join(repo, "tools", "headless", "pool.local.json"))
    ? JSON.parse(readFileSync(join(repo, "tools", "headless", "pool.local.json"), "utf8")) : {};
const POOL_DIRS = [
    ["save", join(userDir, "save"), /\.(park|sv6)$/i],
    ["scenario", join(userDir, "scenario"), /\.(park|sc6|sc4)$/i],
    ["rct2", process.env.RCT2_SCENARIOS ?? localPool.rct2, /\.sc6$/i],
    ["rct1", process.env.RCT1_SCENARIOS ?? localPool.rct1, /\.sc4$/i],
];
const ARMS = [["off", 0], ["off", 1], ["on", 0], ["on", 1]];
const slug = (s) => s.replace(/[^\w.-]+/g, "_");
const post = (file) => {
    const g = spawnSync("gh", ["issue", "comment", ISSUE, "--body-file", file], { cwd: repo, encoding: "utf8" });
    console.log("posted", g.status, (g.stdout || g.stderr).trim());
};

function mulberry32(a) { return () => { a |= 0; a = (a + 0x6d2b79f5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }

function pool() {
    const all = [];
    for (const [src, dir, re] of POOL_DIRS) {
        if (!dir || !existsSync(dir)) { console.log("pool dir missing:", src, dir ?? "(not set)"); continue; }
        for (const f of readdirSync(dir).filter((x) => re.test(x)).sort()) all.push({ src, file: join(dir, f) });
    }
    const rnd = mulberry32(SEED);
    for (let i = all.length - 1; i > 0; i--) { const j = Math.floor(rnd() * (i + 1)); [all[i], all[j]] = [all[j], all[i]]; }
    return all;
}

function fmt(v, m) {
    if (v === null || v === undefined) return "-";
    const x = m.money ? v / 10 : v;
    return Number.isInteger(x) ? String(x) : x.toFixed(1);
}

function runPark(p, dir) {
    const sums = [];
    for (const [arm, perturb] of ARMS) {
        const out = join(dir, `${arm}-p${perturb}`);
        const args = ["tools/headless/run.mjs", "--save", p.file, "--days", String(DAYS), "--arms", arm, "--perturb", String(perturb), "--settings", SETTINGS, "--out", out];
        if (sums.length === 0) args.push("--min-open-rides", String(MIN_RIDES));
        const r = spawnSync(process.execPath, args, { cwd: repo, encoding: "utf8", timeout: 30 * 60 * 1000 });
        if (r.status === 3) return { skipped: (r.stderr.match(/skipped: .*/) || ["skipped"])[0] };
        if (r.status !== 0) return { failed: `${arm}-p${perturb} exit ${r.status}: ${String(r.stderr || r.error).slice(-400)}` };
        const j = JSON.parse(readFileSync(join(out, "summary.json"), "utf8"));
        sums.push({ arm, perturb, summary: j.arms[arm].summary, start: j.arms[arm].start, seconds: j.arms[arm].seconds, errors: j.arms[arm].errors });
    }
    const verdicts = {};
    for (const m of METRICS) {
        const v = (arm) => sums.filter((s) => s.arm === arm).map((s) => metricValue(s.summary, m));
        verdicts[m.key] = { off: v("off"), on: v("on"), ...classifyEffect(v("on"), v("off"), m.better) };
    }
    return { sums, verdicts };
}

function parkReport(p, res) {
    const s0 = res.sums[0];
    const lines = [`### ${basename(p.file)} (${p.src})`, "",
        `Seed ${SEED}, ${DAYS} days, speed 4, \`--settings ${SETTINGS}\`. Start ${s0.start?.date}, ${s0.start?.openRides} open rides. ` +
        `Replicates p0/p1 = scenario RNG perturbed 0/1x. Effect = mean(on) - mean(off); noise = larger same-arm spread. ` +
        `Values are end of run (per-day counts: mean over days; money in currency units, *cum = since day 1).`, "",
        "| Metric | off p0 | off p1 | on p0 | on p1 | effect | noise | verdict |", "|---|---|---|---|---|---|---|---|"];
    for (const m of METRICS) {
        const v = res.verdicts[m.key];
        if (!v || v.verdict === undefined) continue;
        const e = v.effect > 0 ? "+" + fmt(v.effect, m) : fmt(v.effect, m);
        lines.push(`| ${m.label} | ${fmt(v.off[0], m)} | ${fmt(v.off[1], m)} | ${fmt(v.on[0], m)} | ${fmt(v.on[1], m)} | ${e} | ${fmt(v.noise, m)} | ${v.verdict} |`);
    }
    const errs = {};
    for (const s of res.sums) if (s.arm === "on") for (const [k, n] of Object.entries(s.errors || {})) errs[k] = (errs[k] ?? 0) + n;
    const top = Object.entries(errs).sort((a, b) => b[1] - a[1]).slice(0, 5);
    if (top.length) lines.push("", "On-arm game log errors (both replicates): " + top.map(([k, n]) => `${n} x \`${k.slice(0, 80)}\``).join("; "));
    return lines.join("\n") + "\n";
}

function run() {
    mkdirSync(outRoot, { recursive: true });
    const statePath = join(outRoot, "state.json");
    const state = existsSync(statePath) ? JSON.parse(readFileSync(statePath, "utf8")) : { seed: SEED, done: [], skipped: [], failed: [] };
    const seen = new Set([...state.done, ...state.skipped.map((x) => x.file), ...state.failed.map((x) => x.file)]);
    let newDone = 0;
    for (const p of pool()) {
        if (newDone >= PARKS) break;
        if (seen.has(p.file)) continue;
        const dir = join(outRoot, slug(`${p.src}-${basename(p.file)}`));
        const t0 = Date.now();
        const res = runPark(p, dir);
        const mins = ((Date.now() - t0) / 60000).toFixed(1);
        console.log(basename(p.file), res.skipped || res.failed || "done", mins, "min");
        if (res.skipped) state.skipped.push({ file: p.file, why: res.skipped });
        else if (res.failed) state.failed.push({ file: p.file, why: res.failed });
        else {
            writeFileSync(join(dir, "verdicts.json"), JSON.stringify({ park: p, verdicts: res.verdicts, start: res.sums[0].start }, null, 2));
            const md = join(dir, "report.md");
            writeFileSync(md, parkReport(p, res));
            if (POST) post(md);
            state.done.push(p.file);
            newDone++;
        }
        writeFileSync(statePath, JSON.stringify(state, null, 2));
    }
    console.log("DONE", newDone, "parks; totals done", state.done.length, "skipped", state.skipped.length, "failed", state.failed.length);
}

function rollup() {
    const state = JSON.parse(readFileSync(join(outRoot, "state.json"), "utf8"));
    const parks = [];
    for (const d of readdirSync(outRoot)) {
        const f = join(outRoot, d, "verdicts.json");
        if (existsSync(f)) parks.push(JSON.parse(readFileSync(f, "utf8")));
    }
    const n = parks.length;
    const lines = [`## Roll-up: ${n} parks (seed ${SEED}, ${DAYS} d, speed 4, \`--settings ${SETTINGS}\`)`, "",
        `Pool walked in seeded order; ${state.skipped.length} skipped (< ${MIN_RIDES} open rides on day 0), ${state.failed.length} failed.`,
        `Rule (fixed before data): worse in >= 60% of parks -> own issue; improved in >= 60% -> supported win; else no evidence.`, "",
        "| Metric | improved | worse | noise | median effect | call |", "|---|---|---|---|---|---|"];
    for (const m of METRICS) {
        const vs = parks.map((p) => p.verdicts[m.key]).filter((v) => v && v.verdict);
        const c = (k) => vs.filter((v) => v.verdict === k).length;
        const eff = vs.map((v) => v.effect).sort((a, b) => a - b);
        const med = eff.length ? eff[Math.floor(eff.length / 2)] : null;
        let call = "-";
        if (m.better) call = c("worse") >= 0.6 * vs.length ? "**WORSE**" : c("improved") >= 0.6 * vs.length ? "**win**" : "no evidence";
        const imp = m.better ? c("improved") : `up ${c("up")}`, wor = m.better ? c("worse") : `down ${c("down")}`;
        lines.push(`| ${m.label} | ${imp} | ${wor} | ${c("noise")} | ${med === null ? "-" : (med > 0 ? "+" : "") + fmt(med, m)} | ${call} |`);
    }
    lines.push("", "Per park (#64 check: guests vs happiness effect):", "", "| Park | open rides d0 | guests effect | happiness effect | cash effect |", "|---|---|---|---|---|");
    for (const p of parks) {
        const e = (k, money) => { const v = p.verdicts[k]; return v && v.verdict ? `${v.effect > 0 ? "+" : ""}${fmt(v.effect, { money })} (${v.verdict})` : "-"; };
        lines.push(`| ${basename(p.park.file)} | ${p.start?.openRides} | ${e("guests")} | ${e("avgHappiness")} | ${e("cash", true)} |`);
    }
    const md = join(outRoot, "rollup.md");
    writeFileSync(md, lines.join("\n") + "\n");
    console.log(`written ${md}`);
    if (POST) post(md);
}

if (CMD === "run") run(); else rollup();
