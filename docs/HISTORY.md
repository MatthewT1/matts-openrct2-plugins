# Project History

Reconstructed on 2026-09-24 from the Claude Code session transcripts. Much of the work was
done through scripted edits and subagents, so exact intermediate file states can't be
recovered. The git history therefore has two backdated anchor commits (the original JS,
then the TypeScript suite at the end of session 3) and this file carries the detail.
Times are local (EDT).

## Session 1: 2026-09-18 18:31 to 2026-09-19 19:36

Built the original four plugins in plain JavaScript.

- **Trash Manager**: litter monitoring, bins, handyman hiring. Fixed initialising at
  park load (vomit counts showed 0) and a handyman cap that had no effect. Tried
  handyman patrol zones over several rounds.
- **Path Connector**: point-to-point paths, then routing around rides and obstacles.
- **Mechanic Manager**: mechanic hiring, inspection intervals, patrol zones (tuned for
  coverage).
- **Wait Time Optimizer**: wait-time recommendations. Mazes excluded, extra trains and
  then cars-per-train for rides over threshold, "wait for full load" checks.
- Analysed a real save (`Thunder Rock.park`) to check plugin behaviour against data.
- Reviewed ideas from the `benchwarmer` plugin and another community plugin.
- **TypeScript port** with a rollup multi-entry build that deploys straight to the plugin
  folder. Upgraded Node; JS originals moved to `archive/` (~17:55, 2026-09-19).
- Handyman estimate found inflated by path count. Investigated a lag spike every ~4 seconds.

## Session 2: 2026-09-19 19:38 to 2026-09-20 14:37

Research-driven rebuild, validated against live telemetry.

- Reorganised notes into `NOTES.md` + `docs/`. Community research digest.
- Fixed "invalid parameter, staff not found".
- **Telemetry channel** (`debug.ts` + `tools/log-sink.mjs`). Decisions from then on
  were made from logged data.
- Pure, unit-tested decision modules: staffing controller, hotspots, staff activity,
  vomit attribution, amenities, needs, thoughts, ops, facilities, queues.
- Adaptive closed-loop handyman staffing. Vomit advisor. Automatic benches and bins
  (fixed "can't build on sloped footpath").
- Guest-need sampling and **automatic facility building**, which took seven rounds of
  fixes before it worked end to end: sample rotation, cash floor, slope and height
  filters, phantom off-map cluster, threshold dead zone, cluster jitter, queue-line adjacency.
- Ride operation tuning (OPS), pre-emptive wait-time override (W2), per-ride queue attribution.
- **Staff Extras** (entertainers). Fixed costume validation, and it only fires staff it hired itself.
- Mechanic adaptive staffing with its own thresholds, floor decay, paced urgent hiring,
  emergency repair. Handling for hire failures when the entity budget is exhausted.
- Lag fix: hoisting `ride.stations` getter out of loops (206ms to 1ms per day).
- Path Connector declared out of scope from here on.

## Session 3: 2026-09-20 16:46 to 2026-09-21 08:34

- Full documentation and code review. Scale/regime audit (`docs/scale-audit.md`).
- "Don't build next to sloped paths" option for the placer.
- **Marketing Manager**: researched campaign mechanics, then built in phases 1 to 6 up to
  auto-run, verified live with the player (`docs/marketing-*.md`).
- More bench/bin coverage (blanket 6x6-cell coverage across the path network).
- **Handyman scale fix**: controller under-hired as the park grew (`docs/handyman-scale-fix.md`).
- User guide rewritten with a suite overview.

## Session 4: 2026-09-22

Token-usage review of the earlier sessions. Added the global session-hygiene guidance.
No code changes.

## Session 5: 2026-09-24

Repository prep for GitHub: git history reconstructed, README, LICENSE, CI, `.gitignore`
(excludes the ~400 MB `gamesrc/` clone and debug logs), `TODO.md` backlog.
