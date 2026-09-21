# Performance — Cost Model, Measurements and Rules

The OpenRCT2 scripting engine is **QuickJS-NG with no JIT compiler**
(`distribution/scripting/scripting.md`). Interpreted loop cost is real, and the
`interval.day` handler runs roughly every 13 real seconds at 1× speed — far more often
under fast-forward. Plugin cost shows up directly as stutter.

Everything below with a millisecond figure was **measured** via the
[debug channel](#debug-channel), not estimated.

---

## Contents

- [The rules](#the-rules)
- [Measured costs](#measured-costs)
- [Patrol areas](#patrol-areas)
- [Cost budget](#cost-budget)
- [Debug channel](#debug-channel)
- [Case study: the 440ms day handler](#case-study-the-440ms-day-handler)
- [Field measurements](#field-measurements-2026-09-19-23-in-game-days) — sessions 1-5,
  then [OPS runs 1-3](#field-measurements-ops-first-run-2026-09-20-18-in-game-days),
  then the [growth session](#field-measurements-growth-session-2026-09-20-121-sampling-sweeps)
- [Amenity placement](#amenity-placement-making-it-dense-without-making-it-slow)
- [Testing](#testing)

---

## The rules

1. **Never call `map.getAllEntities(...)` from a UI refresh or `interval.tick`.** Entity
   scans belong in `interval.day`; results go into a cache object that the UI reads.
2. **Scan entities once per day and thread the array through every helper.** It is easy
   to end up calling `getAllEntities("staff")` four or five times in one handler by
   having each helper fetch its own copy.
3. **Rate-limit O(N²) tile scans** with a real-time cooldown (`Date.now()`), so
   fast-forwarding cannot trigger them every simulated day.
4. **`interval.tick` must be near-zero cost** — a flag check and early return.
5. **`park.guests` is a cheap property.** Never count guests with `getAllEntities`.
6. **Never issue an unchanged game action on a recurring interval.** `executeAction` is
   a full command dispatch. Track applied state and send only the delta.
7. **Guard entity and ride property writes with a comparison:**
   `if (ride.departFlags !== flags) ride.departFlags = flags;`. Unconditional daily
   writes churn game state and fight the player's manual settings.
8. **Memoise anything that walks a chain or the tile grid.** Cache vehicle-chain lengths
   per ride; cache per-tile facts for the duration of one operation.
9. **A\* needs a closed set.** Without one, expanded nodes get re-pushed and
   re-expanded, and a `MAX_NODES` budget measured in queue pops silently shrinks the
   reachable area.
10. **Aggregate before logging.** `console.log` is comparatively expensive; never log
    per event in a hot path.

---

## Measured costs

From a park with ~29 handymen, 5 mechanics and 12 optimizable rides, over 23 in-game
days at game speed 2:

| Operation | Cost | Notes |
|---|---|---|
| Full map tile scan (`updateTileCache`) | **13ms** | Behind a 30s real-time cooldown. |
| `getAllEntities("staff")` + filter | <1ms | Cheap at this park size. |
| Litter scan + age classification | <1ms | |
| `wait-time-optimizer` full day handler | ~1.3ms | Includes `applyToAll` over 12 rides. |
| Vehicle chain walk, per ride | <1ms | One `map.getEntity` per car; memoised per ride. |
| **`staffsetpatrolarea`, park-sized rectangle** | **~7.6ms each** | See below. |
| `staffsetpatrolarea`, `mode: 2` (clearAll) | fast | No per-tile loop. |
| Steady-state day handler, all three plugins | **0ms** | Once delta-tracking is in place. |

The headline: **21 of 23 days cost nothing at all.** All real cost was concentrated in
bulk patrol-area work on the first day after a park load.

---

## Patrol areas

**Patrol area cost is proportional to rectangle area, and it is quadratic in staff
count for a bulk reassignment.**

Two things make this expensive:

1. `StaffSetPatrolAreaAction::QueryExecute` walks **every tile in the range** to
   validate it — and it runs in both the query pass and the execute pass.
2. After every action it calls `UpdateConsolidatedPatrolAreas()`
   (`StaffSetPatrolAreaAction.cpp:105`), which loops **all four staff types × every
   staff entity** and re-unifies each one's full patrol bitmap (`PatrolArea.cpp:140`).

So assigning N staff a rectangle of area A costs roughly `O(N² × A)`.

Measured: 29 handymen × 2 actions each = 58 actions, each setting a ~8,800-tile
rectangle → **440ms in a single `interval.day` handler**.

### Guidance

- **Never set a staff rectangle spanning most of the park.** It is behaviourally
  equivalent to having no patrol area at all, but vastly more expensive and it bloats
  the save file.
- Use `mode: 2` (clearAll) to un-zone a staff member. It does no per-tile loop, and
  staff with no patrol area are skipped entirely by the consolidation pass.
- **Small zones are cheap.** A 10×10 zone is 100 tiles against ~8,800 for a park-sized
  one — roughly 1% of the cost. The cost model does not argue against patrol zones; it
  argues against *huge* ones. Community consensus favours small focused zones
  (see [research.md](research.md)), and that remains affordable.
- Whatever the approach, **track which staff you have already handled** so steady-state
  days issue zero actions.

---

## Cost budget

Derived from the measurements above:

| Work | Where it belongs |
|---|---|
| ≤ 5ms | Fine per in-game day. |
| 5–20ms | Needs a real-time cooldown, like the 13ms tile scan behind 30s. |
| > 20ms | Needs to be amortised across ticks, or triggered only by user action. |
| Any cost | Never in `interval.tick` or a UI refresh. |

`map.getAllEntities("guest")` on a large park is the main thing that does not fit —
sample a subset or put it behind a long cooldown.

---

## Debug channel

`src/debug.ts` gives the three management plugins an opt-in telemetry channel that
streams newline-delimited JSON over TCP. Path Connector deliberately does not use it.

**Enable:** tick **"Diagnostics: stream timings to log sink"** at the bottom of any of
the three plugin windows. The flag lives in `context.sharedStorage`, so it is global
across all three plugins, persists across parks, and is read lazily — it takes effect
immediately with no reload.

> The in-game console **cannot** set this — it does not evaluate JavaScript. See
> [api-reference.md](api-reference.md#the-in-game-console-cannot-run-javascript).

**Run the sink** (before or during a session; the plugins reconnect on their own):

```bash
node tools/log-sink.mjs
```

It listens on `127.0.0.1:7777` (loopback only) and appends to `tools/rct-debug.log`,
rotating the previous run to `.log.prev`. Both are gitignored.

### What is recorded

Per-phase timings from each `interval.day` handler (`count`, `totalMs`, `meanMs`,
`minMs`, `maxMs`), plus counters and `context.gameSpeed` so cost can be attributed to
fast-forwarding.

| Counter | Meaning |
|---|---|
| `tileScan` | Full map tile scans performed. |
| `patrolActions` | `staffsetpatrolarea` actions issued. |
| `zoneSkippedDeadPeep` | Actions suppressed because the peep no longer exists. Should stay 0. |
| `carChainWalks` | Vehicle chains walked (memo misses). |
| `rideWrites` | Ride property writes that actually changed a value. |
| `handymanWorkDone` / `mechanicWorkDone` | Productivity-counter gain across all staff that day. |
| `handymenStuck` / `mechanicsStuck` | Staff idle for several days while work existed. |
| `patrolActionsManual` vs `patrolActionsDaily` | Button-triggered bulk clear vs daily delta sync. Kept separate because a button press otherwise looks identical to a bookkeeping bug. |
| `breakdowns` | Actual `ride.breakdown` events. |
| `fleetUnderworked` / `mechanicFleetUnderworked` | Days most of the fleet had nothing to do. Drives adaptive staffing. |
| `capacityBoundRides` | Rides stuck queueing despite recommended settings already applied. |

Each `stats` record also carries a `park` object with guest count, staff counts, path
and owned tiles, litter totals, bin state and the worst litter hotspot — so a formula
can be judged against the park it ran on, not just timed.

### Design notes

- Records are aggregated and flushed on a 2s real-time interval — nothing logs per
  event.
- The enabled check is lazy (a shared-storage read per call), which is what makes the
  toggle live.
- The buffer is capped at 500 records and drops oldest first, so a missing sink cannot
  grow memory without bound.
- `network.createSocket()` throws on a `DISABLE_NETWORK` build; that is caught once and
  the channel marks itself permanently unavailable rather than retrying.

### Reading the log

```bash
# Per-day cost summary per plugin
grep '"kind":"stats"' tools/rct-debug.log | head -20

# Only records where patrol actions were issued
grep 'patrolActions' tools/rct-debug.log
```

---

## Case study: the 440ms day handler

Worth reading before optimising anything here, because the obvious diagnosis was wrong.

**Symptom:** stutter, plus an "Invalid parameter / Staff not found" error toast.

**What the log showed:** `day.syncZones` at 440ms with 58 `patrolActions` on the first
day after a park load; 0ms and 0 actions on every subsequent day. Every other phase — the
tile scan, entity scans, ride updates — was 0–2ms.

**Root cause:** not the tile scan, which was the prime suspect going in. Each handyman
was being assigned a patrol rectangle covering the whole path bounding box, and the
consolidation pass re-unified every staff member's bitmap on every one of the 58
actions.

**Fix:** clear patrol areas (`mode: 2`) instead of setting park-sized rectangles, and
track which staff have been handled so steady-state days issue nothing. Result: 440ms →
105ms on the reload where handymen still carried saved rectangles, and 0ms on every
subsequent day.

**Lessons:**

- Measure before optimising. The tile scan was the intuitive culprit and was never the
  problem.
- "This action is idempotent so it is safe to repeat" is false when the action is a game
  command.
- A separate bug — the stale-staff-array crash — was introduced by the *first*
  optimisation pass and would have been caught immediately by the `zoneSkippedDeadPeep`
  counter had the telemetry existed first. Instrument early.

---

## Field measurements (2026-09-19, 23 in-game days)

A 900-guest park, 12-13 rides, ~30 handymen, 5-6 mechanics, auto-sweep **off**.

### Everything is fast now

| Phase | Worst single day |
|---|---|
| `trash-manager` tile scan | 13ms (behind the 30s cooldown) |
| `trash-manager` everything else | <=1ms |
| `mechanic-manager` whole handler | <=1ms |
| `wait-time-optimizer` whole handler | ~2ms |

Zero patrol actions on every steady-state day. The delta tracking holds.

### Handymen were heavily overstaffed

| Metric | Value |
|---|---|
| Handymen | 29 -> 33, climbing linearly with guests |
| Guests | 793 -> 918 |
| Total litter at any moment | 1-11 pieces |
| **Old litter (the only kind that costs rating)** | **0, all 23 days** |
| **Total handyman work events across ~30 staff, 23 days** | **23** |

About one sweep per day across the whole workforce, and the guest-driven formula
(`ceil(guests / 30) + 2`) keeps hiring forever as the park grows. See
[roadmap.md § S](roadmap.md#s--closed-loop-staffing).

### Mechanics were fine all along

11 fix/inspect events in 23 days across 5 mechanics initially looked like a deficit. It
was not. A second 43-day run with a proper breakdown signal gave **19 observed against
19.6 expected** once the real inspection cadence was worked out: one inspection per ride
every ~38 in-game days.

This is the cautionary tale of the project. Two sessions of data "supported" a
hypothesis that collapsed the moment the denominator was computed. See
[roadmap.md § M2](roadmap.md#m2--small-patrol-zones-for-mechanics) and
[api-reference.md](api-reference.md#inspection-cadence-is-far-slower-than-it-sounds).

**Always compute the expected value before reading a measurement as an anomaly.**

### One ride was capacity-bound, not dispatch-bound

`worstQueueMinutes` sat at exactly 13 every single day for 23 days, with the optimizer
writing ride properties only twice in the entire run. It had already applied min/max
wait and Any Load; the queue did not move. Wait-time tuning cannot fix a ride that is
capacity-limited.

13 minutes is also right against the hard 15-minute walk-out.

---

## Gotcha: the litter rating penalty threshold is ~14 in-game days

`LITTER_OLD_AGE_TICKS = 7680` is often described as "about 3 minutes", which is true in
*real* time at 1x speed (7680 / 40 ticks per second = 192 seconds). But an in-game day
is only ~531 ticks, so in game terms litter must sit for **14.5 in-game days** before it
costs a single rating point.

Consequences:

- A daily auto-sweep makes `oldLitter` **structurally zero** - litter can never survive
  long enough to count. A clean `oldLitter` reading therefore proves nothing about
  handyman adequacy unless auto-sweep is known to be off. This is why the telemetry now
  records the auto-sweep setting.
- Litter still makes guests unhappy *immediately*, which is a separate and more
  immediate concern than park rating.
- Avoiding the litter rating penalty entirely is much easier than the "-600 points"
  headline suggests.

## Field measurements, session 2 (2026-09-19, 43 in-game days)

Same park, grown to 1,189 guests and 16 rides, auto-sweep off.

| Metric | Value |
|---|---|
| Park rating | 991 -> **999 (maximum)**, held for most of the run |
| Handymen | 33 -> 36 (hit the cap; formula demanded 42) |
| Litter at any moment | 2-12 pieces |
| Handyman work events, 43 days, 36 staff | **67** |
| Mechanic work events | 19 (vs 19.6 expected) |
| Breakdowns | 4 |
| Worst queue | 11-14 min, 13 most often, every single day |
| Ride property writes | 15 |

Every day handler stayed at or under 2ms apart from the 13ms tile scan behind its
cooldown, and steady-state days issued zero patrol actions.

### The false-positive lesson

`handymenStuck` fired **734 times** across the run — roughly 32 of 36 handymen every
day. The detector was asking "has this one been idle while work existed?" when it should
have asked "has this one been idle **while its peers worked**?". With one piece of litter
per day and 36 staff, fleet-wide idleness is the correct state, not a fault.

Rewritten to compare against peers; the same measured data now produces **zero** flags
and reports `fleetUnderworked` instead, which is what drives adaptive staffing.

## Field measurements, session 3 (2026-09-19, 37 in-game days)

First run with adaptive staffing and capacity-bound detection enabled.

### The controller worked, then overshot

| Phase | Behaviour |
|---|---|
| Days 1-17 | Target 36 -> 35 -> 34, `fleetUnderworked` true throughout, rating 999. **Correct.** |
| Days 18-37 | Litter climbed 9 -> 18, `oldLitter` reached 4, controller hired 34 -> 40 and kept going. |

Two separate design errors, both mine:

**1. The control signal was lagged by 14.5 in-game days.** `oldLitter` counts litter
aged past `LITTER_OLD_AGE_TICKS` (7680 ticks / ~528 ticks per day). The controller acted
every 2 days on it, so it could hire ~7 staff before the first hire's effect became
visible. Classic overshoot.

**2. The trigger was set at a level that did not matter.** Peak `oldLitter` was 4 pieces
= 16 rating points against a base of 1150, with park rating pinned at its 999 maximum the
entire run. It hired 6 handymen to fix a penalty that cost nothing.

**Fixes:** releases are now judged on *total* litter (immediate) against a reference
captured before the release; hiring only triggers on `oldLitter >= 25` or an actual
rating drop below 900; every change is followed by a settle window longer than the signal
it depends on; and a floor discovered by a failed release is never re-probed.

Convergence is deliberately slow as a result: **14 in-game days per release step**, so
36 -> 12 takes ~326 in-game days. That asymmetry is intentional — understaffing costs
rating immediately, overstaffing only costs wages.

### The stuck detector needed a second fix

Still fired 116 times, consistently **26% of the fleet** (10 of 39). The peer test
("are at least half my peers working?") passed, so everything in the zero-work tail got
flagged. But 26% is a distribution, not an anomaly.

Now additionally requires the zero-work group to be **at most 15% of the fleet** before
anyone is reported. Replaying the measured data produces zero flags; a synthetic lone
outlier among 39 staff is still caught.

### What worked

- Worst queue fell from a constant 13 minutes to 4, with 62 ride writes and `[C]`
  capacity-bound detection firing on 5 rides.
- Mechanic noise is gone entirely: 17 work events, 4 breakdowns, **zero** false stuck
  reports, after moving to the 20-day window and peer comparison.
- Patrol actions: 36 on park load plus 1 per hire. Exactly as designed.

## Field measurements, session 4 (2026-09-19, 62 in-game days)

The rewritten staffing controller's first field test — and it **deadlocked**.

| | |
|---|---|
| Target | 40 for all 62 days. Never moved. |
| Days with `oldLitter == 0` | **1 of 62** |
| Days with `fleetUnderworked` | 24 of 62 |
| Days meeting the release gate (both) | **0** |

**The bug:** hiring required `oldLitter >= 25` ("a handful of old litter costs nothing")
while releasing required `oldLitter === 0` ("any old litter blocks it"). Those two
thresholds express contradictory standards, leaving a dead zone from 1 to 24 in which the
controller could take no action at all. Measured, the park sat in that dead zone almost
every single day.

Fixed by making the release gate use the same standard (`oldLitter <= 8`), plus a new
guard that refuses to shed staff while total litter is actively climbing.

**Lesson, again:** the unit tests all passed because they tested the behaviours I had
thought of. Only the field data showed the gate was unreachable in practice. Both halves
of a control law have to be checked against the *same* real distribution, not just
against each other in isolation.

### Meanwhile

- The park grew hard: guests 1,379 -> 1,680, formula target 48 -> 58, litter average
  15 -> 19. So 40 handymen may no longer be over-provisioned — the deadlock was wrong for
  the wrong reason.
- Litter remained **99.9% vomit** (795 of 796). Handymen clean vomit; they do not prevent
  it. Benches do (`Guest.cpp:1099`), which is what motivated automatic amenity placement.
- Mechanics: 10 breakdowns, 36 work events, 1 stuck flag. Healthy.
- Wait-time: 74 ride writes, 6 capacity-bound detections. Working.

## Field measurements, session 5 (2026-09-19, 17 in-game days)

Validation run for the deadlock fix, plus first exposure of the amenity feature.

### The staffing deadlock fix works

| | |
|---|---|
| Target | 40 -> **39** on day 4, then held through the settle window |
| `settling` | counted 10 -> 0 exactly as designed |
| `handymenStuck` | **0** — the peer + outlier-fraction guards hold |
| Park rating | 999 throughout |

The controller now moves. Two rounds of false-positive suppression on the stuck detector
also appear settled: zero flags across the run.

### Bug found: money is in TENTHS of a pound

`amenitySkippedLowCash` fired 6 times in 17 days and **nothing was ever placed**.

`operator""_GBP` multiplies by 10 (`core/Money.hpp:27`), so money64 is tenths of a pound.
The cash floor was written as `5000_00` assuming hundredths, making it £50,000 instead of
£5,000 — above the park's balance every time the pass ran, so the feature silently did
nothing.

**This is the failure mode worth remembering:** the feature did not error, did not warn,
and looked fine in the UI. Only a counter in the telemetry showed it. Instrument the
*skip* paths, not just the success paths.

### Bug found: vomit threshold never reachable

`VOMIT_MIN_TO_REPORT` was 5, but measured vomit clusters peak at **3-4 pieces per 8x8
cell** because handymen sweep continuously. The advisor never fired once. Lowered to 3.

Same shape as the staffing deadlock: a threshold that looked reasonable in the abstract
but sat outside the range the game actually produces. **Check every threshold against a
real distribution before shipping it.**

### Other plugins

- Mechanics: 4 breakdowns, 10 work events, `fleetUnderworked` on 10 of 17 days —
  consistent with the case for [MS](roadmap.md#ms--adaptive-mechanic-staffing).
- Wait-time: 31 ride writes, **8 capacity-bound detections**. W3 is earning its place.

## Bug: "Can't build this on sloped footpath"

Reported from play after automatic amenity placement was enabled. The amenity planner
filtered queue tiles and occupied tiles, but `FootpathAdditionPlaceAction::Query` rejects
placements for **five** reasons, not two.

Two were missed:

- **sloped paths** (`slopeDirection !== null`) — the reported error;
- **tiles with all four edges connected** (`edges === 0x0F`) — an enclosed interior plaza
  tile has no free edge to stand a bench against.

Two more (level crossings, object-specific flags) are not exposed to the scripting API at
all, so no amount of up-front filtering can be complete.

**Fix, in two layers:**

1. Filter the detectable cases when reading tiles (`blocked` on `AmenitySite`).
2. **`queryAction` before `executeAction`.** A failed execute pops an error window at the
   player; a failed query is silent. This makes any undetectable refusal a no-op instead
   of a complaint.

The same bug existed in Path Connector's auto-bin placement, which additionally used the
*surface* element's `baseZ` rather than the footpath's — harmless on flat ground, wrong
on any raised path. Both are fixed.

**Lesson:** when driving a game action, read its full `Query` implementation and count the
rejection paths. Filtering the one you happened to hit leaves the rest live. Where the
game can refuse for reasons you cannot inspect, query first rather than guessing.

## Amenity placement: making it dense without making it slow

Feedback from play: vomit was still widespread and too few benches and bins were being
bought. The original budget was deliberately timid — 3 placements per 30 seconds, only
within 4 tiles of a ride exit, stall or vomit cluster.

**Why it was safe to open up.** `FootpathAdditionPlaceAction::Execute` is O(1): one tile
lookup, a few field writes, one `MapInvalidateTileFull`, no global loops. It is nothing
like `staffsetpatrolarea`, whose cost scales with rectangle area and re-unifies every
staff member's bitmap on every call. Checking this first is what justified the change
rather than guessing.

New settings: **15 placements per 10 seconds**, radius 6, and an amenity within 3 tiles
(down from 5) counts as covering a spot.

### Blanket coverage

Targeted demands alone only ever produce clusters near rides and stalls. The tile scan
now also remembers **one placeable path tile per 6x6 cell**, collected free during a walk
it already does, and emits a low-weight bench and bin demand for each. Targeted demands
always outrank them, so coverage fills in whatever budget is left over — and across
passes it spreads seating over the whole path network.

Candidates skip sloped, queue and fully-enclosed tiles up front, since the game would
refuse those anyway.

### The cost trap this introduced

Blanket coverage takes demands from ~20 to ~180. The planner is O(sites x demands), and
its satisfied-check scans every site for every demand — so the cost would have peaked at
roughly 360,000 operations per pass **in the steady state where everything is already
covered**, which is the state that runs forever.

Fixed with a coarse spatial index built while reading tiles: packed cell key -> bitmask
of which amenity kinds are present. A demand whose own cell or any of its eight
neighbours already holds the right kind is dropped before the planner sees it, turning
the steady-state case into a handful of demands rather than all of them.

`amenityDemandsOpen` records how many survive each pass, so if this ever stops working it
shows up as a number rather than as a stutter.

## Testing

```bash
node tests/run.mjs
```

140 tests across 9 suites. The runner compiles `src/*.ts` for the pure modules into
`tests/build/` and executes every `*.test.mjs`.

**Why the pure modules exist.** `hotspots`, `staff-activity`, `staffing`, `vomit`,
`amenities`, `needs`, `thoughts` and `ops` deliberately touch no OpenRCT2 globals, so all
the decision logic runs under plain node with no game. Everything that touches `map`,
`context` or `park` stays in the four plugin entry points and is verified in-game through
the telemetry channel instead.

That split has paid for itself repeatedly. Tests caught, before shipping:

- a staffing controller whose hire and release gates left an unreachable dead zone;
- a stuck-staff detector that flagged 26% of the fleet as an anomaly;
- an amenity planner that would have removed player-placed benches;
- `hot_dog_much` categorising as an item rather than a surplus, because a naive split on
  `_` breaks on multi-word item names.

**Add a test whenever you add a decision.** The recurring failure mode in this project is
a threshold that looks sensible but sits outside the range the game actually produces —
a test that replays measured data is the cheapest way to catch that.

### Telemetry counters added 2026-09-20

| Counter | Meaning |
|---|---|
| `guestsSampled` | Guests read by the rotating need/thought sampler. |
| `needGapsReported` / `guestProblemsReported` | Console reports emitted. |
| `opsProbeAccepted` / `opsProbeRejected` | Operation-range probing outcomes. |
| `opsSet` / `opsSetRejected` / `opsSetFailed` | Operation changes applied or refused. |
| `opsActions` | Operation actions issued per pass (budgeted). |

Park context gained `problems` (top guest complaint categories),
`handymanWagesPerMonth` / `mechanicWagesPerMonth` and their formula baselines, plus the
mechanic `adaptiveTarget` / `settling` / `discoveredFloor` triplet.

## Field measurements, OPS first run (2026-09-20, 18 in-game days)

First exposure of ride operation tuning, run deliberately in isolation.

### It works, and it is safe

| | |
|---|---|
| Probes issued | 7 (5 rejected, 2 accepted) |
| Ranges discovered | 2 of 10 rides |
| Operation changes applied | **1** |
| `opsSetRejected` / `opsSetFailed` | **0 / 0** |
| `day.opsTuning` cost | **1ms total, 1ms worst** |

No failures and no error windows — the query-first pattern held again. Cost is negligible.

### But it converged far too slowly

Only 2 of 10 rides finished probing in 18 in-game days, and a single change landed.

**The bug was a shared action budget.** Probes and sets were both drawn from one
`OPS_MAX_ACTIONS = 2` per pass, but they cost completely different things:

- a **probe** is a `queryAction` — it changes nothing, shows the player nothing, and is
  the only way to discover a ride's legal range;
- a **set** discards the ride's excitement/intensity/nausea until it runs again.

Sharing one budget meant probing starved the very thing it exists to enable, while the
genuinely expensive action was no rarer for it.

Split into `OPS_MAX_PROBES = 10` and `OPS_MAX_SETS = 1` — probing roughly 5x faster and
actual changes *more* conservative than before.

**Lesson:** budget by cost, not by call count. Two operations sharing an action budget
should be sharing a cost model first.

### Telemetry added

Park context now carries `ops: { rangeKnown, tuned, values }` — how many rides have had
their range discovered, how many have been tuned, and the current value per ride name. The
counters alone could not say whether a change was sensible; the values can.

## Field measurements, OPS second run (2026-09-20, 18 in-game days)

The probe-budget split worked. The set path did not.

| | Run 1 | Run 2 |
|---|---|---|
| Ranges discovered | 2 of 10 | **8 of 10** |
| Probes issued | 7 | 32 |
| **Operation changes applied** | 1 | **0** |
| Cost | 1ms | <1ms |

### The consecutive-run counter was unreachable

Queues oscillated either side of the 5-minute threshold all run (worst queue moved
10 -> 8 -> 5 -> 3 -> 4), and `CONFIRM_OBSERVATIONS` required **four consecutive** identical
readings. A single dip from 5 to 4 minutes reset `streak` to 1 and discarded three
accumulated confirmations, so no ride ever reached the gate.

**This is the same failure as the staffing deadlock**, in a different module: a gate that
passes every unit test but is unreachable against the distribution the game actually
produces. It got the same fix — a **signed accumulator that decays** toward neutral on a
quiet reading rather than discarding history. A mostly-congested ride now converges; one
genuinely flapping between extremes still cancels itself out.

A second bug fell out of the same change: the decision branch was reading the
*instantaneous* pressure rather than the accumulated direction, so a congested ride
sampled during a quiet moment would have been lengthened — exactly backwards.

### Community research changed the design

Vetting against community practice (see [research.md](research.md#ride-operation-settings-added-2026-09-20))
surfaced a trap the original design would have walked into:

- Intensity must stay **below 10** or excitement caps around 5.50.
- More rotations/laps/swings **raise** intensity.
- So lengthening an already-extreme ride makes guests avoid it more, emptying the queue
  further, inviting another lengthen — a feedback loop into uselessness.

`ops.ts` now refuses to lengthen any ride at intensity >= 9.00, **including during blind
midpoint calibration** (the first attempt slipped through precisely there, caught by a
test). The guard is one-directional: an extreme ride with a long queue is still shortened,
since that lowers intensity.

Community range check: swinging ship swings run 7-25, so the probe ceiling of 32 is
correctly above the real maximum.

## Field measurements, OPS third run (2026-09-20, 30 in-game days)

The accumulator fix worked — and exposed two more bugs, one of which the community
research had already predicted.

| | Run 1 | Run 2 | Run 3 |
|---|---|---|---|
| Ranges discovered | 2/10 | 8/10 | 9/10 |
| **Rides tuned** | 0 | 0 | **3** |
| Sets applied | 1 | 0 | **4** |
| **Sets refused** | 0 | 0 | **2** |

Tuned: Rowing Boats 8, Pegasus Ride 9, Twist 1 3. Cost stayed under 1ms.

### Bug: the minimum is not 1

Two sets were refused. The cause was assuming every ride's range starts at 1.

`RideOperatingSettings` carries **both** a MinValue and a MaxValue, and neither is exposed
to plugins. The community research had already flagged the example: a swinging ship
accepts **7 to 25** swings. Stepping such a ride down below 7 is refused.

Worse, the wiring reported that refusal via `noteProbe(..., false)`, which **halved the
discovered maximum** — corrupting the ceiling every time the floor was hit.

Fixed with a dedicated `noteSetRejected` that infers direction from the ride's known
current value: a refusal stepping *down* raises the floor, one stepping *up* lowers the
ceiling. The two can no longer cross.

### Bug: probing found a lower bound, not the maximum

The halving descent stopped at the first accepted value, so a ride whose true maximum is
25 would settle at 16 and have the top of its range permanently unavailable.

Replaced with a proper binary search over `probeLow` / `probeHigh`. Probes are
`queryAction` calls — they change nothing and show the player nothing — so there was never
a reason to settle for an approximation. It converges when the bounds are adjacent and
terminates because the gap strictly shrinks on every answer, with a hard ceiling of 255 so
a permissive ride cannot climb forever.

### Note on attribution

Worst queue rose from 5 to ~10 minutes across this run while OPS was active. **Do not read
that as OPS making things worse** — only 3 of 10 rides were tuned, and mostly via the
initial midpoint calibration rather than a directional decision. The park was also growing.
There is not enough evidence to attribute the queue trend either way yet.

---

## Field measurements: growth session (2026-09-20, 121 sampling sweeps)

The most informative run so far, because **the park grew**: 573 → 927 guests, park rating
875 → 955. Several features that had been measured flat on a small park started producing
signal, and one long-standing hold was lifted as a result.

### Cost

Nothing regressed. Every per-day timing stayed at or below 2ms:

| Pass | Cost |
|---|---|
| `day.needSample` | **1ms** (250 guests/window) |
| `day.updateCache` (wait-time) | 2ms |
| `day.applyToAll` | 1ms |
| `day.opsTuning` | **0ms** |
| everything else | 0ms |

`day.needSample` at 1ms for a 250-guest window on a 927-guest park is the number that
makes NEEDS Phase 3 affordable. The rotating window is doing its job — a full
`getAllEntities("guest")` sweep would be several times that.

### Both staffing controllers are earning their keep

This is the first run where the adaptive controllers can be scored against the formula on
a park large enough for the difference to matter:

| | Adaptive | Formula | Saving |
|---|---|---|---|
| Handymen | **18** | 29 | £750/month |
| Mechanics | **3** | 6 | £240/month |

**£990/month**, with park rating *rising* (875 → 955) and total litter at 1 piece,
`oldLitter` 0. The formula would have hired 14 more staff to achieve the same result.
`litterAverage` sat at 0.6 pieces.

### NEEDS Phase 1's exit criterion fired

The full table is in [roadmap.md](roadmap.md#needs--guest-need-clustering-then-automatic-facility-placement).
The short version: `hunger` at (4, 4) persisted across **63 of 121 sweeps** at **78 tiles**
from the nearest food stall, and park-wide unmet needs went from essentially zero to 90
hungry / 59 thirsty / 76 needing a toilet out of 933 sampled.

**This is what an instrument-first process is supposed to produce.** The same discipline
closed [M2](roadmap.md#m2--small-patrol-zones-for-mechanics) and
[C](roadmap.md#c--bin-placement-advisor) without building anything; here it opened a gate
that had been held shut for several sessions. The criterion was written down in advance
and then honoured in both directions.

### What guests actually complain about

First good look at this, via the thought accumulator. Peak counts:

| Category | Top thought | Peak |
|---|---|---|
| **pricing** | `bad_value` | **134** |
| **pricing** | `cant_afford_ride` | **130** |
| needs | `toilet` | 105 |
| queue | `crowded` | 91 |
| queue | `queuing_ages` | 67 |
| sickness | `sick` | 43 |
| leaving | `go_home` | 17 |

Two things worth recording:

1. **Pricing outranks everything this project was built to solve.** No plugin here
   addresses it, and that is a deliberate scope call — a separate price-manager plugin is
   the right home. Noted so a future session does not rediscover it and assume it is
   unhandled.
2. **Queue complaints are real**, which is the measured support for
   [W2](roadmap.md#w2--more-aggressive-emergency-override). `crowded` at 91 and
   `queuing_ages` at 67 are not a hypothetical problem.

### Amenity placement has saturated, and that is correct

`amenityDemandsOpen` totalled 619 across 33 passes (~19 per pass) against only 7
placements — which looks alarming until the skip counters are read: **`amenityPlaceRefused`,
`amenityPlaceFailed` and `amenitySkippedLowCash` never appeared at all.**

So nothing was refused and nothing was blocked. The park's 352 path tiles are simply
already covered from earlier sessions, and `planAmenities` is correctly finding its
candidate sites occupied. Demand remaining "open" is the expected steady state on a
saturated park, not a failure.

Worth stating plainly because the raw ratio invites the opposite conclusion. **The skip
counters are what distinguish "did nothing because nothing was needed" from "did nothing
because it was broken"** — the distinction five dead features on this project were missing.

### OPS, third run — one open question

`opsProbes: 130` against `rangeKnown: 8` and `tuned: 1`. Probing terminates and costs
0ms, but 130 probes for 8 discovered ranges is more than a binary search over ~12 rides
should need.

**Hypothesis, not a conclusion:** probing may be re-running for rides whose range is
already known. Worth checking next run before changing anything — the last time a
measurement here was called an anomaly without computing the expected value first, it
cost a session (see [M2](roadmap.md#m2--small-patrol-zones-for-mechanics)).

Expected probe count for a binary search over a 1-255 range is ~8 per ride; 12 rides
would be ~96, so 130 is high but not wildly so. It may simply be the two rides whose
ranges are still unknown being re-probed. **Measure before acting.**

---

## Field measurements: the regression session (2026-09-20, 163 in-game days)

The run that caught a bug I introduced. Reported from the game as *"ride still hasn't been
fixed"*, and the telemetry explained it completely.

### The symptom

| | |
|---|---|
| Longest run of days with a broken ride | **11 consecutive** |
| A ride broken at log end | **8+ days and counting** |
| Days with at least one ride broken | 24 of 167 |
| `stuckBroken` (rides broken 3+ days) | reached **1** |
| `minReliability` | decayed **59% → 36%** |
| Mechanics | 5 → 4 → **3**, against a formula target of **6** |

### Was it actually understaffing? Compute the expected value first

The [M2](roadmap.md#m2--small-patrol-zones-for-mechanics) lesson, applied before drawing a
conclusion:

| | |
|---|---|
| Log span | 88,474 ticks ÷ ~541 = **163.5 in-game days** |
| Inspection period per ride | 10 × 2048 = 20,480 ticks |
| Inspection cycles elapsed | 88,474 ÷ 20,480 = **4.32** |
| **Expected** work events (4.32 × 13 rides + 5 breakdowns) | **61.2** |
| **Observed** `mechanicWorkDone` | **44** |
| Ratio | **72%** |

Against **~100%** measured at 7 mechanics in the M2 analysis. So yes — this is a genuine
deficit, not an arithmetic error on our side. The same test that *rejected* M2 *confirms*
this one, which is the point of having it.

### The cause: a threshold in the wrong units

`mechanic-manager.ts` maps mechanic signals onto the shared `staffing.ts` controller. That
controller's thresholds are expressed in **pieces of litter**:

| Gate | Threshold | Mechanic signal | Reachable? |
|---|---|---|---|
| urgent hire | `oldLitter >= 25` | `ridesBroken`, max 2 on a 13-ride park | **Never** |
| urgent hire (alt) | `parkRating < 900` | rating was 955-957 | **Never** |
| allow release | `oldLitter <= 8` | `ridesBroken`, 0-2 | **Always** |

The controller could **only ever fire mechanics**. `mechanicFleetUnderworked` fired on 60
of 167 days — and an idle fleet with an unrepaired ride is not slack, it is a
*reachability* problem, so firing into it made things worse.

> **The roadmap said MS "inherits the same worst case: identical to current behaviour".**
> That was wrong, and wrong in an interesting way. Reusing a controller reuses its
> *shape*, not its *calibration* — and the calibration is the part that encodes what the
> numbers mean. This is the project's recurring failure (a threshold outside the range the
> game produces) appearing in a place the existing discipline did not look: not in a new
> constant, but in an old one applied to a new signal.

### The fix, and the second bug it exposed

`StaffingThresholds` is now an explicit parameter. Litter defaults are unchanged, so
handyman behaviour is bit-for-bit identical — the 18 handyman tests passed untouched
through the refactor. Mechanics get `MECHANIC_THRESHOLDS`, and the urgent signal changed
from *rides broken now* to *rides broken for 2+ consecutive days*.

Writing the test for that immediately exposed the **mirror-image bug**: `discoveredFloor`
is raised on every urgent hire and never lowered, so a ride broken because no mechanic can
physically reach it ratchets the floor up to the formula ceiling and pins it there
permanently, destroying every saving the controller had found. A one-way ratchet up is no
better than a one-way ratchet down.

`floorDecayDays` relaxes the floor by one step after a long, genuinely quiet stretch,
making it a strong prior rather than a life sentence. **Disabled for handymen** — that
controller is measurably working and the failure has only been observed for mechanics.

### OPS: 192 probes, 8 ranges, 1 tuned

Last session flagged `opsProbes: 130` against `rangeKnown: 8` as "high but not wildly so —
measure before acting". This run: **192 probes, still 8 ranges, still 1 tuned**, and the
single tuned ride's identity had changed between sessions. That settles it.

**Cause:** `update()` deleted the entire record for any ride absent from the pass — but a
ride leaves the optimizable list whenever it closes or breaks down, which happened on 24
of 167 days. Every exit threw away the discovered value range, so binary search restarted
from scratch on the ride's return.

The range is a property of the ride **type** and cannot go stale while the ride exists.
Records now survive an absence; only the queue streak resets, because a ride closed for a
week has no meaningful recent trend. Ride ids are reused when a ride is demolished, so
identity is checked against the ride **type**, not the name — a player renaming a ride must
not discard a hard-won probed range.

### Facility building could not fire

`autoFacilities: true`, `facilityConfirmed: 0`, and `facilityPending` showing every gap
stuck at 1-2 sweeps against a requirement of 8. Two compounding causes:

1. **The sweep rate was assumed, not measured.** `confirmSweeps: 8` was set "at roughly one
   sweep per in-game day". A sweep actually needs a full pass over every guest, and the
   whole session produced about **four** complete sweeps (4,015 new samples ÷ 250 per
   window ÷ 3.8 windows per sweep). The gate was unreachable. Sampling is now 400 guests
   every 2.5s instead of 250 every 5s — roughly 3x the sweep rate for a worst case still
   under 10ms — and `confirmSweeps` is 5.
2. **`needs.top(kind, 2)` evicted persistent clusters.** Three hunger regions — (4,4),
   (60,92) and (76,68) — competed for two slots, so each was seen about two-thirds of the
   time and the tracker's decay-on-miss ate the progress. Now top 4 per kind, which costs
   nothing since the array is already sorted.

### W2 telemetry was unreadable

`risingQueues: 1` alongside `queuePreemptive: 0` — contradictory, and it made the feature
impossible to evaluate. `risingCount()` had no idea what the caller's warning threshold
was, so it also counted rides already in "warning". Now counted from the verdicts the pass
actually produced (`risingQueues` / `warningQueues`).

Queues did improve over the run — worst 9 → 5 minutes, long queues 3 → 1, capacity-bound
3 → 0 — but **this cannot be attributed to W2**, because the telemetry shows W2 never
fired. Something else did that, most likely the OPS change to Twist 1 plus ordinary park
growth. Next run will be the first that can actually answer the question.

### Costs: no regression

| Pass | Max |
|---|---|
| `day.tileCache` | 15ms (behind a 30s cooldown — within budget) |
| `day.amenities` | 7ms |
| `day.needSample` | 4ms (will rise with the larger window) |
| `day.updateCache` | 2ms |
| everything else | ≤1ms |

### Still true, still not acted on

- **Pricing remains the largest complaint**: `cant_afford_ride` 132, `bad_value` 134,
  above `needs/toilet` at 84. Out of scope by choice.
- **Sickness is rising**: `needs.sick` 8 → 23 and the `sickness` complaint 43 → 64, with
  only 2 first aid rooms. Not acting yet — `verySick` is still 1, and guests only seek
  first aid at nausea 200. Instrument first.
- **`brokenBins` is still 0**, so SEC stays unscoped.

---

## Field measurements: the validation session (2026-09-20, 41 in-game days)

The first run after the regression fixes. **Three of the four fixes are confirmed working
in the field**, one feature built its first real thing, and the run surfaced one new logic
flaw plus one open question that the data cannot yet settle.

### Confirmed fixed

#### Mechanic staffing — the reported bug

Traced day by day, this is textbook:

| Tick | Mechanics | `longestBrokenDays` | `unattended` | `minReliability` |
|---|---|---|---|---|
| 156495 | 3 | 0 | 0 | 36% |
| 158133 | 3 → **2** | 0 | 0 | 35% |
| 171611 | 2 | 1 | 0 | 25% |
| 172139 | 2 → **3** | **2** | **1** | 24% |
| 173196 | 4 → **5** | 4 | 1 | 23% |
| 173725 | 5 → **6** | 5 | 1 | **33%** |
| 176367 | 6 | **0** | **0** | **45%** |

It released to 2 while the park was quiet, detected the unattended breakdown on day two,
hired to the formula target, and reliability recovered 23% → 45%. `stuckBroken` returned
to 0. **The one-way ratchet is gone.**

#### OPS record retention

`rangeKnown` climbed 0 → 1 → 8 → 9 → **10 and held there** across ride closures, where
before it was pinned at 8 forever. `tuned` went 0 → **4**, and the values persist:

```
{"Neptune and Sirens Ride":3,"Rowing Boats":8,"Twist 1":5,"Pirate Ship 1":13}
```

`Pirate Ship 1: 13` is the nice one — a swinging ship, and 13 sits inside the 7-25 range
the community research predicted. The per-ride minimum discovery is working on real data.

**69 probes for 10 ranges** this session. A binary search over the 1-32 probe ceiling is
~5 probes per ride, so ~60 for 12 rides. That is the expected value, computed rather than
eyeballed.

#### Facility building — it built something

**`facilityPlaced: 1`.** A toilet, taking the park from 3 to 4. `facilityDirection0: 1`,
so the computed direction guess was right first time and the rotation probe never needed
its fallbacks. **`facilityOrphanDiscarded: 0`** — site validation held.

And it worked:

| | Before | After |
|---|---|---|
| `needs.toilet` | 64 | **50** |
| `needs.toiletUrgent` | 45 | **29** |
| `needs/toilet` complaint rank | **#2** (84) | #4 (50) |

`facilityPending` now shows streaks climbing to 5-9 instead of sticking at 1-2, so the
sweep-rate and top-4 fixes both landed.

#### W2 telemetry

`queuePreemptive: 8` — the feature demonstrably ran, which could not be established before.
`risingQueues` and `warningQueues` no longer contradict each other.

### New bug: OPS calibrated congested rides in the wrong direction

With no known current value, the controller set a ride to the **midpoint** of its legal
range. That is direction-blind: a congested ride whose actual value sat below the midpoint
would be **lengthened**, cutting throughput on exactly the ride that needed more of it.
And since `operationOption` cannot be read back, nothing could notice.

Fixed: a congested ride with an unknown current value now calibrates to its **minimum** —
the shortest cycle the ride type allows, hence maximum throughput. An empty ride still
calibrates to the midpoint, because a longer ride costs nothing when nobody is waiting.

### New bug: urgent hires were not paced

The mechanic controller hired **four times in four days** (2 → 6, straight to the
ceiling). The ride stayed broken for **8 days regardless**, so the extra hires bought
nothing, tripled the wage bill from £160 to £480/month, and — because every urgent hire
raises `discoveredFloor` — left the controller pinned at the ceiling afterwards.

The urgent branch correctly bypasses the settle window (an emergency should not wait) but
was also bypassing *any* pacing. `urgentHirePaceDays: 3` now makes it hire one, wait, and
re-check. Releasing stays blocked throughout, so the emergency response is unchanged —
only the *extra* hires are withheld. 0 for handymen, preserving their behaviour.

> The deeper reading: **a ride broken for 8 days while headcount tripled is not a staffing
> problem.** That is the [M3](roadmap.md#m3--emergency-repair) case — a ride no mechanic
> can physically reach. Pacing stops the controller throwing staff at something staff
> cannot fix; M3 is the actual answer, and it is off by default.

### Open question the data cannot settle: queues got worse

| | Start | End |
|---|---|---|
| `worstQueueMinutes` | 6 | **16** |
| `longQueues` | 1 | 4 |
| `capacityBound` | 0 | 4 |
| `criticalQueues` | 0 | 1 |

16 minutes is **past the 15-minute walk-out cliff**, so guests are abandoning queues. This
matters and it is not yet explained. Three candidate causes, and the timeline does not
separate them:

1. **OPS lengthening cycles.** The gradual 7 → 10 rise tracks `tuned` climbing 0 → 4. The
   midpoint-calibration bug above is a real mechanism for this, now fixed.
2. **The 8-day breakdown.** The jump from 10 → 15 lands exactly at tick 173196, when the
   ride went down and mechanics were at 2. A broken ride pushes its guests into other
   queues.
3. **Park growth.** 940 → 980 guests. Real, but 4% growth does not explain a 166% rise in
   queue time on its own.

There is also a fourth possibility worth naming honestly: **W2 itself.** Applying Any Load
early trades capacity-per-dispatch for dispatch rate, and `capacityBound` rising 0 → 4 is
precisely the counter-failure predicted when W2 shipped. `queuePreemptive: 8` means it did
fire.

**No attribution is being made.** The next run has one clear logic fix removed from the
picture (OPS calibration) and mechanics that should no longer let a ride sit broken for 8
days, which should isolate the remaining causes. If queues still degrade with
`queuePreemptive` firing, W2 is the suspect and should be tested with it off.

### Why `facilityNoSite` fired 7 times

Three gaps stayed confirmed all session and never got built:

| Gap | Sweeps | Distance to nearest |
|---|---|---|
| hunger @ (4,4) | 9 | **78 tiles** |
| toilet @ (4,4) | 7 | **73 tiles** |
| hunger @ (60,92) | 9 | 23 tiles |

The decision layer was working perfectly; there was simply nowhere within `siteRadius: 6`
that passed site validation. Raised to **10**, which stays under `minDistance: 12` — an
invariant now asserted in the tests, because a site further away than the facility guests
already walk to would be no improvement at all.

**And the rejection reasons are now counted** (`siteRejectOccupied`, `siteRejectSloped`,
`siteRejectUnowned`, `siteRejectNoPath`, `siteRejectNotSurface`, `siteAccepted`). The fix
above had to be *inferred* because `facilityNoSite` said only "no site", not which of five
conditions rejected the tiles. Next time it will be a reading rather than a deduction —
the instrument-the-skip-paths rule applied one level deeper than before.

### Costs

Unchanged and comfortable. `day.needSample` stayed at 4ms even with the window raised
250 → 400, so there is headroom if the sweep rate needs raising again.

---

## Field measurements: a fresh scenario (2026-09-20, 48 in-game days)

**The tick counter reset (177953 → 104968), so this is a different park, not a
continuation.** Rating 0 → 787, guests 0 → 99, 3 rides, 105 path tiles. A scenario started
from scratch.

That matters for what can be concluded: **the queue regression from the previous session
is still unanswered.** Worst queue here is 2 minutes on a 99-guest park, which tests
nothing. It stays open.

### Everything behaves correctly at small scale

No litter at all, no breakdowns, 100% reliability, no queues. Both adaptive controllers
sit below the formula, which is the right answer on a park this quiet:

| | Adaptive | Formula |
|---|---|---|
| Handymen | 3 | 6 |
| Mechanics | 2 | 3 |

Worth noting explicitly because it is the first time these controllers have been observed
on a *small* park — every previous measurement was on a mature one with 900+ guests. They
do not misbehave at the other end of the range.

### The cash floors were calibrated for a mature park

`amenitySkippedLowCash: 17` and `facilitySkippedLowCash: 16`. Both features were blocked
for essentially the whole run, on a park that had **no food stall, no drink stall and one
toilet**.

Source-verified build costs (`ride/rtd/shops/*.h`, `.BuildCosts`):

| Facility | Cost |
|---|---|
| Food stall | **£300** |
| Drink stall | £250 |
| Toilets | £225 |

The facility cash floor was **£20,000** — sixty-six times the cost of the thing it gates,
and only one is built per pass. The amenity floor was £5,000 against footpath additions
priced in tens of pounds.

Lowered to £2,000 and £1,000 respectively, both still comfortably covering a full pass.

> **This is the same mistake as `URGENT_OLD_LITTER = 25` on ride counts, in a new
> disguise.** Not a unit error this time — a *regime* error. The floor was chosen against
> an imagined park (mature, six figures banked) rather than the range parks actually
> occupy, which includes starting with £10,000. A threshold can be correct for the park
> you tested on and wrong for the park the player is on.
>
> It also inverts the intended safety: a stall costs £300 and *earns* money, so refusing
> to build one on a park that can easily afford it is the expensive choice, not the
> cautious one.

### Not acted on

`facilityConfirmed: 0` with no pending gaps — but `needs` are genuinely all zero
(0 hungry, 0 thirsty, 0 needing a toilet out of the sample). The park has no unmet-need
problem to solve yet, so `minGuests: 5` was left alone despite being a large fraction of a
99-guest park. If gaps appear and still fail to confirm at this scale, that is the number
to look at — but there is no evidence for it yet.

---

## Bug: the rotating guest sample never completed a sweep on a growing park

Reported from the game as *"it isn't building any shops or first aid or bathrooms"*. The
facility builder was correct throughout; it had simply never been handed a single
observation.

### The evidence

| Reading | What it showed |
|---|---|
| `needs.sampled` | **Frozen at 179** across 6+ consecutive records while guests grew 189 → 214 |
| `guestsSampled` | 1,098 over 78 in-game days — one real sweep, then dribs |
| `siteReject*` counters | **All absent.** `collectFacilitySites()` was never called once |
| `problems` | One stale entry (`go_home`, count 6) for the entire run |
| `facilityConfirmed` / `facilityPending` | 0 and `[]` throughout |

Every need read **zero** on a park with **no food stall, no drink stall and one toilet**
serving 214 guests. That is the reading that gave it away: zero unmet need is plausible,
but not on a park with nowhere to eat.

### The cause

```
needSampleOffset = Math.min(needSampleOffset + WINDOW, guests.length);
// ...next pass:
if (needSampleOffset >= guests.length) { publish(); }
```

The offset is clamped to `guests.length`, so it can **equal** the guest count but never
exceed it. The completion check then ran at the *start of the next pass* — by which time
a growing park reports a larger `guests.length`, so `200 >= 206` is false and the sweep
never completes. The accumulator kept collecting and never published, so
`facilityTracker.observe()` was never called and no gap could ever accumulate a sweep.

**Nothing errored.** Every individual step did exactly what it said.

### Why several sessions of field testing missed it

A *stable* park hides it completely. At ~940 roughly-constant guests the offset lands
exactly on the count and the next pass's comparison happens to hold, so sweeps complete
normally — which is precisely what the mature park did across every earlier session. Only
a park in its growth phase exposes it, and the growth phase is the one regime that had
never been profiled.

> This is the third distinct flavour of the same root problem on this project. First a
> **unit** error (litter thresholds applied to ride counts), then a **regime** error (a
> £20,000 cash floor on a starting scenario), now a **regime** error again — logic
> correct for a steady-state park and wrong for a growing one. The recurring lesson is
> not "check your constants". It is **"the range of conditions you tested under is itself
> an assumption"**.

### The fix

Sweep completion is now decided from the pass that just ran, not from the next one. The
window arithmetic moved out of the plugin into `createSampleRotation` in `needs.ts`,
where it is covered by **13 tests** including the growing-roster case, a shrinking roster
(which would strand the offset past the end just as surely), exact-boundary windows, and
a check that one sweep visits every index exactly once.

New counter `needSweepsCompleted` makes the failure directly visible next time: if it is
0 while `guestsSampled` climbs, the sweep is stuck again.

### Also confirmed in this run

The cash-floor fix **worked**. `facilitySkippedLowCash` fired from tick 106025 to 131746
and then stopped entirely, while the log ran on to 147249 — the feature cleared the cash
gate for the last ~28 in-game days and was blocked only by the empty tracker.

---

## The 206ms getter: `ride.stations` rebuilds on every access

The worst performance regression this project has shipped, and the cheapest fix.

**Symptom.** The player reported noticeable lag. `staff-extras` was costing **206-210ms
every in-game day** on a park with **11 rides and 4 entertainers**, against a 5ms budget:

| Plugin | Daily total |
|---|---|
| **staff-extras** | **207-210ms** |
| trash-manager | 1-15ms |
| wait-time-optimizer | 2-3ms |
| mechanic-manager | **0ms** |

**What made it hard to see.** Mechanic Manager runs a structurally identical pass —
including the same `map.getAllEntities("staff")` call, on the same park — for 0ms. Every
function in the expensive path was individually trivial: a filter over 11 rides, a census
loop, a sort over at most four entries. Reading the code did not find it, and three
rounds of reasoning about it produced three wrong hypotheses.

**The cause.** `ride.stations` is a **getter that rebuilds its array on every access**.
The loop touched it twice per iteration:

```ts
for (let j = 0; j < r.stations.length; j++) {   // rebuild
    const st = r.stations[j];                   // rebuild again
```

The wait-time optimizer does the same work for 2ms because it reads it **once**:

```ts
ride.stations.forEach((s) => { ... });
```

Hoisting it to `const stations = r.stations;` took the pass from **206ms to 1ms**.

**The lesson, and it generalises past this one property.** In a QuickJS environment with
no JIT, an API property that looks like a field can be an allocating call. A loop
condition is the worst place to put one, because it runs every iteration and reads as
free. Treat `ride.stations`, `map.rides`, `ride.vehicles` and anything else that returns a
fresh array as a **function call**: hoist it, and never put it in a loop test.

**What actually found it.** Not analysis — sub-timings. `cache.queueSignals` and
`cache.entertainers` were added specifically because the aggregate said 206ms without
saying which call. They immediately read 1ms and 0ms, which is what confirmed the hoist
was the fix rather than the cooldown that shipped alongside it.

---

## Field measurements: closing session (2026-09-20)

### Everything fixed this session, confirmed in the field

| Fix | Before | After |
|---|---|---|
| `staff-extras` day cost | **206ms** | **0-1ms** |
| OPS range collapse (`opsSetRejected`) | **30** vs 5 sets | **2** |
| Guest-need sweeps publishing | **0** | **19** |
| Entertainers hired | 0 (all refused) | **4** |
| Facility gaps confirming | stuck at 1-2 sweeps | **17 and 13 sweeps** |

The entertainer costume fix, the sample-rotation fix, the OPS direction-inference fix and
the lag fix are all validated by telemetry rather than by inspection.

### The last blocker: elevated parks

Facility building still placed nothing, and the rejection counters give an exact account:

```
siteFlat 215 + siteSloped 1400          = 1615 tiles reached the ownership test
siteRejectUnowned 835 + siteRejectNoPath 780 = 1615
                                          -> siteAccepted = 0
```

Every single candidate was either unowned or failed the adjacent-path test. The park is
built as **elevated wooden walkways**, so the terrain beneath runs far below path level —
and the height test required a path within one step *above* the surface, quietly assuming
paths sit on the ground.

Since the stall is built at the **path's** height, the ground only has to not be in the
way. The test is now `pathZ >= surface.baseZ`: a path below the surface means this tile is
a hill over the path, which genuinely cannot be built into. Anything else is fine.

A gap had been waiting **17 sweeps at a 111-tile walk** while this rejected every site
around it.

### Vomit never justified a bench

The player reported seeing vomit with no benches going in near it, and was right.

Bench demand was gated on `VOMIT_MIN_TO_REPORT = 3`, but this park's worst vomit cell
holds **1-2** pieces, so that branch never fired. All amenities placed came from blanket
coverage and stalls.

One constant was doing two jobs. Reporting is advisory — a console line per single piece
of vomit is noise, so 3 is right there. **Placing a bench is not advisory:** one piece is
direct evidence a guest was nauseous with nowhere to sit, which is exactly what a bench
prevents (`Guest.cpp:1099` — a seated guest sheds 6 nausea per update). Split into
`VOMIT_MIN_FOR_BENCH = 1`.

### Costs now

| Pass | Max |
|---|---|
| `day.tileCache` | 15ms (behind a 30s cooldown) |
| `day.amenities` | 7ms |
| `day.facilities` | 4ms |
| `day.needSample` | 3ms |
| `cache.queueSignals` | 2ms |
| everything else | <= 2ms |

Nothing outside budget.

---

## The phantom cluster at (4, 4)

The reason automatic facility building never placed anything, across four parks and five
sessions of debugging. Every earlier fix was real, and none of them could have worked.

### The signature

`facilityPending` on the final park:

```
thirst @ (4,4)  29 sweeps  153 tiles to nearest
hunger @ (4,4)   2 sweeps  139 tiles
toilet @ (4,4)   7 sweeps  133 tiles
thirst @ (84,84) 1 sweep    23 tiles
```

Three of four gaps at the same tile, with absurd distances. The same `(4, 4)` had
appeared at 78 tiles on the mature park and 111 on another. That repetition across
unrelated parks was the tell.

### The cause

A guest **riding a ride**, or one that has left the park, reports
`kLocationNull = -32768` (`world/Location.hpp:18`). `needs.ts` clamps negative tile
coordinates to 0 to protect its key packing — correctly — so every such guest was
bucketed into cell (0, 0), whose centre is tile **(4, 4)**.

The rest of this project already guards that exact sentinel on ride stations and exits.
Guest sampling was the one place that did not.

### Why it defeated everything else

The map corner is unowned and maximally far from any facility, so the phantom was always
the **worst** gap in the park. `findGaps` sorts worst-first and `planFacilities` takes the
worst — so the phantom **won the planner's choice every single pass**, monopolised the
one-per-pass budget, and could never be built on. The site counters say it exactly:

```
siteFlat 2548  ==  siteRejectUnowned 2548   ->  siteAccepted 0
```

Every candidate tile in the search radius was unowned map edge. An exact match, which is
what confirmed the gap itself was bogus rather than the site filter being too strict.

Meanwhile a **real** gap sat in the same list — `thirst @ (84,84)`, 23 tiles out — and
never got a look in.

### Why four earlier fixes all looked plausible and all missed

Each addressed something genuinely broken, which is exactly why this hid for so long:

| Fix | Was it a real bug? | Did it unblock building? |
|---|---|---|
| Sample rotation never completing on a growing park | Yes | No |
| £20,000 cash floor gating a £300 stall | Yes | No |
| `confirmSweeps: 8` against a measured ~4 sweeps/session | Yes | No |
| Slope filter rejecting 6,013 tiles | Yes | No |
| Height test assuming ground-level paths | Yes | No |
| **Off-map guests clamped into the corner cell** | **Yes** | **This is the one** |

Every one was necessary. None was sufficient. The lesson is not about any of them
individually: **when a fix that should have worked doesn't, suspect the input before
tuning the logic again.** Five rounds were spent making the decision layer more permissive
when the data feeding it was fabricated.

The repetition of the *same coordinate across unrelated parks* was visible in the very
first session that logged `needGaps`, and it is the kind of thing that should have been
questioned immediately — a cluster does not sit at the identical tile on four different
maps.

### The fix

Filter `x < 0 || y < 0` at the sampling site, counted as `guestsOffMap`. The clamp in
`needs.ts` stays — it is not the bug, and its header now states the caller contract.
Four tests pin the behaviour so the clamp cannot be "fixed" in the wrong place.

---

## Final validation session (2026-09-20)

### The phantom cluster fix is confirmed

**Zero `(4, 4)` gaps since the fix**, across 330 records. The scale of what it had been
injecting is worth recording:

```
guestsSampled 26041   guestsOffMap 8346   ->  24% of every sample was fabricated
```

Nearly a quarter of all sampled guests were inside rides, reporting
`kLocationNull = -32768`, and being clamped into the corner cell. `needGapsReported` rose
**5 -> 34** once they were filtered out: real gaps had been there all along, buried under
a phantom that always outranked them.

Gaps now name real places — `thirst @ (100,84)` 23 tiles out, `hunger @ (100,68)` 16
tiles — instead of the map corner.

### ...which immediately exposed the next blocker: a dead zone

With the phantom gone, `facilityPending` was still empty. Two thresholds were gating the
same signal with different standards:

| Layer | Floor | Effect |
|---|---|---|
| `needs.ts` clustering | `>= 3` | cluster is reported, logged, published |
| `facilities.ts` planner | `>= 5` | cluster is **ignored** |

Everything in the 3-4 band was therefore visible and unactionable. Measured on a
670-guest park, **every gap present held exactly 3 guests**, so nothing could ever
confirm.

This is the same failure as the staffing controller's v2 deadlock — a hire gate of
`>= 25` against a release gate of `== 0`, leaving a band the park occupied 61 days out of
62. Recognising the shape is what made it quick to spot this time.

**Fixed structurally, not by retuning.** `CLUSTER_MIN_GUESTS` is now exported from
`needs.ts` and imported by the planner, so the two cannot drift apart, and a test asserts
they are equal. Retuning one number would have worked today and re-broken the next time
either was adjusted.

### A build-tooling bug the value import uncovered

Making that import real broke every test in the `facilities` suite with
`ERR_MODULE_NOT_FOUND`. TypeScript emits relative specifiers with no extension
(`from "./needs"`), which Node's ES module resolver rejects.

It had never surfaced because the pure modules only ever imported **types** from one
another, and TypeScript erases those at compile time — so no runtime import was emitted
at all. `tests/run.mjs` now rewrites relative specifiers to `.mjs` as it renames, in the
same pass.

Worth knowing because the symptom looks nothing like the cause: a suite that has passed
for weeks dies wholesale the first time a module imports a value instead of a type.

### Everything else, confirmed steady

| | |
|---|---|
| Max cost anywhere | **14ms** (tile scan, behind a 30s cooldown) |
| `staff-extras` day cost | **2ms** (was 206ms) |
| Entertainers | 4, matching target, stable |
| `entertainersProtected` | **89** — never fired a player-placed entertainer |
| `opsSetRejected` | **1** (was 30) |
| `needSweepsCompleted` | 41 |
| Mechanics | 2-4 adaptive vs formula, no unattended breakdowns |

Tests: **330 across 12 suites.**

---

## The wandering cluster: why gaps never accumulated

With the phantom removed and the dead zone closed, gaps finally reached the planner —
and `facilityConfirmed` was **0 on all 105 post-fix records**. The pending list told the
whole story at a glance:

```
thirst@100,84  1     toilet@92,68  1     hunger@100,68 1
thirst@92,84   1     thirst@76,68  1     thirst@76,84  1
thirst@84,84   1     hunger@92,76  1     hunger@84,84  1
toilet@92,76   1     hunger@108,60 1
```

Eleven gaps, **every single one peaked at exactly 1 sweep**, at eleven different
coordinates spread across the developed half of the park.

### The cause

The tracker keyed gaps on **exact cell coordinates**. But a cluster is a snapshot of
where *sampled* guests happened to be standing, and near the noise floor the particular
8-tile cell that trips the threshold moves from sweep to sweep. Each sweep minted a fresh
key and decayed the previous one toward nothing, so `confirmSweeps` was unreachable no
matter how real or how persistent the underlying need was.

The evidence was being shredded by coordinate jitter before it could accumulate.

### The fix

Observations of the same need kind within `mergeRadius` (12 tiles, the same scale as
`minDistance`) are now treated as **one gap**: if a single facility would serve both, they
are not rivals splitting the evidence.

Two details that matter:

- **The first anchor is kept**, not moved toward each new sighting. The streak is evidence
  about a *region*; letting the anchor chase the sample would walk the eventual build site
  across the park while the count claimed it had been stable all along.
- **`clear()` drops the whole merged region**, so the facility just built does not face a
  near-duplicate that kept its streak and authorises a second one beside it.

### A robustness hole the tests caught

The first version compared `d > options.mergeRadius` with no guard. A caller omitting the
option gets `undefined`, and `d > undefined` is **false** — which silently folds every gap
of a kind into the first one ever seen. That is a far worse failure than not merging, and
it surfaced immediately as an existing ordering test collapsing three gaps into one.
A missing or nonsensical radius now means *merge nothing*.

### Why this took five rounds to reach

Each earlier fix was real and necessary, and each revealed the next:

| Round | Blocker | Symptom it hid behind |
|---|---|---|
| 1 | Sample rotation never completed on a growing park | No data at all |
| 2 | £20,000 cash floor on a £300 stall | Skip counter |
| 3 | Slope filter, then ground-level height assumption | 6,013 rejections |
| 4 | Phantom cluster at (4,4) from off-map guests | 24% of the sample fabricated |
| 5 | Dead zone: cluster floor 3 vs planner floor 5 | Gaps reported, never actionable |
| 6 | **Exact-coordinate keying vs a jittering cluster** | Every gap stuck at 1 sweep |

The through-line is that a pipeline fails at its **earliest** broken stage, and each fix
only exposes the next one. Nothing short of instrumenting every stage would have found
these in fewer passes — which is exactly what the per-reason counters ended up doing.


---

## It works: end-to-end validation (2026-09-20, final)

After six rounds of blockers, the full pipeline ran: need measured -> gap confirmed ->
site found -> facility built and opened.

| Counter | Result |
|---|---|
| `siteAccepted` | **172** (had been 0 in every session ever) |
| `facilityPlaced` | **4** |
| `facilityOrphanDiscarded` | **0** |
| `facilityTrackFailed` / `facilityCreateFailed` | **0** |
| `siteRejectQueuePath` | 42 (the queue fix doing its job) |

Facilities grew hunger 4 -> 5, thirst 2 -> 4, toilet 4 -> 6 on a park that reached
**1,007 guests at rating 968**.

### The rotation question is answered

`facilityDirection0: 1`, `facilityDirection1: 1`, `facilityDirection2: 2`.

This was flagged as an open API question when the feature shipped: which rotation a 1x1
stall wants is not documented anywhere in the plugin API, so all four are probed with
silent `queryAction` calls and the winner counted. The data says **the computed guess is
not always right** — three different rotations were needed across four placements — so
the probe fallback is load-bearing, not belt-and-braces. Had it been a single assumed
direction, roughly three of four builds would have failed.

### Site rejection profile, for reference

```
siteRejectOccupied 966   siteRejectNoPath 589   siteRejectQueuePath 42
siteSloped 440           siteFlat 358           siteRejectUnowned 37
                                         -> siteAccepted 172
```

A healthy distribution: most tiles are genuinely occupied or have no walkable path, and
enough survive to choose from. Compare this with the sessions where one reason accounted
for 100% of rejections — that pattern always meant a filter was wrong, never that the park
was unsuitable.

### Costs, final

Max anywhere: **14ms** (tile scan, behind a 30s cooldown). `day.facilities` 3ms,
`day.needSample` 3ms, `staff-extras` 3ms. Nothing outside budget.
