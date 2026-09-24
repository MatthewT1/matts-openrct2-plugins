/**
 * Constants, types and small litter helpers shared by the trash-manager modules.
 *
 * Split out of trash-manager.ts (#6) with no behaviour change.
 */

import { Hotspot } from "../hotspots";

export interface TileCoord {
    x: number;
    y: number;
}

export interface BoundingRect {
    x1: number;
    y1: number;
    x2: number;
    y2: number;
}

export interface TileCache {
    pathTiles:    number;
    ownedTiles:   number;
    guests:       number;
    handymanCount: number;
    totalLitter:  number;
    oldLitter:    number;
    fullBins:   number;
    brokenBins: number;
    vomit:      number;
    trash:      number;
    // Worst litter clusters from the most recent entity scan, worst first.
    topHotspots: Hotspot[];
    // Bounding boxes (tile coords) of owned land and of tiles carrying footpaths.
    // Informational only since patrol zones were dropped — kept because they fall out
    // of the tile scan for free and are useful when debugging path/ownership counts.
    parkBounds: BoundingRect;
    pathBounds: BoundingRect;
}


// -------------------------------------------------------------------------
// Constants (Park.cpp source-verified values)
// -------------------------------------------------------------------------

export const LITTER_OLD_AGE_TICKS    = 7680;  // ticks before litter starts costing rating (~3 min)
export const LITTER_PENALTY_CAP      = 150;   // rating penalty bottoms out at 150 old pieces
export const RATING_PTS_PER_LITTER   = 4;     // rating points lost per old litter piece
export const FREE_ROAMING_BUFFER     = 2;     // handymen kept unzoned for overflow coverage
export const GUESTS_PER_HANDYMAN     = 30;    // one handyman per ~30 guests (litter rate scales with guests)
export const PATH_TILES_PER_HANDYMAN = 100;   // floor: one per 100 path tiles so empty parks don't over-hire
// sweep (1) + empty bins (4); mowing (8) is intentionally excluded
export const HANDYMAN_ORDERS         = 1 | 4;

// -------------------------------------------------------------------------
// Helpers
// -------------------------------------------------------------------------

export function getHandymen(): Handyman[] {
    return map.getAllEntities("staff").filter(
        (s: Staff): s is Handyman => s.staffType === "handyman"
    );
}

/**
 * Returns true if this litter piece has aged past the grace period.
 *
 * Note: creationTick is a uint32 in C++ and can wrap around after ~49 days
 * of continuous ticks. The subtraction can go negative in JS, so we add 2^32
 * to correct for the wrap. Same fix as used by ParkRatingInspector.js.
 */
export function litterAge(litter: Litter): number {
    let age = date.ticksElapsed - litter.creationTick;
    if (age < 0) age += 4294967296;
    return age;
}

export function isOldLitter(litter: Litter): boolean {
    return litterAge(litter) >= LITTER_OLD_AGE_TICKS;
}

/** Penalty in rating points from the given old-litter count: min(150, n) * 4 */
export function computeRatingPenalty(oldCount: number): number {
    return Math.min(LITTER_PENALTY_CAP, oldCount) * RATING_PTS_PER_LITTER;
}

/** Target handyman count: driven by guests (litter source) with a path-tile floor for empty parks */
export function computeNeededHandymen(pathTileCount: number, guestCount: number): number {
    const fromGuests = Math.ceil(guestCount / GUESTS_PER_HANDYMAN);
    const fromTiles  = Math.ceil(pathTileCount / PATH_TILES_PER_HANDYMAN);
    return Math.max(fromGuests, fromTiles) + FREE_ROAMING_BUFFER;
}
