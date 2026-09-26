/**
 * Plugin settings for harness runs (#49). Pure: runs under node in tests.
 *
 * Our plugins keep their on/off toggles in park storage, so a run otherwise uses whatever
 * the save had stored, or the code defaults if the save never ran the plugins. Most of the
 * features that matter default on since #51; marketing and operation tuning default off.
 * `--settings` makes that explicit: the runner writes a preset before the start and reports
 * what each toggle was.
 *
 * TOGGLES must match the boolSetting(storage, key, default) calls in src/; a test checks it.
 */

/** Every boolean park setting, by plugin name as registered (park storage namespace). */
export const TOGGLES = [
    { plugin: "Trash Manager", key: "autoHireEnabled", defaultOn: true },
    { plugin: "Trash Manager", key: "adaptiveStaffing", defaultOn: true },
    { plugin: "Trash Manager", key: "autoSweepEnabled", defaultOn: true },
    { plugin: "Auto-Builder", key: "autoAmenities", defaultOn: true },
    { plugin: "Auto-Builder", key: "autoAmenityRemoval", defaultOn: true },
    { plugin: "Auto-Builder", key: "autoFacilities", defaultOn: true },
    { plugin: "Auto-Builder", key: "autoCheapBuilds", defaultOn: true },
    { plugin: "Wait Time Optimizer", key: "autoManage", defaultOn: true },
    { plugin: "Wait Time Optimizer", key: "autoOperationTuning", defaultOn: false },
    { plugin: "Mechanic Manager", key: "autoManage", defaultOn: true },
    { plugin: "Mechanic Manager", key: "adaptiveMechanics", defaultOn: true },
    { plugin: "Mechanic Manager", key: "emergencyRepair", defaultOn: true },
    { plugin: "Marketing Manager", key: "autoManage", defaultOn: false },
    { plugin: "Staff Extras", key: "autoManageEntertainers", defaultOn: true },
    { plugin: "Staff Extras", key: "hireAwardGuard", defaultOn: true },
];

export const PRESETS = ["save", "defaults", "all"];

/**
 * What to write for a preset: { plugin: { key: bool } }. "save" writes nothing (the save's
 * stored values stand). A non-preset value is parsed as that same shape from JSON text.
 */
export function settingsToWrite(preset, jsonText) {
    if (preset === "save") return {};
    const out = {};
    if (preset === "defaults" || preset === "all") {
        for (const t of TOGGLES) (out[t.plugin] ??= {})[t.key] = preset === "all" ? true : t.defaultOn;
        return out;
    }
    const parsed = JSON.parse(jsonText);
    for (const [plugin, keys] of Object.entries(parsed)) {
        for (const [key, v] of Object.entries(keys)) {
            if (!TOGGLES.some((t) => t.plugin === plugin && t.key === key)) throw new Error(`unknown setting ${plugin}.${key}`);
            if (typeof v !== "boolean") throw new Error(`${plugin}.${key} must be true or false`);
            (out[plugin] ??= {})[key] = v;
        }
    }
    return out;
}

/** The keys the agent reads back: { plugin: [key, ...] }. */
export function settingsKeys() {
    const out = {};
    for (const t of TOGGLES) (out[t.plugin] ??= []).push(t.key);
    return out;
}

/**
 * Effective value of every toggle from the stored values the agent read back, applying
 * the same rule as src/settings.ts: unset or non-boolean reads as the default.
 */
export function effectiveSettings(stored) {
    return TOGGLES.map((t) => {
        const v = stored?.[t.plugin]?.[t.key];
        const on = t.defaultOn ? v !== false : v === true;
        return { ...t, stored: v === undefined ? null : v, on };
    });
}

/** Markdown table of effective settings. */
export function settingsTable(effective) {
    const rows = ["| Plugin | Setting | Default | This run |", "|---|---|---|---|"];
    for (const s of effective) {
        const mark = s.on === s.defaultOn ? "" : " (changed)";
        rows.push(`| ${s.plugin} | ${s.key} | ${s.defaultOn ? "on" : "off"} | **${s.on ? "on" : "off"}**${mark} |`);
    }
    return rows.join("\n");
}
