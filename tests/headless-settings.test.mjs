import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { TOGGLES, settingsToWrite, settingsKeys, effectiveSettings, settingsTable } from "../tools/headless/settings.mjs";
let pass = 0, fail = 0;
const ok = (c, m) => { c ? pass++ : (fail++, console.log("FAIL:", m)); };

// TOGGLES matches every boolSetting(storage, key, default) call in src/, by plugin name.
{
    const found = [];
    const walk = (dir) => {
        for (const e of readdirSync(dir, { withFileTypes: true })) {
            const p = join(dir, e.name);
            if (e.isDirectory()) walk(p);
            else if (p.endsWith(".ts")) {
                const src = readFileSync(p, "utf8");
                for (const m of src.matchAll(/boolSetting\(storage, "(\w+)", (true|false)\)/g)) {
                    // src/trash/* belong to Trash Manager, src/builder/* to Auto-Builder;
                    // otherwise the file's registerPlugin name.
                    const top = p.includes(join("src", "trash")) ? readFileSync(join("src", "trash-manager.ts"), "utf8")
                        : p.includes(join("src", "builder")) ? readFileSync(join("src", "auto-builder.ts"), "utf8") : src;
                    const plugin = /registerPlugin\(\{\s*name: "([^"]+)"/.exec(top)?.[1];
                    found.push(`${plugin}.${m[1]}=${m[2]}`);
                }
            }
        }
    };
    walk("src");
    const listed = TOGGLES.map((t) => `${t.plugin}.${t.key}=${t.defaultOn}`);
    ok(found.length > 0, "found boolSetting calls");
    ok(found.sort().join() === listed.sort().join(), "TOGGLES matches src:\n  src:    " + found.sort().join(" ") + "\n  listed: " + listed.sort().join(" "));
}

// Presets.
{
    ok(Object.keys(settingsToWrite("save")).length === 0, "save writes nothing");
    const all = settingsToWrite("all");
    ok(all["Staff Extras"].autoManageEntertainers === true && all["Auto-Builder"].autoAmenities === true, "all turns everything on");
    const def = settingsToWrite("defaults");
    ok(def["Auto-Builder"].autoAmenities === true && def["Marketing Manager"].autoManage === false && def["Mechanic Manager"].autoManage === true, "defaults writes code defaults");
}

// JSON settings: only known keys, only booleans.
{
    const w = settingsToWrite("file.json", '{"Auto-Builder":{"autoAmenities":true}}');
    ok(w["Auto-Builder"].autoAmenities === true && Object.keys(w).length === 1, "json settings");
    let threw = false;
    try { settingsToWrite("f", '{"Trash Manager":{"nope":true}}'); } catch { threw = true; }
    ok(threw, "unknown key refused");
    threw = false;
    try { settingsToWrite("f", '{"Auto-Builder":{"autoAmenities":"yes"}}'); } catch { threw = true; }
    ok(threw, "non-boolean refused");
}

// Keys cover every toggle.
ok(Object.values(settingsKeys()).flat().length === TOGGLES.length, "keys cover all toggles");

// Effective values follow src/settings.ts: unset or non-boolean reads as the default.
{
    const e = effectiveSettings({ "Auto-Builder": { autoAmenities: false }, "Trash Manager": { autoHireEnabled: null, autoSweepEnabled: "x" }, "Wait Time Optimizer": { autoOperationTuning: "x" } });
    const get = (p, k) => e.find((s) => s.plugin === p && s.key === k);
    ok(get("Auto-Builder", "autoAmenities").on === false, "stored false beats default-on");
    ok(get("Trash Manager", "autoHireEnabled").on === true && get("Trash Manager", "autoHireEnabled").stored === null, "unset default-on");
    ok(get("Trash Manager", "autoSweepEnabled").on === true && get("Wait Time Optimizer", "autoOperationTuning").on === false, "non-boolean reads as default");
    ok(get("Marketing Manager", "autoManage").on === false, "missing plugin reads default");
    const table = settingsTable(e);
    ok(table.includes("| Auto-Builder | autoAmenities | on | **off** (changed) |"), "table marks changes");
    ok(table.includes("| Marketing Manager | autoManage | off | **off** |"), "table unchanged row");
}

console.log(`${pass} passed, ${fail} failed`);
if (fail > 0) process.exitCode = 1;
