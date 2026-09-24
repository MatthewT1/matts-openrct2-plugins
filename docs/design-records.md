# Design Records

The per-feature design record for every roadmap item: basis, measurements, decisions and why rejected ideas were rejected. Moved verbatim out of [roadmap.md](roadmap.md) on 2026-09-24. **Read the relevant record before changing or reopening a feature.**

---

## Cross-cutting

### T0 — Park-context telemetry

**Status:** done (2026-09-19) · **Basis:** measured · **Cost:** ~0ms

The debug log currently records timings and counters but no park context, so the
staffing formulas cannot be evaluated against real data. Add to each `stats` record:
guest count, path tiles, owned tiles, handyman/mechanic counts, total and old litter,
full and broken bins.

All of these are already in the plugin caches — this is a few lines, and it is what
makes [S](#s--closed-loop-staffing) and any ratio tuning evidence-based rather than
another opinion.

### S — Closed-loop staffing

**Status:** done (2026-09-19) · **Basis:** research + **measured** · **Cost:** ~0ms

Implemented in `src/staffing.ts`. The classic formula remains a hard ceiling and a path
coverage minimum is the floor, so the worst case is exactly the old behaviour. Toggle:
"Adaptive staffing" in the Trash Manager window.

> **Rewritten after its first field test.** v1 reacted to `oldLitter`, which is lagged
> ~14.5 in-game days and whose small values cost nothing — it correctly released 36 -> 34,
> then hired 34 -> 40 chasing a 16-point penalty on a park pinned at maximum rating.
> v2 judges releases on *total* litter against a pre-release reference, waits out the lag
> after every change, only treats old litter as urgent above 25 pieces or on a real rating
> drop, and never re-probes a floor a failed release already discovered. See
> [performance.md](archive/performance-field-log.md#field-measurements-session-3-2026-09-19-37-in-game-days).

> **Field data (2026-09-19, auto-sweep off):** ~30 handymen produced **23 work events in
> 23 days** while the park never once accumulated a single piece of rating-costing
> litter. The formula meanwhile climbed 29 -> 33 as guests grew 793 -> 918. This is no
> longer a hypothesis; the current formula is measurably over-provisioned for this park.
> See [performance.md](archive/performance-field-log.md#field-measurements-2026-09-19-23-in-game-days).

**The problem with every staffing ratio in the research: there is no consensus to
defer to.** Published advice spans 1 handyman per 6 path tiles to 1 per 100 guests —
for a park like the test park that is a range of roughly **10 to 87 handymen**. The
current formula lands at 29. Picking a different forum's number is not an improvement,
it is just a different guess.

Instead, **control against measured outcome**:

- **The signal that matters is `oldLitter`** — litter aged past 7680 ticks is the only
  litter that costs park rating, and the plugin already computes it every day.
- **`Handyman.litterSwept` gives per-staff throughput**, so the plugin can tell the
  difference between *understaffed* (old litter rising, all handymen productive) and
  *overstaffed* (handymen idle regardless of litter).

Sketch:

| Observation | Action |
|---|---|
| Old litter trending up, handymen all productive | Hire |
| Old litter near zero, some handymen idle for N days | Fire toward the free-roaming floor |
| Old litter rising, handymen idle | **Do not hire** — this is a coverage or pathfinding problem, not a headcount one. Surface it; see [B](#b--stuck--idle-staff-detection). |

That third row is the interesting one, and no fixed ratio can express it.

Needs hysteresis and a multi-day window to avoid oscillating, and should keep the
existing formula as the initial estimate and as a hard bound. The same approach applies
to mechanics via `ridesFixed` / `ridesInspected` and measured `downtime`.

**Depends on [T0](#t0--park-context-telemetry)** to validate the control loop against
real data before trusting it.

---

## Trash Manager

### A — Litter hotspot map

**Status:** done (2026-09-19) · **Basis:** new · **Cost:** ~0ms

`Litter` extends `Entity`, so every piece has `x`/`y`. The daily handler already
iterates all litter to classify age and type — bucketing into a coarse grid
(`x >> 8`, `y >> 8`) during that same pass is nearly free.

Turns *"you have 240 litter"* into *"38 pieces clustered at (42, 88)"*, which is
actionable. Feeds [D](#dv--vomit-attribution-and-bench-advisor) and gives the UI somewhere to jump the
viewport to.

### B — Stuck / idle staff detection

**Status:** done, then **rewritten** (2026-09-19) · **Basis:** research · **Cost:** ~0ms

> **The first implementation was wrong.** It flagged any staff member idle for N days
> while work existed, which over 43 in-game days produced **734 false positives** — about
> 32 of 36 handymen, every day. With 36 handymen and ~1.5 pieces of litter appearing
> daily, most of them idling is correct behaviour, not a fault. The detector conflated
> *overstaffed* with *stuck*.
>
> It now compares each staff member **against their peers**: someone who has done nothing
> at all while a majority of the fleet is working is a genuine outlier. When nobody is
> working, that reports as `fleetUnderworked` — a staffing signal, consumed by
> [S](#s--closed-loop-staffing) — rather than blaming individuals.

Handymen becoming trapped — typically oscillating in a queue line toward litter they
cannot reach — is the single most-cited community frustration, and the upstream issues
are still open: [#7947](https://github.com/OpenRCT2/OpenRCT2/issues/7947),
[#3205](https://github.com/OpenRCT2/OpenRCT2/issues/3205).

`Handyman.litterSwept` and `binsEmptied` are cheap readonly counters. A handyman whose
counters have not advanced across N days *while old litter exists* is almost certainly
stuck. Snapshot per peep id, compare daily, flag in the UI — and optionally nudge by
re-issuing a patrol clear.

Same mechanism works for mechanics via `ridesFixed` / `ridesInspected`.

### AM — Automatic bench and bin management

**Status:** done (2026-09-19) · **Basis:** source-verified + measured · **Cost:** rate-limited to 10s

> **Field-verified:** 64 amenities placed, **0 refused and 0 failed** — the slope and
> enclosed-tile filters catch everything before the action is issued. Later tuned much
> denser (15 per 10s, blanket path coverage) and given removal hysteresis after measuring
> 28 removals against 64 placements: a bench placed for a *vomit cluster* stopped being
> justified the instant that cluster moved, which is exactly when it had done its job.

Replaces the manual `benchwarmer` plugin with a daily, data-driven version.

**Demands** are collected from three sources, weighted: observed vomit hotspots
(strongest — actual evidence), nauseating ride exits (`nausea >= 5.00`), and stalls for
bins. `amenities.ts` plans placements against the footpath tiles around each demand.

**Safety rules, all enforced in the planner and unit-tested:**

- Removal *only ever* touches amenities **this plugin placed**, tracked in park storage.
  A bench the player placed is never removed, however redundant it looks.
- An existing amenity within `satisfiedWithin` tiles satisfies a demand, so it never
  stacks duplicates — and a player-placed one counts just as much as ours.
- Never places on queue tiles or tiles that already carry an addition.
- Budgeted to 3 placements and 2 removals per pass, rate-limited to once per 30 real
  seconds, and skipped entirely below a cash floor so it cannot bankrupt a park.
- Both placement and removal are **off by default**; removal is a separate nested toggle.

### C — Bin placement advisor

**Status: SUPERSEDED by [AM](#am--automatic-bench-and-bin-management)** · **Basis:** research says yes, measurement says no

"Bins near food stalls" is the single most agreed rule in the community research, and it
is correct in general. **It is irrelevant to this park.** Across 104 in-game days only
**3 of 851** litter pieces were trash, and bins were never observed full or broken. The
problem bins solve is already solved here.

Revisit only if trash litter starts appearing — the telemetry records the vomit/trash
split, so this is checkable rather than a matter of opinion.

"Bins near food stalls" is the one universally agreed rule in the research — bins act
as a force multiplier, letting guests self-dispose so fewer handymen cover more ground.

Stalls are `ride.classification === "stall"`. The tile scan already walks every path
tile. Find path tiles adjacent to a stall with no `isAddition` bin, then report a count
and offer placement via `footpathadditionplace` (already used in path-connector).

Note `FootpathElement.isAdditionFull` tells you a bin is full; `isAdditionBroken` tells
you it is vandalised and collecting nothing.

### D/V — Vomit attribution and bench advisor

**Status:** done (2026-09-19) · **Basis:** research + **source-verified** + measured · **Cost:** ~0ms

> **This is the whole problem on the measured park.** Across 104 in-game days: **848 of
> 851 litter pieces were vomit**, 3 were trash, and bins were never full or broken. Bins
> only catch trash, so they are irrelevant here.

The fix is source-verified rather than assumed: a guest in `PeepState::sitting` sheds 6
`nauseaTarget` per update while it is >= 50 (`Guest.cpp:1099`), and `throwUp()` halves it.
**Benches genuinely prevent vomiting.**

`hotspots.ts` gained `topVomit()`; `vomit.ts` attributes a cluster to the nearest ride
exit with `nausea >= 5.00`, tie-breaking toward the more nauseating ride. Trash Manager
counts existing benches near the culprit's exit and reports one line:

> *Vomit at (34, 58): 12 pieces, likely from Twister (nausea 8.40, 3 tiles away) — add
> benches nearby so guests can sit and shed nausea before it turns into vomit.*

When benches already exist it says the ride's own nausea is the problem instead, and when
no nauseating ride is in range it says the cause is unclear rather than inventing one.

The research considers vomit the harder problem: continuous, unpredictable, and
cascading from a single nauseating ride. Combining [A](#a--litter-hotspot-map) with
`ride.nausea` (2-decimal fixed integer — >7.50 is the community danger line) lets the
plugin name the ride responsible for a vomit hotspot and suggest benches or a first-aid
room near its exit.

### E — Guest-thought early warning

**Status:** done (2026-09-20) · **Basis:** research · **Cost:** needs rate-limiting

`Guest.thoughts` exists, and `bad_litter`, `path_disgusting` and `vandalism` are real
`ThoughtType` values. The research recommends thoughts as the leading indicator, before
the rating drop shows up.

**Constraint:** this needs `map.getAllEntities("guest")`, which is expensive on a large
park. Sample a subset per day or put it behind a long cooldown. Do not add it to the
unconditional daily path.

Would catch the vandalism cascade (litter → disgust → vandalism → broken bins → more
litter) at its *first* stage; currently only the last stage is detected.

---

## Mechanic Manager

### MS — Adaptive mechanic staffing

**Status:** done (2026-09-20) · **Basis:** measured · **Cost:** ~0ms

> **The handyman controller has been validated in the field** (session 5: target moved
> 40 -> 39, settle window counted down correctly, zero false stuck flags). The hold that
> was on this item is lifted — `staffing.ts` can now be reused for mechanics with
> reasonable confidence. Latest supporting data: 4 breakdowns and 10 work events in 17
> days, with `fleetUnderworked` on 10 of them.

Apply the `staffing.ts` controller to mechanics, exactly as for handymen. Evidence has
the same shape: 7 mechanics for 17 rides, **8 breakdowns in 104 in-game days**,
`fleetUnderworked` on 11 days, and mechanics already perform ~100% of the work the game
asks (see [M2](#m2--small-patrol-zones-for-mechanics)).

At a source-verified £80/month per mechanic (`Staff.cpp:2645` — handymen are £50), this
is worth roughly £300/month on the measured park.

Reuses the existing bounded design — formula ceiling, floor, settle windows, discovered
floor — so it inherits the same worst case: identical to current behaviour.

**Hold until the rewritten handyman controller is validated in the field.** MS copies its
design; if that still misbehaves, fix it once rather than twice.

### Cost reporting

**Status:** done (2026-09-20) · **Basis:** source-verified · **Cost:** ~0ms

Source-verified wages (`Staff.cpp:2645`): handyman **£50/month**, mechanic **£80/month**,
security £60. With the park pinned at 999 rating, wages are the only remaining lever the
staffing plugins actually move, so surfacing "staff cost vs. formula baseline" makes the
adaptive controller's value visible instead of invisible.

### M1 — Weight staffing by breakdown risk

**Status: SUPERSEDED by [MS](#ms--adaptive-mechanic-staffing)** · **Basis:** research + measured · **Cost:** ~0ms

Current target is a flat 1 mechanic per 4 open rides. Community figures span 1-per-2 to
1-per-7 with no consensus. But `downtime` and `reliability` are already in the cache —
allocating against *measured* downtime beats any fixed ratio.

### M2 — Small patrol zones for mechanics

**Status: REJECTED (2026-09-19)** · **Basis:** source arithmetic + measured

The hypothesis was that clearing mechanic patrol zones suppresses inspections, because
inspections require the mechanic to be in range of the ride exit
([#5284](https://github.com/OpenRCT2/OpenRCT2/issues/5284)). Two sessions of data
appeared to support it: mechanics did very little work while rides carried downtime.

**That reading was wrong, because the expected workload was never calculated.**

`RideInspectionUpdate` only runs when `currentTicks & 2047 == 0` — once per **2048
ticks** — and increments `lastInspection` by 1 each time (`Ride.cpp:1025`). So the
"every 10 minutes" setting is 10 x 2048 = 20,480 ticks, which at ~541 ticks per in-game
day is **one inspection per ride every ~38 in-game days**.

Measured over 43 in-game days with 14 rides and 4 breakdowns:

| | |
|---|---|
| Inspection cycles elapsed | 1.11 |
| **Expected** work events (1.11 x 14 + 4) | **19.6** |
| **Observed** `mechanicWorkDone` | **19** |

Mechanics are performing essentially **100%** of the work the game asks of them. There
is no deficit for patrol zones to fix. The earlier session matched too once recomputed
— it simply lacked a denominator.

Related correction: the idle threshold for mechanics was 3 days, which is far too tight
against a 38-day inspection cadence and plausible cross-park walking time. It is now 20
days, and gated on peer comparison.

**Do not reopen without first computing the expected workload.** See
[api-reference.md](api-reference.md#inspection-cadence-is-far-slower-than-it-sounds).

### M3 — Emergency repair

**Status:** done (2026-09-20), off by default · **Basis:** source · **Cost:** ~0ms

`ride.fixBreakdown()` is exposed to plugins (`ScRide.cpp:842`). It clears breakdown
flags and adds **zero** reliability.

This is effectively a cheat, and the UI says so in those words. What keeps it honest is
the **3-day threshold**: a ride broken for a day or two is a ride the mechanics are
dealing with, and stepping in there would replace the game's repair economy with a free
button. The legitimate case is narrow — a ride no mechanic can physically reach, which is
the long-standing pathfinding trap behind
[#7947](https://github.com/OpenRCT2/OpenRCT2/issues/7947) and
[#3205](https://github.com/OpenRCT2/OpenRCT2/issues/3205), and which no amount of hiring
fixes.

The broken-day counter is rebuilt from the live ride list each day rather than
accumulated, so it cannot retain ids for demolished rides — the same stale-id bug class
that produced "Invalid parameter / Staff not found" in the staffing code.

**New telemetry:** `emergencyRepair` (toggle state), `stuckBroken` (rides past the
threshold right now), `emergencyRepairs` (count). The middle one is the interesting one:
if it stays at 0, this feature is correctly doing nothing and the park has no unreachable
rides.

### M4 — Correct the inspection-interval rationale

**Status:** done (2026-09-19) · **Basis:** source · **Cost:** none

The code comment claims 30-minute intervals "cause reliability to drop sharply". The
source shows decay is independent of inspection interval; what shorter intervals
actually do is raise restore frequency. The behaviour stays, the reasoning changes. See
[api-reference.md](api-reference.md#reliability-decay-vs-restore).

Also worth documenting in-code: the daily interval re-application is load-bearing
because opening a ride's construction window resets it
([#25601](https://github.com/OpenRCT2/OpenRCT2/issues/25601)).

### M5 — Breakdown repair trace

**Status:** instrumentation only (2026-09-24) · **Basis:** measured need · **Cost:** ~0ms, Diagnostics only

The Session 2 baseline (Thunder Rock, 22 days) had one breakdown that took **~4 in-game
days** to repair. The daily log shows `unattendedBreakdowns` and a hire, but not why it
took so long. The plugin API has no `ride.mechanicStatus` or `ride.mechanic`.

Reading `Ride.cpp:1387-1560` gives three candidate causes: no mechanic free to dispatch
(`FindClosestMechanic` only takes patrolling mechanics, or ones heading to an inspection
with `subState < 4`), a long walk, or a slow fix. Clearing a patrol area
(`StaffSetPatrolAreaAction`) doesn't touch the peep's state, so the daily zone sync
doesn't interrupt a repair.

`breakdown-trace.ts` separates the three. From the `ride.breakdown` event it samples every
64 ticks: nearest mechanic distance to the exit, mechanics at the ride, and `staffFix*` /
`staffAnswerCall*` animations. When the ride is fixed it emits one `breakdownTrace`
event that says who fixed it (from their `ridesFixed` counter), how far away they started,
the time to the broken flag, to arrival and to the fix animation, and how many inspections
the fleet did in the meantime.

**First trace (Session 2):** dispatch was instant, the walk took ~1.9 of ~3.2 days, and the
fixer started 10 tiles away (Manhattan) with a detour. Full table on
[#22](https://github.com/MatthewT1/matts-openrct2-plugins/issues/22).

**What the source says about the walk** (Session 3):

- The game sends the nearest free mechanic by **Manhattan distance to the exit**
  (`FindClosestMechanic`, `Ride.cpp:1521`), not by walking distance. The "closest"
  mechanic can have a long route.
- Staff walk at energy 96 (`Cheats.h:138`), 2 world units a step (`Peep.cpp:432`), so
  **~43 ticks per flat tile, ~85 on slopes** (`Peep.cpp:938`), which is about 12 flat
  tiles an in-game day. The first trace's 1,024-tick walk is ~24 flat tiles for a
  10-tile start.
- A mechanic gives up after 2,500 steps and the ride calls again (`Staff.cpp:1364`).
- `staffAnswerCall` is the "take the call" animation at the start of `updateAnswering`
  (sub-states 0-1), not a sign of the repair.

**Trace extension (Session 3):** each trace now also reports `fixerWalkTiles` (tiles the
fixer actually walked from the broken flag to the ride), `fixerWalkTicks` and
`fixerTicksPerTile`. Walked vs `fixerStartDistance` separates a long route from slow
walking; ticks per tile near 43 means flat, near 85 means slopes, much higher means waiting
or stuck.

**Exit criterion, decided before collecting the data.** With 5 or more `fixed` traces:

| Result | Reading | Do |
|---|---|---|
| Median `fixerWalkTicks` under ~540 (1 day) | Repairs are fast enough | Close #22, no fix |
| Median over 1 day and walked / start distance >= 1.5 | The route is the problem | Try ride-group patrol zones (reopens M2 on *response time*, not inspections) |
| Median over 1 day, ratio under 1.5, ticks per tile >= 70 | Slopes or blocking | Zones won't help. Leave it to M3 |
| Median over 1 day, ratio under 1.5, ticks per tile near 43 | Plain distance | More mechanics (option A) is the lever |

**Option A (keep the formula count while reliability is low) was checked against the log
before building it.** The lowest ride reliability on Thunder Rock was 65-75% on **all 91**
logged days, so a reliability gate would be on permanently. It would really be "never
release mechanics below the formula", which is a different decision.

---

## Wait Time Optimizer

This plugin is in the best shape — ~1.3ms/day measured, and the research **validates**
the existing min/max formula.

### W1 — Surface the 15-minute walk-out cliff

**Status:** done (2026-09-19) · **Basis:** research + measured · **Cost:** ~0ms

Implemented as the `[!!]` marker at 12+ minutes, distinct from the `[!]` 5-minute
complaint threshold.

> **Field data (2026-09-19):** one ride sat at a **13-minute queue for 23 consecutive
> days** — two minutes under the hard walk-out — and the UI gave it the same single
> warning marker as a ride at 6 minutes.

Guests complain at 5 minutes and **leave the queue at 15, absolutely**. Vanilla RCT2
let entertainers hold guests indefinitely; OpenRCT2 does not
([#5753](https://github.com/OpenRCT2/OpenRCT2/issues/5753)), so strategies ported from
vanilla guides are invalid.

Currently a ride at 14 minutes looks identical in the UI to one at 6. Add a second,
louder severity tier.

### W3 — Capacity-bound ride detection

**Status:** done (2026-09-19) · **Basis:** measured · **Cost:** ~0ms

A ride whose queue stays high *after* the optimizer has already applied its most
aggressive settings (min 0s, Any Load, max 20s) is **capacity-bound, not
dispatch-bound**. No amount of wait-time tuning will help it; it needs more trains, more
cars, or a second station.

Measured: one ride held a 13-minute queue for 23 consecutive days while the optimizer
wrote ride properties only twice in the whole run.

Detect by tracking, per ride, how many consecutive days it has been in the warning state
*with recommended settings already applied*, then say plainly that the ride needs
capacity rather than silently re-applying settings that are already in place. The
existing "Boost Capacity" button is the action; this is the diagnosis that should point
at it.

### W2 — More aggressive emergency override

**Status:** done (2026-09-20) · **Basis:** research + measured · **Cost:** ~0ms

Queue length does **not** deter guests from joining — a known missing feature, not
modelled behaviour ([#16841](https://github.com/OpenRCT2/OpenRCT2/discussions/16841)).

That asymmetry is the whole argument. In a real queueing system a long line is
self-limiting because people balk. Here nothing balks, so **arrival rate is independent
of queue length**, and a ride whose throughput is below its arrival rate grows without
bound until the 15-minute walk-out. The queue is not a level that settles, it is an
integral that diverges — so waiting for it to cross 5 minutes means always acting after
the divergence has started.

**Supporting measurement (2026-09-20):** `queue/crowded` peaked at 91 guests and
`queue/queuing_ages` at 67, second only to pricing. Queues are a real complaint on this
park, not a hypothetical.

#### Why trend, and not simply a lower threshold

Dropping the override from 5 minutes to 3 is the obvious fix and it is **wrong**. The
override trades capacity-per-train for dispatch rate (Any Load instead of Full Load). On
a quiet ride that is a straight loss — trains leave half empty, throughput per cycle
falls, and nothing is gained because there was no queue to clear. A fixed lower threshold
applies that loss to every moderately busy ride in the park.

A *rising* queue is a different signal. It separates "3 minutes and stable", which is a
healthy ride at equilibrium that must be left alone, from "3 minutes and climbing", which
is a ride already past the point where arrivals exceed throughput.

Implemented in `queues.ts` (31 tests). A ride is flagged after
`RISE_OBSERVATIONS = 2` consecutive rising days above `FLOOR_MINUTES = 3`. Any fall
resets the count outright; a flat reading neither confirms nor clears it, so a queue
pinned at one value cannot creep into a flag.

**The worst case is bounded and small:** a ride flagged early gets exactly the settings it
would have received a day or two later anyway.

> **Consistency trap found while wiring this.** The daily cache computed its recommended
> settings *without* the new override while `applySettings` wrote them *with* it. That
> mismatch would have made every rising ride look permanently "not yet tuned" to
> [W3](#w3--capacity-bound-ride-detection), silently disabling capacity-bound detection
> for precisely the rides it matters most for. Both paths now derive from one verdict.

**New telemetry:** `risingQueues`, `queueRiseFloor`, and a `queuePreemptive` counter on
every early application.

---

## Ideas not yet scoped

### NEEDS — Guest-need clustering, then automatic facility placement

**Status:** Phases 1-3 **done** (2026-09-20), placement off by default ·
**Basis:** source-verified throughout, **and the exit criterion fired**

> #### The hold is lifted, and the data is why
>
> Phase 1 shipped with an explicit exit criterion: *build nothing unless the log shows
> persistent clusters at a distance large enough to explain them; if the numbers come
> back flat, stop here.* For several sessions they came back flat and this stayed
> unbuilt. **They are no longer flat.**
>
> Measured across 121 sampling sweeps while the park grew **573 → 927 guests**:
>
> | Cluster | Sweeps present | Distance to nearest | Peak guests |
> |---|---|---|---|
> | `hunger` @ (60, 92) | **77** | 23 tiles | 21 |
> | `thirst` @ (68, 68) | **69** | 7 tiles | 8 |
> | `hunger` @ (4, 4) | **63** | **78 tiles** | 20 |
> | `toilet` @ (68, 68) | **57** | 7 tiles | 16 |
>
> Park-wide at the end of the run: **90 hungry, 59 thirsty, 76 needing a toilet (55 of
> them urgently)** out of 933 sampled — served by 3 food, 3 drink and 3 toilet
> facilities. `needs/toilet` was the largest guest complaint after pricing.
>
> A cluster of 20 guests **78 tiles** from the nearest food stall, persisting across 63
> separate sweeps of the park, is not noise. That is the corner of a park with nothing
> in it, and it is exactly the condition Phase 1 was built to detect.
>
> Note the contrast with [M2](#m2--small-patrol-zones-for-mechanics) and
> [C](#c--bin-placement-advisor), both of which were *closed* by this same discipline.
> The process is not biased toward building.

The goal is to place toilets, first aid, food and drink stalls automatically, driven by
where guests actually have unmet needs. Split into three phases so each one is checkable
before the next is built — the same ordering that would have caught M2 early.

#### Everything needed is source-verified

| Fact | Value | Source |
|---|---|---|
| Hungry thought fires at | `hunger <= 10` (and no food held) | `Guest.cpp:1007` |
| Thirsty thought fires at | `thirst <= 25` (and no drink held) | `Guest.cpp:1012` |
| Toilet thought fires at | `toilet >= 160` | `Guest.cpp:1017` |
| Toilet urgency at | `toilet >= 195` | `Guest.cpp:703` |
| Guest stats exposed | `hunger`, `thirst`, `toilet`, `nausea`, 0-255 | `openrct2.d.ts:3437+` |
| Unlock state readable | `park.research.inventedItems` / `uninventedItems` | `openrct2.d.ts:4581` |
| Shops/facilities are 1x1 | all use `StartTrackPiece = flatTrack1x1A` | `ride/rtd/shops/*.h` |
| That track type's id | **262** | `ted/TrackElemType.h:282` |
| Facility ride types available | Toilets, FirstAid, FoodStall, DrinkStall, Shop, CashMachine, InformationKiosk | `ride/rtd/shops/` |

Note also that a guest whose thought fires **walks to the nearest matching facility**
(`GuestHeadForNearestRideWithFlag`, e.g. `RtdFlag::sellsFood`). So an unmet need is not
just discomfort — it is a guest walking across the park, which is itself the signal that
a facility is too far away.

#### Phase 1 — Instrumentation — **DONE (2026-09-20)**

Implemented in `src/needs.ts` (pure, 22 tests) plus sampling in Trash Manager. Gated on
the Diagnostics flag, so a normal game pays nothing. Rotating window of 250 guests per
5 real seconds; the accumulator publishes and resets on each complete sweep of the park,
so every reading is one coherent picture rather than a blend of two.

New telemetry: `needs` (sampled/hunger/thirst/toilet/toiletUrgent/sick/verySick),
`facilities` (count by kind), and `needGaps` (worst clusters with distance to the nearest
matching facility). `guestsSampled` records throughput; `day.needSample` records cost.

**Still to check in the first log:** the cost of `day.needSample` at this window size, and
whether toilet demand moved after the bench blanket-coverage went in.

#### Phase 1 — original design notes

Answer "is there a problem, and where?" before building anything that acts.

- **Sampling.** `getAllEntities("guest")` is the one operation that does not fit the
  per-day budget (measured ~1,700 guests). Read a **rotating window** — e.g. 250 guests
  per pass, advancing the offset each time — so cost is bounded and coverage accumulates
  over a few days. Put it behind its own cooldown like the tile scan, and **measure it
  before trusting the window size**.
- **Per-guest, read only:** `hunger`, `thirst`, `toilet`, plus `x`/`y`. Thoughts are a
  secondary signal; the raw stats are cheaper and fire earlier.
- **Clustering.** Generalise `hotspots.ts` (or add a sibling) into a need accumulator:
  same coarse-grid, allocation-free `add()` contract, but counting unmet needs by kind
  instead of litter. The grid already proved itself on vomit.
- **Facility inventory.** Existing facilities from `map.rides` filtered by classification
  and ride type, located via `stations[0].start` — the same approach `collectDemands`
  already uses for stalls.
- **New telemetry:** counts over the threshold per need, the worst cluster per need, and
  **distance from that cluster to the nearest matching facility**. That last number is the
  one that says whether a facility is missing or merely far away.

**Exit criterion:** the log shows unmet-need clusters that persist, and a distance to the
nearest facility large enough to explain them. If the numbers come back flat, stop here —
the park does not have this problem and Phase 2 would be solving nothing.

#### Phase 2 — Advisory — **DONE**

`describeGap` in `needs.ts` reports the worst-served cluster, its size, and the distance
to the nearest matching facility, logged once per change rather than per sweep. It has
been running since Phase 1 and produced the console lines that corroborate the table
above.

#### Phase 3 — Automatic placement — **DONE (2026-09-20), off by default**

Implemented as `src/facilities.ts` (pure, **36 tests**) plus the build chain in Trash
Manager. The decision logic is a separate module specifically because **building a ride
is the most consequential action this project takes**, and that is the last place to
accept "looks right to me" as verification.

##### Why hysteresis is not optional here

Guests move. A cluster is a snapshot of where people happened to be standing, and a crowd
leaving a ride lights up a cell for one sweep and is gone the next. The amenity work
already learned this expensively: a bench placed for a vomit cluster stopped being
justified the moment that cluster moved — which was exactly when it had done its job.

A bench is a trivial, reversible mistake. **A stall is not.** So a gap must persist across
`confirmSweeps = 8` separate sweeps of the whole park before it can authorise
construction, and a gap that stops appearing **decays rather than resetting**, so one
missed sweep does not discard a fortnight of evidence.

##### The bounds, all enforced in `facilities.ts` and unit-tested

| Bound | Value | Why |
|---|---|---|
| `confirmSweeps` | 8 | ~a fortnight of agreement before building |
| `minGuests` | 5 | above the noise floor; measured clusters peak at 8-29 |
| `minDistance` | 12 tiles | a cluster *next to* a facility is a capacity problem, not a coverage one |
| `maxPerKind` | 8 | a cluster a facility cannot fix can't spiral into fifty toilets |
| `maxPlacements` | 1/pass | a bad decision costs one building and shows up in telemetry before it repeats |
| cash floor | £20,000 | a stall costs far more than a bench |

**Never demolishes.** `facilities.ts` has no removal output type at all. The "only touch
what we placed" rule that makes bench removal safe is *not* sufficient for a ride: removal
refunds differently, can strand guests already walking to it, and is not something a
player undoes with one click.

##### Two hazards found while building it

1. **The orphan ride.** `ridecreate` and `trackplace` are separate actions, and
   `trackplace` cannot be queried until the ride exists — so a successful create followed
   by a failed place leaves a **trackless ride permanently in the player's ride list**.
   Defended twice: strict site validation before `ridecreate`, and a `ridedemolish`
   cleanup path aimed at the id just created. That cleanup is the only demolition in this
   project.
2. **The silent-deadlock flag.** The in-flight guard that stops build passes overlapping
   would, if a callback were ever dropped (possible in multiplayer), stay set forever and
   disable the feature with no error. It now has a 60-second watchdog, and the watchdog
   firing is **counted** — because a feature that silently stops working is this project's
   single most common failure mode.

##### Sampling is no longer diagnostics-only

Phase 1 gated guest sampling on the Diagnostics flag, since it was pure instrumentation.
Placement *consumes* that sampling, so it now runs whenever either is switched on. A
normal game with both off still pays nothing.

##### New telemetry

`autoFacilities`, `facilityConfirmed`, `facilityPending` (what the tracker is waiting on,
with each gap's sweep count), and counters for every outcome including the skip paths:
`facilityPlaced`, `facilityNoSite`, `facilityCapped`, `facilityNotUnlocked`,
`facilitySkippedLowCash`, `facilityCreateRefused`, `facilityTrackFailed`,
`facilityOrphanDiscarded`, `facilityBuildTimedOut`, and `facilityDirection0-3`.

That last one is deliberate instrumentation of an **unknown**: which rotation a 1x1 stall
wants is not documented anywhere in the plugin API, so all four are probed with silent
`queryAction` calls and the winner is counted. The convention gets read off telemetry
rather than assumed.

#### Phase 3 — original design notes

**Placement sequence** (a stall is one tile, so no entrance/exit is needed):

1. `ridecreate` with `{rideType, rideObject, ...}` — the result carries the new ride id
2. `trackplace` with `{x, y, z, direction, ride, trackType: 262, rideType, ...}`
3. `ridesetstatus` `{ride, status: 1}` to open it

**Site selection** — reuse the amenity machinery, which already solves most of this:

- Candidate tiles adjacent to a footpath (guests must reach it), owned, flat, empty.
- The coverage-cell scan already collects placeable path tiles; this needs the tile
  *beside* a path rather than the path itself.
- **`queryAction` before every `executeAction`.** Ride placement has far more rejection
  conditions than a footpath addition, and the query-first pattern already proved it
  eliminates error windows entirely (0 refusals across 64 amenity placements).

**Safety, carried over from the amenity work:**

- Filter to **unlocked** ride objects via `park.research.inventedItems`.
- Strict per-pass budget and a cash floor — building a stall costs far more than a bench.
- **Never demolish.** Removal of a *ride* is destructive in a way removing a bench is not;
  the "only touch what we placed" rule is not sufficient protection here.
- Off by default, opt-in per facility kind.

#### Known risk to measure, not assume

`PeepState::sitting` **raises `toilet` by 3 per update** while lowering nausea
(`Guest.cpp:1095-1099`). The bench blanket-coverage already shipped therefore trades
nausea for toilet pressure. Phase 1 instrumentation should be able to see this: if toilet
demand rose after benches went in, that is a real coupling between two features and worth
knowing before adding a third.

### OPS — Per-ride-type operation settings

**Status:** done (2026-09-20), off by default · **field-tested once**

> **First run:** 7 probes, 2 ranges discovered, 1 change applied, **zero failures**, 1ms
> cost. Correct and safe, but far too slow — probes and sets shared one action budget
> despite costing completely different things. Split into separate budgets; see
> [performance.md](archive/performance-field-log.md#field-measurements-ops-first-run-2026-09-20-18-in-game-days). · **Basis:** source-verified · **Cost:** unknown

Tune the per-ride "operation" value — maze time limit, number of laps, launch speed,
rotation/swing count — alongside the wait-time work already done.

#### What the source says

`ridesetsetting` takes a `setting` index (`actions/ride/RideSetSettingAction.h:16`):

| Index | Setting |
|---|---|
| 0 | mode |
| 1 | departure |
| 2 | minWaitingTime |
| 3 | maxWaitingTime |
| **4** | **operation** |
| 5 | inspectionInterval |
| 6 / 7 | music / musicType |
| 8 | liftHillSpeed |
| 9 | numCircuits |
| 10 | rideType |

Setting **4** is the one that covers everything asked for, because `Ride::operationOption`
is a **union** (`ride/Ride.h:317-325`) whose meaning depends on ride type:

```
union { operationOption; timeLimit; numLaps; launchSpeed; speed; rotations; }
```

So maze time limit, lap count, launch speed and swing/rotation count are all the *same*
field, addressed through one setting index.

#### Three constraints that shape the design

1. **It is write-blind — verified three ways (2026-09-20).** `operationOption` is **not
   exposed** on `Ride`:
   - the complete list of properties `ScRide` registers contains none of
     `operationOption`, `numLaps`, `numCircuits`, `rotations`, `timeLimit`, `launchSpeed`
     or `speed`;
   - the `@openrct2/types` package this project builds against does not declare them;
   - a direct read of `openrct2.d.ts` on upstream `develop` confirms they are absent.

   A web search suggested otherwise, claiming `operationOption` / `operationMin` /
   `operationMax` were Ride API properties. **That was wrong** — it conflated the C++
   `Ride` struct and the ride-window UI code with the plugin API. Worth remembering that
   search results about this API are unreliable; the vendored clone in `gamesrc/` is the
   authority.

   So writes must be unconditional unless the plugin tracks its own last-written value in
   park storage.
2. **Out-of-range rejects, it does not clamp** (`RideSetSettingAction.cpp:95-100`, via
   `RideIsValidOperationOption`). The legal range comes from `RideOperatingSettings
   {MinValue, MaxValue}` per ride type, which is also not exposed. **But this is
   workable:** `queryAction` is silent, so the plugin can probe downward from a high value
   until a query succeeds and thereby discover the maximum per ride. Same query-first
   pattern that gave 0 failures across the amenity work.
3. **Changing it calls `InvalidateTestResults`** (`RideSetSettingAction.cpp:195`). The
   ride's excitement/intensity/nausea ratings are discarded until it runs again. Since
   guests choose rides partly on those ratings, blindly maxing every ride would
   temporarily blank the stats park-wide. **Measure the recovery time before doing this in
   bulk.**

#### The effect IS readable, even though the value is not

This is what makes the feature tractable. `operationOption` changes ride duration, and
**`ride.rideTime` is exposed** — along with `rideLength`, `averageSpeed` and `maxSpeed`.

So the loop does not need a getter at all:

1. Probe the legal range with `queryAction` (silent).
2. Set a value with `ridesetsetting` setting 4.
3. **Observe the resulting `rideTime`** once the ride has run again.

And `rideTime` is already the input to the wait-time formula this project uses
(`min = rideTime / (trains + 1)`, `max = rideTime / trains`), so a change in operation
settings feeds straight into existing, tested machinery rather than needing new theory.

That also means the throughput question is directly measurable: longer `rideTime` with the
same train count means fewer dispatches per hour, which is exactly what
[W3](#w3--capacity-bound-ride-detection) already watches for.

#### Suggested approach

- Probe each ride's max once via `queryAction`, cache it in park storage keyed by ride id.
- Decide per ride type whether max is actually optimal — more rotations means a longer
  ride, which *reduces* throughput. This interacts directly with
  [W3](#w3--capacity-bound-ride-detection): on a capacity-bound ride, a longer cycle is
  the wrong direction.
- Start advisory, as with every other feature here, and only automate once the
  throughput effect has been measured.

> **Open question worth answering first:** is a longer ride better (higher excitement,
> happier guests) or worse (lower throughput, longer queues)? The project already has the
> telemetry to answer this — queue times and capacity-bound detection are logged. Answer
> it from data before changing anything.

---
