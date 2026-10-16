import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, utimesSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { join, resolve } from "node:path";
import { inspectStaleWorktree } from "../../src/stale-worktree-doctor.ts";

const repoRoot = resolve(import.meta.dir, "../..");
const scratchRoot = join(repoRoot, "var", "agent-tmp");
mkdirSync(scratchRoot, { recursive: true });
const scratch = mkdtempSync(join(scratchRoot, "stale-worktree-doctor-test." + process.pid + "."));
writeFileSync(join(scratch, ".owner"), "pid=" + process.pid + " label=stale-worktree-doctor-test repo=" + repoRoot + " created=" + new Date().toISOString() + "\n");

function git(repo: string, args: string[]): string {
	const run = spawnSync("git", ["-c", "user.email=test@example.invalid", "-c", "user.name=worker", ...args], { cwd: repo, encoding: "utf8" });
	if (run.status !== 0) throw new Error("git " + args.join(" ") + " failed: " + String(run.stderr).slice(0, 200));
	return String(run.stdout);
}

function repoWithLandedLine(): { repo: string; sha: string } {
	const repo = join(scratch, "repo-" + Math.random().toString(36).slice(2));
	mkdirSync(join(repo, "pkg"), { recursive: true });
	writeFileSync(join(repo, "pkg", "f.txt"), "base line\nlanded line L\n");
	git(repo, ["init", "-q"]);
	git(repo, ["add", "-A"]);
	git(repo, ["commit", "-qm", "[test] land L", "-m", "Bead: t-land"]);
	return { repo, sha: git(repo, ["rev-parse", "HEAD"]).trim() };
}

test("stale worktree removal is listed with its commit and bead", () => {
	const { repo, sha } = repoWithLandedLine();
	writeFileSync(join(repo, "pkg", "f.txt"), "base line\n");
	utimesSync(join(repo, "pkg", "f.txt"), new Date("2020-01-01"), new Date("2020-01-01"));
	const report = inspectStaleWorktree(repo);
	expect(report.overall).toBe("FAIL");
	expect(report.stale_paths.length).toBe(1);
	expect(report.stale_paths[0]?.path).toBe("pkg/f.txt");
	const revert = report.stale_paths[0]?.reverts[0];
	expect(revert?.sha).toBe(sha);
	expect(revert?.bead).toBe("t-land");
	expect(revert?.stale).toBe(true);
});

test("fresh own rework is not listed", () => {
	const { repo } = repoWithLandedLine();
	writeFileSync(join(repo, "pkg", "f.txt"), "base line\nlanded line L\nown line\n");
	const report = inspectStaleWorktree(repo);
	expect(report.overall).toBe("OK");
	expect(report.stale_paths.length).toBe(0);
});

test("a repo with no commits is UNVERIFIED", () => {
	const dir = join(scratch, "unborn-" + Math.random().toString(36).slice(2));
	mkdirSync(dir, { recursive: true });
	git(dir, ["init", "-q"]);
	const report = inspectStaleWorktree(dir);
	expect(report.overall).toBe("UNVERIFIED");
});
