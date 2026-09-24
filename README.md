# OpenRCT2 Park Management Plugins

A suite of six [OpenRCT2](https://openrct2.io/) plugins that take over the repetitive parts
of running a park: staffing, cleanliness, ride tuning, facility placement, entertainers
and marketing.

| Plugin | What it does |
|---|---|
| **Trash Manager** | Adaptive handyman staffing, vomit-to-ride attribution, automatic benches/bins, guest-need tracking and optional automatic toilets / first aid / stalls |
| **Mechanic Manager** | Adaptive mechanic staffing, keeps inspection intervals from silently resetting, optional emergency repair for unreachable rides |
| **Wait Time Optimizer** | Recommends and applies min/max wait times, flags capacity-bound rides, pre-emptive override for queues heading past the walk-out point, optional ride operation tuning |
| **Staff Extras** | Hires and positions entertainers at queues close to the walk-out point |
| **Marketing Manager** | Ranks campaigns by value per guest for your park and can run them automatically |
| **Path Connector** | Manual tool: draws a footpath between two picked tiles, routing around obstacles |

Anything that spends money is **off by default**. The plugins never demolish anything, and
automatic removal only ever touches items the plugin placed itself.

See the **[User Guide](docs/user-guide.md)** for every toggle, its default, and how to tell
it's working.

## Install

1. Download the `.js` files from the [latest release](../../releases/latest).
2. Copy them into your OpenRCT2 `plugin` folder:
   - Windows: `Documents\OpenRCT2\plugin\`
   - macOS: `~/Library/Application Support/OpenRCT2/plugin/`
   - Linux: `~/.config/OpenRCT2/plugin/`
3. Load a park. Each plugin adds an entry to the map menu.

Requires an OpenRCT2 build with plugin API version 87 or newer.

## Build from source

```bash
npm install
npm run build:dev     # compile and deploy straight into your OpenRCT2 plugin folder
npm run build         # production build into ./dist
npm test              # unit tests over the pure decision modules
npm run typecheck
```

Decision logic lives in pure modules under `src/` that don't touch any game globals, so
it's unit tested under plain node. The plugin entry points (`trash-manager.ts`,
`mechanic-manager.ts`, and so on) wire that logic to the game and are verified in-game
through an opt-in telemetry channel (`tools/log-sink.mjs`).

Developer docs: [NOTES.md](NOTES.md) (start here), [API reference](docs/api-reference.md),
[performance](docs/performance.md), [roadmap](docs/roadmap.md),
[project history](docs/HISTORY.md).

## License

[MIT](LICENSE)
