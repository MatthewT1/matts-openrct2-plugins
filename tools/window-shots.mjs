/**
 * Plugin window screenshots for the README (#140).
 *
 *   node tools/window-shots.mjs --park <file.park> [--out docs/img/windows] [--scale 2]
 *       [--plugin-dir <built plugins>] [--game "C:/Program Files/OpenRCT2/openrct2.com"]
 *
 * Opens the real (windowed) game on a throwaway user folder with a copy of our plugins in
 * which each plugin opens its own window a few seconds apart, moves it to the top-left and
 * logs its size. Each window is then captured from the screen (Windows only, via
 * PowerShell), and the park's recent news lines are written to <out>/news.txt. The game
 * window must stay visible while it runs (~1 minute); your own OpenRCT2 folder is only read.
 */

import { spawn, execFileSync } from "node:child_process";
import { copyFileSync, mkdirSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { homedir, tmpdir } from "node:os";

const argv = process.argv.slice(2);
const opt = (k, d) => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : d; };
const PARK = opt("--park"), OUT = resolve(opt("--out", "docs/img/windows")), SCALE = Number(opt("--scale", "2"));
const USERDIR = join(homedir(), "Documents", "OpenRCT2");
const PDIR = opt("--plugin-dir", join(USERDIR, "plugin"));
const GAME = opt("--game", "C:/Program Files/OpenRCT2/openrct2.com");
if (!PARK) { console.log(readFileSync(new URL(import.meta.url), "utf8").split("*/")[0]); process.exit(1); }

const PLUGINS = ["trash-manager", "auto-builder", "staff-extras", "wait-time-optimizer", "mechanic-manager", "marketing-manager"];
const FIRST_MS = 12000, EVERY_MS = 5000;

const ud = join(tmpdir(), "rct-window-shots");
rmSync(ud, { recursive: true, force: true });
mkdirSync(join(ud, "plugin"), { recursive: true });
mkdirSync(OUT, { recursive: true });

// Windowed, big enough for any of our windows at this scale; no title music or intro.
let cfg = readFileSync(join(USERDIR, "config.ini"), "utf8");
const force = { fullscreen_mode: 0, window_width: 1600, window_height: 1000, window_scale: SCALE.toFixed(6), play_intro: "false", title_music: 0, currency_format: "GBP" };
for (const [k, v] of Object.entries(force)) {
    const re = new RegExp(`^${k}\\s*=.*$`, "m");
    cfg = re.test(cfg) ? cfg.replace(re, `${k} = ${v}`) : cfg;
}
writeFileSync(join(ud, "config.ini"), cfg);

PLUGINS.forEach((name, k) => {
    const src = readFileSync(join(PDIR, `${name}.js`), "utf8");
    const head = `var __shotAt = ${FIRST_MS + k * EVERY_MS};
function __shotMenu(label, open) {
    ui.registerMenuItem(label, open);
    context.setTimeout(function () {
        try {
            ui.closeAllWindows();
            open();
            // Ours is the window titled like its menu item; fall back to the newest one.
            var w = null, all = [];
            for (var i = 0; i < ui.windows; i++) {
                var c = ui.getWindow(i);
                all.push(c.classification + ":" + c.title + ":" + c.width + "x" + c.height);
                if (c.title && c.title.toLowerCase().indexOf(label.toLowerCase().split(" ")[0]) !== -1) w = c;
            }
            console.log("SHOTINFO|${name}|" + all.join(", "));
            if (!w) { console.log("SHOTFAIL|${name}|no window titled " + label); return; }
            w.x = 24; w.y = 64;
            console.log("SHOT|${name}|" + w.x + "|" + w.y + "|" + w.width + "|" + w.height);
        } catch (e) { console.log("SHOTFAIL|${name}|" + e); }
    }, __shotAt);
}
`;
    writeFileSync(join(ud, "plugin", `${name}.js`), head + src.replace("ui.registerMenuItem(", "__shotMenu("));
});
// News lines: the park's message log, printed once the park is running.
writeFileSync(join(ud, "plugin", "zz-news.js"), `registerPlugin({ name: "News dump", version: "1", authors: [""], type: "local", licence: "MIT",
    main: function () { context.setTimeout(function () {
        var m = park.messages; for (var i = 0; i < m.length; i++) console.log("NEWS|" + m[i].type + "|" + m[i].text.replace(/\\n/g, " "));
        console.log("DONE|"); }, ${FIRST_MS + PLUGINS.length * EVERY_MS}); } });
`);

const PS = `Add-Type @"
using System; using System.Runtime.InteropServices;
public class W { [DllImport("user32.dll")] public static extern bool SetProcessDPIAware();
 [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);
 [DllImport("user32.dll")] public static extern bool GetClientRect(IntPtr h, out RECT r);
 [DllImport("user32.dll")] public static extern bool ClientToScreen(IntPtr h, ref POINT p);
 public struct RECT { public int L, T, R, B; } public struct POINT { public int X, Y; } }
"@
Add-Type -AssemblyName System.Drawing
[W]::SetProcessDPIAware() | Out-Null
$h = (Get-Process -Id $env:SHOT_PID).MainWindowHandle
[W]::SetForegroundWindow($h) | Out-Null; Start-Sleep -Milliseconds 400
$p = New-Object W+POINT; [W]::ClientToScreen($h, [ref]$p) | Out-Null
$r = New-Object W+RECT; [W]::GetClientRect($h, [ref]$r) | Out-Null
$sx = $r.R / [int]$env:SHOT_CW
$x = [int]($p.X + [int]$env:SHOT_X * $sx); $y = [int]($p.Y + [int]$env:SHOT_Y * $sx)
$w = [int]([int]$env:SHOT_W * $sx); $hh = [int]([int]$env:SHOT_H * $sx)
Write-Output "client $($r.R)x$($r.B) at $($p.X),$($p.Y) scale $sx -> $x,$y $w x $hh"
$bmp = New-Object System.Drawing.Bitmap $w, $hh
$g = [System.Drawing.Graphics]::FromImage($bmp); $g.CopyFromScreen($x, $y, 0, 0, $bmp.Size)
$bmp.Save($env:SHOT_OUT, [System.Drawing.Imaging.ImageFormat]::Png)
`;

const game = spawn(GAME, [resolve(PARK), "--user-data-path", ud], { stdio: ["ignore", "pipe", "pipe"] });
const news = [];
let buf = "";
game.stdout.on("data", (d) => {
    buf += d; const lines = buf.split(/\r?\n/); buf = lines.pop();
    for (const raw of lines) {
        const l = raw.replace(/\x1b\[[0-9;]*m/g, "").replace(/^'|'$/g, "");
        const f = l.split("|");
        if (f[0] === "SHOT") {
            console.log(l);
            // The plugin reports game units; the client area is SCALE x that (1600 wide here).
            const [, name, x, y, w, h] = f;
            setTimeout(() => {
                const out = join(OUT, `${name}.png`);
                try {
                    execFileSync("powershell", ["-NoProfile", "-Command", PS], { env: { ...process.env, SHOT_PID: String(game.pid), SHOT_CW: String(1600 / SCALE),
                        SHOT_X: x, SHOT_Y: y, SHOT_W: w, SHOT_H: h, SHOT_OUT: out }, stdio: "inherit" });
                    console.log("captured", out);
                } catch (e) { console.log("capture failed", name, e.message); }
            }, 1500);
        } else if (f[0] === "SHOTFAIL" || f[0] === "SHOTINFO") console.log(l);
        else if (f[0] === "NEWS") news.push(f.slice(2).join("|"));
        else if (f[0] === "DONE") setTimeout(() => {
            writeFileSync(join(OUT, "news.txt"), news.join("\n") + "\n");
            try { execFileSync("taskkill", ["/PID", String(game.pid), "/T", "/F"], { stdio: "ignore" }); } catch { /* gone */ }
            console.log("done:", OUT);
            process.exit(0);
        }, 3000);
    }
});
setTimeout(() => { console.log("timed out"); try { execFileSync("taskkill", ["/PID", String(game.pid), "/T", "/F"], { stdio: "ignore" }); } catch { /* gone */ } process.exit(1); }, 180000);
