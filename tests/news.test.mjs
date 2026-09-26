import { createNews, packLocation, plural, TRASH_PHRASES, BUILDER_PHRASES, WTO_PHRASES, EXTRAS_PHRASES, MECHANIC_PHRASES, MARKETING_PHRASES } from "./build/news.mjs";
let pass = 0, fail = 0;
const ok = (c, m) => { c ? pass++ : (fail++, console.log("FAIL:", m)); };

function rig(on = true, phrases = TRASH_PHRASES) {
    const posts = [], counts = {};
    const news = createNews({
        plugin: "Trash Manager", enabled: () => on, phrases,
        post: (m) => posts.push(m), count: (n) => { counts[n] = (counts[n] || 0) + 1; },
    });
    return { news, posts, counts };
}

// Nothing added: nothing posted.
{ const r = rig(); ok(r.news.flush(1) === null && r.posts.length === 0, "empty day posts nothing"); }

// A busy day is one message; the count is in the text; a peep subject links the peep.
{
    const r = rig();
    r.news.add("hired", undefined, { type: "peep", id: 42 });
    r.news.add("hired", undefined, { type: "peep", id: 43 });
    r.news.add("hired");
    const m = r.news.flush(5);
    ok(r.posts.length === 1, "one message per flush");
    ok(m.text.startsWith("Trash Manager: ") && m.text.includes("3 handymen"), "prefix + count: " + m.text);
    ok(m.type === "peep" && m.subject === 42, "first subject kept");
    ok(r.news.flush(6) === null, "cleared after flush");
    ok(r.counts.newsPosted === 1, "counted");
}

// Other kinds become a tail; no subject means a plain "blank" message.
{
    const r = rig();
    r.news.add("fired"); r.news.add("hired");
    const m = r.news.flush(2);
    ok(m.type === "blank" && m.subject === undefined, "no subject -> blank");
    ok(/1 (other thing|other bit|further deed)/.test(m.text), "tail names the rest: " + m.text);
}

// Toggle off: the day's events are dropped, not saved up for later.
{
    const r = rig(false);
    r.news.add("hired");
    ok(r.news.flush(1) === null && r.posts.length === 0 && r.counts.newsMuted === 1, "muted");
}

// A throwing postMessage is counted, never thrown into the day handler.
{
    const counts = {};
    const news = createNews({ plugin: "X", enabled: () => true, phrases: TRASH_PHRASES,
        post: () => { throw new Error("boom"); }, count: (n) => { counts[n] = 1; } });
    news.add("hired");
    ok(news.flush(1) === null && counts.newsPostFailed === 1, "post failure contained");
}

// Ride subject and the builder's "and N more".
{
    const r = rig(true, BUILDER_PHRASES);
    r.news.add("stall", "Burger Bar 1", { type: "attraction", id: 7 });
    r.news.add("stall", "Drinks Stall 2", { type: "attraction", id: 8 });
    const m = r.news.flush(3);
    ok(m.type === "attraction" && m.subject === 7 && m.text.includes("Burger Bar 1") && m.text.includes("and 1 more stall"), "ride subject: " + m.text);
}

// Location packing matches NewsItem.cpp: x low 16 bits, y high 16.
ok(packLocation(0x120, 0x340) === (0x340 * 65536 + 0x120), "packLocation");
ok(plural(1, "a", "b") === "1 a" && plural(2, "a", "b") === "2 b", "plural");

// Every phrasebook line is non-empty and ticker-sized for n = 1..5.
for (const book of [TRASH_PHRASES, BUILDER_PHRASES, WTO_PHRASES, EXTRAS_PHRASES, MECHANIC_PHRASES, MARKETING_PHRASES]) {
    for (const [kind, f] of Object.entries(book)) {
        for (let n = 1; n <= 5; n++) {
            for (const line of f(n, "Wooden Roller Coaster 1")) ok(line.length > 10 && line.length < 200, kind + " length " + line.length + ": " + line);
        }
    }
}

console.log(`news: ${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
