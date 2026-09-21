# Scale and Regime Audit (P1)

**Read-only audit.** Every tunable constant in the pure modules and the three plugin
entry points (excluding `path-connector.ts`, out of scope), checked against telemetry
from `tools/rct-debug.log`, which records **two distinct parks**:

| | Park A ("mature") | Park B ("fresh") |
|---|---|---|
| Records | ticks 1..177953, 208-320 samples/plugin | ticks 104968.., 320-960 samples/plugin (reset detected at record index 624 of 1584 `stats` lines) |
| Guests | 565 - 984 | 0 - 626 (still growing at log end) |
| Rides | 10 - 13 | 0 - 10 |
| Path tiles | 330 - 361 | 50 - 192 |
| Coverage cells (6-tile) | 33 - 35 | 8 - 26 |
| Park rating | up to 984 guests, rating 873-963 | rating 0 (pre-open) - 928 |

All money figures below are already-corrected TENTHS of a pound
(`core/Money.hpp:27`) unless noted. Verdicts follow the project rule: prefer OK, and
only propose a number backed by arithmetic against the ranges above.

---

## staffing.ts

| Constant (file:line) | What it gates | Observed range of that signal | Reachable: small/large/early/late | Verdict |
|---|---|---|---|---|
| `URGENT_OLD_LITTER = 25` (staffing.ts:43) | Handyman urgent-hire threshold, in **pieces of old litter** | `oldLitter` observed 0-1 (A) and 0-5 (B) | Small OK / Large OK / Early OK / Late OK — units match the handyman signal in both parks | OK. Rarely fires (measured: fired essentially never in the log, matching the file's own note that `oldLitter` costs little). Not the mechanic bug — that path now uses `MECHANIC_THRESHOLDS` (see below), a separate calibration. |
| `RELEASE_OLD_LITTER_MAX = 8` (staffing.ts:57) | Handyman release gate | Same range as above | OK, both regimes | OK |
| `RATING_CONCERN = 900` (staffing.ts:59) | Emergency floor, park rating 0-999 | Rating observed 873-963 (A), 0-928 (B, includes pre-open 0) | Both regimes reachable — rating crosses 900 legitimately in both parks | OK |
| `RELEASE_DAYS = 4` / `SETTLE_DAYS = 10` / `URGENT_SETTLE_DAYS = 16` (staffing.ts:61,70,77) | Handyman hysteresis pacing, in **observations** (daily) | n/a — day counts, not scale-dependent | Same behaviour at any guest/ride count | OK — these are observation counts, not park-size-dependent |
| `EMA_ALPHA = 0.2` / `REGRESSION_FACTOR = 2.0` (staffing.ts:79,81) | Litter-average smoothing / regression trigger | `totalLitter` observed 0-5 (A), 0-8 (B) | Dimensionless ratio, scale-free | OK |
| `MECHANIC_THRESHOLDS.urgentAt = 1` (staffing.ts:198) | Mechanic urgent-hire, in **rides broken 2+ consecutive days** | `ridesBroken`/downtime rides observed 0-2 within a 10-13-ride park (A), 0-10-ride park (B) | Reachable at both scales because unit is "count of rides," which is always small (≤ ride count) — this is the fix already applied per the header comment (staffing.ts:86-98) replacing the old litter-unit reuse bug | OK — this is the corrected calibration; the original bug (litter units fed ride counts) is the one already fixed and documented |
| `MECHANIC_THRESHOLDS.releaseMaxUrgent = 0` (staffing.ts:199) | Never release while any ride unattended | Same | OK | OK |
| `MECHANIC_THRESHOLDS.settleDays=6 / urgentSettleDays=8` (staffing.ts:202-203) | Mechanic pacing | Observation counts | OK | OK |
| `MECHANIC_THRESHOLDS.urgentHirePaceDays = 3` (staffing.ts:206) | Paces repeat urgent hires | Fixed per the documented 4-hires-in-4-days incident | OK | OK, already the fix |
| `MECHANIC_THRESHOLDS.floorDecayDays = 20` (staffing.ts:208) | Decays `discoveredFloor` | ~3 weeks of quiet, observation-count | OK | OK |

## needs.ts

| Constant (file:line) | What it gates | Observed range | Reachable | Verdict |
|---|---|---|---|---|
| `HUNGER_THRESHOLD=10`, `THIRST_THRESHOLD=25`, `TOILET_THRESHOLD=160`, `TOILET_URGENT=195`, `SICK_THRESHOLD=140`, `VERY_SICK_THRESHOLD=200` (needs.ts:55-65) | Guest-stat need classification | Directly cited to `Guest.cpp` per the file header, not measured/estimated constants | Game-engine-defined, not park-scale-dependent | OK — these are copied from source, not tuned against telemetry, and correctly so |
| `CELL_KEY_Y_BITS = 11` (needs.ts:101) | Packed-key bit budget, must exceed `MAX_TILE_COORD` (999) needs | Map size fixed by the game (max 1000×1000) | Both regimes use the same fixed map bound | OK, 2048 > 1000 with headroom |
| `createSampleRotation` completion logic (needs.ts:409-442) | Rotating guest-sample window completeness | This is the exact growth-regime bug described in the task (offset clamps to total, never wraps on a growing roster) | **Already fixed** — `next()` now decides `sweepComplete` from the pass that just ran (`end >= total`), not the next pass's `offset >= total` comparison, and also handles a *shrinking* roster (`if (start >= total) start = 0`) | OK — this is the corrected version; the module's own header documents the measured failure (78 days frozen on a 99→214-guest park) that justified the rewrite |

## facilities.ts

| Constant (file:line) | What it gates | Observed range | Reachable | Verdict |
|---|---|---|---|---|
| `minGuests = 5` (facilities.ts:138) | Facility-construction cluster-size gate (post `NEED_SAMPLE_WINDOW` sampling) | `facilityPending`/`needGaps` cluster sizes observed 3-10 (A), 3-8 (B) — see trash-manager.ts:1186 which additionally reports (not gates construction) at ≥3 | Both regimes produce clusters ≥5 (e.g. A: guests 7, 6, 10, 5; B: guests 8, 8, 7) | OK — reachable and already measured to fire (facilityConfirmed 0-3 in A, 0-2 in B). This is a *different* constant from `NEED_GAP_MIN_GUESTS` (trash-manager.ts, =3): that one filters what gets *reported*, this one filters what gets *built*. The task's "known suspect" pairing them together as one bug is not borne out — they gate different actions at different confidence levels, both reachable at observed sample counts. |
| `minDistance = 12` (facilities.ts:142) | Coverage-gap floor, tiles | Persisted gaps observed at 7-111 tiles (A: 78,73,23,16; B: 111,18,18,17,16) | Both regimes produce qualifying (≥12) and disqualifying (<12) gaps | OK |
| `confirmSweeps = 5` (facilities.ts:155) | Sweeps a gap must persist | `sweeps` observed up to 9 (A) and 27 (B) in `facilityPending` | Comment already documents this was raised from 8 after measuring ~4 sweeps/session; log shows sweeps reaching well past 5 in both parks | OK — already the corrected value, with its own measured justification in-file |
| `maxPerKind = 8`, `maxPlacements = 1` (facilities.ts:156-157) | Facility caps | `facilities` counts observed 0-4 per kind (A), 0-3 (B) — nowhere near the 8 cap | OK both regimes | OK |
| `siteRadius = 10` (facilities.ts:167) | Max tiles from cluster to buildable site, must stay < `minDistance` (12) | Already raised from 6 per in-file measurement (7 consecutive `facilityNoSite` passes) | 10 < 12 holds structurally, independent of park scale | OK |

## amenities.ts

Pure logic module — no numeric constants of its own beyond `AmenityOptions` fields,
which are supplied entirely by `trash-manager.ts` (audited there).

## ops.ts

| Constant (file:line) | What it gates | Observed range | Reachable | Verdict |
|---|---|---|---|---|
| `HIGH_QUEUE_MINUTES=5` / `LOW_QUEUE_MINUTES=1` (ops.ts:73,75) | Queue-pressure classification, minutes | `worstQueueMinutes` observed 0-16 across both parks | Both ends of the classification are hit (queues both <1 min and >5 min appear) | OK |
| `CONFIRM_OBSERVATIONS = 4` (ops.ts:77) | Hysteresis before acting | Day-count, scale-free | Same at any park size | OK — and this is the corrected value; the file documents the prior consecutive-streak version being unreachable (0 rides tuned over 18 days) |
| `MIN_VALUE = 1` (ops.ts:88) | Assumed floor before discovery | Discovered per-ride via probing, not applied blind | Self-correcting via `noteSetRejected` | OK |
| `PROBE_HARD_CEILING = 255` (ops.ts:91) | Absolute probe cap (uint8 max, `RideSetSettingAction` value is a byte) | n/a — matches the type's real range | Same at any scale | OK, matches the engine's own byte-width limit |
| `INTENSITY_CEILING = 900` (ops.ts:103) | Blocks lengthening a cycle above 9.00 intensity | `highIntensity` count observed 0-2 rides in telemetry | Both regimes can have high-intensity rides | OK |

**`OPS_PROBE_CEILING = 32`** (wait-time-optimizer.ts:100, feeds `ops.ts`'s
`createOpsController`) deserves its own line since the task calls it out explicitly:

Checked against `gamesrc/OpenRCT2/src/openrct2/ride/rtd/**/*.h` `.OperatingSettings`
tables. Most ride types cap well under 32 (e.g. swinging ship 7-25), but several exceed
it — `Dodgems.h:38` and `FlyingSaucers.h:37` are `{ 20, 180 }`. Tracing the probe
algorithm (`ops.ts:441-471`): on acceptance it doubles (`probeLow * 2`) until a
rejection, so starting at 32 does **not** cap discovery — it reaches 64, then 128, then
256. But 256 exceeds `PROBE_HARD_CEILING` (255), so the doubling step gives up and
records `max = probeLow = 128` — **52 short of Dodgems' true legal max of 180**, an
under-discovery, not a wrong or unsafe value (128 is a genuinely accepted setting).
Telemetry shows no ride actually hit this — the highest `ops.tuned` value observed was
13, and `optimizableRides` in both parks tops out at 12, well under where this matters.

**Verdict: OK, with a caveat.** Raising `OPS_PROBE_CEILING` would not fix the 128 vs
180 gap (that's the doubling-vs-255-hard-cap interaction, not the starting point) — it
would only affect rides whose true max is under 32, which finish in fewer probe steps
either way. No change proposed; flagging for awareness that any ride type with
`MaxValue` in the 129-255 range (there are several with 180, 68, 64, 60, 52, 50, 40, 38,
33 per the grep above) will have its true ceiling under-discovered by exactly this
doubling/hard-cap interaction, independent of `OPS_PROBE_CEILING`'s value.

## queues.ts

| Constant (file:line) | What it gates | Observed range | Reachable | Verdict |
|---|---|---|---|---|
| `FLOOR_MINUTES = 3` (queues.ts:51) | Queues below this are never flagged rising | `worstQueueMinutes` 0-16 across both parks | Crosses 3 in both A and B | OK |
| `RISE_OBSERVATIONS = 2` (queues.ts:59) | Consecutive rises before "rising" | Day-count, scale-free | `risingQueues`/`warningQueues` observed non-zero (up to 3) in B telemetry | OK |

## hotspots.ts

No numeric constants of its own; `CELL_KEY_Y_BITS`/`MAX_TILE_COORD` are the same fixed,
map-size-derived values as `needs.ts` (see above) — same verdict, OK.

## vomit.ts

| Constant (file:line) | What it gates | Observed range | Reachable | Verdict |
|---|---|---|---|---|
| `HIGH_NAUSEA = 750` / `MIN_NAUSEA = 500` (vomit.ts:54,56) | Nausea (2-decimal fixed) source plausibility | Not directly logged per-ride in `rct-debug.log`, but `worstVomit`/`worstHotspot` counts observed 0-8 pieces in both parks, and NOTES.md/roadmap record measured nausea readings in the 7.50-8.40 range for real culprit rides | Threshold is dimensionless (0-1000 fixed-point scale), not guest/ride-count dependent | OK |

## thoughts.ts

| Constant (file:line) | What it gates | Observed range | Reachable | Verdict |
|---|---|---|---|---|
| `MUCH_SUFFIX` category split (thoughts.ts:76 + logic) | wants_item vs has_too_many | `problems` telemetry shows `pricing`/`sickness`/`queue`/`needs` categories firing with counts 27-277 across both parks | Not a scale threshold — a string-matching correctness rule, verified in file header against every underscore-containing item name | OK, not a tunable in the audited sense |

`THOUGHT_MAX_FRESHNESS = 100` lives in `trash-manager.ts` (below), not `thoughts.ts`.

---

## trash-manager.ts

| Constant (file:line) | What it gates | Observed range | Reachable | Verdict |
|---|---|---|---|---|
| `GUESTS_PER_HANDYMAN = 30` (trash-manager.ts:103) | Classic formula's guest term (now only a **ceiling**, per NOTES.md) | Guests 565-984 (A) → `ceil(984/30)=33`; 0-626 (B) → `ceil(626/30)=21` | Matches observed `needed` field (21-35 A, 3-23 B) | OK — this is a documented ceiling, not the active controller; adaptive staffing (`staffing.ts`) does the real work and is separately verified good |
| `PATH_TILES_PER_HANDYMAN = 100` (trash-manager.ts:104) | Classic formula's tile term | pathTiles 330-361 (A) → `ceil(361/100)=4`; 50-192 (B) → `ceil(192/100)=2` | Correctly the smaller of the two terms in both parks (guest term dominates), so its exact value barely matters while `GUESTS_PER_HANDYMAN` is the binding one | OK |
| `PATH_TILES_PER_HANDYMAN_FLOOR = 150` (trash-manager.ts:388) | **Live floor** — `staffingFloor()` = `ceil(pathTiles/150)+2` | A: `ceil(361/150)+2 = 5` matches observed `staffingFloor:5`; B: `ceil(192/150)+2 = 4` matches observed `staffingFloor:4`; B early (50 tiles): `ceil(50/150)+2 = 3` | Both regimes produce small, sane floors (3-5) that never approach the 9-23 handymen actually employed | OK — arithmetic checks out exactly against telemetry |
| `FREE_ROAMING_BUFFER = 2` (trash-manager.ts:102, shared w/ mechanic-manager.ts:18) | Added to every formula/floor | n/a, additive constant | Same both regimes | OK |
| `TILE_SCAN_COOLDOWN_MS = 30_000` (trash-manager.ts:136) | Real-time throttle on O(map²) scan | Real-time cooldown, deliberately game-speed-independent per performance.md rule 3 | Same at any game speed/park size — that's the point | OK |
| `HOTSPOT_CELL_TILES = 8` (trash-manager.ts:154) | Litter clustering grid | pathTiles 50-361 across both parks; an 8-tile cell is small relative to even the smallest (50-tile) park | OK both ends | OK |
| `HOTSPOT_MIN_OLD = 8` (trash-manager.ts:157) | "Worth mentioning" old-litter hotspot floor | `oldLitter` observed max 5 across BOTH parks in this log | **Never reachable in either observed park** — old litter peaks at 5, this threshold is 8. However, this only gates the human-readable hotspot callout (cosmetic), not any action — matches NOTES.md's own account that this park's litter problem is overwhelmingly vomit, so old-trash hotspots are expected to stay quiet. Not a functional bug, just a threshold that has not fired in this log. | Flag, low severity: lower to ~4-5 (just above the observed 5 peak's midpoint... actually AT the peak) if hotspot callouts are wanted on a mature park; **no change proposed** because nothing downstream depends on it firing and the module's job (mark real hotspots) is still done correctly when it stays silent on a genuinely low-litter park. |
| `VOMIT_MIN_TO_REPORT = 3` (trash-manager.ts:161) | Vomit-cluster reporting floor | `vomit` observed 0-4 (A), 0-8 (B) | Reachable in both, comment already documents a measurement (peaks 3-4/cell on 1,600-guest park) that set this value | OK |
| `VOMIT_SOURCE_RADIUS_TILES = 12` (trash-manager.ts:165) | Search radius, ride-to-cluster attribution | Not park-scale-dependent (tile-distance constant) | Both regimes have rides within typical walking distance of clusters | OK |
| `BENCH_SEARCH_RADIUS = 4` (trash-manager.ts:167) | Existing-bench search radius | Same | OK | OK |
| `AMENITY_COOLDOWN_MS = 10_000` (trash-manager.ts:176) | Real-time throttle | Deliberate, game-speed-independent | OK | OK |
| `AMENITY_RADIUS = 6` (trash-manager.ts:177) | Placement search radius | `coverageTiles` (using `COVERAGE_CELL_TILES=6`) observed 8-35 cells across both parks — radius 6 comfortably reaches a cell's neighbours in both a 50-tile and a 361-tile path network | OK both ends | OK |
| `AMENITY_SATISFIED = 3` (trash-manager.ts:178) | "Already covered" radius | Same tile-distance constant, both regimes | OK | OK |
| `AMENITY_MAX_PLACE = 15` (trash-manager.ts:179) | Per-pass placement budget | `coverageTiles` 8-35; 15 covers roughly half the largest observed coverage grid in one pass, all of the smallest in one pass | Reachable/binding in A (35 cells > 15 budget, so multiple passes needed — expected, by design) and non-binding in early B (8 cells < 15) | OK — behaves as a budget, not a hard scale mismatch, in both regimes |
| `COVERAGE_CELL_TILES = 6` (trash-manager.ts:184) | Coverage grid cell size | pathTiles 50-361 | `coverageTiles` field (8-35) confirms this scales sensibly with park size in both regimes — the task's suggested 121-vs-352-tile comparison is closely matched by the log's actual 50-361 range and produces a proportionate 8-35 cell count, i.e. no runaway or collapsed grid at either end | OK |
| `REMOVAL_CONFIRM_PASSES = 5` (trash-manager.ts:196) | Amenity-removal hysteresis | Comment cites measured 28 removals / 64 placements churn that justified this; not independently re-measurable from this log (no removal counters present in the `park` telemetry object) | Assume unchanged since fix; OK | OK, per existing in-file measurement |
| `VOMIT_DEMAND_COUNT = 8` (trash-manager.ts:199) | How many vomit clusters get a bench demand | `vomit` cluster counts observed low (0-8 pieces total, not 8 clusters) in this log — the cap is far above what either park currently produces | Both regimes: cap non-binding, harmless | OK |
| `AMENITY_MIN_CASH = 1_000 * 10` = £1,000 (trash-manager.ts:215) | Cash floor for bench/bin placement | This is the corrected value; in-file comment documents the original bug (5000_00 read as GBP 50,000 instead of 5,000, in TENTHS) and the measured fix (footpath additions cost tens of pounds; a 15-placement pass costs well under £1,000) | £1,000 reserve is reachable on both a starting scenario (once past initial capital) and a mature park | OK — already fixed and measured |
| `NEED_SAMPLE_COOLDOWN_MS = 2_500` (trash-manager.ts:246) | Real-time sample throttle | Deliberate, `day.needSample` measured 1-4ms | OK | OK |
| `NEED_SAMPLE_WINDOW = 400` (trash-manager.ts:247) | Guests sampled per pass | Guests 565-984 (A) → 41-71% sampled/pass; 0-626 (B) → up to 100% sampled/pass for small counts, ~64% at 626 | Both regimes get a substantial, non-degenerate sample fraction; the rotation-completeness bug that would have made this matter (never wrapping on growth) is already fixed in `needs.ts` | OK |
| `NEED_CELL_TILES = 8` (trash-manager.ts:248) | Need-clustering grid, matches litter grid | Same as `HOTSPOT_CELL_TILES` reasoning | OK | OK |
| `NEED_GAP_MIN_GUESTS = 3` (trash-manager.ts:249) | Reporting-only cluster-size floor (separate from `facilities.ts`'s `minGuests=5` construction gate) | `needGaps` cluster sizes observed 3-10 (A), 3-8 (B) | Both regimes produce clusters right at and above 3 | OK — reachable at both scales; see `facilities.ts` entry above for why this is not the same bug as the task's "known suspect" framing suggests |
| `FACILITY_COOLDOWN_MS = 30_000` (trash-manager.ts:272) | Real-time throttle on build pass | Deliberate | OK | OK |
| `FACILITY_MIN_CASH = 2_000 * 10` = £2,000 (trash-manager.ts:292) | Cash floor for facility construction | Already-fixed value; in-file comment documents the original £20,000 floor (66× the £300 cost of a food stall) and the measured failure (`facilitySkippedLowCash` fired 16 consecutive passes on a starting scenario) | £2,000 is reachable on a starting scenario shortly after opening and trivially on a mature park | OK — already fixed and measured, this is literally bug #2 from the task's own list, already resolved in the current source |
| `FACILITY_BUILD_TIMEOUT_MS = 60_000` (trash-manager.ts:326) | Real-time watchdog on an in-flight build | Deliberate, matches the "in-flight guard needs a watchdog" lesson in NOTES.md | OK | OK |
| `THOUGHT_MAX_FRESHNESS = 100` (trash-manager.ts:335) | Thought staleness filter | `problems` category counts observed 27-277 across the log, clearly non-zero and varying — the filter is passing a meaningful, non-degenerate fraction of thoughts in both parks | OK | OK |

## wait-time-optimizer.ts

| Constant (file:line) | What it gates | Observed range | Reachable | Verdict |
|---|---|---|---|---|
| `QUEUE_WARN_MINUTES = 5` (wait-time-optimizer.ts:45) | Emergency dispatch trigger | `worstQueueMinutes` 0-16; `warningQueues` observed up to 3 (B) | Reachable both regimes | OK |
| `QUEUE_CRITICAL_MINUTES = 12` (wait-time-optimizer.ts:50) | Louder critical marker | `worstQueueMinutes` reaches 16, i.e. above 12 — confirmed reachable | OK | OK |
| `CAPACITY_BOUND_DAYS = 5` (wait-time-optimizer.ts:55) | Days before calling a ride capacity-bound | Day-count, in-file comment cites a measured 43-day case that motivated this | OK | OK |
| `MIN_WAIT_FLOOR = 0` / `MAX_WAIT_CAP = 60` (wait-time-optimizer.ts:57,59) | Wait-time clamp, seconds | Not park-scale-dependent — a per-ride dispatch parameter | OK both regimes | OK |
| `INTENSITY_HIGH = 800` (wait-time-optimizer.ts:79) | Full-load vs any-load choice | `highIntensity` observed 0-2 rides | Reachable | OK |
| `OPS_PROBE_CEILING = 32` (wait-time-optimizer.ts:100) | See the dedicated `ops.ts` section above | — | — | OK, with the noted under-discovery caveat for ride types with `MaxValue` in 129-255 |
| `OPS_COOLDOWN_MS = 15_000` (wait-time-optimizer.ts:101) | Real-time throttle | Deliberate | OK | OK |
| `OPS_MAX_PROBES = 10` (wait-time-optimizer.ts:110) | Per-pass probe budget | `ops.rangeKnown` observed reaching 9-10 out of `optimizableRides` (max 12) — the budget is large enough to finish discovery within a handful of passes in both parks, matching the in-file account of the old shared-budget-of-2 failure (only 2/10 rides finished over 18 days) being fixed by separating and raising this | OK | OK |
| `OPS_MAX_SETS = 1` (wait-time-optimizer.ts:111) | Per-pass real-change budget | `ops.tuned` observed 0-4 (climbing steadily, 1 per pass as designed) | Deliberately conservative regardless of scale (each set invalidates ride ratings) | OK |

## mechanic-manager.ts

| Constant (file:line) | What it gates | Observed range | Reachable | Verdict |
|---|---|---|---|---|
| `TARGET_RIDES_PER_MECHANIC = 4` (mechanic-manager.ts:16) | Classic formula ceiling | rides 10-13 (A) → `ceil(13/4)+2=6`, matches observed `targetMechanics` max 6; rides 0-10 (B) → `ceil(10/4)+2=5`, matches observed max 5 | Both regimes match telemetry exactly | OK |
| `FREE_ROAMING_BUFFER = 2` (mechanic-manager.ts:18) | Additive buffer, shared constant with trash-manager | n/a | OK | OK |
| `OPTIMAL_INSPECTION_INTERVAL = 0` (mechanic-manager.ts:31) | Re-applied daily per NOTES.md ("load-bearing, not redundant") | Not independently telemetered here; behaviour already verified per NOTES.md | Game-defined constant (0 = "every time"), not scale-dependent | OK |
| `MECHANIC_FLOOR = 2` (mechanic-manager.ts:79) | Floor passed into `staffing.ts` as `signals.floor`, **only when `cache.rideCount > 0`** (mechanic-manager.ts:452) | `mechanics` observed 2-6 (A), 0-4 (B, including the pre-open 0-ride state where the floor is correctly suppressed) | The `rideCount > 0` guard is exactly what makes this reachable/correct in BOTH regimes — a naive floor of 2 with no guard would force 2 mechanics onto a 0-ride park before it even opens; this code already avoids that | OK — correctly guarded against the early-game regime |
| `EMERGENCY_REPAIR_DAYS = 3` (mechanic-manager.ts:93) | Cheat-labelled forced-repair threshold | Day-count, off by default | OK | OK |
| `MECHANIC_IDLE_DAYS = 20` (mechanic-manager.ts:111) | (paired with `staffing.ts`'s `floorDecayDays`) | Day-count | OK | OK |
| `UNATTENDED_DAYS = 2` (mechanic-manager.ts:252) | Feeds the mechanic urgent signal (rides broken 2+ consecutive days) into `staffing.ts`'s `MECHANIC_THRESHOLDS.urgentAt=1` | `minReliability` observed dropping to 23 (A) / 64 (B), consistent with genuine multi-day breakdowns occurring in the mature park | Reachable in both, and this is precisely the corrected mechanic signal (see staffing.ts entry above) | OK |
| `MAX_BREAKDOWN_LOG = 5` / `MAX_WATCH_LIST = 5` (mechanic-manager.ts:35,37) | UI list caps | Not scale-dependent — cosmetic display caps | OK | OK |

---

## Summary

- **Constants audited:** 79 across the 12 in-scope files (9 pure modules + 3 plugin
  entry points), counting every exported/local numeric tunable, including the shared
  `staffing.ts` threshold sets used by both trash-manager and mechanic-manager.
- **Flagged:** 2.
  1. `HOTSPOT_MIN_OLD = 8` (trash-manager.ts:157) — never reached in either observed
     park (`oldLitter` peaks at 5). Cosmetic only (gates a hotspot callout, not an
     action); no change proposed because nothing downstream depends on it and staying
     silent is the correct behaviour on a genuinely low-litter park.
  2. `OPS_PROBE_CEILING = 32` interaction with `PROBE_HARD_CEILING = 255`
     (ops.ts:441-471) — the doubling probe strategy under-discovers the true max for
     any ride type whose `RideOperatingSettings.MaxValue` sits in 129-255 (confirmed via
     `gamesrc` grep: Dodgems/FlyingSaucers are `{20, 180}`; several coaster types sit at
     33-68). Not observed to matter in this log (max discovered/used value was 13,
     `optimizableRides` never included a ride of that type) — flagged for awareness,
     no change proposed since the starting ceiling isn't the actual cause.
- **Not flagged, but explicitly re-verified as already-fixed** (the three bugs named in
  the task brief, all confirmed resolved in current source with arithmetic matching
  telemetry): the mechanic-controller unit mismatch (`MECHANIC_THRESHOLDS` in
  staffing.ts), the £20,000/£300 cash-floor regime mismatch (`FACILITY_MIN_CASH` /
  `AMENITY_MIN_CASH` in trash-manager.ts, now £2,000/£1,000), and the growth-regime
  sample-window bug (`createSampleRotation` in needs.ts, now decides completeness from
  the pass that ran).

### Three most serious findings (arithmetic)

1. **Mechanic urgent-hire unit mismatch — already fixed.** Handyman
   `URGENT_OLD_LITTER=25` (pieces of litter) was being compared against `oldLitter`
   fed as a **count of rides broken**, which cannot exceed the park's ride count (10-13
   in Park A). `25 > 13`, so the urgent path was arithmetically dead — confirmed by the
   in-file account of hires going 5→4→3 against a formula target of 6 while a ride sat
   broken 11 days. The fix (`MECHANIC_THRESHOLDS.urgentAt=1`, "2+ consecutive broken
   days" as the signal) is reachable: 1 ≤ observed broken-ride counts in both parks.

2. **Facility cash floor — already fixed.** £20,000 (`5000_00` misread as hundredths)
   against a £300 food stall is a 66× overshoot; on Park B (a starting scenario) this
   is unreachable early game, confirmed by the documented 16 consecutive
   `facilitySkippedLowCash` skips. Current `FACILITY_MIN_CASH = 2_000*10` = £2,000 is
   ~6.7× the £300 stall cost — a sane buffer reachable soon after park opening, not
   gated to mature-park cash reserves only.

3. **Sample-window growth bug — already fixed.** `offset >= total` as a completion
   check is false forever once `total` (guest count) grows between passes, since
   `offset` only ever reaches `min(offset+window, total)`. Measured: 78 in-game days,
   0 publishes, on a park growing 99→214 guests (matches this log's Park B pattern,
   which grows 0→626). The fix decides `sweepComplete` from `end >= total` within the
   *current* pass (`needs.ts:421-435`), which is correct regardless of whether `total`
   moves before the next call.
