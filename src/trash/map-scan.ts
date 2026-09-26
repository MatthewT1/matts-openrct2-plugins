/**
 * Map and entity scans for trash-manager: the tile cache, litter counts, hotspots
 * and blanket-coverage candidate tiles.
 *
 * Split out of trash-manager.ts (#6) with no behaviour change.
 */

import { createHotspotAccumulator } from "../hotspots";
import { getHandymen, isOldLitter, TileCoord, BoundingRect, TileCache } from "./shared";
import { BrokenTile } from "../repairs";
import { DebugChannel } from "../debug";
import { createCooldown, TILE_SCAN_TICKS } from "../cooldown";

export type MapScan = ReturnType<typeof createMapScan>;

export function createMapScan(dbg: DebugChannel) {


    // -------------------------------------------------------------------------
    // Cached state — rebuilt once per in-game day to avoid expensive per-tick scans
    // -------------------------------------------------------------------------

    const cache: TileCache = {
        pathTiles:     0,
        ownedTiles:    0,
        guests:        0,
        handymanCount: 0,
        totalLitter:   0,
        oldLitter:     0,
        fullBins:   0,
        brokenBins: 0,
        vomit:      0,
        trash:      0,
        topHotspots: [],
        parkBounds: { x1: 1, y1: 1, x2: 127, y2: 127 },
        pathBounds: { x1: 1, y1: 1, x2: 127, y2: 127 },
    };

    // The tile scan is O(map_size²). It is throttled in game time (#48) so it runs on the
    // same days at every speed: the old 30 real-second cooldown meant a scan every 3 days
    // at speed 1 but every ~18 at speed 4. Three days keeps speed 1 as it was. Measured
    // 9-14ms per scan (Dynamite Dunes, harness --debug), so the 2 s real-time floor only
    // matters if game time runs faster than speed 4 (3 days there is ~5 s).
    const tileScanCooldown = createCooldown(TILE_SCAN_TICKS, 2_000); // first call scans

    // Litter is bucketed into 8x8-tile cells during the scan we already run, so
    // "240 pieces of litter" becomes "38 of them are all at (42, 88)". 8 tiles is
    // roughly a plaza or a stall frontage - small enough to point at, large enough
    // that a busy junction lands in one cell rather than smeared across four.
    const HOTSPOT_CELL_TILES = 8;
    // A cell has to be worse than this before it is worth mentioning; below it the
    // "hotspot" is just evenly-distributed litter.
    // Lowered from 8 after the scale audit (docs/scale-audit.md).
    //
    // This gates the "litter is piling up at (x, y)" console callout on the worst
    // hotspot's count of RATING-COSTING old litter. Measured across both parks in
    // `tools/rct-debug.log`, `oldLitter` peaks at 5 park-wide — so a single cell
    // reaching 8 was impossible and the callout could never fire. Cosmetic rather than
    // functional, but it is the same unreachable-threshold pattern as the five features
    // that shipped dead, and it costs nothing to make it reachable.
    const HOTSPOT_MIN_OLD = 3;
    // Blanket coverage: one candidate path tile is remembered per cell of this size, so
    // benches and bins end up spread across the whole path network rather than only
    // clustering at rides and stalls.
    const COVERAGE_CELL_TILES   = 6;

    /**
     * One representative placeable path tile per COVERAGE_CELL_TILES cell, rebuilt by
     * the tile scan. This is what turns "benches near rides" into "benches everywhere":
     * it gives the planner a spread of candidate locations across the whole path
     * network, collected for free during a walk we already do.
     */
    let coverageTiles: TileCoord[] = [];
    // Broken path additions (any kind) and a park entrance tile, from the last tile scan (#115).
    let brokenTiles: BrokenTile[] = [];
    let entranceTile: TileCoord | null = null;
    const hotspots = createHotspotAccumulator(HOTSPOT_CELL_TILES);
    let lastHotspotReport = "";

    // -------------------------------------------------------------------------
    // Cache update — split into tile scan (expensive) and entity scan (cheap)
    // -------------------------------------------------------------------------

    // O(map_size²) tile walk: counts path/owned tiles, bins, bounding boxes.
    // Rate-limited via tileScanCooldown — safe to call every day, won't
    // actually re-scan until three in-game days have passed.
    function updateTileCache(): void {
        if (!tileScanCooldown.ready(date.ticksElapsed, Date.now())) return;
        dbg.count("tileScan");

        const size = map.size;
        let pathCount = 0, ownedCount = 0, fullBins = 0, brokenBins = 0;
        // Rebuilt from scratch so demolished paths cannot leave stale candidates behind.
        const coverageSeen: Record<number, true> = {};
        const nextCoverage: TileCoord[] = [];
        const nextBroken: BrokenTile[] = [];
        let nextEntrance: TileCoord | null = null;
        let minPX = size.x, minPY = size.y, maxPX = 0, maxPY = 0;
        let minPathX = size.x, minPathY = size.y, maxPathX = 0, maxPathY = 0;

        for (let x = 0; x < size.x; x++) {
            for (let y = 0; y < size.y; y++) {
                const tile = map.getTile(x, y);
                // Surface element is always index 0; skip unowned tiles entirely.
                // Guard numElements: a tile with no elements would make getElement(0) throw.
                if (tile.numElements === 0) continue;
                const surfEl = tile.getElement(0);
                if (surfEl.type !== "surface" || !surfEl.hasOwnership) continue;
                ownedCount++;

                if (x < minPX) minPX = x;
                if (y < minPY) minPY = y;
                if (x > maxPX) maxPX = x;
                if (y > maxPY) maxPY = y;

                let hasPath = false;
                let pathCounted = false; // guard against double-count on bridge tiles (2 stacked footpaths)
                for (let i = 1; i < tile.numElements; i++) {
                    const el = tile.getElement(i);
                    if (el.type === "entrance") {
                        // EntranceType::parkEntrance = 2 (EntranceElement.h).
                        if (nextEntrance === null && el.object === 2) nextEntrance = { x: x, y: y };
                    } else if (el.type === "footpath") {
                        hasPath = true;
                        if (!el.isQueue && !pathCounted) { pathCount++; pathCounted = true; }
                        if (el.isAdditionFull)   fullBins++;
                        if (el.isAdditionBroken) {
                            brokenBins++;
                            if (el.addition !== null) nextBroken.push({ x: x, y: y, z: el.baseZ, addition: el.addition });
                        }

                        // Remember the first tile in each coverage cell that could
                        // actually take an addition. Sloped and fully-enclosed tiles are
                        // refused by the game, so there is no point offering them.
                        const cellKey = ((x / COVERAGE_CELL_TILES) | 0) * 4096
                                      + ((y / COVERAGE_CELL_TILES) | 0);
                        if (coverageSeen[cellKey] === undefined
                            && !el.isQueue
                            && el.slopeDirection === null
                            && el.edges !== 0x0F) {
                            coverageSeen[cellKey] = true;
                            nextCoverage.push({ x: x, y: y });
                        }
                    }
                }
                if (hasPath) {
                    if (x < minPathX) minPathX = x;
                    if (y < minPathY) minPathY = y;
                    if (x > maxPathX) maxPathX = x;
                    if (y > maxPathY) maxPathY = y;
                }
            }
        }

        const fallback: BoundingRect = { x1: 1, y1: 1, x2: size.x - 2, y2: size.y - 2 };
        cache.parkBounds = (maxPX >= minPX)
            ? { x1: minPX, y1: minPY, x2: maxPX, y2: maxPY }
            : fallback;
        cache.pathBounds = (maxPathX >= minPathX)
            ? { x1: minPathX, y1: minPathY, x2: maxPathX, y2: maxPathY }
            : cache.parkBounds;

        coverageTiles    = nextCoverage;
        cache.pathTiles  = pathCount;
        cache.ownedTiles = ownedCount;
        cache.fullBins   = fullBins;
        cache.brokenBins = brokenBins;
        brokenTiles      = nextBroken;
        entranceTile     = nextEntrance;
    }

    // Cheap entity scan: litter age/type, guest count, handyman count.
    // Safe to call every in-game day at any game speed.
    //
    // `handymen` and `allLitter` are passed in by callers that already hold them so
    // a single in-game day does exactly one getAllEntities("staff") and one
    // getAllEntities("litter") instead of the four-plus scans this used to trigger.
    function updateEntityCache(handymen?: Handyman[], allLitter?: Litter[]): Litter[] {
        const litter = allLitter !== undefined ? allLitter : map.getAllEntities("litter");
        const staff  = handymen  !== undefined ? handymen  : getHandymen();

        let oldCount = 0, vomitCount = 0, trashCount = 0;
        // Rebuild the hotspot grid from scratch each pass - it describes where litter
        // is *now*, and litter that has been swept must not linger in the counts.
        hotspots.reset();
        for (let i = 0; i < litter.length; i++) {
            const e = litter[i];
            const old = isOldLitter(e);
            const isVomit = e.litterType === "vomit" || e.litterType === "vomit_alt";
            if (old) oldCount++;
            if (isVomit) vomitCount++;
            else trashCount++;
            hotspots.add(e.x, e.y, old, isVomit);
        }

        cache.guests        = park.guests;
        cache.handymanCount = staff.length;
        cache.totalLitter   = litter.length;
        cache.oldLitter     = oldCount;
        cache.vomit         = vomitCount;
        cache.trash         = trashCount;
        cache.topHotspots   = hotspots.top(3);
        return litter;
    }

    function updateCache(): void {
        updateTileCache();
        updateEntityCache();
    }

    // -------------------------------------------------------------------------
    // Diagnostics
    // -------------------------------------------------------------------------

    /**
     * Reports the worst litter cluster, if there is one worth naming.
     *
     * Logged only when the location changes, not every day, so a persistent hotspot
     * does not spam the console while the player is dealing with it.
     */
    function reportHotspots(): void {
        const worst = cache.topHotspots.length > 0 ? cache.topHotspots[0] : null;
        if (worst === null || worst.oldCount < HOTSPOT_MIN_OLD) {
            lastHotspotReport = "";
            return;
        }

        const key = worst.x + "," + worst.y;
        if (key === lastHotspotReport) return;
        lastHotspotReport = key;

        const kind = worst.vomit > worst.count - worst.vomit ? "mostly vomit" : "mostly trash";
        console.log("[Trash Manager] Litter hotspot near tile (" + worst.x + ", " + worst.y +
            "): " + worst.count + " pieces, " + worst.oldCount + " costing rating (" +
            kind + "). Consider a bin, or check handyman coverage there.");
    }

    return {
        cache,
        hotspots,
        updateTileCache,
        updateEntityCache,
        updateCache,
        reportHotspots,
        getCoverageTiles(): TileCoord[] { return coverageTiles; },
        /** Broken path additions from the last tile scan; a new array each scan. */
        getBrokenTiles(): BrokenTile[] { return brokenTiles; },
        getEntranceTile(): TileCoord | null { return entranceTile; },
        /** Makes the next updateTileCache run regardless of the cooldown. */
        forceTileScan(): void { tileScanCooldown.reset(); },
    };
}
