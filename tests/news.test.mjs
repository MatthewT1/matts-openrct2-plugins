import { createNews, packLocation, plural, possessive, pickHeadlines, PRIORITY, NEWS_PER_DAY, TRASH_PHRASES, BUILDER_PHRASES, WTO_PHRASES, EXTRAS_PHRASES, MECHANIC_PHRASES, MARKETING_PHRASES } from "./build/news.mjs";
let pass = 0, fail = 0;
const ok = (c, m) => { c ? pass++ : (fail++, console.log("FAIL:", m)); };

function rig(on = true, phrases = TRASH_PHRASES, rand = () => 0) {
    const posts = [], counts = {};
    const news = createNews({
        plugin: "Trash Manager", enabled: () => on, phrases, rand,
        post: (m, p) => posts.push({ m, p }), count: (n) => { counts[n] = (counts[n] || 0) + 1; },
    });
    return { news, posts, counts };
}

// Nothing added: nothing posted.
{ const r = rig(); ok(r.news.flush() === null && r.posts.length === 0, "empty day posts nothing"); }

// A busy day is one message; the count is in the text; a peep subject links the peep.
{
    const r = rig();
    r.news.add("hired", undefined, { type: "peep", id: 42 });
    r.news.add("hired", undefined, { type: "peep", id: 43 });
    r.news.add("hired");
    const m = r.news.flush();
    ok(r.posts.length === 1 && r.posts[0].p === PRIORITY.hired, "one message, with its priority");
    ok(m.text.startsWith("Trash Manager: ") && m.text.includes("3 handymen"), "prefix + count: " + m.text);
    ok(m.type === "peep" && m.subject === 42, "first subject kept");
    ok(r.news.flush() === null, "cleared after flush");
    ok(r.counts.newsPosted === 1, "counted");
}

// The most newsworthy kind leads even when added second; the rest become a tail.
{
    const r = rig();
    r.news.add("fired"); r.news.add("hired");
    const m = r.news.flush();
    ok(/[Hh]ired|joined|started today|Recruited/.test(m.text) && !/Let 1 handyman go/.test(m.text), "hired leads over fired: " + m.text);
    ok(m.type === "blank" && m.subject === undefined, "no subject -> blank");
    ok(/1 (other thing|other bit|further deed|item)/.test(m.text), "tail names the rest: " + m.text);
}

// Filler below its bulk threshold is dropped: 3 benches is not news, 4 is.
{
    const r = rig(true, BUILDER_PHRASES);
    for (let i = 0; i < 3; i++) r.news.add("amenities");
    ok(r.news.flush() === null && r.counts.newsTooSmall === 1, "3 benches dropped");
    for (let i = 0; i < 4; i++) r.news.add("amenities");
    ok(r.news.flush() !== null, "4 benches posted");
}

// The same line never runs twice in a row for a kind.
{
    const r = rig(true, TRASH_PHRASES, () => 0);
    r.news.add("hired"); const a = r.news.flush().text;
    r.news.add("hired"); const b = r.news.flush().text;
    ok(a !== b, "no immediate repeat");
}

// Toggle off: the day's events are dropped, not saved up for later.
{
    const r = rig(false);
    r.news.add("hired");
    ok(r.news.flush() === null && r.posts.length === 0 && r.counts.newsMuted === 1, "muted");
}

// A throwing post is counted, never thrown into the day handler.
{
    const counts = {};
    const news = createNews({ plugin: "X", enabled: () => true, phrases: TRASH_PHRASES, rand: () => 0,
        post: () => { throw new Error("boom"); }, count: (n) => { counts[n] = 1; } });
    news.add("hired");
    ok(news.flush() === null && counts.newsPostFailed === 1, "post failure contained");
}

// Ride subject and the builder's "and N more".
{
    const r = rig(true, BUILDER_PHRASES);
    r.news.add("stall", "Burger Bar 1", { type: "attraction", id: 7 });
    r.news.add("stall", "Drinks Stall 2", { type: "attraction", id: 8 });
    const m = r.news.flush();
    ok(m.type === "attraction" && m.subject === 7 && m.text.includes("Burger Bar 1") && m.text.includes("and 1 more stall"), "ride subject: " + m.text);
}

// Headlines: highest priority first, ties at random, capped.
{
    const items = [{ id: "a", priority: 1 }, { id: "b", priority: 3 }, { id: "c", priority: 2 }, { id: "d", priority: 2 }];
    const [chosen, dropped] = pickHeadlines(items, NEWS_PER_DAY, () => 0.5);
    ok(chosen.length === NEWS_PER_DAY && chosen[0].id === "b" && chosen[1].priority === 2, "top two by priority");
    ok(dropped.length === items.length - NEWS_PER_DAY && dropped[dropped.length - 1].id === "a", "lowest dropped");
    const seq = [0.9, 0.1, 0.8, 0.2]; let i = 0;
    ok(pickHeadlines(items, 2, () => seq[i++])[0][1].id === "d", "tie broken by rand");
}

ok(possessive("Excalibur") === "Excalibur's" && possessive("Grimble's Gallopers") === "Grimble's Gallopers'", "possessive");

// Location packing matches NewsItem.cpp: x low 16 bits, y high 16.
ok(packLocation(0x120, 0x340) === (0x340 * 65536 + 0x120), "packLocation");
ok(plural(1, "a", "b") === "1 a" && plural(2, "a", "b") === "2 b", "plural");

// Every phrasebook line is non-empty and ticker-sized for n = 1..5, and each kind has variety.
for (const book of [TRASH_PHRASES, BUILDER_PHRASES, WTO_PHRASES, EXTRAS_PHRASES, MECHANIC_PHRASES, MARKETING_PHRASES]) {
    for (const [kind, f] of Object.entries(book)) {
        ok(f(1, "X").length >= 3, kind + " has 3+ variants");
        for (let n = 1; n <= 5; n++) {
            for (const line of f(n, "Wooden Roller Coaster 1")) ok(line.length > 10 && line.length < 200, kind + " length " + line.length + ": " + line);
        }
    }
}

console.log(`news: ${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
