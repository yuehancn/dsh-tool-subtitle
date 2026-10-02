/**
 * Subtitle tooling for a coding agent: read and write timed cues, convert
 * between SRT / WebVTT / ASS, retime a track, and turn audio into cues through a
 * user-configured speech recogniser.
 *
 * This plugin owns the subtitle *format* knowledge (three dialects, each with
 * its own timestamp grammar and escaping rules) and the timeline arithmetic
 * (shifting, scaling, merging overlaps, splitting over-long cues). It shells out
 * only for the transcription step, because which ASR engine you have installed
 * is an environment fact, not something a plugin should assume.
 *
 * Design notes
 * - `subtitle_status` runs first and reports which ASR engine is reachable. A
 *   transcription can take minutes; finding out the engine is missing before
 *   paying that cost is the whole point of having a status tool.
 * - Cue parsing is deliberately lenient: real subtitle files in the wild use a
 *   comma or a dot for the millisecond separator, CRLF or LF, a BOM or not, and
 *   sometimes omit the index line entirely. A strict parser would reject the
 *   file the user actually has.
 * - `subtitle_retime` exists as its own tool because "the subtitles are 2.5s
 *   early and drift by 1%" is a shape that appears constantly when syncing to
 *   separately-produced audio, and it is pure arithmetic over the cue list.
 * - Reading cues back as JSON means the model can *reason* about the timeline
 *   (find gaps, spot overlaps, check reading speed) instead of only dumping text.
 * @module dsh-tool-subtitle
 */
import { mkdir, readFile, writeFile, stat } from "node:fs/promises";
import { join, resolve, basename, extname } from "node:path";
import { spawn } from "node:child_process";
import z from "@deepseek-ai/schemastery";
import { defineTool } from "@deepseek-ai/dsh-tools";

/** Cordis plugin name used by loader diagnostics. */
const name = "tool-subtitle";

/** Services required by the subtitle tool suite. */
const inject = ["tools"];

/** Default cooperative tool-call budget (ms). Transcription is slow, so this is generous. */
const DEFAULT_TIMEOUT_MS = 1800000;

/** Extensions recognised as subtitle files, mapped to their dialect. */
const SUBTITLE_EXTENSIONS = new Map([
	[".srt", "srt"],
	[".vtt", "vtt"],
	[".webvtt", "vtt"],
	[".ass", "ass"],
	[".ssa", "ass"]
]);

/** Extensions recognised as audio, for the transcription path. */
const AUDIO_EXTENSIONS = new Set([".mp3", ".wav", ".flac", ".aac", ".m4a", ".ogg", ".opus", ".wma", ".mp4", ".mkv", ".mov", ".webm"]);

/** Characters that force a hard break inside a cue when wrapping. */
const CJK = /[\u3000-\u303f\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff\uff00-\uffef]/u;

/** One cue's worth of characters, for reading-speed estimation. */
const CJK_CHAR = /[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]/gu;
/** Word-ish runs, for reading-speed estimation on latin scripts. */
const LATIN_WORD = /[A-Za-z\u00c0-\u024f']+/gu;
/** Digit runs, counted separately so "2026年" is 5 units rather than 1. */
const DIGIT_RUN = /\d+/gu;

/* ------------------------------------------------------------------ config */

const Config = z.object({
	/** Directory for produced subtitle files. */
	outputDir: z.string().default("subtitle-output"),
	/** Cooperative tool-call budget attached as `ToolDefinition.timeoutMs`. */
	timeoutMs: z.number().default(DEFAULT_TIMEOUT_MS),
	/** Executable that performs speech recognition. Empty disables transcription. */
	asrCommand: z.string().default(""),
	/** Argument template for `asrCommand`. Supports {input}, {output}, {dir}, {lang}, {model}. */
	asrArgs: z.array(z.string()).default([
		"{input}", "--model", "{model}", "--output_dir", "{dir}",
		"--output_format", "srt", "--language", "{lang}"
	]),
	/** Model name or path passed as {model}. */
	asrModel: z.string().default("large-v3"),
	/** Default recognition language passed as {lang}. */
	asrLanguage: z.string().default("zh"),
	/** Extra env for the ASR process, as "KEY=VALUE" entries. */
	asrEnv: z.array(z.string()).default([]),
	/** Register `subtitle_status`. Defaults to true. */
	status: z.boolean().default(true),
	/** Register `subtitle_read`. Defaults to true. */
	read: z.boolean().default(true),
	/** Register `subtitle_write`. Defaults to true. */
	write: z.boolean().default(true),
	/** Register `subtitle_convert`. Defaults to true. */
	convert: z.boolean().default(true),
	/** Register `subtitle_retime`. Defaults to true. */
	retime: z.boolean().default(true),
	/** Register `subtitle_transcribe`. Defaults to true. */
	transcribe: z.boolean().default(true),
	/** Register `subtitle_check`. Defaults to true. */
	check: z.boolean().default(true),
	/** Cues longer than this many seconds are flagged by `subtitle_check`. */
	maxCueSeconds: z.number().default(7),
	/** Cues shorter than this many seconds are flagged by `subtitle_check`. */
	minCueSeconds: z.number().default(0.8),
	/** Reading speed (CJK chars or latin words per second) above which a cue is flagged. */
	maxCharsPerSecond: z.number().default(9),
	/** Upper bound on cues one call may return inline. */
	maxCues: z.number().default(500)
});

/* --------------------------------------------------------------- timestamp */

/**
 * Parse a subtitle timestamp in any of the three dialects into seconds.
 *
 * Accepts `HH:MM:SS,mmm` (SRT), `HH:MM:SS.mmm` (VTT), `H:MM:SS.cc` (ASS) and
 * the relaxed `MM:SS` form some tools emit. Returns `undefined` when the text
 * is not a timestamp, so callers can skip a malformed line instead of throwing
 * on a file that is 99% fine.
 *
 * @param {string} text - the candidate timestamp.
 * @returns {number|undefined} seconds, or undefined when unparseable.
 */
function parseTimestamp(text) {
	if (typeof text !== "string") return undefined;
	const trimmed = text.trim();
	// ASS uses a single-digit hour and centiseconds; the others use two-digit
	// hours and milliseconds. One grammar covers both: the final group is read
	// as a fraction whose width decides its scale.
	const match = /^(?:(\d+):)?(\d{1,2}):(\d{1,2})(?:[.,](\d{1,3}))?$/u.exec(trimmed);
	if (match === null) return undefined;
	const [, hours, minutes, seconds, fraction] = match;
	const h = Number(hours ?? 0);
	const m = Number(minutes);
	const s = Number(seconds);
	if (m > 59 || s > 59) return undefined;
	let millis = 0;
	if (fraction !== undefined) {
		// "5" -> 500ms, "05" -> 50ms, "500" -> 500ms. Pad to 3 digits.
		millis = Number(fraction.padEnd(3, "0"));
	}
	return h * 3600 + m * 60 + s + millis / 1000;
}

/**
 * Render seconds as an SRT timestamp (`HH:MM:SS,mmm`). Negative values clamp to
 * zero, because a negative timestamp is never valid in any dialect and silently
 * emitting one produces a file players reject.
 *
 * @param {number} seconds - the time in seconds.
 * @returns {string} the formatted timestamp.
 */
function formatTimestamp(seconds) {
	const clamped = Math.max(0, seconds);
	const total = Math.round(clamped * 1000);
	const millis = total % 1000;
	const totalSeconds = (total - millis) / 1000;
	const s = totalSeconds % 60;
	const m = Math.floor(totalSeconds / 60) % 60;
	const h = Math.floor(totalSeconds / 3600);
	return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")},${String(millis).padStart(3, "0")}`;
}

/** Render seconds as a WebVTT timestamp (`HH:MM:SS.mmm`). */
function formatVttTimestamp(seconds) {
	return formatTimestamp(seconds).replace(",", ".");
}

/** Render seconds as an ASS timestamp (`H:MM:SS.cc`, centiseconds). */
function formatAssTimestamp(seconds) {
	const clamped = Math.max(0, seconds);
	const total = Math.round(clamped * 100);
	const centis = total % 100;
	const totalSeconds = (total - centis) / 100;
	const s = totalSeconds % 60;
	const m = Math.floor(totalSeconds / 60) % 60;
	const h = Math.floor(totalSeconds / 3600);
	return `${h}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}.${String(centis).padStart(2, "0")}`;
}

/* ------------------------------------------------------------------ parsing */

/**
 * Parse a subtitle file into a dialect-tagged cue list.
 *
 * @param {string} text - the raw file contents.
 * @param {string} dialect - `srt`, `vtt` or `ass`.
 * @returns {{dialect: string, cues: Array<{index: number, start: number, end: number, text: string, style?: string, actor?: string}>, styles: string[]}} the parsed track.
 */
function parseSubtitle(text, dialect) {
	const clean = text.replace(/^\uFEFF/u, "").replace(/\r\n?/gu, "\n");
	if (dialect === "ass") return parseAss(clean);
	return parseCues(clean, dialect);
}

/**
 * Parse SRT or VTT. Both are "blocks separated by a blank line, each block
 * holding an optional index, a timing line, then one or more text lines" — the
 * only differences are the timestamp separator and the VTT header.
 *
 * @param {string} text - normalised text.
 * @param {string} dialect - `srt` or `vtt`.
 * @returns {{dialect: string, cues: object[], styles: string[]}} the parsed track.
 */
function parseCues(text, dialect) {
	const cues = [];
	const blocks = text.split(/\n{2,}/u);
	for (const rawBlock of blocks) {
		const block = rawBlock.trim();
		if (block.length === 0) continue;
		if (/^WEBVTT/u.test(block)) continue;
		if (/^(NOTE|STYLE|REGION)\b/u.test(block)) continue;
		const lines = block.split("\n");
		// The timing line is the one containing "-->". Everything before it is an
		// index or a VTT cue id; everything after is the payload.
		const timingIndex = lines.findIndex((line) => line.includes("-->"));
		if (timingIndex === -1) continue;
		const timing = /^\s*(\S+)\s*-->\s*(\S+)/u.exec(lines[timingIndex]);
		if (timing === null) continue;
		const start = parseTimestamp(timing[1]);
		const end = parseTimestamp(timing[2]);
		if (start === undefined || end === undefined) continue;
		const idLine = timingIndex > 0 ? lines[0].trim() : "";
		const payload = lines.slice(timingIndex + 1).join("\n").trim();
		cues.push({
			index: cues.length + 1,
			start,
			end,
			text: payload,
			...(idLine.length > 0 && !/^\d+$/u.test(idLine) ? { id: idLine } : {})
		});
	}
	return { dialect, cues, styles: [] };
}

/**
 * Parse an ASS/SSA file. Cue text lives in the `Text` field of `Dialogue`
 * lines, and the field *order* is declared once in the `Format:` line — reading
 * it positionally is the only correct approach, since real files reorder fields.
 *
 * @param {string} text - normalised text.
 * @returns {{dialect: string, cues: object[], styles: string[], format: object}} the parsed track.
 */
function parseAss(text) {
	const cues = [];
	const styles = [];
	let dialogueFormat = null;
	let inEvents = false;
	for (const line of text.split("\n")) {
		const trimmed = line.trim();
		if (trimmed.startsWith("[")) {
			// Events is the only section whose Dialogue lines carry cue text.
			inEvents = /^\[events\]$/iu.test(trimmed);
			continue;
		}
		if (/^Format\s*:/iu.test(trimmed)) {
			const fields = trimmed.slice(trimmed.indexOf(":") + 1).split(",").map((part) => part.trim().toLowerCase());
			if (inEvents && fields.includes("text")) dialogueFormat = fields;
			continue;
		}
		if (/^Style\s*:/iu.test(trimmed) && !inEvents) {
			// Strip the "Style:" label before splitting, otherwise field 0 holds
			// "Style: <name>" and the name shifts one slot to the right.
			const fields = trimmed.slice(trimmed.indexOf(":") + 1).split(",").map((part) => part.trim());
			if (fields.length > 0 && fields[0].length > 0) styles.push(fields[0]);
			continue;
		}
		if (!inEvents || !/^Dialogue\s*:/iu.test(trimmed)) continue;
		const format = dialogueFormat ?? ["layer", "start", "end", "style", "name", "marginl", "marginr", "marginv", "effect", "text"];
		const body = trimmed.slice(trimmed.indexOf(":") + 1);
		// `Text` is always last and may itself contain commas, so split with a
		// limit and let the final field absorb the remainder.
		const parts = splitAssFields(body, format.length);
		const value = (key) => {
			const at = format.indexOf(key);
			return at === -1 ? undefined : parts[at];
		};
		const start = parseTimestamp(value("start") ?? "");
		const end = parseTimestamp(value("end") ?? "");
		if (start === undefined || end === undefined) continue;
		cues.push({
			index: cues.length + 1,
			start,
			end,
			text: (value("text") ?? "").replace(/\\N/gu, "\n").replace(/\{[^}]*\}/gu, "").trim(),
			style: value("style"),
			actor: value("name")
		});
	}
	return { dialect: "ass", cues, styles, format: { fields: dialogueFormat ?? [] } };
}

/**
 * Split an ASS Dialogue body into exactly `count` fields, letting the last field
 * keep any commas of its own.
 *
 * @param {string} body - the text after the `Dialogue:` label.
 * @param {number} count - the number of declared fields.
 * @returns {string[]} the field values.
 */
function splitAssFields(body, count) {
	const parts = [];
	let rest = body;
	for (let index = 0; index < count - 1; index += 1) {
		const comma = rest.indexOf(",");
		if (comma === -1) {
			parts.push(rest.trim());
			rest = "";
			continue;
		}
		parts.push(rest.slice(0, comma).trim());
		rest = rest.slice(comma + 1);
	}
	parts.push(rest.trim());
	while (parts.length < count) parts.push("");
	return parts;
}

/* --------------------------------------------------------------- formatting */

/**
 * Render a cue list as a subtitle file in the requested dialect.
 *
 * @param {object[]} cues - the cue list.
 * @param {string} dialect - `srt`, `vtt` or `ass`.
 * @param {{title?: string, styles?: string[]}} [options] - dialect-specific header options.
 * @returns {string} the serialised file contents.
 */
function formatSubtitle(cues, dialect, options = {}) {
	if (dialect === "vtt") {
		const header = ["WEBVTT", ...(options.title === undefined ? [] : [`NOTE ${options.title}`])];
		const blocks = cues.map((cue) =>
			`${cue.index}\n${formatVttTimestamp(cue.start)} --> ${formatVttTimestamp(cue.end)}\n${cue.text}`);
		return `${header.join("\n")}\n\n${blocks.join("\n\n")}\n`;
	}
	if (dialect === "ass") {
		const styleNames = options.styles !== undefined && options.styles.length > 0 ? options.styles : ["Default"];
		const head = [
			"[Script Info]",
			"; Generated by dsh-tool-subtitle",
			`Title: ${options.title ?? "Untitled"}`,
			"ScriptType: v4.00+",
			"WrapStyle: 0",
			"ScaledBorderAndShadow: yes",
			"YCbCr Matrix: TV.601",
			"",
			"[V4+ Styles]",
			"Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding",
			...styleNames.map((styleName) =>
				`Style: ${styleName},Arial,48,&H00FFFFFF,&H000000FF,&H00000000,&H00000000,0,0,0,0,100,100,0,0,1,2,1,2,20,20,30,1`),
			"",
			"[Events]",
			"Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text"
		];
		const events = cues.map((cue) =>
			`Dialogue: 0,${formatAssTimestamp(cue.start)},${formatAssTimestamp(cue.end)},${cue.style ?? styleNames[0]},${cue.actor ?? ""},0,0,0,,${cue.text.replace(/\n/gu, "\\N")}`);
		return `${[...head, ...events].join("\n")}\n`;
	}
	// SRT: index, timing, text. Blank line between blocks.
	return `${cues.map((cue) =>
		`${cue.index}\n${formatTimestamp(cue.start)} --> ${formatTimestamp(cue.end)}\n${cue.text}`).join("\n\n")}\n`;
}

/* ---------------------------------------------------------------- timeline */

/**
 * Count the "reading units" in a cue: CJK characters, latin words, and digits.
 * Digits are counted per character because a viewer reads "2026" as four
 * symbols, not as one word, and reading-speed limits are per-symbol.
 *
 * @param {string} text - the cue text.
 * @returns {number} the unit count.
 */
function readingUnits(text) {
	const cjk = text.match(CJK_CHAR)?.length ?? 0;
	// Strip digits before the latin pass so a token like "abc123" does not count
	// its digits twice (once inside the word, once on their own).
	const latin = text.replace(DIGIT_RUN, " ").match(LATIN_WORD)?.length ?? 0;
	const digits = text.match(/\d/gu)?.length ?? 0;
	return cjk + latin + digits;
}

/**
 * Renumber cues sequentially and sort them by start time, since retiming can
 * reorder a track and players rely on the index matching the order.
 *
 * @param {object[]} cues - the cue list.
 * @returns {object[]} a sorted, renumbered copy.
 */
function normaliseCues(cues) {
	return [...cues]
		.sort((left, right) => left.start - right.start || left.end - right.end)
		.map((cue, index) => ({ ...cue, index: index + 1 }));
}

/**
 * Shift every cue by a constant, and optionally scale its start times by a
 * factor. A drift correction is "the track runs 1.5% long from t=0", i.e.
 * `time * factor + offset` — which is why the two belong in one operation.
 *
 * @param {object[]} cues - the cue list.
 * @param {number} offsetSeconds - added to both start and end.
 * @param {number} [factor] - multiplies both start and end before the offset.
 * @returns {object[]} the retimed cue list.
 */
function retimeCues(cues, offsetSeconds, factor = 1) {
	return normaliseCues(cues.map((cue) => ({
		...cue,
		start: cue.start * factor + offsetSeconds,
		end: cue.end * factor + offsetSeconds
	}))).map((cue) => ({
		...cue,
		// A cue can become zero-length or inverted after a shrink; give it the
		// minimum span a player will render rather than emitting garbage.
		end: cue.end <= cue.start ? cue.start + 0.04 : cue.end
	}));
}

/**
 * Split cues that run longer than `maxSeconds` at their text's natural
 * boundaries, distributing the original time span in proportion to the number
 * of characters in each piece. Surfacing this as a tool matters because
 * over-long cues are the most common defect in machine-generated subtitles.
 *
 * @param {object[]} cues - the cue list.
 * @param {number} maxSeconds - the longest a cue may be.
 * @returns {object[]} the split cue list.
 */
function splitLongCues(cues, maxSeconds) {
	const out = [];
	for (const cue of cues) {
		const span = cue.end - cue.start;
		if (span <= maxSeconds || cue.text.trim().length === 0) {
			out.push(cue);
			continue;
		}
		const pieces = wrapText(cue.text, Math.ceil(readingUnits(cue.text) / Math.max(1, Math.ceil(span / maxSeconds))));
		const totalUnits = pieces.reduce((sum, piece) => sum + Math.max(1, readingUnits(piece)), 0);
		let cursor = cue.start;
		for (const piece of pieces) {
			const share = (Math.max(1, readingUnits(piece)) / totalUnits) * span;
			out.push({ ...cue, start: cursor, end: Math.min(cue.end, cursor + share), text: piece });
			cursor += share;
		}
	}
	return normaliseCues(out);
}

/**
 * Wrap a cue's text to at most `maxUnits` reading units per line cluster,
 * preferring to break after sentence-final punctuation and never breaking in
 * the middle of a latin word.
 *
 * @param {string} text - the cue text.
 * @param {number} maxUnits - the target units per produced piece.
 * @returns {string[]} one or more pieces, each already line-broken.
 */
function wrapText(text, maxUnits) {
	const clean = text.replace(/\s+/gu, " ").trim();
	if (clean.length === 0) return [];
	const target = Math.max(4, Math.round(maxUnits));
	const pieces = [];
	let current = "";
	for (const char of [...clean]) {
		current += char;
		const atBreak = /[。！？!?；;]/u.test(char) || (CJK.test(char) === false && char === " ");
		if (atBreak && readingUnits(current) >= target * 0.6) {
			pieces.push(current.trim());
			current = "";
		} else if (readingUnits(current) >= target) {
			pieces.push(current.trim());
			current = "";
		}
	}
	if (current.trim().length > 0) pieces.push(current.trim());
	return pieces.length === 0 ? [clean] : pieces;
}

/**
 * Merge cues that overlap in time, joining their text. Overlapping cues are
 * legal in some dialects but render as a jumble in most players.
 *
 * @param {object[]} cues - the cue list.
 * @returns {object[]} the merged cue list.
 */
function mergeOverlaps(cues) {
	const sorted = normaliseCues(cues);
	const out = [];
	for (const cue of sorted) {
		const last = out[out.length - 1];
		if (last !== undefined && cue.start < last.end) {
			last.end = Math.max(last.end, cue.end);
			last.text = `${last.text}\n${cue.text}`;
			continue;
		}
		out.push({ ...cue });
	}
	return normaliseCues(out);
}

/* ------------------------------------------------------------------ checks */

/**
 * Report timeline defects the model should fix before rendering.
 *
 * @param {object[]} cues - the cue list.
 * @param {{maxCueSeconds: number, minCueSeconds: number, maxCharsPerSecond: number}} limits - the thresholds.
 * @returns {{issues: object[], summary: object}} findings, worst-first.
 */
function checkCues(cues, limits) {
	const issues = [];
	for (const cue of cues) {
		const span = cue.end - cue.start;
		const units = readingUnits(cue.text);
		if (span <= 0) {
			issues.push({ kind: "non-positive-duration", index: cue.index, detail: `span is ${span.toFixed(3)}s` });
			continue;
		}
		if (span > limits.maxCueSeconds) {
			issues.push({ kind: "too-long", index: cue.index, detail: `${span.toFixed(2)}s > ${limits.maxCueSeconds}s`, start: cue.start });
		}
		if (span < limits.minCueSeconds) {
			issues.push({ kind: "too-short", index: cue.index, detail: `${span.toFixed(2)}s < ${limits.minCueSeconds}s`, start: cue.start });
		}
		const speed = units / span;
		if (speed > limits.maxCharsPerSecond) {
			issues.push({ kind: "too-fast", index: cue.index, detail: `${speed.toFixed(1)}/s > ${limits.maxCharsPerSecond}/s`, start: cue.start });
		}
		if (cue.text.trim().length === 0) {
			issues.push({ kind: "empty-text", index: cue.index, detail: "no text" });
		}
	}
	// Traditional-character detection: an ASR engine configured for Chinese
	// sometimes emits Traditional script, which then ships to a Simplified
	// audience. Flagging it here is cheaper than discovering it after render.
	const traditional = cues.filter((cue) => /[繁體後裏為與說時間點問題]/u.test(cue.text));
	if (traditional.length > 0) {
		issues.push({
			kind: "possible-traditional-chinese",
			index: traditional[0].index,
			detail: `${traditional.length} cue(s) contain Traditional-only characters; run a Simplified conversion if this track targets zh-Hans`
		});
	}
	const sorted = [...cues].sort((left, right) => left.start - right.start);
	for (let at = 1; at < sorted.length; at += 1) {
		if (sorted[at].start < sorted[at - 1].end - 0.001) {
			issues.push({ kind: "overlap", index: sorted[at].index, detail: `starts before cue ${sorted[at - 1].index} ends` });
		}
	}
	const duration = cues.reduce((max, cue) => Math.max(max, cue.end), 0);
	return {
		issues,
		summary: {
			cueCount: cues.length,
			duration: Math.round(duration * 1000) / 1000,
			issueCount: issues.length,
			byKind: issues.reduce((acc, issue) => ({ ...acc, [issue.kind]: (acc[issue.kind] ?? 0) + 1 }), {})
		}
	};
}

/* ---------------------------------------------------------------- process */

/**
 * Run a command and capture output with a hard timeout. The non-zero path
 * surfaces the tail of stderr, which for an ASR engine names the real problem
 * (missing model, unsupported codec) far better than a bare exit code.
 *
 * @param {string} command - executable to spawn.
 * @param {string[]} args - argument array (never a shell string).
 * @param {{timeoutMs: number, signal?: AbortSignal, cwd?: string, env?: Record<string, string>}} options - run options.
 * @returns {Promise<{stdout: string, stderr: string, code: number}>} captured result.
 */
function runCommand(command, args, options) {
	return new Promise((resolvePromise, reject) => {
		let child;
		try {
			child = spawn(command, args, {
				cwd: options.cwd,
				windowsHide: true,
				shell: false,
				env: options.env === undefined ? undefined : { ...process.env, ...options.env }
			});
		} catch (error) {
			reject(new Error(`subtitle: cannot start "${command}" (${error?.message ?? error}). Check asrCommand in the plugin config.`));
			return;
		}
		let stdout = "";
		let stderr = "";
		let settled = false;
		const finish = (fn, value) => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			options.signal?.removeEventListener("abort", onAbort);
			fn(value);
		};
		const timer = setTimeout(() => {
			child.kill("SIGKILL");
			finish(reject, new Error(`subtitle: "${command}" exceeded its ${Math.round(options.timeoutMs / 1000)}s budget. Long audio needs a higher timeoutMs, or a faster model.`));
		}, options.timeoutMs);
		const onAbort = () => {
			child.kill("SIGKILL");
			finish(reject, options.signal?.reason ?? new Error("aborted"));
		};
		options.signal?.addEventListener("abort", onAbort, { once: true });

		child.stdout?.on("data", (chunk) => { stdout += chunk.toString(); });
		child.stderr?.on("data", (chunk) => { stderr += chunk.toString(); });
		child.on("error", (error) => {
			finish(reject, new Error(`subtitle: "${command}" failed to run (${error?.message ?? error}). Configure asrCommand to a speech-recognition executable.`));
		});
		child.on("close", (code) => {
			if (code !== 0) {
				const tail = stderr.trim().split(/\r?\n/u).slice(-6).join("\n");
				finish(reject, new Error(`subtitle: "${command}" exited with code ${code}.\n${tail.slice(0, 600) || "(no stderr)"}`));
				return;
			}
			finish(resolvePromise, { stdout, stderr, code: code ?? 0 });
		});
	});
}

/** Expand `{placeholder}` tokens in an argument template. */
function expandArgs(template, values) {
	return template.map((arg) =>
		arg.replace(/\{(\w+)\}/gu, (whole, key) => (key in values ? String(values[key]) : whole)));
}

/** Probe whether the ASR executable is runnable, without doing any work. */
async function probeAsr(command, env) {
	if (command.length === 0) return { available: false, error: "asrCommand is not configured" };
	try {
		const { stdout, stderr } = await runCommand(command, ["--help"], { timeoutMs: 20000, env });
		const text = `${stdout}${stderr}`.trim();
		return { available: true, version: text.split(/\r?\n/u)[0]?.slice(0, 160) ?? "" };
	} catch (error) {
		// Many CLIs exit non-zero for --help; treat "ran at all" as reachable.
		const message = String(error?.message ?? error);
		if (/exited with code/u.test(message)) return { available: true, version: "(ran, but --help exited non-zero)" };
		return { available: false, error: message };
	}
}

/** Parse "KEY=VALUE" entries into an env object, ignoring malformed ones. */
function parseEnvEntries(entries) {
	const env = {};
	for (const entry of entries) {
		const at = entry.indexOf("=");
		if (at <= 0) continue;
		env[entry.slice(0, at)] = entry.slice(at + 1);
	}
	return env;
}

/* ------------------------------------------------------------------- tools */

/** Model-facing text for a parsed track. */
function formatTrack(value) {
	const lines = [`${value.path} — ${value.cueCount} cue(s), ${humanClock(value.duration)} (${value.dialect})`];
	for (const cue of value.cues) {
		lines.push(`[${cue.index}] ${formatTimestamp(cue.start)} → ${formatTimestamp(cue.end)}  ${cue.text.replace(/\n/gu, " / ")}`);
	}
	if (value.truncated === true) lines.push(`… ${value.cueCount - value.cues.length} more cue(s) not shown (raise maxCues to see them).`);
	return lines.join("\n");
}

/** Format seconds as `M:SS` or `H:MM:SS`. */
function humanClock(seconds) {
	const total = Math.round(seconds);
	const h = Math.floor(total / 3600);
	const m = Math.floor((total % 3600) / 60);
	const s = total % 60;
	return h > 0 ? `${h}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}` : `${m}:${String(s).padStart(2, "0")}`;
}

/**
 * Register the enabled subtitle tools.
 *
 * @param {import("@deepseek-ai/cordis").Context} ctx - context whose `tools` registry receives the tools.
 * @param {z.infer<typeof Config>} config - resolved plugin config.
 */
function apply(ctx, config) {
	const outputDir = resolve(config.outputDir);
	const budgetMs = config.timeoutMs;
	const asrEnv = parseEnvEntries(config.asrEnv);

	/** Resolve an output path and make sure its directory exists. */
	async function outPath(fileName) {
		await mkdir(outputDir, { recursive: true });
		return join(outputDir, fileName);
	}

	/** Load and parse a subtitle file from disk. */
	async function loadTrack(path) {
		const source = await requireFile(path);
		const dialect = SUBTITLE_EXTENSIONS.get(extname(source).toLowerCase());
		if (dialect === undefined) {
			throw new Error(`subtitle: "${basename(source)}" is not a subtitle file. Recognised extensions: ${[...SUBTITLE_EXTENSIONS.keys()].join(", ")}.`);
		}
		const text = await readFile(source, "utf8");
		const parsed = parseSubtitle(text, dialect);
		if (parsed.cues.length === 0) {
			throw new Error(`subtitle: no cues could be parsed from "${basename(source)}" as ${dialect}. Check the file's timing lines (they should contain "-->").`);
		}
		return { source, dialect, ...parsed };
	}

	/* -- subtitle_status --------------------------------------------------- */
	if (config.status) {
		ctx.tools.register(defineTool({
			name: "subtitle_status",
			description: "Report which speech-recognition engine (if any) this plugin can reach, plus the subtitle dialects it can read and write. Check this before a long transcription.",
			parameters: {},
			output: {
				schema: {
					type: "object",
					additionalProperties: false,
					properties: {
						asr: {
							type: "object",
							required: true,
							additionalProperties: false,
							properties: {
								command: { type: "string", required: true },
								configured: { type: "boolean", required: true },
								available: { type: "boolean", required: true },
								model: { type: "string" },
								language: { type: "string" },
								version: { type: "string" },
								error: { type: "string" }
							}
						},
						dialects: { type: "array", required: true, items: { type: "string" } },
						outputDir: { type: "string", required: true }
					}
				},
				render: (_args, value) => [{
					type: "text",
					text: [
						value.asr.configured === false
							? "ASR: NOT CONFIGURED — set asrCommand in the plugin config to enable subtitle_transcribe."
							: `ASR: ${value.asr.available ? "AVAILABLE" : "UNREACHABLE"} — ${value.asr.command}${value.asr.version === undefined ? "" : ` (${value.asr.version})`}`,
						...(value.asr.error === undefined ? [] : [`  ${value.asr.error}`]),
						`  model: ${value.asr.model ?? "(unset)"} | language: ${value.asr.language ?? "(unset)"}`,
						`Dialects: ${value.dialects.join(", ")}`,
						`Output directory: ${value.outputDir}`
					].join("\n")
				}]
			},
			timeoutMs: 60000,
			isConcurrencySafe: () => true,
			async execute() {
				const probed = config.asrCommand.length === 0
					? { available: false, error: "asrCommand is not configured" }
					: await probeAsr(config.asrCommand, asrEnv);
				return {
					asr: {
						command: config.asrCommand,
						configured: config.asrCommand.length > 0,
						model: config.asrModel,
						language: config.asrLanguage,
						...probed
					},
					dialects: [...new Set(SUBTITLE_EXTENSIONS.values())],
					outputDir
				};
			},
			presentCall: () => ({ card: "generic", title: "Subtitle capability", kind: "other", rawInput: {} })
		}));
	}

	/* -- subtitle_read ----------------------------------------------------- */
	if (config.read) {
		ctx.tools.register(defineTool({
			name: "subtitle_read",
			description: "Read a subtitle file into structured cues with numeric start/end times, so you can reason about the timeline instead of only reading text.",
			parameters: {
				path: { type: "string", required: true, description: "Absolute path to an .srt, .vtt or .ass file." },
				offset: { type: "integer", description: "Skip this many cues (for paging through a long track)." },
				limit: { type: "integer", description: `Return at most this many cues (capped by the plugin's maxCues of ${config.maxCues}).` }
			},
			output: {
				schema: {
					type: "object",
					additionalProperties: false,
					properties: {
						path: { type: "string", required: true },
						dialect: { type: "string", required: true },
						cueCount: { type: "integer", required: true },
						duration: { type: "number", required: true },
						truncated: { type: "boolean" },
						cues: {
							type: "array",
							required: true,
							items: {
								type: "object",
								additionalProperties: false,
								properties: {
									index: { type: "integer", required: true },
									start: { type: "number", required: true },
									end: { type: "number", required: true },
									text: { type: "string", required: true }
								}
							}
						}
					}
				},
				render: (_args, value) => [{ type: "text", text: formatTrack(value) }]
			},
			timeoutMs: 60000,
			isConcurrencySafe: () => true,
			async execute(args) {
				const track = await loadTrack(args.path);
				const offset = Math.max(0, args.offset ?? 0);
				const limit = Math.min(args.limit ?? 200, config.maxCues);
				const cues = track.cues.slice(offset, offset + limit).map((cue) => ({
					index: cue.index, start: Math.round(cue.start * 1000) / 1000,
					end: Math.round(cue.end * 1000) / 1000, text: cue.text
				}));
				return {
					path: track.source,
					dialect: track.dialect,
					cueCount: track.cues.length,
					duration: Math.round(Math.max(...track.cues.map((cue) => cue.end)) * 1000) / 1000,
					...offset + limit < track.cues.length ? { truncated: true } : {},
					cues
				};
			},
			presentCall: (args) => ({ card: "generic", title: `Read ${basename(args.path ?? "subtitle")}`, kind: "other", rawInput: args })
		}));
	}

	/* -- subtitle_write ---------------------------------------------------- */
	if (config.write) {
		ctx.tools.register(defineTool({
			name: "subtitle_write",
			description: "Write a cue list to a subtitle file. Pass cues as either structured objects or the plain text of an SRT block per cue.",
			parameters: {
				dialect: { type: "string", required: true, description: "Output dialect: srt, vtt or ass." },
				cues: {
					type: "array",
					required: true,
					description: "Cues in order. Each is {start, end, text} with start/end as seconds or SRT/VTT timestamp strings; an SRT block passed as a bare string is also accepted.",
					items: {
						type: "object",
						additionalProperties: false,
						properties: {
							start: { required: true, description: "Seconds, or an SRT/VTT timestamp string.", oneOf: [{ type: "number" }, { type: "string" }] },
							end: { required: true, description: "Seconds, or an SRT/VTT timestamp string.", oneOf: [{ type: "number" }, { type: "string" }] },
							text: { type: "string", required: true },
							style: { type: "string", description: "ASS style name, when writing an .ass file." }
						}
					}
				},
				outputName: { type: "string", description: "Output filename. Defaults to cues.<dialect> in the output directory." },
				title: { type: "string", description: "Track title, written into the VTT/ASS header." },
				mergeOverlaps: { type: "boolean", description: "Merge cues that overlap in time before writing. Defaults to false." },
				splitLongerThan: { type: "number", description: "Split cues longer than this many seconds into proportionally-timed pieces." }
			},
			output: {
				schema: {
					type: "object",
					additionalProperties: false,
					properties: {
						outputPath: { type: "string", required: true },
						dialect: { type: "string", required: true },
						cueCount: { type: "integer", required: true },
						duration: { type: "number", required: true },
						sizeBytes: { type: "integer" }
					}
				},
				render: (_args, value) => [{
					type: "text",
					text: `Wrote ${value.cueCount} cue(s) to ${value.outputPath} (${value.dialect}, ${humanClock(value.duration)}).`
				}]
			},
			timeoutMs: 60000,
			async execute(args) {
				const dialect = String(args.dialect).toLowerCase();
				if (!["srt", "vtt", "ass"].includes(dialect)) {
					throw new Error(`subtitle: dialect must be srt, vtt or ass; got "${args.dialect}".`);
				}
				let cues = coerceCues(args.cues);
				if (args.mergeOverlaps === true) cues = mergeOverlaps(cues);
				if (args.splitLongerThan !== undefined) cues = splitLongCues(cues, args.splitLongerThan);
				cues = normaliseCues(cues);
				if (cues.length === 0) throw new Error("subtitle: no usable cues were passed. Each cue needs {start, end, text}.");

				const extension = dialect === "ass" ? "ass" : dialect;
				const destination = await outPath(args.outputName ?? `cues.${extension}`);
				const body = formatSubtitle(cues, dialect, args.title === undefined ? {} : { title: args.title });
				await writeFile(destination, body, "utf8");
				const info = await stat(destination).catch(() => undefined);
				return {
					outputPath: destination,
					dialect,
					cueCount: cues.length,
					duration: Math.round(Math.max(...cues.map((cue) => cue.end)) * 1000) / 1000,
					...info === undefined ? {} : { sizeBytes: info.size }
				};
			},
			presentCall: (args) => {
				const count = Array.isArray(args.cues) ? args.cues.length : 0;
				const dialect = args.dialect ?? "?";
				return { card: "generic", title: `Write ${count} cue(s) as ${dialect}`, kind: "other", rawInput: { dialect: args.dialect, outputName: args.outputName } };
			}
		}));
	}

	/* -- subtitle_convert -------------------------------------------------- */
	if (config.convert) {
		ctx.tools.register(defineTool({
			name: "subtitle_convert",
			description: "Convert a subtitle file between SRT, WebVTT and ASS, optionally retiming or cleaning the timeline as it goes.",
			parameters: {
				path: { type: "string", required: true, description: "Absolute path to the source subtitle file." },
				dialect: { type: "string", required: true, description: "Output dialect: srt, vtt or ass." },
				outputName: { type: "string", description: "Output filename." },
				offsetSeconds: { type: "number", description: "Shift every cue by this many seconds (negative to make them earlier)." },
				factor: { type: "number", description: "Scale cue times by this factor before shifting (e.g. 1.015 to correct 1.5% drift)." },
				mergeOverlaps: { type: "boolean", description: "Merge cues that overlap before writing." },
				splitLongerThan: { type: "number", description: "Split cues longer than this many seconds." }
			},
			output: {
				schema: {
					type: "object",
					additionalProperties: false,
					properties: {
						source: { type: "string", required: true },
						from: { type: "string", required: true },
						to: { type: "string", required: true },
						outputPath: { type: "string", required: true },
						cueCount: { type: "integer", required: true },
						duration: { type: "number", required: true },
						sizeBytes: { type: "integer" }
					}
				},
				render: (_args, value) => [{
					type: "text",
					text: `Converted ${value.from} → ${value.to}: ${value.outputPath} (${value.cueCount} cue(s), ${humanClock(value.duration)}).`
				}]
			},
			timeoutMs: 60000,
			async execute(args) {
				const dialect = String(args.dialect).toLowerCase();
				if (!["srt", "vtt", "ass"].includes(dialect)) {
					throw new Error(`subtitle: dialect must be srt, vtt or ass; got "${args.dialect}".`);
				}
				if (args.factor !== undefined && !(args.factor > 0)) {
					throw new Error(`subtitle: factor must be positive; got ${args.factor}.`);
				}
				const track = await loadTrack(args.path);
				let cues = track.cues;
				if (args.factor !== undefined || args.offsetSeconds !== undefined) {
					cues = retimeCues(cues, args.offsetSeconds ?? 0, args.factor ?? 1);
				}
				if (args.mergeOverlaps === true) cues = mergeOverlaps(cues);
				if (args.splitLongerThan !== undefined) cues = splitLongCues(cues, args.splitLongerThan);
				cues = normaliseCues(cues);

				const stem = basename(track.source, extname(track.source));
				const destination = await outPath(args.outputName ?? `${stem}.${dialect}`);
				await writeFile(destination, formatSubtitle(cues, dialect, { title: stem }), "utf8");
				const info = await stat(destination).catch(() => undefined);
				return {
					source: track.source,
					from: track.dialect,
					to: dialect,
					outputPath: destination,
					cueCount: cues.length,
					duration: Math.round(Math.max(...cues.map((cue) => cue.end)) * 1000) / 1000,
					...info === undefined ? {} : { sizeBytes: info.size }
				};
			},
			presentCall: (args) => ({ card: "generic", title: `Convert ${basename(args.path ?? "subtitle")} → ${args.dialect ?? "?"}`, kind: "other", rawInput: args })
		}));
	}

	/* -- subtitle_retime --------------------------------------------------- */
	if (config.retime) {
		ctx.tools.register(defineTool({
			name: "subtitle_retime",
			description: "Shift and/or scale a subtitle timeline to match separately-produced audio, writing a corrected file. Use this to fix constant offsets and drift.",
			parameters: {
				path: { type: "string", required: true, description: "Absolute path to the source subtitle file." },
				offsetSeconds: { type: "number", description: "Added to every cue's time (negative makes cues earlier)." },
				factor: { type: "number", description: "Multiplies every cue's time before the offset (e.g. 1.015)." },
				outputName: { type: "string", description: "Output filename." },
				dialect: { type: "string", description: "Output dialect; defaults to the source dialect." }
			},
			output: {
				schema: {
					type: "object",
					additionalProperties: false,
					properties: {
						outputPath: { type: "string", required: true },
						dialect: { type: "string", required: true },
						offsetSeconds: { type: "number", required: true },
						factor: { type: "number", required: true },
						cueCount: { type: "integer", required: true },
						firstCueBefore: { type: "number", required: true },
						firstCueAfter: { type: "number", required: true },
						lastCueBefore: { type: "number", required: true },
						lastCueAfter: { type: "number", required: true }
					}
				},
				render: (_args, value) => [{
					type: "text",
					text: [
						`Retimed ${value.cueCount} cue(s): ${value.outputPath}`,
						`offset ${value.offsetSeconds}s | factor ${value.factor}`,
						`first cue ${formatTimestamp(value.firstCueBefore)} → ${formatTimestamp(value.firstCueAfter)}`,
						`last cue  ${formatTimestamp(value.lastCueBefore)} → ${formatTimestamp(value.lastCueAfter)}`
					].join("\n")
				}]
			},
			timeoutMs: 60000,
			async execute(args) {
				if (args.offsetSeconds === undefined && args.factor === undefined) {
					throw new Error("subtitle: pass at least one of offsetSeconds or factor, otherwise nothing would change.");
				}
				if (args.factor !== undefined && !(args.factor > 0)) {
					throw new Error(`subtitle: factor must be positive; got ${args.factor}.`);
				}
				const track = await loadTrack(args.path);
				const outputDialect = args.dialect === undefined ? track.dialect : String(args.dialect).toLowerCase();
				if (!["srt", "vtt", "ass"].includes(outputDialect)) {
					throw new Error(`subtitle: dialect must be srt, vtt or ass; got "${args.dialect}".`);
				}
				const cues = retimeCues(track.cues, args.offsetSeconds ?? 0, args.factor ?? 1);
				const stem = basename(track.source, extname(track.source));
				const destination = await outPath(args.outputName ?? `${stem}.retimed.${outputDialect}`);
				await writeFile(destination, formatSubtitle(cues, outputDialect, { title: stem }), "utf8");

				const sorted = [...track.cues].sort((left, right) => left.start - right.start);
				return {
					outputPath: destination,
					dialect: outputDialect,
					offsetSeconds: args.offsetSeconds ?? 0,
					factor: args.factor ?? 1,
					cueCount: cues.length,
					firstCueBefore: Math.round(sorted[0].start * 1000) / 1000,
					firstCueAfter: Math.round(cues[0].start * 1000) / 1000,
					lastCueBefore: Math.round(sorted[sorted.length - 1].end * 1000) / 1000,
					lastCueAfter: Math.round(cues[cues.length - 1].end * 1000) / 1000
				};
			},
			presentCall: (args) => ({ card: "generic", title: `Retime ${basename(args.path ?? "subtitle")}`, kind: "other", rawInput: args })
		}));
	}

	/* -- subtitle_check ---------------------------------------------------- */
	if (config.check) {
		ctx.tools.register(defineTool({
			name: "subtitle_check",
			description: "Audit a subtitle timeline for over-long cues, cues that are too fast to read, overlaps, gaps and empty text, before rendering or publishing.",
			parameters: {
				path: { type: "string", required: true, description: "Absolute path to the subtitle file." }
			},
			output: {
				schema: {
					type: "object",
					additionalProperties: false,
					properties: {
						path: { type: "string", required: true },
						cueCount: { type: "integer", required: true },
						duration: { type: "number", required: true },
						issueCount: { type: "integer", required: true },
						byKind: { type: "object", additionalProperties: true },
						issues: {
							type: "array",
							required: true,
							items: {
								type: "object",
								additionalProperties: false,
								properties: {
									kind: { type: "string", required: true },
									index: { type: "integer", required: true },
									detail: { type: "string", required: true },
									start: { type: "number" }
								}
							}
						}
					}
				},
				render: (_args, value) => [{
					type: "text",
					text: value.issueCount === 0
						? `${value.path}: clean — ${value.cueCount} cue(s) over ${humanClock(value.duration)}, no issues.`
						: [
							`${value.path}: ${value.issueCount} issue(s) across ${value.cueCount} cue(s) (${humanClock(value.duration)})`,
							...Object.entries(value.byKind).map(([kind, count]) => `  ${kind}: ${count}`),
							...value.issues.slice(0, 25).map((issue) => `  [#${issue.index}] ${issue.kind} — ${issue.detail}`)
						].join("\n")
				}]
			},
			timeoutMs: 60000,
			isConcurrencySafe: () => true,
			async execute(args) {
				const track = await loadTrack(args.path);
				const result = checkCues(track.cues, {
					maxCueSeconds: config.maxCueSeconds,
					minCueSeconds: config.minCueSeconds,
					maxCharsPerSecond: config.maxCharsPerSecond
				});
				return { path: track.source, ...result.summary, issues: result.issues.slice(0, 200) };
			},
			presentCall: (args) => ({ card: "generic", title: `Check ${basename(args.path ?? "subtitle")}`, kind: "other", rawInput: args })
		}));
	}

	/* -- subtitle_transcribe ----------------------------------------------- */
	if (config.transcribe) {
		ctx.tools.register(defineTool({
			name: "subtitle_transcribe",
			description: "Turn an audio or video file into timed subtitle cues using the configured speech-recognition engine, then read the result back as structured cues.",
			parameters: {
				path: { type: "string", required: true, description: "Absolute path to the audio or video file." },
				language: { type: "string", description: `Recognition language (default ${config.asrLanguage}).` },
				model: { type: "string", description: `Model name or path (default ${config.asrModel}).` },
				outputName: { type: "string", description: "Filename for the produced SRT." }
			},
			output: {
				schema: {
					type: "object",
					additionalProperties: false,
					properties: {
						source: { type: "string", required: true },
						outputPath: { type: "string", required: true },
						cueCount: { type: "integer", required: true },
						duration: { type: "number", required: true },
						cues: {
							type: "array",
							required: true,
							items: {
								type: "object",
								additionalProperties: false,
								properties: {
									index: { type: "integer", required: true },
									start: { type: "number", required: true },
									end: { type: "number", required: true },
									text: { type: "string", required: true }
								}
							}
						}
					}
				},
				render: (_args, value) => [{
					type: "text",
					text: [
						`Transcribed ${value.source} → ${value.outputPath}`,
						`${value.cueCount} cue(s), ${humanClock(value.duration)}`,
						...(value.cues.length === 0 ? [] : ["", formatTrack({ path: "", dialect: "srt", cueCount: value.cueCount, duration: value.duration, cues: value.cues, truncated: value.cueCount > value.cues.length })])
					].join("\n")
				}]
			},
			timeoutMs: budgetMs,
			async execute(args, exec) {
				if (config.asrCommand.length === 0) {
					throw new Error("subtitle: speech recognition is not configured. Set asrCommand in this plugin's config to a recogniser that writes SRT (faster-whisper, whisper.cpp, or an internal client), then retry.");
				}
				const source = await requireFile(args.path);
				const extension = extname(source).toLowerCase();
				if (!AUDIO_EXTENSIONS.has(extension)) {
					throw new Error(`subtitle: "${basename(source)}" does not look like audio or video. Pass a media file (${[...AUDIO_EXTENSIONS].slice(0, 6).join(", ")}, …).`);
				}
				const stem = basename(source, extname(source));
				const language = args.language ?? config.asrLanguage;
				const model = args.model ?? config.asrModel;
				const destination = await outPath(args.outputName ?? `${stem}.srt`);

				const expanded = expandArgs(config.asrArgs, {
					input: source, output: destination, dir: outputDir, lang: language, model
				});
				await runCommand(config.asrCommand, expanded, { timeoutMs: budgetMs, signal: exec.signal, env: asrEnv });

				// Engines vary in whether they honour {output} or only {dir}; look for
				// the requested path first, then any SRT the run produced.
				let produced = await findProducedSrt(destination, outputDir, stem);
				if (produced === undefined) {
					throw new Error(`subtitle: the recogniser ran but produced no SRT. It was invoked as "${config.asrCommand} ${expanded.join(" ")}" — check that asrArgs writes to {output} or {dir}.`);
				}
				// Honour an explicit outputName even when the engine only writes to
				// {dir} (faster-whisper's --output_dir is the common case): move the
				// file the engine chose to the name the caller asked for.
				if (produced !== destination && args.outputName !== undefined) {
					const { rename, copyFile } = await import("node:fs/promises");
					try {
						await rename(produced, destination);
					} catch {
						// Cross-device rename fails; fall back to a copy.
						await copyFile(produced, destination);
					}
					produced = destination;
				}
				const text = await readFile(produced, "utf8");
				const parsed = parseSubtitle(text, "srt");
				const cuelist = parsed.cues.map((cue) => ({
					index: cue.index, start: Math.round(cue.start * 1000) / 1000,
					end: Math.round(cue.end * 1000) / 1000, text: cue.text
				}));
				return {
					source,
					outputPath: produced,
					cueCount: cuelist.length,
					duration: Math.round(Math.max(0, ...cuelist.map((cue) => cue.end)) * 1000) / 1000,
					cues: cuelist.slice(0, config.maxCues)
				};
			},
			presentCall: (args) => ({ card: "generic", title: `Transcribe ${basename(args.path ?? "media")}`, kind: "other", rawInput: args })
		}));
	}

	/**
	 * Resolve an input path and assert it is a readable file, with a message the
	 * model can act on.
	 *
	 * @param {string} path - the caller's path argument.
	 * @returns {Promise<string>} the absolute path.
	 */
	async function requireFile(path) {
		const source = resolve(path);
		let info;
		try {
			info = await stat(source);
		} catch {
			throw new Error(`subtitle: no file at "${source}". Pass an absolute path to an existing file.`);
		}
		if (!info.isFile()) throw new Error(`subtitle: "${source}" is not a file.`);
		return source;
	}
}

/**
 * Locate the SRT a recognition run produced: the requested path if it exists,
 * otherwise the newest `.srt` in the output directory whose name starts with the
 * source stem.
 *
 * @param {string} requested - the path the config asked for.
 * @param {string} directory - the plugin's output directory.
 * @param {string} stem - the source file's stem.
 * @returns {Promise<string|undefined>} the path, or undefined when nothing was written.
 */
async function findProducedSrt(requested, directory, stem) {
	const direct = await stat(requested).catch(() => undefined);
	if (direct !== undefined && direct.isFile()) return requested;
	const { readdir } = await import("node:fs/promises");
	const entries = await readdir(directory).catch(() => []);
	const candidates = entries.filter((entry) => entry.toLowerCase().endsWith(".srt") && entry.startsWith(stem));
	if (candidates.length === 0) return undefined;
	const withTimes = await Promise.all(candidates.map(async (entry) => ({
		path: join(directory, entry),
		time: (await stat(join(directory, entry)).catch(() => ({ mtimeMs: 0 }))).mtimeMs
	})));
	withTimes.sort((left, right) => right.time - left.time);
	return withTimes[0].path;
}

/**
 * Coerce the caller's cue input into the internal shape. Accepts `{start, end,
 * text}` objects whose times are numbers (seconds) or timestamp strings, and
 * tolerates an SRT block passed as a single string.
 *
 * @param {unknown} input - the caller's `cues` argument.
 * @returns {object[]} the coerced cue list.
 */
function coerceCues(input) {
	if (!Array.isArray(input)) {
		throw new Error("subtitle: cues must be an array.");
	}
	const cues = [];
	for (const [position, raw] of input.entries()) {
		if (typeof raw === "string") {
			const parsed = parseSubtitle(raw, "srt");
			if (parsed.cues.length === 0) {
				throw new Error(`subtitle: cue #${position + 1} was a string but did not contain a valid SRT block.`);
			}
			cues.push(...parsed.cues);
			continue;
		}
		if (raw === null || typeof raw !== "object") {
			throw new Error(`subtitle: cue #${position + 1} is neither an object nor an SRT block.`);
		}
		const start = typeof raw.start === "number" ? raw.start : parseTimestamp(raw.start);
		const end = typeof raw.end === "number" ? raw.end : parseTimestamp(raw.end);
		if (start === undefined || end === undefined) {
			throw new Error(`subtitle: cue #${position + 1} needs numeric or timestamp start/end; got start=${JSON.stringify(raw.start)} end=${JSON.stringify(raw.end)}.`);
		}
		if (end <= start) {
			throw new Error(`subtitle: cue #${position + 1} ends at ${end}s which is not after its start ${start}s.`);
		}
		const text = String(raw.text ?? "").trim();
		if (text.length === 0) throw new Error(`subtitle: cue #${position + 1} has no text.`);
		cues.push({ index: cues.length + 1, start, end, text, ...raw.style === undefined ? {} : { style: raw.style } });
	}
	return cues;
}

export { Config, apply, inject, name };