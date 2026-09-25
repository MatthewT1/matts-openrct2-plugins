import { createDebugChannel, diagnosticsCheckbox } from "./debug";
import { boolSetting } from "./settings";
import { createDeferredActions } from "./deferred";
import { createOpsController, RideOpsState, OpsAction } from "./ops";
import { createQueueTrendTracker, QueuePressure, FLOOR_MINUTES,
    createInterventionTracker, InterventionTracker } from "./queues";

interface RideCacheEntry {
    id: number;
    name: string;
    queueTime: number;
    trainCount: number;
    carsPerTrain: number;
    curMin: number;
    curMax: number;
    recMin: number;
    recMax: number;
    isWarning: boolean;
    isHighIntensity: boolean;
    /** Queue at or past the 15-minute walk-out threshold's danger zone. */
    isCritical: boolean;
    /**
     * True when the queue has stayed long for several days despite the recommended
     * settings already being in force. Such a ride is capacity-bound, not
     * dispatch-bound: no amount of wait-time tuning will help it.
     */
    isCapacityBound: boolean;
    /** Ride duration in seconds — the observable effect of the operation setting. */
    rideTime: number;
    /** Ride type number, used by ops.ts purely as an identity check. */
    rideType: number;
    /** Intensity as a 2-decimal fixed integer (8.40 is 840). */
    intensity: number;
}

registerPlugin({
    name: "Wait Time Optimizer",
    version: __PLUGIN_VERSION__,
    authors: ["MattT"],
    type: "local",
    licence: "MIT",
    targetApiVersion: 87,
    main(): void {
        const PLUGIN_VERSION = __PLUGIN_VERSION__;
        // Guests begin complaining at 5 min queue wait and walk out at 15 min.
        // Trigger emergency dispatch mode at 5 min so trains push out faster
        // before guests start leaving the queue.
        const QUEUE_WARN_MINUTES = 5;
        // Guests leave the queue at 15 minutes, absolutely — OpenRCT2 removed vanilla
        // RCT2's "entertainers make guests wait forever" behaviour (#5753). A ride
        // sitting just under this is losing guests at the margin, and deserves a louder
        // marker than one merely past the 5-minute complaint threshold.
        const QUEUE_CRITICAL_MINUTES = 12;
        // Consecutive days a ride must stay in warning *with our recommended settings
        // already applied* before we call it capacity-bound. Measured: one ride held a
        // 13-minute queue for 43 straight days while the optimizer had already done
        // everything wait-time tuning can do.
        const CAPACITY_BOUND_DAYS = 5;
        // 0s floor lets trains depart the instant they're full — fastest possible throughput.
        const MIN_WAIT_FLOOR = 0;
        // Cap max wait at 60s; beyond that, idle trains waste capacity with no guest benefit.
        const MAX_WAIT_CAP = 60;

        // departFlags bitmask constants (from Ride.h source).
        // Bits 0-2: load threshold (how full before departing when WAIT_FOR_LOAD is on).
        // Bit 3:    WAIT_FOR_LOAD    — honour the load threshold at all.
        // Bit 4:    LEAVE_WHEN_ANOTHER_ARRIVES — preserve; user may have set this.
        // Bit 5:    SYNC_ADJACENT    — preserve; user may have set this.
        // Bit 6:    WAIT_FOR_MIN_LEN — make minimumWaitingTime actually take effect.
        // Bit 7:    WAIT_FOR_MAX_LEN — make maximumWaitingTime actually take effect.
        //
        // Without bits 6/7 set, our min/max wait values are stored but never checked
        // by the departure logic (confirmed in Vehicle.Station.cpp).
        const DEPART_WAIT_FOR_LOAD    = 1 << 3;   // 8
        const DEPART_PRESERVE_MASK    = (1 << 4) | (1 << 5); // bits to keep from existing flags
        const DEPART_WAIT_FOR_MIN_LEN = 1 << 6;   // 64
        const DEPART_WAIT_FOR_MAX_LEN = 1 << 7;   // 128
        const LOAD_FULL               = 3;         // 100% — best for quiet rides (no wasted capacity)
        const LOAD_ANY                = 4;         // any guests — best for busy rides (max dispatch frequency)
        // Rides with intensity > 8.0 attract fewer willing guests; Full Load causes trains to
        // sit idle. 800 = 8.00 in the 2-decimal-point fixed-integer format OpenRCT2 uses.
        const INTENSITY_HIGH          = 800;

        const storage: Configuration = context.getParkStorage();
        const settings = {
            autoOps: boolSetting(storage, "autoOperationTuning", false),
            autoManage: boolSetting(storage, "autoManage", true),
        };

        // --- Ride operation tuning -------------------------------------------
        //
        // `Ride::operationOption` covers maze time limit, lap count, launch speed and
        // rotation/swing count — one field, meaning set by ride type. It is set via
        // `ridesetsetting` setting 4 but CANNOT be read back, so the controller in
        // ops.ts remembers what it wrote and discovers each ride's legal maximum by
        // probing with silent queries.
        //
        // Changing it calls InvalidateTestResults, discarding the ride's
        // excitement/intensity/nausea until it runs again — so this is deliberately slow,
        // hysteretic, and off by default.
        const OPS_SETTING_OPERATION = 4;   // RideSetSetting::operation
        const OPS_PROBE_CEILING     = 32;  // highest value worth trying first
        // Probes and sets are budgeted SEPARATELY because they cost wildly different
        // things. A probe is a `queryAction` — it changes nothing, shows nothing to the
        // player, and is the only way to discover a ride's legal range. A set discards
        // the ride's excitement/intensity/nausea until it runs again.
        //
        // Measured with a shared budget of 2: over 18 in-game days only 2 of 10 rides
        // finished probing and just 1 change was applied. Probing was starving the thing
        // it exists to enable, while the genuinely expensive action was no rarer for it.
        const OPS_MAX_PROBES        = 10;  // per pass; queries are free and change nothing
        const OPS_MAX_SETS          = 1;   // per pass; each one invalidates ride ratings
        const opsController = createOpsController(OPS_PROBE_CEILING);

        function isAutoOps(): boolean {
            return settings.autoOps.get();
        }

        // Debug channel; off unless the shared-storage debug flag is set (see debug.ts).
        const dbg = createDebugChannel("wait-time-optimizer");

        /** Auto-manage toggle, persisted per save file (was reset on every load). */
        function getAutoManage(): boolean {
            return settings.autoManage.get();
        }

        let selectedRow: number = -1;
        let pluginWindow: Window | null = null;
        let refreshHandle: number | null = null;

        // --- Helpers ---

        // Ride types where the train-cycling wait formula doesn't apply.
        // 20 = Maze (guests pilot maze cars individually, no queued dispatch cycle)
        // 35 = Spiral Slide (walk-through, no trains)
        const EXCLUDED_RIDE_TYPES: Record<number, boolean> = { 20: true, 35: true };

        function getOptimizableRides(): Ride[] {
            return map.rides.filter((r: Ride) =>
                r.classification === "ride"
                && r.status === "open"
                && r.stations.length > 0
                && r.vehicles.length > 0      // exclude rides with no allocated vehicles
                && !EXCLUDED_RIDE_TYPES[r.type]
            );
        }

        // Worst (highest) queue time across all stations for a ride.
        function maxQueueTime(ride: Ride): number {
            let max = 0;
            ride.stations.forEach((s: RideStation) => { if (s.queueTime > max) max = s.queueTime; });
            return max;
        }

        // Cars per train, memoised per ride. Walking the vehicle chain costs one
        // map.getEntity call per car, so recomputing it for every ride every in-game
        // day was the most expensive thing this plugin did. The car count only changes
        // when the ride's vehicles change, which always changes the train count or goes
        // through boostTrains — both of which invalidate the entry below.
        interface CarCountMemo { trains: number; cars: number; }
        const carCountMemo: Record<number, CarCountMemo> = {};

        function invalidateCarCount(rideId: number): void {
            delete carCountMemo[rideId];
        }

        // Count cars in one train by following the vehicle chain from the head car.
        function countCarsPerTrain(ride: Ride): number {
            if (ride.vehicles.length === 0) return 1;
            let vehicle: Car | null = map.getEntity(ride.vehicles[0]) as Car | null;
            if (!vehicle) return 1;
            let count = 1;
            const limit = 50; // guard against corrupted vehicle chains
            while (count < limit) {
                const nextId = vehicle.nextCarOnTrain;
                if (nextId === null || nextId === undefined) break;
                const next = map.getEntity(nextId) as Car | null;
                // Only count a car we actually resolved. The old loop incremented before
                // checking, over-reporting by one whenever a chain link was dangling.
                if (!next) break;
                vehicle = next;
                count++;
            }
            return count;
        }

        function getCarsPerTrain(ride: Ride): number {
            const trains = ride.vehicles.length;
            const memo = carCountMemo[ride.id];
            if (memo !== undefined && memo.trains === trains) return memo.cars;
            dbg.count("carChainWalks");
            const cars = countCarsPerTrain(ride);
            carCountMemo[ride.id] = { trains, cars };
            return cars;
        }

        // Scroll the main viewport to the first station of a ride (by cache row index).
        function scrollToRide(rowIndex: number): void {
            if (rowIndex < 0 || rowIndex >= rideCache.length) return;
            const ride = map.getRide(rideCache[rowIndex].id);
            if (!ride || ride.stations.length === 0) return;
            const station = ride.stations[0];
            if (station && station.start && station.start.x >= 0) {
                ui.mainViewport.scrollTo({ x: station.start.x, y: station.start.y, z: station.start.z });
            }
        }

        // Compute recommended min/max wait in seconds.
        // Formula: min = rideDuration / (trains+1), max = rideDuration / trains.
        // Keeps trains cycling without stacking at the station.
        // Emergency override when queue is already over the warning threshold.
        function calcRecommended(ride: Ride, knownQueueTime?: number, forceOverride?: boolean): { minWait: number; maxWait: number } {
            const trainCount = Math.max(1, ride.vehicles.length);
            // ride.rideTime is in seconds; fall back to 60s if the ride hasn't run yet.
            const rideDuration = (ride.rideTime && ride.rideTime >= 10) ? ride.rideTime : 60;
            const queueTime = knownQueueTime !== undefined ? knownQueueTime : maxQueueTime(ride);

            let minWait: number;
            let maxWait: number;
            if (forceOverride === true || queueTime >= QUEUE_WARN_MINUTES) {
                // Queue is at the danger threshold, or climbing toward it — push trains
                // out as fast as possible.
                minWait = MIN_WAIT_FLOOR; // 0: depart immediately when full
                maxWait = 20;             // 20s max so idle trains don't stall throughput
            } else {
                minWait = Math.round(rideDuration / (trainCount + 1));
                maxWait = Math.round(rideDuration / trainCount);
            }

            minWait = Math.max(MIN_WAIT_FLOOR, Math.min(minWait, 60));
            maxWait = Math.max(Math.min(maxWait, MAX_WAIT_CAP), minWait + 10);
            return { minWait, maxWait };
        }

        // --- Cache: pre-computed table rows for the UI ---

        let rideCache: RideCacheEntry[] = [];
        // rideId -> consecutive days in warning while already at recommended settings.
        // Rebuilt each updateCache from the rides actually present, so a demolished or
        // closed ride cannot leave a stale entry behind.
        let stuckQueueDays: Record<number, number> = {};

        // --- W2: act on queues that are running away, before they complain ------
        //
        // The 5-minute threshold is where guests start complaining, which makes it a
        // good place to WARN and a late place to ACT. Queue length does not deter
        // guests from joining (#16841), so a ride whose arrival rate exceeds its
        // throughput grows without bound rather than settling - by the time it crosses
        // the threshold the divergence is already under way. See queues.ts for why this
        // is trend-based rather than simply a lower threshold.
        const queueTrend = createQueueTrendTracker();
        /** rideId -> this pass's verdict, so manual and daily passes agree. */
        let queuePressure: Record<number, QueuePressure> = {};
        /** rideId -> last pass's verdict, used only to detect the "just started rising" edge. */
        let lastQueuePressure: Record<number, QueuePressure> = {};

        // --- P3: per-ride before/after evidence for W2 and OPS interventions -----
        //
        // Park-wide aggregates (worstQueueMinutes, capacityBound, ops.tuned) cannot say
        // WHICH ride's queue moved because of WHICH cause. This tracker keeps a short
        // rolling queue history per ride plus the day/kind of its most recent
        // intervention, and reduces that to a before/after delta - see queues.ts header
        // for why both halves of that state are dropped together on a ride's absence.
        const intervention: InterventionTracker = createInterventionTracker();
        // Monotonic in-game day counter. GameDate exposes months/years elapsed but no
        // day count, and interventions need a day-granularity axis to window around -
        // so the plugin keeps its own, incremented once per "interval.day".
        let dayCounter = 0;
        // Rides that broke down since the last cache pass (#15). A breakdown between two
        // daily readings would otherwise hide inside a throughput day as a capacity drop.
        let brokeSinceLastPass: Record<number, boolean> = {};
        context.subscribe("ride.breakdown", (e: RideBreakdownArgs) => {
            brokeSinceLastPass[e.rideId] = true;
        });

        /** How many rides this pass carried a given verdict. */
        function countPressure(want: QueuePressure): number {
            let n = 0;
            const keys = Object.keys(queuePressure);
            for (let i = 0; i < keys.length; i++) {
                if (queuePressure[Number(keys[i])] === want) n++;
            }
            return n;
        }

        function pressureFor(rideId: number, queueTime: number): QueuePressure {
            const p = queuePressure[rideId];
            if (p !== undefined) return p;
            // A ride applied to individually, outside a daily pass, has no verdict yet.
            // Fall back to the plain threshold rather than inventing a trend from one
            // reading - feeding the tracker here would corrupt the daily series.
            return queueTime >= QUEUE_WARN_MINUTES ? "warning" : "normal";
        }
        let nextStuckQueueDays: Record<number, number> = {};
        // Each entry: {id, name, queueTime, trainCount, carsPerTrain, curMin, curMax, recMin, recMax, isWarning}

        function updateCache(): void {
            nextStuckQueueDays = {};
            queuePressure = {};
            const nextLastQueuePressure: Record<number, QueuePressure> = {};
            rideCache = getOptimizableRides().map((r: Ride) => {
                const qt = maxQueueTime(r);
                // Exactly one observation per ride per pass; endPass below then drops
                // any ride that has since been demolished.
                const pressure = queueTrend.observe(r.id, qt, QUEUE_WARN_MINUTES);
                queuePressure[r.id] = pressure;
                const overridden = pressure !== "normal";
                const rec = calcRecommended(r, qt, overridden);
                const capacityBound = updateStuckQueues(r, qt, rec, overridden);

                // P3 telemetry: one queue sample per ride per pass, same cadence as the
                // trend tracker above. Record the W2 intervention only on the day the
                // verdict newly becomes "rising" - a ride that stays rising for several
                // consecutive days must anchor to when it FIRST tripped, not keep
                // sliding the window forward every day it remains flagged.
                intervention.observe(r.id, r.name, dayCounter, qt, r.totalCustomers,
                    (r.breakdown as string) !== "none" || brokeSinceLastPass[r.id] === true);
                if (pressure === "rising" && lastQueuePressure[r.id] !== "rising") {
                    intervention.recordIntervention(r.id, dayCounter, "w2-preemptive");
                }
                nextLastQueuePressure[r.id] = pressure;

                return {
                    id: r.id,
                    name: r.name,
                    queueTime: qt,
                    trainCount: r.vehicles.length,
                    carsPerTrain: getCarsPerTrain(r),
                    curMin: r.minimumWaitingTime,
                    curMax: r.maximumWaitingTime,
                    recMin: rec.minWait,
                    recMax: rec.maxWait,
                    // A rising ride carries the warning settings, so it shows the
                    // warning marker too - the UI should never disagree with what the
                    // plugin actually wrote.
                    isWarning: overridden,
                    isHighIntensity: r.intensity > INTENSITY_HIGH,
                    isCritical: qt >= QUEUE_CRITICAL_MINUTES,
                    isCapacityBound: capacityBound,
                    rideTime: r.rideTime,
                    rideType: r.type,
                    intensity: r.intensity
                };
            });
            // Swap in the freshly built map; anything not seen this pass is discarded.
            stuckQueueDays = nextStuckQueueDays;
            lastQueuePressure = nextLastQueuePressure;
            queueTrend.endPass();
            intervention.endPass();
            brokeSinceLastPass = {};
        }

        /**
         * Tracks how long each ride has been queueing badly *while already carrying the
         * settings we would recommend*. Only such a ride is genuinely capacity-bound —
         * one that simply has not been tuned yet is a different problem.
         */
        function updateStuckQueues(
            ride: Ride,
            queueTime: number,
            rec: { minWait: number; maxWait: number },
            overridden: boolean,
        ): boolean {
            const id = ride.id;
            const applied = ride.minimumWaitingTime === rec.minWait
                && ride.maximumWaitingTime === rec.maxWait;
            // A rising ride is below the warning threshold but is already carrying the
            // most aggressive settings available, so it can be capacity-bound too.
            if ((queueTime < QUEUE_WARN_MINUTES && !overridden) || !applied) {
                // Simply not carried into the next map, which drops the streak.
                return false;
            }
            const days = (stuckQueueDays[id] !== undefined ? stuckQueueDays[id] : 0) + 1;
            nextStuckQueueDays[id] = days;
            return days >= CAPACITY_BOUND_DAYS;
        }

        // --- Game state mutations (only called from interval.tick) ---

        // Compute the departFlags value for a ride given its queue/intensity status.
        // Preserves bits 4-5 (leave-when-another, sync-adjacent) from the existing flags.
        //
        // Any Load is used when:
        //   a) Queue >= QUEUE_WARN_MINUTES — throughput beats capacity-per-train when backed up.
        //   b) Intensity > 8.0 — fewer guests are willing to ride; Full Load would leave trains
        //      idling for guests who never come. Any Load keeps throughput on niche rides.
        //
        // Full Load + both wait bounds when queue is short and intensity is normal:
        //   trains don't cycle empty, and max-wait ensures departure even at low demand.
        function calcDepartFlags(ride: Ride, isWarning: boolean): number {
            const preserved = ride.departFlags & DEPART_PRESERVE_MASK;
            const isHighIntensity = ride.intensity > INTENSITY_HIGH;
            if (isWarning || isHighIntensity) {
                return preserved | DEPART_WAIT_FOR_LOAD | LOAD_ANY | DEPART_WAIT_FOR_MAX_LEN;
            }
            return preserved | DEPART_WAIT_FOR_LOAD | LOAD_FULL
                             | DEPART_WAIT_FOR_MIN_LEN | DEPART_WAIT_FOR_MAX_LEN;
        }

        // Set lift hill speed to max for chain-lift rides — reduces cycle time with no
        // ride closure. Non-lift rides have minLiftHillSpeed === maxLiftHillSpeed === 0,
        // so this is a no-op for them.
        function applyLiftSpeed(ride: Ride): void {
            if (ride.maxLiftHillSpeed > 0 && ride.liftHillSpeed < ride.maxLiftHillSpeed) {
                ride.liftHillSpeed = ride.maxLiftHillSpeed;
            }
        }

        // Apply settings to one ride, writing each property only when the value would
        // actually change. Auto-manage runs this over every open ride each in-game day;
        // writing all four properties unconditionally meant four ride mutations per ride
        // per day even on a park that had been in steady state for hours.
        function applySettings(ride: Ride): void {
            const queueTime = maxQueueTime(ride);
            const pressure = pressureFor(ride.id, queueTime);
            // "rising" gets the same treatment as "warning", just earlier. The worst
            // case is bounded: a ride flagged early receives exactly the settings it
            // would have received a day or two later anyway.
            const isWarning = pressure !== "normal";
            if (pressure === "rising") dbg.count("queuePreemptive");
            const rec = calcRecommended(ride, queueTime, isWarning);
            const flags = calcDepartFlags(ride, isWarning);

            if (ride.minimumWaitingTime !== rec.minWait) {
                ride.minimumWaitingTime = rec.minWait;
                dbg.count("rideWrites");
            }
            if (ride.maximumWaitingTime !== rec.maxWait) {
                ride.maximumWaitingTime = rec.maxWait;
                dbg.count("rideWrites");
            }
            if (ride.departFlags !== flags) {
                ride.departFlags = flags;
                dbg.count("rideWrites");
            }
            applyLiftSpeed(ride);
        }

        function applyToRide(rideId: number): void {
            const ride = map.getRide(rideId);
            if (!ride) return;
            applySettings(ride);
        }

        function applyToAll(): void {
            getOptimizableRides().forEach(applySettings);
        }

        // Boost capacity of each [!] ride: close → try +1 train AND +1 car per train → reopen.
        // Both operations are unconditional: the game clamps each to its own maximum, so
        // firing both is safe whether or not either is already at its cap.
        // Sequential (one ride at a time) via recursive callbacks so actions don't race.
        let boostInFlight = false;

        function boostTrains(): void {
            // The chain below spans many executeAction callbacks. Without this guard a
            // second run could interleave close/reopen commands with the first.
            if (boostInFlight) return;
            const candidates = rideCache.filter((r: RideCacheEntry) => r.isWarning);
            if (candidates.length === 0) return;
            boostInFlight = true;

            function processNext(idx: number): void {
                if (idx >= candidates.length) {
                    boostInFlight = false;
                    updateCache();
                    refreshWindow();
                    return;
                }
                const entry = candidates[idx];
                const ride = map.getRide(entry.id);
                if (!ride || ride.status !== "open") { processNext(idx + 1); return; }
                // Vehicle layout is about to change - drop the memoised car count.
                invalidateCarCount(entry.id);
                // Capacity is about to change, so the "stuck for N days" streak is no
                // longer evidence of anything.
                delete stuckQueueDays[entry.id];
                delete nextStuckQueueDays[entry.id];

                const newTrainCount = entry.trainCount + 1;
                const obj = ride.object;
                const maxCars = obj ? obj.maxCarsInTrain : 99;
                const newCars = Math.min(getCarsPerTrain(ride) + 1, maxCars);

                // Step 1: close the ride (required before ridesetvehicle).
                context.executeAction("ridesetstatus", { ride: entry.id, status: 0 }, (r1: GameActionResult) => {
                    if (r1.error && r1.error !== 0) { processNext(idx + 1); return; }

                    // Step 2: add one train (game clamps to type max — no-op if already at max).
                    context.executeAction("ridesetvehicle", {
                        ride: entry.id, type: 0, value: newTrainCount, colour: 0
                    }, () => {
                        // Step 3: add one car per train (game clamps to maxCarsInTrain — no-op if maxed).
                        context.executeAction("ridesetvehicle", {
                            ride: entry.id, type: 1, value: newCars, colour: 0
                        }, () => {
                            // Step 4: reopen.
                            context.executeAction("ridesetstatus", { ride: entry.id, status: 1 }, () => {
                                processNext(idx + 1);
                            });
                        });
                    });
                });
            }

            processNext(0);
        }

        // --- Event subscriptions ---

        // Button actions that change game state run on the next tick; see deferred.ts.
        const deferred = createDeferredActions((onTick) => context.subscribe("interval.tick", onTick));
        const requestApplyAll = deferred.define(() => applyToAll());
        const requestApplyRide = deferred.defineWithArg((rideId: number) => applyToRide(rideId));
        const requestBoostTrains = deferred.define(() => boostTrains());

        // Log capacity-bound rides once, when the set changes. Re-applying wait times
        // to these is futile, so the plugin should say what actually needs doing.
        let lastCapacityReport = "";

        function reportCapacityBound(): void {
            const names: string[] = [];
            for (let i = 0; i < rideCache.length; i++) {
                if (rideCache[i].isCapacityBound) names.push(rideCache[i].name);
            }
            const key = names.join("|");
            if (key === lastCapacityReport) return;
            lastCapacityReport = key;
            if (names.length === 0) return;
            dbg.count("capacityBoundRides", names.length);
            console.log("[Wait Time Optimizer] Capacity-bound: " + names.join(", ") +
                ". These have held long queues for " + CAPACITY_BOUND_DAYS +
                "+ days with recommended wait times already applied - wait-time tuning " +
                "cannot help. They need more trains, more cars per train, or a second station.");
        }

        /**
         * Applies one operation-setting action.
         *
         * Both probe and set go through `queryAction` first. For a probe that IS the
         * whole point — a rejected query tells us the value is out of range, silently,
         * with no error window at the player. For a set it is the same safety net used
         * everywhere else in this project.
         */
        function applyOpsAction(a: OpsAction): void {
            const args = { ride: a.rideId, setting: OPS_SETTING_OPERATION, value: a.value };
            context.queryAction("ridesetsetting", args, function (q: GameActionResult): void {
                const accepted = !(q.error && q.error !== 0);

                if (a.kind === "probe") {
                    // A probe never executes; the query result alone is the answer.
                    opsController.noteProbe(a.rideId, a.value, accepted);
                    dbg.count(accepted ? "opsProbeAccepted" : "opsProbeRejected");
                    return;
                }

                if (!accepted) {
                    // Out of range after all. Report it as a *set* refusal, not a probe
                    // one: the controller needs the direction to know whether it hit the
                    // ride's floor or its ceiling. Many ride types have a minimum well
                    // above 1 (a swinging ship accepts 7-25 swings), and treating a floor
                    // refusal as a ceiling refusal shrinks the discovered range every time.
                    opsController.noteSetRejected(a.rideId, a.value);
                    dbg.count("opsSetRejected");
                    return;
                }

                context.executeAction("ridesetsetting", args, function (r: GameActionResult): void {
                    if (r.error && r.error !== 0) {
                        dbg.count("opsSetFailed");
                        return;
                    }
                    opsController.noteSet(a.rideId, a.value);
                    dbg.count("opsSet");
                    // P3: record this as a candidate cause for that ride's queue moving
                    // over the following days, same as W2's pre-emptive override.
                    intervention.recordIntervention(a.rideId, dayCounter, "ops-set");
                    console.log("[Wait Time Optimizer] " + a.name + ": operation set to " +
                        a.value + " - " + a.reason);
                });
            });
        }

        function tuneOperations(): void {
            if (!isAutoOps()) return;

            // Deliberately no real-time cooldown here, unlike the O(map²) scans
            // elsewhere in this project that need one. `ops.ts`'s hysteresis (streak
            // accumulation, CONFIRM_OBSERVATIONS, the probe bracket search) is
            // calibrated in units of "one call per in-game day" - that's the whole
            // point of interval.day. A wall-clock gate on top of that mixes units:
            // measured live, it caused whole in-game days to be silently skipped at
            // gameSpeed 2+ (the cooldown spans more than one day boundary), stalling
            // range discovery far longer than the module's own design intends. The
            // actual per-call cost is already bounded by OPS_MAX_PROBES/OPS_MAX_SETS
            // below, not by how often this function runs, so nothing here needs a
            // second throttle.
            const states: RideOpsState[] = [];
            for (let i = 0; i < rideCache.length; i++) {
                const r = rideCache[i];
                states.push({
                    rideId: r.id, name: r.name,
                    queueTime: r.queueTime,
                    // rideTime is the observable effect of operationOption, which cannot
                    // itself be read. Carried for telemetry and future tuning.
                    rideTime: r.rideTime,
                    // The real value, not a proxy: the guard threshold (900) sits above
                    // this plugin's own "high intensity" mark (800), so approximating
                    // from the boolean would keep the guard permanently disarmed.
                    intensity: r.intensity,
                    // Identity check only. The legal operation range is per ride TYPE,
                    // so a record whose type changed belongs to a different ride that
                    // inherited a reused id.
                    rideType: r.rideType,
                });
            }

            const actions = opsController.update(states);
            let probes = 0;
            let sets = 0;
            for (let i = 0; i < actions.length; i++) {
                const a = actions[i];
                if (a.kind === "probe") {
                    if (probes >= OPS_MAX_PROBES) continue;
                    probes++;
                } else {
                    if (sets >= OPS_MAX_SETS) continue;
                    sets++;
                }
                applyOpsAction(a);
            }
            if (probes > 0) dbg.count("opsProbes", probes);
            if (sets > 0) dbg.count("opsActions", sets);
        }

        // Daily: refresh cache and optionally auto-apply wait times.
        context.subscribe("interval.day", () => {
            dayCounter++;
            dbg.time("day.updateCache", updateCache);
            reportCapacityBound();
            dbg.time("day.opsTuning", tuneOperations);
            if (!getAutoManage()) { dbg.flushStats(parkContext()); return; }
            dbg.time("day.applyToAll", applyToAll);
            dbg.flushStats(parkContext());
        });

        // --- UI ---

        function buildListItems(): string[][] {
            if (rideCache.length === 0) {
                return [["(no open rides with queues)", "", "", "", ""]];
            }
            return rideCache.map((r: RideCacheEntry) => {
                // [C] outranks everything: it means wait-time tuning is exhausted.
                const prefix = r.isCapacityBound                ? "[C] "
                             : r.isCritical                     ? "[!!]"
                             : r.isWarning && r.isHighIntensity ? "[!~]"
                             : r.isWarning                      ? "[!] "
                             : r.isHighIntensity                ? "[~] "
                             :                                    "    ";
                return [
                    prefix + r.name,
                    r.queueTime + "m",
                    r.trainCount + "\xD7" + r.carsPerTrain,   // e.g. "2×4"
                    r.curMin + "-" + r.curMax + "s",
                    r.recMin + "-" + r.recMax + "s"
                ];
            });
        }

        function buildInfoText(): string {
            let warnings = 0, highIntens = 0, critical = 0, capacity = 0;
            for (let i = 0; i < rideCache.length; i++) {
                const r = rideCache[i];
                if (r.isCapacityBound) capacity++;
                if (r.isCritical) critical++;
                if (r.isWarning) warnings++;
                else if (r.isHighIntensity) highIntens++;
            }
            const parts: string[] = ["Rides: " + rideCache.length];
            if (capacity   > 0) parts.push("[C] " + capacity + " need capacity");
            if (critical   > 0) parts.push("[!!] " + critical + " near walk-out");
            if (warnings   > 0) parts.push("[!] " + warnings + " long queue(s)");
            if (highIntens > 0) parts.push("[~] " + highIntens + " intense ride(s)");
            return parts.join("   ");
        }

        /** Park state emitted alongside timings, so queue behaviour can be evaluated. */
        function parkContext(): Record<string, unknown> {
            let warnings = 0, intense = 0, worstQueue = 0, capacity = 0, critical = 0;
            for (let i = 0; i < rideCache.length; i++) {
                const r = rideCache[i];
                if (r.isWarning) warnings++;
                if (r.isHighIntensity) intense++;
                if (r.isCapacityBound) capacity++;
                if (r.isCritical) critical++;
                if (r.queueTime > worstQueue) worstQueue = r.queueTime;
            }
            return {
                parkRating: park.rating,
                autoManage: getAutoManage(),
                guests: park.guests,
                optimizableRides: rideCache.length,
                longQueues: warnings,
                criticalQueues: critical,
                capacityBound: capacity,
                ops: (function (): Record<string, unknown> {
                    let known = 0, tuned = 0;
                    const values: Record<string, number> = {};
                    for (let i = 0; i < rideCache.length; i++) {
                        const st = opsController.describe(rideCache[i].id);
                        if (st === null) continue;
                        if (st.max !== null) known++;
                        if (st.current !== null) {
                            tuned++;
                            values[rideCache[i].name] = st.current;
                        }
                    }
                    return { rangeKnown: known, tuned: tuned, values: values };
                })(),
                highIntensity: intense,
                // Minutes. Guests complain at 5 and leave at 15 (absolute in OpenRCT2).
                // Counted from the verdicts this pass actually produced, not
                // re-derived. `risingCount()` had no idea what the caller's warning
                // threshold was, so it also counted rides already in "warning" - which
                // made `risingQueues: 1` appear alongside `queuePreemptive: 0` and left
                // no way to tell whether W2 had ever fired.
                risingQueues: countPressure("rising"),
                warningQueues: countPressure("warning"),
                queueRiseFloor: FLOOR_MINUTES,
                worstQueueMinutes: worstQueue,
                // P3: per-ride before/after evidence, small by construction — it only
                // ever contains rides that have actually had an intervention applied.
                // Read next to `queuePreemptive`/`opsSet` counts: `kind` says which
                // cause to credit or clear for that ride, `day` says when, and
                // `beforeMinutes`/`afterMinutes` (each a mean over up to
                // ATTRIBUTION_WINDOW_DAYS on that side, null if not enough history yet)
                // give the actual queue-minutes move, e.g. "ride X went w2-preemptive on
                // day N, 7 -> 11 minutes over the following days."
                queueAttribution: intervention.summarize(dayCounter),
            };
        }

        function refreshWindow(): void {
            if (!pluginWindow) return;
            const lv = pluginWindow.findWidget<ListViewWidget>("lvRides");
            if (lv) lv.items = buildListItems();
            const lbl = pluginWindow.findWidget<LabelWidget>("lblInfo");
            if (lbl) lbl.text = buildInfoText();
        }

        function openWindow(): void {
            if (pluginWindow) { pluginWindow.bringToFront(); return; }
            updateCache();

            pluginWindow = ui.openWindow({
                classification: "wait-time-optimizer",
                title: "Wait Time Optimizer v" + PLUGIN_VERSION,
                width: 400,
                height: 346,
                widgets: [
                    // Summary line
                    {
                        type: "label", name: "lblInfo",
                        x: 8, y: 28, width: 384, height: 14,
                        text: buildInfoText()
                    },
                    // Ride table — 5 columns: Name, Queue, Trains×Cars, Current, Recommended
                    {
                        type: "listview", name: "lvRides",
                        x: 4, y: 44, width: 392, height: 150,
                        showColumnHeaders: true,
                        columns: [
                            { header: "Ride Name",   width: 147 },
                            { header: "Queue",       width: 38  },
                            { header: "T\xD7C",      width: 38  },  // Trains × Cars
                            { header: "Current",     width: 82  },
                            { header: "Recommended", width: 79  }
                        ],
                        items: buildListItems(),
                        canSelect: true, scrollbars: "vertical",
                        onHighlight: (item: number) => { selectedRow = item; },
                        onClick: (item: number) => {
                            selectedRow = item;
                            scrollToRide(item);
                        }
                    },
                    // Row 1: wait-time actions
                    {
                        type: "button",
                        x: 8, y: 200, width: 155, height: 18,
                        text: "Apply Recommended to All",
                        tooltip: "Set min/max wait times for all rides. Queues >= " + QUEUE_WARN_MINUTES + " min get emergency override (0s / 20s); others use ride-duration formula.",
                        onClick: () => { requestApplyAll(); }
                    },
                    {
                        type: "button",
                        x: 167, y: 200, width: 100, height: 18,
                        text: "Apply Selected",
                        tooltip: "Apply recommended wait times to the highlighted ride",
                        onClick: () => {
                            if (selectedRow >= 0 && selectedRow < rideCache.length) {
                                requestApplyRide(rideCache[selectedRow].id);
                            }
                        }
                    },
                    {
                        type: "button",
                        x: 271, y: 200, width: 122, height: 18,
                        text: "Refresh",
                        tooltip: "Re-read queue times and recalculate recommendations",
                        onClick: () => { refreshWindow(); }
                    },
                    // Row 2: capacity boost
                    {
                        type: "button",
                        x: 8, y: 222, width: 385, height: 18,
                        text: "Boost [!] Ride Capacity (trains, then cars)",
                        tooltip: "For every ride with a queue >= " + QUEUE_WARN_MINUTES + " min: briefly close the ride, attempt to add one train AND one car per train (both capped at the ride's max), then reopen.",
                        onClick: () => { requestBoostTrains(); }
                    },
                    // Auto-manage toggle
                    {
                        type: "checkbox", name: "chkAuto",
                        x: 8, y: 246, width: 384, height: 14,
                        text: "Auto-adjust wait times daily",
                        tooltip: "Each in-game day, automatically apply recommended wait times to all open rides",
                        isChecked: getAutoManage(),
                        onChange: (checked: boolean) => { settings.autoManage.set(checked); }
                    },
                    // Legend, on two lines: on one it ran past the window edge (#24)
                    {
                        type: "label",
                        x: 8, y: 264, width: 384, height: 14,
                        text: "[C]=needs capacity  [!!]=near 15min walk-out  [!]=queue  [~]=intense"
                    },
                    {
                        type: "label",
                        x: 8, y: 278, width: 384, height: 14,
                        text: "Click a row to centre the view on that ride"
                    },
                    {
                        type: "checkbox", name: "chkOps",
                        x: 8, y: 296, width: 384, height: 14,
                        text: "Tune ride operation settings (laps / rotations / speed)",
                        tooltip: "Shorten the cycle on rides with long queues and lengthen it on empty ones. Changing this discards the ride's excitement/intensity/nausea ratings until it runs again, so it moves one step at a time and only after several consistent readings. Off by default.",
                        isChecked: isAutoOps(),
                        onChange: (checked: boolean) => { settings.autoOps.set(checked); }
                    },
                    diagnosticsCheckbox(8, 316, 384)
                ],
                onClose: () => {
                    pluginWindow = null;
                    selectedRow = -1;
                    if (refreshHandle !== null) {
                        context.clearInterval(refreshHandle);
                        refreshHandle = null;
                    }
                }
            });

            // Auto-refresh every 3 seconds so queue times stay current while the window is open.
            refreshHandle = context.setInterval(refreshWindow, 3000);
        }

        // Run once at startup so values are non-zero on first open.
        updateCache();

        if (typeof ui === "undefined") return;
        ui.registerMenuItem("Wait Time Optimizer", openWindow);
    }
});
