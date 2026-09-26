/**
 * Gradual repair of broken benches, bins and lamps (#115). Pure, no OpenRCT2 globals
 * (tests/repairs.test.mjs).
 *
 * Nothing in the game repairs a broken path addition: angry guests break them
 * (Guest.cpp:6299), handymen skip broken bins (Staff.cpp:1580). The player's fix is to
 * place the same item on the tile again, which FootpathAdditionPlaceAction allows only
 * for a broken one and which clears the flag at the item's normal price. The plugin
 * does the same, a share of what is broken each day so it feels like a crew at work,
 * nearest the park entrance first.
 */

export interface BrokenTile {
    x: number;
    y: number;
    z: number;
    /** The broken addition's object index; the repair re-places this same one. */
    addition: number;
}

/** Share repaired on the first repair day, and on each day after. */
export const FIRST_DAY_SHARE = 0.28;
export const DAILY_SHARE = 0.2;

/** How many to repair today: a share of what is still broken, at least 1. */
export function repairQuota(broken: number, firstDay: boolean): number {
    if (broken <= 0) return 0;
    return Math.max(1, Math.round(broken * (firstDay ? FIRST_DAY_SHARE : DAILY_SHARE)));
}

/** Up to `count` tiles, nearest `from` first (all of them in scan order when `from` is null). */
export function pickRepairs(tiles: BrokenTile[], from: { x: number; y: number } | null, count: number): BrokenTile[] {
    const out = tiles.slice();
    if (from !== null) {
        out.sort(function (a, b): number {
            return (Math.abs(a.x - from.x) + Math.abs(a.y - from.y)) - (Math.abs(b.x - from.x) + Math.abs(b.y - from.y));
        });
    }
    return out.slice(0, Math.max(0, count));
}
