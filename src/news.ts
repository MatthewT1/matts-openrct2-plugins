/**
 * Park news summaries (#124): a short, slightly odd ticker message about what a plugin did.
 *
 * Events are tallied during the day with `add` and turned into one digest per plugin by
 * `flush` at the start of the next interval.day. The digests then go on a shared board
 * (park-news.ts) where `pickHeadlines` keeps the most important few across ALL plugins, so
 * a busy day is still at most NEWS_PER_DAY ticker messages.
 *
 * The ticker keeps 11 recent items (NewsItem.h:125, ItemHistoryStart) and 50 archived,
 * so a quiet digest matters more than completeness.
 *
 * Subjects (ScPark.cpp:410-435, NewsItem.cpp:220-290): "attraction" takes a ride id and
 * opens the ride window; "peep" takes an entity id; "blank" takes a packed map position
 * (x in the low 16 bits, y in the high 16, both in coords) and scrolls the view there.
 *
 * The voice: a deadpan park bulletin. Lead with the fact (what was built, who was hired),
 * then one small, harmless oddity at the end of the line. Humour research agrees on the
 * shape: a norm broken just a little and safely (benign violation), concrete detail over
 * vague whimsy, the surprise last. Staff and objects get odd inner lives; guests are never
 * the butt of it.
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

/** Ticker messages per day across all plugins together. */
export const NEWS_PER_DAY = 2;

/**
 * How newsworthy each kind is; the board keeps the highest first. A new stall or guard is
 * news; a sacking or a few benches is filler. Unlisted kinds are 1.
 */
export const PRIORITY: Record<string, number> = {
    stall: 3, guardHired: 3, started: 3,
    rush: 2, hired: 2, entertainerHired: 2, completed: 2,
    fired: 1, entertainerFired: 1, amenities: 1, queueTvs: 1,
};

/** Kinds that only make the news in bulk: 1 bench is not a story, 4 are. */
export const MIN_COUNT: Record<string, number> = { amenities: 4, queueTvs: 3 };

export interface NewsOptions {
    /** Shown before the text, e.g. "Trash Manager". */
    plugin: string;
    enabled(): boolean;
    phrases: Phrasebook;
    /** Hands the day's digest on (to the shared board in game), with its priority. */
    post(msg: NewsPost, priority: number): void;
    count?(name: string, n?: number): void;
    /** 0 <= r < 1. Math.random in game; fixed in tests. */
    rand?(): number;
}

export interface News {
    /** Notes one event. The first name/subject seen for a kind that day is the one shown. */
    add(kind: string, name?: string, subject?: NewsSubject): void;
    /** Hands on today's digest (if any, and if enabled) and clears it. Returns it. */
    flush(): NewsPost | null;
}

/** Packs a map position the way NewsItem.cpp:279-281 unpacks a "blank" subject. */
export function packLocation(x: number, y: number): number {
    return ((x & 0xFFFF) | ((y & 0xFFFF) << 16)) >>> 0;
}

/** "1 handyman" / "3 handymen": the singular or plural after the number. */
export function plural(n: number, one: string, many: string): string {
    return n + " " + (n === 1 ? one : many);
}

/**
 * The `max` items to publish: highest priority first, ties broken at random so no plugin
 * owns the ticker. Returns [chosen, dropped].
 */
export function pickHeadlines<T extends { priority: number }>(items: T[], max: number, rand: () => number): [T[], T[]] {
    const keyed = items.map(function (it) { return { it, r: rand() }; });
    keyed.sort(function (a, b) { return b.it.priority - a.it.priority || a.r - b.r; });
    const sorted = keyed.map(function (k) { return k.it; });
    return [sorted.slice(0, max), sorted.slice(max)];
}

const TAILS = [
    (k: number): string => " (Plus " + plural(k, "other bit", "other bits") + " of busywork.)",
    (k: number): string => " It also did " + plural(k, "other thing", "other things") + ", but was very modest about it.",
    (k: number): string => " (" + plural(k, "further deed", "further deeds") + " went unreported. Allegedly.)",
    (k: number): string => " Other business: " + plural(k, "item", "items") + ", all minuted, none read.",
];

interface Tally { n: number; name: string; subject: NewsSubject | undefined; }

export function createNews(opts: NewsOptions): News {
    const rand = opts.rand !== undefined ? opts.rand : Math.random;
    let order: string[] = [];
    let tallies: Record<string, Tally> = {};
    // Last line used per kind, so the same joke never runs twice in a row.
    const lastLine: Record<string, string> = {};

    function clear(): void {
        order = [];
        tallies = {};
    }

    function pickLine(kind: string, lines: string[]): string {
        let options = lines.filter(function (l) { return l !== lastLine[kind]; });
        if (options.length === 0) options = lines;
        const line = options[Math.floor(rand() * options.length) % options.length];
        lastLine[kind] = line;
        return line;
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

        flush(): NewsPost | null {
            if (order.length === 0) return null;
            if (!opts.enabled()) {
                if (opts.count) opts.count("newsMuted");
                clear();
                return null;
            }
            // Filler that didn't reach its bulk threshold is dropped, not saved up.
            const kinds = order.filter(function (k) { return tallies[k].n >= (MIN_COUNT[k] || 1); });
            if (kinds.length === 0) {
                if (opts.count) opts.count("newsTooSmall");
                clear();
                return null;
            }
            // Lead with the most newsworthy kind; the first added wins a tie.
            let lead = kinds[0];
            for (const k of kinds) if ((PRIORITY[k] || 1) > (PRIORITY[lead] || 1)) lead = k;
            const t = tallies[lead];
            const phrase = opts.phrases[lead];
            let text = phrase !== undefined
                ? pickLine(lead, phrase(t.n, t.name))
                : "Did " + plural(t.n, "thing", "things") + ".";
            const rest = kinds.length - 1;
            if (rest > 0) text += TAILS[Math.floor(rand() * TAILS.length) % TAILS.length](rest);

            const msg: NewsPost = { type: "blank", text: opts.plugin + ": " + text };
            const s = t.subject;
            if (s !== undefined) {
                msg.type = s.type;
                msg.subject = s.type === "blank" ? packLocation(s.x, s.y) : s.id;
            }
            clear();
            try {
                opts.post(msg, PRIORITY[lead] || 1);
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
/** "Excalibur's", but "Grimble's Gallopers'" (no second s). */
export const possessive = (name: string): string => name + (/s$/i.test(name) ? "'" : "'s");
const benches = (n: number): string => plural(n, "bench or bin", "benches and bins");
const tvs = (n: number): string => plural(n, "queue TV", "queue TVs");

export const TRASH_PHRASES: Phrasebook = {
    hired: (n) => [
        "Hired " + hm(n) + ". Each was issued one broom, one dustpan and a strongly worded pamphlet about crisps.",
        hm(n) + " joined the crew. Early reports suggest they enjoy sweeping slightly too much.",
        hm(n) + " started today. Orientation covered brooms, bins and how to look quietly disappointed at a wrapper.",
        "Recruited " + hm(n) + " straight from the Log Flume queue. Damp, but willing.",
        "Hired " + hm(n) + ". HR notes that one of them has already named the litter.",
    ],
    fired: (n) => [
        "Let " + hm(n) + " go. Litter levels have been judged \"acceptably crunchy\".",
        hm(n) + " retired to a quiet life of not picking things up.",
        "Sent " + hm(n) + " home. The bins have been told to cope, and have not responded.",
        hm(n) + " handed back their brooms. The brooms seemed relieved.",
    ],
};

export const MECHANIC_PHRASES: Phrasebook = {
    hired: (n) => [
        "Hired " + mech(n) + ". They arrived already holding spanners, which is either reassuring or suspicious.",
        mech(n) + " now on duty, humming softly at the roller coasters to keep them calm.",
        "Took on " + mech(n) + ". One asked where the big red button is. Nobody told them.",
        mech(n) + " joined. Their first act was to tighten a bolt that was, in fairness, fine.",
        "Hired " + mech(n) + ". Qualifications: spanner, torch, and an unshakeable belief that it's the gearbox.",
    ],
    fired: (n) => [
        "Let " + mech(n) + " go. The rides have promised to behave.",
        mech(n) + " left to pursue their dream of fixing slightly smaller things.",
        "Released " + mech(n) + " back into the wild. They were last seen oiling a swing.",
        mech(n) + " clocked off for good. The Ferris wheel waved. Probably.",
    ],
};

export const EXTRAS_PHRASES: Phrasebook = {
    entertainerHired: (n) => [
        "Sent " + ent(n) + " to cheer up a grumpy queue. Morale is up; dignity is holding.",
        "Hired " + ent(n) + ". The costume smells faintly of candyfloss and ambition.",
        ent(n) + " now waving at guests who did not ask to be waved at.",
        "Deployed " + ent(n) + " to the queues. It is surprisingly hard to stay cross at a panda.",
        "Hired " + ent(n) + ". They have been told the head does not come off in public. Ever.",
    ],
    entertainerFired: (n) => [
        ent(n) + " hung up the costume. The panda head is in storage, facing the wall.",
        "Let " + ent(n) + " go. The queues must now entertain themselves. They are not good at it.",
        ent(n) + " took off the costume. Several children are still processing this.",
    ],
    guardHired: () => [
        "Hired a security guard. They have already made meaningful eye contact with three benches.",
        "A security guard now patrols the park, mostly guarding the concept of benches.",
        "Hired a security guard. Vandals report feeling \"watched\" and then \"judged\", in that order.",
    ],
};

export const BUILDER_PHRASES: Phrasebook = {
    stall: (n, name) => [
        "Built " + name + more(n, "stall") + " right where guests were milling about looking wistful.",
        "Opened " + name + more(n, "stall") + ". Nobody asked how it knew. It just knew.",
        name + more(n, "stall") + " appeared overnight. The guests act as if it was always there.",
        "Opened " + name + more(n, "stall") + ". Planning permission was granted by a pigeon, who seemed qualified.",
        name + more(n, "stall") + " is open. The first customer was a handyman on their break, which counts.",
    ],
    amenities: (n) => [
        "Placed " + benches(n) + ". Guests are already using them in an eerily coordinated way.",
        "Scattered " + benches(n) + " about. The local pigeons have been notified.",
        "Installed " + benches(n) + ". Each one was named. You will never know the names.",
        "Put down " + benches(n) + ". The benches face the rides; the bins face their responsibilities.",
    ],
    queueTvs: (n) => [
        "Bolted " + tvs(n) + " onto the queues. Today's programme: a documentary about queues.",
        tvs(n) + " installed. Guests now watch other guests wait. It is extremely popular.",
        "Fitted " + tvs(n) + ". Ratings are strong among people with nowhere else to be.",
    ],
};

export const WTO_PHRASES: Phrasebook = {
    rush: (n, name) => [
        possessive(name) + " queue was swelling like a soufflé, so the trains now leave sooner" + more(n, "ride") + ".",
        "Told " + name + " to stop dawdling at the station" + more(n, "ride") + ". The queue has been informed.",
        possessive(name) + " queue got long" + more(n, "ride") + ", so the operator was handed a coffee and a stopwatch.",
        name + " is on rush-hour timing" + more(n, "ride") + ". The trains have been asked to leave with purpose.",
    ],
};

export const MARKETING_PHRASES: Phrasebook = {
    started: (_n, name) => [
        "Started " + name + ". The leaflets are printed on paper that is almost entirely not soup.",
        "Launched " + name + ". A person in a sandwich board is walking along the motorway, and they mean business.",
        "Started " + name + ". The jingle is catchy, legally distinct and stuck in the accountant's head.",
    ],
    completed: (_n, name) => [
        name + " has finished. The leftover leaflets are now a bench cushion.",
        name + " wrapped up. The blimp has been deflated and folded into a very large sock drawer.",
        name + " is over. The sandwich board has been returned, slightly damper than before.",
    ],
};
