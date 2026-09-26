/**
 * Park news summaries (#124): a short, slightly odd ticker message about what a plugin did.
 *
 * Events are tallied during the day with `add` and posted by `flush` from the plugin's
 * interval.day handler, so a plugin posts at most one message per day however busy it
 * was. The first kind added leads the message; any other kinds become a "plus N" tail.
 *
 * The ticker keeps 11 recent items (NewsItem.h:125, ItemHistoryStart) and 50 archived,
 * so a quiet digest matters more than completeness.
 *
 * Subjects (ScPark.cpp:410-435, NewsItem.cpp:220-290): "attraction" takes a ride id and
 * opens the ride window; "peep" takes an entity id; "blank" takes a packed map position
 * (x in the low 16 bits, y in the high 16, both in coords) and scrolls the view there.
 *
 * Pure: the game's postMessage is passed in, so this runs under node in tests.
 */

export type NewsSubject =
    | { type: "attraction"; id: number }
    | { type: "peep"; id: number }
    | { type: "blank"; x: number; y: number };

/** What `park.postMessage` takes (ParkMessageDesc). */
export interface NewsPost {
    type: "attraction" | "peep" | "blank";
    text: string;
    subject?: number;
}

/** For each event kind: the variants to pick from, given the day's count and a name. */
export type Phrasebook = Record<string, (n: number, name: string) => string[]>;

export interface NewsOptions {
    /** Shown before the text, e.g. "Trash Manager". */
    plugin: string;
    enabled(): boolean;
    phrases: Phrasebook;
    post(msg: NewsPost): void;
    count?(name: string, n?: number): void;
}

export interface News {
    /** Notes one event. The first name/subject seen for a kind that day is the one shown. */
    add(kind: string, name?: string, subject?: NewsSubject): void;
    /** Posts today's digest (if any, and if enabled) and clears it. Returns what was posted. */
    flush(day: number): NewsPost | null;
}

/** Packs a map position the way NewsItem.cpp:279-281 unpacks a "blank" subject. */
export function packLocation(x: number, y: number): number {
    return ((x & 0xFFFF) | ((y & 0xFFFF) << 16)) >>> 0;
}

/** "1 handyman" / "3 handymen": the singular or plural after the number. */
export function plural(n: number, one: string, many: string): string {
    return n + " " + (n === 1 ? one : many);
}

const TAILS = [
    (k: number): string => " (Plus " + plural(k, "other bit", "other bits") + " of busywork.)",
    (k: number): string => " It also did " + plural(k, "other thing", "other things") + ", but was very modest about it.",
    (k: number): string => " (" + plural(k, "further deed", "further deeds") + " went unreported. Allegedly.)",
];

/** Deterministic choice: the same day and event give the same line, so tests can pin it. */
function pick<T>(items: T[], seed: number): T {
    return items[((seed % items.length) + items.length) % items.length];
}

interface Tally { n: number; name: string; subject: NewsSubject | undefined; }

export function createNews(opts: NewsOptions): News {
    let order: string[] = [];
    let tallies: Record<string, Tally> = {};

    function clear(): void {
        order = [];
        tallies = {};
    }

    return {
        add(kind: string, name?: string, subject?: NewsSubject): void {
            const t = tallies[kind];
            if (t === undefined) {
                order.push(kind);
                tallies[kind] = { n: 1, name: name !== undefined ? name : "", subject };
                return;
            }
            t.n++;
            if (t.subject === undefined && subject !== undefined) {
                t.subject = subject;
                if (name !== undefined) t.name = name;
            }
        },

        flush(day: number): NewsPost | null {
            if (order.length === 0) return null;
            if (!opts.enabled()) {
                if (opts.count) opts.count("newsMuted");
                clear();
                return null;
            }
            const lead = order[0];
            const t = tallies[lead];
            const phrase = opts.phrases[lead];
            let text = phrase !== undefined
                ? pick(phrase(t.n, t.name), day + t.n)
                : "Did " + plural(t.n, "thing", "things") + ".";
            const rest = order.length - 1;
            if (rest > 0) text += pick(TAILS, day)(rest);

            const msg: NewsPost = { type: "blank", text: opts.plugin + ": " + text };
            const s = t.subject;
            if (s !== undefined) {
                msg.type = s.type;
                msg.subject = s.type === "blank" ? packLocation(s.x, s.y) : s.id;
            }
            clear();
            try {
                opts.post(msg);
                if (opts.count) opts.count("newsPosted");
            } catch (e) {
                if (opts.count) opts.count("newsPostFailed");
                return null;
            }
            return msg;
        },
    };
}

// --- Phrasebooks. Kept here so the voice stays consistent across plugins. ---

const hm = (n: number): string => plural(n, "handyman", "handymen");
const mech = (n: number): string => plural(n, "mechanic", "mechanics");
const ent = (n: number): string => plural(n, "entertainer", "entertainers");
const more = (n: number, what: string): string => n > 1 ? " (and " + plural(n - 1, "more " + what, "more " + what + "s") + ")" : "";

export const TRASH_PHRASES: Phrasebook = {
    hired: (n) => [
        "Hired " + hm(n) + ". Each was issued one broom and a stern talking-to about crisps.",
        hm(n) + " joined the crew. Early reports suggest they enjoy sweeping slightly too much.",
        "Recruited " + hm(n) + " straight from the Log Flume queue. Damp, but willing.",
    ],
    fired: (n) => [
        "Let " + hm(n) + " go. Litter levels have been judged \"acceptably crunchy\".",
        hm(n) + " retired to a quiet life of not picking things up.",
        "Sent " + hm(n) + " home early. The bins have been told to cope.",
    ],
};

export const MECHANIC_PHRASES: Phrasebook = {
    hired: (n) => [
        "Hired " + mech(n) + ". They arrived already holding spanners, which is either reassuring or suspicious.",
        mech(n) + " now on duty, humming softly at the roller coasters to keep them calm.",
        "Took on " + mech(n) + ". One asked where the big red button is. Nobody told them.",
    ],
    fired: (n) => [
        "Let " + mech(n) + " go. The rides have promised to behave.",
        mech(n) + " left to pursue their dream of fixing slightly smaller things.",
        "Released " + mech(n) + " back into the wild. They were last seen oiling a swing.",
    ],
};

export const EXTRAS_PHRASES: Phrasebook = {
    entertainerHired: (n) => [
        "Sent " + ent(n) + " to cheer up a grumpy queue. Morale is up; dignity is holding.",
        "Hired " + ent(n) + ". The costume smells faintly of candyfloss and ambition.",
        ent(n) + " now waving at guests who did not ask to be waved at.",
    ],
    entertainerFired: (n) => [
        ent(n) + " hung up the costume. The panda head is in storage, facing the wall.",
        "Let " + ent(n) + " go. The queues will have to entertain themselves. They are not good at it.",
    ],
    guardHired: () => [
        "Hired a security guard. They have already made meaningful eye contact with three benches.",
        "A security guard now patrols the park, mostly guarding the concept of benches.",
    ],
};

export const BUILDER_PHRASES: Phrasebook = {
    stall: (n, name) => [
        "Built " + name + more(n, "stall") + " right where guests were milling about looking wistful.",
        "Opened " + name + more(n, "stall") + ". Nobody asked how it knew. It just knew.",
        name + more(n, "stall") + " has appeared overnight. The guests act as if it was always there.",
    ],
    amenities: (n) => [
        "Placed " + plural(n, "bench or bin", "benches and bins") + ". Guests are already using them in an eerily coordinated way.",
        "Scattered " + plural(n, "bench or bin", "benches and bins") + " about. The local pigeons have been notified.",
        plural(n, "new bench or bin", "new benches and bins") + " installed. Each one was named. You will never know the names.",
    ],
    queueTvs: (n) => [
        "Bolted " + plural(n, "TV", "TVs") + " onto the queues. Today's programme: a documentary about queues.",
        plural(n, "queue TV", "queue TVs") + " installed. Guests now watch other guests wait. It is extremely popular.",
    ],
};

export const WTO_PHRASES: Phrasebook = {
    rush: (n, name) => [
        name + "'s queue was swelling like a soufflé, so the trains now leave sooner" + more(n, "ride") + ".",
        "Told " + name + " to stop dawdling at the station" + more(n, "ride") + ". The queue has been informed.",
        name + "'s queue got long" + more(n, "ride") + ", so the operator was handed a coffee and a stopwatch.",
    ],
};

export const MARKETING_PHRASES: Phrasebook = {
    started: (_n, name) => [
        "Started " + name + ". The leaflets are printed on paper that is almost entirely not soup.",
        "Launched " + name + ". A person in a sandwich board is walking along the motorway, and they mean business.",
    ],
    completed: (_n, name) => [
        name + " has finished. The leftover leaflets are now a bench cushion.",
        name + " wrapped up. The blimp has been deflated and folded into a very large sock drawer.",
    ],
};
