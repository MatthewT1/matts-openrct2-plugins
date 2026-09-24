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
    /** Days of backoff left. For tests and telemetry. */
    backoffLeft(): number;
}

function failed(result: HireResult): boolean {
    return result.error !== undefined && result.error !== 0;
}

export function createStaffHirer(opts: StaffHirerOptions): StaffHirer {
    const log = opts.log !== undefined ? opts.log : (m: string): void => console.log(m);
    let backoff = 0;

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
            opts.execute("stafffire", { id: peepId }, (result: HireResult): void => {
                if (!failed(result)) return;
                // Firing a stale or already-gone peep id should show up in telemetry,
                // not vanish.
                opts.count(opts.counterPrefix + "FireFailed");
                log("[" + opts.plugin + "] Could not fire " + opts.noun + " #" + peepId + ": " +
                    (result.errorMessage || "error code " + result.error));
            });
        },

        backoffLeft(): number {
            return backoff;
        },
    };
}
