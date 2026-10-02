import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { check } from "../../src/fleet-guard/git.ts";

const scratch = mkdtempSync(join(import.meta.dir, "../../var/agent-tmp/fleet-guard-git-"));
const repo = join(scratch, "repo");
mkdirSync(join(repo, ".git"), { recursive: true });
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
});
