/**
 * Headless harness agent (#46). DEV ONLY: tools/headless/run.mjs copies this into a
 * throwaway user-data folder for each run. It is never built by rollup and must never
 * be put in the real OpenRCT2 plugin folder.
 *
 * It listens on 127.0.0.1 only and understands a fixed set of commands, one JSON object
 * per line. There is deliberately no "evaluate this code" command.
 *
 *   {"cmd":"hello"}                     -> {"type":"hello", ...state, plugins}
 *   {"cmd":"settings","set":{...},"keys":{...},"debug":bool}
 *   {"cmd":"nomoney"}                   -> {"type":"nomoney", noMoney}   (#44: game cheat, both arms)
 *                                       -> {"type":"settings", stored}
 *       set:  { "<plugin name>": { "<key>": true|false } } written to that plugin's park
 *             storage (booleans only; anything else is refused)
 *       keys: { "<plugin name>": ["<key>", ...] } read back after writing
 *   {"cmd":"start","days":60,"speed":4,"perturb":0}
 *                                       -> {"type":"day", ...snapshot} once at start and
 *                                          after every in-game day, then {"type":"done"}
 *                                          (the game is paused again when done)
 *       perturb (#63): draw the scenario RNG this many times at the first day tick, so
 *       replicates of an otherwise deterministic run differ. Needs a game-state callback
 *       (getRandom throws "not mutable" from the socket), and a day tick is the same tick
 *       in every run. Money totals (*Cum) also count from that tick, since the day-0
 *       snapshot is taken at a wall-clock-dependent tick.
 *
 * The port is filled in by the runner (the placeholder below).
 */
registerPlugin({
    name: "Headless Harness Agent",
    version: "1.0.0",
    authors: ["matts-openrct2-plugins"],
    type: "local",
    licence: "MIT",
    targetApiVersion: 87,
    main: function () {
        var PORT = __HARNESS_PORT__;
        var sock = null;
        var daySub = null;
        var daysWanted = 0;
        var daysDone = 0;
        var breakdownsToday = 0;
        context.subscribe("ride.breakdown", function () { breakdownsToday++; });

        // #63 guest thought tally: column name -> thought types counted in it.
        var THOUGHTS_NEG = {
            thPathDisgusting: ["path_disgusting"], thLitter: ["bad_litter"], thVandalism: ["vandalism"],
            thSick: ["sick", "very_sick"], thHungry: ["hungry"], thThirsty: ["thirsty"], thToilet: ["toilet"],
            thTired: ["tired"], thLost: ["lost", "cant_find", "cant_find_exit"], thCrowded: ["crowded"],
            thQueuingAges: ["queuing_ages"], thBadValue: ["bad_value"], thCantAfford: ["cant_afford_ride", "cant_afford_item"]
        };
        var THOUGHTS_POS = {
            thGoodValue: ["good_value"], thVeryClean: ["very_clean"], thScenery: ["scenery"], thWasGreat: ["was_great"]
        };
        // Tallied as columns but NOT counted in thoughtsNeg/thoughtsPos, so adding one keeps
        // those totals comparable with older runs.
        //   #82: "running out of cash" is what sends a guest to an ATM (Guest.cpp:1052).
        var THOUGHTS_INFO = { thRunningOut: ["running_out"] };
        var thoughtCol = {};
        (function () {
            var c, i;
            for (c in THOUGHTS_NEG) for (i = 0; i < THOUGHTS_NEG[c].length; i++) thoughtCol[THOUGHTS_NEG[c][i]] = c;
            for (c in THOUGHTS_POS) for (i = 0; i < THOUGHTS_POS[c].length; i++) thoughtCol[THOUGHTS_POS[c][i]] = c;
            for (c in THOUGHTS_INFO) for (i = 0; i < THOUGHTS_INFO[c].length; i++) thoughtCol[THOUGHTS_INFO[c][i]] = c;
        })();

        // #63 money: cumulative since start per expenditure type. The game keeps a monthly table
        // (index 0 = this month, income positive, costs negative); a day is shorter than a month,
        // so at most one rollover happens between two snapshots.
        var MONEY_TYPES = ["ride_construction", "ride_runningcosts", "land_purchase", "landscaping",
            "park_entrance_tickets", "park_ride_tickets", "shop_sales", "shop_stock", "food_drink_sales",
            "food_drink_stock", "wages", "marketing", "research", "interest"];
        var moneyLast = {}, moneyCum = {}, moneyMonth = 0;
        function moneyReset() {
            moneyMonth = date.monthsElapsed;
            for (var i = 0; i < MONEY_TYPES.length; i++) {
                var arr = park.getMonthlyExpenditure(MONEY_TYPES[i]);
                moneyLast[MONEY_TYPES[i]] = arr.length > 0 ? arr[0] : 0;
                moneyCum[MONEY_TYPES[i]] = 0;
            }
        }
        function moneyUpdate() {
            var rolled = date.monthsElapsed !== moneyMonth;
            for (var i = 0; i < MONEY_TYPES.length; i++) {
                var t = MONEY_TYPES[i], arr = park.getMonthlyExpenditure(t);
                var cur = arr.length > 0 ? arr[0] : 0;
                moneyCum[t] += rolled ? ((arr.length > 1 ? arr[1] : 0) - moneyLast[t]) + cur : cur - moneyLast[t];
                moneyLast[t] = cur;
            }
            moneyMonth = date.monthsElapsed;
            var c = moneyCum, income = 0, expense = 0;
            for (var j = 0; j < MONEY_TYPES.length; j++) {
                if (c[MONEY_TYPES[j]] > 0) income += c[MONEY_TYPES[j]];
                else expense += c[MONEY_TYPES[j]];
            }
            return {
                incomeCum: income,
                expenseCum: expense,
                entranceCum: c.park_entrance_tickets,
                rideTicketsCum: c.park_ride_tickets,
                salesCum: c.shop_sales + c.food_drink_sales,
                stockCum: c.shop_stock + c.food_drink_stock,
                wagesCum: c.wages,
                runningCostsCum: c.ride_runningcosts,
                buildCum: c.ride_construction + c.landscaping + c.land_purchase,
                marketingCum: c.marketing
            };
        }

        function send(obj) {
            if (sock) sock.write(JSON.stringify(obj) + "\n");
        }

        function countStaff() {
            var out = { handyman: 0, mechanic: 0, security: 0, entertainer: 0 };
            var staff = map.getAllEntities("staff");
            for (var i = 0; i < staff.length; i++) {
                var t = staff[i].staffType;
                if (out[t] !== undefined) out[t]++;
            }
            return out;
        }

        function guestStats() {
            var guests = map.getAllEntities("guest");
            var inPark = 0, happy = 0, c;
            var out = { thoughtsNeg: 0, thoughtsPos: 0 };
            for (c in THOUGHTS_NEG) out[c] = 0;
            for (c in THOUGHTS_POS) out[c] = 0;
            for (c in THOUGHTS_INFO) out[c] = 0;
            for (var i = 0; i < guests.length; i++) {
                if (!guests[i].isInPark) continue;
                inPark++;
                happy += guests[i].happiness;
                var th = guests[i].thoughts;
                for (var j = 0; j < th.length; j++) {
                    var col = thoughtCol[th[j].type];
                    if (!col) continue;
                    out[col]++;
                    if (THOUGHTS_NEG[col]) out.thoughtsNeg++;
                    else if (THOUGHTS_POS[col]) out.thoughtsPos++;
                }
            }
            out.avgHappiness = inPark > 0 ? Math.round(happy / inPark) : 0;
            return out;
        }

        function rideStats() {
            var rides = map.rides, open = 0, rel = 0, down = 0, broken = 0;
            for (var i = 0; i < rides.length; i++) {
                var r = rides[i];
                if (r.classification !== "ride" || r.status !== "open") continue;
                open++;
                rel += r.reliability;
                down += r.downtime;
                if (r.breakdown !== "none") broken++;
            }
            return {
                openRides: open,
                avgReliability: open > 0 ? Math.round(rel / open) : 0,
                avgDowntime: open > 0 ? Math.round(down / open) : 0,
                ridesBroken: broken
            };
        }

        function countVomit() {
            var litter = map.getAllEntities("litter"), n = 0;
            for (var i = 0; i < litter.length; i++) {
                var t = litter[i].litterType;
                if (t === "vomit" || t === "vomit_alt") n++;
            }
            return { litter: litter.length, vomit: n };
        }

        function snapshot() {
            var staff = countStaff();
            var g = guestStats(), rs = rideStats(), lv = countVomit(), m = moneyUpdate();
            var row = {
                type: "day",
                day: daysDone,
                date: date.year + "-" + date.month + "-" + date.day,
                ticks: date.ticksElapsed,
                rating: park.rating,
                guests: park.guests,
                avgHappiness: g.avgHappiness,
                cash: park.cash,
                bankLoan: park.bankLoan,
                parkValue: park.value,
                companyValue: park.companyValue,
                totalAdmissions: park.totalAdmissions,
                handymen: staff.handyman,
                mechanics: staff.mechanic,
                security: staff.security,
                entertainers: staff.entertainer,
                litter: lv.litter,
                vomit: lv.vomit,
                openRides: rs.openRides,
                avgReliability: rs.avgReliability,
                avgDowntime: rs.avgDowntime,
                ridesBroken: rs.ridesBroken,
                breakdowns: breakdownsToday
            };
            breakdownsToday = 0;
            var k;
            for (k in m) row[k] = m[k];
            for (k in g) if (k !== "avgHappiness") row[k] = g[k];
            return row;
        }

        function hello() {
            var names = [];
            var plugins = pluginManager.plugins;
            for (var i = 0; i < plugins.length; i++) names.push(plugins[i].name);
            send({
                type: "hello",
                paused: context.paused,
                speed: context.gameSpeed,
                date: date.year + "-" + date.month + "-" + date.day,
                parkName: park.name,
                noMoney: park.getFlag("noMoney"),
                openRides: rideStats().openRides,
                plugins: names
            });
        }

        function settings(set, keys, debug) {
            var p, k;
            // Diagnostics is a shared (not park) flag; every arm's user-data is a throwaway
            // copy, so it is written explicitly each run rather than inherited.
            context.sharedStorage.set("openrct2-plugins.debug", debug === true);
            for (p in set || {}) {
                for (k in set[p]) {
                    if (typeof set[p][k] !== "boolean") {
                        send({ type: "error", error: "setting " + p + "." + k + " is not a boolean" });
                        return;
                    }
                }
            }
            for (p in set || {}) {
                var w = context.getParkStorage(p);
                for (k in set[p]) w.set(k, set[p][k]);
            }
            var stored = {};
            for (p in keys || {}) {
                var r = context.getParkStorage(p);
                stored[p] = {};
                for (var i = 0; i < keys[p].length; i++) {
                    var v = r.get(String(keys[p][i]));
                    stored[p][keys[p][i]] = v === undefined ? null : v;
                }
            }
            send({ type: "settings", stored: stored });
        }

        function start(days, speed, perturb) {
            if (daySub) daySub.dispose();
            daysWanted = days;
            daysDone = 0;
            breakdownsToday = 0;
            moneyReset();
            send(snapshot());
            // Writing context.paused from a socket callback throws "Game state is not
            // mutable in this context"; the pausetoggle action works.
            if (context.paused) context.executeAction("pausetoggle", {});
            context.executeAction("gamesetspeed", { speed: speed });
            daySub = context.subscribe("interval.day", function () {
                daysDone++;
                if (daysDone === 1) {
                    for (var n = 0; n < perturb; n++) context.getRandom(0, 2);
                    moneyReset();
                }
                send(snapshot());
                if (daysDone >= daysWanted) {
                    daySub.dispose();
                    daySub = null;
                    if (!context.paused) context.executeAction("pausetoggle", {});
                    send({ type: "done", days: daysDone });
                }
            });
        }

        // Turns the park into a no-money park with the game's own cheat (CheatType::noMoney
        // = 15, Cheats.h), as a player's "no money" scenario would be. Cash is left as saved.
        function noMoney() {
            context.executeAction("cheatset", { type: 15, param1: 1, param2: 0 }, function (r) {
                if (r.error) send({ type: "error", error: "cheatset noMoney: " + r.errorMessage });
                else send({ type: "nomoney", noMoney: park.getFlag("noMoney") });
            });
        }

        function handle(line) {
            var msg;
            try { msg = JSON.parse(line); } catch (e) { send({ type: "error", error: "bad json" }); return; }
            if (msg.cmd === "hello") hello();
            else if (msg.cmd === "nomoney") noMoney();
            else if (msg.cmd === "settings") settings(msg.set, msg.keys, msg.debug);
            else if (msg.cmd === "start") start(msg.days | 0, msg.speed | 0, msg.perturb | 0);
            else send({ type: "error", error: "unknown cmd " + msg.cmd });
        }

        var listener = network.createListener();
        listener.on("connection", function (s) {
            sock = s;
            var buf = "";
            s.setNoDelay(true);
            s.on("data", function (d) {
                buf += d;
                var i;
                while ((i = buf.indexOf("\n")) >= 0) {
                    var line = buf.slice(0, i);
                    buf = buf.slice(i + 1);
                    if (line.length > 0) handle(line);
                }
            });
            s.on("close", function () { if (sock === s) sock = null; });
        });
        listener.listen(PORT, "127.0.0.1");
        console.log("[Headless Harness Agent] listening on 127.0.0.1:" + PORT);
    }
});
