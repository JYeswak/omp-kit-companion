/**
 * kit-write-ledger tests (ompkit-52p3 OWN1-LEDGER): every agent write is
 * attributed, so uncommitted bytes in a shared checkout always have an author.
 */
import { afterAll, beforeEach, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import kitSaveGuard, { omitPeerLedgerPaths, type SaveGuardApi, type SaveGuardContext } from "./kit-save-guard";
import {
	appendLedgerEntry,
	censusDirtyPaths,
	isCurrentSessionWriter,
	lastWriters,
	ledgerFileFor,
	ledgerStateRoot,
	resolveLedgerAgent,
	type WriteLedgerEntry,
} from "./kit-write-ledger";

// realpath: macOS /var -> /private/var would otherwise desync the guard's
// lexical cwd keys from git's physical toplevel and silently skip attribution.
const base = realpathSync(mkdtempSync(join(tmpdir(), "kit-write-ledger-")));
const savedEnv = { ...process.env };

afterAll(() => {
	rmSync(base, { recursive: true, force: true });
	process.env.HOME = savedEnv.HOME;
	process.env.XDG_STATE_HOME = savedEnv.XDG_STATE_HOME;
	process.env.BR_ACTOR = savedEnv.BR_ACTOR;
});

beforeEach(() => {
	process.env.HOME = join(base, "home");
	process.env.XDG_STATE_HOME = join(base, "home", ".local", "state");
	process.env.BR_ACTOR = "LedgerAgent";
	mkdirSync(process.env.HOME, { recursive: true });
});

function stateRoot(): string {
	const root = ledgerStateRoot(process.env.HOME, process.env.XDG_STATE_HOME);
	if (!root) throw new Error("test state root unavailable");
	return root;
}

function sh(cwd: string, ...args: string[]): void {
	const child = Bun.spawnSync(["git", "-c", "user.name=t", "-c", "user.email=t@t",
		"-c", "init.defaultBranch=main", "-c", "core.hooksPath=/dev/null", ...args],
		{ cwd, stdout: "pipe", stderr: "pipe" });
	if (child.exitCode !== 0) throw new Error(`git ${args.join(" ")} failed`);
}

function fleetRepo(): string {
	const root = mkdtempSync(join(base, "repo-"));
	sh(root, "init");
	mkdirSync(join(root, ".omp"));
	writeFileSync(join(root, ".omp", "fleet.json"), '{"enabled":true}\n');
	sh(root, "add", ".omp/fleet.json");
	sh(root, "commit", "-m", "fleet opt-in [test]");
	return root;
}

type Handler = (event: unknown, ctx: SaveGuardContext) => unknown;

interface FakeSaveGuard {
	pi: SaveGuardApi;
	handlers: Map<string, Handler[]>;
	notices: { message: string; type?: string }[];
	ctx: SaveGuardContext;
	emit(eventName: string, event: unknown): Promise<unknown[]>;
}

function fakePi(cwd: string): FakeSaveGuard {
	const handlers = new Map<string, Handler[]>();
	const notices: { message: string; type?: string }[] = [];
	const ctx: SaveGuardContext = {
		cwd,
		sessionManager: { getSessionId: () => "session-1" },
		ui: { notify: (message: string, type?: string) => void notices.push({ message, type }) },
	};
	const pi = {
		on: (event: string, handler: unknown) => {
			handlers.set(event, [...(handlers.get(event) ?? []), handler as Handler]);
		},
		exec: async (command: string, args: string[], options?: { cwd?: string; timeout?: number }) => {
			if (command === "am") return { code: 127, stdout: "" };
			// Scratch disposal is operator-global state, not this bead's
			// subject: report it unavailable so stops decide on file findings.
			if (command === "omp-kit") throw new Error("scratch is not under test");
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
	return { type: "tool_execution_end", toolCallId, toolName, result: { details }, isError };
}

async function claimFixture(fake: FakeSaveGuard): Promise<void> {
	const row = { id: "fixture-open", status: "in_progress", assignee: "LedgerAgent" };
	const previous = fake.pi.exec.bind(fake.pi);
	fake.pi.exec = async (command, args, options) => {
		if (command === "br" && args[args.indexOf("show") + 1] === "fixture-open") {
			return { code: 0, stdout: JSON.stringify([row]) };
		}
		return previous(command, args, options);
	};
	await fake.emit("tool_call", { toolCallId: "claim-1", toolName: "bash", input: {
		command: `br --db '${join(fake.ctx.cwd, ".beads", "beads.db")}' --actor LedgerAgent update fixture-open --claim`,
	} });
	await fake.emit("tool_execution_end", writeEvent("bash", { exitCode: 0 }, false, "claim-1"));
}

async function plantEntry(root: string, relpath: string, agent: string, session: string, blob: string | null): Promise<void> {
	const entry: WriteLedgerEntry = {
		v: 1, repo: root, relpath, agent, session, ts: new Date().toISOString(), blob,
	};
	expect(appendLedgerEntry(stateRoot(), entry).ok).toBe(true);
}

test("AC1: a planted edit by agent A lands in the ledger with A, A's session and the blob", async () => {
	const root = fleetRepo();
	const file = join(root, "shared.txt");
	writeFileSync(file, "base\n");
	sh(root, "add", "shared.txt");
	sh(root, "commit", "-m", "base [test]");
	const fake = fakePi(root);
	await kitSaveGuard(fake.pi);
	await fake.emit("session_start", { type: "session_start" });
	await fake.emit("tool_call", { type: "tool_call", toolCallId: "write-1", toolName: "write", input: { path: file } });
	writeFileSync(file, "agent A bytes\n");
	await fake.emit("tool_execution_end", writeEvent("write", { resolvedPath: file }, false, "write-1"));
	const writers = lastWriters(stateRoot(), root);
	const last = writers.get("shared.txt");
	expect(last?.agent).toBe("LedgerAgent");
	expect(last?.session).toBe("session-1");
	const blob = createHash("sha256").update(readFileSync(file)).digest("hex");
	expect(last?.blob).toBe(blob);
	// Census attributes the dirty path to A while A is live.
	const census = censusDirtyPaths(stateRoot(), root, ["shared.txt"], () => true);
	expect(census.get("shared.txt")).toEqual({ kind: "writer", agent: "LedgerAgent", session: "session-1" });
});

test("AC1 negative: a path with no ledger entry stays unattributed, never guessed", () => {
	const root = fleetRepo();
	const census = censusDirtyPaths(stateRoot(), root, ["never-touched.txt"], () => true);
	expect(census.get("never-touched.txt")).toEqual({ kind: "unattributed" });
});

test("AC2: when A's session ends, the path resolves to the owner of record by rule", async () => {
	const root = fleetRepo();
	await plantEntry(root, "shared.txt", "DeadWriter", "session-9", "deadblob");
	const census = censusDirtyPaths(stateRoot(), root, ["shared.txt"], () => false);
	expect(census.get("shared.txt")).toEqual({ kind: "rule" });
	expect(isCurrentSessionWriter(lastWriters(stateRoot(), root).get("shared.txt"), "session-1")).toBe(false);
});

test("AC2 negative: a live writer still resolves to the writer, not the rule", async () => {
	const root = fleetRepo();
	await plantEntry(root, "shared.txt", "LiveWriter", "session-1", "liveblob");
	const census = censusDirtyPaths(stateRoot(), root, ["shared.txt"],
		(agent, session) => agent === "LiveWriter" && session === "session-1");
	expect(census.get("shared.txt")).toEqual({ kind: "writer", agent: "LiveWriter", session: "session-1" });
});

test("AC3: a peer's leased edit produces no save demand", async () => {
	const root = fleetRepo();
	const file = join(root, "shared.txt");
	writeFileSync(file, "base\n");
	sh(root, "add", "shared.txt");
	sh(root, "commit", "-m", "base [test]");
	const fake = fakePi(root);
	await kitSaveGuard(fake.pi);
	await fake.emit("session_start", { type: "session_start" });
	await claimFixture(fake);
	await fake.emit("tool_call", { type: "tool_call", toolCallId: "write-1", toolName: "write", input: { path: file } });
	writeFileSync(file, "my bytes\n");
	await fake.emit("tool_execution_end", writeEvent("write", { resolvedPath: file }, false, "write-1"));
	// Plant the QuietBadger case: a peer's leased edit lands after mine, so the
	// ledger's last writer is another session.
	const blob = createHash("sha256").update(readFileSync(file)).digest("hex");
	await plantEntry(root, "shared.txt", "QuietBadger", "session-9", blob);
	const results = await fake.emit("session_stop", {
		type: "session_stop", session_id: "session-1", turn_id: "turn-1", stop_hook_active: false,
	});
	expect(results[0]).toBeUndefined();
	await fake.emit("session_shutdown", { type: "session_shutdown" });
});

test("AC3 positive: my own last write still demands a save", async () => {
	const root = fleetRepo();
	const file = join(root, "mine.txt");
	writeFileSync(file, "base\n");
	sh(root, "add", "mine.txt");
	sh(root, "commit", "-m", "base [test]");
	const fake = fakePi(root);
	await kitSaveGuard(fake.pi);
	await fake.emit("session_start", { type: "session_start" });
	await claimFixture(fake);
	await fake.emit("tool_call", { type: "tool_call", toolCallId: "write-1", toolName: "write", input: { path: file } });
	writeFileSync(file, "my bytes\n");
	await fake.emit("tool_execution_end", writeEvent("write", { resolvedPath: file }, false, "write-1"));
	const results = await fake.emit("session_stop", {
		type: "session_stop", session_id: "session-1", turn_id: "turn-1", stop_hook_active: false,
	});
	const result = results[0] as { decision?: string; reason?: string };
	expect(result?.decision).toBe("block");
	expect(result?.reason).toContain("mine.txt");
	await fake.emit("session_shutdown", { type: "session_shutdown" });
});

test("AC4: ledger writes add under 5 ms p95 per tool call", () => {
	const root = fleetRepo();
	const durations: number[] = [];
	for (let index = 0; index < 200; index += 1) {
		const result = appendLedgerEntry(stateRoot(), {
			v: 1, repo: root, relpath: `file-${index % 10}.txt`, agent: "PerfAgent",
			session: "session-perf", ts: new Date().toISOString(), blob: "blob",
		});
		expect(result.ok).toBe(true);
		durations.push(result.durationMs);
	}
	durations.sort((left, right) => left - right);
	const p95 = durations[Math.ceil(durations.length * 0.95) - 1] ?? 0;
	console.log(`ledger append p95: ${p95} ms over ${durations.length} writes`);
	expect(p95).toBeLessThan(5);
	expect(ledgerFileFor(stateRoot(), root).length).toBeGreaterThan(0);
});

test("AC4 negative: a ledger write failure never blocks the tool call", async () => {
	// A state root that cannot hold a ledger (a file, not a dir) fails closed to ok:false.
	const fileAsRoot = join(base, "not-a-dir");
	writeFileSync(fileAsRoot, "x");
	const result = appendLedgerEntry(join(fileAsRoot, "omp-kit"), {
		v: 1, repo: "/repo", relpath: "a.txt", agent: "A",
		session: "s", ts: new Date().toISOString(), blob: null,
	});
	expect(result.ok).toBe(false);
	// And the guard still attributes and stops cleanly with a broken ledger root.
	process.env.XDG_STATE_HOME = fileAsRoot;
	const root = fleetRepo();
	const file = join(root, "unledgered.txt");
	const fake = fakePi(root);
	await kitSaveGuard(fake.pi);
	await fake.emit("session_start", { type: "session_start" });
	await fake.emit("tool_call", { type: "tool_call", toolCallId: "write-1", toolName: "write", input: { path: file } });
	writeFileSync(file, "bytes\n");
	await fake.emit("tool_execution_end", writeEvent("write", { resolvedPath: file }, false, "write-1"));
	const stopped = await fake.emit("session_stop", {
		type: "session_stop", session_id: "session-1", turn_id: "turn-1", stop_hook_active: false,
	});
	expect(stopped).toBeDefined();
	await fake.emit("session_shutdown", { type: "session_shutdown" });
});

test("ledger identity resolves the pane-identity env contract, never guessed", () => {
	expect(resolveLedgerAgent({ BR_ACTOR: "A" })).toBe("A");
	expect(resolveLedgerAgent({ BR_ACTOR: "", BR_AGENT_NAME: "B" })).toBe("B");
	expect(resolveLedgerAgent({ AGENT_NAME: "C" })).toBe("C");
	expect(resolveLedgerAgent({})).toBeNull();
});

test("omitPeerLedgerPaths narrows demands to the current session's last writes", () => {
	const finding = {
		root: "/repo",
		paths: ["mine.txt", "peer.txt", "unlogged.txt"],
		aheadCount: 0,
		sharedPaths: ["peer.txt"],
		retiredPaths: [],
		omittedPaths: [],
		beadPaths: [{ bead: "b", paths: ["mine.txt", "peer.txt"] }],
		untrackedPaths: ["peer.txt"],
	};
	const writers = new Map([
		["mine.txt", { session: "session-1", agent: "LedgerAgent" }],
		["peer.txt", { session: "session-9", agent: "QuietBadger" }],
	]);
	omitPeerLedgerPaths(finding, writers, "session-1");
	expect(finding.paths).toEqual(["mine.txt", "unlogged.txt"]);
	expect(finding.sharedPaths).toEqual([]);
	expect(finding.beadPaths).toEqual([{ bead: "b", paths: ["mine.txt"] }]);
	expect(finding.untrackedPaths).toEqual([]);
	expect(finding.omittedPaths).toEqual([
		{ path: "peer.txt", reason: expect.stringContaining("QuietBadger") },
	]);
});
