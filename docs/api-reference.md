# OpenRCT2 Scripting API — Verified Reference

Every fact here was checked against the local OpenRCT2 clone in `gamesrc/`, with the
file and line cited. **Check here before trusting an assumption about the API** — several
of these contradict what seems obvious, and two of them previously caused real bugs in
this project.

Authoritative type definitions: `gamesrc/OpenRCT2/distribution/scripting/openrct2.d.ts`
Scripting bindings (C++): `gamesrc/OpenRCT2/src/openrct2/scripting/bindings/`

---

## Contents

- [Units and encodings](#units-and-encodings)
- [Time](#time)
- [Tiles and elements](#tiles-and-elements)
- [Staff](#staff)
- [Rides](#rides)
- [Guests and entities](#guests-and-entities)
- [Plugin lifecycle](#plugin-lifecycle)
- [Game actions](#game-actions)

---

## Units and encodings

Getting these wrong produces code that silently never triggers, which is why they are
first.

| Property | Unit | Note |
|---|---|---|
| `RideStation.queueTime` | **minutes** | Not seconds. `>= 5` is the complaint threshold. |
| `Ride.rideTime` | seconds | Readonly. |
| `Ride.intensity`, `Ride.excitement`, `Ride.nausea` | **2-decimal fixed integer** | 8.00 is `800`. Comparing against `8` is a silent no-op. |
| `Ride.reliability`, `Ride.downtime` | percent, 0–100 | Both readonly. Reliability can exceed 100 on very old rides — [bug #7030](https://github.com/OpenRCT2/OpenRCT2/issues/7030). |
| `Guest.nausea`, `Guest.happiness` | 0–255 | Happiness > 128 counts as "happy" for park rating. |
| `Guest.nauseaTolerance` | 0–3 | |
| World coordinates | tile × 32 | `map.getTile()` takes tile coords; most actions take world coords. |
| **Money** (`park.cash`, wages, prices) | **tenths of a pound** | `operator""_GBP` multiplies by **10** (`core/Money.hpp:27`), not 100. So £5,000 is `50000`. Assuming hundredths silently made a cash floor 10× too high and disabled a whole feature. |

---

## Time

**`interval.day` fires roughly every 528–546 game ticks — not 8192.**

A month is `kTicksPerMonth = 0x10000` (`Date.h:15`) advancing at
`kMonthTicksIncrement = 4` per tick (`Date.cpp:18`), so a month is 16,384 game ticks.
Months are 30 or 31 days (`Date.cpp:24`), giving ~528–546 ticks per day. At 40 ticks/sec
that is **~13 real seconds per in-game day at 1× speed**, and far less when
fast-forwarding.

Measured at exactly 546-tick spacing in the debug log, confirming a 30-day month.

> This project previously assumed 8192 ticks (~3.4 real minutes). That was wrong by
> about 15×, and it made the `interval.day` handler look far cheaper than it is.

- `interval.tick` — every game tick, ~40/sec at 1× speed. Must be trivially cheap.
- `context.setInterval(fn, ms)` — **real-time** milliseconds, like the browser API.
- `date.ticksElapsed` — uint32, wraps after ~49 days of continuous ticks.

---

## Tiles and elements

- **Guard `tile.numElements` before `getElement(0)`.** Index 0 is not guaranteed to
  exist. It is *usually* the surface element, but do not rely on that without checking
  `.type`.
- `SurfaceElement.hasOwnership` → `OwnershipFlag::landOwned` only. It does **not**
  include construction rights.
- `SurfaceElement.hasConstructionRights` → `landOwned | constructionRightsOwned`.
- `map.size` includes the border tiles.
- Bridge tiles can carry two stacked footpath elements — guard against double-counting.

### `EntranceElement.object` is an enum, not an object index

`ScTileElement::object_get` returns `EnumValue(el->getEntranceType())` for entrance
elements (`ScTileElement.cpp:1291`). Values (`EntranceElement.h:25`):

| Value | Meaning |
|---|---|
| `0` | `rideEntrance` |
| `1` | `rideExit` |
| `2` | `parkEntrance` |

Use this to find real ride exits. Matching every `track` and `entrance` element instead
flags each tile of every coaster and produces hundreds of false positives.

---

## Staff

- **`Staff.id` is `number \| null`.** Guard before using it as an action id or an object
  key.
- `map.getAllEntities("staff")` returns all staff; narrow with a type predicate:
  `(s: Staff): s is Handyman => s.staffType === "handyman"`.
- `staffhire` staff types: `0` handyman, `1` mechanic, `2` security, `3` entertainer.
- Handyman `orders` bitmask: sweep `1`, water gardens `2`, empty bins `4`, mow grass `8`.
  This project uses `1 | 4` — mowing is deliberately excluded, see
  [research.md](research.md).
- Mechanic `orders` bitmask: inspect `1`, fix `2`.

### Per-staff productivity counters

Cheap readonly counters, useful for detecting idle or stuck staff:

| Type | Counters |
|---|---|
| `Handyman` | `lawnsMown`, `gardensWatered`, `litterSwept`, `binsEmptied` |
| `Mechanic` | `ridesFixed`, `ridesInspected` |

### Patrol areas

`StaffSetPatrolAreaMode` (`actions/peep/StaffSetPatrolAreaAction.h:16`):

| Mode | Meaning |
|---|---|
| `0` | set |
| `1` | unset |
| `2` | clearAll |

**Patrol areas are expensive in proportion to their area** — see
[performance.md](performance.md#patrol-areas). Never set a rectangle spanning most of
the park.

`Staff.patrolArea` is readonly but exposes `clear()`, `add()`, `remove()`,
`contains()` and `tiles`. The d.ts explicitly warns that reading `.tiles` degrades
performance, so track applied zones in plugin state rather than reading them back.

### Stale staff arrays

**Staff game actions execute synchronously in single player.** A `Staff[]` captured
before a `stafffire` still contains the dead peep. Passing that id to
`staffsetpatrolarea` fails with "Invalid parameter / Staff not found"
(`StaffSetPatrolAreaAction.cpp:69`) and pops an error toast at the player.

Re-fetch the roster after any hire or fire, and guard staff actions with
`map.getEntity(id) !== null`.

---

## Rides

- `map.rides` returns all rides; filter on `classification`, which is
  `"ride" | "stall" | "facility"`.
- `RideStatus` is `"closed" | "open" | "testing" | "simulating"`.
- Mazes have `vehicles.length === 0` — exclude them from anything assuming a dispatch
  cycle.
- Unplaced station exits have negative coordinates; guard before use.
- `ride.fixBreakdown()` is exposed to plugins (`ScRide.cpp:842`). It calls
  `RideFixBreakdown(ride, 0)` — clears the breakdown flags but adds **zero** reliability.
  Effectively a cheat; treat as opt-in.

### Reliability: decay vs. restore

This is the most commonly misunderstood mechanic in the project.

**Decay** (`Ride.cpp:1132`):

```
unreliabilityAccumulator = ride.unreliabilityFactor + getAgePenalty(ride)
ride.reliability -= unreliabilityAccumulator
```

**There is no inspection term.** Decay rate is completely independent of the inspection
interval. Decay is also skipped entirely when the ride is `closed` or `simulating, and
when it is already broken down or crashed (`Ride.cpp:1120-1123`).

`getAgePenalty` (`Ride.cpp:1060`) scales with ride age in years — older rides decay
faster no matter what you do.

**Restore** (`Ride.cpp:4443`, in `RideFixBreakdown`):

```
unreliability = 100 - ride.reliabilityPercentage
ride.reliability += reliabilityIncreaseFactor * (unreliability / 2)
```

So an inspection restores a *proportion of reliability already lost*.

> **Therefore:** shorter inspection intervals do **not** slow decay, but they do raise
> average reliability by making restore events more frequent. The net effect is
> positive; the usual explanation for why is wrong. See the contradiction flagged in
> [research.md](research.md).

### Inspection cadence is far slower than it sounds

`inspectionInterval` is an enum index into `RideInspectionInterval[] = {10, 20, 30, 45,
60, 120, 0, 0}` (`Ride.cpp:133`), in "minutes". `0` = every 10 minutes; the last two
entries mean **never**.

But `RideInspectionUpdate` only runs when `currentTicks & 2047 == 0` — once every
**2048 game ticks** — and increments `lastInspection` by 1 each time (`Ride.cpp:1025`).
So one "minute" of inspection interval is 2048 game ticks:

| Setting | Ticks between inspections | **In-game days** (at ~531 ticks/day) |
|---|---|---|
| `0` — every 10 min | 20,480 | **~38.6** |
| `2` — every 30 min (default) | 61,440 | ~116 |
| `6`/`7` — never | — | — |

**This matters enormously for judging mechanic workload.** A park of 14 rides on the
10-minute setting generates roughly *14 inspections per 38 in-game days* — well under
one per day across the whole park. Measured over 43 in-game days: 19 expected work
events, 19 observed. Mechanics doing "almost nothing" is the correct behaviour, not a
symptom.

A ride is also skipped entirely when `availableBreakdowns.isEmpty()`, when it is already
broken or due inspection, or when it is closed.
- **Re-apply intervals periodically.** A ride's inspection interval resets to default
  whenever its construction window is opened —
  [#25601](https://github.com/OpenRCT2/OpenRCT2/issues/25601).
- The API cannot trigger an inspection on demand; you can only set the interval.

### Ride operation settings are write-only

`Ride::operationOption` is a union (`ride/Ride.h:317`) covering **maze time limit, number
of laps, launch speed, speed and rotation/swing count** — one field, meaning determined by
ride type.

It is settable via `ridesetsetting` with `setting: 4` (`RideSetSetting::operation`), but
**not readable**: it appears in none of the properties `ScRide` registers, nor in
`@openrct2/types`, nor in upstream `develop`'s `openrct2.d.ts` (all checked 2026-09-20).
Web search results claiming otherwise are wrong — they describe the C++ struct, not the
plugin API.

Two consequences:

- Out-of-range values **reject rather than clamp** (`RideSetSettingAction.cpp:95`), so the
  legal maximum can be discovered by probing downward with `queryAction`, which is silent.
- Changing it calls `InvalidateTestResults` (`RideSetSettingAction.cpp:195`) — the ride's
  excitement/intensity/nausea are discarded until it runs again.

**The effect is observable even though the value is not:** `rideTime`, `rideLength`,
`averageSpeed` and `maxSpeed` are all exposed, and `rideTime` is the input the wait-time
formula already uses.

`RideSetSetting` indices (`actions/ride/RideSetSettingAction.h:16`): 0 mode, 1 departure,
2 minWaitingTime, 3 maxWaitingTime, **4 operation**, 5 inspectionInterval, 6 music,
7 musicType, 8 liftHillSpeed, 9 numCircuits, 10 rideType.

### Placing a shop or facility

Every shop and facility — Toilets, FirstAid, FoodStall, DrinkStall, Shop, CashMachine,
InformationKiosk (`ride/rtd/shops/`) — is a **1x1 ride** whose `StartTrackPiece` is
`TrackElemType::flatTrack1x1A`, **id 262** (`ted/TrackElemType.h:282`). So one track
piece builds the whole thing, and no entrance or exit is needed.

Sequence:

1. `ridecreate` `{ rideType, rideObject, entranceObject, colour1, colour2, inspectionInterval }`
   — the result carries the new ride id
2. `trackplace` `{ x, y, z, direction, ride, trackType: 262, rideType, brakeSpeed: 0, colour: 0, seatRotation: 0, trackPlaceFlags: 0, isFromTrackDesign: false }`
3. `ridesetstatus` `{ ride, status: 1 }`

Query each step before executing — ride placement has many more rejection conditions than
a footpath addition.

**Parameter names are the C++ `AcceptParameters` visitor keys**, not the private member
names: `RideCreateAction.cpp:41-49` and `TrackPlaceAction.cpp:59-70`. `trackplace` takes
`x`/`y`/`z`/`direction` through the unnamed `CoordsXYZD` visit, which is why they do not
appear in that list but are still required.

#### Facility ride type numbers

Read off the enum in `Ride.h:580-640`, anchored on the explicit `RIDE_TYPE_DRINK_STALL = 30`
and `RIDE_TYPE_TOP_SPIN = 40` markers so the count cannot drift:

| Ride type | Value | Satisfies |
|---|---|---|
| `RIDE_TYPE_FOOD_STALL` | **28** | hunger |
| `RIDE_TYPE_DRINK_STALL` | **30** | thirst |
| `RIDE_TYPE_TOILETS` | **36** | toilet |
| `RIDE_TYPE_FIRST_AID` | **48** | nausea / first aid |

Beware the gaps: `RIDE_TYPE_1D` (29), `RIDE_TYPE_1F` (31) and `RIDE_TYPE_22` (34) sit
between them and are **`kDummyRTD`** (`RideData.cpp:286-291`) — unused slots, not
alternative stall types. Counting sequentially through this enum will silently produce
the wrong ride type.

#### Direction is 0-3, and the delta table is not the obvious one

`TileDirectionDelta` (`world/Map.cpp:71`):

| Direction | Δx | Δy |
|---|---|---|
| 0 | **-1** | 0 |
| 1 | 0 | **+1** |
| 2 | **+1** | 0 |
| 3 | 0 | **-1** |

Note direction 0 is **-x**, not +x or +y. Which rotation a 1x1 stall actually wants is
not documented in the plugin API at all, so this project probes all four with
`queryAction` — silent, no error window — and takes the first the game accepts, counting
the winner in telemetry so the convention can be read off data rather than assumed.

#### The orphan-ride hazard

`ridecreate` and `trackplace` are **separate actions**, and `trackplace` cannot be
queried until the ride exists. So a `ridecreate` that succeeds followed by a
`trackplace` that fails leaves a **ride with no track** permanently in the player's ride
list, which only they can clean up.

Two defences are needed, not one:

1. Validate the site *before* `ridecreate` — the tile must hold exactly one element, that
   element must be `surface`, with `slope === 0` and `hasOwnership`, and it must touch a
   footpath within one height step.
2. Keep `ridedemolish` `{ ride, modifyType: 0 }` as a cleanup path for the ride id just
   created, in the same callback chain. This is the only demolition in this project and
   it can only ever be aimed at a ride that existed for microseconds.

Build the stall at the **adjacent footpath's** `baseZ`, not the surface's, so the guest
and the counter end up level.

### `departFlags` bitmask

From `Ride.h`. Without bits 6 and 7, the min/max waiting times are stored but never
consulted by the departure logic (`Vehicle.Station.cpp`).

| Bits | Meaning |
|---|---|
| 0–2 | load threshold (0 = any … 3 = full) |
| 3 | `WAIT_FOR_LOAD` — honour the load threshold at all |
| 4 | `LEAVE_WHEN_ANOTHER_ARRIVES` |
| 5 | `SYNC_ADJACENT` |
| 6 | `WAIT_FOR_MIN_LEN` |
| 7 | `WAIT_FOR_MAX_LEN` |

---

### Why `staffhire` refuses, by staff type

`StaffHireNewAction.cpp:74-100`, in order:

| Check | Message | Applies to |
|---|---|---|
| `_staffType >= StaffType::count` | value out of range | any (only if you pass a bad type) |
| `getNumFreeEntities() < 400` | **too many people in game** | **any** |
| entertainer costume not in the loaded set | value out of range | **entertainer only** |
| `createEntity<Staff>()` returned null | too many people in game | any |

So for a handyman, mechanic or security guard with a hard-coded staff type, the **only**
reachable failure is the entity budget. It is transient — it clears as guests leave — but
a controller that retries every in-game day will put the game's error in front of the
player once per day for as long as it lasts. Back off for a stretch after a refusal, and
count it.

**Always pass a real callback to `staffhire` and check `result.error`.** An empty callback
makes a refusal invisible to the plugin and visible to the player, which is the worst way
round.

### Entertainers are the only staff type whose costume is validated

`staffhire` normally ignores `costumeIndex` — but not for entertainers
(`StaffHireNewAction.cpp:85-93`):

```cpp
if (_staffType == static_cast<uint8_t>(StaffType::entertainer))
{
    auto costumes = findAllPeepAnimationsIndexesForType(AnimationPeepType::entertainer);
    if (std::find(costumes.begin(), costumes.end(), _costumeIndex) == costumes.end())
        return Result(Status::invalidParameters, STR_CANT_HIRE_NEW_STAFF,
                      STR_ERR_VALUE_OUT_OF_RANGE);
}
```

So `costumeIndex: 0` — which works for every other staff type and is the obvious default —
produces **"Can't hire new staff / value out of range"** for an entertainer. Slot 0 is not
an entertainer animation.

Valid indexes are object-manager slots holding a loaded `PeepAnimationsObject` whose
`GetPeepType()` is `entertainer` (`PeepAnimations.cpp:160-176`), searched up to
`kMaxPeepAnimationsObjects = 255` (`ObjectLimits.h:37`). **The set depends on which
objects the scenario loaded, so it varies by park.**

The plugin API exposes no way to read a loaded object's peep type, so the set cannot be
computed. Discover it the way every other unreadable range in this project is discovered:
`queryAction` on `staffhire` runs the costume check without hiring anyone and raises no
error window, so probe indexes until one is accepted, then cache it.

| Staff type | `staffType` | Costume validated? |
|---|---|---|
| Handyman | 0 | No |
| Mechanic | 1 | No |
| Security | 2 | No |
| **Entertainer** | **3** | **Yes** |

`staffOrders` is not validated for any type.

### Staff wages

`GetStaffWage` (`entity/Staff.cpp:2645`), in money64 (tenths of a pound):

| Staff type | Per month |
|---|---|
| Handyman | £50 |
| Mechanic | £80 |
| Security | £60 |

Paid as `wage / 4` per wage cycle (`Finance.cpp:120`).

---

## Guests and entities

- **`park.guests` is a cheap property.** Use it instead of
  `map.getAllEntities("guest").filter(...)`, which is expensive.
- `Entity` exposes `x`, `y`, `z` and a nullable `id`. `Litter` extends `Entity`, so
  litter can be located and clustered.
- `Litter.creationTick` is a uint32 and wraps. Compute age as
  `ticksElapsed - creationTick`, adding `2**32` if negative.
- `Guest.thoughts` is a readonly `Thought[]`. Relevant `ThoughtType` values include
  `bad_litter`, `path_disgusting` and `vandalism`.
- **Sitting sheds nausea.** A guest in `PeepState::sitting` has `nauseaTarget` reduced by
  6 per update while it is >= 50 (`Guest.cpp:1099`); `throwUp()` halves `nauseaTarget`
  and drops `nausea` by 30 (`Guest.cpp:7692`). So **benches prevent vomiting** — handymen
  only clean it up afterwards. This is the single highest-leverage fact for litter
  management on a park whose litter is mostly vomit.
- **Guest needs** are exposed 0-255: `hunger`, `thirst`, `toilet` (`openrct2.d.ts:3437+`).
  Source thresholds for the corresponding thoughts (`Guest.cpp:1007-1019`):

  | Need | Thought fires when | Note |
  |---|---|---|
  | Hungry | `hunger <= 10` | only if not already holding food |
  | Thirsty | `thirst <= 25` | only if not already holding a drink |
  | Toilet | `toilet >= 160` | urgency at `>= 195` (`Guest.cpp:703`) |

  Lower is worse for hunger and thirst; higher is worse for toilet.

  A guest whose thought fires then **walks to the nearest matching facility**
  (`GuestHeadForNearestRideWithFlag`, e.g. `RtdFlag::sellsFood`), so an unmet need also
  means a guest crossing the park.

  Note `PeepState::sitting` *raises* `toilet` by 3 per update while lowering nausea
  (`Guest.cpp:1095-1099`) — benches trade one need for another.
- **Research / unlock state** is readable: `park.research.inventedItems` and
  `uninventedItems` are `ResearchItem[]` (`openrct2.d.ts:4581`), so a plugin can restrict
  suggestions to what a scenario has actually unlocked.
- `map.getAllEntitiesOnTile(type, tilePos)` exists — cheaper than filtering everything
  when you only care about one tile.
- `FootpathElement.isAdditionFull` — true when a bin has a fully-filled slot; null when
  the addition is not a bin.
- `FootpathElement.addition` is the addition's **object index**, or null. There is no
  "is this a bench" flag — resolve the index against
  `objectManager.getAllObjects("footpath_addition")` and match on `identifier`/`name`.
### Footpath additions are refused more often than you would expect

`FootpathAdditionPlaceAction::Query` (`actions/footpath/FootpathAdditionPlaceAction.cpp:80-125`)
rejects a placement for **five** separate reasons. Three are detectable from the
scripting API and must be filtered up front, or the player gets a stream of error
windows:

| Condition | Error | Detect with |
|---|---|---|
| Sloped path | "Can't build this on sloped footpath" | `FootpathElement.slopeDirection !== null` |
| **All four edges connected** | "Can only be placed on path edges" | `FootpathElement.edges === 0x0F` |
| Queue line | "Cannot place these on queue line area" | `FootpathElement.isQueue` |
| Level crossing | — | **not exposed** |
| Object-specific flags | varies | **not exposed** |

The `edges === 0x0F` rule is the surprising one: an enclosed interior tile of a wide
plaza has no free edge to stand a bench against, so additions are refused there even
though the tile looks perfectly ordinary.

**Because two conditions are undetectable, always `context.queryAction` first and only
`executeAction` if the query succeeds.** A failed `executeAction` pops an error window at
the player; a failed `queryAction` is silent. This pattern is what makes automated
placement safe.

Use the **footpath element's** `baseZ` for the `z` argument, not the surface element's —
they coincide on flat ground and diverge the moment a path is raised.

---

## Plugin lifecycle

- `targetApiVersion: 87` is what this project targets.
- **Hot-reload cleanup is automatic.** `ScriptEngine::StopPlugin`
  (`ScriptEngine.cpp:1010`) calls `RemoveIntervals`, `RemoveSockets`,
  `RemoveCustomGameActions` and `_hookEngine.UnsubscribeAll`. Subscriptions and
  `setInterval` handles do **not** leak across reloads. You still want `clearInterval`
  in a window's `onClose` so a closed window stops ticking.
- `type: "local"` plugins run when a park is loaded.
- `context.getParkStorage()` persists inside the `.park` file — per save.
- `context.sharedStorage` persists globally, in a JSON file loaded once at startup.
  Editing that file requires a game restart.
- Game state may only be mutated from a compatible hook (`interval.tick`,
  `interval.day`, or a custom game action) — **not** from a UI `onClick`. Defer with a
  flag.

### The in-game console cannot run JavaScript

Backtick (`` ` ``) opens the in-game console (`Shortcuts.cpp:900`), but it only accepts
built-in game commands — `InteractiveConsole.cpp` has no eval path at all.

Only the **`openrct2.com` stdin console** evaluates script, via
`scriptEngine.Eval()` (`StdInOutConsole.cpp:79`). On Windows, run `openrct2.com`
rather than `openrct2.exe` to get a JS REPL.

### Networking

`network.createSocket()` returns an outbound TCP client and is **not** gated to
multiplayer or to a plugin type — only by a compile-time `DISABLE_NETWORK`
(`ScNetwork.cpp:315`), which throws. `network.createListener()` also exists. This is
what the [debug channel](performance.md#debug-channel) uses.

---

## Game actions

`context.executeAction(name, args, callback)` is a full game-command dispatch:
validate → execute → log → replicate in multiplayer. **It is not cheap.** Never issue an
unchanged action on a recurring interval; track what you have applied and send only the
delta.

Actions used by this project:

| Action | Args |
|---|---|
| `staffhire` | `{ autoPosition, staffType, costumeIndex, staffOrders }` → result has `peep` |
| `stafffire` | `{ id }` |
| `staffsetpatrolarea` | `{ id, x1, y1, x2, y2, mode }` |
| `ridesetstatus` | `{ ride, status }` (0 closed, 1 open) |
| `ridesetvehicle` | `{ ride, type, value, colour }` (type 0 = train count, 1 = cars per train) |
| `footpathplace` | `{ x, y, z, direction, object, railingsObject, slopeType, slopeDirection, constructFlags }` |
| `footpathadditionplace` | `{ x, y, z, object }` — `z` is the **footpath** element's baseZ, not the surface's |
| `footpathadditionremove` | `{ x, y, z }` |
| `ridecreate` | `{ rideType, rideObject, entranceObject, colour1, colour2, inspectionInterval }` → result has `ride` |
| `trackplace` | `{ x, y, z, direction, ride, trackType, rideType, brakeSpeed, colour, seatRotation, trackPlaceFlags, isFromTrackDesign }` |
| `ridedemolish` | `{ ride, modifyType }` (0 demolish, 1 renew) |
| `ridesetsetting` | `{ ride, setting, value }` — setting 4 is `operationOption` |

`FootpathPlaceArgs.object` is the **surface** object index; `direction: 0xFF` means no
forced slope.
