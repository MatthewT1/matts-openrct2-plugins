/**
 * Money text in the player's own currency (#31).
 *
 * `{CURRENCY}` / `{CURRENCY2DP}` apply the currency set in Options and its exchange
 * rate (Formatting.cpp FormatCurrency). They take the game's internal money units,
 * which are TENTHS of a pound (Currency.cpp: GBP rate 10), so callers pass pounds and
 * this converts. Precision is therefore 10p: 34.87 prints as the equivalent of £34.90.
 */

/** Whole units, e.g. "£80" or "136 €". */
export function formatMoney(pounds: number): string {
    return context.formatString("{CURRENCY}", Math.round(pounds * 10));
}

/** Two decimal places, e.g. "£34.90". */
export function formatMoney2dp(pounds: number): string {
    return context.formatString("{CURRENCY2DP}", Math.round(pounds * 10));
}
