/**
 * The Auto-Builder window (#84): the bins/benches and facility toggles that used to sit
 * in the Trash Manager window, plus a short status readout.
 */

import { diagnosticsCheckbox } from "../debug";
import { BuilderSettings } from "./settings";

export interface BuilderWindowDeps {
    settings: BuilderSettings;
    /** Benches/bins this plugin placed and may later remove. */
    placedCount(): number;
    /** Facilities in the park by kind, from the last facility pass. */
    facilityCounts(): Record<string, number>;
    /** Queue TVs placed since the park was loaded. */
    queueTvCount(): number;
}

export function createBuilderWindow(deps: BuilderWindowDeps) {
    const { settings, placedCount, facilityCounts, queueTvCount } = deps;

    let win: Window | null           = null;
    let refreshHandle: number | null = null;

    function openWindow(): void {
        if (win !== null) { win.bringToFront(); return; }

        win = ui.openWindow({
            classification: "auto-builder",
            title: "Auto-Builder v" + __PLUGIN_VERSION__,
            width: 300,
            height: 214,
            widgets: [
                { type: "groupbox", x: 6, y: 16, width: 288, height: 110, text: "Automation  (runs each in-game day)" },
                {
                    type: "checkbox", name: "chkAmenities",
                    x: 14, y: 30, width: 276, height: 14,
                    text: "Auto-place benches & bins where needed",
                    tooltip: "Each in-game day, place benches near nauseating ride exits and vomit hotspots, and bins near stalls. Benches stop guests vomiting (a seated guest sheds nausea); handymen only clean up afterwards. Costs money; on by default (#51).",
                    isChecked: settings.autoAmenities.get(),
                    onChange: function(v: boolean): void { settings.autoAmenities.set(v); },
                },
                {
                    type: "checkbox", name: "chkAmenityRemoval",
                    x: 26, y: 48, width: 264, height: 14,
                    text: "...and remove ones no longer needed",
                    tooltip: "Remove benches and bins that are no longer near any stall, nauseating ride exit or vomit hotspot. ONLY removes amenities this plugin placed itself - anything you placed is never touched.",
                    isChecked: settings.amenityRemoval.get(),
                    onChange: function(v: boolean): void { settings.amenityRemoval.set(v); },
                },
                {
                    type: "checkbox", name: "chkFacilities",
                    x: 14, y: 66, width: 276, height: 14,
                    text: "Auto-build toilets, first aid & food stalls",
                    tooltip: "Watches where guests actually go hungry, thirsty or need a toilet, and builds a facility there once the same gap has persisted across many samples. Costs real money and needs Diagnostics-quality sampling, which it turns on for itself. Never demolishes anything, caps how many of each kind it will build, and builds at most one at a time. On by default (#51).",
                    isChecked: settings.autoFacilities.get(),
                    onChange: function(v: boolean): void { settings.autoFacilities.set(v); },
                },
                {
                    type: "checkbox", name: "chkCheapBuilds",
                    x: 14, y: 84, width: 276, height: 14,
                    text: "Auto-build info kiosks & umbrella stall",
                    tooltip: "Once the park has 3 rides, builds an information kiosk near the park entrance, one at the far end of the paths, and one where guests say they are lost, unless one is already within 12 tiles. Also an umbrella stall at the entrance (and the back of a big park) for rainy days. Maps are priced at 50p so guests never refuse them. Cheap (about 250 each), at most 4 kiosks, never demolishes anything. On by default (#81, #105).",
                    isChecked: settings.autoCheapBuilds.get(),
                    onChange: function(v: boolean): void { settings.autoCheapBuilds.set(v); },
                },
                {
                    type: "checkbox", name: "chkQueueTvs",
                    x: 14, y: 102, width: 276, height: 14,
                    text: "Auto-place TVs on long queues",
                    tooltip: "On queues posting 5+ minutes, puts a queue TV on empty queue tiles from the front backwards, every 3rd tile, up to 4 per queue and 2 a day. Guests who have waited a long time lose happiness in the queue unless their own tile has a TV. Never replaces anything already on the path. Needs the TV researched. On by default (#104).",
                    isChecked: settings.autoQueueTvs.get(),
                    onChange: function(v: boolean): void { settings.autoQueueTvs.set(v); },
                },

                { type: "groupbox", x: 6, y: 132, width: 288, height: 58, text: "Status" },
                { type: "label", name: "lblPlaced",     x: 14, y: 146, width: 276, height: 14, text: "" },
                { type: "label", name: "lblFacilities", x: 14, y: 160, width: 276, height: 14, text: "" },
                { type: "label", name: "lblQueueTvs",   x: 14, y: 174, width: 276, height: 14, text: "" },
                diagnosticsCheckbox(14, 196, 276),
            ],
            onClose: function(): void {
                win = null;
                if (refreshHandle !== null) {
                    context.clearInterval(refreshHandle);
                    refreshHandle = null;
                }
            },
        });

        refreshWindow();
        refreshHandle = context.setInterval(refreshWindow, 3000);
    }

    function refreshWindow(): void {
        if (!win) return;
        win.findWidget<LabelWidget>("lblPlaced").text =
            "Benches/bins placed by this plugin: " + placedCount();
        const counts = facilityCounts();
        const parts: string[] = [];
        for (const kind in counts) parts.push(kind + " " + counts[kind]);
        win.findWidget<LabelWidget>("lblFacilities").text =
            "Facilities: " + (parts.length > 0 ? parts.join(", ") : "not counted yet");
        win.findWidget<LabelWidget>("lblQueueTvs").text =
            "Queue TVs placed since load: " + queueTvCount();
    }

    return {
        openWindow,
    };
}
