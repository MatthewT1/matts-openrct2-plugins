// #49 matrix driver: random saves (seeded) x speeds, plugins on vs off.
//   node tools/headless/matrix.mjs broad [--settings save|defaults|all|<json>] [--post]
//     -> 5 random saves (seed 49), speed 4, 60 days, on/off  (~20 min)
//   node tools/headless/matrix.mjs speed [--settings ...] [--post]
//     -> first random save, speeds 1 and 4, 14 days, on/off  (~15 min)
// Writes harness-runs/matrix-seed49-<settings>-<mode>/. --post comments each save's summary on #49.
import { readdirSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
const MODE = process.argv[2];
const flag = (name) => { const i = process.argv.indexOf(name); return i > 0 ? process.argv[i + 1] : undefined; };
const SETTINGS = flag("--settings") ?? "save", POST = process.argv.includes("--post"), DEBUG = process.argv.includes("--debug");
if (MODE !== "broad" && MODE !== "speed") { console.error("usage: node matrix.mjs broad|speed [--settings ...] [--post] [--debug]"); process.exit(1); }
const SEED = 49, N = MODE === "broad" ? 5 : 1, SPEEDS = MODE === "broad" ? [4] : [1, 4], DAYS = MODE === "broad" ? 60 : 14;
const repo = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const saveDir = "C:/Users/Matt/Documents/OpenRCT2/save";
const outRoot = join(repo, "harness-runs", SETTINGS === "save" ? `matrix-seed${SEED}-${MODE}` : `matrix-seed${SEED}-${SETTINGS.replace(/[^\w-]+/g, "_")}-${MODE}`);
function mulberry32(a) { return () => { a |= 0; a = (a + 0x6d2b79f5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }
const all = readdirSync(saveDir).filter((f) => /\.(park|sv6)$/i.test(f)).sort();
const rnd = mulberry32(SEED), pool = [...all], picks = [];
while (picks.length < N && pool.length) picks.push(pool.splice(Math.floor(rnd() * pool.length), 1)[0]);
mkdirSync(outRoot, { recursive: true });
writeFileSync(join(outRoot, "picks.json"), JSON.stringify({ mode: MODE, seed: SEED, settings: SETTINGS, days: DAYS, speeds: SPEEDS, pool: all, picks }, null, 2));
console.log("picks", picks);
for (const save of picks) {
    const parts = [`### ${save}\n\nMode ${MODE}, seed ${SEED}, ${DAYS} days per arm, plugins on vs off (our six), \`--settings ${SETTINGS}\`.`];
    for (const speed of SPEEDS) {
        const out = join(outRoot, save.replace(/[^\w.-]+/g, "_"), `speed${speed}`);
        const t0 = Date.now();
        const r = spawnSync(process.execPath, ["tools/headless/run.mjs", "--save", join(saveDir, save), "--days", String(DAYS), "--speed", String(speed), "--settings", SETTINGS, "--out", out, ...(DEBUG ? ["--debug"] : [])], { cwd: repo, encoding: "utf8", timeout: 45 * 60 * 1000 });
        const mins = ((Date.now() - t0) / 60000).toFixed(1);
        console.log(save, speed, "exit", r.status, mins, "min");
        let body;
        try { body = readFileSync(join(out, "summary.md"), "utf8"); }
        catch { body = "Run failed (exit " + r.status + "):\n```\n" + String(r.stderr || r.error || "").slice(-1500) + "\n```"; }
        parts.push(`#### Speed ${speed} (${mins} min wall clock)\n\n` + body.replace(/^# .*\n/m, ""));
    }
    const file = join(outRoot, save.replace(/[^\w.-]+/g, "_") + ".md");
    writeFileSync(file, parts.join("\n\n"));
    if (!POST) continue;
    const g = spawnSync("gh", ["issue", "comment", "49", "--body-file", file], { cwd: repo, encoding: "utf8" });
    console.log("posted", save, g.status, (g.stdout || g.stderr).trim());
}
console.log("DONE");
