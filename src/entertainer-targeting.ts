/**
 * Entertainer targeting — which rides deserve an entertainer, and where to park one.
 *
 * ## Why this module exists (P2, revised verdict)
 *
 * The mechanic behind an entertainer is `Staff::entertainerUpdateNearbyPeeps()`
 * (`gamesrc/OpenRCT2/src/openrct2/entity/Staff.cpp:889-933`): guests within a 3-tile
 * (96-unit) radius who are `queuing` get `happinessTarget += 3` AND `timeInQueue -= 200`,
 * gated by a ~25% chance per pathfinding tick (`Staff.cpp:941`, `ScenarioRand() & 0xFFFF
 * <= 0x4000`).
 *
 * The first pass at this judgement compared `-200` against the wrong budget (a
 * misremembered 15-minute/36000-tick walk-out) and called the effect negligible. The
 * real give-up check is `Guest.cpp:5729-5739`:
 *
 *     if (timeInQueue < 4300) return;
 *     if (happiness <= 65 && (0xFFFF & ScenarioRand()) < 2184) // give up
 *
 * `timeInQueue` increments by 1 per call (`Guest.cpp:7439`), so the real budget is
 * **4300 ticks**, not 36000. One entertainer hit removes ~4.7% of it in a single event,
 * and — because giving up requires BOTH `timeInQueue >= 4300` AND `happiness <= 65` —
 * the `+3` happiness bump is not incidental, it is the other half of the gate the
 * entertainer is attacking. `queuingAges` (`Guest.cpp:5684`, fires at `timeInQueue >=
 * 3500`) peaked at 67 guests against `crowded` at 96 in `tools/rct-debug.log`, so guests
 * on this park are demonstrably reaching the neighbourhood of 4300, not just a
 * hypothetical ceiling.
 *
 * ## What this module does NOT try to do
 *
 * The entertainer's own pathfinding is undirected wandering — nothing in the engine
 * steers it toward a queue. The only lever available from outside is
 * `staffsetpatrolarea` (a rectangular `MapRange`, same action `mechanic-manager.ts`
 * already uses to *clear* zones). This module decides, in pure logic, which rides are
 * worth restricting an entertainer to and where that rectangle should sit — a small box
 * anchored on the ride's station front, where the longest-waiting guests are. It does
 * NOT know anything about actual tile-by-tile queue paths; the box is a fixed radius
 * around the station entrance, not a traced queue line. A queue that snakes away from
 * its station will only be partially covered. That is an accepted, documented
 * limitation, not a bug — tracing queue path geometry is out of scope for this module
 * and not required for the mechanic to help the guests nearest the front, which are the
 * ones closest to the 4300-tick threshold.
 *
 * ## Calibration
 *
 * `QUEUE_FLOOR_MINUTES` / `QUEUE_URGENT_MINUTES` deliberately reuse the values this
 * project has already validated against telemetry elsewhere (`FLOOR_MINUTES = 3` in
 * `queues.ts`, `QUEUE_WARN_MINUTES = 5` in `wait-time-optimizer.ts`) rather than
 * inventing new numbers. `RideStation.queueTime` (the plugin-visible posted wait
 * estimate, minutes) is a different quantity from an individual guest's `timeInQueue`
 * tick counter — there is no plugin API that exposes the latter — but a station posting
 * 3-5+ minutes is the same evidence this project already used to justify W2's
 * early-override logic: guests are accumulating in that queue faster than it drains,
 * which is exactly the condition under which some of them will cross 4300 ticks.
 *
 * PURITY CONTRACT: no game globals. Ride queue data and station coordinates are passed
 * in; this module returns which rides to target and what rectangle to request.
 */

// Type-only import: erased at compile time, so this stays resolvable by plain node in
// the test harness (which runs each compiled module standalone, without a bundler).
// The numeric thresholds below are therefore inlined rather than imported as values —
// see the comments on each field for which staffing.ts constant they mirror.
import type { StaffingThresholds } from "./staffing";

/** Queues below this are not worth restricting an entertainer to. */
export const QUEUE_FLOOR_MINUTES = 3;

/** Queues at or above this are the same "in real trouble" bar the rest of the project uses. */
export const QUEUE_URGENT_MINUTES = 5;

/** Never station more than this many entertainers via patrol zones — bounds the wage bill. */
export const MAX_TARGETED_ENTERTAINERS = 4;

/**
 * Half-width of the patrol rectangle around a station, in tiles. 4 tiles (128 units) on
 * each side keeps the entertainer within the 3-tile (96-unit) interaction radius of
 * guests queuing at the station front for most of the box, while still being small
 * enough that `docs/performance.md`'s area-scaling cost of `staffsetpatrolarea` stays
 * negligible (that cost was measured on park-sized rectangles).
 */
export const PATROL_RADIUS_TILES = 4;

/** Game distance units per tile (`kCoordsXYStep`), matching the engine's own MapRange units. */
export const TILE_SIZE = 32;

export interface RideQueueSignal {
    rideId: number;
    name: string;
    /** Worst posted queue time across the ride's stations, in minutes. */
    queueMinutes: number;
    /** Coordinates of the station to patrol around (game units, already tile-aligned). */
    stationX: number;
    stationY: number;
}

export interface PatrolRect {
    x1: number;
    y1: number;
    x2: number;
    y2: number;
}

export interface EntertainerTarget {
    rideId: number;
    name: string;
    queueMinutes: number;
    patrol: PatrolRect;
}

/**
 * Picks up to `maxEntertainers` rides worth patrolling, worst queue first, and returns
 * the patrol rectangle for each. Rides below `QUEUE_FLOOR_MINUTES` are never selected,
 * however many entertainers are available — a short queue gains nothing from one.
 */
export function selectEntertainerTargets(
    rides: RideQueueSignal[],
    maxEntertainers: number,
): EntertainerTarget[] {
    const eligible = rides.filter((r) => r.queueMinutes >= QUEUE_FLOOR_MINUTES);
    eligible.sort((a, b) => b.queueMinutes - a.queueMinutes);

    const cap = Math.max(0, Math.min(maxEntertainers, MAX_TARGETED_ENTERTAINERS));
    const chosen = eligible.slice(0, cap);

    const radius = PATROL_RADIUS_TILES * TILE_SIZE;
    return chosen.map((r) => ({
        rideId: r.rideId,
        name: r.name,
        queueMinutes: r.queueMinutes,
        patrol: {
            x1: r.stationX - radius,
            y1: r.stationY - radius,
            x2: r.stationX + radius,
            y2: r.stationY + radius,
        },
    }));
}

/** How many rides currently qualify at each severity, and the worst queue seen. */
export interface QueueCensus {
    urgentCount: number;
    eligibleCount: number;
    worstMinutes: number;
}

export function censusQueues(rides: RideQueueSignal[]): QueueCensus {
    let urgentCount = 0;
    let eligibleCount = 0;
    let worstMinutes = 0;
    for (let i = 0; i < rides.length; i++) {
        const q = rides[i].queueMinutes;
        if (q >= QUEUE_URGENT_MINUTES) urgentCount++;
        if (q >= QUEUE_FLOOR_MINUTES) eligibleCount++;
        if (q > worstMinutes) worstMinutes = q;
    }
    return { urgentCount, eligibleCount, worstMinutes };
}

/**
 * Thresholds for reusing `createStaffingController` on the entertainer signal.
 *
 * Modelled on `MECHANIC_THRESHOLDS` in `staffing.ts`, NOT the litter defaults — see that
 * file's header for why reusing a differently-calibrated controller silently breaks it.
 *
 * `urgentAt: 1`: any single ride posting a 5+ minute queue is the emergency, the same
 * "one bad case is the whole signal" reasoning `MECHANIC_THRESHOLDS` uses for a ride
 * broken 2+ days — queue posted-time is visible same-day, there is no equivalent of the
 * 14.5-day old-litter lag to wait out.
 *
 * `settleDays` / `urgentSettleDays` are short (3) for the same reason: the queue signal
 * reacts immediately to a hire, unlike litter which needs ~14.5 days to show up as
 * `oldLitter`.
 *
 * `urgentHirePaceDays: 2` avoids the mechanic controller's early bug (stacking urgent
 * hires every single observation) by waiting to see whether the last hire helped before
 * adding another.
 *
 * `floorDecayDays: 0`: no equivalent of the mechanic pathfinding-trap failure has been
 * measured for entertainers, so there is nothing yet to justify probing back down.
 */
export const ENTERTAINER_THRESHOLDS: StaffingThresholds = {
    urgentAt: 1,
    releaseMaxUrgent: 0,
    // Mirrors staffing.ts's RATING_CONCERN (900) exactly: "rating is genuinely falling"
    // means the same thing whatever staff type is being reasoned about.
    ratingConcern: 900,
    // Mirrors staffing.ts's RELEASE_DAYS (4).
    releaseDays: 4,
    settleDays: 3,
    urgentSettleDays: 3,
    // Mirrors staffing.ts's REGRESSION_FACTOR (2.0): a release counts as a regression
    // once the fast signal doubles versus its pre-release reference.
    regressionFactor: 2.0,
    urgentHirePaceDays: 2,
    floorDecayDays: 0,
};

/**
 * Translates the raw queue census into the staffing controller's litter vocabulary.
 *
 *   - oldLitter   -> rides posting QUEUE_URGENT_MINUTES+ right now (the real emergency).
 *   - totalLitter -> rides posting QUEUE_FLOOR_MINUTES+ (the noisier leading signal).
 *   - fleetUnderworked -> true when no ride qualifies at all, i.e. entertainers have
 *     nothing worth patrolling.
 *   - formulaTarget -> capped at MAX_TARGETED_ENTERTAINERS so the controller can never
 *     ask for more than the wage budget this module was designed around.
 */
export function entertainerStaffingSignals(
    census: QueueCensus,
    parkRating: number,
): {
    oldLitter: number; totalLitter: number; parkRating: number;
    fleetUnderworked: boolean; formulaTarget: number; floor: number;
} {
    return {
        oldLitter: census.urgentCount,
        totalLitter: census.eligibleCount,
        parkRating: parkRating,
        fleetUnderworked: census.eligibleCount === 0,
        formulaTarget: Math.min(census.eligibleCount, MAX_TARGETED_ENTERTAINERS),
        floor: 0,
    };
}

/**
 * Costume indexes to try for an entertainer hire, best first (#50).
 *
 * The game accepts only peep-animation objects of the entertainer type
 * (StaffHireNewAction.cpp:85-93) and writes an ERROR line for every refused index, even
 * from a `queryAction`. Walking 0, 1, 2, ... hit guest/handyman/mechanic/security first
 * (the default objects, DefaultObjects.cpp:114-117): 4 errors per park in the #49 matrix.
 * Objects named `*entertainer*` (every RCT2 costume, Legacy.cpp:2282-2292) go first;
 * the rest follow in index order, minus the four known non-entertainers, so a custom
 * costume with an unusual name is still found.
 */
export function costumeCandidates(
    objects: { index: number; identifier: string }[],
    maxIndex: number,
): number[] {
    const NOT_ENTERTAINER = ["guest", "handyman", "mechanic", "security"];
    const named: number[] = [];
    const skip: Record<number, true> = {};
    for (let i = 0; i < objects.length; i++) {
        const id = objects[i].identifier.toLowerCase();
        const idx = objects[i].index;
        if (idx < 0 || idx > maxIndex) continue;
        if (id.indexOf("entertainer") >= 0) { named.push(idx); skip[idx] = true; continue; }
        const tail = id.substring(id.lastIndexOf(".") + 1);
        if (NOT_ENTERTAINER.indexOf(tail) >= 0) skip[idx] = true;
    }
    named.sort((a, b) => a - b);
    const out = named.slice();
    for (let i = 0; i <= maxIndex; i++) if (!skip[i]) out.push(i);
    return out;
}
