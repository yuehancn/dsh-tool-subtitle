// Run every dsh-tool-subtitle suite in order and report a combined total.
// Each suite exits non-zero on its own failures, so one run answers the whole
// question: is this plugin safe to publish?
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const suites = ["test-logic.mjs", "test-integration.mjs", "test-e2e.mjs"];
const here = fileURLToPath(new URL(".", import.meta.url));

/** Run one suite as a child process and return its exit code. */
function run(suite) {
	return new Promise((resolve) => {
		const child = spawn(process.execPath, [here + suite], { stdio: "inherit", windowsHide: true });
		child.on("close", (code) => resolve(code ?? 1));
		child.on("error", () => resolve(1));
	});
}

const results = [];
for (const suite of suites) {
	console.log(`\n${"=".repeat(60)}\n== ${suite}\n${"=".repeat(60)}`);
	results.push([suite, await run(suite)]);
}

console.log(`\n${"=".repeat(60)}`);
let failed = 0;
for (const [suite, code] of results) {
	console.log(`${code === 0 ? "PASS" : "FAIL"}  ${suite}`);
	if (code !== 0) failed += 1;
}
console.log(`${"=".repeat(60)}\n${failed === 0 ? "ALL SUITES PASSED" : `${failed} SUITE(S) FAILED`}`);
process.exit(failed === 0 ? 0 : 1);