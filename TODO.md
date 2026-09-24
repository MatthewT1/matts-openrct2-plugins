# TODO

Backlog from the 2026-09-24 review. Baseline at review time: typecheck clean,
**396/396 tests passing**, all six plugins build. Ordered by value, not effort.

## Before / right after the first push

- [ ] Create the GitHub repo and push (see "Publishing" below). Check the first CI run
      passes on Linux (`npm ci` + typecheck + tests + prod build). CI hasn't run yet.
- [ ] Decide on `authors` in each `registerPlugin` (currently `"Matt"`) and the LICENSE
      holder (`Matt T`). Change both if you want your GitHub handle instead.
- [ ] Unify plugin versions. They're currently 0.1 / 1.0 / 3.0 across plugins. Either
      one suite version injected from `package.json` at build time (rollup
      `@rollup/plugin-replace`), or per-plugin semver. Then tag `v1.0.0` and attach
      `dist/*.js` to a GitHub Release (a tag-triggered release workflow would automate it).
- [ ] Delete the local `dist/`. It's stale (4 plugins, 2026-09-19) and gitignored.

## Code

- [ ] **Split `src/trash-manager.ts`** (2,256 lines, 114 KB, ~40% of all source). Most
      bugs in the history landed here. Suggested seams: window/UI, tile scan + litter
      stats, staffing wiring, amenities wiring, needs/facilities wiring. The pure modules
      already exist, so this is only about separating the glue.
- [ ] **Extract shared glue into `src/lib/`.** The same patterns are repeated across the
      entry points: the pending-flag `interval.tick` dispatcher (4 plugins), `getParkStorage`
      config getters (5), and staff hire/fire with entity-budget handling (`staffhire` in
      trash, mechanic and staff-extras). One shared hire helper means the
      "entity budget / pass a real callback" lesson only lives in one place.
- [ ] **Path Connector** (839 lines, no tests, never reviewed; excluded on purpose).
      Either pull its route planner into a pure module with tests like the others, or
      label it experimental in the README and user guide.
- [ ] Diagnostics toggle: every plugin's checkbox writes one shared key
      (`openrct2-plugins.debug`), so ticking it in one window turns it on everywhere, but
      other open windows won't refresh their checkbox. Either document that or sync them.
- [ ] `entertainer-targeting.ts` has the only `any`. Type it.

## Docs (also cuts per-session token use)

- [ ] **Split `docs/performance.md` (1,609 lines) and `docs/roadmap.md` (1,221 lines)**
      into a short current-state reference and an archived narrative. Most of their length
      is session logs, and they get re-read at the start of sessions. That's the single
      biggest token saving available.
- [ ] `docs/roadmap.md`, "Project status: feature-complete": the closing note is
      duplicated with conflicting numbers ("six rounds" / 24% vs "seven rounds" / 28%).
      The status table also still says 5 plugins / 337 tests (now 6 / 396).
- [ ] `gamesrc/` is gitignored now. Add a setup note to NOTES.md so `api-reference.md`
      line citations stay valid: `git clone https://github.com/OpenRCT2/OpenRCT2 gamesrc/OpenRCT2`
      then `git checkout 6fb525e906` (the revision the citations were taken against,
      2026-09-18).
- [ ] `archive/` duplicates the first git commit. Delete it once you're happy with the history.

## Open empirical questions (from roadmap § "If you pick this up again")

- [ ] Facility placement quality: watch `siteRejectQueuePath`. If it climbs, stop
      sampling queueing guests into need clusters.
- [ ] Read the `queueAttribution` rows (W2/OPS before/after). They've been collected but never analysed.
- [ ] Sickness: if `needs.verySick` rises, consider enabling first-aid auto-build.
- [ ] Security: `brokenBins` is still 0. Leave it closed unless that changes.
- [ ] Pricing: the biggest guest complaint. Would be a separate price-manager plugin.

## Environment

- [ ] Fix npm (update nvm-windows; v1.1.7 is missing `@npmcli/config`). The `npm run`
      scripts in package.json already exist, and README/CI use them.

## Publishing

```bash
gh repo create openrct2-plugins --public --source . --remote origin --push
```
