/// <reference path="gamesrc/OpenRCT2/distribution/scripting/openrct2.d.ts" />
"use strict";

registerPlugin({
    name: "Mechanic Manager",
    version: "1.0",
    authors: ["Matt"],
    type: "local",
    licence: "MIT",
    targetApiVersion: 87,
    main: function() {
        var PLUGIN_VERSION = "1.0";
        // Community consensus (myrct guide, CoasterBuzz): 1 per 3-4 rides for coasters.
        // 1 per 4 is a safe middle ground across mixed ride types.
        var TARGET_RIDES_PER_MECHANIC = 4;
        // Keep 2 mechanics with no zone as overflow responders.
        var FREE_ROAMING_BUFFER = 2;
        // inspectionInterval = 0 means "every 10 minutes" (enum index from Ride.h).
        // Default is 30 min which causes reliability to drop sharply; 10 min is the
        // fandom wiki and community recommendation for all coasters.
        var OPTIMAL_INSPECTION_INTERVAL = 0;
        // Mechanic staffOrders bitmask: inspect (1) | fix (2).
        var MECHANIC_ORDERS = 1 | 2;
        // Max breakdown entries displayed in the log.
        var MAX_BREAKDOWN_LOG = 5;

        // Deferred-mutation flags: game state writes (ride property sets, executeAction)
        // are only safe from interval hooks, NOT from UI onClick handlers.
        var pendingApplyIntervals = false;
        var pendingHireToTarget = false;
        var pendingAssignZones = false;

        var autoManage = true;
        var recentBreakdowns = [];
        var pluginWindow = null;

        // --- Data helpers ---

        function getOpenRides() {
            return map.rides.filter(function(r) {
                return r.classification === "ride" && r.status === "open";
            });
        }

        function getMechanics() {
            return map.getAllEntities("staff").filter(function(s) {
                return s.staffType === "mechanic";
            });
        }

        function getTargetCount(rideCount) {
            if (rideCount === 0) return 0;
            return Math.ceil(rideCount / TARGET_RIDES_PER_MECHANIC) + FREE_ROAMING_BUFFER;
        }

        // --- Cache: pre-computed values for UI display ---

        var cache = {
            rideCount: 0,
            mechanicCount: 0,
            targetCount: 0,
            lowestReliability: [] // [{name, reliability, downtime}] sorted by downtime desc then reliability asc
        };

        function updateCache() {
            var rides = getOpenRides();
            var mechanics = getMechanics();
            cache.rideCount = rides.length;
            cache.mechanicCount = mechanics.length;
            cache.targetCount = getTargetCount(rides.length);
            // Clamp reliability to [0, 100] before sorting. Very old rides can exceed 100%
            // due to a game overflow bug (#7030) — they appear fine in-game so we exclude them
            // from the watch list (reliability > 100 treated as full health for display purposes).
            // Sort by downtime descending first (currently broken = most urgent), then by
            // reliability ascending as a tiebreaker (most degraded next).
            var sorted = rides.filter(function(r) { return r.reliability <= 100; })
                              .sort(function(a, b) {
                                  if (b.downtime !== a.downtime) return b.downtime - a.downtime;
                                  return a.reliability - b.reliability;
                              });
            cache.lowestReliability = sorted.slice(0, 5).map(function(r) {
                return {
                    name: r.name,
                    reliability: Math.round(r.reliability),
                    downtime: Math.round(r.downtime)
                };
            });
        }

        // --- Game state mutations (only called from interval hooks) ---

        function applyInspectionIntervals() {
            map.rides.forEach(function(r) {
                if (r.classification === "ride" && r.inspectionInterval !== OPTIMAL_INSPECTION_INTERVAL) {
                    r.inspectionInterval = OPTIMAL_INSPECTION_INTERVAL;
                }
            });
        }

        function enforceOrders() {
            getMechanics().forEach(function(m) {
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
        function assignZones() {
            getMechanics().forEach(function(m) {
                context.executeAction("staffsetpatrolarea", {
                    id: m.id, x1: 0, y1: 0, x2: 0, y2: 0, mode: 2
                }, function() {});
            });
        }

        function hireToTarget() {
            var rides = getOpenRides();
            var mechanics = getMechanics();
            var target = getTargetCount(rides.length);
            var diff = target - mechanics.length;
            if (diff > 0) {
                for (var i = 0; i < diff; i++) {
                    context.executeAction("staffhire", {
                        autoPosition: true,
                        staffType: 1, // 1 = mechanic
                        costumeIndex: 0,
                        staffOrders: MECHANIC_ORDERS
                    }, function() {});
                }
            } else if (diff < 0) {
                mechanics.slice(0, -diff).forEach(function(m) {
                    context.executeAction("stafffire", { id: m.id }, function() {});
                });
            }
        }

        // --- Event subscriptions ---

        // Log breakdowns so the user can see which rides need attention.
        context.subscribe("ride.breakdown", function(e) {
            var ride = map.getRide(e.rideId);
            var entry = (ride ? ride.name : "Ride #" + e.rideId) + " (" + e.breakdownReason + ")";
            recentBreakdowns.unshift(entry);
            if (recentBreakdowns.length > MAX_BREAKDOWN_LOG) recentBreakdowns.pop();
            refreshWindow();
        });

        // Deferred mutations: process pending flags each tick.
        context.subscribe("interval.tick", function() {
            if (!pendingApplyIntervals && !pendingHireToTarget && !pendingAssignZones) return;
            if (pendingApplyIntervals) { applyInspectionIntervals(); pendingApplyIntervals = false; }
            if (pendingHireToTarget) { hireToTarget(); pendingHireToTarget = false; }
            if (pendingAssignZones) { assignZones(); pendingAssignZones = false; }
        });

        // Daily: refresh cache and optionally auto-manage everything.
        context.subscribe("interval.day", function() {
            updateCache();
            if (!autoManage) return;
            applyInspectionIntervals();
            enforceOrders();
            if (getMechanics().length !== getTargetCount(getOpenRides().length)) hireToTarget();
            assignZones();
        });

        // --- UI ---

        function refreshWindow() {
            if (!pluginWindow) return;
            updateCache();

            var statsLbl = pluginWindow.findWidget("lblStats");
            if (statsLbl) {
                statsLbl.text = "Rides: " + cache.rideCount
                    + "   Mechanics: " + cache.mechanicCount
                    + " / " + cache.targetCount + " recommended";
            }

            var relLv = pluginWindow.findWidget("lvReliability");
            if (relLv) {
                relLv.items = cache.lowestReliability.length > 0
                    ? cache.lowestReliability.map(function(r) {
                        return r.name + ": " + r.reliability + "% rel  " + r.downtime + "% down";
                      })
                    : ["(no open rides)"];
            }

            var bdLv = pluginWindow.findWidget("lvBreakdowns");
            if (bdLv) {
                bdLv.items = recentBreakdowns.length > 0 ? recentBreakdowns : ["(none since last load)"];
            }
        }

        function openWindow() {
            if (pluginWindow) { pluginWindow.bringToFront(); return; }
            updateCache();

            pluginWindow = ui.openWindow({
                classification: "mechanic-manager",
                title: "Mechanic Manager v" + PLUGIN_VERSION,
                width: 280,
                height: 330,
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
                    { type: "groupbox", x: 4, y: 44, width: 272, height: 92, text: "Rides Needing Attention  (high downtime / low reliability)" },
                    {
                        type: "listview", name: "lvReliability",
                        x: 8, y: 58, width: 264, height: 70,
                        items: cache.lowestReliability.length > 0
                            ? cache.lowestReliability.map(function(r) {
                                return r.name + ": " + r.reliability + "% rel  " + r.downtime + "% down";
                              })
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
                        tooltip: "Set all rides to inspect every 10 minutes (recommended by the community; default is 30 min which causes reliability to decay)",
                        onClick: function() { pendingApplyIntervals = true; }
                    },
                    {
                        type: "button",
                        x: 144, y: 236, width: 128, height: 16,
                        text: "Hire / Fire to Target",
                        tooltip: "Hire or fire to recommended level: 1 mechanic per " + TARGET_RIDES_PER_MECHANIC + " rides + " + FREE_ROAMING_BUFFER + " free-roaming overflow",
                        onClick: function() { pendingHireToTarget = true; }
                    },
                    {
                        type: "button",
                        x: 8, y: 256, width: 128, height: 16,
                        text: "Clear Patrol Zones",
                        tooltip: "Remove all mechanic patrol zones so they can reach any ride. OpenRCT2 dispatches the nearest mechanic to each breakdown automatically — zone restrictions block this.",
                        onClick: function() { pendingAssignZones = true; }
                    },
                    {
                        type: "button",
                        x: 144, y: 256, width: 128, height: 16,
                        text: "Refresh",
                        tooltip: "Recount mechanics and rides and update this display",
                        onClick: function() { refreshWindow(); }
                    },
                    {
                        type: "checkbox", name: "chkAuto",
                        x: 8, y: 278, width: 264, height: 14,
                        text: "Auto-manage daily  (intervals + hiring + zones)",
                        isChecked: autoManage,
                        onChange: function(checked) { autoManage = checked; }
                    },
                    // Status feedback
                    { type: "label", name: "lblStatus", x: 8, y: 298, width: 264, height: 14, text: "" }
                ],
                onClose: function() { pluginWindow = null; }
            });
        }

        // Run once at startup so values are non-zero on first open.
        updateCache();

        if (typeof ui === "undefined") return;
        ui.registerMenuItem("Mechanic Manager", openWindow);
    }
});
