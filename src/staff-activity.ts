/**
 * Idle / stuck staff detection.
 *
 * Handymen becoming trapped is the most-cited community frustration with OpenRCT2 staff,
 * and the upstream bugs are still open (#7947, #3205): a handyman in a zig-zagging queue
 * line can lock onto litter on an adjacent but unreachable path and oscillate toward it
 * forever, sweeping nothing while the area rots.
 *
 * Detecting that by watching peep coordinates would mean sampling positions every tick.
 * Instead we use the per-staff productivity counters the game already maintains —
 * `Handyman.litterSwept`, `binsEmptied`, `Mechanic.ridesFixed`, `ridesInspected`. They
 * are plain readonly properties, so a check costs one property read per staff member per
 * day.
 *
 * ## Why this compares against peers rather than against a threshold
 *
 * The first version of this module flagged any staff member idle for N days while work
 * existed. Measured over 43 in-game days it produced **734 false positives** — about 32
 * of 36 handymen, every single day.
 *
 * The logic was wrong. With 36 handymen and roughly 1.5 pieces of litter appearing per
 * day, most of them doing nothing is not a fault: there is nothing for them to do. That
 * detector conflated *overstaffed* with *stuck*.
 *
 * So the question is not "has this one been idle?" but "has this one been idle **while
 * its peers were working**?". A staff member that has never once done its job while a
 * majority of the fleet has is a genuine outlier. If nobody is working, that is a
 * staffing signal (`fleetUnderworked`), which the caller should act on by reducing
 * headcount rather than by blaming individuals.
 */

/** Days a staff member must be tracked before it can be judged at all. */
export const DEFAULT_MIN_DAYS = 6;

/**
 * Fraction of the fleet that must have done *some* work before an individual's
 * inactivity is treated as a fault rather than as a lack of demand.
 */
export const PEER_ACTIVE_FRACTION = 0.5;

/**
 * Largest share of the fleet that may be reported stuck at once.
 *
 * Measured: with 39 handymen and ~1.8 work events per day, 10 of them had never swept
 * anything — 26% of the fleet. That is the tail of a normal distribution, not a fault.
 * A real stuck handyman is a *rare* exception; if a quarter of the staff qualify, the
 * explanation is workload, not pathfinding.
 */
export const MAX_STUCK_FRACTION = 0.15;

interface ActivityRecord {
    /** Cumulative work counter at the last observation. */
    work: number;
    /** Total work gained since first sighting. */
    lifetime: number;
    /** Sweeps this staff member has been observed for. */
    days: number;
    /** Set each sweep so records for departed staff can be pruned. */
    seen: boolean;
    /** Index of the last sweep in which this staff member gained work, or -1. */
    lastWorkSweep: number;
}

export interface ActivitySnapshot {
    /**
     * Staff that have done nothing at all since being tracked, while a majority of
     * their peers have. These are the genuine outliers worth reporting.
     */
    stuck: number[];
    /** Staff currently tracked. */
    tracked: number;
    /** Staff with any lifetime work at all. */
    active: number;
    /** Total productivity gained across the fleet since the last sweep. */
    workDone: number;
    /**
     * True when most of the fleet has never had anything to do. This is an
     * overstaffing signal, not a fault — see the module header.
     */
    fleetUnderworked: boolean;
}

export interface ActivityTracker {
    /**
     * Records one staff member's current cumulative work total.
     * Call once per staff member per day.
     */
    observe(peepId: number, workTotal: number): void;
    /**
     * Ends the sweep: prunes departed staff and returns the fleet picture.
     *
     * @param hasWorkAvailable False when there is genuinely nothing to do. No staff
     *        member is reported stuck in that case regardless of peer activity.
     */
    endSweep(hasWorkAvailable: boolean): ActivitySnapshot;
    /**
     * Share of the currently tracked staff that gained work in the last `days` sweeps,
     * or null until `days` sweeps of work could have been observed (the first sweep
     * after a load is a baseline only). Call after `endSweep`.
     *
     * Read-only: it does not feed `fleetUnderworked` or `stuck`. Added for #32, where
     * the lifetime definition of "active" is only ever false in the days after a load.
     * Staff hired inside the window with no job yet count as inactive, which is the
     * point: an idle extra hire is exactly what an overstaffing signal should see.
     */
    activeFractionWithin(days: number): number | null;
    /** Forgets everything — use when the roster is deliberately reset. */
    reset(): void;
}

export function createActivityTracker(minDays?: number): ActivityTracker {
    const threshold = minDays !== undefined ? minDays : DEFAULT_MIN_DAYS;
    let records: Record<number, ActivityRecord> = {};
    let workThisSweep = 0;
    /** Completed sweeps. Also the index of the sweep currently being observed. */
    let sweepCount = 0;

    return {
        observe(peepId: number, workTotal: number): void {
            const existing = records[peepId];
            if (existing === undefined) {
                // First sighting: record the baseline without judging it. A newly hired
                // handyman has swept nothing yet and is not stuck.
                records[peepId] = { work: workTotal, lifetime: 0, days: 0, seen: true, lastWorkSweep: -1 };
                return;
            }
            const gained = workTotal - existing.work;
            if (gained > 0) {
                workThisSweep += gained;
                existing.lifetime += gained;
                existing.work = workTotal;
                existing.lastWorkSweep = sweepCount;
            } else if (gained < 0) {
                // Counters are cumulative and never decrease, so a decrease means the
                // peep id was recycled. Re-baseline rather than recording negative work.
                existing.work = workTotal;
                existing.lifetime = 0;
                existing.days = 0;
                existing.lastWorkSweep = -1;
            }
            existing.days++;
            existing.seen = true;
        },

        endSweep(hasWorkAvailable: boolean): ActivitySnapshot {
            let tracked = 0;
            let active = 0;
            const candidates: number[] = [];

            for (const key in records) {
                const rec = records[key];
                if (!rec.seen) {
                    // Staff member is gone (fired or otherwise). Drop the record so this
                    // map cannot grow without bound, and so a recycled peep id does not
                    // inherit a stranger's history.
                    delete records[key];
                    continue;
                }
                rec.seen = false;
                tracked++;
                if (rec.lifetime > 0) {
                    active++;
                } else if (rec.days >= threshold) {
                    candidates.push(Number(key));
                }
            }

            const activeFraction = tracked > 0 ? active / tracked : 0;
            const fleetUnderworked = activeFraction < PEER_ACTIVE_FRACTION;

            // Only call someone stuck when the fleet around them is demonstrably able to
            // work AND they are a genuine minority. Otherwise their inactivity says
            // something about the park, not about them.
            const isOutlierGroup = tracked > 0
                && (candidates.length / tracked) <= MAX_STUCK_FRACTION;
            const stuck = (hasWorkAvailable && !fleetUnderworked && isOutlierGroup)
                ? candidates
                : [];

            const workDone = workThisSweep;
            workThisSweep = 0;
            sweepCount++;
            return { stuck, tracked, active, workDone, fleetUnderworked };
        },

        activeFractionWithin(days: number): number | null {
            if (sweepCount < days + 1) return null;
            let tracked = 0;
            let active = 0;
            for (const key in records) {
                tracked++;
                if (records[key].lastWorkSweep >= sweepCount - days) active++;
            }
            return tracked > 0 ? active / tracked : null;
        },

        reset(): void {
            records = {};
            workThisSweep = 0;
            sweepCount = 0;
        },
    };
}
