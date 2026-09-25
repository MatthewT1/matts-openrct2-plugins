/**
 * Game-time cooldown with a real-time floor (#48).
 *
 * The plugins' throttles used to be real time (`Date.now()`), so how often they acted
 * per in-game day depended on game speed: the 30 s tile scan ran every ~2 days at
 * normal speed and every ~18 at speed 4. Measuring in game ticks makes the decisions
 * the same at every speed. The real-time floor keeps the original job of these
 * throttles, bounding frame cost, if game time ever runs faster than speed 4.
 *
 * Pick floors below one game interval at speed 4 (`MS_PER_DAY_AT_SPEED[4]` per day),
 * or the floor binds at speed 4 and the speeds drift apart again.
 *
 * Free of OpenRCT2 globals so it can be unit-tested; callers pass
 * `date.ticksElapsed` and `Date.now()`.
 */

/** Game ticks per in-game day (harness days.csv: 528-547 ticks between days). */
export const TICKS_PER_DAY = 530;

/** Real milliseconds per in-game day at speeds 1-4 (40 ticks/s, doubling per step). */
export const MS_PER_DAY_AT_SPEED: Record<number, number> = {
    1: TICKS_PER_DAY * 1000 / 40,
    2: TICKS_PER_DAY * 1000 / 80,
    3: TICKS_PER_DAY * 1000 / 160,
    4: TICKS_PER_DAY * 1000 / 320,
};

export interface Cooldown {
    /** True (and restarts the cooldown) once both the tick and real-time gaps have passed. */
    ready(ticks: number, nowMs: number): boolean;
    /** Makes the next ready() call return true. */
    reset(): void;
}

export function createCooldown(minTicks: number, minMs: number): Cooldown {
    let lastTicks = 0, lastMs = 0, fresh = true;
    return {
        ready(ticks: number, nowMs: number): boolean {
            // ticksElapsed restarts on a park load; a clock that went backwards fires
            // rather than stalling for as long as the previous park had run.
            const due = fresh || ticks < lastTicks
                || (ticks - lastTicks >= minTicks && nowMs - lastMs >= minMs);
            if (!due) return false;
            fresh = false;
            lastTicks = ticks;
            lastMs = nowMs;
            return true;
        },
        reset(): void { fresh = true; },
    };
}

// Day lengths vary (464-547 ticks seen), so "every N days" is N - 0.5 days of ticks: a
// span a few ticks short of N * 530 must still fire on day N, not slip to N + 1.

/** Tile scan (trash/map-scan.ts): every 3 days, as speed 1 did with the old 30 s cooldown. */
export const TILE_SCAN_TICKS = 2.5 * TICKS_PER_DAY;
/** Entertainer queue census (staff-extras.ts): every 2 days (old 15 s at speed 1). */
export const ENTERTAINER_CENSUS_TICKS = 1.5 * TICKS_PER_DAY;
/** Guest-need sampling (trash/facilities.ts): daily (old 2.5 s at speed 1). */
export const NEED_SAMPLE_TICKS = TICKS_PER_DAY / 2;
/** Facility build watchdog (trash/facilities.ts): 5 days (old 60 s at speed 1). */
export const BUILD_WATCHDOG_TICKS = 4.5 * TICKS_PER_DAY;
