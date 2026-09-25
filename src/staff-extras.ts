/**
 * Staff Extras — entertainers (P2).
 *
 * ## Why this plugin exists, and why security guards are not in it
 *
 * P2 covered two untouched staff types. Security guards were closed without code:
 * `brokenBins` measured 0 in every one of 528 telemetry records ever taken, and
 * "vandal" never appears in `park.problems` across either park in `tools/rct-debug.log`.
 * There is no signal to act on, so nothing was built for them.
 *
 * Entertainers are different. `Staff::entertainerUpdateNearbyPeeps()`
 * (`gamesrc/OpenRCT2/src/openrct2/entity/Staff.cpp:889-933`) gives a queuing guest
 * within 3 tiles `happinessTarget += 3` and `timeInQueue -= 200`, and the give-up check
 * (`Guest.cpp:5729-5739`) requires BOTH `timeInQueue >= 4300` and `happiness <= 65` — so
 * one hit removes ~4.7% of the whole patience budget while simultaneously working the
 * other half of the same gate. `queuingAges` (`timeInQueue >= 3500`, `Guest.cpp:5684`)
 * peaked at 67 guests against `crowded` at 96 in the telemetry, so guests here are
 * demonstrably in the danger zone this mechanic targets. See `entertainer-targeting.ts`
 * for the full citation trail and the deliberately narrow scope (a fixed radius around
 * each targeted ride's station, not traced queue geometry).
 *
 * ## Mechanism only
 *
 * All targeting and staffing-count decisions live in the pure module
 * `entertainer-targeting.ts` (ride selection, patrol rectangles) and the shared
 * `staffing.ts` closed-loop controller (headcount), reusing it with `ENTERTAINER_THRESHOLDS`
 * — never the litter defaults, which would silently break it (see `staffing.ts` header).
 * This file only reads game state, calls those modules, and issues the resulting
 * `staffhire` / `stafffire` / `staffsetpatrolarea` actions.
 *
 * Off by default (rule 6): entertainers cost GBP 60/month each (`Staff.cpp:2645`) and
 * this plugin can hire up to `MAX_TARGETED_ENTERTAINERS`, so auto-management is behind
 * an explicit checkbox with the cost stated in its tooltip.
 */

import { createDebugChannel, diagnosticsCheckbox } from "./debug";
import { boolSetting } from "./settings";
import {
    selectEntertainerTargets, censusQueues, entertainerStaffingSignals,
    ENTERTAINER_THRESHOLDS, EntertainerTarget, RideQueueSignal, MAX_TARGETED_ENTERTAINERS,
} from "./entertainer-targeting";
import { createStaffingController, StaffingDecision } from "./staffing";
import { createStaffHirer } from "./staff-hiring";
import { createDeferredActions } from "./deferred";

registerPlugin({
    name: "Staff Extras",
    version: __PLUGIN_VERSION__,
    authors: ["MattT"],
    type: "local",
    licence: "MIT",
    targetApiVersion: 87,
    main(): void {
        const PLUGIN_VERSION = __PLUGIN_VERSION__;
        // Source-verified wage (Staff.cpp:2645): entertainers are GBP 60/month, same
        // tier as handymen and below mechanics.
        const ENTERTAINER_WAGE_PER_MONTH = 60;
        // staffhire action arg, source-verified: 0=handyman, 1=mechanic, 2=security,
        // 3=entertainer.
        const STAFF_TYPE_ENTERTAINER = 3;
        // StaffOrders bitmask only applies to handyman (0) / mechanic (1) staffTypes
        // per @openrct2/types' own doc comment; entertainers ignore it, so 0 is correct,
        // not merely "unset".
        const ENTERTAINER_ORDERS = 0;
        // StaffSetPatrolAreaMode: set=0, unset=1, clearAll=2 (StaffSetPatrolAreaAction.h).
        const PATROL_MODE_SET = 0;
        const PATROL_MODE_CLEAR_ALL = 2;
        const MAX_WATCH_LIST = 5;


        const storage: Configuration = context.getParkStorage();
        const settings = {
            autoManage: boolSetting(storage, "autoManageEntertainers", false),
        };
        const dbg = createDebugChannel("staff-extras");

        // Shared hire/fire; see staff-hiring.ts. No backoff: an entertainer refusal is a
        // costume problem (see entertainerCostume below), not the entity budget.
        const hirer = createStaffHirer({
            staffType: STAFF_TYPE_ENTERTAINER,
            orders: ENTERTAINER_ORDERS,
            noun: "entertainer",
            plugin: "Staff Extras",
            counterPrefix: "entertainer",
            backoffDays: 0,
            execute: (action, args, cb) => context.executeAction(action, args, cb),
            count: (name, n) => dbg.count(name, n),
        });

        function getAutoManage(): boolean {
            return settings.autoManage.get();
        }

        // Closed-loop entertainer staffing, reusing the controller proven on handymen
        // and mechanics — but with ENTERTAINER_THRESHOLDS, calibrated to the queue-minute
        // signal, not the litter-piece or broken-ride-day signals those thresholds were
        // built for. See entertainer-targeting.ts header for the mapping.
        const entertainerStaffing = createStaffingController(0, ENTERTAINER_THRESHOLDS);
        let entertainerStaffingSeeded = false;
        let lastStaffingReason = "";
        let lastDecision: StaffingDecision | null = null;

        let pluginWindow: Window | null = null;
        let refreshHandle: number | null = null;

        interface Cache {
            rideCount: number;
            entertainerCount: number;
            targetCount: number;
            eligibleQueues: number;
            urgentQueues: number;
            worstQueueMinutes: number;
            targets: EntertainerTarget[];
        }

        const cache: Cache = {
            rideCount: 0, entertainerCount: 0, targetCount: 0,
            eligibleQueues: 0, urgentQueues: 0, worstQueueMinutes: 0, targets: [],
        };

        /**
         * Highest peep-animation object slot the game will look at
         * (`ObjectLimits.h:37`, `kMaxPeepAnimationsObjects = 255`).
         */
        const MAX_COSTUME_INDEX = 255;

        /**
         * A costume index the game accepts for an entertainer, or null until discovered.
         *
         * **Entertainers are the only staff type whose costume is validated.**
         * `StaffHireNewAction.cpp:85-93` looks `_costumeIndex` up in
         * `findAllPeepAnimationsIndexesForType(AnimationPeepType::entertainer)` and
         * rejects anything absent with "Can't hire new staff / value out of range".
         * Handymen and mechanics skip that check entirely, which is exactly why
         * `costumeIndex: 0` has always worked everywhere else in this project and fails
         * here — slot 0 is not an entertainer animation.
         *
         * The valid slots are object-manager indexes of loaded `PeepAnimationsObject`s
         * whose peep type is `entertainer`. The plugin API exposes no way to read a
         * loaded object's peep type, so the set cannot be computed directly — and it
         * varies by park, since it depends on which objects the scenario loaded.
         *
         * So discover it the way this project discovers every other unreadable range:
         * `queryAction` is silent and raises no error window, and `staffhire`'s Query
         * performs the costume check, so a query that succeeds proves the index is
         * valid without hiring anyone. Cached once found, because the loaded object set
         * does not change mid-park.
         */
        let entertainerCostume: number | null = null;
        let costumeSearchDone = false;

        /**
         * Finds a usable costume index, then runs `then`.
         *
         * Silent throughout: probes are queries, so a player never sees the failures.
         */
        function withCostume(then: (costume: number) => void): void {
            if (entertainerCostume !== null) { then(entertainerCostume); return; }
            if (costumeSearchDone) return;   // searched already and found nothing

            let index = 0;

            function tryNext(): void {
                if (index > MAX_COSTUME_INDEX) {
                    // No entertainer animation object is loaded in this park at all.
                    costumeSearchDone = true;
                    dbg.count("entertainerNoCostume");
                    console.log("[Staff Extras] No entertainer costume is available in " +
                        "this park, so entertainers cannot be hired.");
                    return;
                }
                const candidate = index;
                index++;

                context.queryAction("staffhire", {
                    autoPosition: true,
                    staffType: STAFF_TYPE_ENTERTAINER,
                    costumeIndex: candidate,
                    staffOrders: ENTERTAINER_ORDERS,
                }, function (q: GameActionResult): void {
                    if (q.error && q.error !== 0) { tryNext(); return; }
                    entertainerCostume = candidate;
                    costumeSearchDone = true;
                    dbg.count("entertainerCostumeFound");
                    then(candidate);
                });
            }

            tryNext();
        }

        function getEntertainers(): Entertainer[] {
            return map.getAllEntities("staff").filter(
                (s: Staff): s is Entertainer => s.staffType === "entertainer"
            );
        }

        /**
         * Staff ids of entertainers THIS PLUGIN hired. Only these may ever be fired.
         *
         * **This asymmetry is not optional, and entertainers need it more than any other
         * staff type.** Handymen and mechanics are fungible — one sweeps litter exactly
         * like another, so firing whichever the roster hands back is harmless. An
         * entertainer is not fungible: players place them deliberately, in a chosen
         * COSTUME, next to a themed ride. Firing a hand-placed pirate standing by the
         * pirate ship destroys a decision the player made, and it cannot be undone —
         * re-hiring gives a fresh entertainer that this plugin would costume as index 0.
         *
         * Same rule the amenity planner already enforces for benches and bins, and the
         * reason the facility builder never demolishes at all: **only ever remove what
         * you placed.**
         *
         * Player-hired entertainers still COUNT toward coverage — they are doing the job
         * whoever placed them intended — they are simply never candidates for firing.
         */
        type OwnedMap = Record<string, true>;

        function loadOwned(): OwnedMap {
            const raw = storage.get<OwnedMap>("ourEntertainers");
            return raw !== undefined && raw !== null ? raw : {};
        }

        function saveOwned(owned: OwnedMap): void {
            storage.set("ourEntertainers", owned);
        }

        /**
         * Drops ids that no longer exist, so the map cannot grow without bound as staff
         * are dismissed by hand.
         *
         * Stale ids are the bug class that produced "Invalid parameter / Staff not
         * found" in the handyman code: an id captured before a fire, then reused.
         */
        function pruneOwned(entertainers: Entertainer[]): OwnedMap {
            const owned = loadOwned();
            const live: OwnedMap = {};
            let changed = false;
            for (let i = 0; i < entertainers.length; i++) {
                const id = entertainers[i].id;
                if (id === null) continue;
                if (owned[String(id)]) live[String(id)] = true;
            }
            for (const key in owned) {
                if (!live[key]) { changed = true; break; }
            }
            if (changed) saveOwned(live);
            return live;
        }

        /**
         * Worst queue-minute reading per open ride, with the coordinates of whichever
         * station posted it — that station is the front of the worst queue, so it is
         * where a patrolling entertainer does the most good.
         */
        function collectQueueSignals(): RideQueueSignal[] {
            const out: RideQueueSignal[] = [];
            const rides = map.rides.filter((r: Ride) => r.classification === "ride" && r.status === "open");
            for (let i = 0; i < rides.length; i++) {
                const r = rides[i];
                let worst = 0;
                let sx = 0, sy = 0, found = false;
                // Read `stations` ONCE. It is a getter that rebuilds its array on every
                // access, and the loop previously touched it twice per iteration (the
                // length test and the index). The wait-time optimizer reads it once per
                // ride and costs 2ms for the same work.
                const stations = r.stations;
                for (let j = 0; j < stations.length; j++) {
                    const st = stations[j];
                    if (st.queueTime > worst || !found) {
                        // Only trust a station with a real entrance position. A ride
                        // that never had this station built still reports a station
                        // slot with start.x < 0 (kLocationNull-derived), which would
                        // otherwise produce a nonsense patrol rectangle at the map edge.
                        if (st.start && st.start.x >= 0) {
                            worst = st.queueTime;
                            sx = st.start.x;
                            sy = st.start.y;
                            found = true;
                        }
                    }
                }
                if (!found) { dbg.count("ridesSkippedNoStation"); continue; }
                out.push({ rideId: r.id, name: r.name, queueMinutes: worst, stationX: sx, stationY: sy });
            }
            return out;
        }

        /**
         * Real seconds between cache refreshes.
         *
         * **Measured 2026-09-20: this pass cost 206ms every in-game day** on a park with
         * only 11 rides and 4 entertainers, while the mechanic manager's structurally
         * identical pass cost 0ms on the same park. That is ~40x the per-day budget in
         * docs/performance.md and it is the lag the player reported.
         *
         * The root cause is not yet identified — the sub-timings below exist to find it,
         * because reading the code did not. What IS certain is that entertainer targeting
         * does not need refreshing every in-game day: queue pressure moves over days, and
         * at fast-forward an in-game day is a fraction of a second. So the cost is bounded
         * here regardless of what turns out to be behind it.
         */
        const CACHE_COOLDOWN_MS = 15_000;
        let lastCacheRefresh = 0;
        let cachedEntertainers: Entertainer[] = [];

        function updateCache(force: boolean): Entertainer[] {
            const now = Date.now();
            if (!force && now - lastCacheRefresh < CACHE_COOLDOWN_MS) {
                dbg.count("cacheReused");
                return cachedEntertainers;
            }
            lastCacheRefresh = now;

            // Sub-timings: the aggregate said 206ms but not WHICH call. Every phase here
            // is individually cheap on paper, which is precisely why it needs measuring
            // rather than reasoning about.
            const signals = dbg.time("cache.queueSignals", collectQueueSignals);
            const entertainers = dbg.time("cache.entertainers", getEntertainers);
            cachedEntertainers = entertainers;
            const census = censusQueues(signals);

            cache.rideCount = signals.length;
            cache.entertainerCount = entertainers.length;
            cache.eligibleQueues = census.eligibleCount;
            cache.urgentQueues = census.urgentCount;
            cache.worstQueueMinutes = census.worstMinutes;
            cache.targets = selectEntertainerTargets(signals,
                Math.max(cache.entertainerCount, census.eligibleCount));

            return entertainers;
        }

        // --- Game state mutations (only from interval hooks) ---

        function hireToTarget(entertainers: Entertainer[], target: number): boolean {
            const owned = pruneOwned(entertainers);
            const diff = target - entertainers.length;

            if (diff > 0) {
                withCostume(function (costume: number): void {
                    for (let i = 0; i < diff; i++) {
                        hirer.hire(function (peepId: number): void {
                            // Counted HERE, on confirmed success, not optimistically
                            // before the action runs. The previous version reported
                            // `entertainersHired: 15` for a run in which every single
                            // hire was refused for an invalid costume index — a counter
                            // that lies is worse than no counter, because it sends the
                            // next investigation in the wrong direction.
                            dbg.count("entertainersHired");
                            // Remember what we hired, so we know what we may fire later.
                            const owned2 = loadOwned();
                            owned2[String(peepId)] = true;
                            saveOwned(owned2);
                        }, costume);
                    }
                });
                return true;
            }

            if (diff < 0) {
                // Fire ONLY entertainers this plugin hired. A hand-placed one is never a
                // candidate, however overstaffed the park looks.
                const ours: Entertainer[] = [];
                for (let i = 0; i < entertainers.length; i++) {
                    const id = entertainers[i].id;
                    if (id !== null && owned[String(id)]) ours.push(entertainers[i]);
                }

                const wanted = -diff;
                const canFire = wanted < ours.length ? wanted : ours.length;
                if (canFire < wanted) {
                    // The rest of the surplus is the player's own staff. Report it rather
                    // than silently doing nothing, so "why is it still overstaffed?" has
                    // an answer in the log.
                    dbg.count("entertainersProtected", wanted - canFire);
                }
                if (canFire === 0) return false;

                const remaining = loadOwned();
                for (let i = 0; i < canFire; i++) {
                    const id = ours[i].id;
                    if (id === null) continue;
                    hirer.fire(id);
                    delete remaining[String(id)];
                }
                saveOwned(remaining);
                dbg.count("entertainersFired", canFire);
                return true;
            }

            return false;
        }

        /**
         * Assigns each targeted ride's patrol rectangle to one entertainer, round-robin.
         * Entertainers left over once every target has one get their zone cleared, so
         * they roam freely rather than sitting idle in a stale rectangle from a ride
         * that no longer qualifies.
         */
        function assignPatrols(entertainers: Entertainer[], targets: EntertainerTarget[]): void {
            const n = Math.min(entertainers.length, targets.length);
            for (let i = 0; i < n; i++) {
                const e = entertainers[i];
                const t = targets[i];
                if (e.id === null) continue;
                if (map.getEntity(e.id) === null) continue;
                context.executeAction("staffsetpatrolarea", {
                    id: e.id,
                    x1: t.patrol.x1, y1: t.patrol.y1, x2: t.patrol.x2, y2: t.patrol.y2,
                    mode: PATROL_MODE_SET,
                }, () => {});
                dbg.count("patrolAssignments");
            }
            for (let i = n; i < entertainers.length; i++) {
                const e = entertainers[i];
                if (e.id === null) continue;
                if (map.getEntity(e.id) === null) continue;
                context.executeAction("staffsetpatrolarea", {
                    id: e.id, x1: 0, y1: 0, x2: 0, y2: 0, mode: PATROL_MODE_CLEAR_ALL,
                }, () => {});
                dbg.count("patrolClears");
            }
        }

        function parkContext(): Record<string, unknown> {
            return {
                rides: cache.rideCount,
                entertainers: cache.entertainerCount,
                targetEntertainers: cache.targetCount,
                eligibleQueues: cache.eligibleQueues,
                urgentQueues: cache.urgentQueues,
                worstQueueMinutes: cache.worstQueueMinutes,
                autoManage: getAutoManage(),
                adaptiveTarget: entertainerStaffing.target(),
                settling: lastDecision !== null ? lastDecision.settling : 0,
                discoveredFloor: lastDecision !== null ? lastDecision.discoveredFloor : 0,
                entertainerWagesPerMonth: cache.entertainerCount * ENTERTAINER_WAGE_PER_MONTH,
                parkRating: park.rating,
            };
        }

        // Button actions that change game state run on the next tick; see deferred.ts.
        const deferred = createDeferredActions((onTick) => context.subscribe("interval.tick", onTick));
        const requestHireToTarget = deferred.define(() => { hireToTarget(getEntertainers(), cache.targetCount); });
        const requestAssignPatrols = deferred.define(() => assignPatrols(getEntertainers(), cache.targets));

        context.subscribe("interval.day", () => {
            // Check the toggle FIRST. The cache refresh is by far the most expensive
            // thing this plugin does, and a switched-off plugin must cost nothing —
            // it was previously paying the full 206ms every day regardless.
            if (!getAutoManage()) { dbg.flushStats(parkContext()); return; }
            const entertainers = dbg.time("day.updateCache", () => updateCache(false));

            const census = { urgentCount: cache.urgentQueues, eligibleCount: cache.eligibleQueues, worstMinutes: cache.worstQueueMinutes };
            const signals = entertainerStaffingSignals(census, park.rating);

            if (!entertainerStaffingSeeded) {
                entertainerStaffing.seed(entertainers.length);
                entertainerStaffingSeeded = true;
            }
            const decision = dbg.time("day.staffing", () => entertainerStaffing.update(signals));
            lastDecision = decision;
            cache.targetCount = decision.target;
            if (decision.reason !== "" && decision.reason !== lastStaffingReason) {
                lastStaffingReason = decision.reason;
                console.log("[Staff Extras] Adaptive entertainer target now " + decision.target + ": " + decision.reason + ".");
            }

            const rosterChanged = cache.entertainerCount !== decision.target
                && hireToTarget(entertainers, decision.target);
            const liveEntertainers = rosterChanged ? getEntertainers() : entertainers;
            dbg.time("day.assignPatrols", () => assignPatrols(liveEntertainers, cache.targets));
            dbg.flushStats(parkContext());
        });

        // --- UI ---

        function refreshWindow(): void {
            if (!pluginWindow) return;
            const statsLbl = pluginWindow.findWidget<LabelWidget>("lblStats");
            if (statsLbl) {
                // Kept short: the longer wording lost the wage figure off the edge (#24).
                statsLbl.text = "Rides " + cache.rideCount
                    + "  Ent. " + cache.entertainerCount + "/" + cache.targetCount
                    + "  Worst queue " + cache.worstQueueMinutes + "m"
                    + "  £" + (cache.entertainerCount * ENTERTAINER_WAGE_PER_MONTH) + "/mo";
            }
            const lv = pluginWindow.findWidget<ListViewWidget>("lvTargets");
            if (lv) {
                lv.items = cache.targets.length > 0
                    ? cache.targets.slice(0, MAX_WATCH_LIST).map((t: EntertainerTarget) =>
                        t.name + ": " + t.queueMinutes + "m queue")
                    : ["(no queue currently needs an entertainer)"];
            }
        }

        function openWindow(): void {
            if (pluginWindow) { pluginWindow.bringToFront(); return; }
            updateCache(true);   // user opened it; give them current numbers

            pluginWindow = ui.openWindow({
                classification: "staff-extras",
                title: "Staff Extras v" + PLUGIN_VERSION,
                width: 280,
                height: 260,
                widgets: [
                    {
                        type: "label", name: "lblStats",
                        x: 8, y: 28, width: 264, height: 14,
                        text: "Rides " + cache.rideCount + "  Ent. " + cache.entertainerCount
                            + "/" + cache.targetCount
                    },
                    { type: "groupbox", x: 4, y: 44, width: 272, height: 92, text: "Queues Wanting an Entertainer" },
                    {
                        type: "listview", name: "lvTargets",
                        x: 8, y: 58, width: 264, height: 70,
                        items: cache.targets.length > 0
                            ? cache.targets.map((t: EntertainerTarget) => t.name + ": " + t.queueMinutes + "m queue")
                            : ["(no queue currently needs an entertainer)"],
                        canSelect: false, scrollbars: "none"
                    },
                    { type: "groupbox", x: 4, y: 140, width: 272, height: 60, text: "Actions" },
                    {
                        type: "button",
                        x: 8, y: 154, width: 128, height: 16,
                        text: "Hire / Fire to Target",
                        tooltip: "Hire or fire entertainers (GBP " + ENTERTAINER_WAGE_PER_MONTH
                            + "/month each) to the adaptive target, and re-assign patrol zones.",
                        onClick: () => { requestHireToTarget(); requestAssignPatrols(); }
                    },
                    {
                        type: "button",
                        x: 144, y: 154, width: 128, height: 16,
                        text: "Refresh",
                        tooltip: "Recount rides, queues and entertainers",
                        onClick: () => { updateCache(true); refreshWindow(); }
                    },
                    {
                        type: "checkbox", name: "chkAuto",
                        x: 8, y: 178, width: 264, height: 14,
                        text: "Auto-manage entertainers daily  (spends money)",
                        tooltip: "Hires up to " + MAX_TARGETED_ENTERTAINERS + " entertainers at GBP "
                            + ENTERTAINER_WAGE_PER_MONTH + "/month each and patrols them near "
                            + "congested queues (3+ minute posted wait). Off by default.",
                        isChecked: getAutoManage(),
                        onChange: (checked: boolean) => {
                            settings.autoManage.set(checked);
                            entertainerStaffingSeeded = false;
                        }
                    },
                    { type: "label", name: "lblStatus", x: 8, y: 198, width: 264, height: 14, text: "" },
                    diagnosticsCheckbox(8, 218, 264)
                ],
                onClose: () => {
                    pluginWindow = null;
                    if (refreshHandle !== null) {
                        context.clearInterval(refreshHandle);
                        refreshHandle = null;
                    }
                }
            });

            refreshHandle = context.setInterval(refreshWindow, 3000);
        }

        // Deliberately no refresh at startup: it is the most expensive thing here and
        // `openWindow` forces one the moment anyone actually looks. A switched-off
        // plugin should cost nothing at load.

        if (typeof ui === "undefined") return;
        ui.registerMenuItem("Staff Extras", openWindow);
    }
});
