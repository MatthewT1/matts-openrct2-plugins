/**
 * Building a one-tile shop or facility beside a footpath: finding sites, choosing an
 * unlocked object, and the ridecreate -> trackplace -> open chain.
 *
 * Moved out of builder/facilities.ts unchanged (#81) so the cheap builds (kiosks, ATMs,
 * umbrella stall) use the same, already-proven mechanism as food stalls and toilets.
 * Counter names take the caller's prefix, so the facility counters keep their names.
 */

import { DebugChannel } from "../debug";
import { pickFacilityVariant, FacilitySite } from "../facilities";

/**
 * Every shop and facility in the game starts with the same 1x1 flat track piece
 * (`StartTrackPiece = TrackElemType::flatTrack1x1A` in every ride/rtd/shops/*.h),
 * whose id is 262 (ted/TrackElemType.h:282). That is what makes a stall placeable
 * with a single trackplace and no entrance or exit.
 */
const STALL_TRACK_TYPE = 262;

/** Tile deltas for direction 0-3, from world/Map.cpp:71 `TileDirectionDelta`. */
export const DIR_DX = [-1, 0, 1, 0];
export const DIR_DY = [0, 1, 0, -1];

export type StallBuilder = ReturnType<typeof createStallBuilder>;

export function createStallBuilder(dbg: DebugChannel) {

    /**
     * Base height of a WALKABLE footpath at this tile, or -1. Queue lines do not count.
     *
     * A facility is only reachable from a path guests can leave. Someone standing in a
     * queue cannot step out to buy a burger, so a stall built against a queue line is
     * both useless and an eyesore — which is exactly what shipped: the first facility
     * this plugin ever placed went up beside a coaster queue.
     *
     * The amenity planner has always excluded queues (`isQueue` on its site records);
     * facility siting reused the general `pathBaseZ` and inherited none of that.
     */
    function walkablePathBaseZ(tileX: number, tileY: number): number {
        const tile = map.getTile(tileX, tileY);
        for (let i = 0; i < tile.numElements; i++) {
            const el = tile.getElement(i);
            if (el.type !== "footpath") continue;
            const fp = el as FootpathElement;
            if (fp.isQueue) {
                dbg.count("siteRejectQueuePath");
                continue;
            }
            // A sloped (ramp) path segment has no flat edge for a shop counter to face -
            // the railing geometry on the high/low sides blocks guest interaction there,
            // even though the tile is a perfectly valid footpath to walk along. Measured
            // in-game: a stall sited against a ramp segment placed successfully but
            // guests could never reach it - the same "can only be placed on path edges"
            // shape of rejection FootpathAdditionPlaceAction already enforces for bins
            // and benches, just not previously applied here.
            if (fp.slopeDirection !== null) {
                dbg.count("siteRejectSlopedPath");
                continue;
            }
            return el.baseZ;
        }
        return -1;
    }

    /**
     * How many of each object index is built for a given ride type, read live from `map.rides`.
     *
     * Not persisted: a ride's object never changes while it exists, and a demolished
     * one should stop counting toward variety immediately, so deriving this fresh from
     * the current ride list is both simpler and correct without any of the stale-id
     * bookkeeping the staff roster needed.
     */
    function builtObjectCounts(rideType: number): Record<number, number> {
        const counts: Record<number, number> = {};
        const rides = map.rides;
        for (let i = 0; i < rides.length; i++) {
            if (rides[i].type !== rideType) continue;
            const index = rides[i].object.index;
            counts[index] = (counts[index] || 0) + 1;
        }
        return counts;
    }

    /**
     * An unlocked ride object index that can be built as `rideType`, or -1. `accept`,
     * when given, narrows the choice (e.g. only the shop that sells umbrellas).
     *
     * Research matters: building an object the player has not invented yet would hand
     * them something the scenario deliberately withheld. `inventedItems` is the
     * authoritative list, so it is consulted first. Sandbox and some pre-built
     * scenarios carry no research state at all, which is why the fallback exists - but
     * the fallback is only reached when there is no research state to respect.
     *
     * Among several unlocked objects of the same ride type (e.g. Burger Bar, Pizza
     * Stall and Fried Chicken Stall are all RIDE_TYPE_FOOD_STALL), picks the one with
     * the fewest already built, ties in research order (pickFacilityVariant). Unbuilt
     * variants come first, which helps the Best Food award (unique items,
     * Award.cpp:300-343); after that, new stalls keep cycling instead of repeating the
     * first variant (#102).
     */
    function unlockedObject(rideType: number, accept?: (objectIndex: number) => boolean): number {
        const invented = park.research.inventedItems;
        const counts = builtObjectCounts(rideType);
        const candidates: number[] = [];
        for (let i = 0; i < invented.length; i++) {
            const item = invented[i];
            if (item.type !== "ride") continue;
            if (item.rideType !== rideType) continue;
            if (accept !== undefined && !accept(item.object)) continue;
            candidates.push(item.object);
        }
        if (candidates.length > 0) return pickFacilityVariant(candidates, counts);

        // Research state exists but holds nothing of this type: it is genuinely locked.
        if (invented.length > 0 || park.research.uninventedItems.length > 0) return -1;

        const objects = objectManager.getAllObjects("ride");
        for (let i = 0; i < objects.length; i++) {
            const types = objects[i].rideType;
            for (let t = 0; t < types.length; t++) {
                if (types[t] === rideType) {
                    if (accept === undefined || accept(objects[i].index)) candidates.push(objects[i].index);
                    break;
                }
            }
        }
        return pickFacilityVariant(candidates, counts);
    }

    /**
     * Buildable tiles within `radius` of the given centres.
     *
     * A stall needs a tile of its own, adjacent to a footpath guests already walk on -
     * the opposite of the amenity scan, where the footpath tile IS the target. A tile
     * qualifies only when it holds nothing but flat, owned surface, because anything
     * else on it makes trackplace fail, and a failed trackplace after a successful
     * ridecreate leaves an orphan ride behind.
     *
     * Bounded by the centre list, which callers keep to a handful, so this never walks
     * the whole map.
     */
    function collectSites(centres: Array<{ x: number; y: number }>, radius: number): FacilitySite[] {
        const size = map.size;
        const seen: Record<string, true> = {};
        const sites: FacilitySite[] = [];

        for (let g = 0; g < centres.length; g++) {
            const c = centres[g];
            for (let x = c.x - radius; x <= c.x + radius; x++) {
                if (x < 1 || x >= size.x - 1) continue;
                for (let y = c.y - radius; y <= c.y + radius; y++) {
                    if (y < 1 || y >= size.y - 1) continue;
                    const key = x + "," + y;
                    if (seen[key]) continue;
                    seen[key] = true;

                    // Every rejection is counted. `facilityNoSite` fired 7 times in
                    // the measured session and there was no way to tell WHICH condition
                    // was doing the rejecting, so the fix had to be guessed at. These
                    // counters turn the next occurrence into a reading.
                    const tile = map.getTile(x, y);
                    if (tile.numElements !== 1) {              // anything else blocks the build
                        dbg.count("siteRejectOccupied");
                        continue;
                    }
                    const el = tile.getElement(0);
                    if (el.type !== "surface") {
                        dbg.count("siteRejectNotSurface");
                        continue;
                    }
                    const surface = el as SurfaceElement;
                    // Slope is a PREFERENCE, not a filter. Measured 2026-09-20:
                    // `siteRejectSloped` fired 6,013 times against `siteAccepted` of
                    // ZERO across a whole session, so on a hilly park this single check
                    // was the entire reason nothing could ever be built. There is no
                    // general flat-ground rule in `TrackPlaceAction` — the only slope
                    // test guards water rides — so the honest verdict comes from the
                    // `queryAction` that precedes every placement, not from a guess here.
                    const isFlat = surface.slope === 0;
                    dbg.count(isFlat ? "siteFlat" : "siteSloped");
                    if (!surface.hasOwnership) {
                        dbg.count("siteRejectUnowned");
                        continue;
                    }

                    // Must touch a path, or guests can never reach it. The path's height
                    // is the height the stall is built at, so the two end up level.
                    let pathZ = -1;
                    let direction = -1;
                    for (let d = 0; d < 4; d++) {
                        const z = walkablePathBaseZ(x + DIR_DX[d], y + DIR_DY[d]);
                        if (z < 0) continue;
                        // The stall is built AT the path's height, so the only thing the
                        // ground has to do is not be in the way. A path at or above the
                        // surface is fine; one BELOW means this tile is a hill sitting
                        // over the path, and building into it would fail.
                        //
                        // The old test also required the path to be within one height
                        // step ABOVE the surface, which quietly assumed paths sit on the
                        // ground. On a park built as elevated wooden walkways they do
                        // not — the terrain runs far below — and measurement showed the
                        // cost exactly: of 1,615 tiles that passed every other check,
                        // 835 were unowned and the remaining 780 were rejected here.
                        // Not one site survived, all session, so nothing could be built
                        // however long a gap persisted (one had waited 17 sweeps at a
                        // 111-tile walk).
                        if (z < surface.baseZ) continue;
                        pathZ = z;
                        direction = d;
                        break;
                    }
                    if (direction < 0) {
                        dbg.count("siteRejectNoPath");
                        continue;
                    }

                    dbg.count("siteAccepted");
                    sites.push({ x: x, y: y, z: pathZ, direction: direction, flat: isFlat });
                }
            }
        }
        return sites;
    }

    /**
     * Removes a ride this plugin created moments ago but failed to place track for.
     *
     * This is the ONLY demolition anywhere in the project, and it is not an exception to
     * the "never remove what the player built" rule - the ride being removed is one that
     * existed for a few milliseconds, has no track, and was created by this call chain.
     * Leaving it would put a permanent blank entry in the player's ride list that only
     * they could clean up. The id is captured in the closure, so there is no path by
     * which this could be pointed at an established ride.
     */
    function discardOrphanRide(prefix: string, rideId: number): void {
        dbg.count(prefix + "OrphanDiscarded");
        context.executeAction("ridedemolish", { ride: rideId, modifyType: 0 }, function (): void { });
    }

    /**
     * Places the track piece, trying each rotation until the game accepts one.
     *
     * Which rotation a stall wants is not something the plugin API documents, and
     * guessing wrong wastes a whole build. `queryAction` is silent and raises no error
     * window, so rotations are probed exactly the way ops.ts probes an unreadable value
     * range: the computed guess first, then the rest. The winning rotation is counted,
     * so the convention can be read off telemetry rather than assumed.
     */
    function placeTrack(prefix: string, site: FacilitySite, rideId: number, rideType: number,
                        onPlaced: (rideId: number) => void): void {
        const order = [site.direction, 0, 1, 2, 3];
        let attempt = 0;

        function tryNext(): void {
            if (attempt >= order.length) {
                discardOrphanRide(prefix, rideId);
                return;
            }
            const direction = order[attempt];
            attempt++;

            const args = {
                x: site.x << 5, y: site.y << 5, z: site.z,
                direction: direction, ride: rideId, trackType: STALL_TRACK_TYPE,
                rideType: rideType, brakeSpeed: 0, colour: 0, seatRotation: 0,
                trackPlaceFlags: 0, isFromTrackDesign: false,
            };

            context.queryAction("trackplace", args, function (q: GameActionResult): void {
                if (q.error && q.error !== 0) {
                    tryNext();
                    return;
                }
                context.executeAction("trackplace", args, function (r: GameActionResult): void {
                    if (r.error && r.error !== 0) {
                        // Accepted on query then refused on execute: the world moved
                        // underneath us. Do not retry, just clean up.
                        dbg.count(prefix + "TrackFailed");
                        discardOrphanRide(prefix, rideId);
                        return;
                    }
                    dbg.count(prefix + "Placed");
                    dbg.count(prefix + "Direction" + direction);
                    // A stall that is built but closed serves nobody.
                    context.executeAction("ridesetstatus", { ride: rideId, status: 1 },
                        function (o: GameActionResult): void {
                            if (o.error && o.error !== 0) dbg.count(prefix + "OpenFailed");
                        });
                    onPlaced(rideId);
                });
            });
        }

        tryNext();
    }

    /**
     * Creates the ride entry, then hands off to track placement. `done` runs once the
     * create step has finished either way (callers use it to release their busy flag);
     * `onPlaced` runs only when the stall is standing and open.
     */
    function build(prefix: string, rideType: number, rideObject: number, site: FacilitySite,
                   done: () => void, onPlaced: (rideId: number) => void): void {
        const args = {
            rideType: rideType, rideObject: rideObject, entranceObject: 0,
            colour1: 0, colour2: 0, inspectionInterval: 0,
        };

        context.queryAction("ridecreate", args, function (q: GameActionResult): void {
            if (q.error && q.error !== 0) {
                dbg.count(prefix + "CreateRefused");
                done();
                return;
            }
            context.executeAction("ridecreate", args, function (r: RideCreateActionResult): void {
                done();
                if ((r.error && r.error !== 0) || r.ride === undefined) {
                    dbg.count(prefix + "CreateFailed");
                    return;
                }
                placeTrack(prefix, site, r.ride, rideType, onPlaced);
            });
        });
    }

    return { walkablePathBaseZ, unlockedObject, collectSites, build };
}
