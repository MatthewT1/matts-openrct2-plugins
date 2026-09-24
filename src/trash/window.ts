/**
 * The Trash Manager window.
 *
 * Split out of trash-manager.ts (#6) with no behaviour change.
 */

import { diagnosticsCheckbox } from "../debug";
import {
    LITTER_PENALTY_CAP, FREE_ROAMING_BUFFER, GUESTS_PER_HANDYMAN,
    PATH_TILES_PER_HANDYMAN, computeRatingPenalty, computeNeededHandymen, TrashSettings,
} from "./shared";
import { StaffingController } from "../staffing";
import { MapScan } from "./map-scan";

export interface TrashWindowDeps {
    storage: Configuration;
    settings: TrashSettings;
    scan: MapScan;
    staffing: StaffingController;
    hireHandyman(onHired: ((peepId: number) => void) | undefined): void;
    clearHandymanZone(peepId: number): void;
    clearAllZones(): void;
    getMaxHandymen(): number;
    isAdaptiveStaffing(): boolean;
    isAutoAmenities(): boolean;
    isAmenityRemoval(): boolean;
    isAutoFacilities(): boolean;
    /** Re-seed the adaptive controller from the live roster on the next day. */
    resetStaffingSeed(): void;
    requestSweepAll(): void;
    requestSweepOld(): void;
    requestFixOrders(): void;
}

export function createTrashWindow(deps: TrashWindowDeps) {
    const {
        storage, settings, scan, staffing, hireHandyman, clearHandymanZone, clearAllZones, getMaxHandymen,
        isAdaptiveStaffing, isAutoAmenities, isAmenityRemoval, isAutoFacilities,
        resetStaffingSeed, requestSweepAll, requestSweepOld, requestFixOrders,
    } = deps;
    const { cache, updateCache, forceTileScan } = scan;


    let win: Window | null           = null;
    let refreshHandle: number | null = null;

    function openWindow(): void {
        if (win !== null) { win.bringToFront(); return; }

        win = ui.openWindow({
            classification: "trash-manager",
            title: "Trash Manager v" + __PLUGIN_VERSION__,
            width: 300,
            height: 446,
            widgets: [
                // --- Rating Impact ---
                { type: "groupbox", x: 6, y: 16, width: 288, height: 66, text: "Rating Impact" },
                { type: "label", name: "lblRating", x: 14, y: 30, width: 276, height: 14, text: "Litter penalty: calculating..." },
                { type: "label", name: "lblThresh", x: 14, y: 46, width: 276, height: 14, text: "Severity: ----" },
                { type: "label", name: "lblLitter", x: 14, y: 62, width: 276, height: 14, text: "Total litter: --  (trash: --, vomit: --)" },

                // --- Staffing ---
                { type: "groupbox", x: 6, y: 88, width: 288, height: 66, text: "Staffing" },
                { type: "label", name: "lblHandymen", x: 14, y: 102, width: 276, height: 14, text: "Handymen: --  /  needed: --  /  max: --" },
                { type: "label", name: "lblBins",     x: 14, y: 118, width: 276, height: 14, text: "Bins: -- full, -- broken  (guests: --)" },
                { type: "label", name: "lblTiles",    x: 14, y: 134, width: 276, height: 14, text: "Path tiles: --  /  owned land: --" },

                // --- Automation ---
                { type: "groupbox", x: 6, y: 160, width: 288, height: 146, text: "Automation  (runs each in-game day)" },
                {
                    type: "checkbox", name: "chkAutoHire",
                    x: 14, y: 174, width: 276, height: 14,
                    text: "Auto-hire / fire handymen",
                    tooltip: "Targets 1 handyman per " + GUESTS_PER_HANDYMAN + " guests (or 1 per " + PATH_TILES_PER_HANDYMAN + " path tiles minimum) + " + FREE_ROAMING_BUFFER + " free-roaming; fires when overstaffed by >3",
                    isChecked: settings.autoHire.get(),
                    onChange: function(v: boolean): void { settings.autoHire.set(v); },
                },
                {
                    type: "checkbox", name: "chkAutoSweep",
                    x: 14, y: 192, width: 276, height: 14,
                    text: "Auto-sweep all litter each day",
                    isChecked: settings.autoSweep.get(),
                    onChange: function(v: boolean): void { settings.autoSweep.set(v); },
                },
                {
                    type: "checkbox", name: "chkAdaptive",
                    x: 14, y: 210, width: 276, height: 14,
                    text: "Adaptive staffing (learn the right number)",
                    tooltip: "Reduce handymen while the park stays clean and the fleet has nothing to do; hire back immediately if litter starts costing park rating. Never exceeds the formula's recommendation, never drops below path-coverage minimum.",
                    isChecked: isAdaptiveStaffing(),
                    onChange: function(v: boolean): void {
                        settings.adaptiveStaffing.set(v);
                        resetStaffingSeed(); // re-seed from the live roster
                    },
                },
                {
                    type: "checkbox", name: "chkAmenities",
                    x: 14, y: 228, width: 276, height: 14,
                    text: "Auto-place benches & bins where needed",
                    tooltip: "Each in-game day, place benches near nauseating ride exits and vomit hotspots, and bins near stalls. Benches stop guests vomiting (a seated guest sheds nausea); handymen only clean up afterwards. Costs money, so it is off by default.",
                    isChecked: isAutoAmenities(),
                    onChange: function(v: boolean): void { settings.autoAmenities.set(v); },
                },
                {
                    type: "checkbox", name: "chkAmenityRemoval",
                    x: 26, y: 246, width: 264, height: 14,
                    text: "...and remove ones no longer needed",
                    tooltip: "Remove benches and bins that are no longer near any stall, nauseating ride exit or vomit hotspot. ONLY removes amenities this plugin placed itself - anything you placed is never touched.",
                    isChecked: isAmenityRemoval(),
                    onChange: function(v: boolean): void { settings.amenityRemoval.set(v); },
                },
                {
                    type: "checkbox", name: "chkFacilities",
                    x: 14, y: 264, width: 276, height: 14,
                    text: "Auto-build toilets, first aid & food stalls",
                    tooltip: "Watches where guests actually go hungry, thirsty or need a toilet, and builds a facility there once the same gap has persisted across many samples. Costs real money and needs Diagnostics-quality sampling, which it turns on for itself. Never demolishes anything, caps how many of each kind it will build, and builds at most one at a time. Off by default.",
                    isChecked: isAutoFacilities(),
                    onChange: function(v: boolean): void { settings.autoFacilities.set(v); },
                },
                { type: "label", x: 14, y: 284, width: 116, height: 14, text: "Max handymen cap:" },
                {
                    type: "spinner", name: "spnMaxHandymen",
                    x: 134, y: 282, width: 48, height: 16,
                    text: String(getMaxHandymen()),
                    tooltip: "Hard upper limit on auto-hired handymen; 1-99  (manual hires are unaffected)",
                    onIncrement: function(): void {
                        const n = Math.min(99, getMaxHandymen() + 1);
                        storage.set("maxHandymen", n);
                        if (win) win.findWidget<SpinnerWidget>("spnMaxHandymen").text = String(n);
                        refreshWindow();
                    },
                    onDecrement: function(): void {
                        const n = Math.max(1, getMaxHandymen() - 1);
                        storage.set("maxHandymen", n);
                        if (win) win.findWidget<SpinnerWidget>("spnMaxHandymen").text = String(n);
                        refreshWindow();
                    },
                },

                // --- Actions ---
                { type: "groupbox", x: 6, y: 312, width: 288, height: 102, text: "Actions" },
                {
                    type: "button", x: 14, y: 326, width: 86, height: 16,
                    text: "Sweep All",
                    tooltip: "Immediately remove every litter item from the park",
                    onClick: function(): void { requestSweepAll(); },
                },
                {
                    type: "button", x: 106, y: 326, width: 90, height: 16,
                    text: "Sweep Old Only",
                    tooltip: "Remove only litter aged 7680+ ticks — the pieces currently costing rating points",
                    onClick: function(): void { requestSweepOld(); },
                },
                {
                    type: "button", x: 202, y: 326, width: 86, height: 16,
                    text: "Hire Handyman",
                    tooltip: "Hire one handyman and assign them a patrol zone",
                    onClick: function(): void {
                        hireHandyman(function(id: number): void {
                            clearHandymanZone(id);
                        });
                    },
                },
                {
                    type: "button", x: 14, y: 346, width: 134, height: 16,
                    text: "Clear All Patrol Zones",
                    tooltip: "Remove every handyman's patrol area so they can reach any path in the park. OpenRCT2 dispatches the nearest handyman to each piece of litter automatically, so a zone only gets in the way.",
                    onClick: function(): void { clearAllZones(); },
                },
                {
                    type: "button", x: 154, y: 346, width: 134, height: 16,
                    text: "Fix Orders (No Mow)",
                    tooltip: "Enable sweep + empty bins on all handymen; disables grass mowing which causes handymen to abandon path sweeping",
                    onClick: function(): void { requestFixOrders(); },
                },
                {
                    type: "button", x: 14, y: 366, width: 274, height: 16,
                    text: "Force Full Scan & Refresh",
                    tooltip: "Re-scan all tiles and entities to update displayed counts",
                    onClick: function(): void { forceTileScan(); updateCache(); refreshWindow(); },
                },

                { type: "label", name: "lblStatus", x: 14, y: 386, width: 276, height: 14, text: "" },
                diagnosticsCheckbox(14, 406, 276),
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
        // Refresh display every 3 real-world seconds; reads cached values only, not a tile scan
        refreshHandle = context.setInterval(refreshWindow, 3000);
    }

    /** Builds a text severity bar: "[####................] 20%" */
    function makeThresholdBar(oldCount: number): string {
        const pct    = Math.min(1.0, oldCount / LITTER_PENALTY_CAP);
        const filled = Math.round(pct * 20);
        let bar      = "[";
        for (let i = 0; i < 20; i++) bar += (i < filled ? "#" : ".");
        bar += "]";
        const label  = pct === 0      ? "none"
                     : pct < 0.25    ? "low"
                     : pct < 0.5     ? "medium"
                     : pct < 0.75    ? "high"
                     : "CRITICAL";
        return "Severity: " + label + "  " + bar + "  " + Math.round(pct * 100) + "%";
    }

    /** Updates all window labels from current cache + live data. */
    function refreshWindow(): void {
        if (!win) return;

        const penalty = computeRatingPenalty(cache.oldLitter);
        const needed  = computeNeededHandymen(cache.pathTiles, cache.guests);

        win.findWidget<LabelWidget>("lblRating").text   =
            "Litter penalty: -" + penalty + " pts  (" + cache.oldLitter + " old / " + LITTER_PENALTY_CAP + " max)";
        win.findWidget<LabelWidget>("lblThresh").text   = makeThresholdBar(cache.oldLitter);
        win.findWidget<LabelWidget>("lblLitter").text   =
            "Total litter: " + cache.totalLitter + "  (trash: " + cache.trash + ", vomit: " + cache.vomit + ")";
        const adaptive = isAdaptiveStaffing();
        win.findWidget<LabelWidget>("lblHandymen").text =
            "Handymen: " + cache.handymanCount +
            (adaptive ? "  /  target: " + staffing.target() + " (formula " + needed + ")"
                      : "  /  needed: " + needed) +
            "  /  max: " + getMaxHandymen();
        const saving = (needed - cache.handymanCount) * 50;
        if (saving > 0) {
            win.findWidget<LabelWidget>("lblHandymen").text += "   (-" + saving + "/mo)";
        }
        win.findWidget<LabelWidget>("lblBins").text     =
            "Bins: " + cache.fullBins + " full, " + cache.brokenBins + " broken  (guests: " + cache.guests + ")";
        win.findWidget<LabelWidget>("lblTiles").text    =
            "Path tiles: " + cache.pathTiles + "  /  owned land: " + cache.ownedTiles;
        win.findWidget<LabelWidget>("lblStatus").text   =
            cache.brokenBins > 0 ? "[!] Broken bins detected -- vandalism cascade risk!" : "";
    }

    return {
        openWindow,
    };
}
