# OpenRCT2 Plugin Project

Six TypeScript plugins for OpenRCT2, built with rollup and deployed straight into the
game's plugin folder.

## Documentation

| Document | What's in it |
|---|---|
| [docs/api-reference.md](docs/api-reference.md) | **Verified** API facts, each cited to a file and line in `gamesrc/`. Units, gotchas, lifecycle. Check here before assuming anything about the API. |
| [docs/performance.md](docs/performance.md) | Cost model, measured timings, the performance rules, and the debug/profiling channel. |
| [docs/research.md](docs/research.md) | Community research digest — game mechanics, staffing strategy, contested ratios, sources. |
| [docs/design-records.md](docs/design-records.md) | Per-feature design record (basis, measurements, decisions, rejections). Read before changing or reopening a feature. |
| [docs/archive/](docs/archive/) | Verbatim field logs and build-out work log moved out of performance.md and roadmap.md. Rarely needed. |
| [docs/roadmap.md](docs/roadmap.md) | Proposed improvements, prioritised, each tagged with its basis and cost. |
| [docs/marketing-research.md](docs/marketing-research.md) | Verified marketing-campaign mechanics (costs, guest-generation math, hidden penalties) for the proposed `marketing-manager` plugin. |
| [docs/marketing-roadmap.md](docs/marketing-roadmap.md) | Step-by-step build plan for `marketing-manager` — done through Phase 6 (auto-run), verified live. |
| [docs/user-guide.md](docs/user-guide.md) | Player-facing guide: every toggle, defaults, how to tell it is working. |
| [docs/scale-audit.md](docs/scale-audit.md) | Read-only audit of how each controller behaves across park sizes and regimes. |
| [docs/HISTORY.md](docs/HISTORY.md) | Session-by-session development timeline (reconstructed). |
| [GitHub Issues](https://github.com/MatthewT1/matts-openrct2-plugins/issues) | Current fix/optimisation backlog, labelled by priority (P1–P3) and whether it needs the game. |
| [docs/handyman-scale-fix.md](docs/handyman-scale-fix.md) | Completed fix (all 4 phases verified 2026-09-20) for the adaptive handyman controller under-hiring as a park scales up (guests 3x, handymen dropped). |

**Start here if you are:**

- changing plugin behaviour → [research.md](docs/research.md), then [roadmap.md](docs/roadmap.md)
- touching anything that runs periodically → [performance.md](docs/performance.md)
- unsure what an API property means or returns → [api-reference.md](docs/api-reference.md)
- chasing a stutter or a bug → [performance.md § debug channel](docs/performance.md#debug-channel)

---

## Project layout

```
openrct2 plugin/
├── src/                        # TypeScript sources (edit these)
│   ├── trash-manager.ts        # entry point: wiring, staffing decision, hooks
│   ├── trash/                  # trash-manager split by job (#6)
│   │   ├── shared.ts           # constants, types, litter helpers
│   │   ├── map-scan.ts         # tile/entity scans, hotspots, coverage tiles
│   │   ├── handymen.ts         # hire/fire, orders, patrol zones, activity
│   │   ├── amenities.ts        # benches/bins, vomit attribution
│   │   ├── facilities.ts       # guest-need sampling, facility placement
│   │   └── window.ts           # the Trash Manager window
│   ├── wait-time-optimizer.ts
│   ├── mechanic-manager.ts
│   ├── marketing-manager.ts    # campaign ranking + auto-run
│   ├── marketing.ts            # campaign value model (pure, unit-tested)
│   ├── staff-extras.ts         # entertainers (security measured zero demand, closed)
│   ├── path-connector.ts
│   ├── debug.ts                # shared opt-in telemetry channel
│   ├── hotspots.ts             # litter clustering (pure, unit-tested)
│   ├── staff-activity.ts       # idle/stuck staff detection (pure, unit-tested)
│   ├── staffing.ts             # closed-loop staffing controller (pure, unit-tested)
│   ├── staff-hiring.ts         # shared staff hire/fire + entity-budget backoff (unit-tested)
│   ├── deferred.ts             # shared UI-click -> next-tick action queue (unit-tested)
│   ├── settings.ts             # shared on/off park settings (unit-tested)
│   ├── breakdown-trace.ts      # breakdown -> repair timing trace, Diagnostics only (unit-tested)
│   ├── vomit.ts                # vomit -> nauseating-ride attribution (pure, unit-tested)
│   ├── amenities.ts            # bench/bin placement planner (pure, unit-tested)
│   ├── needs.ts                # guest-need clustering, facility gaps, sample rotation (pure)
│   ├── thoughts.ts             # guest-thought categorisation (pure, unit-tested)
│   ├── ops.ts                  # ride operation-setting controller (pure, unit-tested)
│   ├── facilities.ts           # facility placement planner (pure, unit-tested)
│   ├── queues.ts               # queue trend + per-ride intervention attribution (pure)
│   └── entertainer-targeting.ts # entertainer ride selection + patrol boxes (pure)
├── tests/                      # 457 tests over the pure modules
│   ├── run.mjs                 # compiles src/*.ts, runs every *.test.mjs
│   └── *.test.mjs
├── tools/
│   └── log-sink.mjs            # TCP sink for the debug channel
├── docs/                       # see table above
├── archive/                    # original JS sources, pre-TypeScript
├── gamesrc/OpenRCT2/           # full OpenRCT2 source clone (read-only reference)
│   └── distribution/scripting/openrct2.d.ts   <- authoritative type definitions
├── rollup.config.js            # multi-entry build; dev -> OpenRCT2/plugin/, prod -> dist/
├── tsconfig.json
└── package.json
```

---

## Build

`npm` is broken on this machine (nvm-windows v1.1.7 bug, missing `@npmcli/config`), so
all commands call the binaries directly through node. Fix is to update nvm-windows.
Node in use: **v22.23.2**.

```bash
# Dev build - compiles and deploys to OpenRCT2\plugin\ in one step
node ./node_modules/rollup/dist/bin/rollup --config rollup.config.js
```

```bash
# Type-check only
node ./node_modules/typescript/bin/tsc --noEmit -p tsconfig.json
```

```bash
# Run the test suite (457 tests over the pure logic modules)
node tests/run.mjs
```

> **The decision logic lives in pure modules on purpose.** `hotspots`, `staff-activity`,
> `staffing`, `vomit`, `amenities`, `needs`, `thoughts`, `ops`, `facilities` and `queues`
> touch no OpenRCT2 globals, so they compile and run under plain node with no game required. Everything
> that touches `map`, `context` or `park` stays in the four plugin entry points and is
> verified in-game via the telemetry channel instead.
>
> Several real bugs were caught by these tests — a staffing controller that deadlocked, a
> stuck-staff detector producing 734 false positives, and an amenity planner that would
> have removed player-placed benches. Add a test when you add a decision.

```bash
# Production build (outputs to ./dist/)
node ./node_modules/rollup/dist/bin/rollup --config rollup.config.js --environment BUILD:production
```

```bash
# Watch mode
node ./node_modules/nodemon/bin/nodemon.js --watch ./src --ext js,ts --exec "node ./node_modules/rollup/dist/bin/rollup --config rollup.config.js"
```

> **After every `.ts` edit, rebuild.** The dev build resolves the Documents folder at
> build time via `getPluginDir()` and writes the compiled `.js` files directly to
> `%USERPROFILE%\Documents\OpenRCT2\plugin\`. No manual copy needed.
>
> OpenRCT2 only reloads plugins **on park load**, so exit to the title screen and
> reload the park to pick up a new build — unless `enable_hot_reloading` is set under
> `[plugin]` in `config.ini`.

### TypeScript config

- **Target `es2015`** — not es5; TypeScript 7 dropped ES5 support.
- **TypeScript pinned to `~5.7.0`.** Do not upgrade to 7.x: `@rollup/plugin-typescript`
  is incompatible (`Cannot read properties of undefined (reading 'ES2015')`).
- Module resolution `bundler`, types `@openrct2/types` only — no DOM or Node libs.

---

## Test session setup

Any change marked `needs-game` is checked in-game like this (~5 min to set up):

1. **Start the log sink.** Double-click `tools\start-log-sink.cmd` and leave the window open.
2. **Build and deploy** with the dev build above. It copies fresh plugins straight into
   `Documents\OpenRCT2\plugin\`.
3. **Load the park.** If the game was already open, go back to the title screen and reload
   the park, because plugins only load with a park.
4. **Turn on Diagnostics.** Open any plugin window from the map menu and tick
   **Diagnostics** (one tick turns it on for all plugins).
5. **Play** for the number of in-game days the issue asks for. The numbers land in
   `tools/rct-debug.log`.

Use the same park each time where you can (Thunder Rock is the usual one), so before and
after numbers are comparable.

---

## The plugins

### trash-manager.ts

Monitors path litter, bin status and handyman staffing; auto-hires/fires handymen and
can auto-sweep.

- Tile scan is O(map²), rate-limited to once per 30 real seconds. The "Force Full Scan"
  button bypasses the cooldown.
- Staffing: **adaptive by default**. The classic formula
  `max(ceil(guests / 30), ceil(pathTiles / 100)) + 2` is now only a ceiling; a control
  loop in `src/staffing.ts` probes downward while the park stays clean and hires back
  fast when litter starts costing rating. Measured: the formula wanted 42 handymen for a
  park sitting at maximum rating with 36. Toggle with "Adaptive staffing".
- Handymen are given **no patrol area**. See
  [performance.md § patrol areas](docs/performance.md#patrol-areas) for why.
- Handyman orders are `sweep | empty bins` — mowing is deliberately excluded.
- **Vomit advisor**: names the nauseating ride behind a vomit cluster and says whether
  benches or the ride's own nausea is the problem. Measured, **99.7% of this park's litter
  is vomit**, so this matters far more than bins.
- **Guest-need and thought instrumentation**: samples a rotating window of guests for
  `hunger`/`thirst`/`toilet`/`nausea` and their thoughts, clusters unmet needs, and
  reports the distance to the nearest matching facility. Measured at **~1ms** for a
  250-guest window on a 927-guest park. Runs when either Diagnostics *or* auto-build is
  on; costs nothing with both off.
- **Automatic facility building** (off by default): builds toilets, first aid rooms and
  food/drink stalls where guests have a **persistent, measured** unmet need. A gap must
  survive **8 separate sweeps** of the whole park before it can authorise construction,
  because a cluster is a snapshot of where guests were standing and crowds move.
  Capped at 8 per kind, one build per pass, £20,000 cash floor, and it **never
  demolishes anything**. See
  [roadmap.md § NEEDS](docs/design-records.md#needs--guest-need-clustering-then-automatic-facility-placement).
  - Only builds what research has unlocked, via `park.research.inventedItems`.
  - The rotation a 1x1 stall wants is undocumented, so all four are probed with silent
    `queryAction` calls and the winner is counted in telemetry.
- **Automatic benches and bins** (off by default): places benches at nauseating ride exits
  and vomit hotspots, bins near stalls, **plus blanket coverage across the whole path
  network** (one candidate tile per 6x6 cell). Budget is 15 placements per 10 seconds.
  Removal is a separate toggle and **only ever touches amenities the plugin placed
  itself** — anything you placed by hand is never removed. Replaces the manual
  `benchwarmer` plugin.
  - Density knobs, if it needs tuning: `AMENITY_MAX_PLACE`, `AMENITY_COOLDOWN_MS`,
    `AMENITY_SATISFIED` (lower = denser), `COVERAGE_CELL_TILES` (lower = denser).

### wait-time-optimizer.ts

Recommends and auto-applies ride min/max wait times.

- Formula: `min = rideDuration / (trains + 1)`, `max = rideDuration / trains`. This
  matches community consensus independently.
- Flags rides that stay queued despite recommended settings already being applied as
  **capacity-bound** (`[C]`) — those need trains or cars, not tuning.
- Emergency override when a queue passes the 5-minute complaint threshold — **and
  pre-emptively on a queue that is still below it but climbing**. Queue length does not
  deter guests from joining ([#16841](https://github.com/OpenRCT2/OpenRCT2/discussions/16841)),
  so arrival rate is independent of queue length and a backed-up ride diverges rather than
  settling. `queues.ts` flags a ride after 2 consecutive rising days above 3 minutes; any
  fall resets it. Deliberately trend-based rather than a lower threshold — see
  [roadmap.md § W2](docs/design-records.md#w2--more-aggressive-emergency-override).
- **Ride operation tuning** (off by default): shortens the cycle on rides with long queues
  and lengthens it on empty ones, via `operationOption` (maze time limit, laps, rotations,
  speed). The value cannot be read back, so the controller probes each ride's legal range
  with silent queries and remembers what it wrote. Changes discard the ride's
  excitement/intensity/nausea until it runs again, so it moves one step at a time after
  several consistent readings.
- Vehicle-chain lengths are memoised per ride; the daily pass only writes properties
  whose value actually changes.

### mechanic-manager.ts

Monitors ride reliability, auto-hires/fires mechanics, manages inspection intervals.

- **Adaptive staffing** (on by default), reusing the same controller as handymen with
  **mechanic-calibrated thresholds** (`MECHANIC_THRESHOLDS` in `staffing.ts`). Signals map
  as: rides broken for **2+ consecutive days** -> the urgent signal, rides broken *now* ->
  the regression signal. Floor of 2 while the park has any rides.
  - The urgent signal is deliberately *unattended* breakdowns, not current ones. A ride
    that breaks and is repaired the same day is the system working; a ride still broken on
    day two is the system failing, and is the condition behind the game's own
    "still hasn't been fixed" warning (`Ride.cpp:1356-1377`).
  - The discovered floor **decays** after ~20 quiet observations, so a ride nobody can
    reach cannot pin the controller at the formula ceiling forever.
- Shows wages saved against the formula baseline (mechanics are £80/month —
  the most expensive staff type). Measured: **3 mechanics against a formula of 6**.
- **Emergency repair** (off by default, and labelled a cheat in the UI): clears the
  breakdown on any ride still broken after 3 days. No mechanic travels and no reliability
  is restored. It exists for rides no mechanic can physically reach — a long-standing
  pathfinding problem in the game itself — and the 3-day threshold is what stops it
  replacing the repair economy with a free button.

- Re-applying inspection intervals daily is **load-bearing**, not redundant —
  construction windows reset them.
- Clears all patrol zones. This was suspected of suppressing inspections; **measurement
  disproved it** — mechanics perform ~100% of the available work. Do not reopen without
  reading [roadmap.md § M2](docs/design-records.md#m2--small-patrol-zones-for-mechanics) first.

### path-connector.ts

Path planning and placement tool. No background subscriptions or timers — all work is
user-triggered from button clicks, with a per-operation tile cache and a memoised
route/analysis preview.

---

## Hard-won gotchas

Each of these caused a real, silent failure. They are documented in full in
[api-reference.md](docs/api-reference.md) and [performance.md](docs/performance.md).

| Trap | Reality |
|---|---|
| `interval.day` is 8192 ticks | It is **~528–546**. Out by 15×. |
| Inspection "every 10 minutes" | **~38 in-game days** per ride. Compute expected workload before calling anything an anomaly. |
| Litter penalty kicks in after ~3 min | True in *real* time, but **14.5 in-game days**. |
| Money is in hundredths | **Tenths** of a pound. A cash floor was 10× too high and silently disabled a feature. |
| Patrol areas are cheap | Cost scales with rectangle **area**; a park-sized one cost 440ms for 29 staff. |
| Idle staff means stuck staff | Only if their *peers* are working. Fleet-wide idleness is an overstaffing signal. |
| A game action will succeed if the obvious checks pass | Footpath additions are refused for **five** reasons, two of which the API cannot see. `queryAction` first, then `executeAction`. |
| A multi-step build either succeeds or does nothing | `ridecreate` then `trackplace` are **separate** actions. A create that succeeds followed by a place that fails leaves a **trackless orphan ride** in the player's ride list forever. Validate the site first *and* keep a cleanup path. |
| Ride type numbers run consecutively | Slots 29, 31 and 34 are `kDummyRTD` — unused. Counting through the enum silently produces the wrong type. |
| Direction 0 means +x | It is **-x**. `TileDirectionDelta` is `{-1,0}, {0,+1}, {+1,0}, {0,-1}`. |
| One rejection reason dominating is normal | It is a **red flag**. Every time a single `siteReject*` reason accounted for ~100% of rejections, a filter was wrong — never that the park was unsuitable. A healthy profile is spread across several reasons. |
| A footpath means guests can reach it | Not a **queue line**. Someone queueing cannot step out to use a stall, so `isQueue` paths must not count as adjacency — the first facility ever placed went up beside a coaster queue. |
| A cluster keeps the same coordinates between samples | It does not. Near the noise floor the exact cell that trips a threshold moves every sweep, so keying evidence on exact coordinates **shreds it** — eleven real gaps each stuck at 1 sweep. Match observations by proximity, and keep the first anchor so the build site does not wander. |
| Two thresholds on one signal are independent | They are not — mismatched floors leave a **dead band** the park sits in. A cluster floor of 3 feeding a planner floor of 5 made every gap reportable and none actionable. Share one exported constant and assert it in a test. |
| A game action either works or is your bug | `staffhire` also fails when the park hits its **entity budget** (`getNumFreeEntities() < 400`) — transient, and nothing to do with your arguments. Pass a real callback and check `result.error`; an empty one hides the failure from you and shows it to the player. Back off rather than retrying daily. |
| An entity you read has a position | Not if it is inside a ride or has left the park — it reports `kLocationNull = -32768`. Clamping that into a grid creates a **phantom cluster in the map corner** that outranks every real one, never resolves, and can never be built on. Filter negative coordinates at the source. |
| A property access is free | `ride.stations` is a **getter that rebuilds its array every access**. Reading it twice per loop iteration cost **206ms/day**; hoisting it to a local made the same pass **1ms**. Treat `ride.stations`, `map.rides` and `ride.vehicles` as function calls — never put one in a loop condition. |
| One constant can serve two similar purposes | `VOMIT_MIN_TO_REPORT` gated both console chatter AND bench placement. A threshold sensible for reporting (3) silently disabled placement on a park whose vomit cells hold 1-2. Split the constant when the two jobs have different stakes. |
| Paths sit on the ground | Not on an elevated park. A height test written against ground-level paths rejected **every** facility site for a whole session. |
| A default of 0 is safe for an optional id | Not for an entertainer's `costumeIndex`. It is the **only** staff type the game validates (`StaffHireNewAction.cpp:85-93`), and slot 0 is not an entertainer animation — you get "Can't hire new staff / value out of range". The valid set varies by park; probe it with `queryAction`. |
| Staff are interchangeable, so firing any is fine | True for handymen and mechanics. **False for entertainers** — players place them in a chosen costume beside a themed ride. Track what you hired and only ever fire that, the same rule that governs bench removal. |
| A probe that stops climbing has found the maximum | Only if it stopped because something was *refused*. Doubling 32→64→128→256 and giving up at a hard ceiling records 128 for a ride whose real max is 180. Bracket and binary-search the gap. |
| A rotating window over a live array will wrap | Not if the array is **growing**. The offset clamps to the length, so `offset >= length` is never true once the roster grows between passes — the sweep silently never completes. Decide completion from the pass that just ran. |
| Testing on a big park covers the small case | The range of conditions you tested under is itself an assumption. A steady-state park hid a sweep bug for several sessions; a starting scenario hid nothing but exposed two cash floors calibrated for a mature park. |
| A "calibrate to the midpoint" default is neutral | It is **direction-blind**. OPS set congested rides to the midpoint of their range, which *lengthened* any ride whose value sat below it — cutting throughput on exactly the ride that needed more. Calibrate toward what the signal is asking for. |
| An emergency should respond as fast as possible | Not if it responds *repeatedly*. The urgent path hired 4 mechanics in 4 days for a ride that stayed broken 8 days regardless. Pace the repeat, not the first response. |
| Reusing a controller reuses its behaviour | It reuses its **calibration**. `staffing.ts` thresholds are in *pieces of litter*; feeding them *counts of rides* made the urgent-hire path arithmetically unreachable and turned the mechanic controller into a one-way ratchet down. |
| A "never go below this" floor is always safe | It is a one-way ratchet **up** if the signal can be caused by something headcount cannot fix. A ride no mechanic can reach raises the floor on every hire until it pins at the ceiling. Floors need decay. |
| A record can be dropped when its subject is absent | Only if the state is transient. OPS deleted a ride's **discovered value range** whenever the ride closed, restarting a 192-probe search each time. Separate durable state from transient state. |
| An in-flight guard is harmless | A flag set before an action and cleared in its callback stays set forever if the callback is dropped, silently disabling the feature. Give it a watchdog, and **count the watchdog firing**. |

**The recurring lesson:** every one of these was a threshold or assumption that looked
sensible in the abstract but sat outside the range the game actually produces. Check
thresholds against real telemetry before trusting them, and instrument the *skip* paths
as well as the success paths — **five** separate features silently did nothing until a
counter revealed it, and not one of them raised an error.

The corollary is the reason this project keeps a written exit criterion for each
measurement: *decide in advance what result would mean "build it" and what would mean
"drop it", then honour both.* It has closed two features without building them
([M2](docs/design-records.md#m2--small-patrol-zones-for-mechanics),
[C](docs/design-records.md#c--bin-placement-advisor)) and opened one that had been held shut for
several sessions ([NEEDS](docs/design-records.md#needs--guest-need-clustering-then-automatic-facility-placement)).

---

## Environment

- **OS:** Windows 11 Pro
- **Node:** v22.23.2 via nvm-windows (symlink at `%USERPROFILE%\nodejs`)
- **npm:** broken — use the direct node calls above
- **Plugin folder:** `%USERPROFILE%\Documents\OpenRCT2\plugin\`
- **Debug log:** `tools/rct-debug.log` (gitignored)
