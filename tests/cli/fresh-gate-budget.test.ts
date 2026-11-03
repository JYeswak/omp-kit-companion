import { afterAll, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { cleanupAllOwnedTmp } from "../../src/kitlib/tmp";
import { runSync } from "../../src/kitlib/run";
import { AMPLE, copyJudgingFiles, MANIFEST_HEADER, affectedArchive, assertPhases, candidateRepo, fixtureMetrics, gate, gateFunctions, gateTree, ledger, measuredFiles, root, runFocused, saveFixture } from "./fresh-gate.helpers.ts";

test.skipIf(!AMPLE)("SUITEBUDGET1 reports, without refusing, a successful file over the heuristic per-file cap", () => {
	const source = readFileSync(gate, "utf8");
	const fx = saveFixture(0, { slots: 8, max_wait_s: 30 });
	try {
		const judge = join(fx.dir, "judge");
		const scripts = join(judge, "scripts");
		mkdirSync(scripts, { recursive: true });
		mkdirSync(join(judge, ".github"));
		copyJudgingFiles(judge, [".github/test-budget.json"]);
		for (const name of ["gate-disk-floor.ts", "affected-tests.ts", "gate-ci-only.tsv"]) {
			symlinkSync(join(root, "scripts", name), join(scripts, name));
		}
		const policy = join(judge, ".github/test-budget.json");
		const measuredPolicy = JSON.parse(readFileSync(join(root, ".github/test-budget.json"), "utf8")).changed_file_budget;
		const configure = (cycle: number) => writeFileSync(policy, JSON.stringify({
			version: 1, requirements: { push_p95_s: 600, full_cycle_s: cycle },
			initial_heuristic: { per_file_cap_s: cycle / 4, derivation: "full_cycle_s / 4",
				status: "INITIAL_HEURISTIC_NOT_DISTRIBUTION_DERIVED", mode: "report" },
			changed_file_budget: { ...measuredPolicy, grandfathered: {}, references: {} },
		}));
		const archive = affectedArchive(fx, 42, 42);
		configure(900);
		const control = runFocused(fx, source, archive, "lib/mod.ts", scripts);
		expect(control.code, control.out).toBe(0);
		// A fixture-only tiny cap exercises the real measured refusal without a
		// five-minute sleeper or a forged timing row. Product policy is untouched.
		configure(0.004);
		const reported = runFocused(fx, source, archive, "lib/mod.ts", scripts);
		expect(reported.code, reported.out).toBe(0);
		expect(reported.out).toContain("OVER_BUDGET");
		expect(reported.out).toContain("tests/cli/mod.test.ts");
		const record = ledger(fx).at(-1)!;
		expect(record.rc).toBe(0);
		const timing = record.timing as Record<string, unknown>;
		const stages = timing.stages as Record<string, unknown>;
		expect(Object.keys(stages)).toContain("focused");
		expect(Object.keys(stages)).toContain("tests-admission");
		assertPhases(stages.focused);
		assertPhases(stages["tests-admission"]);
		const files = measuredFiles(record);
		expect(files[0]!.rc).toBe(0);
		expect(files[0]!.elapsed_ms).toBeGreaterThan(1);
		assertPhases(stages.bun);
		for (const name of ["sh", "python3"]) {
			expect(stages[name]).toMatchObject({
				file_count: 0, phase_basis: "per-file-sum", wait_ms: 0, setup_ms: 0, run_ms: 0,
			});
		}
	} finally {
		rmSync(fx.dir, { recursive: true, force: true });
	}
}, 120_000);

test.skipIf(!AMPLE || process.env.OMP_KIT_LITERAL_SUITE_BUDGET !== "1")("SUITEBUDGET1 literal 10-second control and 300-second file", () => {
	const source = readFileSync(gate, "utf8");
	const fx = saveFixture(0, { slots: 8, max_wait_s: 30 });
	try {
		const archive = affectedArchive(fx, 42, 42);
		writeFileSync(join(archive, "tests/cli/ten.test.sh"), '#!/bin/sh\nsleep 10\nprintf "ten-second control passed\\n"\n');
		writeFileSync(join(archive, "tests/cli/three-hundred.test.sh"), '#!/bin/sh\nsleep 300\nprintf "three-hundred-second file passed\\n"\n');
		const control = runFocused(fx, source, archive, "tests/cli/ten.test.sh");
		expect(control.code, control.out).toBe(0);
		const slow = runFocused(fx, source, archive, "tests/cli/three-hundred.test.sh");
		console.log(slow.out);
		const assertBudgetRefusal = (code: number, out: string) => {
			expect(code, out).not.toBe(0);
			expect(out).toContain("OVER_BUDGET");
			expect(out).toContain("tests/cli/three-hundred.test.sh");
			expect(out).toContain('"cap_s":90');
		};
		assertBudgetRefusal(slow.code, slow.out);
		const rows = measuredFiles(ledger(fx).at(-1)!);
		expect(rows[0]!.elapsed_ms).toBeGreaterThanOrEqual(300000);
		expect(rows[0]!.rc).toBe(0);

		// Remove only the fixture gate's budget enforcement, not the measured run.
		const enforcement = '\t\tbun run --no-env-file --config=/dev/null "$SCRIPT_DIR/test-budget.ts" \\\n\t\t\t--repo "$SCRIPT_DIR/.." --enforce "$metric_rows" --changed-files "$WORK/budget-changed-files" --workers "$budget_workers" --default-workers "$budget_default_workers" --annotate-records --json || budget_rc=$?\n';
		const withoutEnforcement = source.replace(enforcement, "\t\t:\n");
		expect(withoutEnforcement).not.toBe(source);
		const unchecked = runFocused(fx, withoutEnforcement, archive, "tests/cli/three-hundred.test.sh");
		console.log("SUITEBUDGET1 literal enforcement removed", unchecked.out);
		expect(unchecked.code, unchecked.out).toBe(0);
		const uncheckedRows = measuredFiles(ledger(fx).at(-1)!);
		expect(uncheckedRows[0]!.elapsed_ms).toBeGreaterThanOrEqual(300000);
		expect(uncheckedRows[0]!.rc).toBe(0);
		expect(() => assertBudgetRefusal(unchecked.code, unchecked.out)).toThrow();
	} finally {
		rmSync(fx.dir, { recursive: true, force: true });
	}
}, 720_000);

test.skipIf(!AMPLE)("FILEBUDGET1 own timed run admits a normal changed file and refuses a planted over-budget file", () => {
	const source = readFileSync(gate, "utf8");
	const fx = saveFixture(0, { slots: 8, max_wait_s: 30 });
	try {
		const scripts = gateTree(fx, MANIFEST_HEADER);
		const policyPath = join(scripts, "../.github/test-budget.json");
		const policy = JSON.parse(readFileSync(policyPath, "utf8"));
		const archive = affectedArchive(fx, 42, 42);
		const fast = runFocused(fx, source, archive, "tests/cli/mod.test.ts", scripts);
		expect(fast.code, fast.out).toBe(0);
		expect(fast.out).toContain("VERDICT TESTED");
		// A fixture-only tight policy proves the real measured boundary without
		// a 90-second sleeper, forged measurement, or an extra production run.
		policy.changed_file_budget.cap_s = 0.001;
		writeFileSync(policyPath, JSON.stringify(policy));
		const slow = runFocused(fx, source, archive, "tests/cli/mod.test.ts", scripts);
		expect(slow.code, slow.out).toBe(1);
		expect(slow.out).toContain("FILE_OVER_BUDGET");
		expect(slow.out).toContain("private-index-land-2/-3 and kit-update-*");
		expect(slow.out).toContain('"cap_s":0.001');
		const row = measuredFiles(ledger(fx).at(-1)!)[0]!;
		expect(row.rc).toBe(0);
		expect(row.elapsed_ms).toBeGreaterThan(1);
	} finally {
		rmSync(fx.dir, { recursive: true, force: true });
	}
}, 120_000);

test("FILEBUDGET1 policy ratchet uses Git predecessor bytes even for a docs-only change", () => {
	const source = readFileSync(gate, "utf8");
	const fx = saveFixture(0, { slots: 8, max_wait_s: 30 });
	try {
		const repo = candidateRepo(fx);
		mkdirSync(join(repo, ".github"));
		const policy = JSON.parse(readFileSync(join(root, ".github/test-budget.json"), "utf8"));
		const policyPath = join(repo, ".github/test-budget.json");
		writeFileSync(policyPath, JSON.stringify(policy));
		const identity = ["-c", "user.name=fresh-gate test", "-c", "user.email=fresh-gate@example.invalid", "-c", "core.hooksPath=/dev/null", "-c", "commit.gpgsign=false"];
		for (const args of [["add", ".github/test-budget.json"], [...identity, "commit", "-q", "-m", "[test] file budget baseline"]]) {
			const result = runSync(["git", "-C", repo, ...args], { deadline_s: 10 });
			expect(result.rc, new TextDecoder().decode(result.stderr)).toBe(0);
		}
		const archive = affectedArchive(fx, 42, 42);
		mkdirSync(join(archive, ".github"));
		const candidate = join(archive, ".github/test-budget.json");
		writeFileSync(candidate, JSON.stringify(policy));
		const probe = join(fx.dir, "file-policy.sh");
		writeFileSync(probe, `set -eu\n${gateFunctions(source, ["fail", "gate_file_budget_policy"])}gate_file_budget_policy\n`);
		const check = (base = "HEAD") => {
			const result = runSync(["sh", probe], { deadline_s: 15, env: {
				...process.env, ...fx.env, ROOT: repo, FRESH_GATE_REPO: repo, BASE: base, COMMIT: "HEAD",
				ARCHIVE_DIR: archive, SCRIPT_DIR: join(root, "scripts"), CHANGED: "docs/notes.md",
			} });
			return { rc: result.rc, out: new TextDecoder().decode(result.stdout) + new TextDecoder().decode(result.stderr) };
		};
		expect(check().rc).toBe(0);
		// Pre-push exports FRESH_GATE_REPO. Bind it to the owned fixture rather
		// than silently checking the outer checkout's pre-adoption policy.
		const missing = check("refs/heads/filebudget-missing-baseline");
		expect(missing.rc, missing.out).toBe(1);
		expect(missing.out).toContain("cannot read predecessor test-budget policy at refs/heads/filebudget-missing-baseline");
		expect(missing.out).not.toContain("FILE_BUDGET_POLICY OK");
		policy.changed_file_budget.grandfathered["new.test.ts"] = { measured_s: 131, evidence: "planted increase" };
		writeFileSync(candidate, JSON.stringify(policy));
		const refused = check();
		expect(refused.rc).toBe(1);
		expect(refused.out).toContain("FILE_BUDGET_RATCHET new.test.ts");
		expect(refused.out).not.toContain("affected tests:");
	} finally {
		rmSync(fx.dir, { recursive: true, force: true });
	}
});
test.skipIf(!AMPLE)("CIGATE1 wall budget: past the budget the nearest tests run and the rest are deferred by name in a PARTIAL verdict (needs >= 10 GiB free)", () => {
	const source = readFileSync(gate, "utf8");
	const fx = saveFixture(0, { slots: 8, max_wait_s: 30 });
	try {
		const archive = affectedArchive(fx, 42, 42);
		for (const n of [2, 3]) writeFileSync(join(archive, `tests/cli/mod${n}.test.ts`), `import { expect, test } from "bun:test";\nimport { answer } from "../../lib/mod.ts";\ntest("answer ${n}", () => { expect(answer()).toBe(42); });\n`);
		// Untimed files plan at 10 s each; a 5 s budget keeps only the changed test (nearest first).
		fx.env.FRESH_GATE_TEST_BUDGET_SECS = "5";
		const partial = runFocused(fx, source, archive, "lib/mod.ts\ntests/cli/mod3.test.ts");
		expect(partial.code).toBe(0);
		expect(partial.out).toContain("affected-tests plan: run 1, defer 2");
		expect(partial.out).toContain("focused: deferred tests/cli/mod.test.ts (over the 5 s wall budget); the release's full suite runs it");
		expect(partial.out).toContain("FRESH-GATE: VERDICT PARTIAL files=1 ran=1 deferred=tests/cli/mod.test.ts,tests/cli/mod2.test.ts: CI runs the deferred files");
		delete fx.env.FRESH_GATE_TEST_BUDGET_SECS;
		const full = runFocused(fx, source, archive, "lib/mod.ts");
		expect(full.out).toContain("FRESH-GATE: VERDICT TESTED files=3 ran=3");
	} finally {
		rmSync(fx.dir, { recursive: true, force: true });
	}
}, 120_000);
test("FILEBUDGET1 fixture metrics refuse a missing or duplicate production load-sampler anchor", () => {
	expect(() => fixtureMetrics("def unrelated():\n    return 0\n")).toThrow("anchor must occur exactly once");
	const producer = readFileSync(join(root, "scripts/suite-metrics.py"), "utf8");
	expect(() => fixtureMetrics(producer + producer)).toThrow("anchor must occur exactly once");
});

test.skipIf(!AMPLE)("FILEBUDGET1 v2 a busy otherwise-green commit proceeds without budget PASS credit", () => {
	const source = readFileSync(gate, "utf8");
	const fx = saveFixture(0, { slots: 8, max_wait_s: 30 });
	try {
		const scripts = gateTree(fx, MANIFEST_HEADER);
		// Deliberately synthetic host telemetry; native wall/CPU work is unchanged.
		writeFileSync(join(scripts, "suite-metrics.py"), fixtureMetrics(readFileSync(join(root, "scripts/suite-metrics.py"), "utf8"), 1000));
		const archive = affectedArchive(fx, 42, 42);
		fx.env.FRESH_GATE_PASSED_OUT = join(fx.dir, "native-passed-budget-not-calibrated");
		const result = runFocused(fx, source, archive, "tests/cli/mod.test.ts", scripts);
		expect(result.code, result.out).toBe(0);
		expect(result.out).toContain("NOT_CALIBRATED");
		expect(result.out).toContain("busy machine");
		expect(result.out).not.toContain("Split this file");
		expect(result.out).toContain("no budget PASS credit; other gates continue");
		expect(result.out).toContain("VERDICT TESTED");
		expect(result.out).toContain("LOADGATE1 GREEN");
		expect(existsSync(fx.env.FRESH_GATE_PASSED_OUT)).toBe(true);
		const reused = JSON.parse(readFileSync(fx.env.FRESH_GATE_PASSED_OUT + ".timings.json", "utf8"));
		expect(reused[0].rc).toBe(0);
		expect(reused[0].file_budget.status).toBe("NOT_CALIBRATED");
		expect(ledger(fx).at(-1)!.rc).toBe(0);
	} finally {
		rmSync(fx.dir, { recursive: true, force: true });
	}
}, 120_000);

afterAll(() => cleanupAllOwnedTmp());
