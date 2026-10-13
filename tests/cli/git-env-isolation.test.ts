import { afterAll, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

const repo = resolve(import.meta.dir, "../..");
const workspace = join(repo, "var", "agent-tmp", `git-env-isolation.${process.pid}`);
const sentinel = join(workspace, "sentinel");

function git(cwd: string, ...args: string[]): string {
	const child = Bun.spawnSync(["git", "-C", cwd, ...args], {
		stdout: "pipe",
		stderr: "pipe",
		env: { PATH: process.env.PATH ?? "", HOME: workspace },
		timeout: 10_000,
	});
	const output = `${child.stdout.toString()}${child.stderr.toString()}`;
	if (child.exitCode !== 0) throw new Error(`git ${args.join(" ")} failed (${child.exitCode}):\n${output}`);
	return child.stdout.toString().trim();
}

afterAll(() => {
	if (existsSync(workspace)) rmSync(workspace, { recursive: true, force: true });
});

test("Git fixture identity writes ignore inherited repository selectors", { timeout: 120_000 }, () => {
	mkdirSync(sentinel, { recursive: true });
	writeFileSync(join(workspace, ".owner"), `pid=${process.pid}\nlabel=git-env-isolation\nrepo=${repo}\ncreated=${new Date().toISOString()}\n`);
	git(sentinel, "init", "--initial-branch=main");
	git(sentinel, "config", "user.name", "Sentinel");
	git(sentinel, "config", "user.email", "sentinel@example.invalid");
	const sentinelConfig = readFileSync(join(sentinel, ".git", "config"), "utf8");

	const child = Bun.spawnSync([
		process.execPath,
		"test",
		"--config",
		join(repo, "bunfig.toml"),
		"--timeout=120000",
		"tests/cli/git-env-fixture.test.ts",
	], {
		cwd: repo,
		stdout: "pipe",
		stderr: "pipe",
		env: {
			...process.env,
			GIT_DIR: join(sentinel, ".git"),
			GIT_WORK_TREE: sentinel,
			GIT_INDEX_FILE: join(workspace, "sentinel.index"),
			GIT_OBJECT_DIRECTORY: join(sentinel, ".git", "objects"),
			GIT_COMMON_DIR: join(sentinel, ".git"),
			GIT_CONFIG_GLOBAL: join(workspace, "global.gitconfig"),
			GIT_CONFIG_COUNT: "1",
			GIT_CONFIG_KEY_0: "user.name",
			GIT_CONFIG_VALUE_0: "Poisoned",
		},
	});
	const output = `${child.stdout.toString()}${child.stderr.toString()}`;

	expect(readFileSync(join(sentinel, ".git", "config"), "utf8")).toBe(sentinelConfig);
	expect(git(sentinel, "config", "user.name")).toBe("Sentinel");
	expect(child.exitCode, output).toBe(0);
});
