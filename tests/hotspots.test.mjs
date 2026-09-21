import { createHotspotAccumulator } from "./build/hotspots.mjs";
let pass=0, fail=0;
const ok=(c,m)=>{ c?pass++:(fail++,console.log("FAIL:",m)); };

// cell size 8 tiles => 256 world units per cell
const a = createHotspotAccumulator(8);
ok(a.top(3).length===0, "empty -> []");
ok(a.top(0).length===0, "top(0) -> []");

// 10 pieces in one cell (tiles 40..47 -> world 1280..1504), 3 old, 2 vomit
for (let i=0;i<10;i++) a.add(1280+i*16, 1280, i<3, i<2);
// 5 pieces in a far cell, 5 old
for (let i=0;i<5;i++) a.add(3200, 3200, true, false);
const t=a.top(3);
ok(t.length===2, "two distinct cells, got "+t.length);
ok(t[0].oldCount===5 && t[0].count===5, "ranked by oldCount desc first");
ok(t[1].count===10 && t[1].oldCount===3 && t[1].vomit===2, "second cell counts");
// centre of cell containing tile 40 with size 8 => cellX=5 => 5*8+4 = 44
ok(t[1].x===44 && t[1].y===44, "centre in TILE coords, got "+t[1].x+","+t[1].y);

// negative / out of range must not throw or corrupt
a.add(-9999,-9999,false,false); a.add(99999999,99999999,true,false);
ok(a.top(10).length===4, "clamped extremes bucket without throwing");

a.reset();
ok(a.top(3).length===0, "reset clears");

// non-power-of-two rounds up: 5 -> 8
const b=createHotspotAccumulator(5);
b.add(0,0,false,false);
ok(b.top(1)[0].x===4, "cellTiles 5 rounds up to 8 (centre 4), got "+b.top(1)[0].x);

// cellTiles 1 -> max cell index 999, must not collide across axes
const c=createHotspotAccumulator(1);
c.add(999*32, 0, true,false); c.add(0, 999*32, true,false);
ok(c.top(5).length===2, "no key collision at max coords, got "+c.top(5).length);

// top(n) with fewer cells
ok(c.top(99).length===2, "top(n) clamps to available");
console.log(`\n${pass} passed, ${fail} failed`);
if (fail) process.exitCode = 1;
