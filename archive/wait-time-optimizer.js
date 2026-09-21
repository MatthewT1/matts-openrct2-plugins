/// <reference path="gamesrc/OpenRCT2/distribution/scripting/openrct2.d.ts" />
"use strict";

registerPlugin({
    name: "Wait Time Optimizer",
    version: "1.0",
    authors: ["Matt"],
    type: "local",
    licence: "MIT",
    targetApiVersion: 87,
    main: function() {
        var PLUGIN_VERSION = "1.0";
        // Guests begin complaining at 5 min queue wait and walk out at 15 min.
        // Trigger emergency dispatch mode at 5 min so trains push out faster
        // before guests start leaving the queue.
        var QUEUE_WARN_MINUTES = 5;
        // 0s floor lets trains depart the instant they're full — fastest possible throughput.
        var MIN_WAIT_FLOOR = 0;
        // Cap max wait at 60s; beyond that, idle trains waste capacity with no guest benefit.
        var MAX_WAIT_CAP = 60;

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
        var DEPART_WAIT_FOR_LOAD    = 1 << 3;   // 8
        var DEPART_PRESERVE_MASK    = (1 << 4) | (1 << 5); // bits to keep from existing flags
        var DEPART_WAIT_FOR_MIN_LEN = 1 << 6;   // 64
        var DEPART_WAIT_FOR_MAX_LEN = 1 << 7;   // 128
        var LOAD_FULL               = 3;         // 100% — best for quiet rides (no wasted capacity)
        var LOAD_ANY                = 4;         // any guests — best for busy rides (max dispatch frequency)
        // Rides with intensity > 8.0 attract fewer willing guests; Full Load causes trains to
        // sit idle. 800 = 8.00 in the 2-decimal-point fixed-integer format OpenRCT2 uses.
        var INTENSITY_HIGH          = 800;

        // Deferred-mutation flags: ride property writes are only safe from interval hooks.
        var pendingApplyAll = false;
        var pendingApplyRideId = -1;
        var pendingBoostTrains = false;

        var autoManage = true;
        var selectedRow = -1;
        var pluginWindow = null;
        var refreshHandle = null;

        // --- Helpers ---

        // Ride types where the train-cycling wait formula doesn't apply.
        // 20 = Maze (guests pilot maze cars individually, no queued dispatch cycle)
        // 35 = Spiral Slide (walk-through, no trains)
        var EXCLUDED_RIDE_TYPES = { 20: true, 35: true };

        function getOptimizableRides() {
            return map.rides.filter(function(r) {
                return r.classification === "ride"
                    && r.status === "open"
                    && r.stations.length > 0
                    && r.vehicles.length > 0      // exclude rides with no allocated vehicles
                    && !EXCLUDED_RIDE_TYPES[r.type];
            });
        }

        // Worst (highest) queue time across all stations for a ride.
        function maxQueueTime(ride) {
            var max = 0;
            ride.stations.forEach(function(s) { if (s.queueTime > max) max = s.queueTime; });
            return max;
        }

        // Count cars in one train by following the vehicle chain from the head car.
        function getCarsPerTrain(ride) {
            if (!ride || ride.vehicles.length === 0) return 1;
            var headId = ride.vehicles[0];
            if (headId === undefined || headId === null) return 1;
            var vehicle = map.getEntity(headId);
            var count = 1;
            var limit = 50; // guard against corrupted vehicle chains
            while (vehicle && vehicle.nextCarOnTrain !== null && vehicle.nextCarOnTrain !== undefined && count < limit) {
                vehicle = map.getEntity(vehicle.nextCarOnTrain);
                count++;
            }
            return count;
        }

        // Scroll the main viewport to the first station of a ride (by cache row index).
        function scrollToRide(rowIndex) {
            if (rowIndex < 0 || rowIndex >= rideCache.length) return;
            var ride = map.getRide(rideCache[rowIndex].id);
            if (!ride || ride.stations.length === 0) return;
            var station = ride.stations[0];
            if (station && station.start && station.start.x >= 0) {
                ui.mainViewport.scrollTo({ x: station.start.x, y: station.start.y, z: station.start.z });
            }
        }

        // Compute recommended min/max wait in seconds.
        // Formula: min = rideDuration / (trains+1), max = rideDuration / trains.
        // Keeps trains cycling without stacking at the station.
        // Emergency override when queue is already over the warning threshold.
        function calcRecommended(ride) {
            var trainCount = Math.max(1, ride.vehicles.length);
            // ride.rideTime is in seconds; fall back to 60s if the ride hasn't run yet.
            var rideDuration = (ride.rideTime && ride.rideTime >= 10) ? ride.rideTime : 60;
            var queueTime = maxQueueTime(ride);

            var minWait, maxWait;
            if (queueTime >= QUEUE_WARN_MINUTES) {
                // Queue is at the danger threshold — push trains out as fast as possible.
                minWait = MIN_WAIT_FLOOR; // 0: depart immediately when full
                maxWait = 20;             // 20s max so idle trains don't stall throughput
            } else {
                minWait = Math.round(rideDuration / (trainCount + 1));
                maxWait = Math.round(rideDuration / trainCount);
            }

            minWait = Math.max(MIN_WAIT_FLOOR, Math.min(minWait, 60));
            maxWait = Math.max(Math.min(maxWait, MAX_WAIT_CAP), minWait + 10);
            return { minWait: minWait, maxWait: maxWait };
        }

        // --- Cache: pre-computed table rows for the UI ---

        var rideCache = [];
        // Each entry: {id, name, queueTime, trainCount, carsPerTrain, curMin, curMax, recMin, recMax, isWarning}

        function updateCache() {
            rideCache = getOptimizableRides().map(function(r) {
                var rec = calcRecommended(r);
                var qt = maxQueueTime(r);
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
                    isWarning: qt >= QUEUE_WARN_MINUTES,
                    isHighIntensity: r.intensity > INTENSITY_HIGH
                };
            });
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
        function calcDepartFlags(ride, isWarning) {
            var preserved = ride.departFlags & DEPART_PRESERVE_MASK;
            var isHighIntensity = ride.intensity > INTENSITY_HIGH;
            if (isWarning || isHighIntensity) {
                return preserved | DEPART_WAIT_FOR_LOAD | LOAD_ANY | DEPART_WAIT_FOR_MAX_LEN;
            }
            return preserved | DEPART_WAIT_FOR_LOAD | LOAD_FULL
                             | DEPART_WAIT_FOR_MIN_LEN | DEPART_WAIT_FOR_MAX_LEN;
        }

        // Set lift hill speed to max for chain-lift rides — reduces cycle time with no
        // ride closure. Non-lift rides have minLiftHillSpeed === maxLiftHillSpeed === 0,
        // so this is a no-op for them.
        function applyLiftSpeed(ride) {
            if (ride.maxLiftHillSpeed > 0 && ride.liftHillSpeed < ride.maxLiftHillSpeed) {
                ride.liftHillSpeed = ride.maxLiftHillSpeed;
            }
        }

        function applyToRide(rideId) {
            var ride = map.getRide(rideId);
            if (!ride) return;
            var isWarning = maxQueueTime(ride) >= QUEUE_WARN_MINUTES;
            var rec = calcRecommended(ride);
            ride.minimumWaitingTime = rec.minWait;
            ride.maximumWaitingTime = rec.maxWait;
            ride.departFlags = calcDepartFlags(ride, isWarning);
            applyLiftSpeed(ride);
        }

        function applyToAll() {
            getOptimizableRides().forEach(function(r) {
                var isWarning = maxQueueTime(r) >= QUEUE_WARN_MINUTES;
                var rec = calcRecommended(r);
                r.minimumWaitingTime = rec.minWait;
                r.maximumWaitingTime = rec.maxWait;
                r.departFlags = calcDepartFlags(r, isWarning);
                applyLiftSpeed(r);
            });
        }

        // Boost capacity of each [!] ride: close → try +1 train AND +1 car per train → reopen.
        // Both operations are unconditional: the game clamps each to its own maximum, so
        // firing both is safe whether or not either is already at its cap.
        // Sequential (one ride at a time) via recursive callbacks so actions don't race.
        function boostTrains() {
            var candidates = rideCache.filter(function(r) { return r.isWarning; });
            if (candidates.length === 0) return;

            function processNext(idx) {
                if (idx >= candidates.length) {
                    updateCache();
                    refreshWindow();
                    return;
                }
                var entry = candidates[idx];
                var ride = map.getRide(entry.id);
                if (!ride || ride.status !== "open") { processNext(idx + 1); return; }

                var newTrainCount = entry.trainCount + 1;
                var obj = ride.object;
                var maxCars = obj ? obj.maxCarsInTrain : 99;
                var newCars = Math.min(getCarsPerTrain(ride) + 1, maxCars);

                // Step 1: close the ride (required before ridesetvehicle).
                context.executeAction("ridesetstatus", { ride: entry.id, status: 0 }, function(r1) {
                    if (r1.error && r1.error !== 0) { processNext(idx + 1); return; }

                    // Step 2: add one train (game clamps to type max — no-op if already at max).
                    context.executeAction("ridesetvehicle", {
                        ride: entry.id, type: 0, value: newTrainCount, colour: 0
                    }, function() {
                        // Step 3: add one car per train (game clamps to maxCarsInTrain — no-op if maxed).
                        context.executeAction("ridesetvehicle", {
                            ride: entry.id, type: 1, value: newCars, colour: 0
                        }, function() {
                            // Step 4: reopen.
                            context.executeAction("ridesetstatus", { ride: entry.id, status: 1 }, function() {
                                processNext(idx + 1);
                            });
                        });
                    });
                });
            }

            processNext(0);
        }

        // --- Event subscriptions ---

        // Process deferred mutations each tick.
        context.subscribe("interval.tick", function() {
            if (!pendingApplyAll && pendingApplyRideId < 0 && !pendingBoostTrains) return;
            if (pendingApplyAll)    { applyToAll(); pendingApplyAll = false; }
            if (pendingApplyRideId >= 0) { applyToRide(pendingApplyRideId); pendingApplyRideId = -1; }
            if (pendingBoostTrains) { boostTrains(); pendingBoostTrains = false; }
        });

        // Daily: refresh cache and optionally auto-apply wait times.
        context.subscribe("interval.day", function() {
            updateCache();
            if (!autoManage) return;
            applyToAll();
        });

        // --- UI ---

        function buildListItems() {
            if (rideCache.length === 0) {
                return [["(no open rides with queues)", "", "", "", ""]];
            }
            return rideCache.map(function(r) {
                var prefix = r.isWarning && r.isHighIntensity ? "[!~]"
                           : r.isWarning                     ? "[!] "
                           : r.isHighIntensity               ? "[~] "
                           :                                   "    ";
                return [
                    prefix + r.name,
                    r.queueTime + "m",
                    r.trainCount + "\xD7" + r.carsPerTrain,   // e.g. "2×4"
                    r.curMin + "-" + r.curMax + "s",
                    r.recMin + "-" + r.recMax + "s"
                ];
            });
        }

        function buildInfoText() {
            var warnings   = rideCache.filter(function(r) { return r.isWarning; }).length;
            var highIntens = rideCache.filter(function(r) { return r.isHighIntensity && !r.isWarning; }).length;
            var parts = ["Rides: " + rideCache.length];
            if (warnings   > 0) parts.push("[!] " + warnings + " long queue(s)");
            if (highIntens > 0) parts.push("[~] " + highIntens + " intense ride(s)");
            return parts.join("   ");
        }

        function refreshWindow() {
            if (!pluginWindow) return;
            updateCache();
            var lv = pluginWindow.findWidget("lvRides");
            if (lv) lv.items = buildListItems();
            var lbl = pluginWindow.findWidget("lblInfo");
            if (lbl) lbl.text = buildInfoText();
        }

        function openWindow() {
            if (pluginWindow) { pluginWindow.bringToFront(); return; }
            updateCache();

            pluginWindow = ui.openWindow({
                classification: "wait-time-optimizer",
                title: "Wait Time Optimizer v" + PLUGIN_VERSION,
                width: 400,
                height: 292,
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
                        onHighlight: function(item) { selectedRow = item; },
                        onClick: function(item) {
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
                        onClick: function() { pendingApplyAll = true; }
                    },
                    {
                        type: "button",
                        x: 167, y: 200, width: 100, height: 18,
                        text: "Apply Selected",
                        tooltip: "Apply recommended wait times to the highlighted ride",
                        onClick: function() {
                            if (selectedRow >= 0 && selectedRow < rideCache.length) {
                                pendingApplyRideId = rideCache[selectedRow].id;
                            }
                        }
                    },
                    {
                        type: "button",
                        x: 271, y: 200, width: 122, height: 18,
                        text: "Refresh",
                        tooltip: "Re-read queue times and recalculate recommendations",
                        onClick: function() { refreshWindow(); }
                    },
                    // Row 2: capacity boost
                    {
                        type: "button",
                        x: 8, y: 222, width: 385, height: 18,
                        text: "Boost [!] Ride Capacity (trains, then cars)",
                        tooltip: "For every ride with a queue >= " + QUEUE_WARN_MINUTES + " min: briefly close the ride, attempt to add one train AND one car per train (both capped at the ride's max), then reopen.",
                        onClick: function() { pendingBoostTrains = true; }
                    },
                    // Auto-manage toggle
                    {
                        type: "checkbox", name: "chkAuto",
                        x: 8, y: 246, width: 384, height: 14,
                        text: "Auto-adjust wait times daily",
                        tooltip: "Each in-game day, automatically apply recommended wait times to all open rides",
                        isChecked: autoManage,
                        onChange: function(checked) { autoManage = checked; }
                    },
                    // Legend
                    {
                        type: "label",
                        x: 8, y: 264, width: 384, height: 14,
                        text: "[!]=queue  [~]=intense(>8.0)  T\xD7C=trains\xD7cars  click=center camera"
                    }
                ],
                onClose: function() {
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
