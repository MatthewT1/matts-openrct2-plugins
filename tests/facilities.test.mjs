import { createFacilityTracker, planFacilities, describePlan,
         DEFAULT_FACILITY_OPTIONS } from "./build/facilities.mjs";
import { CLUSTER_MIN_GUESTS } from "./build/needs.mjs";
let pass=0, fail=0; const ok=(c,m)=>{ c?pass++:(fail++,console.log("FAIL:",m)); };

const OPT = { minGuests:5, minDistance:12, confirmSweeps:3, maxPerKind:8, maxPlacements:1, siteRadius:6, mergeRadius:12 };
const G = (kind,x,y,guests,distance)=>({kind,x,y,guests,distance});
const S = (x,y)=>({x,y,z:16,direction:0});
/** Feeds the same gap n times and returns the last confirmed list. */
const sweep=(t,gaps,n)=>{ let c=[]; for(let i=0;i<n;i++) c=t.observe(gaps); return c; };

// --- hysteresis: a gap must persist before it can authorise anything --------------
const t1=createFacilityTracker(OPT);
const strong=[G("hunger",60,92,20,23)];
ok(t1.observe(strong).length===0, "one sweep confirms nothing");
ok(t1.observe(strong).length===0, "two sweeps confirm nothing");
ok(t1.observe(strong).length===1, "third sweep confirms at confirmSweeps=3");

// A cluster that appears once and vanishes is forgotten, not remembered.
const t2=createFacilityTracker(OPT);
t2.observe(strong);
t2.observe([]);
ok(t2.pending().length===0, "single-sweep blip decays to nothing");

// ...but a gap that blinks out for ONE sweep keeps most of its evidence. This is the
// case that matters: guests walk, so a real gap disappears from a sweep all the time.
const t3=createFacilityTracker(OPT);
t3.observe(strong); t3.observe(strong);   // streak 2
t3.observe([]);                            // decays to 1, NOT to 0
ok(t3.pending().length===1 && t3.pending()[0].sweeps===1, "absence decays, does not reset");
t3.observe(strong); t3.observe(strong);
ok(t3.observe(strong).length===1, "recovers and confirms after the blip");

// --- the actionable filter -------------------------------------------------------
const t4=createFacilityTracker(OPT);
ok(sweep(t4,[G("toilet",10,10,4,50)],5).length===0, "small cluster never confirms (minGuests)");
const t5=createFacilityTracker(OPT);
ok(sweep(t5,[G("toilet",10,10,20,11)],5).length===0, "cluster inside minDistance is not a gap");
const t6=createFacilityTracker(OPT);
ok(sweep(t6,[G("toilet",10,10,20,12)],5).length===1, "minDistance boundary is inclusive");

// distance -1 means NO facility of that kind exists anywhere — the worst case, not the
// best. Getting this backwards would make a park with no toilets look perfectly served.
const t7=createFacilityTracker(OPT);
ok(sweep(t7,[G("toilet",10,10,20,-1)],5).length===1, "no-facility-at-all always confirms");

// --- ordering --------------------------------------------------------------------
const t8=createFacilityTracker(OPT);
const c8=sweep(t8,[G("hunger",60,92,20,23), G("hunger",4,4,20,78), G("toilet",1,1,20,-1)],5);
ok(c8.length===3, "three confirmed");
ok(c8[0].distance===-1, "no-facility sorts first");
ok(c8[1].distance===78 && c8[2].distance===23, "then farthest first");

// --- planning --------------------------------------------------------------------
const gaps=sweep(createFacilityTracker(OPT),[G("hunger",60,92,20,23)],5);
const plans=planFacilities(gaps,[S(60,90)],{hunger:3},OPT);
ok(plans.length===1 && plans[0].kind==="hunger", "plans a food stall");
ok(plans[0].site.x===60 && plans[0].site.y===90, "uses the site");
ok(plans[0].site.z===16 && plans[0].site.direction===0, "carries z/direction through");
ok(/23 tiles away/.test(plans[0].reason), "reason names the distance");
ok(/food stall/.test(describePlan(plans[0])), "describePlan names the facility");

// nearest site wins, because walking distance IS the problem being solved
const near=planFacilities(gaps,[S(64,94), S(60,91), S(58,90)],{},OPT);
ok(near[0].site.x===60 && near[0].site.y===91, "picks the nearest site, got "+JSON.stringify(near[0].site));

// a site out of reach of the cluster does not serve it
ok(planFacilities(gaps,[S(60,99)],{},OPT).length===0, "site beyond siteRadius is not used");
ok(planFacilities(gaps,[],{},OPT).length===0, "no sites, no plans");

// --- the caps --------------------------------------------------------------------
ok(planFacilities(gaps,[S(60,90)],{hunger:8},OPT).length===0, "maxPerKind blocks at the cap");
ok(planFacilities(gaps,[S(60,90)],{hunger:7},OPT).length===1, "one below the cap is allowed");
ok(planFacilities(gaps,[S(60,90)],{},{...OPT,maxPlacements:0}).length===0, "maxPlacements 0 plans nothing");

// Two clusters of the SAME kind in one pass must both count against maxPerKind, or the
// cap is meaningless whenever more than one plan is budgeted.
const two=sweep(createFacilityTracker(OPT),[G("hunger",10,10,20,40), G("hunger",40,40,20,50)],5);
const capped=planFacilities(two,[S(10,11),S(40,41)],{hunger:7},{...OPT,maxPlacements:2});
ok(capped.length===1, "second plan of a kind respects the cap set by the first, got "+capped.length);

// Distinct kinds have independent caps.
const mixed=sweep(createFacilityTracker(OPT),[G("hunger",10,10,20,40), G("toilet",40,40,20,50)],5);
const both=planFacilities(mixed,[S(10,11),S(40,41)],{hunger:7,toilet:0},{...OPT,maxPlacements:2});
ok(both.length===2, "caps are per kind, got "+both.length);

// --- one site cannot serve two plans ---------------------------------------------
const share=sweep(createFacilityTracker(OPT),[G("hunger",10,10,20,40), G("toilet",10,10,20,50)],5);
const shared=planFacilities(share,[S(10,11)],{},{...OPT,maxPlacements:2});
ok(shared.length===1, "one site yields one plan, got "+shared.length);

// --- clear() forces a gap to re-prove itself -------------------------------------
const t9=createFacilityTracker(OPT);
sweep(t9,[G("hunger",60,92,20,23)],5);
t9.clear("hunger",60,92);
ok(t9.pending().length===0, "clear forgets the gap");
ok(t9.observe([G("hunger",60,92,20,23)]).length===0, "and it must earn confirmation again");

// --- planFacilities must not mutate the caller's counts --------------------------
const counts={hunger:3};
planFacilities(gaps,[S(60,90)],counts,OPT);
ok(counts.hunger===3, "existingCounts is not mutated, got "+counts.hunger);

// --- freshest numbers, oldest evidence -------------------------------------------
// The streak is the memory; the guest count and distance should describe the park now.
const t10=createFacilityTracker(OPT);
t10.observe([G("hunger",60,92,20,23)]);
t10.observe([G("hunger",60,92,20,23)]);
const fresh=t10.observe([G("hunger",60,92,31,40)]);
ok(fresh[0].guests===31 && fresh[0].distance===40, "carries the freshest measurements");
ok(fresh[0].sweeps===3, "while keeping the accumulated streak");

// --- defaults are the shipped behaviour ------------------------------------------
ok(DEFAULT_FACILITY_OPTIONS.maxPlacements===1, "ships one placement per pass");
// The window must be REACHABLE against the measured sweep rate (~4 sweeps per session
// before the sampling rate was tripled), while still demanding sustained agreement.
ok(DEFAULT_FACILITY_OPTIONS.confirmSweeps>=4 && DEFAULT_FACILITY_OPTIONS.confirmSweeps<=6,
   "confirmation window is sustained but reachable, got "+DEFAULT_FACILITY_OPTIONS.confirmSweeps);
ok(DEFAULT_FACILITY_OPTIONS.maxPerKind<=8, "ships a hard per-kind cap");
// A site further away than the facility the guests ALREADY walk to is no improvement:
// the plugin would spend a stall's worth of money to move the walk from 12 tiles to 13.
// Keeping siteRadius below minDistance makes every placement a strict improvement by
// construction. Measured 2026-09-20: siteRadius was 6 and `facilityNoSite` fired on 7
// passes with three gaps confirmed, so it needed raising - but only this far.
ok(DEFAULT_FACILITY_OPTIONS.siteRadius < DEFAULT_FACILITY_OPTIONS.minDistance,
   "siteRadius stays under minDistance so a placement is always closer, got "
   +DEFAULT_FACILITY_OPTIONS.siteRadius+" vs "+DEFAULT_FACILITY_OPTIONS.minDistance);

// The measured gaps must find a site at the shipped radius. A site 10 tiles from the
// (60,92) cluster serves it far better than the 23-tile walk it has now.
const realOpts=DEFAULT_FACILITY_OPTIONS;
const realConf=sweep(createFacilityTracker(realOpts),[G("hunger",60,92,14,23)],realOpts.confirmSweeps);
ok(planFacilities(realConf,[S(60,92-realOpts.siteRadius)],{},realOpts).length===1,
   "a site at the full shipped radius is usable");
ok(planFacilities(realConf,[S(60,92-realOpts.siteRadius-1)],{},realOpts).length===0,
   "one tile beyond it is not");
// The real measured gaps must actually clear the shipped thresholds, or the feature
// ships dead — the failure mode that hit five features on this project already.
const real=createFacilityTracker(DEFAULT_FACILITY_OPTIONS);
const realGaps=sweep(real,[G("hunger",60,92,21,23), G("hunger",4,4,20,78)],DEFAULT_FACILITY_OPTIONS.confirmSweeps);
ok(realGaps.length===2, "the two measured hunger gaps clear the shipped thresholds, got "+realGaps.length);


// --- flat ground is a PREFERENCE, not a requirement ------------------------------
// Measured 2026-09-20: rejecting sloped tiles outright fired 6,013 times against ZERO
// accepted across a whole session, so on a hilly park nothing could ever be built.
// TrackPlaceAction has no general flat-ground rule (its only slope test guards water
// rides), so the verdict belongs to the queryAction before each placement.
const F = (x,y,flat)=>({x,y,z:16,direction:0,flat});
const gapsF = sweep(createFacilityTracker(OPT),[G("hunger",60,92,20,23)],5);

// A sloped tile is usable when it is the only one.
ok(planFacilities(gapsF,[F(60,90,false)],{},OPT).length===1, "a sloped site is still usable");

// Flat wins a tie at equal distance.
const tie = planFacilities(gapsF,[F(58,92,false), F(62,92,true)],{},OPT);
ok(tie[0].site.flat===true, "flat breaks a tie at equal distance");

// ...but NEARER wins over flat, because walking distance is the problem being solved.
const nearer = planFacilities(gapsF,[F(60,91,false), F(60,88,true)],{},OPT);
ok(nearer[0].site.y===91 && nearer[0].site.flat===false,
   "a nearer sloped site beats a further flat one, got "+JSON.stringify(nearer[0].site));


// --- no dead zone between the cluster floor and the actionable floor -------------
// REGRESSION (2026-09-20): needs.ts passed clusters at >= 3 while the planner required
// >= 5, so anything in the 3-4 band was reported as a gap, logged to the console and
// published in telemetry - and could never become actionable. Measured on a 670-guest
// park, EVERY gap present held exactly 3 guests, so nothing could ever confirm.
//
// Same failure as the staffing controller's v2 deadlock: two thresholds expressing
// different standards for one signal, leaving a band the park actually sits in.
ok(DEFAULT_FACILITY_OPTIONS.minGuests === CLUSTER_MIN_GUESTS,
   "the planner uses the SAME floor as the clustering layer, got "
   + DEFAULT_FACILITY_OPTIONS.minGuests + " vs " + CLUSTER_MIN_GUESTS);

// A cluster at exactly the shared floor must be actionable, not merely reportable.
const realOpt = DEFAULT_FACILITY_OPTIONS;
const atFloor = sweep(createFacilityTracker(realOpt),
                      [G("thirst", 100, 84, CLUSTER_MIN_GUESTS, 23)], realOpt.confirmSweeps);
ok(atFloor.length === 1,
   "a cluster at the shared floor confirms, got " + atFloor.length);

// One below it is still noise, so the floor still means something.
const below = sweep(createFacilityTracker(realOpt),
                    [G("thirst", 100, 84, CLUSTER_MIN_GUESTS - 1, 23)], realOpt.confirmSweeps);
ok(below.length === 0, "one guest below the floor is still rejected, got " + below.length);

// The measured gaps from the park that exposed this must now be actionable.
const measured = sweep(createFacilityTracker(realOpt),
                       [G("thirst", 100, 84, 3, 23), G("hunger", 100, 68, 3, 16)],
                       realOpt.confirmSweeps);
ok(measured.length === 2, "both measured 3-guest gaps confirm, got " + measured.length);
// ...but the one standing next to its facility is still correctly ignored.
const adjacent = sweep(createFacilityTracker(realOpt),
                       [G("thirst", 68, 92, 3, 1)], realOpt.confirmSweeps);
ok(adjacent.length === 0, "a cluster 1 tile from its facility is not a coverage gap");


// --- a wandering cluster must still accumulate ------------------------------------
// REGRESSION (2026-09-20): the tracker keyed gaps on EXACT cell coordinates. A cluster
// is a snapshot of where sampled guests happened to stand, so at the noise floor the
// particular 8-tile cell that trips the threshold moves every sweep. Measured over 105
// records, gaps appeared at (76,68) (76,84) (84,84) (92,68) (92,76) (100,68) (100,84)
// (108,60) and EVERY ONE peaked at exactly 1 sweep - each sweep minted a fresh key and
// decayed the last to nothing. confirmSweeps was unreachable however real the need.
const wander = createFacilityTracker(OPT);
const spots = [[76,68],[84,68],[76,76],[84,76],[80,72]];
let confirmedWander = [];
for (let i = 0; i < 6; i++) {
  const [x,y] = spots[i % spots.length];
  confirmedWander = wander.observe([G("hunger", x, y, 6, 30)]);
}
ok(confirmedWander.length === 1,
   "a cluster jittering inside the merge radius accumulates, got " + confirmedWander.length);
ok(wander.pending().length === 1, "and is tracked as ONE gap, got " + wander.pending().length);

// The anchor must NOT chase each sighting, or the build site walks across the park
// while the streak claims it has been stable.
ok(wander.pending()[0].x === 76 && wander.pending()[0].y === 68,
   "the first anchor is kept, got (" + wander.pending()[0].x + ", " + wander.pending()[0].y + ")");

// #80: several clusters merging into one gap in the SAME sweep add one streak point,
// not one each. Measured in the harness: a toilet gap went 9 -> 24 in three sweeps.
const multi = createFacilityTracker(OPT);
multi.observe([G("toilet", 40, 40, 5, 20), G("toilet", 44, 40, 9, 22), G("toilet", 40, 46, 6, 21)]);
ok(multi.pending().length === 1 && multi.pending()[0].sweeps === 1,
   "three merged sightings in one sweep count once, got " + multi.pending()[0].sweeps);
ok(multi.pending()[0].guests === 9, "and keep the strongest reading, got " + multi.pending()[0].guests);
let multiConfirmed = [];
for (let i = 1; i < OPT.confirmSweeps; i++)
  multiConfirmed = multi.observe([G("toilet", 40, 40, 5, 20), G("toilet", 44, 40, 9, 22)]);
ok(multiConfirmed.length === 1, "and confirm after exactly confirmSweeps sweeps");

// Genuinely distant gaps of the same kind stay separate.
const apart = createFacilityTracker(OPT);
apart.observe([G("hunger", 10, 10, 6, 30), G("hunger", 90, 90, 6, 30)]);
ok(apart.pending().length === 2, "far-apart gaps stay distinct, got " + apart.pending().length);

// Different kinds never merge, however close.
const kinds = createFacilityTracker(OPT);
kinds.observe([G("hunger", 50, 50, 6, 30), G("toilet", 50, 50, 6, 30)]);
ok(kinds.pending().length === 2, "different needs at one spot stay distinct");

// A missing mergeRadius must mean "merge nothing", not "merge everything" - `d >
// undefined` is false, which would fold every gap of a kind into the first ever seen.
const noRadius = createFacilityTracker({...OPT, mergeRadius: undefined});
noRadius.observe([G("hunger", 10, 10, 6, 30), G("hunger", 90, 90, 6, 30)]);
ok(noRadius.pending().length === 2, "undefined mergeRadius merges nothing, got " + noRadius.pending().length);

// Building clears the whole merged region, so a near-duplicate cannot authorise a
// second facility next to the one just built.
const cleared = createFacilityTracker(OPT);
sweep(cleared, [G("thirst", 60, 60, 6, 30)], OPT.confirmSweeps);
cleared.observe([G("thirst", 66, 60, 6, 30)]);       // same gap, jittered
cleared.clear("thirst", 60, 60);
ok(cleared.pending().length === 0, "clear drops the merged region, got " + cleared.pending().length);

console.log(`${pass} passed, ${fail} failed`);
