import { realpathSync } from "node:fs";
import { join, resolve } from "node:path";
import type { CliResult, ParsedCommand } from "./cli.ts";
import { privateLock, type PrivateLock } from "./kitlib/lock.ts";
import { run } from "./kitlib/run.ts";

export type CheckoutLanding = {
	overall: "PUSHED" | "REFUSED";
	paths: string[];
	base: string | null;
	commit: string | null;
	commits: string[];
	applied: boolean;
	published: boolean;
	reason?: string;
	text: string;
};

class LandingError extends Error {
	constructor(readonly code: string, message: string) { super(message); }
}

function gitEnvironment(): Record<string, string> {
	const env: Record<string, string> = {};
	for (const [key, value] of Object.entries(process.env)) {
		if (!key.startsWith("GIT_") && value !== undefined) env[key] = value;
	}
	return { ...env, GIT_TERMINAL_PROMPT: "0", GIT_OPTIONAL_LOCKS: "0" };
}

/** Only committed worker changes are admitted: immutable Git objects are the captured delta.
 * The lock serializes this verb, not arbitrary editors or Git clients; main's existing custody
 * and commit/publication hooks remain authoritative. No rollback may discard peer bytes. */
export async function landCheckout(input: { repo: string; checkout: string; base: string }): Promise<CheckoutLanding> {
	const result: CheckoutLanding = { overall: "REFUSED", paths: [], base: null, commit: null, commits: [], applied: false, published: false, text: "" };
	let lock: PrivateLock | undefined;
	const env = gitEnvironment();
	async function git(cwd: string, args: string[], stdin?: Uint8Array | string, publication = false): Promise<Buffer> {
		const output = await run(["git", "--literal-pathspecs", ...args], {
			cwd, env, deadline_s: publication ? 2400 : 120, max_output_bytes: 16 * 1024 * 1024,
			...(stdin === undefined ? {} : { stdin }), ...(lock === undefined ? {} : { inherit_fds: [lock.fd] }),
		});
		if (output.rc !== 0 || output.timed_out || output.killed || output.truncated) {
			throw new LandingError("GIT_FAILED", `git ${args.join(" ")}: exit=${output.rc} timed_out=${output.timed_out} truncated=${output.truncated}\n${Buffer.from(output.stderr).toString()}${Buffer.from(output.stdout).toString()}`);
		}
		return Buffer.from(output.stdout);
	}
	const text = async (cwd: string, args: string[]) => (await git(cwd, args)).toString().trim();
	const names = (bytes: Buffer) => {
		try { return new TextDecoder("utf-8", { fatal: true }).decode(bytes).split("\0").filter(Boolean); }
		catch { throw new LandingError("INVALID_PATH_ENCODING", "Git paths must be valid UTF-8; no patch applied"); }
	};
	try {
		const repo = realpathSync(input.repo), worker = realpathSync(input.checkout);
		if (repo === worker) throw new LandingError("SAME_CHECKOUT", "Worker and shared checkout must be different directories");
		for (const path of [repo, worker]) {
			if (realpathSync(await text(path, ["rev-parse", "--show-toplevel"])) !== path)
				throw new LandingError("NOT_REPO_ROOT", `Use the Git checkout root: ${path}`);
		}
		const gitDir = realpathSync(await text(repo, ["rev-parse", "--path-format=absolute", "--git-common-dir"]));
		lock = await privateLock({ namespace: "ovnfs-land", path: gitDir }, {
			state_dir: join(gitDir, "ovnfs-land-locks"), deadline_s: 120, inherit: true,
		});
		if (await text(repo, ["symbolic-ref", "HEAD"]) !== "refs/heads/main")
			throw new LandingError("NOT_MAIN", "Shared checkout must have main checked out");
		const parent = await text(repo, ["rev-parse", "refs/heads/main"]);
		const base = await text(worker, ["rev-parse", "--verify", "--end-of-options", `${input.base}^{commit}`]);
		result.base = base;
		const tip = await text(worker, ["rev-parse", "HEAD"]);
		await git(worker, ["merge-base", "--is-ancestor", base, tip]);
		await git(repo, ["merge-base", "--is-ancestor", base, parent]);
		const workerDirt = await git(worker, ["status", "--porcelain=v1", "-z", "--untracked-files=all"]);
		if (workerDirt.length) throw new LandingError("WORKER_DIRTY", "Commit all worker changes before landing");
		const revisions = (await text(worker, ["rev-list", "--reverse", "--topo-order", `${base}..${tip}`])).split("\n").filter(Boolean);
		if (!revisions.length) throw new LandingError("EMPTY_DELTA", "Worker has no commits from the selected base");
		const steps: { paths: string[]; patch: Buffer; message: Buffer; author: string; date: string; expected: Buffer }[] = [];
		const touched = new Set<string>();
		let previous = base;
		for (const revision of revisions) {
			if (await text(worker, ["show", "-s", "--format=%P", revision]) !== previous)
				throw new LandingError("NONLINEAR_WORKER", "Worker commits must form a linear sequence from the selected base");
			const paths = names(await git(worker, ["diff", "--name-only", "-z", "--no-renames", previous, revision, "--"]));
			if (!paths.length) throw new LandingError("EMPTY_COMMIT", `Worker commit ${revision} changes no paths`);
			for (const path of paths) touched.add(path);
			const expected = await git(worker, ["ls-tree", "-z", revision, "--", ...paths]);
			if (names(expected).some(entry => entry.startsWith("160000 ")))
				throw new LandingError("SUBMODULE_UNSUPPORTED", "Submodule changes must be landed separately");
			steps.push({
				paths, expected,
				patch: await git(worker, ["diff", "--binary", "--full-index", "--no-ext-diff", "--no-textconv", "--no-renames", previous, revision, "--"]),
				message: await git(worker, ["show", "-s", "--format=%B", revision]),
				author: await text(worker, ["show", "-s", "--format=%an <%ae>", revision]),
				date: await text(worker, ["show", "-s", "--format=%aI", revision]),
			});
			previous = revision;
		}
		const paths = result.paths = [...touched];
		// Both endpoints of renames are paths (diff --no-renames). Literal pathspecs protect
		// filenames containing wildcard syntax; NUL records preserve spaces and newlines.
		const dirty = await git(repo, ["status", "--porcelain=v1", "-z", "--untracked-files=all", "--ignored=matching", "--", ...paths]);
		if (dirty.length) throw new LandingError("PARENT_DIRTY", `Shared paths are dirty: ${names(dirty).join(", ")}`);
		// History, not just the endpoint diff: a main edit followed by a revert is
		// still an overlapping advance and must not silently admit a stale worker.
		const diverged = names(await git(repo, ["log", "-m", "--format=", "--name-only", "-z", "--no-renames", `${base}..${parent}`, "--", ...paths]));
		if (diverged.length) throw new LandingError("PATH_DIVERGED", `Main changed since worker base: ${diverged.join(", ")}`);
		let landedParent = parent;
		async function assertAgreement(commit: string, checkedPaths: string[], expected: Buffer): Promise<void> {
			if (await text(repo, ["symbolic-ref", "HEAD"]) !== "refs/heads/main"
				|| await text(repo, ["rev-parse", "refs/heads/main"]) !== commit)
				throw new LandingError("MAIN_MOVED", "Shared main moved during landing");
			const actual = await git(repo, ["ls-tree", "-z", commit, "--", ...checkedPaths]);
			if (!actual.equals(expected)) throw new LandingError("TREE_MISMATCH", "Commit hooks changed worker content in landed paths");
			await git(repo, ["diff", "--exit-code", "--cached", commit, "--", ...checkedPaths]);
			await git(repo, ["diff", "--exit-code", "--", ...checkedPaths]);
			const remaining = await git(repo, ["status", "--porcelain=v1", "-z", "--untracked-files=all", "--ignored=matching", "--", ...checkedPaths]);
			if (remaining.length) throw new LandingError("TREE_MISMATCH", `Landed paths are not clean: ${names(remaining).join(", ")}`);
		}
		for (const step of steps) {
			await git(repo, ["apply", "--check", "--index", "--binary", "-"], step.patch);
			if (await text(repo, ["rev-parse", "HEAD"]) !== landedParent)
				throw new LandingError("MAIN_MOVED", "Shared HEAD moved during preflight; no further commits applied");
			await git(repo, ["apply", "--index", "--binary", "-"], step.patch);
			result.applied = true;
			// Native --only preserves unrelated staged paths, including additions/deletions.
			// Never cherry-pick: its shared sequencer/index can consume peer staging.
			await git(repo, ["commit", "--only", "--file=-", `--author=${step.author}`, `--date=${step.date}`, "--", ...step.paths], step.message, true);
			const commit = await text(repo, ["rev-parse", "HEAD"]);
			result.commit = commit;
			result.commits.push(commit);
			if (await text(repo, ["show", "-s", "--format=%P", commit]) !== landedParent)
				throw new LandingError("MAIN_MOVED", "Landing commit does not have the admitted main parent");
			await assertAgreement(commit, step.paths, step.expected);
			landedParent = commit;
		}
		const expected = await git(worker, ["ls-tree", "-z", tip, "--", ...paths]);
		await assertAgreement(landedParent, paths, expected);
		await git(repo, ["push", "origin", `${landedParent}:refs/heads/main`], undefined, true);
		result.published = true;
		const remote = (await text(repo, ["ls-remote", "--refs", "origin", "refs/heads/main"])).split("\t");
		if (remote[0] !== result.commit || remote[1] !== "refs/heads/main")
			throw new LandingError("REMOTE_MOVED", "Origin main does not match the landing commit");
		await assertAgreement(landedParent, paths, expected);
		result.overall = "PUSHED";
		result.text = `PUSHED ${result.commit}; landed ${result.commits.length} commit(s); main, index and working tree agree for ${paths.length} path(s)`;
	} catch (error) {
		result.reason = error instanceof LandingError ? error.code : "LANDING_FAILED";
		result.text = `REFUSED ${result.reason}: ${error instanceof Error ? error.message : String(error)}`;
		if (result.applied) result.text += "\nApplied changes/commit retained on main for inspection; no rollback or force-push was attempted.";
	} finally {
		lock?.release();
	}
	return result;
}

export async function ovnfsLandCommand(request: ParsedCommand): Promise<CliResult> {
	const repo = request.flags.get("--repo"), checkout = request.flags.get("--checkout"), base = request.flags.get("--base");
	if (typeof repo !== "string" || typeof checkout !== "string" || typeof base !== "string"
		|| request.flags.get("--apply") !== true || request.flags.get("--yes") !== true) {
		return { code: 2, data: { overall: "REFUSED", text: "Use ovnfs-land --repo PATH --checkout PATH --base SHA --apply --yes; commit the worker first." }, verification: "NOT_RUN" };
	}
	const data = await landCheckout({ repo: resolve(repo), checkout: resolve(checkout), base });
	return { code: data.overall === "PUSHED" ? 0 : 1, data, verification: "PERFORMED" };
}
