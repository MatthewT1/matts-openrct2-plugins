import { pickTvTiles, hotReach, edgeCount, DEFAULT_QUEUE_TV_OPTIONS } from "./build/queue-tv.mjs";
let pass=0, fail=0; const ok=(c,m)=>{ c?pass++:(fail++,console.log("FAIL:",m)); };
const OPT = { spacing: 3, maxPerQueue: 4 };
const T = (o = {}) => ({ x: 0, y: 0, edgeCount: 2, hasAddition: false, hasTv: false, ...o });
const q = (n, over = {}) => Array.from({ length: n }, (_, i) => T(over[i] || {}));

ok(edgeCount(0b1111) === 4 && edgeCount(0b0101) === 2 && edgeCount(0b10000) === 0, "edgeCount low 4 bits only");

// Front first, every 3rd tile, capped by the budget.
ok(pickTvTiles(q(20), OPT, 2).join() === "0,3", "front first, spaced, budget 2");
ok(pickTvTiles(q(20), OPT, 10).join() === "0,3,6,9", "stops at maxPerQueue");
ok(pickTvTiles(q(20), OPT, 0).length === 0, "no budget, no TVs");

// Existing TVs count toward the cap and keep their spacing.
ok(pickTvTiles(q(20, { 1: { hasTv: true, hasAddition: true } }), OPT, 10).join() === "4,7,10",
   "spacing kept from an existing TV, cap includes it");
const full = q(20, { 0: { hasTv: true, hasAddition: true }, 3: { hasTv: true, hasAddition: true },
                     6: { hasTv: true, hasAddition: true }, 9: { hasTv: true, hasAddition: true } });
ok(pickTvTiles(full, OPT, 10).length === 0, "queue at maxPerQueue gets nothing");

// Never replaces the player's addition; never a 4-edge tile.
ok(pickTvTiles(q(10, { 0: { hasAddition: true }, 1: { edgeCount: 4 } }), OPT, 1).join() === "2",
   "skips occupied and 4-edge tiles");
ok(pickTvTiles([], OPT, 2).length === 0, "empty queue");

// Default (#116): every 2nd tile, no per-queue cap beyond the budget.
ok(pickTvTiles(q(9), DEFAULT_QUEUE_TV_OPTIONS, 100).join() === "0,2,4,6,8", "default: every 2nd tile");
ok(pickTvTiles(q(9, { 2: { hasAddition: true } }), DEFAULT_QUEUE_TV_OPTIONS, 100).join() === "0,3,5,7",
   "default: skips an occupied tile and keeps spacing");

// #141: TVs only where a long waiter stands, from the front to that tile + 2.
const hot = (set) => (t) => set.includes(t.x);
const line = (n) => Array.from({ length: n }, (_, i) => T({ x: i }));
ok(hotReach(line(10), hot([])) === -1, "no long waiter: no reach");
ok(hotReach(line(10), hot([3])) === 5, "reach = deepest hot + 2");
ok(hotReach(line(10), hot([1, 4])) === 6, "deepest of several hot tiles");
ok(hotReach(line(10), hot([9])) === 9, "reach clamped to the queue end");
ok(pickTvTiles(line(10), DEFAULT_QUEUE_TV_OPTIONS, 100, hotReach(line(10), hot([3]))).join() === "0,2,4",
   "every 2nd tile from the front up to reach");
ok(pickTvTiles(line(10), DEFAULT_QUEUE_TV_OPTIONS, 1, 5).join() === "0", "budget still caps a hot queue");

console.log(`${pass} passed, ${fail} failed`);
