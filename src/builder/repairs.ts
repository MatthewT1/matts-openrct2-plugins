/**
 * Gradual repair of broken benches, bins and lamps (#115). Which and how many is decided
 * in repairs.ts (tested); this file re-places the same item on its tile, paid from the
 * monthly extras budget shared with queue TVs. Never adds an item that was not there.
 */

import { DebugChannel } from "../debug";
import { BuilderSettings } from "./settings";
import { ExtrasBudget } from "../extras-budget";
import { BrokenTile, repairQuota, pickRepairs } from "../repairs";

/** Budget reserved per repair before the action reports its cost (benches/bins/lamps cost £3-£10). */
const REPAIR_ESTIMATE = 100;

interface RepairScan {
    getBrokenTiles(): BrokenTile[];
    getEntranceTile(): { x: number; y: number } | null;
}

export function createRepairManager(settings: BuilderSettings, dbg: DebugChannel, budget: ExtrasBudget, scan: RepairScan) {
    let source: BrokenTile[] | null = null;
    let pending: BrokenTile[] = [];
    let repaired = 0;
    let firstDay = true;

    /** Whether the path element on this tile at `z` still has this addition, broken. */
    function stillBroken(t: BrokenTile): boolean {
        const tile = map.getTile(t.x, t.y);
        for (let i = 0; i < tile.numElements; i++) {
            const el = tile.getElement(i);
            if (el.type === "footpath" && el.baseZ === t.z) {
                return el.isAdditionBroken === true && el.addition === t.addition;
            }
        }
        return false;
    }

    function repair(t: BrokenTile): void {
        const args = { x: t.x * 32, y: t.y * 32, z: t.z, object: t.addition };
        context.queryAction("footpathadditionplace", args, function (q: GameActionResult): void {
            if (q.error && q.error !== 0) {
                dbg.count("repairRefused");
                return;
            }
            context.executeAction("footpathadditionplace", args, function (r: GameActionResult): void {
                if (r.error && r.error !== 0) {
                    dbg.count("repairFailed");
                    return;
                }
                budget.spend(r.cost !== undefined && r.cost > 0 ? r.cost : REPAIR_ESTIMATE);
                repaired++;
                dbg.count("repaired");
            });
        });
    }

    function manage(): void {
        if (!settings.autoRepairs.get()) return;
        const latest = scan.getBrokenTiles();
        if (latest !== source) {
            source = latest;
            pending = latest.slice();
        }
        pending = pending.filter(stillBroken);
        if (pending.length === 0) return;

        const quota = Math.min(repairQuota(pending.length, firstDay), budget.affordable(REPAIR_ESTIMATE));
        if (quota <= 0) {
            dbg.count("repairSkippedBudget");
            return;
        }
        firstDay = false;
        const picks = pickRepairs(pending, scan.getEntranceTile(), quota);
        for (let i = 0; i < picks.length; i++) repair(picks[i]);
        pending = pending.filter(function (t): boolean { return picks.indexOf(t) === -1; });
        console.log("[Auto-Builder] Repairing " + picks.length + " broken path item(s); "
            + pending.length + " still broken.");
    }

    return {
        manage,
        repairedCount(): number { return repaired; },
        brokenCount(): number { return pending.length; },
    };
}
