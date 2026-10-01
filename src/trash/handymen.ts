/**
 * Handyman hiring, firing, orders, patrol zones and activity tracking.
 *
 * Split out of trash-manager.ts (#6) with no behaviour change.
 */

import { createActivityTracker, ActivitySnapshot } from "../staff-activity";
import { createStaffHirer, HIRE_BACKOFF_DAYS } from "../staff-hiring";
import { HANDYMAN_ORDERS, getHandymen, TileCache } from "./shared";
import { DebugChannel } from "../debug";
import { blockRect, planZones, zoneDelta, ZoneBlock } from "../handyman-zones";
import { createOwnedStaff, OwnedStore, pickOwnedToFire } from "../staff-ownership";

export function createHandymen(dbg: DebugChannel, cache: TileCache, storage: OwnedStore) {

    // Handymen this plugin hired (#135). Only these are ever fired or have their
    // orders changed; the player's own handymen (say, hired to mow) are left alone.
    const owned = createOwnedStaff(storage, "ourHandymen");


    // Handymen whose patrol area we have already cleared. Re-issuing the action for
    // every handyman every in-game day cost N game actions per day and changed
    // nothing, so we only act on handymen we have not seen before.
    const zoneCleared: Record<number, true> = {};

    // Tracks whether each handyman's sweep/empty counters are advancing. Handymen
    // trapped in queue lines are the most-cited community complaint and the upstream
    // bugs are still open; see staff-activity.ts.
    const activity = createActivityTracker();
    let lastStuckReport = 0;

    // -------------------------------------------------------------------------
    // Staff management
    // -------------------------------------------------------------------------

    // Hire/fire and the entity-budget backoff are shared with the other staffing
    // plugins; see staff-hiring.ts.
    const hirer = createStaffHirer({
        staffType: 0, // 0 = handyman
        orders: HANDYMAN_ORDERS,
        noun: "handyman",
        plugin: "Trash Manager",
        counterPrefix: "handyman",
        backoffDays: HIRE_BACKOFF_DAYS,
        execute: (action, args, cb) => context.executeAction(action, args, cb),
        count: (name, n) => dbg.count(name, n),
    });

    /** True while a recent refusal says there is no room for more staff. */
    function hiringBlocked(): boolean {
        return hirer.blocked();
    }

    /** Hires one handyman with correct orders. Calls onHired(peepId) on success. */
    function hireHandyman(onHired: ((peepId: number) => void) | undefined): void {
        hirer.hire(function(peepId: number): void {
            owned.add(peepId);
            if (onHired) onHired(peepId);
        });
    }

    function liveIds(handymen: Handyman[]): number[] {
        const ids: number[] = [];
        for (let i = 0; i < handymen.length; i++) {
            const id = handymen[i].id;
            if (id !== null) ids.push(id);
        }
        return ids;
    }

    /**
     * Fires the newest handyman this plugin hired. Returns false when every handyman
     * left is the player's, so the caller can stop there rather than fire one of theirs.
     */
    function fireHandyman(handymen?: Handyman[]): boolean {
        const ids = liveIds(handymen !== undefined ? handymen : getHandymen());
        const pick = pickOwnedToFire(ids.reverse(), owned.prune(ids), 1);
        if (pick.fireIds.length === 0) {
            dbg.count("handymanFireSkippedPlayerStaff");
            return false;
        }
        hirer.fire(pick.fireIds[0]);
        owned.remove(pick.fireIds[0]);
        return true;
    }

    /**
     * Fixes a handyman whose orders include mowing or are missing sweep/bins tasks.
     * Direct property assignment is safe here because this only runs from interval.day.
     */
    function enforceHandymanOrders(h: Handyman): void {
        if (h.orders !== HANDYMAN_ORDERS) {
            h.orders = HANDYMAN_ORDERS;
        }
    }

    /** Daily: fixes orders on our own handymen only (#135). */
    function enforceOrders(handymen: Handyman[]): void {
        const mine = owned.prune(liveIds(handymen));
        handymen.forEach(function(h: Handyman): void {
            if (h.id !== null && mine[String(h.id)]) enforceHandymanOrders(h);
        });
    }

    /** The "fix orders" button: the player asked, so every handyman. */
    function enforceAllOrders(): void {
        getHandymen().forEach(enforceHandymanOrders);
    }

    // -------------------------------------------------------------------------
    // Patrol zone assignment
    // -------------------------------------------------------------------------

    /**
     * True if this peep id still resolves to a live entity.
     *
     * Issuing a staff game action for a fired peep fails with
     * "Invalid parameter / Staff not found" (StaffSetPatrolAreaAction.cpp:69) and
     * pops an error toast in the player's face. Zone work is rare now, so one lookup
     * per action is a cheap way to make that impossible.
     */
    function staffExists(peepId: number): boolean {
        return map.getEntity(peepId) !== null;
    }

    /**
     * Clears a handyman's patrol area so they roam the whole park path network.
     *
     * This replaces the previous approach of setting every handyman a rectangle
     * covering the path bounding box. That rectangle already spanned essentially the
     * whole park, so it was behaviourally equivalent to having no patrol area — but
     * it was enormously more expensive. Profiling showed 440ms in a single day
     * handler for 29 handymen, because:
     *
     *   - StaffSetPatrolAreaAction walks every tile in the rectangle to validate it,
     *     in both the query and the execute pass; and
     *   - it then calls UpdateConsolidatedPatrolAreas() (PatrolArea.cpp:140), which
     *     re-unifies the full patrol bitmap of *every* staff member, on *every*
     *     action. With N handymen each holding a park-sized area that is O(N^2 * area)
     *     work per bulk reassignment.
     *
     * The clearAll branch does no per-tile loop, and staff with no patrol area are
     * skipped by the consolidation pass entirely. It also keeps the save file smaller
     * and lets handymen reach paths built outside the old bounds.
     */
    // Set while the manual button is driving, so the log can tell a user-triggered
    // bulk clear apart from the daily delta sync.
    let manualClear = false;

    function clearHandymanZone(peepId: number): void {
        if (!staffExists(peepId)) {
            dbg.count("zoneSkippedDeadPeep");
            return;
        }
        // Fired this tick but not removed yet under a server (#136).
        if (hirer.firePending(peepId)) {
            dbg.count("zoneSkippedFirePending");
            return;
        }
        dbg.count(manualClear ? "patrolActionsManual" : "patrolActionsDaily");
        context.executeAction("staffsetpatrolarea", {
            id: peepId, x1: 0, y1: 0, x2: 0, y2: 0, mode: 2,
        });
        zoneCleared[peepId] = true;
    }

    /** Clears every handyman's patrol area (the manual button). */
    function clearAllZones(handymen?: Handyman[]): void {
        const staff = handymen !== undefined ? handymen : getHandymen();
        // The zones are gone with the areas; forget them so the next plan sets them again.
        zonePlanSig = "";
        for (const id in zoneApplied) zoneApplied[id] = [];
        manualClear = true;
        staff.forEach(function(h: Handyman): void {
            if (h.id !== null) clearHandymanZone(h.id);
        });
        manualClear = false;
    }

    /**
     * Daily zone upkeep: clear the patrol area of any handyman we haven't handled yet.
     * On a steady-state park this issues zero game actions per day.
     */
    function syncZones(handymen: Handyman[]): void {
        if (handymen.length === 0) return;

        const live: Record<number, true> = {};
        handymen.forEach(function(h: Handyman): void {
            if (h.id === null) return;
            live[h.id] = true;
            if (!zoneCleared[h.id]) clearHandymanZone(h.id);
        });

        // Drop bookkeeping for fired handymen so the map can't grow without bound
        // across a long game (peep ids are recycled, so stale entries are also wrong).
        for (const id in zoneCleared) {
            if (!live[id as unknown as number]) delete zoneCleared[id];
        }
    }

    // -------------------------------------------------------------------------
    // 4x4-block zones (#65, setting "Handyman zones", off by default)
    // -------------------------------------------------------------------------

    // Game actions per day for zone work. A 4x4 block costs 0.05-0.15 ms (headless probe,
    // #65), so a full re-plan of a big park spreads over a few days instead of one spike.
    const ZONE_ACTIONS_PER_DAY = 80;

    interface ZoneOp { id: number; key: string | null; mode: 0 | 1 | 2 }
    let zoneOps: ZoneOp[] = [];
    // handyman id -> blocks currently set, as far as we know. Never read back from the game.
    const zoneApplied: Record<number, string[]> = {};
    let zonePlanSig = "";
    let zoneStats = { actions: 0, blocksSet: 0, plans: 0 };

    function zoneSig(ids: number[], blocks: ZoneBlock[]): string {
        let sum = 0;
        for (const b of blocks) sum = (sum + b.bx * 31 + b.by * 17 + b.tiles * 7 + b.bx * b.by) % 1000003;
        return ids.join(",") + "|" + blocks.length + "|" + sum;
    }

    /**
     * Plans zones for the handymen we hired and queues the changes. Cheap when nothing has
     * changed (a signature compare); the plan itself is a few hundred blocks.
     */
    function planHandymanZones(handymen: Handyman[], blocks: ZoneBlock[]): void {
        // Every handyman, as with the roaming clear above (syncZones already takes every
        // handyman's patrol area), not only the ones we hired.
        const ids: number[] = [];
        handymen.forEach(function(h: Handyman): void {
            if (h.id !== null && !hirer.firePending(h.id)) ids.push(h.id);
        });
        ids.sort(function(a, b): number { return a - b; });
        for (const id in zoneApplied) {
            if (ids.indexOf(Number(id)) < 0) delete zoneApplied[id];
        }
        const sig = zoneSig(ids, blocks);
        if (sig === zonePlanSig) return;
        zonePlanSig = sig;
        zoneStats.plans++;

        const plan = planZones(blocks, ids);
        const ops: ZoneOp[] = [];
        ids.forEach(function(id: number): void {
            const wanted = plan.zones[id];
            if (wanted === undefined) {
                if (zoneApplied[id] !== undefined && zoneApplied[id].length > 0) ops.push({ id: id, key: null, mode: 2 });
                zoneApplied[id] = [];
                return;
            }
            const d = zoneDelta(zoneApplied[id], wanted);
            d.remove.forEach(function(k: string): void { ops.push({ id: id, key: k, mode: 1 }); });
            d.add.forEach(function(k: string): void { ops.push({ id: id, key: k, mode: 0 }); });
            zoneApplied[id] = wanted;
        });
        zoneOps = ops;
        dbg.count("zonePlans");
    }

    /** Switched off: hand every zoned handyman back to roaming. */
    function releaseHandymanZones(): void {
        zonePlanSig = "";
        const ops: ZoneOp[] = [];
        for (const id in zoneApplied) {
            if (zoneApplied[id].length > 0) ops.push({ id: Number(id), key: null, mode: 2 });
            delete zoneApplied[id];
        }
        zoneOps = ops;
    }

    /** Runs up to ZONE_ACTIONS_PER_DAY queued zone actions. */
    function drainZoneOps(): void {
        let n = 0;
        while (zoneOps.length > 0 && n < ZONE_ACTIONS_PER_DAY) {
            const op = zoneOps.shift() as ZoneOp;
            if (!staffExists(op.id) || hirer.firePending(op.id)) {
                dbg.count("zoneSkippedDeadPeep");
                continue;
            }
            const r = op.key === null ? { x1: 0, y1: 0, x2: 0, y2: 0 } : blockRect(op.key);
            context.executeAction("staffsetpatrolarea", { id: op.id, x1: r.x1, y1: r.y1, x2: r.x2, y2: r.y2, mode: op.mode });
            n++;
            if (op.mode === 0) zoneStats.blocksSet++;
        }
        if (n > 0) {
            zoneStats.actions += n;
            dbg.count("zoneActions", n);
            dbg.count("zoneActionsLeft", zoneOps.length);
        }
    }

    /**
     * Daily zone upkeep with the setting on: plan, then drain.
     */
    function syncHandymanZones(on: boolean, handymen: Handyman[], blocks: ZoneBlock[]): void {
        if (on) planHandymanZones(handymen, blocks);
        else if (Object.keys(zoneApplied).length > 0) releaseHandymanZones();
        drainZoneOps();
        // Totals for the headless harness (#65); the daily row reads them back.
        if (zoneStats.actions > 0 || zoneStats.plans > 0) storage.set("zoneStats", zoneStats);
    }

    /**
     * Watches whether handymen are actually sweeping.
     *
     * A handyman who sweeps nothing for days *while old litter exists* is usually
     * stuck - the classic case is oscillating in a queue line toward litter on an
     * adjacent path they cannot reach. Hiring more handymen does not fix that, so it
     * is worth telling the player rather than silently raising headcount.
     */
    function checkActivity(handymen: Handyman[]): ActivitySnapshot {
        for (let i = 0; i < handymen.length; i++) {
            const h = handymen[i];
            if (h.id === null) continue;
            activity.observe(h.id, h.litterSwept + h.binsEmptied);
        }
        const snap = activity.endSweep(cache.oldLitter > 0);
        dbg.count("handymanWorkDone", snap.workDone);
        if (snap.fleetUnderworked) dbg.count("fleetUnderworked");

        if (snap.stuck.length === 0) {
            lastStuckReport = 0;
            return snap;
        }
        dbg.count("handymenStuck", snap.stuck.length);
        if (snap.stuck.length !== lastStuckReport) {
            lastStuckReport = snap.stuck.length;
            console.log("[Trash Manager] " + snap.stuck.length + " of " + snap.tracked +
                " handymen have swept nothing at all while " + snap.active +
                " of their peers are working - peep id(s): " + snap.stuck.join(", ") +
                ". Likely stuck (queue-line pathfinding bug) rather than understaffed.");
        }
        return snap;
    }

    return {
        hiringBlocked,
        hireHandyman,
        fireHandyman,
        enforceOrders,
        enforceAllOrders,
        clearHandymanZone,
        clearAllZones,
        syncZones,
        syncHandymanZones,
        checkActivity,
    };
}
