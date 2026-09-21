# Marketing Manager — Build Plan

Status: **Phases 0-5 done (Phase 5 called good on a confounded-but-positive result). Phase 6 (auto-run) built and deployed, awaiting live verification.** This is the step-by-step plan for a new `marketing-manager`
plugin, built the same way every other feature in this project was: instrument first,
advise second, act only once measurement proves it's worth acting on. Facts and
numbers referenced throughout are from [marketing-research.md](marketing-research.md)
— check there before changing any threshold below.

Tick items off as we go. Each phase has an explicit exit criterion; we do not move to
the next phase until the current one's criterion is met.

---

## Phase 0 — Scaffolding ✅ done (2026-09-20)

Goal: a plugin that builds, deploys, and loads in-game doing nothing observable.

- [x] Add `src/marketing-manager.ts` entry point with `registerPlugin()` (name,
      version, licence, `targetApiVersion: 87`, matching every other plugin's
      metadata shape)
- [x] Add `"marketing-manager"` to the `plugins` array in `rollup.config.js`
- [x] Add empty `src/marketing.ts` pure module (no game globals) with a placeholder
      exported function and `tests/marketing.test.mjs` with one trivial passing test,
      matching the project's "add a test when you add a decision" rule from day one
- [x] `node tests/run.mjs` passes, `tsc --noEmit` clean, `rollup` builds and deploys,
      plugin appears in the in-game menu

**Exit criterion:** met — confirmed live by user, plugin appears in the menu with an empty window.

---

## Phase 1 — Instrumentation only ✅ done (2026-09-20)

Goal: confirm the readable state this plugin depends on looks sane on a real park,
*before* writing any decision logic against it.

- [x] Read and log via the debug channel (same pattern as the other three plugins):
      `park.cash`, `park.guests`, `park.suggestedGuestMaximum`,
      `park.guestGenerationProbability`, `park.entranceFee`,
      `park.getFlag("forbidMarketingCampaigns")`, `park.getFlag("unlockAllPrices")`,
      `park.getFlag("freeParkEntry")`, plus `park.getFlag("difficultGuestGeneration")`
      (added after the first Phase-2 refinement below)
- [x] Log open rides' `price[0]` and count of open food/drink stalls (ride types 28,
      30), restating `trash-manager.ts`'s source-verified constants since it doesn't
      export them
- [x] Played a session with Diagnostics on; confirmed in `tools/rct-debug.log`:
      - `entranceFee: 400` (raw units) = £40, well above both penalty thresholds on
        this park
      - **every open ride priced at £0** — a real park that charges entrance-only,
        which fully triggers the RIDE_FREE ÷8 penalty for every ride, confirming the
        penalty check isn't a hypothetical edge case
      - `guests` (817→842) already above `suggestedGuestMaximum` (802, flat) with
        `difficultGuestGeneration: false` — a live example of the crowding case

**Exit criterion:** met. Also caught a real unit bug before it shipped: Phase 0's
threshold constants were in real pounds, but `park.entranceFee`/`ride.price[0]` come
back in raw tenths — fixed before Phase 2 used them.

---

## Phase 2 — Pure decision module ✅ done (2026-09-20)

Goal: `src/marketing.ts` decides *what campaign, if any, is worth starting right now*
— given plain data, no game globals, fully unit-testable.

- [x] Define `MarketingSignals` input type: `cash`, `cashFloor`, `guests`,
      `suggestedGuestMaximum`, `guestCountObjective`, `difficultGuestGeneration`,
      `entranceFee`, `entranceFeeUnlocked`, `ridePricesUnlocked`,
      `openRidePrices: {id, price}[]`, `hasOpenFoodOrDrinkStall`, `forbidden`, and
      `activeWeeksRemaining` (from the plugin's own tracked state, since the game
      won't report it — see marketing-research.md's write-only-campaigns section).
      Added `guestCountObjective`/`difficultGuestGeneration` beyond the original plan
      after two refinements found while building this phase (see below).
- [x] Cost-effectiveness ranking is computed live per park (`recommendCampaign`),
      not a fixed table — a park's actual entrance fee/ride prices change which
      campaign is cheapest per guest via the ÷8 penalties, so the ranking has to be
      recomputed against THIS park's numbers, not assumed from the base table.
- [x] Implemented: the five eligibility gates, the two ÷8 penalty checks (including
      picking the best-priced ride for `RIDE_FREE` rather than the first one), the
      crowding guard, a cash floor, and "never re-recommend an active campaign."
- [x] `tests/marketing.test.mjs`: 33 tests, covering every item originally listed
      here plus the two refinements below.

**Two refinements found while building this phase, both now source-verified and
baked into `marketing-research.md`:**
1. `park.entranceFee` / `ride.price[0]` are in **raw tenths of a pound**, not real
   pounds — the Phase 0 threshold constants were in real pounds and needed
   correcting before this phase could be trusted at all.
2. `suggestedGuestMaximum` has no relationship to the scenario's win condition
   (source: `calculateSuggestedMaxGuests`, `Park.cpp:103-160`, sums ride bonus
   values only). The crowding guard now uses
   `max(suggestedGuestMaximum, scenario.objective.guests)` when the objective is
   guest-count-related, and is bypassed entirely under `difficultGuestGeneration`
   per that flag's own documented intent.

**Exit criterion:** met. Module compiles standalone, 33/33 tests pass (370/370
project-wide), and the cheap-entrance-fee test case (`entranceFee < £4`) walks
through the exact £/guest arithmetic from marketing-research.md and correctly
demotes free-entry below free-food/drink — by hand: 50÷8=6.25→2.9 guests/wk→£17.44/guest
vs free-food's unpenalised 200→11.5 guests/wk→£4.36/guest.

---

## Phase 3 — Advisory UI, no spending ✅ done (2026-09-20)

Goal: prove the ranking logic reads live game state correctly and produces sane
advice, before it's allowed to touch money.

- [x] Wired `marketing.ts`'s `rankCampaigns()` into `marketing-manager.ts`'s
      `interval.day` handler, computing the full ranked list daily from live state
- [x] Window shows the **whole ranked list** (not just one pick) in a listview —
      each eligible campaign with its £/guest and item, or the single
      `blockedReason` when a hard gate (forbidden/cash/crowded) rules everything out
      at once
- [x] No `queryAction`/`executeAction` calls anywhere in this file — advisory only,
      `activeWeeksRemaining` is hardcoded empty since nothing can be started until
      Phase 4
- [x] The ranked list and `blockedReason` are also logged to telemetry (`park.rankedCampaigns`/`park.blockedReason`), not just shown in the window, so Phase 3's exit criterion can be checked from `tools/rct-debug.log` too

**One more thing found and fixed while wiring this up:** `entranceFeeUnlocked` and
`ridePricesUnlocked` looked like they should reuse the same flag check, but source
says otherwise (`Park.cpp:739-763`) — ride prices are force-unlocked when entry is
*free* (`unlockAllPrices || freeParkEntry`), while entrance-fee control is unlocked
when entry is *not* free (`unlockAllPrices || !freeParkEntry`). Using one flag for
both would have wrongly gated `RIDE_FREE` off on exactly the park type (free entry)
where it's the only paid campaign left worth running. Implemented as two distinct
expressions in `buildSignals()`.

**Exit criterion: met, confirmed live (2026-09-20).** `rankedCampaigns` matches the
predicted £/guest table almost exactly (£2.18/£4.36/£4.36/£17.43/£24.41 vs
predicted £2.18/£4.35/£4.35/£17.39/£24.50). `RIDE_FREE` is correctly absent
entirely — this park has `unlockAllPrices: false` and `freeParkEntry: false`, so
`ridePricesUnlocked` is false, matching the real in-game restriction. And the
scenario-objective refinement is validated for real, not just in tests: this park's
objective is `guestsBy` 2500, `suggestedGuestMaximum` is only 937, guests sat at 963
— campaigns kept being recommended because the effective ceiling correctly resolved
to 2500, not 937. Without that fix this plugin would have refused to help reach the
park's own win condition from here on.

---

## Phase 4 — Manual start, with tracking ✅ done and verified live (2026-09-20)

Goal: actually start a campaign, on a button press, with full state tracking — no
auto-run yet. **Multiple campaigns can be started independently** — starting one
does not disable the others; only starting a *second* of the same type would
overwrite the first (blocked already by Phase 2's `activeWeeksRemaining` check).

- [x] `context.queryAction("parkmarketing", ...)` then `executeAction`, same
      query-first pattern as every other action in this project; checks
      `result.error` on both the query refusal and the execute failure and counts
      each separately (`campaignStartRefused` / `campaignStartFailed`)
- [x] Tracks `{ item, daysRemaining }` **per type** in park storage
      (`activeCampaigns`) on successful start — days rather than weeks, so it can be
      aged down once per `interval.day` with no separate week-boundary detector
- [x] Daily upkeep (`upkeepCampaigns`): decrements each tracked entry independently;
      for `RIDE`/`RIDE_FREE` re-verifies `map.getRide(item) !== null` first and drops
      the entry (counted as `campaignCancelledRideDemolished`) if the ride is gone,
      before ever decrementing it
- [x] One row per campaign type (fixed order, not the ranked order, so widget names
      stay stable across days) with its own "Start" button — disabled and captioned
      "not eligible" / the block reason when not eligible, "running, Nw left" when
      already tracked, or its live £/guest when startable. A shared weeks spinner
      (2-12, defaulting to `MIN_WEEKS`) sets the duration for whichever button is
      pressed.
- [x] `FOOD_OR_DRINK_FREE`'s shop item (deferred in Phase 2) is now resolved at
      start time via `ride.object.shopItem` on the first open food/drink stall found
      — source-verified field, not guessed

**Exit criterion: met, confirmed live (2026-09-20).** All 5 eligible campaign types
were started in one session (`campaignStarted: 5`); `RIDE_FREE` correctly never
appeared as startable (structurally ineligible on this park). All 5 track
independently with distinct, sensible countdowns (two at 38 days from a 6-week
start, three at 11 days from a 2-week start). `rankedCampaigns` correctly emptied to
`[]` with `blockedReason: "no eligible campaign right now"` once everything eligible
was already running - the exact behaviour the crowding/eligibility/already-active
gates were designed to produce. Cash dropped by an amount consistent with the
expected lump sums plus normal running costs over the same days (not pinned to the
exact penny from telemetry alone, but the cost deduction itself runs through the
same generic game-action path already proven correct everywhere else in this
project).

---

## Phase 5 — Before/after attribution (the actual proof-of-value gate) — built, awaiting a full cycle of data

Goal: does starting a campaign measurably increase guest arrivals on **this park**,
beyond organic growth already in progress? This is the exit criterion that decides
whether Phase 6 gets built at all.

- [x] `createAttributionTracker()` in `marketing.ts` records daily park-wide guest
      counts unconditionally (`observe`), independent of whether any campaign is
      running — the baseline every before/after comparison is measured against
- [x] Every campaign start freezes a `before` reading immediately
      (`recordStart`) and recomputes `after` daily going forward — reusing
      `queues.ts`'s exact shape **and its fix**: `before` is captured once at
      record time and never recomputed from trimmed history, the same real bug
      found and fixed in `queues.ts` earlier this session, built in from day one
      here instead of being discovered twice. 55 tests cover this, including one
      that pushes far more history through the tracker than its internal window
      keeps, to prove `before` stays frozen regardless.
- [x] Wired into `marketing-manager.ts`: `attribution.observe()` every
      `interval.day`, `attribution.recordStart()` on every successful campaign
      start, `campaignAttribution` logged to telemetry with both raw guests/day
      figures and the delta
- [x] **Fixed live (2026-09-20), same session it was caught in.** The tracker and
      `dayCounter` are persisted to park storage (`snapshot()`/restore, 4 new
      tests), not kept in memory only. The in-memory design was modelled on
      `queues.ts`'s equivalent, which is fine there because its evidence only
      needs to survive a few days — it does not fit a campaign's full 2-12 week
      run across realistic, frequent reloads. Measured cost of not fixing this
      immediately: 5 of the first 7 campaigns started this session lost their
      evidence to a reload before their "after" window ever completed.
- [x] Played through a cycle — 4 campaigns started together day 22, ride ads day
      23. Result: guests/day rose 1637-1642 → 1678-1686 (+41 to +44/day).
- [x] Compared against the marketing-research.md prediction: naive combined
      estimate for these 5 types at full effectiveness is ~10 guests/day; observed
      was ~4x that.

**Exit criterion: called, not cleanly met.** The result is directionally positive
but confounded three ways, all recorded here rather than glossed over: (1) all 5
campaigns started together, so the delta can't be attributed to any one type; (2)
the park's ride roster grew from 11 to 15 over the same window
(`suggestedGuestMaximum` 802→1032), so organic growth is mixed into the same
number; (3) the tracker compares guest *stock* (`park.guests`), not arrival *rate*,
so a sustained inflow increase compounds into a larger-looking level shift rather
than a clean delta. A properly isolated single-campaign test on a park not
simultaneously growing its ride roster would answer this cleanly — that was
offered and explicitly declined in favour of proceeding to Phase 6 on the
directionally-positive result as-is (2026-09-20). Worth revisiting if Phase 6's
own field data ever looks off.

---

## Phase 6 — Auto-run ✅ built (2026-09-20), awaiting live verification

Goal: closed-loop marketing, off by default, same shape as adaptive staffing.

- [x] `autoStartCampaigns()` walks the ranked list top-down (best £/guest first),
      not just the single top entry — several types can run concurrently, so
      stopping after one leaves cheap, independent guest generation on the table
      on a park eligible for more than one
- [x] Spends up to `AUTO_CASH_BUDGET_PER_PASS` (£2,000/day, starting point only,
      not yet measured against a real session) per `interval.day` pass, and
      separately never spends below `MARKETING_MIN_CASH`'s reserve — both tracked
      explicitly since `rankCampaigns`'s own cash-floor check guarantees a
      *surplus* exists, not that any one candidate's lump sum fits inside it
- [x] Never starts a second campaign of an already-active type (inherited free
      from `rankCampaigns` already excluding active types from the ranked list)
- [x] "Auto-manage" checkbox, off by default, tooltip states the exact budget and
      reserve figures rather than vague language
- [x] Telemetry: `autoManage` flag, `autoStarted`, `autoSkippedBudget`,
      `autoSkippedCashFloor` counters — every skip path is countable, not silent

**Exit criterion:** typechecked, 396/396 tests pass, deployed. Ready for you to
enable "Auto-manage" and confirm live: campaigns start on their own within budget,
respect the reserve floor, never duplicate an active type, and the £2,000/day
budget figure isn't wildly wrong for how this park actually spends (adjust
`AUTO_CASH_BUDGET_PER_PASS` if it is).

**Not yet done (nice-to-have, not blocking):** update `README.md` /
`docs/user-guide.md` with this plugin and its toggles, matching every other
plugin's documentation. Worth doing once the auto-run figures are confirmed sane
live rather than before.

**Exit criterion:** a full session with auto-run on shows sensible campaign
selection, respects every guard from Phase 2, and the before/after telemetry from
Phase 5's tracker keeps confirming a real effect rather than degrading over time.

---

## Out of scope for now

- Reading the six campaign-name news strings or matching in-game news events — not
  needed for decision-making, `MarketingRaiseFinishedNotification` is a C++-internal
  detail with no plugin hook.
- Anything to do with the `neverendingMarketing` cheat — irrelevant to a legitimate
  plugin.
- Multiplayer considerations beyond what `context.executeAction`'s existing
  synchronous-in-singleplayer behavior already implies elsewhere in this project.
