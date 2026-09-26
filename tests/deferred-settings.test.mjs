import { createDeferredActions } from "./build/deferred.mjs";
import { boolSetting, migrateKeys } from "./build/settings.mjs";
let pass = 0, fail = 0;
const ok = (c, m) => { c ? pass++ : (fail++, console.log("FAIL:", m)); };

// --- deferred actions

// Subscribes exactly once, to whatever the plugin passes.
{
    let subs = 0, tick = null;
    const d = createDeferredActions((cb) => { subs++; tick = cb; });
    ok(subs === 1 && tick === d.flush, "subscribes flush once");
}

// Nothing runs until the tick; repeated requests run once; order is definition order.
{
    const log = [];
    const d = createDeferredActions(() => {});
    const a = d.define(() => log.push("a"));
    const b = d.define(() => log.push("b"));
    b(); a(); a();
    ok(log.length === 0, "nothing runs before the tick");
    d.flush();
    ok(log.join("") === "ab", "runs once each, in definition order: " + log.join(""));
    d.flush();
    ok(log.join("") === "ab", "a second tick runs nothing");
    a(); d.flush();
    ok(log.join("") === "aba", "can be requested again after running");
}

// A throwing action stays queued and is retried; later actions wait (old behaviour).
{
    const log = [];
    const d = createDeferredActions(() => {});
    let fails = 1;
    const a = d.define(() => { if (fails-- > 0) throw new Error("boom"); log.push("a"); });
    const b = d.define(() => log.push("b"));
    a(); b();
    let threw = false;
    try { d.flush(); } catch { threw = true; }
    ok(threw && log.length === 0, "throw propagates, later actions not run");
    d.flush();
    ok(log.join("") === "ab", "retried on next tick: " + log.join(""));
}

// With an argument: latest wins by default; merge combines.
{
    const got = [];
    const d = createDeferredActions(() => {});
    const ride = d.defineWithArg((id) => got.push(id));
    ride(3); ride(7); d.flush();
    ok(got.join() === "7", "latest arg wins: " + got.join());
    // Trash sweeps: request(oldOnly). Sweep All + Sweep Old in one tick = sweep all.
    const sweeps = [];
    const sweep = d.defineWithArg((oldOnly) => sweeps.push(oldOnly), (a, b) => a && b);
    sweep(true); d.flush();
    sweep(false); d.flush();
    sweep(true); sweep(false); d.flush();
    sweep(false); sweep(true); d.flush();
    sweep(true); sweep(true); d.flush();
    ok(sweeps.join() === "true,false,false,false,true", "sweep merge matches old flags: " + sweeps.join());
}

// --- bool settings

function store(init) {
    const m = { ...init };
    return { m, get: (k) => m[k], set: (k, v) => { m[k] = v; } };
}
{
    const s = store({});
    ok(boolSetting(s, "x", true).get() === true, "unset, default on -> true");
    ok(boolSetting(s, "x", false).get() === false, "unset, default off -> false");
    const on = boolSetting(s, "x", true);
    on.set(false);
    ok(s.m.x === false && on.get() === false, "set false persists under the key");
    on.set(true);
    ok(on.get() === true, "set true reads back");
    // Non-boolean junk behaves like the old === true / !== false reads.
    const j = store({ y: 1 });
    ok(boolSetting(j, "y", true).get() === true, "junk, default on -> true (was !== false)");
    ok(boolSetting(j, "y", false).get() === false, "junk, default off -> false (was === true)");
}

// --- migrateKeys (#84: Trash Manager -> Auto-Builder)
{
    const keys = ["autoAmenities", "autoAmenityRemoval", "autoFacilities", "placedAmenities"];
    const oldS = store({ autoAmenities: false, autoFacilities: true, placedAmenities: { "3,4": "bench" }, autoHireEnabled: false });
    const newS = store({ autoFacilities: false });
    const copied = migrateKeys(oldS, newS, keys);
    ok(copied.join() === "autoAmenities,placedAmenities", "copies only keys set in old and unset in new: " + copied.join());
    ok(newS.m.autoAmenities === false && newS.m.placedAmenities["3,4"] === "bench", "old values carried over");
    ok(newS.m.autoFacilities === false, "a value already in the new store wins");
    ok(!("autoAmenityRemoval" in newS.m), "a key unset in old stays unset (code default applies)");
    ok(keys.every((k) => oldS.m[k] === undefined), "old keys cleared so they cannot fight the new ones");
    ok(oldS.m.autoHireEnabled === false, "keys not being moved are untouched");
    ok(boolSetting(newS, "autoAmenities", true).get() === false, "migrated off reads off under a default-on setting");
    ok(migrateKeys(oldS, newS, keys).length === 0 && newS.m.autoAmenities === false, "second run is a no-op");
    oldS.m.autoAmenities = true; // e.g. an old build ran once more
    migrateKeys(oldS, newS, keys);
    ok(newS.m.autoAmenities === false && oldS.m.autoAmenities === undefined, "a stray old value never overrides the new one");
}

console.log(`${pass} passed, ${fail} failed`); if (fail) process.exitCode = 1;
