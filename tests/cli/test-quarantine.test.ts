import { ownedTmp } from "../../src/kitlib/tmp.ts";
import { afterAll, beforeAll, expect, test } from "bun:test";
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { checkRegistry, gate, readJunit, type QuarantineEntry } from "../../scripts/test-quarantine.ts";

const script = resolve(import.meta.dir, "../../scripts/test-quarantine.ts");
const TODAY = "2026-10-19";
const FAILING = "fixture.test.ts::flaky group > intermittent";
const PASSING = "fixture.test.ts::steady";
let temp = "";
let junit = "";
let counter = "";

function entry(overrides: Partial<QuarantineEntry> = {}): QuarantineEntry {
	return {
		test: FAILING, category: "FLAKE-TIMING", owner: "CIFlake", bead: "ompkit-v66l.27.2",
		quarantined: "2026-10-15", expires: "2026-10-29", evidence: ["39160166236"],
		repro: "bun test ./fixture.test.ts", reason: "fixture flake", remove_when: "green on 20 consecutive push runs", ...overrides,
	};
}
const registry = (...entries: QuarantineEntry[]) => JSON.stringify({ schema_version: 1, entries });
function cli(args: string[], entries: QuarantineEntry[]) {
	const file = join(temp, `registry-${Math.random().toString(36).slice(2)}.json`);
	writeFileSync(file, registry(...entries));
	const [mode, ...rest] = args;
	const child = Bun.spawnSync([process.execPath, script, mode!, "--file", file, "--today", TODAY, ...rest], { cwd: temp, stdout: "pipe", stderr: "pipe" });
	return { code: child.exitCode, out: child.stdout.toString() + child.stderr.toString() };
}

// A real bun JUnit report: one passing test and one failing test inside a describe block.
beforeAll(() => {
	temp = ownedTmp("omp-kit-quarantine").path;
	counter = join(temp, "executions.log");
	writeFileSync(join(temp, "fixture.test.ts"), [
		'import { appendFileSync } from "node:fs";',
		'import { describe, expect, test } from "bun:test";',
		`appendFileSync(${JSON.stringify(counter)}, "ran\\n");`,
		'test("steady", () => expect(1).toBe(1));',
		'describe("flaky group", () => { test("intermittent", () => expect(1).toBe(2)); });',
		"",
	].join("\n"));
	junit = join(temp, "fixture.xml");
	const child = Bun.spawnSync([process.execPath, "test", "./fixture.test.ts", "--reporter=junit", `--reporter-outfile=${junit}`], { cwd: temp, stdout: "pipe", stderr: "pipe" });
	expect(child.exitCode).toBe(1);
});
afterAll(() => { if (temp) rmSync(temp, { recursive: true, force: true }); });

test("the committed registry is well formed and holds no expired entry", () => {
	const child = Bun.spawnSync([process.execPath, script, "check"], { stdout: "pipe", stderr: "pipe" });
	expect(child.exitCode, child.stdout.toString() + child.stderr.toString()).toBe(0);
});

test("planted: an entry past its expiry fails the check; inside its window it passes", () => {
	expect(cli(["check"], [entry()])).toMatchObject({ code: 0 });
	const expired = cli(["check"], [entry({ quarantined: "2026-10-01", expires: "2026-10-14" })]);
	expect(expired.code).toBe(1);
	expect(expired.out).toContain(`${FAILING}: EXPIRED 5d ago (bead ompkit-v66l.27.2, owner CIFlake)`);
	// The expiry day itself is still inside the window; the next day is not.
	expect(cli(["check"], [entry({ quarantined: "2026-10-05", expires: TODAY })]).code).toBe(0);
});

test("entries without evidence, bead, exit condition or a bounded window are refused", () => {
	const errors = (value: unknown) => checkRegistry(JSON.stringify({ schema_version: 1, entries: [value] }), TODAY).errors;
	expect(errors(entry({ expires: "2026-10-30" }))).toEqual([`${FAILING}: quarantine window 15d exceeds 14d`]);
	expect(errors({ ...entry(), bead: "" })[0]).toContain("missing bead");
	expect(errors({ ...entry(), remove_when: " " })[0]).toContain("missing remove_when");
	expect(errors(entry({ evidence: [] }))[0]).toContain("evidence must list the CI runs");
	expect(errors(entry({ category: "FLAKE-WHATEVER" as QuarantineEntry["category"] }))[0]).toContain("category must be one of");
	expect(errors(entry({ quarantined: "2026-10-20", expires: "2026-10-21" }))[0]).toContain("is after today");
	expect(errors(entry({ test: "intermittent" }))[0]).toContain("<file>::<describe> > <name>");
	expect(checkRegistry(registry(entry(), entry()), TODAY).errors).toEqual([`${FAILING}: duplicate entry`]);
	expect(checkRegistry("{}", TODAY).errors).toEqual(["quarantine registry needs schema_version 1 and an entries array"]);
});

test("bun's JUnit report names each case by file and describe path", () => {
	expect(readJunit(readFileSync(junit, "utf8"))).toEqual([
		{ id: PASSING, file: "fixture.test.ts", status: "pass" },
		{ id: FAILING, file: "fixture.test.ts", status: "fail" },
	]);
});

test("a quarantined failure still runs and is reported, but only it stops failing the step", () => {
	const cases = readJunit(readFileSync(junit, "utf8"));
	const bare = gate(checkRegistry(registry(), TODAY), cases, 1);
	expect(bare.exitCode).toBe(1);
	expect(bare.lines).toContain(`FAIL ${FAILING}`);

	const held = gate(checkRegistry(registry(entry()), TODAY), cases, 1);
	expect(held.exitCode, held.lines.join("\n")).toBe(0);
	expect(held.lines).toContain(`QUARANTINED-FAIL ${FAILING} (bead ompkit-v66l.27.2, expires 2026-10-29, repro: bun test ./fixture.test.ts)`);
	expect(held.report).toMatchObject({ ran: 2, failed: 1, quarantined_failures: [FAILING], unquarantined_failures: [] });

	// Quarantining the wrong test hides nothing.
	const wrong = gate(checkRegistry(registry(entry({ test: PASSING })), TODAY), cases, 1);
	expect(wrong.exitCode).toBe(1);
	expect(wrong.lines).toContain(`QUARANTINED-PASS ${PASSING} (remove when: green on 20 consecutive push runs)`);
	expect(wrong.lines).toContain(`FAIL ${FAILING}`);

	// An expired entry no longer holds its test, and fails the step by itself.
	const expired = gate(checkRegistry(registry(entry({ quarantined: "2026-10-01", expires: "2026-10-14" })), TODAY), cases, 1);
	expect(expired.exitCode).toBe(1);
	expect(expired.lines).toContain(`FAIL ${FAILING}`);
});

test("stale entries, unexplained bun failures and an empty report fail the gate", () => {
	const cases = readJunit(readFileSync(junit, "utf8"));
	const stale = gate(checkRegistry(registry(entry(), entry({ test: "fixture.test.ts::renamed away" })), TODAY), cases, 1);
	expect(stale.exitCode).toBe(1);
	expect(stale.lines).toContain("ERROR fixture.test.ts::renamed away: stale quarantine entry; its file ran but the test is gone");
	// An entry for a file this shard did not run is not stale.
	expect(gate(checkRegistry(registry(entry(), entry({ test: "other.test.ts::elsewhere" })), TODAY), cases, 1).exitCode).toBe(0);

	const passing = cases.filter(test => test.status === "pass");
	expect(gate(checkRegistry(registry(), TODAY), passing, 0).exitCode).toBe(0);
	const crashed = gate(checkRegistry(registry(), TODAY), passing, 1);
	expect(crashed.exitCode).toBe(1);
	expect(crashed.lines).toContain("ERROR bun test exited 1 but no testcase failed (crash, load error or hook failure outside a test)");
	expect(gate(checkRegistry(registry(), TODAY), [], 0).exitCode).toBe(1);
});

test("run executes the suite exactly once, never retrying, and gates its report", () => {
	const before = readFileSync(counter, "utf8").split("\n").filter(Boolean).length;
	const report = join(temp, "run-junit.xml");
	const held = cli(["run", "--junit", report, "--", "bun", "test", "./fixture.test.ts"], [entry()]);
	expect(held.code, held.out).toBe(0);
	expect(held.out).toContain(`QUARANTINED-FAIL ${FAILING}`);
	expect(existsSync(report)).toBe(true);
	const bare = cli(["run", "--junit", report, "--", "bun", "test", "./fixture.test.ts"], []);
	expect(bare.code).toBe(1);
	expect(readFileSync(counter, "utf8").split("\n").filter(Boolean).length - before).toBe(2);
});
