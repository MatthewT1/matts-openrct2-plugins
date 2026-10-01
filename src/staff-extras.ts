/**
 * Staff Extras — entertainers (P2).
 *
 * ## Why this plugin exists, and why security guards are not in it
 *
 * P2 covered two untouched staff types. Security guards were closed without code:
 * `brokenBins` measured 0 in every one of 528 telemetry records ever taken, and
 * "vandal" never appears in `park.problems` across either park in `tools/rct-debug.log`.
 * There is no signal to act on, so nothing was built for them. The one exception is
 * #92: the Best Staff award (+25% guest generation while held) needs a guard on the
 * roster, so once the park has 20+ staff and no guard, one is hired (see wantsAwardGuard).
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
 * On by default since #51 (was off under rule 6): entertainers cost GBP 60/month each (`Staff.cpp:2645`) and
 * this plugin can hire up to `MAX_TARGETED_ENTERTAINERS`, so auto-management is behind
 * an explicit checkbox with the cost stated in its tooltip.
 */

import { createDebugChannel, diagnosticsCheckbox, DIAG_ROW } from "./debug";
import { boolSetting } from "./settings";
import { formatMoney } from "./money";
import {
    selectEntertainerTargets, censusQueues, entertainerStaffingSignals,
    ENTERTAINER_THRESHOLDS, EntertainerTarget, RideQueueSignal, MAX_TARGETED_ENTERTAINERS,
    planEntertainerRoster, costumeCandidates, selectStationTargets, matchTargets, targetKey, outsidePatrol, StationSignal, MAX_STATION_ENTERTAINERS,
} from "./entertainer-targeting";
import { findCourts, DEFAULT_COURT_OPTIONS } from "./facilities";
import { createStaffingController, StaffingDecision } from "./staffing";
import { createStaffHirer, wantsAwardGuard, planAwardCrew, awardCrewStatusText, DEFAULT_AWARD_CREW_OPTIONS, HIRE_BACKOFF_DAYS } from "./staff-hiring";
import { createOwnedStaff } from "./staff-ownership";
import { spendGate } from "./cash-gate";
import { createParkNews, newsCheckbox } from "./park-news";
import { EXTRAS_PHRASES } from "./news";
import { createDeferredActions } from "./deferred";
import { createCooldown, ENTERTAINER_CENSUS_TICKS, TICKS_PER_DAY } from "./cooldown";

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
        const STAFF_TYPE_SECURITY = 2;
        // Source-verified wage (Staff.cpp:2654): security guards are GBP 60/month.
        const SECURITY_WAGE_PER_MONTH = 60;
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
            autoManage: boolSetting(storage, "autoManageEntertainers", true),
            awardGuard: boolSetting(storage, "hireAwardGuard", true),
            news: boolSetting(storage, "newsSummaries", true),
        };
        const dbg = createDebugChannel("staff-extras");
        const news = createParkNews("Staff Extras", settings.news, EXTRAS_PHRASES, dbg);

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

        // One guard for the Best Staff award (#92). Orders 0: the bitmask only applies to
        // handymen and mechanics, same as entertainers.
        const guardHirer = createStaffHirer({
            staffType: STAFF_TYPE_SECURITY,
            orders: 0,
            noun: "security guard",
            plugin: "Staff Extras",
            counterPrefix: "guard",
            backoffDays: HIRE_BACKOFF_DAYS,
            execute: (action, args, cb) => context.executeAction(action, args, cb),
            count: (name, n) => dbg.count(name, n),
        });

        // #163: guards hired to hold the headcount at the Best Staff line. Only these are
        // ever fired; the #92 guard above and the player's guards are not in this list.
        const crewGuards = createOwnedStaff(storage, "ourAwardGuards");
        const AWARD_CREW_MIN_CASH = 3_000 * 10; // GBP 3,000: wages recur
        /** The Best Staff line as of the last daily pass, for the window. */
        let awardStatus = "";
        let hadBestStaff = false;

        /** Months the Best Staff award has left, 0 when the park does not hold it. */
        function bestStaffMonths(): number {
            const awards = park.awards;
            for (let i = 0; i < awards.length; i++) {
                if (awards[i].type === "bestStaff") return awards[i].monthsRemaining;
            }
            return 0;
        }

        /** Hires the award guard if the roster needs one. Cheap: one staff list read. */
        function manageAwardGuard(): void {
            if (!settings.awardGuard.get()) { awardStatus = ""; return; }
            const staff = map.getAllEntities("staff");
            const types = staff.map((s: Staff) => s.staffType);
            if (wantsAwardGuard(types)) {
                awardStatus = "Best Staff: hiring the first security guard";
                if (guardHirer.blocked()) { dbg.count("guardSkippedBackoff"); return; }
                guardHirer.hire((peepId: number) => {
                    dbg.count("guardHired");
                    news.add("guardHired", undefined, { type: "peep", id: peepId });
                    console.log("[Staff Extras] Hired a security guard (" + formatMoney(SECURITY_WAGE_PER_MONTH) +
                        "/month) so the Best Staff award becomes possible: it needs every staff type.");
                });
                return;
            }
            manageAwardCrew(staff);
        }

        /** Holds the headcount at the Best Staff line with a few guards of our own (#163). */
        function manageAwardCrew(staff: Staff[]): void {
            const n: Record<string, number> = { handyman: 0, mechanic: 0, security: 0, entertainer: 0 };
            const guardIds: number[] = [];
            for (let i = 0; i < staff.length; i++) {
                const id = staff[i].id;
                if (id === null || guardHirer.firePending(id)) continue;
                n[staff[i].staffType]++;
                if (staff[i].staffType === "security") guardIds.push(id);
            }
            const owned = crewGuards.prune(guardIds);
            const ownedIds = guardIds.filter((id) => owned[String(id)] === true);
            const plan = planAwardCrew({
                handymen: n.handyman, mechanics: n.mechanic, security: n.security, entertainers: n.entertainer,
                guestEntities: map.getAllEntities("guest").length, ownedGuards: ownedIds.length,
            }, DEFAULT_AWARD_CREW_OPTIONS);
            const held = bestStaffMonths();
            awardStatus = awardCrewStatusText(plan, ownedIds.length, held);
            if (held > 0 && !hadBestStaff) {
                dbg.count("bestStaffAwardWon");
                news.add("bestStaffWon");
                console.log("[Staff Extras] The park holds the Best Staff award (" + plan.staff + " staff against a line of "
                    + plan.line + "): 25% more new guests for " + held + " months.");
            }
            hadBestStaff = held > 0;
            // One record a day: the roster against the line, and what we did about it (#163).
            dbg.event("awardCrew", {
                action: plan.action, reason: plan.reason, staff: plan.staff, line: plan.line,
                shortBy: plan.shortBy, target: plan.target, owned: ownedIds.length, awardMonths: held,
                guards: n.security, handymen: n.handyman, mechanics: n.mechanic, entertainers: n.entertainer,
                cash: park.cash,
            });
            dbg.count("crewDay_" + plan.reason);
            if (plan.action === "none") {
                if (ownedIds.length > 0) dbg.count("crewGuardHeld", ownedIds.length);
                return;
            }
            if (plan.action === "fire") {
                const id = ownedIds[ownedIds.length - 1];
                crewGuards.remove(id);
                guardHirer.fire(id);
                dbg.count("crewGuardFired");
                console.log("[Staff Extras] Let an award guard go: the park is past the Best Staff line of " + plan.line + " staff without them.");
                return;
            }
            if (spendGate(park.cash, AWARD_CREW_MIN_CASH, park.getFlag("noMoney"), "build") === "lowCash") {
                dbg.count("crewGuardLowCash");
                awardStatus += ", waiting for " + formatMoney(AWARD_CREW_MIN_CASH);
                return;
            }
            if (guardHirer.blocked()) { dbg.count("crewGuardSkippedBackoff"); return; }
            guardHirer.hire((peepId: number) => {
                crewGuards.add(peepId);
                dbg.count("crewGuardHired");
                news.add("guardHired", undefined, { type: "peep", id: peepId });
                console.log("[Staff Extras] Hired a security guard (" + formatMoney(SECURITY_WAGE_PER_MONTH) +
                    "/month) toward the Best Staff award: it needs " + plan.line + " staff.");
            });
        }

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
            /** Entrance and food-court stations (#68), already included in `targets`. */
            stationCount: number;
        }

        const cache: Cache = {
            rideCount: 0, entertainerCount: 0, targetCount: 0,
            eligibleQueues: 0, urgentQueues: 0, worstQueueMinutes: 0, targets: [], stationCount: 0,
        };

        // --- Stations away from queues (#68) ---

        /** EntranceType::parkEntrance (EntranceElement.h). */
        const ENTRANCE_TYPE_PARK = 2;
        /** RIDE_TYPE_FOOD_STALL, RIDE_TYPE_DRINK_STALL (Ride.h). */
        const FOOD_DRINK_RIDE_TYPES = [28, 30];
        // Park entrances barely ever move, and finding them walks the whole map.
        const entranceCooldown = createCooldown(30 * TICKS_PER_DAY, 5_000);
        let entrances: StationSignal[] = [];

        function findEntrances(): StationSignal[] {
            const out: StationSignal[] = [];
            const size = map.size;
            for (let x = 1; x < size.x - 1; x++) {
                for (let y = 1; y < size.y - 1; y++) {
                    const tile = map.getTile(x, y);
                    for (let i = 0; i < tile.numElements; i++) {
                        const el = tile.getElement(i);
                        if (el.type === "entrance" && (el as EntranceElement).object === ENTRANCE_TYPE_PARK
                            && (el as EntranceElement).sequence === 0) {
                            out.push({ name: "park entrance", x: x * 32, y: y * 32 });
                        }
                    }
                }
            }
            return out;
        }

        /** The park entrance first (one), then food courts, largest first. */
        function collectStations(): StationSignal[] {
            if (entranceCooldown.ready(date.ticksElapsed, Date.now())) entrances = findEntrances();
            const out: StationSignal[] = entrances.slice(0, 1);
            const stalls: Array<{ x: number; y: number }> = [];
            const rides = map.rides;
            for (let i = 0; i < rides.length; i++) {
                if (FOOD_DRINK_RIDE_TYPES.indexOf(rides[i].type) < 0 || rides[i].stations.length === 0) continue;
                const s = rides[i].stations[0].start;
                if (!s || s.x < 0 || s.y < 0) continue;
                stalls.push({ x: s.x >> 5, y: s.y >> 5 });
            }
            const courts = findCourts(stalls, DEFAULT_COURT_OPTIONS);
            for (let i = 0; i < courts.length && out.length < MAX_STATION_ENTERTAINERS; i++) {
                out.push({ name: "food court", x: courts[i].x * 32, y: courts[i].y * 32 });
            }
            return out;
        }

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
         * Probes are queries, so a player never sees the failures, but each refusal is
         * still an ERROR line in the game log (#50). Candidates are ordered so the first
         * query is normally an entertainer object and nothing is refused.
         */
        function withCostume(then: (costume: number) => void): void {
            if (entertainerCostume !== null) { then(entertainerCostume); return; }
            if (costumeSearchDone) return;   // searched already and found nothing

            const candidates = costumeCandidates(
                objectManager.getAllObjects("peep_animations"), MAX_COSTUME_INDEX);
            let next = 0;

            function tryNext(): void {
                if (next >= candidates.length) {
                    // No entertainer animation object is loaded in this park at all.
                    costumeSearchDone = true;
                    dbg.count("entertainerNoCostume");
                    console.log("[Staff Extras] No entertainer costume is available in " +
                        "this park, so entertainers cannot be hired.");
                    return;
                }
                const candidate = candidates[next];
                next++;

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
         * Game time between cache refreshes (was real seconds until #48).
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
         *
         * Only the queue census is cached. The roster itself is read live every day
         * (#54): hiring from a list up to 15 real seconds old re-hired the whole deficit
         * every in-game day at speed 4. The live read measured 0ms (performance.md).
         *
         * Game time (#48): 15 real seconds refreshed every 2 days at speed 1 but every ~9
         * at speed 4. Two days keeps speed 1 as it was. The census measured 2ms (harness
         * --debug, Dynamite Dunes); the 2 s floor is under 2 speed-4 days (~3.3 s).
         */
        const cacheCooldown = createCooldown(ENTERTAINER_CENSUS_TICKS, 2_000);

        function updateCache(force: boolean): void {
            if (force) cacheCooldown.reset();
            if (!cacheCooldown.ready(date.ticksElapsed, Date.now())) {
                dbg.count("cacheReused");
                return;
            }

            // Sub-timings: the aggregate said 206ms but not WHICH call. Every phase here
            // is individually cheap on paper, which is precisely why it needs measuring
            // rather than reasoning about.
            const signals = dbg.time("cache.queueSignals", collectQueueSignals);
            const entertainers = dbg.time("cache.entertainers", getEntertainers);
            const census = censusQueues(signals);

            cache.rideCount = signals.length;
            cache.entertainerCount = entertainers.length;
            cache.eligibleQueues = census.eligibleCount;
            cache.urgentQueues = census.urgentCount;
            cache.worstQueueMinutes = census.worstMinutes;
            // Queues first, stations after: a short roster leaves a station empty, never
            // a long queue (#68). Stations skip spots a queue entertainer already covers.
            const queueTargets = selectEntertainerTargets(signals,
                Math.max(cache.entertainerCount, census.eligibleCount));
            const stations = dbg.time("cache.stations",
                () => selectStationTargets(collectStations(), queueTargets));
            cache.stationCount = stations.length;
            cache.targets = queueTargets.concat(stations);
        }

        // --- Game state mutations (only from interval hooks) ---

        function hireToTarget(entertainers: Entertainer[], target: number): boolean {
            const owned = pruneOwned(entertainers);
            const liveIds: number[] = [];
            for (let i = 0; i < entertainers.length; i++) {
                const id = entertainers[i].id;
                if (id !== null) liveIds.push(id);
            }
            // `entertainers` must be the live roster (#54); the plan clamps to the cap
            // and only ever names entertainers this plugin hired for firing.
            const plan = planEntertainerRoster(target, liveIds, owned);

            if (plan.hire > 0) {
                withCostume(function (costume: number): void {
                    for (let i = 0; i < plan.hire; i++) {
                        hirer.hire(function (peepId: number): void {
                            // Counted HERE, on confirmed success, not optimistically
                            // before the action runs. The previous version reported
                            // `entertainersHired: 15` for a run in which every single
                            // hire was refused for an invalid costume index — a counter
                            // that lies is worse than no counter, because it sends the
                            // next investigation in the wrong direction.
                            dbg.count("entertainersHired");
                            news.add("entertainerHired", undefined, { type: "peep", id: peepId });
                            // Remember what we hired, so we know what we may fire later.
                            const owned2 = loadOwned();
                            owned2[String(peepId)] = true;
                            saveOwned(owned2);
                        }, costume);
                    }
                });
                return true;
            }

            // Fire ONLY entertainers this plugin hired. A hand-placed one is never a
            // candidate, however overstaffed the park looks; the rest of the surplus is
            // reported rather than silently left, so "why is it still overstaffed?" has
            // an answer in the log.
            if (plan.protectedCount > 0) dbg.count("entertainersProtected", plan.protectedCount);
            if (plan.fireIds.length === 0) return false;

            const remaining = loadOwned();
            for (let i = 0; i < plan.fireIds.length; i++) {
                hirer.fire(plan.fireIds[i]);
                news.add("entertainerFired");
                delete remaining[String(plan.fireIds[i])];
            }
            saveOwned(remaining);
            dbg.count("entertainersFired", plan.fireIds.length);
            return true;
        }

        /** target key each entertainer was last sent to, so a reorder doesn't shuffle them. */
        const lastTarget: { [id: number]: string } = {};

        /**
         * A flat, non-queue path tile inside the patrol box, nearest its centre, as game
         * units; null when the box has none.
         */
        function pathTileIn(t: EntertainerTarget): { x: number; y: number; z: number } | null {
            const tx1 = t.patrol.x1 >> 5, ty1 = t.patrol.y1 >> 5, tx2 = t.patrol.x2 >> 5, ty2 = t.patrol.y2 >> 5;
            const cx = (tx1 + tx2) / 2, cy = (ty1 + ty2) / 2;
            let best: { x: number; y: number; z: number } | null = null;
            let bestD = Infinity;
            for (let x = Math.max(tx1, 1); x <= tx2 && x < map.size.x - 1; x++) {
                for (let y = Math.max(ty1, 1); y <= ty2 && y < map.size.y - 1; y++) {
                    const d = Math.max(Math.abs(x - cx), Math.abs(y - cy));
                    if (d >= bestD) continue;
                    const tile = map.getTile(x, y);
                    for (let i = 0; i < tile.numElements; i++) {
                        const el = tile.getElement(i);
                        if (el.type !== "footpath") continue;
                        const fp = el as FootpathElement;
                        if (fp.isQueue || fp.slopeDirection !== null) continue;
                        bestD = d;
                        best = { x: x * 32 + 16, y: y * 32 + 16, z: fp.baseZ };
                        break;
                    }
                }
            }
            return best;
        }

        /**
         * Gives each target in priority order one entertainer (sticky, else nearest) and
         * sets its patrol rectangle. The game never walks staff to a box they stand
         * outside of (Staff.cpp:228-231), so one that is outside is moved onto a path
         * tile in it, once: after that it wanders the box on its own. Entertainers left
         * over once every target has one get their zone cleared, so they roam freely.
         */
        function assignPatrols(entertainers: Entertainer[], targets: EntertainerTarget[]): void {
            // `hirer.firePending`: an entertainer fired this tick still exists under a
            // server, where actions run next tick; patrolling it fails (#136).
            const live: Entertainer[] = [];
            const pos: Array<{ id: number; x: number; y: number }> = [];
            for (let i = 0; i < entertainers.length; i++) {
                const e = entertainers[i];
                if (e.id === null) continue;
                const ent = map.getEntity(e.id);
                if (ent === null) continue;
                if (hirer.firePending(e.id)) { dbg.count("patrolSkippedFirePending"); continue; }
                live.push(e);
                pos.push({ id: e.id, x: ent.x, y: ent.y });
            }
            const match = matchTargets(pos, targets, lastTarget);
            for (let i = 0; i < live.length; i++) {
                const id = pos[i].id;
                if (match[i] < 0) {
                    context.executeAction("staffsetpatrolarea", {
                        id, x1: 0, y1: 0, x2: 0, y2: 0, mode: PATROL_MODE_CLEAR_ALL,
                    }, () => {});
                    delete lastTarget[id];
                    dbg.count("patrolClears");
                    continue;
                }
                const t = targets[match[i]];
                context.executeAction("staffsetpatrolarea", {
                    id,
                    x1: t.patrol.x1, y1: t.patrol.y1, x2: t.patrol.x2, y2: t.patrol.y2,
                    mode: PATROL_MODE_SET,
                }, () => {});
                dbg.count("patrolAssignments");
                lastTarget[id] = targetKey(t);
                let moved = false;
                if (outsidePatrol(pos[i].x, pos[i].y, t.patrol)) {
                    const spot = pathTileIn(t);
                    const ent = map.getEntity(id);
                    if (spot !== null && ent !== null) {
                        ent.x = spot.x;
                        ent.y = spot.y;
                        ent.z = spot.z;
                        moved = true;
                        dbg.count("entertainersPlaced");
                    } else {
                        dbg.count("entertainerPlaceNoPath");
                    }
                }
                dbg.event("entertainerPatrol", {
                    id, at: [pos[i].x >> 5, pos[i].y >> 5], target: t.name, moved,
                    rect: [t.patrol.x1 >> 5, t.patrol.y1 >> 5, t.patrol.x2 >> 5, t.patrol.y2 >> 5],
                });
            }
        }


        function parkContext(): Record<string, unknown> {
            return {
                rides: cache.rideCount,
                entertainers: cache.entertainerCount,
                targetEntertainers: cache.targetCount,
                stations: cache.stationCount,
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
            news.flush(); // yesterday's hires/fires (#124)
            dbg.time("day.awardGuard", manageAwardGuard);
            // Check the toggle FIRST. The cache refresh is by far the most expensive
            // thing this plugin does, and a switched-off plugin must cost nothing —
            // it was previously paying the full 206ms every day regardless.
            if (!getAutoManage()) { dbg.flushStats(parkContext()); return; }
            dbg.time("day.updateCache", () => updateCache(false));
            // Live roster every day (#54); the cache above is only the queue census.
            const entertainers = getEntertainers();
            cache.entertainerCount = entertainers.length;

            const census = { urgentCount: cache.urgentQueues, eligibleCount: cache.eligibleQueues, worstMinutes: cache.worstQueueMinutes };
            const signals = entertainerStaffingSignals(census, park.rating);

            if (!entertainerStaffingSeeded) {
                entertainerStaffing.seed(entertainers.length);
                entertainerStaffingSeeded = true;
            }
            const decision = dbg.time("day.staffing", () => entertainerStaffing.update(signals));
            lastDecision = decision;
            // The controller sizes the queue roster; stations are added on top (#68).
            cache.targetCount = decision.target + cache.stationCount;
            if (decision.reason !== "" && decision.reason !== lastStaffingReason) {
                lastStaffingReason = decision.reason;
                console.log("[Staff Extras] Adaptive entertainer target now " + decision.target + ": " + decision.reason + ".");
            }

            const rosterChanged = hireToTarget(entertainers, cache.targetCount);
            const liveEntertainers = rosterChanged ? getEntertainers() : entertainers;
            cache.entertainerCount = liveEntertainers.length;
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
                    + "  " + formatMoney(cache.entertainerCount * ENTERTAINER_WAGE_PER_MONTH) + "/mo";
            }
            const awardLbl = pluginWindow.findWidget<LabelWidget>("lblAward");
            if (awardLbl) awardLbl.text = awardStatus;
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
                height: 274 + DIAG_ROW,
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
                        tooltip: "Hire or fire entertainers (" + formatMoney(ENTERTAINER_WAGE_PER_MONTH)
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
                        tooltip: "Hires up to " + MAX_TARGETED_ENTERTAINERS + " entertainers at "
                            + formatMoney(ENTERTAINER_WAGE_PER_MONTH) + "/month each and patrols them near "
                            + "congested queues (3+ minute posted wait), plus up to " + MAX_STATION_ENTERTAINERS
                            + " more at the park entrance and food courts (#68). On by default (#51); entertainers cost wages.",
                        isChecked: getAutoManage(),
                        onChange: (checked: boolean) => {
                            settings.autoManage.set(checked);
                            entertainerStaffingSeeded = false;
                        }
                    },
                    {
                        type: "checkbox", name: "chkGuard",
                        x: 8, y: 196, width: 264, height: 14,
                        text: "Hire security guards for Best Staff award",
                        tooltip: "The Best Staff award (+25% new guests while held) needs every staff type, 20+ staff "
                            + "and one per 32 guests. Once the park has 20+ staff and no security guard, hires one ("
                            + formatMoney(SECURITY_WAGE_PER_MONTH) + "/month); and when the park is 1 to 5 staff short of "
                            + "the line, hires guards to close the gap, one a day, with 3,000 in the bank. Lets its own "
                            + "extra guards go when they are no longer needed; never fires yours. On by default (#92, #163).",
                        isChecked: settings.awardGuard.get(),
                        onChange: (checked: boolean) => { settings.awardGuard.set(checked); }
                    },
                    { type: "label", name: "lblAward", x: 20, y: 212, width: 252, height: 14, text: awardStatus },
                    { type: "label", name: "lblStatus", x: 8, y: 230, width: 264, height: 14, text: "" },
                    ...diagnosticsCheckbox(8, 250, 264),
                    newsCheckbox(settings.news, 8, 250 + DIAG_ROW, 264)
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
