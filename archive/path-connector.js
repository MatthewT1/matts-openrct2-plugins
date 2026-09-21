/// <reference path="gamesrc/OpenRCT2/distribution/scripting/openrct2.d.ts" />

/**
 * Path Connector v3 — OpenRCT2 plugin
 *
 * Builds an L-shaped (or straight) footpath between two player-picked tiles,
 * with analysis warnings before committing.
 *
 *   USAGE:
 *     1. Open via the top menu → "Path Connector".
 *     2. Click "Pick Start Tile" and click a tile on the map.
 *     3. Click "Pick End Tile" and click another tile.
 *     4. Review the preview and any warnings, then click "Place Path".
 *
 *   NEW IN v3:
 *     - Connectivity check: warns if the route won't touch the existing path network
 *       (disconnected paths can't be used by guests).
 *     - Width check: warns if any new tile would create a 3-wide or wider section
 *       (wide paths confuse guest pathfinding).
 *     - Dead-end detection: flags interior tiles with only one connection after placement.
 *     - Auto bin placement: optionally places litter bins every N tiles on new paths.
 *     - Ride exit scanner: finds ride exits with no adjacent path (stranded guests).
 *
 *   KEY FIXES CARRIED FROM v2:
 *     - FootpathPlaceArgs.object is the surface index (d.ts: "/** Surface object * /").
 *       v1 incorrectly used object: -1 with a non-existent "surfaceObject" field.
 *     - ToolFilter ["terrain"] restricts the tile picker to map surface tiles only.
 */

registerPlugin({
    name: "Path Connector",
    version: "3.0",
    authors: ["Matt"],
    type: "local",
    licence: "MIT",
    targetApiVersion: 87,
    main: pathConnectorMain,
});

function pathConnectorMain() {
    if (typeof ui === "undefined") return; // headless / server mode

    ui.registerMenuItem("Path Connector", openWindow);

    // -------------------------------------------------------------------------
    // State
    // -------------------------------------------------------------------------

    var startTile       = null;  // { x, y } in tile coordinates (world = tile * 32)
    var endTile         = null;
    var routeMode       = "smart"; // "smart", "H_then_V", or "V_then_H"
    var autoBinsEnabled = false;
    var binSpacing      = 5;         // place a bin every N tiles along new paths

    // Cardinal directions for neighbor checks
    var DIRS = [{ dx: 0, dy: -1 }, { dx: 1, dy: 0 }, { dx: 0, dy: 1 }, { dx: -1, dy: 0 }];

    // -------------------------------------------------------------------------
    // Path style detection
    // -------------------------------------------------------------------------

    /**
     * Scans the map for an existing footpath and returns its object indices.
     * Prefers NSF (new-style footpath_surface) paths; falls back to legacy DAT paths.
     * Returns { isLegacy, surfaceObj, railingsObj }.
     */
    function detectExistingPathStyle() {
        var size = map.size;
        for (var x = 1; x < size.x - 1; x++) {
            for (var y = 1; y < size.y - 1; y++) {
                var tile = map.getTile(x, y);
                for (var i = 0; i < tile.numElements; i++) {
                    var el = tile.getElement(i);
                    if (el.type !== "footpath" || el.isQueue) continue;
                    if (el.surfaceObject !== null && el.surfaceObject >= 0) {
                        // NSF-style (modern, separate surface + railings objects)
                        return {
                            isLegacy:    false,
                            surfaceObj:  el.surfaceObject,
                            railingsObj: el.railingsObject !== null ? el.railingsObject : 0,
                        };
                    }
                    if (el.object !== null && el.object >= 0) {
                        // Legacy DAT path (single combined object)
                        return { isLegacy: true, surfaceObj: el.object, railingsObj: 0xFF };
                    }
                }
            }
        }

        // No existing path in park — fall back to whatever is loaded
        var surfaces = objectManager.getAllObjects("footpath_surface");
        if (surfaces.length > 0) {
            var railings = objectManager.getAllObjects("footpath_railings");
            return {
                isLegacy:    false,
                surfaceObj:  surfaces[0].index,
                railingsObj: railings.length > 0 ? railings[0].index : 0,
            };
        }
        var legacy = objectManager.getAllObjects("footpath");
        return { isLegacy: true, surfaceObj: legacy.length > 0 ? legacy[0].index : 0, railingsObj: 0xFF };
    }

    // -------------------------------------------------------------------------
    // Tile helpers
    // -------------------------------------------------------------------------

    function getSurfaceElement(tx, ty) {
        var tile = map.getTile(tx, ty);
        for (var i = 0; i < tile.numElements; i++) {
            var el = tile.getElement(i);
            if (el.type === "surface") return el;
        }
        return null;
    }

    function hasFootpath(tx, ty) {
        var tile = map.getTile(tx, ty);
        for (var i = 0; i < tile.numElements; i++) {
            if (tile.getElement(i).type === "footpath") return true;
        }
        return false;
    }

    function tileIsOwned(tx, ty) {
        var surf = getSurfaceElement(tx, ty);
        return surf !== null && surf.hasOwnership;
    }

    /**
     * Returns true if a tile has an element type that will block footpath placement.
     * Track and entrance elements are hard blockers — the footpathplace action will
     * always fail on these tiles regardless of ownership or clearance flags.
     */
    function hasBlockingElement(tx, ty) {
        var tile = map.getTile(tx, ty);
        for (var i = 0; i < tile.numElements; i++) {
            var type = tile.getElement(i).type;
            if (type === "track" || type === "entrance") return true;
        }
        return false;
    }

    // -------------------------------------------------------------------------
    // Route building
    // -------------------------------------------------------------------------

    /**
     * A* pathfinding from start to end, routing around blocked tiles.
     *
     * Cost model:
     *   - Tiles with track/entrance: impassable (skipped entirely)
     *   - Owned tiles:   cost 1 (preferred)
     *   - Unowned tiles: cost 8 (avoided but not impossible — a route through
     *     unowned land is better than no route at all)
     *
     * Returns an array of tile coordinates, or null if no path is found within
     * MAX_NODES explored nodes (prevents freezing on pathologically complex maps).
     */
    function findSmartRoute(start, end) {
        var MAX_NODES = 15000;
        var size      = map.size;

        function key(x, y) { return x + "," + y; }
        // Manhattan distance — admissible heuristic for a 4-directional grid
        function heuristic(x, y) {
            return Math.abs(x - end.x) + Math.abs(y - end.y);
        }
        function moveCost(tx, ty) {
            return tileIsOwned(tx, ty) ? 1 : 8;
        }
        function inBounds(tx, ty) {
            return tx >= 1 && ty >= 1 && tx < size.x - 1 && ty < size.y - 1;
        }

        var startKey = key(start.x, start.y);
        var endKey   = key(end.x, end.y);

        // Open set: array of { x, y, f }. We find the minimum f each iteration.
        // Simple linear scan is fine here — typical routes are short enough that
        // a proper heap doesn't matter in practice.
        var open   = [{ x: start.x, y: start.y, f: heuristic(start.x, start.y) }];
        var gScore = {};  // best known cost to reach each tile
        var parent = {};  // tile key -> parent key, for path reconstruction
        gScore[startKey] = 0;
        parent[startKey] = null;

        var explored = 0;

        while (open.length > 0 && explored < MAX_NODES) {
            // Find and remove the node with lowest f score
            var bestIdx = 0;
            for (var i = 1; i < open.length; i++) {
                if (open[i].f < open[bestIdx].f) bestIdx = i;
            }
            var curr    = open.splice(bestIdx, 1)[0];
            var currKey = key(curr.x, curr.y);
            explored++;

            if (currKey === endKey) {
                // Reconstruct path by walking parent pointers from end back to start
                var path = [];
                var node = currKey;
                while (node !== null) {
                    var parts = node.split(",");
                    path.unshift({ x: parseInt(parts[0]), y: parseInt(parts[1]) });
                    node = parent[node];
                }
                return path;
            }

            for (var d = 0; d < DIRS.length; d++) {
                var nx   = curr.x + DIRS[d].dx;
                var ny   = curr.y + DIRS[d].dy;
                var nKey = key(nx, ny);
                if (!inBounds(nx, ny) || hasBlockingElement(nx, ny)) continue;

                var tentativeG = gScore[currKey] + moveCost(nx, ny);
                var knownG     = gScore[nKey] !== undefined ? gScore[nKey] : Infinity;
                if (tentativeG < knownG) {
                    gScore[nKey] = tentativeG;
                    parent[nKey] = currKey;
                    open.push({ x: nx, y: ny, f: tentativeG + heuristic(nx, ny) });
                }
            }
        }

        return null; // no path found within node limit
    }

    /**
     * Returns an ordered list of tile coordinates from start to end.
     *
     * mode "smart":    A* pathfinding; falls back to "H_then_V" if no path found.
     * mode "H_then_V": L-shape, horizontal leg first.
     * mode "V_then_H": L-shape, vertical leg first.
     */
    function buildRoute(start, end, mode) {
        if (mode === "smart") {
            var smartPath = findSmartRoute(start, end);
            if (smartPath) return smartPath;
            // A* couldn't find a route (fully blocked or too complex) — fall back
            console.log("[Path Connector] Smart routing found no clear path; falling back to L-shape.");
            mode = "H_then_V";
        }

        var route = [];
        var x = start.x, y = start.y;
        var ex = end.x, ey = end.y;
        var dx = ex > x ? 1 : ex < x ? -1 : 0;
        var dy = ey > y ? 1 : ey < y ? -1 : 0;

        if (mode === "H_then_V") {
            while (x !== ex) { route.push({ x: x, y: y }); x += dx; }
            while (y !== ey) { route.push({ x: x, y: y }); y += dy; }
        } else {
            while (y !== ey) { route.push({ x: x, y: y }); y += dy; }
            while (x !== ex) { route.push({ x: x, y: y }); x += dx; }
        }
        route.push({ x: ex, y: ey });
        return route;
    }

    // -------------------------------------------------------------------------
    // Route analysis (v3)
    // -------------------------------------------------------------------------

    /**
     * Checks if any tile adjacent to the route already has a path.
     * If none do, the entire placed route will be disconnected from the park network
     * and guests won't be able to use it.
     */
    function routeConnectsToNetwork(route) {
        // Build a set of route tile coordinates for quick lookup
        var inRoute = {};
        route.forEach(function(t) { inRoute[t.x + "," + t.y] = true; });

        for (var i = 0; i < route.length; i++) {
            for (var d = 0; d < DIRS.length; d++) {
                var nx = route[i].x + DIRS[d].dx;
                var ny = route[i].y + DIRS[d].dy;
                if (!inRoute[nx + "," + ny] && hasFootpath(nx, ny)) return true;
            }
        }
        return false;
    }

    /**
     * Returns the subset of new tiles that would have 2+ existing path neighbors
     * outside the route — these create 3-wide (or wider) sections.
     * Wide paths confuse guest pathfinding in RCT2.
     */
    function findWidthViolations(newTiles) {
        var inRoute = {};
        newTiles.forEach(function(t) { inRoute[t.x + "," + t.y] = true; });

        return newTiles.filter(function(t) {
            var existingNeighbors = 0;
            DIRS.forEach(function(d) {
                var nx = t.x + d.dx, ny = t.y + d.dy;
                if (!inRoute[nx + "," + ny] && hasFootpath(nx, ny)) existingNeighbors++;
            });
            return existingNeighbors >= 2;
        });
    }

    /**
     * Returns interior route tiles (not start/end) that would end up with only
     * one path neighbor after placement — unexpected dead-ends mid-route.
     */
    function findInteriorDeadEnds(newTiles) {
        if (newTiles.length <= 2) return [];
        var inRoute = {};
        newTiles.forEach(function(t) { inRoute[t.x + "," + t.y] = true; });

        // Check all tiles except the first and last (those are the intended endpoints)
        return newTiles.slice(1, newTiles.length - 1).filter(function(t) {
            var connections = 0;
            DIRS.forEach(function(d) {
                var nx = t.x + d.dx, ny = t.y + d.dy;
                if (inRoute[nx + "," + ny] || hasFootpath(nx, ny)) connections++;
            });
            return connections <= 1;
        });
    }

    /** Full analysis of a route; returns { summary, warnings, canPlace }. */
    function analyzeRoute(route) {
        var newTiles     = route.filter(function(t) { return !hasFootpath(t.x, t.y); });
        var blockedTiles = newTiles.filter(function(t) { return hasBlockingElement(t.x, t.y); });
        var unownedCount = newTiles.filter(function(t) { return !tileIsOwned(t.x, t.y); }).length;
        var placeable    = newTiles.filter(function(t) {
            return tileIsOwned(t.x, t.y) && !hasBlockingElement(t.x, t.y);
        });
        var warnings     = [];

        if (blockedTiles.length > 0) {
            warnings.push(blockedTiles.length + " tile(s) blocked by rides or entrances — placement will fail there");
        }
        if (!routeConnectsToNetwork(route)) {
            warnings.push("Route doesn't connect to the existing path network — guests won't be able to use it");
        }
        var widthViolations = findWidthViolations(newTiles);
        if (widthViolations.length > 0) {
            warnings.push(widthViolations.length + " tile(s) would create 3-wide paths — may confuse guest pathfinding");
        }
        var deadEnds = findInteriorDeadEnds(newTiles);
        if (deadEnds.length > 0) {
            warnings.push(deadEnds.length + " interior tile(s) have only one connection — unexpected dead-ends");
        }
        if (unownedCount > 0) {
            warnings.push(unownedCount + " tile(s) are outside park ownership and will be skipped");
        }

        return {
            summary:   "Route: " + route.length + " tiles  (" + placeable.length + " placeable, " +
                       (route.length - newTiles.length) + " existing" +
                       (blockedTiles.length > 0 ? ", " + blockedTiles.length + " blocked" : "") + ")",
            warnings:  warnings,
            canPlace:  placeable.length > 0,
        };
    }

    // -------------------------------------------------------------------------
    // Bin placement (v3)
    // -------------------------------------------------------------------------

    /**
     * Finds the object index for a litter bin from loaded footpath additions.
     * Checks identifier first (most reliable), then display name as a fallback.
     * Returns -1 if no suitable object is found.
     */
    function findBinObjectIndex() {
        var additions = objectManager.getAllObjects("footpath_addition");
        for (var i = 0; i < additions.length; i++) {
            var id   = (additions[i].identifier || "").toLowerCase();
            var name = (additions[i].name       || "").toLowerCase();
            if (id.indexOf("litter") !== -1 || id.indexOf("bin") !== -1 ||
                name.indexOf("bin")  !== -1 || name.indexOf("litter") !== -1) {
                return additions[i].index;
            }
        }
        return additions.length > 0 ? additions[0].index : -1;
    }

    /** Places bins on the given tiles at every binSpacing-th position. */
    function placeBinsAlongRoute(placedTiles) {
        var binIdx = findBinObjectIndex();
        if (binIdx < 0) {
            console.log("[Path Connector] No bin/addition objects found -- skipping auto-bin placement.");
            return;
        }
        placedTiles.forEach(function(t, i) {
            if (i % binSpacing !== 0) return;
            var surf = getSurfaceElement(t.x, t.y);
            if (!surf) return;
            context.executeAction("footpathadditionplace", {
                x: t.x * 32, y: t.y * 32, z: surf.baseZ, object: binIdx,
            }, function() {});
        });
    }

    // -------------------------------------------------------------------------
    // Path placement
    // -------------------------------------------------------------------------

    /**
     * Places a single footpath tile at (tx, ty).
     * FootpathPlaceArgs.object is the surface object index (per d.ts comment:
     * "/** Surface object * /"). direction 0xFF = flat/no-slope.
     */
    function placePathTile(tx, ty, style, callback) {
        var surf = getSurfaceElement(tx, ty);
        if (!surf) { callback("no surface element"); return; }

        context.executeAction("footpathplace", {
            x:              tx * 32,
            y:              ty * 32,
            z:              surf.baseZ,
            direction:      0xFF, // no forced slope
            object:         style.surfaceObj,
            railingsObject: style.railingsObj,
            slopeType:      0,
            slopeDirection: 0,
            constructFlags: 0,
        }, function(result) {
            callback(result.error && result.error !== 0
                ? (result.errorMessage || "error code " + result.error)
                : null);
        });
    }

    /**
     * Connects start and end tiles with an L-shaped path.
     * Skips tiles that are already paths or outside park ownership.
     * Calls placeBinsAlongRoute on new tiles if auto-bins is enabled.
     */
    function connectPaths() {
        if (!startTile || !endTile) {
            ui.showError("Path Connector", "Set both start and end tiles first.");
            return;
        }

        var style        = detectExistingPathStyle();
        var route        = buildRoute(startTile, endTile, routeMode);
        var total        = route.length;
        var done         = 0;
        var placed       = 0, skippedPath = 0, skippedOwn = 0, errors = 0;
        var placedTiles  = [];

        if (!routeConnectsToNetwork(route)) {
            console.log("[Path Connector] Warning: route is disconnected from the existing path network.");
        }

        function onTileDone() {
            done++;
            if (done < total) return;
            // All tiles processed
            console.log("[Path Connector] Done. Placed: " + placed +
                "  skipped (existing path): " + skippedPath +
                "  skipped (unowned): " + skippedOwn +
                "  errors: " + errors);
            if (autoBinsEnabled && placedTiles.length > 0) {
                placeBinsAlongRoute(placedTiles);
            }
            startTile = null;
            endTile   = null;
            refreshWindow();
        }

        route.forEach(function(tile) {
            if (!tileIsOwned(tile.x, tile.y)) {
                skippedOwn++;
                onTileDone();
                return;
            }
            if (hasFootpath(tile.x, tile.y)) {
                skippedPath++;
                onTileDone();
                return;
            }
            placePathTile(tile.x, tile.y, style, function(err) {
                if (err) {
                    errors++;
                    console.log("[Path Connector] Failed tile (" + tile.x + "," + tile.y + "): " + err);
                } else {
                    placed++;
                    placedTiles.push(tile);
                }
                onTileDone();
            });
        });
    }

    // -------------------------------------------------------------------------
    // Ride exit scanner (v3)
    // -------------------------------------------------------------------------

    /**
     * Scans for track/entrance tiles with no adjacent footpath.
     * These represent ride exits that guests can't walk away from.
     */
    function findDisconnectedRideExits() {
        var size         = map.size;
        var disconnected = [];

        for (var x = 1; x < size.x - 1; x++) {
            for (var y = 1; y < size.y - 1; y++) {
                var tile    = map.getTile(x, y);
                var hasExit = false;
                for (var i = 0; i < tile.numElements; i++) {
                    var type = tile.getElement(i).type;
                    if (type === "track" || type === "entrance") { hasExit = true; break; }
                }
                if (!hasExit) continue;

                var hasAdjacentPath = DIRS.some(function(d) {
                    return hasFootpath(x + d.dx, y + d.dy);
                });
                if (!hasAdjacentPath) disconnected.push({ x: x, y: y });
            }
        }
        return disconnected;
    }

    // -------------------------------------------------------------------------
    // UI
    // -------------------------------------------------------------------------

    var win = null;

    function openWindow() {
        if (win !== null) { win.bringToFront(); return; }

        win = ui.openWindow({
            classification: "path-connector",
            title: "Path Connector v3",
            width: 280,
            height: 290,
            widgets: [
                // --- Tile Selection ---
                { type: "groupbox", x: 6, y: 18, width: 268, height: 56, text: "Tile Selection" },
                { type: "label", x: 14, y: 32, width: 254, height: 14, name: "lblStart", text: "Start: (not set)" },
                { type: "label", x: 14, y: 48, width: 254, height: 14, name: "lblEnd",   text: "End:   (not set)" },

                {
                    type: "button", x: 14, y: 80, width: 124, height: 16,
                    text: "Pick Start Tile",
                    tooltip: "Click to activate the tile picker, then click any map tile to set the start point",
                    onClick: function() { activatePicker("start"); },
                },
                {
                    type: "button", x: 144, y: 80, width: 124, height: 16,
                    text: "Pick End Tile",
                    tooltip: "Click to activate the tile picker, then click any map tile to set the end point",
                    onClick: function() { activatePicker("end"); },
                },

                // --- Route Settings ---
                { type: "groupbox", x: 6, y: 102, width: 268, height: 72, text: "Route Settings" },
                { type: "label", x: 14, y: 116, width: 90, height: 14, text: "Route shape:" },
                {
                    type: "dropdown",
                    x: 104, y: 114, width: 162, height: 14,
                    name: "ddRouteMode",
                    items: ["Smart (avoid obstacles)", "Horizontal then Vertical", "Vertical then Horizontal"],
                    selectedIndex: 0,
                    onChange: function(i) {
                        routeMode = i === 0 ? "smart" : i === 1 ? "H_then_V" : "V_then_H";
                        refreshWindow();
                    },
                },
                {
                    type: "checkbox", x: 14, y: 134, width: 200, height: 14,
                    name: "chkAutoBins",
                    text: "Auto-place bins every N tiles",
                    isChecked: false,
                    onChange: function(v) { autoBinsEnabled = v; refreshWindow(); },
                },
                {
                    type: "spinner", x: 224, y: 134, width: 44, height: 14,
                    name: "spnBinSpacing",
                    text: String(binSpacing),
                    isDisabled: !autoBinsEnabled,
                    onClick: function(isUp) {
                        binSpacing = Math.max(2, Math.min(20, binSpacing + (isUp ? 1 : -1)));
                        if (win) win.findWidget("spnBinSpacing").text = String(binSpacing);
                    },
                },

                // --- Preview / Warnings ---
                { type: "groupbox", x: 6, y: 180, width: 268, height: 72, text: "Preview & Warnings" },
                { type: "label", x: 14, y: 194, width: 254, height: 14, name: "lblPreview", text: "Select both tiles to preview." },
                { type: "label", x: 14, y: 210, width: 254, height: 14, name: "lblWarn1",   text: "" },
                { type: "label", x: 14, y: 224, width: 254, height: 14, name: "lblWarn2",   text: "" },
                { type: "label", x: 14, y: 238, width: 254, height: 14, name: "lblWarn3",   text: "" },

                // --- Action Buttons ---
                {
                    type: "button", x: 14, y: 258, width: 116, height: 20,
                    name: "btnConnect",
                    text: "Place Path",
                    isDisabled: true,
                    onClick: connectPaths,
                },
                {
                    type: "button", x: 136, y: 258, width: 66, height: 20,
                    text: "Scan Exits",
                    tooltip: "Find ride exits with no adjacent footpath (stranded guests). Results are written to the in-game console.",
                    onClick: function() {
                        var exits = findDisconnectedRideExits();
                        if (exits.length === 0) {
                            console.log("[Path Connector] All ride exits have adjacent footpaths.");
                        } else {
                            var preview = exits.slice(0, 5).map(function(e) {
                                return "(" + e.x + "," + e.y + ")";
                            }).join(", ");
                            console.log("[Path Connector] " + exits.length +
                                " disconnected ride exit(s): " + preview +
                                (exits.length > 5 ? " ..." : ""));
                        }
                    },
                },
                {
                    type: "button", x: 208, y: 258, width: 60, height: 20,
                    text: "Clear",
                    onClick: function() { startTile = null; endTile = null; refreshWindow(); },
                },
            ],
            onClose: function() {
                win = null;
                // Cancel any active tile picker when the window is closed
                if (ui.tool) ui.tool.cancel();
            },
        });

        refreshWindow();
    }

    function activatePicker(which) {
        ui.activateTool({
            id:     "path-connector-pick-" + which,
            cursor: "cross_hair",
            // ToolFilter "terrain" limits clicks to map surface tiles, not entities or UI
            filter: ["terrain"],
            onDown: function(e) {
                if (!e.mapCoords) return;
                var tile = {
                    x: Math.floor(e.mapCoords.x / 32),
                    y: Math.floor(e.mapCoords.y / 32),
                };
                if (which === "start") startTile = tile;
                else                   endTile   = tile;

                if (ui.tool) ui.tool.cancel();
                refreshWindow();
            },
        });
    }

    /** Updates all window labels from current start/end state and route analysis. */
    function refreshWindow() {
        if (!win) return;

        win.findWidget("lblStart").text = "Start: " +
            (startTile ? "tile (" + startTile.x + ", " + startTile.y + ")" : "(not set)");
        win.findWidget("lblEnd").text   = "End:   " +
            (endTile ? "tile (" + endTile.x + ", " + endTile.y + ")" : "(not set)");

        win.findWidget("spnBinSpacing").isDisabled = !autoBinsEnabled;

        var ready = startTile !== null && endTile !== null;
        win.findWidget("btnConnect").isDisabled = !ready;

        // Clear warning lines before repopulating
        win.findWidget("lblWarn1").text = "";
        win.findWidget("lblWarn2").text = "";
        win.findWidget("lblWarn3").text = "";

        if (!ready) {
            win.findWidget("lblPreview").text = "Select both tiles to preview route.";
            return;
        }

        var route    = buildRoute(startTile, endTile, routeMode);
        var analysis = analyzeRoute(route);
        win.findWidget("lblPreview").text = analysis.summary;

        for (var i = 0; i < Math.min(3, analysis.warnings.length); i++) {
            win.findWidget("lblWarn" + (i + 1)).text = "[!]  " + analysis.warnings[i];
        }
    }
}
