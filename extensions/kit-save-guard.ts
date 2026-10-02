/**
 * kit-save-guard: session-end save guard for AGENTS.md (Saving).
 *
 * Installing the plugin that lists this extension is the opt-in; there is no
 * per-repo config. At `session_shutdown` it runs read-only git inspection in
 * the session cwd's repo and emits one warning line when work would be left
 * unsaved: dirty file count, commits ahead of upstream, missing upstream.
 * Clean repos, non-repos, and every error stay silent. It never commits,
 * stashes, or pushes, and never blocks shutdown: the whole check is git
 * plumbing that typically settles in tens of milliseconds against OMP's
 * 2 s shutdown-handler budget.
 */
export interface SaveGuardExecResult {
	stdout: string;
	code: number;
}

export interface SaveGuardExecOptions {
	cwd?: string;
	timeout?: number;
}

export interface SaveGuardContext {
	cwd: string;
	ui: { notify(message: string, type?: "info" | "warning" | "error"): void };
}

/** The slice of omp's ExtensionAPI this guard touches. */
export interface SaveGuardApi {
	on(event: "session_shutdown",
		handler: (event: { type: "session_shutdown" }, ctx: SaveGuardContext) => unknown): void;
	exec(command: string, args: string[], options?: SaveGuardExecOptions): Promise<SaveGuardExecResult>;
}

/** Per-command ceiling; the runner caps the whole shutdown handler at 2 s. */
export const SAVE_GUARD_GIT_TIMEOUT_MS = 1000;

export async function checkSaveState(
	exec: SaveGuardApi["exec"], cwd: string): Promise<string | null> {
	const run = async (args: string[]): Promise<SaveGuardExecResult> =>
		exec("git", args, { cwd, timeout: SAVE_GUARD_GIT_TIMEOUT_MS });
	const top = await run(["rev-parse", "--show-toplevel"]);
	if (top.code !== 0) return null;
	const root = top.stdout.trim();
	if (root.length === 0) return null;
	const status = await run(["status", "--porcelain"]);
	if (status.code !== 0) return null;
	const dirty = status.stdout.split("\n").filter(line => line.trim().length > 0).length;
	const branchOut = await run(["branch", "--show-current"]);
	const branch = branchOut.code === 0 && branchOut.stdout.trim().length > 0
		? branchOut.stdout.trim()
		: "(detached HEAD)";
	const upstream = await run(["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{u}"]);
	if (upstream.code !== 0) {
		const parts = [`no upstream for ${branch}`];
		if (dirty > 0) parts.push(`${dirty} uncommitted file(s)`);
		return `kit-save-guard: ${root}: ${parts.join(", ")} — set an upstream or push the branch before ending the session (the guard never writes)`;
	}
	const upstreamName = upstream.stdout.trim();
	const aheadOut = await run(["rev-list", "--count", "@{u}..HEAD"]);
	const ahead = aheadOut.code === 0 ? Number(aheadOut.stdout.trim()) : Number.NaN;
	const parts: string[] = [];
	if (dirty > 0) parts.push(`${dirty} uncommitted file(s)`);
	if (Number.isSafeInteger(ahead) && ahead > 0) parts.push(`${ahead} commit(s) ahead of ${upstreamName}`);
	if (parts.length === 0) return null;
	return `kit-save-guard: ${root}: ${parts.join(", ")} — commit, or push the branch, before ending the session (the guard never writes)`;
}

export default async function kitSaveGuard(pi: SaveGuardApi): Promise<void> {
	pi.on("session_shutdown", async (_event, ctx) => {
		try {
			const warning = await checkSaveState(
				(command, args, options) => pi.exec(command, args, options), ctx.cwd);
			if (warning) ctx.ui.notify(warning, "warning");
		} catch { /* never block shutdown on guard errors */ }
	});
}
