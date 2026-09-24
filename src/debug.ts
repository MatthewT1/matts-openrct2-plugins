/**
 * Shared debug / profiling channel for the OpenRCT2 plugins.
 *
 * Streams newline-delimited JSON to a local TCP listener (see tools/log-sink.mjs)
 * so plugin behaviour and timings can be analysed outside the game. If nothing is
 * listening the module silently does nothing — it must never interfere with play.
 *
 * Design constraints:
 *   - The scripting engine is QuickJS-NG with no JIT, so the hot path has to stay
 *     cheap. Timing a phase costs two Date.now() calls and one array push.
 *   - console.log is comparatively expensive, so samples are aggregated and only
 *     flushed on an interval, never per event.
 *   - Sockets are only available when the game was built with networking enabled;
 *     every socket call is wrapped so a DISABLE_NETWORK build degrades to a no-op.
 */

const DEBUG_HOST = "127.0.0.1";
const DEBUG_PORT = 7777;

/** How often buffered records are shipped, in real milliseconds. */
const FLUSH_INTERVAL_MS = 2000;
/** Reconnect backoff after a failed or dropped connection. */
const RECONNECT_MS = 10000;
/** Hard cap on buffered records so a missing sink can never grow memory without bound. */
const MAX_BUFFER = 500;

type ConnState = "idle" | "connecting" | "open" | "unavailable";

interface PhaseStats {
    count: number;
    total: number;
    min: number;
    max: number;
}

export interface DebugChannel {
    /** Times `fn`, records the duration under `name`, and returns its result. */
    time<T>(name: string, fn: () => T): T;
    /** Records a one-off structured event. */
    event(name: string, data?: Record<string, unknown>): void;
    /** Records a counter increment (e.g. game actions issued). */
    count(name: string, n?: number): void;
    /**
     * Emits the accumulated phase timings and counters, then resets them.
     *
     * `context` carries park state alongside the timings — guest count, staff counts,
     * litter totals and so on. Without it the log says how *fast* a handler ran but
     * nothing about the park it ran against, which makes it useless for judging whether
     * a staffing formula is producing sensible numbers.
     */
    flushStats(context?: Record<string, unknown>): void;
}

/**
 * Whether debugging is on, read from *shared* (not park) storage so the flag is
 * global and survives park loads. Checked lazily on every call rather than captured
 * at startup, so the "Diagnostics" checkbox in any of the plugin windows takes effect
 * immediately, for all three plugins at once, with no reload.
 *
 * Note the in-game console (backtick) cannot set this: it only accepts game commands,
 * not JavaScript — `InteractiveConsole` has no eval path. Only the `openrct2.com`
 * stdin console evaluates script (`StdInOutConsole.cpp:79`).
 *
 * Default is off, so a normal game pays only an object-property read per call.
 */
const DEBUG_FLAG = "openrct2-plugins.debug";

export function isDebugEnabled(): boolean {
    return context.sharedStorage.get<boolean>(DEBUG_FLAG) === true;
}

/** Turns the debug channel on or off for every plugin, immediately and globally. */
export function setDebugEnabled(on: boolean): void {
    context.sharedStorage.set(DEBUG_FLAG, on);
}

/**
 * The "Diagnostics" checkbox every plugin window carries. One definition, so the five
 * windows cannot drift apart (one already had a shorter tooltip).
 */
export function diagnosticsCheckbox(x: number, y: number, width: number): CheckboxDesc {
    return {
        type: "checkbox", name: "chkDebug",
        x: x, y: y, width: width, height: 14,
        text: "Diagnostics: stream timings to log sink",
        tooltip: "Stream timing and counter data to a local log sink on 127.0.0.1:7777 for performance analysis. Off by default; costs nothing when off.",
        isChecked: isDebugEnabled(),
        onChange: function (checked: boolean): void { setDebugEnabled(checked); },
    };
}

/** Creates a debug channel tagged with the given plugin name. */
export function createDebugChannel(plugin: string, isEnabled?: () => boolean): DebugChannel {
    const enabled = isEnabled !== undefined ? isEnabled : isDebugEnabled;

    let socket: Socket | null = null;
    let state: ConnState = "idle";
    let lastAttempt = 0;

    let buffer: string[] = [];
    const phases: Record<string, PhaseStats> = {};
    const counters: Record<string, number> = {};

    function connect(): void {
        const now = Date.now();
        if (state === "open" || state === "connecting" || state === "unavailable") return;
        if (now - lastAttempt < RECONNECT_MS) return;
        lastAttempt = now;

        // network.createSocket throws on builds compiled with DISABLE_NETWORK.
        // Treat that as permanently unavailable rather than retrying forever.
        let s: Socket;
        try {
            s = network.createSocket();
        } catch (e) {
            state = "unavailable";
            return;
        }

        state = "connecting";
        socket = s;
        s.on("close", () => { state = "idle"; socket = null; });
        s.on("error", () => { state = "idle"; socket = null; });
        try {
            s.connect(DEBUG_PORT, DEBUG_HOST, () => { state = "open"; });
        } catch (e) {
            state = "idle";
            socket = null;
        }
    }

    function push(record: Record<string, unknown>): void {
        if (buffer.length >= MAX_BUFFER) {
            // Drop oldest: recent behaviour is more useful than a stale backlog.
            buffer.shift();
        }
        record.plugin = plugin;
        record.tick = date.ticksElapsed;
        buffer.push(JSON.stringify(record));
    }

    function flush(): void {
        if (!enabled() || buffer.length === 0) return;
        connect();
        if (state !== "open" || socket === null) {
            // Not connected. Keep the (bounded) buffer so the first successful
            // connection still gets recent history.
            return;
        }
        const payload = buffer.join("\n") + "\n";
        buffer = [];
        try {
            socket.write(payload);
        } catch (e) {
            state = "idle";
            socket = null;
        }
    }

    context.setInterval(flush, FLUSH_INTERVAL_MS);

    return {
        time<T>(name: string, fn: () => T): T {
            if (!enabled()) return fn();
            const t0 = Date.now();
            try {
                return fn();
            } finally {
                const dt = Date.now() - t0;
                const s = phases[name];
                if (s === undefined) {
                    phases[name] = { count: 1, total: dt, min: dt, max: dt };
                } else {
                    s.count++;
                    s.total += dt;
                    if (dt < s.min) s.min = dt;
                    if (dt > s.max) s.max = dt;
                }
            }
        },

        event(name: string, data?: Record<string, unknown>): void {
            if (!enabled()) return;
            push({ kind: "event", name, data: data !== undefined ? data : {} });
        },

        count(name: string, n?: number): void {
            if (!enabled()) return;
            const by = n !== undefined ? n : 1;
            counters[name] = (counters[name] !== undefined ? counters[name] : 0) + by;
        },

        flushStats(parkContext?: Record<string, unknown>): void {
            if (!enabled()) return;
            const timings: Record<string, unknown> = {};
            let any = false;
            for (const name in phases) {
                const s = phases[name];
                timings[name] = {
                    count: s.count,
                    totalMs: s.total,
                    meanMs: Math.round((s.total / s.count) * 100) / 100,
                    minMs: s.min,
                    maxMs: s.max,
                };
                delete phases[name];
                any = true;
            }
            const counts: Record<string, number> = {};
            for (const name in counters) {
                counts[name] = counters[name];
                delete counters[name];
                any = true;
            }
            // Park context is worth emitting even on a day with no timings or counters,
            // because the trend over quiet days is exactly what staffing tuning needs.
            if (!any && parkContext === undefined) return;
            push({
                kind: "stats",
                timings,
                counts,
                park: parkContext !== undefined ? parkContext : {},
                gameSpeed: context.gameSpeed,
            });
        },
    };
}
