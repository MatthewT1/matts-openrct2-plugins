/**
 * Test runner for the plugins' pure logic modules.
 *
 *   node tests/run.mjs
 *
 * The modules under test (hotspots, staff-activity, staffing, vomit, amenities, needs,
 * thoughts, ops) are deliberately free of OpenRCT2 globals, so they compile and run
 * under plain node with no game required. Everything that touches `map`, `context` or
 * `park` lives in the plugin entry points and is not covered here — which is the main
 * reason the decision logic was pulled out into these modules in the first place.
 *
 * This compiles each module to tests/build/*.mjs, then runs every *.test.mjs file and
 * aggregates the results. A non-zero exit code means at least one assertion failed.
 */

import { execFileSync } from "node:child_process";
import { readdirSync, renameSync, rmSync, mkdirSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const root = dirname(here);
const buildDir = join(here, "build");

const MODULES = [
    "hotspots", "staff-activity", "staffing",
    "vomit", "amenities", "needs", "thoughts", "ops", "facilities", "queues",
    "entertainer-targeting", "marketing",
];

function compile() {
    if (existsSync(buildDir)) rmSync(buildDir, { recursive: true, force: true });
    mkdirSync(buildDir, { recursive: true });

    const tsc = join(root, "node_modules", "typescript", "bin", "tsc");
    execFileSync(
        process.execPath,
        [
            tsc,
            ...MODULES.map((m) => join(root, "src", `${m}.ts`)),
            "--outDir", buildDir,
            "--target", "es2015",
            "--module", "es2020",
            "--strict",
        ],
        { stdio: "inherit" },
    );

    // Node needs the .mjs extension to treat these as ES modules regardless of the
    // nearest package.json "type" field — and the renamed files must then point at each
    // other by their new names.
    //
    // TypeScript emits relative specifiers with no extension (`from "./needs"`), which
    // Node's ES module resolver rejects outright. This stayed invisible for a long time
    // because the pure modules only ever imported TYPES from one another, and TypeScript
    // erases those at compile time so no runtime import was emitted at all. The moment
    // one module imported a real VALUE from another, every test in that suite died with
    // ERR_MODULE_NOT_FOUND — a failure that looks nothing like its one-line cause.
    for (const f of readdirSync(buildDir)) {
        if (!f.endsWith(".js")) continue;
        const from = join(buildDir, f);
        const to = join(buildDir, f.replace(/\.js$/, ".mjs"));
        renameSync(from, to);
        const src = readFileSync(to, "utf8");
        const fixed = src.replace(
            /(from\s*["'])(\.[^"']*)(["'])/g,
            (m, a, spec, b) => (spec.endsWith(".mjs") ? m : a + spec + ".mjs" + b),
        );
        if (fixed !== src) writeFileSync(to, fixed, "utf8");
    }
}

function run() {
    const tests = readdirSync(here).filter((f) => f.endsWith(".test.mjs")).sort();
    let totalPass = 0;
    let totalFail = 0;
    const failedFiles = [];

    for (const t of tests) {
        let out = "";
        let failedToRun = false;
        try {
            out = execFileSync(process.execPath, [join(here, t)], { encoding: "utf8" });
        } catch (err) {
            // A non-zero exit still carries the output we want to report.
            out = `${err.stdout ?? ""}${err.stderr ?? ""}`;
            failedToRun = err.stdout === undefined;
        }

        const m = out.match(/(\d+) passed, (\d+) failed/);
        const passed = m ? Number(m[1]) : 0;
        const failed = m ? Number(m[2]) : 0;
        totalPass += passed;
        totalFail += failed;

        const name = t.replace(".test.mjs", "");
        if (failed > 0 || failedToRun || !m) {
            failedFiles.push(name);
            console.log(`FAIL  ${name.padEnd(22)} ${passed} passed, ${failed} failed`);
            // Only the failing assertions are interesting; they are the lines the
            // individual suites print with a FAIL prefix.
            for (const line of out.split("\n")) {
                if (line.startsWith("FAIL:")) console.log(`        ${line}`);
            }
            if (!m) console.log(out.trim().split("\n").slice(-5).map((l) => `        ${l}`).join("\n"));
        } else {
            console.log(`ok    ${name.padEnd(22)} ${passed} passed`);
        }
    }

    console.log(`\n${totalPass} passed, ${totalFail} failed across ${tests.length} suites`);
    if (failedFiles.length > 0) {
        console.log(`failing suites: ${failedFiles.join(", ")}`);
        process.exitCode = 1;
    }
}

compile();
run();
