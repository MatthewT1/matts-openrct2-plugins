/**
 * Fails on broken internal links in the repo's Markdown (#149): a relative link to a file that
 * isn't tracked, or a #anchor that matches no heading in the target. External links aren't
 * fetched. Anchors use GitHub's heading slugs (lowercase, punctuation dropped, spaces -> "-",
 * repeats get -1, -2...).
 *
 *   node tools/check-doc-links.mjs
 */

import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, statSync } from "node:fs";
import { posix } from "node:path";

const { dirname, join, normalize } = posix;

const files = execFileSync("git", ["ls-files", "*.md"], { encoding: "utf8" }).trim().split("\n").filter(Boolean);
const slugCache = new Map();

const stripFences = (text) => text.replace(/^(```|~~~)[\s\S]*?^\1/gm, "");
const stripCode = (text) => stripFences(text).replace(/`[^`\n]*`/g, "");

function slugs(file) {
    if (slugCache.has(file)) return slugCache.get(file);
    const seen = new Map(), out = new Set();
    for (const m of stripFences(readFileSync(file, "utf8")).matchAll(/^#{1,6}\s+(.+?)\s*#*\s*$/gm)) {
        const base = m[1].replace(/<[^>]+>/g, "").replace(/\[([^\]]*)\]\([^)]*\)/g, "$1").toLowerCase()
            .replace(/[^\p{L}\p{N}\s_-]/gu, "").replace(/ /g, "-");
        const n = seen.get(base) ?? 0;
        seen.set(base, n + 1);
        out.add(n ? `${base}-${n}` : base);
    }
    // Explicit HTML anchors: <a id="x"> / <a name="x">
    for (const m of readFileSync(file, "utf8").matchAll(/<a\s+(?:id|name)="([^"]+)"/g)) out.add(m[1]);
    slugCache.set(file, out);
    return out;
}

const bad = [];
for (const file of files) {
    const lines = stripCode(readFileSync(file, "utf8")).split("\n");
    lines.forEach((line, i) => {
        for (const m of line.matchAll(/\]\(\s*<?([^)\s>]+)>?(?:\s+"[^"]*")?\s*\)/g)) {
            const link = m[1];
            if (/^[a-z][a-z0-9+.-]*:/i.test(link)) continue; // http:, mailto:, ...
            const [path, anchor] = link.split("#");
            const target = path ? normalize(join(dirname(file), decodeURIComponent(path))) : file;
            if (target.startsWith("..")) continue; // leaves the repo: a GitHub web path like ../../releases/latest
            if (path && !existsSync(target)) { bad.push(`${file}:${i + 1}: missing file ${link}`); continue; }
            if (anchor && target.endsWith(".md") && statSync(target).isFile() && !slugs(target).has(decodeURIComponent(anchor).toLowerCase()))
                bad.push(`${file}:${i + 1}: no heading for #${anchor} in ${target}`);
        }
    });
}
console.log(`${files.length} Markdown files checked, ${bad.length} broken internal links`);
for (const b of bad) console.log("  " + b);
process.exit(bad.length ? 1 : 0);
