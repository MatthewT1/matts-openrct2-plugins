# TODO

Current state (2026-09-24): v1.0.0 released, CI green, 396/396 tests passing, typecheck
clean. Nothing below is urgent. The plugins work as they are.

**Priority key:** **P1** = do next · **P2** = worth doing · **P3** = only if the data asks for it

---

## Session plan: what we do together

Work that needs the game is grouped into sessions. Each session starts from the same setup
and ends with a commit, so nothing is ever half-done between sessions.

### Setup (start of every session, ~5 min)

1. **Start the log sink.** Double-click `tools\start-log-sink.cmd` and leave the window open.
2. **Build and deploy.** Ask Claude to build, or run this yourself:
   `node ./node_modules/rollup/dist/bin/rollup --config rollup.config.js`
   This copies fresh plugins straight into `Documents\OpenRCT2\plugin\`.
3. **Load the park.** Start OpenRCT2 and load the park. If the game was already open, go
   back to the title screen and reload the park, because plugins only load with a park.
4. **Turn on Diagnostics.** Open any plugin window from the map menu and tick
   **Diagnostics** (one tick turns it on for all plugins).
5. **Play and report.** Play at normal or fast speed for the number of in-game days the
   session asks for, then tell Claude "data's in". Claude reads `tools/rct-debug.log`.
   You don't need to paste anything.

Use the same park each time where you can (Thunder Rock is the usual one), so before and
after numbers are comparable.

### Session 1: baseline, screenshots, versions (P1, ~1 hour)

The goal is to record how v1.0.0 behaves before any code changes, take the pictures for
GitHub, and ship v1.1.0 with tidy version numbers.

1. **Baseline run.** Follow the setup, then play **20 in-game days** without changing any
   toggles. Claude saves a summary of the numbers (staff counts, litter, breakdowns, queue
   lengths, timings) as the baseline that later sessions are compared against.
2. **Screenshots while playing.** See [Screenshots](#screenshots-p1) for the list.
3. **Version numbers** *(Claude, ~10 min)*. The plugins currently report 0.1, 1.0 and 3.0.
   Claude makes the build stamp every plugin with the version from `package.json`.
4. **Check it in-game:**
   - Reload the park. All six plugins still appear in the map menu and their windows open.
   - The OpenRCT2 console (press the `~` key) shows no errors on load.
   - Each plugin reports the new version. In-game this is under **Options → Plugin**, or
     Claude can check the log.
5. **Release.** Claude commits, tags `v1.1.0` and pushes. GitHub builds and publishes it.

**Done when:** baseline saved, screenshots in the repo, v1.1.0 on the Releases page.

### Session 2: code cleanup (P2, ~1–2 hours)

The goal is to make the code easier to change, with **no change in behaviour**. That's
why the baseline from session 1 matters: the numbers afterwards should match it.

1. *(Claude)* Move the repeated staff hire/fire code into one shared helper (it's
   currently copied into trash, mechanic and staff-extras).
2. *(Claude)* Split `trash-manager.ts` (2,256 lines) into smaller files by job: window,
   map scan, staffing, benches/bins, facilities.
3. *(Claude)* Tests, typecheck and a build must all pass before you're asked to load the game.
4. **Test run.** Follow the setup, then play **20 in-game days** on the same park with the
   same toggles as the baseline.
5. **What to look for while playing:**
   - Every plugin window opens and its numbers update.
   - Handymen and mechanics are still hired and fired. Watch the staff count move.
   - No "Can't hire" or "Invalid parameter" pop-ups, and no errors in the `~` console.
   - The game doesn't stutter any more than before.
6. **Claude compares against the baseline.** It passes if the timings are no worse, the
   staff counts and litter levels are in the same range, and no counter that used to move
   is now stuck at zero. A counter stuck at zero is how silent failures showed up before.
7. If anything is off, Claude fixes it and you repeat step 4. If it's all fine: commit and
   release v1.2.0.

**Done when:** the numbers match the baseline and v1.2.0 is released.

### Session 3: open questions (P3, optional)

These just need data that Claude reads, plus a decision from you:

- **Facility placement quality.** Is `siteRejectQueuePath` climbing while nothing gets
  built? If so, guests standing in queues are being counted as demand, and should be
  excluded.
- **Queue attribution.** Before and after numbers have been recorded for every wait-time
  and ride-operation change, but never analysed. This answers whether those changes
  actually shorten queues.
- **Sickness.** If `needs.verySick` starts rising, turn on first-aid auto-build.
- **Security guards.** `brokenBins` has been 0 in every run ever recorded. Leave it closed
  unless that changes.
- **Pricing.** This is the biggest guest complaint, and would be a new plugin of its own.
  Decide whether you want one.

---

## Screenshots (P1)

These go in `docs/images/` and appear in the README. Claude adds them once you've taken them.

**How to take them:** use `Win + Shift + S` (Windows snipping) to grab a single window.
OpenRCT2's own screenshot key saves the whole screen to `Documents\OpenRCT2\screenshot\`,
which is good for park shots. PNG is fine.

- [ ] Each plugin's window, open on a busy park (6 shots): ~~Trash, Mechanic, Wait Time,
      Staff Extras, Marketing~~ (done), Path Connector still needed
- [ ] A park view with plugin-placed benches near a coaster exit
- [ ] A plugin-built toilet or food stall in a spot that clearly needed one
- [ ] Path Connector in use: the planned path preview before building
- [ ] **Social preview image** (the picture shown when the repo link is shared on Discord,
      Reddit and similar). Use a wide park shot, ideally around 1280×640. Upload it on
      GitHub under **Settings → General → Social preview**. Only you can do this step, and
      it works from your phone.

---

## Code backlog

| Priority | Item | Needs the game? |
|---|---|---|
| P1 | Stamp one version number on all plugins from `package.json` | Quick load check (session 1) |
| P2 | Shared staff hire/fire helper, so the "entity budget" handling lives in one place | Yes (session 2) |
| P2 | Split `trash-manager.ts` into smaller files | Yes (session 2) |
| P2 | Share the other repeated patterns across the plugins: the tick handler (4 plugins) and the settings code (5 plugins) | Yes (session 2) |
| P3 | Path Connector: add tests, or label it experimental in the README. It was never reviewed and has no tests. | Only if changed |
| P3 | The Diagnostics checkbox in other open plugin windows doesn't refresh when one is ticked | Yes, small |
| P3 | Type the one `any` in `entertainer-targeting.ts` | No |

## No game needed (Claude can do these any time)

- [ ] Add a "getting the game source" note to NOTES.md so the API reference line numbers
      stay valid: clone OpenRCT2 into `gamesrc/OpenRCT2` and check out `6fb525e906`.
- [ ] Delete `archive/` (the first git commit already holds it) and the stale local `dist/`.
- [ ] Fix npm on this PC by updating nvm-windows. Then `npm run build:dev` and friends
      work directly, and setup step 2 gets simpler.

---

## Done

- [x] Git history, GitHub repo, CI, tag-triggered releases, v1.0.0 (2026-09-24)
- [x] README, LICENSE (MIT), topics and description for discoverability
- [x] Author set to `MattT`
- [x] Split `performance.md` (1,609 → 343 lines) and `roadmap.md` (1,221 → 187). The
      rest was moved word for word to `docs/design-records.md` and `docs/archive/`. The
      earlier state is saved under the git tag `backup/pre-docs-restructure`.
- [x] Removed the duplicated, contradictory closing note in the roadmap
- [x] Secret scan of the full history: clean
