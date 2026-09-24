/**
 * Marketing Manager — Phase 6: auto-run.
 *
 * See docs/marketing-research.md for the source-verified mechanics this plugin acts
 * on, and docs/marketing-roadmap.md for the phased build plan. Phase 5's before/after
 * evidence came back directionally positive (confounded by simultaneous starts and
 * organic park growth, but positive) and the call was made to proceed rather than
 * chase a cleaner isolated measurement first - see the roadmap for the caveats.
 *
 * Unlike `queues.ts`'s equivalent tracker in wait-time-optimizer.ts (accepted as
 * in-memory-only there, since its evidence only needs to survive a few days), the
 * attribution tracker here IS persisted to park storage - a campaign's full run
 * spans many realistic play sessions, and an in-memory version already lost 5 of 7
 * campaigns' evidence to a reload in this project's own 2026-09-20 testing.
 */

import { createDebugChannel, diagnosticsCheckbox } from "./debug";
import { boolSetting } from "./settings";
import {
    ALL_CAMPAIGN_TYPES, CAMPAIGN_NAMES, CAMPAIGN_FOOD_OR_DRINK_FREE, CampaignType,
    MIN_WEEKS, MAX_WEEKS, WEEKLY_COST, rankCampaigns, createAttributionTracker,
    CampaignRankingResult, MarketingSignals, AttributionTracker, AttributionSnapshot,
} from "./marketing";

registerPlugin({
    name: "Marketing Manager",
    version: __PLUGIN_VERSION__,
    authors: ["MattT"],
    type: "local",
    licence: "MIT",
    targetApiVersion: 87,
    main(): void {
        const PLUGIN_VERSION = __PLUGIN_VERSION__;
        const dbg = createDebugChannel("marketing-manager");
        const storage: Configuration = context.getParkStorage();
        const settings = {
            autoManage: boolSetting(storage, "autoManage", false),
        };

        // Starting point only - no telemetry has justified a specific figure yet.
        // Same reserve-floor pattern as AMENITY_MIN_CASH/FACILITY_MIN_CASH in
        // trash-manager.ts: never let this plugin's own suggestions read as
        // affordable right down to the park's last pound.
        const MARKETING_MIN_CASH = 1_000 * 10; // £1,000, raw tenths

        // Per-pass budget for AUTO-STARTED campaigns only - manual button presses
        // are never limited by this. Same reasoning as trash-manager.ts's
        // AMENITY_MAX_PLACE / hireCount caps elsewhere in this project: without a
        // cap, enabling auto-manage on a park that's eligible for all 5-6 campaign
        // types at once would issue that many lump-sum `parkmarketing` actions in a
        // single interval.day tick. Starting point only, not yet measured against a
        // real session.
        const AUTO_CASH_BUDGET_PER_PASS = 2_000 * 10; // £2,000, raw tenths

        function isAutoManage(): boolean {
            return settings.autoManage.get();
        }

        // RIDE_TYPE_FOOD_STALL=28 and RIDE_TYPE_DRINK_STALL=30 are the same
        // source-verified constants trash-manager.ts uses (Ride.h, anchored on
        // RIDE_TYPE_DRINK_STALL=30 / RIDE_TYPE_TOP_SPIN=40 so the count cannot
        // drift) - restated here rather than imported, since trash-manager.ts does
        // not export them.
        const RIDE_TYPE_FOOD_STALL = 28;
        const RIDE_TYPE_DRINK_STALL = 30;

        // Scenario objective types where a guest-count target should raise the
        // effective crowding ceiling above suggestedGuestMaximum - see
        // marketing-research.md's second refinement.
        const GUEST_OBJECTIVE_TYPES: Record<string, true> = { guestsBy: true, guestsAndRating: true };

        // `parkmarketing`'s `type` arg, ADVERTISING_CAMPAIGN_RIDE_FREE / _RIDE.
        const TYPE_RIDE_FREE = 1;
        const TYPE_RIDE = 5;

        let pluginWindow: Window | null = null;
        let weeksToStart = MIN_WEEKS;

        // Persisted (unlike wait-time-optimizer.ts's equivalent, which is fine to
        // reset on reload since its evidence only needs to survive a few days).
        // A campaign's full run realistically spans many reloads, so both the day
        // axis and the attribution tracker's state must survive them, or the
        // "before" evidence a reload happens to catch mid-window is stranded with
        // no "after" ever computed - measured, 2026-09-20: 5 of 7 campaigns
        // started this session lost their evidence to exactly that.
        let dayCounter = storage.get<number>("dayCounter") ?? 0;
        const attribution: AttributionTracker =
            createAttributionTracker(storage.get<AttributionSnapshot>("attribution"));

        function persistAttribution(): void {
            storage.set("dayCounter", dayCounter);
            storage.set("attribution", attribution.snapshot());
        }

        // --- Tracked campaign state ------------------------------------------------
        //
        // The game exposes NO way to read active campaigns at all (marketing-research.md
        // "the hard constraint"). This plugin storage entry is the only record of
        // reality: what it started, for which item, and how many days are left.
        // `daysRemaining` (not weeks) so it can be decremented once per interval.day
        // without needing a separate week-boundary detector - the game itself only
        // exposes day-granularity events to plugins.

        interface TrackedCampaign { item: number | null; daysRemaining: number; }
        type TrackedCampaigns = Partial<Record<CampaignType, TrackedCampaign>>;

        function loadTracked(): TrackedCampaigns {
            return storage.get<TrackedCampaigns>("activeCampaigns") ?? {};
        }
        function saveTracked(t: TrackedCampaigns): void {
            storage.set("activeCampaigns", t);
        }

        /**
         * Daily upkeep: age every tracked campaign down by one day, and drop any
         * whose ride was demolished mid-campaign.
         *
         * `MarketingCancelCampaignsForRide` (Marketing.cpp:266-279) cancels a
         * RIDE/RIDE_FREE campaign automatically when its ride is demolished - the
         * plugin has no other way to find out this happened, so it must re-verify
         * the ride still exists every day, the same "re-fetch after actions that
         * might invalidate state" rule this project applies to stale staff ids.
         */
        function upkeepCampaigns(tracked: TrackedCampaigns): TrackedCampaigns {
            const next: TrackedCampaigns = {};
            for (const type of ALL_CAMPAIGN_TYPES) {
                const entry = tracked[type];
                if (entry === undefined) continue;

                if ((type === TYPE_RIDE_FREE || type === TYPE_RIDE) && entry.item !== null) {
                    if (map.getRide(entry.item) === null) {
                        dbg.count("campaignCancelledRideDemolished");
                        console.log("[Marketing Manager] " + CAMPAIGN_NAMES[type]
                            + " ended early - its ride was demolished.");
                        continue; // dropped, not carried into `next`
                    }
                }

                const daysRemaining = entry.daysRemaining - 1;
                if (daysRemaining <= 0) {
                    dbg.count("campaignCompleted");
                    continue; // finished its run; dropped
                }
                next[type] = { item: entry.item, daysRemaining };
            }
            return next;
        }

        interface OpenRideInfo { id: number; name: string; price: number; }

        /** One scan of the ride list, reused for telemetry, ranking signals, and item resolution below. */
        function scanRides(): { openRides: OpenRideInfo[]; foodOrDrinkStalls: Ride[] } {
            const openRides: OpenRideInfo[] = [];
            const foodOrDrinkStalls: Ride[] = [];

            const rides = map.rides;
            for (let i = 0; i < rides.length; i++) {
                const r = rides[i];
                if (r.status !== "open") continue;
                if (r.classification === "ride") {
                    openRides.push({ id: r.id, name: r.name, price: r.price[0] });
                } else if (r.classification === "stall"
                    && (r.type === RIDE_TYPE_FOOD_STALL || r.type === RIDE_TYPE_DRINK_STALL)) {
                    foodOrDrinkStalls.push(r);
                }
            }
            return { openRides, foodOrDrinkStalls };
        }

        /**
         * Which shop item a FOOD_OR_DRINK_FREE campaign should give away - the
         * primary item of the first open food/drink stall found. `ride.object.shopItem`
         * is the source-verified field for this (openrct2.d.ts RideObject).
         */
        function resolveFoodOrDrinkItem(stalls: Ride[]): number | null {
            if (stalls.length === 0) return null;
            return stalls[0].object.shopItem;
        }

        function buildSignals(
            rideScan: { openRides: OpenRideInfo[]; foodOrDrinkStalls: Ride[] },
            tracked: TrackedCampaigns,
        ): MarketingSignals {
            const unlockAllPrices = park.getFlag("unlockAllPrices");
            const freeParkEntry = park.getFlag("freeParkEntry");

            // Source-verified (Park.cpp:739-763): these two are NOT the same
            // condition. Ride prices are force-unlocked when entry is free (that's
            // the only remaining way to charge guests); entrance-fee control is
            // unlocked when entry is NOT free. Using one flag for both would wrongly
            // gate RIDE_FREE off on a free-entry park where it's actually the only
            // paid campaign type available.
            const entranceFeeUnlocked = unlockAllPrices || !freeParkEntry;
            const ridePricesUnlocked = unlockAllPrices || freeParkEntry;

            const objective = scenario.objective;
            const guestCountObjective = GUEST_OBJECTIVE_TYPES[objective.type] ? objective.guests : null;

            const activeWeeksRemaining: Partial<Record<CampaignType, number>> = {};
            for (const type of ALL_CAMPAIGN_TYPES) {
                const entry = tracked[type];
                if (entry !== undefined) activeWeeksRemaining[type] = Math.ceil(entry.daysRemaining / 7);
            }

            return {
                cash: park.cash,
                cashFloor: MARKETING_MIN_CASH,
                guests: park.guests,
                suggestedGuestMaximum: park.suggestedGuestMaximum,
                guestCountObjective,
                difficultGuestGeneration: park.getFlag("difficultGuestGeneration"),
                entranceFee: park.entranceFee,
                entranceFeeUnlocked,
                ridePricesUnlocked,
                openRidePrices: rideScan.openRides.map((r) => ({ id: r.id, price: r.price })),
                hasOpenFoodOrDrinkStall: rideScan.foodOrDrinkStalls.length > 0,
                forbidden: park.getFlag("forbidMarketingCampaigns"),
                activeWeeksRemaining,
            };
        }

        let lastRanking: CampaignRankingResult = { ranked: [], blockedReason: "not yet computed" };
        let lastTracked: TrackedCampaigns = {};
        let lastFoodOrDrinkStalls: Ride[] = [];

        /**
         * Starts one campaign via the standard query-then-execute pattern: a query
         * failure is silent, an execute failure is checked and counted rather than
         * swallowed - the same rule this project's own api-reference.md states for
         * every game action ("always pass a real callback and check result.error").
         */
        function startCampaign(type: CampaignType, item: number | null, weeks: number): void {
            const args = { type: type, item: item ?? 0, duration: weeks };

            context.queryAction("parkmarketing", args, (q: GameActionResult) => {
                if (q.error && q.error !== 0) {
                    dbg.count("campaignStartRefused");
                    console.log("[Marketing Manager] Cannot start " + CAMPAIGN_NAMES[type] + ": "
                        + (q.errorMessage || "error code " + q.error));
                    return;
                }
                context.executeAction("parkmarketing", args, (result: GameActionResult) => {
                    if (result.error && result.error !== 0) {
                        dbg.count("campaignStartFailed");
                        console.log("[Marketing Manager] Failed to start " + CAMPAIGN_NAMES[type] + ": "
                            + (result.errorMessage || "error code " + result.error));
                        return;
                    }
                    const tracked = loadTracked();
                    tracked[type] = { item, daysRemaining: weeks * 7 };
                    saveTracked(tracked);
                    attribution.recordStart(type, dayCounter);
                    persistAttribution();
                    dbg.count("campaignStarted");
                    console.log("[Marketing Manager] Started " + CAMPAIGN_NAMES[type] + " for " + weeks + " week(s).");
                    refreshWindow();
                });
            });
        }

        /**
         * Auto-starts from the TOP of the ranked list down, not just the single
         * best entry - up to 6 campaigns can run concurrently (marketing-research.md
         * "multiple campaigns run concurrently"), so stopping after one would leave
         * cheap, independent guest generation on the table on a park eligible for
         * several at once.
         *
         * Spends up to `AUTO_CASH_BUDGET_PER_PASS` per call, and never below
         * `rankCampaigns`'s own cash floor - `rankCampaigns` already guarantees
         * `cash >= cashFloor` before returning anything at all, but a single
         * candidate's lump sum could still exceed the surplus above that floor, so
         * both limits are tracked explicitly rather than assumed compatible.
         */
        function autoStartCampaigns(ranked: CampaignRankingResult["ranked"]): void {
            if (!isAutoManage()) return;

            let budgetLeft = AUTO_CASH_BUDGET_PER_PASS;
            let cashLeft = park.cash - MARKETING_MIN_CASH;

            for (const candidate of ranked) {
                const cost = weeksToStart * WEEKLY_COST[candidate.type];
                if (cost > budgetLeft) {
                    dbg.count("autoSkippedBudget");
                    continue;
                }
                if (cost > cashLeft) {
                    dbg.count("autoSkippedCashFloor");
                    continue;
                }

                const item = candidate.type === CAMPAIGN_FOOD_OR_DRINK_FREE
                    ? resolveFoodOrDrinkItem(lastFoodOrDrinkStalls)
                    : candidate.item;
                startCampaign(candidate.type, item, weeksToStart);
                dbg.count("autoStarted");
                budgetLeft -= cost;
                cashLeft -= cost;
            }
        }

        function parkContext(rideScan: { openRides: OpenRideInfo[]; foodOrDrinkStalls: Ride[] }): Record<string, unknown> {
            return {
                cash: park.cash,
                autoManage: isAutoManage(),
                guests: park.guests,
                suggestedGuestMaximum: park.suggestedGuestMaximum,
                guestGenerationProbability: park.guestGenerationProbability,
                entranceFee: park.entranceFee,
                forbidMarketingCampaigns: park.getFlag("forbidMarketingCampaigns"),
                unlockAllPrices: park.getFlag("unlockAllPrices"),
                freeParkEntry: park.getFlag("freeParkEntry"),
                difficultGuestGeneration: park.getFlag("difficultGuestGeneration"),
                scenarioObjectiveType: scenario.objective.type,
                scenarioObjectiveGuests: scenario.objective.guests,
                openRideCount: rideScan.openRides.length,
                openRidePrices: rideScan.openRides,
                openFoodOrDrinkStalls: rideScan.foodOrDrinkStalls.length,
                // Phase 3: the advisory output itself, so it can be checked against
                // real park state changes without needing to open the window.
                rankedCampaigns: lastRanking.ranked.map((r) => ({
                    type: r.type, name: CAMPAIGN_NAMES[r.type], item: r.item,
                    costPerGuest: Math.round(r.costPerGuest * 100) / 100,
                })),
                blockedReason: lastRanking.blockedReason,
                // Phase 4: what's actually running, per the plugin's own tracked state.
                activeCampaigns: ALL_CAMPAIGN_TYPES
                    .filter((t) => lastTracked[t] !== undefined)
                    .map((t) => ({ type: t, name: CAMPAIGN_NAMES[t], daysRemaining: lastTracked[t]!.daysRemaining })),
                // Phase 5: the proof-of-value evidence. beforeGuestsPerDay/afterGuestsPerDay
                // are park-wide daily guest averages either side of each start - compare
                // against marketing-research.md's predicted guests/week (divide by 7) to
                // see whether a campaign is doing anything beyond organic growth.
                campaignAttribution: attribution.summarize(dayCounter).map((a) => ({
                    type: a.type, name: CAMPAIGN_NAMES[a.type], startDay: a.startDay,
                    beforeGuestsPerDay: a.beforeGuestsPerDay, afterGuestsPerDay: a.afterGuestsPerDay,
                    deltaGuestsPerDay: a.deltaGuestsPerDay,
                })),
            };
        }

        function refreshWindow(): void {
            if (!pluginWindow) return;

            const spinner = pluginWindow.findWidget<SpinnerWidget>("spnWeeks");
            if (spinner) spinner.text = String(weeksToStart) + (weeksToStart === 1 ? " week" : " weeks");

            for (let i = 0; i < ALL_CAMPAIGN_TYPES.length; i++) {
                const type = ALL_CAMPAIGN_TYPES[i];
                const label = pluginWindow.findWidget<LabelWidget>("lblRow" + i);
                const button = pluginWindow.findWidget<ButtonWidget>("btnRow" + i);
                if (!label || !button) continue;

                const tracked = lastTracked[type];
                const ranked = lastRanking.ranked.find((r) => r.type === type);

                if (tracked !== undefined) {
                    label.text = CAMPAIGN_NAMES[type] + "  -  running, "
                        + Math.ceil(tracked.daysRemaining / 7) + "w left";
                    button.isDisabled = true;
                } else if (ranked !== undefined) {
                    label.text = CAMPAIGN_NAMES[type] + "  -  £" + Math.round(ranked.costPerGuest * 100) / 100 + "/guest";
                    button.isDisabled = false;
                } else {
                    // The reason is park-wide, so it is shown once on lblBlocked rather
                    // than on every row, where it ran past the label edge (#24).
                    label.text = CAMPAIGN_NAMES[type] + "  -  not eligible";
                    button.isDisabled = true;
                }
            }

            const blocked = pluginWindow.findWidget<LabelWidget>("lblBlocked");
            if (blocked) {
                blocked.text = lastRanking.blockedReason !== null ? "Blocked: " + lastRanking.blockedReason : "";
            }

            const status = pluginWindow.findWidget<LabelWidget>("lblStatus");
            if (status) {
                status.text = isAutoManage()
                    ? "Auto-start ON, up to £" + (AUTO_CASH_BUDGET_PER_PASS / 10) + "/day."
                    : "Manual start only. Before/after is tracked.";
            }
        }

        function openWindow(): void {
            if (pluginWindow) { pluginWindow.bringToFront(); return; }

            const rowWidgets: WidgetDesc[] = [];
            for (let i = 0; i < ALL_CAMPAIGN_TYPES.length; i++) {
                const type = ALL_CAMPAIGN_TYPES[i];
                const y = 50 + i * 20;
                rowWidgets.push(
                    {
                        type: "label", name: "lblRow" + i,
                        x: 8, y: y + 2, width: 224, height: 14,
                        text: CAMPAIGN_NAMES[type] + "  -  ...",
                    },
                    {
                        type: "button", name: "btnRow" + i,
                        x: 236, y: y, width: 56, height: 16,
                        text: "Start",
                        isDisabled: true,
                        onClick: () => {
                            // FOOD_OR_DRINK_FREE's item is resolved fresh at start time
                            // from whichever stall is currently open, rather than
                            // carried in the ranking - the ranked list doesn't track a
                            // shop item for this type (see marketing.ts's `evaluate`).
                            const item = type === CAMPAIGN_FOOD_OR_DRINK_FREE
                                ? resolveFoodOrDrinkItem(lastFoodOrDrinkStalls)
                                : (lastRanking.ranked.find((r) => r.type === type)?.item ?? null);
                            startCampaign(type, item, weeksToStart);
                        },
                    },
                );
            }

            const rowsBottom = 50 + ALL_CAMPAIGN_TYPES.length * 20;

            pluginWindow = ui.openWindow({
                classification: "marketing-manager",
                title: "Marketing Manager v" + PLUGIN_VERSION,
                width: 300,
                height: rowsBottom + 82,
                widgets: [
                    {
                        type: "label", name: "lblStatus",
                        x: 8, y: 18, width: 284, height: 14,
                        text: "Manual start only. Before/after is tracked.",
                    },
                    {
                        type: "label", x: 8, y: 34, width: 140, height: 14,
                        text: "Duration for next start:",
                    },
                    {
                        type: "spinner", name: "spnWeeks",
                        x: 150, y: 32, width: 142, height: 14,
                        text: String(weeksToStart) + " weeks",
                        onIncrement: () => {
                            weeksToStart = Math.min(MAX_WEEKS, weeksToStart + 1);
                            refreshWindow();
                        },
                        onDecrement: () => {
                            weeksToStart = Math.max(MIN_WEEKS, weeksToStart - 1);
                            refreshWindow();
                        },
                    },
                    ...rowWidgets,
                    {
                        type: "label", name: "lblBlocked",
                        x: 8, y: rowsBottom + 6, width: 284, height: 14,
                        text: "",
                    },
                    {
                        type: "checkbox", name: "chkAutoManage",
                        x: 8, y: rowsBottom + 24, width: 284, height: 14,
                        text: "Auto-start eligible campaigns",
                        tooltip: "Starts campaigns from the ranked list above, best value first, up to £"
                            + (AUTO_CASH_BUDGET_PER_PASS / 10) + " committed per day and never below the £"
                            + (MARKETING_MIN_CASH / 10) + " cash reserve. Never starts a second campaign of a "
                            + "type already running. Off by default - this spends real money on its own.",
                        isChecked: isAutoManage(),
                        onChange: (checked: boolean) => {
                            settings.autoManage.set(checked);
                            refreshWindow();
                        },
                    },
                    diagnosticsCheckbox(8, rowsBottom + 42, 284),
                ],
                onClose: () => { pluginWindow = null; },
            });

            refreshWindow();
        }

        context.subscribe("interval.day", () => {
            dayCounter++;
            attribution.observe(dayCounter, park.guests);
            persistAttribution();

            lastTracked = upkeepCampaigns(loadTracked());
            saveTracked(lastTracked);

            const rideScan = dbg.time("day.scanRides", scanRides);
            lastFoodOrDrinkStalls = rideScan.foodOrDrinkStalls;
            const signals = buildSignals(rideScan, lastTracked);
            lastRanking = dbg.time("day.rankCampaigns", () => rankCampaigns(signals));
            dbg.time("day.autoStart", () => autoStartCampaigns(lastRanking.ranked));
            refreshWindow();
            dbg.flushStats(parkContext(rideScan));
        });

        if (typeof ui === "undefined") return;
        ui.registerMenuItem("Marketing Manager", openWindow);
    },
});
