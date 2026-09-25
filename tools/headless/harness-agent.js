/**
 * Headless harness agent (#46). DEV ONLY: tools/headless/run.mjs copies this into a
 * throwaway user-data folder for each run. It is never built by rollup and must never
 * be put in the real OpenRCT2 plugin folder.
 *
 * It listens on 127.0.0.1 only and understands a fixed set of commands, one JSON object
 * per line. There is deliberately no "evaluate this code" command.
 *
 *   {"cmd":"hello"}                     -> {"type":"hello", ...state, plugins}
 *   {"cmd":"start","days":60,"speed":4} -> {"type":"day", ...snapshot} once at start and
 *                                          after every in-game day, then {"type":"done"}
 *                                          (the game is paused again when done)
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
            var inPark = 0, happy = 0;
            for (var i = 0; i < guests.length; i++) {
                if (!guests[i].isInPark) continue;
                inPark++;
                happy += guests[i].happiness;
            }
            return { avgHappiness: inPark > 0 ? Math.round(happy / inPark) : 0 };
        }

        function openRides() {
            var rides = map.rides, open = 0;
            for (var i = 0; i < rides.length; i++) {
                if (rides[i].classification === "ride" && rides[i].status === "open") open++;
            }
            return open;
        }

        function snapshot() {
            var staff = countStaff();
            var g = guestStats();
            return {
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
                litter: map.getAllEntities("litter").length,
                openRides: openRides()
            };
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
                plugins: names
            });
        }

        function start(days, speed) {
            if (daySub) daySub.dispose();
            daysWanted = days;
            daysDone = 0;
            send(snapshot());
            // Writing context.paused from a socket callback throws "Game state is not
            // mutable in this context"; the pausetoggle action works.
            if (context.paused) context.executeAction("pausetoggle", {});
            context.executeAction("gamesetspeed", { speed: speed });
            daySub = context.subscribe("interval.day", function () {
                daysDone++;
                send(snapshot());
                if (daysDone >= daysWanted) {
                    daySub.dispose();
                    daySub = null;
                    if (!context.paused) context.executeAction("pausetoggle", {});
                    send({ type: "done", days: daysDone });
                }
            });
        }

        function handle(line) {
            var msg;
            try { msg = JSON.parse(line); } catch (e) { send({ type: "error", error: "bad json" }); return; }
            if (msg.cmd === "hello") hello();
            else if (msg.cmd === "start") start(msg.days | 0, msg.speed | 0);
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
