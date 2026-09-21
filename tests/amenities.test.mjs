import { planAmenities } from "./build/amenities.mjs";
let pass=0, fail=0; const ok=(c,m)=>{ c?pass++:(fail++,console.log("FAIL:",m)); };
const site=(x,y,o={})=>({x,y,occupied:false,existing:null,ours:false,isQueue:false,blocked:false,...o});
const dem=(x,y,kind,weight,reason="r")=>({x,y,kind,weight,reason});
const OPT={radius:4,maxPlace:3,maxRemove:2,satisfiedWithin:5,allowRemoval:true};

// empties
ok(planAmenities([],[],OPT).place.length===0, "empty inputs");
ok(planAmenities([site(0,0)],[],OPT).place.length===0, "no demands");

// basic placement: nearest free tile
let p=planAmenities([site(5,5),site(1,1)],[dem(1,2,"bench",10)],OPT);
ok(p.place.length===1 && p.place[0].x===1 && p.place[0].y===1, "nearest site chosen, got "+JSON.stringify(p.place));

// SAFETY: never place on queue or occupied
p=planAmenities([site(1,1,{isQueue:true}),site(1,2,{occupied:true,existing:"bin"})],[dem(1,1,"bench",10)],OPT);
ok(p.place.length===0, "never places on queue or occupied tile, got "+JSON.stringify(p.place));

// already satisfied -> no duplicate
p=planAmenities([site(2,2,{occupied:true,existing:"bench"}),site(3,3)],[dem(2,2,"bench",10)],OPT);
ok(p.place.length===0, "existing bench satisfies demand, no stacking");
// ...even if it's the player's
p=planAmenities([site(2,2,{occupied:true,existing:"bench",ours:false}),site(3,3)],[dem(2,2,"bench",10)],OPT);
ok(p.place.length===0, "player's bench also satisfies");
// but a BIN does not satisfy a BENCH demand
p=planAmenities([site(2,2,{occupied:true,existing:"bin"}),site(3,3)],[dem(2,2,"bench",10)],OPT);
ok(p.place.length===1 && p.place[0].kind==="bench", "wrong kind does not satisfy");

// budget respected, highest weight first
const many=[site(0,0),site(0,1),site(0,2),site(0,3),site(0,4),site(0,5)];
p=planAmenities(many,[dem(0,0,"bench",1),dem(0,1,"bench",99),dem(0,2,"bench",50),dem(0,3,"bench",25)],{...OPT,satisfiedWithin:0});
ok(p.place.length===3, "maxPlace respected, got "+p.place.length);

// no two placements on the same tile
const dup=planAmenities([site(7,7)],[dem(7,7,"bench",10),dem(7,7,"bench",9)],{...OPT,satisfiedWithin:0});
ok(dup.place.length===1, "one tile used once, got "+dup.place.length);

// out of radius -> nothing
p=planAmenities([site(50,50)],[dem(0,0,"bench",10)],OPT);
ok(p.place.length===0, "respects radius");

// *** SAFETY: removal only ever touches OURS ***
const far=[site(80,80,{occupied:true,existing:"bench",ours:false}),
           site(81,81,{occupied:true,existing:"bench",ours:true})];
p=planAmenities(far,[dem(0,0,"bench",10)],OPT);
ok(p.remove.length===1 && p.remove[0].x===81, "removes only ours, never the player's, got "+JSON.stringify(p.remove));

// removal disabled
p=planAmenities(far,[dem(0,0,"bench",10)],{...OPT,allowRemoval:false});
ok(p.remove.length===0, "allowRemoval:false suppresses all removal");

// ours but still near a demand -> keep
p=planAmenities([site(1,1,{occupied:true,existing:"bench",ours:true})],[dem(1,2,"bench",10)],OPT);
ok(p.remove.length===0, "keeps ours while still justified");

// ours, near a demand of the WRONG kind -> remove
p=planAmenities([site(1,1,{occupied:true,existing:"bench",ours:true})],[dem(1,2,"bin",10)],OPT);
ok(p.remove.length===1, "wrong-kind demand does not justify keeping");

// maxRemove respected
const lots=[0,1,2,3,4].map(i=>site(90+i,90,{occupied:true,existing:"bench",ours:true}));
p=planAmenities(lots,[dem(0,0,"bench",10)],OPT);
ok(p.remove.length===2, "maxRemove respected, got "+p.remove.length);

// determinism
const a=JSON.stringify(planAmenities(many,[dem(0,2,"bench",5),dem(0,3,"bench",5)],{...OPT,satisfiedWithin:0}));
const b=JSON.stringify(planAmenities(many,[dem(0,2,"bench",5),dem(0,3,"bench",5)],{...OPT,satisfiedWithin:0}));
ok(a===b, "deterministic across runs");

// *** NEW: blocked tiles (sloped path / all-four-edges) are never placed on ***
let bp=planAmenities([site(1,1,{blocked:true})],[dem(1,1,"bench",10)],OPT);
ok(bp.place.length===0, "never places on a blocked (sloped/enclosed) tile, got "+JSON.stringify(bp.place));
// and a blocked tile does not stop a good neighbour being used
bp=planAmenities([site(1,1,{blocked:true}),site(1,2)],[dem(1,1,"bench",10)],OPT);
ok(bp.place.length===1 && bp.place[0].y===2, "falls through to the nearest placeable tile, got "+JSON.stringify(bp.place));
// a blocked tile that already holds OUR amenity can still be removed
bp=planAmenities([site(80,80,{blocked:true,occupied:true,existing:"bench",ours:true})],[dem(0,0,"bench",10)],OPT);
ok(bp.remove.length===1, "blocked tiles are still removable, got "+bp.remove.length);
console.log(`\n${pass} passed, ${fail} failed`);
if (fail) process.exitCode = 1;
