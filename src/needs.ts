/**
 * Guest needs clustering — OpenRCT2 plugin
 *
 * WHY THIS MODULE EXISTS:
 *   `hotspots.ts` finds where litter piles up; this is the same idea applied to unmet
 *   guest needs, so a caller can work out where the park is missing toilets, first aid
 *   rooms and food/drink stalls rather than just where guests happen to complain. It
 *   buckets sampled guests into a coarse grid and later pairs the worst cells with the
 *   nearest facility that could actually fix them (`findGaps`), the same
 *   attribute-a-cluster-to-a-nearby-thing pattern `vomit.ts` uses for nauseating rides.
 *
 * THE INVERTED-THRESHOLD TRAP:
 *   Guest need stats do not all point the same way. `hunger` and `thirst` count DOWN
 *   from 255 as a guest gets hungrier/thirstier, so LOWER is worse and a guest is needy
 *   at or below a threshold. `toilet` and `nausea` count UP, so HIGHER is worse and a
 *   guest is needy at or above a threshold. Mixing these up silently inverts a need
 *   ("guest is starving" vs "guest just ate") with no type error to catch it — every
 *   comparison below is written out with its direction stated in a comment for exactly
 *   this reason.
 *
 * SOURCE-VERIFIED THRESHOLDS (OpenRCT2 C++, cited at each constant below):
 *   All six thresholds are read directly out of `Guest.cpp`, not estimated. `sick` (140)
 *   is an early-warning count only — nausea has to reach `VERY_SICK_THRESHOLD` (200)
 *   before a guest actually breaks off and heads for a first aid room
 *   (`Guest.cpp:1071-1074`), so `firstAid` clusters are built from 200, not 140. Likewise
 *   `toiletUrgent` (195, `Guest.cpp:703`) is a severity count only; toilet clusters use
 *   the ordinary 160 threshold that first puts "Toilet" in the guest's thought queue.
 *
 * CALLER CONTRACT — FILTER OFF-MAP GUESTS BEFORE CALLING `add()`:
 *   `add()` clamps tile coordinates into [0, MAX_TILE_COORD] to protect its key packing.
 *   That clamp is deliberate, but it means anything with a negative coordinate lands in
 *   cell (0, 0) and surfaces as a cluster at tile (4, 4).
 *
 *   A guest riding a ride, or one that has left the park, reports
 *   `kLocationNull = -32768` (`world/Location.hpp:18`). Feeding those in produced a
 *   permanent phantom cluster in the map corner on every park tested — and because the
 *   corner is unowned and enormously far from any facility (78, 111, 133 and 153 tiles
 *   on four different parks), it always ranked as the worst gap, always won the
 *   planner's choice, and could never be built on. Nothing else could ever be built
 *   either, because it monopolised the budget.
 *
 *   The clamp is not the bug and must stay. **The caller must skip `x < 0 || y < 0`.**
 *
 * PERFORMANCE CONTRACT:
 *   `add()` is called once per sampled guest, potentially hundreds of times per pass. It
 *   must do only integer math and at most one object property lookup/store per matched
 *   need — no intermediate arrays, no allocation once a cell already exists. `top()`,
 *   `counts()` and `reset()` run once per pass and may allocate/sort freely.
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

/**
 * Guests in one cell sharing an unmet need before it counts as a cluster at all.
 *
 * **This is the single source of truth for "is this real or is it noise", and it is
 * exported so nothing downstream can apply a second, different bar.** It previously had
 * a twin: the facility planner carried its own `minGuests: 5` and re-filtered clusters
 * this module had already passed at 3. Anything landing in the 3-4 band was therefore
 * reported as a gap, logged to the console and published in telemetry — and could never
 * become actionable. Measured on a 670-guest park, every gap present held exactly 3
 * guests, so nothing could ever confirm.
 *
 * That is the same failure as the staffing controller's v2 deadlock: two thresholds
 * expressing different standards for one signal, leaving a dead band the park actually
 * occupies.
 *
 * Why 3 is the right floor: sampling is a ROTATING WINDOW, so a cell's count is only the
 * guests seen in this sweep, not everyone standing there. Three sampled guests sharing an
 * unmet need inside one 8-tile cell was 17% of all thirsty guests in the park at the time
 * of measurement — a concentration, not noise.
 */
export const CLUSTER_MIN_GUESTS = 3;

/** The kinds of unmet need this module clusters. */
export type NeedKind = "hunger" | "thirst" | "toilet" | "firstAid";

/** Hunger counts DOWN as a guest gets hungrier; at or below this, they are hungry (`Guest.cpp:1007`). */
export const HUNGER_THRESHOLD = 10;
/** Thirst counts DOWN as a guest gets thirstier; at or below this, they are thirsty (`Guest.cpp:1012`). */
export const THIRST_THRESHOLD = 25;
/** Toilet need counts UP; at or above this, "Toilet" enters the guest's thoughts (`Guest.cpp:1017`). */
export const TOILET_THRESHOLD = 160;
/** Toilet need counts UP; at or above this, the need is severe (`Guest.cpp:703`). Count only, no cluster. */
export const TOILET_URGENT = 195;
/** Nausea counts UP; at or above this, the guest feels sick (`Guest.cpp:1068`). Early-warning count only. */
export const SICK_THRESHOLD = 140;
/** Nausea counts UP; at or above this, the guest actually heads for first aid (`Guest.cpp:1071-1074`). */
export const VERY_SICK_THRESHOLD = 200;

/** Park-wide tallies from one sampling pass. */
export interface NeedCounts {
    sampled: number;
    hunger: number;
    thirst: number;
    toilet: number;
    toiletUrgent: number;
    sick: number;
    verySick: number;
}

/** A cluster of guests sharing an unmet need, in TILE coordinates. */
export interface NeedCluster {
    kind: NeedKind;
    x: number;
    y: number;
    count: number;
}

export interface NeedAccumulator {
    /**
     * Records one sampled guest. `x`/`y` are WORLD coordinates (tile * 32).
     * Allocation-free on the hot path.
     */
    add(x: number, y: number, hunger: number, thirst: number, toilet: number, nausea: number): void;
    /** Park-wide tallies accumulated so far. Allocates a fresh object each call. */
    counts(): NeedCounts;
    /** The `n` worst cells for one need kind, ranked by count descending. */
    top(kind: NeedKind, n: number): NeedCluster[];
    /** Clears all accumulated state for reuse next pass. */
    reset(): void;
}

/** Bits reserved for the cellY component of a packed key; see file header. */
const CELL_KEY_Y_BITS = 11;

/**
 * OpenRCT2's largest supported square map is 1000x1000 tiles. Tile coordinates are
 * clamped to this range before bucketing so out-of-range or negative input (which can
 * legitimately occur for a guest just off the map edge) cannot corrupt the packed key
 * or produce a giant sparse spread of bogus cells.
 */
const MAX_TILE_COORD = 999;

interface Cell {
    cellX: number;
    cellY: number;
    hunger: number;
    thirst: number;
    toilet: number;
    firstAid: number;
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
 * @param cellTiles Grid cell size in tiles; rounded up to a power of two if needed.
 */
export function createNeedAccumulator(cellTiles: number): NeedAccumulator {
    const size = roundUpToPowerOfTwo(cellTiles < 1 ? 1 : cellTiles);
    // Cell index = tile coord >> cellShift. cellShift folds both the world->tile
    // conversion (>> 5) and the tile->cell conversion (>> log2(size)) into a single
    // shift amount applied to the world coordinate.
    const tileShift = 5;
    const cellShift = tileShift + log2OfPowerOfTwo(size);

    let cells: Record<number, Cell> = {};
    let sampled = 0;
    let hungerCount = 0;
    let thirstCount = 0;
    let toiletCount = 0;
    let toiletUrgentCount = 0;
    let sickCount = 0;
    let verySickCount = 0;

    function cellFor(x: number, y: number): Cell {
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
            cell = { cellX: cellX, cellY: cellY, hunger: 0, thirst: 0, toilet: 0, firstAid: 0 };
            cells[key] = cell;
        }
        return cell;
    }

    function add(x: number, y: number, hunger: number, thirst: number, toilet: number, nausea: number): void {
        sampled++;

        // Hunger/thirst count DOWN: a guest is needy at or BELOW the threshold.
        const isHungry = hunger <= HUNGER_THRESHOLD;
        const isThirsty = thirst <= THIRST_THRESHOLD;
        // Toilet/nausea count UP: a guest is needy at or ABOVE the threshold.
        const isToilet = toilet >= TOILET_THRESHOLD;
        const isToiletUrgent = toilet >= TOILET_URGENT;
        const isSick = nausea >= SICK_THRESHOLD;
        const isVerySick = nausea >= VERY_SICK_THRESHOLD;

        if (isHungry) hungerCount++;
        if (isThirsty) thirstCount++;
        if (isToilet) toiletCount++;
        if (isToiletUrgent) toiletUrgentCount++;
        if (isSick) sickCount++;
        if (isVerySick) verySickCount++;

        // Only allocate/look up a cell if this guest actually contributes to a cluster.
        if (!isHungry && !isThirsty && !isToilet && !isVerySick) {
            return;
        }

        const cell = cellFor(x, y);
        if (isHungry) cell.hunger++;
        if (isThirsty) cell.thirst++;
        if (isToilet) cell.toilet++;
        // firstAid clusters are driven by VERY_SICK_THRESHOLD (200), not SICK_THRESHOLD
        // (140) — see file header. `sick` has no cluster of its own.
        if (isVerySick) cell.firstAid++;
    }

    function counts(): NeedCounts {
        return {
            sampled: sampled,
            hunger: hungerCount,
            thirst: thirstCount,
            toilet: toiletCount,
            toiletUrgent: toiletUrgentCount,
            sick: sickCount,
            verySick: verySickCount,
        };
    }

    /** Materialises every cell holding this need kind as a NeedCluster in tile coordinates. */
    function snapshot(kind: NeedKind): NeedCluster[] {
        const keys = Object.keys(cells);
        const half = size >> 1;
        const results: NeedCluster[] = [];
        for (let i = 0; i < keys.length; i++) {
            const cell = cells[Number(keys[i])];
            const count =
                kind === "hunger" ? cell.hunger :
                kind === "thirst" ? cell.thirst :
                kind === "toilet" ? cell.toilet :
                cell.firstAid;
            if (count <= 0) continue;
            results.push({
                kind: kind,
                x: (cell.cellX << (cellShift - tileShift)) + half,
                y: (cell.cellY << (cellShift - tileShift)) + half,
                count: count,
            });
        }
        return results;
    }

    function top(kind: NeedKind, n: number): NeedCluster[] {
        if (n <= 0) return [];
        const results = snapshot(kind);
        results.sort((a, b) => b.count - a.count);
        return results.length > n ? results.slice(0, n) : results;
    }

    function reset(): void {
        cells = {};
        sampled = 0;
        hungerCount = 0;
        thirstCount = 0;
        toiletCount = 0;
        toiletUrgentCount = 0;
        sickCount = 0;
        verySickCount = 0;
    }

    return { add, counts, top, reset };
}

/** A facility that can satisfy a need, in TILE coordinates. */
export interface Facility {
    kind: NeedKind;
    name: string;
    x: number;
    y: number;
}

/** How far an unmet-need cluster is from the nearest facility that would satisfy it. */
export interface NeedGap {
    cluster: NeedCluster;
    nearest: Facility | null;
    /** Manhattan distance in tiles, or -1 when no matching facility exists at all. */
    distance: number;
}

/** Manhattan distance in tiles between two points. Cheap and matches path-grid movement. */
function manhattan(ax: number, ay: number, bx: number, by: number): number {
    const dx = ax > bx ? ax - bx : bx - ax;
    const dy = ay > by ? ay - by : by - ay;
    return dx + dy;
}

/** Human-readable name for a need kind, used by `describeGap`. */
function needLabel(kind: NeedKind): string {
    if (kind === "hunger") return "Hungry guests";
    if (kind === "thirst") return "Thirsty guests";
    if (kind === "toilet") return "Guests needing a toilet";
    return "Guests needing first aid";
}

/** Name of a facility that satisfies a need kind, used when none exists at all. */
function facilityLabel(kind: NeedKind): string {
    if (kind === "hunger") return "food stall";
    if (kind === "thirst") return "drink stall";
    if (kind === "toilet") return "toilet";
    return "first aid room";
}

/**
 * Pairs each cluster with the nearest facility of a matching kind.
 *
 * Sorted by distance descending, so the worst-served cluster comes first. A cluster
 * with no matching facility anywhere in the park (`nearest: null`, `distance: -1`) is
 * the worst case there is — worse than any finite distance — so it always sorts first,
 * ahead of a cluster that merely has a long walk to a facility that does exist.
 */
export function findGaps(clusters: NeedCluster[], facilities: Facility[]): NeedGap[] {
    const gaps: NeedGap[] = [];

    for (let i = 0; i < clusters.length; i++) {
        const cluster = clusters[i];

        let nearest: Facility | null = null;
        let bestDistance = -1;
        for (let j = 0; j < facilities.length; j++) {
            const facility = facilities[j];
            if (facility.kind !== cluster.kind) continue;
            const distance = manhattan(cluster.x, cluster.y, facility.x, facility.y);
            if (nearest === null || distance < bestDistance) {
                nearest = facility;
                bestDistance = distance;
            }
        }

        gaps.push({
            cluster: cluster,
            nearest: nearest,
            distance: nearest === null ? -1 : bestDistance,
        });
    }

    gaps.sort((a, b) => {
        // -1 (no facility at all) must sort as "worse than any finite distance".
        if (a.distance === -1 && b.distance === -1) return 0;
        if (a.distance === -1) return -1;
        if (b.distance === -1) return 1;
        return b.distance - a.distance;
    });

    return gaps;
}

/** One-line human-readable summary of a gap, for the in-game console. */
export function describeGap(gap: NeedGap): string {
    const location = "(" + gap.cluster.x + ", " + gap.cluster.y + ")";
    const guestWord = gap.cluster.count === 1 ? "guest" : "guests";
    const label = needLabel(gap.cluster.kind);

    if (gap.nearest === null) {
        return (
            label + " at " + location + ": " + gap.cluster.count + " " + guestWord +
            " - no " + facilityLabel(gap.cluster.kind) + " exists anywhere in the park, build one."
        );
    }

    return (
        label + " at " + location + ": " + gap.cluster.count + " " + guestWord +
        " - nearest " + facilityLabel(gap.cluster.kind) + " (\"" + gap.nearest.name + "\") is " +
        gap.distance + " tiles away, consider adding one closer."
    );
}

/** One pass's slice of the guest roster, plus whether it completed a full sweep. */
export interface SampleWindow {
    /** First index to read, inclusive. */
    start: number;
    /** Last index to read, exclusive. */
    end: number;
    /**
     * True when this pass reached the end of the roster, so the accumulated picture
     * covers every guest and should be published.
     */
    sweepComplete: boolean;
}

/**
 * Rotating window over a guest roster whose length changes between passes.
 *
 * WHY THIS IS A SEPARATE, TESTED THING:
 *   The original version lived inline and decided "is the sweep finished?" at the START
 *   of the next pass, by asking `offset >= total`. The offset is only ever advanced to
 *   `min(offset + window, total)`, so it can equal `total` but never exceed it — and on
 *   a GROWING park the next pass sees a larger `total`, so the comparison is false and
 *   the sweep never completes.
 *
 *   Measured 2026-09-20: across 78 in-game days on a park growing 99 -> 214 guests, the
 *   need accumulator never published once. Every reading stayed frozen at its first
 *   value, no gap was ever confirmed, and the facility builder correctly did nothing
 *   because it had been handed nothing. No error was raised anywhere — every individual
 *   step did exactly what it said.
 *
 *   A stable park hides it completely: at ~940 roughly-constant guests the offset lands
 *   exactly on the count and the next pass's comparison happens to hold. That is why it
 *   survived several sessions of field testing on a mature park.
 *
 * The fix is to decide completion from the pass that just ran, not from the next one.
 */
export interface SampleRotation {
    /** Advances the window over a roster of `total` entries. */
    next(total: number): SampleWindow;
    /** Current offset, for telemetry. */
    offset(): number;
    reset(): void;
}

export function createSampleRotation(windowSize: number): SampleRotation {
    const size = windowSize < 1 ? 1 : windowSize;
    let start = 0;

    function next(total: number): SampleWindow {
        if (total <= 0) {
            start = 0;
            return { start: 0, end: 0, sweepComplete: false };
        }
        // The roster can also SHRINK between passes (guests leave), which would leave the
        // offset stranded past the end and starve the sweep just as surely.
        if (start >= total) start = 0;

        const end = start + size > total ? total : start + size;
        const complete = end >= total;
        const window: SampleWindow = { start: start, end: end, sweepComplete: complete };
        start = complete ? 0 : end;
        return window;
    }

    return {
        next: next,
        offset: function (): number { return start; },
        reset: function (): void { start = 0; },
    };
}
