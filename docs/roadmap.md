# Roadmap — Proposed Improvements

Each item is tagged with its basis (**source** = verified in OpenRCT2 C++;
**research** = community consensus, see [research.md](research.md); **measured** = from
the debug log) and a cost estimate against the
[cost budget](performance.md#cost-budget).

Status: `proposed` · `in progress` · `done` · `rejected`

---

## Contents

- [Priority order](#priority-order)
- [Cross-cutting](#cross-cutting)
- [Ideas not yet scoped](#ideas-not-yet-scoped)
- [Trash Manager](#trash-manager)
- [Mechanic Manager](#mechanic-manager)
- [Wait Time Optimizer](#wait-time-optimizer)
- [Rejected / deferred](#rejected--deferred)

---

## Priority order

Rebuilt 2026-09-20 from the actual statuses below.

### Done

| | Item | Notes |
|---|---|---|
| T0 | [Park-context telemetry](#t0--park-context-telemetry) | unblocked everything else |
| A | [Litter hotspot map](#a--litter-hotspot-map) | |
| B | [Stuck / idle staff detection](#b--stuck--idle-staff-detection) | rewritten twice after false positives |
| S | [Closed-loop staffing](#s--closed-loop-staffing) | rewritten after overshoot, then a deadlock |
| D/V | [Vomit attribution + bench advisor](#dv--vomit-attribution-and-bench-advisor) | targets 99.7% of real litter |
| AM | [Automatic bench and bin management](#am--automatic-bench-and-bin-management) | replaces `benchwarmer` |
| W1 | [15-minute walk-out cliff](#w1--surface-the-15-minute-walk-out-cliff) | |
| W3 | [Capacity-bound ride detection](#w3--capacity-bound-ride-detection) | |
| M4 | [Inspection-interval rationale](#m4--correct-the-inspection-interval-rationale) | comment + tooltip were factually wrong |
| NEEDS ph.1 | [Guest-need instrumentation](#needs--guest-need-clustering-then-automatic-facility-placement) | measured flat at first; **fired once the park passed ~900 guests** |

### Closed without building

| | Item | Why |
|---|---|---|
| M2 | [Mechanic patrol zones](#m2--small-patrol-zones-for-mechanics) | **Rejected** — expected workload was never computed; mechanics do ~100% of available work |
| M1 | [Weight mechanics by downtime](#m1--weight-staffing-by-breakdown-risk) | Superseded by MS |
| C | [Bin placement advisor](#c--bin-placement-advisor) | Superseded by AM; measured irrelevant (3 of 851 litter was trash) |
| SHOP | Shop placement advisor | Folded into NEEDS |

### Done in the 2026-09-20 build-out (second pass)

| | Item | Shape |
|---|---|---|
| NEEDS ph.2-3 | [Automatic facility placement](#needs--guest-need-clustering-then-automatic-facility-placement) | `facilities.ts`; hysteretic, capped, never demolishes. **Unblocked by data** — see below |
| M3 | [Emergency repair](#m3--emergency-repair) | Opt-in, labelled a cheat, 3-day threshold |
| W2 | [Pre-emptive queue override](#w2--more-aggressive-emergency-override) | `queues.ts`; trend-based, not a lower threshold |

### Done in the 2026-09-20 build-out (first pass)

| | Item | Shape |
|---|---|---|
| MS | [Adaptive mechanic staffing](#ms--adaptive-mechanic-staffing) | Reuses `staffing.ts`; mechanic signals mapped onto it, floor of 2 |
| — | [Cost reporting](#cost-reporting) | Wage savings shown in both staffing windows and logged |
| E | [Guest-thought early warning](#e--guest-thought-early-warning) | `thoughts.ts`, 125 thought types categorised, piggybacks the existing guest sample |
| OPS | [Per-ride operation settings](#ops--per-ride-type-operation-settings) | `ops.ts`; probes the unreadable range with silent queries, hysteretic, off by default |

### Ideas noted, not yet scoped

**SEC/ENT — Security guards and entertainers.** The two staff types this project has never
touched. Natural fit for the existing machinery:

- `staffhire` types are already known: **2 = security, 3 = entertainer**; security wages
  are **£60/month** (`Staff.cpp:2645`).
- `Security` and `Entertainer` are distinct entity types in the API, and the per-staff
  productivity-counter pattern used for handymen and mechanics should extend to them.
- **Security** has a measurable demand signal already being collected: the `vandalism`
  thought category, plus `isAdditionBroken` on footpaths, which the trash tile scan
  already counts as `brokenBins`. Measured so far: **zero broken bins, ever** — so as with
  NEEDS, check whether the park has this problem before building for it.
- **Entertainers** are harder. Their benefit is slowing guest happiness decay in queues,
  and the project has established that OpenRCT2 guests leave at 15 minutes **regardless**
  of entertainers ([#5753](https://github.com/OpenRCT2/OpenRCT2/issues/5753)), so the
  value is narrower than vanilla guides suggest. **Verify the actual mechanic in
  `gamesrc/` before designing anything** — this is exactly the shape of assumption that
  sank M2.

Same discipline as everywhere else here: instrument first, confirm a problem exists, then
build.

> **Still measuring zero (checked again 2026-09-20).** `brokenBins` has been 0 in every
> record across every session, and `vandalism` has never once appeared in the top four
> thought categories. On the evidence available, this park does not have a security
> problem, and building a security controller would be building for an assumed problem —
> the exact mistake [M2](#m2--small-patrol-zones-for-mechanics) cost a session to.
> The signal is already instrumented, so this becomes checkable the moment it changes.

### Still open

**Every named item from the original roadmap is done, rejected, or superseded.** What
remains is not a backlog of features — it is four pieces of finishing work, scoped below
as [parallel work packages](#remaining-work-packages).

Out of scope by request: **Path Connector** (never reviewed this round, no test coverage,
839 lines — noted so a future session knows it was excluded deliberately, not missed) and
**pricing** (see below).

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

### Project status: feature-complete

> **Closing note (2026-09-20).** Automatic facility placement took **six** rounds to
> unblock, each fix real and each only exposing the next: the sample rotation never
> completing on a growing park; a £20,000 cash floor on a £300 stall; a slope filter and
> then a ground-level height assumption; a **phantom cluster at (4,4)** from off-map
> guests (24% of every sample); a **dead zone** between a cluster floor of 3 and a planner
> floor of 5; and finally **exact-coordinate keying** against a cluster that jitters,
> which left eleven real gaps each stuck at 1 sweep.
>
> All six are fixed and the first five are confirmed in telemetry. The sixth — proximity
> merging — is deployed and unvalidated. See
> [performance.md](performance.md#the-wandering-cluster-why-gaps-never-accumulated).
>
> **DONE AND VALIDATED (2026-09-20).** The full pipeline is proven end to end: need
> measured -> gap confirmed -> site found -> facility built and opened. `siteAccepted`
> **172**, `facilityPlaced` **4**, and **zero** orphans, track failures or create
> failures. Facilities grew hunger 4->5, thirst 2->4, toilet 4->6 on a park that reached
> 1,007 guests at rating 968.
>
> It took **seven** rounds, each fix real and each only exposing the next: sample
> rotation never completing on a growing park; a GBP 20,000 cash floor on a GBP 300
> stall; a slope filter; a ground-level height assumption; a phantom cluster at (4,4)
> from off-map guests (28% of every sample); a dead zone between a cluster floor of 3 and
> a planner floor of 5; exact-coordinate keying against a jittering cluster; and finally
> queue lines counting as walkable paths.
>
> See [performance.md](performance.md#it-works-end-to-end-validation-2026-09-20-final).




**Every item on this roadmap is done, rejected with reasons recorded, or closed on
measurement.** Nothing is outstanding.

| Area | State |
|---|---|
| Trash Manager | Litter, adaptive staffing, vomit advisor, benches/bins, guest needs, facility building |
| Wait Time Optimizer | Wait times, capacity-bound detection, walk-out warning, pre-emptive override, operation tuning |
| Mechanic Manager | Adaptive staffing, inspections, emergency repair |
| Staff Extras | Entertainers (security closed on measured zero demand) |
| Shared | 5 plugins, 10 pure modules, **337 tests**, telemetry throughout |

Validated in the field this session: the entertainer costume fix (4 hired), the
sample-rotation fix (19 sweeps published), the OPS direction fix (`opsSetRejected`
30 -> 2), and the 206ms lag fix (0-1ms).

### If you pick this up again

Nothing here is required. In rough order of value:

1. **Facility placement quality.** It works; the open question is now whether it places
   things *well*. Watch `siteRejectQueuePath` — if a spot keeps confirming while that
   counter climbs and nothing is built, the cluster is inside a queue. Queueing guests
   get hungry and are densely packed, so they look like strong demand, but they cannot
   step out to use anything. The fix then is to stop sampling queueing guests into need
   clusters at all. No evidence of this yet.

2. **The queue attribution question.** `queueAttribution` rows now record per-ride
   before/after for every W2 and OPS intervention. That data has never been read, because
   the parks changed underneath every attempt. It is the one open empirical question.
3. **Sickness.** `needs.sick` has been climbing while `verySick` stays at 1, and guests
   only seek first aid at nausea 200. If `verySick` rises, first-aid building becomes
   worth enabling.
4. **Security.** `brokenBins` is still 0 in every record ever taken. Instrumented and
   checkable the moment that changes.
5. **Pricing.** Consistently the largest guest complaint and deliberately out of scope —
   a separate price-manager plugin is the right home.

### Things not to redo

- **Mechanic patrol zones** — mechanics already do ~100% of available work. The arithmetic
  is in [M2](#m2--small-patrol-zones-for-mechanics).
- **Bin placement as a headline feature** — measured irrelevant; vomit dominates litter.
- **Security guards** — no signal, twice measured.
- **Path Connector** — excluded by request, never reviewed, no test coverage. Deliberate,
  not an oversight.

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
> [performance.md](performance.md#field-measurements-session-3-2026-09-19-37-in-game-days).

> **Field data (2026-09-19, auto-sweep off):** ~30 handymen produced **23 work events in
> 23 days** while the park never once accumulated a single piece of rating-costing
> litter. The formula meanwhile climbed 29 -> 33 as guests grew 793 -> 918. This is no
> longer a hypothesis; the current formula is measurably over-provisioned for this park.
> See [performance.md](performance.md#field-measurements-2026-09-19-23-in-game-days).

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
> [performance.md](performance.md#field-measurements-ops-first-run-2026-09-20-18-in-game-days). · **Basis:** source-verified · **Cost:** unknown

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

## Rejected / deferred

| Item | Reason |
|---|---|
| **Small patrol zones for mechanics (M2)** | Mechanics already do ~100% of the available work; the apparent deficit was an arithmetic error on our side. See [M2](#m2--small-patrol-zones-for-mechanics). |
| Park-sized patrol rectangles | Measured at 440ms for 29 staff. Behaviourally identical to no zone. See [performance.md](performance.md#patrol-areas). |
| Forcing a mechanic inspection from script | Not exposed by the API. Only the interval can be set. |
| Path Connector features | Out of scope for the current round by request. |
| Rain washing away vomit | Not a base-game mechanic; a separate third-party plugin already covers it. |
