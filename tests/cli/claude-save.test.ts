import { afterEach, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { checkSkillLibrary, claudeSaveJobEnabled, runClaudeSaveJob, runGitleaksScan, type ClaudeSaveConfig, type ClaudeSaveGit, type GitleaksScanRequest, type GitleaksScanResult, type GitleaksScanner } from "../../src/claude-save-job.ts";

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

function sh(repo: string, ...args: string[]): ClaudeSaveGit {
	const out = Bun.spawnSync(["git", "-C", repo, ...args], { stdout: "pipe", stderr: "pipe", env: { ...process.env, GIT_CONFIG_NOSYSTEM: "1", HOME: repo } });
	return { code: out.exitCode ?? 1, stdout: out.stdout.toString(), stderr: out.stderr.toString() };
}

/** Scratch repo on main with a file:// origin; never ~/.claude itself. */
function fixtureRepo(): { repo: string; origin: string } {
	const base = mkdtempSync(join(process.env.TMPDIR ?? join(import.meta.dir, "../../var/agent-tmp"), "save1-"));
	dirs.push(base);
	const repo = join(base, "work");
	const origin = join(base, "origin.git");
	Bun.spawnSync(["git", "-c", "init.templatedir=", "init", "--bare", "-b", "main", origin], { stdout: "pipe", stderr: "pipe" });
	Bun.spawnSync(["git", "-c", "init.templatedir=", "init", "-b", "main", repo], { stdout: "pipe", stderr: "pipe" });
	sh(repo, "config", "user.email", "save@test.invalid");
	sh(repo, "config", "user.name", "saver");
	sh(repo, "config", "commit.gpgsign", "false");
	writeFileSync(join(repo, "notes.md"), "hello\n");
	sh(repo, "add", "notes.md");
	sh(repo, "commit", "-m", "init");
	sh(repo, "remote", "add", "origin", origin);
	sh(repo, "push", "-u", "origin", "main");
	const stateRoot = join(base, "state");
	return { repo, origin };
}

type CompletedScan = Extract<GitleaksScanResult, { disposition: "COMPLETED" }>;

function completeScan(request: GitleaksScanRequest, overrides: Partial<CompletedScan> = {}): CompletedScan {
	return {
		disposition: "COMPLETED",
		command: ["gitleaks", "detect", "--source", request.target, "--no-git", "--report-format", "json", "--report-path", "/dev/stdout", "--no-banner", "--redact"],
		target: request.target,
		treeId: request.treeId,
		exitCode: 0,
		report: "[]",
		stderr: "",
		...overrides
	};
}

function run(repo: string, stateRoot: string, gitleaks: GitleaksScanner = request => completeScan(request)) {
	const config: ClaudeSaveConfig = { enabled: true, repo, stateRoot };
	return runClaudeSaveJob(config, {
		git: (args, env) => {
			const out = Bun.spawnSync(["git", "-C", repo, ...args], { stdout: "pipe", stderr: "pipe", env: { ...process.env, GIT_CONFIG_NOSYSTEM: "1", HOME: repo, ...env } });
			return { code: out.exitCode ?? 1, stdout: out.stdout.toString(), stderr: out.stderr.toString() };
		},
		gitleaks,
		runId: "t1",
		nowIso: "2026-10-06T00:00:00Z"
	});
}

function headSha(repo: string): string {
	return sh(repo, "rev-parse", "HEAD").stdout.trim();
}

test("disabled job touches nothing", async () => {
	const { repo } = fixtureRepo();
	const result = await runClaudeSaveJob({ enabled: false, repo, stateRoot: join(repo, "state") });
	expect(result.status).toBe("DISABLED");
});

test("opt-in follows the kit-update switch pattern", () => {
	expect(claudeSaveJobEnabled({})).toBe(false);
	expect(claudeSaveJobEnabled({ OMP_KIT_JOB: "claude-save" })).toBe(true);
	expect(claudeSaveJobEnabled({ OMP_KIT_CLAUDE_SAVE_ENABLED: "1" })).toBe(true);
});

test("clean tree commits nothing", async () => {
	const { repo } = fixtureRepo();
	const before = headSha(repo);
	const result = await run(join(repo, "..", "work"), join(repo, "..", "state"));
	expect(result.status).toBe("CLEAN");
	expect(headSha(repo)).toBe(before);
});

test("admitted change scans the exact candidate tree before commit and push", async () => {
	const { repo, origin } = fixtureRepo();
	writeFileSync(join(repo, "notes.md"), "hello\nmore\n");
	const scans: GitleaksScanRequest[] = [];
	const result = await run(repo, join(repo, "..", "state"), request => {
		scans.push(request);
		expect(request.target).not.toBe(repo);
		expect(request.treeId).toBe(sh(repo, "write-tree").stdout.trim());
		expect(readFileSync(join(request.target, "notes.md"), "utf8")).toBe("hello\nmore\n");
		return completeScan(request);
	});
	expect(result).toMatchObject({ status: "PUSHED", committed: true, pushed: true });
	expect(scans).toHaveLength(1);
	expect(existsSync(scans[0]!.target)).toBe(false);
	expect(sh(repo, "log", "--oneline", "origin/main").stdout).toContain("claude-save:");
	expect(sh(origin, "--git-dir=" + origin, "log", "--oneline", "main").stdout).toContain("claude-save:");
});

test("HEAD off main refuses and commits nothing", async () => {
	const { repo } = fixtureRepo();
	sh(repo, "checkout", "-b", "side");
	writeFileSync(join(repo, "notes.md"), "x\n");
	const before = headSha(repo);
	const result = await run(repo, join(repo, "..", "state"));
	expect(result).toMatchObject({ status: "REFUSED", refusal: "HEAD_NOT_MAIN" });
	expect(headSha(repo)).toBe(before);
});

test("upstream not origin/main refuses", async () => {
	const { repo } = fixtureRepo();
	sh(repo, "remote", "remove", "origin");
	const before = headSha(repo);
	const result = await run(repo, join(repo, "..", "state"));
	expect(result).toMatchObject({ status: "REFUSED", refusal: "UPSTREAM_NOT_ORIGIN_MAIN" });
	expect(headSha(repo)).toBe(before);
});

test("linked worktree refuses", async () => {
	const { repo } = fixtureRepo();
	const wt = join(repo, "..", "wt");
	sh(repo, "worktree", "add", wt, "-b", "wt-branch");
	const before = headSha(repo);
	const result = await run(repo, join(repo, "..", "state"));
	expect(result).toMatchObject({ status: "REFUSED", refusal: "WORKTREE_PRESENT" });
	expect(headSha(repo)).toBe(before);
	sh(repo, "worktree", "remove", "--force", wt);
});

test("new branch outside the baseline refuses", async () => {
	const { repo } = fixtureRepo();
	sh(repo, "branch", "sneaky-new");
	const before = headSha(repo);
	const result = await run(repo, join(repo, "..", "state"));
	expect(result).toMatchObject({ status: "REFUSED", refusal: "NEW_BRANCH" });
	expect(result.reason).toContain("sneaky-new");
	expect(headSha(repo)).toBe(before);
	sh(repo, "branch", "-D", "sneaky-new");
});

test("a re-created archived branch is refused under the main-only baseline", async () => {
	const { repo } = fixtureRepo();
	sh(repo, "branch", "tick1e/clte-obsfold-recall-uol16");
	const before = headSha(repo);
	const result = await run(repo, join(repo, "..", "state"));
	expect(result).toMatchObject({ status: "REFUSED", refusal: "NEW_BRANCH" });
	expect(result.reason).toContain("tick1e/clte-obsfold-recall-uol16");
	expect(headSha(repo)).toBe(before);
	sh(repo, "branch", "-D", "tick1e/clte-obsfold-recall-uol16");
});

test("new gitlink refuses while baseline gitlinks are tolerated", async () => {
	const { repo } = fixtureRepo();
	const blob = sh(repo, "hash-object", "-w", "--stdin").stdout.trim();
	sh(repo, "update-index", "--add", "--cacheinfo", `160000,${blob},external-skills/app-store-connect-skill`);
	writeFileSync(join(repo, "notes.md"), "x\n");
	const ok = await run(repo, join(repo, "..", "state"));
	expect(ok.status).toBe("PUSHED");
	sh(repo, "update-index", "--add", "--cacheinfo", `160000,${blob},skills/brand-new-thing`);
	const before = headSha(repo);
	const result = await run(repo, join(repo, "..", "state"));
	expect(result).toMatchObject({ status: "REFUSED", refusal: "NEW_GITLINK" });
	expect(result.reason).toContain("skills/brand-new-thing");
	expect(headSha(repo)).toBe(before);
});

test("a gitlink moved and committed at HEAD is tolerated; an uncommitted new one still refuses", async () => {
	// Field case 2026-10-09: ~/.claude committed `git mv skills/.archived-non-skills-20261001 skill-archive/...`,
	// so the 2026-10-06 path snapshot no longer matched and every hourly save refused NEW_GITLINK.
	const { repo } = fixtureRepo();
	const blob = sh(repo, "hash-object", "-w", "--stdin").stdout.trim();
	sh(repo, "update-index", "--add", "--cacheinfo", `160000,${blob},skill-archive/.archived-non-skills-20261001/rawr-slides`);
	sh(repo, "commit", "-m", "move archived gitlink");
	sh(repo, "push", "origin", "main");
	writeFileSync(join(repo, "notes.md"), "moved\n");
	const ok = await run(repo, join(repo, "..", "state"));
	expect(ok.status).toBe("PUSHED");
	sh(repo, "update-index", "--add", "--cacheinfo", `160000,${blob},skill-archive/brand-new-thing`);
	const before = headSha(repo);
	const refused = await run(repo, join(repo, "..", "state"));
	expect(refused).toMatchObject({ status: "REFUSED", refusal: "NEW_GITLINK" });
	expect(refused.reason).toContain("skill-archive/brand-new-thing");
	expect(refused.reason).not.toContain("rawr-slides");
	expect(headSha(repo)).toBe(before);
});

test("admitted edit commits with all 5 allowlisted gitlinks tracked (verdict leg)", async () => {
	const { repo } = fixtureRepo();
	const blob = sh(repo, "hash-object", "-w", "--stdin").stdout.trim();
	for (const path of ["external-skills/app-store-connect-skill", "external-skills/claude-code-apple-skills", "mcps/postgres-mcp.disabled", "skills/.archived-non-skills-20261001/rawr-slides", "skills/.non-skill-dirs-relocated-20260610/rawr-slides"]) {
		sh(repo, "update-index", "--add", "--cacheinfo", `160000,${blob},${path}`);
	}
	sh(repo, "commit", "-m", "track gitlinks");
	writeFileSync(join(repo, "notes.md"), "verdict leg\n");
	const result = await run(repo, join(repo, "..", "state"));
	expect(result).toMatchObject({ status: "PUSHED", committed: true, pushed: true });
});

test("dirty settings.json refuses and stays unstaged", async () => {
	const { repo } = fixtureRepo();
	writeFileSync(join(repo, "settings.json"), '{"a":1}\n');
	sh(repo, "add", "settings.json");
	sh(repo, "commit", "-m", "settings");
	writeFileSync(join(repo, "settings.json"), '{"a":2}\n');
	const before = headSha(repo);
	const result = await run(repo, join(repo, "..", "state"));
	expect(result).toMatchObject({ status: "REFUSED", refusal: "DENIED_PATH" });
	expect(headSha(repo)).toBe(before);
	expect(sh(repo, "diff", "--cached", "--name-only").stdout).not.toContain("settings.json");
});

test("gitleaks finding report resets the index and refuses", async () => {
	const { repo } = fixtureRepo();
	writeFileSync(join(repo, "notes.md"), "x\n");
	const before = headSha(repo);
	const result = await run(repo, join(repo, "..", "state"), request => completeScan(request, { exitCode: 1, report: '[{"RuleID":"test"}]' }));
	expect(result).toMatchObject({ status: "REFUSED", refusal: "GITLEAKS_HIT" });
	expect(headSha(repo)).toBe(before);
	expect(sh(repo, "diff", "--cached", "--name-only").stdout.trim()).toBe("");
});

test("missing scanner fails closed", async () => {
	const { repo } = fixtureRepo();
	writeFileSync(join(repo, "notes.md"), "x\n");
	const before = headSha(repo);
	const result = await runClaudeSaveJob({ enabled: true, repo, stateRoot: join(repo, "..", "state") },
		{ git: args => sh(repo, ...args), runId: "t1", nowIso: "2026-10-06T00:00:00Z" });
	expect(result).toMatchObject({ status: "REFUSED", refusal: "GITLEAKS_UNAVAILABLE" });
	expect(headSha(repo)).toBe(before);
	expect(sh(repo, "diff", "--cached", "--name-only").stdout.trim()).toBe("");
});

test("timed-out Gitleaks scan is not run to completion and cannot land", async () => {
	const { repo, origin } = fixtureRepo();
	writeFileSync(join(repo, "notes.md"), "changed\n");
	const before = headSha(repo);
	const slowScanner = join(join(repo, ".."), "slow-gitleaks.sh");
	writeFileSync(slowScanner, "#!/bin/sh\nexec /bin/sleep 5\n");
	chmodSync(slowScanner, 0o700);
	const result = await run(repo, join(repo, "..", "state"), request => runGitleaksScan(slowScanner, request, 100));
	expect(result).toMatchObject({ status: "REFUSED", refusal: "GITLEAKS_TIMEOUT", committed: false, pushed: false });
	expect(result.reason).toContain("100ms");
	expect(headSha(repo)).toBe(before);
	expect(sh(repo, "ls-remote", "origin", "refs/heads/main").stdout.split("\t")[0]).toBe(before);
	expect(sh(repo, "diff", "--cached", "--name-only").stdout.trim()).toBe("");
});

test("scanner spawn failure cannot land", async () => {
	const { repo } = fixtureRepo();
	writeFileSync(join(repo, "notes.md"), "changed\n");
	const before = headSha(repo);
	const missing = join(repo, "missing-gitleaks");
	const result = await run(repo, join(repo, "..", "state"), request => runGitleaksScan(missing, request, 100));
	expect(result).toMatchObject({ status: "REFUSED", refusal: "GITLEAKS_FAILED", committed: false, pushed: false });
	expect(result.reason).toContain("SPAWN_FAILED");
	expect(headSha(repo)).toBe(before);
});

test("nonzero scan with an empty report cannot be clean", async () => {
	const { repo } = fixtureRepo();
	writeFileSync(join(repo, "notes.md"), "changed\n");
	const before = headSha(repo);
	const result = await run(repo, join(repo, "..", "state"), request => completeScan(request, { exitCode: 2 }));
	expect(result).toMatchObject({ status: "REFUSED", refusal: "GITLEAKS_FAILED", committed: false, pushed: false });
	expect(headSha(repo)).toBe(before);
});

test("empty Gitleaks output is not a completed clean scan", async () => {
	const { repo, origin } = fixtureRepo();
	writeFileSync(join(repo, "notes.md"), "changed\n");
	const before = headSha(repo);
	const result = await run(repo, join(repo, "..", "state"), request => completeScan(request, { report: "" }));
	expect(result).toMatchObject({ status: "REFUSED", refusal: "GITLEAKS_REPORT_INVALID" });
	expect(headSha(repo)).toBe(before);
	expect(sh(repo, "ls-remote", "origin", "refs/heads/main").stdout.split("\t")[0]).toBe(before);
	expect(sh(repo, "diff", "--cached", "--name-only").stdout.trim()).toBe("");
});

test("truncated Gitleaks output is not a completed clean scan", async () => {
	const { repo } = fixtureRepo();
	writeFileSync(join(repo, "notes.md"), "changed\n");
	const before = headSha(repo);
	const result = await run(repo, join(repo, "..", "state"), request => completeScan(request, { report: "[{" }));
	expect(result).toMatchObject({ status: "REFUSED", refusal: "GITLEAKS_REPORT_INVALID" });
	expect(headSha(repo)).toBe(before);
});

test("Gitleaks result bound to another tree cannot land", async () => {
	const { repo } = fixtureRepo();
	writeFileSync(join(repo, "notes.md"), "changed\n");
	const before = headSha(repo);
	const result = await run(repo, join(repo, "..", "state"), request => completeScan(request, { treeId: "another-tree" }));
	expect(result).toMatchObject({ status: "REFUSED", refusal: "GITLEAKS_TREE_MISMATCH", committed: false, pushed: false });
	expect(headSha(repo)).toBe(before);
});

test("Gitleaks result from another target cannot land", async () => {
	const { repo } = fixtureRepo();
	writeFileSync(join(repo, "notes.md"), "changed\n");
	const before = headSha(repo);
	const result = await run(repo, join(repo, "..", "state"), request => completeScan(request, { target: join(request.target, "other") }));
	expect(result).toMatchObject({ status: "REFUSED", refusal: "GITLEAKS_TREE_MISMATCH", committed: false, pushed: false });
	expect(headSha(repo)).toBe(before);
});

test("SKILL.md outside skills/ refuses", async () => {
	const { repo } = fixtureRepo();
	writeFileSync(join(repo, "notes.md"), "x\n");
	writeFileSync(join(repo, "SKILL.md"), "stray\n");
	sh(repo, "add", "SKILL.md");
	const before = headSha(repo);
	const result = await run(repo, join(repo, "..", "state"));
	expect(result).toMatchObject({ status: "REFUSED", refusal: "SKILL_OUTSIDE_LIBRARY" });
	expect(headSha(repo)).toBe(before);
	expect(checkSkillLibrary(["skills/a/SKILL.md", "SKILL.md", "docs/SKILL.md"])).toEqual(["SKILL.md", "docs/SKILL.md"]);
});
test("non-fast-forward push is reported, never forced", async () => {
	const { repo, origin } = fixtureRepo();
	const clone2 = join(repo, "..", "clone2");
	Bun.spawnSync(["git", "-c", "init.templatedir=", "clone", origin, clone2], { stdout: "pipe", stderr: "pipe" });
	sh(clone2, "config", "user.email", "o@test.invalid");
	sh(clone2, "config", "user.name", "o");
	sh(clone2, "config", "commit.gpgsign", "false");
	writeFileSync(join(clone2, "other.md"), "diverged\n");
	sh(clone2, "add", "other.md");
	sh(clone2, "commit", "-m", "diverge");
	sh(clone2, "push", "origin", "main");
	writeFileSync(join(repo, "notes.md"), "x\n");
	const result = await run(repo, join(repo, "..", "state"));
	expect(result).toMatchObject({ status: "PUSH_FAILED", committed: true, pushed: false, refusal: "PUSH_REJECTED" });
	expect(sh(repo, "log", "--oneline").stdout).toContain("claude-save:");
});
