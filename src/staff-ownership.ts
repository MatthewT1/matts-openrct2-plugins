/**
 * Which staff this plugin hired, kept in park storage (#135).
 *
 * The rule is "never touch the player's stuff": a plugin may only fire, or change the
 * orders of, staff it hired itself. Staff Extras already keeps its owned list this way
 * (`ourEntertainers`); Trash Manager and Mechanic Manager fired whoever came first in
 * their release order, player-hired staff included.
 *
 * No OpenRCT2 globals: the plugin passes in its park storage, so this runs under node.
 */

export type OwnedIds = Record<string, true>;

/** The subset of `Configuration` this module uses. */
export interface OwnedStore {
    get<T>(key: string): T | undefined;
    set<T>(key: string, value: T): void;
}

export interface StaffFirePick {
    /** Owned ids to fire, in the caller's release order. */
    fireIds: number[];
    /** Fires wanted but skipped because the rest of the candidates are the player's. */
    protectedCount: number;
}

/**
 * Picks up to `count` ids to fire from `candidates` (already in release order),
 * skipping any the plugin did not hire. Player staff is never in `fireIds`.
 */
export function pickOwnedToFire(candidates: number[], owned: OwnedIds, count: number): StaffFirePick {
    const fireIds: number[] = [];
    for (let i = 0; i < candidates.length && fireIds.length < count; i++) {
        if (owned[String(candidates[i])]) fireIds.push(candidates[i]);
    }
    return { fireIds, protectedCount: Math.max(0, count - fireIds.length) };
}

export interface OwnedStaff {
    /** True if the plugin hired this id. */
    has(id: number): boolean;
    /** Remembers a confirmed hire. */
    add(id: number): void;
    /** Forgets a fired id. */
    remove(id: number): void;
    /**
     * Drops ids that are no longer on the roster, and returns what is left. Peep ids are
     * recycled, so a stale id could otherwise mark a player's later hire as ours.
     */
    prune(liveIds: number[]): OwnedIds;
}

export function createOwnedStaff(store: OwnedStore, key: string): OwnedStaff {
    function load(): OwnedIds {
        const raw = store.get<OwnedIds>(key);
        return raw !== undefined && raw !== null ? raw : {};
    }

    return {
        has(id: number): boolean {
            return load()[String(id)] === true;
        },
        add(id: number): void {
            const owned = load();
            owned[String(id)] = true;
            store.set(key, owned);
        },
        remove(id: number): void {
            const owned = load();
            if (!owned[String(id)]) return;
            delete owned[String(id)];
            store.set(key, owned);
        },
        prune(liveIds: number[]): OwnedIds {
            const owned = load();
            const live: OwnedIds = {};
            for (let i = 0; i < liveIds.length; i++) {
                if (owned[String(liveIds[i])]) live[String(liveIds[i])] = true;
            }
            for (const k in owned) {
                if (!live[k]) { store.set(key, live); break; }
            }
            return live;
        },
    };
}
