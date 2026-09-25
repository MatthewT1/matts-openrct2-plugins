/**
 * Marketing campaign decision logic.
 *
 * PURITY CONTRACT: no game globals. Everything here is plain data and arithmetic;
 * the plugin entry point supplies live park state and issues the resulting actions.
 *
 * Every number below is source-verified — see docs/marketing-research.md for the
 * file:line citations. Phase 0/1 only: this module currently exports the verified
 * constants every later phase depends on. The actual recommendation function lands
 * in Phase 2 (docs/marketing-roadmap.md), once Phase 1's telemetry has confirmed
 * these fields behave as expected on a real park.
 */

/** `ADVERTISING_CAMPAIGN_*` indices, Marketing.h:16-25. Must match `parkmarketing`'s `type` arg exactly. */
export const CAMPAIGN_PARK_ENTRY_FREE = 0;
export const CAMPAIGN_RIDE_FREE = 1;
export const CAMPAIGN_PARK_ENTRY_HALF_PRICE = 2;
export const CAMPAIGN_FOOD_OR_DRINK_FREE = 3;
export const CAMPAIGN_PARK = 4;
export const CAMPAIGN_RIDE = 5;

export type CampaignType =
    | typeof CAMPAIGN_PARK_ENTRY_FREE
    | typeof CAMPAIGN_RIDE_FREE
    | typeof CAMPAIGN_PARK_ENTRY_HALF_PRICE
    | typeof CAMPAIGN_FOOD_OR_DRINK_FREE
    | typeof CAMPAIGN_PARK
    | typeof CAMPAIGN_RIDE;

/** Human-readable names, for UI/telemetry only - never compared against. */
export const CAMPAIGN_NAMES: Record<CampaignType, string> = {
    [CAMPAIGN_PARK_ENTRY_FREE]: "Free park entry vouchers",
    [CAMPAIGN_RIDE_FREE]: "Free ride vouchers",
    [CAMPAIGN_PARK_ENTRY_HALF_PRICE]: "Half-price entry vouchers",
    [CAMPAIGN_FOOD_OR_DRINK_FREE]: "Free food/drink vouchers",
    [CAMPAIGN_PARK]: "Park advertising campaign",
    [CAMPAIGN_RIDE]: "Ride advertising campaign",
};

/**
 * £ per week, source-verified (Marketing.cpp:28-35, already converted from money64
 * tenths to real GBP). Indexed by CampaignType.
 */
export const WEEKLY_COST: Record<CampaignType, number> = {
    [CAMPAIGN_PARK_ENTRY_FREE]: 50,
    [CAMPAIGN_RIDE_FREE]: 50,
    [CAMPAIGN_PARK_ENTRY_HALF_PRICE]: 50,
    [CAMPAIGN_FOOD_OR_DRINK_FREE]: 50,
    [CAMPAIGN_PARK]: 350,
    [CAMPAIGN_RIDE]: 200,
};

/**
 * Base guest-generation probability out of 65536, rolled every game tick for the
 * campaign's entire duration (Marketing.cpp:48-50, Park.cpp:228-237). Three of
 * these are subject to a further ÷8 penalty - see the `*_PENALTY` constants below,
 * applied by the caller once real park/ride pricing is known.
 */
export const BASE_PROBABILITY: Record<CampaignType, number> = {
    [CAMPAIGN_PARK_ENTRY_FREE]: 400,
    [CAMPAIGN_RIDE_FREE]: 300,
    [CAMPAIGN_PARK_ENTRY_HALF_PRICE]: 200,
    [CAMPAIGN_FOOD_OR_DRINK_FREE]: 200,
    [CAMPAIGN_PARK]: 250,
    [CAMPAIGN_RIDE]: 200,
};

/**
 * Hidden ÷8 penalty thresholds (Marketing.cpp:60-77). Undocumented anywhere in
 * community guides; only visible from source. `PARK`, `RIDE` and
 * `FOOD_OR_DRINK_FREE` have no such penalty.
 *
 * In RAW TENTHS OF A POUND, matching `park.entranceFee` and `ride.price[0]`'s units
 * directly - NOT real pounds. The source literals are `4.00_GBP` / `6.00_GBP` /
 * `0.30_GBP`, and `_GBP` multiplies by 10 (core/Money.hpp:27, api-reference.md#units).
 * Comparing a real-pound constant against these raw fields would silently disable
 * the penalty check 90% of the time - the exact shape of bug this project has hit
 * before with cash floors.
 */
export const FREE_ENTRY_FEE_THRESHOLD = 40; // PARK_ENTRY_FREE: probability /8 if park.entranceFee below this (= £4.00)
export const HALF_PRICE_ENTRY_FEE_THRESHOLD = 60; // PARK_ENTRY_HALF_PRICE: probability /8 if park.entranceFee below this (= £6.00)
export const FREE_RIDE_PRICE_THRESHOLD = 3; // RIDE_FREE: probability /8 if the ride's price[0] is below this (= £0.30)
export const PENALTY_DIVISOR = 8;

/** Ticks per in-game day, verified elsewhere in this project (api-reference.md#time). */
export const TICKS_PER_DAY = 537; // midpoint of the measured 528-546 range
export const DAYS_PER_WEEK = 7;

/** Official UI bounds (NewCampaign.cpp:191,249,253). The action itself allows 1-255. */
export const MIN_WEEKS = 2;
export const MAX_WEEKS = 12;

/**
 * Expected extra guests per week at full (unpenalised) effectiveness.
 * `guests/week = (ticks/week) * (probability / 65536)`.
 */
export function expectedGuestsPerWeek(probability: number): number {
    const ticksPerWeek = TICKS_PER_DAY * DAYS_PER_WEEK;
    return (ticksPerWeek * probability) / 65536;
}

/** £ spent per extra guest at full effectiveness - lower is better value. */
export function costPerGuest(type: CampaignType): number {
    const guestsPerWeek = expectedGuestsPerWeek(BASE_PROBABILITY[type]);
    if (guestsPerWeek <= 0) return Infinity;
    return WEEKLY_COST[type] / guestsPerWeek;
}

// ---------------------------------------------------------------------------
// Phase 2: the actual recommendation.
// ---------------------------------------------------------------------------

export const ALL_CAMPAIGN_TYPES: CampaignType[] = [
    CAMPAIGN_PARK_ENTRY_FREE, CAMPAIGN_RIDE_FREE, CAMPAIGN_PARK_ENTRY_HALF_PRICE,
    CAMPAIGN_FOOD_OR_DRINK_FREE, CAMPAIGN_PARK, CAMPAIGN_RIDE,
];

/** One open ride's id and admission price, both needed for the RIDE_FREE penalty check and item selection. */
export interface OpenRidePrice {
    id: number;
    /** Raw tenths of a pound, `ride.price[0]`. */
    price: number;
}

/**
 * Everything the recommendation needs, gathered from live game state by the
 * caller. All money fields are RAW TENTHS OF A POUND, matching the plugin API
 * directly - never converted to real pounds here.
 */
export interface MarketingSignals {
    /** Raw tenths of a pound. */
    cash: number;
    /** Never spend below this floor, same pattern as AMENITY_MIN_CASH elsewhere in this project. */
    cashFloor: number;
    guests: number;
    suggestedGuestMaximum: number;
    /**
     * `scenario.objective.guests` when the objective is guest-count-related, else
     * null. See marketing-research.md's second refinement: `suggestedGuestMaximum`
     * has no relationship to the scenario's win condition, so a plugin that treats
     * it as a hard ceiling can fight the player's own objective.
     */
    guestCountObjective: number | null;
    /**
     * When true, the game itself intends campaigns to push guests past
     * `suggestedGuestMaximum` (see the d.ts comment on that field) - the crowding
     * guard does not apply in this scenario type.
     */
    difficultGuestGeneration: boolean;
    /** Raw tenths of a pound. */
    entranceFee: number;
    entranceFeeUnlocked: boolean;
    ridePricesUnlocked: boolean;
    openRidePrices: OpenRidePrice[];
    hasOpenFoodOrDrinkStall: boolean;
    /** `park.getFlag("forbidMarketingCampaigns")`. */
    forbidden: boolean;
    /**
     * Weeks remaining per campaign type, from the PLUGIN'S OWN tracked state - the
     * game exposes no way to read active campaigns at all (marketing-research.md).
     * 0 (or absent) means not currently running.
     */
    activeWeeksRemaining: Partial<Record<CampaignType, number>>;
}

export interface CampaignRecommendation {
    type: CampaignType;
    /** Ride id for RIDE/RIDE_FREE, otherwise null. FOOD_OR_DRINK_FREE's shop item is resolved later (Phase 4) - not yet a signal this module has. */
    item: number | null;
    /** This park's actual effective probability (post-penalty) out of 65536. */
    effectiveProbability: number;
    costPerGuest: number;
    reason: string;
}

/** The ceiling to compare `guests` against - see the second refinement above. */
function effectiveGuestCeiling(signals: MarketingSignals): number {
    return Math.max(signals.suggestedGuestMaximum, signals.guestCountObjective ?? 0);
}

function isCrowded(signals: MarketingSignals): boolean {
    if (signals.difficultGuestGeneration) return false;
    return signals.guests >= effectiveGuestCeiling(signals);
}

function isActive(signals: MarketingSignals, type: CampaignType): boolean {
    return (signals.activeWeeksRemaining[type] ?? 0) > 0;
}

/**
 * Best eligible ride for RIDE_FREE, preferring one that clears the £0.30 penalty
 * threshold over the cheapest/first one - a free-ride voucher on a ride priced
 * below the threshold is 1/8 as effective for the same £50/week.
 */
function pickRideForFreeRide(rides: OpenRidePrice[]): OpenRidePrice | null {
    if (rides.length === 0) return null;
    let best = rides[0];
    for (let i = 1; i < rides.length; i++) {
        const aboveThreshold = rides[i].price >= FREE_RIDE_PRICE_THRESHOLD;
        const bestAboveThreshold = best.price >= FREE_RIDE_PRICE_THRESHOLD;
        if (aboveThreshold && !bestAboveThreshold) best = rides[i];
    }
    return best;
}

/**
 * One eligible candidate's effective (post-penalty) probability and chosen item,
 * or null if this campaign type is not currently applicable at all.
 */
function evaluate(type: CampaignType, signals: MarketingSignals): { item: number | null; probability: number } | null {
    switch (type) {
        case CAMPAIGN_PARK_ENTRY_FREE: {
            if (!signals.entranceFeeUnlocked) return null;
            const penalised = signals.entranceFee < FREE_ENTRY_FEE_THRESHOLD;
            return { item: 0, probability: penalised ? BASE_PROBABILITY[type] / PENALTY_DIVISOR : BASE_PROBABILITY[type] };
        }
        case CAMPAIGN_PARK_ENTRY_HALF_PRICE: {
            if (!signals.entranceFeeUnlocked) return null;
            const penalised = signals.entranceFee < HALF_PRICE_ENTRY_FEE_THRESHOLD;
            return { item: 0, probability: penalised ? BASE_PROBABILITY[type] / PENALTY_DIVISOR : BASE_PROBABILITY[type] };
        }
        case CAMPAIGN_RIDE_FREE: {
            if (!signals.ridePricesUnlocked) return null;
            const ride = pickRideForFreeRide(signals.openRidePrices);
            if (ride === null) return null;
            const penalised = ride.price < FREE_RIDE_PRICE_THRESHOLD;
            return { item: ride.id, probability: penalised ? BASE_PROBABILITY[type] / PENALTY_DIVISOR : BASE_PROBABILITY[type] };
        }
        case CAMPAIGN_FOOD_OR_DRINK_FREE: {
            if (!signals.hasOpenFoodOrDrinkStall) return null;
            // Which shop item to give away is not yet resolved from a signal this
            // module has - Phase 4 fills this in when the action is actually issued.
            return { item: null, probability: BASE_PROBABILITY[type] };
        }
        case CAMPAIGN_PARK:
            return { item: 0, probability: BASE_PROBABILITY[type] };
        case CAMPAIGN_RIDE: {
            if (signals.openRidePrices.length === 0) return null;
            return { item: signals.openRidePrices[0].id, probability: BASE_PROBABILITY[type] };
        }
    }
}

export interface CampaignRankingResult {
    /** Every eligible, not-currently-active campaign, best £/guest first. Empty if none qualify or a hard gate (forbidden/cash/crowded) blocks all of them. */
    ranked: CampaignRecommendation[];
    /** Set when a hard gate blocked EVERY campaign outright, before per-type eligibility was even considered. */
    blockedReason: string | null;
}

/**
 * Every campaign worth starting right now, ranked by THIS PARK'S actual effective
 * (post-penalty) cost per guest - not the base table, since a park's entrance fee
 * and ride prices change which campaign is cheapest per guest here.
 *
 * Returns a RANKED LIST, not a single winner: up to 6 campaigns (one per type) can
 * run concurrently with fully independent, additive guest-generation rolls - see
 * marketing-research.md's "multiple campaigns run concurrently" finding. Picking
 * only the single best type would leave cheap, independent guest generation on the
 * table. The caller decides how many of the ranked list to actually start, gated by
 * how much total cash it's willing to commit and the shared crowding guard already
 * applied here.
 */
export function rankCampaigns(signals: MarketingSignals): CampaignRankingResult {
    if (signals.forbidden) {
        return { ranked: [], blockedReason: "forbidden by the local authority" };
    }
    if (signals.cash < signals.cashFloor) {
        return { ranked: [], blockedReason: "cash below reserve floor" };
    }
    if (isCrowded(signals)) {
        return { ranked: [], blockedReason: "park at guest capacity" };
    }

    const ranked: CampaignRecommendation[] = [];
    for (const type of ALL_CAMPAIGN_TYPES) {
        if (isActive(signals, type)) continue;
        const candidate = evaluate(type, signals);
        if (candidate === null || candidate.probability <= 0) continue;
        const guestsPerWeek = expectedGuestsPerWeek(candidate.probability);
        const cpg = guestsPerWeek > 0 ? WEEKLY_COST[type] / guestsPerWeek : Infinity;
        ranked.push({
            type,
            item: candidate.item,
            effectiveProbability: candidate.probability,
            costPerGuest: cpg,
            reason: "eligible for this park's current pricing",
        });
    }
    ranked.sort((a, b) => a.costPerGuest - b.costPerGuest);

    return { ranked, blockedReason: ranked.length === 0 ? "no eligible campaign right now" : null };
}

// ---------------------------------------------------------------------------
// Phase 5: before/after attribution - the actual proof-of-value gate.
//
// Reuses the shape (and the fix) of `queues.ts`'s `createInterventionTracker`,
// generalised for a park-wide signal (guests) rather than a per-ride one (queue
// minutes). The one thing carried over deliberately: `before` is captured ONCE,
// at the moment a start is recorded, never recomputed later from trimmed
// history. That was a real bug in the queue tracker (fixed 2026-09-20) - the
// same failure mode applies here just as easily, so this tracker is built with
// the fix from day one rather than discovering it the same way twice.
//
// UNLIKE `queues.ts`'s tracker, this one's internal state is exported via
// `snapshot()`/restorable via `createAttributionTracker(initial)` so the caller
// can persist it in park storage. `queues.ts`'s in-memory-only scope was an
// accepted limitation there because its evidence only needs to survive a few
// days within one sitting. It does NOT fit here: a campaign's full 2-12 week
// run realistically spans many park reloads, and this project's own measured
// telemetry (2026-09-20 session) lost the first 5 of 7 campaigns' evidence to
// exactly this - the tracker reset before their "after" windows ever completed.
// ---------------------------------------------------------------------------

/** Days of history compared on each side of a campaign start. */
export const ATTRIBUTION_WINDOW_DAYS = 7;
const MAX_HISTORY_DAYS = ATTRIBUTION_WINDOW_DAYS * 3;
/** Bounds memory; a handful of campaigns per session is the expected shape. */
const MAX_TRACKED_STARTS = 12;

export interface GuestSample { day: number; guests: number; }
export interface StartRecord { type: CampaignType; day: number; before: number | null; }

/** Plain-data snapshot of a tracker's internal state, for persisting in park storage. */
export interface AttributionSnapshot {
    history: GuestSample[];
    starts: StartRecord[];
}

/** One campaign start's before/after evidence, small enough to log every day. */
export interface CampaignAttribution {
    type: CampaignType;
    startDay: number;
    /** Mean park-wide guests in the window before the start. Null if no observations yet. */
    beforeGuestsPerDay: number | null;
    /** Mean park-wide guests in the window after the start, so far. Null if none observed yet. */
    afterGuestsPerDay: number | null;
    /** afterGuestsPerDay - beforeGuestsPerDay. Null unless both sides have data. */
    deltaGuestsPerDay: number | null;
}

export interface AttributionTracker {
    /** Record one day's total park guest count. Call once per day regardless of any campaign. */
    observe(day: number, guests: number): void;
    /** Record that `type` started on `day`. Freezes the before-window immediately from history already observed. */
    recordStart(type: CampaignType, day: number): void;
    /** Every tracked start's before/after evidence as of `day`. Intended to be logged once per day. */
    summarize(day: number): CampaignAttribution[];
    /** Plain-data copy of internal state - persist this so evidence survives a park reload. */
    snapshot(): AttributionSnapshot;
    reset(): void;
}

function windowMean(history: GuestSample[], from: number, to: number): number | null {
    let sum = 0;
    let n = 0;
    for (let i = 0; i < history.length; i++) {
        const s = history[i];
        if (s.day >= from && s.day <= to) { sum += s.guests; n++; }
    }
    return n === 0 ? null : Math.round((sum / n) * 10) / 10;
}

/**
 * `initial`, when given, restores a snapshot saved before the last reload -
 * see the header above for why this matters here specifically.
 */
export function createAttributionTracker(initial?: AttributionSnapshot): AttributionTracker {
    let history: GuestSample[] = initial ? initial.history.slice() : [];
    let starts: StartRecord[] = initial ? initial.starts.slice() : [];

    function observe(day: number, guests: number): void {
        history.push({ day, guests });
        const floor = day - MAX_HISTORY_DAYS;
        while (history.length > 0 && history[0].day < floor) history.shift();
    }

    function recordStart(type: CampaignType, day: number): void {
        // Computed HERE, once, from history already observed - not recomputed later
        // from whatever `history` happens to still contain. See the header above.
        const before = windowMean(history, day - ATTRIBUTION_WINDOW_DAYS, day - 1);
        starts.push({ type, day, before });
        if (starts.length > MAX_TRACKED_STARTS) starts.shift();
    }

    function summarize(day: number): CampaignAttribution[] {
        return starts.map((s) => {
            const after = windowMean(history, s.day + 1, Math.min(day, s.day + ATTRIBUTION_WINDOW_DAYS));
            const delta = (s.before !== null && after !== null) ? Math.round((after - s.before) * 10) / 10 : null;
            return {
                type: s.type,
                startDay: s.day,
                beforeGuestsPerDay: s.before,
                afterGuestsPerDay: after,
                deltaGuestsPerDay: delta,
            };
        });
    }

    function snapshot(): AttributionSnapshot {
        return { history: history.slice(), starts: starts.slice() };
    }

    function reset(): void {
        history = [];
        starts = [];
    }

    return { observe, recordStart, summarize, snapshot, reset };
}

// --- #74: auto-start only with headroom, and only while campaigns pay for themselves ----------
//
// The #63 study (10 parks, 60 d) found auto-started campaigns bought guests the parks could not
// hold comfortably (happiness worse in the 4 parks with the biggest guest gains, 'crowded'
// thoughts up) and did not earn their cost back. These rules gate AUTO starts only; the
// manual Start buttons are unchanged.

/** Auto-start only while guests are below this share of the guest ceiling. */
export const AUTO_HEADROOM_SHARE = 0.8;
/** Days of income history needed before a batch can be judged (the "before" rate). */
export const PAYBACK_BASELINE_DAYS = 7;
/** After a batch that did not pay for itself, no auto starts for this many days. */
export const PAYBACK_COOLDOWN_DAYS = 56;

/** Room for more guests: below AUTO_HEADROOM_SHARE of the ceiling, even in difficult-guest parks. */
export function hasHeadroom(signals: MarketingSignals): boolean {
    return signals.guests < AUTO_HEADROOM_SHARE * effectiveGuestCeiling(signals);
}

/** One day's cumulative park income (raw tenths), for the payback check. */
export interface IncomeSample { day: number; income: number; }

/** Mean daily income over the last `days` days of history, or null with too little history. */
export function dailyIncomeRate(history: IncomeSample[], days: number): number | null {
    if (history.length < days + 1) return null;
    const a = history[history.length - 1 - days], b = history[history.length - 1];
    return (b.income - a.income) / (b.day - a.day);
}

/** A batch of campaigns auto-started on one day, judged once the longest has run. */
export interface AutoBatch {
    startDay: number;
    /** Lump-sum cost of the batch, raw tenths. */
    cost: number;
    /** Cumulative income on the start day. */
    incomeAtStart: number;
    /** Mean daily income over the PAYBACK_BASELINE_DAYS before the start. */
    dailyIncomeBefore: number;
    /** Days the batch runs (weeks x 7). */
    days: number;
}

/**
 * Income above the pre-campaign rate over the batch's run, and whether it covered the cost.
 * Null until the batch has run its full length.
 */
export function judgeBatch(batch: AutoBatch, day: number, incomeNow: number): { extra: number; paid: boolean } | null {
    const elapsed = day - batch.startDay;
    if (elapsed < batch.days) return null;
    const extra = incomeNow - batch.incomeAtStart - batch.dailyIncomeBefore * elapsed;
    return { extra, paid: extra >= batch.cost };
}

/**
 * Why auto-start should wait today, or null to go ahead. `pending` is the last batch while it
 * is still running or unjudged; `cooldownUntil` is the day after which a failed batch stops
 * blocking.
 */
export function autoStartHold(
    signals: MarketingSignals, day: number, pending: AutoBatch | null, cooldownUntil: number, hasBaseline: boolean,
): string | null {
    if (pending !== null) return "waiting to judge the last campaigns";
    if (day < cooldownUntil) return "the last campaigns did not pay for themselves";
    if (!hasHeadroom(signals)) return "park near guest capacity";
    if (!hasBaseline) return "measuring income first";
    return null;
}
