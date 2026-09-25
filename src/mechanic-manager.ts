import { createDebugChannel, diagnosticsCheckbox, isDebugEnabled } from "./debug";
import { boolSetting } from "./settings";
import { formatMoney } from "./money";
import { createActivityTracker } from "./staff-activity";
import { MECHANIC_THRESHOLDS, createStaffingController, StaffingDecision } from "./staffing";
import { createStaffHirer, HIRE_BACKOFF_DAYS } from "./staff-hiring";
import { createDeferredActions } from "./deferred";
import { createBreakdownTracer, RideSnapshot, MechanicSnapshot } from "./breakdown-trace";

registerPlugin({
    name: "Mechanic Manager",
    version: __PLUGIN_VERSION__,
    authors: ["MattT"],
    type: "local",
    licence: "MIT",
    targetApiVersion: 87,
    main(): void {
        const PLUGIN_VERSION = __PLUGIN_VERSION__;
        // Community consensus (myrct guide, CoasterBuzz): 1 per 3-4 rides for coasters.
        // 1 per 4 is a safe middle ground across mixed ride types.
        const TARGET_RIDES_PER_MECHANIC = 4;
        // Keep 2 mechanics with no zone as overflow responders.
        const FREE_ROAMING_BUFFER = 2;
        // inspectionInterval = 0 means "every 10 minutes" (enum index into
        // RideInspectionInterval[], Ride.cpp:133).
        //
        // NOTE: shorter intervals do NOT slow reliability decay. Decay is
        // `unreliabilityFactor + getAgePenalty(ride)` with no inspection term at all
        // (Ride.cpp:1132). What inspections do is RESTORE a proportion of reliability
        // already lost (Ride.cpp:4443). So more frequent inspections raise *average*
        // reliability by restoring more often — the usual "it stops decay" explanation
        // is simply wrong. The cost is mechanic travel time, not decay.
        //
        // Also note "every 10 minutes" is ~38 in-game days per ride: RideInspectionUpdate
        // only runs once per 2048 ticks. See docs/api-reference.md.
        const OPTIMAL_INSPECTION_INTERVAL = 0;
        // Mechanic staffOrders bitmask: inspect (1) | fix (2).
        const MECHANIC_ORDERS = 1 | 2;
        // Max breakdown entries displayed in the log.
        const MAX_BREAKDOWN_LOG = 5;
        // Max rides shown in the "needs attention" watch list.
        const MAX_WATCH_LIST = 5;

        const storage: Configuration = context.getParkStorage();
        const settings = {
            autoManage: boolSetting(storage, "autoManage", true),
            emergencyRepair: boolSetting(storage, "emergencyRepair", false),
            adaptiveMechanics: boolSetting(storage, "adaptiveMechanics", true),
        };

        // Debug channel; off unless the shared-storage debug flag is set (see debug.ts).
        const dbg = createDebugChannel("mechanic-manager");

        /** Auto-manage toggle, persisted per save file (was reset on every load). */
        function getAutoManage(): boolean {
            return settings.autoManage.get();
        }

        const recentBreakdowns: string[] = [];
        let pluginWindow: Window | null = null;
        let refreshHandle: number | null = null;

        // Mechanics whose patrol area we have already cleared. Re-issuing
        // `staffsetpatrolarea` for every mechanic every in-game day cost N game actions
        // per day and changed nothing — zones only need clearing once per mechanic.
        const zoneCleared: Record<number, true> = {};

        // Closed-loop mechanic staffing, reusing the controller proven on handymen.
        //
        // Measured basis: 7 mechanics for 17 rides, 8 breakdowns across 104 in-game days,
        // and `fleetUnderworked` on most of them — while mechanics already perform ~100%
        // of the work the game asks of them (see docs/roadmap.md, M2). At GBP 80/month
        // each (Staff.cpp:2645, the most expensive staff type) that is real money for
        // staff with nothing to do.
        // Mechanic-calibrated thresholds, NOT the litter defaults. Passing the wrong
        // ones here is what turned this controller into a one-way ratchet.
        const mechanicStaffing = createStaffingController(0, MECHANIC_THRESHOLDS);
        let mechanicStaffingSeeded = false;
        let lastMechanicStaffingReason = "";
        let lastMechanicDecision: StaffingDecision | null = null;
        // Never drop below this many mechanics while the park has rides at all: a
        // breakdown with nobody to send is far worse than one idle mechanic.
        const MECHANIC_FLOOR = 2;

        // --- Emergency repair (M3) ------------------------------------------
        //
        // `ride.fixBreakdown()` (ScRide.cpp:842) clears the breakdown flags and adds
        // ZERO reliability. No mechanic walks anywhere; the ride is simply not broken
        // any more. That is a cheat, and it is labelled as one in the UI, because the
        // honest use for it is narrow: a ride that has been broken for days because no
        // mechanic can physically reach it - the long-standing pathfinding trap behind
        // issues #7947 and #3205, which no amount of hiring fixes.
        //
        // The days threshold is what keeps it honest. A ride broken for a day or two is
        // a ride the mechanics are dealing with, and stepping in there would replace
        // the game's economy with a free repair button.
        const EMERGENCY_REPAIR_DAYS = 3;
        /** Ride id -> consecutive days observed broken. */
        let brokenDays: Record<number, number> = {};

        function isEmergencyRepair(): boolean {
            return settings.emergencyRepair.get();
        }

        function isAdaptiveMechanics(): boolean {
            return settings.adaptiveMechanics.get();
        }

        // Tracks whether each mechanic's fix/inspect counters are advancing. See
        // staff-activity.ts for why counters beat position sampling.
        // Mechanics are judged over a much longer window than handymen. At the optimal
        // inspection interval a ride is only due every ~38 in-game days
        // (RideInspectionUpdate runs once per 2048 ticks; see docs/api-reference.md), so
        // a mechanic with nothing to do for a week is entirely normal.
        const MECHANIC_IDLE_DAYS = 20;
        const activity = createActivityTracker(MECHANIC_IDLE_DAYS);
        // Mechanics reported stuck on the most recent sweep, so the log is not repeated
        // every single day for the same peep.
        let lastStuckReport = 0;
        // Breakdowns seen since the last telemetry flush. Counting actual events is a
        // far better "was there work to do" signal than any derived ride property.
        let breakdownsToday = 0;
        let lastFleetUnderworked = false;
        // #32 phase 1 (shadow): rolling-window active fraction for candidate windows,
        // logged only. The controller still uses the lifetime `fleetUnderworked`.
        const SHADOW_WINDOW_DAYS = [7, 10, 14, 21];
        let shadowActiveFraction: Record<string, number | null> = {};

        // --- Data helpers ---

        function getOpenRides(): Ride[] {
            return map.rides.filter((r: Ride) => r.classification === "ride" && r.status === "open");
        }

        function getMechanics(): Mechanic[] {
            return map.getAllEntities("staff").filter(
                (s: Staff): s is Mechanic => s.staffType === "mechanic"
            );
        }

        function getTargetCount(rideCount: number): number {
            if (rideCount === 0) return 0;
            return Math.ceil(rideCount / TARGET_RIDES_PER_MECHANIC) + FREE_ROAMING_BUFFER;
        }

        // --- Cache: pre-computed values for UI display ---

        interface RideWatchEntry {
            name: string;
            reliability: number;
            downtime: number;
        }

        interface Cache {
            rideCount: number;
            mechanicCount: number;
            targetCount: number;
            // Rides broken RIGHT NOW. `ride.breakdown` returns the literal string
            // "none" when RideFlag::brokenDown is clear (ScRide.cpp:809), which is a
            // precise signal - unlike downtime, which is a rolling percentage that
            // stays non-zero for a while after a ride is fixed.
            ridesBroken: number;
            // Rides with any downtime history. Context only; not a work signal.
            ridesWithDowntime: number;
            // Reliability across open rides, for trend analysis in the log.
            minReliability: number;
            meanReliability: number;
            lowestReliability: RideWatchEntry[]; // sorted by downtime desc then reliability asc
        }

        const cache: Cache = {
            rideCount: 0,
            mechanicCount: 0,
            targetCount: 0,
            ridesBroken: 0,
            ridesWithDowntime: 0,
            minReliability: 100,
            meanReliability: 100,
            lowestReliability: []
        };

        function updateCache(): Mechanic[] {
            const rides = getOpenRides();
            const mechanics = getMechanics();
            cache.rideCount = rides.length;
            cache.mechanicCount = mechanics.length;
            cache.targetCount = getTargetCount(rides.length);

            let broken = 0, withDowntime = 0, relSum = 0, relCount = 0, relMin = 100;
            for (let i = 0; i < rides.length; i++) {
                const r = rides[i];
                // The d.ts types `breakdown` as BreakdownType, which has no "none"
                // member even though the binding returns exactly that string.
                if ((r.breakdown as string) !== "none") broken++;
                if (r.downtime > 0) withDowntime++;
                // Skip the >100 overflow cases (bug #7030) so they don't skew the mean.
                if (r.reliability <= 100) {
                    relSum += r.reliability;
                    relCount++;
                    if (r.reliability < relMin) relMin = r.reliability;
                }
            }
            cache.ridesBroken = broken;
            cache.ridesWithDowntime = withDowntime;
            cache.minReliability = relCount > 0 ? relMin : 100;
            cache.meanReliability = relCount > 0 ? Math.round(relSum / relCount) : 100;
            // Clamp reliability to [0, 100] before sorting. Very old rides can exceed 100%
            // due to a game overflow bug (#7030) — they appear fine in-game so we exclude them
            // from the watch list (reliability > 100 treated as full health for display purposes).
            // Sort by downtime descending first (currently broken = most urgent), then by
            // reliability ascending as a tiebreaker (most degraded next).
            const sorted = rides.filter((r: Ride) => r.reliability <= 100)
                               .sort((a: Ride, b: Ride) => {
                                   if (b.downtime !== a.downtime) return b.downtime - a.downtime;
                                   return a.reliability - b.reliability;
                               });
            cache.lowestReliability = sorted.slice(0, MAX_WATCH_LIST).map((r: Ride): RideWatchEntry => ({
                name: r.name,
                reliability: Math.round(r.reliability),
                downtime: Math.round(r.downtime)
            }));
            return mechanics;
        }

        /**
         * Clears breakdowns on rides that have been broken long enough to count as stuck.
         *
         * Tracked per ride across days rather than acted on immediately, so a ride that
         * breaks and is fixed normally never qualifies. The counter is rebuilt from the
         * live ride list each day and entries for rides that are no longer broken are
         * dropped, so it cannot accumulate stale ids the way the staff roster bug did.
         */
        function emergencyRepair(rides: Ride[]): void {
            const next: Record<number, number> = {};
            for (let i = 0; i < rides.length; i++) {
                const r = rides[i];
                if ((r.breakdown as string) === "none") continue;
                const previous = brokenDays[r.id] !== undefined ? brokenDays[r.id] : 0;
                const days = previous + 1;
                if (!isEmergencyRepair()) { next[r.id] = days; continue; }
                if (days < EMERGENCY_REPAIR_DAYS) { next[r.id] = days; continue; }

                r.fixBreakdown();
                dbg.count("emergencyRepairs");
                console.log("[Mechanic Manager] Emergency repair: " + r.name +
                    " had been broken for " + days + " days with no mechanic reaching it.");
                // Deliberately not carried into `next`: the ride is fixed, so the count
                // starts again if it breaks down once more.
            }
            brokenDays = next;
        }

        /**
         * Days a ride must sit broken before the staffing controller calls it unattended.
         *
         * Lower than EMERGENCY_REPAIR_DAYS on purpose. Staffing should react to the
         * problem well before the cheat would step in — hiring a mechanic is the
         * legitimate fix, and clearing the breakdown outright is the last resort.
         */
        const UNATTENDED_DAYS = 2;

        /**
         * How long the worst-affected ride has been broken.
         *
         * Logged because a count alone cannot distinguish "one ride broke yesterday"
         * from "one ride has been broken for eleven days" - and the measured run that
         * prompted this fix was the second one.
         */
        function longestBrokenDays(): number {
            let worst = 0;
            const keys = Object.keys(brokenDays);
            for (let i = 0; i < keys.length; i++) {
                const d = brokenDays[Number(keys[i])];
                if (d > worst) worst = d;
            }
            return worst;
        }

        /** Rides broken for at least `days` consecutive days right now. */
        function brokenAtLeast(days: number): number {
            let n = 0;
            const keys = Object.keys(brokenDays);
            for (let i = 0; i < keys.length; i++) {
                if (brokenDays[Number(keys[i])] >= days) n++;
            }
            return n;
        }

        // --- Game state mutations (only called from interval hooks) ---

        /**
         * Re-applies the optimal inspection interval to every ride.
         *
         * This is load-bearing, not redundant: a ride's inspection interval is reset to
         * the default whenever its construction window is opened
         * (https://github.com/OpenRCT2/OpenRCT2/issues/25601), so without a periodic
         * sweep the setting silently degrades as the player edits rides.
         */
        function applyInspectionIntervals(): void {
            map.rides.forEach((r: Ride) => {
                if (r.classification === "ride" && r.inspectionInterval !== OPTIMAL_INSPECTION_INTERVAL) {
                    r.inspectionInterval = OPTIMAL_INSPECTION_INTERVAL;
                }
            });
        }

        function enforceOrders(mechanics: Mechanic[]): void {
            mechanics.forEach((m: Mechanic) => {
                if (m.orders !== MECHANIC_ORDERS) m.orders = MECHANIC_ORDERS;
            });
        }

        // Clear all mechanic patrol zones so they roam the full park path network.
        //
        // Per-exit rectangle zones caused mechanics to fail responding to breakdowns:
        // if the path to a broken ride passed outside their tiny zone boundary, the
        // mechanic was blocked even when physically nearby. Mechanics are dispatched
        // by OpenRCT2 to specific breakdowns — the nearest reachable mechanic is sent
        // automatically. Without a zone restriction, any mechanic can reach any ride.
        // Set while the manual button is driving, so the log can tell a user-triggered
        // bulk clear apart from the daily delta sync. Without this, a button press looks
        // identical to a bookkeeping bug.
        let manualClear = false;

        function clearZone(m: Mechanic): void {
            if (m.id === null) return;
            // Issuing a staff action for a fired peep fails with
            // "Invalid parameter / Staff not found" (StaffSetPatrolAreaAction.cpp:69)
            // and pops an error toast. Zone clearing is rare, so verify the sprite first.
            if (map.getEntity(m.id) === null) return;
            dbg.count(manualClear ? "patrolActionsManual" : "patrolActionsDaily");
            context.executeAction("staffsetpatrolarea", {
                id: m.id, x1: 0, y1: 0, x2: 0, y2: 0, mode: 2
            }, () => {});
            zoneCleared[m.id] = true;
        }

        /** Unconditionally clear every mechanic's zone (the manual button). */
        function assignZones(mechanics: Mechanic[]): void {
            manualClear = true;
            mechanics.forEach(clearZone);
            manualClear = false;
        }

        /**
         * Daily upkeep: clear zones only for mechanics we haven't already handled.
         * On a steady-state park this issues zero game actions per day.
         */
        function syncZones(mechanics: Mechanic[]): void {
            const live: Record<number, true> = {};
            mechanics.forEach((m: Mechanic) => {
                if (m.id === null) return;
                live[m.id] = true;
                if (!zoneCleared[m.id]) clearZone(m);
            });
            // Prune fired mechanics so this map can't grow unbounded, and so a recycled
            // peep id is not mistaken for an already-cleared mechanic.
            for (const id in zoneCleared) {
                if (!live[id as unknown as number]) delete zoneCleared[id];
            }
        }

        // Hire/fire and the entity-budget backoff are shared with the other staffing
        // plugins; see staff-hiring.ts.
        const hirer = createStaffHirer({
            staffType: 1, // 1 = mechanic
            orders: MECHANIC_ORDERS,
            noun: "mechanic",
            plugin: "Mechanic Manager",
            counterPrefix: "mechanic",
            backoffDays: HIRE_BACKOFF_DAYS,
            execute: (action, args, cb) => context.executeAction(action, args, cb),
            count: (name, n) => dbg.count(name, n),
        });

        /** Returns true if the roster changed, meaning any cached Mechanic[] is now stale. */
        function hireToTarget(knownMechanics?: Mechanic[], knownTarget?: number): boolean {
            const mechanics = knownMechanics !== undefined ? knownMechanics : getMechanics();
            const target = knownTarget !== undefined ? knownTarget : getTargetCount(getOpenRides().length);

            // Guard: getTargetCount(0) is 0, so a park whose rides are all temporarily
            // closed (night, construction, a testing session) used to fire every
            // mechanic and then re-hire them the next day. Never fire below the
            // free-roaming buffer while the park still has rides built.
            const floor = map.rides.some((r: Ride) => r.classification === "ride")
                ? FREE_ROAMING_BUFFER
                : 0;
            const effectiveTarget = Math.max(target, floor);

            const diff = effectiveTarget - mechanics.length;
            if (diff > 0 && hirer.blocked()) return false;
            if (diff > 0) {
                // Cap hires per day, same as the handyman path in trash-manager.ts. A
                // large target jump - enabling auto-manage on an already-built park, or
                // several rides finishing construction in one day - would otherwise fire
                // `diff` executeAction calls synchronously in a single tick.
                const hireCount = Math.min(3, diff);
                for (let i = 0; i < hireCount; i++) hirer.hire();
                return true;
            } else if (diff < 0) {
                mechanics.slice(0, -diff).forEach((m: Mechanic) => {
                    if (m.id === null) return;
                    hirer.fire(m.id);
                });
                return true;
            }
            return false;
        }

        // --- Event subscriptions ---

        // Log breakdowns so the user can see which rides need attention.
        context.subscribe("ride.breakdown", (e: RideBreakdownArgs) => {
            const ride = map.getRide(e.rideId);
            const entry = (ride ? ride.name : "Ride #" + e.rideId) + " (" + e.breakdownReason + ")";
            breakdownsToday++;
            dbg.count("breakdowns");
            recentBreakdowns.unshift(entry);
            if (recentBreakdowns.length > MAX_BREAKDOWN_LOG) recentBreakdowns.pop();
            if (isDebugEnabled()) tracer.start(e.rideId, e.breakdownReason, date.ticksElapsed);
            refreshWindow();
        });

        // --- Breakdown repair trace (Diagnostics only) ------------------------
        //
        // Observes where the time goes between a breakdown and its repair; see
        // breakdown-trace.ts. Changes nothing in the game. Costs one boolean check per
        // tick while no traced ride is broken, and a ride + staff read every
        // TRACE_SAMPLE_TICKS while one is.
        const TRACE_SAMPLE_TICKS = 64;
        const tracer = createBreakdownTracer();
        let traceTicks = 0;

        function traceSample(): void {
            const rides: RideSnapshot[] = [];
            map.rides.forEach((r: Ride) => {
                if (r.classification !== "ride") return;
                const exit = r.stations.length > 0 ? r.stations[0].exit : null;
                rides.push({
                    id: r.id, name: r.name, breakdown: r.breakdown as string,
                    exit: exit !== null ? { x: exit.x, y: exit.y } : null,
                });
            });
            const mechanics: MechanicSnapshot[] = [];
            getMechanics().forEach((m: Mechanic) => {
                if (m.id === null) return;
                mechanics.push({
                    id: m.id, x: m.x, y: m.y, animation: m.animation,
                    ridesFixed: m.ridesFixed, ridesInspected: m.ridesInspected,
                });
            });
            const done = tracer.sample(date.ticksElapsed, rides, mechanics);
            for (let i = 0; i < done.length; i++) {
                dbg.count("breakdownTraces");
                dbg.event("breakdownTrace", done[i] as unknown as Record<string, unknown>);
            }
        }

        context.subscribe("interval.tick", () => {
            if (!tracer.active()) return;
            if (++traceTicks < TRACE_SAMPLE_TICKS) return;
            traceTicks = 0;
            dbg.time("tick.breakdownTrace", traceSample);
        });

        // Button actions that change game state run on the next tick; see deferred.ts.
        const deferred = createDeferredActions((onTick) => context.subscribe("interval.tick", onTick));
        const requestApplyIntervals = deferred.define(() => applyInspectionIntervals());
        const requestHireToTarget = deferred.define(() => { hireToTarget(); });
        const requestAssignZones = deferred.define(() => assignZones(getMechanics()));

        // Daily: refresh cache and optionally auto-manage everything.
        /**
         * Watches whether mechanics are actually fixing and inspecting things.
         * A mechanic with a cleared patrol area should be able to reach any ride, so a
         * persistently idle one usually means a pathfinding problem, not understaffing.
         */
        /**
         * Translates mechanic-domain signals into the staffing controller's vocabulary.
         *
         * The controller was written for litter, so the mapping needs stating plainly:
         *   - `oldLitter`   -> rides broken right now. The thing that actually costs
         *                      money and guest happiness if nobody attends to it.
         *   - `totalLitter` -> rides with any downtime history. The leading, noisier
         *                      signal, used to detect a regression after a release.
         *   - `parkRating`  -> passes through unchanged; a falling rating blocks
         *                      releasing whatever the mechanic numbers say.
         */
        function mechanicStaffingSignals(fleetUnderworked: boolean, formulaTarget: number): {
            oldLitter: number; totalLitter: number; parkRating: number;
            fleetUnderworked: boolean; formulaTarget: number; floor: number;
        } {
            return {
                // The urgent signal is rides left broken for days, NOT rides broken right
                // now. A ride that breaks and is repaired the same day is the system
                // working; a ride still broken on day two is the system failing, and it
                // is the exact condition behind the game's own "still hasn't been fixed"
                // warning (Ride.cpp:1356-1377, which fires only while no mechanic is
                // assigned to it).
                //
                // The previous mapping used `cache.ridesBroken` against a threshold of
                // 25 inherited from the litter controller. On a 13-ride park that is
                // arithmetically unreachable, so the controller could never hire in an
                // emergency and never refuse a release - a one-way ratchet down. See
                // MECHANIC_THRESHOLDS in staffing.ts.
                oldLitter:        brokenAtLeast(UNATTENDED_DAYS),
                // The fast, noisy leading indicator: rides broken right now. Feeds the
                // EMA that detects a release having made things worse.
                totalLitter:      cache.ridesBroken,
                parkRating:       park.rating,
                fleetUnderworked: fleetUnderworked,
                formulaTarget:    formulaTarget,
                floor:            cache.rideCount > 0 ? MECHANIC_FLOOR : 0,
            };
        }

        function checkActivity(mechanics: Mechanic[]): void {
            for (let i = 0; i < mechanics.length; i++) {
                const m = mechanics[i];
                if (m.id === null) continue;
                activity.observe(m.id, m.ridesFixed + m.ridesInspected);
            }
            // Only count idleness against mechanics when a ride was actually broken
            // during the day or is broken now. Inspections happen on the game's own
            // schedule, so a quiet day says nothing about whether a mechanic can work.
            const snap = activity.endSweep(cache.ridesBroken > 0 || breakdownsToday > 0);
            lastFleetUnderworked = snap.fleetUnderworked;
            dbg.count("mechanicWorkDone", snap.workDone);
            if (snap.fleetUnderworked) dbg.count("mechanicFleetUnderworked");
            shadowActiveFraction = {};
            for (let i = 0; i < SHADOW_WINDOW_DAYS.length; i++) {
                const n = SHADOW_WINDOW_DAYS[i];
                const f = activity.activeFractionWithin(n);
                shadowActiveFraction["n" + n] = f === null ? null : Math.round(f * 100) / 100;
            }

            if (snap.stuck.length === 0) {
                lastStuckReport = 0;
                return;
            }
            dbg.count("mechanicsStuck", snap.stuck.length);
            // Only re-log when the count changes, so this cannot spam the console on
            // every in-game day.
            if (snap.stuck.length !== lastStuckReport) {
                lastStuckReport = snap.stuck.length;
                console.log("[Mechanic Manager] " + snap.stuck.length + " of " +
                    snap.tracked + " mechanic(s) have done nothing at all while " +
                    snap.active + " of their peers are working and " + cache.ridesBroken +
                    " ride(s) are broken - peep id(s): " + snap.stuck.join(", ") +
                    ". Likely unreachable rides or blocked paths.");
            }
        }

        function parkContext(): Record<string, unknown> {
            const ctx: Record<string, unknown> = {
                parkRating: park.rating,
                rides: cache.rideCount,
                mechanics: cache.mechanicCount,
                targetMechanics: cache.targetCount,
                ridesBroken: cache.ridesBroken,
                ridesWithDowntime: cache.ridesWithDowntime,
                minReliability: cache.minReliability,
                meanReliability: cache.meanReliability,
                breakdownsToday: breakdownsToday,
                autoManage: getAutoManage(),
                adaptiveMechanics: isAdaptiveMechanics(),
                adaptiveTarget: mechanicStaffing.target(),
                settling: lastMechanicDecision !== null ? lastMechanicDecision.settling : 0,
                discoveredFloor: lastMechanicDecision !== null ? lastMechanicDecision.discoveredFloor : 0,
                // Source-verified wages (Staff.cpp:2645): mechanics are GBP 80/month.
                mechanicWagesPerMonth: cache.mechanicCount * 80,
                formulaWagesPerMonth: cache.targetCount * 80,
                emergencyRepair: isEmergencyRepair(),
                stuckBroken: brokenAtLeast(EMERGENCY_REPAIR_DAYS),
                unattendedBreakdowns: brokenAtLeast(UNATTENDED_DAYS),
                longestBrokenDays: longestBrokenDays(),
                activeFraction: shadowActiveFraction,
            };
            breakdownsToday = 0;
            return ctx;
        }

        context.subscribe("interval.day", () => {
            const mechanics = dbg.time("day.updateCache", updateCache);
            dbg.time("day.activity", () => checkActivity(mechanics));
            if (!getAutoManage()) { dbg.flushStats(parkContext()); return; }
            dbg.time("day.emergencyRepair", () => emergencyRepair(getOpenRides()));
            dbg.time("day.inspectionIntervals", applyInspectionIntervals);
            dbg.time("day.enforceOrders", () => enforceOrders(mechanics));
            let wanted = cache.targetCount;
            if (isAdaptiveMechanics()) {
                if (!mechanicStaffingSeeded) {
                    // Seed from the live roster so enabling this never causes a mass
                    // hire or fire on the first day.
                    mechanicStaffing.seed(mechanics.length > 0 ? mechanics.length : cache.targetCount);
                    mechanicStaffingSeeded = true;
                }
                const decision = mechanicStaffing.update(
                    mechanicStaffingSignals(lastFleetUnderworked, cache.targetCount));
                lastMechanicDecision = decision;
                wanted = decision.target;
                if (decision.reason !== "" && decision.reason !== lastMechanicStaffingReason) {
                    lastMechanicStaffingReason = decision.reason;
                    console.log("[Mechanic Manager] Adaptive target now " + decision.target +
                        " (formula says " + cache.targetCount + "): " + decision.reason + ".");
                }
            }

            const rosterChanged = cache.mechanicCount !== wanted
                && hireToTarget(mechanics, wanted);
            // Re-read the roster if we just hired or fired: game actions execute
            // synchronously in single player, so `mechanics` would otherwise still hold
            // a peep that no longer exists and syncZones would aim a patrol-area action
            // at a dead sprite id.
            dbg.time("day.syncZones", () => syncZones(rosterChanged ? getMechanics() : mechanics));
            dbg.flushStats(parkContext());
        });

        // --- UI ---

        function refreshWindow(): void {
            if (!pluginWindow) return;

            const statsLbl = pluginWindow.findWidget<LabelWidget>("lblStats");
            if (statsLbl) {
                const adaptive = isAdaptiveMechanics();
                const target = adaptive ? mechanicStaffing.target() : cache.targetCount;
                // Source-verified wage (Staff.cpp:2645). Rating is usually maxed, so
                // wages are the only lever left worth showing the player.
                const saving = (cache.targetCount - cache.mechanicCount) * 80;
                statsLbl.text = "Rides: " + cache.rideCount
                    + "   Mechanics: " + cache.mechanicCount + " / " + target
                    + (adaptive ? " target" : " recommended")
                    + (saving > 0 ? "   (saving " + formatMoney(saving) + "/mo)" : "");
            }

            const relLv = pluginWindow.findWidget<ListViewWidget>("lvReliability");
            if (relLv) {
                relLv.items = cache.lowestReliability.length > 0
                    ? cache.lowestReliability.map((r: RideWatchEntry) =>
                        r.name + ": " + r.reliability + "% rel  " + r.downtime + "% down"
                      )
                    : ["(no open rides)"];
            }

            const bdLv = pluginWindow.findWidget<ListViewWidget>("lvBreakdowns");
            if (bdLv) {
                bdLv.items = recentBreakdowns.length > 0 ? recentBreakdowns : ["(none since last load)"];
            }
        }

        function openWindow(): void {
            if (pluginWindow) { pluginWindow.bringToFront(); return; }
            updateCache();

            pluginWindow = ui.openWindow({
                classification: "mechanic-manager",
                title: "Mechanic Manager v" + PLUGIN_VERSION,
                width: 280,
                height: 390,
                widgets: [
                    // Stats bar
                    {
                        type: "label", name: "lblStats",
                        x: 8, y: 28, width: 264, height: 14,
                        text: "Rides: " + cache.rideCount
                            + "   Mechanics: " + cache.mechanicCount
                            + " / " + cache.targetCount + " recommended"
                    },
                    // Reliability watch list
                    { type: "groupbox", x: 4, y: 44, width: 272, height: 92, text: "Rides Needing Attention" },
                    {
                        type: "listview", name: "lvReliability",
                        x: 8, y: 58, width: 264, height: 70,
                        items: cache.lowestReliability.length > 0
                            ? cache.lowestReliability.map((r: RideWatchEntry) =>
                                r.name + ": " + r.reliability + "% rel  " + r.downtime + "% down"
                              )
                            : ["(no open rides with normal reliability)"],
                        canSelect: false, scrollbars: "none"
                    },
                    // Breakdown log
                    { type: "groupbox", x: 4, y: 140, width: 272, height: 78, text: "Recent Breakdowns" },
                    {
                        type: "listview", name: "lvBreakdowns",
                        x: 8, y: 154, width: 264, height: 56,
                        items: recentBreakdowns.length > 0 ? recentBreakdowns : ["(none since last load)"],
                        canSelect: false, scrollbars: "none"
                    },
                    // Actions
                    { type: "groupbox", x: 4, y: 222, width: 272, height: 92, text: "Actions" },
                    {
                        type: "button",
                        x: 8, y: 236, width: 128, height: 16,
                        text: "Set Optimal Intervals",
                        tooltip: "Set all rides to inspect every 10 minutes. Inspections do not slow reliability decay - they restore a share of what has already been lost, so inspecting more often raises average reliability. Costs mechanic travel time.",
                        onClick: () => { requestApplyIntervals(); }
                    },
                    {
                        type: "button",
                        x: 144, y: 236, width: 128, height: 16,
                        text: "Hire / Fire to Target",
                        tooltip: "Hire or fire to recommended level: 1 mechanic per " + TARGET_RIDES_PER_MECHANIC + " rides + " + FREE_ROAMING_BUFFER + " free-roaming overflow",
                        onClick: () => { requestHireToTarget(); }
                    },
                    {
                        type: "button",
                        x: 8, y: 256, width: 128, height: 16,
                        text: "Clear Patrol Zones",
                        tooltip: "Remove all mechanic patrol zones so they can reach any ride. OpenRCT2 dispatches the nearest mechanic to each breakdown automatically — zone restrictions block this.",
                        onClick: () => { requestAssignZones(); }
                    },
                    {
                        type: "button",
                        x: 144, y: 256, width: 128, height: 16,
                        text: "Refresh",
                        tooltip: "Recount mechanics and rides and update this display",
                        onClick: () => { refreshWindow(); }
                    },
                    {
                        type: "checkbox", name: "chkAuto",
                        x: 8, y: 278, width: 264, height: 14,
                        text: "Auto-manage daily  (intervals + hiring + zones)",
                        isChecked: getAutoManage(),
                        onChange: (checked: boolean) => { settings.autoManage.set(checked); }
                    },
                    {
                        type: "checkbox", name: "chkAdaptiveMech",
                        x: 8, y: 296, width: 264, height: 14,
                        text: "Adaptive staffing (learn the right number)",
                        tooltip: "Release mechanics while no ride is breaking down and the fleet has nothing to do; hire back immediately if breakdowns go unattended or park rating falls. Never exceeds the formula's recommendation, never drops below 2 while the park has rides.",
                        isChecked: isAdaptiveMechanics(),
                        onChange: (checked: boolean) => {
                            settings.adaptiveMechanics.set(checked);
                            mechanicStaffingSeeded = false; // re-seed from the live roster
                        }
                    },
                    {
                        type: "checkbox", name: "chkEmergencyRepair",
                        x: 8, y: 314, width: 264, height: 14,
                        text: "Emergency repair stuck rides  (cheat)",
                        tooltip: "Clears the breakdown on any ride still broken after " + EMERGENCY_REPAIR_DAYS + " days. This is a CHEAT: no mechanic travels and no reliability is restored, the ride simply stops being broken. It exists for rides no mechanic can physically reach, which is a long-standing pathfinding problem in the game itself. Off by default.",
                        isChecked: isEmergencyRepair(),
                        onChange: (checked: boolean) => { settings.emergencyRepair.set(checked); }
                    },
                    // Status feedback
                    { type: "label", name: "lblStatus", x: 8, y: 334, width: 264, height: 14, text: "" },
                    diagnosticsCheckbox(8, 354, 264)
                ],
                onClose: () => {
                    pluginWindow = null;
                    if (refreshHandle !== null) {
                        context.clearInterval(refreshHandle);
                        refreshHandle = null;
                    }
                }
            });

            // Keep the stats line live while the window is open. This only reads the
            // cache — no entity scan — so it is safe at this frequency.
            refreshHandle = context.setInterval(refreshWindow, 3000);
        }

        // Run once at startup so values are non-zero on first open.
        updateCache();

        if (typeof ui === "undefined") return;
        ui.registerMenuItem("Mechanic Manager", openWindow);
    }
});
