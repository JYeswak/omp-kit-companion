import { afterAll, expect, test } from "bun:test";
import type { Subprocess } from "bun";
import { chmodSync, existsSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { cleanupAllOwnedTmp, ownedTmp } from "../../src/kitlib/tmp";

const WRAPPER = join(import.meta.dir, "../../scripts/kit-commit.py");
const CLI = join(import.meta.dir, "../../src/cli.ts");

function git(root: string, args: string[], env?: Record<string, string>): { code: number; out: string; err: string } {
	const p = Bun.spawnSync(["git", ...args], {
		cwd: root, stdout: "pipe", stderr: "pipe", stdin: "ignore",
		env: { ...process.env, ...env },
	});
	return { code: p.exitCode, out: p.stdout.toString(), err: p.stderr.toString() };
}

function fixture(label: string, hook: string | null): string {
	const root = realpathSync(ownedTmp(label).path);
	expect(git(root, ["init", "-q"]).code).toBe(0);
	expect(git(root, ["config", "user.email", "t@e.invalid"]).code).toBe(0);
	expect(git(root, ["config", "user.name", "t"]).code).toBe(0);
	if (hook !== null) {
		const hookPath = join(root, ".git", "hooks", "pre-commit");
		writeFileSync(hookPath, hook);
		chmodSync(hookPath, 0o755);
	}
	return root;
}

async function exitedText(proc: Subprocess): Promise<{ code: number; out: string; err: string }> {
	await proc.exited;
	const [out, err] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
	return { code: proc.exitCode, out, err };
}

test("planted GITLOCK1: two concurrent wrapper commits both land with zero lock errors", async () => {
	const root = fixture("kit-commit-race", "#!/bin/sh\nsleep 4\n");
	try {
		writeFileSync(join(root, "A"), "a1\n");
		writeFileSync(join(root, "B"), "b1\n");
		expect(git(root, ["add", "A", "B"]).code).toBe(0);
		const env = { ...process.env };
		const p1 = Bun.spawn(["python3", WRAPPER, "commit", "--only", "A", "-m", "one [test]"], { cwd: root, stdout: "pipe", stderr: "pipe", stdin: "ignore", env });
		const p2 = Bun.spawn(["python3", WRAPPER, "commit", "--only", "B", "-m", "two [test]"], { cwd: root, stdout: "pipe", stderr: "pipe", stdin: "ignore", env });
		const [r1, r2] = await Promise.all([exitedText(p1), exitedText(p2)]);
		expect({ one: r1.code, two: r2.code }).toEqual({ one: 0, two: 0 });
		expect(r1.out + r1.err + r2.out + r2.err).not.toContain("index.lock");
		const log = git(root, ["log", "--format=%s"]);
		expect(log.code).toBe(0);
		expect(log.out).toContain("one [test]");
		expect(log.out).toContain("two [test]");
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
}, 120_000);

test("planted GITLOCK1: commit TERM-killed during its pre-commit hook leaves no index.lock", async () => {
	const root = fixture("kit-commit-killed", "#!/bin/sh\n# Hold .git/index.lock like a hook-spawned git command (the outer\n# commit itself holds no lock during hooks on modern git): sleep keeps the\n# stdin pipe open so update-index blocks holding the lock.\nsleep 30 | git update-index --stdin\n");
	const shim = realpathSync(ownedTmp("kit-commit-shim").path);
	try {
		writeFileSync(join(root, "A"), "a1\n");
		expect(git(root, ["add", "A"]).code).toBe(0);
		// PATH omp-kit delegating to the workspace CLI, so the wrapper's
		// termination path exercises graceful child shutdown and the gated reaper.
		const ompKit = join(shim, "omp-kit");
		writeFileSync(ompKit, `#!/bin/sh\nexec "${process.execPath}" run "${CLI}" "$@"\n`);
		chmodSync(ompKit, 0o755);
		const env = { ...process.env, PATH: `${shim}:${process.env.PATH}`, HOME: root };
		const proc = Bun.spawn(["python3", WRAPPER, "commit", "-m", "killed [test]"], { cwd: root, stdout: "pipe", stderr: "pipe", stdin: "ignore", env });
		const lock = join(root, ".git", "index.lock");
		// Live git holder: fake timers cannot work, the lock appears on the platform clock.
		const { promise: appeared, resolve: markAppeared } = Promise.withResolvers<void>();
		const poll = async () => {
			for (let i = 0; i < 100 && !existsSync(lock); i++) await new Promise((resolve) => setTimeout(resolve, 100));
			markAppeared();
		};
		await poll();
		await appeared;
		expect(existsSync(lock)).toBe(true);
		proc.kill("SIGTERM");
		const result = await exitedText(proc);
		expect(result.code).toBe(143);
		expect(existsSync(lock)).toBe(false);
	} finally {
		rmSync(root, { recursive: true, force: true });
		rmSync(shim, { recursive: true, force: true });
	}
}, 120_000);

test("planted GITLOCK1: one transient lock collision is retried, not surfaced", async () => {
	const root = fixture("kit-commit-retry", null);
	const shim = realpathSync(ownedTmp("kit-commit-gitshim").path);
	try {
		const realGit = Bun.spawnSync(["sh", "-c", "command -v git"], { stdout: "pipe", stderr: "ignore", stdin: "ignore" }).stdout.toString().trim();
		expect(realGit).not.toBe("");
		writeFileSync(join(root, "A"), "a1\n");
		expect(git(root, ["add", "A"]).code).toBe(0);
		// PATH git fails the first commit with git's lock text, then delegates.
		writeFileSync(join(shim, "git"), `#!/bin/sh
if [ "$1" = "commit" ] && [ ! -e "${shim}/failed-once" ]; then
  touch "${shim}/failed-once"
  echo "error: Unable to create '${root}/.git/index.lock': File exists" >&2
  exit 128
fi
echo "git $*" >> "${shim}/calls.log"
exec "${realGit}" "$@"
`);
		chmodSync(join(shim, "git"), 0o755);
		const env = { ...process.env, PATH: `${shim}:${process.env.PATH}` };
		const proc = Bun.spawn(["python3", WRAPPER, "--retries", "1", "commit", "-m", "retried [test]"], { cwd: root, stdout: "pipe", stderr: "pipe", stdin: "ignore", env });
		const result = await exitedText(proc);
		expect(result.code).toBe(0);
		expect(result.out + result.err).not.toContain("index.lock");
		const calls = readFileSync(join(shim, "calls.log"), "utf8").split("\n").filter((line) => line.startsWith("git commit"));
		expect(calls.length).toBe(1);
		expect(existsSync(join(shim, "failed-once"))).toBe(true);
		expect(git(root, ["log", "--format=%s"]).out).toContain("retried [test]");
	} finally {
		rmSync(root, { recursive: true, force: true });
		rmSync(shim, { recursive: true, force: true });
	}
}, 120_000);

afterAll(() => cleanupAllOwnedTmp());
