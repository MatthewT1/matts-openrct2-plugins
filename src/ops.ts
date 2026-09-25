/**
 * Ride operation-value controller.
 *
 * ## What "operation value" is, and why this module has to be so careful
 *
 * `Ride::operationOption` is a single byte with different meanings per ride type — maze
 * time limit, number of laps, launch speed, speed, or rotation/swing count. It is changed
 * through the `ridesetsetting` game action (`setting: 4`). Three source-verified facts
 * shape everything below:
 *
 * 1. **It cannot be read back.** `operationOption` is not among `ScRide`'s registered
 *    properties, is absent from `@openrct2/types`, and is absent from upstream `develop`.
 *    There is no query that returns "what is it set to right now." So this controller has
 *    to remember, in-memory, every value it has ever successfully written — `current` below
 *    is the plugin's only record of reality, and it starts out genuinely unknown.
 * 2. **Out-of-range values reject rather than clamp** (`RideSetSettingAction.cpp:95`), and
 *    the legal range is not exposed anywhere either. But issuing the action as a *query*
 *    (not an execution) is silent — it reports accept/reject without touching the ride. So
 *    the only way to learn a ride's maximum is to probe downward with queries until one is
 *    accepted.
 * 3. **Changing it calls `InvalidateTestResults`** (`RideSetSettingAction.cpp:195`), which
 *    throws away the ride's excitement/intensity/nausea ratings until it completes a lap
 *    with a rider again. So real (`"set"`) changes must be rare, deliberate, and always a
 *    single step — never bursts, never jumps to an extreme "while we're at it."
 *
 * ## Policy
 *
 * The observable proxy for "did that help" is `ride.rideTime` (seconds), which this module
 * does not need to touch directly: the caller already reduces the situation to `queueTime`
 * (worst queue across stations, in minutes), and this module reduces that further to a
 * `QueuePressure`. A long queue means the ride is throughput-limited, so a shorter cycle
 * (lower operation value) serves more guests. An empty queue means the ride is underused,
 * so a longer, more satisfying cycle (higher operation value) is free. Anything in between
 * is left alone, because doing nothing is the only change-free default and changes are
 * never free (see point 3 above).
 *
 * ## Probing strategy, and why it terminates
 *
 * Each ride starts with `max` unknown. `update` emits a `"probe"` action at `probeCeiling`.
 * A rejection halves the tested value toward the floor (`next = floor(value / 2)`, clamped
 * to 1); an acceptance records that value as `max` and probing stops for good. Because the
 * probed value strictly decreases on every rejection (halving any integer > 1 always
 * produces a smaller integer) and 1 is the smallest value the floor allows, the sequence
 * `probeCeiling, probeCeiling/2, .../4, ...` reaches 1 within `ceil(log2(probeCeiling)) + 1`
 * steps. If even 1 is rejected, there is nothing left to try — the ride is marked exhausted
 * and simply never receives a `"set"` again (its `max` stays `null` forever, which the
 * "never set with an unknown max" rule already forbids acting on).
 *
 * ## Hysteresis
 *
 * Every `update` call records one pressure reading per ride and compares it to the last.
 * A changed reading resets the streak to 1; a repeated reading increments it. Only once the
 * streak reaches `CONFIRM_OBSERVATIONS` — and only while the reading is `"high"` or `"low"`,
 * never `"normal"` — does the controller consider acting. Deciding to act (emitting a
 * `"set"`) immediately resets the streak to 0, exactly like `staffing.ts` resets its settle
 * timer on every change: the point is to force a fresh run of confirmations before the next
 * move, not to let one long streak justify a chain of single steps back to back.
 *
 * ## The unknown-`current` problem
 *
 * Because `operationOption` cannot be read (point 1), the very first `"set"` for a ride has
 * no known starting point to step from. Jumping straight to 1 or to `max` would violate
 * "never jump to the extreme," so instead the first ever `"set"` targets the midpoint of the
 * known legal range, `round((1 + max) / 2)` — a neutral calibration point, not a guess at
 * the guests' preference. Every `"set"` after that steps by exactly 1 from the now-known
 * `current`, as usual.
 */

/** How busy a ride is, derived by the caller from queue time. */
export type QueuePressure = "high" | "normal" | "low";

/** Queue minutes at or above which a ride counts as pressured. Guests complain at 5. */
export const HIGH_QUEUE_MINUTES = 5;
/** Queue minutes at or below which a ride counts as underused. */
export const LOW_QUEUE_MINUTES = 1;
/** Consecutive observations a pressure reading must hold before acting. */
export const CONFIRM_OBSERVATIONS = 4;

/** Floor for every operation value, regardless of ride type. */
/**
 * Lowest value worth assuming before anything is known.
 *
 * The real floor is per ride type and is **not 1** for many of them — community-documented
 * example: a swinging ship accepts 7 to 25 swings. `RideOperatingSettings` carries both a
 * MinValue and a MaxValue and neither is exposed to plugins, so the floor has to be
 * discovered the same way the ceiling is: by being told no.
 */
const MIN_VALUE = 1;

/** Absolute cap on upward probing, so a permissive ride cannot loop forever. */
const PROBE_HARD_CEILING = 255;

/**
 * Intensity at or above which the cycle is never lengthened, as a 2-decimal fixed
 * integer (900 = 9.00).
 *
 * Community consensus is that intensity must stay **below 10** for a ride to remain
 * exciting; once it reads Extreme, excitement is effectively capped around 5.50. Since
 * more rotations, swings or laps push intensity up, lengthening an already-intense ride
 * would make guests avoid it *more* — emptying the queue further and inviting this
 * controller to lengthen it again. A feedback trap, so it is blocked outright.
 */
export const INTENSITY_CEILING = 900;

export interface RideOpsState {
    rideId: number;
    name: string;
    /** Worst queue time across stations, in MINUTES. */
    queueTime: number;
    /** Current ride duration in seconds, or 0 when the ride has not run yet. */
    rideTime: number;
    /** Intensity as a 2-decimal fixed integer (8.40 is 840). */
    intensity: number;
    /**
     * The ride type number.
     *
     * Used solely as an identity check. The legal operation range comes from
     * `RideOperatingSettings {MinValue, MaxValue}`, which is per ride TYPE, so a record
     * whose type has changed describes a different ride that happens to have inherited
     * a reused id and must be discarded.
     */
    rideType: number;
}

/** What the caller should do next for one ride. */
export interface OpsAction {
    rideId: number;
    name: string;
    /**
     * "probe" — issue a silent query with `value` to test whether it is in range.
     * "set"   — issue the real action with `value`.
     */
    kind: "probe" | "set";
    value: number;
    reason: string;
}

export interface OpsController {
    /**
     * Record one observation per ride and return the actions to take.
     * Call once per pass with every optimisable ride.
     */
    update(rides: RideOpsState[]): OpsAction[];
    /** Record the outcome of a probe so the controller learns the ride's legal range. */
    noteProbe(rideId: number, value: number, accepted: boolean): void;
    /**
     * Record that a real `set` was refused.
     *
     * Direction matters and a probe result cannot express it: a refusal while stepping
     * DOWN means the ride's minimum is above that value, while a refusal stepping UP
     * means the maximum is below it. Treating a floor refusal as a ceiling refusal — as
     * an earlier version did — corrupts the discovered range downward every time.
     */
    noteSetRejected(rideId: number, value: number): void;
    /** Record that a `set` succeeded, so the controller knows the current value. */
    noteSet(rideId: number, value: number): void;
    /** Everything the controller knows about a ride, for telemetry. */
    describe(rideId: number): {
        min: number;
        max: number | null;
        current: number | null;
        pressure: QueuePressure | null;
        streak: number;
    } | null;
    /** Forget a ride (demolished). */
    forget(rideId: number): void;
    reset(): void;
}

interface RideOpsRecord {
    /** Lowest value known to be accepted. Raised when a downward set is refused. */
    min: number;
    /** Highest value a probe has ACCEPTED so far; 0 until one is. */
    probeLow: number;
    /** Lowest value a probe has REFUSED so far; null until one is. */
    probeHigh: number | null;
    rideId: number;
    name: string;
    /** Ride type at the time this record was created; see RideOpsState.rideType. */
    rideType: number;
    max: number | null;
    current: number | null;
    pressure: QueuePressure | null;
    streak: number;
    /** Next value to probe, or null when max is known or probing has been given up on. */
    nextProbe: number | null;
    /** True once even 1 has been rejected — nothing left to try. */
    probeExhausted: boolean;
}

function classify(queueTime: number): QueuePressure {
    if (queueTime >= HIGH_QUEUE_MINUTES) return "high";
    if (queueTime <= LOW_QUEUE_MINUTES) return "low";
    return "normal";
}

function clamp(value: number, min: number, max: number): number {
    if (value < min) return min;
    if (value > max) return max;
    return value;
}

/**
 * A ride type's legal range when it is known up front (#50): `[min, max]`, `"untunable"`
 * for a known type with nothing to tune, or null when unknown (then the range is probed).
 */
export type KnownOpsRange = (rideType: number) => [number, number] | "untunable" | null;

export function createOpsController(probeCeiling: number, knownRange?: KnownOpsRange): OpsController {
    let records: { [rideId: string]: RideOpsRecord } = {};

    function ensure(rideId: number, name: string, rideType: number): RideOpsRecord {
        const key = String(rideId);
        let record = records[key];
        if (!record) {
            record = {
                rideId: rideId,
                name: name,
                rideType: rideType,
                max: null,
                current: null,
                pressure: null,
                min: MIN_VALUE,
                probeLow: 0,
                probeHigh: null,
                streak: 0,
                nextProbe: clamp(probeCeiling, MIN_VALUE, probeCeiling),
                probeExhausted: false,
            };
            // A known range skips probing entirely: every probe refusal is an ERROR line
            // in the game log (#50), and the range is static per ride type anyway.
            const known = knownRange !== undefined ? knownRange(rideType) : null;
            if (known === "untunable") {
                record.nextProbe = null;
                record.probeExhausted = true;
            } else if (known !== null) {
                record.min = known[0];
                record.max = known[1];
                record.probeLow = known[1];
                record.probeHigh = known[1] + 1;
                record.nextProbe = null;
            }
            records[key] = record;
        } else if (record.rideType !== rideType) {
            // Ride ids are reused when a ride is demolished and another is built. Since
            // records now survive a ride's absence from a pass, a reused id would
            // otherwise inherit the previous ride's discovered range — and
            // `RideOperatingSettings {MinValue, MaxValue}` is per ride TYPE, so a
            // swinging ship's 7-25 would be applied to a maze.
            //
            // The TYPE is the right identity check, not the name: a player may rename a
            // ride at any time, and throwing away a hard-won probed range because
            // someone typed a new label would be a needless regression.
            delete records[key];
            return ensure(rideId, name, rideType);
        } else {
            record.name = name;
        }
        return record;
    }

    function update(rides: RideOpsState[]): OpsAction[] {
        const actions: OpsAction[] = [];
        const seen: { [rideId: string]: boolean } = {};

        for (let i = 0; i < rides.length; i++) {
            const ride = rides[i];
            seen[String(ride.rideId)] = true;
            const record = ensure(ride.rideId, ride.name, ride.rideType);

            const pressure = classify(ride.queueTime);
            record.pressure = pressure;

            if (record.max === null) {
                // Still discovering the legal range. Nothing else can happen until we do -
                // and deliberately nothing counts toward the confirmation streak either.
                // Probing can take several passes, and this used to fall through to the
                // streak accumulator below every one of them, so a ride under sustained
                // pressure while its range was still being discovered could arrive at the
                // moment `max` became known already sitting at or past
                // CONFIRM_OBSERVATIONS - collapsing the "wait for fresh confirmations"
                // gate into "act on the first pass after discovery."
                if (!record.probeExhausted && record.nextProbe !== null) {
                    actions.push({
                        rideId: ride.rideId,
                        name: ride.name,
                        kind: "probe",
                        value: record.nextProbe,
                        reason: "discovering the legal range (probing " + record.nextProbe + ")",
                    });
                }
                continue;
            }

            // Signed pressure accumulator rather than a consecutive-run counter.
            //
            // The first version reset the streak to 1 whenever the reading changed, which
            // made the gate unreachable in practice: measured over 18 in-game days with
            // queues fluctuating either side of the 5-minute threshold, **not one ride
            // was ever tuned** even though several held long queues. A single dip from 5
            // to 4 minutes threw away three accumulated confirmations.
            //
            // This is the same failure the staffing controller had, and it gets the same
            // fix: accumulate, and decay toward neutral on a quiet reading instead of
            // discarding the history. A ride that is mostly-congested still converges;
            // one that genuinely flips between extremes still cancels itself out.
            if (pressure === "high") {
                record.streak = record.streak < 0 ? 1 : record.streak + 1;
            } else if (pressure === "low") {
                record.streak = record.streak > 0 ? -1 : record.streak - 1;
            } else if (record.streak > 0) {
                record.streak--;
            } else if (record.streak < 0) {
                record.streak++;
            }

            // `streak` is now signed: positive means sustained congestion, negative
            // means a sustained empty queue. Either extreme can act once it is confident.
            const confident = record.streak >= CONFIRM_OBSERVATIONS
                || record.streak <= -CONFIRM_OBSERVATIONS;
            if (!confident) {
                continue;
            }
            const acting: QueuePressure = record.streak > 0 ? "high" : "low";

            // Check the intensity ceiling BEFORE anything else that could raise the
            // value — including the blind midpoint calibration below, which has no idea
            // whether it is stepping up or down.
            if (acting === "low" && ride.intensity >= INTENSITY_CEILING) {
                continue;
            }

            const max = record.max;
            let target: number;
            let reason: string;

            if (record.current === null) {
                // No known baseline. Calibrate in the direction the queue is asking for,
                // NOT blindly to the midpoint.
                //
                // **This was a bug, and a consequential one.** The midpoint is
                // direction-blind, so a ride under sustained queue pressure whose current
                // value happened to sit below the midpoint would be LENGTHENED — cutting
                // throughput on precisely the ride that needed more of it. Since
                // `operationOption` cannot be read back, the controller had no way to
                // notice it was making things worse.
                //
                // Measured 2026-09-20: `tuned` climbed 0 -> 4 while the worst queue rose
                // 7 -> 10 minutes and later to 16, past the 15-minute walk-out cliff.
                // That rise has other plausible causes (a ride broken for 8 days, a
                // growing park) so OPS is NOT being blamed for all of it — but a
                // calibration that can only ever hurt a congested ride is wrong on its
                // own terms, whatever else was happening.
                //
                // Congested: go straight to the minimum. That is the shortest cycle the
                // ride type allows and therefore its maximum throughput — unambiguously
                // right for a ride with a queue, and it makes the first change useful
                // rather than a coin flip.
                //
                // Empty: the midpoint is still right. A longer ride costs nothing when
                // nobody is waiting, and may raise excitement.
                if (acting === "high") {
                    target = record.min;
                    reason = "sustained queue pressure with an unknown current setting; " +
                        "calibrating to the shortest cycle for maximum throughput";
                } else {
                    target = clamp(Math.round((record.min + max) / 2), record.min, max);
                    reason = "calibrating baseline operation value (current setting is unknown)";
                }
            } else if (acting === "high") {
                // Branch on the ACCUMULATED direction, not the instantaneous reading.
                // Using `pressure` here would act backwards whenever the current sample
                // happened to be quiet while the history said congested.
                target = clamp(record.current - 1, record.min, max);
                reason = "sustained queue pressure (score " + record.streak +
                    "); shortening the cycle to raise throughput";
            } else {
                target = clamp(record.current + 1, record.min, max);
                reason = "sustained empty queue (score " + record.streak +
                    "); lengthening the cycle since it costs nothing";
            }

            if (record.current !== null && target === record.current) {
                // Already at the floor or ceiling in the desired direction; nothing to do.
                continue;
            }

            actions.push({
                rideId: ride.rideId,
                name: ride.name,
                kind: "set",
                value: target,
                reason: reason,
            });
            // Force a fresh confirmation streak before the next move, whether or not this
            // one is confirmed successful — see header on why changes must stay rare.
            record.streak = 0;
        }

        // Rides absent from this pass keep their record; only the transient decision
        // state is cleared.
        //
        // **This was a real bug, measured.** The original code deleted the whole record,
        // including the painstakingly probed legal range. But a ride leaves the
        // optimizable list whenever it closes or breaks down — which happened on 24 of
        // 167 measured days — and every exit threw the range away, so probing restarted
        // from scratch on its return. The log showed **192 probes** with `rangeKnown`
        // stuck at 8 and only one ride ever tuned, and the single tuned ride's identity
        // changed between sessions because its record had been destroyed and rebuilt.
        //
        // The range is a property of the ride TYPE and cannot go stale while the ride
        // exists. The streak is a property of recent queue history and must not carry
        // across a gap in observation — a ride that was closed for a week has no
        // meaningful queue trend, and acting on a pre-closure streak would be acting on
        // stale evidence.
        const keys = Object.keys(records);
        for (let i = 0; i < keys.length; i++) {
            const key = keys[i];
            if (!seen[key]) {
                const record = records[key];
                record.streak = 0;
                record.pressure = null;
            }
        }

        return actions;
    }

    function noteSetRejected(rideId: number, value: number): void {
        const record = records[String(rideId)];
        if (!record) return;

        // A value at or below the floor we already believe in cannot possibly be a
        // step UP, whatever `current` says — so this is always a floor refusal.
        //
        // **This ordering is a bug fix, and the bug was severe.** The directional
        // calibration added on 2026-09-20 sends a congested ride with no known baseline
        // straight to `record.min`, which starts at the assumed 1. Many ride types have
        // a much higher real floor — Dodgems and Flying Saucers are `{20, 180}`,
        // Merry-Go-Round `{4, 25}` — so that first set is refused. With `current` still
        // null the old code fell through to the else branch, read the refusal as
        // "stepping up", and dropped `max` to `value - 1 = 0`, which the clamp below
        // then pinned to `min`. The ride's whole range collapsed to [1, 1] and it could
        // never be tuned again. Measured: `opsSetRejected` rose from 2 to **30** against
        // only 5 successful sets.
        if (value <= record.min || (record.current !== null && value < record.current)) {
            // Refused while stepping down, or refused at the assumed floor: the real
            // floor is higher than we thought.
            //
            // Raised one step at a time on purpose. A refusal proves `value` is illegal
            // but says nothing about how far above it the true floor sits, so jumping
            // would overshoot and permanently give up the fastest legal cycle — exactly
            // the throughput a congested ride is being tuned for. Convergence is linear
            // and invisible to the player (every attempt is a silent `queryAction`), and
            // it lands on the exact floor.
            record.min = value + 1;
            if (record.max !== null && record.min > record.max) record.min = record.max;
        } else {
            // Refused while stepping up (or with no baseline): the ceiling is lower.
            const ceiling = value - 1;
            record.max = record.max === null ? ceiling : Math.min(record.max, ceiling);
            if (record.max < record.min) record.max = record.min;
        }
    }

    /**
     * Binary search for the true maximum.
     *
     * The first version simply halved on rejection and stopped on the first acceptance,
     * which finds only a *lower bound*: probing a ride whose real maximum is 25 would
     * stop at 16 and permanently cap the usable range. Since a probe is a `queryAction`
     * and therefore free — it changes nothing and shows the player nothing — there is no
     * reason to settle for an approximation.
     *
     * `probeLow` is the highest value known to be accepted, `probeHigh` the lowest known
     * to be refused. The search converges when they are adjacent, and terminates because
     * the gap between them strictly shrinks on every answer.
     */
    function noteProbe(rideId: number, value: number, accepted: boolean): void {
        const record = records[String(rideId)];
        if (!record) return;

        if (accepted) {
            if (value > record.probeLow) record.probeLow = value;
        } else if (record.probeHigh === null || value < record.probeHigh) {
            record.probeHigh = value;
        }

        if (record.probeHigh === null) {
            // Nothing has been refused yet, so climb: the ceiling is above everything
            // tried so far.
            const next = record.probeLow * 2;
            if (next <= PROBE_HARD_CEILING) {
                record.nextProbe = next;
                return;
            }
            // Doubling would overshoot the hard ceiling. Do NOT settle for the last
            // accepted value — bracket against the ceiling and binary search the gap.
            //
            // This used to record `max = probeLow` here, which silently under-reported
            // any ride whose true maximum fell between two powers of two above the
            // starting ceiling. Real example: Dodgems and Flying Saucers are
            // `{20, 180}` (`ride/rtd/gentle/Dodgems.h:38`). Doubling runs
            // 32 -> 64 -> 128 -> 256, and 256 exceeds the hard ceiling, so the ride was
            // recorded as max 128 and the whole 129-180 band was unreachable forever.
            // Maze is `{1, 64}` and several types are `{10, 40}` or `{30, 50}`, so this
            // is not a one-ride curiosity.
            //
            // Probes are silent `queryAction` calls that change nothing, so there is no
            // reason to accept an approximation — the search below costs a handful of
            // them and lands on the exact value.
            if (record.probeLow >= PROBE_HARD_CEILING) {
                record.max = PROBE_HARD_CEILING;
                record.nextProbe = null;
                return;
            }
            record.probeHigh = PROBE_HARD_CEILING + 1;
            record.nextProbe = Math.floor((record.probeLow + record.probeHigh) / 2);
            return;
        }

        if (record.probeLow === 0) {
            // Everything tried has been refused. Keep halving toward the floor.
            const next = Math.floor(record.probeHigh / 2);
            if (next < MIN_VALUE) {
                // Even the smallest value is refused: this ride cannot be tuned.
                record.probeExhausted = true;
                record.nextProbe = null;
            } else {
                record.nextProbe = next;
            }
            return;
        }

        if (record.probeHigh - record.probeLow <= 1) {
            record.max = record.probeLow;
            record.nextProbe = null;
            return;
        }

        record.nextProbe = Math.floor((record.probeLow + record.probeHigh) / 2);
    }

    function noteSet(rideId: number, value: number): void {
        const record = records[String(rideId)];
        // A no-op for a ride the controller has never seen, matching noteProbe.
        //
        // This previously fabricated a record. That is no longer safe: a record now
        // carries the ride TYPE as its identity, and inventing one would mean guessing
        // it — after which the record would either be wrongly discarded on the next
        // pass or, worse, wrongly kept. `noteSet` is only ever called in response to a
        // "set" action that `update` itself emitted, so a missing record means the
        // caller is out of contract and the right answer is to do nothing.
        if (!record) return;
        record.current = value;
        // A confirmed change is exactly the kind of event that should require a fresh
        // confirmation streak before the next one.
        record.streak = 0;
    }

    function describe(rideId: number): {
        min: number;
        max: number | null;
        current: number | null;
        pressure: QueuePressure | null;
        streak: number;
    } | null {
        const record = records[String(rideId)];
        if (!record) return null;
        return {
            min: record.min,
            max: record.max,
            current: record.current,
            pressure: record.pressure,
            streak: record.streak,
        };
    }

    function forget(rideId: number): void {
        delete records[String(rideId)];
    }

    function reset(): void {
        records = {};
    }

    return {
        update,
        noteProbe,
        noteSetRejected,
        noteSet,
        describe,
        forget,
        reset,
    };
}
