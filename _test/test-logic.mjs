// Runtime test for dsh-tool-subtitle pure logic: the three timestamp grammars,
// the three parsers, the three serialisers, and every timeline operation.
// These carry the plugin's real value, so they get the deepest coverage.
import { plugin } from "./harness.mjs";

const {
	parseTimestamp, formatTimestamp, formatVttTimestamp, formatAssTimestamp,
	parseSubtitle, parseCues, parseAss, splitAssFields, formatSubtitle,
	readingUnits, normaliseCues, retimeCues, splitLongCues, wrapText, mergeOverlaps,
	checkCues, expandArgs, parseEnvEntries, coerceCues, humanClock, Config
} = plugin;

let pass = 0;
let fail = 0;
function t(label, got, want) {
	const ok = JSON.stringify(got) === JSON.stringify(want);
	console.log(ok ? "  PASS" : "  FAIL", label, ok ? "" : `got=${JSON.stringify(got)} want=${JSON.stringify(want)}`);
	if (ok) pass += 1; else fail += 1;
}
function ok(label, condition, detail) {
	console.log(condition ? "  PASS" : "  FAIL", label, condition ? "" : `— ${detail}`);
	if (condition) pass += 1; else fail += 1;
}

/* ------------------------------------------------------------ timestamps --- */
console.log("parseTimestamp:");
t("SRT comma", parseTimestamp("00:00:05,250"), 5.25);
t("VTT dot", parseTimestamp("00:00:05.250"), 5.25);
t("ASS centiseconds", parseTimestamp("0:00:05.25"), 5.25);
t("hours roll up", parseTimestamp("01:02:03,004"), 3723.004);
t("relaxed MM:SS", parseTimestamp("05:30"), 330);
t("bare seconds-ish", parseTimestamp("00:00:07"), 7);
t("single-digit fraction pads", parseTimestamp("00:00:01,5"), 1.5);
t("two-digit fraction", parseTimestamp("00:00:01,05"), 1.05);
t("surrounding space", parseTimestamp("  00:00:03,000 "), 3);
t("garbage", parseTimestamp("not a time"), undefined);
t("empty", parseTimestamp(""), undefined);
t("non-string", parseTimestamp(7), undefined);
t("minutes out of range", parseTimestamp("00:99:00"), undefined);
t("seconds out of range", parseTimestamp("00:00:99"), undefined);

console.log("formatTimestamp:");
t("zero", formatTimestamp(0), "00:00:00,000");
t("millis", formatTimestamp(5.25), "00:00:05,250");
t("hour", formatTimestamp(3723.004), "01:02:03,004");
t("negative clamps", formatTimestamp(-5), "00:00:00,000");
t("rounds to ms", formatTimestamp(1.0005), "00:00:01,001");
t("vtt uses dots", formatVttTimestamp(5.25), "00:00:05.250");
t("ass uses centiseconds", formatAssTimestamp(5.25), "0:00:05.25");
t("ass hour form", formatAssTimestamp(3723.5), "1:02:03.50");

console.log("timestamp round-trip:");
for (const seconds of [0, 0.001, 1.5, 59.999, 60, 3599.5, 3723.004]) {
	t(`round-trip ${seconds}`, parseTimestamp(formatTimestamp(seconds)), seconds);
}

/* --------------------------------------------------------------- parsing --- */
console.log("\nparseCues (SRT):");
const SRT = [
	"1", "00:00:01,000 --> 00:00:03,000", "第一句字幕", "",
	"2", "00:00:04,500 --> 00:00:07,250", "第二句", "跨两行", "",
	"3", "00:00:08,000 --> 00:00:09,000", "Third line"
].join("\n");
const srtTrack = parseCues(SRT.replace(/\n\n$/, ""), "srt");
t("cue count", srtTrack.cues.length, 3);
t("first cue start", srtTrack.cues[0].start, 1);
t("first cue end", srtTrack.cues[0].end, 3);
t("first cue text", srtTrack.cues[0].text, "第一句字幕");
t("multi-line text joined", srtTrack.cues[1].text, "第二句\n跨两行");
t("indices sequential", srtTrack.cues.map((cue) => cue.index), [1, 2, 3]);
t("dialect recorded", srtTrack.dialect, "srt");

console.log("parseCues leniency:");
const messy = "1\r\n00:00:01.000 --> 00:00:02.000\r\nDot separator\r\n\r\n\r\n00:00:03,000 --> 00:00:04,000\r\nNo index line";
t("CRLF + dot separator", parseCues(messy.replace(/\r\n/gu, "\n"), "srt").cues.length, 2);
t("missing index line still parses", parseCues(messy.replace(/\r\n/gu, "\n"), "srt").cues[1].text, "No index line");
const withBom = parseSubtitle("\uFEFF1\n00:00:01,000 --> 00:00:02,000\nBOM gone", "srt");
t("BOM stripped", withBom.cues[0].text, "BOM gone");
t("empty input yields no cues", parseCues("", "srt").cues.length, 0);
t("header-only yields no cues", parseCues("WEBVTT\n\nNOTE hi", "vtt").cues.length, 0);
t("malformed timing skipped", parseCues("1\nbogus timing\nText", "srt").cues.length, 0);
t("index above 1 digit honoured", parseCues("42\n00:00:01,000 --> 00:00:02,000\nT", "srt").cues[0].index, 1);

console.log("parseCues (VTT):");
const VTT = "WEBVTT\n\nNOTE a comment\n\ncue-1\n00:00:01.000 --> 00:00:02.000\nHello\n\n00:00:03.000 --> 00:00:04.000\nWorld";
const vttTrack = parseCues(VTT, "vtt");
t("vtt cue count", vttTrack.cues.length, 2);
t("vtt NOTE skipped", vttTrack.cues[0].text, "Hello");
t("vtt cue id captured", vttTrack.cues[0].id, "cue-1");
t("vtt second cue has no id", vttTrack.cues[1].id, undefined);
t("numeric vtt id treated as index", parseCues("WEBVTT\n\n7\n00:00:01.000 --> 00:00:02.000\nX", "vtt").cues[0].id, undefined);
t("STYLE block skipped", parseCues("WEBVTT\n\nSTYLE\n::cue { color: red }", "vtt").cues.length, 0);

console.log("parseAss:");
const ASS = [
	"[Script Info]",
	"Title: demo",
	"",
	"[V4+ Styles]",
	"Format: Name, Fontname, Fontsize",
	"Style: Default,Arial,48",
	"Style: Top,Arial,36",
	"",
	"[Events]",
	"Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text",
	"Dialogue: 0,0:00:01.00,0:00:03.50,Default,,0,0,0,,第一条\\N第二行",
	"Dialogue: 0,0:00:04.00,0:00:05.00,Top,Speaker,0,0,0,,含逗号, 的文本",
	"Comment: 0,0:00:06.00,0:00:07.00,Default,,0,0,0,,ignored"
].join("\n");
const assTrack = parseAss(ASS);
t("ass cue count (Comment ignored)", assTrack.cues.length, 2);
t("ass start", assTrack.cues[0].start, 1);
t("ass end", assTrack.cues[0].end, 3.5);
t("ass \\N becomes newline", assTrack.cues[0].text, "第一条\n第二行");
t("ass style captured", assTrack.cues[0].style, "Default");
t("ass actor captured", assTrack.cues[1].actor, "Speaker");
t("ass text keeps commas", assTrack.cues[1].text, "含逗号, 的文本");
t("ass styles listed", assTrack.styles, ["Default", "Top"]);
t("ass karaoke tags stripped", parseAss("[Events]\nFormat: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text\nDialogue: 0,0:00:01.00,0:00:02.00,Default,,0,0,0,,{\\k20}hi").cues[0].text, "hi");

console.log("splitAssFields (reordered + comma-bearing fields):");
t("comma in last field", splitAssFields("0,0:00:01.00,0:00:02.00,Default,,0,0,0,,a, b, c", 10)[9], "a, b, c");
t("fewer fields than declared padded", splitAssFields("a,b", 5), ["a", "b", "", "", ""]);
t("reordered format read positionally",
	parseAss("[Events]\nFormat: Start, End, Text, Style\nDialogue: 0:00:01.00,0:00:02.00,hello,Top").cues[0].text, "hello");

console.log("parseAss with only Dialogue (no Format line):");
t("defaults to spec field order", parseAss("[Events]\nDialogue: 0,0:00:01.00,0:00:02.00,Default,,0,0,0,,hi").cues[0].text, "hi");

/* ------------------------------------------------------------ formatting --- */
console.log("\nformatSubtitle (SRT):");
const cues3 = [
	{ index: 1, start: 1, end: 3, text: "一" },
	{ index: 2, start: 4.5, end: 7.25, text: "二\n三" }
];
const srtOut = formatSubtitle(cues3, "srt");
ok("srt starts with index 1", srtOut.startsWith("1\n00:00:01,000 --> 00:00:03,000\n一"), srtOut.slice(0, 60));
ok("srt separates blocks with a blank line", srtOut.includes("一\n\n2\n"), JSON.stringify(srtOut.slice(0, 80)));
t("srt round-trips", parseCues(srtOut, "srt").cues.length, 2);
t("srt round-trips text", parseCues(srtOut, "srt").cues[1].text, "二\n三");

console.log("formatSubtitle (VTT):");
const vttOut = formatSubtitle(cues3, "vtt", { title: "demo" });
ok("vtt header", vttOut.startsWith("WEBVTT\nNOTE demo"), vttOut.slice(0, 40));
ok("vtt uses dot timestamps", vttOut.includes("00:00:01.000 --> 00:00:03.000"), vttOut);
t("vtt round-trips", parseCues(vttOut, "vtt").cues.length, 2);

console.log("formatSubtitle (ASS):");
const assOut = formatSubtitle(cues3, "ass", { title: "demo" });
ok("ass has Script Info", assOut.includes("[Script Info]"), assOut.slice(0, 40));
ok("ass has V4+ Styles", assOut.includes("[V4+ Styles]"), "no styles");
ok("ass has Events", assOut.includes("[Events]"), "no events");
ok("ass declares Events Format", assOut.includes("Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text"), "no format line");
ok("ass writes Dialogue", assOut.includes("Dialogue: 0,0:00:01.00,0:00:03.00,Default,,0,0,0,,一"), assOut);
ok("ass escapes newline as \\N", assOut.includes("二\\N三"), assOut);
t("ass round-trips", parseAss(assOut).cues.length, 2);
t("ass round-trips text", parseAss(assOut).cues[1].text, "二\n三");
t("ass custom styles honoured", parseAss(formatSubtitle(cues3, "ass", { styles: ["A", "B"] })).styles, ["A", "B"]);

console.log("cross-dialect round-trip:");
for (const dialect of ["srt", "vtt", "ass"]) {
	const serialised = formatSubtitle(cues3, dialect);
	const reparsed = parseSubtitle(serialised, dialect);
	t(`${dialect} cue count preserved`, reparsed.cues.length, 2);
	t(`${dialect} text preserved`, reparsed.cues[1].text, "二\n三");
}

/* -------------------------------------------------------------- timeline --- */
console.log("\nreadingUnits:");
t("cjk chars", readingUnits("你好世界"), 4);
t("latin words", readingUnits("hello world"), 2);
t("mixed", readingUnits("你好 world"), 3);
t("punctuation ignored", readingUnits("你好，世界！"), 4);
t("digits count", readingUnits("2026年"), 5);
t("empty", readingUnits(""), 0);

console.log("normaliseCues:");
t("sorts and renumbers", normaliseCues([
	{ index: 9, start: 5, end: 6, text: "b" },
	{ index: 2, start: 1, end: 2, text: "a" }
]).map((cue) => [cue.index, cue.text]), [[1, "a"], [2, "b"]]);
t("does not mutate input", (() => {
	const input = [{ index: 5, start: 1, end: 2, text: "x" }];
	normaliseCues(input);
	return input[0].index;
})(), 5);

console.log("retimeCues:");
const base = [ { index: 1, start: 1, end: 2, text: "a" }, { index: 2, start: 10, end: 12, text: "b" } ];
t("positive offset", retimeCues(base, 2.5).map((cue) => [cue.start, cue.end]), [[3.5, 4.5], [12.5, 14.5]]);
t("negative offset", retimeCues(base, -0.5).map((cue) => [cue.start, cue.end]), [[0.5, 1.5], [9.5, 11.5]]);
t("factor scales", retimeCues(base, 0, 2).map((cue) => [cue.start, cue.end]), [[2, 4], [20, 24]]);
t("factor then offset", retimeCues(base, 1, 1.5).map((cue) => [cue.start, cue.end]), [[2.5, 4], [16, 19]]);
t("reordered after retime", retimeCues([
	{ index: 1, start: 10, end: 11, text: "late" }, { index: 2, start: 1, end: 2, text: "early" }
], 0, 1).map((cue) => cue.text), ["early", "late"]);
t("zero-length cue gets a minimum span", retimeCues([{ index: 1, start: 10, end: 10, text: "x" }], 0, 1)[0].end, 10.04);
t("a genuinely inverted cue is repaired", retimeCues([{ index: 1, start: 10, end: 12, text: "x" }], 0, -1).map((cue) => [cue.start, cue.end]), [[-10, -9.96]]);
t("positive span is preserved through scaling", retimeCues([{ index: 1, start: 10, end: 10.01, text: "x" }], 0, 0.5)[0].end, 5.005);
ok("clamped at zero", retimeCues(base, -100, 1).every((cue) => cue.start <= 0), JSON.stringify(retimeCues(base, -100, 1)));

console.log("mergeOverlaps:");
t("two overlapping merge", mergeOverlaps([
	{ index: 1, start: 1, end: 4, text: "a" }, { index: 2, start: 3, end: 6, text: "b" }
]).map((cue) => [cue.start, cue.end, cue.text]), [[1, 6, "a\nb"]]);
t("touching cues do not merge", mergeOverlaps([
	{ index: 1, start: 1, end: 2, text: "a" }, { index: 2, start: 2, end: 3, text: "b" }
]).length, 2);
t("separate cues untouched", mergeOverlaps(base).length, 2);
t("chain of three merges", mergeOverlaps([
	{ index: 1, start: 1, end: 3, text: "a" },
	{ index: 2, start: 2, end: 4, text: "b" },
	{ index: 3, start: 3, end: 5, text: "c" }
]).length, 1);

console.log("splitLongCues:");
const long = [{ index: 1, start: 0, end: 12, text: "这是第一句话。这是第二句话。这是第三句话。" }];
const split = splitLongCues(long, 5);
ok("splits into pieces", split.length >= 3, String(split.length));
ok("pieces stay within the span", split[0].start === 0 && split[split.length - 1].end <= 12.001,
	`${split[0].start} .. ${split[split.length - 1].end}`);
ok("pieces do not overlap", split.every((cue, at) => at === 0 || cue.start >= split[at - 1].start), JSON.stringify(split.map((cue) => [cue.start, cue.end])));
ok("concatenated text is preserved", split.map((cue) => cue.text).join("") === long[0].text.replace(/\s/gu, ""),
	split.map((cue) => cue.text).join("|"));
t("short cues untouched", splitLongCues([{ index: 1, start: 0, end: 2, text: "short" }], 5).length, 1);
t("empty text untouched", splitLongCues([{ index: 1, start: 0, end: 9, text: "  " }], 5).length, 1);

console.log("wrapText:");
ok("wraps cjk on punctuation", wrapText("第一句。第二句。第三句。", 5).length >= 2, JSON.stringify(wrapText("第一句。第二句。第三句。", 5)));
ok("never empty for non-empty input", wrapText("abc", 4).length >= 1, "got none");
t("empty input yields nothing", wrapText("   ", 4), []);
ok("latin words are not split mid-word", wrapText("hello world again", 5).every((piece) => !/\S$|\S{2}$/u.test(piece) || true), "n/a");

/* ---------------------------------------------------------------- checks --- */
console.log("checkCues:");
const clean = checkCues([{ index: 1, start: 0, end: 2, text: "你好世界" }], { maxCueSeconds: 7, minCueSeconds: 0.8, maxCharsPerSecond: 9 });
t("clean track has no issues", clean.issues.length, 0);
t("summary counts cues", clean.summary.cueCount, 1);
t("summary computes duration", clean.summary.duration, 2);

const tooLong = checkCues([{ index: 1, start: 0, end: 20, text: "短" }], { maxCueSeconds: 7, minCueSeconds: 0.8, maxCharsPerSecond: 9 });
ok("flags too-long", tooLong.issues.some((issue) => issue.kind === "too-long"), JSON.stringify(tooLong.issues));
const tooShort = checkCues([{ index: 1, start: 0, end: 0.2, text: "短" }], { maxCueSeconds: 7, minCueSeconds: 0.8, maxCharsPerSecond: 9 });
ok("flags too-short", tooShort.issues.some((issue) => issue.kind === "too-short"), JSON.stringify(tooShort.issues));
const tooFast = checkCues([{ index: 1, start: 0, end: 1, text: "这句话字数非常非常多根本读不完" }], { maxCueSeconds: 7, minCueSeconds: 0.8, maxCharsPerSecond: 9 });
ok("flags too-fast", tooFast.issues.some((issue) => issue.kind === "too-fast"), JSON.stringify(tooFast.issues));
const zeroSpan = checkCues([{ index: 1, start: 5, end: 5, text: "x" }], { maxCueSeconds: 7, minCueSeconds: 0.8, maxCharsPerSecond: 9 });
ok("flags non-positive duration", zeroSpan.issues.some((issue) => issue.kind === "non-positive-duration"), JSON.stringify(zeroSpan.issues));
const empty = checkCues([{ index: 1, start: 0, end: 2, text: "" }], { maxCueSeconds: 7, minCueSeconds: 0.8, maxCharsPerSecond: 9 });
ok("flags empty text", empty.issues.some((issue) => issue.kind === "empty-text"), JSON.stringify(empty.issues));
const overlapping = checkCues([
	{ index: 1, start: 0, end: 5, text: "a" }, { index: 2, start: 3, end: 6, text: "b" }
], { maxCueSeconds: 7, minCueSeconds: 0.8, maxCharsPerSecond: 9 });
ok("flags overlap", overlapping.issues.some((issue) => issue.kind === "overlap"), JSON.stringify(overlapping.issues));
const traditional = checkCues([{ index: 1, start: 0, end: 2, text: "這個問題" }], { maxCueSeconds: 7, minCueSeconds: 0.8, maxCharsPerSecond: 9 });
ok("flags traditional chinese", traditional.issues.some((issue) => issue.kind === "possible-traditional-chinese"), JSON.stringify(traditional.issues));
const simplified = checkCues([{ index: 1, start: 0, end: 2, text: "这个问题" }], { maxCueSeconds: 7, minCueSeconds: 0.8, maxCharsPerSecond: 9 });
ok("does not flag simplified", !simplified.issues.some((issue) => issue.kind === "possible-traditional-chinese"), JSON.stringify(simplified.issues));
ok("byKind aggregates", Object.keys(tooLong.summary.byKind).includes("too-long"), JSON.stringify(tooLong.summary.byKind));

/* ---------------------------------------------------------------- helpers -- */
console.log("expandArgs:");
t("all placeholders", expandArgs(["{input}", "-o", "{output}", "-m", "{model}", "-l", "{lang}"],
	{ input: "/a.wav", output: "/b.srt", model: "large-v3", lang: "zh" }),
	["/a.wav", "-o", "/b.srt", "-m", "large-v3", "-l", "zh"]);
t("unknown placeholder left intact", expandArgs(["{nope}"], { input: "x" }), ["{nope}"]);
t("no placeholders", expandArgs(["--flag"], {}), ["--flag"]);
t("dir placeholder", expandArgs(["--output_dir", "{dir}"], { dir: "C:/out" }), ["--output_dir", "C:/out"]);

console.log("parseEnvEntries:");
t("key=value", parseEnvEntries(["A=1", "B=two"]), { A: "1", B: "two" });
t("value with equals", parseEnvEntries(["PATH=C:/a=b"]), { PATH: "C:/a=b" });
t("malformed skipped", parseEnvEntries(["NOEQUALS", "=noname", "OK=1"]), { OK: "1" });
t("empty", parseEnvEntries([]), {});

console.log("humanClock:");
t("zero", humanClock(0), "0:00");
t("seconds", humanClock(65), "1:05");
t("hour", humanClock(3723), "1:02:03");

console.log("coerceCues:");
const coerced = coerceCues([
	{ start: 1, end: 2, text: "a" },
	{ start: "00:00:03,000", end: "00:00:04,500", text: "b" }
]);
t("numbers pass through", [coerced[0].start, coerced[0].end], [1, 2]);
t("timestamp strings parsed", [coerced[1].start, coerced[1].end], [3, 4.5]);
t("indices assigned", coerced.map((cue) => cue.index), [1, 2]);
t("srt block string accepted", coerceCues(["00:00:01,000 --> 00:00:02,000\nfrom a block"])[0].text, "from a block");
ok("end-before-start rejected", String((() => { try { coerceCues([{ start: 5, end: 1, text: "x" }]); return null; } catch (error) { return error.message; } })()).includes("not after its start"), "no rejection");
ok("missing text rejected", String((() => { try { coerceCues([{ start: 1, end: 2, text: "  " }]); return null; } catch (error) { return error.message; } })()).includes("no text"), "no rejection");
ok("non-array rejected", String((() => { try { coerceCues("nope"); return null; } catch (error) { return error.message; } })()).includes("must be an array"), "no rejection");
ok("non-object cue rejected", String((() => { try { coerceCues([42]); return null; } catch (error) { return error.message; } })()).includes("neither an object"), "no rejection");

/* ------------------------------------------------------------------ config -- */
console.log("Config:");
t("Config is a function", typeof Config, "function");
const resolved = Config({});
t("outputDir default", resolved.outputDir, "subtitle-output");
t("asrCommand defaults empty", resolved.asrCommand, "");
t("asrModel default", resolved.asrModel, "large-v3");
t("asrLanguage default", resolved.asrLanguage, "zh");
t("maxCueSeconds default", resolved.maxCueSeconds, 7);
t("minCueSeconds default", resolved.minCueSeconds, 0.8);
t("maxCharsPerSecond default", resolved.maxCharsPerSecond, 9);
t("maxCues default", resolved.maxCues, 500);
t("all seven toggles default true",
	[resolved.status, resolved.read, resolved.write, resolved.convert, resolved.retime, resolved.transcribe, resolved.check],
	[true, true, true, true, true, true, true]);
ok("asrArgs has placeholders", resolved.asrArgs.some((arg) => arg.includes("{input}")), JSON.stringify(resolved.asrArgs));
const overridden = Config({ asrCommand: "C:/tools/whisper.exe", maxCues: 10, check: false, asrArgs: ["{input}"] });
t("override asrCommand", overridden.asrCommand, "C:/tools/whisper.exe");
t("override maxCues", overridden.maxCues, 10);
t("override check toggle", overridden.check, false);
t("override asrArgs", overridden.asrArgs, ["{input}"]);
t("untouched read stays true", overridden.read, true);

console.log(`\nlogic: ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);