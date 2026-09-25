# User Guide — OpenRCT2 Management Plugins

This is a suite of six plugins that take over the repetitive parts of running a park — staffing, cleanliness, ride tuning, facility placement, entertainers, and marketing — so you can spend your time designing rides and the park itself instead of babysitting numbers. Every plugin is independent (use one, use all six, doesn't matter) and every toggle can be switched off. The cleanliness, entertainer and stuck-ride features are on by default, because a 10-park test showed they make parks cleaner at a small cost ([#51](https://github.com/MatthewT1/matts-openrct2-plugins/issues/51)). Marketing and ride operation tuning stay off until you opt in. None of it does anything you couldn't do yourself by hand — it just does it continuously, from measured park data, instead of you having to notice and act on it.

**Trash Manager** — Keeps the park clean and comfortable. Adjusts handyman headcount to match how dirty the park actually is, places benches and bins where they're measurably needed (benches specifically stop guests from vomiting in the first place), and can build toilets, food stalls and first-aid rooms where guests keep going without.

**Mechanic Manager** — Keeps rides running. Adjusts mechanic headcount to match real breakdowns, keeps inspection intervals from silently resetting, and clears patrol zones so mechanics can reach any ride. A separate cheat toggle exists for the rare ride no mechanic can physically path to.

**Wait Time Optimizer** — Keeps queues from spiraling. Recommends and applies ride wait-time settings, flags rides that are capacity-bound (need more trains, not tuning) versus genuinely mistuned, and steps in before a queue crosses the point where guests start walking away.

**Staff Extras** — Entertainers. Positions them at queues that are close to that same walk-out point, since an entertainer measurably buys guests more patience. (Guests only walk out after ~15 minutes **and** when their happiness is low, 65 of 255 or less; an entertainer both resets the queue timer by 200 and raises happiness.)

**Marketing Manager** — Advertising and voucher campaigns. Ranks every campaign type by actual value for your park's current pricing (some campaigns are quietly far worse value than others) and can start them for you, tracking whether they're actually bringing in guests.

**Path Connector** — A manual tool, not automation: draws a footpath between two tiles you pick, with warnings before you commit. No toggles, nothing runs in the background.

The rest of this guide covers every toggle across the five automated plugins in detail — what it does, why it defaults the way it does, and how to tell it's working.

---

## All Toggles at a Glance

| Toggle (as it appears in the UI) | Plugin | Default | Spends money? | What it does |
|---|---|---|---|---|
| Auto-hire / fire handymen | Trash Manager | **ON** | No | Adjusts handyman count to keep the park clean; adapts the formula's recommendation downward while the park stays clean, hires back if litter starts costing rating |
| Auto-sweep all litter each day | Trash Manager | **ON** | No | Removes every piece of litter at the end of each in-game day; automates what you would do manually with the Sweep All button |
| Adaptive staffing (learn the right number) | Trash Manager | **ON** | No | Works with auto-hire to reduce overstaffing on a small/stable park; also enforces a rising minimum tied to guest count so headcount can't get stuck low as the park grows |
| Auto-place benches & bins where needed | Trash Manager | **ON** | **Yes** | Places benches near nauseating ride exits and vomit hotspots (benches stop guests vomiting), and bins near food/drink stalls; costs money |
| ...and remove ones no longer needed | Trash Manager | **ON** | No | Works with auto-place to remove benches and bins that are no longer serving a purpose; **only ever removes amenities this plugin placed itself**; anything you placed by hand is never touched |
| Auto-build toilets, first aid & food stalls | Trash Manager | **ON** | **Yes** | Watches where guests have unmet needs and builds facilities once a gap persists across many samples; costs real money and **never demolishes anything** |
| Max handymen cap | Trash Manager | (spinner) | No | Hard upper limit on auto-hired handymen (manual hires are unaffected); allows you to cap the formula's recommendation |
| Diagnostics: stream timings to log sink | Trash Manager | **OFF** | No | Streams telemetry to a local log sink on 127.0.0.1:7777 for performance analysis; costs nothing when off |
| Auto-manage daily (intervals + hiring + zones) | Mechanic Manager | **ON** | No | Re-applies inspection intervals daily (opening a ride's construction window silently resets them) and clears mechanic patrol zones, which lets mechanics reach **any** ride — OpenRCT2 dispatches the nearest mechanic to each breakdown automatically, and a patrol zone blocks that |
| Adaptive staffing (learn the right number) | Mechanic Manager | **ON** | No | Adjusts mechanic count downward while no rides are breaking down, hires back immediately if breakdowns go unattended |
| Emergency repair stuck rides (cheat) | Mechanic Manager | **ON** | No | **This is a cheat**: clears the breakdown on any ride broken for 3+ days with no mechanic able to fix it (a pathfinding problem in the game itself); adds zero reliability and no mechanic travels |
| Diagnostics: stream timings to log sink | Mechanic Manager | **OFF** | No | Streams telemetry to a local log sink on 127.0.0.1:7777 for performance analysis; costs nothing when off |
| Auto-adjust wait times daily | Wait Time Optimizer | **ON** | No | Automatically applies recommended min/max wait times to all open rides each in-game day |
| Tune ride operation settings (laps / rotations / speed) | Wait Time Optimizer | **OFF** | No | Shortens ride cycles on rides with long queues (5+ min), lengthens them on quiet ones (1 min or less); not yet shown to shorten queues overall ([#15](https://github.com/MatthewT1/matts-openrct2-plugins/issues/15)); **discards the ride's excitement/intensity/nausea ratings until it runs again**, so moves one step at a time; off by default |
| Diagnostics: stream timings to log sink | Wait Time Optimizer | **OFF** | No | Streams telemetry to a local log sink on 127.0.0.1:7777 for performance analysis; costs nothing when off |
| Auto-manage entertainers daily (spends money) | Staff Extras | **ON** | **Yes** | Hires and positions entertainers near queues close to the 15-minute walk-out point (entertainers cut guests' time-in-queue and raise happiness); tracks which entertainers it hired and only ever fires those — one you placed by hand, in whatever costume, is never touched |
| Diagnostics: stream timings to log sink | Staff Extras | **OFF** | No | Streams telemetry to a local log sink on 127.0.0.1:7777 for performance analysis; costs nothing when off |
| Start (per campaign row) | Marketing Manager | manual | **Yes** | Starts that specific campaign for the chosen duration; disabled when the campaign isn't currently eligible (see below) or is already running |
| Duration for next start (spinner) | Marketing Manager | 2 weeks | No | Sets how many weeks the *next* campaign you start (manually or automatically) runs, from 2 to 12 |
| Auto-start eligible campaigns | Marketing Manager | **OFF** | **Yes** | Starts campaigns automatically from the ranked list, best value-per-guest first, up to a daily spending budget and never below a cash reserve; never starts a second campaign of a type already running |
| Diagnostics: stream timings to log sink | Marketing Manager | **OFF** | No | Streams telemetry to a local log sink on 127.0.0.1:7777 for performance analysis; costs nothing when off |

---

## Important Callouts

### Toggles That Are On By Default (And What They Cost)

These were off by default until [#51](https://github.com/MatthewT1/matts-openrct2-plugins/issues/51). In a 10-park headless test ([#63](https://github.com/MatthewT1/matts-openrct2-plugins/issues/63)) they made parks clearly cleaner (less litter and vomit, more 'very clean' thoughts) and did not hurt happiness, for about 500 less cash per 60 days (benches, bins, stalls and entertainer wages). Switch any of them off in the plugin's window; the choice is saved with the park.

**Auto-sweep all litter each day** — Removes every piece of litter at the end of each day, including small recent pieces that don't cost rating yet. On a fully staffed park this can make some handymen redundant; adaptive staffing then hires fewer.

**Auto-place benches & bins where needed** (and **remove ones no longer needed**) — Costs money to build. Benches are cheap and stop guests vomiting near nauseating rides; bins catch litter near stalls. Removal only touches amenities this plugin placed.

**Auto-build toilets, first aid & food stalls** — Costs real money (£225–£300 per facility). The algorithm is conservative and waits until a gap persists across many samples. It never demolishes anything.

**Emergency repair stuck rides** — Labelled a cheat because it is one: it clears the breakdown on a ride no mechanic can reach (a long-standing pathfinding bug), with zero mechanic travel and zero reliability restored. It only acts on rides stuck broken for days with no mechanic able to fix them.

**Auto-manage entertainers** — Each entertainer costs a monthly wage like any other staff. Entertainers go to queues close to the walk-out point.

### Toggles That Are Off By Default (And Why)

**Tune ride operation settings** — Changing operation settings (cycle time, laps, rotations) **discards the ride's excitement/intensity/nausea ratings until the ride runs again**. This can temporarily blind your park to high-intensity rides while tuning progresses, so it is off by default. The wait-time tuning (min/max queues) does not have this cost and runs by default.

**Auto-start eligible campaigns (Marketing Manager)** — This spends real money starting advertising/voucher campaigns on your park's behalf, potentially several at once. In the #63 test it bought guests the parks couldn't hold comfortably and didn't earn its cost back within 60 days ([#74](https://github.com/MatthewT1/matts-openrct2-plugins/issues/74)). Off by default; the ranked list and manual Start buttons let you see and approve every campaign before it costs anything.

### Benches Stop Vomiting

Benches are the answer to vomit, not more handymen. A guest seated on a bench sheds nausea until they stand up and walk away. Vomit is often 99%+ of the litter problem on a typical park, so benches near nauseating rides (or their exits) prevent most litter before handymen ever need to sweep.

If the **Auto-place benches & bins** toggle is on, the plugin names which ride is causing vomit clusters and suggests placing benches near it. If it is off, the in-game console will show vomit reports to help you place them manually.

### Facility Building Never Demolishes

The **Auto-build** toggle will place toilets, first aid, and food/drink stalls where guests have persistent unmet needs. It will never demolish a facility, including ones you built by hand. If you build a toilet on one side of the park and the plugin places one on the other (because both sides had gaps), both stay.

Unmet needs must persist across multiple sweeps of the whole guest roster before a facility is built — this prevents chasing temporary clusters of guests that move in the next moment. A gap far from the nearest facility that keeps reappearing is a real problem worth solving; a temporary crowd is not.

Each facility kind (toilets, food, drink, first aid) is capped at 8 plugin-built facilities — this only limits what the plugin itself builds automatically, not the total in your park; anything you build by hand doesn't count against it. If the plugin has stopped building a kind you still need more of, this cap is why — there's currently no toggle to raise it, but it's easy to adjust if your park has genuinely outgrown it.

### Bench and Bin Removal Only Touches What the Plugin Placed

The **...and remove ones no longer needed** toggle works with auto-place to clean up obsolete amenities. It **only ever removes amenities this plugin placed itself**. A bench you placed by hand will never be removed, even if it looks redundant. This is a safety rule: the plugin knows which ones it placed (it tracks them), and removes only those.

### Ride Operation Tuning Is Slow on Purpose

The **Tune ride operation settings** toggle discovers the legal range for each ride type (what the game will accept) by probing with silent queries. Once a range is found, the controller moves one step at a time after several consistent readings. This is deliberately slow because changing the operation setting clears the ride's ratings. A cascade of changes park-wide would blind the park to what guests actually think of the rides. It runs once per in-game day, so it keeps pace regardless of how fast you're running the game.

### Marketing Campaigns Can Run Several at Once

Unlike most other automation in these plugins, marketing campaigns aren't mutually exclusive: up to five or six different campaign types (the game allows one of each type) can run at the same time, each independently generating extra guests. The ranked list in the Marketing Manager window shows every campaign currently worth starting, cheapest cost-per-extra-guest first — general park/ride advertising is almost always poor value compared to the voucher campaigns (free/half-price entry, free food or drink), so don't be surprised if it's ranked last or missing from the list.

Two things the plugin checks that aren't obvious from playing normally:
- **Free/half-price entry and free-ride vouchers are far less effective if your entrance fee (or that ride's price) is already very low** — the game itself cuts their effectiveness to an eighth in that case, and the plugin accounts for this when ranking.
- **The plugin won't recommend or auto-start anything while the park is already at its guest capacity** — unless your scenario's objective specifically calls for more guests than the park currently supports, in which case it knows to keep going.

Because the game gives plugins no way to check which campaigns are currently running, the Marketing Manager window is the only place that information lives — it's tracked and saved with your park, so reloading doesn't lose it.

### Diagnostics Streams Telemetry (Costs Nothing When Off)

The **Diagnostics** toggle at the bottom of each plugin window streams timing and counter data to a local TCP sink on 127.0.0.1:7777. This is for profiling and understanding what the plugins are doing. It costs nothing when off (which is the default) and the data is not sent anywhere — it stays on your machine.

To enable:
1. Tick **Diagnostics** in any plugin window
2. Run `node tools/log-sink.mjs` in a terminal (or double-click `tools/start-log-sink.cmd` to do this without a Claude/agent session)
3. The sink will write to `tools/rct-debug.log`

Each log entry is newline-delimited JSON with per-plugin timings, staff counts, litter totals, and event counters. The same data is consumed by the technical documentation in `docs/performance.md`.

---

## How Do I Know It's Working?

### In-Game Console

Open the in-game console (see the [OpenRCT2 documentation](https://github.com/OpenRCT2/OpenRCT2/wiki/Scripting) for how) and look for plugin messages. Each plugin logs its decisions:

- **Trash Manager** reports when it hires/fires handymen, places amenities, or finds unmet needs.
- **Mechanic Manager** reports when it hires/fires mechanics, or when a ride is stuck broken beyond reach.
- **Wait Time Optimizer** is silent in normal operation; it just applies settings.
- **Staff Extras** reports when it hires/fires entertainers or reassigns their patrol area.
- **Marketing Manager** reports when it starts a campaign (manually or automatically) and why.

### Status Line in Each Plugin Window

Each plugin has a status line at the bottom of its window showing the current state. Trash Manager shows handyman/litter counts. Mechanic Manager shows mechanic count and wages saved. Wait Time Optimizer shows queue and capacity statistics. Staff Extras shows entertainer count and coverage. Marketing Manager shows whether auto-manage is on and its daily spending budget.

### Diagnostics Log

If you enable **Diagnostics** and run the log sink, the file `tools/rct-debug.log` will contain detailed counters:

| Counter | What it means |
|---|---|
| `handymenStuck` | Handymen idling while work exists (should be zero) |
| `mechanicFleetUnderworked` | Days where fewer than half the mechanics did a job in the last 14 days (drives the controller to release one). Never counted in the first 14 days after a load |
| `amenityDemandsOpen` | Unmet demands after placement (should be zero on a park with enough benches) |
| `facilityPlaced` | Facilities actually built (will be zero if no persistent gaps are found) |
| `facilityCapped` | A facility kind hit its 8-per-kind build cap and was skipped |
| `capacityBoundRides` | Rides whose queues are not tuning-sensitive; they need more trains/cars instead |
| `queuePreemptive` | Times the optimizer applied emergency settings before a queue hit 5 minutes |
| `campaignStarted` / `autoStarted` | Marketing campaigns started manually / automatically |
| `campaignAttribution` | Before/after guest-count evidence for each campaign start, so you can judge whether it actually helped |

**Example:** `facilityPlaced: 0` with `facilityConfirmed: 5` means the plugin found 5 persistent facility gaps but the park's cash was too low to build them. This is not a bug; it is the feature working as designed and respecting your budget.

### What to Expect from Each Plugin

#### Trash Manager

- Handymen will be hired or fired roughly every 1-2 in-game weeks as the park grows or shrinks, and the minimum headcount rises with guest count as the park grows, not just with path tile count
- If adaptive staffing is on, the number will drop below the formula's recommendation on a small/stable park (and stay there), but won't get stuck low as the park grows
- Benches appear near exits of nauseating rides and near stalls; bench/bin placement runs every in-game day regardless of game speed
- Vomit hotspots are reported in the console with the ride name and the distance to the nearest facility

#### Mechanic Manager

- Mechanics are hired or fired slowly (over days, not hours) to avoid thrashing
- If a ride stays broken for 3 days and emergency repair is on, it will be fixed immediately (and the console will say so)
- Inspection intervals are re-applied daily (you won't see this, but it ensures mechanics do their job)

#### Wait Time Optimizer

- Ride properties change roughly once per day when queues are high (you will see the numbers in the ride info window)
- Rides flagged with `[C]` are capacity-bound and need more trains, not tuning
- Rides flagged with `[!!]` are at the 15-minute walk-out cliff (guests are abandoning them)
- The optimizer is silent when doing its job; only unusual conditions get console messages

#### Staff Extras (Entertainers)

- Entertainers are hired and positioned near queues nearing the 15-minute walk-out point, not spread evenly across the park
- Hired entertainers all use the same costume — the first one the game accepts for this park, auto-discovered on first hire (slot 0 specifically does *not* work for entertainers, unlike every other staff type, so this can't be hardcoded and varies by park); if you want a specific themed costume near a ride, place that entertainer by hand — the plugin will never touch or replace it

#### Marketing Manager

- The ranked list refreshes daily; a campaign disappears from it the moment it starts (it moves to "running, Nw left" instead) and reappears once it finishes
- Voucher campaigns (free/half-price entry, free food/drink) are almost always ranked above general park/ride advertising — this is expected, not a bug
- With auto-manage on, expect several campaigns to start over the first few days as it works through the ranked list within its daily budget, then quiet down once everything eligible is already running

---

## Common Questions

**Q: Can I turn these plugins on and off without losing progress?**

A: Yes. All state is saved in the park file. You can reload and adjust toggles at any time.

**Q: Will this make the park harder?**

A: No. These plugins are automation for chores you would do manually anyway (hiring staff, tuning rides, placing amenities, running marketing campaigns). They default to conservative settings and can be turned off entirely.

**Q: Why did it build a toilet nobody uses?**

A: The plugin detected a guest need cluster far from the nearest facility, and it persisted across multiple sweeps. Guests do walk to that facility, and the *expectation* is that they are choosing the farther one because it was built afterward. If the facility genuinely goes unused, it will not be built again on the next park load (only one per kind per pass, capped at 8 per kind overall).

**Q: The handymen aren't sweeping anymore.**

A: Check auto-sweep. If it is off, handymen only sweep when they have work orders from you. If it is on, they should be sweeping. If neither, enable Diagnostics and check whether the staff count dropped to zero. The plugin may have determined the park is overstaffed — though it should never drop below a minimum tied to your current guest count.

**Q: Why aren't the mechanics fixing this ride?**

A: Mechanics cannot reach it (a pathfinding bug in the game). They have probably tried; you will see no repair order on the ride. If you enable **Emergency repair**, it will be cleared on day 3 of being broken.

**Q: Why did it start 5 marketing campaigns at once?**

A: This is intentional — the game allows one of each of the 6 campaign types to run concurrently, each generating guests independently, so running several eligible ones at once is normal and (per the plugin's own measured data) genuinely more effective than running just one. Check the ranked list or `activeCampaigns` in the diagnostics log to see what's running and why.

**Q: How much money will this cost?**

A: Auto-place benches cost tens of pounds per bench. Auto-build facilities cost £225–£300 each. Marketing campaigns cost £50/week (voucher campaigns) to £200-350/week (advertising), charged as a lump sum for the whole duration when started. Entertainers cost a monthly wage like any other staff. Everything else costs nothing. All money-spending toggles are off by default.
