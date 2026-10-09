import { afterAll, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import kitSaveGuard, { type SaveGuardApi, type SaveGuardContext } from "./kit-save-guard";

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

type Handler = (event: unknown, ctx: SaveGuardContext) => unknown;

interface FakeContext extends SaveGuardContext {
	sessionManager: { getSessionId(): string };
}

interface FakeSaveGuard {
	pi: SaveGuardApi;
	handlers: Map<string, Handler[]>;
	notices: { message: string; type?: string }[];
	ctx: FakeContext;
	emit(eventName: string, event: unknown): Promise<unknown[]>;
}


function fakePi(cwd: string): FakeSaveGuard {
	const handlers = new Map<string, Handler[]>();
	const notices: { message: string; type?: string }[] = [];
	const ctx: FakeContext = {
		cwd,
		sessionManager: { getSessionId: () => "session-1" },
		ui: { notify: (message: string, type?: string) => void notices.push({ message, type }) },
	};
	const pi = {
		on: (event: string, handler: unknown) => {
			handlers.set(event, [...(handlers.get(event) ?? []), handler as Handler]);
		},
		exec: async (command: string, args: string[], options?: { cwd?: string; timeout?: number }) => {
			const child = Bun.spawnSync([command, ...args],
				{ cwd: options?.cwd, stdout: "pipe", stderr: "pipe" });
			return { stdout: child.stdout.toString(), code: child.exitCode ?? 127 };
		},
	} as unknown as SaveGuardApi;
	const emit = async (eventName: string, event: unknown): Promise<unknown[]> => {
		const results: unknown[] = [];
		for (const handler of handlers.get(eventName) ?? []) results.push(await handler(event, ctx));
		return results;
	};
	return { pi, handlers, notices, ctx, emit };
}


function writeEvent(toolName: string, details: unknown, isError = false): unknown {
	return {
		type: "tool_execution_end",
		toolCallId: `${toolName}-1`,
		toolName,
		result: { details },
		isError,
	};
}

async function stop(fake: FakeSaveGuard, stopHookActive = false): Promise<unknown> {
	const results = await fake.emit("session_stop", {
		type: "session_stop",
		session_id: "session-1",
		turn_id: "turn-1",
		stop_hook_active: stopHookActive,
	});
	return results[0];
}

async function shutdown(fake: FakeSaveGuard): Promise<void> {
	await fake.emit("session_shutdown", { type: "session_shutdown" });
}

function reasonOf(result: unknown): string {
	if (typeof result !== "object" || result === null || !("reason" in result) || typeof result.reason !== "string") {
		return "";
	}
	return result.reason;
}

test("session_stop drains in-flight path attribution before checking owned work", async () => {
	const root = repo({ remote: true });
	const file = join(root, "concurrent-write.txt");
	const secondFile = join(root, "second-concurrent-write.txt");
	writeFileSync(file, "owned\n");
	writeFileSync(secondFile, "owned too\n");
	const fake = fakePi(root);
	await kitSaveGuard(fake.pi);

	let signalEntered!: () => void;
	const entered = new Promise<void>(resolve => { signalEntered = resolve; });
	let releaseLookup!: () => void;
	const lookup = new Promise<void>(resolve => { releaseLookup = resolve; });
	const originalExec = fake.pi.exec.bind(fake.pi);
	fake.pi.exec = async (command, args, options) => {
		if (command === "git" && args.includes("--show-toplevel")) {
			signalEntered();
			await lookup;
		}
		return originalExec(command, args, options);
	};

	const toolEvent = fake.emit("tool_execution_end", writeEvent("write", { resolvedPath: file }));
	const eventState = await Promise.race([
		entered.then(() => "path lookup started"),
		toolEvent.then(() => "tool event completed"),
	]);
	const stopEvent = stop(fake);
	let secondToolEvent: Promise<unknown[]> | undefined;
	if (eventState === "path lookup started") {
		secondToolEvent = fake.emit("tool_execution_end", writeEvent("write", { resolvedPath: secondFile }));
	}
	releaseLookup();
	await Promise.all([toolEvent, ...(secondToolEvent ? [secondToolEvent] : [])]);

	const result = await stopEvent;
	expect(result).toMatchObject({ decision: "block" });
	expect(reasonOf(result)).toContain("concurrent-write.txt");
	if (eventState === "path lookup started") {
		expect(reasonOf(result)).toContain("second-concurrent-write.txt");
	}
});


test("re-prompts for this session's write, edit, and applied ast_edit paths", async () => {
	const root = repo({ remote: true });
	const writePath = join(root, "write.txt");
	const editPath = join(root, "edit.txt");
	const astPath = join(root, "ast.txt");
	writeFileSync(writePath, "written\n");
	writeFileSync(editPath, "edited\n");
	writeFileSync(astPath, "rewritten\n");
	const fake = fakePi(root);
	await kitSaveGuard(fake.pi);
	await fake.emit("tool_execution_end", writeEvent("write", { resolvedPath: writePath }));
	await fake.emit("tool_execution_end", writeEvent("edit", { path: editPath, diff: "+edited" }));
	await fake.emit("tool_execution_end", writeEvent("ast_edit", {
		applied: true,
		searchPath: root,
		fileReplacements: [{ path: "ast.txt", count: 1 }],
	}));

	const result = await stop(fake);
	expect(result).toMatchObject({ decision: "block" });
	const reason = reasonOf(result);
	expect(reason).toContain(root);
	expect(reason).toContain("write.txt");
	expect(reason).toContain("edit.txt");
	expect(reason).toContain("ast.txt");
	expect(reason).toContain("ahead=0");
	expect(reason).toContain("reserve");
	expect(reason).toContain('git commit --only -m "<msg> [level]" --');
	expect(reason).toContain("git push");
	expect(reason).toContain("release");
});

test("foreign dirty files, failed writes, and commits do not block this session", async () => {
	const root = repo({ remote: true });
	writeFileSync(join(root, "foreign-dirty.txt"), "other session\n");
	writeFileSync(join(root, "foreign-commit.txt"), "other session commit\n");
	sh(root, "add", "foreign-commit.txt");
	sh(root, "commit", "-m", "foreign [test]");
	const fake = fakePi(root);
	await kitSaveGuard(fake.pi);
	await fake.emit("tool_execution_end", writeEvent("write", {
		resolvedPath: join(root, "foreign-dirty.txt"),
	}, true));

	expect(await stop(fake)).toBeUndefined();
	expect(fake.notices).toEqual([]);
});

test("ignored paths and var/agent-tmp paths do not count as owned work", async () => {
	const root = repo({ remote: true });
	writeFileSync(join(root, ".gitignore"), "ignored.txt\n");
	sh(root, "add", ".gitignore");
	sh(root, "commit", "-m", "ignore fixture [test]");
	sh(root, "push");
	const ignoredPath = join(root, "ignored.txt");
	const tempPath = join(root, "var", "agent-tmp", "session", "scratch.txt");
	mkdirSync(join(root, "var", "agent-tmp", "session"), { recursive: true });
	writeFileSync(ignoredPath, "ignored\n");
	writeFileSync(tempPath, "scratch\n");
	const fake = fakePi(root);
	await kitSaveGuard(fake.pi);
	await fake.emit("tool_execution_end", writeEvent("write", { resolvedPath: ignoredPath }));
	await fake.emit("tool_execution_end", writeEvent("write", { resolvedPath: tempPath }));

	expect(await stop(fake)).toBeUndefined();
	expect(fake.notices).toEqual([]);
});

test("committed and pushed owned work stays silent", async () => {
	const root = repo({ remote: true });
	const file = join(root, "published.txt");
	writeFileSync(file, "published\n");
	const fake = fakePi(root);
	await kitSaveGuard(fake.pi);
	await fake.emit("tool_execution_end", writeEvent("write", { resolvedPath: file }));
	sh(root, "add", "published.txt");
	sh(root, "commit", "-m", "published [test]");
	sh(root, "push");

	expect(await stop(fake)).toBeUndefined();
	expect(fake.notices).toEqual([]);
});
test("a pre-existing unpushed commit is not attributed to this session", async () => {
	const root = repo({ remote: true });
	const file = join(root, "pre-existing.txt");
	writeFileSync(file, "pre-existing\n");
	sh(root, "add", "pre-existing.txt");
	sh(root, "commit", "-m", "pre-existing [test]");
	const fake = fakePi(root);
	await kitSaveGuard(fake.pi);
	await fake.emit("tool_execution_end", writeEvent("write", { resolvedPath: file }));

	expect(await stop(fake)).toBeUndefined();
	expect(fake.notices).toEqual([]);
});


test("an unpushed commit touching an owned path blocks and reports its count", async () => {
	const root = repo({ remote: true });
	const file = join(root, "owned-commit.txt");
	writeFileSync(file, "committed but not pushed\n");
	const fake = fakePi(root);
	await kitSaveGuard(fake.pi);
	await fake.emit("tool_execution_end", writeEvent("write", { resolvedPath: file }));
	sh(root, "add", "owned-commit.txt");
	sh(root, "commit", "-m", "owned [test]");

	const result = await stop(fake);
	expect(result).toMatchObject({ decision: "block" });
	expect(reasonOf(result)).toContain("ahead=1");
	expect(reasonOf(result)).toContain("owned-commit.txt");
});

test("third stop attempt warns once and shutdown remains a backstop", async () => {
	const root = repo({ remote: true });
	const file = join(root, "still-dirty.txt");
	writeFileSync(file, "unsaved\n");
	const fake = fakePi(root);
	await kitSaveGuard(fake.pi);
	await fake.emit("tool_execution_end", writeEvent("edit", { path: file, diff: "+unsaved" }));

	expect(await stop(fake, false)).toMatchObject({ decision: "block" });
	expect(await stop(fake, true)).toMatchObject({ decision: "block" });
	expect(await stop(fake, true)).toBeUndefined();
	expect(fake.notices).toHaveLength(1);
	expect(fake.notices[0]?.type).toBe("warning");
	expect(fake.notices[0]?.message).toContain("still-dirty.txt");

	await shutdown(fake);
	expect(fake.notices).toHaveLength(1);
});

test("shutdown warns about owned dirty work when no stop hook runs", async () => {
	const root = repo({ remote: true });
	const file = join(root, "shutdown-only.txt");
	writeFileSync(file, "unsaved\n");
	const fake = fakePi(root);
	await kitSaveGuard(fake.pi);
	await fake.emit("tool_execution_end", writeEvent("write", { resolvedPath: file }));
	await shutdown(fake);

	expect(fake.notices).toHaveLength(1);
	expect(fake.notices[0]?.type).toBe("warning");
	expect(fake.notices[0]?.message).toContain("shutdown-only.txt");
});
