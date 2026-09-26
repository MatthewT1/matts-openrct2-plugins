/**
 * Queue TVs on long queues (#104): which queue tiles get one.
 *
 * Source (`Guest.cpp:1107-1150`): once a guest has queued for 2000+ ticks, each update
 * lowers their target happiness by 4 unless their own queue tile has a TV; on a TV tile
 * it is raised to at least 90, then +2 per update up to 165. The check is per tile, so
 * a TV only helps the guests standing on it. The longest-waiting guests are nearest the
 * ride, so TVs go from the front of the queue backwards, spaced out so one queue gets
 * several screens along its length rather than a cluster at the start.
 *
 * Placement limits (`FootpathAdditionPlaceAction.cpp:115-124`): queue tiles only, and
 * not a tile with all 4 edges connected.
 *
 * Pure logic, no OpenRCT2 globals (tests/queue-tv.test.mjs).
 */

export interface QueueTile {
    x: number;
    y: number;
    /** Number of connected edges (0-4). A TV cannot go on a 4-edge tile. */
    edgeCount: number;
    /** Any path addition already here (ours or the player's). */
    hasAddition: boolean;
    /** The addition here is a queue TV. */
    hasTv: boolean;
}

export interface QueueTvOptions {
    /** Posted wait (station queueTime, minutes) before a queue gets TVs. */
    minQueueMinutes: number;
    /** Most TVs on one queue, counting any already there. */
    maxPerQueue: number;
    /** Tiles between TVs along the queue (2 = every other tile). */
    spacing: number;
    /** Most TVs placed per day, across all queues. */
    maxPerDay: number;
}

export const DEFAULT_QUEUE_TV_OPTIONS: QueueTvOptions = {
    // The walk-out warning threshold (QUEUE_WARN_MINUTES in wait-time-optimizer.ts).
    minQueueMinutes: 5,
    maxPerQueue: 4,
    spacing: 3,
    maxPerDay: 2,
};

/**
 * Indices into `trace` (ordered front of queue first) to put a TV on.
 *
 * Skips tiles with any addition (never replaces the player's bin, bench or lamp) and
 * 4-edge tiles, keeps `spacing` tiles from every TV already on the queue, and stops at
 * `maxPerQueue` including existing TVs, or at `budget` new ones.
 */
export function pickTvTiles(trace: QueueTile[], options: QueueTvOptions, budget: number): number[] {
    const tvAt: number[] = [];
    for (let i = 0; i < trace.length; i++) if (trace[i].hasTv) tvAt.push(i);
    const room = Math.min(options.maxPerQueue - tvAt.length, budget);
    const out: number[] = [];
    if (room <= 0) return out;

    for (let i = 0; i < trace.length && out.length < room; i++) {
        const t = trace[i];
        if (t.hasAddition || t.edgeCount >= 4) continue;
        let clear = true;
        for (let j = 0; j < tvAt.length; j++) {
            if (Math.abs(tvAt[j] - i) < options.spacing) { clear = false; break; }
        }
        if (!clear) continue;
        out.push(i);
        tvAt.push(i);
    }
    return out;
}

/** Number of set bits in the low 4 bits of a footpath `edges` mask. */
export function edgeCount(edges: number): number {
    let n = 0;
    for (let d = 0; d < 4; d++) if ((edges & (1 << d)) !== 0) n++;
    return n;
}
