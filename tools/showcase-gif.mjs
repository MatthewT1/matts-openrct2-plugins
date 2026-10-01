// README time-lapse (#140): turns the frames of a `run.mjs --capture-at X,Y --capture-every N`
// run into a GIF with a "Day N" caption. Needs ffmpeg on PATH (or --ffmpeg <path>).
//
//   node tools/headless/run.mjs --save <park> --out harness-runs/gif --days 90 --arms on \
//        --capture-at 74,91 --capture-every 5
//   node tools/showcase-gif.mjs --frames harness-runs/gif/on --out docs/img/showcase/holland-90d.gif
import { execFileSync } from "node:child_process";
import { readdirSync, mkdtempSync, copyFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const arg = (k, d) => { const i = process.argv.indexOf(k); return i > 0 ? process.argv[i + 1] : d; };
const frames = arg("--frames"), out = arg("--out");
const ffmpeg = arg("--ffmpeg", "ffmpeg");
const days = Number(arg("--days", 90));          // day number of end.png
const frameMs = Number(arg("--frame-ms", 450));  // time per frame
const holdMs = Number(arg("--hold-ms", 2500));   // extra time on the last frame
const width = Number(arg("--width", 960));
const font = arg("--font", "C:/Windows/Fonts/arialbd.ttf");
if (!frames || !out) { console.log("usage: showcase-gif.mjs --frames <arm dir> --out <file.gif>"); process.exit(1); }

// start.png (day 1), d005.png ..., end.png, in day order.
const dayOf = (f) => f === "start.png" ? 1 : f === "end.png" ? days : Number(f.slice(1, 4));
const files = readdirSync(frames).filter((f) => /^(start|end|d\d{3})\.png$/.test(f)).sort((a, b) => dayOf(a) - dayOf(b));
if (files.length < 2) { console.log("no frames in " + frames); process.exit(1); }

const tmp = mkdtempSync(join(tmpdir(), "showcase-gif-"));
try {
    // Caption each frame, then one palette for the whole clip so colours do not flicker.
    files.forEach((f, i) => {
        const text = "Day " + dayOf(f);
        const vf = `scale=${width}:-1:flags=neighbor,drawtext=fontfile='${font.replace(":", "\\:")}':text='${text}':x=16:y=h-th-16:fontsize=28:fontcolor=white:box=1:boxcolor=black@0.6:boxborderw=8`;
        execFileSync(ffmpeg, ["-y", "-loglevel", "error", "-i", join(frames, f), "-vf", vf, join(tmp, `f${String(i).padStart(3, "0")}.png`)]);
    });
    // Hold the last frame by repeating it.
    const extra = Math.round(holdMs / frameMs);
    for (let n = 0; n < extra; n++) {
        copyFileSync(join(tmp, `f${String(files.length - 1).padStart(3, "0")}.png`), join(tmp, `f${String(files.length + n).padStart(3, "0")}.png`));
    }
    const fps = (1000 / frameMs).toFixed(3);
    execFileSync(ffmpeg, ["-y", "-loglevel", "error", "-framerate", fps, "-i", join(tmp, "f%03d.png"),
        "-filter_complex", "split[a][b];[a]palettegen=stats_mode=diff[p];[b][p]paletteuse=dither=none:diff_mode=rectangle",
        "-loop", "0", out]);
    console.log(`${out}: ${files.length} frames, ${(statSync(out).size / 1024).toFixed(0)} KB`);
} finally {
    rmSync(tmp, { recursive: true, force: true });
}
