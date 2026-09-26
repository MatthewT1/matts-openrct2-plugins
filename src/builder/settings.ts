/**
 * Auto-Builder's on/off settings, one per window checkbox. See settings.ts.
 *
 * The first three lived under Trash Manager until #84; MIGRATED_KEYS are moved across from
 * its park storage on load (migrateKeys), along with the record of what we placed.
 */

import { boolSetting, SettingsStore } from "../settings";

export type BuilderSettings = ReturnType<typeof createBuilderSettings>;

export function createBuilderSettings(storage: SettingsStore) {
    return {
        autoAmenities:  boolSetting(storage, "autoAmenities", true),
        amenityRemoval: boolSetting(storage, "autoAmenityRemoval", true),
        autoFacilities: boolSetting(storage, "autoFacilities", true),
        // #81: info kiosks at the park front/back and where guests get lost. New key,
        // nothing to migrate from Trash Manager.
        autoCheapBuilds: boolSetting(storage, "autoCheapBuilds", true),
    };
}

/** Trash Manager keys that belong to Auto-Builder since #84. */
export const MIGRATED_KEYS = ["autoAmenities", "autoAmenityRemoval", "autoFacilities", "placedAmenities"];
