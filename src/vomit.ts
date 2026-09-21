/**
 * Vomit attribution — OpenRCT2 plugin
 *
 * WHY THIS MODULE EXISTS:
 *   Telemetry across 104 in-game days showed 848 of 851 litter pieces recorded by this
 *   park were vomit; only 3 were trash. Litter bins exist to catch trash, so for this
 *   park bins are structurally irrelevant to the litter problem — the only litter
 *   problem worth solving is vomit. Vomit comes from nauseated guests, not from a lack
 *   of bins, so the actionable question is "which ride is making guests sick here?"
 *   rather than "where should a bin go?".
 *
 *   The game gives a genuine lever: `Guest.cpp:1099` reduces a sitting guest's
 *   `nauseaTarget` by 6 per update while it is still `>= 50`. A bench near a nauseating
 *   ride's exit lets guests shed nausea before it turns into vomit, so "add a bench"
 *   is a real fix and not a superstition — but only where a high-nausea ride is
 *   actually the source and no benches are already doing that job.
 *
 *   This module turns a day's vomit clusters (from the hotspot accumulator) and the
 *   park's ride list into a diagnosis per cluster: which ride is plausibly responsible,
 *   how far away it is, and what to do about it. It is pure data-in/data-out logic with
 *   no game API calls, so it can be unit-tested without a running park.
 */

/** A nauseating ride that could plausibly be the source of nearby vomit. */
export interface NauseaSource {
    rideId: number;
    name: string;
    /** 2-decimal fixed-point, so 750 means 7.50. */
    nausea: number;
    /** Ride exit location, TILE coordinates. */
    x: number;
    y: number;
}

/** A vomit cluster, in tile coordinates. */
export interface VomitCluster {
    x: number;
    y: number;
    vomit: number;
}

export interface VomitDiagnosis {
    /** The cluster, tile coordinates. */
    x: number;
    y: number;
    vomit: number;
    /** Nearest plausible source, or null if none is within range. */
    source: NauseaSource | null;
    /** Manhattan distance in tiles to that source; -1 when there is none. */
    distance: number;
}

/** Nausea at or above this is a high vomit-rate ride (7.50). */
export const HIGH_NAUSEA = 750;
/** Rides below this nausea are not plausible sources (5.00). */
export const MIN_NAUSEA = 500;

/** Manhattan distance in tiles between two points. Cheap and matches path-grid movement. */
function manhattan(ax: number, ay: number, bx: number, by: number): number {
    const dx = ax > bx ? ax - bx : bx - ax;
    const dy = ay > by ? ay - by : by - ay;
    return dx + dy;
}

/**
 * Attributes each vomit cluster to the nearest sufficiently-nauseating ride exit.
 *
 * Clusters with zero vomit carry no diagnostic value (nothing to explain) and are
 * dropped. Sources below `MIN_NAUSEA` are not plausible causes of vomiting and are
 * ignored outright, rather than being considered and rejected per cluster. When two
 * sources are equally close, the higher-nausea ride is preferred: it is statistically
 * the more likely culprit and gives the player a concrete, actionable target instead of
 * an arbitrary pick.
 */
export function attributeVomit(
    clusters: VomitCluster[],
    sources: NauseaSource[],
    maxDistanceTiles: number,
): VomitDiagnosis[] {
    const plausible: NauseaSource[] = [];
    for (let i = 0; i < sources.length; i++) {
        if (sources[i].nausea >= MIN_NAUSEA) {
            plausible.push(sources[i]);
        }
    }

    const diagnoses: VomitDiagnosis[] = [];
    for (let i = 0; i < clusters.length; i++) {
        const cluster = clusters[i];
        if (cluster.vomit <= 0) {
            continue;
        }

        let bestSource: NauseaSource | null = null;
        let bestDistance = -1;
        for (let j = 0; j < plausible.length; j++) {
            const source = plausible[j];
            const distance = manhattan(cluster.x, cluster.y, source.x, source.y);
            if (distance > maxDistanceTiles) {
                continue;
            }
            if (
                bestSource === null ||
                distance < bestDistance ||
                (distance === bestDistance && source.nausea > bestSource.nausea)
            ) {
                bestSource = source;
                bestDistance = distance;
            }
        }

        diagnoses.push({
            x: cluster.x,
            y: cluster.y,
            vomit: cluster.vomit,
            source: bestSource,
            distance: bestSource === null ? -1 : bestDistance,
        });
    }

    // Explicit descending sort: worst clusters first, so a caller printing a top-N list
    // doesn't need to know or re-derive the ordering.
    diagnoses.sort((a, b) => b.vomit - a.vomit);

    return diagnoses;
}

/** Renders a 2-decimal fixed-point nausea value (e.g. 840) as a decimal string ("8.40"). */
function formatNausea(nausea: number): string {
    const whole = Math.floor(nausea / 100);
    const fraction = nausea % 100;
    const fractionStr = fraction < 10 ? "0" + fraction : String(fraction);
    return whole + "." + fractionStr;
}

/** One-line human-readable explanation of a diagnosis, for the in-game console. */
export function describeDiagnosis(d: VomitDiagnosis, benchesNearby: number): string {
    const location = "(" + d.x + ", " + d.y + ")";
    const vomitWord = d.vomit === 1 ? "piece" : "pieces";

    if (d.source === null) {
        return (
            "Vomit at " + location + ": " + d.vomit + " " + vomitWord +
            ", but no ride nauseating enough is within range - cause unclear."
        );
    }

    const nauseaStr = formatNausea(d.source.nausea);
    const rideDesc =
        d.source.name + " (nausea " + nauseaStr + ", " + d.distance + " tiles away)";

    if (benchesNearby === 0) {
        return (
            "Vomit at " + location + ": " + d.vomit + " " + vomitWord +
            ", likely from " + rideDesc + " - add benches nearby so guests can sit and " +
            "shed nausea before it turns into vomit."
        );
    }

    return (
        "Vomit at " + location + ": " + d.vomit + " " + vomitWord +
        ", likely from " + rideDesc + " - " + benchesNearby +
        " bench(es) already nearby, so the ride's own nausea rating is the problem, " +
        "not a lack of seating."
    );
}
