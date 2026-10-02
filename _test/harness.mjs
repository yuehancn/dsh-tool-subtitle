// Shared minimal harness for the dsh-tool-subtitle tests.
//
// It rebuilds the plugin's `apply` against the REAL @deepseek-ai/dsh-tools, so
// schema normalization (`required` hoisting, `additionalProperties`, description
// retention) is exercised for real rather than against a hand-written stub.
//
// `apply(ctx, config)` receives an already schema-resolved config, so this
// context runs the caller's options through the real `Config` first and fills
// every missing key with its default. Passing a partial object straight through
// would silently register zero tools.
import { readFile, mkdir, writeFile, stat } from "node:fs/promises";
import { join, resolve, basename, extname } from "node:path";
import { spawn } from "node:child_process";
import z from "@deepseek-ai/schemastery";
import { defineTool } from "@deepseek-ai/dsh-tools";

const source = await readFile(new URL("../lib/index.js", import.meta.url), "utf8");

const body = source
	.replace(/^import .*$/gm, "")
	.replace(/^export \{.*\};$/m, "");
const build = new Function(
	"z", "defineTool", "mkdir", "readFile", "writeFile", "stat",
	"join", "resolve", "basename", "extname", "spawn",
	`${body}
	 return { Config, apply, inject, name,
	   parseTimestamp, formatTimestamp, formatVttTimestamp, formatAssTimestamp,
	   parseSubtitle, parseCues, parseAss, splitAssFields, formatSubtitle,
	   readingUnits, normaliseCues, retimeCues, splitLongCues, wrapText, mergeOverlaps,
	   checkCues, expandArgs, parseEnvEntries, coerceCues, humanClock };`
);

/** The plugin's real exports plus its internals, for white-box assertions. */
export const plugin = build(
	z, defineTool, mkdir, readFile, writeFile, stat, join, resolve, basename, extname, spawn
);

/**
 * Build a minimal cordis-like context that records registered tools.
 *
 * @param {object} [options] - partial plugin config; missing keys take defaults.
 * @returns {{tools: object, config: object, names: () => string[], get: (n: string) => any, has: (n: string) => boolean}} the context.
 */
export function Context(options = {}) {
	const config = plugin.Config(options);
	const registry = new Map();
	const tools = {
		register(definition) {
			registry.set(definition.name, definition);
		}
	};
	return {
		tools,
		config,
		names: () => [...registry.keys()],
		get: (n) => registry.get(n),
		has: (n) => registry.has(n)
	};
}

/**
 * Run a tool call and capture either its value or the thrown error, so tests can
 * assert on modelled failure paths without try/catch noise.
 *
 * @param {any} definition - a tool definition exposing `execute`.
 * @param {object} args - tool arguments.
 * @returns {Promise<{value?: any, error?: string}>} the outcome.
 */
export async function call(definition, args) {
	try {
		return { value: await definition.execute(args, { signal: undefined }) };
	} catch (error) {
		return { error: String(error?.message ?? error) };
	}
}

export default { plugin, Context, call };