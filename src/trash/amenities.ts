/**
 * Bench and bin placement, and vomit attribution.
 *
 * Split out of trash-manager.ts (#6) with no behaviour change.
 */

import { attributeVomit, describeDiagnosis, NauseaSource, MIN_NAUSEA } from "../vomit";
import { planAmenities, AmenityDemand, AmenityKind, AmenitySite } from "../amenities";
import { DebugChannel } from "../debug";
import { MapScan } from "./map-scan";

export function createAmenityManager(storage: Configuration, dbg: DebugChannel, scan: MapScan) {
    const { hotspots, getCoverageTiles } = scan;

    // A vomit cluster smaller than this is not worth naming a culprit for.
    // Measured: real clusters on a 1,600-guest park peak at 3-4 pieces per 8x8 cell
    // because handymen sweep continuously, so a threshold of 5 never fired at all.
    const VOMIT_MIN_TO_REPORT = 3;
    // How far from a cluster we will look for the ride that caused it. Guests walk a
    // little way from an exit before their nausea wins, so this is deliberately
    // wider than the 8-tile hotspot cell.
    const VOMIT_SOURCE_RADIUS_TILES = 12;
    // Radius searched for existing benches around the culprit ride's exit.
    const BENCH_SEARCH_RADIUS = 4;

    // --- Automatic amenity management ---
    // Each place/remove is a game action, so this pass is strictly budgeted per run
    // rather than acting on everything it finds at once. FootpathAdditionPlaceAction::Execute
    // is O(1) — one tile lookup, one field write, one tile invalidate, no global loops
    // (unlike patrol areas, which are O(area) and cost 440ms in bulk) — and collectDemands/
    // collectSites are already cheap (no full map scan, see their own comments). So unlike
    // the O(map²) tile scan, this pass needs no real-time cooldown of its own: it already
    // runs at most once per interval.day, and AMENITY_MAX_PLACE below is the real throughput
    // cap. A 10-second real-time cooldown WAS here, and it caused exactly the bug fixed in
    // wait-time-optimizer.ts's OPS controller the same session: at gameSpeed 2+, multiple
    // in-game days can elapse inside one real-time cooldown window, so the pass silently
    // skipped days precisely when a growing park needed it to run every one of them. Removed.
    const AMENITY_RADIUS        = 6;  // how far from a demand an amenity may be placed
    const AMENITY_SATISFIED     = 3;  // an existing amenity this close already covers it
    // Raised from 15: measured 2026-09-20, a park that grew from ~130 to ~360+ path tiles
    // (coverageTiles 22 -> 32+) left blanket coverage - the lowest-priority demand kind -
    // perpetually starved behind higher-weight vomit/ride/stall demands at the old cap,
    // which is exactly the "need more bins and benches" complaint. Each placement is a
    // cheap O(1) action (see above), so a larger per-pass budget costs little.
    const AMENITY_MAX_PLACE     = 25; // per pass
    const AMENITY_MAX_REMOVE    = 2;  // per pass, kept low: removal is the risky direction
    /**
     * Consecutive passes an amenity must look unjustified before it is actually removed.
     *
     * Measured: 28 removals against 64 placements — heavy churn. The cause is that a
     * bench placed for a *vomit cluster* stops being justified the moment that cluster
     * moves, which is precisely when the bench has done its job. Without hysteresis the
     * plugin places a bench, the vomit shifts, it removes it, and repeats — wasteful, and
     * visible in-game as benches blinking in and out.
     *
     * Same discipline as the staffing controller: do not act on a transient signal.
     */
    const REMOVAL_CONFIRM_PASSES = 5;
    // How many vomit clusters get their own bench demand. Raised from 3: vomit is the
    // dominant litter type on real parks, so more of it deserves direct attention.
    const VOMIT_DEMAND_COUNT    = 8;
    /**
     * Vomit in one cell before it justifies a BENCH there.
     *
     * One piece is enough. It is evidence a guest was nauseous at that spot with nowhere
     * to sit — the exact thing a bench prevents. Deliberately lower than
     * `VOMIT_MIN_TO_REPORT`, which governs console chatter and should stay quiet about
     * single pieces. They were the same constant until measurement showed this park's
     * vomit cells hold 1-2 pieces, which disabled vomit-driven placement entirely.
     */
    const VOMIT_MIN_FOR_BENCH   = 1;
    // Keep a cash buffer so the plugin can never bankrupt a park buying benches.
    //
    // OpenRCT2 money is in TENTHS of a pound, not hundredths: `operator""_GBP`
    // multiplies by 10 (core/Money.hpp:27). This was originally written as 5000_00
    // assuming hundredths, which made the floor GBP 50,000 instead of GBP 5,000 and
    // silently blocked every placement — 6 skips in 17 in-game days with none placed.
    //
    // Lowered from GBP 5,000 after measurement. A footpath addition costs
    // `pathAdditionEntry->price` (FootpathAdditionPlaceAction.cpp:126), which is tens of
    // pounds, so a full 15-placement pass is well under GBP 1,000. The old floor was two
    // orders of magnitude above what it was gating and fired `amenitySkippedLowCash` 17
    // times on a starting scenario.
    //
    // The reserve still covers a complete pass with room to spare, so this cannot take a
    // park into debt.
    const AMENITY_MIN_CASH      = 1_000 * 10; // GBP 1,000

    /** "x,y" -> consecutive passes this amenity of ours has looked unjustified. */
    let unjustifiedPasses: Record<string, number> = {};

    /** Amenities this plugin placed: "x,y" -> kind. Only these may ever be removed. */
    type PlacedMap = Record<string, AmenityKind>;

    function loadPlaced(): PlacedMap {
        const raw = storage.get<PlacedMap>("placedAmenities");
        return raw !== undefined && raw !== null ? raw : {};
    }
    function savePlaced(map: PlacedMap): void {
        storage.set("placedAmenities", map);
    }

    function isAutoAmenities(): boolean {
        return storage.get<boolean>("autoAmenities") === true;
    }
    function isAmenityRemoval(): boolean {
        return storage.get<boolean>("autoAmenityRemoval") === true;
    }
    let lastVomitReport = "";

    // -------------------------------------------------------------------------
    // Vomit attribution
    // -------------------------------------------------------------------------

    // Object indices of footpath additions that are benches, resolved once. The object
    // list does not change during a park session, so there is no reason to re-scan it.
    let benchIndices: Record<number, true> | null = null;

    function getBenchIndices(): Record<number, true> {
        if (benchIndices !== null) return benchIndices;
        const found: Record<number, true> = {};
        const additions = objectManager.getAllObjects("footpath_addition");
        for (let i = 0; i < additions.length; i++) {
            const id = additions[i].identifier.toLowerCase();
            const name = additions[i].name.toLowerCase();
            if (id.indexOf("bench") !== -1 || id.indexOf("seat") !== -1 ||
                name.indexOf("bench") !== -1 || name.indexOf("seat") !== -1) {
                found[additions[i].index] = true;
            }
        }
        benchIndices = found;
        return found;
    }

    let binIndices: Record<number, true> | null = null;

    function getBinIndices(): Record<number, true> {
        if (binIndices !== null) return binIndices;
        const found: Record<number, true> = {};
        const additions = objectManager.getAllObjects("footpath_addition");
        for (let i = 0; i < additions.length; i++) {
            const id = additions[i].identifier.toLowerCase();
            const name = additions[i].name.toLowerCase();
            if (id.indexOf("litter") !== -1 || id.indexOf("bin") !== -1 ||
                name.indexOf("litter") !== -1 || name.indexOf("bin") !== -1) {
                found[additions[i].index] = true;
            }
        }
        binIndices = found;
        return found;
    }

    /** First object index of the given kind, or -1 when the park has none loaded. */
    function amenityObjectIndex(kind: AmenityKind): number {
        const set = kind === "bench" ? getBenchIndices() : getBinIndices();
        for (const key in set) return Number(key);
        return -1;
    }

    /**
     * Counts benches on footpaths within `radius` tiles of a point.
     *
     * Only ever called for the single worst vomit cluster, and only when that cluster
     * is big enough to report, so the O(radius^2) tile walk stays negligible.
     */
    function countBenchesNear(tileX: number, tileY: number, radius: number): number {
        const benches = getBenchIndices();
        const size = map.size;
        let count = 0;
        for (let x = tileX - radius; x <= tileX + radius; x++) {
            if (x < 0 || x >= size.x) continue;
            for (let y = tileY - radius; y <= tileY + radius; y++) {
                if (y < 0 || y >= size.y) continue;
                const tile = map.getTile(x, y);
                for (let i = 0; i < tile.numElements; i++) {
                    const el = tile.getElement(i);
                    if (el.type !== "footpath") continue;
                    const add = (el as FootpathElement).addition;
                    if (add !== null && benches[add]) count++;
                }
            }
        }
        return count;
    }

    /**
     * Rides nauseating enough to plausibly cause vomit, located at their exits.
     *
     * Guests leave a ride at the exit, so that is where nausea-driven vomiting starts.
     * Unplaced exits have negative coordinates and are skipped.
     */
    function collectNauseaSources(): NauseaSource[] {
        const sources: NauseaSource[] = [];
        const rides = map.rides;
        for (let i = 0; i < rides.length; i++) {
            const r = rides[i];
            if (r.classification !== "ride" || r.nausea < MIN_NAUSEA) continue;
            for (let st = 0; st < r.stations.length; st++) {
                const exit = r.stations[st].exit;
                if (!exit || exit.x < 0 || exit.y < 0) continue;
                sources.push({
                    rideId: r.id,
                    name: r.name,
                    nausea: r.nausea,
                    x: exit.x >> 5,
                    y: exit.y >> 5,
                });
                break; // one exit per ride is enough to locate it
            }
        }
        return sources;
    }

    /**
     * Names the ride responsible for the worst vomit cluster, and says what to do.
     *
     * Measured on this park: 848 of 851 litter pieces were vomit and only 3 were trash,
     * so bins are irrelevant here and this is the report that matters. Benches are the
     * fix because a seated guest sheds nausea (Guest.cpp:1099) instead of vomiting.
     */
    function reportVomit(): void {
        const clusters = hotspots.topVomit(1);
        if (clusters.length === 0 || clusters[0].vomit < VOMIT_MIN_TO_REPORT) {
            lastVomitReport = "";
            return;
        }

        const diagnoses = attributeVomit(
            [{ x: clusters[0].x, y: clusters[0].y, vomit: clusters[0].vomit }],
            collectNauseaSources(),
            VOMIT_SOURCE_RADIUS_TILES,
        );
        if (diagnoses.length === 0) return;

        const d = diagnoses[0];
        // Report only when the location or the culprit changes, so a persistent hotspot
        // does not repeat every in-game day while the player deals with it.
        const key = d.x + "," + d.y + ":" + (d.source !== null ? d.source.rideId : -1);
        if (key === lastVomitReport) return;
        lastVomitReport = key;

        const benches = d.source !== null
            ? countBenchesNear(d.source.x, d.source.y, BENCH_SEARCH_RADIUS)
            : countBenchesNear(d.x, d.y, BENCH_SEARCH_RADIUS);

        dbg.count("vomitHotspotsReported");
        console.log("[Trash Manager] " + describeDiagnosis(d, benches));
    }

    /**
     * Where amenities are wanted, and why.
     *
     * Benches go where guests are about to be sick: nauseating ride exits, and any tile
     * where vomit is actually piling up. Bins go near stalls, which is where guests
     * acquire the food packaging that becomes trash litter.
     */
    function collectDemands(): AmenityDemand[] {
        const demands: AmenityDemand[] = [];
        const rides = map.rides;

        for (let i = 0; i < rides.length; i++) {
            const r = rides[i];
            if (r.stations.length === 0) continue;

            if (r.classification === "ride" && r.nausea >= MIN_NAUSEA) {
                const exit = r.stations[0].exit;
                if (exit && exit.x >= 0 && exit.y >= 0) {
                    demands.push({
                        x: exit.x >> 5, y: exit.y >> 5, kind: "bench",
                        // Nausea is 2-decimal fixed point; /100 gives a sane weight scale.
                        weight: r.nausea / 100,
                        reason: r.name + " exit (nausea " + (r.nausea / 100).toFixed(2) + ")",
                    });
                }
            } else if (r.classification === "stall") {
                const start = r.stations[0].start;
                if (start && start.x >= 0 && start.y >= 0) {
                    demands.push({
                        x: start.x >> 5, y: start.y >> 5, kind: "bin",
                        weight: 3,
                        reason: r.name + " (stall)",
                    });
                }
            }
        }

        // Observed vomit outranks predicted vomit, so weight it above ride nausea.
        const clusters = hotspots.topVomit(VOMIT_DEMAND_COUNT);
        for (let i = 0; i < clusters.length; i++) {
            // NOT VOMIT_MIN_TO_REPORT. Those are two different jobs that shared one
            // constant, and sharing it silently disabled this one.
            //
            // Reporting is advisory — a console line for a single piece of vomit would
            // be noise, so 3 is right there. PLACING A BENCH is not advisory: one piece
            // of vomit is direct evidence that a guest was nauseous at that spot and
            // had nowhere to sit, which is exactly the condition a bench fixes. A
            // seated guest sheds 6 nausea per update (`Guest.cpp:1099`); handymen only
            // clean up afterwards.
            //
            // Measured 2026-09-20: this park's worst vomit cell holds 1-2 pieces, so
            // the shared threshold of 3 meant vomit NEVER created a bench demand. All
            // 52 amenities placed that run came from blanket coverage and stalls. The
            // player could see vomit on screen with no bench going in near it, which is
            // precisely what they reported.
            if (clusters[i].vomit < VOMIT_MIN_FOR_BENCH) continue;
            demands.push({
                x: clusters[i].x, y: clusters[i].y, kind: "bench",
                weight: 20 + clusters[i].vomit,
                reason: clusters[i].vomit + " vomit at (" + clusters[i].x + ", " + clusters[i].y + ")",
            });
        }
        // Blanket coverage. Lowest weight, so targeted demands always get the budget
        // first and this only fills in whatever is left over — but over many passes it
        // spreads seating and bins across the entire path network.
        const coverageTiles = getCoverageTiles();
        for (let i = 0; i < coverageTiles.length; i++) {
            const t = coverageTiles[i];
            demands.push({ x: t.x, y: t.y, kind: "bench", weight: 1, reason: "path coverage" });
            demands.push({ x: t.x, y: t.y, kind: "bin", weight: 1, reason: "path coverage" });
        }

        return demands;
    }

    /**
     * Reads the footpath tiles around each demand so the planner has something to work
     * with. Only tiles near a demand are visited, which keeps this far cheaper than a
     * full map scan even though it runs on the same 30-second cadence.
     */
    /**
     * Coarse spatial index of existing amenities: packed cell key -> bitmask
     * (1 = bench present, 2 = bin present). Cell size is AMENITY_SATISFIED, so a demand
     * whose own cell or any neighbouring cell already holds the right kind is covered.
     *
     * This exists purely for cost. The planner's own satisfied-check is exact but scans
     * every site for every demand, which is O(sites x demands) — and that cost peaks in
     * the steady state where almost everything IS satisfied, i.e. exactly the case that
     * runs forever. Filtering satisfied demands out first keeps the planner's input tiny.
     */
    let amenityCells: Record<number, number> = {};

    function amenityCellKey(tileX: number, tileY: number): number {
        return ((tileX / AMENITY_SATISFIED) | 0) * 4096 + ((tileY / AMENITY_SATISFIED) | 0);
    }

    /** True when an amenity of `kind` sits in this cell or any of its eight neighbours. */
    function alreadyCovered(x: number, y: number, kind: AmenityKind): boolean {
        const want = kind === "bench" ? 1 : 2;
        const cx = (x / AMENITY_SATISFIED) | 0;
        const cy = (y / AMENITY_SATISFIED) | 0;
        for (let dx = -1; dx <= 1; dx++) {
            for (let dy = -1; dy <= 1; dy++) {
                const mask = amenityCells[(cx + dx) * 4096 + (cy + dy)];
                if (mask !== undefined && (mask & want) !== 0) return true;
            }
        }
        return false;
    }

    function collectSites(demands: AmenityDemand[], placed: PlacedMap): AmenitySite[] {
        const benches = getBenchIndices();
        const bins = getBinIndices();
        const size = map.size;
        const seen: Record<string, true> = {};
        const sites: AmenitySite[] = [];
        amenityCells = {};

        for (let d = 0; d < demands.length; d++) {
            const dm = demands[d];
            // A coverage demand already points at a tile the scan verified as placeable,
            // so sweeping a radius around it would just re-read tiles for nothing. The
            // radius sweep is only needed for demands anchored to a ride or stall, whose
            // own tile is not a footpath at all.
            const reach = dm.reason === "path coverage" ? 0 : AMENITY_RADIUS;
            for (let x = dm.x - reach; x <= dm.x + reach; x++) {
                if (x < 0 || x >= size.x) continue;
                for (let y = dm.y - reach; y <= dm.y + reach; y++) {
                    if (y < 0 || y >= size.y) continue;
                    const key = x + "," + y;
                    if (seen[key]) continue;
                    seen[key] = true;

                    const tile = map.getTile(x, y);
                    for (let i = 0; i < tile.numElements; i++) {
                        const el = tile.getElement(i);
                        if (el.type !== "footpath") continue;
                        const fp = el as FootpathElement;
                        const add = fp.addition;
                        let existing: AmenityKind | null = null;
                        if (add !== null) {
                            if (benches[add]) existing = "bench";
                            else if (bins[add]) existing = "bin";
                            if (existing !== null) {
                                const ck = amenityCellKey(x, y);
                                const prev = amenityCells[ck] !== undefined ? amenityCells[ck] : 0;
                                amenityCells[ck] = prev | (existing === "bench" ? 1 : 2);
                            }
                        }
                        sites.push({
                            x: x, y: y,
                            occupied: add !== null,
                            existing: existing,
                            ours: placed[key] !== undefined,
                            isQueue: fp.isQueue,
                            // The game refuses additions on sloped paths, and on tiles
                            // whose four edges are all connected — an enclosed interior
                            // plaza tile has no edge to stand the bench against
                            // (FootpathAdditionPlaceAction.cpp:105-118). Filtering these
                            // here is what stops a stream of "Can't build this on sloped
                            // footpath" errors in the player's face.
                            blocked: fp.slopeDirection !== null || fp.edges === 0x0F,
                        });
                        break; // one footpath per tile is enough
                    }
                }
            }
        }
        return sites;
    }

    /** Footpath element z at a tile, or -1 when the tile carries no path. */
    function pathBaseZ(tileX: number, tileY: number): number {
        const tile = map.getTile(tileX, tileY);
        for (let i = 0; i < tile.numElements; i++) {
            const el = tile.getElement(i);
            if (el.type === "footpath") return el.baseZ;
        }
        return -1;
    }

    /**
     * Places and removes benches and bins according to where they are actually needed.
     *
     * Budgeted per pass (no real-time cooldown - see the constants above for why), and
     * removal only ever touches amenities this plugin placed itself - a bench the player
     * put somewhere deliberately is never taken away.
     */
    function manageAmenities(): void {
        if (!isAutoAmenities()) return;

        if (park.cash < AMENITY_MIN_CASH) {
            dbg.count("amenitySkippedLowCash");
            return;
        }

        const demands = collectDemands();
        if (demands.length === 0) return;

        const placed = loadPlaced();
        const sites = collectSites(demands, placed);

        // Drop demands that are already covered. In a well-populated park this removes
        // nearly all of them, which is what keeps the planner's O(sites x demands) cost
        // negligible once the park has been filled in.
        const open: AmenityDemand[] = [];
        for (let i = 0; i < demands.length; i++) {
            if (!alreadyCovered(demands[i].x, demands[i].y, demands[i].kind)) open.push(demands[i]);
        }
        dbg.count("amenityDemandsOpen", open.length);
        if (open.length === 0) return;

        const plan = planAmenities(sites, open, {
            radius:          AMENITY_RADIUS,
            maxPlace:        AMENITY_MAX_PLACE,
            maxRemove:       AMENITY_MAX_REMOVE,
            satisfiedWithin: AMENITY_SATISFIED,
            allowRemoval:    isAmenityRemoval(),
        });

        let changed = false;

        for (let i = 0; i < plan.place.length; i++) {
            const a = plan.place[i];
            const obj = amenityObjectIndex(a.kind);
            if (obj < 0) continue; // park has no object of that kind loaded
            const z = pathBaseZ(a.x, a.y);
            if (z < 0) continue;
            const args = { x: a.x * 32, y: a.y * 32, z: z, object: obj };
            // Ask first. Not every refusal is predictable from the tile data — level
            // crossings, ownership and object-specific flags all reject placements — and
            // a failed executeAction pops an error window at the player. Querying first
            // makes an unplaceable tile a silent no-op instead.
            context.queryAction("footpathadditionplace", args, function (q: GameActionResult): void {
                if (q.error && q.error !== 0) {
                    dbg.count("amenityPlaceRefused");
                    return;
                }
                context.executeAction("footpathadditionplace", args, function (result: GameActionResult): void {
                    if (result.error && result.error !== 0) {
                        dbg.count("amenityPlaceFailed");
                        return;
                    }
                    placed[a.x + "," + a.y] = a.kind;
                    changed = true;
                    dbg.count("amenityPlaced");
                    console.log("[Trash Manager] Placed " + a.kind + " at (" + a.x + ", " +
                        a.y + ") for " + a.reason + ".");
                });
            });
        }

        // Removal hysteresis. A tile has to be proposed for removal on several
        // consecutive passes before we act, and any pass that does not propose it resets
        // the count — so a bench only goes once its reason is durably gone.
        const proposed: Record<string, true> = {};
        for (let i = 0; i < plan.remove.length; i++) {
            const a = plan.remove[i];
            const key = a.x + "," + a.y;
            proposed[key] = true;
            const seen = (unjustifiedPasses[key] !== undefined ? unjustifiedPasses[key] : 0) + 1;
            unjustifiedPasses[key] = seen;
            if (seen < REMOVAL_CONFIRM_PASSES) {
                dbg.count("amenityRemovalDeferred");
                continue;
            }

            const z = pathBaseZ(a.x, a.y);
            if (z < 0) continue;
            const rmArgs = { x: a.x * 32, y: a.y * 32, z: z };
            context.queryAction("footpathadditionremove", rmArgs, function (q: GameActionResult): void {
                if (q.error && q.error !== 0) {
                    // Nothing there any more, or it cannot be removed. Drop our record so
                    // we stop retrying a tile that will never succeed.
                    delete placed[a.x + "," + a.y];
                    delete unjustifiedPasses[key];
                    changed = true;
                    dbg.count("amenityRemoveRefused");
                    return;
                }
                context.executeAction("footpathadditionremove", rmArgs, function (result: GameActionResult): void {
                    if (result.error && result.error !== 0) {
                        dbg.count("amenityRemoveFailed");
                        return;
                    }
                    delete placed[a.x + "," + a.y];
                    delete unjustifiedPasses[key];
                    changed = true;
                    dbg.count("amenityRemoved");
                    console.log("[Trash Manager] Removed " + a.kind + " at (" + a.x + ", " +
                        a.y + "): " + a.reason + ".");
                });
            });
        }

        // Anything not proposed this pass is justified again — forget its streak, and
        // keep this map from growing without bound.
        for (const key in unjustifiedPasses) {
            if (!proposed[key]) delete unjustifiedPasses[key];
        }

        if (changed) savePlaced(placed);
    }

    return {
        isAutoAmenities,
        isAmenityRemoval,
        reportVomit,
        manageAmenities,
    };
}
