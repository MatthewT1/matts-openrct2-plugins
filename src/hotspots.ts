/**
 * Litter hotspot grid — OpenRCT2 plugin
 *
 * Buckets litter into a coarse grid of square cells so a caller (e.g. a day handler
 * already walking every litter entity) can find the worst spots in the park without
 * building or sorting any per-litter data structure.
 *
 * PERFORMANCE CONTRACT:
 *   `add()` is called once per litter piece, per in-game day, potentially hundreds of
 *   times in a single handler pass. It must do only integer math (bit shifts, no
 *   division or Math.floor) and at most one object property lookup/store — no
 *   intermediate arrays, no allocation once a cell already exists in the map.
 *   `top()` and `reset()` run once per day and may allocate/sort freely.
 *
 * CELL KEY PACKING:
 *   A cell is identified by its (cellX, cellY) grid indices, packed into a single
 *   numeric key so the accumulator can use a plain object (`Record<number, Cell>`)
 *   instead of a nested map or string-concatenated key (both slower in QuickJS).
 *
 *     key = (cellX << CELL_KEY_Y_BITS) | cellY
 *
 *   OpenRCT2 maps are at most 1000 tiles per side (`MAX_TILE_COORD`), so a cell index
 *   along either axis never exceeds 1000 even with the smallest legal cell size (1
 *   tile). CELL_KEY_Y_BITS = 11 gives 2048 representable values per axis, comfortably
 *   covering that range with headroom. cellX is not masked before shifting, so if this
 *   assumption is ever violated (a bigger map, or cellX computed from unclamped input)
 *   keys could collide; tile coordinates are clamped in `add()` specifically to keep
 *   that assumption true.
 */

/** A cluster of litter, in tile coordinates. */
export interface Hotspot {
    /** Tile coords of the cell's centre. */
    x: number;
    y: number;
    /** Total litter pieces in this cell. */
    count: number;
    /** Pieces aged past the rating-penalty threshold. */
    oldCount: number;
    /** Pieces that are vomit rather than trash. */
    vomit: number;
}

export interface HotspotAccumulator {
    /**
     * Records one litter piece. `x`/`y` are WORLD coordinates (tile * 32).
     * Must be allocation-free on the hot path.
     */
    add(x: number, y: number, isOld: boolean, isVomit: boolean): void;
    /** Returns the `n` worst cells, ranked by oldCount then count, both descending. */
    top(n: number): Hotspot[];
    /**
     * Returns the `n` worst cells ranked by vomit count descending.
     *
     * Separate from `top()` because vomit and trash are different problems with
     * different fixes: bins reduce trash but do nothing for vomit, which needs benches
     * or a less nauseating ride. Measured on a real park, 848 of 851 litter pieces were
     * vomit — so for that park this is the ranking that matters.
     */
    topVomit(n: number): Hotspot[];
    /** Clears all accumulated state for reuse next day. */
    reset(): void;
}

/** Bits reserved for the cellY component of a packed key; see file header. */
const CELL_KEY_Y_BITS = 11;

/**
 * OpenRCT2's largest supported square map is 1000x1000 tiles. Tile coordinates are
 * clamped to this range before bucketing so out-of-range or negative input (which can
 * legitimately occur for entities just off the map edge) cannot corrupt the packed key
 * or produce a giant sparse spread of bogus cells.
 */
const MAX_TILE_COORD = 999;

interface Cell {
    cellX: number;
    cellY: number;
    count: number;
    oldCount: number;
    vomit: number;
}

/** Rounds `n` up to the next power of two. Assumes `n >= 1`. */
function roundUpToPowerOfTwo(n: number): number {
    let p = 1;
    while (p < n) {
        p <<= 1;
    }
    return p;
}

/** Returns log2 of `n`, which must already be a power of two. */
function log2OfPowerOfTwo(n: number): number {
    let shift = 0;
    let v = n;
    while (v > 1) {
        v >>= 1;
        shift++;
    }
    return shift;
}

/**
 * @param cellTiles Width/height of a grid cell in tiles. Must be a power of two; if it
 * isn't, it is rounded up to the next one rather than throwing.
 */
export function createHotspotAccumulator(cellTiles: number): HotspotAccumulator {
    const size = roundUpToPowerOfTwo(cellTiles < 1 ? 1 : cellTiles);
    // Cell index = tile coord >> cellShift. cellShift folds both the world->tile
    // conversion (>> 5) and the tile->cell conversion (>> log2(size)) into a single
    // shift amount applied to the world coordinate.
    const tileShift = 5;
    const cellShift = tileShift + log2OfPowerOfTwo(size);

    let cells: Record<number, Cell> = {};

    function add(x: number, y: number, isOld: boolean, isVomit: boolean): void {
        // Clamp in TILE space (not world space) so the clamp bound matches
        // MAX_TILE_COORD regardless of the >> 5 world->tile conversion below.
        let tileX = x >> tileShift;
        let tileY = y >> tileShift;
        if (tileX < 0) tileX = 0;
        else if (tileX > MAX_TILE_COORD) tileX = MAX_TILE_COORD;
        if (tileY < 0) tileY = 0;
        else if (tileY > MAX_TILE_COORD) tileY = MAX_TILE_COORD;

        const cellX = tileX >> (cellShift - tileShift);
        const cellY = tileY >> (cellShift - tileShift);
        const key = (cellX << CELL_KEY_Y_BITS) | cellY;

        let cell = cells[key];
        if (cell === undefined) {
            cell = { cellX: cellX, cellY: cellY, count: 0, oldCount: 0, vomit: 0 };
            cells[key] = cell;
        }

        cell.count++;
        if (isOld) cell.oldCount++;
        if (isVomit) cell.vomit++;
    }

    /** Materialises every cell as a Hotspot in tile coordinates. Allocates freely. */
    function snapshot(): Hotspot[] {
        const keys = Object.keys(cells);
        const half = size >> 1;
        const results: Hotspot[] = [];
        for (let i = 0; i < keys.length; i++) {
            const cell = cells[Number(keys[i])];
            results.push({
                x: (cell.cellX << (cellShift - tileShift)) + half,
                y: (cell.cellY << (cellShift - tileShift)) + half,
                count: cell.count,
                oldCount: cell.oldCount,
                vomit: cell.vomit,
            });
        }
        return results;
    }

    function top(n: number): Hotspot[] {
        if (n <= 0) return [];
        const results = snapshot();
        results.sort((a, b) => {
            if (b.oldCount !== a.oldCount) return b.oldCount - a.oldCount;
            return b.count - a.count;
        });
        return results.length > n ? results.slice(0, n) : results;
    }

    function topVomit(n: number): Hotspot[] {
        if (n <= 0) return [];
        const results = snapshot();
        // Cells with no vomit are not vomit hotspots, however much trash they hold.
        const withVomit: Hotspot[] = [];
        for (let i = 0; i < results.length; i++) {
            if (results[i].vomit > 0) withVomit.push(results[i]);
        }
        withVomit.sort((a, b) => b.vomit - a.vomit);
        return withVomit.length > n ? withVomit.slice(0, n) : withVomit;
    }

    function reset(): void {
        cells = {};
    }

    return { add, top, topVomit, reset };
}
