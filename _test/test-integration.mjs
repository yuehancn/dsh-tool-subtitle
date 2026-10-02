// Integration test for dsh-tool-subtitle against the REAL @deepseek-ai/dsh-tools
// runtime: module surface, registration counts, schema normalization, toggles,
// error paths against the real filesystem, and output rendering.
import { mkdir, writeFile, rm, stat } from "node:fs/promises";
import { join, resolve } from "node:path";
import { plugin, Context, call } from "./harness.mjs";

const ROOT = resolve(new URL("..", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/u, "$1"));
const FIXTURES = join(ROOT, "_test", "fixtures");
const OUT = join(ROOT, "_test", "tmp-out");

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

await rm(OUT, { recursive: true, force: true });
await mkdir(FIXTURES, { recursive: true });
const BASIC = join(FIXTURES, "basic.srt");
await writeFile(BASIC, "1\n00:00:01,000 --> 00:00:03,000\n第一句\n\n2\n00:00:04,000 --> 00:00:06,000\n第二句\n", "utf8");
const BASIC_VTT = join(FIXTURES, "basic.vtt");
await writeFile(BASIC_VTT, "WEBVTT\n\n00:00:01.000 --> 00:00:03.000\nHello\n", "utf8");
const BASIC_ASS = join(FIXTURES, "basic.ass");
await writeFile(BASIC_ASS, "[Events]\nFormat: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text\nDialogue: 0,0:00:01.00,0:00:03.00,Default,,0,0,0,,第一条\n", "utf8");
const NOT_SUB = join(FIXTURES, "notes.txt");
await writeFile(NOT_SUB, "plain text", "utf8");

/* ---------------------------------------------------- module surface ---- */
console.log("module surface:");
t("name value", plugin.name, "tool-subtitle");
t("inject declares tools", plugin.inject, ["tools"]);
t("apply is a function", typeof plugin.apply, "function");
t("Config is a function", typeof plugin.Config, "function");

/* ------------------------------------------------- registration count --- */
console.log("registration:");
const all = Context({ outputDir: OUT });
plugin.apply(all, all.config);
t("registers 7 tools", all.names().length, 7);
t("names are stable", all.names().sort(),
	["subtitle_check", "subtitle_convert", "subtitle_read", "subtitle_retime", "subtitle_status", "subtitle_transcribe", "subtitle_write"]);

/* ------------------------------------------------ schema normalization -- */
console.log("schema shape (defineTool normalization):");
const read = all.get("subtitle_read");
t("read parameters type", read.parameters.type, "object");
t("read required is top-level array", read.parameters.required, ["path"]);
ok("read offset is optional", !read.parameters.required.includes("offset"), JSON.stringify(read.parameters.required));
t("read output requires path", read.output.schema.required.includes("path"), true);
ok("read cues items describe a cue", read.output.schema.properties.cues.items.properties.index.type === "integer", JSON.stringify(read.output.schema.properties.cues));

const write = all.get("subtitle_write");
t("write required", write.parameters.required.sort(), ["cues", "dialect"]);
t("write cues is an array", write.parameters.properties.cues.type, "array");
t("write cues items are objects", write.parameters.properties.cues.items.type, "object");

const convert = all.get("subtitle_convert");
t("convert required", convert.parameters.required.sort(), ["dialect", "path"]);
t("convert offsetSeconds is number", convert.parameters.properties.offsetSeconds.type, "number");

const retime = all.get("subtitle_retime");
t("retime required", retime.parameters.required, ["path"]);
ok("retime offset/factor both optional", !retime.parameters.required.includes("offsetSeconds") && !retime.parameters.required.includes("factor"),
	JSON.stringify(retime.parameters.required));

const check = all.get("subtitle_check");
t("check required", check.parameters.required, ["path"]);
ok("check output has byKind", check.output.schema.properties.byKind !== undefined, JSON.stringify(Object.keys(check.output.schema.properties)));

const transcribe = all.get("subtitle_transcribe");
t("transcribe required", transcribe.parameters.required, ["path"]);

const status = all.get("subtitle_status");
t("status has empty parameters", Object.keys(status.parameters.properties).length, 0);

/* ------------------------------------------------------------- toggles -- */
console.log("toggles:");
const none = Context({ status: false, read: false, write: false, convert: false, retime: false, transcribe: false, check: false });
plugin.apply(none, none.config);
t("all off registers nothing", none.names().length, 0);

const onlyCheck = Context({ status: false, read: false, write: false, convert: false, retime: false, transcribe: false });
plugin.apply(onlyCheck, onlyCheck.config);
t("only check on", onlyCheck.names(), ["subtitle_check"]);

const noRead = Context({ outputDir: OUT, read: false });
plugin.apply(noRead, noRead.config);
t("read off drops one", noRead.names().length, 6);
ok("read off really removes it", !noRead.names().includes("subtitle_read"), noRead.names().join(","));

/* ----------------------------------------------------------- happy path -- */
console.log("read/write/convert happy path:");
const ctx = Context({ outputDir: OUT, maxCues: 50 });
plugin.apply(ctx, ctx.config);

const readResult = await call(ctx.get("subtitle_read"), { path: BASIC });
ok("read succeeds", readResult.error === undefined, readResult.error);
t("read cue count", readResult.value?.cueCount, 2);
t("read dialect", readResult.value?.dialect, "srt");
t("read duration", readResult.value?.duration, 6);
t("read first cue text", readResult.value?.cues[0]?.text, "第一句");
ok("read returns numeric times", typeof readResult.value?.cues[0]?.start === "number", typeof readResult.value?.cues[0]?.start);

const readVtt = await call(ctx.get("subtitle_read"), { path: BASIC_VTT });
t("vtt dialect detected", readVtt.value?.dialect, "vtt");
const readAss = await call(ctx.get("subtitle_read"), { path: BASIC_ASS });
t("ass dialect detected", readAss.value?.dialect, "ass");

const paged = await call(ctx.get("subtitle_read"), { path: BASIC, offset: 1, limit: 1 });
t("offset/limit pages", paged.value?.cues.length, 1);
t("paged cue is the second", paged.value?.cues[0]?.text, "第二句");
t("paging reports total", paged.value?.cueCount, 2);

const wrote = await call(ctx.get("subtitle_write"), {
	dialect: "vtt",
	cues: [{ start: 0, end: 2, text: "a" }, { start: 3, end: 5, text: "b" }],
	outputName: "written.vtt"
});
ok("write succeeds", wrote.error === undefined, wrote.error);
t("write cue count", wrote.value?.cueCount, 2);
ok("written file exists", (await stat(wrote.value?.outputPath ?? "").catch(() => ({ size: 0 }))).size > 0, wrote.value?.outputPath);
const readBack = await call(ctx.get("subtitle_read"), { path: wrote.value?.outputPath });
t("written file reads back", readBack.value?.cueCount, 2);

const converted = await call(ctx.get("subtitle_convert"), { path: BASIC, dialect: "ass", outputName: "converted.ass" });
ok("convert succeeds", converted.error === undefined, converted.error);
t("convert reports from", converted.value?.from, "srt");
t("convert reports to", converted.value?.to, "ass");
const convertedBack = await call(ctx.get("subtitle_read"), { path: converted.value?.outputPath });
t("converted file reads back as ass", convertedBack.value?.dialect, "ass");
t("conversion preserved text", convertedBack.value?.cues[0]?.text, "第一句");

const retimed = await call(ctx.get("subtitle_retime"), { path: BASIC, offsetSeconds: 2, outputName: "shifted.srt" });
ok("retime succeeds", retimed.error === undefined, retimed.error);
t("retime shifted the first cue", retimed.value?.firstCueAfter, 3);
t("retime preserved the count", retimed.value?.cueCount, 2);
ok("retime reports before/after", retimed.value?.lastCueBefore === 6 && retimed.value?.lastCueAfter === 8,
	`${retimed.value?.lastCueBefore} -> ${retimed.value?.lastCueAfter}`);

const checked = await call(ctx.get("subtitle_check"), { path: BASIC });
ok("check succeeds", checked.error === undefined, checked.error);
t("clean file has no issues", checked.value?.issueCount, 0);
t("check reports cue count", checked.value?.cueCount, 2);

/* ------------------------------------------------------- error paths ---- */
console.log("error paths:");
const missing = await call(ctx.get("subtitle_read"), { path: join(FIXTURES, "nope.srt") });
ok("missing file rejects", /no file at/u.test(missing.error ?? ""), missing.error);

const wrongExt = await call(ctx.get("subtitle_read"), { path: NOT_SUB });
ok("non-subtitle extension rejected", /is not a subtitle file/u.test(wrongExt.error ?? ""), wrongExt.error);

const badDialectRead = await call(ctx.get("subtitle_convert"), { path: BASIC, dialect: "docx" });
ok("unsupported output dialect rejected", /dialect must be srt, vtt or ass/u.test(badDialectRead.error ?? ""), badDialectRead.error);

const badFactor = await call(ctx.get("subtitle_retime"), { path: BASIC, factor: 0 });
ok("zero factor rejected", /factor must be positive/u.test(badFactor.error ?? ""), badFactor.error);

const negativeFactor = await call(ctx.get("subtitle_retime"), { path: BASIC, factor: -1 });
ok("negative factor rejected", /factor must be positive/u.test(negativeFactor.error ?? ""), negativeFactor.error);

const noChange = await call(ctx.get("subtitle_retime"), { path: BASIC });
ok("retime with neither offset nor factor rejected", /at least one of offsetSeconds or factor/u.test(noChange.error ?? ""), noChange.error);

const badCues = await call(ctx.get("subtitle_write"), { dialect: "srt", cues: [{ start: 5, end: 1, text: "x" }] });
ok("inverted cue rejected", /not after its start/u.test(badCues.error ?? ""), badCues.error);

const emptyCues = await call(ctx.get("subtitle_write"), { dialect: "srt", cues: [] });
ok("empty cue list rejected", /no usable cues/u.test(emptyCues.error ?? ""), emptyCues.error);

const noAsr = await call(ctx.get("subtitle_transcribe"), { path: BASIC });
ok("transcribe without asrCommand explains how to fix it",
	/not configured.*asrCommand/su.test(noAsr.error ?? ""), noAsr.error);

// A context with an ASR command configured, so the tool reaches the file checks
// rather than stopping at the "not configured" guard.
const asrCtx = Context({ outputDir: OUT, asrCommand: "definitely-not-a-real-engine" });
plugin.apply(asrCtx, asrCtx.config);

const badMedia = await call(asrCtx.get("subtitle_transcribe"), { path: NOT_SUB });
ok("transcribe rejects a non-media file before spawning", /does not look like audio or video/u.test(badMedia.error ?? ""), badMedia.error);

const missingMedia = await call(asrCtx.get("subtitle_transcribe"), { path: join(FIXTURES, "nope.mp3") });
ok("transcribe rejects a missing file", /no file at/u.test(missingMedia.error ?? ""), missingMedia.error);

const emptyFile = join(FIXTURES, "empty.srt");
await writeFile(emptyFile, "", "utf8");
const noCues = await call(ctx.get("subtitle_read"), { path: emptyFile });
ok("file with no cues explains the timing-line requirement", /no cues could be parsed|they should contain/u.test(noCues.error ?? ""), noCues.error);

/* ------------------------------------------------------- status tool ---- */
console.log("status tool:");
const statusCtx = Context({ outputDir: OUT });
plugin.apply(statusCtx, statusCtx.config);
const statusResult = await call(statusCtx.get("subtitle_status"), {});
ok("status succeeds without an engine configured", statusResult.error === undefined, statusResult.error);
t("status reports configured=false", statusResult.value?.asr?.configured, false);
t("status lists the three dialects", statusResult.value?.dialects?.sort(), ["ass", "srt", "vtt"]);
t("status reports the output dir", statusResult.value?.outputDir, OUT);
ok("status has a readable render", /NOT CONFIGURED/u.test(statusCtx.get("subtitle_status").output.render({}, statusResult.value)[0].text),
	statusCtx.get("subtitle_status").output.render({}, statusResult.value)[0].text);

/* --------------------------------------------------------- presentation - */
console.log("presentation:");
t("read card title", ctx.get("subtitle_read").presentCall({ path: "C:/a.srt" }).title, "Read a.srt");
t("convert card title", ctx.get("subtitle_convert").presentCall({ path: "C:/a.srt", dialect: "vtt" }).title, "Convert a.srt → vtt");
t("retime card title", ctx.get("subtitle_retime").presentCall({ path: "C:/a.srt" }).title, "Retime a.srt");
t("check card title", ctx.get("subtitle_check").presentCall({ path: "C:/a.srt" }).title, "Check a.srt");
t("transcribe card title", ctx.get("subtitle_transcribe").presentCall({ path: "C:/a.mp4" }).title, "Transcribe a.mp4");
t("write card title", ctx.get("subtitle_write").presentCall({
	cues: [{ start: 0, end: 2, text: "a" }, { start: 3, end: 5, text: "b" }], dialect: "srt"
}).title, "Write 2 cue(s) as srt");
ok("presentCall validates its arguments",
	ctx.get("subtitle_write").presentCall({ cues: [1, 2], dialect: "srt" }) === undefined,
	"invalid cues should suppress the card");

/* ------------------------------------------------------------- renders -- */
console.log("output render:");
const readRender = ctx.get("subtitle_read").output.render({}, {
	path: "C:/a.srt", dialect: "srt", cueCount: 1, duration: 5,
	cues: [{ index: 1, start: 1, end: 3, text: "hi\nthere" }]
});
ok("read render shows the timing", readRender[0].text.includes("00:00:01,000 → 00:00:03,000"), readRender[0].text);
ok("read render flattens newlines", readRender[0].text.includes("hi / there"), readRender[0].text);

const truncRender = ctx.get("subtitle_read").output.render({}, {
	path: "C:/a.srt", dialect: "srt", cueCount: 99, duration: 5, truncated: true,
	cues: [{ index: 1, start: 1, end: 3, text: "x" }]
});
ok("read render mentions truncation", /more cue\(s\) not shown/u.test(truncRender[0].text), truncRender[0].text);

const checkRender = ctx.get("subtitle_check").output.render({}, {
	path: "C:/a.srt", cueCount: 2, duration: 10, issueCount: 2,
	byKind: { "too-long": 1, overlap: 1 },
	issues: [{ kind: "too-long", index: 1, detail: "9.00s > 7s" }, { kind: "overlap", index: 2, detail: "starts early" }]
});
ok("check render lists kinds", checkRender[0].text.includes("too-long: 1"), checkRender[0].text);
ok("check render lists issues", checkRender[0].text.includes("[#1] too-long"), checkRender[0].text);
const cleanRender = ctx.get("subtitle_check").output.render({}, { path: "C:/a.srt", cueCount: 2, duration: 10, issueCount: 0, byKind: {}, issues: [] });
ok("clean check render says clean", /clean —/u.test(cleanRender[0].text), cleanRender[0].text);

const retimeRender = ctx.get("subtitle_retime").output.render({}, {
	outputPath: "C:/out/a.retimed.srt", dialect: "srt", offsetSeconds: 2, factor: 1,
	cueCount: 2, firstCueBefore: 1, firstCueAfter: 3, lastCueBefore: 6, lastCueAfter: 8
});
ok("retime render shows before → after", retimeRender[0].text.includes("00:00:01,000 → 00:00:03,000"), retimeRender[0].text);

console.log(`\nintegration: ${pass} passed, ${fail} failed`);
await rm(OUT, { recursive: true, force: true }).catch(() => {});
process.exit(fail === 0 ? 0 : 1);