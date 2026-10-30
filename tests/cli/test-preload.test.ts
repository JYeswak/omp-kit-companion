import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { expect, test } from "bun:test";
import { run } from "../../src/kitlib/run.ts";
import { ownedTmp } from "../../src/kitlib/tmp.ts";

test("bun test preload creates repo scratch root before fixtures", () => {
	expect(existsSync(resolve(import.meta.dir, "../../var/agent-tmp"))).toBe(true);
});

test("preload preserves wrapper Git boundaries and removes caller repository selectors", async () => {
	const owned = ownedTmp("test-preload-git-boundary");
	try {
		const repo = resolve(import.meta.dir, "../..");
		const archive = join(owned.path, "archive");
		const work = join(archive, "suite");
		const home = join(archive, "home");
		const gitConfig = join(home, "gitconfig");
		const preload = resolve(import.meta.dir, "../test-preload.ts");
		const script = join(owned.path, "inspect.cjs");
		mkdirSync(work, { recursive: true });
		mkdirSync(home, { recursive: true });
		writeFileSync(script, [
			'const { spawnSync } = require("node:child_process");',
			'const git = args => spawnSync("git", args, { cwd: process.cwd(), encoding: "utf8" });',
			'const discovery = git(["rev-parse", "--git-dir"]);',
			'const write = git(["config", "--global", "hermetic.test", "value"]);',
			'const setting = git(["config", "--global", "--get", "hermetic.test"]);',
			'process.stdout.write(JSON.stringify({ ceiling: process.env.GIT_CEILING_DIRECTORIES,',
			'  globalConfig: process.env.GIT_CONFIG_GLOBAL, gitDir: process.env.GIT_DIR,',
			'  workTree: process.env.GIT_WORK_TREE, discoveryCode: discovery.status,',
			'  configCode: write.status, configValue: setting.stdout.trim() }));',
		].join("\n"));
		const realConfig = join(process.env.HOME ?? "", ".gitconfig");
		const before = existsSync(realConfig)
			? createHash("sha256").update(readFileSync(realConfig)).digest("hex")
			: null;
		const child = await run([process.execPath, "--preload", preload, script], {
			cwd: work,
			deadline_s: 30,
			env: {
				PATH: process.env.PATH ?? "",
				HOME: home,
				TMPDIR: owned.path,
				GIT_CEILING_DIRECTORIES: owned.path,
				GIT_CONFIG_GLOBAL: gitConfig,
				GIT_DIR: join(repo, ".git"),
				GIT_WORK_TREE: repo,
			},
		});
		const stdout = Buffer.from(child.stdout).toString("utf8");
		const stderr = Buffer.from(child.stderr).toString("utf8");
		const diagnostic = `${stdout}${stderr}`;
		expect(child.rc, diagnostic).toBe(0);
		const observed = JSON.parse(stdout);
		expect(observed.ceiling).toBe(owned.path);
		expect(observed.globalConfig).toBe(gitConfig);
		expect(observed.gitDir).toBeUndefined();
		expect(observed.workTree).toBeUndefined();
		expect(observed.discoveryCode).not.toBe(0);
		expect(observed.configCode).toBe(0);
		expect(observed.configValue).toBe("value");
		expect(existsSync(realConfig)
			? createHash("sha256").update(readFileSync(realConfig)).digest("hex")
			: null).toBe(before);
	} finally {
		owned.cleanup();
	}
});
