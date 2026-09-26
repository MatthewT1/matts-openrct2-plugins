/**
 * Trash Manager v3 — OpenRCT2 plugin
 *
 * Manages park litter and handyman staffing based on source-code-verified mechanics:
 *
 *   LITTER PENALTY (from Park.cpp):
 *     - Only litter aged >= 7680 ticks (~3 min) counts toward the rating penalty.
 *     - Penalty = min(150, oldLitterCount) * 4 rating points (max -600).
 *     - Fresh litter has a grace period and does not yet hurt your rating.
 *
 *   HANDYMAN RATIOS:
 *     - Staffing is guest-driven (litter scales with visitors), with a path-tile
 *       floor so an empty park still gets a small recommendation. See
 *       computeNeededHandymen.
 *
 *   PATROL ZONES:
 *     - Handymen are given NO patrol area. OpenRCT2 dispatches the nearest handyman
 *       to each piece of litter, so a zone only blocks that. Setting a park-sized
 *       rectangle instead was measured at 440ms per bulk reassignment; see
 *       clearHandymanZone for why.
 *
 *   MOWING (critical):
 *     - Grass mowing (orders bit 8) must be disabled. When enabled, handymen
 *       abandon path sweeping to mow grass. RCT2 shipped with it off for this reason.
 *
 *   BROKEN BINS:
 *     - Vandalized bins don't collect litter. Litter -> disgust -> vandalism ->
 *       more broken bins is a cascade loop detectable via isAdditionBroken.
 */

import { createDebugChannel } from "./debug";
import { createStaffingController, StaffingDecision } from "./staffing";
import { createDeferredActions } from "./deferred";
import {
    LITTER_PENALTY_CAP, FREE_ROAMING_BUFFER, getHandymen, litterAge, isOldLitter,
    computeRatingPenalty, computeNeededHandymen, createTrashSettings,
} from "./trash/shared";
import { createMapScan } from "./trash/map-scan";
import { TILE_SCAN_TICKS } from "./cooldown";
import { createHandymen } from "./trash/handymen";
import { createTrashWindow } from "./trash/window";

registerPlugin({
    name: "Trash Manager",
    version: __PLUGIN_VERSION__,
    authors: ["MattT"],
    type: "local",
    licence: "MIT",
    targetApiVersion: 87,
    main: trashManagerMain,
});

function trashManagerMain(): void {
    const storage: Configuration = context.getParkStorage(); // per-save-file settings

    // Debug channel. Off unless the shared-storage debug flag is set; see debug.ts.
    const dbg = createDebugChannel("trash-manager");

    // The work is split by job into src/trash/ (#6). Each factory keeps its own state;
    // this function wires them together and owns the staffing decision and the hooks.
    const settings = createTrashSettings(storage);
    // #100: path tiles and bin counts change slowly; a 10-day scan keeps the split from
    // doubling the tile-walk cost (Auto-Builder keeps the 2.5-day one for placement).
    const scan = createMapScan(dbg, 4 * TILE_SCAN_TICKS);
    const {
        cache, hotspots, updateTileCache, updateEntityCache, updateCache, reportHotspots,
    } = scan;
    const {
        hiringBlocked, hireHandyman, fireHandyman, enforceOrders, clearHandymanZone, clearAllZones,
        syncZones, checkActivity,
    } = createHandymen(dbg, cache);
    // Bins/benches, facilities and guest-need sampling moved to the Auto-Builder plugin (#84).

    /** Returns the user-configured max handymen cap (stored per save file, default 20). */
    function getMaxHandymen(): number {
        const v = storage.get<number>("maxHandymen");
        return v !== undefined ? v : 20;
    }

    // Button actions that change game state run on the next tick; see deferred.ts.
    // entity.remove() and h.orders writes must not run from a UI onClick handler
    // (game state is not mutable in that context).
    const deferred = createDeferredActions(function(onTick: () => void): void {
        context.subscribe("interval.tick", onTick);
    });

    // Closed-loop staffing. The guest-driven formula is coverage-blind and hires
    // forever as a park grows; this probes downward while the park stays clean and
    // hires back the moment rating-costing litter appears. See staffing.ts.
    const staffing = createStaffingController(0);
    let staffingSeeded = false;
    let lastStaffingReason = "";
    let lastDecision: StaffingDecision | null = null;
    // Never drop below roughly one handyman per this many path tiles, however clean
    // things look. Coverage, not throughput, is the real constraint.
    const PATH_TILES_PER_HANDYMAN_FLOOR = 150;
    /**
     * A second, independent floor term keyed on guest count, not just map size.
     *
     * Measured 2026-09-20: on a park growing 621 -> 1955 guests, `staffingFloor()`
     * sat at exactly 4 the entire time (path tiles barely grew relative to guests),
     * providing no protection as the real litter/vomit driver tripled. The only
     * thing that could still force a hire was `oldLitter >= URGENT_OLD_LITTER`, a
     * rating-protection signal - and the existing 8-9 handymen worked hard enough
     * to keep litter from *ageing* past that threshold even while `litterAverage`
     * spiked to 23 and vomit visibly piled up faster than they could clear it in
     * real time. The controller correctly protected rating and incorrectly
     * concluded there was no problem.
     *
     * Deliberately gentler than `GUESTS_PER_HANDYMAN = 30` (the classic formula's
     * ceiling, already measured over-provisioned in this project's own field data)
     * - this is a FLOOR the adaptive loop cannot ratchet below, not a target it is
     * steered toward. Starting point only, not yet re-validated against a fresh
     * session; revisit if the park still looks messy at this ratio or the loop
     * over-hires against it.
     */
    const GUESTS_PER_HANDYMAN_FLOOR = 100;

    function isAdaptiveStaffing(): boolean {
        return settings.adaptiveStaffing.get();
    }

    function staffingFloor(): number {
        const tileFloor = Math.ceil(cache.pathTiles / PATH_TILES_PER_HANDYMAN_FLOOR);
        const guestFloor = Math.ceil(cache.guests / GUESTS_PER_HANDYMAN_FLOOR);
        return Math.max(tileFloor, guestFloor) + FREE_ROAMING_BUFFER;
    }

    /** Park state emitted alongside timings, so staffing formulas can be evaluated. */
    function parkContext(): Record<string, unknown> {
        const worst = cache.topHotspots.length > 0 ? cache.topHotspots[0] : null;
        return {
            parkRating:  park.rating,
            // Without these the litter counts are uninterpretable: a clean park under
            // auto-sweep says nothing about whether the handymen are keeping up.
            autoSweep:   settings.autoSweep.get(),
            autoHire:    settings.autoHire.get(),
            guests:      cache.guests,
            handymen:    cache.handymanCount,
            needed:      computeNeededHandymen(cache.pathTiles, cache.guests),
            adaptive:    isAdaptiveStaffing(),
            // Source-verified wage (Staff.cpp:2645): handymen are GBP 50/month. With park
            // rating usually pinned at its maximum, wages are the only lever the staffing
            // controller still moves, so the saving is worth making visible.
            handymanWagesPerMonth: cache.handymanCount * 50,
            formulaWagesPerMonth: computeNeededHandymen(cache.pathTiles, cache.guests) * 50,
            adaptiveTarget: staffing.target(),
            staffingFloor: staffingFloor(),
            discoveredFloor: lastDecision !== null ? lastDecision.discoveredFloor : 0,
            settling: lastDecision !== null ? lastDecision.settling : 0,
            litterAverage: lastDecision !== null ? lastDecision.litterAverage : 0,
            maxHandymen: getMaxHandymen(),
            pathTiles:   cache.pathTiles,
            ownedTiles:  cache.ownedTiles,
            totalLitter: cache.totalLitter,
            oldLitter:   cache.oldLitter,
            vomit:       cache.vomit,
            fullBins:    cache.fullBins,
            brokenBins:  cache.brokenBins,
            worstVomit: (function(): Record<string, unknown> | null {
                const v = cache.topHotspots.length > 0 ? hotspots.topVomit(1) : [];
                return v.length > 0 ? { x: v[0].x, y: v[0].y, vomit: v[0].vomit } : null;
            })(),
            worstHotspot: worst !== null
                ? { x: worst.x, y: worst.y, count: worst.count, oldCount: worst.oldCount }
                : null,
        };
    }

    // -------------------------------------------------------------------------
    // Interval hooks
    // -------------------------------------------------------------------------

    /**
     * Daily: update entity cache (cheap); tile cache is rate-limited internally.
     * Expensive tile scan runs at most once per ten in-game days (tileScanCooldown, #100).
     */
    context.subscribe("interval.day", function(): void {
        dbg.time("day.tileCache", updateTileCache); // no-op if cooldown hasn't elapsed

        // One staff scan and one litter scan for the whole day's work — every helper
        // below takes these arrays rather than re-running getAllEntities itself.
        const handymen = dbg.time("day.staffScan", getHandymen);
        dbg.time("day.entityCache", () => updateEntityCache(handymen));

        dbg.time("day.enforceOrders", () => enforceOrders(handymen));
        const snap = dbg.time("day.activity", () => checkActivity(handymen));
        reportHotspots();

        const autoHire  = settings.autoHire.get();
        const autoSweep = settings.autoSweep.get();

        if (autoSweep) {
            // Removed on the next tick, not now (#84): Auto-Builder places benches from the
            // day's vomit clusters in its own interval.day handler, and plugins run their
            // handlers in load order, so sweeping here could hide the vomit from it.
            requestDailySweep();
            cache.oldLitter = 0;
            cache.trash     = 0;
            cache.vomit     = 0;
            cache.totalLitter = 0;
        }

        // Set when we hire or fire below, meaning `handymen` no longer reflects reality.
        let rosterChanged = false;

        if (autoHire) {
            const formulaTarget = computeNeededHandymen(cache.pathTiles, cache.guests);
            let wanted = formulaTarget;

            if (isAdaptiveStaffing()) {
                if (!staffingSeeded) {
                    // Start from what the park already has rather than jumping straight
                    // to the formula, so enabling this never causes a mass hire or fire.
                    staffing.seed(handymen.length > 0 ? handymen.length : formulaTarget);
                    staffingSeeded = true;
                }
                const decision = staffing.update({
                    oldLitter:        cache.oldLitter,
                    totalLitter:      cache.totalLitter,
                    parkRating:       park.rating,
                    fleetUnderworked: snap.fleetUnderworked,
                    formulaTarget:    formulaTarget,
                    floor:            staffingFloor(),
                });
                dbg.count("staffingSettling", decision.settling > 0 ? 1 : 0);
                lastDecision = decision;
                wanted = decision.target;
                if (decision.reason !== "" && decision.reason !== lastStaffingReason) {
                    lastStaffingReason = decision.reason;
                    console.log("[Trash Manager] Adaptive staffing target now " +
                        decision.target + " (formula says " + formulaTarget + "): " +
                        decision.reason + ".");
                }
            }

            // The cap is the real target: if the player lowers "max handymen" below the
            // recommendation we must fire down to the cap. Comparing against `wanted`
            // here meant a lowered cap was silently ignored.
            const cap     = Math.min(wanted, getMaxHandymen());
            const deficit = cap - handymen.length;
            // A recent refusal says the park has no room for another entity. Retrying
            // daily would just put the game's error in front of the player again.
            if (deficit > 0 && !hiringBlocked()) {
                // Hire up to 3 per day so staffing recovers quickly after park expansions,
                // without flooding the park on initial load.
                const hireCount = Math.min(3, deficit);
                rosterChanged = true;
                for (let i = 0; i < hireCount; i++) {
                    hireHandyman(function(peepId: number): void {
                        clearHandymanZone(peepId);
                    });
                }
            } else if (handymen.length > cap + (isAdaptiveStaffing() ? 0 : 3)) {
                // The controller already has its own hysteresis, so when adaptive
                // staffing is on we converge straight to its target. The fixed formula
                // has none, hence the +3 dead band in that mode.
                fireHandyman(handymen);
                rosterChanged = true;
            }
        }

        // Keep patrol zones in step with newly built paths. This is a no-op on days
        // where the path bounds are unchanged and no handyman was hired.
        //
        // Re-read the roster if we just hired or fired: game actions execute
        // synchronously in single player, so `handymen` would otherwise still contain
        // a peep that no longer exists and syncZones would aim a patrol-area action at
        // a dead sprite id.
        dbg.time("day.syncZones", () => syncZones(rosterChanged ? getHandymen() : handymen));
        dbg.flushStats(parkContext());

        const penalty = computeRatingPenalty(cache.oldLitter);
        if (penalty >= 300) {
            console.log("[Trash Manager] Litter costing -" + penalty + " rating pts (" +
                cache.oldLitter + " old pieces; ceiling at " + LITTER_PENALTY_CAP + ").");
        }
        if (cache.brokenBins > 0) {
            console.log("[Trash Manager] " + cache.brokenBins +
                " broken path item(s) (benches/bins/lamps) detected — vandalism cascade risk.");
        }
    });

    /**
     * Per-tick: process deferred sweep requests from UI buttons.
     * entity.remove() is only safe in this context (game state is mutable here).
     */
    const requestDailySweep = deferred.define(function(): void {
        map.getAllEntities("litter").forEach(function(e: Litter): void { e.remove(); });
    });

    // enforceOrders writes directly to entity properties; must run on the tick, not in onClick.
    const requestFixOrders = deferred.define(function(): void { enforceOrders(); });

    // Sweep All and Sweep Old share one queued sweep. If both are pressed before the
    // tick, the full sweep wins: `oldOnly` stays true only if every request was "old".
    const requestSweep = deferred.defineWithArg(function(sweepOldOnly: boolean): void {
        let litter: Litter[] = map.getAllEntities("litter");

        if (sweepOldOnly) {
            // Keep only penalty-causing pieces; oldest-first so highest-damage
            // litter is removed first if there is ever a per-tick removal limit.
            litter = litter.filter(isOldLitter);
            // Sort oldest-first by *age*, not raw creationTick: creationTick is a uint32
            // that wraps, so subtracting raw ticks mis-orders litter across a wrap.
            litter.sort(function(a: Litter, b: Litter): number {
                return litterAge(b) - litterAge(a);
            });
        }

        litter.forEach(function(e: Litter): void { e.remove(); });

        if (sweepOldOnly) {
            cache.oldLitter = 0;
        } else {
            cache.oldLitter = 0;
            cache.trash     = 0;
            cache.vomit     = 0;
        }

        console.log("[Trash Manager] Swept " + litter.length +
            (sweepOldOnly ? " old (penalty-causing)" : "") + " litter items.");
    }, function(queued: boolean, next: boolean): boolean { return queued && next; });

    // -------------------------------------------------------------------------
    // UI
    // -------------------------------------------------------------------------

    // Populate cache immediately on load so the UI shows real values on first open,
    // not zeros. Without this, the cache stays empty until the first in-game day.
    updateCache();

    if (typeof ui === "undefined") return; // headless / dedicated server

    const { openWindow } = createTrashWindow({
        storage, settings, scan, staffing, hireHandyman, clearHandymanZone, clearAllZones, getMaxHandymen,
        isAdaptiveStaffing,
        resetStaffingSeed: function(): void { staffingSeeded = false; },
        requestSweepAll: function(): void { requestSweep(false); },
        requestSweepOld: function(): void { requestSweep(true); },
        requestFixOrders: requestFixOrders,
    });

    ui.registerMenuItem("Trash Manager", openWindow);
}
