#!/usr/bin/env bun
import { strict as assert } from "node:assert";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { runClaudeSaveJob, runGitleaksScan, type ClaudeSaveGit, type GitleaksScanRequest, type GitleaksScanResult, type GitleaksScanner } from "../../src/claude-save-job.ts";

type CompletedScan = Extract<GitleaksScanResult, { disposition: "COMPLETED" }>;
type Expectation = { job: "PUSHED"; scan: "COMPLETED" } | { job: "REFUSED"; refusal: string; scan: "COMPLETED" | "NOT_RUN" };

const scratch = mkdtempSync(join(process.env.TMPDIR ?? join(import.meta.dir, "../../var/agent-tmp"), "gitleaks-gate-e2e-"));
const records: Record<string, unknown>[] = [];
let assertionTotal = 0;

function git(repo: string, args: readonly string[], env?: Record<string, string>): ClaudeSaveGit {
	const out = Bun.spawnSync(["git", "-C", repo, ...args], { stdout: "pipe", stderr: "pipe", env: { ...process.env, HOME: repo, GIT_CONFIG_NOSYSTEM: "1", ...env } });
	return { code: out.exitCode ?? 1, stdout: out.stdout.toString(), stderr: out.stderr.toString() };
}

function fixture(name: string): { repo: string; origin: string } {
	const root = join(scratch, name);
	mkdirSync(root);
	const repo = join(root, "work");
	const origin = join(root, "origin.git");
	Bun.spawnSync(["git", "-c", "init.templatedir=", "init", "--bare", "-b", "main", origin], { stdout: "pipe", stderr: "pipe" });
	Bun.spawnSync(["git", "-c", "init.templatedir=", "init", "-b", "main", repo], { stdout: "pipe", stderr: "pipe" });
	git(repo, ["config", "user.email", "gitleaks-gate@test.invalid"]);
	git(repo, ["config", "user.name", "gitleaks-gate"]);
	git(repo, ["config", "commit.gpgsign", "false"]);
	writeFileSync(join(repo, "notes.md"), "fixture\n");
	git(repo, ["add", "notes.md"]);
	git(repo, ["commit", "-m", "fixture"]);
	git(repo, ["remote", "add", "origin", origin]);
	git(repo, ["push", "-u", "origin", "main"]);
	return { repo, origin };
}

function completed(request: GitleaksScanRequest, overrides: Partial<CompletedScan> = {}): CompletedScan {
	return {
		disposition: "COMPLETED",
		command: ["/fixture/gitleaks", "detect", "--source", request.target, "--no-git", "--report-format", "json", "--report-path", "/dev/stdout", "--no-banner", "--redact"],
		target: request.target,
		treeId: request.treeId,
		exitCode: 0,
		report: "[]",
		stderr: "",
		...overrides
	};
}

function scannerScript(name: string, body: string): string {
	const path = join(scratch, `${name}.sh`);
	writeFileSync(path, `#!/bin/sh\n${body}`);
	chmodSync(path, 0o700);
	return path;
}

async function exercise(name: string, expectation: Expectation, scanner?: GitleaksScanner, plannedLookup?: string): Promise<void> {
	const { repo } = fixture(name);
	writeFileSync(join(repo, "notes.md"), `candidate ${name}\n`);
	const before = git(repo, ["rev-parse", "HEAD"]).stdout.trim();
	let assertions = 0;
	const equal = (actual: unknown, expected: unknown, message: string): void => {
		assertions++;
		assert.equal(actual, expected, message);
	};
	let request: GitleaksScanRequest | undefined;
	let scan: GitleaksScanResult | undefined;
	const wrapped: GitleaksScanner | undefined = scanner === undefined ? undefined : input => {
		request = input;
		equal(input.treeId, git(repo, ["write-tree"]).stdout.trim(), `${name}: scanner received candidate tree`);
		scan = scanner(input);
		return scan;
	};
	const result = await runClaudeSaveJob({ enabled: true, repo, stateRoot: join(repo, "..", "state") }, {
		git: (args, env) => git(repo, args, env),
		gitleaks: wrapped,
		runId: name,
		nowIso: "2026-10-10T00:00:00Z"
	});
	const localHead = git(repo, ["rev-parse", "HEAD"]).stdout.trim();
	const remoteHead = git(repo, ["ls-remote", "origin", "refs/heads/main"]).stdout.split("\t")[0];
	const observedDisposition = scan?.disposition ?? "NOT_RUN";
	equal(result.status, expectation.job, `${name}: job disposition`);
	equal(observedDisposition, expectation.scan, `${name}: scan disposition`);
	if (scan && request) {
		const expectedArgs = ["detect", "--source", request.target, "--no-git", "--report-format", "json", "--report-path", "/dev/stdout", "--no-banner", "--redact"];
		equal(scan.command.slice(1).join("\0"), expectedArgs.join("\0"), `${name}: exact scanner arguments`);
	}
	if (expectation.job === "REFUSED") equal(result.refusal, expectation.refusal, `${name}: refusal`);
	if (expectation.job === "PUSHED") {
		equal(result.pushed, true, `${name}: push flag`);
		equal(remoteHead, localHead, `${name}: remote candidate`);
	} else {
		equal(result.committed, false, `${name}: no commit`);
		equal(localHead, before, `${name}: local HEAD unchanged`);
		equal(remoteHead, before, `${name}: remote HEAD unchanged`);
		equal(git(repo, ["diff", "--cached", "--name-only"]).stdout.trim(), "", `${name}: staged index reset`);
	}
	if (scan?.disposition === "COMPLETED" && expectation.job === "PUSHED") {
		equal(scan.exitCode, 0, `${name}: successful scanner exit`);
		equal(scan.report, "[]\n", `${name}: empty JSON report`);
	}
	if (scan?.disposition === "NOT_RUN" && scan.reason === "TIMEOUT") equal(result.reason?.includes(`${scan.timeoutMs}ms`), true, `${name}: timeout named`);
	const record = {
		fixture_id: name,
		candidate_tree_id: request?.treeId ?? null,
		command_lookup: plannedLookup ?? null,
		exact_command: scan?.command ?? null,
		exit_code: scan?.disposition === "COMPLETED" ? scan.exitCode : null,
		expected_scan_disposition: expectation.scan,
		observed_scan_disposition: observedDisposition,
		expected_job_disposition: expectation.job,
		observed_job_disposition: result.status,
		refusal: result.refusal ?? null,
		assertions: { passed: assertions, total: assertions }
	};
	records.push(record);
	assertionTotal += assertions;
	process.stdout.write(`${JSON.stringify(record)}\n`);
}

async function main(): Promise<void> {
	try {
		const clean = scannerScript("gitleaks-clean", 'test "$1" = "detect" || exit 91\nprintf \'[]\\n\'\n');
		const slow = scannerScript("gitleaks-timeout", "exec /bin/sleep 5\n");
		const missing = join(scratch, "missing-gitleaks");
		await exercise("clean-completed", { job: "PUSHED", scan: "COMPLETED" }, request => runGitleaksScan(clean, request, 1_000));
		await exercise("timeout", { job: "REFUSED", refusal: "GITLEAKS_TIMEOUT", scan: "NOT_RUN" }, request => runGitleaksScan(slow, request, 100));
		await exercise("missing-executable", { job: "REFUSED", refusal: "GITLEAKS_UNAVAILABLE", scan: "NOT_RUN" }, undefined, "Bun.which('gitleaks')");
		await exercise("spawn-failure", { job: "REFUSED", refusal: "GITLEAKS_FAILED", scan: "NOT_RUN" }, request => runGitleaksScan(missing, request, 100));
		await exercise("nonzero-empty-report", { job: "REFUSED", refusal: "GITLEAKS_FAILED", scan: "COMPLETED" }, request => completed(request, { exitCode: 2 }));
		await exercise("finding", { job: "REFUSED", refusal: "GITLEAKS_HIT", scan: "COMPLETED" }, request => completed(request, { exitCode: 1, report: '[{"RuleID":"fixture"}]' }));
		await exercise("missing-report", { job: "REFUSED", refusal: "GITLEAKS_REPORT_INVALID", scan: "COMPLETED" }, request => completed(request, { report: "" }));
		await exercise("truncated-report", { job: "REFUSED", refusal: "GITLEAKS_REPORT_INVALID", scan: "COMPLETED" }, request => completed(request, { report: "[{" }));
		await exercise("wrong-tree", { job: "REFUSED", refusal: "GITLEAKS_TREE_MISMATCH", scan: "COMPLETED" }, request => completed(request, { treeId: "different-tree" }));
		await exercise("wrong-target", { job: "REFUSED", refusal: "GITLEAKS_TREE_MISMATCH", scan: "COMPLETED" }, request => completed(request, { target: join(request.target, "other") }));
		process.stdout.write(`${JSON.stringify({ type: "summary", fixtures: records.length, assertions: assertionTotal, status: "PASS" })}\n`);
	} finally {
		rmSync(scratch, { recursive: true, force: true });
	}
}

await main();
