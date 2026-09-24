/**
 * Trash Manager v3 — OpenRCT2 plugin
 *
 * Manages park litter and handyman staffing based on source-code-verified mechanics:
 *
 *   LITTER PENALTY (from Park.cpp):
 *     - Only litter aged >= 7680 ticks (~3 min) counts toward the rating penalty.
 *     - Penalty = min(150, oldLitterCount) * 4 rating points (max -600).
 *     - Fresh litter has a grace period and does not yet hurt your rating.
 *
 *   HANDYMAN RATIOS:
 *     - Staffing is guest-driven (litter scales with visitors), with a path-tile
 *       floor so an empty park still gets a small recommendation. See
 *       computeNeededHandymen.
 *
 *   PATROL ZONES:
 *     - Handymen are given NO patrol area. OpenRCT2 dispatches the nearest handyman
 *       to each piece of litter, so a zone only blocks that. Setting a park-sized
 *       rectangle instead was measured at 440ms per bulk reassignment; see
 *       clearHandymanZone for why.
 *
 *   MOWING (critical):
 *     - Grass mowing (orders bit 8) must be disabled. When enabled, handymen
 *       abandon path sweeping to mow grass. RCT2 shipped with it off for this reason.
 *
 *   BROKEN BINS:
 *     - Vandalized bins don't collect litter. Litter -> disgust -> vandalism ->
 *       more broken bins is a cascade loop detectable via isAdditionBroken.
 */

import { createDebugChannel, isDebugEnabled, setDebugEnabled } from "./debug";
import { createActivityTracker, ActivitySnapshot } from "./staff-activity";
import { createStaffingController, StaffingDecision } from "./staffing";
import { createHotspotAccumulator, Hotspot } from "./hotspots";
import { attributeVomit, describeDiagnosis, NauseaSource, MIN_NAUSEA } from "./vomit";
import { planAmenities, AmenityDemand, AmenityKind, AmenitySite } from "./amenities";
import {
    createNeedAccumulator, createSampleRotation, findGaps, describeGap, CLUSTER_MIN_GUESTS,
    NeedKind, NeedCounts, NeedGap, Facility,
} from "./needs";
import {
    createFacilityTracker, planFacilities, describePlan,
    DEFAULT_FACILITY_OPTIONS, FacilityPlan, FacilitySite, ConfirmedGap, GapObservation,
} from "./facilities";
import { createThoughtAccumulator, describeThoughts, ThoughtTally } from "./thoughts";

interface TileCoord {
    x: number;
    y: number;
}

interface BoundingRect {
    x1: number;
    y1: number;
    x2: number;
    y2: number;
}

interface TileCache {
    pathTiles:    number;
    ownedTiles:   number;
    guests:       number;
    handymanCount: number;
    totalLitter:  number;
    oldLitter:    number;
    fullBins:   number;
    brokenBins: number;
    vomit:      number;
    trash:      number;
    // Worst litter clusters from the most recent entity scan, worst first.
    topHotspots: Hotspot[];
    // Bounding boxes (tile coords) of owned land and of tiles carrying footpaths.
    // Informational only since patrol zones were dropped — kept because they fall out
    // of the tile scan for free and are useful when debugging path/ownership counts.
    parkBounds: BoundingRect;
    pathBounds: BoundingRect;
}

registerPlugin({
    name: "Trash Manager",
    version: __PLUGIN_VERSION__,
    authors: ["MattT"],
    type: "local",
    licence: "MIT",
    targetApiVersion: 87,
    main: trashManagerMain,
});

function trashManagerMain(): void {
    const storage: Configuration = context.getParkStorage(); // per-save-file settings

    // Debug channel. Off unless the shared-storage debug flag is set; see debug.ts.
    const dbg = createDebugChannel("trash-manager");

    // -------------------------------------------------------------------------
    // Constants (Park.cpp source-verified values)
    // -------------------------------------------------------------------------

    const LITTER_OLD_AGE_TICKS    = 7680;  // ticks before litter starts costing rating (~3 min)
    const LITTER_PENALTY_CAP      = 150;   // rating penalty bottoms out at 150 old pieces
    const RATING_PTS_PER_LITTER   = 4;     // rating points lost per old litter piece
    const FREE_ROAMING_BUFFER     = 2;     // handymen kept unzoned for overflow coverage
    const GUESTS_PER_HANDYMAN     = 30;    // one handyman per ~30 guests (litter rate scales with guests)
    const PATH_TILES_PER_HANDYMAN = 100;   // floor: one per 100 path tiles so empty parks don't over-hire
    // sweep (1) + empty bins (4); mowing (8) is intentionally excluded
    const HANDYMAN_ORDERS         = 1 | 4;

    /** Returns the user-configured max handymen cap (stored per save file, default 20). */
    function getMaxHandymen(): number {
        const v = storage.get<number>("maxHandymen");
        return v !== undefined ? v : 20;
    }

    // -------------------------------------------------------------------------
    // Cached state — rebuilt once per in-game day to avoid expensive per-tick scans
    // -------------------------------------------------------------------------

    const cache: TileCache = {
        pathTiles:     0,
        ownedTiles:    0,
        guests:        0,
        handymanCount: 0,
        totalLitter:   0,
        oldLitter:     0,
        fullBins:   0,
        brokenBins: 0,
        vomit:      0,
        trash:      0,
        topHotspots: [],
        parkBounds: { x1: 1, y1: 1, x2: 127, y2: 127 },
        pathBounds: { x1: 1, y1: 1, x2: 127, y2: 127 },
    };

    // The tile scan is O(map_size²) — throttle to at most once per 30 real seconds so
    // fast-forwarding the game doesn't cause repeated freezes each simulated day.
    const TILE_SCAN_COOLDOWN_MS = 30_000;
    let lastTileScanTime = 0; // 0 forces a scan on the very first day

    // Deferred sweep flags: entity.remove() must run from interval.tick, not
    // from a UI button onClick handler (game state is not mutable in that context).
    let pendingSweepAll  = false;
    let pendingSweepOld  = false;
    let pendingFixOrders = false; // h.orders write must be deferred from onClick to interval.tick

    // Handymen whose patrol area we have already cleared. Re-issuing the action for
    // every handyman every in-game day cost N game actions per day and changed
    // nothing, so we only act on handymen we have not seen before.
    const zoneCleared: Record<number, true> = {};

    // Litter is bucketed into 8x8-tile cells during the scan we already run, so
    // "240 pieces of litter" becomes "38 of them are all at (42, 88)". 8 tiles is
    // roughly a plaza or a stall frontage - small enough to point at, large enough
    // that a busy junction lands in one cell rather than smeared across four.
    const HOTSPOT_CELL_TILES = 8;
    // A cell has to be worse than this before it is worth mentioning; below it the
    // "hotspot" is just evenly-distributed litter.
    // Lowered from 8 after the scale audit (docs/scale-audit.md).
    //
    // This gates the "litter is piling up at (x, y)" console callout on the worst
    // hotspot's count of RATING-COSTING old litter. Measured across both parks in
    // `tools/rct-debug.log`, `oldLitter` peaks at 5 park-wide — so a single cell
    // reaching 8 was impossible and the callout could never fire. Cosmetic rather than
    // functional, but it is the same unreachable-threshold pattern as the five features
    // that shipped dead, and it costs nothing to make it reachable.
    const HOTSPOT_MIN_OLD = 3;
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
    // Blanket coverage: one candidate path tile is remembered per cell of this size, so
    // benches and bins end up spread across the whole path network rather than only
    // clustering at rides and stalls.
    const COVERAGE_CELL_TILES   = 6;
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

    /**
     * One representative placeable path tile per COVERAGE_CELL_TILES cell, rebuilt by
     * the tile scan. This is what turns "benches near rides" into "benches everywhere":
     * it gives the planner a spread of candidate locations across the whole path
     * network, collected for free during a walk we already do.
     */
    let coverageTiles: TileCoord[] = [];

    /** "x,y" -> consecutive passes this amenity of ours has looked unjustified. */
    let unjustifiedPasses: Record<string, number> = {};

    // --- Guest-need instrumentation (Phase 1: measure, do not act) ------------
    //
    // `map.getAllEntities("guest")` is the one operation that does not fit the per-day
    // budget — this park runs 1,700+ guests. So we read a rotating window each pass and
    // let coverage accumulate over several passes, rather than scanning everyone at once.
    //
    // The whole thing is gated on the Diagnostics flag: a normal game pays nothing, and
    // it only runs while we are deliberately gathering data.
    // Measured 2026-09-20: a whole play session produced only ~4 COMPLETE sweeps of
    // the park (4,015 guests sampled / 250 per window / 3.8 windows per sweep), against
    // a facility confirmation requirement of 8. The feature could not fire, and the
    // limiting factor is real time rather than game time because the cooldown dominates
    // at fast-forward speeds.
    //
    // `day.needSample` measured 1-4ms at a 250-guest window, well inside the per-day
    // budget, so there is room to sample harder. 400 guests every 2.5s is roughly a
    // 3x sweep rate for a worst case still under 10ms.
    const NEED_SAMPLE_COOLDOWN_MS = 2_500;
    const NEED_SAMPLE_WINDOW      = 400;   // guests read per pass
    const NEED_CELL_TILES         = 8;     // clustering grid, matches the litter grid
    // Shared with the facility planner via needs.ts, so the two cannot disagree about
    // what counts as a cluster. They did, and it created an unactionable dead band.
    const NEED_GAP_MIN_GUESTS     = CLUSTER_MIN_GUESTS;

    // Ride type numbers for the facilities that satisfy each need. Verified against
    // Ride.h, cross-checked with the explicit `RIDE_TYPE_DRINK_STALL = 30` and
    // `RIDE_TYPE_TOP_SPIN = 40` anchors so the counting cannot be off by one.
    const FACILITY_RIDE_TYPES: Record<number, NeedKind> = {
        28: "hunger",    // RIDE_TYPE_FOOD_STALL
        30: "thirst",    // RIDE_TYPE_DRINK_STALL
        36: "toilet",    // RIDE_TYPE_TOILETS
        48: "firstAid",  // RIDE_TYPE_FIRST_AID
    };

    // --- Automatic facility placement (NEEDS Phase 3) ------------------------
    //
    // Phase 1 shipped instrumentation with an explicit exit criterion: build nothing
    // unless the log shows PERSISTENT clusters at a distance large enough to explain
    // them. For several sessions the numbers came back flat and this stayed unbuilt.
    // They are no longer flat - see the header of facilities.ts for the measurements
    // that unblocked it.
    //
    // Building a ride is the most consequential action this project takes, so the
    // decision logic lives in facilities.ts where it is unit-tested, and everything
    // here is mechanism: find sites, issue actions, never improvise.
    // No real-time cooldown here, matching the fix already made twice this session
    // (OPS in wait-time-optimizer.ts, manageAmenities above): this pass already runs
    // at most once per interval.day, `collectFacilitySites` only walks a bounded
    // radius around confirmed gaps (not a full map scan), and `maxPlacements: 1` /
    // `confirmSweeps` already cap the real cost and pace. A 30-second real-time gate
    // on top of that just meant the pass silently skipped whole in-game days at
    // gameSpeed 2+ - directly slowing down an already-conservative-by-design build
    // rate even further, which is exactly the "doesn't add buildings quickly" report.
    const FACILITY_SITE_RADIUS = DEFAULT_FACILITY_OPTIONS.siteRadius;
    /**
     * A stall costs far more than a bench, so the cash floor is correspondingly higher.
     * Money is in TENTHS of a pound (core/Money.hpp:27) - the mistake that silently
     * disabled amenity placement for a whole session.
     */
    // Source-verified build costs (`ride/rtd/shops/*.h`, `.BuildCosts`):
    // food stall GBP 300, drink stall GBP 250, toilets GBP 225, and only one is built
    // per pass. The original GBP 20,000 floor was **66 times** the cost of the thing it
    // gated - picked cautiously without checking the actual price - and it disabled the
    // feature outright on a starting scenario, firing `facilitySkippedLowCash` on 16
    // consecutive passes while the park had no food or drink facilities at all.
    //
    // A stall also *earns* money, so refusing to build one on a park that can easily
    // afford it is the expensive choice, not the safe one. GBP 2,000 still leaves about
    // seven stalls of headroom.
    //
    // Same failure as every other threshold on this project: chosen against an imagined
    // range (a mature park with six figures banked) rather than a measured one.
    const FACILITY_MIN_CASH    = 2_000 * 10; // GBP 2,000

    /** Ride type to build for each need. Inverse of FACILITY_RIDE_TYPES. */
    const FACILITY_BUILD_TYPE: Record<string, number> = {
        hunger:   28,  // RIDE_TYPE_FOOD_STALL
        thirst:   30,  // RIDE_TYPE_DRINK_STALL
        toilet:   36,  // RIDE_TYPE_TOILETS
        firstAid: 48,  // RIDE_TYPE_FIRST_AID
    };

    /**
     * Every shop and facility in the game starts with the same 1x1 flat track piece
     * (`StartTrackPiece = TrackElemType::flatTrack1x1A` in every ride/rtd/shops/*.h),
     * whose id is 262 (ted/TrackElemType.h:282). That is what makes a stall placeable
     * with a single trackplace and no entrance or exit.
     */
    const FACILITY_TRACK_TYPE  = 262;

    const facilityTracker = createFacilityTracker(DEFAULT_FACILITY_OPTIONS);
    /** Set while a build chain is mid-flight, so passes cannot overlap. */
    let facilityBuilding = false;
    let facilityBuildStarted = 0;
    /**
     * How long an in-flight build may block further passes before the flag is assumed
     * lost and cleared.
     *
     * In single player every game-action callback fires immediately, so the flag is
     * held for microseconds and this never triggers. In multiplayer a callback can be
     * dropped outright, and a flag that is set but never cleared would silently disable
     * this feature forever with no error to notice - which is precisely how five
     * features on this project shipped dead. The watchdog is counted, so if it ever
     * does fire it shows up as data.
     */
    const FACILITY_BUILD_TIMEOUT_MS = 60_000;
    let lastFacilityPlans = 0;

    function isAutoFacilities(): boolean {
        return storage.get<boolean>("autoFacilities") === true;
    }

    // Guests keep several thoughts, oldest last, with LOWER freshness meaning more
    // recent. Only recent ones describe the park as it is now, so stale ones are dropped.
    const THOUGHT_MAX_FRESHNESS = 100;
    const thoughts = createThoughtAccumulator(THOUGHT_MAX_FRESHNESS);
    let lastProblems: ThoughtTally[] = [];
    let lastProblemReport = "";

    const needs = createNeedAccumulator(NEED_CELL_TILES);
    // The window arithmetic lives in needs.ts, where it is unit-tested. It was inline
    // here and got the growing-roster case wrong for an entire play session - see the
    // header on createSampleRotation.
    const needRotation = createSampleRotation(NEED_SAMPLE_WINDOW);
    let lastNeedSample   = 0;
    let lastNeedCounts: NeedCounts | null = null;
    let lastNeedGaps: NeedGap[] = [];
    let lastGapReport = "";
    // Facility counts by kind, for the log. Rebuilt with the gaps.
    let facilityCounts: Record<string, number> = {};

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
    const hotspots = createHotspotAccumulator(HOTSPOT_CELL_TILES);

    // Tracks whether each handyman's sweep/empty counters are advancing. Handymen
    // trapped in queue lines are the most-cited community complaint and the upstream
    // bugs are still open; see staff-activity.ts.
    const activity = createActivityTracker();
    let lastStuckReport = 0;
    let lastHotspotReport = "";
    let lastVomitReport = "";

    // Closed-loop staffing. The guest-driven formula is coverage-blind and hires
    // forever as a park grows; this probes downward while the park stays clean and
    // hires back the moment rating-costing litter appears. See staffing.ts.
    const staffing = createStaffingController(0);
    let staffingSeeded = false;
    let lastStaffingReason = "";
    let lastDecision: StaffingDecision | null = null;
    // Never drop below roughly one handyman per this many path tiles, however clean
    // things look. Coverage, not throughput, is the real constraint.
    const PATH_TILES_PER_HANDYMAN_FLOOR = 150;
    /**
     * A second, independent floor term keyed on guest count, not just map size.
     *
     * Measured 2026-09-20: on a park growing 621 -> 1955 guests, `staffingFloor()`
     * sat at exactly 4 the entire time (path tiles barely grew relative to guests),
     * providing no protection as the real litter/vomit driver tripled. The only
     * thing that could still force a hire was `oldLitter >= URGENT_OLD_LITTER`, a
     * rating-protection signal - and the existing 8-9 handymen worked hard enough
     * to keep litter from *ageing* past that threshold even while `litterAverage`
     * spiked to 23 and vomit visibly piled up faster than they could clear it in
     * real time. The controller correctly protected rating and incorrectly
     * concluded there was no problem.
     *
     * Deliberately gentler than `GUESTS_PER_HANDYMAN = 30` (the classic formula's
     * ceiling, already measured over-provisioned in this project's own field data)
     * - this is a FLOOR the adaptive loop cannot ratchet below, not a target it is
     * steered toward. Starting point only, not yet re-validated against a fresh
     * session; revisit if the park still looks messy at this ratio or the loop
     * over-hires against it.
     */
    const GUESTS_PER_HANDYMAN_FLOOR = 100;

    function isAdaptiveStaffing(): boolean {
        return storage.get<boolean>("adaptiveStaffing") !== false;
    }

    function staffingFloor(): number {
        const tileFloor = Math.ceil(cache.pathTiles / PATH_TILES_PER_HANDYMAN_FLOOR);
        const guestFloor = Math.ceil(cache.guests / GUESTS_PER_HANDYMAN_FLOOR);
        return Math.max(tileFloor, guestFloor) + FREE_ROAMING_BUFFER;
    }

    // -------------------------------------------------------------------------
    // Helpers
    // -------------------------------------------------------------------------

    function getHandymen(): Handyman[] {
        return map.getAllEntities("staff").filter(
            (s: Staff): s is Handyman => s.staffType === "handyman"
        );
    }

    /**
     * Returns true if this litter piece has aged past the grace period.
     *
     * Note: creationTick is a uint32 in C++ and can wrap around after ~49 days
     * of continuous ticks. The subtraction can go negative in JS, so we add 2^32
     * to correct for the wrap. Same fix as used by ParkRatingInspector.js.
     */
    function litterAge(litter: Litter): number {
        let age = date.ticksElapsed - litter.creationTick;
        if (age < 0) age += 4294967296;
        return age;
    }

    function isOldLitter(litter: Litter): boolean {
        return litterAge(litter) >= LITTER_OLD_AGE_TICKS;
    }

    /** Penalty in rating points from the given old-litter count: min(150, n) * 4 */
    function computeRatingPenalty(oldCount: number): number {
        return Math.min(LITTER_PENALTY_CAP, oldCount) * RATING_PTS_PER_LITTER;
    }

    /** Target handyman count: driven by guests (litter source) with a path-tile floor for empty parks */
    function computeNeededHandymen(pathTileCount: number, guestCount: number): number {
        const fromGuests = Math.ceil(guestCount / GUESTS_PER_HANDYMAN);
        const fromTiles  = Math.ceil(pathTileCount / PATH_TILES_PER_HANDYMAN);
        return Math.max(fromGuests, fromTiles) + FREE_ROAMING_BUFFER;
    }

    // -------------------------------------------------------------------------
    // Cache update — split into tile scan (expensive) and entity scan (cheap)
    // -------------------------------------------------------------------------

    // O(map_size²) tile walk: counts path/owned tiles, bins, bounding boxes.
    // Rate-limited via TILE_SCAN_COOLDOWN_MS — safe to call every day, won't
    // actually re-scan until the cooldown has elapsed in real time.
    function updateTileCache(): void {
        const now = Date.now();
        if (now - lastTileScanTime < TILE_SCAN_COOLDOWN_MS) return;
        lastTileScanTime = now;
        dbg.count("tileScan");

        const size = map.size;
        let pathCount = 0, ownedCount = 0, fullBins = 0, brokenBins = 0;
        // Rebuilt from scratch so demolished paths cannot leave stale candidates behind.
        const coverageSeen: Record<number, true> = {};
        const nextCoverage: TileCoord[] = [];
        let minPX = size.x, minPY = size.y, maxPX = 0, maxPY = 0;
        let minPathX = size.x, minPathY = size.y, maxPathX = 0, maxPathY = 0;

        for (let x = 0; x < size.x; x++) {
            for (let y = 0; y < size.y; y++) {
                const tile = map.getTile(x, y);
                // Surface element is always index 0; skip unowned tiles entirely.
                // Guard numElements: a tile with no elements would make getElement(0) throw.
                if (tile.numElements === 0) continue;
                const surfEl = tile.getElement(0);
                if (surfEl.type !== "surface" || !surfEl.hasOwnership) continue;
                ownedCount++;

                if (x < minPX) minPX = x;
                if (y < minPY) minPY = y;
                if (x > maxPX) maxPX = x;
                if (y > maxPY) maxPY = y;

                let hasPath = false;
                let pathCounted = false; // guard against double-count on bridge tiles (2 stacked footpaths)
                for (let i = 1; i < tile.numElements; i++) {
                    const el = tile.getElement(i);
                    if (el.type === "footpath") {
                        hasPath = true;
                        if (!el.isQueue && !pathCounted) { pathCount++; pathCounted = true; }
                        if (el.isAdditionFull)   fullBins++;
                        if (el.isAdditionBroken) brokenBins++;

                        // Remember the first tile in each coverage cell that could
                        // actually take an addition. Sloped and fully-enclosed tiles are
                        // refused by the game, so there is no point offering them.
                        const cellKey = ((x / COVERAGE_CELL_TILES) | 0) * 4096
                                      + ((y / COVERAGE_CELL_TILES) | 0);
                        if (coverageSeen[cellKey] === undefined
                            && !el.isQueue
                            && el.slopeDirection === null
                            && el.edges !== 0x0F) {
                            coverageSeen[cellKey] = true;
                            nextCoverage.push({ x: x, y: y });
                        }
                    }
                }
                if (hasPath) {
                    if (x < minPathX) minPathX = x;
                    if (y < minPathY) minPathY = y;
                    if (x > maxPathX) maxPathX = x;
                    if (y > maxPathY) maxPathY = y;
                }
            }
        }

        const fallback: BoundingRect = { x1: 1, y1: 1, x2: size.x - 2, y2: size.y - 2 };
        cache.parkBounds = (maxPX >= minPX)
            ? { x1: minPX, y1: minPY, x2: maxPX, y2: maxPY }
            : fallback;
        cache.pathBounds = (maxPathX >= minPathX)
            ? { x1: minPathX, y1: minPathY, x2: maxPathX, y2: maxPathY }
            : cache.parkBounds;

        coverageTiles    = nextCoverage;
        cache.pathTiles  = pathCount;
        cache.ownedTiles = ownedCount;
        cache.fullBins   = fullBins;
        cache.brokenBins = brokenBins;
    }

    // Cheap entity scan: litter age/type, guest count, handyman count.
    // Safe to call every in-game day at any game speed.
    //
    // `handymen` and `allLitter` are passed in by callers that already hold them so
    // a single in-game day does exactly one getAllEntities("staff") and one
    // getAllEntities("litter") instead of the four-plus scans this used to trigger.
    function updateEntityCache(handymen?: Handyman[], allLitter?: Litter[]): Litter[] {
        const litter = allLitter !== undefined ? allLitter : map.getAllEntities("litter");
        const staff  = handymen  !== undefined ? handymen  : getHandymen();

        let oldCount = 0, vomitCount = 0, trashCount = 0;
        // Rebuild the hotspot grid from scratch each pass - it describes where litter
        // is *now*, and litter that has been swept must not linger in the counts.
        hotspots.reset();
        for (let i = 0; i < litter.length; i++) {
            const e = litter[i];
            const old = isOldLitter(e);
            const isVomit = e.litterType === "vomit" || e.litterType === "vomit_alt";
            if (old) oldCount++;
            if (isVomit) vomitCount++;
            else trashCount++;
            hotspots.add(e.x, e.y, old, isVomit);
        }

        cache.guests        = park.guests;
        cache.handymanCount = staff.length;
        cache.totalLitter   = litter.length;
        cache.oldLitter     = oldCount;
        cache.vomit         = vomitCount;
        cache.trash         = trashCount;
        cache.topHotspots   = hotspots.top(3);
        return litter;
    }

    function updateCache(): void {
        updateTileCache();
        updateEntityCache();
    }

    // -------------------------------------------------------------------------
    // Staff management
    // -------------------------------------------------------------------------

    /**
     * In-game days to stop attempting hires after one is refused.
     *
     * For a handyman or mechanic the ONLY way `staffhire` can fail is the entity budget:
     * it refuses when `getNumFreeEntities() < 400`, and again if entity creation itself
     * fails (`StaffHireNewAction.cpp:74-100`). The staff type is a constant we control
     * and costumes are not validated for these types, so nothing else can reject it.
     *
     * That condition is transient — it clears as guests leave — but the controller would
     * otherwise retry every single in-game day and put the game's "can't hire new staff"
     * message in front of the player each time. Backing off turns a repeating error into
     * one message and a counter.
     */
    const HIRE_BACKOFF_DAYS = 10;
    let hireBackoff = 0;

    /** True while a recent refusal says there is no room for more staff. */
    function hiringBlocked(): boolean {
        if (hireBackoff <= 0) return false;
        hireBackoff--;
        dbg.count("handymanHireBlocked");
        return true;
    }

    /** Hires one handyman with correct orders. Calls onHired(peepId) on success. */
    function hireHandyman(onHired: ((peepId: number) => void) | undefined): void {
        context.executeAction("staffhire", {
            autoPosition: true,
            staffType:    0, // 0 = handyman
            costumeIndex: 0,
            staffOrders:  HANDYMAN_ORDERS,
        }, function(result: StaffHireNewActionResult): void {
            if ((!result.error || result.error === 0) && result.peep != null) {
                if (onHired) onHired(result.peep);
                return;
            }
            // A refusal used to be swallowed here: no counter, no log, and a retry the
            // next day. The player saw the game's error repeatedly while the telemetry
            // said nothing at all.
            dbg.count("handymanHireFailed");
            if (hireBackoff === 0) {
                console.log("[Trash Manager] Could not hire a handyman - the park is at " +
                    "its entity limit. Pausing hiring for " + HIRE_BACKOFF_DAYS + " days.");
            }
            hireBackoff = HIRE_BACKOFF_DAYS;
        });
    }

    function fireHandyman(handymen?: Handyman[]): void {
        const h = handymen !== undefined ? handymen : getHandymen();
        if (h.length > 0) {
            const id = h[h.length - 1].id;
            context.executeAction("stafffire", { id: id }, (result: GameActionResult) => {
                if (!result.error || result.error === 0) return;
                // A refusal here used to be silent: no counter, no log. Firing a stale
                // or already-gone peep id should show up in telemetry, not vanish.
                dbg.count("handymanFireFailed");
                console.log("[Trash Manager] Could not fire handyman #" + id + ": " +
                    (result.errorMessage || "error code " + result.error));
            });
        }
    }

    /**
     * Fixes a handyman whose orders include mowing or are missing sweep/bins tasks.
     * Direct property assignment is safe here because this only runs from interval.day.
     */
    function enforceHandymanOrders(h: Handyman): void {
        if (h.orders !== HANDYMAN_ORDERS) {
            h.orders = HANDYMAN_ORDERS;
        }
    }

    function enforceOrders(handymen?: Handyman[]): void {
        (handymen !== undefined ? handymen : getHandymen()).forEach(enforceHandymanOrders);
    }

    // -------------------------------------------------------------------------
    // Patrol zone assignment
    // -------------------------------------------------------------------------

    /**
     * True if this peep id still resolves to a live entity.
     *
     * Issuing a staff game action for a fired peep fails with
     * "Invalid parameter / Staff not found" (StaffSetPatrolAreaAction.cpp:69) and
     * pops an error toast in the player's face. Zone work is rare now, so one lookup
     * per action is a cheap way to make that impossible.
     */
    function staffExists(peepId: number): boolean {
        return map.getEntity(peepId) !== null;
    }

    /**
     * Clears a handyman's patrol area so they roam the whole park path network.
     *
     * This replaces the previous approach of setting every handyman a rectangle
     * covering the path bounding box. That rectangle already spanned essentially the
     * whole park, so it was behaviourally equivalent to having no patrol area — but
     * it was enormously more expensive. Profiling showed 440ms in a single day
     * handler for 29 handymen, because:
     *
     *   - StaffSetPatrolAreaAction walks every tile in the rectangle to validate it,
     *     in both the query and the execute pass; and
     *   - it then calls UpdateConsolidatedPatrolAreas() (PatrolArea.cpp:140), which
     *     re-unifies the full patrol bitmap of *every* staff member, on *every*
     *     action. With N handymen each holding a park-sized area that is O(N^2 * area)
     *     work per bulk reassignment.
     *
     * The clearAll branch does no per-tile loop, and staff with no patrol area are
     * skipped by the consolidation pass entirely. It also keeps the save file smaller
     * and lets handymen reach paths built outside the old bounds.
     */
    // Set while the manual button is driving, so the log can tell a user-triggered
    // bulk clear apart from the daily delta sync.
    let manualClear = false;

    function clearHandymanZone(peepId: number): void {
        if (!staffExists(peepId)) {
            dbg.count("zoneSkippedDeadPeep");
            return;
        }
        dbg.count(manualClear ? "patrolActionsManual" : "patrolActionsDaily");
        context.executeAction("staffsetpatrolarea", {
            id: peepId, x1: 0, y1: 0, x2: 0, y2: 0, mode: 2,
        });
        zoneCleared[peepId] = true;
    }

    /** Clears every handyman's patrol area (the manual button). */
    function clearAllZones(handymen?: Handyman[]): void {
        const staff = handymen !== undefined ? handymen : getHandymen();
        manualClear = true;
        staff.forEach(function(h: Handyman): void {
            if (h.id !== null) clearHandymanZone(h.id);
        });
        manualClear = false;
    }

    /**
     * Daily zone upkeep: clear the patrol area of any handyman we haven't handled yet.
     * On a steady-state park this issues zero game actions per day.
     */
    function syncZones(handymen: Handyman[]): void {
        if (handymen.length === 0) return;

        const live: Record<number, true> = {};
        handymen.forEach(function(h: Handyman): void {
            if (h.id === null) return;
            live[h.id] = true;
            if (!zoneCleared[h.id]) clearHandymanZone(h.id);
        });

        // Drop bookkeeping for fired handymen so the map can't grow without bound
        // across a long game (peep ids are recycled, so stale entries are also wrong).
        for (const id in zoneCleared) {
            if (!live[id as unknown as number]) delete zoneCleared[id];
        }
    }

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
     * Base height of a WALKABLE footpath at this tile, or -1. Queue lines do not count.
     *
     * A facility is only reachable from a path guests can leave. Someone standing in a
     * queue cannot step out to buy a burger, so a stall built against a queue line is
     * both useless and an eyesore — which is exactly what shipped: the first facility
     * this plugin ever placed went up beside a coaster queue.
     *
     * The amenity planner has always excluded queues (`isQueue` on its site records);
     * facility siting reused the general `pathBaseZ` and inherited none of that.
     */
    function walkablePathBaseZ(tileX: number, tileY: number): number {
        const tile = map.getTile(tileX, tileY);
        for (let i = 0; i < tile.numElements; i++) {
            const el = tile.getElement(i);
            if (el.type !== "footpath") continue;
            const fp = el as FootpathElement;
            if (fp.isQueue) {
                dbg.count("siteRejectQueuePath");
                continue;
            }
            // A sloped (ramp) path segment has no flat edge for a shop counter to face -
            // the railing geometry on the high/low sides blocks guest interaction there,
            // even though the tile is a perfectly valid footpath to walk along. Measured
            // in-game: a stall sited against a ramp segment placed successfully but
            // guests could never reach it - the same "can only be placed on path edges"
            // shape of rejection FootpathAdditionPlaceAction already enforces for bins
            // and benches (see the isQueue/edges checks elsewhere in this file), just not
            // previously applied here.
            if (fp.slopeDirection !== null) {
                dbg.count("siteRejectSlopedPath");
                continue;
            }
            return el.baseZ;
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

    /** Facilities that can satisfy a guest need, located at their own tile. */
    function collectFacilities(): Facility[] {
        const out: Facility[] = [];
        const counts: Record<string, number> = { hunger: 0, thirst: 0, toilet: 0, firstAid: 0 };
        const rides = map.rides;
        for (let i = 0; i < rides.length; i++) {
            const r = rides[i];
            const kind = FACILITY_RIDE_TYPES[r.type];
            if (kind === undefined) continue;
            if (r.stations.length === 0) continue;
            const start = r.stations[0].start;
            if (!start || start.x < 0 || start.y < 0) continue;
            counts[kind]++;
            out.push({ kind: kind, name: r.name, x: start.x >> 5, y: start.y >> 5 });
        }
        facilityCounts = counts;
        return out;
    }

    /**
     * Samples a window of guests and clusters their unmet needs.
     *
     * Phase 1 of the facility work: this only measures. Nothing acts on the result yet,
     * deliberately — the park has never shown a food or drink problem in telemetry, and
     * building placement logic for an assumed problem is the mistake that cost a whole
     * session on mechanic patrol zones.
     */
    function sampleGuestNeeds(): void {
        // Sampling was instrumentation-only while this was Phase 1. Automatic facility
        // placement now CONSUMES the result, so it has to run whenever that is switched
        // on, not only while diagnostics are being gathered. A normal game with both
        // switched off still pays nothing.
        if (!isDebugEnabled() && !isAutoFacilities()) return;
        const now = Date.now();
        if (now - lastNeedSample < NEED_SAMPLE_COOLDOWN_MS) return;
        lastNeedSample = now;

        const guests = map.getAllEntities("guest");
        if (guests.length === 0) return;

        // Sample this pass's window, then act on whether it finished a sweep. The
        // rotation decides that from the pass that just ran rather than from the next
        // one, which is what makes it correct on a park whose guest count is changing.
        const window = needRotation.next(guests.length);
        for (let i = window.start; i < window.end; i++) {
            const g = guests[i];
            // Skip guests that are not standing on the map.
            //
            // **This was a phantom-cluster bug, and it defeated the whole feature.** A
            // guest riding a ride — or one that has left the park — reports
            // `kLocationNull = -32768` (`world/Location.hpp:18`). The need accumulator
            // clamps negative tile coordinates to 0 to protect its key packing, so every
            // such guest was bucketed into cell (0, 0) and surfaced as a cluster at
            // tile **(4, 4)**, the centre of that cell.
            //
            // The consequences compounded. That corner is unowned map edge, so the
            // "nearest facility" was always enormously far — measured at 78, 111, 133
            // and 153 tiles across four different parks — which made it the single worst
            // gap every time and therefore the one the planner always chose. It then
            // confirmed (29 sweeps on the last park) and could never be built on,
            // because the entire search radius around it is unowned: `siteFlat` 2548
            // against `siteRejectUnowned` 2548, an exact match. Not one facility was
            // ever built from a confirmed gap.
            //
            // The rest of the project already guards this exact sentinel on ride
            // stations and exits; guest sampling was the one place that did not.
            if (g.x < 0 || g.y < 0) {
                dbg.count("guestsOffMap");
                continue;
            }
            needs.add(g.x, g.y, g.hunger, g.thirst, g.toilet, g.nausea);
            const th = g.thoughts;
            for (let t = 0; t < th.length; t++) {
                thoughts.add(th[t].type, th[t].freshness);
            }
        }
        dbg.count("guestsSampled", window.end - window.start);

        if (window.sweepComplete) {
            // Reached the end of the roster: one complete sweep of the park is finished,
            // so publish it and start a fresh picture rather than blending two sweeps.
            dbg.count("needSweepsCompleted");
            lastNeedCounts = needs.counts();
            const facilities = collectFacilities();
            // Four per kind, not two.
            //
            // Measured 2026-09-20: with only the top two taken, a genuinely persistent
            // cluster was evicted from the list whenever a third competed, so its
            // confirmation streak decayed instead of accumulating - `facilityPending`
            // showed every gap stuck at one or two sweeps against a requirement of
            // eight. The three hunger regions on the measured park (4,4), (60,92) and
            // (76,68) were competing for two slots, so each was seen about two-thirds
            // of the time and none could ever confirm.
            //
            // Slicing a already-sorted array costs nothing; the eviction did.
            const clusters = needs.top("hunger", 4)
                .concat(needs.top("thirst", 4))
                .concat(needs.top("toilet", 4))
                .concat(needs.top("firstAid", 4))
                .filter(function (c): boolean { return c.count >= NEED_GAP_MIN_GUESTS; });
            lastNeedGaps = findGaps(clusters, facilities);
            // One completed sweep of the park is one observation. Feeding the tracker
            // here rather than once per window is what makes `confirmSweeps` mean "this
            // gap survived N independent looks at the whole park".
            facilityTracker.observe(lastNeedGaps.map(function (g): GapObservation {
                return {
                    kind: g.cluster.kind, x: g.cluster.x, y: g.cluster.y,
                    guests: g.cluster.count, distance: g.distance,
                };
            }));
            lastProblems = thoughts.problems(4);
            reportNeedGaps();
            reportProblems(lastNeedCounts.sampled);
            needs.reset();
            thoughts.reset();
        }
    }

    /**
     * Logs what guests are actually complaining about.
     *
     * Thoughts lead the park-rating drop: a guest thinks "the litter here is really bad"
     * well before that litter has aged into the rating penalty (which takes ~14.5 in-game
     * days). So this is the early-warning channel the rating itself cannot provide.
     */
    function reportProblems(sampled: number): void {
        if (lastProblems.length === 0) {
            lastProblemReport = "";
            return;
        }
        const worst = lastProblems[0];
        // Only re-log when the leading complaint changes, not every sweep.
        const key = worst.category + ":" + worst.topType;
        if (key === lastProblemReport) return;
        lastProblemReport = key;
        dbg.count("guestProblemsReported");
        console.log("[Trash Manager] " + describeThoughts(worst, sampled));
    }

    /** Logs the worst-served need cluster, once per change. */
    function reportNeedGaps(): void {
        if (lastNeedGaps.length === 0) {
            lastGapReport = "";
            return;
        }
        const worst = lastNeedGaps[0];
        const key = worst.cluster.kind + ":" + worst.cluster.x + "," + worst.cluster.y;
        if (key === lastGapReport) return;
        lastGapReport = key;
        dbg.count("needGapsReported");
        console.log("[Trash Manager] " + describeGap(worst));
    }

    // -------------------------------------------------------------------------
    // Automatic facility placement (NEEDS Phase 3)
    // -------------------------------------------------------------------------

    /** Tile deltas for direction 0-3, from world/Map.cpp:71 `TileDirectionDelta`. */
    const FACILITY_DIR_DX = [-1, 0, 1, 0];
    const FACILITY_DIR_DY = [0, 1, 0, -1];

    /**
     * Object indices already built for a given ride type, read live from `map.rides`.
     *
     * Not persisted: a ride's object never changes while it exists, and a demolished
     * one should stop counting toward variety immediately, so deriving this fresh from
     * the current ride list is both simpler and correct without any of the stale-id
     * bookkeeping the staff roster needed.
     */
    function builtFacilityObjects(rideType: number): Record<number, true> {
        const used: Record<number, true> = {};
        const rides = map.rides;
        for (let i = 0; i < rides.length; i++) {
            if (rides[i].type === rideType) used[rides[i].object.index] = true;
        }
        return used;
    }

    /**
     * An unlocked ride object index that can be built as `rideType`, or -1.
     *
     * Research matters: building an object the player has not invented yet would hand
     * them something the scenario deliberately withheld. `inventedItems` is the
     * authoritative list, so it is consulted first. Sandbox and some pre-built
     * scenarios carry no research state at all, which is why the fallback exists - but
     * the fallback is only reached when there is no research state to respect.
     *
     * Among several unlocked objects of the same ride type (e.g. Burger Bar, Pizza
     * Stall and Fried Chicken Stall are all RIDE_TYPE_FOOD_STALL), prefers one not
     * already present in the park. RCT2's "Best/Worst Park Food" award is decided by
     * the count of distinct food stall TYPES (5+ distinct types avoids it outright),
     * so always picking whichever object happens to sort first would build the same
     * stall over and over and actively work against that award. Falls back to the
     * first invented match once every unlocked variant is already built.
     */
    function unlockedFacilityObject(rideType: number): number {
        const invented = park.research.inventedItems;
        const alreadyBuilt = builtFacilityObjects(rideType);
        let firstMatch = -1;
        for (let i = 0; i < invented.length; i++) {
            const item = invented[i];
            if (item.type !== "ride") continue;
            if (item.rideType !== rideType) continue;
            if (firstMatch < 0) firstMatch = item.object;
            if (!alreadyBuilt[item.object]) return item.object;
        }
        if (firstMatch >= 0) return firstMatch;

        // Research state exists but holds nothing of this type: it is genuinely locked.
        if (invented.length > 0 || park.research.uninventedItems.length > 0) return -1;

        const objects = objectManager.getAllObjects("ride");
        for (let i = 0; i < objects.length; i++) {
            const types = objects[i].rideType;
            for (let t = 0; t < types.length; t++) {
                if (types[t] === rideType && !alreadyBuilt[objects[i].index]) return objects[i].index;
            }
        }
        for (let i = 0; i < objects.length; i++) {
            const types = objects[i].rideType;
            for (let t = 0; t < types.length; t++) {
                if (types[t] === rideType) return objects[i].index;
            }
        }
        return -1;
    }

    /**
     * Buildable tiles near the confirmed gaps.
     *
     * A stall needs a tile of its own, adjacent to a footpath guests already walk on -
     * the opposite of the amenity scan, where the footpath tile IS the target. A tile
     * qualifies only when it holds nothing but flat, owned surface, because anything
     * else on it makes trackplace fail, and a failed trackplace after a successful
     * ridecreate leaves an orphan ride behind.
     *
     * Bounded by the gap list, which facilities.ts has already narrowed to a handful of
     * confirmed clusters, so this never walks the whole map.
     */
    function collectFacilitySites(gaps: ConfirmedGap[]): FacilitySite[] {
        const size = map.size;
        const seen: Record<string, true> = {};
        const sites: FacilitySite[] = [];

        for (let g = 0; g < gaps.length; g++) {
            const gap = gaps[g];
            for (let x = gap.x - FACILITY_SITE_RADIUS; x <= gap.x + FACILITY_SITE_RADIUS; x++) {
                if (x < 1 || x >= size.x - 1) continue;
                for (let y = gap.y - FACILITY_SITE_RADIUS; y <= gap.y + FACILITY_SITE_RADIUS; y++) {
                    if (y < 1 || y >= size.y - 1) continue;
                    const key = x + "," + y;
                    if (seen[key]) continue;
                    seen[key] = true;

                    // Every rejection is counted. `facilityNoSite` fired 7 times in
                    // the measured session and there was no way to tell WHICH condition
                    // was doing the rejecting, so the fix had to be guessed at. These
                    // counters turn the next occurrence into a reading.
                    const tile = map.getTile(x, y);
                    if (tile.numElements !== 1) {              // anything else blocks the build
                        dbg.count("siteRejectOccupied");
                        continue;
                    }
                    const el = tile.getElement(0);
                    if (el.type !== "surface") {
                        dbg.count("siteRejectNotSurface");
                        continue;
                    }
                    const surface = el as SurfaceElement;
                    // Slope is a PREFERENCE, not a filter. Measured 2026-09-20:
                    // `siteRejectSloped` fired 6,013 times against `siteAccepted` of
                    // ZERO across a whole session, so on a hilly park this single check
                    // was the entire reason nothing could ever be built. There is no
                    // general flat-ground rule in `TrackPlaceAction` — the only slope
                    // test guards water rides — so the honest verdict comes from the
                    // `queryAction` that precedes every placement, not from a guess here.
                    const isFlat = surface.slope === 0;
                    dbg.count(isFlat ? "siteFlat" : "siteSloped");
                    if (!surface.hasOwnership) {
                        dbg.count("siteRejectUnowned");
                        continue;
                    }

                    // Must touch a path, or guests can never reach it. The path's height
                    // is the height the stall is built at, so the two end up level.
                    let pathZ = -1;
                    let direction = -1;
                    for (let d = 0; d < 4; d++) {
                        const z = walkablePathBaseZ(x + FACILITY_DIR_DX[d], y + FACILITY_DIR_DY[d]);
                        if (z < 0) continue;
                        // The stall is built AT the path's height, so the only thing the
                        // ground has to do is not be in the way. A path at or above the
                        // surface is fine; one BELOW means this tile is a hill sitting
                        // over the path, and building into it would fail.
                        //
                        // The old test also required the path to be within one height
                        // step ABOVE the surface, which quietly assumed paths sit on the
                        // ground. On a park built as elevated wooden walkways they do
                        // not — the terrain runs far below — and measurement showed the
                        // cost exactly: of 1,615 tiles that passed every other check,
                        // 835 were unowned and the remaining 780 were rejected here.
                        // Not one site survived, all session, so nothing could be built
                        // however long a gap persisted (one had waited 17 sweeps at a
                        // 111-tile walk).
                        if (z < surface.baseZ) continue;
                        pathZ = z;
                        direction = d;
                        break;
                    }
                    if (direction < 0) {
                        dbg.count("siteRejectNoPath");
                        continue;
                    }

                    dbg.count("siteAccepted");
                    sites.push({ x: x, y: y, z: pathZ, direction: direction, flat: isFlat });
                }
            }
        }
        return sites;
    }

    /** Facility counts by need kind, including everything the player built. */
    function currentFacilityCounts(): Record<string, number> {
        const counts: Record<string, number> = { hunger: 0, thirst: 0, toilet: 0, firstAid: 0 };
        const rides = map.rides;
        for (let i = 0; i < rides.length; i++) {
            const kind = FACILITY_RIDE_TYPES[rides[i].type];
            if (kind !== undefined) counts[kind]++;
        }
        return counts;
    }

    /**
     * Removes a ride this plugin created moments ago but failed to place track for.
     *
     * This is the ONLY demolition anywhere in the project, and it is not an exception to
     * the "never remove what the player built" rule - the ride being removed is one that
     * existed for a few milliseconds, has no track, and was created by this call chain.
     * Leaving it would put a permanent blank entry in the player's ride list that only
     * they could clean up. The id is captured in the closure, so there is no path by
     * which this could be pointed at an established ride.
     */
    function discardOrphanRide(rideId: number): void {
        dbg.count("facilityOrphanDiscarded");
        context.executeAction("ridedemolish", { ride: rideId, modifyType: 0 }, function (): void { });
    }

    /**
     * Places the track piece, trying each rotation until the game accepts one.
     *
     * Which rotation a stall wants is not something the plugin API documents, and
     * guessing wrong wastes a whole build. `queryAction` is silent and raises no error
     * window, so rotations are probed exactly the way ops.ts probes an unreadable value
     * range: the computed guess first, then the rest. The winning rotation is counted,
     * so the convention can be read off telemetry rather than assumed.
     */
    function placeFacilityTrack(plan: FacilityPlan, rideId: number, rideType: number): void {
        const order = [plan.site.direction, 0, 1, 2, 3];
        let attempt = 0;

        function tryNext(): void {
            if (attempt >= order.length) {
                discardOrphanRide(rideId);
                return;
            }
            const direction = order[attempt];
            attempt++;

            const args = {
                x: plan.site.x << 5, y: plan.site.y << 5, z: plan.site.z,
                direction: direction, ride: rideId, trackType: FACILITY_TRACK_TYPE,
                rideType: rideType, brakeSpeed: 0, colour: 0, seatRotation: 0,
                trackPlaceFlags: 0, isFromTrackDesign: false,
            };

            context.queryAction("trackplace", args, function (q: GameActionResult): void {
                if (q.error && q.error !== 0) {
                    tryNext();
                    return;
                }
                context.executeAction("trackplace", args, function (r: GameActionResult): void {
                    if (r.error && r.error !== 0) {
                        // Accepted on query then refused on execute: the world moved
                        // underneath us. Do not retry, just clean up.
                        dbg.count("facilityTrackFailed");
                        discardOrphanRide(rideId);
                        return;
                    }
                    dbg.count("facilityPlaced");
                    dbg.count("facilityDirection" + direction);
                    // A stall that is built but closed serves nobody.
                    context.executeAction("ridesetstatus", { ride: rideId, status: 1 },
                        function (o: GameActionResult): void {
                            if (o.error && o.error !== 0) dbg.count("facilityOpenFailed");
                        });
                    // It exists now, so the cluster must prove itself all over again
                    // before anything else gets built for it.
                    facilityTracker.clear(plan.gap.kind, plan.gap.x, plan.gap.y);
                    console.log("[Trash Manager] " + describePlan(plan));
                });
            });
        }

        tryNext();
    }

    /** Creates the ride entry, then hands off to track placement. */
    function buildFacility(plan: FacilityPlan): void {
        const rideType = FACILITY_BUILD_TYPE[plan.kind];
        const rideObject = unlockedFacilityObject(rideType);
        if (rideObject < 0) {
            // Nothing of this kind is researched yet. Not an error, just not yet.
            dbg.count("facilityNotUnlocked");
            facilityBuilding = false;
            return;
        }

        const args = {
            rideType: rideType, rideObject: rideObject, entranceObject: 0,
            colour1: 0, colour2: 0, inspectionInterval: 0,
        };

        context.queryAction("ridecreate", args, function (q: GameActionResult): void {
            if (q.error && q.error !== 0) {
                dbg.count("facilityCreateRefused");
                facilityBuilding = false;
                return;
            }
            context.executeAction("ridecreate", args, function (r: RideCreateActionResult): void {
                facilityBuilding = false;
                if ((r.error && r.error !== 0) || r.ride === undefined) {
                    dbg.count("facilityCreateFailed");
                    return;
                }
                placeFacilityTrack(plan, r.ride, rideType);
            });
        });
    }

    /**
     * Builds at most one facility where guests have a measured, persistent unmet need.
     *
     * Off by default. Rate-limited, cash-floored, capped per kind, and gated on a gap
     * having persisted across many sampling sweeps - every one of those bounds is
     * enforced in facilities.ts and unit-tested there. Nothing is ever demolished.
     */
    function manageFacilities(): void {
        if (!isAutoFacilities()) return;
        const now = Date.now();
        if (facilityBuilding) {
            if (now - facilityBuildStarted < FACILITY_BUILD_TIMEOUT_MS) return;
            dbg.count("facilityBuildTimedOut");
            facilityBuilding = false;
        }

        if (park.cash < FACILITY_MIN_CASH) {
            dbg.count("facilitySkippedLowCash");
            return;
        }

        const confirmed = facilityTracker.pending().filter(function (g): boolean {
            return g.sweeps >= DEFAULT_FACILITY_OPTIONS.confirmSweeps;
        });
        lastFacilityPlans = confirmed.length;
        if (confirmed.length === 0) {
            // Instrumented because this is the overwhelmingly common reason nothing gets
            // built, and it used to return in silence — leaving "is it even working?"
            // answerable only by digging through per-day park records. Every other exit
            // from this function is counted; this one is the one that actually fires.
            //
            // A high count here is the feature working correctly on a well-served park,
            // NOT a fault. It only becomes interesting if `needGaps` is non-empty at the
            // same time, which would mean gaps are being found but never confirmed.
            dbg.count("facilityNoGaps");
            return;
        }

        const sites = collectFacilitySites(confirmed);
        if (sites.length === 0) {
            dbg.count("facilityNoSite");
            return;
        }

        const plans = planFacilities(confirmed, sites, currentFacilityCounts(), DEFAULT_FACILITY_OPTIONS);
        if (plans.length === 0) {
            dbg.count("facilityCapped");
            return;
        }

        facilityBuilding = true;
        facilityBuildStarted = now;
        buildFacility(plans[0]);
    }

    // -------------------------------------------------------------------------
    // Diagnostics
    // -------------------------------------------------------------------------

    /**
     * Reports the worst litter cluster, if there is one worth naming.
     *
     * Logged only when the location changes, not every day, so a persistent hotspot
     * does not spam the console while the player is dealing with it.
     */
    function reportHotspots(): void {
        const worst = cache.topHotspots.length > 0 ? cache.topHotspots[0] : null;
        if (worst === null || worst.oldCount < HOTSPOT_MIN_OLD) {
            lastHotspotReport = "";
            return;
        }

        const key = worst.x + "," + worst.y;
        if (key === lastHotspotReport) return;
        lastHotspotReport = key;

        const kind = worst.vomit > worst.count - worst.vomit ? "mostly vomit" : "mostly trash";
        console.log("[Trash Manager] Litter hotspot near tile (" + worst.x + ", " + worst.y +
            "): " + worst.count + " pieces, " + worst.oldCount + " costing rating (" +
            kind + "). Consider a bin, or check handyman coverage there.");
    }

    /**
     * Watches whether handymen are actually sweeping.
     *
     * A handyman who sweeps nothing for days *while old litter exists* is usually
     * stuck - the classic case is oscillating in a queue line toward litter on an
     * adjacent path they cannot reach. Hiring more handymen does not fix that, so it
     * is worth telling the player rather than silently raising headcount.
     */
    function checkActivity(handymen: Handyman[]): ActivitySnapshot {
        for (let i = 0; i < handymen.length; i++) {
            const h = handymen[i];
            if (h.id === null) continue;
            activity.observe(h.id, h.litterSwept + h.binsEmptied);
        }
        const snap = activity.endSweep(cache.oldLitter > 0);
        dbg.count("handymanWorkDone", snap.workDone);
        if (snap.fleetUnderworked) dbg.count("fleetUnderworked");

        if (snap.stuck.length === 0) {
            lastStuckReport = 0;
            return snap;
        }
        dbg.count("handymenStuck", snap.stuck.length);
        if (snap.stuck.length !== lastStuckReport) {
            lastStuckReport = snap.stuck.length;
            console.log("[Trash Manager] " + snap.stuck.length + " of " + snap.tracked +
                " handymen have swept nothing at all while " + snap.active +
                " of their peers are working - peep id(s): " + snap.stuck.join(", ") +
                ". Likely stuck (queue-line pathfinding bug) rather than understaffed.");
        }
        return snap;
    }

    /** Park state emitted alongside timings, so staffing formulas can be evaluated. */
    function parkContext(): Record<string, unknown> {
        const worst = cache.topHotspots.length > 0 ? cache.topHotspots[0] : null;
        return {
            parkRating:  park.rating,
            // Without these the litter counts are uninterpretable: a clean park under
            // auto-sweep says nothing about whether the handymen are keeping up.
            autoSweep:   storage.get<boolean>("autoSweepEnabled") === true,
            autoHire:    storage.get<boolean>("autoHireEnabled") !== false,
            guests:      cache.guests,
            handymen:    cache.handymanCount,
            needed:      computeNeededHandymen(cache.pathTiles, cache.guests),
            adaptive:    isAdaptiveStaffing(),
            autoAmenities: isAutoAmenities(),
            coverageTiles: coverageTiles.length,
            needs: lastNeedCounts,
            problems: lastProblems.map(function (t): Record<string, unknown> {
                return { category: t.category, count: t.count, topType: t.topType };
            }),
            // Source-verified wage (Staff.cpp:2645): handymen are GBP 50/month. With park
            // rating usually pinned at its maximum, wages are the only lever the staffing
            // controller still moves, so the saving is worth making visible.
            handymanWagesPerMonth: cache.handymanCount * 50,
            formulaWagesPerMonth: computeNeededHandymen(cache.pathTiles, cache.guests) * 50,
            facilities: facilityCounts,
            autoFacilities: isAutoFacilities(),
            facilityConfirmed: lastFacilityPlans,
            facilityPending: facilityTracker.pending().slice(0, 4).map(function (g): Record<string, unknown> {
                return { kind: g.kind, x: g.x, y: g.y, guests: g.guests, distance: g.distance, sweeps: g.sweeps };
            }),
            needGaps: lastNeedGaps.slice(0, 4).map(function (g): Record<string, unknown> {
                return {
                    kind: g.cluster.kind,
                    x: g.cluster.x,
                    y: g.cluster.y,
                    guests: g.cluster.count,
                    distance: g.distance,
                    nearest: g.nearest !== null ? g.nearest.name : null,
                };
            }),
            amenityRemoval: isAmenityRemoval(),
            adaptiveTarget: staffing.target(),
            staffingFloor: staffingFloor(),
            discoveredFloor: lastDecision !== null ? lastDecision.discoveredFloor : 0,
            settling: lastDecision !== null ? lastDecision.settling : 0,
            litterAverage: lastDecision !== null ? lastDecision.litterAverage : 0,
            maxHandymen: getMaxHandymen(),
            pathTiles:   cache.pathTiles,
            ownedTiles:  cache.ownedTiles,
            totalLitter: cache.totalLitter,
            oldLitter:   cache.oldLitter,
            vomit:       cache.vomit,
            fullBins:    cache.fullBins,
            brokenBins:  cache.brokenBins,
            worstVomit: (function(): Record<string, unknown> | null {
                const v = cache.topHotspots.length > 0 ? hotspots.topVomit(1) : [];
                return v.length > 0 ? { x: v[0].x, y: v[0].y, vomit: v[0].vomit } : null;
            })(),
            worstHotspot: worst !== null
                ? { x: worst.x, y: worst.y, count: worst.count, oldCount: worst.oldCount }
                : null,
        };
    }

    // -------------------------------------------------------------------------
    // Interval hooks
    // -------------------------------------------------------------------------

    /**
     * Daily: update entity cache (cheap); tile cache is rate-limited internally.
     * Expensive tile scan runs at most once per TILE_SCAN_COOLDOWN_MS real seconds.
     */
    context.subscribe("interval.day", function(): void {
        dbg.time("day.tileCache", updateTileCache); // no-op if cooldown hasn't elapsed

        // One staff scan and one litter scan for the whole day's work — every helper
        // below takes these arrays rather than re-running getAllEntities itself.
        const handymen = dbg.time("day.staffScan", getHandymen);
        const litter   = dbg.time("day.entityCache", () => updateEntityCache(handymen));

        dbg.time("day.enforceOrders", () => enforceOrders(handymen));
        const snap = dbg.time("day.activity", () => checkActivity(handymen));
        reportHotspots();
        reportVomit();
        dbg.time("day.amenities", manageAmenities);
        dbg.time("day.needSample", sampleGuestNeeds);
        dbg.time("day.facilities", manageFacilities);

        const autoHire  = storage.get<boolean>("autoHireEnabled") !== false;
        const autoSweep = storage.get<boolean>("autoSweepEnabled") === true;

        if (autoSweep) {
            litter.forEach(function(e: Litter): void { e.remove(); });
            cache.oldLitter = 0;
            cache.trash     = 0;
            cache.vomit     = 0;
            cache.totalLitter = 0;
        }

        // Set when we hire or fire below, meaning `handymen` no longer reflects reality.
        let rosterChanged = false;

        if (autoHire) {
            const formulaTarget = computeNeededHandymen(cache.pathTiles, cache.guests);
            let wanted = formulaTarget;

            if (isAdaptiveStaffing()) {
                if (!staffingSeeded) {
                    // Start from what the park already has rather than jumping straight
                    // to the formula, so enabling this never causes a mass hire or fire.
                    staffing.seed(handymen.length > 0 ? handymen.length : formulaTarget);
                    staffingSeeded = true;
                }
                const decision = staffing.update({
                    oldLitter:        cache.oldLitter,
                    totalLitter:      cache.totalLitter,
                    parkRating:       park.rating,
                    fleetUnderworked: snap.fleetUnderworked,
                    formulaTarget:    formulaTarget,
                    floor:            staffingFloor(),
                });
                dbg.count("staffingSettling", decision.settling > 0 ? 1 : 0);
                lastDecision = decision;
                wanted = decision.target;
                if (decision.reason !== "" && decision.reason !== lastStaffingReason) {
                    lastStaffingReason = decision.reason;
                    console.log("[Trash Manager] Adaptive staffing target now " +
                        decision.target + " (formula says " + formulaTarget + "): " +
                        decision.reason + ".");
                }
            }

            // The cap is the real target: if the player lowers "max handymen" below the
            // recommendation we must fire down to the cap. Comparing against `wanted`
            // here meant a lowered cap was silently ignored.
            const cap     = Math.min(wanted, getMaxHandymen());
            const deficit = cap - handymen.length;
            // A recent refusal says the park has no room for another entity. Retrying
            // daily would just put the game's error in front of the player again.
            if (deficit > 0 && !hiringBlocked()) {
                // Hire up to 3 per day so staffing recovers quickly after park expansions,
                // without flooding the park on initial load.
                const hireCount = Math.min(3, deficit);
                rosterChanged = true;
                for (let i = 0; i < hireCount; i++) {
                    hireHandyman(function(peepId: number): void {
                        clearHandymanZone(peepId);
                    });
                }
            } else if (handymen.length > cap + (isAdaptiveStaffing() ? 0 : 3)) {
                // The controller already has its own hysteresis, so when adaptive
                // staffing is on we converge straight to its target. The fixed formula
                // has none, hence the +3 dead band in that mode.
                fireHandyman(handymen);
                rosterChanged = true;
            }
        }

        // Keep patrol zones in step with newly built paths. This is a no-op on days
        // where the path bounds are unchanged and no handyman was hired.
        //
        // Re-read the roster if we just hired or fired: game actions execute
        // synchronously in single player, so `handymen` would otherwise still contain
        // a peep that no longer exists and syncZones would aim a patrol-area action at
        // a dead sprite id.
        dbg.time("day.syncZones", () => syncZones(rosterChanged ? getHandymen() : handymen));
        dbg.flushStats(parkContext());

        const penalty = computeRatingPenalty(cache.oldLitter);
        if (penalty >= 300) {
            console.log("[Trash Manager] Litter costing -" + penalty + " rating pts (" +
                cache.oldLitter + " old pieces; ceiling at " + LITTER_PENALTY_CAP + ").");
        }
        if (cache.brokenBins > 0) {
            console.log("[Trash Manager] " + cache.brokenBins +
                " broken bin(s) detected — vandalism cascade risk.");
        }
    });

    /**
     * Per-tick: process deferred sweep requests from UI buttons.
     * entity.remove() is only safe in this context (game state is mutable here).
     */
    context.subscribe("interval.tick", function(): void {
        if (!pendingSweepAll && !pendingSweepOld && !pendingFixOrders) return;

        // enforceOrders writes directly to entity properties; must run here, not in onClick.
        if (pendingFixOrders) { enforceOrders(); pendingFixOrders = false; }
        if (!pendingSweepAll && !pendingSweepOld) return;

        const sweepOldOnly = pendingSweepOld && !pendingSweepAll;
        pendingSweepAll  = false;
        pendingSweepOld  = false;

        let litter: Litter[] = map.getAllEntities("litter");

        if (sweepOldOnly) {
            // Keep only penalty-causing pieces; oldest-first so highest-damage
            // litter is removed first if there is ever a per-tick removal limit.
            litter = litter.filter(isOldLitter);
            // Sort oldest-first by *age*, not raw creationTick: creationTick is a uint32
            // that wraps, so subtracting raw ticks mis-orders litter across a wrap.
            litter.sort(function(a: Litter, b: Litter): number {
                return litterAge(b) - litterAge(a);
            });
        }

        litter.forEach(function(e: Litter): void { e.remove(); });

        if (sweepOldOnly) {
            cache.oldLitter = 0;
        } else {
            cache.oldLitter = 0;
            cache.trash     = 0;
            cache.vomit     = 0;
        }

        console.log("[Trash Manager] Swept " + litter.length +
            (sweepOldOnly ? " old (penalty-causing)" : "") + " litter items.");
    });

    // -------------------------------------------------------------------------
    // UI
    // -------------------------------------------------------------------------

    // Populate cache immediately on load so the UI shows real values on first open,
    // not zeros. Without this, the cache stays empty until the first in-game day.
    updateCache();

    if (typeof ui === "undefined") return; // headless / dedicated server

    ui.registerMenuItem("Trash Manager", openWindow);

    let win: Window | null           = null;
    let refreshHandle: number | null = null;

    function openWindow(): void {
        if (win !== null) { win.bringToFront(); return; }

        win = ui.openWindow({
            classification: "trash-manager",
            title: "Trash Manager v" + __PLUGIN_VERSION__,
            width: 300,
            height: 446,
            widgets: [
                // --- Rating Impact ---
                { type: "groupbox", x: 6, y: 16, width: 288, height: 66, text: "Rating Impact" },
                { type: "label", name: "lblRating", x: 14, y: 30, width: 276, height: 14, text: "Litter penalty: calculating..." },
                { type: "label", name: "lblThresh", x: 14, y: 46, width: 276, height: 14, text: "Severity: ----" },
                { type: "label", name: "lblLitter", x: 14, y: 62, width: 276, height: 14, text: "Total litter: --  (trash: --, vomit: --)" },

                // --- Staffing ---
                { type: "groupbox", x: 6, y: 88, width: 288, height: 66, text: "Staffing" },
                { type: "label", name: "lblHandymen", x: 14, y: 102, width: 276, height: 14, text: "Handymen: --  /  needed: --  /  max: --" },
                { type: "label", name: "lblBins",     x: 14, y: 118, width: 276, height: 14, text: "Bins: -- full, -- broken  (guests: --)" },
                { type: "label", name: "lblTiles",    x: 14, y: 134, width: 276, height: 14, text: "Path tiles: --  /  owned land: --" },

                // --- Automation ---
                { type: "groupbox", x: 6, y: 160, width: 288, height: 146, text: "Automation  (runs each in-game day)" },
                {
                    type: "checkbox", name: "chkAutoHire",
                    x: 14, y: 174, width: 276, height: 14,
                    text: "Auto-hire / fire handymen",
                    tooltip: "Targets 1 handyman per " + GUESTS_PER_HANDYMAN + " guests (or 1 per " + PATH_TILES_PER_HANDYMAN + " path tiles minimum) + " + FREE_ROAMING_BUFFER + " free-roaming; fires when overstaffed by >3",
                    isChecked: storage.get<boolean>("autoHireEnabled") !== false,
                    onChange: function(v: boolean): void { storage.set("autoHireEnabled", v); },
                },
                {
                    type: "checkbox", name: "chkAutoSweep",
                    x: 14, y: 192, width: 276, height: 14,
                    text: "Auto-sweep all litter each day",
                    isChecked: storage.get<boolean>("autoSweepEnabled") === true,
                    onChange: function(v: boolean): void { storage.set("autoSweepEnabled", v); },
                },
                {
                    type: "checkbox", name: "chkAdaptive",
                    x: 14, y: 210, width: 276, height: 14,
                    text: "Adaptive staffing (learn the right number)",
                    tooltip: "Reduce handymen while the park stays clean and the fleet has nothing to do; hire back immediately if litter starts costing park rating. Never exceeds the formula's recommendation, never drops below path-coverage minimum.",
                    isChecked: isAdaptiveStaffing(),
                    onChange: function(v: boolean): void {
                        storage.set("adaptiveStaffing", v);
                        staffingSeeded = false; // re-seed from the live roster
                    },
                },
                {
                    type: "checkbox", name: "chkAmenities",
                    x: 14, y: 228, width: 276, height: 14,
                    text: "Auto-place benches & bins where needed",
                    tooltip: "Each in-game day, place benches near nauseating ride exits and vomit hotspots, and bins near stalls. Benches stop guests vomiting (a seated guest sheds nausea); handymen only clean up afterwards. Costs money, so it is off by default.",
                    isChecked: isAutoAmenities(),
                    onChange: function(v: boolean): void { storage.set("autoAmenities", v); },
                },
                {
                    type: "checkbox", name: "chkAmenityRemoval",
                    x: 26, y: 246, width: 264, height: 14,
                    text: "...and remove ones no longer needed",
                    tooltip: "Remove benches and bins that are no longer near any stall, nauseating ride exit or vomit hotspot. ONLY removes amenities this plugin placed itself - anything you placed is never touched.",
                    isChecked: isAmenityRemoval(),
                    onChange: function(v: boolean): void { storage.set("autoAmenityRemoval", v); },
                },
                {
                    type: "checkbox", name: "chkFacilities",
                    x: 14, y: 264, width: 276, height: 14,
                    text: "Auto-build toilets, first aid & food stalls",
                    tooltip: "Watches where guests actually go hungry, thirsty or need a toilet, and builds a facility there once the same gap has persisted across many samples. Costs real money and needs Diagnostics-quality sampling, which it turns on for itself. Never demolishes anything, caps how many of each kind it will build, and builds at most one at a time. Off by default.",
                    isChecked: isAutoFacilities(),
                    onChange: function(v: boolean): void { storage.set("autoFacilities", v); },
                },
                { type: "label", x: 14, y: 284, width: 116, height: 14, text: "Max handymen cap:" },
                {
                    type: "spinner", name: "spnMaxHandymen",
                    x: 134, y: 282, width: 48, height: 16,
                    text: String(getMaxHandymen()),
                    tooltip: "Hard upper limit on auto-hired handymen; 1-99  (manual hires are unaffected)",
                    onIncrement: function(): void {
                        const n = Math.min(99, getMaxHandymen() + 1);
                        storage.set("maxHandymen", n);
                        if (win) win.findWidget<SpinnerWidget>("spnMaxHandymen").text = String(n);
                        refreshWindow();
                    },
                    onDecrement: function(): void {
                        const n = Math.max(1, getMaxHandymen() - 1);
                        storage.set("maxHandymen", n);
                        if (win) win.findWidget<SpinnerWidget>("spnMaxHandymen").text = String(n);
                        refreshWindow();
                    },
                },

                // --- Actions ---
                { type: "groupbox", x: 6, y: 312, width: 288, height: 102, text: "Actions" },
                {
                    type: "button", x: 14, y: 326, width: 86, height: 16,
                    text: "Sweep All",
                    tooltip: "Immediately remove every litter item from the park",
                    onClick: function(): void { pendingSweepAll = true; },
                },
                {
                    type: "button", x: 106, y: 326, width: 90, height: 16,
                    text: "Sweep Old Only",
                    tooltip: "Remove only litter aged 7680+ ticks — the pieces currently costing rating points",
                    onClick: function(): void { pendingSweepOld = true; },
                },
                {
                    type: "button", x: 202, y: 326, width: 86, height: 16,
                    text: "Hire Handyman",
                    tooltip: "Hire one handyman and assign them a patrol zone",
                    onClick: function(): void {
                        hireHandyman(function(id: number): void {
                            clearHandymanZone(id);
                        });
                    },
                },
                {
                    type: "button", x: 14, y: 346, width: 134, height: 16,
                    text: "Clear All Patrol Zones",
                    tooltip: "Remove every handyman's patrol area so they can reach any path in the park. OpenRCT2 dispatches the nearest handyman to each piece of litter automatically, so a zone only gets in the way.",
                    onClick: function(): void { clearAllZones(); },
                },
                {
                    type: "button", x: 154, y: 346, width: 134, height: 16,
                    text: "Fix Orders (No Mow)",
                    tooltip: "Enable sweep + empty bins on all handymen; disables grass mowing which causes handymen to abandon path sweeping",
                    onClick: function(): void { pendingFixOrders = true; },
                },
                {
                    type: "button", x: 14, y: 366, width: 274, height: 16,
                    text: "Force Full Scan & Refresh",
                    tooltip: "Re-scan all tiles and entities to update displayed counts",
                    onClick: function(): void { lastTileScanTime = 0; updateCache(); refreshWindow(); },
                },

                { type: "label", name: "lblStatus", x: 14, y: 386, width: 276, height: 14, text: "" },
                {
                    type: "checkbox", name: "chkDebug",
                    x: 14, y: 406, width: 276, height: 14,
                    text: "Diagnostics: stream timings to log sink",
                    tooltip: "Stream timing and counter data to a local log sink on 127.0.0.1:7777 for performance analysis. Off by default; costs nothing when off.",
                    isChecked: isDebugEnabled(),
                    onChange: function(v: boolean): void { setDebugEnabled(v); },
                },
            ],
            onClose: function(): void {
                win = null;
                if (refreshHandle !== null) {
                    context.clearInterval(refreshHandle);
                    refreshHandle = null;
                }
            },
        });

        refreshWindow();
        // Refresh display every 3 real-world seconds; reads cached values only, not a tile scan
        refreshHandle = context.setInterval(refreshWindow, 3000);
    }

    /** Builds a text severity bar: "[####................] 20%" */
    function makeThresholdBar(oldCount: number): string {
        const pct    = Math.min(1.0, oldCount / LITTER_PENALTY_CAP);
        const filled = Math.round(pct * 20);
        let bar      = "[";
        for (let i = 0; i < 20; i++) bar += (i < filled ? "#" : ".");
        bar += "]";
        const label  = pct === 0      ? "none"
                     : pct < 0.25    ? "low"
                     : pct < 0.5     ? "medium"
                     : pct < 0.75    ? "high"
                     : "CRITICAL";
        return "Severity: " + label + "  " + bar + "  " + Math.round(pct * 100) + "%";
    }

    /** Updates all window labels from current cache + live data. */
    function refreshWindow(): void {
        if (!win) return;

        const penalty = computeRatingPenalty(cache.oldLitter);
        const needed  = computeNeededHandymen(cache.pathTiles, cache.guests);

        win.findWidget<LabelWidget>("lblRating").text   =
            "Litter penalty: -" + penalty + " pts  (" + cache.oldLitter + " old / " + LITTER_PENALTY_CAP + " max)";
        win.findWidget<LabelWidget>("lblThresh").text   = makeThresholdBar(cache.oldLitter);
        win.findWidget<LabelWidget>("lblLitter").text   =
            "Total litter: " + cache.totalLitter + "  (trash: " + cache.trash + ", vomit: " + cache.vomit + ")";
        const adaptive = isAdaptiveStaffing();
        win.findWidget<LabelWidget>("lblHandymen").text =
            "Handymen: " + cache.handymanCount +
            (adaptive ? "  /  target: " + staffing.target() + " (formula " + needed + ")"
                      : "  /  needed: " + needed) +
            "  /  max: " + getMaxHandymen();
        const saving = (needed - cache.handymanCount) * 50;
        if (saving > 0) {
            win.findWidget<LabelWidget>("lblHandymen").text += "   (-" + saving + "/mo)";
        }
        win.findWidget<LabelWidget>("lblBins").text     =
            "Bins: " + cache.fullBins + " full, " + cache.brokenBins + " broken  (guests: " + cache.guests + ")";
        win.findWidget<LabelWidget>("lblTiles").text    =
            "Path tiles: " + cache.pathTiles + "  /  owned land: " + cache.ownedTiles;
        win.findWidget<LabelWidget>("lblStatus").text   =
            cache.brokenBins > 0 ? "[!] Broken bins detected -- vandalism cascade risk!" : "";
    }
}
