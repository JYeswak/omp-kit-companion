import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";

/** Fleet-wide commit lookup (SHAFIND1 ompkit-fp72.19.1.22): graders declared
 * real commits phantom by checking one repo. `omp-kit sha` resolves a cited
 * sha across every fleet repo so an absence verdict is provable, and
 * grade_apply.py refuses a missing-commit REWORK without its output. */

export const SHA_PATTERN = /^[0-9a-fA-F]{4,40}$/;

export type ShaRunResult = { code: number | null; stdout: string; stderr: string };
export type ShaRunner = (args: readonly string[], opts?: { timeoutMs?: number }) => ShaRunResult;

export type ShaRepoResult = {
	repo: string;
	present: boolean;
	full: string | null;
	subject: string | null;
	onOriginMain: "yes" | "no" | "unknown";
};

const MAX_REPOS = 256;
const GIT_TIMEOUT_MS = 10_000;

/** Fleet repos: the kit, the companion, ~/.claude, plus every ~/Developer
 * child holding a .git (project repos a fleet-watch session may grade). */
export function discoverFleetRepos(home: string): string[] {
	const found: string[] = [];
	const seen = new Set<string>();
	const add = (repo: string): void => {
		if (seen.has(repo) || found.length >= MAX_REPOS) return;
		seen.add(repo);
		try {
			if (existsSync(join(repo, ".git"))) found.push(repo);
		} catch {
			// Unreadable repo: skipped, never fatal.
		}
	};
	add(join(home, "Developer", "omp-kit"));
	add(join(home, "Developer", "omp-kit-companion"));
	add(join(home, ".claude"));
	let children: string[] = [];
	try {
		children = readdirSync(join(home, "Developer"));
	} catch {
		return found;
	}
	for (const child of children.sort()) add(join(home, "Developer", child));
	return found;
}

function git(run: ShaRunner, repo: string, args: readonly string[]): ShaRunResult {
	try {
		return run(["git", "-C", repo, "--no-optional-locks", ...args], { timeoutMs: GIT_TIMEOUT_MS });
	} catch {
		return { code: null, stdout: "", stderr: "spawn failed" };
	}
}

export function lookupShaInRepo(run: ShaRunner, repo: string, sha: string): ShaRepoResult {
	const absent: ShaRepoResult = { repo, present: false, full: null, subject: null, onOriginMain: "unknown" };
	if (git(run, repo, ["cat-file", "-e", `${sha}^{commit}`]).code !== 0) return absent;
	const resolved = git(run, repo, ["rev-parse", "--verify", `${sha}^{commit}`]);
	const full = resolved.code === 0 ? resolved.stdout.trim() : "";
	if (!/^[0-9a-f]{40}$/.test(full)) return { ...absent, present: true };
	const subjectOut = git(run, repo, ["log", "-1", "--format=%s", full]);
	const subject = subjectOut.code === 0 ? subjectOut.stdout.replace(/\s+/g, " ").trim().slice(0, 200) : null;
	let onOriginMain: ShaRepoResult["onOriginMain"] = "unknown";
	if (git(run, repo, ["rev-parse", "--verify", "--quiet", "origin/main^{commit}"]).code === 0)
		onOriginMain = git(run, repo, ["merge-base", "--is-ancestor", full, "origin/main"]).code === 0 ? "yes" : "no";
	return { repo, present: true, full, subject, onOriginMain };
}

export function lookupSha(run: ShaRunner, repos: string[], sha: string): ShaRepoResult[] {
	return repos.map((repo) => lookupShaInRepo(run, repo, sha));
}

/** Grader-pasteable text. The absent marker line is the proof token
 * grade_apply.py requires: `SHA-ABSENT-EVERYWHERE <sha>`. */
export function formatShaText(query: string, repos: string[], results: ShaRepoResult[]): string {
	const hits = results.filter((row) => row.present);
	if (!hits.length)
		return [`SHA-ABSENT-EVERYWHERE ${query}`, `searched ${repos.length} repos: ${repos.join(", ") || "(none)"}`].join("\n");
	return [
		`SHA-FOUND ${query} in ${hits.length} of ${repos.length} repos:`,
		...hits.map((hit) => `SHA-FOUND ${hit.repo} ${hit.full ?? query} on-origin-main=${hit.onOriginMain} ${hit.subject ?? "(no subject)"}`),
	].join("\n");
}
