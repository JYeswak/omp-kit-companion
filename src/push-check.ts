/** HANDOFFPUSHCHECK1: `omp-kit push-check --commit <sha> [--repo PATH]` runs the
 * `.omp/push-check` committed at the repo's HEAD against an export of <sha>'s
 * tree through land's execution path (never a second runner), bounded, and
 * appends the verdict row the author handoff gate reads.
 */
import { rmSync } from "node:fs";
import { resolve } from "node:path";
import { run as kitlibRun, runSync as kitlibRunSync } from "./kitlib/run.ts";
import { ownedTmp } from "./kitlib/tmp.ts";
import type { CliResult, ParsedCommand } from "./cli.ts";
import {
	appendPushCheckRow,
	executePushCheckScript,
	pushCheckDeadlineSeconds,
	pushCheckHeadBytes,
	resolvePushCheckExecutable,
} from "./land.ts";

function refusal(code: number, check: Record<string, unknown>, error: { code: string; message: string; remediation: string }): CliResult {
	return { code: code as CliResult["code"], data: { overall: "UNRUN", check }, errors: [error], verification: "UNVERIFIED" };
}

function repoRoot(cwd: string, repoFlag: string | true | undefined): { repo: string } | { error: CliResult } {
	try {
		const start = typeof repoFlag === "string" && repoFlag ? resolve(repoFlag) : cwd;
		const run = kitlibRunSync(["git", "rev-parse", "--show-toplevel"], { cwd: start, deadline_s: 30, max_output_bytes: 1 << 20 });
		if (run.rc !== 0 || run.timed_out || run.killed) {
			return {
				error: refusal(2, { status: "UNRUN", path: ".omp/push-check", sha256: null },
					{ code: "PUSH_CHECK_REPOSITORY_REQUIRED", message: "The target directory is not inside a Git repository", remediation: "Run push-check inside a Git checkout or pass --repo PATH." }),
			};
		}
		return { repo: new TextDecoder().decode(run.stdout).trim() };
	} catch {
		return {
			error: refusal(2, { status: "UNRUN", path: ".omp/push-check", sha256: null },
				{ code: "PUSH_CHECK_REPOSITORY_REQUIRED", message: "The target repository could not be inspected", remediation: "Run push-check inside a Git checkout or pass --repo PATH." }),
		};
	}
}
function isHexSha(value: string): boolean {
	if (value.length !== 40 && value.length !== 64) return false;
	for (const char of value) if (!"0123456789abcdef".includes(char)) return false;
	return true;
}

function resolveCommit(repo: string, raw: string): string | null {
	try {
		const run = kitlibRunSync(["git", "rev-parse", "--verify", `${raw}^{commit}`], { cwd: repo, deadline_s: 30, max_output_bytes: 1 << 20 });
		if (run.rc !== 0 || run.timed_out || run.killed) return null;
		const sha = new TextDecoder().decode(run.stdout).trim();
		if (!isHexSha(sha)) return null;
		return sha;
	} catch {
		return null;
	}
}

export async function pushCheckCommand(request: ParsedCommand): Promise<CliResult> {
	const commitFlag = request.flags.get("--commit");
	if (typeof commitFlag !== "string" || !commitFlag.trim()) {
		return refusal(2, { status: "UNRUN", path: ".omp/push-check", sha256: null },
			{ code: "PUSH_CHECK_COMMIT_REQUIRED", message: "push-check needs --commit SHA", remediation: "Pass the commit to check, e.g. omp-kit push-check --commit <sha>." });
	}
	const located = repoRoot(process.cwd(), request.flags.get("--repo"));
	if ("error" in located) return located.error;
	const repo = located.repo;
	const commit = resolveCommit(repo, commitFlag.trim());
	if (!commit) {
		return refusal(2, { status: "UNRUN", path: ".omp/push-check", sha256: null },
			{ code: "PUSH_CHECK_COMMIT_UNKNOWN", message: `Commit not found: ${commitFlag.trim()}`, remediation: "Pass a commit present in the target repository." });
	}
	const head = pushCheckHeadBytes(repo, "HEAD");
	if ("kind" in head && head.kind === "missing") {
		return refusal(1, { status: "SKIP", path: ".omp/push-check", sha256: null, reason: "unregistered" },
			{ code: "PUSH_CHECK_UNREGISTERED", message: "No executable .omp/push-check is committed at HEAD", remediation: "Commit an executable .omp/push-check that runs the repo's checks, then run omp-kit push-check --commit <sha>." });
	}
	if ("kind" in head) {
		return refusal(77, { status: "UNRUN", path: ".omp/push-check", sha256: null, reason: head.reason },
			{ code: "PUSH_CHECK_UNAVAILABLE", message: `The registered repo check is unavailable: ${head.reason}`, remediation: "Restore the committed .omp/push-check and retry; nothing was recorded." });
	}
	const resolved = resolvePushCheckExecutable(repo, head.bytes, head.sha256);
	if ("reason" in resolved) {
		return refusal(77, { status: "UNRUN", path: ".omp/push-check", sha256: head.sha256, reason: resolved.reason },
			{ code: "PUSH_CHECK_UNAVAILABLE", message: `The registered repo check is unavailable: ${resolved.reason}`, remediation: "Start .omp/push-check with #! and an interpreter that resolves on this machine (e.g. #!/bin/sh), commit it, and retry; nothing was recorded." });
	}
	let exportRoot: string;
	try {
		exportRoot = ownedTmp("omp-kit-push-check").path;
	} catch {
		return refusal(77, { status: "UNRUN", path: ".omp/push-check", sha256: head.sha256, reason: "export_unavailable" },
			{ code: "PUSH_CHECK_EXPORT_UNAVAILABLE", message: "A scratch export directory could not be created", remediation: "Restore temporary-directory access and retry; nothing was recorded." });
	}
	try {
		const archive = kitlibRunSync(["git", "-C", repo, "archive", commit], { cwd: repo, deadline_s: 120, max_output_bytes: 512 * 1024 * 1024 });
		if (archive.rc !== 0 || archive.timed_out || archive.killed || archive.truncated) {
			return refusal(77, { status: "UNRUN", path: ".omp/push-check", sha256: head.sha256, reason: "export_unavailable" },
				{ code: "PUSH_CHECK_EXPORT_UNAVAILABLE", message: "The commit's tree could not be exported", remediation: "Repair the repository and retry; nothing was recorded." });
		}
		const extract = await kitlibRun(["tar", "-xf", "-", "-C", exportRoot], { cwd: repo, stdin: archive.stdout, deadline_s: 120, max_output_bytes: 8 * 1024 * 1024 });
		if (extract.rc !== 0 || extract.timed_out) {
			return refusal(77, { status: "UNRUN", path: ".omp/push-check", sha256: head.sha256, reason: "export_unavailable" },
				{ code: "PUSH_CHECK_EXPORT_UNAVAILABLE", message: "The commit's tree could not be exported", remediation: "Repair the repository and retry; nothing was recorded." });
		}
		const result = await executePushCheckScript(repo, head.bytes, resolved.executable, resolved.version, head.sha256, commit, exportRoot, pushCheckDeadlineSeconds());
		const treeRun = kitlibRunSync(["git", "rev-parse", "--verify", `${commit}^{tree}`], { cwd: repo, deadline_s: 30, max_output_bytes: 1 << 20 });
		const tree = treeRun.rc === 0 && !treeRun.timed_out && !treeRun.killed ? new TextDecoder().decode(treeRun.stdout).trim() : null;
		const rc = result.status === "PASS" ? 0 : result.status === "FAIL" ? (typeof result.exit_code === "number" ? result.exit_code : 1) : null;
		if ((result.status === "PASS" || result.status === "FAIL") && rc !== null) appendPushCheckRow(repo, commit, head.sha256, rc);
		if (result.status === "SKIP") {
			return { code: 1, data: { overall: "SKIP", commit, tree, check_sha256: head.sha256, rc, check: result, text: `push-check SKIP for ${commit}` }, verification: "PERFORMED" };
		}
		if (result.status === "FAIL") {
			return {
				code: 1,
				data: { overall: "FAIL", commit, tree, check_sha256: head.sha256, rc, check: result, text: `push-check FAIL for ${commit} (rc ${rc})` },
				errors: [{ code: "PUSH_CHECK_FAILED", message: `The repo check failed for ${commit}`, remediation: `Repair the check or candidate, then run omp-kit push-check --commit ${commit}.` }],
				verification: "PERFORMED",
			};
		}
		if (result.status !== "PASS") {
			return refusal(77, { status: "UNRUN", path: ".omp/push-check", sha256: head.sha256, reason: result.reason ?? "check_execution_unavailable" },
				{ code: "PUSH_CHECK_UNRUN", message: `The repo check did not complete: ${result.reason ?? "unknown"}`, remediation: "Restore the check tooling and retry; nothing was recorded." });
		}
		return {
			code: 0,
			data: { overall: "PASS", commit, tree, check_sha256: head.sha256, rc: 0, check: { ...result, pushed_sha: null }, text: `push-check PASS for ${commit}` },
			verification: "PERFORMED",
		};
	} finally {
		try { rmSync(exportRoot, { recursive: true, force: true }); } catch { /* best-effort */ }
	}
}

export const PUSH_CHECK_USAGE = "push-check --commit SHA [--repo PATH]";
