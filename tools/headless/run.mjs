/**
 * Headless test harness (#46): run a copy of a save with our plugins on and off,
 * fast-forwarded, and record the park every in-game day.
 *
 *   node tools/headless/run.mjs --save "C:/Users/you/Documents/OpenRCT2/save/Thunder Rock.park" --days 60
 *
 * Each arm gets its own throwaway user-data folder under the output folder (copied
 * config.ini, the chosen plugins, the harness agent, a copy of the save), so the real
 * Documents/OpenRCT2 folder is only ever read, never written. See docs/headless-harness.md.
 */

import { spawn, execFileSync } from "node:child_process";
import { connect } from "node:net";
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync, createWriteStream } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";
import { summariseRun, markdownReport, toCsv, countLogErrors, compareRuns } from "./summary.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, "..", "..");
const userDir = join(homedir(), "Documents", "OpenRCT2");

/** Our six plugins, as deployed by the dev build. */
const OUR_PLUGINS = [
    "trash-manager", "wait-time-optimizer", "mechanic-manager",
    "marketing-manager", "staff-extras", "path-connector",
];

function parseArgs(argv) {
    const a = {
        save: null,
        days: 60,
        speed: 4,
        arms: ["on", "off"],
        plugins: OUR_PLUGINS,
        pluginDir: join(userDir, "plugin"),
        config: join(userDir, "config.ini"),
        game: "C:/Program Files/OpenRCT2/openrct2.com",
        out: null,
        gamePort: 11800,
        agentPort: 47820,
    };
    for (let i = 2; i < argv.length; i++) {
        const k = argv[i], v = argv[i + 1];
        switch (k) {
            case "--save": a.save = v; i++; break;
            case "--days": a.days = Number(v); i++; break;
            case "--speed": a.speed = Number(v); i++; break;
            case "--arms": a.arms = v.split(","); i++; break;
            case "--plugins": a.plugins = v.split(","); i++; break;
            case "--plugin-dir": a.pluginDir = v; i++; break;
            case "--config": a.config = v; i++; break;
            case "--game": a.game = v; i++; break;
            case "--out": a.out = v; i++; break;
            case "--game-port": a.gamePort = Number(v); i++; break;
            case "--agent-port": a.agentPort = Number(v); i++; break;
            case "-h": case "--help":
                console.log(readFileSync(fileURLToPath(import.meta.url), "utf8").split("*/")[0]);
                process.exit(0);
                break;
            default:
                throw new Error(`unknown argument ${k}`);
        }
    }
    if (!a.save) throw new Error("--save <park file> is required");
    for (const arm of a.arms) if (arm !== "on" && arm !== "off") throw new Error(`arm must be on or off, got ${arm}`);
    if (!(a.days > 0)) throw new Error("--days must be positive");
    if (!(a.speed >= 0 && a.speed <= 4)) throw new Error("--speed must be 0..4");
    if (!a.out) {
        const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
        const name = basename(a.save).replace(/\.[^.]+$/, "").replace(/[^A-Za-z0-9-]+/g, "-");
        a.out = join(root, "harness-runs", `${stamp}-${name}`);
    }
    return a;
}

/** Copy config.ini with the settings the harness depends on forced. */
function writeConfig(src, dest) {
    let text = readFileSync(src, "utf8");
    const force = { pause_server_if_no_clients: "false", enable_hot_reloading: "false" };
    for (const [k, v] of Object.entries(force)) {
        const re = new RegExp(`^${k}\\s*=.*$`, "m");
        text = re.test(text) ? text.replace(re, `${k} = ${v}`) : text;
    }
    writeFileSync(dest, text);
}

function prepareArm(a, arm, armDir) {
    const ud = join(armDir, "userdata");
    mkdirSync(join(ud, "plugin"), { recursive: true });
    mkdirSync(join(ud, "save"), { recursive: true });
    writeConfig(a.config, join(ud, "config.ini"));

    const provenance = [];
    if (arm === "on") {
        for (const p of a.plugins) {
            const src = join(a.pluginDir, p.endsWith(".js") ? p : `${p}.js`);
            if (!existsSync(src)) throw new Error(`plugin not found: ${src}`);
            copyFileSync(src, join(ud, "plugin", basename(src)));
            provenance.push({ file: src, modified: statSync(src).mtime.toISOString() });
        }
    }
    const agent = readFileSync(join(here, "harness-agent.js"), "utf8").replace("__HARNESS_PORT__", String(a.agentPort));
    writeFileSync(join(ud, "plugin", "zz-harness-agent.js"), agent);

    const saveCopy = join(ud, "save", basename(a.save));
    copyFileSync(a.save, saveCopy);
    return { ud, saveCopy, provenance };
}

function delay(ms) {
    return new Promise((r) => setTimeout(r, ms));
}

/** Connect to the agent, retrying while the game starts up. */
async function connectAgent(port, timeoutMs, game) {
    const until = Date.now() + timeoutMs;
    while (Date.now() < until) {
        if (game.exitCode !== null) throw new Error(`game exited early (code ${game.exitCode}), see game.log`);
        const sock = await new Promise((res) => {
            const s = connect(port, "127.0.0.1");
            s.once("connect", () => res(s));
            s.once("error", () => res(null));
        });
        if (sock) return sock;
        await delay(500);
    }
    throw new Error(`agent did not answer on port ${port} within ${timeoutMs / 1000}s`);
}

/** Line-based JSON reader over the agent socket. */
function lineReader(sock) {
    let buf = "";
    const queue = [];
    let waiter = null;
    sock.setEncoding("utf8");
    sock.on("data", (d) => {
        buf += d;
        let i;
        while ((i = buf.indexOf("\n")) >= 0) {
            const line = buf.slice(0, i);
            buf = buf.slice(i + 1);
            if (!line) continue;
            const msg = JSON.parse(line);
            if (waiter) { const w = waiter; waiter = null; w.resolve(msg); } else queue.push(msg);
        }
    });
    sock.on("close", () => { if (waiter) { const w = waiter; waiter = null; w.reject(new Error("agent connection closed")); } });
    return (timeoutMs) => {
        if (queue.length > 0) return Promise.resolve(queue.shift());
        return new Promise((resolveMsg, reject) => {
            const t = setTimeout(() => { waiter = null; reject(new Error(`no message from agent in ${timeoutMs / 1000}s`)); }, timeoutMs);
            waiter = {
                resolve: (m) => { clearTimeout(t); resolveMsg(m); },
                reject: (e) => { clearTimeout(t); reject(e); },
            };
        });
    };
}

async function stopGame(game) {
    if (game.exitCode !== null) return;
    game.kill();
    for (let i = 0; i < 20 && game.exitCode === null; i++) await delay(250);
    if (game.exitCode === null && process.platform === "win32") {
        try { execFileSync("taskkill", ["/PID", String(game.pid), "/T", "/F"], { stdio: "ignore" }); } catch { /* already gone */ }
    }
}

async function runArm(a, arm) {
    const armDir = join(a.out, arm);
    mkdirSync(armDir, { recursive: true });
    const { ud, saveCopy, provenance } = prepareArm(a, arm, armDir);

    const logPath = join(armDir, "game.log");
    const log = createWriteStream(logPath);
    const game = spawn(a.game, [
        "host", saveCopy, "--headless",
        "--port", String(a.gamePort), "--address", "127.0.0.1",
        "--user-data-path", ud,
    ], { stdio: ["ignore", "pipe", "pipe"], windowsHide: true, env: { ...process.env, OPENRCT2_NO_REPL: "1" } });
    game.stdout.pipe(log, { end: false });
    game.stderr.pipe(log, { end: false });
    const started = Date.now();

    const rows = [];
    let hello = null;
    try {
        const sock = await connectAgent(a.agentPort, 120000, game);
        const next = lineReader(sock);
        sock.write(JSON.stringify({ cmd: "hello" }) + "\n");
        hello = await next(10000);
        console.log(`[${arm}] ${hello.parkName} ${hello.date}, plugins: ${hello.plugins.join(", ")}`);

        sock.write(JSON.stringify({ cmd: "start", days: a.days, speed: a.speed }) + "\n");
        for (;;) {
            // A day is ~530 ticks: ~13 s at speed 0, ~1.6 s at speed 4. Allow for a slow park.
            const msg = await next(60000);
            if (msg.type === "day") {
                rows.push(msg);
                if (msg.day % 10 === 0) console.log(`[${arm}] day ${msg.day}/${a.days}: rating ${msg.rating}, guests ${msg.guests}, cash ${(msg.cash / 10).toFixed(0)}`);
            } else if (msg.type === "done") {
                break;
            } else if (msg.type === "error") {
                throw new Error(`agent error: ${msg.error}`);
            }
        }
        sock.end();
    } finally {
        await stopGame(game);
        log.end();
    }

    const seconds = (Date.now() - started) / 1000;
    writeFileSync(join(armDir, "days.csv"), toCsv(rows));
    const errors = countLogErrors(readFileSync(logPath, "utf8"));
    console.log(`[${arm}] done: ${rows.length - 1} days in ${seconds.toFixed(0)} s`);
    return { arm, hello, rows, seconds, provenance, errors, summary: summariseRun(rows) };
}

async function main() {
    const a = parseArgs(process.argv);
    if (!existsSync(a.save)) throw new Error(`save not found: ${a.save}`);
    if (!existsSync(a.game)) throw new Error(`game not found: ${a.game}`);
    mkdirSync(a.out, { recursive: true });
    console.log(`output: ${a.out}`);

    const results = {};
    for (const arm of a.arms) results[arm] = await runArm(a, arm);

    const summaries = {};
    for (const arm of a.arms) summaries[arm] = results[arm].summary;
    const report = [
        `# Headless run: ${basename(a.save)}`,
        "",
        `${a.days} in-game days at speed ${a.speed}. Money columns are in currency units.`,
        "",
        markdownReport(summaries),
    ];
    for (const arm of a.arms) {
        const r = results[arm];
        report.push(`## ${arm}`, "", `Start ${r.hello?.date}, ${r.rows.length - 1} days in ${r.seconds.toFixed(0)} s.`, "");
        report.push(`Plugins running: ${r.hello?.plugins.join(", ")}`, "");
        const errs = Object.entries(r.errors).sort((x, y) => y[1] - x[1]);
        if (errs.length > 0) {
            report.push("Game log errors:", "");
            for (const [msg, n] of errs) report.push(`- ${n} x \`${msg}\``);
            report.push("");
        }
    }
    writeFileSync(join(a.out, "summary.md"), report.join("\n"));
    writeFileSync(join(a.out, "summary.json"), JSON.stringify({
        args: { save: a.save, days: a.days, speed: a.speed, arms: a.arms, plugins: a.plugins },
        arms: Object.fromEntries(a.arms.map((arm) => [arm, {
            start: results[arm].hello, seconds: results[arm].seconds, pluginFiles: results[arm].provenance,
            errors: results[arm].errors, summary: results[arm].summary,
        }])),
        comparison: results.on && results.off ? compareRuns(results.on.summary, results.off.summary) : null,
    }, null, 2));

    console.log("\n" + markdownReport(summaries));
    console.log(`written: ${join(a.out, "summary.md")}`);
}

main().catch((e) => {
    console.error(`harness failed: ${e.message}`);
    process.exitCode = 1;
});
