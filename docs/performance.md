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
- [Gotcha: the litter rating penalty threshold is ~14 in-game days](#gotcha-the-litter-rating-penalty-threshold-is-14-in-game-days)
- [Amenity placement: making it dense without making it slow](#amenity-placement-making-it-dense-without-making-it-slow)
- [Testing](#testing)
- [The 206ms getter: `ride.stations` rebuilds on every access](#the-206ms-getter-ridestations-rebuilds-on-every-access)

Field measurements, case studies and bug write-ups: [archive/performance-field-log.md](archive/performance-field-log.md).

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
