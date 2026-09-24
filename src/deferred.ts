/**
 * Game-state changes requested from the UI, run on the next tick.
 *
 * A window's onClick/onChange cannot safely mutate game state (entity removal, staff
 * orders, ride settings), so every plugin used to keep its own `pendingX` flags and an
 * `interval.tick` handler that ran and cleared them. Four copies of the same pattern;
 * this is the one place it lives now.
 *
 * Semantics match the copies it replaces:
 *   - requesting an action twice before the tick runs it once;
 *   - actions run in the order they were defined;
 *   - a flag is cleared only after its action returns, so one that throws is retried
 *     on the next tick rather than silently dropped;
 *   - a tick with nothing queued returns after a single check.
 *
 * Pure: the plugin passes in the tick subscription, so this runs under node in tests.
 */

export interface DeferredActions {
    /** Registers an action. Returns a function that queues it for the next tick. */
    define(run: () => void): () => void;
    /**
     * Registers an action that takes an argument. A second request before the tick
     * replaces the queued argument, or combines with it through `merge` when given.
     */
    defineWithArg<T>(run: (arg: T) => void, merge?: (queued: T, next: T) => T): (arg: T) => void;
    /** Runs everything queued. Called from the tick subscription; public for tests. */
    flush(): void;
}

interface Slot {
    pending: boolean;
    arg: unknown;
    run(arg: unknown): void;
}

export function createDeferredActions(subscribeTick: (onTick: () => void) => void): DeferredActions {
    const slots: Slot[] = [];
    let queued = 0;

    function flush(): void {
        if (queued === 0) return;
        for (let i = 0; i < slots.length; i++) {
            const s = slots[i];
            if (!s.pending) continue;
            s.run(s.arg);
            s.pending = false;
            s.arg = undefined;
            queued--;
        }
    }

    subscribeTick(flush);

    return {
        define(run: () => void): () => void {
            const slot: Slot = { pending: false, arg: undefined, run: () => run() };
            slots.push(slot);
            return () => {
                if (slot.pending) return;
                slot.pending = true;
                queued++;
            };
        },

        defineWithArg<T>(run: (arg: T) => void, merge?: (queued: T, next: T) => T): (arg: T) => void {
            const slot: Slot = { pending: false, arg: undefined, run: (a: unknown) => run(a as T) };
            slots.push(slot);
            return (arg: T) => {
                if (slot.pending) {
                    slot.arg = merge ? merge(slot.arg as T, arg) : arg;
                    return;
                }
                slot.pending = true;
                slot.arg = arg;
                queued++;
            };
        },

        flush,
    };
}
