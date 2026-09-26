/**
 * Food court extras (#83): dense benches and bins around each court, and a toilet
 * nearby, the way a player dresses up a food court by hand. Guests eat and drink there,
 * so litter lands there (bins) and they want to sit while they eat (benches).
 *
 * Which tiles is decided here (tested); builder/court-extras.ts reads the map and places.
 * Pure logic, no OpenRCT2 globals (tests/court-extras.test.mjs).
 */

export type CourtAmenity = "bench" | "bin";

export interface CourtPathTile {
    x: number;
    y: number;
    isQueue: boolean;
    /** Sloped or enclosed on all four edges: the game refuses additions there. */
    blocked: boolean;
    /** Already carries a path addition (ours, the player's, a lamp...). */
    occupied: boolean;
}

export interface CourtExtrasOptions {
    /** Path tiles within this many tiles (Chebyshev) of the court centre get an item. */
    radius: number;
    /** A toilet within this many tiles (Manhattan) of the court centre serves it. */
    toiletReach: number;
}

export const DEFAULT_COURT_EXTRAS: CourtExtrasOptions = {
    radius: 3,
    toiletReach: 8,
};

/** Checkerboard: benches and bins alternate so every seat has a bin next to it. */
export function courtAmenityKind(x: number, y: number): CourtAmenity {
    return ((x + y) & 1) === 0 ? "bench" : "bin";
}

/**
 * Every free, placeable, non-queue path tile within `radius` of the court, nearest the
 * centre first, up to `limit`.
 */
export function pickCourtAmenities(court: { x: number; y: number }, tiles: CourtPathTile[],
                                   options: CourtExtrasOptions, limit: number): Array<{ x: number; y: number; kind: CourtAmenity }> {
    const free: Array<{ t: CourtPathTile; d: number }> = [];
    for (let i = 0; i < tiles.length; i++) {
        const t = tiles[i];
        if (t.isQueue || t.blocked || t.occupied) continue;
        const d = Math.max(Math.abs(t.x - court.x), Math.abs(t.y - court.y));
        if (d > options.radius) continue;
        free.push({ t: t, d: Math.abs(t.x - court.x) + Math.abs(t.y - court.y) });
    }
    free.sort(function (a, b) { return a.d - b.d || a.t.x - b.t.x || a.t.y - b.t.y; });
    const out: Array<{ x: number; y: number; kind: CourtAmenity }> = [];
    for (let i = 0; i < free.length && out.length < limit; i++) {
        out.push({ x: free[i].t.x, y: free[i].t.y, kind: courtAmenityKind(free[i].t.x, free[i].t.y) });
    }
    return out;
}

/** True when no toilet is within `toiletReach` of the court. */
export function courtNeedsToilet(court: { x: number; y: number }, toilets: Array<{ x: number; y: number }>,
                                 options: CourtExtrasOptions): boolean {
    for (let i = 0; i < toilets.length; i++) {
        if (Math.abs(toilets[i].x - court.x) + Math.abs(toilets[i].y - court.y) <= options.toiletReach) return false;
    }
    return true;
}
