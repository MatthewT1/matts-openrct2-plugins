/**
 * Cheap "just in case" buildings at the park front, the back, and where the guests who
 * need them cluster (#81 info kiosks, #105 the umbrella stall; #82 ATMs were tried and held back). Placement rules are in cheap-builds.ts, where they are tested;
 * this file reads the map and issues the builds through the shared stall builder.
 */

import { DebugChannel } from "../debug";
import { BuilderSettings } from "./settings";
import { spendGate } from "../cash-gate";
import { createCooldown, TICKS_PER_DAY, BUILD_WATCHDOG_TICKS } from "../cooldown";
import {
    createSpotAccumulator, farthestPathTile, sidePathTiles, buildAnchors, uncoveredAnchors, pickSite, tileKey, buildQueue,
    DEFAULT_CHEAP_BUILD_OPTIONS, CheapBuildOptions, Tile, Anchor,
} from "../cheap-builds";
import { StallBuilder, DIR_DX, DIR_DY } from "./stall-build";
import { GuestThoughtListener } from "./facilities";

/** One kind of cheap building. */
interface CheapKind {
    key: string;
    label: string;
    rideType: number;
    /** Guest thoughts whose clusters get one of these. */
    thoughts: string[];
    /** Primary price to set once built, in tenths of a pound; undefined keeps the default. */
    price?: number;
    /** True when this kind is pointless in the current park. */
    skip?: () => boolean;
    /** Narrows which unlocked objects of the ride type count (e.g. the umbrella shop). */
    accept?: (objectIndex: number) => boolean;
    /** Also build at each side of the park (#81 east/west). */
    sides?: boolean;
    /** Overrides DEFAULT_CHEAP_BUILD_OPTIONS.maxPerKind. */
    maxPerKind?: number;
}

/** ShopItem::umbrella (ride/ShopItem.h:28). */
const SHOP_ITEM_UMBRELLA = 4;

const OPTIONS = DEFAULT_CHEAP_BUILD_OPTIONS;

/**
 * Kept well below the food-stall floor's headroom logic: these cost GBP 200-250
 * (`.BuildCosts` in ride/rtd/shops/InformationKiosk.h, CashMachine.h), so the same
 * GBP 2,000 floor as facilities still leaves several builds of room.
 */
const MIN_CASH = 2_000 * 10;

/** EntranceType::parkEntrance (EntranceElement.h); 0 and 1 are ride entrance/exit. */
const ENTRANCE_TYPE_PARK = 2;

const KINDS: CheapKind[] = [
    {
        // #81. A guest with a map searches 7 junctions ahead instead of 5, considers
        // every ride in the park, and looks at the map when lost (GuestPathfinding.cpp:37,
        // Guest.cpp:1778-1784, :3107).
        key: "kiosk",
        label: "information kiosk",
        rideType: 35, // RIDE_TYPE_INFORMATION_KIOSK (Ride.h:617)
        thoughts: ["lost", "cant_find"],
        // Maps skip the souvenir mood gate (Guest.cpp:1495) but a price above the map's
        // value (GBP 0.60-0.80 by weather, ShopItem.cpp:32) can still be refused as "too
        // much" (Guest.cpp:1517-1535). GBP 0.50 is under every value, so it never is,
        // and still earns more than the GBP 0.10 each map costs.
        price: 5,
        // #81: front, back, east and west (four at least), plus up to two where guests get lost.
        sides: true,
        maxPerKind: 6,
    },
    {
        // #105. In rain guests only ride sheltered rides unless they hold an umbrella
        // (Guest.cpp:2308-2322), and an umbrella bought in rain skips the souvenir price
        // check (:1441, :1495, :1522). No thought marks "wants an umbrella", so there is
        // no cluster anchor: the entrance, plus the back in a deep park.
        key: "umbrella",
        label: "umbrella stall",
        rideType: 32, // RIDE_TYPE_SHOP (Ride.h:614)
        thoughts: [],
        accept: function (objectIndex: number): boolean {
            const obj = objectManager.getObject("ride", objectIndex);
            return obj !== null && obj.shopItem === SHOP_ITEM_UMBRELLA;
        },
    },
];

export function createCheapBuilder(settings: BuilderSettings, dbg: DebugChannel, stalls: StallBuilder) {
    const spots: Record<string, ReturnType<typeof createSpotAccumulator>> = {};
    const lastClusters: Record<string, Tile[]> = {};
    const thoughtKind: Record<string, string> = {};
    for (let i = 0; i < KINDS.length; i++) {
        const k = KINDS[i];
        spots[k.key] = createSpotAccumulator(8); // same 8-tile grid as needs.ts
        lastClusters[k.key] = [];
        for (let t = 0; t < k.thoughts.length; t++) thoughtKind[k.thoughts[t]] = k.key;
    }

    // The front/back scan walks the whole map, so it is cached for a week of game time.
    // Paths and entrances change slowly, and a stale back only moves a building a bit.
    const scanCooldown = createCooldown(7 * TICKS_PER_DAY, 5_000);
    let fronts: Tile[] = [];
    let back: { x: number; y: number; steps: number } | null = null;
    let sides: Tile[] = [];

    let building = false;
    const buildWatchdog = createCooldown(BUILD_WATCHDOG_TICKS, 5_000);

    function optionsOf(kind: CheapKind): CheapBuildOptions {
        if (kind.maxPerKind === undefined) return OPTIONS;
        const o: CheapBuildOptions = {
            coverRadius: OPTIONS.coverRadius, minBackSteps: OPTIONS.minBackSteps,
            clusterMinGuests: OPTIONS.clusterMinGuests, maxPerKind: kind.maxPerKind,
            siteRadius: OPTIONS.siteRadius, minRides: OPTIONS.minRides,
        };
        return o;
    }

    /** Anchors of this kind with none of it nearby yet. */
    function uncoveredOf(kind: CheapKind, built: Tile[]): Anchor[] {
        const opts = optionsOf(kind);
        return uncoveredAnchors(
            buildAnchors(fronts, back, kind.sides === true ? sides : [], lastClusters[kind.key], opts), built, opts);
    }

    function isOn(): boolean {
        return settings.autoCheapBuilds.get();
    }

    const listener: GuestThoughtListener = {
        wantsSamples: isOn,
        thought(type: string, tileX: number, tileY: number): void {
            const key = thoughtKind[type];
            if (key !== undefined) spots[key].add(tileX, tileY);
        },
        sweepComplete(): void {
            for (const key in spots) {
                lastClusters[key] = spots[key].top(OPTIONS.clusterMinGuests, 2);
                spots[key].reset();
            }
        },
    };

    /** Walkable (non-queue) path tiles and their connections, plus park entrances. */
    function scanPaths(): void {
        const size = map.size;
        const edges: Record<number, number> = {};
        const entranceTiles: Tile[] = [];
        const centres: Tile[] = [];
        for (let x = 1; x < size.x - 1; x++) {
            for (let y = 1; y < size.y - 1; y++) {
                const tile = map.getTile(x, y);
                for (let i = 0; i < tile.numElements; i++) {
                    const el = tile.getElement(i);
                    if (el.type === "footpath") {
                        const fp = el as FootpathElement;
                        if (fp.isQueue) continue;
                        const k = tileKey(x, y);
                        edges[k] = (edges[k] || 0) | fp.edges;
                    } else if (el.type === "entrance" && (el as EntranceElement).object === ENTRANCE_TYPE_PARK) {
                        entranceTiles.push({ x: x, y: y });
                        if ((el as EntranceElement).sequence === 0) centres.push({ x: x, y: y });
                    }
                }
            }
        }

        // Footpath edge bit d connects towards direction d (TileDirectionDelta). A link
        // counts when either side has it, so one odd tile cannot split the graph.
        const graph: Record<number, number[]> = {};
        for (const key in edges) {
            const k = Number(key);
            const x = Math.floor(k / 4096);
            const y = k % 4096;
            const out: number[] = [];
            for (let d = 0; d < 4; d++) {
                const n = tileKey(x + DIR_DX[d], y + DIR_DY[d]);
                const ne = edges[n];
                if (ne === undefined) continue;
                if ((edges[k] & (1 << d)) !== 0 || (ne & (1 << ((d + 2) & 3))) !== 0) out.push(n);
            }
            graph[k] = out;
        }

        const starts: number[] = [];
        for (let i = 0; i < entranceTiles.length; i++) {
            for (let d = 0; d < 4; d++) {
                const n = tileKey(entranceTiles[i].x + DIR_DX[d], entranceTiles[i].y + DIR_DY[d]);
                if (graph[n] !== undefined) starts.push(n);
            }
        }
        fronts = centres;
        back = farthestPathTile(starts, graph);
        sides = back !== null && centres.length > 0
            ? sidePathTiles(starts, graph, centres[0], back, OPTIONS.coverRadius) : [];
        dbg.count("cheapScan");
    }

    /** Where this kind already stands (station tile), the player's own included. */
    function builtOf(rideType: number, accept?: (objectIndex: number) => boolean): Tile[] {
        const out: Tile[] = [];
        const rides = map.rides;
        for (let i = 0; i < rides.length; i++) {
            const r = rides[i];
            if (r.type !== rideType || r.stations.length === 0) continue;
            if (accept !== undefined && !accept(r.object.index)) continue;
            const s = r.stations[0].start;
            if (!s || s.x < 0 || s.y < 0) continue;
            out.push({ x: s.x >> 5, y: s.y >> 5 });
        }
        return out;
    }

    function realRideCount(): number {
        let n = 0;
        const rides = map.rides;
        for (let i = 0; i < rides.length; i++) {
            if (rides[i].classification === "ride") n++;
        }
        return n;
    }

    function setPrice(kind: CheapKind, rideId: number): void {
        if (kind.price === undefined || park.getFlag("noMoney")) return;
        context.executeAction("ridesetprice", { ride: rideId, price: kind.price, isPrimaryPrice: true },
            function (r: GameActionResult): void {
                if (r.error && r.error !== 0) dbg.count("cheapPriceFailed");
            });
    }

    /** Builds at most one cheap building a day: the first uncovered anchor with a site. */
    function manage(): void {
        if (!isOn()) return;
        if (building) {
            if (!buildWatchdog.ready(date.ticksElapsed, Date.now())) return;
            dbg.count("cheapBuildTimedOut");
            building = false;
        }
        if (realRideCount() < OPTIONS.minRides) {
            dbg.count("cheapTooFewRides");
            return;
        }
        const gate = spendGate(park.cash, MIN_CASH, park.getFlag("noMoney"), "build");
        if (gate === "lowCash") {
            dbg.count("cheapSkippedLowCash");
            return;
        }

        if (scanCooldown.ready(date.ticksElapsed, Date.now())) scanPaths();

        const perKind: Array<{ kind: CheapKind; anchors: Anchor[] }> = [];
        const objects: Record<string, number> = {};
        for (let i = 0; i < KINDS.length; i++) {
            const kind = KINDS[i];
            if (kind.skip !== undefined && kind.skip()) continue;
            const anchors = uncoveredOf(kind, builtOf(kind.rideType, kind.accept));
            if (anchors.length === 0) continue;
            const rideObject = stalls.unlockedObject(kind.rideType, kind.accept);
            if (rideObject < 0) {
                dbg.count("cheapNotUnlocked_" + kind.key);
                continue;
            }
            objects[kind.key] = rideObject;
            perKind.push({ kind: kind, anchors: anchors });
        }

        const queue = buildQueue(perKind);
        for (let q = 0; q < queue.length; q++) {
            const kind = queue[q].kind;
            const anchor = queue[q].anchor;
            const site = pickSite(anchor, stalls.collectSites([anchor], OPTIONS.siteRadius), OPTIONS);
            if (site === null) {
                dbg.count("cheapNoSite_" + anchor.role);
                continue;
            }
            building = true;
            buildWatchdog.reset();
            buildWatchdog.ready(date.ticksElapsed, Date.now());
            stalls.build("cheap", kind.rideType, objects[kind.key], site,
                function (): void { building = false; },
                function (rideId: number): void {
                    dbg.count("cheapPlaced_" + kind.key + "_" + anchor.role);
                    setPrice(kind, rideId);
                    console.log("[Auto-Builder] Built " + (/^[aeiou]/i.test(kind.label) ? "an " : "a ") + kind.label
                        + " at the park " + anchor.role + " (" + site.x + ", " + site.y + ").");
                });
            return;
        }
    }

    /** For the debug channel: what the last scan found and what each kind still lacks. */
    function status(): Record<string, unknown> {
        const out: Record<string, unknown> = {
            fronts: fronts.length,
            back: back === null ? null : { x: back.x, y: back.y, steps: back.steps },
            sides: sides.length,
        };
        for (let i = 0; i < KINDS.length; i++) {
            const k = KINDS[i];
            const built = builtOf(k.rideType, k.accept);
            out[k.key] = {
                built: built.length,
                clusters: lastClusters[k.key].length,
                uncovered: uncoveredOf(k, built).map(function (a): string { return a.role; }),
            };
        }
        return out;
    }

    return { listener, manage, isOn, status };
}
