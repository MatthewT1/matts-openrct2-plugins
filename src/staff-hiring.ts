/**
 * Shared staff hire/fire helper.
 *
 * trash-manager, mechanic-manager and staff-extras each had their own copy of the
 * `staffhire` / `stafffire` calls and the entity-budget backoff. The copies had already
 * drifted: only the handyman path reported a refused fire. This module is the one place
 * those rules live now.
 *
 * It touches no OpenRCT2 globals directly. The plugin passes in `context.executeAction`
 * and its debug counter, so the backoff logic runs under plain node in the tests.
 */

/** The subset of a game action result this module reads. */
export interface HireResult {
    error?: number;
    errorMessage?: string;
    peep?: number;
}

export type ExecuteAction = (
    action: string,
    args: object,
    callback: (result: HireResult) => void,
) => void;

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
export const HIRE_BACKOFF_DAYS = 10;

export interface StaffHirerOptions {
    /** `staffhire` staffType: 0 handyman, 1 mechanic, 2 security, 3 entertainer. */
    staffType: number;
    /** Orders bitmask passed with every hire. */
    orders: number;
    /** Singular noun for log lines, e.g. "handyman". */
    noun: string;
    /** Log prefix without brackets, e.g. "Trash Manager". */
    plugin: string;
    /** Counter prefix: counts are `<prefix>HireBlocked`, `HireFailed`, `FireFailed`. */
    counterPrefix: string;
    /**
     * Days to pause hiring after a refusal, or 0 for no backoff. Entertainers use 0:
     * their refusals are costume problems, not the entity budget, and waiting does
     * not clear them.
     */
    backoffDays: number;
    execute: ExecuteAction;
    count: (name: string, n?: number) => void;
    log?: (message: string) => void;
}

export interface StaffHirer {
    /**
     * True while a recent refusal says there is no room for more staff. Each call
     * while blocked uses up one day of the backoff, so call it once per daily decision.
     */
    blocked(): boolean;
    /**
     * Hires one staff member. `onHired` gets the new peep id on success. A refusal
     * starts the backoff and is logged once, not every day.
     */
    hire(onHired?: (peepId: number) => void, costumeIndex?: number): void;
    /** Fires one staff member. A refusal is counted and logged, never silent. */
    fire(peepId: number): void;
    /**
     * True while a fire for this id is issued but has not run yet. Under a server (the
     * headless harness runs `host`, and multiplayer) plugin actions are queued to the next
     * tick (`GameActionRunner.cpp:315-323`), so the staff entity still exists when a patrol
     * action for it is issued and is gone when that runs: "Staff entity not found" (#136).
     * Single player runs actions at once, so this is only ever true under a server.
     */
    firePending(peepId: number): boolean;
    /** Days of backoff left. For tests and telemetry. */
    backoffLeft(): number;
}

function failed(result: HireResult): boolean {
    return result.error !== undefined && result.error !== 0;
}

export function createStaffHirer(opts: StaffHirerOptions): StaffHirer {
    const log = opts.log !== undefined ? opts.log : (m: string): void => console.log(m);
    let backoff = 0;
    const pendingFires: Record<number, true> = {};

    return {
        blocked(): boolean {
            if (backoff <= 0) return false;
            backoff--;
            opts.count(opts.counterPrefix + "HireBlocked");
            return true;
        },

        hire(onHired?: (peepId: number) => void, costumeIndex?: number): void {
            opts.execute("staffhire", {
                autoPosition: true,
                staffType:    opts.staffType,
                costumeIndex: costumeIndex !== undefined ? costumeIndex : 0,
                staffOrders:  opts.orders,
            }, (result: HireResult): void => {
                if (!failed(result)) {
                    if (onHired && result.peep !== undefined && result.peep !== null) {
                        onHired(result.peep);
                    }
                    return;
                }
                // A refusal used to be swallowed in some copies: no counter, no log, and
                // a retry the next day. The player saw the game's error repeatedly while
                // the telemetry said nothing at all.
                opts.count(opts.counterPrefix + "HireFailed");
                if (opts.backoffDays <= 0) return;
                if (backoff === 0) {
                    log("[" + opts.plugin + "] Could not hire a " + opts.noun + " - the park " +
                        "is at its entity limit. Pausing hiring for " + opts.backoffDays + " days.");
                }
                backoff = opts.backoffDays;
            });
        },

        fire(peepId: number): void {
            pendingFires[peepId] = true;
            opts.execute("stafffire", { id: peepId }, (result: HireResult): void => {
                delete pendingFires[peepId];
                if (!failed(result)) return;
                // Firing a stale or already-gone peep id should show up in telemetry,
                // not vanish.
                opts.count(opts.counterPrefix + "FireFailed");
                log("[" + opts.plugin + "] Could not fire " + opts.noun + " #" + peepId + ": " +
                    (result.errorMessage || "error code " + result.error));
            });
        },

        firePending(peepId: number): boolean {
            return pendingFires[peepId] === true;
        },

        backoffLeft(): number {
            return backoff;
        },
    };
}

/**
 * Staff needed before the Best Staff award is possible (`Award.cpp:294-296`): at least 20
 * staff, at least one per 32 guests, and all four types, security included (#92).
 */
export const BEST_STAFF_MIN_STAFF = 20;

/**
 * True when hiring one security guard is what stands between the park and the Best Staff
 * award's staff-type rule: 20+ staff and none of them security. No plugin hires security
 * otherwise, so without this the award can never be granted. Takes the roster's
 * `staffType`s so it runs under node.
 */
export function wantsAwardGuard(staffTypes: string[]): boolean {
    return staffTypes.length >= BEST_STAFF_MIN_STAFF && staffTypes.indexOf("security") < 0;
}

/**
 * Award crew (#163): extra security guards that hold the headcount at the Best Staff line
 * when the park is a few staff short. Measured on 32 parks (#162): the award was never
 * deserved in 25, and 12 of those were only 1-5 staff short of max(20, guests / 32)
 * (`Award.cpp:294-296`), because the adaptive controllers trim handymen and mechanics.
 * Guards are the one type no controller trims, and a guard nearby stops vandalism.
 */
export interface AwardCrewInput {
    handymen: number;
    mechanics: number;
    security: number;
    entertainers: number;
    /** Guest entities, inside the park or not: what the award divides by 32. */
    guestEntities: number;
    /** Guards this feature hired that are still on the roster. */
    ownedGuards: number;
}

export interface AwardCrewOptions {
    minStaff: number;
    guestsPerStaff: number;
    /** A gap wider than this is not chased, and guards hired for it are let go. */
    maxExtra: number;
}

export const DEFAULT_AWARD_CREW_OPTIONS: AwardCrewOptions = {
    minStaff: BEST_STAFF_MIN_STAFF,
    guestsPerStaff: 32,
    maxExtra: 5,
};

export interface AwardCrewPlan {
    action: "hire" | "fire" | "none";
    /** Staff the award asks for, with one spare when the guest count sets it. */
    line: number;
    /** Guards this feature should own right now. */
    target: number;
}

/** How many staff the award line asks for: the game's rule plus one spare above 20. */
export function awardStaffLine(guestEntities: number, o: AwardCrewOptions): number {
    return Math.max(o.minStaff, Math.floor(guestEntities / o.guestsPerStaff) + 1);
}

/**
 * One step a day toward the right number of award guards. Hires while we own fewer than
 * the gap; fires our own once we own two more than needed (one of slack stops flip-flop),
 * or one more when the gap is out of reach. Never asks to fire with nothing owned.
 */
export function planAwardCrew(i: AwardCrewInput, o: AwardCrewOptions): AwardCrewPlan {
    const line = awardStaffLine(i.guestEntities, o);
    const staff = i.handymen + i.mechanics + i.security + i.entertainers;
    const gap = line - (staff - i.ownedGuards);
    // The award needs every type; extra guards cannot stand in for a missing one.
    const reachable = i.handymen > 0 && i.mechanics > 0 && i.entertainers > 0 && gap <= o.maxExtra;
    const target = reachable && gap > 0 ? gap : 0;
    if (i.ownedGuards < target) return { action: "hire", line: line, target: target };
    const slack = reachable ? 2 : 1;
    if (i.ownedGuards >= target + slack) return { action: "fire", line: line, target: target };
    return { action: "none", line: line, target: target };
}
