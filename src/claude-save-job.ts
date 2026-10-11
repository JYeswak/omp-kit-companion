/** claude-save-job.ts — SAVE1 (ompkit-ckyg): keep ~/.claude committed and pushed.
 *
 * An interval service job (hourly) that commits admitted changes on main and
 * pushes origin main. Refusals (each with a planted test): HEAD not main,
 * upstream not origin/main, any worktree, any branch besides main, any
 * gitlink outside the 5-gitlink allowlist, a dirty
 * tracked denied file (cc-router-local.json, settings.json), a gitleaks
 * finding, a missing gitleaks scanner (fail-closed), and SKILL.md outside
 * skills/. Gitlinks and denied files are never staged. No merge, rebase,
 * stash, branch creation, or force-push: a non-fast-forward push is reported.
 * Tests run on scratch repos only, never ~/.claude itself.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export const GITLEAKS_TIMEOUT_MS = 15_000;

export type ClaudeSaveGitEnv = Readonly<Record<string, string>>;

export interface GitleaksScanRequest {
	target: string;
	treeId: string;
}

export type GitleaksScanResult =
	| { disposition: "COMPLETED"; command: readonly string[]; target: string; treeId: string; exitCode: number; report: string; stderr: string }
	| { disposition: "NOT_RUN"; command: readonly string[]; target: string; reason: "TIMEOUT" | "SPAWN_FAILED" | "SIGNALLED"; timeoutMs: number; detail: string };

export type GitleaksScanner = (request: GitleaksScanRequest) => GitleaksScanResult;

export type ClaudeSaveStatus = "DISABLED" | "CLEAN" | "PUSHED" | "REFUSED" | "PUSH_FAILED" | "FAILED";

export interface ClaudeSaveResult {
	status: ClaudeSaveStatus;
	receiptId: string | null;
	committed: boolean;
	pushed: boolean;
	refusal?: string;
	reason?: string;
}

export interface ClaudeSaveConfig {
	enabled: boolean;
	repo: string;
	stateRoot: string;
}

export interface ClaudeSaveGit {
	code: number;
	stdout: string;
	stderr: string;
}

export interface ClaudeSaveDeps {
	git?: (args: readonly string[], env?: ClaudeSaveGitEnv) => ClaudeSaveGit;
	gitleaks?: GitleaksScanner;
	notify?: (message: string) => void;
	runId?: string;
	nowIso?: string;
}

const DENIED_BASENAMES: Record<string, true> = { "cc-router-local.json": true, "settings.json": true };

/** Gitlinks snapshotted from ~/.claude 2026-10-06 (5 entries). Gitlinks already committed at HEAD
 * are tolerated too, so a committed move of one of them (git mv) does not refuse every later save;
 * only a gitlink that is neither here nor at HEAD is new. */
export const CLAUDE_SAVE_BASELINE_GITLINKS: readonly string[] = [
	"external-skills/app-store-connect-skill",
	"external-skills/claude-code-apple-skills",
	"mcps/postgres-mcp.disabled",
	"skills/.archived-non-skills-20261001/rawr-slides",
	"skills/.non-skill-dirs-relocated-20260610/rawr-slides",
];

/** Branch baseline: main only. TopazRiver deleted every other ~/.claude
 * branch with Josh's approval (amendment 3, 2026-10-06); any re-created
 * archived branch is refused as new. */
export const CLAUDE_SAVE_BASELINE_BRANCHES: readonly string[] = ["main"];

export function claudeSaveJobEnabled(environment: { OMP_KIT_CLAUDE_SAVE_ENABLED?: string; OMP_KIT_JOB?: string }): boolean {
	return environment.OMP_KIT_CLAUDE_SAVE_ENABLED === "1" || environment.OMP_KIT_JOB === "claude-save";
}

function basename(path: string): string {
	const slash = path.lastIndexOf("/");
	return slash < 0 ? path : path.slice(slash + 1);
}

/** Doctor check: SKILL.md files outside skills/ (the skills-library regression). */
export function checkSkillLibrary(trackedFiles: string[]): string[] {
	return trackedFiles.filter(path => basename(path) === "SKILL.md" && path !== "skills/SKILL.md" && !path.startsWith("skills/"));
}
export function runGitleaksScan(executable: string, request: GitleaksScanRequest, timeoutMs = GITLEAKS_TIMEOUT_MS): GitleaksScanResult {
	const command = [executable, "detect", "--source", request.target, "--no-git", "--report-format", "json", "--report-path", "/dev/stdout", "--no-banner", "--redact"];
	try {
		const out = Bun.spawnSync(command, { stdout: "pipe", stderr: "pipe", timeout: timeoutMs });
		if (out.exitCode === null) {
			return {
				disposition: "NOT_RUN",
				command,
				target: request.target,
				reason: out.signalCode === "SIGTERM" ? "TIMEOUT" : "SIGNALLED",
				timeoutMs,
				detail: `scanner terminated by ${out.signalCode ?? "unknown signal"}`
			};
		}
		return {
			disposition: "COMPLETED",
			command,
			target: request.target,
			treeId: request.treeId,
			exitCode: out.exitCode,
			report: out.stdout.toString(),
			stderr: out.stderr.toString()
		};
	} catch (error) {
		return {
			disposition: "NOT_RUN",
			command,
			target: request.target,
			reason: "SPAWN_FAILED",
			timeoutMs,
			detail: error instanceof Error ? error.message : String(error)
		};
	}
}

interface Ctx {
	git: (args: readonly string[], env?: ClaudeSaveGitEnv) => ClaudeSaveGit;
	gitleaks?: GitleaksScanner;
	notify?: (message: string) => void;
	repo: string;
	stateRoot: string;
	runId: string;
	nowIso: string;
}

function fail(ctx: Ctx, refusal: string, reason: string): ClaudeSaveResult {
	ctx.notify?.(`claude-save refused: ${refusal}: ${reason}`);
	return { status: "REFUSED", receiptId: null, committed: false, pushed: false, refusal, reason };
}

function materializeGitleaksTree(ctx: Ctx, treeId: string): { root: string; target: string } {
	mkdirSync(ctx.stateRoot, { recursive: true, mode: 0o700 });
	const root = mkdtempSync(join(ctx.stateRoot, "claude-save-gitleaks-"));
	const target = join(root, "source");
	const env = { GIT_INDEX_FILE: join(root, "index") };
	try {
		mkdirSync(target, { mode: 0o700 });
		const readTree = ctx.git(["read-tree", treeId], env);
		if (readTree.code !== 0) throw new Error(`temporary index read-tree failed: ${readTree.stderr.trim()}`);
		const writtenTree = ctx.git(["write-tree"], env);
		if (writtenTree.code !== 0 || writtenTree.stdout.trim() !== treeId) throw new Error("temporary index tree did not match the candidate tree");
		const checkout = ctx.git(["checkout-index", "--all", `--prefix=${target}/`], env);
		if (checkout.code !== 0) throw new Error(`candidate tree checkout failed: ${checkout.stderr.trim()}`);
		return { root, target };
	} catch (error) {
		rmSync(root, { recursive: true, force: true });
		throw error;
	}
}

function record(ctx: Ctx, result: ClaudeSaveResult): ClaudeSaveResult {
	try {
		mkdirSync(ctx.stateRoot, { recursive: true, mode: 0o700 });
		const receiptId = `claude-save-${ctx.runId}.json`;
		writeFileSync(join(ctx.stateRoot, receiptId), JSON.stringify({ schema_version: 1, run_id: ctx.runId, finished_at: ctx.nowIso, ...result }) + "\n", { flag: "wx", mode: 0o600 });
		return { ...result, receiptId };
	} catch {
		return result;
	}
}

export async function runClaudeSaveJob(config: ClaudeSaveConfig, deps: ClaudeSaveDeps = {}): Promise<ClaudeSaveResult> {
	const runId = deps.runId ?? Math.random().toString(36).slice(2, 10);
	const nowIso = deps.nowIso ?? new Date().toISOString();
	if (!config.enabled) return { status: "DISABLED", receiptId: null, committed: false, pushed: false };
	const git = deps.git ?? ((args: readonly string[], env?: ClaudeSaveGitEnv) => {
		const out = Bun.spawnSync(["git", "-C", config.repo, ...args], { stdout: "pipe", stderr: "pipe", env: { ...process.env, ...env } });
		return { code: out.exitCode, stdout: out.stdout.toString(), stderr: out.stderr.toString() };
	});
	const ctx: Ctx = { git, gitleaks: deps.gitleaks, notify: deps.notify, repo: config.repo, stateRoot: config.stateRoot, runId, nowIso };
	try {
		const head = git(["rev-parse", "--abbrev-ref", "HEAD"]);
		if (head.code !== 0 || head.stdout.trim() !== "main") return record(ctx, fail(ctx, "HEAD_NOT_MAIN", `HEAD is ${head.stdout.trim() || "unknown"}; the service targets main only`));
		const upstream = git(["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{u}"]);
		if (upstream.code !== 0 || upstream.stdout.trim() !== "origin/main") return record(ctx, fail(ctx, "UPSTREAM_NOT_ORIGIN_MAIN", `upstream is ${upstream.stdout.trim() || "unset"}; pushes go to origin main only`));
		const worktrees = git(["worktree", "list", "--porcelain"]);
		const worktreePaths = worktrees.stdout.split("\n").filter(line => line.startsWith("worktree "));
		if (worktreePaths.length > 1) return record(ctx, fail(ctx, "WORKTREE_PRESENT", `${worktreePaths.length - 1} linked worktree(s); remove them before the saver runs`));
		const branches = git(["branch", "--list", "--format=%(refname:short)"]);
		if (branches.code !== 0) return record(ctx, fail(ctx, "BRANCH_LIST_FAILED", branches.stderr.trim()));
		const baseline = new Set(CLAUDE_SAVE_BASELINE_BRANCHES);
		const extra = branches.stdout.split("\n").map(name => name.trim()).filter(name => name !== "" && !baseline.has(name));
		if (extra.length > 0) return record(ctx, fail(ctx, "NEW_BRANCH", `new branches outside the main-only baseline: ${extra.join(", ")}`));
		const index = git(["ls-files", "-s"]);
		if (index.code !== 0) return record(ctx, fail(ctx, "INDEX_READ_FAILED", index.stderr.trim()));
		const headTree = git(["ls-tree", "-r", "--full-tree", "HEAD"]);
		if (headTree.code !== 0) return record(ctx, fail(ctx, "HEAD_TREE_READ_FAILED", headTree.stderr.trim()));
		const allowGitlinks = new Set(CLAUDE_SAVE_BASELINE_GITLINKS);
		for (const line of headTree.stdout.split("\n")) {
			const match = /^160000 commit [0-9a-f]{40}\t(.*)$/.exec(line);
			if (match) allowGitlinks.add(match[1]!);
		}
		const gitlinks: string[] = [];
		for (const line of index.stdout.split("\n")) {
			const match = /^160000 [0-9a-f]{40} \d+\t(.*)$/.exec(line);
			if (match) gitlinks.push(match[1]!);
		}
		const novel = gitlinks.filter(path => !allowGitlinks.has(path));
		if (novel.length > 0) return record(ctx, fail(ctx, "NEW_GITLINK", `gitlinks neither in the baseline nor committed at HEAD: ${novel.join(", ")}`));
		const status = git(["status", "--porcelain=v1", "--untracked-files=all"]);
		if (status.code !== 0) return record(ctx, fail(ctx, "STATUS_FAILED", status.stderr.trim()));
		const dirtyTracked: string[] = [];
		const untracked: string[] = [];
		for (const line of status.stdout.split("\n")) {
			if (line.length < 4) continue;
			const x = line[0]!, y = line[1]!;
			const path = line.slice(3).trim().replace(/^"(.*)"$/, "$1");
			if (x === "?" && y === "?") untracked.push(path);
			else dirtyTracked.push(path);
		}
		const deniedDirty = dirtyTracked.filter(path => DENIED_BASENAMES[basename(path)] === true);
		if (deniedDirty.length > 0) return record(ctx, fail(ctx, "DENIED_PATH", `denied files dirty, left unstaged: ${deniedDirty.join(", ")}`));
		const tracked = git(["ls-files"]);
		const outside = checkSkillLibrary((tracked.stdout + "\n" + untracked.filter(p => basename(p) === "SKILL.md").join("\n")).split("\n").filter(p => p !== ""));
		if (outside.length > 0) return record(ctx, fail(ctx, "SKILL_OUTSIDE_LIBRARY", `SKILL.md outside skills/: ${outside.join(", ")}`));
		const candidates = [...dirtyTracked.filter(path => !allowGitlinks.has(path)), ...untracked.filter(path => DENIED_BASENAMES[basename(path)] !== true && !allowGitlinks.has(path))];
		if (candidates.length === 0) {
			const result: ClaudeSaveResult = { status: "CLEAN", receiptId: null, committed: false, pushed: false, reason: "no admitted changes" };
			return record(ctx, result);
		}
		const add = git(["add", "-A", "--", ...candidates]);
		if (add.code !== 0) return record(ctx, fail(ctx, "STAGE_FAILED", add.stderr.trim()));
		const stagedNames = git(["diff", "--cached", "--name-only", "-z"]);
		const staged = stagedNames.stdout.split("\0").filter(p => p !== "");
		const stagedDenied = staged.filter(path => DENIED_BASENAMES[basename(path)] === true);
		if (stagedDenied.length > 0) {
			git(["reset", "-q"]);
			return record(ctx, fail(ctx, "DENIED_STAGED", `denied files reached the index, reset: ${stagedDenied.join(", ")}`));
		}
		const stagedRaw = git(["diff", "--cached", "--raw", "-z"]);
		const stagedGitlinks: string[] = [];
		const rawParts = stagedRaw.stdout.split("\0");
		for (let index = 0; index < rawParts.length; index++) {
			const entry = rawParts[index]!;
			if (!entry.startsWith(":")) continue;
			const fields = entry.slice(1).split(" ");
			if (fields.length < 5) continue;
			const path = rawParts[index + 1];
			if (path === undefined || path === "") continue;
			if ((fields[0] === "160000" || fields[1] === "160000") && !allowGitlinks.has(path)) stagedGitlinks.push(path);
		}
		if (stagedGitlinks.length > 0) {
			git(["reset", "-q"]);
			return record(ctx, fail(ctx, "GITLINK_STAGED", `new gitlinks reached the index, reset: ${stagedGitlinks.join(", ")}`));
		}
		if (staged.length === 0) {
			const result: ClaudeSaveResult = { status: "CLEAN", receiptId: null, committed: false, pushed: false, reason: "candidates reduced to nothing after staging audit" };
			return record(ctx, result);
		}
		if (!deps.gitleaks) {
			git(["reset", "-q"]);
			return record(ctx, fail(ctx, "GITLEAKS_UNAVAILABLE", "no gitleaks scanner injected; refusing rather than committing unscanned"));
		}
		const candidateTree = git(["write-tree"]);
		if (candidateTree.code !== 0 || candidateTree.stdout.trim() === "") {
			git(["reset", "-q"]);
			return record(ctx, fail(ctx, "GITLEAKS_TREE_UNAVAILABLE", candidateTree.stderr.trim() || "candidate tree could not be read; index reset"));
		}
		const candidateTreeId = candidateTree.stdout.trim();
		let snapshot: { root: string; target: string };
		try {
			snapshot = materializeGitleaksTree(ctx, candidateTreeId);
		} catch (error) {
			git(["reset", "-q"]);
			return record(ctx, fail(ctx, "GITLEAKS_SNAPSHOT_FAILED", error instanceof Error ? error.message : String(error)));
		}
		let scan: GitleaksScanResult | undefined;
		let scannerFailure: string | undefined;
		try {
			scan = deps.gitleaks({ target: snapshot.target, treeId: candidateTreeId });
		} catch (error) {
			scannerFailure = error instanceof Error ? error.message : String(error);
		}
		try {
			rmSync(snapshot.root, { recursive: true, force: true });
		} catch (error) {
			git(["reset", "-q"]);
			return record(ctx, fail(ctx, "GITLEAKS_SNAPSHOT_CLEANUP_FAILED", error instanceof Error ? error.message : String(error)));
		}
		if (scannerFailure !== undefined || scan === undefined) {
			git(["reset", "-q"]);
			return record(ctx, fail(ctx, "GITLEAKS_FAILED", scannerFailure ?? "scanner returned no result; scan not completed"));
		}
		if (scan.disposition === "NOT_RUN") {
			git(["reset", "-q"]);
			const refusal = scan.reason === "TIMEOUT" ? "GITLEAKS_TIMEOUT" : "GITLEAKS_FAILED";
			const reason = scan.reason === "TIMEOUT"
				? `gitleaks timed out after ${scan.timeoutMs}ms; scan did not complete (not run to completion). ${scan.detail}`
				: `gitleaks did not complete (${scan.reason}); scan not run. ${scan.detail}`;
			return record(ctx, fail(ctx, refusal, reason));
		}
		if (scan.target !== snapshot.target || scan.treeId !== candidateTreeId) {
			git(["reset", "-q"]);
			return record(ctx, fail(ctx, "GITLEAKS_TREE_MISMATCH", "scanner result was not bound to the exact candidate tree; index reset"));
		}
		let findings: unknown[];
		try {
			const report: unknown = JSON.parse(scan.report);
			if (!Array.isArray(report)) throw new Error("report is not a JSON array");
			findings = report;
		} catch (error) {
			git(["reset", "-q"]);
			return record(ctx, fail(ctx, "GITLEAKS_REPORT_INVALID", `gitleaks report was missing, truncated or invalid; index reset. ${error instanceof Error ? error.message : String(error)}`));
		}
		if (findings.length > 0 || scan.exitCode !== 0) {
			git(["reset", "-q"]);
			const refusal = findings.length > 0 ? "GITLEAKS_HIT" : "GITLEAKS_FAILED";
			return record(ctx, fail(ctx, refusal, `gitleaks exit code ${scan.exitCode}; findings=${findings.length}; index reset. ${scan.stderr.slice(0, 200)}`));
		}
		const verifiedTree = git(["write-tree"]);
		if (verifiedTree.code !== 0 || verifiedTree.stdout.trim() !== candidateTreeId) {
			git(["reset", "-q"]);
			return record(ctx, fail(ctx, "GITLEAKS_TREE_CHANGED", "candidate index changed during scan; index reset"));
		}
		const commit = git(["commit", "-m", `claude-save: ${nowIso} (${staged.length} files)`]);
		if (commit.code !== 0) {
			git(["reset", "-q"]);
			return record(ctx, fail(ctx, "COMMIT_FAILED", commit.stderr.trim().slice(0, 200)));
		}
		const committedTree = git(["rev-parse", "HEAD^{tree}"]);
		if (committedTree.code !== 0 || committedTree.stdout.trim() !== candidateTreeId) {
			const result: ClaudeSaveResult = { status: "FAILED", receiptId: null, committed: true, pushed: false, refusal: "GITLEAKS_TREE_CHANGED", reason: "committed tree differs from the scanned candidate; push refused" };
			ctx.notify?.(`claude-save refused: ${result.refusal}: ${result.reason}`);
			return record(ctx, result);
		}
		const push = git(["push", "origin", "main"]);
		if (push.code !== 0) {
			const result: ClaudeSaveResult = { status: "PUSH_FAILED", receiptId: null, committed: true, pushed: false, refusal: "PUSH_REJECTED", reason: `push origin main rejected (no force, no retry): ${push.stderr.trim().slice(0, 200)}` };
			ctx.notify?.(`claude-save push rejected: ${result.reason}`);
			return record(ctx, result);
		}
		const result: ClaudeSaveResult = { status: "PUSHED", receiptId: null, committed: true, pushed: true };
		return record(ctx, result);
	} catch (error) {
		return record(ctx, { status: "FAILED", receiptId: null, committed: false, pushed: false, refusal: "JOB_ERROR", reason: error instanceof Error ? error.message : String(error) });
	}
}
