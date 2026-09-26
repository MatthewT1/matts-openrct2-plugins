/**
 * Per-park on/off settings.
 *
 * Every toggle used to be read as `storage.get<boolean>(key) === true` (default off) or
 * `!== false` (default on) in one place and written with `storage.set(key, ...)` in the
 * window, so the key and the default were each written out twice per setting, across
 * five plugins. A BoolSetting holds both once.
 *
 * Pure: takes the park storage as an argument, so it runs under node in tests.
 */

/** The subset of OpenRCT2's `Configuration` this module uses. */
export interface SettingsStore {
    get<T>(key: string): T | undefined;
    set<T>(key: string, value: T): void;
}

export interface BoolSetting {
    get(): boolean;
    set(on: boolean): void;
}

/**
 * A boolean park setting. An unset key reads as `defaultOn`, and so does any stored
 * value that is not a boolean, exactly as the old `=== true` / `!== false` reads did.
 */
export function boolSetting(storage: SettingsStore, key: string, defaultOn: boolean): BoolSetting {
    return {
        get(): boolean {
            const v = storage.get<boolean>(key);
            return defaultOn ? v !== false : v === true;
        },
        set(on: boolean): void {
            storage.set(key, on);
        },
    };
}

/**
 * Moves keys from another plugin's park storage into this one's (#84: Auto-Builder took
 * the bins/benches and facility toggles from Trash Manager).
 *
 * A key set in `from` is copied only when `to` has no value yet, so a choice already made
 * in the new plugin always wins. The old key is then cleared either way, so the two can
 * never disagree later and the move runs once per key. Returns the keys copied.
 */
export function migrateKeys(from: SettingsStore, to: SettingsStore, keys: string[]): string[] {
    const copied: string[] = [];
    for (const key of keys) {
        const old = from.get<unknown>(key);
        if (old === undefined) continue;
        if (to.get<unknown>(key) === undefined) {
            to.set(key, old);
            copied.push(key);
        }
        from.set(key, undefined);
    }
    return copied;
}
