# Roadmap — Proposed Improvements

Each item is tagged with its basis (**source** = verified in OpenRCT2 C++;
**research** = community consensus, see [research.md](research.md); **measured** = from
the debug log) and a cost estimate against the
[cost budget](performance.md#cost-budget).

Status: `proposed` · `in progress` · `done` · `rejected`

---

## Contents

- [Priority order](#priority-order)
- [Rejected / deferred](#rejected--deferred)

Per-feature design records (T0, S, A–E, MS, M1–M4, W1–W3, NEEDS, OPS): [design-records.md](design-records.md).
Build-out work log: [archive/roadmap-worklog.md](archive/roadmap-worklog.md).

---

## Priority order

Rebuilt 2026-09-20 from the actual statuses below.

### Done

| | Item | Notes |
|---|---|---|
| T0 | [Park-context telemetry](design-records.md#t0--park-context-telemetry) | unblocked everything else |
| A | [Litter hotspot map](design-records.md#a--litter-hotspot-map) | |
| B | [Stuck / idle staff detection](design-records.md#b--stuck--idle-staff-detection) | rewritten twice after false positives |
| S | [Closed-loop staffing](design-records.md#s--closed-loop-staffing) | rewritten after overshoot, then a deadlock |
| D/V | [Vomit attribution + bench advisor](design-records.md#dv--vomit-attribution-and-bench-advisor) | targets 99.7% of real litter |
| AM | [Automatic bench and bin management](design-records.md#am--automatic-bench-and-bin-management) | replaces `benchwarmer` |
| W1 | [15-minute walk-out cliff](design-records.md#w1--surface-the-15-minute-walk-out-cliff) | |
| W3 | [Capacity-bound ride detection](design-records.md#w3--capacity-bound-ride-detection) | |
| M4 | [Inspection-interval rationale](design-records.md#m4--correct-the-inspection-interval-rationale) | comment + tooltip were factually wrong |
| NEEDS ph.1 | [Guest-need instrumentation](design-records.md#needs--guest-need-clustering-then-automatic-facility-placement) | measured flat at first; **fired once the park passed ~900 guests** |

### Closed without building

| | Item | Why |
|---|---|---|
| M2 | [Mechanic patrol zones](design-records.md#m2--small-patrol-zones-for-mechanics) | **Rejected** — expected workload was never computed; mechanics do ~100% of available work |
| M1 | [Weight mechanics by downtime](design-records.md#m1--weight-staffing-by-breakdown-risk) | Superseded by MS |
| C | [Bin placement advisor](design-records.md#c--bin-placement-advisor) | Superseded by AM; measured irrelevant (3 of 851 litter was trash) |
| SHOP | Shop placement advisor | Folded into NEEDS |

### Done in the 2026-09-20 build-out (second pass)

| | Item | Shape |
|---|---|---|
| NEEDS ph.2-3 | [Automatic facility placement](design-records.md#needs--guest-need-clustering-then-automatic-facility-placement) | `facilities.ts`; hysteretic, capped, never demolishes. **Unblocked by data** — see below |
| M3 | [Emergency repair](design-records.md#m3--emergency-repair) | Opt-in, labelled a cheat, 3-day threshold |
| W2 | [Pre-emptive queue override](design-records.md#w2--more-aggressive-emergency-override) | `queues.ts`; trend-based, not a lower threshold |

### Done in the 2026-09-20 build-out (first pass)

| | Item | Shape |
|---|---|---|
| MS | [Adaptive mechanic staffing](design-records.md#ms--adaptive-mechanic-staffing) | Reuses `staffing.ts`; mechanic signals mapped onto it, floor of 2 |
| — | [Cost reporting](design-records.md#cost-reporting) | Wage savings shown in both staffing windows and logged |
| E | [Guest-thought early warning](design-records.md#e--guest-thought-early-warning) | `thoughts.ts`, 125 thought types categorised, piggybacks the existing guest sample |
| OPS | [Per-ride operation settings](design-records.md#ops--per-ride-type-operation-settings) | `ops.ts`; probes the unreadable range with silent queries, hysteretic, off by default |

### Ideas noted, not yet scoped

**SEC/ENT — Security guards and entertainers.** The two staff types this project has never
touched. Natural fit for the existing machinery:

- `staffhire` types are already known: **2 = security, 3 = entertainer**; security wages
  are **£60/month** (`Staff.cpp:2645`).
- `Security` and `Entertainer` are distinct entity types in the API, and the per-staff
  productivity-counter pattern used for handymen and mechanics should extend to them.
- **Security** has a measurable demand signal already being collected: the `vandalism`
  thought category, plus `isAdditionBroken` on footpaths, which the trash tile scan
  already counts as `brokenBins`. Measured so far: **at most one broken bin** (Session 5,
  see the watch list below) — so as with NEEDS, check whether the park has this problem
  before building for it.
- **Entertainers** are harder. Their benefit is slowing guest happiness decay in queues,
  and the project has established that OpenRCT2 guests leave at 15 minutes **regardless**
  of entertainers ([#5753](https://github.com/OpenRCT2/OpenRCT2/issues/5753)), so the
  value is narrower than vanilla guides suggest. **Verify the actual mechanic in
  `gamesrc/` before designing anything** — this is exactly the shape of assumption that
  sank M2.

Same discipline as everywhere else here: instrument first, confirm a problem exists, then
build.

> **Still measuring (near) zero (checked again 2026-09-24).** `brokenBins` was 0 in every
> record through 2026-09-20; since then one 2,503-guest run held a single broken bin for
> 116 records (Session 5, [#16](https://github.com/MatthewT1/matts-openrct2-plugins/issues/16)). And `vandalism` has never once appeared in the top four
> thought categories. On the evidence available, this park does not have a security
> problem, and building a security controller would be building for an assumed problem —
> the exact mistake [M2](design-records.md#m2--small-patrol-zones-for-mechanics) cost a session to.
> The signal is already instrumented, so this becomes checkable the moment it changes.

### Still open

**Every named item from the original roadmap is done, rejected, or superseded.** What
remains is not a backlog of features — it is four pieces of finishing work, scoped below
as [parallel work packages](archive/roadmap-worklog.md#remaining-work-packages).

Out of scope by request: **Path Connector** (never reviewed this round, no test coverage,
839 lines — noted so a future session knows it was excluded deliberately, not missed) and
**pricing** (see below).

---

### Project status: feature-complete

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
> See [performance.md](archive/performance-field-log.md#it-works-end-to-end-validation-2026-09-20-final).




**Every item on this roadmap is done, rejected with reasons recorded, or closed on
measurement.** Nothing is outstanding.

| Area | State |
|---|---|
| Trash Manager | Litter, adaptive staffing, vomit advisor, benches/bins, guest needs, facility building |
| Wait Time Optimizer | Wait times, capacity-bound detection, walk-out warning, pre-emptive override, operation tuning |
| Mechanic Manager | Adaptive staffing, inspections, emergency repair |
| Staff Extras | Entertainers (security closed on measured zero demand) |
| Marketing Manager | Campaign ranking, auto-run |
| Shared | 6 plugins, 12 pure modules, **396 tests**, telemetry throughout |

Validated in the field this session: the entertainer costume fix (4 hired), the
sample-rotation fix (19 sweeps published), the OPS direction fix (`opsSetRejected`
30 -> 2), and the 206ms lag fix (0-1ms).

### If you pick this up again

Nothing here is required. In rough order of value:

1. **Facility placement quality.** Answered in Session 5
   ([#14](https://github.com/MatthewT1/matts-openrct2-plugins/issues/14)): queue tiles were
   0.3-4.4% of rejected sites across 4 park loads, every search still accepted sites, and
   14 facilities were built. Queueing guests are still sampled as demand
   (`src/builder/facilities.ts`), which is harmless on that evidence. Reopen only if a gap
   confirms (8 sweeps), then builds nothing while `siteRejectQueuePath` is the top reason.

2. **The queue attribution question.** `queueAttribution` rows record per-ride
   before/after for every W2 and OPS intervention. First read in Session 5
   ([#15](https://github.com/MatthewT1/matts-openrct2-plugins/issues/15)): OPS median 0,
   W2 queues longer afterwards in 35 of 44, but confounded (W2 fires on rising queues,
   guest counts always changing, no control group). Methodology under discussion there.

**Telemetry watch list** (moved from
[#16](https://github.com/MatthewT1/matts-openrct2-plugins/issues/16); no action unless a
trigger fires):

3. **Sickness.** Trigger: `needs.verySick` trending *up* within a run, not just rising with
   guest count. Then enable first-aid auto-build. Guests only seek first aid at nausea 200,
   so `needs.sick` is not the trigger. Last checked Session 5: peak 1.3% of sampled guests
   (7 of 529), no trend in any of 5 runs.
4. **Security.** Trigger: `brokenBins` above 1, or broken bins recurring across runs. Then
   reconsider security guards. Last checked Session 5: 0 in 1,410 of 1,526 records; one
   2,503-guest run held exactly 1 broken bin for 116 records. One vandalised bin does not
   pay for guard wages.
5. **Pricing.** Consistently the largest guest complaint and deliberately out of scope —
   a separate price-manager plugin is the right home.

### Things not to redo

- **Mechanic patrol zones** — mechanics already do ~100% of available work. The arithmetic
  is in [M2](design-records.md#m2--small-patrol-zones-for-mechanics).
- **Bin placement as a headline feature** — measured irrelevant; vomit dominates litter.
- **Security guards** — no signal, twice measured.
- **Path Connector** — excluded by request, never reviewed, no test coverage. Deliberate,
  not an oversight.

---

## Rejected / deferred

| Item | Reason |
|---|---|
| **Small patrol zones for mechanics (M2)** | Mechanics already do ~100% of the available work; the apparent deficit was an arithmetic error on our side. See [M2](design-records.md#m2--small-patrol-zones-for-mechanics). |
| Park-sized patrol rectangles | Measured at 440ms for 29 staff. Behaviourally identical to no zone. See [performance.md](performance.md#patrol-areas). |
| Forcing a mechanic inspection from script | Not exposed by the API. Only the interval can be set. |
| Path Connector features | Out of scope for the current round by request. |
| Rain washing away vomit | Not a base-game mechanic; a separate third-party plugin already covers it. |
