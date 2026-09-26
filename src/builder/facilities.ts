/**
 * Guest-need sampling and automatic facility (stall/toilet) placement.
 *
 * Split out of trash-manager.ts (#6); moved to the Auto-Builder plugin (#84).
 */

import { isDebugEnabled, DebugChannel } from "../debug";
import { BuilderSettings } from "./settings";
import { spendGate } from "../cash-gate";
import { createCooldown, NEED_SAMPLE_TICKS, BUILD_WATCHDOG_TICKS } from "../cooldown";
import {
    createNeedAccumulator, createSampleRotation, findGaps, describeGap,
    CLUSTER_MIN_GUESTS, NeedKind, NeedCounts, NeedGap, Facility,
} from "../needs";
import {
    createFacilityTracker, planFacilities, describePlan, findCourts, courtForGap, DEFAULT_FACILITY_OPTIONS,
    DEFAULT_COURT_OPTIONS, FacilityPlan, GapObservation,
} from "../facilities";
import { createThoughtAccumulator, describeThoughts, ThoughtTally } from "../thoughts";
import { StallBuilder } from "./stall-build";
import { pickSite, DEFAULT_CHEAP_BUILD_OPTIONS } from "../cheap-builds";

/**
 * Gets every fresh thought the need sampler reads, with the guest's tile, and hears
 * when a sweep of the park finishes. Lets the cheap builds (#81) cluster "lost" guests
 * without a second pass over the guest list.
 */
export interface GuestThoughtListener {
    /** True when the listener needs samples even with auto facilities off. */
    wantsSamples(): boolean;
    thought(type: string, tileX: number, tileY: number): void;
    sweepComplete(): void;
}

export function createFacilityManager(settings: BuilderSettings, dbg: DebugChannel, stalls: StallBuilder,
                                      listener?: GuestThoughtListener) {


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
    //
    // #48: the 2.5 s cooldown was real time, so sampling ran every day at speed 1 but
    // only every ~1.5 days at speed 4, and facility confirmations (counted in sweeps)
    // came later at speed 4. Half a game day keeps it daily at every speed; the 1 s floor
    // is under one speed-4 day (~1.7 s) so it only binds past speed 4. Max measured 9ms.
    const NEED_SAMPLE_FLOOR_MS       = 1_000;
    const NEED_SAMPLE_WINDOW      = 400;   // guests read per pass, at least
    // #80: the window grows with the park so one pass reads everyone, making a sweep
    // one in-game day on every park. At a fixed 400 a 1,200-guest park took 3 days per
    // sweep, so `confirmSweeps` = 5 meant ~15 days and gaps drifted away first: 1 build
    // in 10 thirty-day harness runs. Reading everyone measured 16ms max per day on a
    // 1,200-guest park (the fixed 400 window already peaked at 13ms). The cap keeps a
    // very large park near 30ms; above it sweeps fall back to taking several days.
    const NEED_SAMPLE_WINDOW_MAX  = 2_000;
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
    // at most once per interval.day, `stalls.collectSites` only walks a bounded
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


    const facilityTracker = createFacilityTracker(DEFAULT_FACILITY_OPTIONS);
    /** Set while a build chain is mid-flight, so passes cannot overlap. */
    let facilityBuilding = false;
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
     *
     * Game time (#48): 60 real seconds was ~5 days at speed 1 but ~37 at speed 4. Five
     * days keeps speed 1 as it was; the 5 s floor is under 5 speed-4 days (~8 s).
     */
    const buildWatchdog = createCooldown(BUILD_WATCHDOG_TICKS, 5_000);
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
    const needSampleCooldown = createCooldown(NEED_SAMPLE_TICKS, NEED_SAMPLE_FLOOR_MS);
    let lastNeedCounts: NeedCounts | null = null;
    let lastNeedGaps: NeedGap[] = [];
    let lastGapReport = "";
    // Facility counts by kind, for the log. Rebuilt with the gaps.
    let facilityCounts: Record<string, number> = {};

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
        if (!isDebugEnabled() && !isAutoFacilities() && !(listener !== undefined && listener.wantsSamples())) return;
        if (!needSampleCooldown.ready(date.ticksElapsed, Date.now())) return;

        const guests = map.getAllEntities("guest");
        if (guests.length === 0) return;

        // Sample this pass's window, then act on whether it finished a sweep. The
        // rotation decides that from the pass that just ran rather than from the next
        // one, which is what makes it correct on a park whose guest count is changing.
        const size = Math.min(Math.max(guests.length, NEED_SAMPLE_WINDOW), NEED_SAMPLE_WINDOW_MAX);
        const window = needRotation.next(guests.length, size);
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
                if (listener !== undefined && th[t].freshness <= THOUGHT_MAX_FRESHNESS) {
                    listener.thought(th[t].type, g.x >> 5, g.y >> 5);
                }
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
            if (listener !== undefined) listener.sweepComplete();
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
        console.log("[Auto-Builder] " + describeThoughts(worst, sampled));
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
        console.log("[Auto-Builder] " + describeGap(worst));
    }

    // -------------------------------------------------------------------------
    // Automatic facility placement (NEEDS Phase 3)
    // -------------------------------------------------------------------------

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

    /** Picks an unlocked object for the plan's kind and builds it at the plan's site. */
    function buildFacility(plan: FacilityPlan): void {
        const rideType = FACILITY_BUILD_TYPE[plan.kind];
        const rideObject = stalls.unlockedObject(rideType);
        if (rideObject < 0) {
            // Nothing of this kind is researched yet. Not an error, just not yet.
            dbg.count("facilityNotUnlocked");
            facilityBuilding = false;
            return;
        }
        stalls.build("facility", rideType, rideObject, plan.site,
            function (): void { facilityBuilding = false; },
            function (): void {
                // It exists now, so the cluster must prove itself all over again
                // before anything else gets built for it.
                facilityTracker.clear(plan.gap.kind, plan.gap.x, plan.gap.y);
                console.log("[Auto-Builder] " + describePlan(plan));
            });
    }
    /**
     * Builds at most one facility where guests have a measured, persistent unmet need.
     *
     * On by default since #51. Rate-limited, cash-floored, capped per kind, and gated on a gap
     * having persisted across many sampling sweeps - every one of those bounds is
     * enforced in facilities.ts and unit-tested there. Nothing is ever demolished.
     */
    function manageFacilities(): void {
        if (!isAutoFacilities()) return;
        if (facilityBuilding) {
            if (!buildWatchdog.ready(date.ticksElapsed, Date.now())) return;
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

        const sites = stalls.collectSites(confirmed, FACILITY_SITE_RADIUS);
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
        // Arm the watchdog: the next ready() is due five days from now.
        buildWatchdog.reset();
        buildWatchdog.ready(date.ticksElapsed, Date.now());
        buildFacility(toCourt(plans[0]));
    }

    /**
     * Food courts (#83): a food or drink stall whose gap has a court (2+ food/drink
     * stalls together) within reach is built in the court rather than at the gap. The
     * gap chosen is unchanged; only where the stall goes moves. See DEFAULT_COURT_OPTIONS
     * for why the gap still resolves.
     */
    const COURT_PICK = {
        coverRadius: DEFAULT_CHEAP_BUILD_OPTIONS.coverRadius,
        minBackSteps: DEFAULT_CHEAP_BUILD_OPTIONS.minBackSteps,
        clusterMinGuests: DEFAULT_CHEAP_BUILD_OPTIONS.clusterMinGuests,
        maxPerKind: DEFAULT_CHEAP_BUILD_OPTIONS.maxPerKind,
        minRides: DEFAULT_CHEAP_BUILD_OPTIONS.minRides,
        siteRadius: DEFAULT_COURT_OPTIONS.siteRadius,
    };

    function toCourt(plan: FacilityPlan): FacilityPlan {
        if (plan.kind !== "hunger" && plan.kind !== "thirst") return plan;
        const stallTiles: Array<{ x: number; y: number }> = [];
        const facilities = collectFacilities();
        for (let i = 0; i < facilities.length; i++) {
            const k = facilities[i].kind;
            if (k === "hunger" || k === "thirst") stallTiles.push({ x: facilities[i].x, y: facilities[i].y });
        }
        const court = courtForGap(plan.gap, findCourts(stallTiles, DEFAULT_COURT_OPTIONS), DEFAULT_COURT_OPTIONS);
        if (court === null) return plan;
        const radius = DEFAULT_COURT_OPTIONS.siteRadius;
        const site = pickSite(court, stalls.collectSites([court], radius), COURT_PICK);
        if (site === null) {
            dbg.count("facilityCourtNoSite");
            return plan;
        }
        dbg.count("facilityCourt");
        return {
            kind: plan.kind, gap: plan.gap, site: site,
            reason: plan.reason + ", built in the food court at (" + court.x + ", " + court.y + ")",
        };
    }

    return {
        isAutoFacilities,
        stalls,
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
