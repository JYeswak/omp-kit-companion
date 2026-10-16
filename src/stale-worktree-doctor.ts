import { spawnSync } from "node:child_process";
import { statSync } from "node:fs";
import { resolve } from "node:path";

export interface StalePathRevert {
	sha: string;
	subject: string;
	bead: string | null;
	/** Blamed commit is newer than the file's last worktree write. */
	stale: boolean;
}

export interface StaleWorktreeReport {
	scope: "stale-worktree";
	overall: "OK" | "FAIL" | "UNVERIFIED";
	repo: string;
	head: string | null;
	checked_paths: number;
	stale_paths: StalePath[];
}

function git(repo: string, args: string[]): { code: number; out: string } {
	const run = spawnSync("git", args, { cwd: repo, encoding: "utf8", timeout: 30_000, maxBuffer: 8 * 1024 * 1024 });
	return { code: run.status ?? 1, out: String(run.stdout ?? "") };
}

function removedLines(repo: string, head: string, path: string): number[] {
	const diff = git(repo, ["diff", "-U0", "--no-color", "--no-ext-diff", head, "--", path]);
	if (diff.code !== 0 || /Binary files .* differ/.test(diff.out)) return [];
	const removed: number[] = [];
	let old = 0;
	for (const line of diff.out.split("\n")) {
		if (line.startsWith("@@")) {
			const range = (line.slice(3).split(" ")[0] ?? "").replace(/^[+-]/, "");
			old = Number(range.split(",")[0]) || 0;
		} else if (line.startsWith("---") || line.startsWith("+++")) {
			continue;
		} else if (line.startsWith("-")) {
			removed.push(old);
			old += 1;
		} else if (line.startsWith("+") || line.startsWith("\\")) {
			continue;
		} else {
			old += 1;
		}
	}
	return removed;
}

function blameMap(repo: string, head: string, path: string): Map<number, string> {
	const map = new Map<number, string>();
	const blame = git(repo, ["blame", "--porcelain", head, "--", path]);
	if (blame.code !== 0) return map;
	let sha = "";
	let n = 0;
	for (const line of blame.out.split("\n")) {
		if (line.startsWith("\t")) {
			n += 1;
			if (sha) map.set(n, sha);
		} else {
			const m = /^([0-9a-f]{40}) /.exec(line);
			if (m) sha = m[1] ?? "";
		}
	}
	return map;
}

const BEAD_RE = /^[ \t]*[Bb]ead:[ \t]*([A-Za-z0-9._-]+)/m;

/** Read-only inventory: paths whose worktree removes lines landed in HEAD. */
export function inspectStaleWorktree(dir: string): StaleWorktreeReport {
	const top = git(dir, ["rev-parse", "--show-toplevel"]);
	if (top.code !== 0) {
		return { scope: "stale-worktree", overall: "UNVERIFIED", repo: resolve(dir), head: null, checked_paths: 0, stale_paths: [] };
	}
	const repo = top.out.trim();
	const head = git(repo, ["rev-parse", "--verify", "HEAD^{commit}"]);
	if (head.code !== 0) {
		return { scope: "stale-worktree", overall: "UNVERIFIED", repo, head: null, checked_paths: 0, stale_paths: [] };
	}
	const headSha = head.out.trim();
	const names = git(repo, ["diff", "--name-only", "-z", "HEAD", "--"]);
	if (names.code !== 0) {
		return { scope: "stale-worktree", overall: "UNVERIFIED", repo, head: headSha, checked_paths: 0, stale_paths: [] };
	}
	const stale: StalePath[] = [];
	let checked = 0;
	for (const path of names.out.split("\0").filter((entry) => entry.length > 0)) {
		if (path.includes("\n") || path.includes("..")) continue;
		checked += 1;
		const removed = removedLines(repo, headSha, path);
		if (removed.length === 0) continue;
		let mtime = 0;
		try {
			mtime = Math.floor(statSync(resolve(repo, path)).mtimeMs / 1000);
		} catch {
			continue;
		}
		const blames = blameMap(repo, headSha, path);
		const seen = new Set<string>();
		const reverts: StalePathRevert[] = [];
		for (const ln of removed) {
			const sha = blames.get(ln);
			if (!sha || seen.has(sha)) continue;
			seen.add(sha);
			const log = git(repo, ["log", "-1", "--format=%s%n%ct%n%B", sha]);
			if (log.code !== 0) continue;
			const [subject = "", dateStr = "", ...body] = log.out.split("\n");
			const date = Number(dateStr) || 0;
			const bead = BEAD_RE.exec(body.join("\n"))?.[1] ?? null;
			// Stale: the worktree predates the landing. Foreign-bead: the
			// removed line belongs to another bead's landed commit and needs
			// a declared revert at save time, whatever the mtime says.
			if (date <= mtime && bead === null) continue;
			reverts.push({ sha, subject, bead, stale: date > mtime });
		}
		if (reverts.length > 0) stale.push({ path, reverts });
	}
	return {
		scope: "stale-worktree",
		overall: stale.length > 0 ? "FAIL" : "OK",
		repo,
		head: headSha,
		checked_paths: checked,
		stale_paths: stale,
	};
}
