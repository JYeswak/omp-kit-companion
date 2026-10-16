import { afterAll, describe, expect, test } from "bun:test";
import { execSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { check } from "../../src/fleet-guard/git.ts";
import { handleToolCall } from "../../extensions/fleet-guard.ts";

const scratchRoot = join(import.meta.dir, "../../var/agent-tmp");
const scratch = mkdtempSync(join(scratchRoot, "fleet-guard-git-"));
const repo = join(scratch, "repo");
mkdirSync(repo, { recursive: true });
const gitEnv = { ...process.env, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null" };
const git = (args: string): string => execSync(`git ${args}`, { cwd: repo, encoding: "utf8", env: gitEnv }).trim();
git("init -b main");
git("config user.email t@t");
git("config user.name t");
git("config commit.gpgsign false");
writeFileSync(join(repo, "ownA.txt"), "owned bytes");
writeFileSync(join(repo, "receipt.txt"), "receipt bytes");
git("add ownA.txt receipt.txt");
git("commit -m init");
writeFileSync(join(repo, "foreignB.txt"), "peer bytes");
git("add foreignB.txt");
rmSync(join(repo, "receipt.txt"));
const gitState = (): string => `${git("rev-parse HEAD")}\n${git("status --porcelain")}`;

function snapshotTree(root: string): string[] {
	const entries: string[] = [];
	const walk = (directory: string, prefix: string): void => {
		for (const name of readdirSync(directory)) {
			const relative = prefix ? `${prefix}/${name}` : name;
			if (statSync(join(directory, name)).isDirectory()) {
				entries.push(`${relative}/`);
				walk(join(directory, name), relative);
			} else {
				entries.push(`${relative}:${readFileSync(join(directory, name)).toString()}`);
			}
		}
	};
	walk(root, "");
	return entries.sort();
}
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

const event = (command: string) => ({ toolName: "bash", arguments: { command } });
const context = { cwd: repo };

describe("fleet guard main-only git checks", () => {
	test("blocks every branch/worktree creation form in a repository", () => {
		for (const command of [
			"git worktree add ../new-worktree",
			"git worktree --force add ../new-worktree",
			"git checkout -b topic",
			"git checkout -B topic",
			"git checkout --orphan topic",
			"git switch -c topic",
			"git switch -C topic",
			"git switch --orphan topic",
			"git branch topic",
		]) {
			const result = check(event(command), context);
			expect(result?.block).toBe(true);
			expect(result?.reason).toContain("main-only");
		}
	});

	test("allows ordinary checkout, switch, listing, and non-repository commands", () => {
		for (const command of ["git switch main", "git checkout main", "git worktree list", "printf 'git switch -c fake'"]) {
			expect(check(event(command), context)).toBeUndefined();
		}
		expect(check(event("git switch -c topic"), { cwd: "/" })).toBeUndefined();
	});

	test("allows branch creation only for an explicit repository opt-out", () => {
		writeFileSync(join(repo, ".omp-fleet-guard.json"), "{}");
		expect(check(event("git switch -c topic"), context)).toBeDefined();
		mkdirSync(join(repo, ".omp"), { recursive: true });
		writeFileSync(join(repo, ".omp", "fleet-guard.json"), JSON.stringify({ branches: true }));
		expect(check(event("git switch -c topic"), context)).toBeUndefined();
	});

	test("refuses unscoped git commit --amend in every wrapper form", () => {
		const before = snapshotTree(repo);
		const gitBefore = gitState();
		for (const command of [
			"git commit --amend --no-edit",
			"git commit --amend",
			"git commit -m msg --amend",
			"git -C sub commit --amend",
			"git -c user.name=t commit --amend",
			"GIT_DIR=x git commit --amend",
			"env GIT_SSH=x git commit --amend",
			"git commit --amend --only -- some/path",
			"git status && git commit --amend",
			`/usr/bin/git -C ${repo} commit --amend --no-edit`,
		]) {
			const result = check(event(command), context);
			expect(result?.block, command).toBe(true);
			expect(result?.reason, command).toContain("amend");
		}
		expect(snapshotTree(repo)).toEqual(before);
		expect(gitState()).toBe(gitBefore);
	});

	test("allows ordinary scoped commits and quiet quoted prose", () => {
		const before = snapshotTree(repo);
		for (const command of [
			"git commit --only -m msg -- some/path",
			"git commit -m msg",
			"git commit --no-amend",
			"git commit -m \"fix --amend stuff\"",
			"git commit -m msg -- --amend",
			"git commit -m \"--amend\"",
			"git commit -am \"--amend\"",
			"git commit --author \"x <x@y>\" -m msg",
			"git --no-pager commit -m msg",
			"printf 'git commit --amend fake'",
			"git commit -amend -m msg",
		]) {
			expect(check(event(command), context), command).toBeUndefined();
		}
		expect(snapshotTree(repo)).toEqual(before);
		expect(readFileSync(join(repo, "ownA.txt"), "utf8")).toBe("owned bytes");
		expect(readFileSync(join(repo, "foreignB.txt"), "utf8")).toBe("peer bytes");
	});

	test("native entry path blocks unscoped amend through the chained checks", async () => {
		const result = await handleToolCall(event("git commit --amend --no-edit"), context);
		expect(result?.block).toBe(true);
		expect(result?.reason).toContain("amend");
	});
});
