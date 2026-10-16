import { lstatSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { isAbsolute, join, normalize, relative, resolve, sep } from "node:path";
import type { CliResult, ParsedCommand } from "./cli.ts";
import { convergeRepository } from "./converge.ts";


type GitResult = { code: number; out: string; err: string; interrupted: boolean };
type Reservation = { agent: unknown; path: string; exclusive: boolean; remaining_seconds: number };

function git(repo: string, args: string[], reflogAction?: string): GitResult {
	const env: NodeJS.ProcessEnv = {};
	for (const [key, value] of Object.entries(process.env)) {
		if (key.startsWith("GIT_") && key !== "GIT_TERMINAL_PROMPT") continue;
		env[key] = value;
	}
	env.GIT_TERMINAL_PROMPT = "0";
	if (reflogAction) env.GIT_REFLOG_ACTION = reflogAction;
	const run = spawnSync("git", args, { cwd: repo, env, encoding: "utf8", timeout: 30_000, maxBuffer: 8 * 1024 * 1024 });
	return { code: run.status ?? 1, out: String(run.stdout ?? ""), err: String(run.stderr ?? ""), interrupted: run.signal !== null || run.error !== undefined };
}

function trackedPaths(repo: string, path: string): string[] | null {
	const result = git(repo, ["ls-files", "-z", "--", `:(literal)${path}`]);
	return result.code === 0 ? result.out.split("\0").filter((entry) => entry.length > 0) : null;
}

function refused(code: string, message: string, remediation: string): CliResult {
	return { code: 2, data: { overall: "NOT_RUN" }, errors: [{ code, message, remediation }], verification: "NOT_RUN" };
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
	if (process.env.HERDR_PANE_ID && process.env.HERDR_PANE_ID.length > 0) return { refusal: refused("OWNER_UNAVAILABLE", "Land from a Herdr pane needs its own qualified ownership branch", "Herdr callers must not borrow an outer Tern or tmux key; no files were changed.") };
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
	if (!sha) {
		if (commit.code !== 0 && !commit.interrupted && reflog.code === 0 && matches.length === 0)
			return refused("COMMIT_CREATION_FAILED", `Git did not save the owned paths: ${commit.err.trim()}`, "Inspect the worktree and owned index entries; nothing was published.");
		return { code: 2, data: { overall: "SAVE_UNCERTAIN", commit: null, owner: owner.owner, paths, base: head.out.trim() }, errors: [{ code: "LAND_COMMIT_UNVERIFIED", message: "The commit operation ended without unambiguous native save attribution; work may already be saved", remediation: "Inspect shared main and its reflog before attempting publication; no rollback or publication was attempted." }], verification: "PERFORMED" };
	}
	if (commit.code !== 0 || commit.interrupted)
		return { code: 2, data: { overall: "SAVED_NOT_PUBLISHED", commit: sha, owner: owner.owner, paths, base: head.out.trim() }, errors: [{ code: "LAND_COMMIT_INTERRUPTED", message: "Git saved the owned commit, but the commit command did not finish successfully", remediation: "Inspect the interrupted hook and saved commit before publication; no hooks were bypassed and no rollback was attempted." }], verification: "PERFORMED" };
	try {
		const convergence = convergeRepository({ repo, apply: true, push: true });
		const fetched = convergence.pushed ? git(repo, ["fetch", "--no-tags", "origin", "refs/heads/main"]) : null;
		const remote = git(repo, ["rev-parse", "--verify", "FETCH_HEAD^{commit}"]);
		const reachable = fetched?.code === 0 && remote.code === 0 && git(repo, ["merge-base", "--is-ancestor", sha, remote.out.trim()]).code === 0;
		const published = convergence.pushed && reachable;
		return {
			code: published ? 0 : 2,
			data: { overall: published ? "PUSHED" : "SAVED_NOT_PUBLISHED", commit: sha, owner: owner.owner, paths, base: head.out.trim(), localMain: git(repo, ["rev-parse", "refs/heads/main"]).out.trim(), convergence },
			...(published ? {} : { errors: [{ code: "LAND_PUBLICATION_REFUSED", message: `Owned commit is saved on shared main; publication was not verified: ${convergence.reason ?? "landed commit not reachable from fetched origin/main"}`, remediation: "Preserve the saved commit and resolve the convergence refusal before publishing." }] }),
			verification: "PERFORMED",
		};
	} catch (error) {
		return { code: 2, data: { overall: "SAVED_NOT_PUBLISHED", commit: sha, owner: owner.owner, paths, base: head.out.trim() }, errors: [{ code: "LAND_PUBLICATION_FAILED", message: `Owned commit is saved; convergence failed: ${error instanceof Error ? error.message : String(error)}`, remediation: "Inspect shared main and origin before publishing; no rollback of saved work was attempted." }], verification: "PERFORMED" };
	}
}
