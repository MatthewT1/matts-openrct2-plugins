/**
 * Cheap "just in case" buildings: where to put them (#81 info kiosks, #82 ATMs,
 * #105 umbrella stall).
 *
 * The rule is the one players use by hand (user, session 9): one at the park **front**
 * (the entrance), one at the **back** (the path tile farthest from the entrance by
 * walking distance), and one wherever the guests who need it cluster, if none is
 * already nearby. At a few hundred pounds each these are cheap safety, so there is no
 * persistence gate like the one that guards food stalls in facilities.ts: a building
 * that turns out to be spare costs little.
 *
 * Pure logic, no OpenRCT2 globals, so it is unit-tested (tests/cheap-builds.test.mjs).
 * The map reads and game actions live in builder/cheap-builds.ts.
 */

export interface Tile {
    x: number;
    y: number;
}

export type AnchorRole = "front" | "back" | "cluster";

export interface Anchor extends Tile {
    role: AnchorRole;
}

export interface SiteCandidate extends Tile {
    flat: boolean;
}

export interface CheapBuildOptions {
    /** An existing building of the kind this close (Manhattan tiles) covers an anchor. */
    coverRadius: number;
    /** The back is only worth a building this many path steps from the entrance. */
    minBackSteps: number;
    /** Guests with the thought in one cluster cell before it counts as a cluster. */
    clusterMinGuests: number;
    /** Most of one kind the plugin will have in the park, counting the player's own. */
    maxPerKind: number;
    /** How far from an anchor a site may be (Manhattan tiles). */
    siteRadius: number;
    /** Real rides (not shops) the park needs before any of this is worth building. */
    minRides: number;
}

export const DEFAULT_CHEAP_BUILD_OPTIONS: CheapBuildOptions = {
    coverRadius: 12,
    minBackSteps: 25,
    clusterMinGuests: 3,
    maxPerKind: 4,
    siteRadius: 6,
    minRides: 3,
};

// Map sizes top out at 1001 tiles (MAXIMUM_MAP_SIZE_TECHNICAL), so 4096 leaves room.
const KEY_SCALE = 4096;

/** Packs a tile into one number, for graph and grid keys. */
export function tileKey(x: number, y: number): number {
    return x * KEY_SCALE + y;
}

export function keyTile(key: number): Tile {
    return { x: Math.floor(key / KEY_SCALE), y: key % KEY_SCALE };
}

function manhattan(a: Tile, b: Tile): number {
    return Math.abs(a.x - b.x) + Math.abs(a.y - b.y);
}

/**
 * The path tile farthest from any start tile by walking steps (breadth-first search),
 * or null when there are no starts in the graph.
 *
 * `neighbours` maps a tile key to the keys of the path tiles it connects to. Ties go to
 * the tile reached first, so the result is deterministic for a given graph.
 */
export function farthestPathTile(
    starts: number[],
    neighbours: Record<number, number[]>,
): { x: number; y: number; steps: number } | null {
    const dist: Record<number, number> = {};
    const queue: number[] = [];
    for (let i = 0; i < starts.length; i++) {
        const k = starts[i];
        if (neighbours[k] === undefined || dist[k] !== undefined) continue;
        dist[k] = 0;
        queue.push(k);
    }
    if (queue.length === 0) return null;

    let best = queue[0];
    for (let head = 0; head < queue.length; head++) {
        const k = queue[head];
        const d = dist[k];
        if (d > dist[best]) best = k;
        const next = neighbours[k];
        for (let i = 0; i < next.length; i++) {
            const n = next[i];
            if (dist[n] !== undefined || neighbours[n] === undefined) continue;
            dist[n] = d + 1;
            queue.push(n);
        }
    }
    const t = keyTile(best);
    return { x: t.x, y: t.y, steps: dist[best] };
}

/**
 * The front, back and cluster anchors, in build order.
 *
 * Front first because every guest passes it; the back only when the park is deep
 * enough that the front does not already serve it; clusters last.
 */
export function buildAnchors(
    fronts: Tile[],
    back: { x: number; y: number; steps: number } | null,
    clusters: Tile[],
    options: CheapBuildOptions,
): Anchor[] {
    const out: Anchor[] = [];
    for (let i = 0; i < fronts.length; i++) out.push({ x: fronts[i].x, y: fronts[i].y, role: "front" });
    if (back !== null && back.steps >= options.minBackSteps) out.push({ x: back.x, y: back.y, role: "back" });
    for (let i = 0; i < clusters.length; i++) out.push({ x: clusters[i].x, y: clusters[i].y, role: "cluster" });
    return out;
}

/**
 * Anchors with no building of the kind within `coverRadius`, in the order given.
 *
 * Empty once the kind is at `maxPerKind`. Coverage is re-derived from the buildings
 * that exist rather than remembered, so one the player demolishes is noticed and one
 * the player built counts.
 */
export function uncoveredAnchors(anchors: Anchor[], built: Tile[], options: CheapBuildOptions): Anchor[] {
    if (built.length >= options.maxPerKind) return [];
    return anchors.filter(function (a): boolean {
        for (let i = 0; i < built.length; i++) {
            if (manhattan(a, built[i]) <= options.coverRadius) return false;
        }
        return true;
    });
}

/**
 * The best site for an anchor: flat ground first (a sloped tile only works when the
 * game's own query says so), then the closest. Null when none is within `siteRadius`.
 */
export function pickSite<T extends SiteCandidate>(anchor: Tile, sites: T[], options: CheapBuildOptions): T | null {
    let best: T | null = null;
    let bestScore = Infinity;
    for (let i = 0; i < sites.length; i++) {
        const d = manhattan(anchor, sites[i]);
        if (d > options.siteRadius) continue;
        // Flatness outranks any distance inside the radius.
        const score = d + (sites[i].flat ? 0 : 1000);
        if (score < bestScore) {
            bestScore = score;
            best = sites[i];
        }
    }
    return best;
}

/**
 * Counts where guests with a given thought are standing, on a coarse grid, and reports
 * the fullest cell. The reported tile is the guests' mean position, not the cell
 * centre, so it lands on the paths they are actually on.
 */
export function createSpotAccumulator(cellTiles: number) {
    const cells: Record<number, { n: number; sx: number; sy: number }> = {};

    return {
        add(x: number, y: number): void {
            if (x < 0 || y < 0) return;
            const k = tileKey(Math.floor(x / cellTiles), Math.floor(y / cellTiles));
            const c = cells[k] || (cells[k] = { n: 0, sx: 0, sy: 0 });
            c.n++;
            c.sx += x;
            c.sy += y;
        },
        /** Up to `limit` cells with at least `minCount` guests, fullest first. */
        top(minCount: number, limit: number): Array<Tile & { count: number }> {
            const out: Array<Tile & { count: number }> = [];
            for (const key in cells) {
                const c = cells[key];
                if (c.n < minCount) continue;
                out.push({ x: Math.round(c.sx / c.n), y: Math.round(c.sy / c.n), count: c.n });
            }
            out.sort(function (a, b): number { return b.count - a.count || a.x - b.x || a.y - b.y; });
            return out.slice(0, limit);
        },
        reset(): void {
            for (const key in cells) delete cells[key];
        },
    };
}
