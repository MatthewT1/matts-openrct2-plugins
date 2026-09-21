/**
 * Local TCP sink for the OpenRCT2 plugin debug channel (src/debug.ts).
 *
 * Listens on 127.0.0.1:7777, accepts newline-delimited JSON from the plugins and
 * appends every record to tools/rct-debug.log. Start it before (or during) a game
 * session; the plugins reconnect on their own, so order does not matter.
 *
 *   node tools/log-sink.mjs
 *
 * Bound to the loopback interface only — nothing is exposed off this machine.
 */

import { createServer } from "node:net";
import { createWriteStream, existsSync, renameSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const HOST = "127.0.0.1";
const PORT = 7777;

const here = dirname(fileURLToPath(import.meta.url));
const logPath = join(here, "rct-debug.log");

// Opened only once the port is successfully bound — see the listen callback. Rotating
// the log before binding meant a failed start (e.g. a sink already running) still
// destroyed the previous run's data while writing nothing new.
let out = null;

function write(line) {
	if (out !== null) out.write(line + "\n");
	console.log(line);
}

const server = createServer((socket) => {
	const who = `${socket.remoteAddress}:${socket.remotePort}`;
	write(JSON.stringify({ sink: "connect", peer: who, at: new Date().toISOString() }));

	let pending = "";
	socket.setEncoding("utf8");

	socket.on("data", (chunk) => {
		pending += chunk;
		const lines = pending.split("\n");
		// The last element is either an empty string or a partial record.
		pending = lines.pop() ?? "";
		for (const line of lines) {
			if (line.trim() === "") continue;
			// Record whatever arrived, even if it is not valid JSON, so nothing is lost.
			write(line);
		}
	});

	socket.on("error", (err) => {
		write(JSON.stringify({ sink: "error", peer: who, message: err.message }));
	});

	socket.on("close", () => {
		if (pending.trim() !== "") write(pending);
		write(JSON.stringify({ sink: "disconnect", peer: who, at: new Date().toISOString() }));
	});
});

server.on("error", (err) => {
	if (err.code === "EADDRINUSE") {
		console.error(`[log-sink] port ${PORT} is already in use — a sink is probably`);
		console.error(`[log-sink] already running. The existing log was left untouched.`);
	} else {
		console.error(`[log-sink] ${err.message}`);
	}
	process.exit(1);
});

server.listen(PORT, HOST, () => {
	// Only now that we own the port do we touch the log, keeping one previous run so a
	// crash-and-restart does not destroy the evidence.
	if (existsSync(logPath)) {
		renameSync(logPath, logPath + ".prev");
	}
	out = createWriteStream(logPath, { flags: "a" });
	console.log(`[log-sink] listening on ${HOST}:${PORT}`);
	console.log(`[log-sink] writing to ${logPath}`);
});
