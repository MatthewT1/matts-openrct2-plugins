# OpenRCT2 Plugin Research Reference

> Compiled 2026-09-19 from web research conducted by four AI research subagents (litter & handyman strategies; staffing & cleanliness deep mechanics; ride & staff settings consensus; mechanic optimization & wait times/queues). All community claims are **unverified opinion** unless explicitly marked "Source-verified." This document is intended as a durable reference for building the `trash-manager`, `mechanic-manager`, `wait-time-optimizer`, and `path-connector` plugins.

## How to use this document

Skim the table of contents and jump to the section relevant to the plugin you're touching. Each fact is tagged **Source-verified** (confirmed against OpenRCT2 C++ source, GitHub issues, or official wiki/API docs) or **Community consensus** (forum/wiki/Steam-guide opinion, which may vary or conflict). Where reports disagreed, look for the ⚠️ **Contradiction** callout rather than trusting a single number — do not silently pick a side when implementing defaults; consider making the value configurable.

## Table of Contents

- [Park Rating Formula](#park-rating-formula)
- [Litter & Cleanliness](#litter--cleanliness)
- [Handyman Staffing & Patrol Zones](#handyman-staffing--patrol-zones)
- [Litter Bins](#litter-bins)
- [Guest Behaviour (disgust, thoughts, vandalism, vomit)](#guest-behaviour-disgust-thoughts-vandalism-vomit)
- [Mechanics, Reliability & Inspections](#mechanics-reliability--inspections)
- [Ride Operation & Queues](#ride-operation--queues)
- [Known Bugs Relevant to Plugin Behaviour](#known-bugs-relevant-to-plugin-behaviour)
- [Contradictions Summary](#contradictions-summary)
- [Sources](#sources)

---

## Park Rating Formula

**Source-verified** (from `OpenRCT2/src/openrct2/world/Park.cpp`, cross-referenced with the OpenRCT2 forums' reverse-engineering guide):

- Base rating: **1150 points** (**1050** in "difficult" scenarios).
- Final rating is clamped to **0–999**.

| Factor | Range | Detail |
|---|---|---|
| Guest count | -150 to +3 | `min(2000, guestCount) / 13`, subtracted from 150 |
| Guest happiness | -500 to +250 (net) | Formula counts guests with happiness > 128/255 as "happy"; bonus = `2 * min(250, (happyCount * 300) / totalGuests)`. >~83% happy guests yields the max bonus. |
| Lost guests | uncapped | First 25 guests who leave: no penalty. Each additional lost guest: **-7 points**. |
| Ride uptime | -200 to 0 | 0% uptime = -200; 100% uptime = 0. |
| **Litter** | **0 to -600** | See [Litter & Cleanliness](#litter--cleanliness) below. |
| Ride excitement total | -200 to 0 | Both total excitement and total intensity across rides must exceed 1000 (80.0 each) to avoid penalty. |
| Ride excitement average | -100 to 0 | Target average: 46 excitement / 65 intensity points. |
| Deaths — drowning | -25 per guest | Uncapped. |
| Deaths — crash | -200 per incident | Capped at -500 total (in money-based parks). |

Litter (up to -600) and happiness (up to ±500/+250) are the two largest single levers in the formula; litter can erase most of the gains from a happy, high-uptime park if left unmanaged.

---

## Litter & Cleanliness

**Source-verified** litter penalty formula (from `Park.cpp`):

```
result -= 600 - (4 * (150 - min(150, litterCount)))
```

- Each qualifying litter item costs **-4 rating points**.
- The penalty caps at **-600 points**, reached at **150 qualifying litter items**.
- **Only litter aged 7680+ ticks counts** toward the penalty — freshly dropped litter has a grace period before it hurts rating (in correctly patched OpenRCT2). **Correction (2026-09-20):** this was originally logged here as "~5 in-game minutes," which is wrong on two counts — it's ~192 real seconds at 1x speed (7680 / 40 ticks/sec), and in *in-game* time, at ~528-546 ticks/day, that's **~14.5 in-game days**. See [performance.md](performance.md#field-measurements) and [api-reference.md](api-reference.md#time) for the corrected, source-verified figure; this lag is exactly why the staffing controller in `staffing.ts` does not react to `oldLitter` directly.

**Source-verified bugs affecting this formula** (see also [Known Bugs](#known-bugs-relevant-to-plugin-behaviour)):
- A vanilla-RCT2-era bug reversed the age-check subtraction (`litter->creationTick - gCurrentTicks >= 7680` instead of `gCurrentTicks - litter->creationTick >= 7680`), causing unsigned integer underflow that made nearly all litter count as "old" immediately, even freshly dropped litter. Carried into early OpenRCT2, later fixed ([GitHub #15567](https://github.com/OpenRCT2/OpenRCT2/issues/15567)).
- A separate regression in OpenRCT2 v0.3.5 broke litter penalty application differently; also subsequently corrected ([GitHub #20209](https://github.com/OpenRCT2/OpenRCT2/issues/20209)).
- **Practical implication for plugin logic:** don't assume litter always penalizes instantly — check which OpenRCT2 version/build the target is running if precise reproduction of the penalty timing matters.

**Community consensus:** litter is considered the single most controllable rating factor, and "overstaffing is better than understaffing" for handymen is the dominant philosophy for keeping it in check.

---

## Handyman Staffing & Patrol Zones

**Community consensus — wide disagreement, no single accepted ratio.** Present the full range; do not silently pick one value as a plugin default without making it configurable.

| Source | Ratio | Context |
|---|---|---|
| rct.wiki "Guests and Staff" | 1 handyman per 15–20 path tiles | General baseline |
| CoasterBuzz forum | 1 handyman per 6 path spaces (12 if double-wide) | Intensive/dense coverage |
| Steam starter guide | +2 handymen per 3 rides built | Ride-based ratio, not path-based |
| Advanced Staff AI Manager plugin default | 1 handyman per 100 guests | Plugin's automation default |
| Steam community rule of thumb | 1 handyman per 10 "blue squares" | Alternate path-tile framing |
| Dense/high-traffic parks | 8–10 patrol squares per handyman | For truly clean paths |
| Sparse parks | up to 15 patrol squares per handyman | Without guest complaints |
| Ride & staff settings synthesis | 1-per-10 to 1-per-15 path tiles | Called out as more typical than 1-per-25 |

A CoasterBuzz forum thread concluded outright that "there's so many potential path setups that it's impossible to create a hard, fast rule." One anecdote: a player raised handyman count from 37 to 55 in the Magic Mountain scenario and park rating rose from the low 600s to consistently upper 800s — illustrative, not a formula.

**Patrol zone sizing — Community consensus:**
- Small, defined patrol zones strongly outperform full-park roaming/unzoned handymen — cited across every source.
- **8–10 patrol squares** for dense areas; up to **15** for sparse areas (myrct Tumblr).
- **5–6 patrol zones per handyman** (CoasterBuzz pragmatic recommendation).
- Advanced Staff AI Manager plugin default: **15-tile zones with 2-tile overlap**, grid-covering the park.
- Keep **2 free-roaming handymen** as overflow/buffer for coverage gaps (myrct Tumblr; repeated by the staffing-mechanics report as general best practice) — this is presented as the *only* sanctioned use of unzoned staff.
- Recommended zoning strategy: 10–15 tile zones generally, tightened to **8–10 tiles** in food-court areas and near high-nausea ride exits.

**Source-verified (game mechanics):**
- Vanilla RCT2 patrol zones are defined in **4×4 tile blocks**.
- OpenRCT2 allows arbitrary custom patrol areas for finer control — use this instead of the default 4×4 grid where precision matters.
- Handyman cost: **$35/month** (RCT1), **$55/month** (RCT2).
- Default handyman tasks: Sweep Paths, Empty Bins, Water Gardens. **Mow Grass is unchecked by default in RCT2** — a deliberate change from RCT1.

**Community consensus — grass mowing:** Always leave mowing disabled unless specifically needed. In RCT1, mowing-enabled handymen prioritized mowing over path sweeping, generating major player complaints — this is why RCT2 ships with it off by default. Handymen can also become stuck if roof tiles fall inside their patrol area (they climb onto roofs and get stranded, leaving real paths dirty).

**Known handyman pathfinding problems (Community consensus, cross-referenced with GitHub issues):**
- Handymen can get stuck oscillating near litter they cannot path to (e.g., litter visible across a queue-line barrier) — the path "becomes absolutely disgusting" while the handyman does nothing ([GitHub #7947](https://github.com/OpenRCT2/OpenRCT2/issues/7947), [#3205](https://github.com/OpenRCT2/OpenRCT2/issues/3205), [#18023](https://github.com/OpenRCT2/OpenRCT2/issues/18023), [forum #3474](https://forums.openrct2.org/topic/3474-handymen-can-get-stuck-when-heading-toward-litter/)).
- Double-wide paths create more pathfinding edge cases where handymen stall.
- Well-sized patrol zones partially mitigate oscillation bugs by limiting how far a stuck handyman can wander.

---

## Litter Bins

**Source-verified:**
- Bins can be placed on any path **except queue lines**.
- A full bin no longer accepts trash; guests who would have used it litter on the path instead.
- A vandalized/broken bin cannot collect trash (see feedback loop under [Guest Behaviour](#guest-behaviour-disgust-thoughts-vandalism-vomit)).
- Early OpenRCT2 builds had a bug where bins filled after a **single item** ([GitHub #1860](https://github.com/OpenRCT2/OpenRCT2/issues/1860)); this was fixed to slow the fill rate, though the exact new capacity value isn't documented in the public issue thread.
- Vanilla RCT2 has a **visual-only bug**: bins don't appear to accumulate garbage even though the internal fill counter works correctly. OpenRCT2 fixed the visual display.

**Community consensus — placement:**
- **Near food/drink stalls** is the universal #1 rule (every source agrees).
- **Near bathrooms** — secondary priority (guests dispose of drink cups there).
- **Near high-nausea ride exits** — food packaging litter spikes after nauseated guests discard items.
- Cluster food stalls into **"food courts"** with dense bin/bench placement, rather than scattering stalls.
- Keep bins within roughly **4–6 tiles** of a major food stall.
- Bins are cheap — "you cannot have too many"; treat them as a force multiplier that reduces required handyman sweep frequency.
- A forum feature-request proposal (not validated best practice) suggested bins on every diagonal path tile and every 8th straight tile.

---

## Guest Behaviour (disgust, thoughts, vandalism, vomit)

**Source-verified / documented mechanics:**
- Guests walking through paths with significant litter/vomit accumulation enter a **"disgusted" mood state**, distinct from generic low happiness.
- Disgusted guests' happiness decays faster than normal.
- Disgusted guests are the **primary source of vandalism** (attacking benches, lamp posts, litter bins).
- Ways out of the disgusted state: ride an enjoyable attraction, calm down naturally after a few minutes, or vandalize something.
- **Feedback loop:** litter → guest disgust → vandalism → broken bin → more litter accumulates near that bin → more disgust.
- **Second feedback loop:** unhappy guests are more likely to litter instead of seeking a bin, so a park getting dirty makes guests litter more, compounding the problem.
- Guests with happiness above **128/255 (~50%)** count as "happy" for the park-rating bonus.
- No specific numerical litter-count-per-tile threshold for triggering the disgust thought is publicly documented outside the source code; reported practical behavior is that even a moderate concentration on one tile triggers it.
- Vanilla RCT2 had a bug where guests on sloped paths could not vomit or litter there; fixed in OpenRCT2 so litter/vomit now applies to all path types ([GitHub #26756](https://github.com/OpenRCT2/OpenRCT2/issues/26756)).

**Vomit mechanics — Source-verified/documented:**
- High nausea (guest skin turns green) triggers a vomit event on the guest's current path tile, functioning like litter for disgust/rating purposes.
- First Aid rooms reduce nausea and can prevent vomiting.
- **Rain does not wash away vomit or litter in vanilla RCT2**, and OpenRCT2 has no native rain-cleaning mechanic either — confirmed by the existence of the third-party plugin `openrct2-rain-cleans-vomit` (adds a probabilistic chance for rain to clean vomit), whose existence implies the base mechanic is absent in both vanilla and OpenRCT2.
- The only native way to remove vomit is a handyman sweeping the tile.

**Community consensus — vomit management:**
- Place **benches near nausea-heavy ride exits**; seated guests recover nausea faster, reducing vomit events.
- Place **First Aid rooms** near rides with nausea rating above roughly **7.0–7.5**.
- Avoid placing food stalls near high-nausea rides (guests eating around intense rides vomit more).
- Assign smaller, tighter handyman patrol zones around high-nausea ride exits for faster cleanup response.
- Vomit is considered the **harder problem** vs. food litter because it's generated continuously and unpredictably (a single ride can cascade), while food litter scales roughly with guest count and is easier to plan for with bins.

---

## Mechanics, Reliability & Inspections

**Source-verified:**
- The scripting API does **not** expose a "trigger inspection now" action — inspection timing is game-AI-driven based on the ride's `inspectionInterval` property, which scripts *can* read/set. The `openrct2-ride-inspection-manager` plugin works this way (sets the interval, doesn't force inspections).
- A known bug ([GitHub #7030](https://github.com/OpenRCT2/OpenRCT2/issues/7030)) lets reliability overflow above 100% (up to 250%+) on very old, long-uninspected rides, which paradoxically reduces breakdowns temporarily. This is a bug to avoid exploiting, not a strategy.
- A known bug ([GitHub #5284](https://github.com/OpenRCT2/OpenRCT2/issues/5284)) allows mechanics to be dispatched outside their patrol zone for repairs, even though inspections require the mechanic to already be in range.
- Guest queue behavior: guests begin complaining after **5 minutes** of queuing and **leave the queue at 15 minutes** regardless of entertainment — documented wiki-sourced hardcoded thresholds.
- Queue length does **not** currently affect whether guests choose to join a queue in OpenRCT2 — confirmed as a known missing feature, not implemented behavior ([GitHub Discussion #16841](https://github.com/OpenRCT2/OpenRCT2/discussions/16841)). Satisfaction is driven purely by elapsed wait time once queued.
- OpenRCT2 changed guest patience vs. vanilla RCT2: in vanilla, guests with entertainers/TVs nearby would wait indefinitely; in OpenRCT2 they still leave after ~15 minutes even with entertainers present. Strategies ported from vanilla-RCT2 guides assuming infinite patience are invalidated.

⚠️ **Contradiction — do shorter inspection intervals slow reliability decay?**
- **Position A (mechanic-optimization report):** "Shorter inspection cycles actively slow reliability decay; there is no documented threshold percentage — the mechanic inspections are the lever, not a threshold to watch." Cites the RCT fandom wiki's explicit recommendation of 10-minute intervals for coasters (default is 30 minutes, described as too long).
- **Position B (ride & staff settings report):** An OpenRCT2 forum thread specifically investigating this topic "found no evidence that shorter intervals improve reliability outcomes meaningfully." Mechanics restore up to 25% of lost reliability *per inspection* — shorter intervals let this happen more often, but do not change the underlying reliability decay rate itself. This report frames "10 minutes for everything" as a habitual economic choice (trading mechanic travel time), not a proven optimum, and notes 20–30 minute intervals are accepted for replaceable flat rides.
- **Resolution: RESOLVED from C++ source (2026-09-19).** Both positions are partly right, and each gets the mechanism or the conclusion wrong.

  **Source-verified:** decay is `unreliabilityAccumulator = ride.unreliabilityFactor + getAgePenalty(ride)`, applied as `ride.reliability -= unreliabilityAccumulator` (`Ride.cpp:1132`). **There is no inspection term** — the decay rate is completely independent of the inspection interval, so Position A's stated mechanism is wrong.

  Restore is `ride.reliability += reliabilityIncreaseFactor * ((100 - reliabilityPercentage) / 2)` (`Ride.cpp:4443`, in `RideFixBreakdown`) — a proportion of reliability *already lost*, which matches Position B's description.

  **But** because each inspection triggers a restore, more frequent inspections do raise *average* reliability over time. So Position B's conclusion ("no meaningful benefit") is too strong, while Position A's conclusion ("shorter is better") happens to be right for the wrong reason.

  **Practical takeaway:** short intervals are worth keeping; the cost is mechanic travel time, not decay. See [api-reference.md](api-reference.md#reliability-decay-vs-restore) for the full code paths.

  Two related source findings: decay is skipped entirely while a ride is `closed`/`simulating` or already broken (`Ride.cpp:1120-1123`), and a ride's inspection interval **resets to default whenever its construction window is opened** ([#25601](https://github.com/OpenRCT2/OpenRCT2/issues/25601)) — which is why periodically re-applying intervals is load-bearing rather than redundant.

**Community consensus — mechanic-to-ride ratios (wide disagreement):**

| Source | Ratio | Notes |
|---|---|---|
| Advanced Staff AI Manager plugin / general automation default | 1 mechanic per 10 rides | Practical default; some players use 1-per-ride for coasters specifically |
| myrct Tumblr guide | ~1 per 7 rides | Plus 2–3 rides of overlap between adjacent mechanics, plus 2 free-roaming backups |
| CoasterBuzz forum | 1 mechanic per 2 rides (1 per 3 for small flat rides) | Most aggressive/frequent coverage |
| Ride & staff settings synthesis | 1 per 3–4 rides typical guidance for coasters that break down often | Calls a 1-per-6 ratio "lenient" |

No consensus exists; ratios cited span from 1-per-2 to 1-per-10 depending on ride type and source.

**Community consensus — inspection intervals:**
- "10 minutes for everything" is the most commonly repeated habit/default, though (per the contradiction above) its benefit is disputed.
- 20–30 minute intervals are considered acceptable for replaceable flat rides.
- Default game interval is 30 minutes.

**Community consensus — mechanic patrol zones:**
- Zoning mechanics per ride exit is strongly preferred over free-roaming; a mechanic must physically reach the ride exit to inspect it.
- Recommended: patrol zone directly covering the ride exit tiles.
- Free-roaming mechanics tend to get lost or wander, missing scheduled inspections.

---

## Ride Operation & Queues

**Source-verified:**
- Ride departure load options: Any, 1/4, 1/2, 3/4, Full load (documented in the wiki).
- Max wait time setting **overrides** the load threshold — it acts as a safety valve so trains still depart even if the load target isn't met.
- Any chain-lift piece enforces a **minimum lift speed of 8 km/h** on non-downhill sections.
- Guests complain after 5 minutes queuing, leave after 15 minutes (see Mechanics section above — shared source).
- Queue length does not affect join decisions in current OpenRCT2 (see Mechanics section above).

**Community consensus — load threshold:**
- Busy/popular rides: use "Any Load" or "1/4 Load" with a short max wait time so trains leave frequently; half-load on a hugely popular coaster wastes capacity.
- Quiet/low-demand rides: "Full Load" avoids near-empty departures, improving profitability/satisfaction, but risks long waits if demand drops.
- OpenRCT2 forums explicitly recommend unchecking or reducing the load threshold when queues back up.

**Community consensus — wait time settings:**
- No widely cited authoritative formula exists in community guides for general wait-time tuning; rule of thumb is to set max wait roughly equal to one train's full circuit time.
- Forums suggest targeting **5–6 seconds between departures** as a sign of healthy flow.
- A distinct formula surfaced from community discussion for multi-train rides:
  - Minimum wait = ride duration / (train count + 1)
  - Maximum wait = ride duration / train count
  - Example: 60-second ride, 3 trains → min 15s, max 20s wait, to keep trains cycling without stacking. Needs per-ride fine-tuning.

**Community consensus — train count:**
- No agreed formula in text guides. Practical approach: add trains until the station is never empty and trains aren't backing up into the circuit (risking block-brake collisions).
- Rough cited heuristic: divide total circuit time by target dispatch interval to estimate train count, then subtract one.
- Maxing out trains is recommended for high-demand coasters.

**Community consensus — lift hill speed:**
- No documented downside to maxing lift hill speed was found. Faster lifts shorten circuit time, improving throughput and potentially allowing fewer trains for the same capacity.
- Marcel Vos's YouTube channel is cited as the primary source for deep dispatch/throughput mechanics analysis, but specific conclusions weren't captured in text form by the research agents — treat as a lead for further investigation, not a citable fact.

---

## Known Bugs Relevant to Plugin Behaviour

| Bug | Effect | Reference |
|---|---|---|
| Litter age-check underflow (vanilla RCT2 + early OpenRCT2) | Nearly all litter counted as "old" and penalized immediately regardless of actual age | [GitHub #15567](https://github.com/OpenRCT2/OpenRCT2/issues/15567) |
| Litter penalty regression in OpenRCT2 v0.3.5 | Litter penalty applied incorrectly; later corrected | [GitHub #20209](https://github.com/OpenRCT2/OpenRCT2/issues/20209) |
| Litter bins fill after a single item | Bins effectively useless without constant handyman attention; fixed | [GitHub #1860](https://github.com/OpenRCT2/OpenRCT2/issues/1860) |
| Bin visual bug (vanilla RCT2) | Bins don't visually show accumulation even though internally full; fixed in OpenRCT2 | community guide |
| Handymen stuck oscillating near unreachable litter | Path stays dirty indefinitely while handyman does nothing | [GitHub #7947](https://github.com/OpenRCT2/OpenRCT2/issues/7947), [#3205](https://github.com/OpenRCT2/OpenRCT2/issues/3205), [#18023](https://github.com/OpenRCT2/OpenRCT2/issues/18023), [forum #3474](https://forums.openrct2.org/topic/3474-handymen-can-get-stuck-when-heading-toward-litter/) |
| Reliability overflow above 100% on old uninspected rides | Can paradoxically reduce breakdowns; not a real strategy | [GitHub #7030](https://github.com/OpenRCT2/OpenRCT2/issues/7030) |
| Mechanics dispatched outside patrol area for repairs | Inconsistent with patrol-zone-only inspection behavior | [GitHub #5284](https://github.com/OpenRCT2/OpenRCT2/issues/5284) |
| Guests could vomit/litter only on non-sloped paths (vanilla RCT2) | Fixed in OpenRCT2; litter/vomit now applies to all path types | [GitHub #26756](https://github.com/OpenRCT2/OpenRCT2/issues/26756) |
| Queue length doesn't affect guest join decisions | Confirmed missing feature, not a bug fix candidate without upstream work | [GitHub Discussion #16841](https://github.com/OpenRCT2/OpenRCT2/discussions/16841) |
| Rain doesn't clean vomit/litter (vanilla RCT2 and OpenRCT2) | No native mechanic; addressed only by third-party plugin | [openrct2-rain-cleans-vomit](https://github.com/nickgal/openrct2-rain-cleans-vomit) |

---

## Contradictions Summary

✅ **Inspection interval vs. reliability decay — RESOLVED from C++ source.** Decay
(`Ride.cpp:1132`) contains no inspection term, so shorter intervals do *not* slow decay.
Inspections restore a proportion of lost reliability (`Ride.cpp:4443`), so more frequent
inspections *do* raise average reliability. Both source reports were half right. Full
writeup under [Mechanics, Reliability & Inspections](#mechanics-reliability--inspections).

No other direct fact-for-fact contradictions were found between the four reports; the remaining disagreements are wide **ranges of community opinion** (handyman ratios, mechanic ratios, patrol zone sizes, wait-time formulas) rather than mutually exclusive claims, and are presented as ranges in tables above rather than as contradictions.

---

## Sources

### Official / GitHub (source code, issues, discussions)
- [OpenRCT2/src/openrct2/world/Park.cpp](https://github.com/OpenRCT2/OpenRCT2/blob/develop/src/openrct2/world/Park.cpp)
- [Park rating litter penalty bug · #20209](https://github.com/OpenRCT2/OpenRCT2/issues/20209)
- [Litter age calculated wrong · #15567](https://github.com/OpenRCT2/OpenRCT2/issues/15567)
- [Litter bins fill up too fast · #1860](https://github.com/OpenRCT2/OpenRCT2/issues/1860)
- [Handymen trapped in queue lines · #7947](https://github.com/OpenRCT2/OpenRCT2/issues/7947)
- [Handyman pathfinding issue · #3205](https://github.com/OpenRCT2/OpenRCT2/issues/3205)
- [Handyman pathfinding issue · #18023](https://github.com/OpenRCT2/OpenRCT2/issues/18023)
- [Problem with Handyman AI (mow grass) · #3267](https://github.com/OpenRCT2/OpenRCT2/issues/3267)
- [Reliability goes above 100% on old rides · #7030](https://github.com/OpenRCT2/OpenRCT2/issues/7030)
- [Mechanic dispatched outside patrol area · #5284](https://github.com/OpenRCT2/OpenRCT2/issues/5284)
- [Guests cannot puke on sloped path · #26756](https://github.com/OpenRCT2/OpenRCT2/issues/26756)
- [guests should use queue length stat · Discussion #16841](https://github.com/OpenRCT2/OpenRCT2/discussions/16841)
- [Guests will not wait in queues · #5753](https://github.com/OpenRCT2/OpenRCT2/issues/5753)
- [Add option to change default inspection time · #1455](https://github.com/OpenRCT2/OpenRCT2/issues/1455)
- [Park Management — DeepWiki OpenRCT2](https://deepwiki.com/OpenRCT2/OpenRCT2/4.5-park-management)

### Wikis
- [Guide: How to calculate park rating? — OpenRCT2 Forums](https://forums.openrct2.org/topic/2798-guide-how-to-calculate-park-rating/)
- [Handyman — rct.wiki](https://rct.wiki/wiki/Handyman)
- [Guests and Staff — rct.wiki](https://rct.wiki/wiki/Guests_and_Staff)
- [Park Rating — rct.wiki](https://rct.wiki/wiki/Park_rating)
- [Ride Operation Options — RollerCoaster Tycoon Wiki](https://rct.wiki/wiki/Ride_Operation_Options)
- [Breakdown — RollerCoaster Tycoon Fandom Wiki](https://rct.fandom.com/wiki/Breakdown)
- [Mechanic — RollerCoaster Tycoon Fandom Wiki](https://rct.fandom.com/wiki/Mechanic)
- [Guest Thoughts — RCT Fandom](https://rct.fandom.com/wiki/Guest_Thoughts)

### Forums
- [Handymen can get stuck when heading toward litter — OpenRCT2 Forums #3474](https://forums.openrct2.org/topic/3474-handymen-can-get-stuck-when-heading-toward-litter/)
- [Automatic Bin and Bench Placement — OpenRCT2 Forums](https://forums.openrct2.org/topic/4767-automatic-bin-and-bench-placement/)
- [Increased Capacity of Litter Bins — OpenRCT2 Forums](https://forums.openrct2.org/topic/1095-increased-capacity-of-litter-bins/)
- [Effect of short inspection cycle — OpenRCT2 Forums](https://forums.openrct2.org/topic/2454-effect-of-short-inspection-cycle/)
- [Best way to decrease queue wait time — OpenRCT2 Forums](https://forums.openrct2.org/topic/3555-best-way-to-decrease-queue-wait-time/)
- [Understanding Simulation in RCT2 — OpenRCT2 Forums](https://forums.openrct2.org/topic/6444-understanding-simulation-in-rct2/)
- [How Many Handymen? Per Square, Etc. — CoasterBuzz Forums](https://coasterbuzz.com/Forums/Topic/how-many-handymen--per-square-etc)
- [Trash/Puke Cleaning Bug — CoasterBuzz](https://coasterbuzz.com/Forums/Topic/trashpuke-cleaning-bug)
- [RCT2 Steam Community cleanliness discussion](https://steamcommunity.com/app/285330/discussions/0/1473095965301909832)
- [Always Lose Scenarios — Steam Community RCT2](https://steamcommunity.com/app/285330/discussions/0/1697168437882626608/)

### Community Guides
- [Staffing A Park Part 1: Handymen and Mechanics — @myrct on Tumblr](https://www.tumblr.com/myrct/31354418971/staffing-a-park-part-1-handymen-and-mechanics)
- [Keeping Your Park Clean — Gamers Temple RCT Guide](https://www.gamerstemple.com/guides/pc/54/3/rollercoaster-tycoon-keeping-your-park-clean)
- [RCT Learner's Guide — Steam Community](https://steamcommunity.com/sharedfiles/filedetails/?id=1830311909)
- [How do Benches and Bins work in RCT2? — YouTube](https://www.youtube.com/watch?v=BUfRc6GKPLA)
- [Marcel Vos — YouTube Channel (deep-mechanics analysis)](https://www.youtube.com/@MarcelVos)

### Plugins
- [OpenRCT2-ParkRatingInspector — Basssiiie (GitHub)](https://github.com/Basssiiie/OpenRCT2-ParkRatingInspector/releases)
- [Advanced Staff AI Manager — OpenRCT2 Plugins Directory](https://openrct2plugins.org/plugin/R_kgDOQhfqvw/advanced-staff-ai-manager)
- [advanced-staff-ai-manager — GitHub](https://github.com/StixsmasterHD4k/advanced-staff-ai-manager)
- [OpenRCT2 Remote Handymen Plugin — GitHub](https://github.com/mrmagic2020/openrct2-remotehandymen)
- [openrct2-ride-inspection-manager — GitHub](https://github.com/aelindeman/openrct2-ride-inspection-manager)
- [openrct2-rain-cleans-vomit — GitHub](https://github.com/nickgal/openrct2-rain-cleans-vomit)

---

## Ride Operation Settings (added 2026-09-20)

Researched to vet the OPS feature against community practice.

**Community consensus — swinging ship swings:** adjustable from **7 to 25**; the default
has all test ratings at 2. Useful sanity check on the probe ceiling of 32, which sits
comfortably above the real maximum.

**Community consensus — intensity ceiling:** intensity must stay **below 10** for a ride
to remain exciting. Once it reads Extreme, excitement is effectively capped around
**5.50**.

> ⚠️ **This is a real trap for automated tuning.** More rotations, swings or laps push
> intensity up. Lengthening an already-extreme ride makes guests avoid it *more*, which
> empties the queue further, which invites the controller to lengthen it again — a
> feedback loop that drives a ride into uselessness.
>
> `ops.ts` therefore refuses to lengthen any ride at intensity >= 9.00
> (`INTENSITY_CEILING`), including during its blind midpoint calibration. The guard is
> **one-directional**: an extreme ride with a long queue is still shortened, because that
> lowers intensity.

**Community consensus — mazes:** guests do not care how difficult a maze is, so a
labyrinth beats a maze. An over-complicated maze means guests complain about being on the
ride too long *and* the queue backs up. This directly supports the OPS policy of
shortening the maze time limit under queue pressure.

**Not found:** no published optimal values for lap counts or rotations. As with staffing
ratios, there is no consensus number to copy — which is again why the controller measures
rather than predicts.

Sources: [Ride Operation Options](https://rct.fandom.com/wiki/Ride_Operation_Options),
[Excitement](https://rct.fandom.com/wiki/Excitement),
[Ride rating calculation](https://github.com/OpenRCT2/OpenRCT2/wiki/Ride-rating-calculation),
[Thrill Rides](https://strategywiki.org/wiki/RollerCoaster_Tycoon/Thrill_Rides),
[Maze guide](https://outof.games/realms/rollercoastertycoon/guides/495-guide-to-building-a-maze-in-rollercoaster-tycoon-1-2/)
