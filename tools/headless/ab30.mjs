// Fast A/B (#51, #74): first 5 parks of the #63 seed-63 order, 30 d, on arm p0/p1 with --settings,
// against a base arm truncated to day DAYS (harness is deterministic, so the first 30 days of a
// 60-day run are the 30-day run). Base "off" = existing #63 no-plugin runs; any other base = a tag
// written by an earlier ab30 run.
//   node tools/headless/ab30.mjs <tag> <settings> [base=off] [report]
import { readdirSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { METRICS, classifyEffect, metricValue, summariseRun } from "./summary.mjs";
const [TAG, SET, BASE = "off"] = process.argv.slice(2), REPORT = process.argv.includes("report");
const DAYS = 30, N = 5, root = "harness-runs/viability-seed63";
const byFile = {};
for (const d of readdirSync(root)) if (existsSync(`${root}/${d}/verdicts.json`)) byFile[JSON.parse(readFileSync(`${root}/${d}/verdicts.json`, "utf8")).park.file] = d;
const parks = JSON.parse(readFileSync(`${root}/state.json`, "utf8")).done.filter((f) => byFile[f]).slice(0, N);
if (!REPORT) for (const f of parks) for (const p of [0, 1]) {
  const out = `${root}/${byFile[f]}/${TAG}-p${p}`;
  if (existsSync(`${out}/summary.json`)) continue;
  const r = spawnSync(process.execPath, ["tools/headless/run.mjs", "--save", f, "--days", String(DAYS), "--arms", "on", "--perturb", String(p), "--settings", SET, "--out", out], { encoding: "utf8" });
  console.log(byFile[f], p, "exit", r.status);
}
// Summary of one arm run from its days.csv, cut at DAYS.
const summ = (d, dir) => {
  const arm = dir.startsWith("off") ? "off" : "on";
  const [head, ...lines] = readFileSync(`${root}/${d}/${dir}/${arm}/days.csv`, "utf8").trim().split("\n");
  const cols = head.split(",");
  const rows = lines.map((l) => Object.fromEntries(l.split(",").map((v, i) => [cols[i], v === "" || isNaN(v) ? v : Number(v)]))).filter((r) => r.day <= DAYS);
  return summariseRun(rows);
};
const lines = [`## ${TAG} vs ${BASE}: ${N} parks, ${DAYS} d, p0/p1 (\`--settings ${SET}\`)`, "", "| Metric | improved / worse / noise | median effect |", "|---|---|---|"];
const per = {};
for (const m of METRICS.filter((x) => x.better)) {
  const cnt = { improved: 0, worse: 0, noise: 0 }, eff = [];
  for (const f of parks) {
    const d = byFile[f];
    const v = (tag) => [0, 1].map((p) => metricValue(summ(d, `${tag}-p${p}`), m));
    const c = classifyEffect(v(TAG), v(BASE), m.better); if (!c) continue;
    cnt[c.verdict]++; eff.push(c.effect);
    (per[d] ??= {})[m.key] = `${(m.money ? c.effect / 10 : c.effect).toFixed(1)}±${(m.money ? c.noise / 10 : c.noise).toFixed(1)}`;
  }
  eff.sort((x, y) => x - y);
  const med = eff.length ? (m.money ? eff[Math.floor(eff.length / 2)] / 10 : eff[Math.floor(eff.length / 2)]).toFixed(1) : "-";
  lines.push(`| ${m.label} | ${cnt.improved} / ${cnt.worse} / ${cnt.noise} | ${med} |`);
}
const keys = ["cash", "avgHappiness", "guests", "rating", "litter", "vomit", "thCrowded", "incomeCum"];
lines.push("", "Per park (effect ± noise):", "", `| Park | ${keys.join(" | ")} |`, `|---|${keys.map(() => "---").join("|")}|`);
for (const [d, e] of Object.entries(per)) lines.push(`| ${d} | ${keys.map((k) => e[k] ?? "-").join(" | ")} |`);
writeFileSync(`${root}/ab-${TAG}.md`, lines.join("\n") + "\n");
console.log(`written ${root}/ab-${TAG}.md`);
