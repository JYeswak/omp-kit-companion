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

function candidateTree(root: string, relativePath: string, contents: string, label: string): string {
	const indexPath = join(root, ".git", `candidate-${label}.index`);
	const candidatePath = join(root, ".git", `candidate-${label}.txt`);
	writeFileSync(candidatePath, contents);
	const blob = sh(root, "hash-object", "-w", candidatePath).stdout.trim();
	const runWithIndex = (...args: string[]): string => {
		const child = Bun.spawnSync(["env", `GIT_INDEX_FILE=${indexPath}`, "git", ...args],
			{ cwd: root, stdout: "pipe", stderr: "pipe" });
		if (child.exitCode !== 0) {
			throw new Error(`git ${args.join(" ")} failed: ${child.stderr.toString().slice(0, 300)}`);
		}
		return child.stdout.toString().trim();
	};
	runWithIndex("read-tree", "HEAD");
	runWithIndex("update-index", "--add", "--cacheinfo", "100644", blob, relativePath);
	return runWithIndex("write-tree");
}

async function recordMailCandidate(fake: FakeSaveGuard, sha: string, relativePath: string): Promise<void> {
	const toolName = "mcp__mcp_agent_mail_send_message";
	const toolCallId = `receipt-${sha}`;
	const body = `private-index candidate tree ${sha} for ${relativePath}; recorded as AM49247`;
	await fake.emit("tool_call", {
		type: "tool_call",
		toolCallId,
		toolName,
		input: { thread_id: "48536", body },
	});
	await fake.emit("tool_execution_end", {
		type: "tool_execution_end",
		toolCallId,
		toolName,
		result: { details: { messageId: "AM49247" } },
		isError: false,
	});
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
test("cfsios mixed AGENTS.md hunk uses a private-index prompt", async () => {
	const { root, file, held } = cfsiosFixture();
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
	const result = await stop(fake);
	expect(result).toMatchObject({ decision: "block" });
	const reason = reasonOf(result);
	expect(reason).toContain("private GIT_INDEX_FILE");
	expect(reason).toContain("stage only this session's hunk");
	expect(reason).toContain("GIT_INDEX_FILE=<private-index> git write-tree");
	expect(reason).not.toContain("git commit --only");
	expect(reason).toContain("candidate <sha> for <repo-relative path>");
});

test("a recorded candidate must contain the hunk before it clears mixed work", async () => {
	const { root, file, base, held } = cfsiosFixture();
	const invalidTree = candidateTree(root, "AGENTS.md", base, "invalid");
	const validTree = candidateTree(root, "AGENTS.md", `${base}session-owned line\n`, "valid");
	const fake = fakePi(root);
	await kitSaveGuard(fake.pi);
	await startSession(fake);
	const insertionPoint = held.indexOf("held 95\n");
	await emitPathToolCall(fake, "edit", file, "candidate-edit");
	writeFileSync(file, `${held.slice(0, insertionPoint)}session-owned line\n${held.slice(insertionPoint)}`);
	expect(sh(root, "diff", "--numstat", "--", "AGENTS.md").stdout.trim()).toBe("189\t27\tAGENTS.md");
	await fake.emit("tool_execution_end", writeEvent("edit", {
		path: file,
		diff: "+session-owned line",
	}, false, "candidate-edit"));
	await recordMailCandidate(fake, invalidTree, "AGENTS.md");
	expect(await stop(fake)).toMatchObject({ decision: "block" });

	await recordMailCandidate(fake, validTree, "AGENTS.md");
	expect(await stop(fake)).toBeUndefined();
	expect(fake.notices).toEqual([]);
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
	expect(reason).toContain("git commit --only -m");
	expect(reason).not.toContain("private GIT_INDEX_FILE");
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
	expect(reason).toContain("git commit --only -m");
	expect(reason).not.toContain("private GIT_INDEX_FILE");
});

test("candidate with the final sequential content clears a mixed path", async () => {
	const { root, file, base, held } = cfsiosFixture();
	const candidate = candidateTree(root, "AGENTS.md", `${base}beta\n`, "sequential-final");
	const fake = fakePi(root);
	await kitSaveGuard(fake.pi);
	await startSession(fake);

	const insertionPoint = held.indexOf("held 95\n");
	await emitPathToolCall(fake, "edit", file, "mixed-alpha");
	writeFileSync(file, `${held.slice(0, insertionPoint)}alpha\n${held.slice(insertionPoint)}`);
	await fake.emit("tool_execution_end", writeEvent("edit", {
		path: file,
		diff: "@@ -95,0 +96 @@\n+alpha",
	}, false, "mixed-alpha"));

	await emitPathToolCall(fake, "edit", file, "mixed-beta");
	writeFileSync(file, `${held.slice(0, insertionPoint)}beta\n${held.slice(insertionPoint)}`);
	await fake.emit("tool_execution_end", writeEvent("edit", {
		path: file,
		diff: "@@ -96 +96 @@\n-alpha\n+beta",
	}, false, "mixed-beta"));

	await recordMailCandidate(fake, candidate, "AGENTS.md");
	expect(await stop(fake)).toBeUndefined();
	expect(fake.notices).toEqual([]);
});

test("an unreported foreign write beyond this session's hunk requires a private index", async () => {
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
	expect(result).toMatchObject({ decision: "block" });
	const reason = reasonOf(result);
	expect(reason).toContain("private GIT_INDEX_FILE");
	expect(reason).toContain("foreign-after-session.txt");
	expect(reason).not.toContain("git commit --only");
});

test("a br comments add candidate receipt clears matching owned work", async () => {
	const { root, file, base, held } = cfsiosFixture();
	const tree = candidateTree(root, "AGENTS.md", `${base}session hunk\n`, "comment-receipt");
	const fake = fakePi(root);
	await kitSaveGuard(fake.pi);
	await startSession(fake);

	const insertionPoint = held.indexOf("held 95\n");
	await emitPathToolCall(fake, "edit", file, "comment-receipt-edit");
	writeFileSync(file, `${held.slice(0, insertionPoint)}session hunk\n${held.slice(insertionPoint)}`);
	await fake.emit("tool_execution_end", writeEvent("edit", {
		path: file,
		diff: "+session hunk",
	}, false, "comment-receipt-edit"));
	const commentToolCallId = "bead-comment-receipt";
	const command = `br comments add ompkit-xa5s.3 "candidate ${tree} for AGENTS.md"`;
	await fake.emit("tool_call", {
		type: "tool_call",
		toolCallId: commentToolCallId,
		toolName: "bash",
		input: { command },
	});
	await fake.emit("tool_execution_end", {
		type: "tool_execution_end",
		toolCallId: commentToolCallId,
		toolName: "bash",
		result: { details: {} },
		isError: false,
	});

	expect(await stop(fake)).toBeUndefined();
	expect(fake.notices).toEqual([]);
});

function landOnUpstream(root: string, relativePath: string, contents: string, label: string): void {
	const tree = candidateTree(root, relativePath, contents, label);
	const commit = sh(root, "commit-tree", tree, "-p", "HEAD", "-m", `${label} [test]`).stdout.trim();
	sh(root, "push", "origin", `${commit}:refs/heads/main`);
	sh(root, "fetch", "origin");
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
	landOnUpstream(root, "AGENTS.md", landed, "landed");
	expect(sh(root, "rev-list", "--count", "HEAD..@{u}").stdout.trim()).toBe("1");

	expect(await stop(fake)).toBeUndefined();
	expect(fake.notices).toEqual([]);
});

test("a further edit after publishing upstream still blocks", async () => {
	const { root, file, fake, landed } = await sessionEditsTrackedFile();
	landOnUpstream(root, "AGENTS.md", landed, "landed-then-edited");
	writeFileSync(file, `${landed}unpublished line\n`);

	const result = await stop(fake);
	expect(result).toMatchObject({ decision: "block" });
	expect(reasonOf(result)).toContain("AGENTS.md");
});

test("a local commit whose content already landed upstream under a different sha stays silent", async () => {
	const { root, fake, landed } = await sessionEditsTrackedFile();
	landOnUpstream(root, "AGENTS.md", landed, "landed-elsewhere");
	sh(root, "commit", "-am", "redundant local duplicate [test]");
	expect(sh(root, "rev-list", "--count", "@{u}..HEAD").stdout.trim()).toBe("1");
	expect(sh(root, "status", "--porcelain").stdout).toBe("");

	expect(await stop(fake)).toBeUndefined();
	expect(fake.notices).toEqual([]);
});

test("a local commit with an extra unpushed hunk beyond the upstream copy still blocks", async () => {
	const { root, file, fake, landed } = await sessionEditsTrackedFile();
	landOnUpstream(root, "AGENTS.md", landed, "landed-then-extra");
	writeFileSync(file, `${landed}unpushed hunk\n`);
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
	writeFileSync(file, "not on origin\n");
	await fake.emit("tool_execution_end", writeEvent("write", { resolvedPath: file }));
	sh(root, "add", "no-upstream-unpushed.txt");
	sh(root, "commit", "-m", "unpushed [test]");

	const result = await stop(fake);
	expect(result).toMatchObject({ decision: "block" });
	expect(reasonOf(result)).toContain("no-upstream-unpushed.txt");
});

async function recordCommentReceipt(fake: FakeSaveGuard, command: string, toolCallId: string): Promise<void> {
	await fake.emit("tool_call", { type: "tool_call", toolCallId, toolName: "bash", input: { command } });
	await fake.emit("tool_execution_end", {
		type: "tool_execution_end",
		toolCallId,
		toolName: "bash",
		result: { details: {} },
		isError: false,
	});
}

/** cfsios-style mixed AGENTS.md: the session adds one hunk on top of held foreign work. */
async function sessionHunkOnHeldWork(fake: FakeSaveGuard, label: string): Promise<{ root: string; file: string; tree: string }> {
	const { root, file, base, held } = cfsiosFixture();
	const tree = candidateTree(root, "AGENTS.md", `${base}${label} hunk\n`, label);
	const insertionPoint = held.indexOf("held 95\n");
	await emitPathToolCall(fake, "edit", file, `${label}-edit`);
	writeFileSync(file, `${held.slice(0, insertionPoint)}${label} hunk\n${held.slice(insertionPoint)}`);
	await fake.emit("tool_execution_end", writeEvent("edit", { path: file, diff: `+${label} hunk` }, false, `${label}-edit`));
	return { root, file, tree };
}

test("a combined two-repo receipt binds each clause's sha to its own repository", async () => {
	const cwd = repo();
	const fake = fakePi(cwd);
	await kitSaveGuard(fake.pi);
	const first = await sessionHunkOnHeldWork(fake, "first");
	const second = await sessionHunkOnHeldWork(fake, "second");
	expect(await stop(fake)).toMatchObject({ decision: "block" });

	await recordCommentReceipt(fake,
		`br comments add a "candidate ${first.tree} for ${first.file}" && br comments add b "candidate ${second.tree} for ${second.file}"`,
		"combined-receipt");
	expect(await stop(fake)).toBeUndefined();
	expect(fake.notices).toEqual([]);
});

test("a receipt naming one repository's sha with another repository's path does not clear it", async () => {
	const cwd = repo();
	const fake = fakePi(cwd);
	await kitSaveGuard(fake.pi);
	const foreign = await sessionHunkOnHeldWork(fake, "foreign");
	const owned = await sessionHunkOnHeldWork(fake, "owned");
	// Clear the foreign repository with its own receipt so only the owned repository can remain.
	await recordCommentReceipt(fake, `br comments add a "candidate ${foreign.tree} for ${foreign.file}"`, "foreign-receipt");
	// The owned repository's own tree is named only for an unrelated path; its file is named only
	// beside the foreign repository's sha.
	await recordCommentReceipt(fake,
		`br comments add b "candidate ${foreign.tree} for ${owned.file}" && br comments add c "candidate ${owned.tree} for unrelated.md"`,
		"crossed-receipt");

	const result = await stop(fake);
	expect(result).toMatchObject({ decision: "block" });
	expect(reasonOf(result)).toContain(owned.root);
	expect(reasonOf(result)).not.toContain(foreign.root);
});

test("a candidate holding the session's current content clears work whose hunk is unknown", async () => {
	const { root, file, held } = cfsiosFixture();
	const fake = fakePi(root);
	await kitSaveGuard(fake.pi);
	await startSession(fake);
	const current = `${held}unsnapshotted session line\n`;
	// No tool_call snapshot: the session's own hunk is unknown, so patch containment cannot vouch.
	writeFileSync(file, current);
	await fake.emit("tool_execution_end", writeEvent("write", { resolvedPath: file }));
	expect(await stop(fake)).toMatchObject({ decision: "block" });

	const tree = candidateTree(root, "AGENTS.md", current, "current-content");
	await recordMailCandidate(fake, tree, "AGENTS.md");
	expect(await stop(fake)).toBeUndefined();
	expect(fake.notices).toEqual([]);

	writeFileSync(file, `${current}later unsaved line\n`);
	expect(await stop(fake)).toMatchObject({ decision: "block" });
});
