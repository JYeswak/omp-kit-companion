import { lstatSync, realpathSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { isAbsolute, join, normalize, relative, resolve, sep } from "node:path";
import type { CliResult, ParsedCommand } from "./cli.ts";
import { convergeRepository, type ConvergeResult } from "./converge.ts";


type GitResult = { code: number; out: string; err: string; interrupted: boolean };
type Reservation = { agent: unknown; path: string; exclusive: boolean; remaining_seconds: number };

function gitEnvironment(reflogAction?: string): NodeJS.ProcessEnv {
	const env: NodeJS.ProcessEnv = {};
	for (const [key, value] of Object.entries(process.env)) {
		if (key.startsWith("GIT_") && key !== "GIT_TERMINAL_PROMPT") continue;
		env[key] = value;
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

function trackedPaths(repo: string, path: string): string[] | null {
	const result = git(repo, ["ls-files", "-z", "--", `:(literal)${path}`]);
	return result.code === 0 ? result.out.split("\0").filter((entry) => entry.length > 0) : null;
}

function refused(code: string, message: string, remediation: string): CliResult {
	return { code: 1, data: { overall: "REFUSED", check: pushCheckResult("UNRUN", "not_started") }, errors: [{ code, message, remediation }], verification: "NOT_RUN" };
}

function parseReservations(stdout: string): Reservation[] | null {
	try {
		const parsed: unknown = JSON.parse(stdout);
		if (typeof parsed !== "object" || parsed === null || !("my_reservations" in parsed) || !("reservation_read_attestation" in parsed)) return null;
		const attestation = parsed.reservation_read_attestation;
		if (typeof attestation !== "object" || attestation === null || !("state" in attestation) || attestation.state !== "current" ||
			!("database_matches_server" in attestation) || attestation.database_matches_server !== true ||
			!("storage_root_matches_server" in attestation) || attestation.storage_root_matches_server !== true ||
			!Array.isArray(parsed.my_reservations)) return null;
		const rows: Reservation[] = [];
		for (const row of parsed.my_reservations) {
			if (typeof row !== "object" || row === null || !("agent" in row) || !("path" in row) || !("exclusive" in row) ||
				!("remaining_seconds" in row) || typeof row.path !== "string" || typeof row.exclusive !== "boolean" ||
				typeof row.remaining_seconds !== "number") return null;
			rows.push({ agent: row.agent, path: row.path, exclusive: row.exclusive, remaining_seconds: row.remaining_seconds });
		}
		return rows;
	} catch {
		return null;
	}
}

type PaneKey = { key: string } | { refusal: CliResult };

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
	const rows = parseReservations(String(active.stdout));
	if (rows === null) return { error: refused("RESERVATION_UNREADABLE", "The current reservation read could not be verified", "Repair the Agent Mail response and retry; no files were changed.") };
	const held = new Set<string>();
	for (const row of rows) {
		if (row.agent === owner && row.exclusive === true && row.remaining_seconds > 0 && typeof row.path === "string") held.add(row.path);
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

export function landCommand(request: ParsedCommand): CliResult {
	if (!request.flags.has("--apply")) return refused("LAND_APPLY_REQUIRED", "land is a mutation and requires --apply", "Review the exact owner, paths, base and candidate, then pass --apply --yes.");
	const root = git(process.cwd(), ["rev-parse", "--show-toplevel"]);
	if (root.code !== 0) return refused("LAND_REPOSITORY_REQUIRED", "The current directory is not inside a Git repository", "Run land from the repository to publish.");
	const repo = resolve(root.out.trim());
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
	let convergenceStarted = false;
	let convergenceResult: ConvergeResult | undefined;
	let checkResult = checkPreflight.kind === "skip"
		? checkPreflight.result
		: pushCheckResult("UNRUN", "not_run", checkPreflight.result.sha256);
	let checkedCandidateSha: string | null = null;
	try {
		convergenceStarted = true;
		const convergence = convergeRepository({
			repo, apply: true, push: true,
			beforePush: (candidateSha, baseSha) => {
				checkedCandidateSha = candidateSha;
				checkResult = runPushCheck(repo, baseSha, candidateSha);
				return pushCheckAdmission(checkResult);
			},
		});
		convergenceResult = convergence;
		const candidateSha = checkResult.candidate_sha ?? checkedCandidateSha ?? convergence.new_head ?? sha;
		const pushedSha = convergence.pushed ? convergence.remote_after ?? null : null;
		checkResult = { ...checkResult, pushed_sha: pushedSha };
		const checkUnavailable = checkResult.status === "UNRUN" && checkResult.reason !== "not_run";
		const checkAllowed = checkResult.status === "PASS" || checkResult.status === "SKIP";
		const published = convergence.pushed && pushedSha === candidateSha && checkAllowed;
		const overall = published ? "PUSHED" : checkUnavailable ? "UNRUN" : "REFUSED";
		const phases = landPhaseEvidence(repo, sha, convergenceStarted, convergence);
		const failure = published ? undefined : checkResult.status === "FAIL"
			? { code: "LAND_CHECK_FAILED", message: "The registered repo check failed for the exact publication candidate", remediation: "Repair the check or candidate; it was not published." }
			: checkUnavailable
				? { code: "LAND_CHECK_UNRUN", message: `The registered repo check did not complete: ${checkResult.reason ?? "unknown"}`, remediation: "Restore the registered check tooling and retry; no publication was authorized." }
				: convergence.reason === "PUSH_REJECTED"
					? { code: "LAND_PUSH_REJECTED", message: "origin/main advanced after candidate check; the exact checked candidate was refused without retry or force", remediation: "Reconcile with current origin/main and run land again so the new candidate is checked." }
					: { code: "LAND_PUBLICATION_REFUSED", message: `The exact checked candidate was not published: ${convergence.reason ?? "publication was not verified"}`, remediation: "Preserve the candidate and resolve the typed refusal before another landing." };
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
