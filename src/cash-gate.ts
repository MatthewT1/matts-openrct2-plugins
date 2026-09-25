/**
 * Whether a plugin may spend, given the park's cash and money mode (#44).
 *
 * The builders keep a cash floor so they never spend a money park into trouble. In a
 * no-money park the game charges nothing for building (`FinanceCheckMoneyRequired`
 * returns false, Finance.cpp:62) and pays no wages, so `park.cash` means nothing and
 * a floor that happened to sit above it switched the builders off for good.
 *
 * Marketing is the exception: the game hides the Finances window, which holds the
 * marketing tab, in no-money parks (TopToolbar.cpp:1103). A player cannot run
 * campaigns there, so the plugin does not either, even though the action would be free.
 *
 * Free of OpenRCT2 globals so it can be unit-tested; callers pass `park.cash` and
 * `park.getFlag("noMoney")`.
 */

export type SpendKind = "build" | "marketing";
export type SpendGate = "spend" | "lowCash" | "noMoneyPark" | "unavailable";

export function spendGate(cash: number, floor: number, noMoney: boolean, kind: SpendKind): SpendGate {
    if (noMoney) return kind === "marketing" ? "unavailable" : "noMoneyPark";
    return cash >= floor ? "spend" : "lowCash";
}
