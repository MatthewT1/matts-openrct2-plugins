# Roadmap — Work Log (archived)

The 2026-09-20 parallel build-out, work packages and regression/validation passes, moved verbatim out of [roadmap.md](../roadmap.md) on 2026-09-24. All of it is done.

---

## Parallel build-out results (2026-09-20)

All four packages landed. Full detail in
[performance.md](performance.md) and [scale-audit.md](scale-audit.md).

| | Package | Outcome |
|---|---|---|
| P1 | Scale audit | **79 constants audited**, 2 flagged, both fixed |
| P2 | Security / entertainers | Security **closed**; entertainers **built** after a corrected verdict |
| P3 | Queue attribution | `createInterventionTracker`, per-ride before/after evidence |
| P4 | User docs | `README.md` + `docs/user-guide.md` |

### SEC — Security guards: CLOSED

`brokenBins` is **0 in all 528 telemetry records** across both parks, and the string
`vandal` appears **nowhere** in the log — never in `park.problems`, never in a guest
thought. Top complaint categories are pricing (352), sickness (339), queue (336), needs
(329); vandalism does not place. There is no signal to act on. **Reopen only if
`brokenBins` becomes non-zero** — it is already instrumented, so this is checkable rather
than a matter of opinion.

### ENT — Entertainers: BUILT (`staff-extras.ts`, off by default)

Nearly closed on a **scale error**, which is worth recording because it is the project's
signature failure appearing inside the very task meant to avoid it.

The first verdict rested on "the queue-leave threshold is 15 min = 36000 ticks". The real
check is `Guest.cpp:5729-5739`:

```
if (timeInQueue < 4300)
    return;
if (happiness <= 65 && (0xFFFF & ScenarioRand()) < 2184)
    // Give up queueing for the ride
```

**4300, not 36000** — an 8x error, and the number the whole judgment hung on. One
entertainer hit (`timeInQueue -= 200`, `Staff.cpp:925`) is worth **~4.7% of the entire
patience budget**, not ~0.55%.

Three things the first pass also missed:

1. **The effect is double-barrelled.** Giving up requires BOTH `timeInQueue >= 4300` AND
   `happiness <= 65`. An entertainer attacks both gates at once (`-200` ticks, `+3`
   happiness, `Staff.cpp:925-926`). The happiness bump is half the mechanic, not a
   footnote.
2. **Guests demonstrably reach these thresholds here.** `queuingAges` fires at
   `timeInQueue >= 3500` (`Guest.cpp:5684`); this park measured `queuing_ages` at **67**
   guests and `crowded` at **96**.
3. **Patrol rectangles were available all along.** The project already issues
   `staffsetpatrolarea`, already knows `ride.stations[0].start`, and patrol cost scales
   with **area** — the 440ms figure was for park-sized boxes. The shipped rectangle is
   9x9 tiles around a station, which is negligible.

**Accepted limitation, stated rather than hidden:** the rectangle is a fixed box around
the station, not traced queue-path geometry. It covers the front of the queue — where
guests are closest to 4300 — but not the back of a long snaking line.

> **Safety gap found in review and fixed.** The delivered version fired from the **full
> entertainer roster**. Handymen and mechanics are fungible, so firing whichever the
> roster returns is harmless; an entertainer is not. Players place them deliberately, in
> a chosen **costume**, beside a themed ride — and this plugin hires at `costumeIndex: 0`,
> so it could fire a hand-placed pirate and replace it with a plain entertainer,
> irreversibly. It now tracks the ids it hired in park storage and **only ever fires
> those**, the same rule that governs bench removal. Player-hired entertainers still
> count toward coverage; they are simply never candidates. Surplus that cannot be fired
> is reported as `entertainersProtected` rather than silently ignored.

### P1 findings, both applied

**OPS probe ceiling under-reported the legal maximum.** Doubling ran 32 -> 64 -> 128 ->
256; 256 exceeds `PROBE_HARD_CEILING`, so the controller recorded `max = 128` and stopped.
Real ride types break on that: Dodgems and Flying Saucers are `{20, 180}`
(`ride/rtd/gentle/Dodgems.h:38`), Maze is `{1, 64}`, others are `{10, 40}` and `{30, 50}`.
The band above the last power of two was permanently unreachable. It now brackets against
the ceiling and binary-searches the gap — probes are silent `queryAction` calls, so
accepting an approximation was never necessary. **5 new tests** confirm it finds 180, 64,
50 and 18 exactly and still caps at 255.

**`HOTSPOT_MIN_OLD = 8` was unreachable.** `oldLitter` peaks at **5** park-wide across
both parks, so the litter-hotspot console callout could never fire. Lowered to 3.
Cosmetic, but the same pattern as the five features that shipped dead.

---

## Remaining work packages

Four packages, designed to run **in parallel** with **disjoint file ownership** so they
cannot conflict. Each is sized for a cheap agent at low effort; the integration step at
the end is the only one that needs judgement across packages.

### Constraints that apply to every package

Non-negotiable, because each one has already cost this project a session:

1. **`gamesrc/` is the authority.** Never trust a web search about this API — one
   confidently reported `operationOption` as a Ride property; it does not exist. Cite
   `file:line` for every claim about game behaviour.
2. **Check every threshold against the range the signal actually produces**, read from
   `tools/rct-debug.log`, not from intuition. Five features have shipped dead behind an
   unreachable threshold.
3. **Instrument the skip paths**, not just the success paths. A feature that silently
   does nothing must say *which* condition stopped it.
4. **Decision logic goes in a pure module** (no `map`/`context`/`park` globals) with
   tests in `tests/`. Plugin entry points hold mechanism only.
5. **Money is in TENTHS of a pound** (`core/Money.hpp:27`).
6. **Do not change behaviour that telemetry shows is working** without evidence.
7. Build with `node node_modules/rollup/dist/bin/rollup -c`, test with
   `node tests/run.mjs`. **npm is broken on this machine** — call binaries via node.
8. **Concluding "do not build this" is a valid, valuable result.** Two features have been
   correctly closed that way.

---

### P1 — Scale and regime audit  *(read-only)*

**Why:** three separate bugs in three sessions were all the same shape — logic correct in
the regime it was written for, wrong in another. A **unit** error (litter thresholds fed
ride counts), a **cash regime** error (a £20,000 floor on a starting scenario), and a
**growth regime** error (a rotating window that never wrapped on a growing park). There
are very likely more.

**Deliverable:** `docs/scale-audit.md` — a table of every tunable constant across
`staffing.ts`, `needs.ts`, `facilities.ts`, `amenities.ts`, `ops.ts`, `queues.ts`,
`hotspots.ts`, `vomit.ts`, `thoughts.ts` and the three plugin entry points, each with:

| Column | Content |
|---|---|
| Constant, file:line | where it lives |
| What it gates | the signal it is compared against |
| Observed range | from `tools/rct-debug.log`, both the 99-214 guest park and the 900+ one |
| Reachable? | small park / large park / early game / late game |
| Verdict | OK, or a proposed value with the arithmetic |

**Known suspects to check first:** `minGuests: 5` and `NEED_GAP_MIN_GUESTS: 3` on a
200-guest park; `COVERAGE_CELL_TILES` and `AMENITY_MAX_PLACE` on a 121-path-tile park;
`GUESTS_PER_HANDYMAN` at both ends; `OPS_PROBE_CEILING` against ride types whose real
maximum exceeds 32.

**Writes:** `docs/scale-audit.md` only. **Changes no code** — proposals go in the table
so they can be reviewed together rather than applied piecemeal.

---

### P2 — Security guards and entertainers

**Why:** the two staff types this project has never touched, and the last genuinely
unbuilt features.

**Verify before building — this is most of the task:**

- **Security.** `brokenBins` has been **0 in every record ever taken**, and `vandalism`
  has never reached the top four thought categories. On current evidence this park does
  not have the problem. Confirm from the log, then either close it with the numbers
  recorded, or build if the evidence has changed.
- **Entertainers.** Their supposed benefit is holding guests in queues, but OpenRCT2
  guests leave at 15 minutes **regardless**
  ([#5753](https://github.com/OpenRCT2/OpenRCT2/issues/5753)). **Find what entertainers
  actually do in `gamesrc/`** — search `Staff.cpp` / `Guest.cpp` for the entertainer
  interaction and report the real mechanic with `file:line` before designing anything.
  Queue complaints are measured and real (`crowded` peaked at 96), so if there is a genuine
  happiness effect this is worth building; if the effect is negligible, say so and stop.

**If building:** a new plugin `src/staff-extras.ts` plus a pure module and tests. Staff
types are known: **2 = security, 3 = entertainer**; security wages **£60/month**
(`Staff.cpp:2645`). Reuse `staffing.ts` — **with its own `StaffingThresholds`**, never the
litter defaults. That exact mistake is why the mechanic controller could only ever fire.

**Writes:** `src/staff-extras.ts`, `src/<new module>.ts`, `tests/*.test.mjs`,
`rollup.config.js`, and a roadmap section. **Touches no existing plugin.**

---

### P3 — Queue attribution

**Why:** the one open empirical question. Worst queue went **6 → 16 minutes** — past the
15-minute walk-out — with `capacityBound` 0 → 4, and four candidate causes that the
telemetry cannot separate: OPS lengthening cycles, an 8-day breakdown, park growth, or W2
itself. `queuePreemptive` fired 8 times, so W2 is genuinely in the frame.

**Deliverable:** per-ride attribution, so the next run answers it without guesswork.
Record per ride per day: queue minutes, whether W2 applied the pre-emptive override,
whether OPS changed its operation value and to what, train/car count, and
`capacityBound`. Then a small pure helper that reports, for each ride, **queue time before
versus after** each intervention.

The goal is a log that can state "ride X was overridden on day N and its queue went
7 → 11 over the following five days" — evidence, not correlation across a whole park.

**Writes:** `src/queues.ts`, `src/wait-time-optimizer.ts`, `tests/queues.test.mjs`.

---

### P4 — User-facing documentation

**Why:** there is **no README**, and **11 toggles** across three plugins with no single
explanation of what they do, which are safe, or which cost money. The engineering docs are
thorough and are aimed entirely at whoever maintains this next — not at whoever plays it.

**Deliverable:** `README.md` (what the plugins are, install, the one-paragraph pitch per
plugin) and `docs/user-guide.md` covering every toggle:

| Toggle | Plugin | Default | Spends money? | What it does, in one sentence |

Call out plainly: which are **off by default and why**, that **emergency repair is a
cheat**, that **facility building spends real money and never demolishes**, and that
**OPS discards ride ratings until the ride runs again**. Source the facts from
`NOTES.md` and `docs/`; do not re-derive them.

**Writes:** `README.md`, `docs/user-guide.md`. **No code, no existing docs.**

---

### P5 — Integration  *(not parallel; after P1-P4 land)*

Apply the P1 audit's accepted proposals, reconcile P2's verdict into the roadmap, run the
full suite, rebuild, deploy, and update `NOTES.md` and `docs/performance.md`. This is the
only step that needs a view across all four packages.

---

### File ownership map

Proof that P1-P4 cannot collide:

| Package | Writes |
|---|---|
| P1 | `docs/scale-audit.md` |
| P2 | `src/staff-extras.ts`, new module + tests, `rollup.config.js` |
| P3 | `src/queues.ts`, `src/wait-time-optimizer.ts`, `tests/queues.test.mjs` |
| P4 | `README.md`, `docs/user-guide.md` |

`trash-manager.ts`, `mechanic-manager.ts`, `staffing.ts`, `needs.ts` and `facilities.ts`
are deliberately owned by **nobody** during the parallel phase — they are the files most
recently changed and the ones P1 is most likely to have proposals for, so they are held
for P5.


### Pricing — the largest measured complaint, and out of scope

Worth recording because it is the single biggest thing the telemetry found and **no
plugin here addresses it**. Peak thought counts over the 2026-09-20 session:

| Category | Top thought | Peak |
|---|---|---|
| **pricing** | `bad_value` | **134** |
| **pricing** | `cant_afford_ride` | **130** |
| needs | `toilet` | 105 |
| queue | `crowded` | 91 |

Pricing outranks every problem this project was built to solve. The user already runs a
separate `openrct2-price-manager` plugin, which is the right home for it — noting it here
so a future session does not rediscover it and assume it is unhandled.

### Fixed in the 2026-09-20 regression pass

The first play session with everything switched on found four real bugs. Full analysis in
[performance.md](performance.md#field-measurements-the-regression-session-2026-09-20-163-in-game-days).

| | Bug | Cause |
|---|---|---|
| **MS** | Mechanic controller could only ever *fire* | Litter-calibrated thresholds applied to ride counts; urgent-hire unreachable at `>= 25` on a 13-ride park |
| **MS** | ...and the fix exposed a ratchet the other way | `discoveredFloor` never decayed, so an unreachable ride pins the controller at the formula ceiling forever |
| **OPS** | 192 probes, 8 ranges, 1 ride tuned | Records deleted whenever a ride left the optimizable list, discarding the probed range |
| **NEEDS ph.3** | Could not fire at all | `confirmSweeps: 8` against a *measured* ~4 sweeps per session, plus `top(kind, 2)` evicting persistent clusters |
| **W2** | Telemetry self-contradictory | `risingQueues` counted rides already in "warning"; impossible to tell whether the feature ever ran |

> **The through-line.** Three of these are the same mistake wearing different clothes: a
> threshold chosen against an *imagined* range rather than a measured one. The project
> already had a rule for that
> ([check thresholds against real data](performance.md#the-rules)) and it still happened,
> because the rule was being applied to *new* constants only. `URGENT_OLD_LITTER = 25` was
> correct where it was written and became wrong when reused. **Reusing a controller reuses
> its calibration, and calibration is where the units live.**

---

### Validated in the field, 2026-09-20

First run after the regression fixes. Full analysis in
[performance.md](performance.md#field-measurements-the-validation-session-2026-09-20-41-in-game-days).

| | Status | Evidence |
|---|---|---|
| **MS** mechanic thresholds | ✅ **working** | Released to 2 while quiet, detected an unattended breakdown on day 2, hired to 6, reliability recovered 23% → 45% |
| **OPS** record retention | ✅ **working** | `rangeKnown` 0 → **10 and held** across closures (was stuck at 8); `tuned` 0 → 4 with persistent values |
| **NEEDS ph.3** facility building | ✅ **built its first facility** | A toilet. `toiletUrgent` 45 → 29, toilet complaints dropped from #2 to #4. Zero orphans |
| **W2** telemetry | ✅ **readable** | `queuePreemptive: 8` — the feature demonstrably ran |

Two new bugs found and fixed in the same pass:

| Bug | Cause |
|---|---|
| **OPS calibrated congested rides the wrong way** | Midpoint calibration is direction-blind, so a busy ride below the midpoint got *lengthened*. Now calibrates to the **minimum** when congested |
| **Urgent hires were not paced** | 4 hires in 4 days for a ride that stayed broken 8 days regardless. `urgentHirePaceDays: 3` for mechanics, 0 for handymen |

---
