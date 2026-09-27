/** In-game side of news.ts (#124): uses the game globals, so kept out of the pure module. */

import { createNews, pickHeadlines, NewsPost, Phrasebook, NEWS_PER_DAY } from "./news";

/**
 * Park storage every plugin can reach (getParkStorage takes any name, as migrateKeys uses
 * for Trash Manager). Lives in the save, in memory: no disk write per message.
 */
const BOARD_STORE = "MattT News";

interface BoardItem { plugin: string; msg: NewsPost; priority: number; }
interface Board { day: number; posted: boolean; items: BoardItem[]; }

function today(): number {
    return date.monthsElapsed * 31 + date.day;
}

/**
 * The in-game wiring. Each plugin's `flush()` (first thing in its interval.day) puts its
 * digest on the shared board and asks for one tick callback. Every plugin's day handler
 * has run by then, so the first callback to fire picks the top NEWS_PER_DAY across all
 * plugins, posts them and marks the day done; the others find nothing to do.
 */
export function createParkNews(plugin: string, setting: { get(): boolean },
                               phrases: Phrasebook, dbg: { count(name: string, n?: number): void }) {
    const store = context.getParkStorage(BOARD_STORE);

    function publish(): void {
        const b = store.get<Board>("board");
        if (b === undefined || b === null || b.posted) return;
        const [chosen, dropped] = pickHeadlines(b.items, NEWS_PER_DAY, Math.random);
        for (const it of chosen) {
            park.postMessage(it.msg as ParkMessageDesc);
            console.log("[" + it.plugin + "] News (day " + b.day + "): " + it.msg.text); // same line in the console log
        }
        if (dropped.length > 0) dbg.count("newsCapped", dropped.length);
        b.posted = true;
        store.set("board", b);
    }

    const news = createNews({
        plugin,
        enabled: () => setting.get(),
        phrases,
        post: (msg: NewsPost, priority: number) => {
            const d = today();
            let b = store.get<Board>("board");
            if (b === undefined || b === null || b.day !== d) b = { day: d, posted: false, items: [] };
            if (b.posted) { dbg.count("newsLate"); return; }
            b.items.push({ plugin, msg, priority });
            store.set("board", b);
            const sub = context.subscribe("interval.tick", () => { sub.dispose(); publish(); });
        },
        count: (name: string, n?: number) => dbg.count(name, n),
    });
    return { add: news.add, flush: news.flush };
}
export type ParkNews = ReturnType<typeof createParkNews>;

/** The per-plugin "News summaries" window checkbox. */
export function newsCheckbox(setting: { get(): boolean; set(on: boolean): void },
                             x: number, y: number, width: number): CheckboxDesc {
    return {
        type: "checkbox", name: "chkNews",
        x: x, y: y, width: width, height: 14,
        text: "News summaries",
        tooltip: "A daily news-ticker line about what this plugin just did (hires, builds, rush hours, campaigns). All plugins together post at most " + NEWS_PER_DAY + " a day, the most important first. Turn off for a quieter ticker. On by default (#124).",
        isChecked: setting.get(),
        onChange: function (checked: boolean): void { setting.set(checked); },
    };
}
