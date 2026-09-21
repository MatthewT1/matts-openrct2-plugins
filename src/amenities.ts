/**
 * Amenity placement — OpenRCT2 plugin
 *
 * WHY THIS MODULE EXISTS:
 *   Telemetry across 166 in-game days showed 99.7% of all litter recorded by this park
 *   was vomit, not trash. Litter bins only catch trash, so on this park bins are a
 *   low-value amenity — the high-value one is the bench, because of a genuine game
 *   mechanic: `Guest.cpp:1099` sheds 6 `nauseaTarget` per update from a sitting guest
 *   while it is still `>= 50`. A bench near a nauseating ride's exit lets guests shed
 *   nausea before it turns into vomit; a bin near a food stall catches the trash that
 *   does occur. Community consensus (unverified, but consistent across sources) agrees
 *   with that split — bins near food, benches near nauseating exits — so this module
 *   treats amenity kind as tied to the reason it is wanted, not interchangeable.
 *
 *   This module turns a list of demand signals (from ride/stall analysis elsewhere in
 *   the plugin) and the current footpath-addition state into a plan: which amenities to
 *   place, and — only under a player-safety rule — which of our own to remove because
 *   nothing justifies them any more. It is pure data-in/data-out logic with no game API
 *   calls, so it can be unit-tested without a running park.
 */

/** The two footpath additions this module plans. */
export type AmenityKind = "bench" | "bin";

/** A footpath tile that could host an amenity. */
export interface AmenitySite {
    x: number;
    y: number;
    /** True when this tile already carries any footpath addition (so nothing can be placed). */
    occupied: boolean;
    /** Kind of amenity already here, or null. Only meaningful when `occupied`. */
    existing: AmenityKind | null;
    /** True when this tile's addition was placed by us and may therefore be removed. */
    ours: boolean;
    /** Queue tiles cannot take additions. */
    isQueue: boolean;
    /**
     * True when the game will refuse an addition here for a reason other than the tile
     * already being occupied — a sloped path, or a fully-enclosed tile with all four
     * edges connected. See FootpathAdditionPlaceAction.cpp:105-118.
     */
    blocked: boolean;
}

/** A reason amenities are wanted at a location. */
export interface AmenityDemand {
    x: number;
    y: number;
    kind: AmenityKind;
    /** Higher is more urgent. Used to rank when the placement budget is limited. */
    weight: number;
    /** Short human-readable cause, e.g. "Twister exit (nausea 8.40)". */
    reason: string;
}

export interface AmenityAction {
    x: number;
    y: number;
    kind: AmenityKind;
    reason: string;
}

export interface AmenityPlan {
    place: AmenityAction[];
    remove: AmenityAction[];
}

export interface AmenityOptions {
    /** Max tiles from a demand that an amenity may be placed. */
    radius: number;
    /** Hard cap on placements produced by one plan. */
    maxPlace: number;
    /** Hard cap on removals produced by one plan. */
    maxRemove: number;
    /** An existing amenity within this many tiles of a demand already satisfies it. */
    satisfiedWithin: number;
    /** When false, `remove` is always empty. */
    allowRemoval: boolean;
}

/** Manhattan distance in tiles between two points. Cheap and matches path-grid movement. */
function manhattan(ax: number, ay: number, bx: number, by: number): number {
    const dx = ax > bx ? ax - bx : bx - ax;
    const dy = ay > by ? ay - by : by - ay;
    return dx + dy;
}

/**
 * True when some amenity of `kind` — ours or the player's, it does not matter which —
 * already sits within `satisfiedWithin` tiles of the demand. A demand this satisfies
 * must not produce a placement: doubling up on seating or bins that are already doing
 * the job wastes the placement budget and clutters the path.
 */
function isSatisfied(
    demand: AmenityDemand,
    sites: AmenitySite[],
    satisfiedWithin: number,
): boolean {
    for (let i = 0; i < sites.length; i++) {
        const site = sites[i];
        if (!site.occupied || site.existing !== demand.kind) {
            continue;
        }
        if (manhattan(demand.x, demand.y, site.x, site.y) <= satisfiedWithin) {
            return true;
        }
    }
    return false;
}

/**
 * Finds the nearest eligible, not-yet-claimed site for a demand within `radius` tiles.
 * Eligible means unoccupied and not a queue tile. Ties break on lower x then lower y so
 * that repeated runs over the same input produce the same plan, which matters for a
 * plugin that only re-plans every 30 real seconds and should not visibly dither.
 *
 * @param claimed Parallel array to `sites`; true for a site already used earlier in
 * this same planning pass, so two demands never compete for the same tile in one plan.
 */
function nearestEligibleSite(
    demand: AmenityDemand,
    sites: AmenitySite[],
    claimed: boolean[],
    radius: number,
): number {
    let bestIndex = -1;
    let bestDistance = -1;
    for (let i = 0; i < sites.length; i++) {
        const site = sites[i];
        if (claimed[i] || site.occupied || site.isQueue || site.blocked) {
            continue;
        }
        const distance = manhattan(demand.x, demand.y, site.x, site.y);
        if (distance > radius) {
            continue;
        }
        if (bestIndex === -1 || distance < bestDistance) {
            bestIndex = i;
            bestDistance = distance;
        } else if (distance === bestDistance) {
            const best = sites[bestIndex];
            if (site.x < best.x || (site.x === best.x && site.y < best.y)) {
                bestIndex = i;
            }
        }
    }
    return bestIndex;
}

/**
 * True when no demand of `kind` is within `radius` tiles of `(x, y)` — i.e. nothing in
 * the current demand list still justifies an amenity sitting there.
 */
function hasNoNearbyDemand(
    x: number,
    y: number,
    kind: AmenityKind,
    demands: AmenityDemand[],
    radius: number,
): boolean {
    for (let i = 0; i < demands.length; i++) {
        const demand = demands[i];
        if (demand.kind !== kind) {
            continue;
        }
        if (manhattan(x, y, demand.x, demand.y) <= radius) {
            return false;
        }
    }
    return true;
}

/**
 * Plans amenity placements and, optionally, removals from a snapshot of footpath sites
 * and the current demand list.
 *
 * PLACEMENT: demands are processed most-urgent (`weight`) first, so a limited
 * `maxPlace` budget goes where it matters most. A demand already satisfied by an
 * existing amenity of the same kind — ours or the player's — produces nothing; a demand
 * with no eligible site within `radius` also produces nothing. Otherwise the nearest
 * eligible site is claimed and cannot be reused by a later demand in the same plan.
 *
 * REMOVAL (only when `options.allowRemoval`): a removal is proposed only for a site
 * where `ours === true`. This is a hard safety rule — a player-placed bench or bin is
 * never touched by this module, regardless of how far it sits from any demand, because
 * removing something the player deliberately placed is a far worse mistake than leaving
 * a slightly-redundant amenity of ours standing. An amenity of ours is only removed once
 * nothing in the current demand list of its own kind is within `radius` tiles of it —
 * it no longer serves the purpose it was placed for.
 */
export function planAmenities(
    sites: AmenitySite[],
    demands: AmenityDemand[],
    options: AmenityOptions,
): AmenityPlan {
    const place: AmenityAction[] = [];
    const remove: AmenityAction[] = [];

    if (options.maxPlace > 0 && demands.length > 0 && sites.length > 0) {
        // Copy before sorting: the input arrays are the caller's, not ours to mutate.
        // Ties on weight break on lower x then lower y, for the same determinism reason
        // as the site tie-break below.
        const ordered = demands.slice();
        ordered.sort((a, b) => {
            if (b.weight !== a.weight) return b.weight - a.weight;
            if (a.x !== b.x) return a.x - b.x;
            return a.y - b.y;
        });

        const claimed: boolean[] = [];
        for (let i = 0; i < sites.length; i++) {
            claimed.push(false);
        }

        for (let i = 0; i < ordered.length && place.length < options.maxPlace; i++) {
            const demand = ordered[i];
            if (isSatisfied(demand, sites, options.satisfiedWithin)) {
                continue;
            }
            const siteIndex = nearestEligibleSite(demand, sites, claimed, options.radius);
            if (siteIndex === -1) {
                continue;
            }
            claimed[siteIndex] = true;
            const site = sites[siteIndex];
            place.push({ x: site.x, y: site.y, kind: demand.kind, reason: demand.reason });
        }
    }

    if (options.allowRemoval && options.maxRemove > 0 && sites.length > 0) {
        // Deterministic candidate order: lower x then lower y, independent of the order
        // `sites` happens to arrive in.
        const candidates: AmenitySite[] = [];
        for (let i = 0; i < sites.length; i++) {
            const site = sites[i];
            if (site.ours && site.existing !== null) {
                candidates.push(site);
            }
        }
        candidates.sort((a, b) => (a.x !== b.x ? a.x - b.x : a.y - b.y));

        for (let i = 0; i < candidates.length && remove.length < options.maxRemove; i++) {
            const site = candidates[i];
            const kind = site.existing as AmenityKind;
            if (hasNoNearbyDemand(site.x, site.y, kind, demands, options.radius)) {
                remove.push({
                    x: site.x,
                    y: site.y,
                    kind: kind,
                    reason:
                        "No " + kind + " demand within " + options.radius +
                        " tiles any more",
                });
            }
        }
    }

    return { place: place, remove: remove };
}
