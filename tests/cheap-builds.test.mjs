import { tileKey, keyTile, farthestPathTile, buildAnchors, uncoveredAnchors, pickSite,
         createSpotAccumulator, DEFAULT_CHEAP_BUILD_OPTIONS } from "./build/cheap-builds.mjs";
let pass=0, fail=0; const ok=(c,m)=>{ c?pass++:(fail++,console.log("FAIL:",m)); };
const OPT = DEFAULT_CHEAP_BUILD_OPTIONS;

// --- keys round-trip, including a large map ----------------------------------------
ok(JSON.stringify(keyTile(tileKey(37, 999))) === '{"x":37,"y":999}', "key round-trips");

// --- farthest path tile: breadth-first by steps, not straight-line -----------------
/** Undirected graph from a list of [a, b] tile pairs. */
const graph = (pairs) => {
    const g = {};
    for (const [a, b] of pairs) {
        const ka = tileKey(...a), kb = tileKey(...b);
        (g[ka] ??= []).push(kb); (g[kb] ??= []).push(ka);
    }
    return g;
};
// A line 10,10 -> 10,15 plus a U-turn that ends physically close to the start (11,10)
// but is the most steps away.
const line = [];
for (let y = 10; y < 15; y++) line.push([[10, y], [10, y + 1]]);
line.push([[10, 15], [11, 15]]);
for (let y = 15; y > 10; y--) line.push([[11, y], [11, y - 1]]);
const far = farthestPathTile([tileKey(10, 10)], graph(line));
ok(far.x === 11 && far.y === 10 && far.steps === 11, "farthest by steps, got " + JSON.stringify(far));
ok(farthestPathTile([], graph(line)) === null, "no starts -> null");
ok(farthestPathTile([tileKey(99, 99)], graph(line)) === null, "start off the graph -> null");
// Two entrances: distance is from the nearest one.
const two = farthestPathTile([tileKey(10, 10), tileKey(11, 10)], graph(line));
ok(two.steps === 5, "multi-source takes the nearer entrance, got " + JSON.stringify(two));
// Unreachable islands are ignored, not treated as far.
const island = graph([...line, [[50, 50], [50, 51]]]);
ok(farthestPathTile([tileKey(10, 10)], island).x === 11, "disconnected paths ignored");

// --- anchors: front, then back if deep enough, then clusters -----------------------
const a1 = buildAnchors([{ x: 5, y: 5 }], { x: 60, y: 60, steps: 80 }, [{ x: 30, y: 30 }], OPT);
ok(a1.map((a) => a.role).join() === "front,back,cluster", "anchor order");
const a2 = buildAnchors([{ x: 5, y: 5 }], { x: 9, y: 9, steps: OPT.minBackSteps - 1 }, [], OPT);
ok(a2.length === 1 && a2[0].role === "front", "shallow park has no back anchor");
ok(buildAnchors([], null, [], OPT).length === 0, "no entrance, no anchors");

// --- coverage: anything within coverRadius covers an anchor ------------------------
const un1 = uncoveredAnchors(a1, [{ x: 5 + OPT.coverRadius, y: 5 }], OPT);
ok(un1.map((a) => a.role).join() === "back,cluster", "front covered at exactly coverRadius");
const un2 = uncoveredAnchors(a1, [{ x: 5 + OPT.coverRadius + 1, y: 5 }], OPT);
ok(un2.length === 3, "one tile further does not cover");
const many = Array.from({ length: OPT.maxPerKind }, (_, i) => ({ x: 200 + i, y: 200 }));
ok(uncoveredAnchors(a1, many, OPT).length === 0, "nothing once the kind is at maxPerKind");

// --- site choice: flat beats close, then closest, radius respected -----------------
const anchor = { x: 20, y: 20 };
const sites = [
    { x: 21, y: 20, flat: false },
    { x: 23, y: 20, flat: true },
    { x: 22, y: 20, flat: true },
    { x: 20, y: 20 + OPT.siteRadius + 1, flat: true },
];
const s1 = pickSite(anchor, sites, OPT);
ok(s1.x === 22 && s1.flat, "closest flat site wins over a closer sloped one");
ok(pickSite(anchor, [sites[0]], OPT).x === 21, "sloped site used when it is all there is");
ok(pickSite(anchor, [sites[3]], OPT) === null, "out-of-radius site ignored");

// --- spot accumulator: fullest cell, reported at the guests' mean position ---------
const sp = createSpotAccumulator(8);
sp.add(1, 1); sp.add(3, 3);                 // cell (0,0): 2 guests
for (const [x, y] of [[40, 40], [42, 44], [41, 42]]) sp.add(x, y);  // cell (5,5): 3
sp.add(-5, 3);                               // off map, ignored
const top = sp.top(3, 2);
ok(top.length === 1 && top[0].x === 41 && top[0].y === 42 && top[0].count === 3,
   "only cells at minCount, mean position, got " + JSON.stringify(top));
ok(sp.top(2, 2).length === 2 && sp.top(2, 2)[0].count === 3, "fullest first");
sp.reset();
ok(sp.top(1, 5).length === 0, "reset clears");

console.log(`${pass} passed, ${fail} failed`);
