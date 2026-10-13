import { afterAll, expect, test } from "bun:test";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

const repo = resolve(import.meta.dir, "../..");
const workspace = join(repo, "var", "agent-tmp", `git-env-fixture.${process.pid}`);
const fixture = join(workspace, "repo");

afterAll(() => {
	if (existsSync(workspace)) rmSync(workspace, { recursive: true, force: true });
});

test("fixture identity is stored in its own Git repository", () => {
	mkdirSync(fixture, { recursive: true });
	writeFileSync(join(workspace, ".owner"), `pid=${process.pid}\nlabel=git-env-fixture\nrepo=${repo}\ncreated=${new Date().toISOString()}\n`);
	git("init", "--initial-branch=main");
	git("config", "user.name", "Fixture Identity");
	git("config", "user.email", "fixture@example.invalid");
	expect(git("config", "--local", "user.name")).toBe("Fixture Identity");
});

function git(...args: string[]): string {
	const child = Bun.spawnSync(["git", "-C", fixture, ...args], {
		stdout: "pipe",
		stderr: "pipe",
		env: process.env,
		timeout: 10_000,
	});
	const output = `${child.stdout.toString()}${child.stderr.toString()}`;
	if (child.exitCode !== 0) throw new Error(`git ${args.join(" ")} failed (${child.exitCode}):\n${output}`);
	return child.stdout.toString().trim();
}
