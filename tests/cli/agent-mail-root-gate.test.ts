import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

const kitRoot = resolve(import.meta.dir, "../..");
const scratchRoot = join(kitRoot, "var", "agent-tmp");
mkdirSync(scratchRoot, { recursive: true });
const scratch = mkdtempSync(join(scratchRoot, `am1-root-gate.${process.pid}.`));
writeFileSync(join(scratch, ".owner"), `pid=${process.pid}\nlabel=am1-root-gate\nrepo=${kitRoot}\ncreated=${new Date().toISOString()}\n`);
const fixture = join(scratch, "repo");
const isolatedHome = join(scratch, "home");
const globalGitConfig = join(scratch, "gitconfig");
const gate = join(kitRoot, "scripts", "pre-commit-storage-root-gate.sh");
const liveStorageRoot = join(isolatedHome, ".local", "share", "mcp-agent-mail-rust-live");
const legacyStorageRoot = join(isolatedHome, ".mcp_agent_mail_git_mailbox_repo");
const wrongStorageRoot = join(scratch, "wrong-agent-mail");
const projectKey = resolve(fixture);
mkdirSync(fixture);
mkdirSync(isolatedHome);
writeFileSync(globalGitConfig, "");

const baseEnv: NodeJS.ProcessEnv = {
	...process.env,
	HOME: isolatedHome,
	TMPDIR: scratchRoot,
	GIT_CONFIG_GLOBAL: globalGitConfig,
	GIT_CONFIG_NOSYSTEM: "1",
};
for (const key of ["AGENT_MAIL_STORAGE_ROOT", "STORAGE_ROOT", "XDG_DATA_HOME", "XDG_STATE_HOME"]) delete baseEnv[key];

const initialized = Bun.spawnSync(["git", "init", "--quiet", fixture], {
	cwd: scratch,
	env: baseEnv,
	stdout: "pipe",
	stderr: "pipe",
});
expect(initialized.exitCode, initialized.stderr.toString()).toBe(0);
function git(args: string[]) {
	return Bun.spawnSync(["git", ...args], { cwd: fixture, env: baseEnv, stdout: "pipe", stderr: "pipe" });
}

function writeProjectArchive(storageRoot: string, slug: string, humanKey: string) {
	const archive = join(storageRoot, "projects", slug);
	mkdirSync(join(archive, "file_reservations"), { recursive: true });
	writeFileSync(join(archive, "project.json"), JSON.stringify({ slug, human_key: humanKey }));
}

writeProjectArchive(legacyStorageRoot, "unrelated-project", "/some/other/repository");
writeProjectArchive(liveStorageRoot, "fixture-project", projectKey);
writeProjectArchive(wrongStorageRoot, "unrelated-project", "/some/other/repository");

test("bare-shell guard resolves the matching project archive instead of the stale legacy root", () => {
	const resolved = Bun.spawnSync(["sh", gate, "--resolve-root"], {
		cwd: fixture,
		env: baseEnv,
		stdout: "pipe",
		stderr: "pipe",
	});
	expect(resolved.exitCode, resolved.stderr.toString()).toBe(0);
	expect(resolved.stdout.toString().trim()).toBe(liveStorageRoot);
});

test("bare-shell guard uses the repository's configured matching archive", () => {
	const configured = git(["config", "--local", "--replace-all", "omp-kit.agent-mail-storage-root", liveStorageRoot]);
	expect(configured.exitCode, configured.stderr.toString()).toBe(0);
	const resolved = Bun.spawnSync(["sh", gate, "--resolve-root"], {
		cwd: fixture,
		env: baseEnv,
		stdout: "pipe",
		stderr: "pipe",
	});
	expect(resolved.exitCode, resolved.stderr.toString()).toBe(0);
	expect(resolved.stdout.toString().trim()).toBe(liveStorageRoot);
});

test("linked worktree resolves the archive for the main project root", () => {
	const configured = git(["config", "--local", "--replace-all", "omp-kit.agent-mail-storage-root", liveStorageRoot]);
	expect(configured.exitCode, configured.stderr.toString()).toBe(0);
	const committed = git([
		"-c", "user.name=Fixture",
		"-c", "user.email=fixture@example.invalid",
		"commit", "--allow-empty", "--quiet", "-m", "fixture",
	]);
	expect(committed.exitCode, committed.stderr.toString()).toBe(0);
	const worktree = join(scratch, "worktree");
	const added = git(["worktree", "add", "--detach", "--quiet", worktree, "HEAD"]);
	expect(added.exitCode, added.stderr.toString()).toBe(0);
	const resolved = Bun.spawnSync(["sh", gate, "--resolve-root"], {
		cwd: worktree,
		env: baseEnv,
		stdout: "pipe",
		stderr: "pipe",
	});
	expect(resolved.exitCode, resolved.stderr.toString()).toBe(0);
	expect(resolved.stdout.toString().trim()).toBe(liveStorageRoot);
});

test("guard refuses an explicitly configured root with no matching project key", () => {
	const refused = Bun.spawnSync(["sh", gate, "--resolve-root"], {
		cwd: fixture,
		env: { ...baseEnv, AGENT_MAIL_STORAGE_ROOT: wrongStorageRoot },
		stdout: "pipe",
		stderr: "pipe",
	});
	expect(refused.exitCode, refused.stdout.toString()).not.toBe(0);
	expect(refused.stderr.toString()).toContain("no Agent Mail archive matches this Git project");
});
