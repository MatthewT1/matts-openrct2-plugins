/**
 * Auto-Builder — OpenRCT2 plugin (#84)
 *
 * Builds what guests need, split out of Trash Manager so that plugin is only about
 * litter and handymen:
 *
 *   - benches and bins where guests vomit, near nauseating ride exits and stalls, and
 *     across the path network (and removes ones it placed that are no longer needed);
 *   - toilets, first aid and food/drink stalls where sampled guest needs go unmet;
 *   - cheap "just in case" buildings (info kiosks, an umbrella stall) at the park front,
 *     back and where guests get lost (#81, #105);
 *   - TVs on long queues (#104).
 *
 * The settings used to live in Trash Manager's park storage; they are moved across on
 * load (see migrateKeys), so a save keeps whatever the player had chosen.
 */

import { createDebugChannel } from "./debug";
import { migrateKeys } from "./settings";
import { createMapScan } from "./trash/map-scan";
import { createBuilderSettings, MIGRATED_KEYS } from "./builder/settings";
import { createAmenityManager } from "./builder/amenities";
import { createFacilityManager } from "./builder/facilities";
import { createStallBuilder } from "./builder/stall-build";
import { createCheapBuilder } from "./builder/cheap-builds";
import { createQueueTvManager } from "./builder/queue-tvs";
import { createBuilderWindow } from "./builder/window";

registerPlugin({
    name: "Auto-Builder",
    version: __PLUGIN_VERSION__,
    authors: ["MattT"],
    type: "local",
    licence: "MIT",
    targetApiVersion: 87,
    main: autoBuilderMain,
});

function autoBuilderMain(): void {
    const storage: Configuration = context.getParkStorage(); // per-save-file settings

    const moved = migrateKeys(context.getParkStorage("Trash Manager"), storage, MIGRATED_KEYS);
    if (moved.length > 0) {
        console.log("[Auto-Builder] Carried over from Trash Manager: " + moved.join(", ") + ".");
    }

    const dbg = createDebugChannel("auto-builder");
    const settings = createBuilderSettings(storage);

    // Our own litter/tile scan: the vomit clusters and path coverage tiles the bench/bin
    // planner works from. Trash Manager keeps its own for staffing.
    const scan = createMapScan(dbg);
    const { reportVomit, manageAmenities } = createAmenityManager(storage, settings, dbg, scan);
    const stalls = createStallBuilder(dbg);
    const cheap = createCheapBuilder(settings, dbg, stalls);
    const facilities = createFacilityManager(settings, dbg, stalls, cheap.listener);
    const queueTvs = createQueueTvManager(settings, dbg);
    const { sampleGuestNeeds, manageFacilities, facilityTracker } = facilities;

    function placedCount(): number {
        const raw = storage.get<Record<string, string>>("placedAmenities");
        return raw !== undefined && raw !== null ? Object.keys(raw).length : 0;
    }

    /** Park state emitted alongside timings. */
    function parkContext(): Record<string, unknown> {
        return {
            autoAmenities: settings.autoAmenities.get(),
            amenityRemoval: settings.amenityRemoval.get(),
            autoFacilities: settings.autoFacilities.get(),
            autoCheapBuilds: settings.autoCheapBuilds.get(),
            cheapBuilds: cheap.status(),
            autoQueueTvs: settings.autoQueueTvs.get(),
            placedAmenities: placedCount(),
            coverageTiles: scan.getCoverageTiles().length,
            vomit: scan.cache.vomit,
            needs: facilities.getLastNeedCounts(),
            problems: facilities.getLastProblems().map(function (t): Record<string, unknown> {
                return { category: t.category, count: t.count, topType: t.topType };
            }),
            facilities: facilities.getFacilityCounts(),
            facilityConfirmed: facilities.getLastFacilityPlans(),
            facilityPending: facilityTracker.pending().slice(0, 4).map(function (g): Record<string, unknown> {
                return { kind: g.kind, x: g.x, y: g.y, guests: g.guests, distance: g.distance, sweeps: g.sweeps };
            }),
            needGaps: facilities.getLastNeedGaps().slice(0, 4).map(function (g): Record<string, unknown> {
                return {
                    kind: g.cluster.kind,
                    x: g.cluster.x,
                    y: g.cluster.y,
                    guests: g.cluster.count,
                    distance: g.distance,
                    nearest: g.nearest !== null ? g.nearest.name : null,
                };
            }),
        };
    }

    context.subscribe("interval.day", function(): void {
        dbg.time("day.tileCache", scan.updateTileCache); // no-op until its cooldown elapses
        // Empty roster: this scan only needs litter; Trash Manager counts handymen.
        dbg.time("day.entityCache", function(): void { scan.updateEntityCache([]); });
        reportVomit();
        dbg.time("day.amenities", manageAmenities);
        dbg.time("day.needSample", sampleGuestNeeds);
        dbg.time("day.facilities", manageFacilities);
        dbg.time("day.cheapBuilds", cheap.manage);
        dbg.time("day.queueTvs", queueTvs.manage);
        dbg.flushStats(parkContext());
    });

    scan.updateCache();

    if (typeof ui === "undefined") return; // headless / dedicated server

    const { openWindow } = createBuilderWindow({
        settings,
        placedCount,
        facilityCounts: facilities.getFacilityCounts,
        queueTvCount: queueTvs.placedCount,
    });

    ui.registerMenuItem("Auto-Builder", openWindow);
}
