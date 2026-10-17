import { afterAll, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import kitSaveGuard, { type SaveGuardApi, type SaveGuardContext } from "./kit-save-guard";
import { check as checkFleetGit } from "../src/fleet-guard/git";
import { isMutatingCall } from "./kit-flywheel-guard";

const base = mkdtempSync(join(tmpdir(), "kit-save-guard-"));

afterAll(() => {
	rmSync(base, { recursive: true, force: true });
});

function sh(cwd: string, ...args: string[]): { code: number; stdout: string } {
	// These owned fixtures exercise save-guard, not the operator's inherited commit hooks.
	const child = Bun.spawnSync(["git", "-c", "user.name=t", "-c", "user.email=t@t",
		"-c", "init.defaultBranch=main", "-c", "core.hooksPath=/dev/null", ...args], { cwd, stdout: "pipe", stderr: "pipe" });
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
			// Native authority is unavailable unless a test supplies an explicit native-response fixture.
			// Git remains real; this bus is not evidence of an installed/native stop consumer.
			if (command === "am") return { code: 127, stdout: "" };
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


function writeEvent(toolName: string, details: unknown, isError = false, toolCallId = `${toolName}-1`): unknown {
	return {
		type: "tool_execution_end",
		toolCallId,
		toolName,
		result: { details },
		isError,
	};
}

async function emitPathToolCall(
	fake: FakeSaveGuard,
	toolName: string,
	file: string,
	toolCallId: string,
): Promise<void> {
	await fake.emit("tool_call", {
		type: "tool_call",
		toolCallId,
		toolName,
		input: { path: file },
	});
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
async function startSession(fake: FakeSaveGuard): Promise<void> {
	await fake.emit("session_start", { type: "session_start" });
	await claimFixture(fake);
}

function numberedLines(label: string, count: number): string {
	return Array.from({ length: count }, (_, index) => `${label} ${index + 1}\n`).join("");
}

function cfsiosFixture(): { root: string; file: string; base: string; held: string } {
	const root = repo({ remote: true });
	const file = join(root, "AGENTS.md");
	const base = numberedLines("base", 27);
	const held = numberedLines("held", 188);
	writeFileSync(file, base);
	sh(root, "add", "AGENTS.md");
	sh(root, "commit", "-m", "base AGENTS [test]");
	sh(root, "push");
	writeFileSync(file, held);
	expect(sh(root, "diff", "--numstat", "--", "AGENTS.md").stdout.trim()).toBe("188\t27\tAGENTS.md");
	return { root, file, base, held };
}


test("session_stop drains in-flight path attribution before checking owned work", async () => {
	const root = repo({ remote: true });
	const file = join(root, "concurrent-write.txt");
	const secondFile = join(root, "second-concurrent-write.txt");
	const fake = fakePi(root);
	await kitSaveGuard(fake.pi);
	await claimFixture(fake);
	await emitPathToolCall(fake, "write", file, "write-1");
	await emitPathToolCall(fake, "write", secondFile, "write-2");
	writeFileSync(file, "owned\n");
	writeFileSync(secondFile, "owned too\n");

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
		secondToolEvent = fake.emit("tool_execution_end", writeEvent("write", { resolvedPath: secondFile }, false, "write-2"));
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
	const fake = fakePi(root);
	await kitSaveGuard(fake.pi);
	await claimFixture(fake);
	await emitPathToolCall(fake, "write", writePath, "write-1");
	await emitPathToolCall(fake, "edit", editPath, "edit-1");
	await emitPathToolCall(fake, "ast_edit", astPath, "ast_edit-1");
	writeFileSync(writePath, "written\n");
	writeFileSync(editPath, "edited\n");
	writeFileSync(astPath, "rewritten\n");
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
	expect(offeredPaths(result)).toEqual(["ast.txt", "edit.txt", "write.txt"]);
	expect(isMutatingCall({ toolName: "bash", input: { command: reason } })).toBe(true);
	expect(reason).toContain("commit --only");
	expect(reason).not.toContain("git push");
	expect(reason).toContain("Publication qualification is UNKNOWN");
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
	await emitPathToolCall(fake, "write", file, "write-1");
	await fake.emit("tool_execution_end", writeEvent("write", { resolvedPath: file }));

	expect(await stop(fake)).toBeUndefined();
	expect(fake.notices).toEqual([]);
});


test("an unpushed commit touching an owned path blocks and reports its count", async () => {
	const root = repo({ remote: true });
	const file = join(root, "owned-commit.txt");
	const fake = fakePi(root);
	await kitSaveGuard(fake.pi);
	await claimFixture(fake);
	await emitPathToolCall(fake, "write", file, "write-1");
	writeFileSync(file, "committed but not pushed\n");
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
	const fake = fakePi(root);
	await kitSaveGuard(fake.pi);
	await claimFixture(fake);
	await emitPathToolCall(fake, "edit", file, "edit-1");
	writeFileSync(file, "unsaved\n");
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
	const fake = fakePi(root);
	await kitSaveGuard(fake.pi);
	await claimFixture(fake);
	await emitPathToolCall(fake, "write", file, "write-1");
	writeFileSync(file, "unsaved\n");
	await fake.emit("tool_execution_end", writeEvent("write", { resolvedPath: file }));
	await shutdown(fake);

	expect(fake.notices).toHaveLength(1);
	expect(fake.notices[0]?.type).toBe("warning");
	expect(fake.notices[0]?.message).toContain("shutdown-only.txt");
});
/** cfsios-style mixed AGENTS.md: the session inserts one line inside held foreign work. */
async function sessionLineOnHeldWork(): Promise<{ root: string; file: string; base: string; fake: FakeSaveGuard }> {
	const { root, file, base, held } = cfsiosFixture();
	const fake = fakePi(root);
	await kitSaveGuard(fake.pi);
	await startSession(fake);
	const insertionPoint = held.indexOf("held 95\n");
	await emitPathToolCall(fake, "edit", file, "cfsios-edit");
	writeFileSync(file, `${held.slice(0, insertionPoint)}session-owned line\n${held.slice(insertionPoint)}`);
	expect(sh(root, "diff", "--numstat", "--", "AGENTS.md").stdout.trim()).toBe("189\t27\tAGENTS.md");
	await fake.emit("tool_execution_end", writeEvent("edit", {
		path: file,
		diff: "+session-owned line",
	}, false, "cfsios-edit"));
	return { root, file, base, fake };
}

test("cfsios mixed AGENTS.md hunk blocks", async () => {
	const { fake } = await sessionLineOnHeldWork();
	const result = await stop(fake);
	expect(result).toMatchObject({ decision: "block" });
	expect(reasonOf(result)).toContain("AGENTS.md");
});

test("a bead comment recording a candidate sha does not silence mixed unpublished work", async () => {
	const { root, base, fake } = await sessionLineOnHeldWork();
	const sha = publishFromClone(root, { "AGENTS.md": `${base}session-owned line\n` }, "side-candidate", "side-candidate");
	const toolCallId = "bead-comment-candidate";
	const command = `br comments add ompkit-xa5s.3 "candidate ${sha} for AGENTS.md"`;
	await fake.emit("tool_call", { type: "tool_call", toolCallId, toolName: "bash", input: { command } });
	await fake.emit("tool_execution_end", {
		type: "tool_execution_end",
		toolCallId,
		toolName: "bash",
		result: { details: {} },
		isError: false,
	});

	const result = await stop(fake);
	expect(result).toMatchObject({ decision: "block" });
	expect(reasonOf(result)).toContain("AGENTS.md");
});

test("mixed work goes silent once origin main holds the session's hunk while the peer hunk stays local", async () => {
	const { root, base, fake } = await sessionLineOnHeldWork();
	publishFromClone(root, {
		"AGENTS.md": `${base}session-owned line\n`,
		"unrelated.txt": "peer-published change\n",
	}, "hunk-on-origin");
	expect(sh(root, "diff", "--numstat", "--", "AGENTS.md").stdout).not.toBe("");
	expect(sh(root, "--literal-pathspecs", "diff", "--numstat", "@{u}", "--", "AGENTS.md").stdout).not.toBe("");
	expect(await stop(fake)).toBeUndefined();
	expect(fake.notices).toEqual([]);
});

test("mixed work still blocks when origin main's commit lacks the session's hunk", async () => {
	const { root, base, fake } = await sessionLineOnHeldWork();
	publishFromClone(root, {
		"AGENTS.md": `${base}some other line\n`,
		"unrelated.txt": "peer-published change\n",
	}, "other-hunk-on-origin");
	const result = await stop(fake);
	expect(result).toMatchObject({ decision: "block" });
	expect(reasonOf(result)).toContain("AGENTS.md");
});

test("a wholly owned tracked file keeps the plain commit-only prompt", async () => {
	const root = repo({ remote: true });
	const file = join(root, "AGENTS.md");
	const base = "base line\n";
	writeFileSync(file, base);
	sh(root, "add", "AGENTS.md");
	sh(root, "commit", "-m", "base AGENTS [test]");
	sh(root, "push");
	const fake = fakePi(root);
	await kitSaveGuard(fake.pi);
	await startSession(fake);
	await emitPathToolCall(fake, "edit", file, "plain-edit");
	writeFileSync(file, `${base}session-owned line\n`);
	await fake.emit("tool_execution_end", writeEvent("edit", {
		path: file,
		diff: "+session-owned line",
	}, false, "plain-edit"));
	const result = await stop(fake);
	expect(result).toMatchObject({ decision: "block" });
	const reason = reasonOf(result);
	expect(isMutatingCall({ toolName: "bash", input: { command: reason } })).toBe(true);
	expect(reason).toContain("commit --only");
});
test("sequential edits compose to the final content and keep the plain commit-only prompt", async () => {
	const root = repo({ remote: true });
	const file = join(root, "sequential.txt");
	writeFileSync(file, "");
	sh(root, "add", "sequential.txt");
	sh(root, "commit", "-m", "base sequential file [test]");
	sh(root, "push");
	const fake = fakePi(root);
	await kitSaveGuard(fake.pi);
	await startSession(fake);

	await emitPathToolCall(fake, "edit", file, "sequential-alpha");
	writeFileSync(file, "alpha\n");
	await fake.emit("tool_execution_end", writeEvent("edit", {
		path: file,
		diff: "@@ -0,0 +1 @@\n+alpha",
	}, false, "sequential-alpha"));

	await emitPathToolCall(fake, "edit", file, "sequential-beta");
	writeFileSync(file, "beta\n");
	await fake.emit("tool_execution_end", writeEvent("edit", {
		path: file,
		diff: "@@ -1 +1 @@\n-alpha\n+beta",
	}, false, "sequential-beta"));

	const result = await stop(fake);
	expect(result).toMatchObject({ decision: "block" });
	const reason = reasonOf(result);
	expect(isMutatingCall({ toolName: "bash", input: { command: reason } })).toBe(true);
	expect(reason).toContain("commit --only");
});

test("an unreported foreign write is omitted instead of authorizing a whole-file commit", async () => {
	const root = repo({ remote: true });
	const file = join(root, "foreign-after-session.txt");
	const baseline = "base\n";
	writeFileSync(file, baseline);
	sh(root, "add", "foreign-after-session.txt");
	sh(root, "commit", "-m", "base foreign-after-session [test]");
	sh(root, "push");
	const fake = fakePi(root);
	await kitSaveGuard(fake.pi);
	await startSession(fake);

	await emitPathToolCall(fake, "edit", file, "owned-hunk");
	writeFileSync(file, `${baseline}session hunk\n`);
	await fake.emit("tool_execution_end", writeEvent("edit", {
		path: file,
		diff: "+session hunk",
	}, false, "owned-hunk"));

	// No tool_call or tool_execution_end represents this second writer.
	writeFileSync(file, `${baseline}session hunk\nforeign write\n`);

	const result = await stop(fake);
	expect(result).toBeUndefined();
	expect(fake.notices).toHaveLength(1);
	expect(fake.notices[0]?.message).toContain("foreign-after-session.txt");
	expect(fake.notices[0]?.message).toContain("current bytes differ");
	expect(isMutatingCall({ toolName: "bash", input: { command: fake.notices[0]?.message } })).toBe(false);
});

/** Commit `files` on top of origin's `ref` from a separate clone, push it, and fetch it into `root`. */
function publishFromClone(root: string, files: Record<string, string | null>, label: string, ref = "main"): string {
	const bare = sh(root, "remote", "get-url", "origin").stdout.trim();
	const clone = mkdtempSync(join(base, `clone-${label}-`));
	sh(clone, "clone", "--quiet", bare, ".");
	for (const [relativePath, contents] of Object.entries(files)) {
		if (contents === null) rmSync(join(clone, relativePath));
		else writeFileSync(join(clone, relativePath), contents);
		sh(clone, "add", "--", relativePath);
	}
	sh(clone, "commit", "-m", `${label} [test]`);
	sh(clone, "push", "origin", `HEAD:refs/heads/${ref}`);
	sh(root, "fetch", "origin");
	return sh(clone, "rev-parse", "HEAD").stdout.trim();
}

async function sessionEditsTrackedFile(): Promise<{ root: string; file: string; fake: FakeSaveGuard; landed: string }> {
	const root = repo({ remote: true });
	const file = join(root, "AGENTS.md");
	const base = "base line\n";
	writeFileSync(file, base);
	sh(root, "add", "AGENTS.md");
	sh(root, "commit", "-m", "base AGENTS [test]");
	sh(root, "push");
	const fake = fakePi(root);
	await kitSaveGuard(fake.pi);
	await startSession(fake);
	await emitPathToolCall(fake, "edit", file, "landed-edit");
	const landed = `${base}session-owned line\n`;
	writeFileSync(file, landed);
	await fake.emit("tool_execution_end", writeEvent("edit", { path: file, diff: "+session-owned line" }, false, "landed-edit"));
	return { root, file, fake, landed };
}

test("owned work already published on upstream stays silent while local main lags behind", async () => {
	const { root, fake, landed } = await sessionEditsTrackedFile();
	publishFromClone(root, { "AGENTS.md": landed }, "landed");
	expect(sh(root, "rev-list", "--count", "HEAD..@{u}").stdout.trim()).toBe("1");

	expect(await stop(fake)).toBeUndefined();
	expect(fake.notices).toEqual([]);
});

test("a further edit after publishing upstream still blocks", async () => {
	const { root, file, fake, landed } = await sessionEditsTrackedFile();
	publishFromClone(root, { "AGENTS.md": landed }, "landed-then-edited");
	await emitPathToolCall(fake, "edit", file, "after-publish");
	writeFileSync(file, `${landed}unpublished line\n`);
	await fake.emit("tool_execution_end", writeEvent("edit", { path: file }, false, "after-publish"));

	const result = await stop(fake);
	expect(result).toMatchObject({ decision: "block" });
	expect(reasonOf(result)).toContain("AGENTS.md");
});

test("a local commit whose content already landed upstream under a different sha stays silent", async () => {
	const { root, fake, landed } = await sessionEditsTrackedFile();
	publishFromClone(root, { "AGENTS.md": landed }, "landed-elsewhere");
	sh(root, "commit", "-am", "redundant local duplicate [test]");
	expect(sh(root, "rev-list", "--count", "@{u}..HEAD").stdout.trim()).toBe("1");
	expect(sh(root, "status", "--porcelain").stdout).toBe("");

	expect(await stop(fake)).toBeUndefined();
	expect(fake.notices).toEqual([]);
});

test("a local commit with an extra unpushed hunk beyond the upstream copy still blocks", async () => {
	const { root, file, fake, landed } = await sessionEditsTrackedFile();
	publishFromClone(root, { "AGENTS.md": landed }, "landed-then-extra");
	await emitPathToolCall(fake, "edit", file, "extra-before-commit");
	writeFileSync(file, `${landed}unpushed hunk\n`);
	await fake.emit("tool_execution_end", writeEvent("edit", { path: file }, false, "extra-before-commit"));
	sh(root, "commit", "-am", "extra hunk [test]");

	const result = await stop(fake);
	expect(result).toMatchObject({ decision: "block" });
	expect(reasonOf(result)).toContain("ahead=1");
	expect(reasonOf(result)).toContain("AGENTS.md");
});

test("a branch without upstream stays silent once its commit is in origin/main", async () => {
	const root = repo({ remote: true });
	sh(root, "branch", "--unset-upstream");
	const file = join(root, "no-upstream.txt");
	const fake = fakePi(root);
	await kitSaveGuard(fake.pi);
	await startSession(fake);
	await emitPathToolCall(fake, "write", file, "write-1");
	writeFileSync(file, "landed without upstream\n");
	await fake.emit("tool_execution_end", writeEvent("write", { resolvedPath: file }));
	sh(root, "add", "no-upstream.txt");
	sh(root, "commit", "-m", "landed [test]");
	sh(root, "push", "origin", "main");
	expect(Bun.spawnSync(["git", "rev-parse", "--verify", "@{u}"], { cwd: root }).exitCode).not.toBe(0);

	expect(await stop(fake)).toBeUndefined();
	expect(fake.notices).toEqual([]);
});

test("a branch without upstream still blocks on a commit missing from origin/main", async () => {
	const root = repo({ remote: true });
	sh(root, "branch", "--unset-upstream");
	const file = join(root, "no-upstream-unpushed.txt");
	const fake = fakePi(root);
	await kitSaveGuard(fake.pi);
	await startSession(fake);
	await emitPathToolCall(fake, "write", file, "write-1");
	writeFileSync(file, "not on origin\n");
	await fake.emit("tool_execution_end", writeEvent("write", { resolvedPath: file }));
	sh(root, "add", "no-upstream-unpushed.txt");
	sh(root, "commit", "-m", "unpushed [test]");

	const result = await stop(fake);
	expect(result).toMatchObject({ decision: "block" });
	expect(reasonOf(result)).toContain("no-upstream-unpushed.txt");
});

/** The first paths clause is the actionable set; omitted paths remain diagnostic only. */
function offeredPaths(result: unknown): string[] {
	const reason = reasonOf(result);
	const start = reason.indexOf(" paths [");
	if (start < 0) return [];
	const begin = start + " paths ".length;
	// A literal ']' in a filename is not the end of the JSON paths clause.
	for (let end = reason.indexOf("]", begin); end >= 0; end = reason.indexOf("]", end + 1)) {
		try {
			const paths: unknown = JSON.parse(reason.slice(begin, end + 1));
			if (Array.isArray(paths) && paths.every(path => typeof path === "string")) return paths;
		} catch { /* try the next complete JSON boundary */ }
	}
	return [];
}

async function ownWrite(fake: FakeSaveGuard, file: string, contents: string | Uint8Array, id = file): Promise<void> {
	await emitPathToolCall(fake, "write", file, id);
	writeFileSync(file, contents);
	await fake.emit("tool_execution_end", writeEvent("write", { resolvedPath: file }, false, id));
}

test("OWNER1 a: twenty read paths and one actual edit offer exactly one path", async () => {
	const root = repo({ remote: true });
	for (let index = 0; index < 20; index++) writeFileSync(join(root, `read-${index}.txt`), "peer bytes\n");
	sh(root, "add", ".");
	sh(root, "commit", "-m", "read fixtures [test]");
	sh(root, "push");
	const fake = fakePi(root);
	await kitSaveGuard(fake.pi);
	await startSession(fake);
	for (let index = 0; index < 20; index++) {
		const file = join(root, `read-${index}.txt`);
		await fake.emit("tool_call", { toolCallId: `read-${index}`, toolName: "read", input: { path: file } });
		await fake.emit("tool_execution_end", writeEvent("read", { path: file }, false, `read-${index}`));
	}
	await ownWrite(fake, join(root, "read-7.txt"), "session bytes\n");
	expect(offeredPaths(await stop(fake))).toEqual(["read-7.txt"]);
});

test("OWNER1 b: peer replacement removes the old owned path from save commands", async () => {
	const root = repo({ remote: true });
	const fake = fakePi(root);
	await kitSaveGuard(fake.pi);
	await startSession(fake);
	const file = join(root, "old-owned.txt");
	await ownWrite(fake, file, "my old bytes\n");
	writeFileSync(file, "peer replacement\n");
	expect(await stop(fake)).toBeUndefined();
	expect(fake.notices).toHaveLength(1);
	expect(fake.notices[0]?.message).toContain("old-owned.txt");
	expect(fake.notices[0]?.message).toContain("current bytes differ");
	expect(isMutatingCall({ toolName: "bash", input: { command: fake.notices[0]?.message } })).toBe(false);
	await stop(fake, true);
	expect(fake.notices).toHaveLength(1);
});

test("OWNER1 c: locally created then origin-retired file is archive-or-drop, never commit", async () => {
	const root = repo({ remote: true });
	const fake = fakePi(root);
	await kitSaveGuard(fake.pi);
	await startSession(fake);
	await ownWrite(fake, join(root, "retired.txt"), "session-created\n");
	publishFromClone(root, { "retired.txt": "session-created\n" }, "publish-created");
	publishFromClone(root, { "retired.txt": null }, "retire-created");
	expect(await stop(fake)).toBeUndefined();
	expect(fake.notices).toHaveLength(1);
	expect(fake.notices[0]?.message).toContain("retired.txt");
	expect(fake.notices[0]?.message).toContain("retired upstream: archive (refs/preserve) or drop");
	expect(isMutatingCall({ toolName: "bash", input: { command: fake.notices[0]?.message } })).toBe(false);
});

test("OWNER1 d: twenty-five historical writes with two current own files offer exactly two", async () => {
	const root = repo({ remote: true });
	const fake = fakePi(root);
	await kitSaveGuard(fake.pi);
	await startSession(fake);
	for (let index = 0; index < 25; index++) {
		const file = join(root, `historical-${index}.txt`);
		await ownWrite(fake, file, `session ${index}\n`);
		if (index !== 3 && index !== 21) writeFileSync(file, `peer ${index}\n`);
	}
	const result = await stop(fake);
	expect(offeredPaths(result)).toEqual(["historical-21.txt", "historical-3.txt"]);
	for (let index = 0; index < 25; index++) {
		if (index !== 3 && index !== 21) expect(reasonOf(result)).toContain(`"historical-${index}.txt": current bytes differ`);
	}
	const commands = reasonOf(result).split(";").filter(command => isMutatingCall({ toolName: "bash", input: { command } }));
	expect(commands).toHaveLength(1);
	expect(commands[0]).toContain("'historical-21.txt' 'historical-3.txt'");
});

test("successful no-op writes and result-only events cannot manufacture ownership", async () => {
	const root = repo({ remote: true });
	const file = join(root, "no-op.txt");
	writeFileSync(file, "pre-existing foreign bytes\n");
	const fake = fakePi(root);
	await kitSaveGuard(fake.pi);
	await startSession(fake);
	await ownWrite(fake, file, "pre-existing foreign bytes\n");
	expect(await stop(fake)).toBeUndefined();
	await fake.emit("tool_execution_end", writeEvent("write", { resolvedPath: file }, false, "no-before"));
	expect(await stop(fake)).toBeUndefined();
	expect(fake.notices[0]?.message).toContain("write attribution unavailable");
	expect(isMutatingCall({ toolName: "bash", input: { command: fake.notices[0]?.message } })).toBe(false);
});

test("byte attribution distinguishes invalid UTF-8 bytes that decode to the same text", async () => {
	const root = repo({ remote: true });
	const file = join(root, "binary.dat");
	const fake = fakePi(root);
	await kitSaveGuard(fake.pi);
	await startSession(fake);
	await ownWrite(fake, file, new Uint8Array([0xff]));
	writeFileSync(file, new Uint8Array([0xfe]));
	expect(await stop(fake)).toBeUndefined();
	expect(fake.notices[0]?.message).toContain("current bytes differ");
});

test("native current foreign-holder view routes dirty files without a write or save demand", async () => {
	const root = repo({ remote: true });
	const file = join(root, "held.txt");
	writeFileSync(file, "peer half-finished work\n");
	const fake = fakePi(root);
	const gitExec = fake.pi.exec.bind(fake.pi);
	fake.pi.exec = async (command, args, options) => command === "am"
		? { code: 0, stdout: JSON.stringify({
			reservation_read_attestation: { state: "current", database_matches_server: true, storage_root_matches_server: true },
			all_active: [{ agent: "PeerHolder", path: "held.txt", exclusive: true, remaining_seconds: 300 }],
		}) }
		: gitExec(command, args, options);
	await kitSaveGuard(fake.pi);
	await startSession(fake);
	expect(await stop(fake)).toBeUndefined();
	expect(fake.notices[0]?.message).toContain("held by PeerHolder");
	expect(isMutatingCall({ toolName: "bash", input: { command: fake.notices[0]?.message } })).toBe(false);
});

test("a peer write during queued repository lookup is not captured as this session's result", async () => {
	const root = repo({ remote: true });
	const file = join(root, "queued.txt");
	const fake = fakePi(root);
	await kitSaveGuard(fake.pi);
	await claimFixture(fake);
	await emitPathToolCall(fake, "write", file, "queued-write");
	writeFileSync(file, "session result\n");
	let entered!: () => void;
	let release!: () => void;
	const lookupStarted = new Promise<void>(resolve => { entered = resolve; });
	const lookupReleased = new Promise<void>(resolve => { release = resolve; });
	const gitExec = fake.pi.exec.bind(fake.pi);
	fake.pi.exec = async (command, args, options) => {
		if (command === "git" && args.includes("--show-toplevel")) {
			entered();
			await lookupReleased;
		}
		return gitExec(command, args, options);
	};
	const resultEvent = fake.emit("tool_execution_end", writeEvent("write", { resolvedPath: file }, false, "queued-write"));
	await lookupStarted;
	writeFileSync(file, "peer result during lookup\n");
	release();
	await resultEvent;
	expect(await stop(fake)).toBeUndefined();
	expect(fake.notices[0]?.message).toContain("current bytes differ");
});

test("an unattested foreign-holder response cannot suppress a real known-byte save", async () => {
	const root = repo({ remote: true });
	const file = join(root, "still-owned.txt");
	const fake = fakePi(root);
	const gitExec = fake.pi.exec.bind(fake.pi);
	fake.pi.exec = async (command, args, options) => command === "am"
		? { code: 0, stdout: JSON.stringify({
			reservation_read_attestation: { state: "stale", database_matches_server: false, storage_root_matches_server: false },
			all_active: [{ agent: "StalePeer", path: "still-owned.txt", exclusive: true, remaining_seconds: 300 }],
		}) }
		: gitExec(command, args, options);
	await kitSaveGuard(fake.pi);
	await startSession(fake);
	await ownWrite(fake, file, "current own bytes\n");
	const result = await stop(fake);
	expect(offeredPaths(result)).toEqual(["still-owned.txt"]);
	expect(isMutatingCall({ toolName: "bash", input: { command: reasonOf(result) } })).toBe(true);
	expect(reasonOf(result)).toContain("commit --only");
	expect(reasonOf(result)).not.toContain("held by StalePeer");
	expect(reasonOf(result)).not.toContain("git push");
});

/** Native CLI response fixture only: production executes bounded read-only br commands. */
async function claimFixture(fake: FakeSaveGuard, id = "fixture-open"): Promise<{ setStatus(status: string): void }> {
	const row = { id, status: "in_progress", assignee: "FixtureOwner" };
	const previous = fake.pi.exec.bind(fake.pi);
	fake.pi.exec = async (command, args, options) => {
		if (command === "br" && args[args.indexOf("show") + 1] === id) {
			expect(args).toContain("--no-auto-import");
			expect(args).toContain("--no-auto-flush");
			return { code: 0, stdout: JSON.stringify([row]) };
		}
		return previous(command, args, options);
	};
	const toolCallId = `claim-${id}`;
	await fake.emit("tool_call", { toolCallId, toolName: "bash", input: {
		command: `br --db '${join(fake.ctx.cwd, ".beads", "beads.db")}' --actor FixtureOwner update ${id} --claim`,
	} });
	await fake.emit("tool_execution_end", writeEvent("bash", { exitCode: 0 }, false, toolCallId));
	return { setStatus: status => { row.status = status; } };
}

test("a closed native bead removes still-current own bytes from all save commands", async () => {
	const root = repo({ remote: true });
	const fake = fakePi(root);
	await kitSaveGuard(fake.pi);
	await fake.emit("session_start", { type: "session_start" });
	const bead = await claimFixture(fake);
	await ownWrite(fake, join(root, "closed.txt"), "owned bytes\n");
	bead.setStatus("closed");
	expect(await stop(fake)).toBeUndefined();
	expect(fake.notices[0]?.message).toContain("fixture-open is closed, not open");
	expect(isMutatingCall({ toolName: "bash", input: { command: fake.notices[0]?.message } })).toBe(false);
});

test("known open-bead saves stay separate instead of spanning two native beads", async () => {
	const root = repo({ remote: true });
	const fake = fakePi(root);
	await kitSaveGuard(fake.pi);
	await startSession(fake);
	await ownWrite(fake, join(root, "first-bead.txt"), "first\n");
	await claimFixture(fake, "fixture-second");
	await ownWrite(fake, join(root, "second-bead.txt"), "second\n");
	const result = await stop(fake);
	expect(offeredPaths(result)).toEqual(["first-bead.txt", "second-bead.txt"]);
	const commands = reasonOf(result).split(";").filter(command => isMutatingCall({ toolName: "bash", input: { command } }));
	expect(commands).toHaveLength(2);
	expect(commands[0]).toContain("'first-bead.txt'");
	expect(commands[0]).not.toContain("'second-bead.txt'");
	expect(commands[1]).toContain("'second-bead.txt'");
	expect(commands[1]).not.toContain("'first-bead.txt'");
});

test("writes to one file under two native beads require whole-file owner handoff", async () => {
	const root = repo({ remote: true });
	const fake = fakePi(root);
	await kitSaveGuard(fake.pi);
	await startSession(fake);
	const file = join(root, "cross-bead.txt");
	await ownWrite(fake, file, "first bead\n");
	await claimFixture(fake, "fixture-second");
	await ownWrite(fake, file, "second bead\n");
	expect(await stop(fake)).toBeUndefined();
	expect(fake.notices[0]?.message).toContain("writes span native beads");
	expect(isMutatingCall({ toolName: "bash", input: { command: fake.notices[0]?.message } })).toBe(false);
});

test("a current exact native lease holder with an open bead retains the real local-save positive", async () => {
	const root = repo({ remote: true });
	const fake = fakePi(root);
	const previous = fake.pi.exec.bind(fake.pi);
	fake.pi.exec = async (command, args, options) => command === "am"
		? { code: 0, stdout: JSON.stringify({
			reservation_read_attestation: { state: "current", database_matches_server: true, storage_root_matches_server: true },
			all_active: [{ agent: "FixtureOwner", path: "holder.txt", exclusive: true, remaining_seconds: 300 }],
		}) }
		: previous(command, args, options);
	await kitSaveGuard(fake.pi);
	await startSession(fake);
	await ownWrite(fake, join(root, "holder.txt"), "holder's current own bytes\n");
	const result = await stop(fake);
	expect(offeredPaths(result)).toEqual(["holder.txt"]);
	expect(isMutatingCall({ toolName: "bash", input: { command: reasonOf(result) } })).toBe(true);
	expect(reasonOf(result)).toContain("commit --only");
	expect(reasonOf(result)).not.toContain("git push");
});

test("an actual byte write without a native bead binding is explained, never offered as commit", async () => {
	const root = repo({ remote: true });
	const fake = fakePi(root);
	await kitSaveGuard(fake.pi);
	await fake.emit("session_start", { type: "session_start" });
	await ownWrite(fake, join(root, "unbound.txt"), "actual session bytes\n");
	expect(await stop(fake)).toBeUndefined();
	expect(fake.notices[0]?.message).toContain("no native open-bead association");
	expect(isMutatingCall({ toolName: "bash", input: { command: fake.notices[0]?.message } })).toBe(false);
});

test("resumed native actors bind one active bead but never guess between two", async () => {
	const previousActor = process.env.BR_ACTOR;
	const previousDb = process.env.BEADS_DB;
	try {
		process.env.BR_ACTOR = "FixtureOwner";
		for (const [count, protocol] of [[1, "envelope"], [2, "envelope"], [1, "legacy-array"], [2, "legacy-array"]] as const) {
			const root = repo({ remote: true });
			process.env.BEADS_DB = join(root, "native-tracker.db");
			const fake = fakePi(root);
			const previous = fake.pi.exec.bind(fake.pi);
			fake.pi.exec = async (command, args, options) => {
				if (command !== "br") return previous(command, args, options);
				expect(args).toContain("--no-auto-import");
				expect(args).toContain("--no-auto-flush");
				const rows = Array.from({ length: args.includes("list") ? count : 1 }, (_, index) => ({
					id: `resumed-${index}`, status: "in_progress", assignee: "FixtureOwner",
				}));
				return { code: 0, stdout: JSON.stringify(args.includes("list") && protocol === "envelope"
					? { issues: rows, total: rows.length, limit: 2, offset: 0, has_more: false }
					: rows) };
			};
			await kitSaveGuard(fake.pi);
			await fake.emit("session_start", { type: "session_start" });
			await ownWrite(fake, join(root, "resumed.txt"), "resumed own bytes\n");
			const result = await stop(fake);
			if (count === 1) {
				expect(offeredPaths(result)).toEqual(["resumed.txt"]);
				expect(isMutatingCall({ toolName: "bash", input: { command: reasonOf(result) } })).toBe(true);
				expect(reasonOf(result)).toContain("commit --only");
			} else {
				expect(result).toBeUndefined();
				expect(fake.notices[0]?.message).toContain("no native open-bead association");
			}
		}
	} finally {
		if (previousActor === undefined) delete process.env.BR_ACTOR;
		else process.env.BR_ACTOR = previousActor;
		if (previousDb === undefined) delete process.env.BEADS_DB;
		else process.env.BEADS_DB = previousDb;
	}
});

test("native resume refuses partial or inconsistent list pages even with one visible issue", async () => {
	const previousActor = process.env.BR_ACTOR;
	const previousDb = process.env.BEADS_DB;
	const row = { id: "partial-list", status: "in_progress", assignee: "FixtureOwner" };
	const complete = { issues: [row], total: 1, limit: 2, offset: 0, has_more: false };
	const { has_more: _hasMore, ...missingHasMore } = complete;
	const { offset: _offset, ...missingOffset } = complete;
	try {
		process.env.BR_ACTOR = "FixtureOwner";
		for (const page of [
			{ ...complete, has_more: true },
			{ ...complete, offset: 1 },
			{ ...complete, total: 2 },
			missingHasMore,
			missingOffset,
		]) {
			const root = repo({ remote: true });
			process.env.BEADS_DB = join(root, "native-tracker.db");
			const fake = fakePi(root);
			const previous = fake.pi.exec.bind(fake.pi);
			fake.pi.exec = async (command, args, options) => command === "br"
				? { code: 0, stdout: JSON.stringify(args.includes("list") ? page : [row]) }
				: previous(command, args, options);
			await kitSaveGuard(fake.pi);
			await fake.emit("session_start", { type: "session_start" });
			await ownWrite(fake, join(root, "partial.txt"), "actual own bytes with incomplete native attribution\n");
			expect(await stop(fake)).toBeUndefined();
			expect(fake.notices[0]?.message).toContain("no native open-bead association");
			expect(isMutatingCall({ toolName: "bash", input: { command: fake.notices[0]?.message } })).toBe(false);
		}
	} finally {
		if (previousActor === undefined) delete process.env.BR_ACTOR;
		else process.env.BR_ACTOR = previousActor;
		if (previousDb === undefined) delete process.env.BEADS_DB;
		else process.env.BEADS_DB = previousDb;
	}
});

test("a failed native claim cannot leave the old bead attached to later writes", async () => {
	const root = repo({ remote: true });
	const fake = fakePi(root);
	await kitSaveGuard(fake.pi);
	await startSession(fake);
	const toolCallId = "failed-claim";
	await fake.emit("tool_call", { toolCallId, toolName: "bash", input: {
		command: `br --db '${join(root, ".beads", "beads.db")}' --actor FixtureOwner update refused-bead --claim`,
	} });
	await fake.emit("tool_execution_end", writeEvent("bash", { exitCode: 1 }, false, toolCallId));
	await ownWrite(fake, join(root, "after-refusal.txt"), "new task bytes\n");
	expect(await stop(fake)).toBeUndefined();
	expect(fake.notices[0]?.message).toContain("no native open-bead association");
	expect(isMutatingCall({ toolName: "bash", input: { command: fake.notices[0]?.message } })).toBe(false);
});

test("native glob reservations also prevent a foreign dirty-path save demand", async () => {
	const root = repo({ remote: true });
	mkdirSync(join(root, "held"), { recursive: true });
	writeFileSync(join(root, "held", "peer.txt"), "peer bytes\n");
	const fake = fakePi(root);
	const previous = fake.pi.exec.bind(fake.pi);
	fake.pi.exec = async (command, args, options) => command === "am"
		? { code: 0, stdout: JSON.stringify({
			reservation_read_attestation: { state: "current", database_matches_server: true, storage_root_matches_server: true },
			all_active: [{ agent: "GlobHolder", path: "held/**", exclusive: true, remaining_seconds: 300 }],
		}) }
		: previous(command, args, options);
	await kitSaveGuard(fake.pi);
	await startSession(fake);
	expect(await stop(fake)).toBeUndefined();
	expect(fake.notices[0]?.message).toContain('"held/peer.txt": held by GlobHolder');
	expect(isMutatingCall({ toolName: "bash", input: { command: fake.notices[0]?.message } })).toBe(false);
});

test("red and stale native tip-CI rows name the run but never authorize a push", async () => {
	for (const stale of [false, true]) {
		const root = repo({ remote: true });
		const head = sh(root, "rev-parse", "HEAD").stdout.trim();
		sh(root, "remote", "set-url", "origin", "https://github.com/Fixture/Repo.git");
		const fake = fakePi(root);
		const previous = fake.pi.exec.bind(fake.pi);
		fake.pi.exec = async (command, args, options) => command === "omp-kit"
			? { code: 0, stdout: JSON.stringify({ ok: true, data: { repos: {
				"Fixture/Repo": { stale, runs: [{
					id: 9001, sha: head, status: "completed", conclusion: "failure", stale,
				}] },
			} } }) }
			: previous(command, args, options);
		await kitSaveGuard(fake.pi);
		await startSession(fake);
		await ownWrite(fake, join(root, "ci-blocked.txt"), "owned but unpublished\n");
		const result = await stop(fake);
		expect(offeredPaths(result)).toEqual(["ci-blocked.txt"]);
		expect(reasonOf(result)).toContain(stale ? "CI UNKNOWN/stale run 9001" : "CI RED run 9001");
		expect(reasonOf(result)).not.toContain("git push");
	}
});

test("offered per-bead recipe saves a new own file without restaging tracked or peer bytes", async () => {
	const root = repo({ remote: true });
	const peerPaths = ["peer-staged.txt", "literal-peer.txt", "bracketa.txt"];
	for (const file of ["tracked-own.txt", "peer-unstaged.txt", ...peerPaths]) {
		writeFileSync(join(root, file), "baseline\n");
	}
	sh(root, "add", ".");
	sh(root, "commit", "-m", "recipe baseline [test]");
	sh(root, "push");
	// The emitted recipe executes verbatim in this owned fixture, with fixture-local identity/hooks.
	sh(root, "config", "user.name", "Save Guard Recipe Fixture");
	sh(root, "config", "user.email", "fixture@example.invalid");
	sh(root, "config", "core.hooksPath", "/dev/null");
	const fake = fakePi(root);
	await kitSaveGuard(fake.pi);
	await startSession(fake);

	await ownWrite(fake, join(root, "tracked-own.txt"), "own intermediate index bytes\n");
	sh(root, "add", "--", "tracked-own.txt");
	await ownWrite(fake, join(root, "tracked-own.txt"), "own final working bytes\n");
	await ownWrite(fake, join(root, "already-staged.txt"), "own staged creation\n");
	sh(root, "add", "--", "already-staged.txt");
	await ownWrite(fake, join(root, "already-staged.txt"), "own final staged creation\n");
	const newFile = "new owned's file.txt";
	await ownWrite(fake, join(root, newFile), "new own bytes\n");
	const globOwn = "literal*.txt";
	const bracketOwn = "bracket[ab].txt";
	await ownWrite(fake, join(root, globOwn), "literal wildcard own bytes\n");
	await ownWrite(fake, join(root, bracketOwn), "literal bracket own bytes\n");

	for (const file of peerPaths) {
		writeFileSync(join(root, file), `peer index bytes: ${file}\n`);
		sh(root, "add", "--", file);
		writeFileSync(join(root, file), `peer working bytes beyond index: ${file}\n`);
	}
	writeFileSync(join(root, "peer-unstaged.txt"), "peer unstaged bytes\n");
	const peerUntrackedFile = "literal-new-peer.txt";
	writeFileSync(join(root, peerUntrackedFile), "peer untracked bytes\n");
	const trackedIndex = sh(root, "rev-parse", ":tracked-own.txt").stdout;
	const stagedCreationIndex = sh(root, "rev-parse", ":already-staged.txt").stdout;
	const peerIndex = sh(root, "diff", "--cached", "--binary", "--", ...peerPaths).stdout;
	const peerWorking = sh(root, "diff", "--binary", "--", ...peerPaths, "peer-unstaged.txt").stdout;
	const peerUntracked = sh(root, "hash-object", "--", peerUntrackedFile).stdout;

	const result = await stop(fake);
	const expectedPaths = ["already-staged.txt", bracketOwn, globOwn, newFile, "tracked-own.txt"].sort();
	expect(offeredPaths(result)).toEqual(expectedPaths);
	expect(reasonOf(result)).not.toContain("git push");
	const commands = reasonOf(result).split(";").map(step => step.trim()).filter(step => step.startsWith("git "));
	expect(commands.some(command => command.includes(" commit --only "))).toBe(true);
	expect(commands.every(command => command.includes(" add -- ") || command.includes(" commit --only "))).toBe(true);
	for (const command of commands) {
		if (command.includes(" commit --only ")) {
			const previousAgent = process.env.AGENT_NAME;
			try {
				delete process.env.AGENT_NAME;
				expect(checkFleetGit({ command }, { cwd: root })).toMatchObject({ block: true });
			} finally {
				if (previousAgent === undefined) delete process.env.AGENT_NAME;
				else process.env.AGENT_NAME = previousAgent;
			}
		}
		const child = Bun.spawnSync(["sh", "-c", command.replace("<msg> [level]", "save attributed fixture [test]")],
			{ cwd: root, stdout: "pipe", stderr: "pipe" });
		expect({ code: child.exitCode, stdout: child.stdout.toString(), stderr: child.stderr.toString() }).toMatchObject({ code: 0 });
		if (command.includes(" add -- ")) {
			expect(sh(root, "rev-parse", ":tracked-own.txt").stdout).toBe(trackedIndex);
			expect(sh(root, "rev-parse", ":already-staged.txt").stdout).toBe(stagedCreationIndex);
			expect(sh(root, "diff", "--cached", "--binary", "--", ...peerPaths).stdout).toBe(peerIndex);
		}
	}

	expect(sh(root, "show", `HEAD:${newFile}`).stdout).toBe("new own bytes\n");
	expect(sh(root, "show", "HEAD:tracked-own.txt").stdout).toBe("own final working bytes\n");
	expect(sh(root, "show", "HEAD:already-staged.txt").stdout).toBe("own final staged creation\n");
	expect(sh(root, "show", `HEAD:${globOwn}`).stdout).toBe("literal wildcard own bytes\n");
	expect(sh(root, "show", `HEAD:${bracketOwn}`).stdout).toBe("literal bracket own bytes\n");
	expect(sh(root, "diff-tree", "--no-commit-id", "--name-only", "-r", "HEAD").stdout.trim().split("\n").sort())
		.toEqual(expectedPaths);
	expect(sh(root, "diff", "--cached", "--binary", "--", ...peerPaths).stdout).toBe(peerIndex);
	expect(sh(root, "diff", "--binary", "--", ...peerPaths, "peer-unstaged.txt").stdout).toBe(peerWorking);
	expect(sh(root, "hash-object", "--", peerUntrackedFile).stdout).toBe(peerUntracked);
	expect(sh(root, "status", "--porcelain=v1", "--", peerUntrackedFile).stdout).toBe(`?? ${peerUntrackedFile}\n`);
});
