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
