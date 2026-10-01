import { planZones, zoneDelta, blockRect, blockKey, ZONE_ROAMERS } from "./build/handyman-zones.mjs";
let pass = 0, fail = 0;
const ok = (c, m) => { c ? pass++ : (fail++, console.log("FAIL:", m)); };

// A 20x20 block grid, 3 path tiles each = 1200 tiles.
const grid = (w, h, tiles = 3) => { const b = []; for (let x = 0; x < w; x++) for (let y = 0; y < h; y++) b.push({ bx: x, by: y, tiles }); return b; };
const ids = (n) => Array.from({ length: n }, (_, i) => 100 + i);

// Roamers are left out, every block is in exactly one zone, weights are even (#65).
{
    const blocks = grid(20, 20);
    const p = planZones(blocks, ids(12));
    ok(p.roaming.length === ZONE_ROAMERS, "2 roam: " + p.roaming.length);
    ok(Object.keys(p.zones).length === 10, "10 zoned");
    const all = [].concat(...Object.values(p.zones));
    ok(all.length === 400 && new Set(all).size === 400, "every block exactly once: " + all.length);
    const w = Object.values(p.zones).map((z) => z.length * 3);
    ok(Math.max(...w) - Math.min(...w) <= 12, "even weight: " + w.join(","));
}

// Zones are compact: on a solid grid each zone is one connected patch.
{
    const p = planZones(grid(20, 20), ids(12));
    for (const [id, z] of Object.entries(p.zones)) {
        const set = new Set(z), seen = new Set([z[0]]), q = [z[0]];
        while (q.length) { const [x, y] = q.shift().split(",").map(Number);
            for (let dx = -1; dx <= 1; dx++) for (let dy = -1; dy <= 1; dy++) { const k = blockKey(x + dx, y + dy); if (set.has(k) && !seen.has(k)) { seen.add(k); q.push(k); } } }
        ok(seen.size === z.length, "zone " + id + " connected: " + seen.size + "/" + z.length);
    }
}

// Deterministic, and independent of the order ids come in.
{
    const a = planZones(grid(10, 10), [5, 3, 9, 1, 7]);
    const b = planZones(grid(10, 10), [1, 3, 5, 7, 9]);
    ok(JSON.stringify(a) === JSON.stringify(b), "same plan for same roster");
}

// Few handymen: everyone roams. No blocks: everyone roams. More handymen than blocks: extras roam.
{
    ok(planZones(grid(5, 5), ids(2)).roaming.length === 2, "2 handymen all roam");
    ok(planZones(grid(5, 5), ids(0)).roaming.length === 0, "none");
    ok(planZones([], ids(8)).roaming.length === 8, "no blocks all roam");
    const p = planZones(grid(2, 1), ids(10));
    ok(Object.keys(p.zones).length === 2 && p.roaming.length === 8, "extras roam: " + Object.keys(p.zones).length);
    ok(Object.values(p.zones).every((z) => z.length === 1), "one block each");
}

// Uneven weights and islands: everything still assigned, nobody empty.
{
    const blocks = [...grid(3, 3, 16), ...grid(3, 3, 1).map((b) => ({ ...b, bx: b.bx + 40 }))];
    const p = planZones(blocks, ids(6));
    const all = [].concat(...Object.values(p.zones));
    ok(all.length === 18 && new Set(all).size === 18, "islands all assigned: " + all.length);
    ok(Object.values(p.zones).every((z) => z.length > 0), "no empty zone");
}

// A roster change shifts few blocks? Hiring one handyman should not rewrite most zones.
{
    const a = planZones(grid(20, 20), ids(12));
    const b = planZones(grid(20, 20), ids(13));
    let moved = 0, total = 0;
    for (const id of Object.keys(a.zones)) { const d = zoneDelta(a.zones[id], b.zones[id] || []); moved += d.add.length; total += a.zones[id].length; }
    ok(moved < total, "delta never exceeds a full rewrite: " + moved + "/" + total);
}

// zoneDelta and blockRect.
{
    const d = zoneDelta(["1,1", "2,2"], ["2,2", "3,3"]);
    ok(d.add.join() === "3,3" && d.remove.join() === "1,1", "delta");
    ok(zoneDelta(undefined, ["1,1"]).add.length === 1, "fresh");
    const r = blockRect("2,3");
    ok(r.x1 === 256 && r.y1 === 384 && r.x2 === 352 && r.y2 === 480, "rect " + JSON.stringify(r));
}

console.log(`handyman-zones: ${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
