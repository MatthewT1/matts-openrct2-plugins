/**
 * Closed-loop staffing controller.
 *
 * ## Why this exists
 *
 * Every published handyman ratio disagrees with every other one — community advice spans
 * 1 per 6 path tiles to 1 per 100 guests, a range of roughly 10 to 220 staff for a
 * 1,340-tile, 1,200-guest park. There is no consensus number to copy, and the classic
 * guest-driven formula is coverage-blind: it kept demanding more staff as the park grew
 * while the park sat at maximum rating doing nothing.
 *
 * So instead of predicting the right number, this controller *finds* it: release staff
 * while the park stays clean, and hire back when that demonstrably makes things worse.
 *
 * ## Why the obvious control signal does not work
 *
 * The first version reacted to `oldLitter` — litter aged past the rating-penalty
 * threshold. Measured, that failed in two distinct ways:
 *
 * 1. **It is lagged by ~14.5 in-game days.** `LITTER_OLD_AGE_TICKS` is 7680, and an
 *    in-game day is only ~528 ticks. So `oldLitter` describes litter dropped a fortnight
 *    ago. Acting on it every 2 days meant hiring ~7 staff before the first hire's effect
 *    was even visible — textbook overshoot, and that is exactly what happened.
 *
 * 2. **`oldLitter > 0` is not a problem worth solving.** Peak observed was 4 pieces = 16
 *    rating points against a base of 1150, with the rating clamped at its 999 maximum the
 *    entire time. The controller hired 6 handymen to fix a penalty that cost nothing.
 *
 * This version therefore:
 *
 * - uses **total litter**, which responds immediately, as the regression signal;
 * - **remembers the litter level before each release**, so it can tell whether its own
 *   last change caused a problem, rather than reacting to absolute numbers that are
 *   entirely park-specific;
 * - **waits out the lag** after every change before drawing any conclusion;
 * - **remembers the floor it discovered** so it does not re-probe a level it already
 *   learned was too low;
 * - only treats `oldLitter` as urgent when it is large enough to matter, or when park
 *   rating has actually fallen.
 */

/** Old litter below this costs a trivial number of rating points; not worth reacting to. */
export const URGENT_OLD_LITTER = 25;
/**
 * Old litter at or below this does not block a release.
 *
 * **This gate was the bug that deadlocked v2.** The release path originally required
 * `oldLitter === 0`, while hiring required `>= 25`. That left a dead zone from 1 to 24
 * in which the controller could do nothing at all — and measured over 62 in-game days,
 * `oldLitter` was zero on exactly **one** day and never on a day the fleet was also
 * underworked. The controller sat motionless at 40 handymen for the entire run.
 *
 * The two thresholds must express the same standard: a handful of old litter costs a
 * few rating points out of ~150 of headroom, so it should neither trigger hiring nor
 * prevent releasing.
 */
export const RELEASE_OLD_LITTER_MAX = 8;
/** Park rating below this means something is genuinely wrong, whatever the litter count. */
export const RATING_CONCERN = 900;
/** Consecutive days of slack before releasing one handyman. */
export const RELEASE_DAYS = 4;
/**
 * Days to wait after a *release* before judging its effect.
 *
 * The regression signal is total litter, whose EMA has a time constant of roughly
 * 1/EMA_ALPHA = 5 days, so ~10 days is ample to see litter double if the release went
 * too far. This does not need to cover the 14.5-day old-litter lag, because releases are
 * judged on total litter rather than old litter.
 */
export const SETTLE_DAYS = 10;
/**
 * Days to wait after *hiring*. Longer, because the trigger for hiring is the old-litter
 * signal, which describes litter dropped ~14.5 in-game days ago. Reacting faster than
 * that means stacking hires in response to a problem already being fixed — which is
 * exactly the overshoot this controller was rewritten to avoid.
 */
export const URGENT_SETTLE_DAYS = 16;
/** Litter must exceed `reference * this` after a release for it to count as a regression. */
export const REGRESSION_FACTOR = 2.0;
/** Smoothing for the total-litter average. Lower reacts faster. */
export const EMA_ALPHA = 0.2;

/**
 * The thresholds the controller compares its signals against.
 *
 * **These exist because reusing this controller for mechanics silently broke it.**
 * Every constant above is expressed in *pieces of litter*, and the mechanic mapping
 * feeds it *counts of rides* — so `URGENT_OLD_LITTER = 25` was being compared against a
 * number that cannot exceed the park's ride count. On a 13-ride park the urgent-hire
 * path was arithmetically unreachable, while `RELEASE_OLD_LITTER_MAX = 8` was always
 * satisfied. The result was a one-way ratchet that could only ever fire mechanics:
 * measured over 163 in-game days it went 5 -> 4 -> 3 against a formula target of 6,
 * while a ride sat broken for 11 consecutive days and minimum reliability decayed from
 * 59% to 36%.
 *
 * The lesson is the project's recurring one, in a new place: a threshold is only
 * meaningful against the range of values the signal actually produces. Reusing a
 * controller means reusing its *shape*, not its calibration.
 */
export interface StaffingThresholds {
    /** `urgentSignal` at or above this forces a hire, bypassing the settle window. */
    urgentAt: number;
    /** `urgentSignal` at or below this does not block a release. */
    releaseMaxUrgent: number;
    /** Park rating below this counts as an emergency whatever the signals say. */
    ratingConcern: number;
    /** Consecutive slack observations before releasing one staff member. */
    releaseDays: number;
    /** Observations to wait after a release before judging it. */
    settleDays: number;
    /** Observations to wait after a hire. */
    urgentSettleDays: number;
    /** The regression signal must exceed `reference * this` to count as a regression. */
    regressionFactor: number;
    /**
     * Observations to wait between successive URGENT hires. 0 hires every observation.
     *
     * The urgent branch bypasses the ordinary settle window by design — an emergency
     * should not wait. But it also bypassed any pacing at all, so a condition persisting
     * for several observations produced one hire per observation.
     *
     * Measured 2026-09-20: one ride went unattended and the mechanic controller hired
     * **four times in four days**, 2 -> 6, straight to the formula ceiling. The ride
     * stayed broken for 8 days regardless, so the extra hires bought nothing and tripled
     * the wage bill — and since every urgent hire also raises `discoveredFloor`, the
     * controller was left pinned at the ceiling afterwards.
     *
     * Pacing makes the urgent path hire one, wait, and re-check. If the problem really
     * is headcount, the next observation still sees it and hires again. If it is not — a
     * ride no mechanic can physically reach — it stops throwing staff at it.
     *
     * This does NOT delay the emergency response itself: releasing stays blocked for as
     * long as the urgent condition holds, whatever the pacing counter says.
     *
     * 0 for handymen, preserving their measured-good behaviour exactly.
     */
    urgentHirePaceDays: number;
    /**
     * Quiet observations before the discovered floor relaxes by one. 0 disables decay.
     *
     * **Why this exists.** `discoveredFloor` records a level that was proven inadequate
     * and is never probed below again. That is sound when the signal genuinely responds
     * to headcount — more handymen really do clear more litter.
     *
     * It is NOT sound when the signal can be caused by something headcount cannot fix.
     * A ride left broken because no mechanic can physically reach it (the pathfinding
     * trap behind #7947 / #3205) raises the floor on every urgent hire until the floor
     * reaches the formula ceiling, at which point the controller is pinned there
     * permanently and every saving it had found is gone for the rest of the game. That
     * is a one-way ratchet UP — the mirror image of the one-way ratchet DOWN that the
     * mechanic thresholds were fixed to remove, and no less wrong.
     *
     * Decay makes the floor a strong prior rather than a permanent verdict: after a
     * long, genuinely quiet stretch the controller may probe one step lower again. If
     * that probe was a mistake, the urgent path puts the floor straight back.
     *
     * Deliberately 0 for handymen. The failure has only been *measured* for mechanics,
     * and changing a controller that is demonstrably working on the strength of a
     * theoretical argument is how this project has broken things before.
     */
    floorDecayDays: number;
}

/** Litter-calibrated defaults. Handyman behaviour is unchanged by the parameterisation. */
export const DEFAULT_THRESHOLDS: StaffingThresholds = {
    urgentAt: URGENT_OLD_LITTER,
    releaseMaxUrgent: RELEASE_OLD_LITTER_MAX,
    ratingConcern: RATING_CONCERN,
    releaseDays: RELEASE_DAYS,
    settleDays: SETTLE_DAYS,
    urgentSettleDays: URGENT_SETTLE_DAYS,
    regressionFactor: REGRESSION_FACTOR,
    // No decay: the handyman controller is measurably working, and the ratchet-up
    // failure has not been observed for it. See the field notes on those two fields.
    urgentHirePaceDays: 0,
    floorDecayDays: 0,
};

/**
 * Thresholds for the mechanic controller, in *counts of rides*.
 *
 * `urgentAt: 1` looks aggressive next to the handyman value of 25 and is not: the
 * mechanic urgent signal is **rides that have been broken for two or more consecutive
 * days**, not rides broken right now. A ride that breaks and is repaired the same day
 * never contributes. One ride left broken for two days genuinely is the emergency —
 * it is the condition behind the game's own "still hasn't been fixed" warning.
 *
 * `releaseMaxUrgent: 0` follows from the same reasoning: never shed a mechanic while
 * any ride is sitting unattended, however idle the fleet looks. An idle fleet with an
 * unrepaired ride is not slack, it is a reachability problem, and firing into it makes
 * it worse.
 *
 * The settle windows are much shorter than the litter ones because the mechanic signals
 * have no equivalent of the 14.5-day old-litter lag — a broken ride is visible the day
 * it breaks.
 */
export const MECHANIC_THRESHOLDS: StaffingThresholds = {
    urgentAt: 1,
    releaseMaxUrgent: 0,
    ratingConcern: RATING_CONCERN,
    releaseDays: RELEASE_DAYS,
    settleDays: 6,
    urgentSettleDays: 8,
    regressionFactor: REGRESSION_FACTOR,
    // Hire one, then wait three days to see whether it helped before hiring again.
    urgentHirePaceDays: 3,
    // ~3 weeks of complete quiet before re-probing one step lower.
    floorDecayDays: 20,
};

export interface StaffingSignals {
    /**
     * The slow, high-confidence "this is actually costing something" signal.
     *
     * Handymen: litter aged past the rating threshold, lagged ~14.5 days.
     * Mechanics: rides broken for two or more consecutive days.
     *
     * Compared against `urgentAt` and `releaseMaxUrgent`, so it MUST be in the same
     * units as the thresholds passed to `createStaffingController`.
     */
    oldLitter: number;
    /**
     * The fast, noisy leading signal, smoothed into an EMA and used to detect a
     * release that made things worse.
     *
     * Handymen: all litter in the park. Mechanics: rides broken right now.
     */
    totalLitter: number;
    /** Current park rating, 0-999. The actual outcome we care about. */
    parkRating: number;
    /** True when most of the fleet has had nothing to do — see staff-activity.ts. */
    fleetUnderworked: boolean;
    /** The classic formula's answer. Used as a hard upper bound. */
    formulaTarget: number;
    /** Never go below this, however clean the park looks. */
    floor: number;
}

export interface StaffingDecision {
    target: number;
    /** Days remaining before the controller will act again. */
    settling: number;
    /** Lowest level not yet shown to be inadequate. */
    discoveredFloor: number;
    /** Smoothed total litter. */
    litterAverage: number;
    /** Why the target moved, or "" when it did not. */
    reason: string;
}

export interface StaffingController {
    update(signals: StaffingSignals): StaffingDecision;
    target(): number;
    seed(target: number): void;
    reset(): void;
}

export function createStaffingController(
    initialTarget: number,
    thresholds?: StaffingThresholds,
): StaffingController {
    const limits = thresholds !== undefined ? thresholds : DEFAULT_THRESHOLDS;
    let target = initialTarget;
    let pressure = 0;
    let settle = 0;
    let ema = -1;                 // -1 = not yet established
    let referenceLitter = -1;     // litter average captured before the last release
    let discoveredFloor = 0;      // raised when a release proves to have been too far
    let quiet = 0;                // consecutive observations with nothing wrong at all
    let urgentPace = 0;           // observations still to wait before the next urgent hire

    function update(signals: StaffingSignals): StaffingDecision {
        let reason = "";

        // Track total litter continuously, including while settling — the average needs
        // to be warm and current by the time we are allowed to act on it.
        ema = ema < 0 ? signals.totalLitter : ema * (1 - EMA_ALPHA) + signals.totalLitter * EMA_ALPHA;

        const floor = Math.max(signals.floor, discoveredFloor);
        const ceiling = Math.max(floor, signals.formulaTarget);

        // Genuine emergencies bypass the settle window. Everything else waits.
        const urgent = signals.oldLitter >= limits.urgentAt
            || (signals.parkRating < limits.ratingConcern && signals.oldLitter > 0);

        if (!urgent) {
            // Out of the emergency; let the next one act immediately.
            urgentPace = 0;
        }

        if (urgent) {
            if (limits.urgentHirePaceDays > 0 && urgentPace > 0) {
                // Still waiting to see whether the last hire helped. The emergency is
                // unchanged, so everything below (settle, pressure, blocked releases)
                // still applies — only the extra hire is withheld.
                urgentPace--;
            } else if (target < ceiling) {
                target++;
                urgentPace = limits.urgentHirePaceDays;
                // Whatever level we were at was not enough; never probe below it again.
                discoveredFloor = Math.max(discoveredFloor, target);
                reason = signals.parkRating < limits.ratingConcern
                    ? "park rating is falling"
                    : "old litter is costing real rating";
            }
            settle = limits.urgentSettleDays;
            pressure = 0;
            referenceLitter = -1;
        } else if (settle > 0) {
            // Waiting out the lag from the last change. Deliberately do nothing.
            settle--;
        } else if (referenceLitter >= 0 && ema > referenceLitter * limits.regressionFactor) {
            // The last release made litter materially worse. Undo it and remember.
            target++;
            discoveredFloor = Math.max(discoveredFloor, target);
            referenceLitter = -1;
            settle = limits.urgentSettleDays;
            pressure = 0;
            reason = "the last release made things worse";
        } else if (signals.fleetUnderworked
                   && signals.oldLitter <= limits.releaseMaxUrgent
                   // Do not shed staff while litter is actively climbing, even if the
                   // absolute numbers still look harmless.
                   && signals.totalLitter <= ema
                   && target > floor) {
            pressure--;
            if (pressure <= -limits.releaseDays) {
                // Remember how clean things were, so a regression is recognisable.
                referenceLitter = Math.max(ema, 1);
                target--;
                pressure = 0;
                settle = limits.settleDays;
                reason = "park clean and fleet underworked";
            }
        } else if (pressure < 0) {
            // Conditions no longer favour releasing; let the streak decay.
            pressure++;
        }

        // Relax the discovered floor after a long, genuinely quiet stretch, so a level
        // once proven inadequate is a strong prior rather than a life sentence. Any
        // urgent signal resets the counter, and the urgent path above will raise the
        // floor straight back if the probe turns out to have been a mistake.
        if (limits.floorDecayDays > 0) {
            if (urgent || signals.oldLitter > 0) {
                quiet = 0;
            } else {
                quiet++;
                if (quiet >= limits.floorDecayDays && discoveredFloor > signals.floor) {
                    discoveredFloor--;
                    quiet = 0;
                }
            }
        }

        const before = target;
        if (target > ceiling) target = ceiling;
        if (target < floor) target = floor;
        if (target !== before) {
            reason = target > before ? "raised to floor" : "capped at formula target";
        }

        return {
            target,
            settling: settle,
            discoveredFloor,
            litterAverage: Math.round(ema * 10) / 10,
            reason,
        };
    }

    return {
        update,
        target(): number { return target; },
        seed(value: number): void {
            target = value;
            pressure = 0;
            settle = 0;
            ema = -1;
            referenceLitter = -1;
            discoveredFloor = 0;
        quiet = 0;
        urgentPace = 0;
        },
        reset(): void {
            pressure = 0;
            settle = 0;
        },
    };
}
