/**
 * Award top-up (#162): which toilet or food stall would bring the park within the count
 * rule of the Best Toilets / Best Food award, and where to put it. Pure, no game globals.
 *
 * Each positive award multiplies guest generation by 1.25 while held (`world/Park.cpp:163-211`).
 * The count rules, from `management/Award.cpp`:
 *   Best Toilets (L390-420): >= 4 open toilets and >= guests / 128.
 *   Best Food    (L300-342): >= 7 open food stalls, >= 4 different items, and >= guests / 128.
 * Both also need few guests thinking "need toilet" / "hungry", which the need-gap builder
 * already works on. Measured on 32 parks (#162): 8 were 1-3 toilets short and 12 were 1-3
 * food stalls or item types short with the thought clause already met.
 */

export interface AwardCounts {
    /** Guests in the park. */
    guests: number;
    /** Open toilets. */
    toilets: number;
    /** Open food stalls (ride type 28). */
    foodStalls: number;
    /** Different items those food stalls sell. */
    foodItems: number;
    /** True when an unlocked food stall sells an item the park does not have yet. */
    newFoodItemUnlocked: boolean;
}

export interface AwardTopUpOptions {
    minToilets: number;
    minFoodStalls: number;
    minFoodItems: number;
    guestsPerFacility: number;
    /** A park further than this from the count is the need-gap builder's job, not a top-up. */
    maxShort: number;
}

export const DEFAULT_AWARD_TOPUP_OPTIONS: AwardTopUpOptions = {
    minToilets: 4,
    minFoodStalls: 7,
    minFoodItems: 4,
    guestsPerFacility: 128,
    maxShort: 3,
};

export interface AwardTopUp {
    kind: "toilet" | "hunger";
    award: "Best Toilets" | "Best Food";
    have: number;
    need: number;
    /** True when the stall count is met and only the item variety is short. */
    varietyOnly: boolean;
}

/** How many of a facility the award asks for at this guest count (integer division, as the game). */
export function awardNeed(guests: number, minimum: number, guestsPerFacility: number): number {
    return Math.max(minimum, Math.floor(guests / guestsPerFacility));
}

/**
 * The one build that moves the park toward an award, or null when it is already there or
 * too far off. Toilets first: they are cheaper (GBP 225 vs 300) and the rule is simpler.
 */
export function planAwardTopUp(c: AwardCounts, o: AwardTopUpOptions): AwardTopUp | null {
    const toiletNeed = awardNeed(c.guests, o.minToilets, o.guestsPerFacility);
    const toiletShort = toiletNeed - c.toilets;
    if (toiletShort >= 1 && toiletShort <= o.maxShort) {
        return { kind: "toilet", award: "Best Toilets", have: c.toilets, need: toiletNeed, varietyOnly: false };
    }
    const foodNeed = awardNeed(c.guests, o.minFoodStalls, o.guestsPerFacility);
    const foodShort = foodNeed - c.foodStalls;
    if (foodShort >= 1 && foodShort <= o.maxShort) {
        return { kind: "hunger", award: "Best Food", have: c.foodStalls, need: foodNeed, varietyOnly: false };
    }
    // Enough stalls but too few different items: one more only helps if it sells a new item.
    const itemShort = o.minFoodItems - c.foodItems;
    if (foodShort <= 0 && itemShort >= 1 && itemShort <= o.maxShort && c.newFoodItemUnlocked) {
        return { kind: "hunger", award: "Best Food", have: c.foodItems, need: o.minFoodItems, varietyOnly: true };
    }
    return null;
}

export interface TopUpTile { x: number; y: number; }
export interface TopUpCluster extends TopUpTile { kind: string; guests: number; }

function manhattan(a: TopUpTile, b: TopUpTile): number {
    return Math.abs(a.x - b.x) + Math.abs(a.y - b.y);
}

/**
 * Where the top-up goes: beside the biggest group of guests who need it now; with no such
 * group, the path area farthest from every existing facility of that kind (the biggest hole
 * in the coverage). Null when there is neither a cluster nor a path tile to go by.
 */
export function pickTopUpAnchor(kind: string, clusters: TopUpCluster[], existing: TopUpTile[], pathTiles: TopUpTile[]): TopUpTile | null {
    let best: TopUpCluster | null = null;
    for (let i = 0; i < clusters.length; i++) {
        if (clusters[i].kind !== kind) continue;
        if (best === null || clusters[i].guests > best.guests) best = clusters[i];
    }
    if (best !== null) return { x: best.x, y: best.y };

    let far: TopUpTile | null = null;
    let farDistance = -1;
    for (let i = 0; i < pathTiles.length; i++) {
        let nearest = Infinity;
        for (let e = 0; e < existing.length; e++) nearest = Math.min(nearest, manhattan(pathTiles[i], existing[e]));
        if (nearest > farDistance) {
            far = pathTiles[i];
            farDistance = nearest;
        }
    }
    return far;
}

/** Nearest site to the anchor within `radius`; flat ground breaks a tie. */
export function nearestTopUpSite<T extends TopUpTile & { flat: boolean }>(anchor: TopUpTile, sites: T[], radius: number): T | null {
    let best: T | null = null;
    let bestDistance = 0;
    for (let i = 0; i < sites.length; i++) {
        const d = manhattan(anchor, sites[i]);
        if (d > radius) continue;
        if (best === null || d < bestDistance || (d === bestDistance && sites[i].flat && !best.flat)) {
            best = sites[i];
            bestDistance = d;
        }
    }
    return best;
}

/**
 * Per-kind cap for the need-gap builder (#162): the flat cap, or the award's own yardstick
 * of one per `guestsPerFacility` guests plus one spare, whichever is larger. A flat 8 left
 * every 1,000+ guest park short of toilets while guests kept asking for one.
 */
export function scaledFacilityCap(flatCap: number, guests: number, guestsPerFacility: number): number {
    return Math.max(flatCap, Math.floor(guests / guestsPerFacility) + 1);
}
