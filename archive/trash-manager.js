/// <reference path="gamesrc/OpenRCT2/distribution/scripting/openrct2.d.ts" />

/**
 * Trash Manager v3 — OpenRCT2 plugin
 *
 * Manages park litter and handyman staffing based on source-code-verified mechanics:
 *
 *   LITTER PENALTY (from Park.cpp):
 *     - Only litter aged >= 7680 ticks (~3 min) counts toward the rating penalty.
 *     - Penalty = min(150, oldLitterCount) * 4 rating points (max -600).
 *     - Fresh litter has a grace period and does not yet hurt your rating.
 *
 *   HANDYMAN RATIOS (community consensus):
 *     - 1 handyman per 15 path tiles (not per guest count).
 *     - Keep 2 unzoned "free-roaming" handymen as overflow coverage.
 *     - Small focused patrol zones outperform full-park roaming.
 *
 *   MOWING (critical):
 *     - Grass mowing (orders bit 8) must be disabled. When enabled, handymen
 *       abandon path sweeping to mow grass. RCT2 shipped with it off for this reason.
 *
 *   BROKEN BINS:
 *     - Vandalized bins don't collect litter. Litter -> disgust -> vandalism ->
 *       more broken bins is a cascade loop detectable via isAdditionBroken.
 */

registerPlugin({
    name: "Trash Manager",
    version: "3.0",
    authors: ["Matt"],
    type: "local",
    licence: "MIT",
    targetApiVersion: 87,
    main: trashManagerMain,
});

function trashManagerMain() {
    var storage = context.getParkStorage(); // per-save-file settings

    // -------------------------------------------------------------------------
    // Constants (Park.cpp source-verified values)
    // -------------------------------------------------------------------------

    var LITTER_OLD_AGE_TICKS    = 7680;  // ticks before litter starts costing rating (~3 min)
    var LITTER_PENALTY_CAP      = 150;   // rating penalty bottoms out at 150 old pieces
    var RATING_PTS_PER_LITTER   = 4;     // rating points lost per old litter piece
    var FREE_ROAMING_BUFFER     = 2;     // handymen kept unzoned for overflow coverage
    var PATH_TILES_PER_HANDYMAN = 12;    // Community consensus: 1 per 10-15 tiles (CoasterBuzz, myrct guide); 12 is midpoint
    // sweep (1) + empty bins (4); mowing (8) is intentionally excluded
    var HANDYMAN_ORDERS         = 1 | 4;

    /** Returns the user-configured max handymen cap (stored per save file, default 20). */
    function getMaxHandymen() {
        var v = storage.get("maxHandymen");
        return (v !== undefined && v !== null) ? v : 20;
    }

    // -------------------------------------------------------------------------
    // Cached state — rebuilt once per in-game day to avoid expensive per-tick scans
    // -------------------------------------------------------------------------

    var cache = {
        pathTiles:  0,
        oldLitter:  0,
        fullBins:   0,
        brokenBins: 0,
        vomit:      0,
        trash:      0,
        // Bounding box (tile coords) of park-owned land; set during updateCache.
        parkBounds: { x1: 1, y1: 1, x2: 127, y2: 127 },
        // Bounding box (tile coords) of tiles that have footpaths on them.
        // Used for zone subdivision — ensures handymen patrol where paths actually are,
        // not forested/empty owned land that has no litter to sweep.
        pathBounds: { x1: 1, y1: 1, x2: 127, y2: 127 },
    };

    // Deferred sweep flags: entity.remove() must run from interval.tick, not
    // from a UI button onClick handler (game state is not mutable in that context).
    var pendingSweepAll  = false;
    var pendingSweepOld  = false;
    var pendingFixOrders = false; // h.orders write must be deferred from onClick to interval.tick

    // -------------------------------------------------------------------------
    // Helpers
    // -------------------------------------------------------------------------

    function getHandymen() {
        return map.getAllEntities("staff").filter(function(s) {
            return s.staffType === "handyman";
        });
    }

    function getGuestsInPark() {
        return map.getAllEntities("guest").filter(function(g) {
            return g.isInPark;
        }).length;
    }

    /**
     * Returns true if this litter piece has aged past the grace period.
     *
     * Note: creationTick is a uint32 in C++ and can wrap around after ~49 days
     * of continuous ticks. The subtraction can go negative in JS, so we add 2^32
     * to correct for the wrap. Same fix as used by ParkRatingInspector.js.
     */
    function isOldLitter(litter) {
        var age = date.ticksElapsed - litter.creationTick;
        if (age < 0) age += 4294967296;
        return age >= LITTER_OLD_AGE_TICKS;
    }

    /** Penalty in rating points from the given old-litter count: min(150, n) * 4 */
    function computeRatingPenalty(oldCount) {
        return Math.min(LITTER_PENALTY_CAP, oldCount) * RATING_PTS_PER_LITTER;
    }

    /** Target handyman count: one per zone + the free-roaming buffer */
    function computeNeededHandymen(pathTileCount) {
        var zoned = Math.max(1, Math.ceil(pathTileCount / PATH_TILES_PER_HANDYMAN));
        return zoned + FREE_ROAMING_BUFFER;
    }

    // -------------------------------------------------------------------------
    // Full-map scan — only call from interval.day
    // -------------------------------------------------------------------------

    function updateCache() {
        var size      = map.size;
        var pathCount = 0, fullBins = 0, brokenBins = 0;
        var minPX = size.x, minPY = size.y, maxPX = 0, maxPY = 0;
        var minPathX = size.x, minPathY = size.y, maxPathX = 0, maxPathY = 0;

        for (var x = 0; x < size.x; x++) {
            for (var y = 0; y < size.y; y++) {
                var tile = map.getTile(x, y);
                // Surface element is always index 0; skip unowned tiles entirely.
                var surf = tile.getElement(0);
                if (!surf || surf.type !== "surface" || !surf.hasOwnership) continue;

                // Expand the park bounding box to include this owned tile.
                if (x < minPX) minPX = x;
                if (y < minPY) minPY = y;
                if (x > maxPX) maxPX = x;
                if (y > maxPY) maxPY = y;

                var hasPath = false;
                var pathCounted = false; // guard against double-count on bridge tiles (2 stacked footpaths)
                for (var i = 1; i < tile.numElements; i++) {
                    var el = tile.getElement(i);
                    if (el.type === "footpath") {
                        hasPath = true;
                        if (!el.isQueue && !pathCounted) { pathCount++; pathCounted = true; }
                        if (el.isAdditionFull)   fullBins++;
                        if (el.isAdditionBroken) brokenBins++;
                    }
                }
                // Track bounding box of tiles that actually have paths, so that
                // patrol zones are placed where handymen can actually sweep.
                if (hasPath) {
                    if (x < minPathX) minPathX = x;
                    if (y < minPathY) minPathY = y;
                    if (x > maxPathX) maxPathX = x;
                    if (y > maxPathY) maxPathY = y;
                }
            }
        }

        var fallback = { x1: 1, y1: 1, x2: size.x - 2, y2: size.y - 2 };
        cache.parkBounds = (maxPX >= minPX)
            ? { x1: minPX, y1: minPY, x2: maxPX, y2: maxPY }
            : fallback;
        // Use path bounds for zone subdivision; fall back to park bounds if no paths yet.
        cache.pathBounds = (maxPathX >= minPathX)
            ? { x1: minPathX, y1: minPathY, x2: maxPathX, y2: maxPathY }
            : cache.parkBounds;

        var oldCount = 0, vomitCount = 0, trashCount = 0;
        map.getAllEntities("litter").forEach(function(e) {
            if (isOldLitter(e)) oldCount++;
            if (e.litterType === "vomit" || e.litterType === "vomit_alt") vomitCount++;
            else trashCount++;
        });

        cache.pathTiles  = pathCount;
        cache.oldLitter  = oldCount;
        cache.fullBins   = fullBins;
        cache.brokenBins = brokenBins;
        cache.vomit      = vomitCount;
        cache.trash      = trashCount;
    }

    // -------------------------------------------------------------------------
    // Staff management
    // -------------------------------------------------------------------------

    /** Hires one handyman with correct orders. Calls onHired(peepId) on success. */
    function hireHandyman(onHired) {
        context.executeAction("staffhire", {
            autoPosition: true,
            staffType:    0, // 0 = handyman
            costumeIndex: 0,
            staffOrders:  HANDYMAN_ORDERS,
        }, function(result) {
            if ((!result.error || result.error === 0) && result.peep != null) {
                if (onHired) onHired(result.peep);
            }
        });
    }

    function fireHandyman() {
        var h = getHandymen();
        if (h.length > 0) {
            context.executeAction("stafffire", { id: h[h.length - 1].id });
        }
    }

    /**
     * Fixes a handyman whose orders include mowing or are missing sweep/bins tasks.
     * Direct property assignment is safe here because this only runs from interval.day.
     */
    function enforceHandymanOrders(h) {
        if (h.orders !== HANDYMAN_ORDERS) {
            h.orders = HANDYMAN_ORDERS;
        }
    }

    function enforceOrders() {
        getHandymen().forEach(enforceHandymanOrders);
    }

    // -------------------------------------------------------------------------
    // Patrol zone assignment
    // -------------------------------------------------------------------------

    /**
     * Returns the bounding rect (world coords) of tiles that have paths on them.
     * All handymen get this as their patrol zone so they can navigate any path in
     * the park without hitting rectangular sub-zone boundaries mid-path.
     * OpenRCT2's built-in dispatch sends the nearest available handyman to each
     * piece of litter, so geographic sub-division isn't needed for efficiency.
     */
    function getPathZone() {
        var b = cache.pathBounds;
        return { x1: b.x1 * 32, y1: b.y1 * 32, x2: b.x2 * 32, y2: b.y2 * 32 };
    }

    function assignZoneToHandyman(peepId, zone) {
        // Clear any existing patrol first (mode 2 = clear all) so repeated
        // reassignments don't accumulate stale tiles from previous zones.
        context.executeAction("staffsetpatrolarea", {
            id: peepId, x1: 0, y1: 0, x2: 0, y2: 0, mode: 2,
        });
        context.executeAction("staffsetpatrolarea", {
            id: peepId, x1: zone.x1, y1: zone.y1, x2: zone.x2, y2: zone.y2, mode: 0,
        });
    }

    /**
     * Assigns all handymen the full path-bounding-box patrol zone.
     * Sub-zone grids cause handymen to pace at zone edges when the only path
     * connecting two areas passes through a neighbouring rectangle.
     * Instead, every handyman gets the same zone covering all paths; OpenRCT2
     * dispatch sends whichever handyman is nearest to each piece of litter.
     */
    function reassignAllZones() {
        var handymen = getHandymen();
        if (handymen.length === 0) return;

        var zone = getPathZone();
        handymen.forEach(function(h) {
            assignZoneToHandyman(h.id, zone);
        });

        // Zone sync logged only when count changes to avoid daily spam.
    }

    // -------------------------------------------------------------------------
    // Interval hooks
    // -------------------------------------------------------------------------

    /**
     * Daily: update all caches, enforce orders, auto-hire/fire, log warnings.
     * Expensive tile/entity scans live here so they never run per-tick.
     */
    context.subscribe("interval.day", function() {
        updateCache();
        enforceOrders();

        var autoHire  = storage.get("autoHireEnabled") !== false;
        var autoSweep = storage.get("autoSweepEnabled") === true;

        if (autoSweep) {
            map.getAllEntities("litter").forEach(function(e) { e.remove(); });
            cache.oldLitter = 0;
            cache.trash     = 0;
            cache.vomit     = 0;
        }

        if (autoHire) {
            var handymen = getHandymen();
            var needed   = computeNeededHandymen(cache.pathTiles);
            var cap      = Math.min(needed, getMaxHandymen());
            var deficit  = cap - handymen.length;
            if (deficit > 0) {
                // Hire up to 3 per day so staffing recovers quickly after park expansions,
                // without flooding the park on initial load.
                var hireCount = Math.min(3, deficit);
                for (var i = 0; i < hireCount; i++) {
                    hireHandyman(function(peepId) {
                        assignZoneToHandyman(peepId, getPathZone());
                    });
                }
            } else if (handymen.length > needed + 3) {
                // Only fire when significantly overstaffed to avoid oscillation.
                fireHandyman();
            }
        }

        // Re-sync patrol zones daily so they track newly built paths.
        // pathBounds was just updated above by updateCache(); pushing the new zone
        // to all handymen ensures no one is patrolling a stale boundary.
        var currentHandymen = getHandymen();
        if (currentHandymen.length > 0) {
            reassignAllZones();
        }

        var penalty = computeRatingPenalty(cache.oldLitter);
        if (penalty >= 300) {
            console.log("[Trash Manager] Litter costing -" + penalty + " rating pts (" +
                cache.oldLitter + " old pieces; ceiling at " + LITTER_PENALTY_CAP + ").");
        }
        if (cache.brokenBins > 0) {
            console.log("[Trash Manager] " + cache.brokenBins +
                " broken bin(s) detected — vandalism cascade risk.");
        }
    });

    /**
     * Per-tick: process deferred sweep requests from UI buttons.
     * entity.remove() is only safe in this context (game state is mutable here).
     */
    context.subscribe("interval.tick", function() {
        if (!pendingSweepAll && !pendingSweepOld && !pendingFixOrders) return;

        // enforceOrders writes directly to entity properties; must run here, not in onClick.
        if (pendingFixOrders) { enforceOrders(); pendingFixOrders = false; }
        if (!pendingSweepAll && !pendingSweepOld) return;

        var sweepOldOnly = pendingSweepOld && !pendingSweepAll;
        pendingSweepAll  = false;
        pendingSweepOld  = false;

        var litter = map.getAllEntities("litter");

        if (sweepOldOnly) {
            // Keep only penalty-causing pieces; oldest-first so highest-damage
            // litter is removed first if there is ever a per-tick removal limit.
            litter = litter.filter(isOldLitter);
            litter.sort(function(a, b) { return a.creationTick - b.creationTick; });
        }

        litter.forEach(function(e) { e.remove(); });

        if (sweepOldOnly) {
            cache.oldLitter = 0;
        } else {
            cache.oldLitter = 0;
            cache.trash     = 0;
            cache.vomit     = 0;
        }

        console.log("[Trash Manager] Swept " + litter.length +
            (sweepOldOnly ? " old (penalty-causing)" : "") + " litter items.");
    });

    // -------------------------------------------------------------------------
    // UI
    // -------------------------------------------------------------------------

    // Populate cache immediately on load so the UI shows real values on first open,
    // not zeros. Without this, the cache stays empty until the first in-game day.
    updateCache();

    if (typeof ui === "undefined") return; // headless / dedicated server

    ui.registerMenuItem("Trash Manager", openWindow);

    var win           = null;
    var refreshHandle = null;

    function openWindow() {
        if (win !== null) { win.bringToFront(); return; }

        win = ui.openWindow({
            classification: "trash-manager",
            title: "Trash Manager v3",
            width: 300,
            height: 342,
            widgets: [
                // --- Rating Impact ---
                { type: "groupbox", x: 6, y: 16, width: 288, height: 66, text: "Rating Impact" },
                { type: "label", name: "lblRating", x: 14, y: 30, width: 276, height: 14, text: "Litter penalty: calculating..." },
                { type: "label", name: "lblThresh", x: 14, y: 46, width: 276, height: 14, text: "Severity: ----" },
                { type: "label", name: "lblLitter", x: 14, y: 62, width: 276, height: 14, text: "Total litter: --  (trash: --, vomit: --)" },

                // --- Staffing ---
                { type: "groupbox", x: 6, y: 88, width: 288, height: 52, text: "Staffing" },
                { type: "label", name: "lblHandymen", x: 14, y: 102, width: 276, height: 14, text: "Handymen: --  /  needed: --  /  max: --" },
                { type: "label", name: "lblBins",     x: 14, y: 118, width: 276, height: 14, text: "Bins: -- full, -- broken  (guests: --)" },

                // --- Automation ---
                { type: "groupbox", x: 6, y: 146, width: 288, height: 76, text: "Automation  (runs each in-game day)" },
                {
                    type: "checkbox", name: "chkAutoHire",
                    x: 14, y: 160, width: 276, height: 14,
                    text: "Auto-hire / fire handymen",
                    tooltip: "Targets 1 handyman per " + PATH_TILES_PER_HANDYMAN + " path tiles + " + FREE_ROAMING_BUFFER + " free-roaming; fires when overstaffed by >3",
                    isChecked: storage.get("autoHireEnabled") !== false,
                    onChange: function(v) { storage.set("autoHireEnabled", v); },
                },
                {
                    type: "checkbox", name: "chkAutoSweep",
                    x: 14, y: 178, width: 276, height: 14,
                    text: "Auto-sweep all litter each day",
                    isChecked: storage.get("autoSweepEnabled") === true,
                    onChange: function(v) { storage.set("autoSweepEnabled", v); },
                },
                { type: "label", x: 14, y: 200, width: 116, height: 14, text: "Max handymen cap:" },
                {
                    type: "spinner", name: "spnMaxHandymen",
                    x: 134, y: 198, width: 48, height: 16,
                    text: String(getMaxHandymen()),
                    tooltip: "Hard upper limit on auto-hired handymen; 1-99  (manual hires are unaffected)",
                    onIncrement: function() {
                        var n = Math.min(99, getMaxHandymen() + 1);
                        storage.set("maxHandymen", n);
                        if (win) win.findWidget("spnMaxHandymen").text = String(n);
                        refreshWindow();
                    },
                    onDecrement: function() {
                        var n = Math.max(1, getMaxHandymen() - 1);
                        storage.set("maxHandymen", n);
                        if (win) win.findWidget("spnMaxHandymen").text = String(n);
                        refreshWindow();
                    },
                },

                // --- Actions ---
                { type: "groupbox", x: 6, y: 228, width: 288, height: 102, text: "Actions" },
                {
                    type: "button", x: 14, y: 242, width: 86, height: 16,
                    text: "Sweep All",
                    tooltip: "Immediately remove every litter item from the park",
                    onClick: function() { pendingSweepAll = true; },
                },
                {
                    type: "button", x: 106, y: 242, width: 90, height: 16,
                    text: "Sweep Old Only",
                    tooltip: "Remove only litter aged 7680+ ticks — the pieces currently costing rating points",
                    onClick: function() { pendingSweepOld = true; },
                },
                {
                    type: "button", x: 202, y: 242, width: 86, height: 16,
                    text: "Hire Handyman",
                    tooltip: "Hire one handyman and assign them a patrol zone",
                    onClick: function() {
                        hireHandyman(function(id) {
                            assignZoneToHandyman(id, getPathZone());
                        });
                    },
                },
                {
                    type: "button", x: 14, y: 262, width: 134, height: 16,
                    text: "Reassign All Zones",
                    tooltip: "Set all handymen to patrol the path-tile area of the park; OpenRCT2 dispatches the nearest handyman to each piece of litter automatically",
                    onClick: reassignAllZones,
                },
                {
                    type: "button", x: 154, y: 262, width: 134, height: 16,
                    text: "Fix Orders (No Mow)",
                    tooltip: "Enable sweep + empty bins on all handymen; disables grass mowing which causes handymen to abandon path sweeping",
                    onClick: function() { pendingFixOrders = true; },
                },
                {
                    type: "button", x: 14, y: 282, width: 274, height: 16,
                    text: "Force Full Scan & Refresh",
                    tooltip: "Re-scan all tiles and entities to update displayed counts",
                    onClick: function() { updateCache(); refreshWindow(); },
                },

                { type: "label", name: "lblStatus", x: 14, y: 302, width: 276, height: 14, text: "" },
            ],
            onClose: function() {
                win = null;
                if (refreshHandle !== null) {
                    context.clearInterval(refreshHandle);
                    refreshHandle = null;
                }
            },
        });

        refreshWindow();
        // Refresh display every 3 real-world seconds; reads cached values only, not a tile scan
        refreshHandle = context.setInterval(refreshWindow, 3000);
    }

    /** Builds a text severity bar: "[####................] 20%" */
    function makeThresholdBar(oldCount) {
        var pct    = Math.min(1.0, oldCount / LITTER_PENALTY_CAP);
        var filled = Math.round(pct * 20);
        var bar    = "[";
        for (var i = 0; i < 20; i++) bar += (i < filled ? "#" : ".");
        bar += "]";
        var label  = pct === 0      ? "none"
                   : pct < 0.25    ? "low"
                   : pct < 0.5     ? "medium"
                   : pct < 0.75    ? "high"
                   : "CRITICAL";
        return "Severity: " + label + "  " + bar + "  " + Math.round(pct * 100) + "%";
    }

    /** Updates all window labels from current cache + live data. */
    function refreshWindow() {
        if (!win) return;

        var totalLitter = map.getAllEntities("litter").length; // live count, cheap
        var penalty     = computeRatingPenalty(cache.oldLitter);
        var handymen    = getHandymen();
        var needed      = computeNeededHandymen(cache.pathTiles);

        win.findWidget("lblRating").text   =
            "Litter penalty: -" + penalty + " pts  (" + cache.oldLitter + " old / " + LITTER_PENALTY_CAP + " max)";
        win.findWidget("lblThresh").text   = makeThresholdBar(cache.oldLitter);
        win.findWidget("lblLitter").text   =
            "Total litter: " + totalLitter + "  (trash: " + cache.trash + ", vomit: " + cache.vomit + ")";
        win.findWidget("lblHandymen").text =
            "Handymen: " + handymen.length + "  /  needed: " + needed + "  /  max: " + getMaxHandymen() + "  (tiles: " + cache.pathTiles + ")";
        win.findWidget("lblBins").text     =
            "Bins: " + cache.fullBins + " full, " + cache.brokenBins + " broken  (guests: " + getGuestsInPark() + ")";
        win.findWidget("lblStatus").text   =
            cache.brokenBins > 0 ? "[!] Broken bins detected -- vandalism cascade risk!" : "";
    }
}
