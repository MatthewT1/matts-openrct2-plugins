/**
 * Food court extras (#83). Which tiles is decided in court-extras.ts (tested); this file
 * finds the courts (the same findCourts the stall placement and entertainer stations
 * use), fills the path tiles around each with benches and bins, and builds one toilet
 * where no toilet is near, all from the monthly extras budget (extras-budget.ts).
 *
 * Items placed here are never removed: the amenity planner treats them like the
 * player's, so its removal pass cannot churn a court.
 */

import { DebugChannel } from "../debug";
import { BuilderSettings } from "./settings";
import { ExtrasBudget } from "../extras-budget";
import { StallBuilder } from "./stall-build";
import { findCourts, DEFAULT_COURT_OPTIONS, Court } from "../facilities";
import { pickCourtAmenities, courtNeedsToilet, DEFAULT_COURT_EXTRAS, CourtPathTile, CourtAmenity } from "../court-extras";
import { pickSite, DEFAULT_CHEAP_BUILD_OPTIONS } from "../cheap-builds";

const OPTIONS = DEFAULT_COURT_EXTRAS;

/** A bench's price (£5); the action's own cost is used when given. */
const ITEM_COST = 50;

/** Toilets build cost, £225 (ride/rtd/shops/Toilets.h:44). */
const TOILET_COST = 2_250;
const TOILET_TYPE = 36; // RIDE_TYPE_TOILETS

/** Items per court per day, so a new court fills over a few days rather than at once. */
const ITEMS_PER_COURT_PER_DAY = 6;

const TOILET_PICK = {
    coverRadius: DEFAULT_CHEAP_BUILD_OPTIONS.coverRadius,
    minBackSteps: DEFAULT_CHEAP_BUILD_OPTIONS.minBackSteps,
    clusterMinGuests: DEFAULT_CHEAP_BUILD_OPTIONS.clusterMinGuests,
    maxPerKind: DEFAULT_CHEAP_BUILD_OPTIONS.maxPerKind,
    minRides: DEFAULT_CHEAP_BUILD_OPTIONS.minRides,
    siteRadius: 5,
};

/** Cumulative court counts kept in park storage, so a headless soak can read them. */
export interface CourtStats {
    stalls: number;
    amenities: number;
    toilets: number;
}

export function createCourtStats(storage: Configuration) {
    const KEY = "courtStats";
    function read(): CourtStats {
        const s = storage.get<CourtStats>(KEY);
        return s !== undefined && s !== null ? s : { stalls: 0, amenities: 0, toilets: 0 };
    }
    return {
        read,
        bump(key: keyof CourtStats): void {
            const s = read();
            s[key]++;
            storage.set(KEY, s);
        },
    };
}
export type CourtStatsStore = ReturnType<typeof createCourtStats>;

export function createCourtExtrasManager(settings: BuilderSettings, dbg: DebugChannel, budget: ExtrasBudget,
                                         stalls: StallBuilder, stats: CourtStatsStore,
                                         objectIndex: (kind: CourtAmenity) => number) {
    let toiletBuilding = false;

    function isOn(): boolean {
        return settings.autoCourtExtras.get();
    }

    function pathTilesAround(court: Court): Array<CourtPathTile & { z: number }> {
        const out: Array<CourtPathTile & { z: number }> = [];
        const r = OPTIONS.radius;
        for (let x = court.x - r; x <= court.x + r; x++) {
            if (x < 1 || x >= map.size.x - 1) continue;
            for (let y = court.y - r; y <= court.y + r; y++) {
                if (y < 1 || y >= map.size.y - 1) continue;
                const tile = map.getTile(x, y);
                for (let i = 0; i < tile.numElements; i++) {
                    const el = tile.getElement(i);
                    if (el.type !== "footpath") continue;
                    const fp = el as FootpathElement;
                    out.push({
                        x: x, y: y, z: fp.baseZ, isQueue: fp.isQueue,
                        // Same refusals as the amenity planner (FootpathAdditionPlaceAction.cpp:105-118).
                        blocked: fp.slopeDirection !== null || fp.edges === 0x0F,
                        occupied: fp.addition !== null,
                    });
                    break;
                }
            }
        }
        return out;
    }

    function place(x: number, y: number, z: number, kind: CourtAmenity, obj: number): void {
        const args = { x: x * 32, y: y * 32, z: z, object: obj };
        context.queryAction("footpathadditionplace", args, function (q: GameActionResult): void {
            if (q.error && q.error !== 0) {
                dbg.count("courtAmenityRefused");
                return;
            }
            context.executeAction("footpathadditionplace", args, function (r: GameActionResult): void {
                if (r.error && r.error !== 0) {
                    dbg.count("courtAmenityFailed");
                    return;
                }
                budget.spend(r.cost !== undefined && r.cost > 0 ? r.cost : ITEM_COST);
                stats.bump("amenities");
                dbg.count("courtAmenityPlaced");
                console.log("[Auto-Builder] Placed a " + kind + " at the food court (" + x + ", " + y + ").");
            });
        });
    }

    function buildToilet(court: Court): void {
        const obj = stalls.unlockedObject(TOILET_TYPE);
        if (obj < 0) {
            dbg.count("courtToiletNotUnlocked");
            return;
        }
        const site = pickSite(court, stalls.collectSites([court], TOILET_PICK.siteRadius), TOILET_PICK);
        if (site === null) {
            dbg.count("courtToiletNoSite");
            return;
        }
        toiletBuilding = true;
        stalls.build("courtToilet", TOILET_TYPE, obj, site,
            function (): void { toiletBuilding = false; },
            function (): void {
                budget.spend(TOILET_COST);
                stats.bump("toilets");
                dbg.count("courtToiletBuilt");
                console.log("[Auto-Builder] Built toilets next to the food court at (" + court.x + ", " + court.y + ").");
            });
    }

    /** Dresses every court a little each day while the budget lasts. Never removes anything. */
    function manage(): void {
        if (!isOn()) return;
        const food: Array<{ x: number; y: number }> = [];
        const toilets: Array<{ x: number; y: number }> = [];
        const rides = map.rides;
        for (let i = 0; i < rides.length; i++) {
            const t = rides[i].type;
            if (t !== 28 && t !== 30 && t !== TOILET_TYPE) continue; // food, drink, toilets
            const stations = rides[i].stations; // rebuilt on every access: hoist
            if (stations.length === 0) continue;
            const s = stations[0].start;
            if (!s || s.x < 0 || s.y < 0) continue;
            (t === TOILET_TYPE ? toilets : food).push({ x: s.x >> 5, y: s.y >> 5 });
        }
        const courts = findCourts(food, DEFAULT_COURT_OPTIONS);
        if (courts.length === 0) {
            dbg.count("courtNone");
            return;
        }

        const bench = objectIndex("bench"), bin = objectIndex("bin");
        // Spends land in the action callbacks, so today's picks are counted here too.
        let left = budget.affordable(ITEM_COST);
        for (let c = 0; c < courts.length; c++) {
            const room = Math.min(ITEMS_PER_COURT_PER_DAY, left);
            if (room <= 0) {
                dbg.count("courtSkippedBudget");
                return;
            }
            const tiles = pathTilesAround(courts[c]);
            const picks = pickCourtAmenities(courts[c], tiles, OPTIONS, room);
            left -= picks.length;
            if (picks.length === 0) dbg.count("courtFull");
            for (let p = 0; p < picks.length; p++) {
                const obj = picks[p].kind === "bench" ? bench : bin;
                if (obj < 0) continue;
                let z = -1;
                for (let t = 0; t < tiles.length; t++) if (tiles[t].x === picks[p].x && tiles[t].y === picks[p].y) z = tiles[t].z;
                place(picks[p].x, picks[p].y, z, picks[p].kind, obj);
            }
            // One toilet build at a time; the new toilet then serves this court.
            if (!toiletBuilding && courtNeedsToilet(courts[c], toilets, OPTIONS) &&
                budget.affordable(TOILET_COST) > 0) {
                buildToilet(courts[c]);
            }
        }
    }

    return { manage, isOn };
}
