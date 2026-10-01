/**
 * Park pool census (#160): loads every save plus a fixed set of scenarios for one day with no
 * plugins and records what each park looks like on day 0. soak.mjs draws from the result.
 *
 *   node tools/headless/census.mjs [--k 16]
 *
 * Saves: every .park/.sv6 in Documents/OpenRCT2/save (a .sv6 is dropped when a .park of the same
 * name exists). Scenarios: the FIXED list below, found in Documents/OpenRCT2/scenario or the
 * RCT2/RCT1 folders (RCT2_SCENARIOS / RCT1_SCENARIOS or tools/headless/pool.local.json).
 * Output: harness-runs/pool-v2/pool.json and pool.md; runs under harness-runs/pool-v2/census/.
 * A park is in the pool when it loads and has >= MIN_RIDES open rides.
 */

import { existsSync, readdirSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join, dirname, basename } from "node:path";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";
import { runPool } from "./pool.mjs";

export const POOL_DIR = "harness-runs/pool-v2";
export const MIN_RIDES = 5;
/** The small-park check: scenarios that start with >= 5 open rides (the ones #63 kept). */
const FIXED = ["Six Flags Magic Mountain.SC6", "Jetlag Heights.sc6", "Frozen Flats.sc6", "Six Flags Holland.SC6",
    "Dark Age - Robin Hood.SC6", "Mythological - Animatronic Film Set.SC6", "sc8.sc4"];

const here = dirname(fileURLToPath(import.meta.url));
const userDir = join(homedir(), "Documents", "OpenRCT2");
const localFile = join(here, "pool.local.json");
const local = existsSync(localFile) ? JSON.parse(readFileSync(localFile, "utf8")) : {};
const scenarioDirs = [join(userDir, "scenario"), process.env.RCT2_SCENARIOS ?? local.rct2, process.env.RCT1_SCENARIOS ?? local.rct1]
    .filter((d) => d && existsSync(d));
const slug = (s) => s.replace(/[^\w.-]+/g, "_");
const ki = process.argv.indexOf("--k");
const K = ki > 0 ? Number(process.argv[ki + 1]) : 16;

const saveDir = join(userDir, "save");
const saveFiles = readdirSync(saveDir).filter((f) => /\.(park|sv6)$/i.test(f)).sort();
const parks = saveFiles
    .filter((f) => !(/\.sv6$/i.test(f) && saveFiles.includes(f.replace(/\.sv6$/i, ".park"))))
    .map((f) => ({ kind: "save", dir: "save-" + slug(f), save: join(saveDir, f) }));
for (const name of FIXED) {
    const dir = scenarioDirs.find((d) => readdirSync(d).some((f) => f.toLowerCase() === name.toLowerCase()));
    if (!dir) { console.log("fixed scenario not found:", name); continue; }
    parks.push({ kind: "scenario", dir: "scenario-" + slug(name), save: join(dir, readdirSync(dir).find((f) => f.toLowerCase() === name.toLowerCase())) });
}

const jobs = parks.map((p) => ({ save: p.save, out: join(POOL_DIR, "census", p.dir), days: 1, arms: ["off"] }));
mkdirSync(POOL_DIR, { recursive: true });
const res = await runPool(jobs, K, (r, n) => console.log(`[${n + 1}/${jobs.length}] ${r.status} ${r.seconds.toFixed(0)} s ${r.job.out}`));

/** Day-0 row of days.csv as an object. */
function day0(out) {
    const f = join(out, "off", "days.csv");
    if (!existsSync(f)) return {};
    const [head, row] = readFileSync(f, "utf8").trim().split(/\r?\n/);
    const cells = (row ?? "").split(",");
    return Object.fromEntries(head.split(",").map((h, i) => [h, Number(cells[i])]));
}

const rows = parks.map((p, i) => {
    const ok = res[i].status === "ok" || res[i].status === "cached";
    const d = ok ? day0(jobs[i].out) : {};
    const hello = ok ? JSON.parse(readFileSync(join(jobs[i].out, "summary.json"), "utf8")).arms.off.start : null;
    const openRides = hello ? hello.openRides : null;
    return { ...p, loaded: ok, parkName: hello?.parkName ?? null, date: hello?.date ?? null, noMoney: hello?.noMoney ?? null,
        openRides, guests: d.guests ?? null, cash: d.cash ?? null, rating: d.rating ?? null,
        inPool: ok && openRides >= MIN_RIDES };
});
writeFileSync(join(POOL_DIR, "pool.json"), JSON.stringify({ made: new Date().toISOString(), minRides: MIN_RIDES, parks: rows }, null, 2));

const inPool = rows.filter((r) => r.inPool);
const n = (kind) => inPool.filter((r) => r.kind === kind).length;
const L = [`# Park pool (#160): ${inPool.length} parks (${n("save")} saves, ${n("scenario")} fixed scenarios)`, "",
    `In the pool = loads headless and has >= ${MIN_RIDES} open rides on day 0. Cash in GBP.`, "",
    "| Park | kind | open rides | guests | rating | cash | in pool |", "|---|---|---|---|---|---|---|"];
for (const r of [...rows].sort((a, b) => (b.openRides ?? -1) - (a.openRides ?? -1))) {
    L.push(`| ${basename(r.save)} | ${r.kind} | ${r.openRides ?? "-"} | ${r.guests ?? "-"} | ${r.rating ?? "-"} | ${r.cash === null ? "-" : r.noMoney ? "no money" : Math.round(r.cash / 10)} | ${r.inPool ? "yes" : r.loaded ? "no (< " + MIN_RIDES + " rides)" : "no (did not load)"} |`);
}
writeFileSync(join(POOL_DIR, "pool.md"), L.join("\n") + "\n");
console.log(L.join("\n"));
