/**
 * Handyman patrol zones (#65): 4x4-tile blocks laid over the path network, dealt out so every
 * zoned handyman gets about the same number of path tiles, with a few left roaming as backup.
 *
 * Pure: no game globals, so it runs under node in tests.
 *
 * A zone is a set of blocks grown outward from a seed (breadth-first over touching blocks), so
 * it stays one connected patch where the paths allow. Staff only wander inside their patrol
 * area, so a zone split into islands would strand the handyman on one of them.
 */

export const ZONE_BLOCK_TILES = 4;
/** Handymen left without a zone as backup (community advice: about 2). */
export const ZONE_ROAMERS = 2;

/** A 4x4-tile block that holds `tiles` path tiles. bx/by are block coordinates (tile / 4). */
export interface ZoneBlock {
    bx: number;
    by: number;
    tiles: number;
}

export interface ZonePlan {
    /** handyman id -> the blocks (as "bx,by" keys) that make up their zone. */
    zones: Record<number, string[]>;
    /** Handymen with no zone: they roam the whole park. */
    roaming: number[];
}

export function blockKey(bx: number, by: number): string {
    return bx + "," + by;
}

/** Z-order (Morton) index of a block: nearby blocks get nearby numbers, so seeds spread evenly. */
function morton(bx: number, by: number): number {
    let m = 0;
    for (let i = 0; i < 12; i++) {
        m += ((bx >> i) & 1) * Math.pow(2, 2 * i) + ((by >> i) & 1) * Math.pow(2, 2 * i + 1);
    }
    return m;
}

/**
 * Splits the blocks between the handymen. Ids are dealt out in ascending order, so the same
 * roster and blocks always give the same plan. With `roamers` or fewer handymen everyone roams.
 */
export function planZones(blocks: ZoneBlock[], handymanIds: number[], roamers: number = ZONE_ROAMERS): ZonePlan {
    const ids = handymanIds.slice().sort(function(a, b): number { return a - b; });
    const zoned = ids.length - roamers;
    const plan: ZonePlan = { zones: {}, roaming: [] };
    if (zoned <= 0 || blocks.length === 0) {
        plan.roaming = ids;
        return plan;
    }
    // More zoned handymen than blocks: the extras roam rather than share a block.
    const zoneCount = Math.min(zoned, blocks.length);
    plan.roaming = ids.slice(zoneCount);

    const order = blocks.slice().sort(function(a, b): number { return morton(a.bx, a.by) - morton(b.bx, b.by); });
    const byKey: Record<string, ZoneBlock> = {};
    let total = 0;
    for (const b of order) { byKey[blockKey(b.bx, b.by)] = b; total += b.tiles; }
    const taken: Record<string, true> = {};
    let seedAt = 0;

    const owner: Record<string, number> = {};

    /** Free neighbours of a block: how boxed-in it is. */
    function freeNeighbours(b: ZoneBlock): number {
        let n = 0;
        for (let dx = -1; dx <= 1; dx++) for (let dy = -1; dy <= 1; dy++) {
            const k = blockKey(b.bx + dx, b.by + dy);
            if ((dx !== 0 || dy !== 0) && byKey[k] !== undefined && !taken[k]) n++;
        }
        return n;
    }

    /**
     * Where the next patch starts: a free block touching what this zone already holds (so
     * the zone stays in one piece), the most boxed-in one first (so the free area stays
     * in one piece too). A zone with nothing yet starts from the previous edge, else Z-order.
     */
    function pickSeed(mine: string[]): ZoneBlock | null {
        let best: ZoneBlock | null = null, bestN = 99;
        const from = mine.length > 0 ? mine : lastZone;
        for (const key of from) {
            const p = key.split(",");
            const bx = Number(p[0]), by = Number(p[1]);
            for (let dx = -1; dx <= 1; dx++) for (let dy = -1; dy <= 1; dy++) {
                const k = blockKey(bx + dx, by + dy);
                if (byKey[k] === undefined || taken[k]) continue;
                const n = freeNeighbours(byKey[k]);
                if (n < bestN) { best = byKey[k]; bestN = n; }
            }
        }
        if (best !== null) return best;
        while (seedAt < order.length && taken[blockKey(order[seedAt].bx, order[seedAt].by)]) seedAt++;
        return seedAt < order.length ? order[seedAt] : null;
    }
    let lastZone: string[] = [];
    for (let z = 0; z < zoneCount; z++) {
        const mine: string[] = [];
        plan.zones[ids[z]] = mine;
        // Share what is left over the zones still to fill, so rounding never starves the last one.
        const target = total / (zoneCount - z);
        let weight = 0;
        while (weight < target) {
            const seed = pickSeed(mine);
            if (seed === null) break;
            // Grow one patch from the seed.
            const queue: ZoneBlock[] = [seed];
            taken[blockKey(seed.bx, seed.by)] = true;
            while (queue.length > 0 && weight < target) {
                const b = queue.shift() as ZoneBlock;
                mine.push(blockKey(b.bx, b.by));
                owner[blockKey(b.bx, b.by)] = z;
                weight += b.tiles;
                for (let dx = -1; dx <= 1; dx++) for (let dy = -1; dy <= 1; dy++) {
                    const k = blockKey(b.bx + dx, b.by + dy);
                    if (byKey[k] !== undefined && !taken[k]) { taken[k] = true; queue.push(byKey[k]); }
                }
            }
            // Blocks queued but not used go back in the pool for the next zone.
            for (const q of queue) delete taken[blockKey(q.bx, q.by)];
        }
        total -= weight;
        lastZone = mine;
    }

    // Rounding leaves a few blocks over. Each joins a zone it touches; a block touching none
    // (an island) goes to the last zone.
    let left = order.filter(function(b): boolean { return !taken[blockKey(b.bx, b.by)]; });
    while (left.length > 0) {
        const rest: ZoneBlock[] = [];
        for (const b of left) {
            let z = -1;
            for (let dx = -1; dx <= 1 && z < 0; dx++) for (let dy = -1; dy <= 1 && z < 0; dy++) {
                const o = owner[blockKey(b.bx + dx, b.by + dy)];
                if (o !== undefined) z = o;
            }
            if (z < 0) { rest.push(b); continue; }
            plan.zones[ids[z]].push(blockKey(b.bx, b.by));
            owner[blockKey(b.bx, b.by)] = z;
        }
        if (rest.length === left.length) {
            const z = zoneCount - 1;
            for (const b of rest) { plan.zones[ids[z]].push(blockKey(b.bx, b.by)); owner[blockKey(b.bx, b.by)] = z; }
            break;
        }
        left = rest;
    }
    return plan;
}

/** What to change to move from the zones applied now to a new plan, for one handyman. */
export interface ZoneDelta {
    add: string[];
    remove: string[];
}

export function zoneDelta(applied: string[] | undefined, wanted: string[]): ZoneDelta {
    const have: Record<string, true> = {};
    (applied || []).forEach(function(k): void { have[k] = true; });
    const want: Record<string, true> = {};
    wanted.forEach(function(k): void { want[k] = true; });
    return {
        add: wanted.filter(function(k): boolean { return !have[k]; }),
        remove: (applied || []).filter(function(k): boolean { return !want[k]; }),
    };
}

/** World-coordinate rectangle for `staffsetpatrolarea`: the block's four tiles, ends inclusive. */
export function blockRect(key: string): { x1: number; y1: number; x2: number; y2: number } {
    const p = key.split(",");
    const bx = Number(p[0]), by = Number(p[1]);
    return {
        x1: bx * ZONE_BLOCK_TILES * 32,
        y1: by * ZONE_BLOCK_TILES * 32,
        x2: (bx * ZONE_BLOCK_TILES + ZONE_BLOCK_TILES - 1) * 32,
        y2: (by * ZONE_BLOCK_TILES + ZONE_BLOCK_TILES - 1) * 32,
    };
}
