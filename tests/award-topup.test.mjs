import { planAwardTopUp, awardNeed, pickTopUpAnchor, nearestTopUpSite, scaledFacilityCap, DEFAULT_AWARD_TOPUP_OPTIONS as O } from "./build/award-topup.mjs";
let pass=0, fail=0; const ok=(c,m)=>{ c?pass++:(fail++,console.log("FAIL:",m)); };
const C = (guests, toilets, foodStalls, foodItems, newFoodItemUnlocked = true) => ({ guests, toilets, foodStalls, foodItems, newFoodItemUnlocked });

// --- awardNeed: the game's integer division with a floor (Award.cpp:327, 401-405) -----
ok(awardNeed(300, 4, 128) === 4, "small park needs the minimum");
ok(awardNeed(1279, 4, 128) === 9, "1279 guests / 128 floors to 9");
ok(awardNeed(1280, 4, 128) === 10, "1280 guests need 10");

// --- planAwardTopUp --------------------------------------------------------------------
ok(planAwardTopUp(C(300, 4, 7, 4), O) === null, "park already at both counts: nothing");
let p = planAwardTopUp(C(301, 3, 1, 1), O);
ok(p && p.kind === "toilet" && p.have === 3 && p.need === 4, "Frozen Flats: 3 of 4 toilets -> a toilet");
p = planAwardTopUp(C(643, 2, 3, 3), O);
ok(p && p.kind === "toilet", "Big Pier: 2 short on toilets still a top-up");
p = planAwardTopUp(C(262, 4, 5, 4), O);
ok(p && p.kind === "hunger" && p.need === 7 && !p.varietyOnly, "Cliffside Castle: toilets fine, 5 of 7 food stalls -> food");
p = planAwardTopUp(C(301, 3, 6, 4), O);
ok(p && p.kind === "toilet", "toilets come before food when both are short");
ok(planAwardTopUp(C(2418, 3, 6, 4), O) === null, "Planet Llipe: 15 toilets and 12 stalls short is not a top-up");
p = planAwardTopUp(C(1445, 7, 14, 8), O);
ok(p === null, "Zeron: 4 toilets short (11 needed) is past maxShort, food is met");
p = planAwardTopUp(C(907, 8, 8, 3), O);
ok(p && p.kind === "hunger" && p.varietyOnly && p.have === 3 && p.need === 4, "Katie's World: enough stalls, 3 items -> a new item");
ok(planAwardTopUp(C(907, 8, 8, 3, false), O) === null, "no new item unlocked: another stall would not help, so nothing");
ok(planAwardTopUp(C(907, 8, 8, 0), O) === null, "4 item types short is past maxShort");
p = planAwardTopUp(C(833, 6, 6, 3, false), O);
ok(p && p.kind === "hunger" && !p.varietyOnly, "count short builds even with no new item unlocked");
ok(planAwardTopUp(C(0, 0, 0, 0), O) === null, "empty park (4 toilets short) is the need builder's job");
ok(planAwardTopUp(C(300, 5, 9, 6), O) === null, "over the counts: nothing");

// --- pickTopUpAnchor ---------------------------------------------------------------------
const clusters = [{ kind: "toilet", x: 10, y: 10, guests: 4 }, { kind: "toilet", x: 50, y: 50, guests: 9 }, { kind: "hunger", x: 80, y: 80, guests: 30 }];
let a = pickTopUpAnchor("toilet", clusters, [], []);
ok(a.x === 50 && a.y === 50, "biggest cluster of the same kind wins");
a = pickTopUpAnchor("hunger", clusters, [], []);
ok(a.x === 80, "other kinds' clusters are ignored");
const paths = [{ x: 5, y: 5 }, { x: 40, y: 40 }, { x: 90, y: 90 }];
a = pickTopUpAnchor("toilet", [clusters[2]], [{ x: 6, y: 6 }, { x: 88, y: 88 }], paths);
ok(a.x === 40 && a.y === 40, "no cluster: the path tile farthest from every existing toilet");
a = pickTopUpAnchor("toilet", [], [], paths);
ok(a !== null && a.x === 5, "no cluster and no existing facility: first path tile");
ok(pickTopUpAnchor("toilet", [], [{ x: 1, y: 1 }], []) === null, "nothing to go by: null");

// --- nearestTopUpSite --------------------------------------------------------------------
const sites = [{ x: 12, y: 10, flat: false }, { x: 10, y: 12, flat: true }, { x: 30, y: 30, flat: true }];
let s = nearestTopUpSite({ x: 10, y: 10 }, sites, 10);
ok(s.x === 10 && s.y === 12, "equal distance: flat wins");
ok(nearestTopUpSite({ x: 10, y: 10 }, [sites[2]], 10) === null, "site outside the radius is not used");
ok(nearestTopUpSite({ x: 10, y: 10 }, [], 10) === null, "no sites: null");

// --- scaledFacilityCap -------------------------------------------------------------------
ok(scaledFacilityCap(8, 500, 128) === 8, "small park keeps the flat cap");
ok(scaledFacilityCap(8, 1024, 128) === 9, "1024 guests: 8 + 1 spare");
ok(scaledFacilityCap(8, 2487, 128) === 20, "Fungus Woods: 19 + 1");

console.log(`${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
