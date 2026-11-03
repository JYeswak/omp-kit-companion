import { afterAll, expect, test } from "bun:test";
import { readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { cleanupAllOwnedTmp } from "../../src/kitlib/tmp";
import { AMPLE, affectedArchive, gate, ledger, measuredFiles, root, runFocused, saveFixture } from "./fresh-gate.helpers.ts";

test.skipIf(!AMPLE)("CIGATE1 planted: a src change runs the tests importing it; breaking it refuses the push (needs >= 10 GiB free)", () => {
	const source = readFileSync(gate, "utf8");
	const fx = saveFixture(0, { slots: 8, max_wait_s: 30 });
	try {
		const green = runFocused(fx, source, affectedArchive(fx, 42, 42), "lib/mod.ts");
		expect(green.code, green.out).toBe(0);
		expect(green.out).toContain("affected: tests/cli/mod.test.ts <- lib/mod.ts");
		expect(green.out).toContain("disk-floor: OK");
		expect(green.out).toContain("affected tests: files=1 ran=1 fail=0 rc=0");
		const broken = affectedArchive(fx, 41, 42);
		const red = runFocused(fx, source, broken, "lib/mod.ts");
		expect(red.code).not.toBe(0);
		expect(red.out).toContain("affected tests: files=1 ran=1 fail=1 rc=1");
		expect(red.out).toContain("FRESH-GATE: RED: affected tests did not pass (exit 1); the push is refused");
		expect(ledger(fx).map((row) => [row.selected_files, row.tests_ran, row.rc])).toEqual([[1, 1, 0], [1, 1, 1]]);
		// Mutant: a gate that ignores the suite's status passes the broken push.
		const ignoresFailure = source.replace('\t\treturn "$tests_rc"\n', "\t\treturn 0\n");
		expect(ignoresFailure).not.toBe(source);
		expect(runFocused(fx, ignoresFailure, broken, "lib/mod.ts").code).toBe(0);
	} finally {
		rmSync(fx.dir, { recursive: true, force: true });
	}
}, 120_000);

test.skipIf(!AMPLE)("GATEFLAKE1 retains a real fixture timeout without misclassifying an assertion failure", () => {
	const source = readFileSync(gate, "utf8");
	const fx = saveFixture(0, { slots: 8, max_wait_s: 30 });
	try {
		const timeoutArchive = affectedArchive(fx, 42, 42);
		// Real process expiry is the behavior under test; fake timers cannot expire kitlib's OS deadline.
		writeFileSync(join(timeoutArchive, "tests/cli/mod.test.ts"), `
import { test } from "bun:test";
import { runFixture } from ${JSON.stringify(join(root, "tests/cli/fixture-process.ts"))};
test("real fixture expiry", () => runFixture([process.execPath, "-e", "setTimeout(() => {}, 5000)"], {
	cwd: import.meta.dir, floor_s: 0.05, label: "gate-timeout",
}));
`);
		const timeout = runFocused(fx, source, timeoutArchive, "tests/cli/mod.test.ts");
		expect(timeout.code, timeout.out).toBe(1);
		expect(timeout.out).toContain('FRESH-GATE: RED: TIMEOUT_UNDER_LOAD label="gate-timeout"');
		expect(timeout.out).toContain("loadavg=");
		expect(timeout.out).toContain("workers=");

		const assertionArchive = affectedArchive(fx, 41, 42);
		writeFileSync(join(assertionArchive, "tests/cli/mod.test.ts"), `
import { expect, test } from "bun:test";
test("ordinary assertion failure", () => {
	// TIMEOUT_UNDER_LOAD loadavg=2 workers=1 is only a source excerpt.
	expect(41).toBe(42);
});
`);
		const assertion = runFocused(fx, source, assertionArchive, "tests/cli/mod.test.ts");
		expect(assertion.code, assertion.out).toBe(1);
		expect(assertion.out).toContain("TIMEOUT_UNDER_LOAD");
		expect(assertion.out).not.toContain("FRESH-GATE: RED: TIMEOUT_UNDER_LOAD");
		expect(assertion.out).toContain("FRESH-GATE: RED: affected tests did not pass (exit 1)");
		expect(ledger(fx).map(row => [row.selected_files, row.tests_ran, row.rc])).toEqual([[1, 1, 1], [1, 1, 1]]);
	} finally {
		rmSync(fx.dir, { recursive: true, force: true });
	}
}, 120_000);


test.skipIf(!AMPLE)("CIGATE1 shards: the selection runs in K parallel bun workers, and a failure in any shard refuses (needs >= 10 GiB free)", () => {
	const source = readFileSync(gate, "utf8");
	const fx = saveFixture(0, { slots: 8, max_wait_s: 30 });
	try {
		const archive = affectedArchive(fx, 42, 42);
		for (const n of [2, 3]) writeFileSync(join(archive, `tests/cli/mod${n}.test.ts`), `import { expect, test } from "bun:test";\nimport { answer } from "../../lib/mod.ts";\ntest("answer ${n}", () => { expect(answer() + ${n}).toBe(${42 + n}); });\n`);
		fx.env.FRESH_GATE_TEST_WORKERS = "2";
		const green = runFocused(fx, source, archive, "lib/mod.ts");
		expect(green.code).toBe(0);
		expect(green.out).toContain("affected bun tests: files=3 workers=2");
		const measured = measuredFiles(ledger(fx).at(-1)!).sort((a, b) => a.started_ms - b.started_ms);
		expect(measured.map(row => row.path).sort()).toEqual(["tests/cli/mod.test.ts", "tests/cli/mod2.test.ts", "tests/cli/mod3.test.ts"]);
		expect(measured.every(row => row.rc === 0)).toBe(true);
		expect(measured[1]!.started_ms).toBeLessThan(measured[0]!.finished_ms);
		expect(green.out).toContain("FRESH-GATE: VERDICT TESTED files=3 ran=3");
		writeFileSync(join(archive, "tests/cli/mod3.test.ts"), `import { expect, test } from "bun:test";\ntest("broken shard", () => { expect(1).toBe(2); });\n`);
		const red = runFocused(fx, source, archive, "lib/mod.ts\ntests/cli/mod3.test.ts");
		expect(red.code).not.toBe(0);
		expect(red.out).toContain("FRESH-GATE: RED: affected tests did not pass");
		// Paired serial control must not overlap file-process lifetimes.
		fx.env.FRESH_GATE_TEST_WORKERS = "1";
		writeFileSync(join(archive, "tests/cli/mod3.test.ts"), `import { expect, test } from "bun:test";\ntest("ok", () => { expect(1).toBe(1); });\n`);
		expect(runFocused(fx, source, archive, "lib/mod.ts").code).toBe(0);
		const serial = measuredFiles(ledger(fx).at(-1)!).sort((a, b) => a.started_ms - b.started_ms);
		expect(serial[1]!.started_ms).toBeGreaterThanOrEqual(serial[0]!.finished_ms);
	} finally {
		rmSync(fx.dir, { recursive: true, force: true });
	}
}, 120_000);
test.skipIf(!AMPLE)("CIGATE1 planted: a commit breaking the test it touches is refused (needs >= 10 GiB free)", () => {
	const source = readFileSync(gate, "utf8");
	const fx = saveFixture(0, { slots: 8, max_wait_s: 30 });
	try {
		const red = runFocused(fx, source, affectedArchive(fx, 42, 43), "tests/cli/mod.test.ts");
		expect(red.code).not.toBe(0);
		expect(red.out).toContain("affected: tests/cli/mod.test.ts <- tests/cli/mod.test.ts");
		expect(red.out).toContain("FRESH-GATE: RED: affected tests did not pass");
	} finally {
		rmSync(fx.dir, { recursive: true, force: true });
	}
}, 120_000);
afterAll(() => cleanupAllOwnedTmp());
