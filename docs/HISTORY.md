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

## On GitHub: v1.0.0 to v1.4.0 (2026-09-24 to 2026-09-25)

From here the work is in pull requests and issues on
[GitHub](https://github.com/MatthewT1/matts-openrct2-plugins). Session notes are local only.
This entry covers the main points.

- **v1.0.0 and v1.1.0**: first releases. Plugin versions are stamped from `package.json` (#1),
  a PR template and a release approval gate were added (#2), and the backlog moved from
  `TODO.md` to GitHub Issues (#18).
- **v1.2.0**: refactor with no behaviour change, tested in-game against a baseline. Shared
  staff hire/fire helper (#19), `trash-manager.ts` split into `src/trash/` (#20), shared tick
  and settings code (#21), and a breakdown repair trace (Diagnostics only, #23).
- **v1.3.0**:
  - **Breakdown repairs (#22)**: traces (#23, #26, #27, #29) showed that a slow repair is
    mostly fixed game cost (the answer-call pause and the fix itself). Mechanics walk
    near-straight routes. No behaviour change; recorded as design record M5.
  - **Window text (#24, #10)**: text that was cut off now fits, and the Diagnostics checkbox
    stays in sync across open windows (#28).
  - **Currency (#31)**: money is shown in the player's currency, not a hardcoded £ (#33).
  - **Queue measurement (#15, #14, #16)**: throughput is logged per intervention (#35). W2 and
    OPS were measured, then stopped and recorded (#39). Facility demand and the telemetry
    watch list needed no change (#34).
  - **Mechanic release (#32)**: the "fleet underworked" signal was only ever true just after a
    park load. It was measured in shadow (#36), then replaced by a 14-day activity window that
    releases the longest-idle mechanic first (#40). An overstaff test with 2 extra mechanics
    released 1 in 80 days and kept every safety criterion. Accepted as slow and safe (M6).
- **v1.4.0**:
  - **Headless test harness (#46, #49, #63, #72)**: runs parks with no window, the plugins on
    vs off, with RNG-perturbed replicates and an effect-vs-noise rule. Every gameplay change
    below was A/B tested with it, with the pass rule posted on the issue first.
  - **New defaults (#51)**: trash sweep, amenities, amenity removal, facilities, entertainers
    and emergency repair are on by default (#76). Happiness was not worse in any of 5 parks,
    and litter and vomit were better in 4. In game, Factory Capers was completed quickly.
  - **Marketing (#74)**: campaign costs were compared in pounds against tenths, so the budget
    and reserve checks were 10x too loose. Auto campaigns now run one at a time, behind a
    happiness/crowding gate (#78). Still off by default.
  - **Fixes**: no build cash floors or marketing in no-money parks (#44); cooldowns use game
    time (#48); ride-setting probes no longer spam the log (#50); live entertainer count
    (#54); no bench add/remove churn (#56).
  - **Tried and rejected**: ride operation tuning changes (#67). Two attempts both cost
    happiness; tuning stays off by default.
  - **Docs**: walk-out rule (#70), doc drift (#71), Path Connector marked experimental (#9),
    README screenshot (#4).
