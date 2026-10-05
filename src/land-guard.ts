import { spawnSync } from "node:child_process";

export interface StaleDeletion {
	commit: string;
	file: string;
	missing_lines: string[];
}

export interface LandGit {
	run(args: string[], cwd: string): { code: number; out: string };
}

function defaultGit(): LandGit {
	return {
		run(args, cwd) {
			const run = spawnSync("git", args, { cwd, encoding: "utf8", maxBuffer: 16 * 1024 * 1024 });
			return { code: run.status ?? 1, out: String(run.stdout ?? "") };
		},
	};
}

/** Lines added between base and tip per file, from a zero-context diff. */
export function addedLinesSince(git: LandGit, repo: string, base: string, tip: string, paths: string[]): Map<string, string[]> {
	const diff = git.run(["diff", "-U0", base, tip, "--", ...paths], repo);
	if (diff.code !== 0) throw new Error("land-guard: git diff failed: " + diff.out.slice(0, 200));
	const added = new Map<string, string[]>();
	let file = "";
	for (const line of diff.out.split("\n")) {
		if (line.startsWith("+++ b/")) {
			file = line.slice("+++ b/".length);
			if (!added.has(file)) added.set(file, []);
		} else if (line.startsWith("+") && !line.startsWith("+++") && file) {
			added.get(file)!.push(line.slice(1));
		}
	}
	return added;
}

function blobLines(git: LandGit, repo: string, tree: string, file: string): Set<string> | null {
	const shown = git.run(["show", tree + ":" + file], repo);
	if (shown.code !== 0) return null;
	return new Set(shown.out.split("\n"));
}

function attributeCommit(git: LandGit, repo: string, base: string, tip: string, file: string, line: string): string | null {
	const logged = git.run(["log", "--format=%H", "-S", line, base + ".." + tip, "--", file], repo);
	if (logged.code !== 0) return null;
	const first = logged.out.split("\n").map((row) => row.trim()).filter((row) => row.length > 0)[0];
	return first ?? null;
}

/**
 * Refuse a candidate tree built on a stale base: every line added after base
 * must still be present, or the finding names the commit that added it.
 */
export function findStaleDeletions(
	git: LandGit,
	repo: string,
	base: string,
	tip: string,
	candidateTree: string,
	paths: string[],
): StaleDeletion[] {
	const added = addedLinesSince(git, repo, base, tip, paths);
	const byCommit = new Map<string, StaleDeletion>();
	for (const [file, lines] of added) {
		const candidate = blobLines(git, repo, candidateTree, file);
		for (const line of lines) {
			if (line.length === 0) continue;
			if (candidate !== null && candidate.has(line)) continue;
			const commit = attributeCommit(git, repo, base, tip, file, line) ?? tip;
			const key = commit + "\0" + file;
			const row = byCommit.get(key) ?? { commit, file, missing_lines: [] };
			if (!row.missing_lines.includes(line)) row.missing_lines.push(line);
			byCommit.set(key, row);
		}
	}
	return [...byCommit.values()].sort((a, b) => (a.commit < b.commit ? -1 : a.commit > b.commit ? 1 : a.file < b.file ? -1 : 1));
}

export function checkCandidateTree(
	repo: string,
	base: string,
	tip: string,
	candidateTree: string,
	paths: string[],
	git: LandGit = defaultGit(),
): { ok: boolean; deletions: StaleDeletion[] } {
	const deletions = findStaleDeletions(git, repo, base, tip, candidateTree, paths);
	return { ok: deletions.length === 0, deletions };
}

if (import.meta.main) {
	const args = process.argv.slice(2);
	const flag = (name: string): string | null => {
		const index = args.indexOf(name);
		return index >= 0 && index + 1 < args.length ? args[index + 1]! : null;
	};
	const repo = flag("--repo");
	const base = flag("--base");
	const tip = flag("--tip");
	const tree = flag("--tree");
	const pathsIndex = args.indexOf("--paths");
	const paths = pathsIndex >= 0 ? args.slice(pathsIndex + 1) : null;
	if (!repo || !base || !tip || !tree || !paths || paths.length === 0) {
		process.stderr.write("land-guard: usage: land-guard.ts --repo DIR --base REV --tip REV --tree REV --paths FILE...\n");
		process.exit(2);
	}
	const verdict = checkCandidateTree(repo, base, tip, tree, paths);
	for (const row of verdict.deletions) {
		process.stderr.write(`land-guard: stale deletion from ${row.commit} in ${row.file}: ${row.missing_lines.join(" | ").slice(0, 300)}\n`);
	}
	process.exit(verdict.ok ? 0 : 1);
}
