/**
 * A stand-in speech recogniser, used by the end-to-end test.
 *
 * It accepts the same argument shape a real engine does — an input file, an
 * `--output_dir`, an `--output_format` and a `--language` — and writes a
 * plausible SRT next to the input. Substituting this for a real model keeps the
 * e2e suite fast and offline while still exercising every part of the plugin
 * that matters: argument expansion, process spawn, output discovery, SRT parse.
 *
 * Usage: node mock-asr.mjs <input> --output_dir <dir> [--output_format srt] [--language zh]
 */
import { mkdir, writeFile, stat } from "node:fs/promises";
import { join, basename, extname, resolve } from "node:path";

const args = process.argv.slice(2);
const input = args[0];
const flag = (name) => {
	const at = args.indexOf(name);
	return at === -1 ? undefined : args[at + 1];
};

if (input === undefined) {
	process.stderr.write("mock-asr: no input file given\n");
	process.exit(2);
}
try {
	await stat(input);
} catch {
	process.stderr.write(`mock-asr: cannot read "${input}"\n`);
	process.exit(3);
}

const dir = resolve(flag("--output_dir") ?? ".");
const language = flag("--language") ?? "zh";
await mkdir(dir, { recursive: true });

// Two cues at fixed times, with the language echoed back so the test can prove
// the {lang} placeholder travelled all the way into the child process.
const stem = basename(input, extname(input));
const body = [
	"1",
	"00:00:00,500 --> 00:00:02,000",
	`这是用 ${language} 识别的第一句`,
	"",
	"2",
	"00:00:02,500 --> 00:00:04,000",
	"second cue in latin script",
	""
].join("\n");

const destination = join(dir, `${stem}.srt`);
await writeFile(destination, body, "utf8");

// Some engines also honour an explicit output path; support that too so the
// plugin's {output} placeholder is covered. (`return` is illegal at module top
// level, so this is expressed as a branch.)
const outputFlag = flag("--output");
if (outputFlag !== undefined) {
	await writeFile(resolve(outputFlag), body, "utf8");
	process.stderr.write(`mock-asr: wrote ${outputFlag}\n`);
} else {
	process.stderr.write(`mock-asr: wrote ${destination}\n`);
}