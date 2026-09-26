/**
 * Queue TVs on long queues (#104). Which tiles is decided in queue-tv.ts (tested); this
 * file traces each long queue on the map and places the TVs like bins and benches.
 */

import { DebugChannel } from "../debug";
import { BuilderSettings } from "./settings";
import { spendGate } from "../cash-gate";
import { pickTvTiles, edgeCount, DEFAULT_QUEUE_TV_OPTIONS, QueueTile } from "../queue-tv";
import { DIR_DX, DIR_DY } from "./stall-build";

const OPTIONS = DEFAULT_QUEUE_TV_OPTIONS;

/** Same floor as the other builds; a TV costs far less than a stall. */
const MIN_CASH = 2_000 * 10;

/** Longest queue the trace follows, so a looping queue cannot run away. */
const MAX_TRACE = 200;

interface TracedTile extends QueueTile {
    z: number;
}

export function createQueueTvManager(settings: BuilderSettings, dbg: DebugChannel) {
    // The loaded object list does not change during a park session. undefined = not
    // looked up yet; -1 = none loaded.
    let tvObject: number | undefined = undefined;
    let placedTotal = 0;

    function isOn(): boolean {
        return settings.autoQueueTvs.get();
    }

    /**
     * The queue TV path addition (`rct2.footpath_item.qtv1`, park/Legacy.cpp:607), or -1.
     * Its `isQueueScreen` flag is not in the plugin API, so it is found by identifier
     * the way amenities.ts finds bins and benches; a custom TV object won't match.
     */
    function findTvObject(): number {
        if (tvObject !== undefined) return tvObject;
        tvObject = -1;
        const additions = objectManager.getAllObjects("footpath_addition");
        for (let i = 0; i < additions.length; i++) {
            if (additions[i].identifier.toLowerCase().indexOf("qtv") !== -1) {
                tvObject = additions[i].index;
                break;
            }
        }
        return tvObject;
    }

    /** The queue path element of `rideId` on this tile, or null. */
    function queueElement(x: number, y: number, rideId: number): FootpathElement | null {
        if (x < 1 || y < 1 || x >= map.size.x - 1 || y >= map.size.y - 1) return null;
        const tile = map.getTile(x, y);
        for (let i = 0; i < tile.numElements; i++) {
            const el = tile.getElement(i);
            if (el.type !== "footpath") continue;
            const fp = el as FootpathElement;
            if (fp.isQueue && fp.ride === rideId) return fp;
        }
        return null;
    }

    /**
     * The ride's queue tiles in walking order from the entrance (front first): the
     * queue tiles next to each station entrance, then breadth-first along connected
     * queue tiles belonging to the same ride.
     */
    function traceQueue(ride: Ride): TracedTile[] {
        const out: TracedTile[] = [];
        const seen: Record<string, true> = {};
        const frontier: Array<{ x: number; y: number }> = [];
        for (let s = 0; s < ride.stations.length; s++) {
            const e = ride.stations[s].entrance;
            if (!e || e.x < 0 || e.y < 0) continue;
            const ex = e.x >> 5, ey = e.y >> 5;
            for (let d = 0; d < 4; d++) frontier.push({ x: ex + DIR_DX[d], y: ey + DIR_DY[d] });
        }
        for (let head = 0; head < frontier.length && out.length < MAX_TRACE; head++) {
            const t = frontier[head];
            const key = t.x + "," + t.y;
            if (seen[key]) continue;
            seen[key] = true;
            const fp = queueElement(t.x, t.y, ride.id);
            if (fp === null) continue;
            out.push({
                x: t.x, y: t.y, z: fp.baseZ,
                edgeCount: edgeCount(fp.edges),
                hasAddition: fp.addition !== null,
                hasTv: fp.addition !== null && fp.addition === tvObject,
            });
            for (let d = 0; d < 4; d++) {
                if ((fp.edges & (1 << d)) === 0) continue;
                frontier.push({ x: t.x + DIR_DX[d], y: t.y + DIR_DY[d] });
            }
        }
        return out;
    }

    function worstQueueMinutes(ride: Ride): number {
        let worst = 0;
        for (let s = 0; s < ride.stations.length; s++) {
            if (ride.stations[s].queueTime > worst) worst = ride.stations[s].queueTime;
        }
        return worst;
    }

    function place(tile: TracedTile, obj: number, rideName: string): void {
        const args = { x: tile.x * 32, y: tile.y * 32, z: tile.z, object: obj };
        // Query first: a refusal is then silent instead of an error window.
        context.queryAction("footpathadditionplace", args, function (q: GameActionResult): void {
            if (q.error && q.error !== 0) {
                dbg.count("queueTvRefused");
                return;
            }
            context.executeAction("footpathadditionplace", args, function (r: GameActionResult): void {
                if (r.error && r.error !== 0) {
                    dbg.count("queueTvFailed");
                    return;
                }
                placedTotal++;
                dbg.count("queueTvPlaced");
                console.log("[Auto-Builder] Placed a queue TV on " + rideName + "'s queue at ("
                    + tile.x + ", " + tile.y + ").");
            });
        });
    }

    /** Places up to `maxPerDay` TVs on the longest queues. Never removes anything. */
    function manage(): void {
        if (!isOn()) return;
        const obj = findTvObject();
        if (obj < 0) {
            dbg.count("queueTvNoObject");
            return;
        }
        if (!park.research.isObjectResearched("footpath_addition", obj)) {
            dbg.count("queueTvNotResearched");
            return;
        }
        const gate = spendGate(park.cash, MIN_CASH, park.getFlag("noMoney"), "build");
        if (gate === "lowCash") {
            dbg.count("queueTvSkippedLowCash");
            return;
        }

        const long: Array<{ ride: Ride; minutes: number }> = [];
        const rides = map.rides;
        for (let i = 0; i < rides.length; i++) {
            if (rides[i].classification !== "ride") continue;
            const minutes = worstQueueMinutes(rides[i]);
            if (minutes >= OPTIONS.minQueueMinutes) long.push({ ride: rides[i], minutes: minutes });
        }
        long.sort(function (a, b): number { return b.minutes - a.minutes; });

        let budget = OPTIONS.maxPerDay;
        for (let i = 0; i < long.length && budget > 0; i++) {
            const trace = traceQueue(long[i].ride);
            const picks = pickTvTiles(trace, OPTIONS, budget);
            for (let p = 0; p < picks.length; p++) place(trace[picks[p]], obj, long[i].ride.name);
            budget -= picks.length;
        }
    }

    return { manage, isOn, placedCount(): number { return placedTotal; } };
}
