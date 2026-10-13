import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { isAbsolute, join, normalize, relative, resolve, sep } from "node:path";
import type { CliResult, ParsedCommand } from "./cli.ts";


type GitResult = { code: number; out: string; err: string };
type Reservation = { agent: unknown; path: string; exclusive: boolean; remaining_seconds: number };

function git(repo: string, args: string[], indexFile?: string): GitResult {
	const env: NodeJS.ProcessEnv = {};
	for (const [key, value] of Object.entries(process.env)) {
		if (key.startsWith("GIT_") && key !== "GIT_TERMINAL_PROMPT") continue;
		env[key] = value;
	}
	env.GIT_TERMINAL_PROMPT = "0";
	if (indexFile) env.GIT_INDEX_FILE = indexFile;
	const run = spawnSync("git", args, { cwd: repo, env, encoding: "utf8", timeout: 30_000, maxBuffer: 8 * 1024 * 1024 });
	return { code: run.status ?? 1, out: String(run.stdout ?? ""), err: String(run.stderr ?? "") };
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

function authorizedOwner(repo: string, paths: string[]): { owner: string } | { error: CliResult } {
	const pane = process.env.TMUX_PANE;
	const claimed = process.env.AGENT_NAME;
	if (!pane || !claimed) return { error: refused("OWNER_UNKNOWN", "A live pane identity is required", "Run land inside the registered tmux agent pane; no files were changed.") };
	const identity = spawnSync("am", ["agents", "resolve-pane", "--project", repo, "--pane", pane, "--json"], { cwd: repo, encoding: "utf8", timeout: 10_000, maxBuffer: 1024 * 1024 });
	if (identity.status !== 0) return { error: refused("OWNER_UNAVAILABLE", "The live pane owner could not be resolved", "Restore Agent Mail identity resolution; no files were changed.") };
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

function remoteMain(repo: string): string | null {
	const result = git(repo, ["ls-remote", "--refs", "origin", "refs/heads/main"]);
	if (result.code !== 0) return null;
	const line = result.out.trim().split("\n").find((row) => row.endsWith("\trefs/heads/main"));
	return line?.split("\t")[0] ?? null;
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
	const fetch = git(repo, ["fetch", "--no-tags", "origin", "refs/heads/main"]);
	if (fetch.code !== 0) return refused("BASELINE_UNAVAILABLE", "Fresh origin/main could not be fetched", "Restore origin access and retry; no files were changed.");
	const baseResult = git(repo, ["rev-parse", "--verify", "FETCH_HEAD^{commit}"]);
	const headResult = git(repo, ["rev-parse", "--verify", "HEAD^{commit}"]);
	if (baseResult.code !== 0 || headResult.code !== 0) return refused("BASELINE_UNAVAILABLE", "A local HEAD or fetched origin/main commit is unavailable", "Repair the Git repository before landing.");
	const base = baseResult.out.trim();
	const head = headResult.out.trim();
	if (head !== base) return refused("BASELINE_DIVERGED", "Local HEAD is not the fetched origin/main commit", "Reconcile the checkout with origin/main before landing.");
	const remoteBefore = remoteMain(repo);
	if (remoteBefore !== base) return refused("BASELINE_DRIFT", "origin/main changed during the fetch", "Retry from the current origin/main; no files were published.");
	const scratchRoot = join(repo, "var", "agent-tmp");
	mkdirSync(scratchRoot, { recursive: true });
	const scratch = mkdtempSync(join(scratchRoot, `omp-kit-land.${process.pid}.`));
	writeFileSync(join(scratch, ".owner"), `pid=${process.pid} label=omp-kit-land repo=${repo} created=${new Date().toISOString()}\n`);
	const indexFile = join(scratch, "index");
	try {
		const readTree = git(repo, ["read-tree", base], indexFile);
		if (readTree.code !== 0) return refused("PRIVATE_INDEX_FAILED", "Could not initialize the private candidate index", "Repair Git object access; shared index and worktree were not changed.");
		for (const path of paths) {
			const add = git(repo, ["add", "--all", "--force", "--", `:(literal)${path}`], indexFile);
			if (add.code !== 0) return refused("LAND_PATH_UNAVAILABLE", `Could not stage reserved path ${path} in the private index`, "Ensure the exact path exists in the worktree or is tracked for deletion.");
		}
		const tree = git(repo, ["write-tree"], indexFile);
		if (tree.code !== 0) return refused("PRIVATE_INDEX_FAILED", "Could not write the candidate tree", "Repair Git object access; shared index and worktree were not changed.");
		const changed = git(repo, ["diff-tree", "--no-commit-id", "--name-only", "-r", base, tree.out.trim()]);
		if (changed.code !== 0) return refused("CANDIDATE_SCOPE_UNVERIFIED", "Could not verify the candidate path scope", "Retry after repairing Git object access.");
		const changedPaths = changed.out.trim().length ? changed.out.trim().split("\n") : [];
		if (changedPaths.some((path) => !paths.includes(path))) return refused("CANDIDATE_SCOPE_REFUSED", "The private candidate contains a path outside the requested reservation set", "Use exact file paths; no commit was created.");
		if (changedPaths.length === 0) return refused("LAND_NO_CHANGES", "The requested paths produce no candidate changes", "Make the reserved worktree changes before landing.");

		const remoteAtBuild = remoteMain(repo);
		if (remoteAtBuild !== base) return refused("BASELINE_DRIFT", "origin/main advanced while the candidate was being built", "Retry from the current origin/main; no files were published.");
		const currentOwner = authorizedOwner(repo, paths);
		if ("error" in currentOwner) return currentOwner.error;
		if (currentOwner.owner !== owner.owner) return refused("OWNER_MISMATCH", "The live pane owner changed before publication", "Reacquire the correct pane identity and reservation; nothing was pushed.");
		const commit = git(repo, ["commit-tree", tree.out.trim(), "-p", base, "-m", message]);
		if (commit.code !== 0) return refused("COMMIT_CREATION_FAILED", "Git could not create the candidate commit", "Check repository author configuration; no files were published.");
		const sha = commit.out.trim();
		const push = git(repo, ["push", "origin", `${sha}:refs/heads/main`]);
		if (push.code !== 0) return refused("PUSH_REFUSED", "origin/main rejected the candidate push; no force-push was attempted", "Fetch the new origin/main and rebuild the candidate.");
		return { code: 0, data: { overall: "PUSHED", commit: sha, owner: owner.owner, paths, base }, verification: "PERFORMED" };
	} finally {
		rmSync(scratch, { recursive: true, force: true });
	}
}
