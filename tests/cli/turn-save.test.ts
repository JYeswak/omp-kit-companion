/**
 * UNSAVEDAGE1 (ompkit-1ra0d.205) turn-end checkpoint: at turn end the guard
 * saves this session's wholly attributed dirty paths to a private ref
 * (`refs/omp-kit/saves/<agent>`) while leaving the block-and-ask report,
 * HEAD, the index, the worktree and refs/heads untouched. A peer's dirty
 * file in the same tree stays byte-identical and unstaged.
 */
import { afterAll, beforeEach, expect, test } from "bun:test";
import { mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import kitSaveGuard, { attemptTurnSave, type SaveGuardApi, type SaveGuardContext } from "../../extensions/kit-save-guard.ts";
import { ownedTmp } from "../../src/kitlib/tmp.ts";
import { fixtureDeadlineS, runFixtureAsync } from "./fixture-process.ts";

const BEAD = "ompkit-1ra0d.205";
const ACTOR = "TurnSaver";
const SESSION = "session-1";
const REF = `refs/omp-kit/saves/${ACTOR}`;

let freshSeq = 0;
function freshDir(parent: string, prefix: string): string {
	const dir = join(parent, `${prefix}${process.pid}-${++freshSeq}`);
	mkdirSync(dir, { recursive: true });
	return dir;
}

const base = realpathSync(ownedTmp("turn-save").path);
const savedEnv = { ...process.env };

afterAll(() => {
	rmSync(base, { recursive: true, force: true });
	for (const key of ["HOME", "XDG_STATE_HOME", "BR_ACTOR", "TMPDIR", "KIT_SAVE_GUARD_CHECKPOINT"] as const) {
		if (savedEnv[key] === undefined) delete process.env[key];
		else process.env[key] = savedEnv[key];
	}
});

const home = join(base, "home");
const xdg = join(home, ".local", "state");
const tmp = join(base, "tmp");

beforeEach(() => {
	mkdirSync(home, { recursive: true });
	mkdirSync(tmp, { recursive: true });
	process.env.HOME = home;
	process.env.XDG_STATE_HOME = xdg;
	process.env.BR_ACTOR = ACTOR;
	process.env.TMPDIR = tmp;
	// No KIT_SAVE_GUARD_CHECKPOINT reset here: the mutant run sets it in the
	// outer environment and beforeEach must not wipe it. The seam-disabled
	// test sets and clears its own value; afterAll restores the saved one.
});

function spawnEnv(): Record<string, string> {
	return {
		PATH: process.env.PATH ?? "/usr/bin:/bin",
		HOME: home,
		XDG_STATE_HOME: xdg,
		BR_ACTOR: ACTOR,
		GIT_CEILING_DIRECTORIES: base,
		GIT_CONFIG_GLOBAL: "/dev/null",
		GIT_CONFIG_NOSYSTEM: "1",
		GIT_AUTHOR_NAME: "t",
		GIT_AUTHOR_EMAIL: "t@t",
		GIT_COMMITTER_NAME: "t",
		GIT_COMMITTER_EMAIL: "t@t",
		TMPDIR: tmp,
	};
}

const decode = (bytes: Uint8Array): string => new TextDecoder().decode(bytes);

type Handler = (event: unknown, ctx: SaveGuardContext) => unknown;

interface FixtureGuard {
	pi: SaveGuardApi;
	handlers: Map<string, Handler[]>;
	notices: { message: string; type?: string }[];
	ctx: SaveGuardContext;
	emit(eventName: string, event: unknown): Promise<unknown[]>;
}

function fakePi(cwd: string): FixtureGuard {
	const handlers = new Map<string, Handler[]>();
	const notices: { message: string; type?: string }[] = [];
	const ctx: SaveGuardContext = {
		cwd,
		sessionManager: { getSessionId: () => SESSION },
		ui: { notify: (message: string, type?: string) => void notices.push({ message, type }) },
	};
	const env = spawnEnv();
	const pi = {
		on: (event: string, handler: unknown) => {
			handlers.set(event, [...(handlers.get(event) ?? []), handler as Handler]);
		},
		exec: async (command: string, args: string[], options?: { cwd?: string; timeout?: number }) => {
			if (command === "am") return { code: 127, stdout: "" };
			if (command === "br") {
				return { code: 0, stdout: JSON.stringify([{ id: BEAD, status: "in_progress", assignee: ACTOR }]) };
			}
			if (command === "omp-kit") {
				return { code: 0, stdout: JSON.stringify({ data: { overall: "OK", unreleased: 0, dirs: [] } }) };
			}
			const result = await runFixtureAsync([command, ...args], {
				cwd: options?.cwd ?? cwd, env, floor_s: fixtureDeadlineS(),
			});
			return { code: result.rc ?? 127, stdout: decode(result.stdout) };
		},
	} as unknown as SaveGuardApi;
	const emit = async (eventName: string, event: unknown): Promise<unknown[]> => {
		const results: unknown[] = [];
		for (const handler of handlers.get(eventName) ?? []) results.push(await handler(event, ctx));
		return results;
	};
	return { pi, handlers, notices, ctx, emit };
}

async function git(root: string, ...args: string[]): Promise<string> {
	const result = await runFixtureAsync(["git", ...args], { cwd: root, env: spawnEnv(), floor_s: fixtureDeadlineS() });
	expect(result.rc, decode(result.stderr)).toBe(0);
	return decode(result.stdout);
}

async function gitCode(root: string, ...args: string[]): Promise<number> {
	const result = await runFixtureAsync(["git", ...args], { cwd: root, env: spawnEnv(), floor_s: fixtureDeadlineS() });
	return result.rc ?? 127;
}

async function repo(): Promise<string> {
	const root = freshDir(base, "repo-");
	await git(root, "init", "-b", "main");
	mkdirSync(join(root, ".omp"), { recursive: true });
	writeFileSync(join(root, ".omp", "fleet.json"), '{"enabled":true}\n');
	await git(root, "add", ".omp/fleet.json");
	await git(root, "commit", "-m", "fleet opt-in [test]");
	writeFileSync(join(root, "base.txt"), "base\n");
	writeFileSync(join(root, "del.txt"), "doomed\n");
	await git(root, "add", "base.txt", "del.txt");
	await git(root, "commit", "-m", "base [test]");
	return root;
}

async function claimBead(fake: FixtureGuard): Promise<void> {
	await fake.emit("tool_call", { type: "tool_call", toolCallId: "claim-1", toolName: "bash", input: {
		command: `br --db '${join(fake.ctx.cwd, ".beads", "beads.db")}' --actor ${ACTOR} update ${BEAD} --claim`,
	} });
	await fake.emit("tool_execution_end", {
		type: "tool_execution_end", toolCallId: "claim-1", toolName: "bash",
		result: { details: { exitCode: 0 } }, isError: false,
	});
}

async function ownWrite(fake: FixtureGuard, file: string, contents: string, id: string): Promise<void> {
	await fake.emit("tool_call", { type: "tool_call", toolCallId: id, toolName: "write", input: { path: file } });
	writeFileSync(file, contents);
	await fake.emit("tool_execution_end", {
		type: "tool_execution_end", toolCallId: id, toolName: "write",
		result: { details: { resolvedPath: file } }, isError: false,
	});
}

async function ownDelete(fake: FixtureGuard, file: string, id: string): Promise<void> {
	await fake.emit("tool_call", { type: "tool_call", toolCallId: id, toolName: "write", input: { path: file } });
	rmSync(file);
	await fake.emit("tool_execution_end", {
		type: "tool_execution_end", toolCallId: id, toolName: "write",
		result: { details: { resolvedPath: file } }, isError: false,
	});
}

async function stop(fake: FixtureGuard): Promise<{ decision?: string; reason?: string } | undefined> {
	const results = await fake.emit("session_stop", {
		type: "session_stop", session_id: SESSION, turn_id: "turn-1", stop_hook_active: false,
	});
	return results[0] as { decision?: string; reason?: string } | undefined;
}

test("UNSAVEDAGE1 control: seat's own files checkpoint to the private ref while main stays clean", async () => {
	const root = await repo();
	const own = join(root, "own.txt");
	const peer = join(root, "peer.txt");
	const tracked = join(root, "base.txt");
	const doomed = join(root, "del.txt");
	const fake = fakePi(root);
	await kitSaveGuard(fake.pi);
	await fake.emit("session_start", { type: "session_start" });
	await claimBead(fake);
	await ownWrite(fake, own, "own bytes\n", "write-own");
	await ownWrite(fake, tracked, "changed base\n", "write-tracked");
	await ownDelete(fake, doomed, "write-del");
	writeFileSync(peer, "peer bytes\n");
	const headBefore = (await git(root, "rev-parse", "HEAD")).trim();
	const result = await stop(fake);
	// The block-and-ask report is unchanged, with one checkpoint line appended.
	expect(result?.decision).toBe("block");
	expect(result?.reason).toContain("own.txt");
	expect(await gitCode(root, "rev-parse", "--verify", "--quiet", REF)).toBe(0);
	const saveSha = (await git(root, "rev-parse", "--verify", REF)).trim();
	expect(result?.reason).toContain(`checkpointed to ${REF} ${saveSha.slice(0, 7)}`);
	// The save tip carries the [pending] subject, the Bead trailer, and only
	// the seat's files at their current bytes; the deletion is honored.
	const subject = (await git(root, "log", "-1", "--format=%s", saveSha)).trim();
	expect(subject.startsWith("[pending]")).toBe(true);
	expect(subject).toContain("3 files");
	const body = await git(root, "log", "-1", "--format=%B", saveSha);
	const blocks = body.trim().split("\n\n").map(block => block.trim()).filter(block => block.length > 0);
	expect(blocks[blocks.length - 1]?.endsWith(`Bead: ${BEAD}`)).toBe(true);
	expect(body).toContain("own.txt");
	expect(body).not.toContain("peer.txt");
	const names = (await git(root, "ls-tree", "-r", "--name-only", saveSha)).trim().split("\n").sort();
	expect(names).toEqual([".omp/fleet.json", "base.txt", "own.txt"]);
	expect((await git(root, "show", `${saveSha}:own.txt`))).toBe("own bytes\n");
	expect((await git(root, "show", `${saveSha}:base.txt`))).toBe("changed base\n");
	expect(await gitCode(root, "ls-tree", saveSha, "--", "del.txt")).toBe(0);
	expect((await git(root, "ls-tree", saveSha, "--", "del.txt")).trim()).toBe("");
	// HEAD, refs/heads/main, the real index and the peer are all unchanged;
	// the seat's files are still dirty in the worktree.
	expect((await git(root, "rev-parse", "HEAD")).trim()).toBe(headBefore);
	expect((await git(root, "rev-parse", "refs/heads/main")).trim()).toBe(headBefore);
	expect((await git(root, "rev-list", "--count", "HEAD")).trim()).toBe("2");
	expect((await git(root, "diff", "--cached", "--name-only")).trim()).toBe("");
	expect((await git(root, "ls-files", "-s", "own.txt")).trim()).toBe("");
	expect(readFileSync(own, "utf8")).toBe("own bytes\n");
	expect((await git(root, "status", "--porcelain=v1", "--untracked-files=all", "--", "own.txt"))).toBe("?? own.txt\n");
	expect((await git(root, "status", "--porcelain=v1", "--untracked-files=all", "--", "base.txt"))).toBe(" M base.txt\n");
	expect(readFileSync(peer, "utf8")).toBe("peer bytes\n");
	expect((await git(root, "status", "--porcelain=v1", "--untracked-files=all", "--", "peer.txt")).trim()).toBe("?? peer.txt");
	// A second stop with unchanged bytes writes no new save commit.
	const again = await stop(fake);
	expect((await git(root, "rev-parse", "--verify", REF)).trim()).toBe(saveSha);
	expect(again?.reason).not.toContain("checkpointed to");
}, { timeout: fixtureDeadlineS(60) * 1000 });

test("UNSAVEDAGE1 seam-disabled: without the checkpoint no save ref exists", async () => {
	process.env.KIT_SAVE_GUARD_CHECKPOINT = "0";
	try {
		const root = await repo();
		const own = join(root, "own.txt");
		const fake = fakePi(root);
		await kitSaveGuard(fake.pi);
		await fake.emit("session_start", { type: "session_start" });
		await claimBead(fake);
		await ownWrite(fake, own, "own bytes\n", "write-own");
		const result = await stop(fake);
		expect(result?.decision).toBe("block");
		expect(result?.reason).toContain("own.txt");
		expect(await gitCode(root, "rev-parse", "--verify", "--quiet", REF)).not.toBe(0);
		expect((await git(root, "rev-list", "--count", "HEAD")).trim()).toBe("2");
	} finally {
		delete process.env.KIT_SAVE_GUARD_CHECKPOINT;
	}
}, { timeout: fixtureDeadlineS(60) * 1000 });

test("UNSAVEDAGE1 negative: a later bash write is not included in the save", async () => {
	const root = await repo();
	const own = join(root, "own.txt");
	const fake = fakePi(root);
	await kitSaveGuard(fake.pi);
	await fake.emit("session_start", { type: "session_start" });
	await claimBead(fake);
	await ownWrite(fake, own, "own bytes\n", "write-own");
	// A later unattributed (bash) write changes the bytes after the ledger row.
	writeFileSync(own, "bash bytes\n");
	const outcome = await attemptTurnSave(fake.pi.exec.bind(fake.pi),
		{ root, paths: ["own.txt"], aheadCount: 0, beadPaths: [{ bead: BEAD, paths: ["own.txt"] }] }, SESSION);
	expect(outcome.saved).toEqual([]);
	expect(outcome.skipped.map(row => row.path)).toEqual(["own.txt"]);
	expect(await gitCode(root, "rev-parse", "--verify", "--quiet", REF)).not.toBe(0);
	expect(readFileSync(own, "utf8")).toBe("bash bytes\n");
}, { timeout: fixtureDeadlineS(60) * 1000 });
