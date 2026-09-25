# Headless test harness

Runs a copy of a save with our plugins **on** and again with them **off**, fast-forwarded
with no game window, and records the park every in-game day. Built for #46.

```bash
node tools/headless/run.mjs --save "<OpenRCT2 user dir>/save/YourPark.park" --days 60 --settings all
```

**Check the settings before reading the results.** Without `--settings`, the on arm uses
whatever toggles the save had stored, or the code defaults if the save never ran the
plugins. Since #51, auto sweep, auto benches and bins, amenity removal, auto shops,
entertainers and emergency repair default **on**; marketing and operation tuning default
**off**, so a defaults run doesn't test them. `summary.md` lists every toggle for the run.

At speed 4 (the default) 60 days take about 105 s per arm, plus a few seconds of start-up.
Output goes to `harness-runs/<time>-<save>/` (gitignored):

| File | What's in it |
|---|---|
| `summary.md` | Start/end/change per arm, the on − off difference, the on arm's plugin settings, and grouped `ERROR` lines from each game log |
| `summary.json` | The same numbers and settings, plus which plugin files were used and when they were last built |
| `<arm>/days.csv` | One row per in-game day: rating, guests, happiness, cash, loan, park and company value, admissions, staff by type, litter, open rides |
| `<arm>/game.log` | The game's console output for that arm |
| `<arm>/userdata/` | The throwaway user-data folder the arm ran in |

Money in `summary.md` is in currency units. The CSV and JSON keep the game's raw units
(tenths of a currency unit).

## Options

| Option | Default | |
|---|---|---|
| `--save <file>` | required | The save to copy. The original is only read. |
| `--days <n>` | 60 | In-game days to run after the start snapshot. |
| `--speed <1-4>` | 4 | Game speed. 1 is normal and 4 (hyper) is 8× normal. The game refuses 0. |
| `--settings <preset or file>` | `save` | The on arm's plugin toggles. `save` leaves them as stored, `defaults` writes the code defaults, and `all` turns every toggle on. A JSON file such as `{"Trash Manager": {"autoAmenities": true}}` sets only the toggles it names. |
| `--arms on,off` | both | Run just one arm with `--arms on` or `--arms off`. |
| `--plugins a,b` | our six | Plugin file names for the on arm. Add third-party ones here if you want them included. |
| `--plugin-dir <dir>` | `Documents/OpenRCT2/plugin` | Where the on arm's plugins are copied from, i.e. the last dev build. |
| `--config <file>` | `Documents/OpenRCT2/config.ini` | Copied into each arm, with `pause_server_if_no_clients` and hot reloading forced off. |
| `--game <exe>` | `C:/Program Files/OpenRCT2/openrct2.com` | |
| `--out <dir>` | `harness-runs/<time>-<save>` | |
| `--game-port`, `--agent-port` | 11800, 47820 | Both bound to 127.0.0.1. |
| `--perturb <n>` | 0 | Draw the scenario RNG n times at the first day tick (#63), giving a replicate of an otherwise deterministic run. |
| `--min-open-rides <n>` | 0 | Exit with code 3 and no output when the park has fewer open rides at load. |

Each day row also records (#63): ride reliability/downtime (mean of open rides), rides broken
now, breakdowns that day, vomit, a tally of selected guest thoughts (`th*`, plus negative and
positive totals), and money totals since day 1 (`*Cum`: income, expenses, entrance, ride
tickets, sales, stock, wages, running costs, build, marketing; costs negative).

## Viability study (#63)

```
node tools/headless/viability.mjs run --parks 5 --post
node tools/headless/viability.mjs rollup --post
```

Walks a seeded shuffle of saves + user scenarios + RCT2 and RCT1 scenarios, skips parks
with fewer than 5 open rides, and runs 4 arms per park (off/on × perturb 0/1, 60 days,
`--settings all`, ~8 min). Per metric, effect = mean(on) − mean(off) and noise = the larger
same-arm spread; an effect within the noise is reported as noise. Resumable: finished and
skipped parks are kept in `harness-runs/viability-seed63/state.json`.

## How it works

1. For each arm, `run.mjs` makes a user-data folder: a copied `config.ini`, a copy of the
   save, the on arm's plugins, and the harness agent. The folder's `plugin/` contents decide
   what runs, and the real `Documents/OpenRCT2` is never written to.
2. It starts `openrct2.com host <save copy> --headless --user-data-path <folder>`.
3. `tools/headless/harness-agent.js` is a dev-only plugin that listens on 127.0.0.1. It
   takes a fixed set of JSON commands, with no way to run arbitrary code. On the on arm,
   `settings` writes the `--settings` booleans into each plugin's park storage and reads
   every toggle back. The toggle list is `tools/headless/settings.mjs`, and a test checks
   it against the `boolSetting` calls in `src/`. `start` unpauses
   the game, sets the speed, and sends a snapshot at the start and after every
   `interval.day`. It pauses the game again when the days are done.
4. The runner writes the CSV, stops the game, and moves to the next arm. Summary maths is
   in `tools/headless/summary.mjs` (pure, tested in `tests/headless-summary.test.mjs`).

## Things to know

- **Runs are deterministic.** With the same save and plugins, two 60-day runs of Thunder
  Rock gave byte-identical CSVs, for both the off arm and the on arm (2026-09-25). A
  single run per arm reproduces exactly. That does **not** make an on − off difference a
  real effect: one extra RNG draw (`--perturb 1`) changes a 5-day Dynamite Dunes run
  (litter 3 vs 1, cash 7659 vs 7613), so compare against perturbed replicates (#63).
- **Some plugin cooldowns use real time, not game time.** `Date.now()` rate-limits the
  Staff Extras entertainer cache, Trash Manager guest-need sampling, facility build
  timeout, and tile scan. At 8× these run less often per in-game day than they do at
  normal speed. So the harness measures the plugins as they behave on fast-forward. That
  also makes determinism depend on those cooldowns falling on the same days, which they
  did in the runs above.
- **The save's own state carries over.** If the save was paused, the agent unpauses it.
  Plugin settings live in the save's park storage, so with `--settings save` each toggle
  is whatever it was when the save was made. Use `all` or a file to compare saves on the
  same footing.
- **Third-party plugins are left out by default.** Price Manager, Award Eligibility and
  others change cash and rating. Add them to `--plugins` to include them, but note that
  the off arm then only drops ours if you also run an arm with just those.

## Why not the other routes

- **stdin REPL:** `openrct2.com` evaluates JavaScript typed at its console, but
  `StdInOutConsole::Start` returns unless stdin *and* stdout are TTYs
  (`StdInOutConsole.cpp:29`). A script's pipes are not.
- **`openrct2.com simulate <park> <ticks>`:** runs the game logic headless but never
  starts plugins. It only calls `gameStateUpdateLogic()`, and plugins are started from
  `ScriptEngine::Tick`.
- **`context.paused = false` from a socket callback** throws "Game state is not mutable
  in this context". The `pausetoggle` action works.
