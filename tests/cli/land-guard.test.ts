import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { join, resolve } from "node:path";
import { checkCandidateTree, findStaleDeletions, type LandGit } from "../../src/land-guard.ts";

const repoRoot = resolve(import.meta.dir, "../..");
const scratchRoot = join(repoRoot, "var", "agent-tmp");
mkdirSync(scratchRoot, { recursive: true });
const scratch = mkdtempSync(join(scratchRoot, "land-guard-test." + process.pid + "."));
writeFileSync(join(scratch, ".owner"), "pid=" + process.pid + " label=land-guard-test repo=" + repoRoot + " created=" + new Date().toISOString() + "\n");

function git(repo: string, args: string[]): string {
	const run = spawnSync("git", ["-c", "user.email=test@example.invalid", "-c", "user.name=worker", ...args], { cwd: repo, encoding: "utf8" });
	if (run.status !== 0) throw new Error("git " + args.join(" ") + " failed: " + String(run.stderr).slice(0, 200));
	return String(run.stdout);
}

function repoWith(baseFiles: Record<string, string>): string {
	const repo = join(scratch, "repo-" + Math.random().toString(36).slice(2));
	mkdirSync(repo, { recursive: true });
	git(repo, ["init", "-q"]);
	for (const [name, content] of Object.entries(baseFiles)) {
		mkdirSync(join(repo, name).split("/").slice(0, -1).join("/"), { recursive: true });
		writeFileSync(join(repo, name), content);
	}
	git(repo, ["add", "-A"]);
	git(repo, ["commit", "-qm", "[test] base fixture"]);
	return repo;
}

function commitAll(repo: string, message: string): string {
	git(repo, ["add", "-A"]);
	git(repo, ["commit", "-qm", "[test] " + message]);
	return git(repo, ["rev-parse", "HEAD"]).trim();
}

const gitRunner: LandGit = {
	run(args, cwd) {
		const run = spawnSync("git", ["-c", "user.email=test@example.invalid", "-c", "user.name=worker", ...args], { cwd, encoding: "utf8" });
		return { code: run.status ?? 1, out: String(run.stdout ?? "") };
	},
};

test("LAND1 happy: candidate built on the tip is clean", () => {
	const repo = repoWith({ "f.ts": "line one\n" });
	const base = git(repo, ["rev-parse", "HEAD"]).trim();
	writeFileSync(join(repo, "f.ts"), "line one\nline two added later\n");
	const tip = commitAll(repo, "add line two");
	const verdict = checkCandidateTree(repo, base, tip, tip, ["f.ts"]);
	expect(verdict).toEqual({ ok: true, deletions: [] });
});

test("LAND1 planted: stale-base replay of 38afcc7e59 names the dropped commit", () => {
	const repo = repoWith({ "src/diagnostics.ts": "old check\n", "notes.txt": "context\n" });
	const base = git(repo, ["rev-parse", "HEAD"]).trim();
	writeFileSync(join(repo, "src/diagnostics.ts"), "old check\nlikely duplicate beads share most text\n");
	writeFileSync(join(repo, "src/new-tool.ts"), "new module\n");
	const tip = commitAll(repo, "FLY1 dedup report plus new tool");
	const staleTree = git(repo, ["rev-parse", base + "^{tree}"]).trim();
	writeFileSync(join(repo, "unrelated.txt"), "other work\n");
	const deletions = findStaleDeletions(gitRunner, repo, base, tip, staleTree, ["src/diagnostics.ts", "src/new-tool.ts", "unrelated.txt"]);
	expect(deletions.map((row) => row.commit)).toEqual([tip, tip]);
	expect(deletions.map((row) => row.file).sort()).toEqual(["src/diagnostics.ts", "src/new-tool.ts"]);
	expect(deletions.every((row) => row.missing_lines.length > 0)).toBe(true);
	const exact = checkCandidateTree(repo, base, tip, tip, ["src/diagnostics.ts", "src/new-tool.ts"]);
	expect(exact.ok).toBe(true);
});

test("LAND1: candidate that keeps newer lines but adds its own passes", () => {
	const repo = repoWith({ "f.ts": "one\n" });
	const base = git(repo, ["rev-parse", "HEAD"]).trim();
	writeFileSync(join(repo, "f.ts"), "one\ntwo\n");
	const tip = commitAll(repo, "add two");
	writeFileSync(join(repo, "f.ts"), "one\ntwo\nthree mine\n");
	const mine = commitAll(repo, "add three");
	expect(mine).not.toBe(tip);
	const verdict = checkCandidateTree(repo, base, tip, mine, ["f.ts"]);
	expect(verdict.ok).toBe(true);
});
