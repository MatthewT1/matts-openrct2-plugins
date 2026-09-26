/**
 * Facility placement planning — OpenRCT2 plugin
 *
 * WHY THIS MODULE EXISTS:
 *   `needs.ts` answers "where do guests have an unmet need, and how far is the nearest
 *   facility that would fix it?". This module answers the next question: "should we
 *   build one, and where?". It is Phase 3 of the NEEDS work in docs/roadmap.md, and it
 *   is deliberately a separate, pure module so the *decision* can be unit-tested
 *   without a running game — building a ride is the most destructive-capable action
 *   this project takes, so the logic that authorises it is the last place to accept
 *   "looks right to me" as verification.
 *
 * THE EVIDENCE THAT UNBLOCKED IT:
 *   Phase 1 shipped instrumentation only, with an explicit exit criterion: build
 *   nothing unless the log shows persistent clusters at a distance large enough to
 *   explain them. For a long time the numbers came back flat and this stayed unbuilt.
 *   They are no longer flat. Measured 2026-09-20 over 121 sampling sweeps as the park
 *   grew 573 -> 927 guests:
 *
 *     hunger@(60,92)   77 sweeps   23 tiles to nearest food    peak 21 guests
 *     hunger@(4,4)     63 sweeps   78 tiles to nearest food    peak 20 guests
 *     thirst@(68,68)   69 sweeps    7 tiles to nearest drink   peak  8 guests
 *     toilet@(68,68)   57 sweeps    7 tiles to nearest toilet  peak 16 guests
 *
 *   Park-wide at the end of the run: 90 hungry, 59 thirsty, 76 needing a toilet (55 of
 *   them urgently) out of 933 sampled, served by 3 food, 3 drink and 3 toilet
 *   facilities. `toilet` was the single largest guest complaint category.
 *
 * WHY HYSTERESIS IS NOT OPTIONAL HERE:
 *   Guests move. A cluster is a snapshot of where people happened to be standing, and a
 *   crowd leaving a ride will light up a cell for one sweep and be gone the next. The
 *   amenity work already learned this the expensive way — a bench placed for a vomit
 *   cluster stopped being justified the instant that cluster moved, which was exactly
 *   when it had done its job. A bench is a trivial, reversible mistake. A stall is not:
 *   it costs real money, occupies a tile permanently, and this module will never
 *   demolish one. So a gap must prove itself across `confirmSweeps` separate sweeps
 *   before it can authorise construction, and a gap that stops appearing decays rather
 *   than resetting, so one missed sweep does not throw away a week of evidence.
 *
 * SAFETY RULES, ALL ENFORCED HERE AND UNIT-TESTED:
 *   1. NEVER emit a demolish/remove plan. This module has no such output type. The
 *      "only touch what we placed" rule that makes bench removal safe is NOT sufficient
 *      for a ride, because removing a ride refunds differently, can strand guests
 *      already walking to it, and is not something a player can undo with one click.
 *   2. A hard cap per need kind (`maxPerKind`), so a persistent cluster that a facility
 *      cannot actually fix (a dead-end path, a cluster of broke guests) cannot spiral
 *      into fifty toilets.
 *   3. A per-pass budget (`maxPlacements`), so a bad decision costs one building, not a
 *      park's worth, and shows up in telemetry before it repeats.
 *   4. `minDistance` — a cluster standing next to a facility that already exists is not
 *      a coverage gap. It usually means that facility is at capacity or the guests are
 *      queueing for it, and a second one 3 tiles away is not the fix.
 *   5. One plan per site and one plan per cluster per pass, so a single pass cannot
 *      stack two buildings on the same tile or serve the same cluster twice.
 *
 * PURITY CONTRACT:
 *   No game globals. Coordinates in and out are TILE coordinates, matching `needs.ts`.
 *   The caller owns everything that touches the map: finding candidate sites, issuing
 *   `ridecreate`/`trackplace`/`ridesetstatus`, and the cash floor.
 */

import { NeedKind, CLUSTER_MIN_GUESTS } from "./needs";

/**
 * One sweep's observation of an unmet-need cluster.
 *
 * `distance` is tiles to the nearest matching facility, or -1 when no facility of that
 * kind exists anywhere in the park — which is the worst case, not the best, and is
 * treated as infinitely far throughout this module.
 */
export interface GapObservation {
    kind: NeedKind;
    /** Tile coordinates of the cluster centre. */
    x: number;
    y: number;
    /** Guests in the cluster with this unmet need. */
    guests: number;
    /** Tiles to the nearest matching facility, or -1 if none exists. */
    distance: number;
}

/** A gap that has persisted long enough to authorise building something. */
export interface ConfirmedGap extends GapObservation {
    /** Consecutive-ish sweeps this gap has been observed; see `observe`. */
    sweeps: number;
}

/** A tile the caller has verified as buildable, in TILE coordinates. */
export interface FacilitySite {
    x: number;
    y: number;
    /** Base height of the adjacent footpath, passed straight back in the plan. */
    z: number;
    /** Direction the facility should face, 0-3 — toward the path it serves. */
    direction: number;
    /**
     * True when the tile's surface is perfectly flat.
     *
     * A PREFERENCE, not a requirement. Flat ground is the safest place to drop a stall,
     * but `TrackPlaceAction` has no general flat-ground rule — the only slope test in it
     * guards water rides (`TrackPlaceAction.cpp:348-355`). Treating slope as a hard
     * filter was measured to reject **6,013** candidate tiles against **zero** accepted
     * across a whole session, which is why the facility builder could not find anywhere
     * to build on a hilly park.
     *
     * So sloped tiles are now offered, flat ones are preferred at equal distance, and
     * the real verdict is left to the `queryAction` that precedes every placement.
     */
    flat: boolean;
}

/** An instruction to build one facility. The caller turns this into game actions. */
export interface FacilityPlan {
    kind: NeedKind;
    site: FacilitySite;
    /** The cluster this serves, for logging and for clearing the tracker afterwards. */
    gap: ConfirmedGap;
    /** Human-readable justification, for the console and the log. */
    reason: string;
}

export interface FacilityOptions {
    /** Clusters smaller than this are noise, not demand. */
    minGuests: number;
    /**
     * Tiles. A cluster closer than this to a matching facility is not a coverage gap.
     * A cluster with no facility at all (distance -1) always passes.
     */
    minDistance: number;
    /** Sweeps a gap must persist before it can authorise construction. */
    confirmSweeps: number;
    /** Hard cap on facilities of one kind in the park, counting player-built ones. */
    maxPerKind: number;
    /** Facilities that may be planned in a single pass. */
    maxPlacements: number;
    /**
     * Tiles. A site further than this from the cluster does not serve it.
     *
     * **Must stay below `minDistance`.** `minDistance` is how far the *existing* nearest
     * facility is before a gap counts as real, so a site further away than that would be
     * no improvement at all — the plugin would spend a stall's worth of money to move
     * the walk from 12 tiles to 13. Keeping `siteRadius < minDistance` makes every
     * placement a strict improvement by construction rather than by luck.
     */
    /**
     * Tiles. Two observations of the same need kind within this distance are the SAME
     * gap, not two competing ones.
     *
     * **Without this the tracker cannot accumulate anything.** It keyed gaps on exact
     * cell coordinates, but a cluster is a snapshot of where sampled guests happened to
     * be standing, and at the noise floor the particular 8-tile cell that reaches the
     * threshold varies from sweep to sweep. Measured over 105 post-fix records, gaps
     * appeared at (76,68), (76,84), (84,84), (92,68), (92,76), (100,68), (100,84) and
     * (108,60) — spread across the developed half of the park — and **every single one
     * peaked at exactly 1 sweep**. Each sweep minted a fresh key and decayed the
     * previous one to nothing, so `confirmSweeps` was unreachable no matter how real or
     * how persistent the underlying need was.
     *
     * The radius is deliberately tied to the same scale as `minDistance`: if one
     * facility would serve both observations, they are one gap. Merging preserves the
     * FIRST anchor rather than drifting toward each new sighting, so the build site
     * stays put instead of wandering across the park as the sample jitters.
     */
    mergeRadius: number;
    siteRadius: number;
}

export const DEFAULT_FACILITY_OPTIONS: FacilityOptions = {
    // Deliberately the SAME constant the clustering layer uses, not a second opinion.
    //
    // This was 5 while `needs.ts` passed clusters at 3, which left everything in the 3-4
    // band reported as a gap and permanently unactionable — a dead zone, and the park
    // sat squarely in it. Importing the shared floor makes the two impossible to drift
    // apart; the test suite asserts it.
    minGuests: CLUSTER_MIN_GUESTS,
    // The two hunger gaps that persisted were 23 and 78 tiles out; the thirst/toilet
    // ones at 7 tiles persisted too but are much weaker evidence of a *missing*
    // facility. 12 keeps the clear cases and drops the ambiguous ones.
    minDistance: 12,
    // Calibrated against the MEASURED sweep rate, not an assumed one.
    //
    // This was 8, on the assumption of roughly one sweep per in-game day. That
    // assumption was wrong: a sweep needs a full pass over every guest in the park, and
    // a whole play session on 2026-09-20 produced about FOUR complete sweeps. Combined
    // with a tracker that decays on every miss, the gate was unreachable and the
    // feature could not fire - `facilityPending` showed every gap stuck at one or two
    // sweeps. The sampling rate has since been roughly tripled; 5 is reachable against
    // that rate while still requiring sustained agreement.
    //
    // This is the same class of mistake as `URGENT_OLD_LITTER = 25` applied to ride
    // counts: a threshold chosen against an imagined range rather than a measured one.
    confirmSweeps: 5,
    maxPerKind: 8,
    maxPlacements: 1,
    // Same scale as minDistance: if one facility would serve both sightings, they are
    // one gap rather than two rivals splitting the evidence between them.
    mergeRadius: 12,
    // Raised from 6 after measurement.
    //
    // Measured 2026-09-20: three gaps stayed confirmed for the whole session — hunger at
    // (4,4) 78 tiles from food, hunger at (60,92) 23 tiles, toilet at (4,4) 73 tiles —
    // and `facilityNoSite` fired on 7 passes. The decision layer was working perfectly
    // and there was simply nowhere within 6 tiles that passed site validation.
    //
    // 10 stays under `minDistance` (12), so a placement is still guaranteed to be closer
    // than whatever the guests are currently walking to.
    siteRadius: 10,
};

/**
 * Sorts gaps worst-first.
 *
 * "No facility at all" (-1) outranks every finite distance, mirroring `findGaps` in
 * needs.ts — a park with no toilet at all is a worse problem than one with a distant
 * toilet, however distant. Below that, distance dominates and cluster size breaks ties,
 * because distance is evidence of a *coverage* gap while size is evidence of demand,
 * and this module exists to fix coverage.
 */
function worseFirst(a: GapObservation, b: GapObservation): number {
    if (a.distance === -1 && b.distance === -1) return b.guests - a.guests;
    if (a.distance === -1) return -1;
    if (b.distance === -1) return 1;
    if (b.distance !== a.distance) return b.distance - a.distance;
    return b.guests - a.guests;
}

/** True when this observation is strong enough to be worth tracking at all. */
function isActionable(g: GapObservation, options: FacilityOptions): boolean {
    if (g.guests < options.minGuests) return false;
    // -1 means no facility of this kind exists; that is maximally far, not zero.
    if (g.distance === -1) return true;
    return g.distance >= options.minDistance;
}

/** Manhattan distance in tiles. Matches the path-grid movement guests actually do. */
function manhattan(ax: number, ay: number, bx: number, by: number): number {
    const dx = ax > bx ? ax - bx : bx - ax;
    const dy = ay > by ? ay - by : by - ay;
    return dx + dy;
}

interface TrackedGap {
    kind: NeedKind;
    x: number;
    y: number;
    guests: number;
    distance: number;
    streak: number;
    /** True when this gap was seen in the sweep currently being processed. */
    seen: boolean;
}

export interface FacilityTracker {
    /**
     * Records one sweep's worth of gaps and returns those now confirmed.
     *
     * A gap present and actionable this sweep increments its streak; a tracked gap that
     * is absent decays by one instead of resetting, so a cluster that blinks out for a
     * single sweep — which happens constantly, because guests walk — does not throw away
     * the evidence gathered so far. A gap that decays to zero is forgotten entirely,
     * which is what keeps the tracker from growing without bound as crowds wander.
     */
    observe(gaps: GapObservation[]): ConfirmedGap[];
    /**
     * Forgets a gap, so it must prove itself again from scratch.
     *
     * Called after building something for it. The new facility needs time to actually
     * be walked to before its effect shows up in a sweep, and without this the same
     * cluster would stay confirmed and authorise a second building immediately.
     */
    clear(kind: NeedKind, x: number, y: number): void;
    /** Every gap currently being tracked, worst-first. For telemetry. */
    pending(): ConfirmedGap[];
    /** Drops all state. */
    reset(): void;
}

export function createFacilityTracker(options: FacilityOptions): FacilityTracker {
    let tracked: Record<string, TrackedGap> = {};

    function keyOf(kind: NeedKind, x: number, y: number): string {
        return kind + ":" + x + "," + y;
    }

    /**
     * The tracked gap this observation belongs to, or undefined for a genuinely new one.
     *
     * Nearest match wins, so an observation between two tracked gaps joins the closer.
     * The matched entry keeps its own anchor: the streak is evidence about a REGION, and
     * letting the anchor chase each sighting would walk the eventual build site around
     * the park while the count said it had been stable all along.
     */
    function nearbyEntry(g: GapObservation): TrackedGap | undefined {
        const keys = Object.keys(tracked);
        let best: TrackedGap | undefined = undefined;
        let bestDistance = 0;
        for (let i = 0; i < keys.length; i++) {
            const entry = tracked[keys[i]];
            if (entry.kind !== g.kind) continue;
            // A missing or nonsensical radius must mean "merge nothing", not "merge
            // everything" — `d > undefined` is false, which would silently fold every
            // gap of a kind into the first one ever seen.
            const radius = options.mergeRadius > 0 ? options.mergeRadius : 0;
            const d = manhattan(entry.x, entry.y, g.x, g.y);
            if (d > radius) continue;
            if (best === undefined || d < bestDistance) {
                best = entry;
                bestDistance = d;
            }
        }
        return best;
    }

    function observe(gaps: GapObservation[]): ConfirmedGap[] {
        const keys = Object.keys(tracked);
        for (let i = 0; i < keys.length; i++) tracked[keys[i]].seen = false;

        for (let i = 0; i < gaps.length; i++) {
            const g = gaps[i];
            if (!isActionable(g, options)) continue;

            // Match against an existing gap of the same kind nearby before creating a
            // new one. Exact-coordinate keying shredded the signal — see `mergeRadius`.
            let entry = nearbyEntry(g);
            if (entry === undefined) {
                entry = { kind: g.kind, x: g.x, y: g.y, guests: g.guests, distance: g.distance, streak: 0, seen: false };
                tracked[keyOf(g.kind, g.x, g.y)] = entry;
            }
            // #80: at most ONE streak point per sweep. Several clusters inside the merge
            // radius used to add one each, so a gap reached `confirmSweeps` in two or
            // three sweeps (measured: streak 9 -> 24 over three daily sweeps).
            if (entry.seen) {
                // Second sighting this sweep: keep the stronger of the two readings.
                if (g.guests > entry.guests) {
                    entry.guests = g.guests;
                    entry.distance = g.distance;
                }
                continue;
            }
            // Always carry the freshest measurements forward; the streak is the memory,
            // the numbers should describe the park as it is now.
            entry.guests = g.guests;
            entry.distance = g.distance;
            entry.streak++;
            entry.seen = true;
        }

        const confirmed: ConfirmedGap[] = [];
        const all = Object.keys(tracked);
        for (let i = 0; i < all.length; i++) {
            const entry = tracked[all[i]];
            if (!entry.seen) {
                entry.streak--;
                if (entry.streak <= 0) {
                    delete tracked[all[i]];
                    continue;
                }
            }
            if (entry.streak >= options.confirmSweeps) {
                confirmed.push({
                    kind: entry.kind, x: entry.x, y: entry.y,
                    guests: entry.guests, distance: entry.distance, sweeps: entry.streak,
                });
            }
        }

        confirmed.sort(worseFirst);
        return confirmed;
    }

    function clear(kind: NeedKind, x: number, y: number): void {
        delete tracked[keyOf(kind, x, y)];
        // Also drop anything of the same kind close enough to be the same gap, or the
        // newly-built facility would face a near-duplicate that kept its streak and
        // authorised a second building beside the first.
        const keys = Object.keys(tracked);
        for (let i = 0; i < keys.length; i++) {
            const entry = tracked[keys[i]];
            if (entry.kind !== kind) continue;
            const radius = options.mergeRadius > 0 ? options.mergeRadius : 0;
            if (manhattan(entry.x, entry.y, x, y) <= radius) delete tracked[keys[i]];
        }
    }

    function pending(): ConfirmedGap[] {
        const all = Object.keys(tracked);
        const out: ConfirmedGap[] = [];
        for (let i = 0; i < all.length; i++) {
            const e = tracked[all[i]];
            out.push({ kind: e.kind, x: e.x, y: e.y, guests: e.guests, distance: e.distance, sweeps: e.streak });
        }
        out.sort(worseFirst);
        return out;
    }

    function reset(): void {
        tracked = {};
    }

    return { observe, clear, pending, reset };
}

/** What a need kind's facility is called, for the console line. */
function facilityLabel(kind: NeedKind): string {
    if (kind === "hunger") return "food stall";
    if (kind === "thirst") return "drink stall";
    if (kind === "toilet") return "toilet";
    return "first aid room";
}

/**
 * Chooses what to build and where.
 *
 * `existingCounts` must count EVERY facility of that kind in the park, including ones
 * the player built — the cap is about how many the park should have, not how many this
 * plugin is responsible for.
 *
 * Sites are consumed as they are assigned, and each cluster yields at most one plan, so
 * a single pass can never stack two buildings on one tile or over-serve one cluster.
 * Returns an empty array when nothing qualifies, which is the expected outcome on a
 * well-served park and is not an error.
 */
export function planFacilities(
    confirmed: ConfirmedGap[],
    sites: FacilitySite[],
    existingCounts: Record<string, number>,
    options: FacilityOptions,
): FacilityPlan[] {
    const plans: FacilityPlan[] = [];
    if (options.maxPlacements <= 0) return plans;

    // Local copy so the caller's counts are not mutated, and so two plans in the same
    // pass correctly count against each other's cap.
    const counts: Record<string, number> = {};
    const countKeys = Object.keys(existingCounts);
    for (let i = 0; i < countKeys.length; i++) counts[countKeys[i]] = existingCounts[countKeys[i]];

    const used: Record<string, true> = {};
    const ordered = confirmed.slice().sort(worseFirst);

    for (let i = 0; i < ordered.length && plans.length < options.maxPlacements; i++) {
        const gap = ordered[i];

        const have = counts[gap.kind] !== undefined ? counts[gap.kind] : 0;
        if (have >= options.maxPerKind) continue;

        // Nearest unused site within reach of the cluster. Nearest matters: the whole
        // problem being solved is walking distance.
        let best: FacilitySite | null = null;
        let bestDistance = 0;
        for (let s = 0; s < sites.length; s++) {
            const site = sites[s];
            const siteKey = site.x + "," + site.y;
            if (used[siteKey]) continue;
            const d = manhattan(gap.x, gap.y, site.x, site.y);
            if (d > options.siteRadius) continue;
            // Nearest wins, because walking distance is the problem being solved. Flat
            // ground only breaks a tie — a flat tile further away serves the cluster
            // worse than a sloped one next door.
            if (best === null || d < bestDistance || (d === bestDistance && site.flat && !best.flat)) {
                best = site;
                bestDistance = d;
            }
        }
        if (best === null) continue;

        used[best.x + "," + best.y] = true;
        counts[gap.kind] = have + 1;

        const where = gap.distance === -1
            ? "no " + facilityLabel(gap.kind) + " exists in the park"
            : "nearest is " + gap.distance + " tiles away";
        plans.push({
            kind: gap.kind,
            site: best,
            gap: gap,
            reason: gap.guests + " guests at (" + gap.x + ", " + gap.y + ") for " +
                gap.sweeps + " sweeps, " + where,
        });
    }

    return plans;
}

/** One-line summary of a plan, for the in-game console. */
export function describePlan(plan: FacilityPlan): string {
    return "Building a " + facilityLabel(plan.kind) + " at (" + plan.site.x + ", " +
        plan.site.y + "): " + plan.reason + ".";
}

/**
 * Which stall variant to build next: the one with the fewest already in the park,
 * ties going to the earliest candidate (research order).
 *
 * `candidates` are the unlocked object indices for one ride type, in order;
 * `builtCounts` maps an object index to how many of it the park has now. Unbuilt
 * variants count as 0, so they still win first. Once every variant exists, new stalls
 * keep cycling instead of repeating the first one (#102). Returns -1 for no candidates.
 */
export function pickFacilityVariant(candidates: number[], builtCounts: Record<number, number>): number {
    let best = -1;
    let bestCount = 0;
    for (let i = 0; i < candidates.length; i++) {
        const count = builtCounts[candidates[i]] || 0;
        if (best < 0 || count < bestCount) {
            best = candidates[i];
            bestCount = count;
        }
    }
    return best;
}

// ---------------------------------------------------------------------------
// Food courts (#83)
// ---------------------------------------------------------------------------

/** A group of food/drink stalls close together, at their mean position. */
export interface Court {
    x: number;
    y: number;
    stalls: number;
}

export interface CourtOptions {
    /** Stalls needed before a group counts as a court. */
    minStalls: number;
    /** Stalls within this many tiles (Manhattan) of the group's seed join it. */
    clusterRadius: number;
    /** A court whose centre is this close to a food/drink gap serves it instead. */
    reach: number;
    /** How far from the court centre the new stall may go. */
    siteRadius: number;
}

/**
 * `reach + siteRadius` stays under `minDistance` (12): the new stall then lands within
 * 11 tiles of the gap, closer than the "nearest is 12+ tiles away" that made it a gap,
 * so the gap resolves instead of building at the court again and again.
 */
export const DEFAULT_COURT_OPTIONS: CourtOptions = {
    minStalls: 2,
    clusterRadius: 6,
    reach: 8,
    siteRadius: 3,
};

/**
 * Groups stalls into courts. Greedy: the stall with the most neighbours seeds a court
 * of itself and its neighbours, those are removed, and the rest are grouped again.
 * Deterministic for a given list (ties go to the earlier stall).
 */
export function findCourts(stalls: Array<{ x: number; y: number }>, options: CourtOptions): Court[] {
    const left = stalls.slice();
    const courts: Court[] = [];
    while (left.length >= options.minStalls) {
        let seed = -1;
        let seedN = 0;
        for (let i = 0; i < left.length; i++) {
            let n = 0;
            for (let j = 0; j < left.length; j++) {
                if (manhattan(left[i].x, left[i].y, left[j].x, left[j].y) <= options.clusterRadius) n++;
            }
            if (n > seedN) { seed = i; seedN = n; }
        }
        if (seedN < options.minStalls) break;
        const s = left[seed];
        let sx = 0, sy = 0;
        const rest: Array<{ x: number; y: number }> = [];
        for (let j = 0; j < left.length; j++) {
            if (manhattan(s.x, s.y, left[j].x, left[j].y) <= options.clusterRadius) {
                sx += left[j].x;
                sy += left[j].y;
            } else {
                rest.push(left[j]);
            }
        }
        courts.push({ x: Math.round(sx / seedN), y: Math.round(sy / seedN), stalls: seedN });
        left.length = 0;
        for (let j = 0; j < rest.length; j++) left.push(rest[j]);
    }
    return courts;
}

/** The nearest court within `reach` of a food or drink gap, or null (toilets, first aid never). */
export function courtForGap(gap: { kind: NeedKind; x: number; y: number }, courts: Court[],
                            options: CourtOptions): Court | null {
    if (gap.kind !== "hunger" && gap.kind !== "thirst") return null;
    let best: Court | null = null;
    let bestD = 0;
    for (let i = 0; i < courts.length; i++) {
        const d = manhattan(gap.x, gap.y, courts[i].x, courts[i].y);
        if (d > options.reach) continue;
        if (best === null || d < bestD) { best = courts[i]; bestD = d; }
    }
    return best;
}
