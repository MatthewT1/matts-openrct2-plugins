# Marketing Campaigns — Verified Reference

Compiled 2026-09-20 for the proposed `marketing-manager` plugin. Every fact below is
tagged **Source-verified** (checked against the local OpenRCT2 clone in `gamesrc/`,
file and line cited) or **Community consensus** (forum opinion, may be wrong). Same
discipline as [research.md](research.md) and [api-reference.md](api-reference.md):
check here before assuming anything, and note where community claims disagree with
source.

Authoritative source: `gamesrc/OpenRCT2/src/openrct2/management/Marketing.cpp`,
`Marketing.h`, `actions/park/ParkMarketingAction.cpp`,
`world/Park.cpp` (`generateGuests`, `calculateGuestGenerationProbability`),
`openrct2-ui/windows/NewCampaign.cpp`.

---

## The six campaign types

**Source-verified** (`Marketing.cpp:28-35`, money already converted from money64 tenths
to real GBP — `_GBP` multiplies by 10, `core/Money.hpp:27`, the same gotcha this
project already tracks in [api-reference.md](api-reference.md#units-and-encodings)):

| # | Type | £/week | Base guest-gen probability (of 65536, rolled every tick) |
|---|---|---|---|
| 0 | `PARK_ENTRY_FREE` — free entry voucher | £50 | 400 |
| 1 | `RIDE_FREE` — free ride voucher | £50 | 300 |
| 2 | `PARK_ENTRY_HALF_PRICE` — half-price entry voucher | £50 | 200 |
| 3 | `FOOD_OR_DRINK_FREE` — free food/drink voucher | £50 | 200 |
| 4 | `PARK` — general park advertising | **£350** | 250 |
| 5 | `RIDE` — ride-specific advertising | **£200** | 200 |

- **Cost is a single lump sum charged at start** — `weeks * pricePerWeek`
  (`ParkMarketingAction.cpp:95-98`), not billed weekly. Query-then-execute already
  reports insufficient funds correctly: affordability is checked generically by the
  game-action framework right after `Query()` returns ok
  (`GameActionRunner.cpp:186-196`, `FinanceCheckAffordability`), the same pattern this
  project already relies on everywhere else.
- **Duration**: the action itself accepts 1-255 weeks (`ParkMarketingAction.cpp:50`),
  but the game's own UI caps the spinner at **2-12 weeks**, defaulting to 2
  (`NewCampaign.cpp:191,249,253` — RCT2's original cap was 6; OpenRCT2 raised it to
  12). Treat 2-12 as the sane range; nothing in source suggests going higher is ever
  worthwhile.
- **Guest generation mechanic**: every single game tick (~40/sec at 1x speed, ~537
  ticks per in-game day per this project's own verified figure), for every ACTIVE
  campaign: `if (ScenarioRandMax(65536) < probability) generateGuestFromCampaign(...)`
  (`Park.cpp:228-237`). This is a flat, continuous roll for the campaign's entire
  duration — not a one-time burst.

---

## Three findings that should drive every design decision below

### 1. Voucher campaigns are 5-13x more cost-effective per guest than paid advertising

Expected extra guests/week ≈ `(ticks/week) * (probability/65536)`, at ~3,759
ticks/week (7 days * ~537 ticks/day):

| Type | Guests/week (est.) | Cost/week | £ per extra guest |
|---|---|---|---|
| Free park entry | ~23 | £50 | **£2.18** |
| Free ride | ~17 | £50 | £2.90 |
| Half-price entry / free food | ~12 | £50 | £4.35 |
| Ride advertising | ~12 | £200 | £17.39 |
| **General park advertising** | ~14 | £350 | **£24.50** |

General park advertising is the single worst value per guest despite being the most
expensive campaign in the game. **Community consensus agrees, independently**: a
GOG.com RCT1/2 forum post (2017, Seraphim5683) reports "coupons for free
rides/drinks or entry to the park" as most effective while "general advertising of
the park or a particular ride" showed no significant change — matching this
arithmetic exactly, without either source citing the other.

### 2. Three campaigns have a hidden ÷8 penalty nowhere documented in community guides

**Source-verified** (`Marketing.cpp:60-77`):

| Campaign | Penalty condition | Effect |
|---|---|---|
| `PARK_ENTRY_FREE` | `park.entranceFee < £4.00` | probability ÷ 8 |
| `PARK_ENTRY_HALF_PRICE` | `park.entranceFee < £6.00` | probability ÷ 8 |
| `RIDE_FREE` | `ride.price[0] < £0.30` | probability ÷ 8 |

Running one of these three on a park/ride that's already cheap wastes 7/8 of the
money for almost nothing (e.g. free-entry drops from 400 to 50 — worse than every
other campaign type). **Must check `park.entranceFee` / `ride.price[0]` before ever
recommending these three.** No community source mentions this at all; it can only be
known from source.

### 3. Marketing has no crowding brake — unlike organic guest generation

**Source-verified.** Organic generation (`calculateGuestGenerationProbability`,
`Park.cpp:163-213`) cuts to 1/4 once `guests > suggestedGuestMaximum`, and to 1/16 if
the scenario's `difficultGuestGeneration` flag is set. The campaign loop
(`Park.cpp:228-237`) has **no equivalent check at all** — it keeps rolling at full
probability regardless of how far over capacity the park already is. Running any
campaign on an already-crowded park adds guests with nothing to stop it, directly
worsening queues/crowding.

`park.suggestedGuestMaximum` and `park.guestGenerationProbability` are both readable
(`openrct2.d.ts:4429,4436` — the d.ts comment independently confirms the tick-rate
math above: *"guests per second = 40 * (guestGenerationProbability / 65535)"*).

**Refinement (2026-09-20, found while writing Phase 1's logging):** the d.ts's own
comment on `suggestedGuestMaximum` says *"in scenarios with difficult guest
generation, guests will not spawn above this value **without advertisements**"* —
meaning the game's own design intends marketing to be the way past the soft cap in
a `difficultGuestGeneration` scenario. So a flat "never recommend above
`suggestedGuestMaximum`" rule would fight the game's own intended mechanic in that
specific scenario type. The underlying finding still holds — campaigns genuinely
have zero throttle, unlike organic generation's graceful ÷4 — the guard just needs
to be more targeted than a blanket cap: read `park.getFlag("difficultGuestGeneration")`
and treat crossing `suggestedGuestMaximum` as expected/fine there, but as a real
warning sign everywhere else. Phase 2 should also cross-check existing
queue/crowding telemetry (`queues.ts`, `needs.ts`) rather than `suggestedGuestMaximum`
alone, since that is the more direct signal of "the park can't actually absorb more
guests right now."

**Second refinement (2026-09-20, user-caught):** `suggestedGuestMaximum` has nothing
to do with the scenario's win condition at all. Source-verified —
`calculateSuggestedMaxGuests` (`Park.cpp:103-160`) sums each open, non-broken ride's
`BonusValue` (plus a difficult-generation bonus for high-quality tested rides); it
never reads the scenario objective. So on a scenario whose objective is
`"guestsBy"` or `"guestsAndRating"` with a guest target higher than what the current
ride roster organically supports, a plugin that refuses to market past
`suggestedGuestMaximum` would actively fight the player's own win condition.
`scenario.objective.guests` and `scenario.objective.type` are both readable globals
(`openrct2.d.ts:39,4693-4716`). **The effective ceiling Phase 2 uses is
`max(suggestedGuestMaximum, objective.guests)` when the objective type is
guest-related, not `suggestedGuestMaximum` alone.**

---

## The hard constraint that shapes the whole design

**There is no way to read active campaigns from the plugin API.** Confirmed absent
from `openrct2.d.ts` and the `ScPark.cpp` scripting bindings (`park.marketingCampaigns`
does not exist in either). No list, no remaining weeks, no "is one running right now."
This is the exact same write-only shape as `Ride::operationOption` in `ops.ts` — the
plugin must track every campaign it starts (type, ride/item id, start day, weeks)
entirely in its own park storage.

Two consequences of that blindness, both source-verified:

- **`MarketingNewCampaign` overwrites, it does not stack or extend**
  (`Marketing.cpp:252-264`). Starting a campaign of a type that's already active
  resets its `weeksLeft` to the new value rather than adding to it. Re-firing a
  "renewal" while one is still running silently throws away the remaining weeks of
  the old one. The plugin must track remaining weeks itself and only renew once its
  own count reaches zero.
- **`MarketingCancelCampaignsForRide` cancels automatically on ride demolition**
  (`Marketing.cpp:266-279`) — a plugin has no way to observe this happening. It must
  re-verify (daily) that a ride it started a `RIDE`/`RIDE_FREE` campaign for still
  exists, the same "re-fetch after actions that might invalidate state" rule this
  project already applies to stale staff ids
  (see [NOTES.md](../NOTES.md) hard-won gotchas).

### Multiple campaigns run concurrently — there is no "one at a time" limit

**Source-verified, user-caught (2026-09-20).** `park.marketingCampaigns` is a plain
list; `MarketingNewCampaign` only overwrites an entry of the *same* type
(`Marketing.cpp:252-264`), and `Park.cpp:228-237` loops over every entry in the list
independently each tick — nothing checks how many other campaigns are already
running. `Finances.cpp:661-678` confirms this at the UI level too: each of the 6
campaign types gets its own independent start button/slot. The only real ceiling is
**one active campaign per type**, i.e. up to 6 concurrently, not one overall.

This changes the shape of the recommendation function: picking a single "best"
campaign and ignoring the rest leaves cheap, independent guest-generation on the
table. Since vouchers are only £50/week each and their guest-generation rolls are
fully independent and additive, running several eligible voucher types at once is
straightforwardly better than running just the single cheapest one, as long as cash
and the crowding guard still allow it. `marketing.ts` should rank *all* eligible,
not-yet-active campaigns and let the caller decide how many to start (gated by
total cash committed and the shared crowding guard), not just return one winner.

### Eligibility gates — C++-only, not exposed, must be replicated

`MarketingIsCampaignTypeApplicable` (`Marketing.cpp:186-238`) is never bound to the
scripting API. A plugin must reproduce its logic from readable state:

| Campaign | Requirement | How to check from a plugin |
|---|---|---|
| `PARK_ENTRY_FREE` / `PARK_ENTRY_HALF_PRICE` | Entrance fee "unlocked" | `park.getFlag("unlockAllPrices") \|\| !park.getFlag("freeParkEntry")` (`Park.cpp:752-763`) |
| `RIDE_FREE` | Ride prices unlocked, AND an open ride exists | same flag logic (`Park.cpp:739-`) + `map.rides.some(r => r.classification === "ride" && r.status === "open")` |
| `RIDE` | An open ride exists | as above, no price-unlock requirement |
| `FOOD_OR_DRINK_FREE` | An open food or drink stall exists | `map.rides.some(r => r.classification === "stall" && r.status === "open" && (r.type === 28 \|\| r.type === 30))` |
| `PARK` | None | always applicable |

Also check **`park.getFlag("forbidMarketingCampaigns")`** before attempting anything —
directly readable (`ScPark.cpp:37`), and some scenarios forbid marketing outright.
`ParkMarketingAction::Query` itself checks this and returns
`STR_MARKETING_CAMPAIGNS_FORBIDDEN_BY_LOCAL_AUTHORITY` if so, but checking it locally
avoids the round trip and matches this project's existing pattern of pre-filtering
before `queryAction` (see `unlockedFacilityObject` in `trash-manager.ts`).

### Scripting API surface, confirmed

```
context.queryAction("parkmarketing", { type, item, duration }, callback)
context.executeAction("parkmarketing", { type, item, duration }, callback)
```

`ParkMarketingArgs` (`@openrct2/types`): `{ type: number; item: number; duration: number }`.
`item` is the ride id for `RIDE_FREE`/`RIDE`, or the shop item index for
`FOOD_OR_DRINK_FREE` (see `ShopItem.h`), ignored otherwise.

---

## Community consensus explicitly checked and discarded

A Steam Community thread ("What is the point of marketing/advertising?") calling
marketing "broken/nonfunctional" and citing a "Fame Rank" / VIP mechanic is for
**RollerCoaster Tycoon World** — an unrelated 2016 Atari/Nvizzio game with no such
mechanic in RCT2 or OpenRCT2. Flagging explicitly so this doesn't get mistaken for
RCT2 consensus later; it was surfaced by search and initially looked relevant by
title alone.

---

## Sources

### Official / source
- `gamesrc/OpenRCT2/src/openrct2/management/Marketing.cpp` / `Marketing.h`
- `gamesrc/OpenRCT2/src/openrct2/actions/park/ParkMarketingAction.cpp` / `.h`
- `gamesrc/OpenRCT2/src/openrct2/world/Park.cpp` (guest generation, `EntranceFeeUnlocked`, `RidePricesUnlocked`)
- `gamesrc/OpenRCT2/src/openrct2-ui/windows/NewCampaign.cpp` (UI week bounds)
- `gamesrc/OpenRCT2/src/openrct2/scripting/bindings/world/ScPark.cpp` (flag map, confirms no campaign read access)
- `node_modules/@openrct2/types/openrct2.d.ts` (`ParkMarketingArgs`, `park.suggestedGuestMaximum`, `park.guestGenerationProbability`, `park.getFlag`, `Ride.price`)

### Community
- [RCT 1/2 Advertising Strategies — GOG.com forum](https://www.gog.com/forum/rollercoaster_tycoon_series/rct_12_advertising_strategies) (vouchers > general ads, matches arithmetic above)
- ~~Steam Community: "What is the point of marketing/advertising?"~~ — discarded, wrong game (RCT World, not RCT2/OpenRCT2)
