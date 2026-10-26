import { lstatSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { ownedTmp } from "./kitlib/tmp.ts";
import { run as kitlibRun, type RunResult } from "./kitlib/run.ts";
import { spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { homedir } from "node:os";
import type { CliResult, ParsedCommand } from "./cli.ts";
import { authorizeSourceAct } from "./source-authority.ts";
import { isAbsolute, join, normalize, relative, resolve, sep } from "node:path";
import { convergeRepository, type ConvergeResult } from "./converge.ts";
import { defaultLiveness, defaultRunner, disposalGate } from "./scratch.ts";
import { parseReservationRead } from "./fleet-guard/git.ts";


type GitResult = { code: number; out: string; err: string; interrupted: boolean };

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

function git(repo: string, args: string[], reflogAction?: string): GitResult {
	const run = spawnSync("git", args, { cwd: repo, env: gitEnvironment(reflogAction), encoding: "utf8", timeout: 30_000, maxBuffer: 8 * 1024 * 1024 });
	return { code: run.status ?? 1, out: String(run.stdout ?? ""), err: String(run.stderr ?? ""), interrupted: run.signal !== null || run.error !== undefined };
}

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
const PUSH_CHECK_PATH = ".omp/push-check";
const MAX_PUSH_CHECK_BYTES = 4 * 1024 * 1024;

type PushCheckStatus = "PASS" | "FAIL" | "SKIP" | "UNRUN";
type PushCheckResult = {
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

	const firstLineEnd = baseBlob.bytes.indexOf(0x0a);
	const firstLine = baseBlob.bytes.subarray(0, firstLineEnd < 0 ? baseBlob.bytes.length : firstLineEnd).toString("utf8").replace(/\r$/, "");
	if (!firstLine.startsWith("#!")) return { kind: "unrun", result: pushCheckResult("UNRUN", "check_interpreter_unavailable", sha256) };
	const interpreter = firstLine.slice(2).trim();
	if (!isAbsolute(interpreter) || interpreter.includes(" ") || interpreter.includes("\t"))
		return { kind: "unrun", result: pushCheckResult("UNRUN", "check_interpreter_unavailable", sha256) };
	let executable: string;
	try { executable = realpathSync(interpreter); }
	catch { return { kind: "unrun", result: pushCheckResult("UNRUN", "check_interpreter_unavailable", sha256) }; }
	const versionRun = spawnSync(executable, ["--version"], { cwd: repo, env: gitEnvironment(), encoding: "utf8", timeout: 10_000, maxBuffer: 1024 * 1024 });
	const versionText = `${String(versionRun.stdout ?? "")}\n${String(versionRun.stderr ?? "")}`.trim();
	const version = versionText.split("\n")[0]?.trim() ?? "";
	if (versionRun.error || versionRun.status !== 0 || !version)
		return { kind: "unrun", result: pushCheckResult("UNRUN", "check_interpreter_unavailable", sha256) };
	return { kind: "ready", result: pushCheckResult("UNRUN", "not_run", sha256), script: baseBlob.bytes, executable, version };
}

function runPushCheck(repo: string, base: string, candidate: string): PushCheckResult {
	const plan = preparePushCheck(repo, base, candidate);
	if (plan.kind !== "ready") return { ...plan.result, candidate_sha: candidate };
	const env = gitEnvironment();
	env.OMP_LAND_REPOSITORY = repo;
	env.OMP_LAND_CANDIDATE_SHA = candidate;
	env.OMP_LAND_CHECK_PATH = PUSH_CHECK_PATH;
	env.OMP_LAND_CHECK_SHA256 = plan.result.sha256 ?? "";
	const run = spawnSync(plan.executable, ["-s"], { cwd: repo, env, input: plan.script, encoding: "utf8", maxBuffer: 8 * 1024 * 1024 });
	const common = { ...plan.result, selected_executable: plan.executable, selected_version: plan.version, candidate_sha: candidate, checked_sha: candidate, exit_code: run.status };
	if (run.error || run.signal !== null || run.status === null) return { ...common, status: "UNRUN", reason: "check_execution_unavailable" };
	if (run.status === 0) return { ...common, status: "PASS", reason: undefined };
	if (run.status === 77) return { ...common, status: "SKIP", reason: "check_not_applicable" };
	return { ...common, status: "FAIL", reason: "check_failed" };
}

function pushCheckAdmission(result: PushCheckResult): { allow: boolean; reason?: string } {
	if (result.status === "PASS" || result.status === "SKIP") return { allow: true };
	return { allow: false, reason: result.status === "FAIL" ? "CHECK_FAILED" : "CHECK_UNRUN" };
}

type FullSuiteVerdict = "PASS" | "FAIL" | "UNRUN";
const FULL_SUITE_VERDICT_TIMEOUT_MS = 1_830_000;
const FULL_SUITE_VERDICT_MAX_OUTPUT_BYTES = 1024 * 1024;

type FullSuiteJudge = { root: string; script: string };
type FullSuiteRun = {
	error?: Error;
	signal: NodeJS.Signals | null;
	status: number | null;
	stdout?: string | null;
	stderr?: string | null;
};

function archiveFullSuiteJudge(repo: string, base: string): FullSuiteJudge | null {
	const helpers = ["scripts/gate-ci-only.tsv", "scripts/full-suite-worker.sh", "scripts/full-suite-supervise/package.json",
		"scripts/pysafe.py", "scripts/kitlib_run.py", "scripts/kitlib_proc.py"];
	const present = git(repo, ["ls-tree", "-r", "--name-only", base, "--", ...helpers]);
	if (present.code !== 0 || present.interrupted) return null;
	const gatePaths = ["scripts/full-suite-verdict.sh", "scripts/fresh-gate.sh", "scripts/kitlib-tmp.sh",
		...present.out.trim().split("\n").filter(Boolean)];
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

function fullSuiteVerdictFromRun(run: FullSuiteRun): FullSuiteVerdict {
	const stdout = run.stdout ?? "";
	const stderr = run.stderr ?? "";
	if (!run.error && run.signal === null && run.status === 0 &&
		(stdout.includes("FULL-SUITE: VERDICT PASS ") || stdout.includes("FULL-SUITE: VERDICT REUSED PASS ") ||
			stderr.includes("FULL-SUITE: VERDICT PASS ") || stderr.includes("FULL-SUITE: VERDICT REUSED PASS ")))
		return "PASS";
	if (!run.error && run.signal === null && run.status !== 0 &&
		(stdout.includes("FULL-SUITE: VERDICT FAIL ") || stdout.includes("FULL-SUITE: VERDICT REUSED FAIL ") ||
			stderr.includes("FULL-SUITE: VERDICT FAIL ") || stderr.includes("FULL-SUITE: VERDICT REUSED FAIL ")))
		return "FAIL";
	return "UNRUN";
}
function runFullSuiteVerdict(repo: string, base: string, candidate: string): FullSuiteVerdict {
	const judge = archiveFullSuiteJudge(repo, base);
	if (judge === null) return "UNRUN";
	const configuredTimeoutSeconds = process.env.FULL_SUITE_TIMEOUT_SECS === undefined
		? 1800
		: Number(process.env.FULL_SUITE_TIMEOUT_SECS);
	const timeoutMs = Number.isSafeInteger(configuredTimeoutSeconds) && configuredTimeoutSeconds > 0 && configuredTimeoutSeconds < 2_147_000
		? configuredTimeoutSeconds * 1000 + 30_000
		: FULL_SUITE_VERDICT_TIMEOUT_MS;
	const run = spawnSync("sh", [judge.script, "--repo", repo, "--commit", candidate], {
		cwd: repo, env: gitEnvironment(), encoding: "utf8",
		timeout: timeoutMs, maxBuffer: FULL_SUITE_VERDICT_MAX_OUTPUT_BYTES,
	});
	const verdict = fullSuiteVerdictFromRun(run);
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

function authorizedOwner(repo: string, paths: string[]): { owner: string } | { error: CliResult } {
	const claimed = process.env.AGENT_NAME;
	const selected = paneKey();
	if ("refusal" in selected) return { error: selected.refusal };
	if (!claimed) return { error: refused("OWNER_UNKNOWN", "The agent name claim is required", "Set AGENT_NAME to the identity registered for this pane; no files were changed.") };
	const pane = selected.key;
	const identity = spawnSync("am", ["agents", "resolve-pane", "--project", repo, "--pane", pane, "--json"], { cwd: repo, encoding: "utf8", timeout: 10_000, maxBuffer: 1024 * 1024 });
	if (identity.status !== 0) return { error: refused("OWNER_UNKNOWN", "The pane has no registered owner", "Register the pane with Agent Mail before landing; no files were changed.") };
	let owner: unknown;
	try {
		const parsed: unknown = JSON.parse(String(identity.stdout));
		owner = typeof parsed === "object" && parsed !== null && "agent_name" in parsed ? parsed.agent_name : null;
	} catch { owner = null; }
	if (typeof owner !== "string" || owner.length === 0) return { error: refused("OWNER_UNKNOWN", "The pane has no registered owner", "Register the pane with Agent Mail before landing.") };
	if (owner !== claimed) return { error: refused("OWNER_MISMATCH", "AGENT_NAME does not match the live pane owner", "Use the identity registered for this pane; no files were changed.") };
	const active = spawnSync("am", ["robot", "reservations", "--project", repo, "--agent", owner, "--json"], { cwd: repo, encoding: "utf8", timeout: 10_000, maxBuffer: 2 * 1024 * 1024 });
	if (active.status !== 0) return { error: refused("RESERVATION_UNAVAILABLE", "Active file reservations could not be read", "Restore the Agent Mail reservation service; no files were changed.") };
	const read = parseReservationRead(String(active.stdout));
	if ("why" in read) return { error: refused("RESERVATION_UNREADABLE", `The current reservation read could not be verified: ${read.why}`, "Repair the Agent Mail response and retry; no files were changed.") };
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

function patchConvergence(repo: string, state: "FAST_FORWARD" | "REFUSED", reason: string | null, pushed: boolean, base: string, candidate: string | null, remoteAfter: string | null, publishedCommits: number, elapsedS: number): ConvergeResult {
	// Patch mode never integrates local main, so applied stays false: the only
	// mutation is the exact candidate fast-forwarding origin/main. old/up name
	// the fetched origin/main the candidate was reconstructed on.
	return {
		repo, state, reason, applied: false, pushed, conflicts: [], elapsed_s: elapsedS,
		old: base, up: base, ...(candidate ? { new_head: candidate } : {}),
		published_commits: publishedCommits, ...(remoteAfter ? { remote_after: remoteAfter } : {}),
	};
}


async function landPatchCommand(repo: string, request: ParsedCommand): Promise<CliResult> {
	const started = performance.now();
	const elapsed = (): number => Math.round(performance.now() - started) / 1000;
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
	const commit = git(scratch, ["commit", "-m", message]);
	if (commit.code !== 0 || commit.interrupted) {
		cleanup();
		const check = checkPreflight.kind === "skip" ? checkPreflight.result : pushCheckResult("UNRUN", "commit_refused", checkPreflight.result.sha256);
		const phases = landPhaseEvidence(repo, null, false, undefined, "NOT_APPLIED");
		return {
			code: commit.interrupted ? 77 : 1,
			data: { overall: commit.interrupted ? "UNRUN" : "REFUSED", commit: null, owner: owner.owner, paths, base, localMain, check, phases },
			errors: [{ code: commit.interrupted ? "LAND_COMMIT_INTERRUPTED" : "COMMIT_CREATION_REFUSED", message: commit.interrupted ? "Git saved no verifiable candidate before the commit command ended" : `Git refused the reconstructed candidate: ${commit.err.trim()}`, remediation: "Inspect the shared main and hooks before retrying; no publication was attempted." }],
			verification: commit.interrupted ? "UNVERIFIED" : "NOT_RUN",
		};
	}
	const candidateRef = git(scratch, ["rev-parse", "--verify", "HEAD"]);
	if (candidateRef.code !== 0) {
		cleanup();
		return patchUnrun(repo, "LAND_CONSTRUCTION_UNVERIFIED", "The reconstructed candidate has no readable commit", "Repair the local repository and retry; nothing was published.", owner.owner, paths, base, checkPreflight.result.sha256);
	}
	const candidate = candidateRef.out.trim();
	// Actual-parent/custody qualification (ompkit-rhy9.10): the reconstructed
	// candidate carries the caller bytes by construction, so qualification
	// pins the actual parent, rejects superseded restores, admits only owned
	// paths, and re-proves custody before any check or publication.
	const patchQualifiedBlobs: Record<string, WorktreeBlob> = {};
	for (const path of paths) {
		const entry = treeBlob(repo, candidate, path);
		if (entry === null) {
			cleanup();
			return patchUnrun(repo, "LAND_CANDIDATE_UNREADABLE", `The reconstructed candidate tree could not be read for ${path}`, "Repair the local repository and retry; nothing was published.", owner.owner, paths, base, checkPreflight.result.sha256);
		}
		patchQualifiedBlobs[path] = entry;
	}
	const patchQualified = qualifyPublicationCandidate(repo, {
		candidate, base, paths, owner: owner.owner,
		publicationRef: LAND_PUBLICATION_REF, qualifiedBlobs: patchQualifiedBlobs,
	});
	if ("refusal" in patchQualified) {
		cleanup();
		const phases = landPhaseEvidence(repo, candidate, false);
		return {
			code: 1,
			data: { overall: "REFUSED", commit: candidate, candidate_sha: candidate, pushed_sha: null, owner: owner.owner, paths, base, localMain, check: patchQualified.guardCheck, phases },
			errors: patchQualified.refusal.errors,
			verification: "PERFORMED",
		};
	}
	const checkResult = runPushCheck(repo, base, candidate);
	const admission = pushCheckAdmission(checkResult);
	if (!admission.allow) {
		cleanup();
		const remoteAfter = observedRemoteMain(repo);
		if (remoteAfter && remoteAfter !== base) git(repo, ["fetch", "origin", "refs/heads/main"]);
		const convergence = patchConvergence(repo, "REFUSED", checkResult.status === "FAIL" ? "CHECK_FAILED" : "CHECK_UNRUN", false, base, candidate, remoteAfter, 0, elapsed());
		const phases = landPhaseEvidence(repo, candidate, true, convergence);
		return {
			code: 1,
			data: { overall: "REFUSED", commit: candidate, candidate_sha: candidate, pushed_sha: null, owner: owner.owner, paths, base, localMain, convergence, check: { ...checkResult, pushed_sha: null }, phases },
			errors: [checkResult.status === "FAIL"
				? { code: "LAND_CHECK_FAILED", message: "The registered repo check failed for the exact reconstructed candidate", remediation: "Repair the check or candidate; it was not published." }
				: { code: "LAND_CHECK_UNRUN", message: `The registered repo check did not complete: ${checkResult.reason ?? "unknown"}`, remediation: "Restore the registered check tooling and retry; no publication was authorized." }],
			verification: "PERFORMED",
		};
	}
	const fullSuiteVerdict = runFullSuiteVerdict(repo, base, candidate);
	if (fullSuiteVerdict !== "PASS") {
		cleanup();
		const remoteAfter = observedRemoteMain(repo);
		if (remoteAfter && remoteAfter !== base) git(repo, ["fetch", "origin", "refs/heads/main"]);
		const reason = fullSuiteVerdict === "FAIL" ? "CHECK_FAILED" : "CHECK_UNRUN";
		const convergence = patchConvergence(repo, "REFUSED", reason, false, base, candidate, remoteAfter, 0, elapsed());
		const phases = landPhaseEvidence(repo, candidate, true, convergence);
		return {
			code: fullSuiteVerdict === "UNRUN" ? 77 : 1,
			data: { overall: fullSuiteVerdict === "UNRUN" ? "UNRUN" : "REFUSED", commit: candidate, candidate_sha: candidate, pushed_sha: null, owner: owner.owner, paths, base, localMain, convergence, check: { ...checkResult, pushed_sha: null }, phases },
			errors: [fullSuiteError(fullSuiteVerdict)],
			verification: fullSuiteVerdict === "UNRUN" ? "UNVERIFIED" : "PERFORMED",
		};
	}
	const observed = observedRemoteMain(repo);
	if (observed === null) {
		cleanup();
		return patchUnrun(repo, "LAND_ORIGIN_UNVERIFIED", "Fresh origin/main could not be re-read before publication", "Restore origin reachability and retry; nothing was published.", owner.owner, paths, base, checkResult.sha256);
	}
	if (observed !== base) {
		cleanup();
		// Materialize the moved origin so phase evidence classifies the
		// candidate against the actual publication head instead of UNKNOWN.
		git(repo, ["fetch", "origin", "refs/heads/main"]);
		const convergence = patchConvergence(repo, "REFUSED", "ORIGIN_MOVED", false, base, candidate, observed, 0, elapsed());
		const phases = landPhaseEvidence(repo, candidate, true, convergence);
		return {
			code: 1,
			data: { overall: "REFUSED", commit: candidate, candidate_sha: candidate, pushed_sha: null, owner: owner.owner, paths, base, localMain, convergence, check: { ...checkResult, pushed_sha: null }, phases },
			errors: [{ code: "LAND_ORIGIN_MOVED", message: "origin/main moved during patch construction; the exact checked candidate was refused without retry or force", remediation: "Reconcile with current origin/main and run land again so the new candidate is checked." }],
			verification: "PERFORMED",
		};
	}
	const push = git(repo, ["push", "origin", `${candidate}:refs/heads/main`]);
	if (push.interrupted) {
		cleanup();
		const phases = landPhaseEvidence(repo, candidate, true);
		return {
			code: 77,
			data: { overall: "UNRUN", commit: candidate, candidate_sha: candidate, pushed_sha: null, owner: owner.owner, paths, base, localMain, check: checkResult, phases },
			errors: [{ code: "LAND_PUBLICATION_UNVERIFIED", message: "The push command did not finish; publication could not be verified", remediation: "Inspect origin/main before retrying; no force-push or fallback was attempted." }],
			verification: "UNVERIFIED",
		};
	}
	const after = observedRemoteMain(repo);
	cleanup();
	const published = push.code === 0 && after === candidate;
	const pushedCheck = { ...checkResult, pushed_sha: published ? candidate : null };
	const convergence = published
		? patchConvergence(repo, "FAST_FORWARD", null, true, base, candidate, after, 1, elapsed())
		: patchConvergence(repo, "REFUSED", after === base ? "PUSH_FAILED" : "PUSH_REJECTED", false, base, candidate, after, 0, elapsed());
	if (after && after !== base && after !== candidate) git(repo, ["fetch", "origin", "refs/heads/main"]);
	const phases = landPhaseEvidence(repo, candidate, true, convergence);
	if (published) {
		return {
			code: 0,
			data: { overall: "PUSHED", commit: candidate, candidate_sha: candidate, pushed_sha: candidate, owner: owner.owner, paths, base, localMain, convergence, check: pushedCheck, phases },
			verification: "PERFORMED",
		};
	}
	if (after === base) {
		return {
			code: 1,
			data: { overall: "REFUSED", commit: candidate, candidate_sha: candidate, pushed_sha: null, owner: owner.owner, paths, base, localMain, convergence, check: pushedCheck, phases },
			errors: [{ code: "LAND_PUBLICATION_REFUSED", message: `The exact checked candidate was not published: ${push.err.trim().slice(-300) || "the push was rejected without origin movement"}`, remediation: "Preserve the candidate and resolve the typed refusal before another landing." }],
			verification: "PERFORMED",
		};
	}
	return {
		code: 1,
		data: { overall: "REFUSED", commit: candidate, candidate_sha: candidate, pushed_sha: null, owner: owner.owner, paths, base, localMain, convergence, check: pushedCheck, phases },
		errors: [{ code: "LAND_PUSH_REJECTED", message: "origin/main advanced after candidate check; the exact checked candidate was refused without retry or force", remediation: "Reconcile with current origin/main and run land again so the new candidate is checked." }],
		verification: "PERFORMED",
	};
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
	let checkPreflight = preparePushCheck(repo, head.out.trim());
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
			data: { overall: "UNRUN", commit: null, owner: owner.owner, paths, base: head.out.trim(), check: checkPreflight.result, phases },
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
	// A peer may advance HEAD from a post-commit hook before Git returns. Attribute
	// our save through a per-call native reflog action, never through the later tip.
	const action = `omp-kit-land-${randomUUID()}`;
	const commit = git(repo, ["-c", "core.logAllRefUpdates=true", "commit", "--only", "-m", message, "--", ...paths.map((path) => `:(literal)${path}`)], action);
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
			data: { overall: refusedCommit ? "REFUSED" : "UNRUN", commit: null, owner: owner.owner, paths, base: head.out.trim(), check, phases },
			errors: [{ code: refusedCommit ? "COMMIT_CREATION_REFUSED" : "LAND_COMMIT_UNVERIFIED", message: refusedCommit ? `Git refused the candidate commit: ${commit.err.trim()}` : "The commit operation ended without unambiguous save attribution", remediation: "Inspect the shared main and reflog before retrying; no publication was attempted." }],
			verification: refusedCommit ? "NOT_RUN" : "UNVERIFIED",
		};
	}
	if (commit.code !== 0 || commit.interrupted) {
		const check = pushCheckResult("UNRUN", "commit_interrupted", checkPreflight.result.sha256);
		const phases = landPhaseEvidence(repo, sha, false);
		return { code: 77, data: { overall: "UNRUN", commit: sha, owner: owner.owner, paths, base: head.out.trim(), check, phases }, errors: [{ code: "LAND_COMMIT_INTERRUPTED", message: "Git saved the owned commit, but the commit command did not finish successfully", remediation: "Inspect the interrupted hook and saved commit before publication; no hooks were bypassed and no rollback was attempted." }], verification: "UNVERIFIED" };
	}
	// Actual-parent/custody qualification (ompkit-rhy9.10): the constructed
	// candidate must be parented on exactly the qualified base, carry exactly
	// the qualified bytes without restoring superseded history, touch only
	// owned paths, and hold current custody. Anything else publishes nothing.
	const qualified = qualifyPublicationCandidate(repo, {
		candidate: sha, base: head.out.trim(), paths, owner: owner.owner,
		publicationRef: LAND_PUBLICATION_REF, qualifiedBlobs,
	});
	if ("refusal" in qualified) {
		const phases = landPhaseEvidence(repo, sha, false);
		return {
			code: 1,
			data: { overall: "REFUSED", commit: sha, candidate_sha: sha, pushed_sha: null, owner: owner.owner, paths, base: head.out.trim(), check: qualified.guardCheck, phases },
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
		const convergence = convergeRepository({
			repo, apply: true, push: true,
			beforePush: (candidateSha, baseSha) => {
				checkedCandidateSha = candidateSha;
				checkResult = runPushCheck(repo, baseSha, candidateSha);
				const admission = pushCheckAdmission(checkResult);
				if (!admission.allow) return admission;
				fullSuiteVerdict = runFullSuiteVerdict(repo, baseSha, candidateSha);
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
		const checkUnavailable = checkResult.status === "UNRUN" && checkResult.reason !== "not_run";
		const fullSuiteUnavailable = fullSuiteVerdict === "UNRUN";
		const checkAllowed = checkResult.status === "PASS" || checkResult.status === "SKIP";
		const published = convergence.pushed && pushedSha === candidateSha && checkAllowed && fullSuiteVerdict === "PASS";
		const overall = published ? "PUSHED" : checkUnavailable || fullSuiteUnavailable ? "UNRUN" : "REFUSED";
		const phases = landPhaseEvidence(repo, sha, convergenceStarted, convergence);
		const suiteFailure = fullSuiteVerdict === "FAIL" || fullSuiteVerdict === "UNRUN" ? fullSuiteError(fullSuiteVerdict) : undefined;
		const failure = published ? undefined : suiteFailure ?? (checkResult.status === "FAIL"
			? { code: "LAND_CHECK_FAILED", message: "The registered repo check failed for the exact publication candidate", remediation: "Repair the check or candidate; it was not published." }
			: checkUnavailable
				? { code: "LAND_CHECK_UNRUN", message: `The registered repo check did not complete: ${checkResult.reason ?? "unknown"}`, remediation: "Restore the registered check tooling and retry; no publication was authorized." }
				: convergence.reason === "PUSH_REJECTED"
					? { code: "LAND_PUSH_REJECTED", message: "origin/main advanced after candidate check; the exact checked candidate was refused without retry or force", remediation: "Reconcile with current origin/main and run land again so the new candidate is checked." }
					: { code: "LAND_PUBLICATION_REFUSED", message: `The exact checked candidate was not published: ${convergence.reason ?? "publication was not verified"}`, remediation: "Preserve the candidate and resolve the typed refusal before another landing." });
		return {
			code: published ? 0 : overall === "UNRUN" ? 77 : 1,
			data: { overall, commit: sha, candidate_sha: candidateSha, pushed_sha: pushedSha, owner: owner.owner, paths, base: head.out.trim(), localMain: git(repo, ["rev-parse", "refs/heads/main"]).out.trim(), convergence, check: checkResult, phases },
			...(failure ? { errors: [failure] } : {}),
			verification: overall === "UNRUN" ? "UNVERIFIED" : "PERFORMED",
		};
	} catch (error) {
		const phases = landPhaseEvidence(repo, sha, convergenceStarted, convergenceResult);
		const check = { ...checkResult, pushed_sha: null };
		return { code: 77, data: { overall: "UNRUN", commit: sha, candidate_sha: checkedCandidateSha ?? sha, pushed_sha: null, owner: owner.owner, paths, base: head.out.trim(), check, phases }, errors: [{ code: "LAND_PUBLICATION_UNVERIFIED", message: `The candidate was saved but publication could not be verified: ${error instanceof Error ? error.message : String(error)}`, remediation: "Inspect local main and origin/main before retrying; no force-push or fallback was attempted." }], verification: "UNVERIFIED" };
	}
}
