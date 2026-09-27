import { pickOwnedToFire, createOwnedStaff } from "./build/staff-ownership.mjs";
let pass = 0, fail = 0;
const ok = (c, m) => { c ? pass++ : (fail++, console.log("FAIL:", m)); };

function memStore() {
    const data = {};
    return { data, get: (k) => data[k], set: (k, v) => { data[k] = JSON.parse(JSON.stringify(v)); } };
}

// Player staff never lands in the fire list, whatever the order or count (#135).
{
    const owned = { "7": true, "9": true };
    const r = pickOwnedToFire([1, 7, 2, 9, 3], owned, 5);
    ok(r.fireIds.join(",") === "7,9", "only owned ids fired: " + r.fireIds);
    ok(r.protectedCount === 3, "surplus beyond owned is reported: " + r.protectedCount);
    for (let n = 0; n <= 6; n++) {
        const p = pickOwnedToFire([1, 7, 2, 9, 3], owned, n);
        ok(p.fireIds.every((id) => owned[String(id)]), "no player id at count " + n);
        ok(p.fireIds.length === Math.min(n, 2), "fires min(count, owned) at count " + n);
    }
}

// Release order is kept: the idlest owned mechanic goes first.
{
    const r = pickOwnedToFire([4, 8, 6], { "8": true, "6": true }, 1);
    ok(r.fireIds.join(",") === "8" && r.protectedCount === 0, "first owned in order: " + r.fireIds);
}

// Nothing owned (an existing park's staff): nothing fired, all counted as protected.
{
    const r = pickOwnedToFire([1, 2, 3], {}, 2);
    ok(r.fireIds.length === 0 && r.protectedCount === 2, "no owned -> no fires");
}

// Store: add/has/remove round-trip, prune drops ids no longer on the roster.
{
    const s = memStore();
    const o = createOwnedStaff(s, "ourHandymen");
    ok(!o.has(5), "empty store owns nothing");
    o.add(5); o.add(6); o.add(7);
    ok(o.has(5) && o.has(6) && o.has(7), "added ids owned");
    o.remove(6);
    ok(!o.has(6), "removed id forgotten");
    const live = o.prune([5, 42]);
    ok(Object.keys(live).join(",") === "5", "prune keeps live owned only: " + Object.keys(live));
    ok(!o.has(7) && !o.has(42), "pruned id gone; player id 42 never owned");
    let writes = 0;
    const s2 = { get: s.get, set: (k, v) => { writes++; s.set(k, v); } };
    createOwnedStaff(s2, "ourHandymen").prune([5]);
    ok(writes === 0, "prune with nothing stale does not write");
}

console.log(`${pass} passed, ${fail} failed`); if (fail) process.exitCode = 1;
