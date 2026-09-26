/** In-game side of news.ts (#124): uses the game globals, so kept out of the pure module. */

import { createNews, NewsPost, Phrasebook } from "./news";

/**
 * The in-game wiring: posts through `park.postMessage`, counts into the debug channel,
 * seeds the line choice from the game date. `flush()` goes first in interval.day, so a
 * hire callback that lands late still makes the next digest.
 */
export function createParkNews(plugin: string, setting: { get(): boolean },
                               phrases: Phrasebook, dbg: { count(name: string, n?: number): void }) {
    const news = createNews({
        plugin,
        enabled: () => setting.get(),
        phrases,
        post: (m: NewsPost) => {
            park.postMessage(m as ParkMessageDesc);
            console.log("[" + plugin + "] News: " + m.text); // same line in the console log
        },
        count: (name: string, n?: number) => dbg.count(name, n),
    });
    return {
        add: news.add,
        flush: (): NewsPost | null => news.flush(date.monthsElapsed * 31 + date.day),
    };
}
export type ParkNews = ReturnType<typeof createParkNews>;

/** The per-plugin "News summaries" window checkbox. */
export function newsCheckbox(setting: { get(): boolean; set(on: boolean): void },
                             x: number, y: number, width: number): CheckboxDesc {
    return {
        type: "checkbox", name: "chkNews",
        x: x, y: y, width: width, height: 14,
        text: "News summaries",
        tooltip: "At most one news-ticker message a day about what this plugin just did (hires, builds, rush hours, campaigns). Harmless fun; turn off for a quieter ticker. On by default (#124).",
        isChecked: setting.get(),
        onChange: function (checked: boolean): void { setting.set(checked); },
    };
}
