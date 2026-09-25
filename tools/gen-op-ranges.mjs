// Regenerates src/op-ranges.ts data: ride type -> [min, max] operation option, read from gamesrc
// (RideData.cpp kRideTypeDescriptors order + rtd/**/*.h .OperatingSettings). Run: node tools/gen-op-ranges.mjs
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
const base = "gamesrc/OpenRCT2/src/openrct2/ride";
const order = [...readFileSync(join(base, "RideData.cpp"), "utf8").split("kRideTypeDescriptors[RIDE_TYPE_COUNT] = {")[1].split("};")[0]
    .matchAll(/\/\*\s*(RIDE_TYPE_\w+)\s*\*\/\s*(k\w+RTD)/g)].map(m => [m[1], m[2]]);
const files = []; const walk = d => { for (const f of readdirSync(d)) { const p = join(d, f); statSync(p).isDirectory() ? walk(p) : p.endsWith(".h") && files.push(p); } };
walk(join(base, "rtd"));
const ranges = {};
for (const f of files) {
    const src = readFileSync(f, "utf8");
    const parts = src.split(/constexpr RideTypeDescriptor (k\w+RTD)\b/);
    for (let i = 1; i < parts.length; i += 2) {
        const m = parts[i + 1].match(/\.OperatingSettings\s*=\s*\{\s*(\d+)\s*,\s*(\d+)/);
        ranges[parts[i]] = m ? [+m[1], +m[2]] : null;
    }
}
const out = order.map(([t, k], i) => ({ i, t, k, r: k === "kDummyRTD" ? null : ranges[k] }));
const missing = out.filter(o => o.k !== "kDummyRTD" && !(o.k in ranges));
console.error("types", out.length, "missing rtd", missing.map(m => m.k).join(","), "no-op-settings", out.filter(o => o.k !== "kDummyRTD" && o.r === null).length);
console.log(JSON.stringify(out.map(o => o.r)));
