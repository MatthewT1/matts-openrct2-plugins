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

// ---------------------------------------------------------------------------
// Local interfaces
// ---------------------------------------------------------------------------

/** Tile-space coordinate (world = tile * 32). */
interface TileCoord {
    x: number;
    y: number;
}

/** Resolved path style to use when placing footpath tiles. */
interface PathStyle {
    isLegacy: boolean;
    surfaceObj: number;
    railingsObj: number;
}

/** Output of analyzeRoute(). */
interface RouteAnalysis {
    summary: string;
    warnings: string[];
    canPlace: boolean;
}

/** Unit vector for a cardinal direction. */
interface Dir {
    dx: number;
    dy: number;
}

// ---------------------------------------------------------------------------

registerPlugin({
    name: "Path Connector",
    version: __PLUGIN_VERSION__,
    authors: ["MattT"],
    type: "local",
    licence: "MIT",
    targetApiVersion: 87,
    main: pathConnectorMain,
});

function pathConnectorMain(): void {
    if (typeof ui === "undefined") return; // headless / server mode

    ui.registerMenuItem("Path Connector", openWindow);

    // -------------------------------------------------------------------------
    // State
    // -------------------------------------------------------------------------

    let startTile: TileCoord | null = null;  // tile coordinates (world = tile * 32)
    let endTile: TileCoord | null = null;
    let routeMode: "smart" | "H_then_V" | "V_then_H" = "smart";
    let autoBinsEnabled = false;
    let binSpacing = 5;         // place a bin every N tiles along new paths

    // Cardinal directions for neighbor checks
    const DIRS: Dir[] = [
        { dx: 0, dy: -1 }, { dx: 1, dy: 0 }, { dx: 0, dy: 1 }, { dx: -1, dy: 0 },
    ];

    // -------------------------------------------------------------------------
    // Path style detection
    // -------------------------------------------------------------------------

    /**
     * Scans the map for an existing footpath and returns its object indices.
     * Prefers NSF (new-style footpath_surface) paths; falls back to legacy DAT paths.
     * Returns { isLegacy, surfaceObj, railingsObj }.
     */
    function detectExistingPathStyle(): PathStyle {
        const size = map.size;
        for (let x = 1; x < size.x - 1; x++) {
            for (let y = 1; y < size.y - 1; y++) {
                const tile = map.getTile(x, y);
                for (let i = 0; i < tile.numElements; i++) {
                    const el = tile.getElement(i);
                    if (el.type !== "footpath") continue;
                    if (el.isQueue) continue;
                    // el is now narrowed to FootpathElement
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
        const surfaces = objectManager.getAllObjects("footpath_surface");
        if (surfaces.length > 0) {
            const railings = objectManager.getAllObjects("footpath_railings");
            return {
                isLegacy:    false,
                surfaceObj:  surfaces[0].index,
                railingsObj: railings.length > 0 ? railings[0].index : 0,
            };
        }
        const legacy = objectManager.getAllObjects("footpath");
        return { isLegacy: true, surfaceObj: legacy.length > 0 ? legacy[0].index : 0, railingsObj: 0xFF };
    }

    // -------------------------------------------------------------------------
    // Tile helpers
    // -------------------------------------------------------------------------

    /**
     * Cached per-tile facts.
     *
     * A* and analyzeRoute each ask the same handful of questions about the same tiles
     * over and over — the A* frontier alone did two map.getTile() calls plus two full
     * element walks per neighbour, four neighbours per node, up to 15000 nodes. Reading
     * each tile once and reusing the answer turns that into one walk per distinct tile.
     *
     * The cache is invalidated by invalidateTileFacts() whenever we place anything, and
     * at the start of every user-initiated operation, so it never outlives a change to
     * the map.
     */
    interface TileFacts {
        owned:    boolean;
        footpath: boolean;
        blocked:  boolean;
        baseZ:    number;   // surface baseZ, or -1 when the tile has no surface element
    }

    let tileFacts: Record<string, TileFacts> = {};

    function invalidateTileFacts(): void {
        tileFacts = {};
    }

    function getTileFacts(tx: number, ty: number): TileFacts {
        const k = tx + "," + ty;
        const hit = tileFacts[k];
        if (hit !== undefined) return hit;

        const tile = map.getTile(tx, ty);
        const facts: TileFacts = { owned: false, footpath: false, blocked: false, baseZ: -1 };
        for (let i = 0; i < tile.numElements; i++) {
            const el = tile.getElement(i);
            const type = el.type;
            if (type === "surface") {
                facts.owned = (el as SurfaceElement).hasOwnership;
                facts.baseZ = el.baseZ;
            } else if (type === "footpath") {
                facts.footpath = true;
            } else if (type === "track" || type === "entrance") {
                // Hard blockers — the footpathplace action always fails on these tiles
                // regardless of ownership or clearance flags.
                facts.blocked = true;
            }
        }
        tileFacts[k] = facts;
        return facts;
    }

    function getSurfaceElement(tx: number, ty: number): SurfaceElement | null {
        const tile = map.getTile(tx, ty);
        for (let i = 0; i < tile.numElements; i++) {
            const el = tile.getElement(i);
            if (el.type === "surface") return el;
        }
        return null;
    }

    function hasFootpath(tx: number, ty: number): boolean {
        return getTileFacts(tx, ty).footpath;
    }

    function tileIsOwned(tx: number, ty: number): boolean {
        return getTileFacts(tx, ty).owned;
    }

    function hasBlockingElement(tx: number, ty: number): boolean {
        return getTileFacts(tx, ty).blocked;
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
    function findSmartRoute(start: TileCoord, end: TileCoord): TileCoord[] | null {
        const MAX_NODES = 15000;
        const size = map.size;

        function key(x: number, y: number): string { return x + "," + y; }
        // Manhattan distance — admissible heuristic for a 4-directional grid
        function heuristic(x: number, y: number): number {
            return Math.abs(x - end.x) + Math.abs(y - end.y);
        }
        function moveCost(tx: number, ty: number): number {
            return tileIsOwned(tx, ty) ? 1 : 8;
        }
        function inBounds(tx: number, ty: number): boolean {
            return tx >= 1 && ty >= 1 && tx < size.x - 1 && ty < size.y - 1;
        }

        const startKey = key(start.x, start.y);
        const endKey   = key(end.x, end.y);

        // Open set: array of { x, y, f }. We find the minimum f each iteration.
        // Simple linear scan is fine here — typical routes are short enough that
        // a proper heap doesn't matter in practice.
        const open: Array<{ x: number; y: number; f: number }> = [
            { x: start.x, y: start.y, f: heuristic(start.x, start.y) },
        ];
        const gScore: Record<string, number> = {};  // best known cost to reach each tile
        const parent: Record<string, string | null> = {};  // tile key -> parent key
        const closed: Record<string, true> = {};    // tiles already expanded
        gScore[startKey] = 0;
        parent[startKey] = null;

        let explored = 0;

        while (open.length > 0 && explored < MAX_NODES) {
            // Find and remove the node with lowest f score
            let bestIdx = 0;
            for (let i = 1; i < open.length; i++) {
                if (open[i].f < open[bestIdx].f) bestIdx = i;
            }
            const curr    = open.splice(bestIdx, 1)[0];
            const currKey = key(curr.x, curr.y);
            // Stale duplicate: a better route to this tile was already expanded.
            // Skipping it here is what makes MAX_NODES a budget of distinct tiles
            // rather than of queue pops.
            if (closed[currKey]) continue;
            closed[currKey] = true;
            explored++;

            if (currKey === endKey) {
                // Reconstruct path by walking parent pointers from end back to start
                const path: TileCoord[] = [];
                let node: string | null = currKey;
                while (node !== null) {
                    const parts = node.split(",");
                    path.unshift({ x: parseInt(parts[0], 10), y: parseInt(parts[1], 10) });
                    node = parent[node];
                }
                return path;
            }

            for (let d = 0; d < DIRS.length; d++) {
                const nx   = curr.x + DIRS[d].dx;
                const ny   = curr.y + DIRS[d].dy;
                const nKey = key(nx, ny);
                if (closed[nKey]) continue;
                if (!inBounds(nx, ny) || hasBlockingElement(nx, ny)) continue;

                const tentativeG = gScore[currKey] + moveCost(nx, ny);
                const knownG     = gScore[nKey] !== undefined ? gScore[nKey] : Infinity;
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
    function buildRoute(
        start: TileCoord,
        end: TileCoord,
        mode: "smart" | "H_then_V" | "V_then_H",
    ): TileCoord[] {
        if (mode === "smart") {
            const smartPath = findSmartRoute(start, end);
            if (smartPath) return smartPath;
            // A* couldn't find a route (fully blocked or too complex) — fall back
            console.log("[Path Connector] Smart routing found no clear path; falling back to L-shape.");
            mode = "H_then_V";
        }

        const route: TileCoord[] = [];
        let x = start.x, y = start.y;
        const ex = end.x, ey = end.y;
        const dx = ex > x ? 1 : ex < x ? -1 : 0;
        const dy = ey > y ? 1 : ey < y ? -1 : 0;

        if (mode === "H_then_V") {
            while (x !== ex) { route.push({ x, y }); x += dx; }
            while (y !== ey) { route.push({ x, y }); y += dy; }
        } else {
            while (y !== ey) { route.push({ x, y }); y += dy; }
            while (x !== ex) { route.push({ x, y }); x += dx; }
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
    function routeConnectsToNetwork(route: TileCoord[]): boolean {
        // Build a set of route tile coordinates for quick lookup
        const inRoute: Record<string, boolean> = {};
        route.forEach(t => { inRoute[t.x + "," + t.y] = true; });

        for (let i = 0; i < route.length; i++) {
            for (let d = 0; d < DIRS.length; d++) {
                const nx = route[i].x + DIRS[d].dx;
                const ny = route[i].y + DIRS[d].dy;
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
    function findWidthViolations(newTiles: TileCoord[]): TileCoord[] {
        const inRoute: Record<string, boolean> = {};
        newTiles.forEach(t => { inRoute[t.x + "," + t.y] = true; });

        return newTiles.filter(t => {
            let existingNeighbors = 0;
            DIRS.forEach(d => {
                const nx = t.x + d.dx, ny = t.y + d.dy;
                if (!inRoute[nx + "," + ny] && hasFootpath(nx, ny)) existingNeighbors++;
            });
            return existingNeighbors >= 2;
        });
    }

    /**
     * Returns interior route tiles (not start/end) that would end up with only
     * one path neighbor after placement — unexpected dead-ends mid-route.
     */
    function findInteriorDeadEnds(newTiles: TileCoord[]): TileCoord[] {
        if (newTiles.length <= 2) return [];
        const inRoute: Record<string, boolean> = {};
        newTiles.forEach(t => { inRoute[t.x + "," + t.y] = true; });

        // Check all tiles except the first and last (those are the intended endpoints)
        return newTiles.slice(1, newTiles.length - 1).filter(t => {
            let connections = 0;
            DIRS.forEach(d => {
                const nx = t.x + d.dx, ny = t.y + d.dy;
                if (inRoute[nx + "," + ny] || hasFootpath(nx, ny)) connections++;
            });
            return connections <= 1;
        });
    }

    // Memo for the route + analysis shown in the preview pane, keyed on the inputs
    // that determine it. refreshWindow() is called from every widget callback, and
    // each call previously re-ran A* and five full analysis passes over the route.
    interface PreviewMemo { key: string; route: TileCoord[]; analysis: RouteAnalysis; }
    let previewMemo: PreviewMemo | null = null;

    function invalidatePreview(): void {
        previewMemo = null;
    }

    function getPreview(start: TileCoord, end: TileCoord, mode: string): PreviewMemo {
        const k = start.x + "," + start.y + ">" + end.x + "," + end.y + ":" + mode;
        if (previewMemo !== null && previewMemo.key === k) return previewMemo;
        const route = buildRoute(start, end, mode as "smart" | "H_then_V" | "V_then_H");
        previewMemo = { key: k, route, analysis: analyzeRoute(route) };
        return previewMemo;
    }

    /** Full analysis of a route; returns { summary, warnings, canPlace }. */
    function analyzeRoute(route: TileCoord[]): RouteAnalysis {
        const newTiles     = route.filter(t => !hasFootpath(t.x, t.y));
        const blockedTiles = newTiles.filter(t => hasBlockingElement(t.x, t.y));
        const unownedCount = newTiles.filter(t => !tileIsOwned(t.x, t.y)).length;
        const placeable    = newTiles.filter(t =>
            tileIsOwned(t.x, t.y) && !hasBlockingElement(t.x, t.y)
        );
        const warnings: string[] = [];

        if (blockedTiles.length > 0) {
            warnings.push(blockedTiles.length + " tile(s) blocked by rides or entrances — placement will fail there");
        }
        if (!routeConnectsToNetwork(route)) {
            warnings.push("Route doesn't connect to the existing path network — guests won't be able to use it");
        }
        const widthViolations = findWidthViolations(newTiles);
        if (widthViolations.length > 0) {
            warnings.push(widthViolations.length + " tile(s) would create 3-wide paths — may confuse guest pathfinding");
        }
        const deadEnds = findInteriorDeadEnds(newTiles);
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
            warnings,
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
    function findBinObjectIndex(): number {
        const additions = objectManager.getAllObjects("footpath_addition");
        for (let i = 0; i < additions.length; i++) {
            const id   = additions[i].identifier.toLowerCase();
            const name = additions[i].name.toLowerCase();
            if (id.indexOf("litter") !== -1 || id.indexOf("bin") !== -1 ||
                name.indexOf("bin")  !== -1 || name.indexOf("litter") !== -1) {
                return additions[i].index;
            }
        }
        return additions.length > 0 ? additions[0].index : -1;
    }

    /** Places bins on the given tiles at every binSpacing-th position. */
    function placeBinsAlongRoute(placedTiles: TileCoord[]): void {
        const binIdx = findBinObjectIndex();
        if (binIdx < 0) {
            console.log("[Path Connector] No bin/addition objects found -- skipping auto-bin placement.");
            return;
        }
        placedTiles.forEach((t, i) => {
            if (i % binSpacing !== 0) return;

            // Use the FOOTPATH element's z, not the surface's. They coincide for a flat
            // path but diverge the moment the path is raised, and the action wants the
            // path it is attaching to.
            const tile = map.getTile(t.x, t.y);
            let path: FootpathElement | null = null;
            for (let e = 0; e < tile.numElements; e++) {
                const el = tile.getElement(e);
                if (el.type === "footpath") { path = el as FootpathElement; break; }
            }
            if (path === null) return;

            // The game refuses additions on sloped paths and on tiles whose four edges
            // are all connected (FootpathAdditionPlaceAction.cpp:105-118). Skipping them
            // here avoids a burst of "Can't build this on sloped footpath" errors.
            if (path.slopeDirection !== null || path.edges === 0x0F || path.isQueue) return;

            const args = { x: t.x * 32, y: t.y * 32, z: path.baseZ, object: binIdx };
            // Query first so any remaining refusal is a silent no-op rather than an
            // error window in the player's face.
            context.queryAction("footpathadditionplace", args, (q: GameActionResult) => {
                if (q.error && q.error !== 0) return;
                context.executeAction("footpathadditionplace", args, () => {});
            });
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
    function placePathTile(
        tx: number,
        ty: number,
        style: PathStyle,
        callback: (err: string | null) => void,
    ): void {
        const surf = getSurfaceElement(tx, ty);
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
        }, result => {
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
    function connectPaths(): void {
        if (!startTile || !endTile) {
            ui.showError("Path Connector", "Set both start and end tiles first.");
            return;
        }

        invalidateTileFacts(); // start from a clean read of the current map
        const style        = detectExistingPathStyle();
        const route        = getPreview(startTile, endTile, routeMode).route;
        const total        = route.length;
        let done           = 0;
        let placed         = 0, skippedPath = 0, skippedOwn = 0, errors = 0;
        const placedTiles: TileCoord[] = [];

        if (!routeConnectsToNetwork(route)) {
            console.log("[Path Connector] Warning: route is disconnected from the existing path network.");
        }

        function onTileDone(): void {
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
            // The map changed underneath us — every cached tile fact is now stale.
            invalidateTileFacts();
            invalidatePreview();
            startTile = null;
            endTile   = null;
            refreshWindow();
        }

        route.forEach(tile => {
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
            placePathTile(tile.x, tile.y, style, err => {
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
    const ENTRANCE_TYPE_RIDE_EXIT = 1; // EntranceType::rideExit (EntranceElement.h)

    function findDisconnectedRideExits(): TileCoord[] {
        invalidateTileFacts();
        const size         = map.size;
        const disconnected: TileCoord[] = [];

        for (let x = 1; x < size.x - 1; x++) {
            for (let y = 1; y < size.y - 1; y++) {
                const tile    = map.getTile(x, y);
                let hasExit   = false;
                for (let i = 0; i < tile.numElements; i++) {
                    const el = tile.getElement(i);
                    // Match ride *exits* only. Matching every track and entrance element
                    // flagged each tile of every coaster and every ride entrance too,
                    // which buried the real problems in hundreds of false positives.
                    if (el.type === "entrance"
                        && (el as EntranceElement).object === ENTRANCE_TYPE_RIDE_EXIT) {
                        hasExit = true;
                        break;
                    }
                }
                if (!hasExit) continue;

                const hasAdjacentPath = DIRS.some(d => hasFootpath(x + d.dx, y + d.dy));
                if (!hasAdjacentPath) disconnected.push({ x, y });
            }
        }
        return disconnected;
    }

    // -------------------------------------------------------------------------
    // UI
    // -------------------------------------------------------------------------

    let win: Window | null = null;

    function openWindow(): void {
        if (win !== null) { win.bringToFront(); return; }

        win = ui.openWindow({
            classification: "path-connector",
            title: "Path Connector v" + __PLUGIN_VERSION__,
            width: 280,
            height: 290,
            widgets: [
                // --- Tile Selection ---
                { type: "groupbox", x: 6,   y: 18,  width: 268, height: 56, text: "Tile Selection" },
                { type: "label",    x: 14,  y: 32,  width: 254, height: 14, name: "lblStart", text: "Start: (not set)" },
                { type: "label",    x: 14,  y: 48,  width: 254, height: 14, name: "lblEnd",   text: "End:   (not set)" },

                {
                    type: "button", x: 14, y: 80, width: 124, height: 16,
                    text: "Pick Start Tile",
                    tooltip: "Click to activate the tile picker, then click any map tile to set the start point",
                    onClick: () => { activatePicker("start"); },
                },
                {
                    type: "button", x: 144, y: 80, width: 124, height: 16,
                    text: "Pick End Tile",
                    tooltip: "Click to activate the tile picker, then click any map tile to set the end point",
                    onClick: () => { activatePicker("end"); },
                },

                // --- Route Settings ---
                { type: "groupbox", x: 6, y: 102, width: 268, height: 72, text: "Route Settings" },
                { type: "label",    x: 14, y: 116, width: 90,  height: 14, text: "Route shape:" },
                {
                    type: "dropdown",
                    x: 104, y: 114, width: 162, height: 14,
                    name: "ddRouteMode",
                    items: ["Smart (avoid obstacles)", "Horizontal then Vertical", "Vertical then Horizontal"],
                    selectedIndex: 0,
                    onChange: (index: number) => {
                        routeMode = index === 0 ? "smart" : index === 1 ? "H_then_V" : "V_then_H";
                        invalidatePreview();
                        refreshWindow();
                    },
                },
                {
                    type: "checkbox", x: 14, y: 134, width: 200, height: 14,
                    name: "chkAutoBins",
                    text: "Auto-place bins every N tiles",
                    isChecked: false,
                    onChange: (isChecked: boolean) => { autoBinsEnabled = isChecked; refreshWindow(); },
                },
                {
                    type: "spinner", x: 224, y: 134, width: 44, height: 14,
                    name: "spnBinSpacing",
                    text: String(binSpacing),
                    isDisabled: !autoBinsEnabled,
                    onIncrement: () => {
                        binSpacing = Math.max(2, Math.min(20, binSpacing + 1));
                        if (win) win.findWidget<SpinnerWidget>("spnBinSpacing").text = String(binSpacing);
                    },
                    onDecrement: () => {
                        binSpacing = Math.max(2, Math.min(20, binSpacing - 1));
                        if (win) win.findWidget<SpinnerWidget>("spnBinSpacing").text = String(binSpacing);
                    },
                },

                // --- Preview / Warnings ---
                { type: "groupbox", x: 6,  y: 180, width: 268, height: 72, text: "Preview & Warnings" },
                { type: "label",    x: 14, y: 194, width: 254, height: 14, name: "lblPreview", text: "Select both tiles to preview." },
                { type: "label",    x: 14, y: 210, width: 254, height: 14, name: "lblWarn1",   text: "" },
                { type: "label",    x: 14, y: 224, width: 254, height: 14, name: "lblWarn2",   text: "" },
                { type: "label",    x: 14, y: 238, width: 254, height: 14, name: "lblWarn3",   text: "" },

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
                    onClick: () => {
                        const exits = findDisconnectedRideExits();
                        if (exits.length === 0) {
                            console.log("[Path Connector] All ride exits have adjacent footpaths.");
                        } else {
                            const preview = exits.slice(0, 5).map(e => "(" + e.x + "," + e.y + ")").join(", ");
                            console.log("[Path Connector] " + exits.length +
                                " disconnected ride exit(s): " + preview +
                                (exits.length > 5 ? " ..." : ""));
                        }
                    },
                },
                {
                    type: "button", x: 208, y: 258, width: 60, height: 20,
                    text: "Clear",
                    onClick: () => {
                        startTile = null;
                        endTile   = null;
                        invalidatePreview();
                        refreshWindow();
                    },
                },
            ],
            onClose: () => {
                win = null;
                // Cancel any active tile picker when the window is closed
                if (ui.tool) ui.tool.cancel();
            },
        });

        refreshWindow();
    }

    function activatePicker(which: "start" | "end"): void {
        ui.activateTool({
            id:     "path-connector-pick-" + which,
            cursor: "cross_hair",
            // ToolFilter "terrain" limits clicks to map surface tiles, not entities or UI
            filter: ["terrain"],
            onDown: (e: ToolEventArgs) => {
                if (!e.mapCoords) return;
                const tile: TileCoord = {
                    x: Math.floor(e.mapCoords.x / 32),
                    y: Math.floor(e.mapCoords.y / 32),
                };
                if (which === "start") startTile = tile;
                else                   endTile   = tile;
                invalidateTileFacts();
                invalidatePreview();

                if (ui.tool) ui.tool.cancel();
                refreshWindow();
            },
        });
    }

    /** Updates all window labels from current start/end state and route analysis. */
    function refreshWindow(): void {
        if (!win) return;

        win.findWidget<LabelWidget>("lblStart").text = "Start: " +
            (startTile ? "tile (" + startTile.x + ", " + startTile.y + ")" : "(not set)");
        win.findWidget<LabelWidget>("lblEnd").text   = "End:   " +
            (endTile ? "tile (" + endTile.x + ", " + endTile.y + ")" : "(not set)");

        win.findWidget<SpinnerWidget>("spnBinSpacing").isDisabled = !autoBinsEnabled;

        const ready = startTile !== null && endTile !== null;
        win.findWidget<ButtonWidget>("btnConnect").isDisabled = !ready;

        // Clear warning lines before repopulating
        win.findWidget<LabelWidget>("lblWarn1").text = "";
        win.findWidget<LabelWidget>("lblWarn2").text = "";
        win.findWidget<LabelWidget>("lblWarn3").text = "";

        if (!ready) {
            win.findWidget<LabelWidget>("lblPreview").text = "Select both tiles to preview route.";
            return;
        }

        const analysis = getPreview(startTile!, endTile!, routeMode).analysis;
        win.findWidget<LabelWidget>("lblPreview").text = analysis.summary;

        for (let i = 0; i < Math.min(3, analysis.warnings.length); i++) {
            win.findWidget<LabelWidget>("lblWarn" + (i + 1)).text = "[!]  " + analysis.warnings[i];
        }
    }
}
