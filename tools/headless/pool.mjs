/**
 * Parallel pool for headless runs: K run.mjs processes at once, each worker on its own ports
 * (game 11800 + 10*i, agent 47820 + i). Every arm already gets its own userdata folder, so the
 * only shared thing is the debug sink (port 7777): do not pass --debug through the pool.
 *
 *   node tools/headless/pool.mjs <jobs.json> [--k 4]
 *
 * jobs.json is an array of { save, out, days?, perturb?, pluginDir?, settings?, arms? }.
 * A job whose out/summary.json exists is skipped (resume); a failed job is retried once;
 * exit code 3 (park skipped by --min-open-rides) is not retried. Each job's console output
 * goes to <out>/run.log. Also importable: runPool(jobs, k) -> [{ job, status, seconds }].
 */

import { spawn } from "node:child_process";
import { createWriteStream, existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const RUN = join(here, "run.mjs");

function runArgs(job, worker) {
    const args = [RUN, "--save", job.save, "--out", job.out,
        "--days", String(job.days ?? 30), "--arms", (job.arms ?? ["on"]).join(","),
        "--perturb", String(job.perturb ?? 0), "--settings", job.settings ?? "defaults",
        "--game-port", String(11800 + 10 * worker), "--agent-port", String(47820 + worker)];
    if (job.pluginDir) args.push("--plugin-dir", job.pluginDir);
    if (job.speed) args.push("--speed", String(job.speed));
    return args;
}

function runOnce(job, worker) {
    mkdirSync(job.out, { recursive: true });
    const log = createWriteStream(join(job.out, "run.log"), { flags: "a" });
    return new Promise((res) => {
        const p = spawn(process.execPath, runArgs(job, worker), { stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
        p.stdout.pipe(log, { end: false });
        p.stderr.pipe(log, { end: false });
        p.on("close", (code) => { log.end(); res(code); });
    });
}

export async function runPool(jobs, k = 4, onDone = () => {}) {
    const results = [];
    let next = 0;
    async function worker(i) {
        for (;;) {
            const n = next++;
            if (n >= jobs.length) return;
            const job = jobs[n];
            if (existsSync(join(job.out, "summary.json"))) {
                results[n] = { job, status: "cached", seconds: 0 };
                onDone(results[n], n);
                continue;
            }
            const t = Date.now();
            let code = await runOnce(job, i);
            if (code !== 0 && code !== 3) code = await runOnce(job, i);
            results[n] = { job, status: code === 0 ? "ok" : code === 3 ? "skipped" : `failed (${code})`, seconds: (Date.now() - t) / 1000 };
            onDone(results[n], n);
        }
    }
    await Promise.all(Array.from({ length: Math.min(k, jobs.length) }, (_, i) => worker(i)));
    return results;
}

if (resolve(process.argv[1] ?? "") === fileURLToPath(import.meta.url)) {
    const file = process.argv[2];
    const ki = process.argv.indexOf("--k");
    const k = ki > 0 ? Number(process.argv[ki + 1]) : 4;
    if (!file) throw new Error("usage: node tools/headless/pool.mjs <jobs.json> [--k 4]");
    const jobs = JSON.parse(readFileSync(file, "utf8"));
    const t = Date.now();
    const res = await runPool(jobs, k, (r, n) => console.log(`[${n + 1}/${jobs.length}] ${r.status} ${r.seconds.toFixed(0)} s ${r.job.out}`));
    const bad = res.filter((r) => r.status.startsWith("failed"));
    console.log(`${jobs.length} jobs, K=${k}, ${((Date.now() - t) / 1000).toFixed(0)} s wall, ${bad.length} failed`);
    if (bad.length) process.exitCode = 1;
}
