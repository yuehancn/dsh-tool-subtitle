// End-to-end test for dsh-tool-subtitle: every assertion drives the plugin
// through real file I/O and a real child process (a stand-in recogniser that
// writes genuine SRT), so argument expansion, output discovery and the SRT
// parser are proven against files on disk rather than in-memory fixtures.
import { mkdir, rm, writeFile, readFile, stat } from "node:fs/promises";
import { join, resolve } from "node:path";
import { plugin, Context, call } from "./harness.mjs";

const ROOT = resolve(new URL("..", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/u, "$1"));
const FIXTURES = join(ROOT, "_test", "fixtures");
const OUT = join(ROOT, "_test", "tmp-out");
const MOCK_ASR = join(FIXTURES, "mock-asr.mjs");

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
await mkdir(OUT, { recursive: true });

/* --------------------------------------------------- transcribe (real) -- */
console.log("subtitle_transcribe (real child process):");
const ctx = Context({
	outputDir: OUT,
	asrCommand: process.execPath,
	asrArgs: [MOCK_ASR, "{input}", "--output_dir", "{dir}", "--output_format", "srt", "--language", "{lang}"],
	asrModel: "large-v3",
	asrLanguage: "zh",
	maxCues: 100
});
plugin.apply(ctx, ctx.config);

const MEDIA = join(FIXTURES, "audio 输入.mp3");
await writeFile(MEDIA, "not real audio, but the stand-in engine only checks existence\n", "utf8");

const transcribed = await call(ctx.get("subtitle_transcribe"), { path: MEDIA });
ok("transcribe succeeds", transcribed.error === undefined, transcribed.error);
t("cues were parsed from the produced SRT", transcribed.value?.cueCount, 2);
t("first cue start", transcribed.value?.cues?.[0]?.start, 0.5);
t("first cue end", transcribed.value?.cues?.[0]?.end, 2);
t("language placeholder reached the engine", transcribed.value?.cues?.[0]?.text, "这是用 zh 识别的第一句");
t("second cue text", transcribed.value?.cues?.[1]?.text, "second cue in latin script");
t("duration derived from cues", transcribed.value?.duration, 4);
ok("the SRT really exists on disk", (await stat(transcribed.value?.outputPath ?? "").catch(() => ({ size: 0 }))).size > 0, transcribed.value?.outputPath);

const overrideLang = await call(ctx.get("subtitle_transcribe"), { path: MEDIA, language: "en", outputName: "english.srt" });
ok("per-call language override succeeds", overrideLang.error === undefined, overrideLang.error);
t("override reached the engine", overrideLang.value?.cues?.[0]?.text, "这是用 en 识别的第一句");
ok("custom output name honoured", overrideLang.value?.outputPath?.endsWith("english.srt"), overrideLang.value?.outputPath);

// A CJK + space path must survive argument expansion and reach the child intact.
const cjkMedia = join(FIXTURES, "素材 音频.wav");
await writeFile(cjkMedia, "stub\n", "utf8");
const cjkRun = await call(ctx.get("subtitle_transcribe"), { path: cjkMedia, outputName: "中文 转写.srt" });
ok("CJK+space input path works", cjkRun.error === undefined, cjkRun.error);
ok("CJK output was produced", (await stat(cjkRun.value?.outputPath ?? "").catch(() => ({ size: 0 }))).size > 0, cjkRun.value?.outputPath);

/* ----------------------------------------------- engine diagnostics ---- */
console.log("\nengine diagnostics:");
const broken = Context({ outputDir: OUT, asrCommand: "definitely-not-a-real-engine-xyz" });
plugin.apply(broken, broken.config);
const brokenRun = await call(broken.get("subtitle_transcribe"), { path: MEDIA });
ok("an unreachable engine is reported with the command name",
	/failed to run|ENOENT|not found/u.test(brokenRun.error ?? ""), brokenRun.error);
const brokenStatus = await call(broken.get("subtitle_status"), {});
t("status reports the engine unreachable", brokenStatus.value?.asr?.available, false);
t("status marks it configured", brokenStatus.value?.asr?.configured, true);
ok("status render explains the failure", /UNREACHABLE/u.test(broken.get("subtitle_status").output.render({}, brokenStatus.value)[0].text),
	broken.get("subtitle_status").output.render({}, brokenStatus.value)[0].text);

const goodStatus = await call(ctx.get("subtitle_status"), {});
t("status reports our stand-in reachable", goodStatus.value?.asr?.available, true);
t("status echoes the configured model", goodStatus.value?.asr?.model, "large-v3");

// An engine that exits non-zero must surface its stderr, not a bare code.
const FAILING = join(FIXTURES, "failing-asr.mjs");
await writeFile(FAILING, "process.stderr.write('model file is missing\\n'); process.exit(4);\n", "utf8");
const failingCtx = Context({ outputDir: OUT, asrCommand: process.execPath, asrArgs: [FAILING] });
plugin.apply(failingCtx, failingCtx.config);
const failingRun = await call(failingCtx.get("subtitle_transcribe"), { path: MEDIA });
ok("non-zero engine exit surfaces stderr",
	/model file is missing/u.test(failingRun.error ?? ""), failingRun.error);
ok("non-zero exit reports the code", /exited with code 4/u.test(failingRun.error ?? ""), failingRun.error);

// An engine that exits 0 without writing anything must be diagnosed, not
// silently reported as zero cues.
const SILENT = join(FIXTURES, "silent-asr.mjs");
await writeFile(SILENT, "process.exit(0);\n", "utf8");
const silentCtx = Context({ outputDir: OUT + "-silent", asrCommand: process.execPath, asrArgs: [SILENT] });
plugin.apply(silentCtx, silentCtx.config);
const silentRun = await call(silentCtx.get("subtitle_transcribe"), { path: MEDIA });
ok("an engine that writes nothing is diagnosed",
	/produced no SRT/u.test(silentRun.error ?? ""), silentRun.error);

/* ----------------------------------------------------- full pipeline --- */
console.log("\nfull pipeline (transcribe → check → retime → convert → read):");
const SRC = join(FIXTURES, "pipeline.srt");
await writeFile(SRC, [
	"1", "00:00:00,000 --> 00:00:09,500", "这一句太长了需要被拆开因为它超过了七秒的上限。", "",
	"2", "00:00:10,000 --> 00:00:10,200", "太短", "",
	"3", "00:00:12,000 --> 00:00:14,000", "正常长度的一句", ""
].join("\n"), "utf8");

const audit = await call(ctx.get("subtitle_check"), { path: SRC });
ok("check finds the seeded defects", (audit.value?.issueCount ?? 0) >= 2, JSON.stringify(audit.value?.byKind));
ok("check flags the long cue", (audit.value?.byKind?.["too-long"] ?? 0) >= 1, JSON.stringify(audit.value?.byKind));
ok("check flags the short cue", (audit.value?.byKind?.["too-short"] ?? 0) >= 1, JSON.stringify(audit.value?.byKind));

const cleaned = await call(ctx.get("subtitle_convert"), {
	path: SRC, dialect: "srt", outputName: "cleaned.srt", splitLongerThan: 5, mergeOverlaps: true
});
ok("convert with split succeeds", cleaned.error === undefined, cleaned.error);
ok("splitting increased the cue count", (cleaned.value?.cueCount ?? 0) > 3, String(cleaned.value?.cueCount));

const reaudit = await call(ctx.get("subtitle_check"), { path: cleaned.value?.outputPath });
ok("the long cue is gone after splitting", (reaudit.value?.byKind?.["too-long"] ?? 0) === 0, JSON.stringify(reaudit.value?.byKind));

const shifted = await call(ctx.get("subtitle_retime"), {
	path: cleaned.value?.outputPath, offsetSeconds: 1.5, factor: 1.01, outputName: "shifted.srt"
});
ok("retime succeeds on the cleaned file", shifted.error === undefined, shifted.error);
ok("retime shifted forward", (shifted.value?.firstCueAfter ?? 0) > (shifted.value?.firstCueBefore ?? 0),
	`${shifted.value?.firstCueBefore} -> ${shifted.value?.firstCueAfter}`);

const toVtt = await call(ctx.get("subtitle_convert"), { path: shifted.value?.outputPath, dialect: "vtt", outputName: "final.vtt" });
ok("srt → vtt succeeds", toVtt.error === undefined, toVtt.error);
const vttText = await readFile(toVtt.value?.outputPath ?? "", "utf8");
ok("vtt starts with the WEBVTT header", vttText.startsWith("WEBVTT"), vttText.slice(0, 20));
ok("vtt uses dot-separated timestamps", /-->\s*\d\d:\d\d:\d\d\.\d\d\d/u.test(vttText), vttText.slice(0, 200));

const toAss = await call(ctx.get("subtitle_convert"), { path: toVtt.value?.outputPath, dialect: "ass", outputName: "final.ass" });
ok("vtt → ass succeeds", toAss.error === undefined, toAss.error);
const assText = await readFile(toAss.value?.outputPath ?? "", "utf8");
ok("ass has the Events section", assText.includes("[Events]"), "missing");
ok("ass has Dialogue lines", assText.includes("Dialogue: 0,"), "missing");

const finalRead = await call(ctx.get("subtitle_read"), { path: toAss.value?.outputPath });
ok("final ass reads back", finalRead.error === undefined, finalRead.error);
t("dialect survived the whole chain", finalRead.value?.dialect, "ass");
t("cue count survived the chain", finalRead.value?.cueCount, cleaned.value?.cueCount);
ok("text survived srt→vtt→ass", finalRead.value?.cues?.[0]?.text?.includes("这一句太长") === true,
	JSON.stringify(finalRead.value?.cues?.[0]?.text));

/* ----------------------------------------------------- write round-trip - */
console.log("\nwrite round-trip with timestamp strings:");
const written = await call(ctx.get("subtitle_write"), {
	dialect: "srt",
	cues: [
		{ start: "00:00:01,500", end: "00:00:03,000", text: "从时间戳字符串来" },
		{ start: 4, end: 6, text: "from seconds" },
		{ start: "00:00:07,000 --> 00:00:09,000\n整块 SRT 也被接受", end: 0, text: "" }
	],
	outputName: "roundtrip.srt"
});
// The third entry is an invalid object; expect a modelled rejection rather than
// a crash, proving cue coercion validates before writing.
ok("an invalid cue is rejected with a clear message",
	/is not after its start|no text|needs numeric/u.test(written.error ?? ""), written.error);

const goodWrite = await call(ctx.get("subtitle_write"), {
	dialect: "srt",
	cues: [
		{ start: "00:00:01,500", end: "00:00:03,000", text: "从时间戳字符串来" },
		{ start: 4, end: 6, text: "from seconds" }
	],
	outputName: "roundtrip.srt"
});
ok("valid cues write successfully", goodWrite.error === undefined, goodWrite.error);
const rtText = await readFile(goodWrite.value?.outputPath ?? "", "utf8");
ok("timestamp strings were normalised into SRT", rtText.includes("00:00:01,500 --> 00:00:03,000"), rtText.slice(0, 120));
ok("numeric seconds were normalised too", rtText.includes("00:00:04,000 --> 00:00:06,000"), rtText);
t("round-trip cue count", (await call(ctx.get("subtitle_read"), { path: goodWrite.value?.outputPath })).value?.cueCount, 2);

console.log(`\ne2e: ${pass} passed, ${fail} failed`);
await rm(OUT, { recursive: true, force: true }).catch(() => {});
await rm(OUT + "-silent", { recursive: true, force: true }).catch(() => {});
process.exit(fail === 0 ? 0 : 1);