/**
 * Queue trend detection — OpenRCT2 plugin
 *
 * WHY THIS MODULE EXISTS:
 *   The wait-time optimizer applies its emergency override at a fixed 5-minute queue.
 *   That threshold is the point at which guests start *complaining*, which makes it a
 *   good place to warn the player — and a late place to act.
 *
 * THE ASYMMETRY THAT JUSTIFIES ACTING EARLY:
 *   Queue length does not deter guests from joining. That is not modelled behaviour
 *   being simulated, it is a known missing feature
 *   ([#16841](https://github.com/OpenRCT2/OpenRCT2/discussions/16841)). In a real
 *   queueing system a long line is self-limiting because people balk; here nothing
 *   balks, so arrival rate is independent of queue length and a ride whose throughput
 *   is below its arrival rate grows without bound until the walk-out (~15 min in
 *   the queue and happiness <= 65, Guest.cpp:5729).
 *
 *   So the queue is not a level that settles, it is an integral that diverges. Waiting
 *   for it to cross a threshold means always acting after the divergence has started.
 *
 * WHY TREND AND NOT A LOWER THRESHOLD:
 *   The obvious fix — drop the override threshold from 5 minutes to 3 — is wrong,
 *   because the override trades capacity-per-train for dispatch rate (Any Load instead
 *   of Full Load). On a quiet ride that is a straight loss: trains leave half empty,
 *   throughput per cycle falls, and nothing was gained because there was no queue to
 *   clear. A fixed lower threshold applies that loss to every ride that is merely
 *   moderately busy.
 *
 *   A *rising* queue is different. It distinguishes "3 minutes and stable", which is a
 *   healthy ride at equilibrium and must be left alone, from "3 minutes and climbing",
 *   which is a ride whose arrival rate already exceeds its throughput and which will
 *   reach the complaint threshold on its own. Only the second one needs the trade.
 *
 * DELIBERATELY CONSERVATIVE:
 *   The worst case is bounded and small. A ride flagged early receives exactly the
 *   settings it would have received a day or two later anyway, so the downside is a
 *   short period of Any Load on a ride that turned out not to need it. `FLOOR_MINUTES`
 *   keeps this away from genuinely quiet rides, and `RISE_OBSERVATIONS` requires the
 *   rise to be sustained rather than a single sample of noise — queue time is measured
 *   from guests currently in line, so it jitters constantly.
 *
 * PURITY CONTRACT:
 *   No game globals. The caller feeds observed queue times and gets back a verdict.
 */

/**
 * Queues below this are left alone however they are trending.
 *
 * A ride climbing from 30 seconds to a minute is filling up, not backing up, and that
 * is the normal behaviour of a ride guests have started noticing.
 */
export const FLOOR_MINUTES = 3;

/**
 * Consecutive rising observations before a queue counts as running away.
 *
 * Two is enough to rule out single-sample noise while still acting well before the
 * 5-minute complaint threshold, which is the entire point.
 */
export const RISE_OBSERVATIONS = 2;

/** What the caller should do about one ride. */
export type QueuePressure =
    /** Below the floor, or not rising. Use the normal duration formula. */
    | "normal"
    /** Rising toward trouble. Apply the override early. */
    | "rising"
    /** Already past the caller's own warning threshold. Override regardless of trend. */
    | "warning";

interface TrendRecord {
    last: number;
    /** Consecutive observations where the queue grew. */
    rises: number;
    seen: boolean;
}

export interface QueueTrendTracker {
    /**
     * Records one ride's queue time (in minutes) and returns what to do about it.
     *
     * `warnMinutes` is the caller's existing warning threshold; at or above it the
     * verdict is always "warning" and the trend is irrelevant, because a queue that is
     * already in trouble does not need to prove it is getting worse.
     */
    observe(rideId: number, queueMinutes: number, warnMinutes: number): QueuePressure;
    /**
     * Drops records for rides not seen since the last call.
     *
     * Called once per pass after every ride has been observed. Without this the table
     * would accumulate ids for demolished rides forever — the same stale-id class of
     * bug that produced "Invalid parameter / Staff not found" in the staffing code.
     */
    endPass(): void;
    /** Rides currently judged to be running away. For telemetry. */
    risingCount(): number;
    reset(): void;
}

export function createQueueTrendTracker(): QueueTrendTracker {
    let records: Record<number, TrendRecord> = {};

    function observe(rideId: number, queueMinutes: number, warnMinutes: number): QueuePressure {
        let record = records[rideId];
        if (record === undefined) {
            record = { last: queueMinutes, rises: 0, seen: true };
            records[rideId] = record;
            // First sighting establishes a baseline; there is no trend yet, so a ride
            // cannot be flagged on the strength of a single reading.
            return queueMinutes >= warnMinutes ? "warning" : "normal";
        }

        if (queueMinutes > record.last) {
            record.rises++;
        } else if (queueMinutes < record.last) {
            // Any fall resets outright. A queue that is being cleared is not running
            // away, and letting rises accumulate across a fall would slowly flag every
            // ride that had ever been busy.
            record.rises = 0;
        }
        // An exactly flat reading neither confirms nor clears the trend: it leaves the
        // count alone, so a queue pinned at one value does not creep toward a flag.

        record.last = queueMinutes;
        record.seen = true;

        if (queueMinutes >= warnMinutes) return "warning";
        if (queueMinutes >= FLOOR_MINUTES && record.rises >= RISE_OBSERVATIONS) return "rising";
        return "normal";
    }

    function endPass(): void {
        const keys = Object.keys(records);
        const next: Record<number, TrendRecord> = {};
        for (let i = 0; i < keys.length; i++) {
            const id = Number(keys[i]);
            const record = records[id];
            if (!record.seen) continue;
            record.seen = false;
            next[id] = record;
        }
        records = next;
    }

    function risingCount(): number {
        const keys = Object.keys(records);
        let n = 0;
        for (let i = 0; i < keys.length; i++) {
            const record = records[Number(keys[i])];
            if (record.rises >= RISE_OBSERVATIONS && record.last >= FLOOR_MINUTES) n++;
        }
        return n;
    }

    function reset(): void {
        records = {};
    }

    return { observe, endPass, risingCount, reset };
}

/**
 * Per-ride intervention attribution (P3).
 *
 * WHY THIS EXISTS:
 *   `createQueueTrendTracker` above answers "is this ride's queue rising right now" —
 *   a park-wide count of rising/warning rides. It cannot answer "did the thing we did
 *   to ride X actually help ride X", because it throws its per-ride history away as
 *   soon as the verdict is computed. When the park-wide aggregates move (worst queue
 *   6 -> 16 minutes, `capacityBound` 0 -> 4) there are several candidate causes —
 *   OPS lengthening cycles, a breakdown pushing guests elsewhere, park growth, or W2's
 *   own pre-emptive override trading capacity-per-dispatch for dispatch rate — and a
 *   park-wide number cannot distinguish them. Only a per-ride before/after can.
 *
 * WHAT IT TRACKS:
 *   A short rolling history of queue minutes per ride, and — separately — the day and
 *   kind of the most recent intervention applied to that ride (W2's pre-emptive
 *   override, or an OPS operation-value set). `summarize` reduces the two to a single
 *   before/after delta over a fixed window either side of the intervention day.
 *
 * DURABLE VS TRANSIENT STATE, AND WHY BOTH ARE DROPPED ON ABSENCE:
 *   Unlike the OPS controller's probed range (expensive to rediscover, so it survives
 *   a ride's absence from the optimizable list) a queue-minutes history is cheap to
 *   rebuild and stale the moment a ride goes missing for a pass: a closed or broken
 *   ride's queue is meaningless (usually 0, or frozen), and a ride absent for the
 *   8-day breakdown this module exists to help attribute would otherwise splice a
 *   pre-breakdown and post-breakdown queue into one misleading "trend". Ride ids are
 *   also reused when a ride is demolished, so an old record surviving an absence could
 *   silently attach to a different, unrelated ride. `endPass` therefore drops the
 *   *entire* record — history AND intervention — for any ride not observed this pass,
 *   same as `createQueueTrendTracker.endPass`. An intervention whose after-window
 *   hasn't finished when the ride vanishes is simply never reported; that is correct,
 *   not a bug, because the ride it would have been reported about no longer exists in
 *   the sense the report means.
 *
 * PURITY CONTRACT: no game globals. The caller supplies a monotonic day counter (e.g.
 * one incremented per `interval.day`) and observed queue minutes; everything here is
 * plain arithmetic over that input.
 */

/** Days of history kept, and consulted, on each side of an intervention. */
export const ATTRIBUTION_WINDOW_DAYS = 5;

/**
 * Throughput is only counted on days the ride was queued at BOTH daily readings
 * bounding the day (#15). While a queue exists, guests served per day is capped by the
 * ride's capacity rather than by how many guests are in the park, so it measures what
 * W2 and OPS actually change, independent of the always-moving guest count. A ride
 * without a queue is short of guests, and its throughput measures demand instead.
 */
export const THROUGHPUT_QUEUE_MINUTES = 1;

/** How an intervention was triggered. */
export type InterventionKind = "w2-preemptive" | "ops-set";

interface QueueSample {
    day: number;
    minutes: number;
}

/**
 * First reading of a day. The daily hook is always the first caller for a new day;
 * later same-day reads (window open, boosts) would shift the interval, so they only
 * contribute `broken`, which is sticky across the day.
 */
interface DailyReading {
    day: number;
    customers: number;
    queueMinutes: number;
    broken: boolean;
}

interface ThroughputWindow {
    /** Mean guests served per qualifying day, 1 dp. Null if no qualifying day. */
    mean: number | null;
    days: number;
}

interface InterventionRideRecord {
    name: string;
    /** One entry per day, oldest first, when the caller supplies `totalCustomers`. */
    daily: DailyReading[];
    /** Oldest first. Trimmed to what a before/after window could ever need. */
    history: QueueSample[];
    /**
     * `before` is computed once, when the intervention is recorded, and never
     * recomputed - see the comment on `recordIntervention` for why.
     */
    intervention: {
        day: number; kind: InterventionKind; before: number | null;
        /** Frozen at record time, same reason as `before`. */
        throughputBefore: ThroughputWindow;
    } | null;
    seen: boolean;
}

/** One ride's before/after evidence, small enough to log every day. */
export interface RideAttribution {
    rideId: number;
    name: string;
    kind: InterventionKind;
    day: number;
    /** Mean queue minutes in the window before the intervention day. Null if none observed. */
    beforeMinutes: number | null;
    /** Mean queue minutes in the window after the intervention day. Null if none observed yet. */
    afterMinutes: number | null;
    /** afterMinutes - beforeMinutes. Null unless both sides have data. */
    deltaMinutes: number | null;
    /**
     * Mean guests served per queued day (see THROUGHPUT_QUEUE_MINUTES). "Before" covers
     * the ATTRIBUTION_WINDOW_DAYS intervals ending at the intervention-day reading,
     * "after" the same number starting from it. Null without `totalCustomers` input.
     */
    throughputBefore: number | null;
    throughputAfter: number | null;
    qualifyingDaysBefore: number;
    qualifyingDaysAfter: number;
    /** (after - before) / before * 100, rounded. Null unless both sides have data. */
    throughputDeltaPct: number | null;
}

export interface InterventionTracker {
    /**
     * Records one ride's queue reading for `day`. Call once per ride per pass.
     * `customers` is the ride's cumulative `totalCustomers`; `broken` is whether it was
     * broken down now or at any point since the last reading. Both optional: without
     * them only the queue-minute fields are reported.
     */
    observe(rideId: number, name: string, day: number, queueMinutes: number,
            customers?: number, broken?: boolean): void;
    /**
     * Records that an intervention of `kind` was applied to `rideId` on `day`.
     * A new call overwrites any prior intervention for the ride — only the most
     * recent one is tracked, so a ride touched twice reports against the latest.
     */
    recordIntervention(rideId: number, day: number, kind: InterventionKind): void;
    /** Drops records for rides not observed since the last call. See header. */
    endPass(): void;
    /**
     * Small before/after summary for every ride carrying an intervention, as of `day`.
     * Intended to be logged once per day; a handful of rides at most.
     */
    summarize(day: number): RideAttribution[];
    reset(): void;
}

export function createInterventionTracker(): InterventionTracker {
    let records: Record<number, InterventionRideRecord> = {};

    // Only ever needed: the window either side of the current intervention, plus the
    // most recent days a NEW intervention's before-window would read. Trimming to that
    // keeps each array a couple of windows long rather than growing for the life of
    // the save.
    //
    // This used to be a flat cap of 2 * window + 1 ENTRIES. That evicted the
    // after-window once more than ~11 samples had arrived since the intervention (and
    // sooner when the cache refreshed several times in a day), so `afterMinutes` for
    // an old intervention silently shrank to the last few days and then went null.
    // Found by the #15 throughput tests.
    function keep(sampleDay: number, today: number, anchor: number | null): boolean {
        if (sampleDay >= today - ATTRIBUTION_WINDOW_DAYS - 1) return true;
        return anchor !== null
            && sampleDay >= anchor - ATTRIBUTION_WINDOW_DAYS
            && sampleDay <= anchor + ATTRIBUTION_WINDOW_DAYS;
    }

    function trim<T extends { day: number }>(samples: T[], today: number, anchor: number | null): T[] {
        // The anchor window can sit before a run of stale days, so this is a filter,
        // not a pop-from-the-front. Arrays are a couple of windows long; only allocate
        // when something actually goes.
        for (let i = 0; i < samples.length; i++) {
            if (!keep(samples[i].day, today, anchor)) {
                return samples.filter(x => keep(x.day, today, anchor));
            }
        }
        return samples;
    }

    function observe(rideId: number, name: string, day: number, queueMinutes: number,
                     customers?: number, broken?: boolean): void {
        let record = records[rideId];
        if (record === undefined) {
            record = { name, daily: [], history: [], intervention: null, seen: true };
            records[rideId] = record;
        }
        const anchor = record.intervention !== null ? record.intervention.day : null;
        if (customers !== undefined) {
            const last = record.daily.length > 0 ? record.daily[record.daily.length - 1] : null;
            if (last !== null && last.day === day) {
                if (broken === true) last.broken = true;
            } else {
                record.daily.push({ day, customers, queueMinutes, broken: broken === true });
                record.daily = trim(record.daily, day, anchor);
            }
        }
        record.name = name;
        record.seen = true;
        record.history.push({ day, minutes: queueMinutes });
        record.history = trim(record.history, day, anchor);
    }

    function recordIntervention(rideId: number, day: number, kind: InterventionKind): void {
        const record = records[rideId];
        if (record === undefined) {
            // No observation yet this pass or ever - nothing to anchor a window to.
            // Interventions are only meaningful for rides we are already tracking.
            return;
        }
        // `before` is captured HERE, once, rather than recomputed from `history` on
        // every `summarize()` call.
        //
        // This was a real bug, and a bad one for a feature whose only job is being
        // trustworthy evidence: `observe()` trims `history` to whatever window the
        // CURRENT `intervention.day` still needs, so a ride that isn't observed every
        // single day (a walk-through ride briefly leaving the optimizable list, for
        // instance) could have the exact days its before-window needed evicted and
        // then partially repopulated between two `summarize()` calls - the same
        // historical intervention reporting a real number, then null, then a real
        // number again, depending purely on when it was read. Freezing `before` the
        // moment the intervention is recorded - while those days are still guaranteed
        // to be in `history` - makes it a fact instead of a live recomputation.
        const before = windowMean(record.history, day - ATTRIBUTION_WINDOW_DAYS, day - 1);
        const throughputBefore = throughputWindow(record.daily, day - ATTRIBUTION_WINDOW_DAYS + 1, day);
        record.intervention = { day, kind, before, throughputBefore };
    }

    function endPass(): void {
        const keys = Object.keys(records);
        const next: Record<number, InterventionRideRecord> = {};
        for (let i = 0; i < keys.length; i++) {
            const id = Number(keys[i]);
            const record = records[id];
            if (!record.seen) continue;
            record.seen = false;
            next[id] = record;
        }
        records = next;
    }

    function windowMean(history: QueueSample[], from: number, to: number): number | null {
        let sum = 0;
        let n = 0;
        for (let i = 0; i < history.length; i++) {
            const s = history[i];
            if (s.day >= from && s.day <= to) { sum += s.minutes; n++; }
        }
        return n === 0 ? null : Math.round((sum / n) * 10) / 10;
    }

    /**
     * Guests served on day d = customers(d) - customers(d-1). Day d qualifies only if
     * both readings exist on consecutive days, both were queued, neither was broken,
     * and the counter did not go backwards (ride id reused, or a reset).
     */
    function throughputWindow(daily: DailyReading[], from: number, to: number): ThroughputWindow {
        let sum = 0;
        let n = 0;
        for (let i = 1; i < daily.length; i++) {
            const cur = daily[i];
            const prev = daily[i - 1];
            if (cur.day < from || cur.day > to) continue;
            if (prev.day !== cur.day - 1) continue;
            if (cur.broken || prev.broken) continue;
            if (cur.queueMinutes < THROUGHPUT_QUEUE_MINUTES
                || prev.queueMinutes < THROUGHPUT_QUEUE_MINUTES) continue;
            const served = cur.customers - prev.customers;
            if (served < 0) continue;
            sum += served;
            n++;
        }
        return { mean: n === 0 ? null : Math.round((sum / n) * 10) / 10, days: n };
    }

    function summarize(day: number): RideAttribution[] {
        const out: RideAttribution[] = [];
        const keys = Object.keys(records);
        for (let i = 0; i < keys.length; i++) {
            const id = Number(keys[i]);
            const record = records[id];
            const iv = record.intervention;
            if (iv === null) continue;
            const after = windowMean(record.history, iv.day + 1, Math.min(day, iv.day + ATTRIBUTION_WINDOW_DAYS));
            const delta = (iv.before !== null && after !== null) ? Math.round((after - iv.before) * 10) / 10 : null;
            const tAfter = throughputWindow(record.daily, iv.day + 1, Math.min(day, iv.day + ATTRIBUTION_WINDOW_DAYS));
            const tBefore = iv.throughputBefore;
            const tPct = (tBefore.mean !== null && tBefore.mean > 0 && tAfter.mean !== null)
                ? Math.round((tAfter.mean - tBefore.mean) / tBefore.mean * 100) : null;
            out.push({
                rideId: id,
                name: record.name,
                kind: iv.kind,
                day: iv.day,
                beforeMinutes: iv.before,
                afterMinutes: after,
                deltaMinutes: delta,
                throughputBefore: tBefore.mean,
                throughputAfter: tAfter.mean,
                qualifyingDaysBefore: tBefore.days,
                qualifyingDaysAfter: tAfter.days,
                throughputDeltaPct: tPct,
            });
        }
        return out;
    }

    function reset(): void {
        records = {};
    }

    return { observe, recordIntervention, endPass, summarize, reset };
}
