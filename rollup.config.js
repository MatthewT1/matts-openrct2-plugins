import resolve from "@rollup/plugin-node-resolve";
import terser from "@rollup/plugin-terser";
import typescript from "@rollup/plugin-typescript";
import { exec } from "node:child_process";
import { homedir } from "node:os";
import { promisify } from "node:util";

const plugins = [
	"wait-time-optimizer",
	"trash-manager",
	"mechanic-manager",
	"path-connector",
	"staff-extras",
	"marketing-manager",
];

const build = process.env.BUILD || "development";

async function getPluginDir() {
	if (build !== "development") {
		return "./dist";
	}

	const platform = process.platform;
	const base = "OpenRCT2/plugin";

	if (platform === "win32") {
		const { stdout } = await promisify(exec)(
			"powershell -command \"[Environment]::GetFolderPath('MyDocuments')\""
		);
		return `${stdout.trim()}/${base}`;
	} else if (platform === "darwin") {
		return `${homedir()}/Library/Application Support/${base}`;
	} else {
		const cfg = process.env.XDG_CONFIG_HOME || `${homedir()}/.config`;
		return `${cfg}/${base}`;
	}
}

const dir = await getPluginDir();

/** @type {import("rollup").RollupOptions[]} */
const config = plugins.map((name) => ({
	input: `./src/${name}.ts`,
	output: {
		file: `${dir}/${name}.js`,
		format: "iife",
		compact: true,
	},
	treeshake: "smallest",
	plugins: [
		resolve(),
		typescript(),
		terser({
			compress: {
				passes: 5,
				toplevel: true,
				unsafe: true,
			},
			format: {
				comments: false,
				quote_style: 1,
				wrap_iife: true,
				beautify: build === "development",
			},
		}),
	],
}));

export default config;
