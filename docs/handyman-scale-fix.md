# Handyman Staffing — Scale Fix Plan

Status: **All 4 phases done and verified live (2026-09-20).** Live data (`tools/rct-debug.log`)
shows the adaptive handyman controller failing to keep pace as a park scales up:
guests grew 621 → 1978 (3.2x) and path tiles 131 → 224, but adaptive handymen
*dropped* 9 → 8, `fleetUnderworked` fired on ~34% of days, `litterAverage` rose
2 → 6.1, and vomit is now visibly spread around the park. Same discipline as
everything else in this project: diagnose from source + real telemetry, fix the
narrowest thing that's actually wrong, verify against fresh data before calling it
done.

Tick items off as we go.

---

## Phase 1 — Diagnose precisely ✅ done

Goal: name the exact mechanism, cited to `staffing.ts`/`trash-manager.ts` line
numbers, not a guess.

- [x] Pulled the full per-record trend (not just first/last): handymen, guests,
      `fleetUnderworked`, `oldLitter`, `totalLitter`, `staffingFloor`,
      `adaptiveTarget` over the whole session.
- [x] Confirmed against source: `staffingFloor()` (`trash-manager.ts:414-416`,
      pre-fix) is `ceil(pathTiles/150)+2` — sat at exactly **4** for the entire
      guests 724→1955 range, since path tiles grew far slower than guest count.
- [x] Confirmed `oldLitter` (the only signal that can force a hire, via
      `urgent = oldLitter >= 25` in `staffing.ts`) peaked at **17** during the worst
      spike (day 211-241, `litterAverage` hit 23, vomit hit 21) — never crossed 25,
      so the hire path never fired even during visibly bad mess. The existing
      8-9 handymen were working hard enough to keep litter from *ageing* past the
      rating-relevant threshold, which is a different thing from the park *looking*
      clean in real time.

**Root cause:** `staffingFloor()` protects against under-staffing relative to *map
size*; nothing protects against under-staffing relative to *guest count*, which is
the actual driver of litter/vomit generation. The hire trigger is a lagged,
rating-protection signal that this park's headcount was (barely) still satisfying,
so the controller had no way to know the park had outgrown it.

---

## Phase 2 — Design the fix ✅ done

Chosen: **a second, independent guest-count floor term** —
`GUESTS_PER_HANDYMAN_FLOOR = 100`, gentler than the classic formula's
`GUESTS_PER_HANDYMAN = 30` (already measured over-provisioned in this project's own
field data) since this is a floor the adaptive loop cannot ratchet below, not a
target it's steered toward. `staffingFloor()` becomes
`max(ceil(pathTiles/150), ceil(guests/100)) + FREE_ROAMING_BUFFER`.

Rejected for now: a rate-of-change release guard (more complex, and doesn't fix the
hire side of the problem — the park could still be understaffed and stay that way
if it never gets a `fleetUnderworked` release attempt to block); re-calibrating
`URGENT_OLD_LITTER` (would weaken its one clearly-working job, rating protection,
to fix a problem that isn't actually about rating).

**Exit criterion, stated in advance:** handymen count should track guest growth
more closely going forward (no more multi-hundred-guest stretches at a flat
headcount), and `litterAverage`/vomit should visibly stop climbing during growth
spurts. If the loop instead over-hires against this floor with no corresponding
improvement, the divisor is too aggressive and needs loosening.

---

## Phase 3 — Implement and test ✅ done (2026-09-20)

- [x] Added `GUESTS_PER_HANDYMAN_FLOOR = 100` and rewrote `staffingFloor()` in
      `trash-manager.ts` to take the max of the tile-based and guest-based terms
- [x] No new unit test added — `staffingFloor()` lives in the impure plugin file by
      this project's own architecture (decision logic in pure modules, mechanism in
      plugin entry points), and was already outside unit-test coverage before this
      change; verification is via live telemetry (Phase 4), consistent with how
      every other impure-file constant in this project is validated
- [x] `tsc --noEmit` clean, `node tests/run.mjs` 396/396 unaffected, rebuilt and
      deployed

---

## Phase 4 — Verify live ✅ done (2026-09-20)

- [x] The moment the new build loaded (day 380), `staffingFloor` jumped **4 → 22**,
      matching `ceil(1986/100)+2` exactly against that day's guest count
- [x] Handymen climbed 8 → 23 over the following ~6 days, paced by the existing
      3-hires/day cap (working as designed, not a burst)
- [x] `litterAverage` dropped from 6.1 to 2-3 and vomit counts stayed near zero
      through the rest of the observed session; the floor kept tracking guest
      growth live afterward (22 → 23 as guests crossed 2000+)

**Exit criterion: met.** Handymen now track guest growth instead of sitting flat,
and the visible mess cleared up. No over-hiring observed against the new floor -
divisor stays at 100 for now.

---

## Related, not in scope for this doc

- Bin/bench density (`amenities.ts` / `AMENITY_MAX_PLACE`, `COVERAGE_CELL_TILES`) —
  the other reported issue ("need more bins and benches"). Related (both are
  litter/vomit management) but a different mechanism — tackle after this one.
