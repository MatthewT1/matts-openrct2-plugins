/**
 * Handyman hiring, firing, orders, patrol zones and activity tracking.
 *
 * Split out of trash-manager.ts (#6) with no behaviour change.
 */

import { createActivityTracker, ActivitySnapshot } from "../staff-activity";
import { createStaffHirer, HIRE_BACKOFF_DAYS } from "../staff-hiring";
import { HANDYMAN_ORDERS, getHandymen, TileCache } from "./shared";
import { DebugChannel } from "../debug";

export function createHandymen(dbg: DebugChannel, cache: TileCache) {


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
        hirer.hire(onHired);
    }

    function fireHandyman(handymen?: Handyman[]): void {
        const h = handymen !== undefined ? handymen : getHandymen();
        if (h.length > 0) {
            const id = h[h.length - 1].id;
            if (id !== null) hirer.fire(id);
        }
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

    function enforceOrders(handymen?: Handyman[]): void {
        (handymen !== undefined ? handymen : getHandymen()).forEach(enforceHandymanOrders);
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
        dbg.count(manualClear ? "patrolActionsManual" : "patrolActionsDaily");
        context.executeAction("staffsetpatrolarea", {
            id: peepId, x1: 0, y1: 0, x2: 0, y2: 0, mode: 2,
        });
        zoneCleared[peepId] = true;
    }

    /** Clears every handyman's patrol area (the manual button). */
    function clearAllZones(handymen?: Handyman[]): void {
        const staff = handymen !== undefined ? handymen : getHandymen();
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
        clearHandymanZone,
        clearAllZones,
        syncZones,
        checkActivity,
    };
}
