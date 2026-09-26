import { tileKey, keyTile, farthestPathTile, sidePathTiles, buildAnchors, uncoveredAnchors, pickSite,
         createSpotAccumulator, buildQueue, DEFAULT_CHEAP_BUILD_OPTIONS } from "./build/cheap-builds.mjs";
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

// --- sides (#81 east/west): farthest reachable tile each side of the front -> back line
// A T: a spine from (20,10) to (20,40), and a crossbar at y = 25 from x = 0 to x = 40.
const tee = [];
for (let y = 10; y < 40; y++) tee.push([[20, y], [20, y + 1]]);
for (let x = 0; x < 40; x++) tee.push([[x, 25], [x + 1, 25]]);
const sd = sidePathTiles([tileKey(20, 10)], graph(tee), { x: 20, y: 9 }, { x: 20, y: 40 }, 12);
ok(sd.length === 2 && sd.some((t) => t.x === 0 && t.y === 25) && sd.some((t) => t.x === 40 && t.y === 25),
    "both ends of the crossbar, got " + JSON.stringify(sd));
const narrow = sidePathTiles([tileKey(20, 10)], graph(tee), { x: 20, y: 9 }, { x: 20, y: 40 }, 21);
ok(narrow.length === 0, "flanks under minOffset are not sides");
const cut = sidePathTiles([tileKey(20, 10)], graph([...tee.filter(([a]) => a[0] >= 20 || a[1] !== 25), [[60, 60], [60, 61]]]),
    { x: 20, y: 9 }, { x: 20, y: 40 }, 12);
ok(cut.length === 1 && cut[0].x === 40, "only reachable tiles, one side, got " + JSON.stringify(cut));
ok(sidePathTiles([tileKey(20, 10)], graph(tee), { x: 5, y: 5 }, { x: 5, y: 5 }, 12).length === 0, "front == back -> none");

// --- anchors: front, then back if deep enough, then clusters -----------------------
const a1 = buildAnchors([{ x: 5, y: 5 }], { x: 60, y: 60, steps: 80 }, [{ x: 50, y: 10 }], [{ x: 30, y: 30 }], OPT);
ok(a1.map((a) => a.role).join() === "front,back,side,cluster", "anchor order");
const a2 = buildAnchors([{ x: 5, y: 5 }], { x: 9, y: 9, steps: OPT.minBackSteps - 1 }, [], [], OPT);
ok(a2.length === 1 && a2[0].role === "front", "shallow park has no back anchor");
ok(buildAnchors([], null, [], [], OPT).length === 0, "no entrance, no anchors");

// --- coverage: anything within coverRadius covers an anchor ------------------------
const un1 = uncoveredAnchors(a1, [{ x: 5 + OPT.coverRadius, y: 5 }], OPT);
ok(un1.map((a) => a.role).join() === "back,side,cluster", "front covered at exactly coverRadius");
const un2 = uncoveredAnchors(a1, [{ x: 5 + OPT.coverRadius + 1, y: 5 }], OPT);
ok(un2.length === 4, "one tile further does not cover");
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

// --- build queue: every kind's front before any back, kinds in order (#82) ---------
const A = (role, x) => ({ role, x, y: 0 });
const q = buildQueue([
    { kind: "kiosk", anchors: [A("front", 1), A("back", 2), A("cluster", 3)] },
    { kind: "atm", anchors: [A("front", 4), A("cluster", 5)] },
]);
ok(q.map((e) => e.kind + ":" + e.anchor.role).join() === "kiosk:front,atm:front,kiosk:back,kiosk:cluster,atm:cluster",
   "queue order, got " + q.map((e) => e.kind + ":" + e.anchor.role).join());
ok(buildQueue([]).length === 0, "empty queue");

console.log(`${pass} passed, ${fail} failed`);
