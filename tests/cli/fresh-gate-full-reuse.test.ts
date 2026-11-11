// Coverage: scripts/fresh-gate.sh, scripts/full-suite-verdict-store.py.
import { afterAll, expect, test } from "bun:test";
import { chmodSync, copyFileSync, existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { cleanupAllOwnedTmp } from "../../src/kitlib/tmp";
import { runSync } from "../../src/kitlib/run";
import { AMPLE, affectedArchive, candidateRepo, copyJudgingFiles, gate, gateFunctions, gateTree, MANIFEST_HEADER, root, saveFixture } from "./fresh-gate.helpers";

import { fixtureDeadlineS } from "./fixture-process";
afterAll(() => cleanupAllOwnedTmp());

// Keep the production argument parser, archive setup and focused gate intact. Only the unrelated
// compile/manifest/harness phases are excluded, as in runFocused, so this tests pre-push's call shape.
function runArchive(pass: boolean, supplyRepo = true) {
	const fx = saveFixture(0, { max_load: 1000, reserve_gib: 0 });
	const archive = affectedArchive(fx, 1, 1);
	const repo = candidateRepo(fx);
	const scripts = gateTree(fx, MANIFEST_HEADER);
	const source = readFileSync(gate, "utf8");
	const dispatch = "\nrun_gate &\n";
	expect(source.split(dispatch)).toHaveLength(2);
	const script = join(scripts, "fresh-gate.sh");
	// gateTree links judging scripts to source; replace only this fixture-owned link.
	if (existsSync(script)) unlinkSync(script);
	writeFileSync(script, source.replace(dispatch, "\nrun_gate() { gate_focused; }\nrun_gate &\n"));
	// Startup checks require these archive members; the focused phase never executes them.
	mkdirSync(join(archive, "scripts"));
	for (const name of ["build-manifest.sh", "ttsr-harness.ts"]) writeFileSync(join(archive, "scripts", name), "");
	const calls = join(fx.dir, "store-call");
	const python = Bun.which("python3");
	if (!python) throw new Error("python3 is required");
	// Stub only the store response, recording every real require-pass argument. Other Python work
	// (including record_run) uses the real interpreter. No operator verdicts are read or written.
	const shim = join(fx.dir, "bin/python3");
	writeFileSync(shim, `#!/bin/sh
if [ "$1" = full-suite-verdict-store.py ]; then
  printf '%s\\n' "$@" >${JSON.stringify(calls)}
  echo ${pass ? "PASS" : "MISS"}
  exit ${pass ? 0 : 1}
fi
exec '${python}' "$@"
`);
	chmodSync(shim, 0o755);
	// Replace the fixture-owned policy link before admitting its store shim.
	const policy = join(scripts, "fixed-env.sh");
	const pinned = readFileSync(policy, "utf8");
	unlinkSync(policy);
	writeFileSync(policy, `${pinned}\nPATH="${join(fx.dir, "bin")}:$PATH"\nexport PATH\n`);
	const git = (args: string[]) => {
		const result = runSync(["git", "-C", repo, ...args], { deadline_s: fixtureDeadlineS(10) });
		if (result.rc !== 0) throw new Error(Buffer.from(result.stderr).toString());
		return Buffer.from(result.stdout).toString().trim();
	};
	const commit = git(["rev-parse", "HEAD"]);
	const tree = git(["rev-parse", `${commit}^{tree}`]);
	const env: Record<string, string | undefined> = { ...process.env, ...fx.env, STORE_CALL: calls, FRESH_GATE_LEDGER: "" };
	delete env.FRESH_GATE_REPO;
	if (supplyRepo) env.FRESH_GATE_REPO = repo;
	const result = runSync(["sh", script, "--commit", commit, "--archive-dir", archive, "--changed-file", "scripts/pysafe.py"], { env, deadline_s: fixtureDeadlineS(120) });
	return { code: result.rc, out: Buffer.from(result.stdout).toString() + Buffer.from(result.stderr).toString(),
		args: existsSync(calls) ? readFileSync(calls, "utf8").trim().split("\n") : [],
		expected: ["full-suite-verdict-store.py", "require-pass", "--repo", repo, "--tree", tree, "--role", "main", "--judge-root", `${scripts}/..`, "--suite-root", resolve(archive)] };
}

(AMPLE ? test : test.skip)("FULLREUSE1 reuses the exact candidate tree PASS through pre-push archive arguments", () => {
	const result = runArchive(true);
	expect(result.out).toContain("FRESH-GATE: VERDICT FULL_SUITE_REUSED");
	expect(result.code).toBe(0);
	expect(result.args).toEqual(result.expected);
}, 120_000);

(AMPLE ? test : test.skip)("FULLREUSE1 refuses the same archive call when no PASS is recorded", () => {
	const result = runArchive(false);
	expect(result.out).toContain("FULL_SUITE_REQUIRED");
	expect(result.code).toBe(1);
	expect(result.args).toEqual(result.expected);
}, 120_000);

(AMPLE ? test : test.skip)("FULLREUSE1 caller-owned archive without candidate repo never consults the store", () => {
	const result = runArchive(true, false);
	expect(result.out).toContain("FULL_SUITE_REQUIRED");
	expect(result.code).toBe(1);
	expect(result.args).toEqual([]);
}, 120_000);

(AMPLE ? test : test.skip)("FULLJUDGE1 the refusal teaches the consulted judge; its command records a PASS the same gate reuses; another judge stays MISS", () => {
	const fx = saveFixture(0, { max_load: 1000, reserve_gib: 0 });
	const cache = join(fx.dir, "verdict-cache");
	mkdirSync(cache, { recursive: true });
	const callerTmp = join(fx.dir, "caller-tmp");
	mkdirSync(callerTmp, { recursive: true });
	// Tiny candidate: one passing bun test plus the runner helper the verdict sources.
	const repo = join(fx.dir, "candidate");
	mkdirSync(join(repo, "scripts"), { recursive: true });
	mkdirSync(join(repo, "tests/cli"), { recursive: true });
	copyFileSync(join(root, "scripts/kitlib-tmp.sh"), join(repo, "scripts/kitlib-tmp.sh"));
	writeFileSync(join(repo, "tests/cli/mod.test.ts"), 'import { expect, test } from "bun:test";\ntest("ok", () => { expect(1).toBe(1); });\n');
	const git = (args: string[]) => {
		const result = runSync(["git", "-C", repo, "-c", "user.name=FULLJUDGE1 test", "-c", "user.email=fulljudge1@example.invalid", "-c", "core.hooksPath=/dev/null", "-c", "commit.gpgsign=false", ...args], { env: { ...process.env, ...fx.env }, deadline_s: fixtureDeadlineS(30) });
		if (result.rc !== 0) throw new Error(`git ${args.join(" ")} failed: ${Buffer.from(result.stderr).toString()}`);
		return Buffer.from(result.stdout).toString().trim();
	};
	git(["init", "-q"]);
	git(["add", "-A"]);
	git(["commit", "-q", "-m", "[test] FULLJUDGE1 fixture"]);
	const commit = git(["rev-parse", "HEAD"]);
	const tree = git(["rev-parse", `${commit}^{tree}`]);
	// The gate archive is the exact candidate tree, so its declared suite matches the recorded verdict.
	const tarball = join(fx.dir, "candidate.tar");
	const archive = join(fx.dir, "archive");
	mkdirSync(archive, { recursive: true });
	expect(runSync(["git", "-C", repo, "archive", "--format=tar", "-o", tarball, commit], { env: { ...process.env, ...fx.env }, deadline_s: fixtureDeadlineS(30) }).rc).toBe(0);
	expect(runSync(["tar", "-xf", tarball, "-C", archive], { env: { ...process.env, ...fx.env }, deadline_s: fixtureDeadlineS(30) }).rc).toBe(0);

	const source = readFileSync(gate, "utf8");
	const probe = join(fx.dir, "fulljudge-probe.sh");
	writeFileSync(probe, `set -eu\ngate_defer_record=1\nlast_record_tests=0; last_record_files=0\n${gateFunctions(source, ["fail", "run_step", "heavy_step", "print_budget_skip", "select_affected_tests", "test_workers", "run_affected_tests", "changed_code", "deleted_code", "expand_changed_with_importers", "apply_ci_only", "record_run", "gate_focused"])}rc=0\nrun_step focused gate_focused || rc=$?\ngate_defer_record=0\nrecord_run "$last_record_tests" "$last_record_files" "$rc"\nexit "$rc"\n`);
	const gateEnv = { ...process.env, ...fx.env, ROOT: repo, TMPDIR: callerTmp, WORK: fx.dir, FRESH_GATE_LEDGER: "", FRESH_GATE_REPO: repo, COMMIT: commit, ARCHIVE_DIR: archive, SCRIPT_DIR: join(root, "scripts"), CHANGED: "scripts/pysafe.py", FULL_SUITE_VERDICT_CACHE_DIR: cache };
	const runGate = () => {
		const result = runSync(["sh", probe], { env: gateEnv, deadline_s: fixtureDeadlineS(120) });
		return { code: result.rc, out: Buffer.from(result.stdout).toString() + Buffer.from(result.stderr).toString() };
	};

	// No verdict recorded: refused, teaching the exact consulted-judge command.
	const refused = runGate();
	expect(refused.code).toBe(1);
	expect(refused.out).toContain("FRESH-GATE: REFUSED reason=FULL_SUITE_REQUIRED");
	const expectedRemedy = `sh ${join(root, "scripts/full-suite-verdict.sh")} --repo ${repo} --commit ${commit} --judge-role main`;
	expect(refused.out).toContain(`run ${expectedRemedy}, then retry`);

	// The printed command, executed as printed, records a PASS ...
	const remedyFile = join(fx.dir, "remedy.sh");
	writeFileSync(remedyFile, `set -eu\n${expectedRemedy}\n`);
	const recorded = runSync(["sh", remedyFile], { env: { ...process.env, ...fx.env, TMPDIR: callerTmp, FULL_SUITE_VERDICT_CACHE_DIR: cache }, deadline_s: fixtureDeadlineS(170) });
	const recordedOut = Buffer.from(recorded.stdout).toString() + Buffer.from(recorded.stderr).toString();
	expect(recorded.rc).toBe(0);
	expect(recordedOut).toContain("VERDICT PASS");

	// ... which a rerun of the same gate reuses.
	const reused = runGate();
	expect(reused.code).toBe(0);
	expect(reused.out).toContain(`FRESH-GATE: VERDICT FULL_SUITE_REUSED tree=${tree}`);

	// Planted negative: the same tree recorded under this judge is still MISS from another judge.
	const other = join(fx.dir, "other-judge");
	copyJudgingFiles(other);
	unlinkSync(join(other, "scripts/suite-metrics.py"));
	writeFileSync(join(other, "scripts/suite-metrics.py"), `${readFileSync(join(root, "scripts/suite-metrics.py"), "utf8")}\n# FULLJUDGE1 planted-negative judge\n`);
	const negative = runSync(["python3", "scripts/full-suite-verdict-store.py", "require-pass", "--repo", repo, "--tree", tree, "--role", "main", "--judge-root", other, "--suite-root", archive], {
		env: { ...process.env, ...fx.env, FULL_SUITE_VERDICT_CACHE_DIR: cache }, cwd: root, deadline_s: fixtureDeadlineS(30),
	});
	expect(negative.rc).not.toBe(0);
	expect((Buffer.from(negative.stdout).toString() + Buffer.from(negative.stderr).toString()).trim()).toBe("MISS");
}, 240_000);
