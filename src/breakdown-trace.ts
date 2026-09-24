/**
 * Breakdown repair trace: where the time goes between a ride breaking and being fixed.
 *
 * The baseline run (notes/baseline.md) had one breakdown that took ~4 in-game days to
 * repair. The daily log can't say why, because the plugin API exposes neither
 * `ride.mechanicStatus` nor `ride.mechanic` (the game's dispatch state, Ride.cpp:1387).
 * Three explanations fit the daily numbers:
 *
 *   1. dispatch: no mechanic was free to call. `FindClosestMechanic` (Ride.cpp:1520)
 *      only picks mechanics that are patrolling, or heading to an inspection that
 *      hasn't reached the ride yet (subState < 4);
 *   2. walking: a mechanic was sent but had a long way to go, or got lost;
 *   3. fixing: the mechanic arrived and the repair itself took a long time.
 *
 * What the API does expose is enough to tell these apart: every mechanic's position and
 * animation (`staffAnswerCall*` when a call is taken, `staffFix*` while repairing), and
 * each mechanic's `ridesFixed` counter, which names who did the repair.
 *
 * This module only observes. It changes nothing in the game and runs only while
 * Diagnostics is on and a ride is broken. Pure: the plugin passes in plain snapshots, so
 * it runs under node in tests.
 */

/** World units per map tile. */
const TILE = 32;

/** Stop tracing a ride after this many ticks (~20 in-game days) and report it unfinished. */
export const MAX_TRACE_TICKS = 11_000;
/** Cap on stored samples per trace, so a long breakdown cannot grow memory without bound. */
export const MAX_SAMPLES = 200;

export interface RideSnapshot {
    id: number;
    name: string;
    /** `ride.breakdown`: "none" unless the ride's brokenDown flag is set. */
    breakdown: string;
    /** First station's exit in world coords, or null if the ride has none. */
    exit: { x: number; y: number } | null;
}

export interface MechanicSnapshot {
    id: number;
    x: number;
    y: number;
    animation: string;
    ridesFixed: number;
    ridesInspected: number;
}

/** One sample while the ride is broken. Distances are Manhattan, in tiles, to the exit. */
export interface TraceSample {
    /** Ticks since the breakdown event. */
    t: number;
    /** 1 once the ride's brokenDown flag is set (a breakdown starts as "pending"). */
    broken: 0 | 1;
    nearest: number;
    nearestId: number;
    /** Mechanics within 2 tiles of the exit. */
    atRide: number;
    fixing: number;
    answering: number;
}

export interface BreakdownTrace {
    rideId: number;
    ride: string;
    reason: string;
    /**
     * "fixed"; "fixedWhilePending" (a mechanic already inspecting the ride fixed it before
     * it was ever marked broken); "unfinished" (gave up at MAX_TRACE_TICKS); or "gone"
     * (ride closed/removed).
     */
    outcome: string;
    /** Ticks from the breakdown event to the brokenDown flag, or -1 if never seen. */
    ticksToBroken: number;
    /** Ticks from the breakdown event to the last sample that saw it broken or pending. */
    ticksToFixed: number;
    /** First tick a mechanic stood within 2 tiles of the exit, or -1. */
    ticksToArrive: number;
    /** First tick a mechanic near the exit showed a fix animation, or -1. */
    ticksToFixAnim: number;
    mechanics: number;
    /** Nearest mechanic at the first sample, in tiles. */
    startNearest: number;
    /** Mechanic whose ridesFixed went up, with their distance at the first sample; -1 if none. */
    fixedBy: number;
    fixerStartDistance: number;
    /** Inspections completed fleet-wide during the breakdown (were they busy elsewhere?). */
    inspectionsDuring: number;
    /**
     * Tiles the fixer actually walked between the ride being marked broken and first
     * standing within 2 tiles of the exit, summed sample to sample; -1 if unknown.
     * Against `fixerStartDistance` this says whether the route was long (a detour, or a
     * path that doesn't run straight to the exit).
     */
    fixerWalkTiles: number;
    /** Ticks from the broken flag to the fixer's arrival; -1 if unknown. */
    fixerWalkTicks: number;
    /**
     * fixerWalkTicks / fixerWalkTiles. Staff walk ~43 ticks per flat tile and about twice
     * that on slopes (energy 96, 2 units a step: Peep.cpp:432, :938), so a figure well
     * above 43 means slopes or waiting, not a long route. -1 if unknown.
     */
    fixerTicksPerTile: number;
    samples: TraceSample[];
}

interface Active {
    rideId: number;
    reason: string;
    startTick: number;
    name: string;
    brokenAt: number;
    lastSeenBroken: number;
    arriveAt: number;
    fixAnimAt: number;
    mechanics: number;
    startNearest: number;
    startDistances: Record<number, number>;
    startFixed: Record<number, number>;
    startInspected: number;
    /** Per mechanic: tiles walked since the broken flag, until they first reach the ride. */
    walked: Record<number, number>;
    last: Record<number, { x: number; y: number }>;
    /** Per mechanic: first tick within 2 tiles of the exit after the broken flag. */
    arrivedAt: Record<number, number>;
    samples: TraceSample[];
}

function tilesTo(m: MechanicSnapshot, exit: { x: number; y: number }): number {
    return Math.round((Math.abs(m.x - exit.x) + Math.abs(m.y - exit.y)) / TILE);
}

/** A mechanic at the ride whose ridesFixed rose since the trace started, or -1. */
function pendingFixer(a: Active, exit: { x: number; y: number }, mechanics: MechanicSnapshot[]): number {
    for (let i = 0; i < mechanics.length; i++) {
        const m = mechanics[i];
        const before = a.startFixed[m.id];
        if (before !== undefined && m.ridesFixed > before && tilesTo(m, exit) <= 2) return m.id;
    }
    return -1;
}

function isFixAnim(a: string): boolean {
    return a === "staffFix" || a === "staffFix2" || a === "staffFix3" || a === "staffFixGround";
}

function isAnswerAnim(a: string): boolean {
    return a === "staffAnswerCall" || a === "staffAnswerCall2";
}

export interface BreakdownTracer {
    /** Called from the `ride.breakdown` hook. A second event for the same ride is ignored. */
    start(rideId: number, reason: string, tick: number): void;
    /** True while any ride is being traced, so the plugin can skip sampling otherwise. */
    active(): boolean;
    /**
     * Records one sample for every traced ride. Returns traces that finished on this
     * sample: the ride is no longer broken, it was removed, or the trace timed out.
     */
    sample(tick: number, rides: RideSnapshot[], mechanics: MechanicSnapshot[]): BreakdownTrace[];
}

export function createBreakdownTracer(): BreakdownTracer {
    const traces: Record<number, Active> = {};
    let count = 0;

    function finish(a: Active, outcome: string, mechanics: MechanicSnapshot[], fixer = -1): BreakdownTrace {
        let fixedBy = fixer;
        let inspected = 0;
        for (let i = 0; i < mechanics.length; i++) {
            const m = mechanics[i];
            inspected += m.ridesInspected;
            const before = a.startFixed[m.id];
            if (before !== undefined && m.ridesFixed > before && fixedBy === -1) fixedBy = m.id;
        }
        delete traces[a.rideId];
        count--;
        const walked = fixedBy !== -1 && a.walked[fixedBy] !== undefined ? a.walked[fixedBy] : -1;
        const walkTicks = fixedBy !== -1 && a.arrivedAt[fixedBy] !== undefined && a.brokenAt !== -1
            ? a.arrivedAt[fixedBy] - a.brokenAt : -1;
        return {
            rideId: a.rideId,
            ride: a.name,
            reason: a.reason,
            outcome: outcome,
            ticksToBroken: a.brokenAt,
            ticksToFixed: a.lastSeenBroken,
            ticksToArrive: a.arriveAt,
            ticksToFixAnim: a.fixAnimAt,
            mechanics: a.mechanics,
            startNearest: a.startNearest,
            fixedBy: fixedBy,
            fixerStartDistance: fixedBy !== -1 && a.startDistances[fixedBy] !== undefined
                ? a.startDistances[fixedBy] : -1,
            // Mechanics hired mid-breakdown start from 0, so they count in full; ones
            // fired mid-breakdown drop out. Good enough for "were they busy".
            inspectionsDuring: Math.max(0, inspected - a.startInspected),
            fixerWalkTiles: walkTicks >= 0 ? Math.round(walked * 10) / 10 : -1,
            fixerWalkTicks: walkTicks,
            fixerTicksPerTile: walkTicks > 0 && walked > 0 ? Math.round(walkTicks / walked) : -1,
            samples: a.samples,
        };
    }

    return {
        start(rideId: number, reason: string, tick: number): void {
            if (traces[rideId] !== undefined) return;
            traces[rideId] = {
                rideId, reason, startTick: tick, name: "",
                brokenAt: -1, lastSeenBroken: 0, arriveAt: -1, fixAnimAt: -1,
                mechanics: -1, startNearest: -1,
                startDistances: {}, startFixed: {}, startInspected: 0,
                walked: {}, last: {}, arrivedAt: {}, samples: [],
            };
            count++;
        },

        active(): boolean {
            return count > 0;
        },

        sample(tick: number, rides: RideSnapshot[], mechanics: MechanicSnapshot[]): BreakdownTrace[] {
            const done: BreakdownTrace[] = [];
            if (count === 0) return done;
            const byId: Record<number, RideSnapshot> = {};
            for (let i = 0; i < rides.length; i++) byId[rides[i].id] = rides[i];

            for (const key in traces) {
                const a = traces[key];
                const r = byId[a.rideId];
                const t = tick - a.startTick;
                if (r === undefined || r.exit === null) { done.push(finish(a, "gone", mechanics)); continue; }
                a.name = r.name;

                const first = a.mechanics === -1;
                if (first) {
                    a.mechanics = mechanics.length;
                    for (let i = 0; i < mechanics.length; i++) {
                        const m = mechanics[i];
                        a.startDistances[m.id] = tilesTo(m, r.exit);
                        a.startFixed[m.id] = m.ridesFixed;
                        a.startInspected += m.ridesInspected;
                    }
                }

                const broken = r.breakdown !== "none";
                if (broken && a.brokenAt === -1) a.brokenAt = t;
                // The event fires while the breakdown is still pending, before the
                // brokenDown flag is set; don't call it fixed until it has been seen broken.
                if (!broken && a.brokenAt !== -1) { done.push(finish(a, "fixed", mechanics)); continue; }
                // A mechanic who is already inspecting the ride fixes a pending breakdown
                // on the spot (Staff.cpp:2016-2020), so the brokenDown flag, the only one
                // `ride.breakdown` reports (ScRide.cpp:809), is never set. Without this
                // the trace would wait out MAX_TRACE_TICKS and blame whichever mechanic's
                // counter rose elsewhere in the meantime.
                if (!broken && !first) {
                    const fixer = pendingFixer(a, r.exit, mechanics);
                    if (fixer !== -1) { done.push(finish(a, "fixedWhilePending", mechanics, fixer)); continue; }
                }
                if (t > MAX_TRACE_TICKS) { done.push(finish(a, "unfinished", mechanics)); continue; }
                a.lastSeenBroken = t;

                let nearest = -1, nearestId = -1, atRide = 0, fixing = 0, answering = 0;
                for (let i = 0; i < mechanics.length; i++) {
                    const m = mechanics[i];
                    const d = tilesTo(m, r.exit);
                    if (nearest === -1 || d < nearest) { nearest = d; nearestId = m.id; }
                    if (d <= 2) {
                        atRide++;
                        if (isFixAnim(m.animation)) fixing++;
                    }
                    // Walk tracking starts at the broken flag, when the game dispatches
                    // (Ride.cpp:1420), and stops for each mechanic once they reach the ride.
                    if (broken && a.arrivedAt[m.id] === undefined) {
                        const p = a.last[m.id];
                        const w = a.walked[m.id] !== undefined ? a.walked[m.id] : 0;
                        a.walked[m.id] = p === undefined ? w
                            : w + (Math.abs(m.x - p.x) + Math.abs(m.y - p.y)) / TILE;
                        a.last[m.id] = { x: m.x, y: m.y };
                        if (d <= 2) a.arrivedAt[m.id] = t;
                    }
                    if (isAnswerAnim(m.animation)) answering++;
                }
                if (first) a.startNearest = nearest;
                if (atRide > 0 && a.arriveAt === -1) a.arriveAt = t;
                if (fixing > 0 && a.fixAnimAt === -1) a.fixAnimAt = t;
                if (a.samples.length < MAX_SAMPLES) {
                    a.samples.push({ t, broken: broken ? 1 : 0, nearest, nearestId, atRide, fixing, answering });
                }
            }
            return done;
        },
    };
}
