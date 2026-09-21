import {
    CAMPAIGN_PARK_ENTRY_FREE, CAMPAIGN_RIDE_FREE, CAMPAIGN_PARK_ENTRY_HALF_PRICE,
    CAMPAIGN_FOOD_OR_DRINK_FREE, CAMPAIGN_PARK, CAMPAIGN_RIDE,
    WEEKLY_COST, BASE_PROBABILITY, MIN_WEEKS, MAX_WEEKS,
    expectedGuestsPerWeek, costPerGuest, rankCampaigns, createAttributionTracker,
    ATTRIBUTION_WINDOW_DAYS,
} from "./build/marketing.mjs";

let pass = 0, fail = 0;
const ok = (c, m) => { c ? pass++ : (fail++, console.log("FAIL:", m)); };

// --- Phase 0/1 constants -----------------------------------------------------

const types = [
    CAMPAIGN_PARK_ENTRY_FREE, CAMPAIGN_RIDE_FREE, CAMPAIGN_PARK_ENTRY_HALF_PRICE,
    CAMPAIGN_FOOD_OR_DRINK_FREE, CAMPAIGN_PARK, CAMPAIGN_RIDE,
];
ok(JSON.stringify(types) === JSON.stringify([0, 1, 2, 3, 4, 5]), "campaign indices match Marketing.h enum order");
ok(WEEKLY_COST[CAMPAIGN_PARK_ENTRY_FREE] === 50, "free entry costs 50/week");
ok(WEEKLY_COST[CAMPAIGN_PARK] === 350, "general park ads cost 350/week - the most expensive type");
ok(WEEKLY_COST[CAMPAIGN_RIDE] === 200, "ride ads cost 200/week");
ok(MIN_WEEKS === 2 && MAX_WEEKS === 12, "official UI bounds are 2-12 weeks");

for (const t of types) {
    const g = expectedGuestsPerWeek(BASE_PROBABILITY[t]);
    ok(g > 0 && g < 100, `type ${t} expects a plausible guests/week figure, got ${g}`);
}

const parkCost = costPerGuest(CAMPAIGN_PARK);
for (const voucher of [CAMPAIGN_PARK_ENTRY_FREE, CAMPAIGN_RIDE_FREE, CAMPAIGN_PARK_ENTRY_HALF_PRICE, CAMPAIGN_FOOD_OR_DRINK_FREE]) {
    ok(costPerGuest(voucher) < parkCost, `voucher type ${voucher} must be cheaper per guest than general park ads`);
}
const cheapest = types.reduce((best, t) => costPerGuest(t) < costPerGuest(best) ? t : best);
ok(cheapest === CAMPAIGN_PARK_ENTRY_FREE, "free park entry is the most cost-effective campaign at full effectiveness");

// --- Phase 2: rankCampaigns() ------------------------------------------------
//
// Returns a RANKED LIST, not a single winner - up to 6 campaigns (one per type)
// can run concurrently in-game with independent, additive guest generation. See
// marketing-research.md's "multiple campaigns run concurrently" finding.

// A generous, unpenalised, uncrowded park - the baseline every test overrides from.
function baseSignals(overrides = {}) {
    return {
        cash: 100000,          // £10,000
        cashFloor: 5000,       // £500
        guests: 500,
        suggestedGuestMaximum: 1000,
        guestCountObjective: null,
        difficultGuestGeneration: false,
        entranceFee: 400,      // £40 - well above both penalty thresholds
        entranceFeeUnlocked: true,
        ridePricesUnlocked: true,
        openRidePrices: [{ id: 1, price: 50 }, { id: 2, price: 20 }], // £5.00, £2.00 - both above the £0.30 threshold
        hasOpenFoodOrDrinkStall: true,
        forbidden: false,
        activeWeeksRemaining: {},
        ...overrides,
    };
}

// General shape: on the generous baseline, several campaigns come back ranked,
// each a real type from the enum, sorted best £/guest first.
{
    const { ranked, blockedReason } = rankCampaigns(baseSignals());
    ok(blockedReason === null, "generous baseline is not hard-blocked");
    ok(ranked.length > 1, "multiple campaigns are eligible at once, got " + ranked.length);
    for (const r of ranked) ok(types.includes(r.type), "every ranked entry is one of the six real campaign types");
    for (let i = 1; i < ranked.length; i++) {
        ok(ranked[i].costPerGuest >= ranked[i - 1].costPerGuest, "ranked list is sorted best £/guest first");
    }
}

// Forbidden by local authority -> nothing, whatever else looks eligible.
{
    const { ranked, blockedReason } = rankCampaigns(baseSignals({ forbidden: true }));
    ok(ranked.length === 0 && blockedReason !== null, "forbidMarketingCampaigns blocks every campaign");
}

// Cash below the floor -> nothing.
{
    const { ranked, blockedReason } = rankCampaigns(baseSignals({ cash: 1000, cashFloor: 5000 }));
    ok(ranked.length === 0 && blockedReason !== null, "cash below the reserve floor blocks every campaign");
}

// Crowded park (guests >= suggestedGuestMaximum), normal scenario -> nothing.
{
    const { ranked, blockedReason } = rankCampaigns(baseSignals({ guests: 1000, suggestedGuestMaximum: 1000 }));
    ok(ranked.length === 0 && blockedReason !== null, "guests at or above suggestedGuestMaximum blocks every campaign");
}

// Same crowding, but difficultGuestGeneration is on -> the guard does not apply
// (the game itself intends marketing to push past the cap in this scenario type).
{
    const { ranked } = rankCampaigns(baseSignals({
        guests: 1000, suggestedGuestMaximum: 1000, difficultGuestGeneration: true,
    }));
    ok(ranked.length > 0, "difficultGuestGeneration bypasses the crowding guard");
}

// Scenario objective raises the effective ceiling above suggestedGuestMaximum -
// guests sit between the two, so this should NOT count as crowded.
{
    const { ranked } = rankCampaigns(baseSignals({
        guests: 900, suggestedGuestMaximum: 800, guestCountObjective: 1200,
    }));
    ok(ranked.length > 0, "a guest-count objective above suggestedGuestMaximum raises the effective ceiling");
}
// But without that objective, the same guest count IS crowded.
{
    const { ranked } = rankCampaigns(baseSignals({ guests: 900, suggestedGuestMaximum: 800 }));
    ok(ranked.length === 0, "same guest count with no objective override is correctly treated as crowded");
}

// No open rides at all -> RIDE and RIDE_FREE both excluded from the ranking, but
// the voucher/park types unaffected by rides should still appear.
{
    const { ranked } = rankCampaigns(baseSignals({ openRidePrices: [] }));
    ok(!ranked.some(r => r.type === CAMPAIGN_RIDE || r.type === CAMPAIGN_RIDE_FREE), "no open rides excludes RIDE and RIDE_FREE from the ranking");
    ok(ranked.length > 0, "other campaign types remain eligible with no open rides");
}

// No open food/drink stall -> FOOD_OR_DRINK_FREE excluded specifically.
{
    const { ranked } = rankCampaigns(baseSignals({ hasOpenFoodOrDrinkStall: false, openRidePrices: [] }));
    ok(!ranked.some(r => r.type === CAMPAIGN_FOOD_OR_DRINK_FREE), "no open food/drink stall excludes FOOD_OR_DRINK_FREE");
}

// A campaign already running (tracked in the plugin's own state) never appears in
// the ranking, even though it would otherwise be the top pick.
{
    const { ranked } = rankCampaigns(baseSignals({ activeWeeksRemaining: { [CAMPAIGN_PARK_ENTRY_FREE]: 3 } }));
    ok(!ranked.some(r => r.type === CAMPAIGN_PARK_ENTRY_FREE), "an already-active campaign never appears in the ranking");
}

// The core hidden-penalty finding: a cheap entrance fee (<£4) demotes free-entry
// below a campaign not subject to that penalty, even though free-entry has the
// highest BASE probability of all six types.
{
    const { ranked } = rankCampaigns(baseSignals({ entranceFee: 10, openRidePrices: [] })); // £1.00
    ok(ranked[0].type !== CAMPAIGN_PARK_ENTRY_FREE, "a cheap entrance fee (<£4) demotes free-entry out of first place, got type " + ranked[0].type);
    ok(ranked[0].type === CAMPAIGN_FOOD_OR_DRINK_FREE, "free food/drink (no penalty, unaffected by fee) ranks first instead, got type " + ranked[0].type);
}

// RIDE_FREE picks a ride ABOVE the £0.30 threshold over one below it, even if the
// below-threshold ride is listed first.
{
    const { ranked } = rankCampaigns(baseSignals({
        openRidePrices: [{ id: 99, price: 0 }, { id: 42, price: 50 }],
        hasOpenFoodOrDrinkStall: false,
    }));
    const rideFree = ranked.find(r => r.type === CAMPAIGN_RIDE_FREE);
    ok(rideFree !== undefined && rideFree.item === 42, "RIDE_FREE targets the ride above the price threshold, not the free one listed first");
}

// Every open ride priced at £0 (a real park state, seen in this project's own
// telemetry): RIDE_FREE must be fully penalised, never ranked first over an
// unpenalised alternative.
{
    const { ranked } = rankCampaigns(baseSignals({
        openRidePrices: [{ id: 1, price: 0 }, { id: 2, price: 0 }],
    }));
    ok(ranked[0].type !== CAMPAIGN_RIDE_FREE, "RIDE_FREE with every ride at £0 must not rank first");
}

// General park advertising must never rank above an equally-eligible voucher
// campaign on the generous baseline.
{
    const { ranked } = rankCampaigns(baseSignals());
    const parkIdx = ranked.findIndex(r => r.type === CAMPAIGN_PARK);
    const voucherIdx = ranked.findIndex(r => r.type === CAMPAIGN_PARK_ENTRY_FREE);
    ok(parkIdx > voucherIdx, "general park advertising ranks below an equally-eligible voucher campaign");
}

// The whole point of this refactor: on the generous baseline, MULTIPLE campaigns
// should be startable at once, since up to 6 can run concurrently in-game with
// independent, additive guest generation (marketing-research.md).
{
    const { ranked } = rankCampaigns(baseSignals());
    ok(ranked.length >= 4, "at least 4 of the 6 campaign types are simultaneously eligible on the generous baseline, got " + ranked.length);
}

// --- Phase 5: createAttributionTracker() ------------------------------------

// No observations at all before a start -> before is null, not a crash or a zero.
{
    const t = createAttributionTracker();
    t.recordStart(CAMPAIGN_PARK_ENTRY_FREE, 10);
    const [a] = t.summarize(10);
    ok(a.beforeGuestsPerDay === null, "no prior observations -> before is null");
    ok(a.afterGuestsPerDay === null, "no observations yet on start day -> after is null too");
}

// Basic before/after: flat 500 guests/day before, jumps to 600 after.
{
    const t = createAttributionTracker();
    for (let d = 1; d <= 7; d++) t.observe(d, 500);
    t.recordStart(CAMPAIGN_PARK_ENTRY_FREE, 8);
    for (let d = 9; d <= 15; d++) t.observe(d, 600);
    const [a] = t.summarize(15);
    ok(a.beforeGuestsPerDay === 500, "before window averages the flat pre-start guests, got " + a.beforeGuestsPerDay);
    ok(a.afterGuestsPerDay === 600, "after window averages the flat post-start guests, got " + a.afterGuestsPerDay);
    ok(a.deltaGuestsPerDay === 100, "delta is after - before, got " + a.deltaGuestsPerDay);
}

// The core fix, ported from queues.ts's real bug: `before` must stay the SAME
// value across repeated summarize() calls, even as more history is observed and
// old samples get trimmed out of the tracker's internal buffer. It must never
// flicker between a number and null depending on when it's read.
{
    const t = createAttributionTracker();
    for (let d = 1; d <= 5; d++) t.observe(d, 400);
    t.recordStart(CAMPAIGN_RIDE, 6);
    const firstRead = t.summarize(6)[0].beforeGuestsPerDay;
    ok(firstRead === 400, "before captured at record time, got " + firstRead);
    // Push many more days through - far more than the tracker's internal history
    // window - so the pre-start samples would be trimmed if `before` were ever
    // recomputed live instead of frozen.
    for (let d = 7; d <= 7 + ATTRIBUTION_WINDOW_DAYS * 5; d++) t.observe(d, 900);
    const laterRead = t.summarize(7 + ATTRIBUTION_WINDOW_DAYS * 5).find(a => a.type === CAMPAIGN_RIDE).beforeGuestsPerDay;
    ok(laterRead === firstRead, "before stays frozen at " + firstRead + " long after the source samples are trimmed away, got " + laterRead);
}

// Multiple concurrent campaign starts are tracked independently against the same
// shared park-wide guest history - the whole point of this being park-wide
// rather than per-ride.
{
    const t = createAttributionTracker();
    for (let d = 1; d <= 5; d++) t.observe(d, 500);
    t.recordStart(CAMPAIGN_PARK_ENTRY_FREE, 6);
    // Longer than ATTRIBUTION_WINDOW_DAYS so the second start's before-window
    // (which looks back 7 days from its own start day) falls entirely within this
    // 550 period and never touches the original 500 days.
    for (let d = 6; d <= 6 + ATTRIBUTION_WINDOW_DAYS + 2; d++) t.observe(d, 550);
    const secondStartDay = 6 + ATTRIBUTION_WINDOW_DAYS + 3;
    t.recordStart(CAMPAIGN_FOOD_OR_DRINK_FREE, secondStartDay);
    for (let d = secondStartDay; d <= secondStartDay + 4; d++) t.observe(d, 600);
    const results = t.summarize(secondStartDay + 4);
    ok(results.length === 2, "both starts are tracked, got " + results.length);
    const freeEntry = results.find(a => a.type === CAMPAIGN_PARK_ENTRY_FREE);
    const freeFood = results.find(a => a.type === CAMPAIGN_FOOD_OR_DRINK_FREE);
    ok(freeEntry.beforeGuestsPerDay === 500, "first start's before uses only pre-day-6 history");
    ok(freeFood.beforeGuestsPerDay === 550, "second start's before uses the history up to its own start day, not the first start's, got " + freeFood.beforeGuestsPerDay);
}

// snapshot()/restore round-trip: this is the actual fix for the bug found live -
// evidence must survive a park reload, which recreates the tracker from scratch.
{
    const t1 = createAttributionTracker();
    for (let d = 1; d <= 5; d++) t1.observe(d, 500);
    t1.recordStart(CAMPAIGN_PARK_ENTRY_FREE, 6);
    const snap = t1.snapshot();

    // Simulate a reload: a brand new tracker restored from the saved snapshot.
    const t2 = createAttributionTracker(snap);
    ok(t2.summarize(6)[0].beforeGuestsPerDay === 500, "before survives a snapshot/restore round-trip");

    // And it keeps working correctly afterward - "after" can still be computed
    // from observations made only on the restored instance.
    for (let d = 7; d <= 13; d++) t2.observe(d, 700);
    const restored = t2.summarize(13)[0];
    ok(restored.afterGuestsPerDay === 700, "after computes correctly on a restored tracker, got " + restored.afterGuestsPerDay);
    ok(restored.deltaGuestsPerDay === 200, "delta computes correctly on a restored tracker, got " + restored.deltaGuestsPerDay);
}

// A tracker created with no snapshot behaves exactly like the pre-persistence
// default - restoring is opt-in, never required.
{
    const t = createAttributionTracker(undefined);
    ok(t.summarize(1).length === 0, "no snapshot -> starts empty, same as before this feature existed");
}

console.log(`\n${pass} passed, ${fail} failed`);
