import { pickCourtAmenities, courtNeedsToilet, courtAmenityKind, DEFAULT_COURT_EXTRAS } from "./build/court-extras.mjs";
let pass=0, fail=0; const ok=(c,m)=>{ c?pass++:(fail++,console.log("FAIL:",m)); };
const O = DEFAULT_COURT_EXTRAS; // radius 3, toilet reach 8
const T = (x, y, o = {}) => ({ x, y, isQueue: false, blocked: false, occupied: false, ...o });
const c = { x: 10, y: 10 };

const row = [T(9, 10), T(10, 10), T(11, 10), T(12, 10), T(13, 10), T(14, 10)];
let p = pickCourtAmenities(c, row, O, 99);
ok(p.length === 5, "tiles within radius 3 only (14 is 4 away): " + p.length);
ok(p[0].x === 10, "nearest the centre first");
ok(courtAmenityKind(10, 10) === "bench" && courtAmenityKind(11, 10) === "bin", "checkerboard bench/bin");
ok(p.filter(a => a.kind === "bench").length >= 2 && p.filter(a => a.kind === "bin").length >= 2, "both kinds placed");

p = pickCourtAmenities(c, [T(10, 10, { isQueue: true }), T(11, 10, { blocked: true }), T(12, 10, { occupied: true }), T(9, 10)], O, 99);
ok(p.length === 1 && p[0].x === 9, "skips queue, blocked and occupied tiles (never replaces the player's items)");
ok(pickCourtAmenities(c, row, O, 2).length === 2, "limit (budget) respected");
ok(pickCourtAmenities(c, [T(13, 13)], O, 9).length === 1, "corner of the square counts (Chebyshev 3)");

ok(courtNeedsToilet(c, [], O), "no toilets: needs one");
ok(!courtNeedsToilet(c, [{ x: 14, y: 14 }], O), "toilet 8 away serves it");
ok(courtNeedsToilet(c, [{ x: 15, y: 14 }], O), "toilet 9 away does not");

console.log(`${pass} passed, ${fail} failed`);

