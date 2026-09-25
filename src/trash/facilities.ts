/**
 * Guest-need sampling and automatic facility (stall/toilet) placement.
 *
 * Split out of trash-manager.ts (#6) with no behaviour change.
 */

import { isDebugEnabled, DebugChannel } from "../debug";
import { TrashSettings } from "./shared";
import { spendGate } from "../cash-gate";
import {
    createNeedAccumulator, createSampleRotation, findGaps, describeGap,
    CLUSTER_MIN_GUESTS, NeedKind, NeedCounts, NeedGap, Facility,
} from "../needs";
import {
    createFacilityTracker, planFacilities, describePlan, DEFAULT_FACILITY_OPTIONS,
    FacilityPlan, FacilitySite, ConfirmedGap, GapObservation,
} from "../facilities";
import { createThoughtAccumulator, describeThoughts, ThoughtTally } from "../thoughts";

export function createFacilityManager(settings: TrashSettings, dbg: DebugChannel) {


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
        return settings.autoFacilities.get();
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

        // #44: a no-money park is never charged, so the floor is skipped there (counted).
        const gate = spendGate(park.cash, FACILITY_MIN_CASH, park.getFlag("noMoney"), "build");
        if (gate === "lowCash") {
            dbg.count("facilitySkippedLowCash");
            return;
        }
        if (gate === "noMoneyPark") dbg.count("facilityNoMoneyPark");

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

    return {
        isAutoFacilities,
        sampleGuestNeeds,
        manageFacilities,
        facilityTracker,
        getLastNeedCounts(): NeedCounts | null { return lastNeedCounts; },
        getLastProblems(): ThoughtTally[] { return lastProblems; },
        getFacilityCounts(): Record<string, number> { return facilityCounts; },
        getLastFacilityPlans(): number { return lastFacilityPlans; },
        getLastNeedGaps(): NeedGap[] { return lastNeedGaps; },
    };
}
