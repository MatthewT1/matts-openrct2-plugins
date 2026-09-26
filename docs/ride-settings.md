# Ride settings: what the game actually does (#38, step 1)

Research for [#38](https://github.com/MatthewT1/matts-openrct2-plugins/issues/38). It covers
what the Wait Time Optimizer (WTO) and ride operation tuning (OPS) write: load mode
(`departFlags`), min/max wait and `operationOption`. Every **source** line is cited to
`gamesrc/OpenRCT2` @ `6fb525e906`. Community practice is already collected in
[research.md § Ride Operation & Queues](research.md#ride-operation--queues) and
[§ Ride Operation Settings](research.md#ride-operation-settings-added-2026-09-20). It is
summarised here, not repeated.

Step 2 (a pure capacity model comparing current behaviour with these ideals, 5% rule) is
not in this doc.

## 1. Dispatch: how a train decides to leave (source)

Wait values are in units of **32 game ticks** (the "seconds" the ride window shows).
`time_waiting` counts ticks from the moment the train stops in the station.

The checks run in this order each tick (`ride/Vehicle.Station.cpp`):

| # | Check | Lines | Effect |
|---|---|---|---|
| 0 | Ride type has a test mode (`supportsStatus(testing)`, `Ride.cpp:637-638`; almost every tracked ride) | 572-579 | Waits at least 20 ticks, then continues to checks 1-5 **even if empty**, so max wait (2) or no load flag (5) sends an empty train. |
| 0b | Ride type has no test mode, and the train is empty | 580-586 | **Never departs.** It waits for a guest, whatever the max wait. |
| 1 | `WAIT_FOR_MINIMUM_LENGTH` (bit 6) and `minWaitingTime × 32 > time_waiting` | 591-597 | Blocks departure, **even if the train is full**. |
| 2 | `WAIT_FOR_MAXIMUM_LENGTH` (bit 7) and `maxWaitingTime × 32 < time_waiting` | 599-607 | Departs now, whatever the load. |
| 3 | `LEAVE_WHEN_ANOTHER_ARRIVES` (bit 4), and another train is unloading at this station | 610-630 | Departs now. |
| 4 | `WAIT_FOR_LOAD` (bit 3) | 633-656 | Departs when full, or at ≥ ceil((load+1)/4 × seats) riders. Load 0-3 = ¼, ½, ¾, full. Load 4 = "any" = **1 rider**. |
| 5 | None of the above | 661-662 | Departs now (with ≥ 1 rider). |

Checks 1 and 2 only apply to ride types with `RtdFlag::hasLoadOptions` (line 589). Every
exit also needs every guest who has a seat to be sitting in it (`TrainReadyToDepart`,
line 460), so a train never leaves mid-boarding.

**Gap between departures (non-block-sectioned rides only).** When a train leaves, the
station's light stays red for `waitingTime` units: 3, or `minWaitingTime` (clamped 3-127)
when bit 6 is set (`ride/Vehicle.cpp:1135-1147`). The timer ticks down once every 32 ticks
(`ride/Station.cpp:155-183`). On a shuttle or station-to-station ride, min wait therefore
costs **twice**: once as the dwell in check 1 and once as the gap before the next train.
Block-sectioned rides skip the gap (`Vehicle.cpp:1135`), and their blocks space the trains.

### What this means

- **"Any load" = leave with the first seated rider.** With a steady queue a train still
  fills while guests walk to their seats, because of the boarding rule above. But any lull
  sends a train out nearly empty. Whether this loses capacity against "full load + short
  max wait" depends on how fast guests reach the platform. That is Step 2's question.
- **Empty trains cycle on tracked rides.** With a max wait and nobody queuing, a train leaves
  empty every max-wait period. That costs nothing in capacity, but it is not "trains don't
  cycle empty" as the `calcDepartFlags` comment says.
- **Max wait only matters with a load threshold.** Under "any load", check 4 fires as soon
  as one rider sits, long before any max wait.
- **Min wait is pure dead time on a busy ride.** It holds a full train. WTO's busy-ride
  branch already turns bit 6 off (`src/wait-time-optimizer.ts:401`).

## 2. `operationOption`: one byte, meaning set by the ride mode (source)

`operationOption` is a union with `timeLimit`, `numLaps`, `launchSpeed`, `speed` and
`rotations` (`ride/Ride.h:317-325`). The ride window labels it per mode
(`openrct2-ui/windows/Ride.cpp:3567-3612`):

| Mode | Label | What it changes |
|---|---|---|
| Powered / upward launch | Launch speed | Launch velocity (`Vehicle.Station.cpp:1088-1090, 1262`) |
| Station-to-station | Speed | Cruise velocity (`Vehicle.TrackMotion.cpp:218`) |
| Race (go-karts) | Number of laps | Laps per race |
| Dodgems (also flying saucers) | Time limit | Session length |
| Swing | Number of swings | Cycle length |
| Rotation / forward / backward rotation | Number of rotations | Cycle length |
| Other modes, **no-vehicle rides only** (maze, spiral slide) | Max people on ride | Admission cap: a guest waits while `numRiders >= operationOption` (`entity/Guest.cpp:3447-3451`) |

> **Correction.** A maze's option is **max guests in the maze**, not a time limit, as
> `src/ops.ts` and `src/wait-time-optimizer.ts` comments (and research.md) said.
> Lowering it cuts capacity. No harm was done: mazes (type 20) and spiral slides (35) are in
> `EXCLUDED_RIDE_TYPES` (`src/wait-time-optimizer.ts:142`), so neither WTO nor OPS touches them.

Legal ranges come from each type's `OperatingSettings` and are already generated into
`src/op-ranges.ts` (#50).

### Rating effect per step (source)

Ratings are in hundredths. Each value is the change per +1 of `operationOption`, from each
type's `RatingsModifier` list (`ride/rtd/...`), applied by
`RideRatingsApplyBonusRotations` / `…OperationOption` / `…GoKartRace`
(`ride/RideRatings.cpp:1901-1936`).

| Ride | Range | Excitement | Intensity | Nausea | Whole range (E / I / N) |
|---|---|---|---|---|---|
| Swinging Ship (`thrill/SwingingShip.h:66`) | 7-25 | +0.05 | +0.05 | +0.10 | +0.90 / +0.90 / +1.80 |
| Swinging Inverter Ship (`thrill/SwingingInverterShip.h:66`) | 7-15 | +0.11 | +0.22 | +0.22 | +0.88 / +1.76 / +1.76 |
| Magic Carpet (`thrill/MagicCarpet.h:67`) | 7-15 | +0.10 | +0.20 | +0.20 | +0.80 / +1.60 / +1.60 |
| Enterprise (`thrill/Enterprise.h:62`) | 10-20 | **+0.01** | **+0.16** | **+0.16** | +0.10 / +1.60 / +1.60 |
| Twist (`thrill/Twist.h:61`) | 3-6 | +0.20 | +0.20 | +0.20 | +0.60 / +0.60 / +0.60 |
| Merry-Go-Round (`gentle/MerryGoRound.h:63`) | 4-25 | +0.05 | +0.05 | +0.05 | +1.05 / +1.05 / +1.05 |
| Ferris Wheel (`gentle/FerrisWheel.h:66`) | 1-3 | +0.25 | +0.25 | +0.25 | +0.50 / +0.50 / +0.50 |
| Dodgems, Flying Saucers (`gentle/Dodgems.h:71`, `FlyingSaucers.h:69`) | 20-180 s | +0.01 /s | +0.005 /s | 0 | +1.60 / +0.80 / 0 |
| Go-Karts, race mode with ≥ 4 karts (`thrill/GoKarts.h:69`) | 1-10 laps | +0.30 /lap | +0.15 /lap | 0 | +2.70 / +1.35 / 0 |

For tracked rides, `operationOption` is launch speed or speed, which changes the measured
ratings through speed and G-forces rather than a fixed bonus. Separately, the duration
bonus is **capped** at `min(totalTime, threshold)` (`RideRatings.cpp:1866-1869`). On the
Looping Coaster the threshold is 150 s, worth at most +0.60 excitement
(`coaster/LoopingRollerCoaster.h:78`). Going past the cap adds cycle time for no rating.

## 3. Community practice (summary)

From research.md (sources there):
- Busy rides: "any" or ¼ load with a short max wait. Quiet rides: full load.
- Min/max wait for multi-train rides: min = duration / (trains + 1), max = duration / trains.
  WTO uses exactly this for quiet rides (`src/wait-time-optimizer.ts:232-233`).
- Intensity above ~10 makes a ride unattractive. Lengthening an intense ride backfires.
- Maze: simpler is better. **No published optimum** for laps, rotations or swings.
- Max lift hill speed has no known downside. WTO already sets it (`applyLiftSpeed`).

## 4. Ideal settings per group

Basis: **S** = source, **C** = community, **S+C** = both agree. "Step 2" marks what only
the capacity model can settle.

| Group | Load / waits (busy queue) | Load / waits (quiet) | `operationOption` | Basis | Trade-off |
|---|---|---|---|---|---|
| Block-sectioned circuit coasters | No min wait. Any or ¼ load vs full + short max: **Step 2** | Full load + max wait (min wait optional; there is no gap timer) | Not used (option hidden) | S+C | Partial trains vs idle trains |
| Shuttle / launched / station-to-station | Min wait off: it costs twice (dwell + gap) | Full load + max wait | Launch speed: lowest that still clears the track. Higher speed changes ratings via G-forces, **no fixed bonus** | S | Every min-wait unit is paid twice |
| Flat rides, swing/rotate (ship, carpet, twist, merry-go-round, ferris) | Any load; fewest swings/rotations | More swings/rotations for excitement, if intensity stays under the ceiling | Excitement per step is **small next to intensity/nausea on thrill rides** | S (C: no optimum published) | Cycle time roughly ∝ option; the rating gain is linear and small |
| Enterprise | Any load; **minimum rotations** | Minimum rotations anyway: +0.01 E per rotation buys +0.16 I and N | 10 | S | Essentially no upside to more rotations |
| Dodgems / flying saucers | Shorter session | Longer session: +0.01 E/s, no nausea | 20-180 | S | Linear E gain, linear cycle cost |
| Go-karts (race) | Fewer laps | More laps: +0.30 E/lap, only with ≥ 4 karts | 1-10 | S (C: 1 lap) | Community "1 lap" gives up +0.30 E/lap |
| Maze / spiral slide | Raise max-people toward the range top | – | Admission cap, **not** time | S | Higher cap = more capacity; congestion inside is unmeasured |

## 5. Where current behaviour differs (input to Step 2)

1. **Busy rides get "any load"** (`calcDepartFlags`, `src/wait-time-optimizer.ts:396-404`).
   Source says this leaves with the first seated rider. Whether trains leave part-empty
   under a real queue is exactly what Step 2 should model.
2. **Quiet rides get min wait = duration / (trains + 1)**. On non-block-sectioned rides it is
   paid again as the gap before the next train. That matters only when demand is low, so it
   is probably harmless.
3. **OPS lengthens on an empty queue** (the out-of-scope −38% issue). For the Enterprise,
   source shows the lengthening buys almost no excitement (+0.01 per rotation) for +0.16
   intensity and nausea.
4. **Comments call the maze option a time limit** (`src/ops.ts:6`,
   `src/wait-time-optimizer.ts:95`). Harmless, because mazes are excluded; fixed with this doc.

**Not checked:** in-game throughput (by design; #38 Step 2 replaces it with a model),
modes not written by WTO/OPS (e.g. circuits count), and ride types outside the ones listed.
