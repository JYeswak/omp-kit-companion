import { afterAll, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import kitSaveGuard, { checkSaveState, type SaveGuardContext } from "./kit-save-guard";

const base = mkdtempSync(join(tmpdir(), "kit-save-guard-"));

afterAll(() => {
	rmSync(base, { recursive: true, force: true });
});

function sh(cwd: string, ...args: string[]): { code: number; stdout: string } {
	const child = Bun.spawnSync(["git", "-c", "user.name=t", "-c", "user.email=t@t",
		"-c", "init.defaultBranch=main", ...args], { cwd, stdout: "pipe", stderr: "pipe" });
	if (child.exitCode !== 0) throw new Error(`git ${args.join(" ")} failed: ${child.stderr.toString().slice(0, 300)}`);
	return { code: child.exitCode ?? 1, stdout: child.stdout.toString() };
}

/** Throwaway repo; withRemote wires a local bare upstream and pushes main. */
function repo(opts: { remote?: boolean } = {}): string {
	const root = mkdtempSync(join(base, "repo-"));
	sh(root, "init");
	sh(root, "commit", "--allow-empty", "-m", "init [test]");
	if (opts.remote) {
		const bare = mkdtempSync(join(base, "bare-"));
		sh(bare, "init", "--bare");
		sh(root, "remote", "add", "origin", bare);
		sh(root, "push", "-u", "origin", "main");
	}
	return root;
}

type Handler = (event: { type: "session_shutdown" }, ctx: SaveGuardContext) => unknown;

function fakePi(cwd: string) {
	const handlers = new Map<string, Handler[]>();
	const notices: { message: string; type?: string }[] = [];
	const pi = {
		on: (event: string, handler: Handler) => void handlers.set(event, [...(handlers.get(event) ?? []), handler]),
		exec: async (command: string, args: string[], options?: { cwd?: string; timeout?: number }) => {
			const child = Bun.spawnSync([command, ...args],
				{ cwd: options?.cwd, stdout: "pipe", stderr: "pipe" });
			return { stdout: child.stdout.toString(), code: child.exitCode ?? 127 };
		},
	};
	const ctx = { cwd, ui: { notify: (message: string, type?: string) => void notices.push({ message, type }) } };
	return { pi, handlers, notices, ctx };
}

async function shutdownNotices(cwd: string): Promise<{ message: string; type?: string }[]> {
	const { pi, handlers, notices, ctx } = fakePi(cwd);
	await kitSaveGuard(pi);
	const shutdown = handlers.get("session_shutdown") ?? [];
	expect(shutdown.length).toBe(1);
	const started = Date.now();
	for (const handler of shutdown) await handler({ type: "session_shutdown" }, ctx);
	return { notices, elapsedMs: Date.now() - started };
}

test("clean repo with upstream stays silent", async () => {
	const { notices } = await shutdownNotices(repo({ remote: true }));
	expect(notices).toEqual([]);
});

test("dirty repo warns naming the file count", async () => {
	const root = repo({ remote: true });
	writeFileSync(join(root, "a.txt"), "dirty\n");
	const { notices } = await shutdownNotices(root);
	expect(notices).toHaveLength(1);
	expect(notices[0]?.type).toBe("warning");
	expect(notices[0]?.message).toContain("1 uncommitted file");
	expect(notices[0]?.message).toContain(root);
});

test("ahead repo warns naming the commit count", async () => {
	const root = repo({ remote: true });
	writeFileSync(join(root, "b.txt"), "ahead\n");
	sh(root, "add", "b.txt");
	sh(root, "commit", "-m", "ahead [test]");
	const { notices } = await shutdownNotices(root);
	expect(notices).toHaveLength(1);
	expect(notices[0]?.message).toContain("1 commit(s) ahead of origin/main");
});

test("repo without upstream warns", async () => {
	const root = repo();
	const { notices } = await shutdownNotices(root);
	expect(notices).toHaveLength(1);
	expect(notices[0]?.message).toContain("no upstream for main");
});

test("non-git cwd stays silent", async () => {
	const dir = mkdtempSync(join(base, "plain-"));
	const { notices } = await shutdownNotices(dir);
	expect(notices).toEqual([]);
});

test("shutdown check settles inside the 200 ms budget", async () => {
	const root = repo({ remote: true });
	writeFileSync(join(root, "c.txt"), "timing\n");
	const started = Date.now();
	const warning = await checkSaveState(async (command, args, options) => {
		const child = Bun.spawnSync([command, ...args], { cwd: options?.cwd, stdout: "pipe", stderr: "pipe" });
		return { stdout: child.stdout.toString(), code: child.exitCode ?? 127 };
	}, root);
	const elapsedMs = Date.now() - started;
	expect(warning).toContain("1 uncommitted file");
	expect(elapsedMs).toBeLessThan(200);
});

test("guard errors never block shutdown", async () => {
	const { pi, handlers, notices } = fakePi(mkdtempSync(join(base, "plain-")));
	await kitSaveGuard({ ...pi, exec: async () => { throw new Error("boom"); } });
	const shutdown = handlers.get("session_shutdown") ?? [];
	for (const handler of shutdown) await handler({ type: "session_shutdown" }, { cwd: "", ui: { notify: () => void notices.push({ message: "x" }) } });
	expect(notices).toEqual([]);
});
