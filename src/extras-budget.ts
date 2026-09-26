/**
 * Monthly budget for cheap happiness extras (#116): queue TVs, repairs (#115), ...
 *
 * Each month the plugin may spend a share of the cash above a floor, fixed when the
 * month starts. It works from cash in the bank, not the month's profit, so a park
 * that runs a loss early on still gets its £15 TVs while it has money. A no-money
 * park charges nothing for building (Finance.cpp:62), so there the budget is open.
 *
 * Pure logic, no OpenRCT2 globals (tests/extras-budget.test.mjs). Money in tenths of a pound.
 */

export interface ExtrasBudgetOptions {
    /** Cash kept back (tenths). */
    floor: number;
    /** Share of the cash above the floor the month may spend (0-1). */
    share: number;
}

export const DEFAULT_EXTRAS_BUDGET: ExtrasBudgetOptions = {
    floor: 1_000 * 10,
    share: 0.05,
};

/** The month's allowance for this much cash. */
export function monthAllowance(cash: number, options: ExtrasBudgetOptions): number {
    if (cash <= options.floor) return 0;
    return Math.floor((cash - options.floor) * options.share);
}

export interface ExtrasBudget {
    /** Starts a new month when `monthKey` changes (allowance from `cash` then). */
    update(monthKey: number, cash: number, noMoney: boolean): void;
    /** How many items at `cost` each still fit in this month's budget. */
    affordable(cost: number): number;
    /** Records a spend. */
    spend(amount: number): void;
    spent(): number;
    allowance(): number;
    /** The park charges nothing: no limit. */
    open(): boolean;
}

export function createExtrasBudget(options: ExtrasBudgetOptions = DEFAULT_EXTRAS_BUDGET): ExtrasBudget {
    let month = -1;
    let allowance = 0;
    let spent = 0;
    let noMoneyPark = false;
    return {
        update(monthKey: number, cash: number, noMoney: boolean): void {
            noMoneyPark = noMoney;
            if (monthKey === month) return;
            month = monthKey;
            allowance = monthAllowance(cash, options);
            spent = 0;
        },
        affordable(cost: number): number {
            if (noMoneyPark || cost <= 0) return 1_000_000;
            return Math.max(0, Math.floor((allowance - spent) / cost));
        },
        spend(amount: number): void { spent += amount; },
        spent(): number { return spent; },
        allowance(): number { return allowance; },
        open(): boolean { return noMoneyPark; },
    };
}
