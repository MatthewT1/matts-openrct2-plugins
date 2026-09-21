/**
 * Guest thought aggregation — OpenRCT2 plugin
 *
 * WHY THIS MODULE EXISTS:
 *   `needs.ts` clusters guests by *stat* (hunger, thirst, toilet, nausea), sampled off a
 *   rotating window of guests each pass. Every one of those guests also carries a list of
 *   `PeepThought`s — free-text-ish complaints the game itself already generates ("Queue
 *   line for X is too long", "I can't afford this"). This module aggregates the thoughts
 *   from that same sample so a caller can report what guests are actually complaining
 *   about right now, as an early-warning signal: thoughts pile up and change tone well
 *   before a park-rating drop shows up in the aggregate rating number.
 *
 * WHY A SEPARATE CATEGORY SCHEME FROM `needs.ts`:
 *   Needs are numeric stats with source-verified thresholds; thoughts are a fixed
 *   105-way-ish enum the game hands out directly, no threshold judgement involved. The
 *   two modules are complementary lenses (stat trending badly vs. guest already
 *   complaining about it) rather than one built on the other.
 *
 * THE *_MUCH SUFFIX TRAP:
 *   Every purchasable-item thought type has a sibling ending in `_much`
 *   ("I've got too much of this already") that means the OPPOSITE of the plain item
 *   thought ("I'd like this"). Several item names themselves contain underscores
 *   (`hot_dog`, `ice_cream`, `toffee_apple`, `sub_sandwich`, `hot_chocolate`, `iced_tea`,
 *   `funnel_cake`, `beef_noodles`, `fried_rice_noodles`, `wonton_soup`, `meatball_soup`,
 *   `fruit_juice`, `soybean_milk`, `roast_sausage`), so naively splitting on the first or
 *   last underscore cannot separate "item" from "item variant" reliably. The suffix test
 *   (`type` ends with the literal string `"_much"`) is checked first, before any lookup,
 *   so it is applied uniformly regardless of how many underscores the item name has.
 *
 * PERFORMANCE CONTRACT:
 *   `add()` is called once per thought per sampled guest — hundreds of times per pass. It
 *   must do only a string suffix check, one object property lookup (the category table)
 *   and at most one more property lookup/store per matched bucket — no intermediate
 *   arrays, no allocation once a category bucket already exists. `top()`, `problems()`
 *   and `reset()` run once per pass and may allocate/sort freely.
 *
 * WHY A FLAT OBJECT LOOKUP INSTEAD OF IF/ELSE:
 *   125 thought types is too many branches for a readable if/else chain, and a chain
 *   pays average-case linear-scan cost per call on the hot path. A single object literal
 *   keyed by the raw thought type string is one hash lookup regardless of how many types
 *   exist — QuickJS-NG has no JIT to optimise a long if/else into a jump table anyway.
 */

/** How a raw `ThoughtType` string is grouped for reporting. */
export type ThoughtCategory =
    | "cleanliness" // bad_litter, path_disgusting, vandalism
    | "safety" // not_safe, drowning
    | "queue" // queuing_ages, crowded
    | "pricing" // bad_value, cant_afford_ride, cant_afford_item, not_paying, spent_money, running_out
    | "needs" // hungry, thirsty, toilet, tired
    | "sickness" // sick, very_sick, sickening, intense
    | "navigation" // lost, cant_find, cant_find_exit, help, get_out, get_off
    | "leaving" // go_home
    | "positive" // was_great, good_value, very_clean, scenery, fountains, music, wow, wow2, new_ride, here_we_are, watched
    | "wants_item" // the item thoughts: balloon, drink, burger, ... (NOT the *_much variants)
    | "has_too_many" // every *_much variant
    | "other"; // anything else, including the deprecated values

/**
 * Categories that indicate a problem the player can act on. `wants_item`/`has_too_many`
 * are sales signals, not park-quality problems, and `positive`/`other` obviously are not
 * either, so none of those four are included here.
 */
export const PROBLEM_CATEGORIES: ThoughtCategory[] = [
    "cleanliness",
    "safety",
    "queue",
    "pricing",
    "needs",
    "sickness",
    "navigation",
    "leaving",
];

/** Suffix marking a "guest has too many of this item" thought; see file header. */
const MUCH_SUFFIX = "_much";

/**
 * Category lookup for every non-`_much` `ThoughtType` value. A type not present here
 * (including any `_much` value, which is intercepted before this table is consulted)
 * categorises as `"other"`.
 */
const CATEGORY_BY_TYPE: Record<string, ThoughtCategory> = {
    // pricing
    cant_afford_ride: "pricing",
    spent_money: "pricing",
    bad_value: "pricing",
    cant_afford_item: "pricing",
    not_paying: "pricing",
    running_out: "pricing",

    // sickness
    sick: "sickness",
    very_sick: "sickness",
    intense: "sickness",
    sickening: "sickness",

    // leaving
    go_home: "leaving",

    // positive
    good_value: "positive",
    was_great: "positive",
    scenery: "positive",
    very_clean: "positive",
    fountains: "positive",
    music: "positive",
    wow: "positive",
    wow2: "positive",
    watched: "positive",
    new_ride: "positive",
    here_we_are: "positive",

    // safety
    drowning: "safety",
    not_safe: "safety",

    // navigation
    lost: "navigation",
    cant_find: "navigation",
    cant_find_exit: "navigation",
    get_off: "navigation",
    get_out: "navigation",
    help: "navigation",

    // needs
    tired: "needs",
    hungry: "needs",
    thirsty: "needs",
    toilet: "needs",

    // queue
    queuing_ages: "queue",
    crowded: "queue",

    // cleanliness
    bad_litter: "cleanliness",
    path_disgusting: "cleanliness",
    vandalism: "cleanliness",

    // wants_item — purchasable-item thoughts. Their *_much siblings are handled by the
    // suffix check in categoriseThought() and deliberately do not appear here.
    balloon: "wants_item",
    toy: "wants_item",
    map: "wants_item",
    photo: "wants_item",
    umbrella: "wants_item",
    drink: "wants_item",
    burger: "wants_item",
    chips: "wants_item",
    ice_cream: "wants_item",
    candyfloss: "wants_item",
    pizza: "wants_item",
    popcorn: "wants_item",
    hot_dog: "wants_item",
    tentacle: "wants_item",
    hat: "wants_item",
    toffee_apple: "wants_item",
    tshirt: "wants_item",
    doughnut: "wants_item",
    coffee: "wants_item",
    chicken: "wants_item",
    lemonade: "wants_item",
    photo2: "wants_item",
    photo3: "wants_item",
    photo4: "wants_item",
    pretzel: "wants_item",
    hot_chocolate: "wants_item",
    iced_tea: "wants_item",
    funnel_cake: "wants_item",
    sunglasses: "wants_item",
    beef_noodles: "wants_item",
    fried_rice_noodles: "wants_item",
    wonton_soup: "wants_item",
    meatball_soup: "wants_item",
    fruit_juice: "wants_item",
    soybean_milk: "wants_item",
    sujongkwa: "wants_item",
    sub_sandwich: "wants_item",
    cookie: "wants_item",
    roast_sausage: "wants_item",

    // other — not actionable, and not covered by any bucket above. Includes the
    // deprecated values, which the game may still emit for old saves.
    more_thrilling: "other",
    havent_finished: "other",
    already_got: "other",
    not_hungry: "other",
    not_thirsty: "other",
    not_while_raining: "other",
    nice_ride_deprecated: "other",
    excited_deprecated: "other",
};

/**
 * Maps a raw `ThoughtType` string to its `ThoughtCategory`. Never throws — an
 * unrecognised value (including a future game addition this module has not been updated
 * for) falls back to `"other"` rather than crashing the caller's sampling pass.
 */
export function categoriseThought(type: string): ThoughtCategory {
    // Checked first, and by suffix rather than any split, so item names that themselves
    // contain underscores (hot_dog, ice_cream, ...) never get misread as the base item.
    if (type.length > MUCH_SUFFIX.length && type.indexOf(MUCH_SUFFIX, type.length - MUCH_SUFFIX.length) !== -1) {
        return "has_too_many";
    }
    const category = CATEGORY_BY_TYPE[type];
    return category === undefined ? "other" : category;
}

/** Aggregated count for one category in a sampling pass. */
export interface ThoughtTally {
    category: ThoughtCategory;
    count: number;
    /** Most common raw thought type in this category, for a specific report line. */
    topType: string;
    topTypeCount: number;
}

export interface ThoughtAccumulator {
    /**
     * Records one thought. `freshness` is the API's value — LOWER means fresher.
     * Only thoughts at or below `maxFreshness` are counted; stale ones are ignored.
     */
    add(type: string, freshness: number): void;
    /** Tallies sorted by count descending. */
    top(n: number): ThoughtTally[];
    /** Problem-category tallies only, sorted by count descending. */
    problems(n: number): ThoughtTally[];
    /** Total thoughts recorded (after the freshness filter). */
    total(): number;
    reset(): void;
}

interface CategoryBucket {
    category: ThoughtCategory;
    count: number;
    /** Per-raw-type counts within this category; a plain object, keyed by ThoughtType. */
    types: Record<string, number>;
}

/**
 * @param maxFreshness Thoughts with a freshness above this are ignored.
 */
export function createThoughtAccumulator(maxFreshness: number): ThoughtAccumulator {
    let buckets: Record<string, CategoryBucket> = {};
    let total = 0;

    function add(type: string, freshness: number): void {
        if (freshness > maxFreshness) return;

        const category = categoriseThought(type);
        let bucket = buckets[category];
        if (bucket === undefined) {
            bucket = { category: category, count: 0, types: {} };
            buckets[category] = bucket;
        }

        bucket.count++;
        const previous = bucket.types[type];
        bucket.types[type] = previous === undefined ? 1 : previous + 1;
        total++;
    }

    /** Turns one bucket into a ThoughtTally, picking its most common raw type. Allocates. */
    function toTally(bucket: CategoryBucket): ThoughtTally {
        const typeKeys = Object.keys(bucket.types);
        let topType = typeKeys[0];
        let topTypeCount = bucket.types[topType];
        for (let i = 1; i < typeKeys.length; i++) {
            const key = typeKeys[i];
            const count = bucket.types[key];
            if (count > topTypeCount) {
                topType = key;
                topTypeCount = count;
            }
        }
        return {
            category: bucket.category,
            count: bucket.count,
            topType: topType,
            topTypeCount: topTypeCount,
        };
    }

    function tallies(): ThoughtTally[] {
        const keys = Object.keys(buckets);
        const results: ThoughtTally[] = [];
        for (let i = 0; i < keys.length; i++) {
            results.push(toTally(buckets[keys[i]]));
        }
        return results;
    }

    function top(n: number): ThoughtTally[] {
        if (n <= 0) return [];
        const results = tallies();
        results.sort((a, b) => b.count - a.count);
        return results.length > n ? results.slice(0, n) : results;
    }

    function problems(n: number): ThoughtTally[] {
        if (n <= 0) return [];
        const results = tallies().filter((tally) => PROBLEM_CATEGORIES.indexOf(tally.category) !== -1);
        results.sort((a, b) => b.count - a.count);
        return results.length > n ? results.slice(0, n) : results;
    }

    function reset(): void {
        buckets = {};
        total = 0;
    }

    return {
        add,
        top,
        problems,
        total: () => total,
        reset,
    };
}

/** Plain-language label for a category, used by `describeThoughts`. */
function categoryLabel(category: ThoughtCategory): string {
    if (category === "cleanliness") return "Cleanliness complaints";
    if (category === "safety") return "Safety complaints";
    if (category === "queue") return "Queue complaints";
    if (category === "pricing") return "Pricing complaints";
    if (category === "needs") return "Unmet needs";
    if (category === "sickness") return "Sickness complaints";
    if (category === "navigation") return "Navigation trouble";
    if (category === "leaving") return "Guests wanting to leave";
    if (category === "positive") return "Positive thoughts";
    if (category === "wants_item") return "Item demand";
    if (category === "has_too_many") return "Oversold items";
    return "Other thoughts";
}

/** One-line human-readable summary of a tally, for the in-game console. */
export function describeThoughts(tally: ThoughtTally, sampledGuests: number): string {
    const label = categoryLabel(tally.category);
    const guestWord = tally.count === 1 ? "guest" : "guests";
    const share = sampledGuests > 0 ? Math.round((tally.count / sampledGuests) * 100) : 0;

    return (
        label + ": " + tally.count + " " + guestWord + " (" + share + "% of sampled)" +
        " - most common: \"" + tally.topType + "\" (" + tally.topTypeCount + ")"
    );
}
