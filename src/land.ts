import { appendFileSync, chmodSync, existsSync, lstatSync, mkdirSync, readFileSync, readlinkSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { ownedTmp, type OwnedTmp } from "./kitlib/tmp.ts";
import { run as kitlibRun, runSync as kitlibRunSync } from "./kitlib/run.ts";
import type { RunResult } from "./kitlib/run.ts";
import { loadFactor } from "./kitlib/load.ts";
import { spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { homedir } from "node:os";
import type { CliResult, ParsedCommand } from "./cli.ts";
import { authorizeSourceAct } from "./source-authority.ts";
import { dirname, isAbsolute, join, normalize, relative, resolve, sep } from "node:path";
import { convergeRepository } from "./converge.ts";
import type { ConvergeResult } from "./converge.ts";
import { defaultLiveness, defaultRunner, disposalGate } from "./scratch.ts";
import { parseReservationRead } from "./fleet-guard/git.ts";
import type { AttestedReservation } from "./fleet-guard/git.ts";


type GitResult = { code: number; out: string; err: string; interrupted: boolean; timedOut: boolean };

function gitEnvironment(reflogAction?: string): Record<string, string> {
	const env: Record<string, string> = {};
	for (const [key, value] of Object.entries(process.env)) {
		if (key.startsWith("GIT_") && key !== "GIT_TERMINAL_PROMPT") continue;
		if (value !== undefined) env[key] = value;
	}
	env.GIT_TERMINAL_PROMPT = "0";
	if (reflogAction) env.GIT_REFLOG_ACTION = reflogAction;
	return env;
}

function git(repo: string, args: string[], reflogAction?: string, timeoutMs = 30_000): GitResult {
	const run = kitlibRunSync(["git", ...args], { cwd: repo, env: gitEnvironment(reflogAction), deadline_s: timeoutMs / 1000, max_output_bytes: 8 * 1024 * 1024 });
	return { code: run.rc, out: new TextDecoder().decode(run.stdout), err: new TextDecoder().decode(run.stderr), interrupted: run.timed_out || run.killed, timedOut: run.timed_out };
}

// LANDPUSH1 (ompkit-fp72.120.16.224): the publication push runs the pre-push hook chain (fresh gate,
// affected tests), so it cannot share the 30 s bound of the other git calls. Measured in the companion's
// .git/omp-kit/fresh-gate-runs.jsonl timing.wall_ms, 2026-10-30..2026-11-04: n=510, p50 38.2 s,
// p95 257.3 s, max 1543.6 s, 289/510 over 30 s. Default 2400 s = observed max + ~55% margin.
const LAND_PUSH_DEADLINE_ENV = "OMP_KIT_LAND_PUSH_DEADLINE_S";

/** The publication push deadline in seconds: OMP_KIT_LAND_PUSH_DEADLINE_S (integer, clamped to 1..7200) or 2400. */
function landPushDeadlineSeconds(): number {
	const raw = process.env[LAND_PUSH_DEADLINE_ENV];
	const value = raw === undefined || raw.trim() === "" ? Number.NaN : Number(raw);
	return Number.isSafeInteger(value) ? Math.min(7200, Math.max(1, value)) : 2400;
}

const LAND_COMMIT_DEADLINE_ENV = "OMP_KIT_LAND_COMMIT_DEADLINE_S";

/** The candidate commit deadline in seconds: OMP_KIT_LAND_COMMIT_DEADLINE_S (integer, clamped to 1..7200) or 2400. */
function landCommitDeadlineSeconds(): number {
	const raw = process.env[LAND_COMMIT_DEADLINE_ENV];
	const value = raw === undefined || raw.trim() === "" ? Number.NaN : Number(raw);
	return Number.isSafeInteger(value) ? Math.min(7200, Math.max(1, value)) : 2400;
}

// LANDPATCH1: patch mode publishes through commitOwnedPathsAndPublish, the same
// local-main publisher path mode uses; no second (private-index) publisher remains.

function gitBytes(repo: string, args: string[]): { code: number; out: Buffer; err: string; interrupted: boolean } {
	const run = spawnSync("git", args, { cwd: repo, env: gitEnvironment(), timeout: 30_000, maxBuffer: 4 * 1024 * 1024 });
	return {
		code: run.status ?? 1,
		out: Buffer.isBuffer(run.stdout) ? run.stdout : Buffer.from(run.stdout ?? ""),
		err: String(run.stderr ?? ""),
		interrupted: run.signal !== null || run.error !== undefined,
	};
}

type PhaseState = "APPLIED" | "NOT_APPLIED" | "UNKNOWN";
type LandPhaseEvidence = {
	candidate_sha: string | null;
	actual_parents: string[] | null;
	publication_ref: "refs/heads/main";
	construction: PhaseState;
	publication: PhaseState;
	local_catch_up: PhaseState;
	observed_local_main: string | null;
	observed_publication_head: string | null;
};

function observedRemoteMain(repo: string): string | null {
	const result = git(repo, ["ls-remote", "--refs", "origin", "refs/heads/main"]);
	if (result.code !== 0) return null;
	const lines = result.out.trim().split("\n").filter((line) => line.length > 0);
	if (lines.length !== 1) return null;
	const fields = lines[0]?.split("\t") ?? [];
	return fields.length === 2 && fields[1] === "refs/heads/main" && fields[0] ? fields[0] : null;
}

function isAncestor(repo: string, ancestor: string, descendant: string): boolean | null {
	const result = git(repo, ["merge-base", "--is-ancestor", ancestor, descendant]);
	return result.code === 0 ? true : result.code === 1 ? false : null;
}

function landPhaseEvidence(
	repo: string,
	candidate: string | null,
	convergenceStarted: boolean,
	convergence?: ConvergeResult,
	constructionWithoutCandidate: PhaseState = "UNKNOWN",
): LandPhaseEvidence {
	let actualParents: string[] | null = null;
	let construction = constructionWithoutCandidate;
	if (candidate) {
		const parentResult = git(repo, ["show", "-s", "--format=%P", candidate]);
		if (parentResult.code === 0) {
			const parents = parentResult.out.trim();
			actualParents = parents ? parents.split(" ").filter((parent) => parent.length > 0) : [];
			construction = "APPLIED";
		} else construction = "UNKNOWN";
	}

	const localResult = git(repo, ["rev-parse", "--verify", "refs/heads/main"]);
	const localMain = localResult.code === 0 ? localResult.out.trim() : null;
	const publicationHead = observedRemoteMain(repo);
	const candidateOnRemote = candidate && publicationHead ? isAncestor(repo, candidate, publicationHead) : null;
	let publication: PhaseState;
	if (candidateOnRemote === true) publication = "APPLIED";
	else if (!candidate || publicationHead === null) publication = "UNKNOWN";
	else if (!convergenceStarted) publication = "NOT_APPLIED";
	else if (convergence?.reason === "PUSH_FAILED" && convergence.up === publicationHead && candidateOnRemote === false)
		publication = "NOT_APPLIED";
	else if (convergence?.reason === "PUSH_REJECTED" || convergence?.reason === "CHECK_FAILED" || convergence?.reason === "CHECK_UNRUN")
		publication = "NOT_APPLIED";
	else if (convergence?.state === "REFUSED" && !convergence.applied && candidateOnRemote === false)
		publication = "NOT_APPLIED";
	else publication = "UNKNOWN";

	let localCatchUp: PhaseState;
	if (!convergenceStarted) localCatchUp = "NOT_APPLIED";
	else if (!convergence) localCatchUp = "UNKNOWN";
	else if (convergence.state === "AHEAD") localCatchUp = "NOT_APPLIED";
	else if (convergence.state === "REFUSED" || !convergence.applied)
		localCatchUp = localMain === candidate ? "NOT_APPLIED" : "UNKNOWN";
	else if (convergence.new_head && localMain) {
		const includesCatchUp = isAncestor(repo, convergence.new_head, localMain);
		localCatchUp = includesCatchUp === true ? "APPLIED" : "UNKNOWN";
	} else localCatchUp = "UNKNOWN";

	return {
		candidate_sha: candidate,
		actual_parents: actualParents,
		publication_ref: "refs/heads/main",
		construction,
		publication,
		local_catch_up: localCatchUp,
		observed_local_main: localMain,
		observed_publication_head: publicationHead,
	};
}
export const PUSH_CHECK_PATH = ".omp/push-check";
const MAX_PUSH_CHECK_BYTES = 4 * 1024 * 1024;

type PushCheckStatus = "PASS" | "FAIL" | "SKIP" | "UNRUN";
export type PushCheckResult = {
	status: PushCheckStatus;
	path: string;
	sha256: string | null;
	candidate_sha256?: string | null;
	reason?: string;
	selected_executable: string | null;
	selected_version: string | null;
	candidate_sha: string | null;
	checked_sha: string | null;
	pushed_sha: string | null;
	exit_code: number | null;
};
type TreeBlob =
	| { kind: "blob"; mode: string; oid: string }
	| { kind: "missing" }
	| { kind: "invalid"; reason: string }
	| { kind: "unknown"; reason: string };
type PushCheckPlan =
	| { kind: "ready"; result: PushCheckResult; script: Buffer; executable: string; version: string }
	| { kind: "skip"; result: PushCheckResult }
	| { kind: "unrun"; result: PushCheckResult };

const PUSH_CHECK_DEADLINE_ENV = "OMP_KIT_PUSH_CHECK_DEADLINE_S";

/** The push-check execution deadline in seconds: OMP_KIT_PUSH_CHECK_DEADLINE_S (integer, clamped to 1..3600) or 600. */
export function pushCheckDeadlineSeconds(): number {
	const raw = process.env[PUSH_CHECK_DEADLINE_ENV];
	const value = raw === undefined || raw.trim() === "" ? Number.NaN : Number(raw);
	return Number.isSafeInteger(value) ? Math.min(3600, Math.max(1, value)) : 600;
}

/** Shared push-check execution (HANDOFFPUSHCHECK1): one runner for land and the push-check verb, bounded by kitlib run(). */
export async function executePushCheckScript(repo: string, script: Buffer, executable: string, version: string, checkSha256: string, candidateSha: string, cwd: string, deadlineS: number): Promise<PushCheckResult> {
	const base = pushCheckResult("UNRUN", "not_run", checkSha256);
	const env = gitEnvironment();
	env.OMP_LAND_REPOSITORY = repo;
	env.OMP_LAND_CANDIDATE_SHA = candidateSha;
	env.OMP_LAND_CHECK_PATH = PUSH_CHECK_PATH;
	env.OMP_LAND_CHECK_SHA256 = checkSha256;
	const common = { ...base, selected_executable: executable, selected_version: version, candidate_sha: candidateSha, checked_sha: candidateSha };
	// The check's temporary files go to an owned dir of its own, removed when it ends (never an
	// unowned system temp dir, never the caller's scratch).
	let scratch: OwnedTmp;
	try { scratch = ownedTmp("push-check-tmp"); }
	catch { return { ...common, exit_code: null, status: "UNRUN", reason: "check_execution_unavailable" }; }
	env.TMPDIR = scratch.path;
	let run: RunResult;
	try {
		run = await kitlibRun([executable, "-s"], { cwd, env, stdin: script, deadline_s: Math.max(1, Math.floor(deadlineS)), max_output_bytes: 8 * 1024 * 1024 });
	} catch {
		return { ...common, exit_code: null, status: "UNRUN", reason: "check_execution_unavailable" };
	} finally {
		try { scratch.cleanup(); } catch { /* the owned-temp exit hook retries */ }
	}
	const exitCode = run.rc !== null && run.rc >= 0 ? run.rc : null;
	if (run.timed_out || exitCode === null) return { ...common, exit_code: exitCode, status: "UNRUN", reason: "check_execution_unavailable" };
	if (exitCode === 0) return { ...common, exit_code: exitCode, status: "PASS", reason: undefined };
	if (exitCode === 77) return { ...common, exit_code: exitCode, status: "SKIP", reason: "check_not_applicable" };
	return { ...common, exit_code: exitCode, status: "FAIL", reason: "check_failed" };
}

/** sha256 of the .omp/push-check blob at a revision, or null when absent/unreadable (never throws). */
export function pushCheckHeadSha256(repo: string, revision = "HEAD"): string | null {
	const entry = pushCheckTreeBlob(repo, revision);
	if (entry.kind !== "blob") return null;
	const blob = pushCheckBlob(repo, entry.oid);
	if ("reason" in blob) return null;
	return createHash("sha256").update(blob.bytes).digest("hex");
}

/** Raw .omp/push-check bytes at a revision for the push-check verb (never throws). */
export function pushCheckHeadBytes(repo: string, revision = "HEAD"): { bytes: Buffer; sha256: string; oid: string } | { kind: "missing" } | { kind: "unavailable"; reason: string } {
	const entry = pushCheckTreeBlob(repo, revision);
	if (entry.kind === "missing") return { kind: "missing" };
	if (entry.kind === "invalid") return { kind: "unavailable", reason: entry.reason };
	if (entry.kind === "unknown") return { kind: "unavailable", reason: entry.reason };
	const blob = pushCheckBlob(repo, entry.oid);
	if ("reason" in blob) return { kind: "unavailable", reason: blob.reason };
	return { bytes: blob.bytes, sha256: createHash("sha256").update(blob.bytes).digest("hex"), oid: entry.oid };
}

/** Validate a push-check script the way land does: absolute #! interpreter whose --version answers. */
export function resolvePushCheckExecutable(repo: string, script: Buffer, sha256: string): { executable: string; version: string } | { reason: string } {
	const firstLineEnd = script.indexOf(0x0a);
	const firstLine = script.subarray(0, firstLineEnd < 0 ? script.length : firstLineEnd).toString("utf8").replace(/\r$/, "");
	if (!firstLine.startsWith("#!")) return { reason: "check_interpreter_unavailable" };
	const interpreter = firstLine.slice(2).trim();
	if (!isAbsolute(interpreter) || interpreter.includes(" ") || interpreter.includes("\t"))
		return { reason: "check_interpreter_unavailable" };
	let executable: string;
	try { executable = realpathSync(interpreter); }
	catch { return { reason: "check_interpreter_unavailable" }; }
	const versionRun = spawnSync(executable, ["--version"], { cwd: repo, env: gitEnvironment(), encoding: "utf8", timeout: 10_000, maxBuffer: 1024 * 1024 });
	const versionText = `${String(versionRun.stdout ?? "")}\n${String(versionRun.stderr ?? "")}`.trim();
	const version = versionText.split("\n")[0]?.trim() ?? "";
	if (versionRun.error || versionRun.status !== 0 || !version)
		return { reason: "check_interpreter_unavailable" };
	return { executable, version };
}

/** Append one push-check verdict row (HANDOFFPUSHCHECK1 record). Best-effort: false when the ledger could not be written. */
export function appendPushCheckRow(repo: string, commit: string, checkSha256: string, rc: number): boolean {
	try {
		const tree = git(repo, ["rev-parse", "--verify", `${commit}^{tree}`]);
		if (tree.code !== 0) return false;
		const gitDir = git(repo, ["rev-parse", "--absolute-git-dir"]);
		if (gitDir.code !== 0) return false;
		const dir = join(resolve(repo, gitDir.out.trim()), "omp-kit");
		mkdirSync(dir, { recursive: true });
		const row = { version: 1, commit, tree: tree.out.trim(), check_sha256: checkSha256, rc, at: new Date().toISOString() };
		appendFileSync(join(dir, "push-check-runs.jsonl"), `${JSON.stringify(row)}\n`);
		return true;
	} catch {
		return false;
	}
}

/** Record a completed land push-check verdict for the checked candidate (PASS/FAIL only; SKIP/UNRUN record nothing). */
export function recordLandPushCheck(repo: string, result: PushCheckResult): void {
	try {
		if (result.status !== "PASS" && result.status !== "FAIL") return;
		if (typeof result.sha256 !== "string" || !result.sha256) return;
		const commit = result.candidate_sha ?? result.checked_sha;
		if (!commit) return;
		const rc = typeof result.exit_code === "number" ? result.exit_code : result.status === "PASS" ? 0 : 1;
		appendPushCheckRow(repo, commit, result.sha256, rc);
	} catch { /* ledger writes never fail a landing */ }
}
function pushCheckResult(status: PushCheckStatus, reason?: string, sha256: string | null = null, candidateSha256?: string | null): PushCheckResult {
	return {
		status, path: PUSH_CHECK_PATH, sha256,
		...(candidateSha256 === undefined ? {} : { candidate_sha256: candidateSha256 }),
		...(reason ? { reason } : {}),
		selected_executable: null, selected_version: null, candidate_sha: null, checked_sha: null, pushed_sha: null, exit_code: null,
	};
}

function pushCheckTreeBlob(repo: string, revision: string): TreeBlob {
	const result = git(repo, ["ls-tree", revision, "--", PUSH_CHECK_PATH]);
	if (result.code !== 0) return { kind: "unknown", reason: "check_registration_unavailable" };
	const line = result.out.trimEnd();
	if (!line) return { kind: "missing" };
	const tab = line.indexOf("\t");
	if (tab < 0 || line.slice(tab + 1) !== PUSH_CHECK_PATH) return { kind: "unknown", reason: "check_registration_unreadable" };
	const fields = line.slice(0, tab).split(" ");
	if (fields.length !== 3 || fields[1] !== "blob" || !fields[2]) return { kind: "invalid", reason: "check_not_regular_file" };
	if (fields[0] !== "100644" && fields[0] !== "100755") return { kind: "invalid", reason: "check_not_regular_file" };
	return { kind: "blob", mode: fields[0], oid: fields[2] };
}

function pushCheckBlob(repo: string, oid: string): { bytes: Buffer } | { reason: string } {
	const result = gitBytes(repo, ["cat-file", "blob", oid]);
	if (result.code !== 0 || result.interrupted) return { reason: "check_source_unavailable" };
	if (result.out.length > MAX_PUSH_CHECK_BYTES) return { reason: "check_source_too_large" };
	const text = result.out.toString("utf8");
	if (!Buffer.from(text, "utf8").equals(result.out)) return { reason: "check_source_invalid_utf8" };
	return { bytes: result.out };
}

function preparePushCheck(repo: string, base: string, candidate?: string): PushCheckPlan {
	const baseEntry = pushCheckTreeBlob(repo, base);
	if (baseEntry.kind === "missing") return { kind: "skip", result: pushCheckResult("SKIP", "unregistered") };
	if (baseEntry.kind === "invalid") return { kind: "skip", result: pushCheckResult("SKIP", baseEntry.reason) };
	if (baseEntry.kind === "unknown") return { kind: "unrun", result: pushCheckResult("UNRUN", baseEntry.reason) };
	const baseBlob = pushCheckBlob(repo, baseEntry.oid);
	if ("reason" in baseBlob) return { kind: "unrun", result: pushCheckResult("UNRUN", baseBlob.reason) };
	const sha256 = createHash("sha256").update(baseBlob.bytes).digest("hex");
	if (candidate) {
		const candidateEntry = pushCheckTreeBlob(repo, candidate);
		if (candidateEntry.kind === "unknown") return { kind: "unrun", result: pushCheckResult("UNRUN", candidateEntry.reason, sha256) };
		if (candidateEntry.kind !== "blob") return { kind: "skip", result: pushCheckResult("SKIP", "hash_changed", sha256, null) };
		const candidateBlob = pushCheckBlob(repo, candidateEntry.oid);
		if ("reason" in candidateBlob) return { kind: "unrun", result: pushCheckResult("UNRUN", candidateBlob.reason, sha256) };
		const candidateSha256 = createHash("sha256").update(candidateBlob.bytes).digest("hex");
		if (candidateSha256 !== sha256) return { kind: "skip", result: pushCheckResult("SKIP", "hash_changed", sha256, candidateSha256) };
	}
	const resolved = resolvePushCheckExecutable(repo, baseBlob.bytes, sha256);
	if ("reason" in resolved) return { kind: "unrun", result: pushCheckResult("UNRUN", resolved.reason, sha256) };
	return { kind: "ready", result: pushCheckResult("UNRUN", "not_run", sha256), script: baseBlob.bytes, executable: resolved.executable, version: resolved.version };
}

async function runPushCheck(repo: string, base: string, candidate: string): Promise<PushCheckResult> {
	const plan = preparePushCheck(repo, base, candidate);
	if (plan.kind !== "ready") return { ...plan.result, candidate_sha: candidate };
	return executePushCheckScript(repo, plan.script, plan.executable, plan.version, plan.result.sha256 ?? "", candidate, repo, pushCheckDeadlineSeconds());
}

function pushCheckAdmission(result: PushCheckResult): { allow: boolean; reason?: string } {
	if (result.status === "PASS" || result.status === "SKIP") return { allow: true };
	return { allow: false, reason: result.status === "FAIL" ? "CHECK_FAILED" : "CHECK_UNRUN" };
}

type FullSuiteVerdict = "PASS" | "FAIL" | "UNRUN";
const FULL_SUITE_VERDICT_TIMEOUT_MS = 1_830_000;
const FULL_SUITE_VERDICT_MAX_OUTPUT_BYTES = 1024 * 1024;

type FullSuiteJudge = { root: string; script: string };

async function archiveFullSuiteJudge(repo: string, base: string): Promise<FullSuiteJudge | null> {
	const manifest = git(repo, ["ls-tree", base, "--", "scripts/gate-ci-only.tsv"]);
	if (manifest.code !== 0 || manifest.interrupted) return null;
	const gatePaths = ["scripts/full-suite-verdict.sh", "scripts/full-suite-verdict-store.py", "scripts/fresh-gate.sh", "scripts/kitlib-tmp.sh"];
	const metrics = git(repo, ["ls-tree", base, "--", "scripts/suite-metrics.py"]);
	if (metrics.code !== 0 || metrics.interrupted) return null;
	if (metrics.out.trim()) {
		// JUDGECLOSURE1: the base owns its judging dependencies, including a legacy base's
		// smaller closure. Parse its literal declaration without executing base Python.
		const source = gitBytes(repo, ["show", `${base}:scripts/suite-metrics.py`]);
		if (source.code !== 0 || source.interrupted) return null;
		const closure = await kitlibRun(["python3", "-c", `
import ast, json, sys
if sys.stdin.isatty(): raise ValueError('judging source must be piped')
tree = ast.parse(sys.stdin.read())
values = [ast.literal_eval(n.value) for n in tree.body if isinstance(n, ast.Assign) and any(isinstance(t, ast.Name) and t.id == 'JUDGING_FILES' for t in n.targets)]
if len(values) != 1: raise ValueError('missing or ambiguous JUDGING_FILES')
paths = values[0]
if not isinstance(paths, (tuple, list)) or not paths or any(not isinstance(p, str) or not p or p.startswith('/') or any(c in ('', '.', '..') for c in p.split('/')) or '\\\\' in p or '\\n' in p or '\\r' in p for p in paths): raise ValueError('invalid judging paths')
print(json.dumps(paths))
`], {
			cwd: repo, env: gitEnvironment(), stdin: source.out, deadline_s: 30,
			max_output_bytes: FULL_SUITE_VERDICT_MAX_OUTPUT_BYTES, max_total_bytes: FULL_SUITE_VERDICT_MAX_OUTPUT_BYTES,
		});
		if (closure.rc !== 0 || closure.timed_out || closure.killed || closure.truncated || closure.total_truncated) return null;
		let paths: unknown;
		try { paths = JSON.parse(new TextDecoder().decode(closure.stdout)); } catch { return null; }
		if (!Array.isArray(paths) || !paths.every((path): path is string => typeof path === "string")) return null;
		gatePaths.push(...paths);
	}
	// Historical metrics closures can predate the shell runner's direct process
	// helper. Retain that helper when the base supplies it, never from the worktree.
	const processHelper = git(repo, ["ls-tree", "--name-only", base, "--", "scripts/kitlib-proc.sh"]);
	if (processHelper.code !== 0 || processHelper.interrupted) return null;
	gatePaths.push(...processHelper.out.split("\n").filter(Boolean));
	if (manifest.out.trim()) gatePaths.push("scripts/gate-ci-only.tsv");
	const archive = gitBytes(repo, ["archive", base, ...gatePaths]);
	if (archive.code !== 0 || archive.interrupted) return null;

	let root: string;
	try { root = ownedTmp("land-full-suite-gate", { root: join(repo, "var", "agent-tmp") }).path; }
	catch { return null; }
	const extract = spawnSync("tar", ["-xf", "-", "-C", root], {
		cwd: repo, env: gitEnvironment(), input: archive.out, encoding: "utf8",
		timeout: 30_000, maxBuffer: FULL_SUITE_VERDICT_MAX_OUTPUT_BYTES,
	});
	if (extract.error || extract.signal !== null || extract.status !== 0) {
		try { rmSync(root, { recursive: true, force: true }); }
		catch { return null; }
		return null;
	}
	return { root, script: join(root, "scripts", "full-suite-verdict.sh") };
}

function fullSuiteVerdictFromRun(run: RunResult): FullSuiteVerdict {
	const decoder = new TextDecoder();
	const stdout = decoder.decode(run.stdout);
	const stderr = decoder.decode(run.stderr);
	const complete = !run.timed_out && !run.killed && !run.truncated && !run.total_truncated && run.rc !== null && run.rc >= 0;
	if (!complete) return "UNRUN";
	if (run.rc === 0 &&
		(stdout.includes("FULL-SUITE: VERDICT PASS ") || stdout.includes("FULL-SUITE: VERDICT REUSED PASS ") ||
			stderr.includes("FULL-SUITE: VERDICT PASS ") || stderr.includes("FULL-SUITE: VERDICT REUSED PASS ")))
		return "PASS";
	if (run.rc !== 0 &&
		(stdout.includes("FULL-SUITE: VERDICT FAIL ") || stdout.includes("FULL-SUITE: VERDICT REUSED FAIL ") ||
			stderr.includes("FULL-SUITE: VERDICT FAIL ") || stderr.includes("FULL-SUITE: VERDICT REUSED FAIL ")))
		return "FAIL";
	return "UNRUN";
}
async function runFullSuiteVerdict(repo: string, base: string, candidate: string): Promise<FullSuiteVerdict> {
	// GATESPEED1 (ompkit-774u.71, J-2026-10-31-12): like the push gate, land defers the complete suite to
	// the release (release-local refuses without a main-role PASS for the exact tree, and the push gate
	// starts scripts/release-verdict.sh for the pushed commit). PRE_PUSH_FULL_SUITE=push runs it inline.
	if ((process.env.PRE_PUSH_FULL_SUITE ?? "release") !== "push") return "PASS";
	const judge = await archiveFullSuiteJudge(repo, base);
	if (judge === null) return "UNRUN";
	const configuredTimeoutSeconds = process.env.FULL_SUITE_TIMEOUT_SECS === undefined
		? 1800
		: Number(process.env.FULL_SUITE_TIMEOUT_SECS);
	const timeoutMs = Number.isSafeInteger(configuredTimeoutSeconds) && configuredTimeoutSeconds > 0 && configuredTimeoutSeconds < 2_147_000
		? configuredTimeoutSeconds * 1000 + 30_000
		: FULL_SUITE_VERDICT_TIMEOUT_MS;
	let verdict: FullSuiteVerdict = "UNRUN";
	try {
		const run = await kitlibRun(["sh", judge.script, "--repo", repo, "--commit", candidate, "--judge-role", "base"], {
			cwd: repo, env: gitEnvironment(), deadline_s: timeoutMs / 1000,
			max_output_bytes: FULL_SUITE_VERDICT_MAX_OUTPUT_BYTES, max_total_bytes: FULL_SUITE_VERDICT_MAX_OUTPUT_BYTES,
		});
		verdict = fullSuiteVerdictFromRun(run);
	} catch {
		verdict = "UNRUN";
	}
	try { rmSync(judge.root, { recursive: true, force: true }); }
	catch { return "UNRUN"; }
	return verdict;
}

function fullSuiteError(verdict: Exclude<FullSuiteVerdict, "PASS">): { code: string; message: string; remediation: string } {
	return verdict === "FAIL"
		? { code: "LAND_FULL_SUITE_FAILED", message: "The complete declared suite failed against the exact candidate archive", remediation: "Repair the candidate and retry; the failed tree is cached RED and was not published." }
		: { code: "LAND_FULL_SUITE_UNRUN", message: "The complete declared suite did not produce complete PASS evidence for the exact candidate archive", remediation: "Restore the suite runner or resolve its timeout/incomplete evidence, then retry; no publication was authorized." };
}


const LAND_PUBLICATION_REF = "refs/heads/main";
const LAND_ACTUAL_PARENT_GUARD = "actual-parent-custody-v1";

export const LAND_GUARD_PUBLIC_IDENTITY = {
	guard: LAND_ACTUAL_PARENT_GUARD,
	publication_ref: LAND_PUBLICATION_REF,
} as const;

type WorktreeBlob = { present: boolean; oid: string | null };

function hashWorktreeBlob(repo: string, path: string): WorktreeBlob {
	const run = git(repo, ["hash-object", "--", join(repo, path)]);
	if (run.code !== 0 || run.interrupted) return { present: false, oid: null };
	const oid = run.out.trim();
	return oid.length > 0 ? { present: true, oid } : { present: false, oid: null };
}

function treeBlob(repo: string, revision: string, path: string): WorktreeBlob | null {
	const run = git(repo, ["ls-tree", revision, "--", `:(literal)${path}`]);
	if (run.code !== 0 || run.interrupted) return null;
	const line = run.out.trimEnd();
	if (!line) return { present: false, oid: null };
	const tab = line.indexOf("\t");
	if (tab < 0) return null;
	const fields = line.slice(0, tab).split(" ");
	if (fields.length !== 3 || fields[1] !== "blob" || !fields[2]) return null;
	return { present: true, oid: fields[2] ?? null };
}

function candidateTouchedPaths(repo: string, candidate: string): string[] | null {
	const run = git(repo, ["diff-tree", "--no-commit-id", "--name-only", "-r", "--no-renames", candidate]);
	if (run.code !== 0 || run.interrupted) return null;
	return run.out.split("\n").map((line) => line.trim()).filter((line) => line.length > 0);
}

function supersededBlob(repo: string, base: string, path: string, candidateOid: string): boolean | null {
	const baseEntry = treeBlob(repo, base, path);
	if (baseEntry === null) return null;
	if (baseEntry.present && baseEntry.oid === candidateOid) return false;
	const log = git(repo, ["log", "--format=%H", base, "--", `:(literal)${path}`]);
	if (log.code !== 0 || log.interrupted) return null;
	for (const commit of log.out.split("\n").map((line) => line.trim()).filter((line) => line.length > 0)) {
		if (commit === base) continue;
		const entry = treeBlob(repo, commit, path);
		if (entry === null) return null;
		if (entry.present && entry.oid === candidateOid) return true;
	}
	return false;
}

export type LandPublicationQualification = {
	guard: string;
	publication_ref: string;
	base: string;
	candidate: string;
	actual_parents: string[];
	owned_paths: string[];
	owner: string;
};

export type LandGuardRefusal = {
	refusal: CliResult;
	guardCheck: PushCheckResult;
};

export function qualifyPublicationCandidate(repo: string, input: {
	candidate: string;
	base: string;
	paths: string[];
	owner: string;
	publicationRef: string;
	qualifiedBlobs: Record<string, WorktreeBlob>;
}): { qualification: LandPublicationQualification } | LandGuardRefusal {
	const guardCheck = pushCheckResult("UNRUN", "guard_refused");
	const guardRefusal = (code: string, message: string, remediation: string): LandGuardRefusal => ({
		refusal: {
			code: 1,
			data: { overall: "REFUSED", check: guardCheck },
			errors: [{ code, message, remediation }],
			verification: "NOT_RUN",
		},
		guardCheck,
	});
	if (typeof input.publicationRef !== "string" || input.publicationRef.length === 0)
		return guardRefusal("LAND_PUBLICATION_REF_UNNAMED", "The publication ref is unnamed; no candidate was qualified", "Name the supported publication ref explicitly; nothing was published.");
	if (input.publicationRef !== LAND_PUBLICATION_REF)
		return guardRefusal("LAND_PUBLICATION_REF_UNSUPPORTED", `The publication ref ${input.publicationRef} is not the supported ${LAND_PUBLICATION_REF}; no candidate was qualified`, "Publish only through the supported publication ref; nothing was published.");
	const parentResult = git(repo, ["show", "-s", "--format=%P", input.candidate]);
	if (parentResult.code !== 0 || parentResult.interrupted)
		return guardRefusal("LAND_ACTUAL_PARENT_UNREADABLE", "The candidate has no readable actual parent; no candidate was qualified", "Repair the candidate commit and retry; nothing was published.");
	const actualParents = parentResult.out.trim().split(" ").map((parent) => parent.trim()).filter((parent) => parent.length > 0);
	if (actualParents.length !== 1 || actualParents[0] !== input.base)
		return guardRefusal("LAND_ACTUAL_PARENT_MISMATCH", `The candidate is parented on ${actualParents.length === 1 ? actualParents[0] : `(${actualParents.length} parents)`}, not the qualified base ${input.base}; no candidate was qualified`, "Reconcile with the current publication parent and run land again so the new candidate is qualified.");
	for (const path of input.paths) {
		const qualified = input.qualifiedBlobs[path];
		if (!qualified)
			return guardRefusal("LAND_CANDIDATE_UNQUALIFIED", `Owned path ${path} has no qualified worktree bytes; no candidate was qualified`, "Re-run land so every owned path is qualified before publication; nothing was published.");
		const candidateEntry = treeBlob(repo, input.candidate, path);
		if (candidateEntry === null)
			return guardRefusal("LAND_CANDIDATE_UNREADABLE", `The candidate tree could not be read for ${path}; no candidate was qualified`, "Repair the repository and retry; nothing was published.");
		const sameBytes = qualified.present === candidateEntry.present && qualified.oid === candidateEntry.oid;
		if (!sameBytes)
			return guardRefusal("LAND_CANDIDATE_CONTENT_MISMATCH", `Owned path ${path} drifted between qualification and candidate construction; no candidate was qualified`, "Re-run land on the current worktree bytes; nothing was published.");
		if (candidateEntry.present && candidateEntry.oid) {
			const restored = supersededBlob(repo, input.base, path, candidateEntry.oid);
			if (restored === null)
				return guardRefusal("LAND_STALE_HISTORY_UNREADABLE", `The actual-parent history for ${path} could not be read; no candidate was qualified`, "Repair the repository history and retry; nothing was published.");
			if (restored)
				return guardRefusal("LAND_STALE_RESTORE", `Owned path ${path} restores bytes the actual parent ${input.base} superseded; no candidate was qualified`, "Rebase the owned change onto the actual parent content instead of restoring obsolete bytes; nothing was published.");
		}
	}
	const touched = candidateTouchedPaths(repo, input.candidate);
	if (touched === null)
		return guardRefusal("LAND_CANDIDATE_UNREADABLE", "The candidate file list could not be read; no candidate was qualified", "Repair the repository and retry; nothing was published.");
	const foreign = touched.filter((entry) => !input.paths.includes(entry));
	if (foreign.length > 0)
		return guardRefusal("LAND_FOREIGN_PATH_PUBLISH", `The candidate touches unreserved paths: ${foreign.join(", ")}; no candidate was qualified`, "Reserve and name each exact file separately, then re-run land; nothing was published.");
	const current = authorizedOwner(repo, input.paths);
	if ("error" in current)
		return guardRefusal("LAND_CUSTODY_EXPIRED", "Live custody lapsed before publication; no candidate was qualified", "Reacquire the exact exclusive reservations and re-run land; nothing was published.");
	if (current.owner !== input.owner)
		return guardRefusal("LAND_CUSTODY_FOREIGN", "The live pane owner changed before publication; no candidate was qualified", "Reacquire the correct identity and reservation; nothing was published.");
	return {
		qualification: {
			guard: LAND_ACTUAL_PARENT_GUARD,
			publication_ref: LAND_PUBLICATION_REF,
			base: input.base,
			candidate: input.candidate,
			actual_parents: actualParents,
			owned_paths: [...input.paths],
			owner: input.owner,
		},
	};
}

export type LandGuardIdentity = {
	guard: string;
	publication_ref: string;
	owner: string;
	owner_capability: string;
	actual_parent_capability: string;
	decision: string;
	reason: string;
};

export function inspectLandGuard(repo: string): LandGuardIdentity {
	let owner = "UNKNOWN";
	let ownerCapability = "UNKNOWN";
	const claimed = authorizedOwner(repo, []);
	if (!("error" in claimed)) {
		owner = claimed.owner;
		ownerCapability = "verified-current";
	}
	const headParents = git(repo, ["show", "-s", "--format=%P", "HEAD"]);
	const actualParentCapability = headParents.code === 0 && !headParents.interrupted ? "native-git" : "UNKNOWN";
	const ready = owner !== "UNKNOWN" && actualParentCapability !== "UNKNOWN";
	return {
		guard: LAND_ACTUAL_PARENT_GUARD,
		publication_ref: LAND_PUBLICATION_REF,
		owner,
		owner_capability: ownerCapability,
		actual_parent_capability: actualParentCapability,
		decision: ready ? "READY" : "UNKNOWN",
		reason: ready
			? `Guard ${LAND_ACTUAL_PARENT_GUARD} qualifies owned candidates against their actual publication parent on ${LAND_PUBLICATION_REF} for pane-bound owner ${owner}`
			: "Land guard identities are not fully provable in this checkout; no qualification was attempted",
	};
}

function trackedPaths(repo: string, path: string): string[] | null {
	const result = git(repo, ["ls-files", "-z", "--", `:(literal)${path}`]);
	return result.code === 0 ? result.out.split("\0").filter((entry) => entry.length > 0) : null;
}

function refused(code: string, message: string, remediation: string): CliResult {
	return { code: 1, data: { overall: "REFUSED", check: pushCheckResult("UNRUN", "not_started") }, errors: [{ code, message, remediation }], verification: "NOT_RUN" };
}

type PaneKey = { key: string } | { refusal: CliResult };

// Owner seam (ompkit-kdbz.1.2.1): the tern:<id> mapping below resolves a DECLARED
// Agent Mail pane registration (binding=legacy-unverified), not cryptographic or
// current-native identity proof. Stronger caller/session proof stays on parent ACTOR1.
function paneKey(): PaneKey {
	const herdr = process.env.HERDR_PANE_ID;
	if (process.env.HERDR_ENV === "1" || herdr !== undefined) {
		const id = herdr?.trim() ?? "";
		if (process.env.HERDR_ENV !== "1" || !id || id !== herdr)
			return { refusal: refused("OWNER_UNAVAILABLE", "A native Herdr pane identity is required", "Run land inside a Herdr-managed pane with HERDR_ENV=1 and its unchanged HERDR_PANE_ID; no files were changed.") };
		const tmux = process.env.TMUX_PANE;
		const tern = process.env.TERN_PANE;
		if ((tmux && tmux.length > 0) || (tern && tern.trim().length > 0))
			return { refusal: refused("OWNER_AMBIGUOUS", "Herdr and outer pane identity markers are both present", "Run land from the native Herdr pane after inherited tmux and Tern markers have been removed; no files were changed.") };
		return { key: `herdr:${id}` };
	}
	const tmux = process.env.TMUX_PANE;
	if (tmux && tmux.length > 0) return { key: tmux };
	const tern = process.env.TERN_PANE;
	if (!tern || tern.trim().length === 0) return { refusal: refused("OWNER_UNKNOWN", "A live pane identity is required", "Run land inside a registered tmux or Tern agent pane; no files were changed.") };
	const id = tern.trim();
	let decimal = true;
	for (let i = 0; i < id.length; i++) {
		const digit = id[i];
		if (digit < "0" || digit > "9") { decimal = false; break; }
	}
	if (!decimal) return { refusal: refused("OWNER_UNKNOWN", "The Tern pane identity is malformed", "Run land inside a registered Tern agent pane without overriding TERN_PANE; no files were changed.") };
	return { key: `tern:${id}` };
}

// LANDPANETIMEOUT1 (ompkit-fp72.120.16.280): `am agents resolve-pane` ran under a fixed 10 s spawnSync timeout
// and a timeout read as OWNER_UNKNOWN. Measured 2026-11-05: the real am answers in 15-24 ms (n=10, load1 16.8 on
// 32 cores), but in ~/.local/state/omp-kit/full-suite-verdicts logs 45 land-test cases read OWNER_UNKNOWN from a
// trivial /bin/sh stub, 33 of them at 10.09-10.35 s test wall, i.e. the stub had not answered when the 10 s bound
// fired, at sampled load1 10-30 on 32 cores. The stall is load, not work, and its length is unobserved past 10 s,
// so the bound is 30 s scaled by the fixtures' load factor (1..4): 30 s idle, at most 120 s for a hung am.
const RESOLVE_PANE_BASE_DEADLINE_S = 30;
const RESOLVE_PANE_BASE_ENV = "OMP_KIT_LAND_RESOLVE_BASE_S";

/** The base deadline in seconds, before load scaling, for land's `am` calls (resolve-pane and, since
 * LANDRESVTIMEOUT1, robot reservations): OMP_KIT_LAND_RESOLVE_BASE_S (integer, clamped to 1..600) when set,
 * else 30. */
function resolvePaneBaseSeconds(): number {
	const raw = process.env[RESOLVE_PANE_BASE_ENV];
	const value = raw === undefined || raw.trim() === "" ? Number.NaN : Number(raw);
	return Number.isSafeInteger(value) ? Math.min(600, Math.max(1, value)) : RESOLVE_PANE_BASE_DEADLINE_S;
}

/** The production load factor, the same scaling as tests/cli/fixture-process.ts: 1-minute load per core x 4,
 * clamped to 1..4. OMP_KIT_LOAD_OVERRIDE ("load1/ncpu", the test seam cli.ts already reads) pins it; an
 * unreadable reading takes the widest bound. The single formula lives in src/kitlib/load.ts; this alias keeps
 * the LANDPANETIMEOUT1 call site spelling that tests assert. */
function landLoadFactor(): number {
	return loadFactor();
}

/** Run one `am` call under the shared load-scaled bound (LANDPANETIMEOUT1, LANDRESVTIMEOUT1). am is a single
 * leaf binary and every caller is synchronous, so this uses kitlib's synchronous bounded run (SIGKILL at the
 * deadline). `run` is absent when am could not be spawned. */
function runAmBounded(argv: string[], repo: string, maxOutputBytes: number): { baseS: number; deadlineS: number; run?: RunResult } {
	const baseS = resolvePaneBaseSeconds();
	const deadlineS = Math.ceil(baseS * landLoadFactor());
	try {
		return { baseS, deadlineS, run: kitlibRunSync(argv, { cwd: repo, deadline_s: deadlineS, max_output_bytes: maxOutputBytes }) };
	} catch {
		return { baseS, deadlineS };
	}
}

/** Resolve the live owner of one pane through Agent Mail under the load-scaled bound. A timeout is its own
 * refusal, OWNER_RESOLVE_TIMEOUT; only an answer (or an absent/failed am) reads OWNER_UNKNOWN. */
export function resolvePaneOwner(repo: string, pane: string): { owner: string } | { error: CliResult } {
	const { baseS, deadlineS, run: identity } = runAmBounded(["am", "agents", "resolve-pane", "--project", repo, "--pane", pane, "--json"], repo, 1024 * 1024);
	if (!identity)
		return { error: refused("OWNER_UNKNOWN", "The pane has no registered owner", "Register the pane with Agent Mail before landing; no files were changed.") };
	if (identity.timed_out)
		return { error: refused("OWNER_RESOLVE_TIMEOUT", `am agents resolve-pane did not answer within ${deadlineS} s (${baseS} s base scaled by the 1-minute load), so the pane owner is unknown, not unregistered`, `Check that \`am agents resolve-pane --project ${repo} --pane ${pane} --json\` answers, then retry land; no files were changed.`) };
	if (identity.rc !== 0) return { error: refused("OWNER_UNKNOWN", "The pane has no registered owner", "Register the pane with Agent Mail before landing; no files were changed.") };
	let owner: unknown;
	try {
		const parsed: unknown = JSON.parse(new TextDecoder().decode(identity.stdout));
		owner = typeof parsed === "object" && parsed !== null && "agent_name" in parsed ? parsed.agent_name : null;
	} catch { owner = null; }
	if (typeof owner !== "string" || owner.length === 0) return { error: refused("OWNER_UNKNOWN", "The pane has no registered owner", "Register the pane with Agent Mail before landing.") };
	return { owner };
}

// LANDRESVTIMEOUT1 (ompkit-fp72.120.16.282): `am robot reservations` ran under the same fixed 10 s spawnSync
// timeout, and a load-cut read RESERVATION_UNAVAILABLE. It now shares resolve-pane's load-scaled bound and a
// timeout is its own refusal, RESERVATION_TIMEOUT.
/** Read the owner's active reservations through Agent Mail under the load-scaled bound. */
export function readActiveReservations(repo: string, owner: string): { rows: AttestedReservation[] } | { error: CliResult } {
	const { baseS, deadlineS, run: active } = runAmBounded(["am", "robot", "reservations", "--project", repo, "--agent", owner, "--json"], repo, 2 * 1024 * 1024);
	if (!active) return { error: refused("RESERVATION_UNAVAILABLE", "Active file reservations could not be read", "Restore the Agent Mail reservation service; no files were changed.") };
	if (active.timed_out)
		return { error: refused("RESERVATION_TIMEOUT", `am robot reservations did not answer within ${deadlineS} s (${baseS} s base scaled by the 1-minute load), so the held reservations are unknown, not absent`, `Check that \`am robot reservations --project ${repo} --agent ${owner} --json\` answers, then retry land; no files were changed.`) };
	if (active.rc !== 0) return { error: refused("RESERVATION_UNAVAILABLE", "Active file reservations could not be read", "Restore the Agent Mail reservation service; no files were changed.") };
	const read = parseReservationRead(new TextDecoder().decode(active.stdout));
	if ("why" in read) return { error: refused("RESERVATION_UNREADABLE", `The current reservation read could not be verified: ${read.why}`, "Repair the Agent Mail response and retry; no files were changed.") };
	return { rows: read.rows };
}

function authorizedOwner(repo: string, paths: string[]): { owner: string } | { error: CliResult } {
	const claimed = process.env.AGENT_NAME;
	const selected = paneKey();
	if ("refusal" in selected) return { error: selected.refusal };
	if (!claimed) return { error: refused("OWNER_UNKNOWN", "The agent name claim is required", "Set AGENT_NAME to the identity registered for this pane; no files were changed.") };
	const resolved = resolvePaneOwner(repo, selected.key);
	if ("error" in resolved) return resolved;
	const owner = resolved.owner;
	if (owner !== claimed) return { error: refused("OWNER_MISMATCH", "AGENT_NAME does not match the live pane owner", "Use the identity registered for this pane; no files were changed.") };
	const read = readActiveReservations(repo, owner);
	if ("error" in read) return read;
	const held = new Set<string>();
	for (const row of read.rows) {
		if (row.agent === owner && row.exclusive === true && row.remaining_seconds > 0) held.add(row.path);
	}
	const missing = paths.filter((path) => !held.has(path));
	if (missing.length) return { error: refused("RESERVATION_REQUIRED", `The owner lacks an active exclusive reservation for: ${missing.join(", ")}`, "Reserve every exact repository-relative path exclusively before landing.") };
	return { owner };
}

function normalizePaths(value: string | true | undefined, repo: string): string[] | CliResult {
	if (typeof value !== "string" || value.length === 0) return refused("LAND_PATHS_REQUIRED", "land needs one or more --paths PATH values", "Repeat --paths for each exact repository-relative file.");
	const paths = value.split("\n");
	if (paths.some((path) => path.length === 0 || path.includes("\n") || path.includes("\\") || isAbsolute(path) || path !== normalize(path) || path === "." || path.split("/").includes("..") || path.split("/").includes(".git")))
		return refused("LAND_PATH_INVALID", "Paths must be exact repository-relative files outside .git", "Pass normalized repository-relative file paths; no files were changed.");
	if (new Set(paths).size !== paths.length) return refused("LAND_PATH_DUPLICATE", "Duplicate --paths entries are not allowed", "Pass each repository-relative path once.");
	if (paths.some((path) => relative(repo, resolve(repo, path)).startsWith(`..${sep}`) || isAbsolute(relative(repo, resolve(repo, path)))))
		return refused("LAND_PATH_INVALID", "A requested path resolves outside the repository", "Pass normalized paths contained in the repository.");
	return paths;
}

const MAX_PATCH_BYTES = 4 * 1024 * 1024;

type PatchSelection = { path: string; renamed: boolean; hunks: string[] };

function isOctalDigit(ch: string): boolean {
	return ch >= "0" && ch <= "7";
}

function unquoteGitPath(raw: string): string {
	const text = raw.trim();
	if (text.length < 2 || !text.startsWith('"') || !text.endsWith('"')) return text;
	const bytes: number[] = [];
	const body = text.slice(1, -1);
	for (let i = 0; i < body.length; i++) {
		const ch = body[i] ?? "";
		if (ch !== "\\" || i + 1 >= body.length) {
			for (const byte of Buffer.from(ch, "utf8")) bytes.push(byte);
			continue;
		}
		const next = body[i + 1] ?? "";
		if (next === "n") { bytes.push(0x0a); i++; }
		else if (next === "t") { bytes.push(0x09); i++; }
		else if (next === "\\" || next === '"') { for (const byte of Buffer.from(next, "utf8")) bytes.push(byte); i++; }
		else if (next >= "0" && next <= "7" && i + 4 <= body.length && isOctalDigit(body[i + 1] ?? "") && isOctalDigit(body[i + 2] ?? "") && isOctalDigit(body[i + 3] ?? "")) { bytes.push(parseInt(body.slice(i + 1, i + 4), 8)); i += 3; }
		else { for (const byte of Buffer.from(next, "utf8")) bytes.push(byte); i++; }
	}
	return Buffer.from(bytes).toString("utf8");
}

function splitGitDiffSides(rest: string): [string, string] | null {
	const sides: string[] = [];
	let cursor = rest.trimStart();
	for (let n = 0; n < 2; n++) {
		if (!cursor) return null;
		if (cursor.startsWith('"')) {
			let i = 1;
			while (i < cursor.length) {
				if (cursor[i] === "\\") i += 2;
				else if (cursor[i] === '"') break;
				else i++;
			}
			if (i >= cursor.length) return null;
			sides.push(cursor.slice(0, i + 1));
			cursor = cursor.slice(i + 1).trimStart();
		} else {
			const spaceIndex = cursor.indexOf(" ");
			const tabIndex = cursor.indexOf("\t");
			const space = spaceIndex < 0 ? tabIndex : tabIndex < 0 ? spaceIndex : Math.min(spaceIndex, tabIndex);
			if (space < 0) { sides.push(cursor); cursor = ""; }
			else { sides.push(cursor.slice(0, space)); cursor = cursor.slice(space).trimStart(); }
		}
	}
	if (sides.length !== 2 || cursor.length > 0) return null;
	return [sides[0] ?? "", sides[1] ?? ""];
}

function parsePatchSelection(text: string): PatchSelection[] | null {
	const files: PatchSelection[] = [];
	let current: PatchSelection | null = null;
	for (const line of text.split("\n")) {
		if (line.startsWith("diff --git ")) {
			const sides = splitGitDiffSides(line.slice("diff --git ".length));
			if (!sides) return null;
			const a = unquoteGitPath(sides[0]);
			const b = unquoteGitPath(sides[1]);
			if (!a.startsWith("a/") || !b.startsWith("b/")) return null;
			current = { path: b.slice(2), renamed: a.slice(2) !== b.slice(2), hunks: [] };
			files.push(current);
			continue;
		}
		if (line.startsWith("rename from ") || line.startsWith("rename to ") || line.startsWith("copy from ") || line.startsWith("copy to ")) {
			if (!current) return null;
			current.renamed = true;
			continue;
		}
		if (line.startsWith("@@ ") && current && current.hunks.length < 8) current.hunks.push(line.slice(0, 120));
	}
	return files;
}

function normalizePatchPaths(paths: string[], repo: string): string[] | CliResult {
	if (paths.length === 0) return refused("LAND_PATCH_EMPTY", "The patch selects no files", "Pass a unified diff that names at least one repository-relative file; nothing was published.");
	if (new Set(paths).size !== paths.length) return refused("LAND_PATH_DUPLICATE", "Duplicate patch entries are not allowed", "Name each repository-relative path once; nothing was published.");
	for (const path of paths) {
		if (path.length === 0 || path.includes("\\") || isAbsolute(path) || path !== normalize(path) || path === "." || path.split("/").includes("..") || path.split("/").includes(".git") ||
			relative(repo, resolve(repo, path)).startsWith(`..${sep}`) || isAbsolute(relative(repo, resolve(repo, path))))
			return refused("LAND_PATH_INVALID", `Patch names an invalid repository-relative file: ${path}`, "Pass normalized repository-relative file paths outside .git; nothing was published.");
	}
	return paths;
}

function patchFailureFiles(stderr: string): string[] {
	const files: string[] = [];
	for (const raw of stderr.split("\n")) {
		const line = raw.trim();
		let rest: string | null = null;
		if (line.startsWith("error: patch failed: ")) rest = line.slice("error: patch failed: ".length);
		else if (line.startsWith("error: ") && line.endsWith(": patch does not apply")) rest = line.slice("error: ".length, -": patch does not apply".length);
		else if (line.startsWith("error: ") && line.endsWith(": already exists in working directory")) rest = line.slice("error: ".length, -": already exists in working directory".length);
		if (rest === null) continue;
		const colon = rest.lastIndexOf(":");
		const suffix = colon >= 0 ? rest.slice(colon + 1) : "";
		const lineNumber = colon > 0 && suffix.length > 0 && suffix.split("").every((ch) => ch >= "0" && ch <= "9");
		const file = unquoteGitPath(lineNumber ? rest.slice(0, colon) : rest);
		if (file && !files.includes(file)) files.push(file);
	}
	return files;
}

function patchUnrun(repo: string, code: string, message: string, remediation: string, owner: string, paths: string[], base: string | null, sha256: string | null): CliResult {
	const phases = landPhaseEvidence(repo, null, false, undefined, "NOT_APPLIED");
	return {
		code: 77,
		data: { overall: "UNRUN", commit: null, owner, paths, ...(base ? { base } : {}), check: pushCheckResult("UNRUN", "construction_unavailable", sha256), phases },
		errors: [{ code, message, remediation }],
		verification: "UNVERIFIED",
	};
}

/** Persist the interrupted publication push's hook output and report it the
 * way the retired private-index publisher did (LANDPUSH1): the push is
 * unverified, never failed, and nothing was force-pushed or retried. */
function pushUnverifiedFailure(repo: string, deadlineS: number, convergence: ConvergeResult): { code: string; message: string; remediation: string } {
	let log: string | null = null;
	const gitDir = git(repo, ["rev-parse", "--absolute-git-dir"]);
	if (gitDir.code === 0 && !gitDir.interrupted) {
		const dir = join(gitDir.out.trim(), "omp-kit", "land-push");
		const path = join(dir, `${convergence.new_head ?? "unknown"}.${Date.now()}.log`);
		try {
			mkdirSync(dir, { recursive: true });
			const output = convergence.push_output;
			writeFileSync(path, `# git push origin <head>:refs/heads/main; deadline ${deadlineS} s; the pre-push hook was still running\n# stderr (pre-push hook output)\n${output?.err ?? ""}\n# stdout\n${output?.out ?? ""}`);
			log = path;
		} catch { /* the refusal names the missing log instead */ }
	}
	return {
		code: "LAND_PUBLICATION_UNVERIFIED",
		message: `The push did not finish: the pre-push hook was still running after ${deadlineS} s, the land push deadline (${LAND_PUSH_DEADLINE_ENV}, default 2400, 1..7200); hook log: ${log ?? "not written (could not create it under the git dir's omp-kit/land-push)"}; publication could not be verified`,
		remediation: `Read the hook log, inspect origin/main before retrying, and raise ${LAND_PUSH_DEADLINE_ENV} if the hook chain needs longer. No force-push or fallback was attempted.`,
	};
}

async function landPatchCommand(repo: string, request: ParsedCommand): Promise<CliResult> {
	const message = request.flags.get("--message");
	if (typeof message !== "string" || message.trim().length === 0) return refused("LAND_MESSAGE_REQUIRED", "land needs a nonempty --message", "Pass the commit message; nothing was published.");
	const patchValue = request.flags.get("--patch");
	if (typeof patchValue !== "string" || patchValue.length === 0) return refused("LAND_PATCH_REQUIRED", "patch mode needs a --patch FILE value", "Pass the caller-produced unified diff; nothing was published.");
	if (request.flags.get("--paths") !== undefined) return refused("LAND_PATCH_EXCLUSIVE", "land takes either --paths worktree files or one --patch file, never both", "Run patch mode without --paths, or path mode without --patch; nothing was published.");
	const patchPath = isAbsolute(patchValue) ? patchValue : resolve(process.cwd(), patchValue);
	let patchStat;
	try { patchStat = lstatSync(patchPath); }
	catch { return refused("LAND_PATCH_UNREADABLE", `The patch file could not be read: ${patchValue}`, "Pass a readable unified diff file; nothing was published."); }
	if (!patchStat.isFile()) return refused("LAND_PATCH_UNREADABLE", `The patch is not a regular file: ${patchValue}`, "Pass a readable unified diff file; nothing was published.");
	if (patchStat.size > MAX_PATCH_BYTES) return refused("LAND_PATCH_TOO_LARGE", "The patch file exceeds the 4 MiB construction budget", "Land a smaller caller selection; nothing was published.");
	let patchBytes: Buffer;
	try { patchBytes = readFileSync(patchPath); }
	catch { return refused("LAND_PATCH_UNREADABLE", `The patch file could not be read: ${patchValue}`, "Pass a readable unified diff file; nothing was published."); }
	if (patchBytes.length === 0) return refused("LAND_PATCH_EMPTY", "The patch file is empty", "Pass a unified diff that selects caller hunks; nothing was published.");
	const selection = parsePatchSelection(patchBytes.toString("utf8"));
	if (selection === null) return refused("LAND_PATCH_FORMAT", "The patch is not a standard a/ b/ unified diff", "Produce the patch with git diff or git format-patch; nothing was published.");
	const renamed = selection.filter((entry) => entry.renamed).map((entry) => entry.path);
	if (renamed.length > 0) return refused("LAND_PATCH_RENAMED", `The patch renames files and only content hunks land: ${renamed.join(", ")}`, "Regenerate the patch without renames or copies; nothing was published.");
	const paths = normalizePatchPaths(selection.map((entry) => entry.path), repo);
	if (!Array.isArray(paths)) return paths;
	const owner = authorizedOwner(repo, paths);
	if ("error" in owner) return owner.error;
	const currentOwner = authorizedOwner(repo, paths);
	if ("error" in currentOwner) return currentOwner.error;
	if (currentOwner.owner !== owner.owner) return refused("OWNER_MISMATCH", "The live pane owner changed before saving", "Reacquire the correct identity and reservation; nothing was committed.");
	const branch = git(repo, ["symbolic-ref", "--quiet", "HEAD"]);
	if (branch.code !== 0 || branch.out.trim() !== "refs/heads/main")
		return refused("LAND_MAIN_REQUIRED", "Land requires the canonical shared main checkout", "Return to shared main without discarding work; no commit was created.");
	const gitDir = git(repo, ["rev-parse", "--absolute-git-dir"]);
	const commonDir = git(repo, ["rev-parse", "--git-common-dir"]);
	if (gitDir.code !== 0 || commonDir.code !== 0 || resolve(repo, commonDir.out.trim()) !== resolve(gitDir.out.trim()))
		return refused("LAND_CANONICAL_REQUIRED", "Land requires the primary shared checkout, not a linked worktree", "Use the canonical shared main checkout; no commit was created.");
	const fetch = git(repo, ["fetch", "origin", "refs/heads/main"]);
	if (fetch.code !== 0 || fetch.interrupted)
		return patchUnrun(repo, "LAND_ORIGIN_UNAVAILABLE", "Fresh origin/main could not be fetched", "Restore origin reachability and retry; nothing was committed or published.", owner.owner, paths, null, null);
	const mainRef = git(repo, ["rev-parse", "--verify", "refs/remotes/origin/main"]);
	if (mainRef.code !== 0)
		return patchUnrun(repo, "LAND_ORIGIN_UNAVAILABLE", "Fresh origin/main has no readable commit after fetch", "Restore origin reachability and retry; nothing was committed or published.", owner.owner, paths, null, null);
	const base = mainRef.out.trim();
	const localMain = git(repo, ["rev-parse", "refs/heads/main"]).out.trim();
	let checkPreflight = preparePushCheck(repo, base);
	if (checkPreflight.kind === "ready" && paths.includes(PUSH_CHECK_PATH))
		checkPreflight = { kind: "skip", result: pushCheckResult("SKIP", "hash_changed", checkPreflight.result.sha256) };
	if (checkPreflight.kind === "unrun") {
		const phases = landPhaseEvidence(repo, null, false, undefined, "NOT_APPLIED");
		return {
			code: 77,
			data: { overall: "UNRUN", commit: null, owner: owner.owner, paths, base, check: checkPreflight.result, phases },
			errors: [{ code: "LAND_CHECK_UNRUN", message: `The registered repo check is unavailable: ${checkPreflight.result.reason ?? "unknown"}`, remediation: "Restore the registered check executable and retry; no commit or publication was attempted." }],
			verification: "UNVERIFIED",
		};
	}
	// Reconstruct the caller selection onto fresh origin/main in a detached
	// scratch worktree. The shared worktree and index never contribute bytes.
	let scratchBase = "";
	try { scratchBase = ownedTmp("omp-kit-land-patch").path; }
	catch { return patchUnrun(repo, "LAND_CONSTRUCTION_UNAVAILABLE", "A scratch construction directory could not be created", "Restore temporary-directory access and retry; nothing was committed or published.", owner.owner, paths, base, checkPreflight.result.sha256); }
	const scratch = join(scratchBase, "work");
	const cleanup = (): void => {
		try { git(repo, ["worktree", "remove", "--force", scratch]); } catch { /* scratch removal is best-effort */ }
		try { git(repo, ["worktree", "prune"]); } catch { /* scratch removal is best-effort */ }
		try { rmSync(scratchBase, { recursive: true, force: true }); } catch { /* scratch removal is best-effort */ }
	};
	const added = git(repo, ["worktree", "add", "--detach", scratch, base]);
	if (added.code !== 0 || added.interrupted) {
		cleanup();
		return patchUnrun(repo, "LAND_CONSTRUCTION_UNAVAILABLE", "Fresh origin/main could not be checked out for reconstruction", "Repair the local repository and retry; nothing was committed or published.", owner.owner, paths, base, checkPreflight.result.sha256);
	}
	let applied: RunResult;
	try {
		applied = await kitlibRun(["git", "apply", "--3way", "-"], {
			cwd: scratch, env: gitEnvironment(), stdin: patchBytes,
			deadline_s: 30, max_output_bytes: 8 * 1024 * 1024,
		});
	} catch (error) {
		cleanup();
		return patchUnrun(repo, "LAND_CONSTRUCTION_UNAVAILABLE", `Git could not apply the caller patch: ${error instanceof Error ? error.message : String(error)}`, "Restore Git execution and retry; nothing was committed or published.", owner.owner, paths, base, checkPreflight.result.sha256);
	}
	if (applied.rc !== 0 || applied.timed_out || applied.killed || applied.truncated) {
		cleanup();
		const files = patchFailureFiles(new TextDecoder().decode(applied.stderr));
		const named = files.length > 0 ? files : paths;
		const hunks = named.flatMap((file) => selection.find((entry) => entry.path === file)?.hunks ?? []).slice(0, 6);
		const check = checkPreflight.kind === "skip" ? checkPreflight.result : pushCheckResult("UNRUN", "patch_conflict", checkPreflight.result.sha256);
		const phases = landPhaseEvidence(repo, null, false, undefined, "NOT_APPLIED");
		return {
			code: 1,
			data: { overall: "REFUSED", commit: null, owner: owner.owner, paths, base, localMain, check, phases },
			errors: [{ code: "PATCH_CONFLICT", message: `The patch does not apply to fresh origin/main: ${named.join(", ")}${hunks.length > 0 ? ` (${hunks.join("; ")})` : ""}`, remediation: "Regenerate the caller patch from current origin/main so every selected hunk applies; no commit was created or published." }],
			verification: "NOT_RUN",
		};
	}
	const changed = git(scratch, ["diff", "--quiet", "HEAD"]);
	if (changed.code === 0) {
		cleanup();
		const check = checkPreflight.kind === "skip" ? checkPreflight.result : pushCheckResult("UNRUN", "patch_empty", checkPreflight.result.sha256);
		const phases = landPhaseEvidence(repo, null, false, undefined, "NOT_APPLIED");
		return {
			code: 1,
			data: { overall: "REFUSED", commit: null, owner: owner.owner, paths, base, localMain, check, phases },
			errors: [{ code: "LAND_PATCH_EMPTY", message: "The patch selects no changes against fresh origin/main", remediation: "Select caller hunks that differ from current origin/main; no commit was created or published." }],
			verification: "NOT_RUN",
		};
	}
	if (changed.code !== 1) {
		cleanup();
		return patchUnrun(repo, "LAND_CONSTRUCTION_UNVERIFIED", "The reconstructed tree could not be inspected safely", "Repair the local repository and retry; nothing was committed or published.", owner.owner, paths, base, checkPreflight.result.sha256);
	}
	// Snapshot the reconstructed bytes for exactly the patch paths, then drop
	// the scratch worktree: it never publishes. The reconstruction lives only
	// in the scratch worktree (never committed), so the snapshot reads worktree
	// files, never a committed tree. Patch mode commits these bytes on local
	// main and publishes main exactly the way path mode does (LANDPATCH1), so
	// the on-main pre-push member admits the push.
	type ReconstructedEntry = { bytes: Buffer; mode: string } | null;
	const reconstructed = new Map<string, ReconstructedEntry>();
	for (const path of paths) {
		const full = join(scratch, path);
		let entry: ReconstructedEntry;
		try {
			const stat = lstatSync(full);
			if (stat.isSymbolicLink()) entry = { bytes: Buffer.from(readlinkSync(full), "utf8"), mode: "120000" };
			else if (stat.isFile()) entry = { bytes: readFileSync(full), mode: (stat.mode & 0o111) !== 0 ? "100755" : "100644" };
			else {
				cleanup();
				return patchUnrun(repo, "LAND_CONSTRUCTION_UNVERIFIED", `The reconstructed candidate entry for ${path} is not a plain file and cannot be landed on local main`, "Land only caller hunks that add or change plain files; nothing was published.", owner.owner, paths, base, checkPreflight.result.sha256);
			}
		} catch (error) {
			if (!(error instanceof Error && "code" in error && error.code === "ENOENT") || existsSync(full)) {
				cleanup();
				return patchUnrun(repo, "LAND_CONSTRUCTION_UNVERIFIED", `The reconstructed candidate bytes for ${path} could not be read`, "Repair the local repository and retry; nothing was published.", owner.owner, paths, base, checkPreflight.result.sha256);
			}
			entry = null;
		}
		reconstructed.set(path, entry);
	}
	cleanup();
	// Patch paths are normally dirty in the caller checkout: the patch itself
	// was produced from those bytes. Committing the reconstruction and then
	// restoring the caller's bytes preserves them exactly, so no refusal is
	// needed and no byte outside these paths is touched. Only the dirtiness
	// snapshot below is read; the worktree snapshot decides what comes back.
	const dirtyBefore = new Set<string>();
	{
		const dirty = git(repo, ["status", "--porcelain=v1", "-z", "--", ...paths.map((path) => `:(literal)${path}`)]);
		if (dirty.code !== 0 || dirty.interrupted)
			return patchUnrun(repo, "STAGED_INDEX_UNAVAILABLE", "The owned changes could not be checked", "Repair the Git index before landing; no files were changed.", owner.owner, paths, base, checkPreflight.result.sha256);
		for (const entry of dirty.out.split("\0")) {
			// Rename records are two NUL fields; only the XY-prefixed side
			// names a dirty path.
			if (entry.length > 3 && entry[2] === " ") dirtyBefore.add(entry.slice(3));
		}
	}
	// The reconstruction is parented on fresh origin/main: advance local main
	// onto it before committing, never behind and never diverged. A local main
	// that already holds unpushed commits would lose those bytes to the
	// materialized reconstruction, so it refuses instead.
	const localTip = git(repo, ["rev-parse", "--verify", "refs/heads/main^{commit}"]);
	if (localTip.code !== 0 || localTip.interrupted)
		return patchUnrun(repo, "BASELINE_UNAVAILABLE", "Local main has no readable commit", "Repair the Git repository before landing; nothing was committed or published.", owner.owner, paths, base, checkPreflight.result.sha256);
	if (isAncestor(repo, localTip.out.trim(), base) !== true)
		return refused("LAND_BASE_ADVANCE_REFUSED", `Local main holds commits that fresh origin/main lacks: ${localTip.out.trim()}`, "Push or reconcile the local main commits first, then run land again; no commit was created or published.");
	if (localTip.out.trim() !== base) {
		const ff = git(repo, ["merge", "--ff-only", "refs/remotes/origin/main"]);
		if (ff.code !== 0 || ff.interrupted)
			return refused("LAND_BASE_ADVANCE_REFUSED", `Local main could not be fast-forwarded to fresh origin/main: ${(ff.err.trim() || ff.out.trim()).slice(-300)}`, "Reconcile local main with origin/main without discarding work, then run land again; no commit was created or published.");
	}
	// Snapshot the exact pre-landing worktree state and index. Paths the
	// caller left dirty get their state back however the landing ends, so the
	// reconstruction never strands in their worktree; clean paths keep the
	// committed bytes on success and come back on any refusal. Symlinks are
	// snapshotted as links and restored as links, never flattened to files.
	type WorktreeEntry =
		| { kind: "absent" }
		| { kind: "file"; bytes: Buffer; mode: number }
		| { kind: "symlink"; target: string }
		| { kind: "other" };
	const worktreeBefore = new Map<string, WorktreeEntry>();
	for (const path of paths) {
		const full = join(repo, path);
		let entry: WorktreeEntry;
		try {
			const stat = lstatSync(full);
			if (stat.isSymbolicLink()) entry = { kind: "symlink", target: readlinkSync(full) };
			else if (stat.isFile()) entry = { kind: "file", bytes: readFileSync(full), mode: stat.mode & 0o7777 };
			else entry = { kind: "other" };
		} catch (error) {
			if (error instanceof Error && "code" in error && error.code === "ENOENT" && !existsSync(full)) entry = { kind: "absent" };
			else return patchUnrun(repo, "LAND_CONSTRUCTION_UNVERIFIED", `The pre-landing worktree state for ${path} could not be read`, "Repair the worktree and index before retrying; nothing was committed or published.", owner.owner, paths, base, checkPreflight.result.sha256);
		}
		worktreeBefore.set(path, entry);
	}
	const indexPathResult = git(repo, ["rev-parse", "--absolute-git-dir"]);
	const indexBefore = indexPathResult.code === 0 && !indexPathResult.interrupted
		? (() => { try { return readFileSync(join(indexPathResult.out.trim(), "index")); } catch { return null; } })()
		: null;
	const restoreWorktree = (published: boolean): void => {
		for (const [path, before] of worktreeBefore) {
			// Clean paths keep the committed bytes on success; everything
			// else comes back exactly as the caller left it.
			if (published && !dirtyBefore.has(path)) continue;
			const full = join(repo, path);
			try {
				rmSync(full, { force: true });
				if (before.kind === "symlink") symlinkSync(before.target, full);
				else if (before.kind === "file") {
					mkdirSync(dirname(full), { recursive: true });
					writeFileSync(full, before.bytes);
					chmodSync(full, before.mode);
				}
			} catch { /* best-effort per path; the refusal already reports */ }
		}
		try {
			if (!published && indexBefore !== null && indexPathResult.code === 0 && !indexPathResult.interrupted)
				writeFileSync(join(indexPathResult.out.trim(), "index"), indexBefore);
		} catch { /* best-effort; the refusal already reports */ }
	};
	let result: CliResult | null = null;
	let published = false;
	try {
		for (const path of paths) {
			const full = join(repo, path);
			const entry = reconstructed.get(path);
			try {
				// Replace the path, never write through a caller symlink.
				rmSync(full, { force: true });
				if (!entry) continue;
				if (entry.mode === "120000") symlinkSync(entry.bytes.toString("utf8"), full);
				else {
					mkdirSync(dirname(full), { recursive: true });
					writeFileSync(full, entry.bytes);
					if (entry.mode === "100755") chmodSync(full, 0o755);
				}
			} catch {
				return patchUnrun(repo, "LAND_CONSTRUCTION_UNVERIFIED", `The reconstructed bytes for ${path} could not be written to local main`, "Repair the worktree and index before retrying; nothing was committed or published.", owner.owner, paths, base, checkPreflight.result.sha256);
			}
		}
		result = await commitOwnedPathsAndPublish(repo, { paths, message, owner: owner.owner, base, pushDeadlineS: landPushDeadlineSeconds() });
		published = (result.data as { overall?: string } | null)?.overall === "PUSHED";
		return result;
	} finally {
		restoreWorktree(published);
	}
}

/** Commit exactly the owned worktree paths on local main and publish main
 * through owner-resolved convergence (LANDPATCH1, ompkit-1ra0d.69). Path mode
 * calls this with its reserved worktree bytes; patch mode calls it after
 * materializing its reconstructed hunks onto local main. One publisher, so
 * every push moves local main itself and the on-main pre-push member admits
 * it. Preserves every staged entry and worktree byte outside `paths`, the
 * same contract as Git's native --only transaction. */
async function commitOwnedPathsAndPublish(
	repo: string,
	input: { paths: string[]; message: string; owner: string; base: string; pushDeadlineS?: number },
): Promise<CliResult> {
	const { paths, message, owner, base } = input;
	let checkPreflight = preparePushCheck(repo, base);
	if (checkPreflight.kind === "ready" && paths.includes(PUSH_CHECK_PATH)) {
		const checkDiff = git(repo, ["diff", "--quiet", "HEAD", "--", `:(literal)${PUSH_CHECK_PATH}`]);
		if (checkDiff.code === 1)
			checkPreflight = { kind: "skip", result: pushCheckResult("SKIP", "hash_changed", checkPreflight.result.sha256) };
		else if (checkDiff.code !== 0)
			return refused("CHECK_REGISTRATION_UNREADABLE", "The push check candidate could not be inspected safely", "Repair the candidate path and retry; nothing was committed.");
	}
	if (checkPreflight.kind === "unrun") {
		const phases = landPhaseEvidence(repo, null, false, undefined, "NOT_APPLIED");
		return {
			code: 77,
			data: { overall: "UNRUN", commit: null, owner, paths, base, check: checkPreflight.result, phases },
			errors: [{ code: "LAND_CHECK_UNRUN", message: `The registered repo check is unavailable: ${checkPreflight.result.reason ?? "unknown"}`, remediation: "Restore the registered check executable and retry; no commit or publication was attempted." }],
			verification: "UNVERIFIED",
		};
	}
	// Git's native --only transaction leaves every unrelated staged entry intact.
	// New paths must first be known to the index; only explicitly owned paths enter it.
	for (const path of paths) {
		const tracked = trackedPaths(repo, path);
		if (tracked === null) return refused("STAGED_INDEX_UNREADABLE", "Tracked paths could not be rechecked safely", "Repair the Git index before landing.");
		if (tracked.length === 0) {
			const add = git(repo, ["add", "--intent-to-add", "--", `:(literal)${path}`]);
			if (add.code !== 0) return refused("LAND_PATH_UNAVAILABLE", `Could not prepare owned path ${path}`, "Repair the file or index; no commit was created.");
		}
	}
	// Snapshot the exact qualified worktree bytes before construction. The
	// actual-parent guard compares the built candidate against this snapshot
	// and the qualified base, never against a dispatch seed or shared HEAD.
	const qualifiedBlobs: Record<string, WorktreeBlob> = {};
	for (const path of paths) qualifiedBlobs[path] = hashWorktreeBlob(repo, path);
	// GATELOCK1: the installed member judges HEAD plus these exact owned
	// worktree paths before git commit takes index.lock. The commit hook
	// admits only the same tree, parent, message, remote base and gate.
	const hookPath = git(repo, ["rev-parse", "--path-format=absolute", "--git-path", "hooks"]);
	if (hookPath.code !== 0)
		return refused("COMMIT_GATE_UNAVAILABLE", "Git's hook location could not be resolved", "Repair the repository before saving; nothing was committed.");
	const commitGate = join(hookPath.out.trim(), "hooks.d/commit-msg/55-omp-kit-commit-gate");
	let gatePresent = false;
	try { gatePresent = lstatSync(commitGate).isFile(); }
	catch (error) {
		if (!(error instanceof Error && "code" in error && error.code === "ENOENT"))
			return refused("COMMIT_GATE_UNAVAILABLE", `Cannot inspect installed gate: ${String(error)}`, "Restore hook access before saving; nothing was committed.");
	}
	try {
		if (gatePresent) {
			const preparation = ownedTmp("land-commit-gate");
			try {
				const messageFile = join(preparation.path, "message");
				writeFileSync(messageFile, message + "\n");
				const result = await kitlibRun(["sh", commitGate, "--prepare", messageFile, "--files", ...paths], {
					cwd: repo, env: gitEnvironment(), deadline_s: landPushDeadlineSeconds(), max_output_bytes: 8 * 1024 * 1024,
				});
				if (result.rc !== 0 || result.timed_out || result.killed || result.truncated)
					return refused("COMMIT_GATE_REFUSED", new TextDecoder().decode(result.stdout) + new TextDecoder().decode(result.stderr), "Fix the gate finding and prepare the current tree again; nothing was committed.");
			} finally { preparation.cleanup(); }
		}
	} catch (error) {
		return refused("COMMIT_GATE_UNAVAILABLE", `Commit preparation failed: ${String(error)}`, "Restore the installed gate and retry; nothing was committed.");
	}
	// A peer may advance HEAD from a post-commit hook before Git returns. Attribute
	// our save through a per-call native reflog action, never through the later tip.
	const action = `omp-kit-land-${randomUUID()}`;
	const commitDeadlineS = landCommitDeadlineSeconds();
	const commit = git(repo, ["-c", "core.logAllRefUpdates=true", "commit", "--only", "-m", message, "--", ...paths.map((path) => `:(literal)${path}`)], action, commitDeadlineS * 1000);
	const reflog = git(repo, ["reflog", "show", "--format=%H%x00%gs", "refs/heads/main"]);
	const matches = reflog.out.split("\n").map((line) => line.split("\0"))
		.filter((fields) => fields[1]?.startsWith(`${action}: `)).map((fields) => fields[0]);
	const sha = matches.length === 1 ? matches[0] : null;
	const constructionWithoutCandidate: PhaseState =
		commit.code !== 0 && !commit.interrupted && reflog.code === 0 && matches.length === 0 ? "NOT_APPLIED" : "UNKNOWN";
	if (!sha) {
		const check = checkPreflight.kind === "skip"
			? checkPreflight.result
			: pushCheckResult("UNRUN", constructionWithoutCandidate === "NOT_APPLIED" ? "commit_refused" : "candidate_identity_unknown", checkPreflight.result.sha256);
		const refusedCommit = constructionWithoutCandidate === "NOT_APPLIED";
		const phases = landPhaseEvidence(repo, null, false, undefined, constructionWithoutCandidate);
		return {
			code: refusedCommit ? 1 : 77,
			data: { overall: refusedCommit ? "REFUSED" : "UNRUN", commit: null, owner, paths, base, check, phases },
			errors: [{
				code: commit.timedOut ? "LAND_COMMIT_TIMEOUT" : refusedCommit ? "COMMIT_CREATION_REFUSED" : "LAND_COMMIT_UNVERIFIED",
				message: commit.timedOut ? `The candidate commit exceeded ${commitDeadlineS} s; commit hooks may still be running` : refusedCommit ? `Git refused the candidate commit: ${commit.err.trim()}` : "The commit operation ended without unambiguous save attribution",
				remediation: commit.timedOut ? `Check git log -1 and the reflog, raise ${LAND_COMMIT_DEADLINE_ENV}, then retry; no publication was attempted.` : "Inspect the shared main and reflog before retrying; no publication was attempted.",
			}],
			verification: refusedCommit ? "NOT_RUN" : "UNVERIFIED",
		};
	}
	if (commit.code !== 0 || commit.interrupted) {
		const check = pushCheckResult("UNRUN", "commit_interrupted", checkPreflight.result.sha256);
		const phases = landPhaseEvidence(repo, sha, false);
		return { code: 77, data: { overall: "UNRUN", commit: sha, owner, paths, base, check, phases }, errors: [{ code: "LAND_COMMIT_INTERRUPTED", message: "Git saved the owned commit, but the commit command did not finish successfully", remediation: "Inspect the interrupted hook and saved commit before publication; no hooks were bypassed and no rollback was attempted." }], verification: "UNVERIFIED" };
	}
	// Actual-parent/custody qualification (ompkit-rhy9.10): the constructed
	// candidate must be parented on exactly the qualified base, carry exactly
	// the qualified bytes without restoring superseded history, touch only
	// owned paths, and hold current custody. Anything else publishes nothing.
	const qualified = qualifyPublicationCandidate(repo, {
		candidate: sha, base, paths, owner,
		publicationRef: LAND_PUBLICATION_REF, qualifiedBlobs,
	});
	if ("refusal" in qualified) {
		const phases = landPhaseEvidence(repo, sha, false);
		return {
			code: 1,
			data: { overall: "REFUSED", commit: sha, candidate_sha: sha, pushed_sha: null, owner, paths, base, check: qualified.guardCheck, phases },
			errors: qualified.refusal.errors,
			verification: "PERFORMED",
		};
	}
	let convergenceStarted = false;
	let convergenceResult: ConvergeResult | undefined;
	let checkResult = checkPreflight.kind === "skip"
		? checkPreflight.result
		: pushCheckResult("UNRUN", "not_run", checkPreflight.result.sha256);
	let fullSuiteVerdict: FullSuiteVerdict | undefined;
	let checkedCandidateSha: string | null = null;
	try {
		convergenceStarted = true;
		const convergence = await convergeRepository({
			repo, apply: true, push: true, pushDeadlineS: input.pushDeadlineS,
			beforePush: async (candidateSha, baseSha) => {
				checkedCandidateSha = candidateSha;
				checkResult = await runPushCheck(repo, baseSha, candidateSha);
				const admission = pushCheckAdmission(checkResult);
				if (!admission.allow) return admission;
				fullSuiteVerdict = await runFullSuiteVerdict(repo, baseSha, candidateSha);
				if (fullSuiteVerdict !== "PASS")
					return { allow: false, reason: fullSuiteVerdict === "FAIL" ? "CHECK_FAILED" : "CHECK_UNRUN" };
				// SCRATCHBIN1 (ompkit-774u.15, Joshua scope 2026-10-20): refuse the push while the session holds an
				// undisposed scratch dir. Refuse on positive evidence only; an unlistable census is fail-open, never
				// a block, so a broken measuring tool cannot strand a landing.
				try {
					const gate = disposalGate(homedir(), "push", { liveness: defaultLiveness(), run: defaultRunner });
					if (!gate.unproven && gate.decision === "refuse") {
						const first = gate.owed.slice(0, 3).map(row => `${row.dir} (${row.state}, bin ${row.bin})`).join("; ");
						return { allow: false, reason: `SCRATCH_DISPOSAL_REFUSED: ${gate.owed.length} undisposed scratch dir(s): ${first}${gate.owed.length > 3 ? "…" : ""}. Release each with omp-kit scratch release DIR --bin throwaway|evidence|promote.` };
					}
				} catch { /* fail-open: the push check already passed */ }
				return admission;
			},
		});
		convergenceResult = convergence;
		const candidateSha = checkResult.candidate_sha ?? checkedCandidateSha ?? convergence.new_head ?? sha;
		const pushedSha = convergence.pushed ? convergence.remote_after ?? null : null;
		checkResult = { ...checkResult, pushed_sha: pushedSha };
		// HANDOFFPUSHCHECK1: every completed push-check verdict lands in the
		// <git-dir>/omp-kit/push-check-runs.jsonl ledger the handoff gate reads.
		recordLandPushCheck(repo, checkResult);
		const checkUnavailable = checkResult.status === "UNRUN" && checkResult.reason !== "not_run";
		const fullSuiteUnavailable = fullSuiteVerdict === "UNRUN";
		const pushUnverified = convergence.reason === "PUSH_UNVERIFIED";
		const checkAllowed = checkResult.status === "PASS" || checkResult.status === "SKIP";
		const published = convergence.pushed && pushedSha === candidateSha && checkAllowed && fullSuiteVerdict === "PASS";
		const overall = published ? "PUSHED" : checkUnavailable || fullSuiteUnavailable || pushUnverified ? "UNRUN" : "REFUSED";
		const phases = landPhaseEvidence(repo, sha, convergenceStarted, convergence);
		const suiteFailure = fullSuiteVerdict === "FAIL" || fullSuiteVerdict === "UNRUN" ? fullSuiteError(fullSuiteVerdict) : undefined;
		const convergenceData: ConvergeResult = { ...convergence };
		delete convergenceData.push_output;
		const failure = published ? undefined : suiteFailure ?? (checkResult.status === "FAIL"
			? { code: "LAND_CHECK_FAILED", message: "The registered repo check failed for the exact publication candidate", remediation: "Repair the check or candidate; it was not published." }
			: checkUnavailable
				? { code: "LAND_CHECK_UNRUN", message: `The registered repo check did not complete: ${checkResult.reason ?? "unknown"}`, remediation: "Restore the registered check tooling and retry; no publication was authorized." }
				: convergence.reason === "PUSH_REJECTED"
					? { code: "LAND_PUSH_REJECTED", message: "origin/main advanced after candidate check; the exact checked candidate was refused without retry or force", remediation: "Reconcile with current origin/main and run land again so the new candidate is checked." }
					: pushUnverified
						? pushUnverifiedFailure(repo, input.pushDeadlineS ?? landPushDeadlineSeconds(), convergence)
						: { code: "LAND_PUBLICATION_REFUSED", message: `The exact checked candidate was not published: ${convergence.reason ?? "publication was not verified"}`, remediation: "Preserve the candidate and resolve the typed refusal before another landing." });
		return {
			code: published ? 0 : overall === "UNRUN" ? 77 : 1,
			data: { overall, commit: sha, candidate_sha: candidateSha, pushed_sha: pushedSha, owner, paths, base, localMain: git(repo, ["rev-parse", "refs/heads/main"]).out.trim(), convergence: convergenceData, check: checkResult, phases },
			...(failure ? { errors: [failure] } : {}),
			verification: overall === "UNRUN" ? "UNVERIFIED" : "PERFORMED",
		};
	} catch (error) {
		const phases = landPhaseEvidence(repo, sha, convergenceStarted, convergenceResult);
		const check = { ...checkResult, pushed_sha: null };
		return { code: 77, data: { overall: "UNRUN", commit: sha, candidate_sha: checkedCandidateSha ?? sha, pushed_sha: null, owner, paths, base, check, phases }, errors: [{ code: "LAND_PUBLICATION_UNVERIFIED", message: `The candidate was saved but publication could not be verified: ${error instanceof Error ? error.message : String(error)}`, remediation: "Inspect local main and origin/main before retrying; no force-push or fallback was attempted." }], verification: "UNVERIFIED" };
	}
}

export async function landCommand(request: ParsedCommand): Promise<CliResult> {
	if (!request.flags.has("--apply")) return refused("LAND_APPLY_REQUIRED", "land is a mutation and requires --apply", "Review the exact owner, paths, base and candidate, then pass --apply --yes.");
	const root = git(process.cwd(), ["rev-parse", "--show-toplevel"]);
	if (root.code !== 0) return refused("LAND_REPOSITORY_REQUIRED", "The current directory is not inside a Git repository", "Run land from the repository to publish.");
	const repo = resolve(root.out.trim());
	try {
		authorizeSourceAct({ canonicalRoot: repo, privateRoots: [join(repo, "var", "agent-tmp")] }, { path: repo, act: "publish" });
	} catch (error) {
		return refused("SOURCE_ACT_REFUSED", error instanceof Error ? error.message : String(error), "Land only from the canonical companion source root; no commit or publication was attempted.");
	}
	if (request.flags.get("--patch") !== undefined) return landPatchCommand(repo, request);
	const paths = normalizePaths(request.flags.get("--paths"), repo);
	if (!Array.isArray(paths)) return paths;
	const message = request.flags.get("--message");
	if (typeof message !== "string" || message.trim().length === 0) return refused("LAND_MESSAGE_REQUIRED", "land needs a nonempty --message", "Pass the commit message; nothing was published.");
	const owner = authorizedOwner(repo, paths);
	if ("error" in owner) return owner.error;
	for (const path of paths) {
		const staged = git(repo, ["diff", "--cached", "--quiet", "HEAD", "--", `:(literal)${path}`]);
		if (staged.code === 1) return refused("STAGED_OWNED_PATH_REFUSED", `The shared index already contains changes for ${path}`, "Keep foreign or partial staging separate; commit only a clean reserved worktree path.");
		if (staged.code !== 0) return refused("STAGED_INDEX_UNREADABLE", "The shared index could not be checked safely", "Repair the local Git index before landing; no files were changed.");
	}
	const branch = git(repo, ["symbolic-ref", "--quiet", "HEAD"]);
	if (branch.code !== 0 || branch.out.trim() !== "refs/heads/main")
		return refused("LAND_MAIN_REQUIRED", "Land requires the canonical shared main checkout", "Return to shared main without discarding work; no commit was created.");
	const gitDir = git(repo, ["rev-parse", "--absolute-git-dir"]);
	const commonDir = git(repo, ["rev-parse", "--git-common-dir"]);
	if (gitDir.code !== 0 || commonDir.code !== 0 || resolve(repo, commonDir.out.trim()) !== resolve(gitDir.out.trim()))
		return refused("LAND_CANONICAL_REQUIRED", "Land requires the primary shared checkout, not a linked worktree", "Use the canonical shared main checkout; no commit was created.");
	const head = git(repo, ["rev-parse", "--verify", "HEAD^{commit}"]);
	if (head.code !== 0) return refused("BASELINE_UNAVAILABLE", "Local main has no readable commit", "Repair the Git repository before landing.");
	const changed = git(repo, ["diff", "--quiet", "HEAD", "--", ...paths.map((path) => `:(literal)${path}`)]);
	const hasNewPath = paths.some((path) => trackedPaths(repo, path)?.length === 0);
	if (changed.code === 0 && !hasNewPath) return refused("LAND_NO_CHANGES", "The owned paths have no changes to save", "Make the reserved worktree changes before landing.");
	if (changed.code !== 0 && changed.code !== 1) return refused("STAGED_INDEX_UNREADABLE", "The owned changes could not be checked", "Repair the Git index before landing.");
	for (const path of paths) {
		const tracked = trackedPaths(repo, path);
		if (tracked === null) return refused("STAGED_INDEX_UNREADABLE", "Tracked paths could not be read safely", "Repair the Git index before landing.");
		if (tracked.some((entry) => entry !== path))
			return refused("LAND_PATH_INVALID", `Requested path expands to unreserved descendants: ${path}`, "Reserve and name each exact file separately.");
		try {
			if (lstatSync(join(repo, path)).isDirectory())
				return refused("LAND_PATH_INVALID", `Requested path is a directory: ${path}`, "Reserve and name each exact file separately.");
		} catch {
			if (!tracked.includes(path)) return refused("LAND_PATH_UNAVAILABLE", `Requested file does not exist: ${path}`, "Name an existing file or a tracked deletion.");
		}
	}
	const currentOwner = authorizedOwner(repo, paths);
	if ("error" in currentOwner) return currentOwner.error;
	if (currentOwner.owner !== owner.owner) return refused("OWNER_MISMATCH", "The live pane owner changed before saving", "Reacquire the correct identity and reservation; nothing was committed.");
	return commitOwnedPathsAndPublish(repo, { paths, message, owner: owner.owner, base: head.out.trim() });
}
