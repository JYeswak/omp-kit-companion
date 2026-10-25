import { afterAll, expect, test } from "bun:test";
import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import {
	classifyTernObservation,
	defaultTernIo,
	identifyTernSeat,
	observeTernSeat,
	parseSessionJournal as parseSessionJournalImpl,
	parseSessionJournalTail,
	parseSessionView,
	parseTernInspection,
	parseTernProcess,
	readSessionTail,
	readSessionView,
	resolveDaemonSocket,
	resolveTernWindow,
	SESSION_HEAD_BYTES,
	SESSION_TAIL_WINDOW_BYTES,
	sessionJournalDecision,
	ternWindowArgv,
	ternWindowEnv,
	type TernObserverIo,
	type SessionJournalResult,
} from "../../src/plane-tern.ts";
import { ownedTmp } from "../../src/kitlib/tmp.ts";

/** Every journal fixture this file parses; the bounded-tail equivalence test at the end replays them all. */
const journalCorpus = new Set<string>();
function parseSessionJournal(text: string): SessionJournalResult {
	journalCorpus.add(text);
	return parseSessionJournalImpl(text);
}


const seat = { session: "Default", pane: "123", windowKey: "window-1", cwd: "/repo" };
const inspectFixture = {
	sessions: [{ id: 41, name: "Default", shown: true, tabs: [{ id: 42, number: 1, name: "test", shown: true,
		zoomed: false, blocks: [{ id: 123, cwd: "/repo", program: "/bin/zsh", title: "shell", exited: null }] }] }],
	panes: [{ pane: 123, cwd: "/repo", exited: null, working: false, omp_session_file: "/sessions/session-1.jsonl",
		program: "/bin/zsh", args: ["-l"], title: "shell" }],
	clients: [],
	detached: [],
};

const header = JSON.stringify({ type: "session", version: 3, id: "session-1", timestamp: "2026-10-16T00:00:00.000Z", cwd: "/repo" });
const user = JSON.stringify({ type: "message", id: "user-1", parentId: null, timestamp: "2026-10-16T00:00:01.000Z", message: { role: "user", content: [{ type: "text", text: "seed café" }] } });
const assistant = JSON.stringify({ type: "message", id: "assistant-1", parentId: "user-1", timestamp: "2026-10-16T00:00:02.000Z", message: { role: "assistant", stopReason: "stop", content: [{ type: "text", text: "done" }] } });
const terminalJournal = [header, user, assistant, JSON.stringify({ type: "model_usage", id: "usage-1", parentId: "assistant-1", timestamp: "2026-10-16T00:00:03.000Z", activeLeafId: "assistant-1" })].join("\n") + "\n";

test("Tern inspect binds the configured session and block without rejecting a shell-backed agent", async () => {
	const result = parseTernInspection(inspectFixture, seat);
	expect(result).toMatchObject({ status: "FOUND", sessionId: 41, sessionName: "Default", paneId: 123,
		cwd: "/repo", working: false, exited: null, sessionFile: "/sessions/session-1.jsonl" });
});

test("Tern inspect refuses a block that is not in the configured session", async () => {
	const result = parseTernInspection(inspectFixture, { ...seat, session: "Other" });
	expect(result).toMatchObject({ status: "REFUSED", code: "SEAT_REBOUND" });
});

// TERNADDR1 (ompkit-fixjo): the tab a block lives in is DERIVED from `tern inspect --json`; the configured fleet
// session name is only checked against the derived session/tab (name or id). Nothing about names is assumed in
// code. The fixture mirrors the live tree shape (one session holding tabs); its names are arbitrary.
const fleetInspect = {
	sessions: [{ id: 4, name: "Default", shown: true, tabs: [
		{ id: 55834574849, number: 1, name: "omp-chief", shown: true, zoomed: false,
			blocks: [{ id: 1756641624081, cwd: "/repo", program: "/bin/zsh", title: "chief", exited: null }] },
		{ id: 55834574850, number: 2, name: "omp-test", shown: true, zoomed: false,
			blocks: [{ id: 5, cwd: "/repo", program: "/bin/zsh", title: "director", exited: null }] },
	] }],
	panes: [
		{ pane: 1756641624081, cwd: "/repo", exited: null, working: false, omp_session_file: "/sessions/chief.jsonl", program: "/bin/zsh", args: ["-l"], title: "chief" },
		{ pane: 5, cwd: "/repo", exited: null, working: true, omp_session_file: "/sessions/director.jsonl", program: "/bin/zsh", args: ["-l"], title: "director" },
	],
	clients: [],
	detached: [],
};

test("TERNADDR1: the block's tab is derived and the configured name checks against it (planted: old code refused SEAT_REBOUND)", () => {
	const result = parseTernInspection(fleetInspect, { session: "omp-chief", pane: "tern:1756641624081", windowKey: "", cwd: "/repo" });
	expect(result).toMatchObject({ status: "FOUND", sessionId: 4, sessionName: "Default", paneId: 1756641624081, sessionFile: "/sessions/chief.jsonl" });
});

test("TERNADDR1: a tab id checks too; a block that lives in another tab is SEAT_REBOUND naming where it is", () => {
	expect(parseTernInspection(fleetInspect, { session: "55834574850", pane: "5", windowKey: "", cwd: "/repo" })).toMatchObject({ status: "FOUND", paneId: 5, working: true });
	expect(parseTernInspection(fleetInspect, { session: "omp-test", pane: "tern:1756641624081", windowKey: "", cwd: "/repo" })).toMatchObject({ status: "REFUSED", code: "SEAT_REBOUND", reason: expect.stringContaining("tab omp-chief") });
});

test("TERNADDR1: a block in no tab is DEAD only when its configured session exists; the same block appearing twice is UNKNOWN", () => {
	expect(parseTernInspection(fleetInspect, { session: "Default", pane: "999", windowKey: "", cwd: "/repo" })).toMatchObject({ status: "DEAD", reason: "PANE_MISSING_FROM_CONFIGURED_SESSION" });
	expect(parseTernInspection(fleetInspect, { session: "omp-test", pane: "999", windowKey: "", cwd: "/repo" })).toMatchObject({ status: "REFUSED", code: "SEAT_REBOUND" });
	const twice = { ...fleetInspect, sessions: [{ ...fleetInspect.sessions[0]!, tabs: [...fleetInspect.sessions[0]!.tabs, { ...fleetInspect.sessions[0]!.tabs[0]!, id: 99, number: 3 }] }] };
	expect(parseTernInspection(twice, { session: "omp-chief", pane: "tern:1756641624081", windowKey: "", cwd: "/repo" })).toMatchObject({ status: "UNKNOWN", reason: "INSPECT_BLOCK_AMBIGUOUS" });
	expect(parseTernInspection(fleetInspect, { session: "Default", pane: "tern:1756641624081", windowKey: "", cwd: "/repo" })).toMatchObject({ status: "FOUND", sessionId: 4 });
});

test("TERNADDR1: resolveTernWindow admits the default window when the fleet session is a tab of it", () => {
	const io = { ...defaultTernIo(), run: (argv: string[]) => argv[0] === "tern" && argv.includes("inspect")
		? { code: 0, out: JSON.stringify(fleetInspect) } : { code: 1, out: "" } } as TernObserverIo;
	expect(resolveTernWindow({ session: "omp-test", pane: "5", windowKey: "", cwd: "/repo" }, io, {})).toMatchObject({ ok: true, kind: "default" });
	expect(resolveTernWindow({ session: "nowhere", pane: "5", windowKey: "", cwd: "/repo" }, io, {})).toMatchObject({ ok: false, code: "PLANE_SEAT_UNBOUND", reason: expect.stringContaining("lives in session Default tab omp-test") });
});

test("Tern inspect reports a missing block as DEAD", () => {
	expect(parseTernInspection(inspectFixture, { ...seat, pane: "999" })).toMatchObject({ status: "DEAD" });
});

test("Tern inspect rejects cwd outside the configured repository", () => {
	const snapshot = { ...inspectFixture, panes: [{ ...inspectFixture.panes[0], cwd: "/outside" }] };
	expect(parseTernInspection(snapshot, seat)).toMatchObject({ status: "REFUSED", code: "SEAT_CWD_MISMATCH" });
});

test("TERNADDR1 AC2: an empty window key is Tern's documented default window and binds; a non-string key is still refused", () => {
	expect(parseTernInspection(inspectFixture, { ...seat, windowKey: "" })).toMatchObject({ status: "FOUND", paneId: 123 });
	expect(parseTernInspection(inspectFixture, { ...seat, windowKey: 7 as unknown as string })).toMatchObject({ status: "REFUSED", code: "TERN_WINDOW_UNBOUND" });
});

test("session oracle resolves the active leaf past late model usage metadata", async () => {
	const result = parseSessionJournal(terminalJournal);
	expect(result).toMatchObject({ status: "KNOWN", sessionId: "session-1", cwd: "/repo", leafId: "assistant-1",
		terminalAssistantStop: true, unresolvedAsyncTool: false, oracleBusy: false });
});

test("a terminal assistant stop with an unresolved async tool has unknown oracle state", () => {
	const assistantWithTool = JSON.stringify({ type: "message", id: "assistant-1", parentId: "user-1",
		timestamp: "2026-10-16T00:00:02.000Z", message: { role: "assistant", stopReason: "stop", toolCallIds: ["tool-1"], content: [] } });
	const runningTool = JSON.stringify({ type: "tool_result", id: "tool-result-1", parentId: "assistant-1",
		timestamp: "2026-10-16T00:00:03.000Z", toolCallId: "tool-1", details: { async: { state: "running" } } });
	const usage = JSON.stringify({ type: "model_usage", id: "usage-1", parentId: "tool-result-1",
		timestamp: "2026-10-16T00:00:04.000Z", activeLeafId: "tool-result-1" });
	const result = parseSessionJournal([header, user, assistantWithTool, runningTool, usage].join("\n") + "\n");
	expect(result).toMatchObject({ status: "KNOWN", terminalAssistantStop: true, unresolvedAsyncTool: true, oracleBusy: null });
	const inspection = parseTernInspection(inspectFixture, seat);
	const process = parseTernProcess(processFixture, "/repo", 123);
	expect(classifyTernObservation(inspection, process, result)).toMatchObject({ state: "UNKNOWN", oracleBusy: null });
});

test("a partial session record remains unknown, not idle", async () => {
	const result = parseSessionJournal(terminalJournal.trimEnd());
	expect(result).toMatchObject({ status: "UNKNOWN" });
});
const processFixture = {
	pane: 123,
	child: { pid: 12, name: "zsh", argv: ["/bin/zsh", "-l"], cwd: "/repo" },
	group: 13,
	foreground: { pid: 13, name: "18.11.0", argv: ["omp", "--profile", "codex"], cwd: "/repo" },
};
const agentResolution = { schema_version: "am.agents.resolve-pane.v1", agent_name: "SilverCondor",
	pane_id: "tern:123", project_key: "/repo", source: "canonical", binding: "verified-live" };
function testIo(
	working: boolean,
	journal: string | string[],
	agent: unknown = agentResolution,
	waits: number[] = [],
	processStart: string | string[] = "Wed Oct 14 19:39:32 2026 omp --profile codex\n",
) {
	const journalReads = typeof journal === "string" ? [journal] : journal;
	const processStartReads = typeof processStart === "string" ? [processStart] : processStart;
	let journalIndex = 0;
	let processStartIndex = 0;
	return {
		run(argv: string[]) {
			if (argv.includes("inspect")) {
				return { code: 0, out: JSON.stringify({ ...inspectFixture, panes: [{ ...inspectFixture.panes[0], working }] }) };
			}
			if (argv.includes("process")) return { code: 0, out: JSON.stringify(processFixture) };
			if (argv[0] === "/bin/ps") {
				return { code: 0, out: processStartReads[Math.min(processStartIndex++, processStartReads.length - 1)] ?? "" };
			}
			if (argv[0] === "am") return { code: 0, out: JSON.stringify(agent) };
			return { code: 2, out: "" };
		},
		readSessionFile: (_path: string) => journalReads[Math.min(journalIndex++, journalReads.length - 1)] ?? null,
		wait: async (ms: number) => { waits.push(ms); },
	};
}

test("observer reports IDLE only when inspect and the session oracle agree", async () => {
	const result = await observeTernSeat(seat, testIo(false, terminalJournal));
	expect(result).toMatchObject({ state: "IDLE", working: false, oracleBusy: false,
		sessionFile: "/sessions/session-1.jsonl", sessionCursorBytes: new TextEncoder().encode(terminalJournal).length,
		sessionLeafId: "assistant-1", fg: { pid: 13, name: "18.11.0", cwd: "/repo",
			argv: ["omp", "--profile", "codex"], started: "Wed Oct 14 19:39:32 2026" } });
});
test("observer rejects process identity that changed across the bracket", async () => {
	const processStarts = [
		"Wed Oct 14 19:39:32 2026 omp --profile codex\n",
		"Wed Oct 14 19:39:33 2026 omp --profile codex\n",
	];
	expect(await observeTernSeat(seat, testIo(false, terminalJournal, agentResolution, [], processStarts)))
		.toMatchObject({ state: "UNKNOWN", reason: "OBSERVATION_CHANGED_DURING_READ" });
});


test("observer retries disagreement and never promotes it to IDLE", async () => {
	const waits: number[] = [];
	const pendingUser = [header, user].join("\n") + "\n";
	const result = await observeTernSeat(seat, testIo(false, pendingUser, agentResolution, waits));
	expect(result).toMatchObject({ state: "UNKNOWN", working: false, oracleBusy: true });
	expect(waits).toEqual([2000, 2000, 2000]);
});

test("observer returns UNKNOWN when the active session branch changes across its bracket", async () => {
	const alternateAssistant = JSON.stringify({ type: "message", id: "assistant-2", parentId: "user-1",
		timestamp: "2026-10-16T00:00:04.000Z", message: { role: "assistant", stopReason: "stop", content: [] } });
	const alternateUsage = JSON.stringify({ type: "model_usage", id: "usage-2", parentId: "assistant-2",
		timestamp: "2026-10-16T00:00:05.000Z", activeLeafId: "assistant-2" });
	const branchedJournal = [header, user, assistant, alternateAssistant, alternateUsage].join("\n") + "\n";
	expect(await observeTernSeat(seat, testIo(false, [terminalJournal, branchedJournal])))
		.toMatchObject({ state: "UNKNOWN", reason: "SESSION_CHANGED_DURING_READ" });
});
test("observer returns UNKNOWN when the session file rotates across its bracket", async () => {
	let inspectCount = 0;
	const io = {
		run(argv: string[]) {
			if (argv.includes("inspect")) {
				// The first two reads (window resolution, opening bracket) agree;
				// the rotation lands across the observation bracket itself.
				const sessionFile = inspectCount++ < 2 ? "/sessions/session-1.jsonl" : "/sessions/session-2.jsonl";
				const panes = [{ ...inspectFixture.panes[0], working: false, omp_session_file: sessionFile }];
				return { code: 0, out: JSON.stringify({ ...inspectFixture, panes }) };
			}
			if (argv.includes("process")) return { code: 0, out: JSON.stringify(processFixture) };
			if (argv[0] === "/bin/ps") return { code: 0, out: "Wed Oct 14 19:39:32 2026 omp --profile codex\n" };
			return { code: 2, out: "" };
		},
		readSessionFile() { return terminalJournal; },
		wait: async () => {},
	};
	expect(await observeTernSeat(seat, io)).toMatchObject({ state: "UNKNOWN", reason: "OBSERVATION_CHANGED_DURING_READ" });
});

test("observer detects a same-session process exec across its bracket", async () => {
	let processCount = 0;
	let currentCommand = "omp --profile codex";
	const io = {
		run(argv: string[]) {
			if (argv.includes("inspect")) return { code: 0, out: JSON.stringify(inspectFixture) };
			if (argv.includes("process")) {
				const argvForProcess = processCount++ === 0 ? ["omp", "--profile", "codex"] : ["omp", "--profile", "other"];
				currentCommand = argvForProcess.join(" ");
				const result = { ...processFixture, foreground: { ...processFixture.foreground, argv: argvForProcess } };
				return { code: 0, out: JSON.stringify(result) };
			}
			if (argv[0] === "/bin/ps") return { code: 0, out: `Wed Oct 14 19:39:32 2026 ${currentCommand}\n` };
			return { code: 2, out: "" };
		},
		readSessionFile() { return terminalJournal; },
		wait: async () => {},
	};
		expect(await observeTernSeat(seat, io)).toMatchObject({ state: "UNKNOWN", reason: "OBSERVATION_CHANGED_DURING_READ" });
});

test("observer reports BUSY when a persisted user message and Tern working flag agree", async () => {
	const pendingUser = [header, user].join("\n") + "\n";
	expect(await observeTernSeat(seat, testIo(true, pendingUser)))
		.toMatchObject({ state: "BUSY", working: true, oracleBusy: true });
});

test("observer returns UNKNOWN when the session file changes across its bracket", async () => {
	const changedJournal = terminalJournal + JSON.stringify({ type: "title" }) + "\n";
	expect(await observeTernSeat(seat, testIo(false, [terminalJournal, changedJournal])))
		.toMatchObject({ state: "UNKNOWN", reason: "SESSION_CHANGED_DURING_READ" });
});

test("observer fails closed when a CLI runner throws", async () => {
	const io = { run() { throw new Error("exec failed"); }, readSessionFile() { return terminalJournal; }, wait: async () => {} };
	// The first command is the window resolution read; its failure refuses
	// the seat before any observation, still UNKNOWN and never IDLE.
	expect(await observeTernSeat(seat, io)).toMatchObject({ state: "UNKNOWN", reason: "PLANE_SEAT_UNBOUND" });
});

test("identity returns the registered Tern pane and runtime binding", async () => {
	const result = await identifyTernSeat(seat, testIo(false, terminalJournal));
	expect(result).toMatchObject({
		binding: "verified-live",
		agent: "SilverCondor",
		cwdOk: true,
		runtimeBinding: { sessionId: 41, sessionFile: "/sessions/session-1.jsonl", sessionUuid: "session-1",
			paneId: 123, foregroundPid: 13, foregroundName: "18.11.0", foregroundStarted: "Wed Oct 14 19:39:32 2026",
			foregroundArgv: ["omp", "--profile", "codex"], cwd: "/repo" },
	});
});
test("identity refuses a legacy-unverified Agent Mail pane binding", async () => {
	const legacyAgent = { ...agentResolution, binding: "legacy-unverified" };
	expect(await identifyTernSeat(seat, testIo(false, terminalJournal, legacyAgent)))
		.toMatchObject({ status: "REFUSED", code: "PLANE_SEAT_UNBOUND", binding: "legacy-unverified", agent: null });
});
test("identity refuses an unregistered Agent Mail pane", async () => {
	expect(await identifyTernSeat(seat, testIo(false, terminalJournal, null)))
		.toMatchObject({ status: "REFUSED", code: "PLANE_SEAT_UNBOUND", agent: null });
});
test("identity accepts legacy binding only after the same runtime was bound", async () => {
	const previousBinding = { sessionId: 41, sessionFile: "/sessions/session-1.jsonl", sessionUuid: "session-1",
		paneId: 123, foregroundPid: 13, foregroundName: "18.11.0", foregroundStarted: "Wed Oct 14 19:39:32 2026",
		foregroundArgv: ["omp", "--profile", "codex"], cwd: "/repo" };
	const legacyAgent = { ...agentResolution, binding: "legacy-unverified" };
	const result = await identifyTernSeat({ ...seat, previousBinding }, testIo(false, terminalJournal, legacyAgent));
	expect(result).toMatchObject({ status: "IDENTIFIED", agent: "SilverCondor", binding: "legacy-unverified", cwdOk: true });
});

test("Tern process parser refuses a result for another block", () => {
	expect(parseTernProcess({ ...processFixture, pane: 456 }, "/repo", 123))
		.toMatchObject({ status: "UNKNOWN", reason: "PROCESS_PANE_MISMATCH" });
});
test("Tern process parser rejects a non-OMP foreground", () => {
	const snapshot = { ...processFixture, foreground: { ...processFixture.foreground, argv: ["node"] } };
	expect(parseTernProcess(snapshot, "/repo", 123))
		.toMatchObject({ status: "UNKNOWN", reason: "FOREGROUND_OMP_MISSING" });
});

test("Tern process parser extracts the actual foreground OMP record", () => {
	const result = parseTernProcess(processFixture, "/repo", 123);
	expect(result).toMatchObject({
		status: "FOUND",
		foreground: { pid: 13, name: "18.11.0", cwd: "/repo", argv: ["omp", "--profile", "codex"], started: null },
	});
});

test("Tern observation stays unknown when inspect and session oracle disagree", async () => {
	const inspection = { status: "FOUND", sessionId: 41, sessionName: "Default", paneId: 123, cwd: "/repo",
		working: false, exited: null, sessionFile: "/sessions/session-1.jsonl" } as const;
	const process = { status: "FOUND" as const, foreground: { pid: 13, name: "18.11.0", cwd: "/repo",
		argv: ["omp"], started: null } };
	const oracle = { status: "KNOWN", sessionId: "session-1", cwd: "/repo", leafId: "assistant-1", cursorBytes: 20,
		sessionSha256: "a".repeat(64), terminalAssistantStop: false, lastMessageRole: "user",
		unresolvedAsyncTool: false, oracleBusy: true, window: null } as const;
	const result = classifyTernObservation(inspection, process, oracle);
	expect(result).toMatchObject({ state: "UNKNOWN", working: false, oracleBusy: true });
});

test("Tern identity refuses a different runtime incarnation", async () => {
	const previousBinding = { sessionId: 41, sessionFile: "/sessions/old-session.jsonl", sessionUuid: "session-1",
		paneId: 123, foregroundPid: 13, foregroundName: "18.11.0", foregroundStarted: "Wed Oct 14 19:39:32 2026",
		foregroundArgv: ["omp", "--profile", "codex"], cwd: "/repo" };
	const result = await identifyTernSeat({ ...seat, previousBinding }, testIo(false, terminalJournal));
	expect(result).toMatchObject({ status: "REFUSED", code: "SEAT_REBOUND", agent: null, cwdOk: false });
});

test("Tern identity refuses an Agent Mail row bound to another block", async () => {
	const wrongAgent = { ...agentResolution, agent_name: "OtherAgent", pane_id: "tern:456" };
	const result = await identifyTernSeat(seat, testIo(false, terminalJournal, wrongAgent));
	expect(result).toMatchObject({ status: "REFUSED", code: "PLANE_SEAT_UNBOUND", agent: null });
});

// ---- native OMP v3 toolResult records (ompkit-kdbz.2.12): toolCallId and details.async live
// inside message, and real metadata records participate in the parent chain ----

const stamp = (n: number): string => `2026-10-16T00:00:${String(n).padStart(2, "0")}.000Z`;
function nativeMessage(id: string, parentId: string | null, n: number, message: unknown): string {
	return JSON.stringify({ type: "message", id, parentId, timestamp: stamp(n), message });
}
const nativeUser = nativeMessage("user-1", null, 1, { role: "user", content: [{ type: "text", text: "go" }] });
const nativeAssistantTools = nativeMessage("assistant-1", "user-1", 2,
	{ role: "assistant", stopReason: "toolUse", content: [{ type: "toolCall", id: "tool-1" }], toolCallIds: ["tool-1"] });
const nativeToolDone = nativeMessage("tool-result-1", "assistant-1", 3,
	{ role: "toolResult", toolCallId: "tool-1", toolName: "read", isError: false, content: [], details: { resolvedPath: "/x" } });
const nativeFinal = nativeMessage("assistant-2", "tool-result-1", 4,
	{ role: "assistant", stopReason: "stop", content: [{ type: "text", text: "done" }] });
const nativeUsage = JSON.stringify({ type: "model_usage", id: "usage-1", parentId: "assistant-2",
	timestamp: stamp(5), activeLeafId: "assistant-2" });
const nativeCompleted = [header, nativeUser, nativeAssistantTools, nativeToolDone, nativeFinal, nativeUsage].join("\n") + "\n";

test("native completed tool roundtrip resolves KNOWN with no unresolved async tool", () => {
	const result = parseSessionJournal(nativeCompleted);
	expect(result).toMatchObject({ status: "KNOWN", terminalAssistantStop: true, unresolvedAsyncTool: false, oracleBusy: false });
});

test("native running async inside message.details stays unresolved, never idle", () => {
	const running = nativeMessage("tool-result-1", "assistant-1", 3,
		{ role: "toolResult", toolCallId: "tool-1", toolName: "read", isError: false, content: [], details: { async: { state: "running" } } });
	const usage = JSON.stringify({ type: "model_usage", id: "usage-1", parentId: "tool-result-1",
		timestamp: stamp(4), activeLeafId: "tool-result-1" });
	const result = parseSessionJournal([header, nativeUser, nativeAssistantTools, running, usage].join("\n") + "\n");
	expect(result).toMatchObject({ status: "KNOWN", unresolvedAsyncTool: true, oracleBusy: null });
});

test("native completion for another id never clears the pending tool", () => {
	const other = nativeMessage("tool-result-1", "assistant-1", 3,
		{ role: "toolResult", toolCallId: "tool-2", toolName: "read", isError: false, content: [], details: {} });
	const usage = JSON.stringify({ type: "model_usage", id: "usage-1", parentId: "tool-result-1",
		timestamp: stamp(4), activeLeafId: "tool-result-1" });
	const result = parseSessionJournal([header, nativeUser, nativeAssistantTools, other, usage].join("\n") + "\n");
	expect(result).toMatchObject({ status: "KNOWN", unresolvedAsyncTool: true, oracleBusy: null });
});

test("native running async without an id stays unresolved", () => {
	const noid = nativeMessage("tool-result-1", "assistant-1", 3,
		{ role: "toolResult", toolName: "read", isError: false, content: [], details: { async: { state: "pending" } } });
	const usage = JSON.stringify({ type: "model_usage", id: "usage-1", parentId: "tool-result-1",
		timestamp: stamp(4), activeLeafId: "tool-result-1" });
	const result = parseSessionJournal([header, nativeUser, nativeAssistantTools, noid, usage].join("\n") + "\n");
	expect(result).toMatchObject({ status: "KNOWN", unresolvedAsyncTool: true, oracleBusy: null });
});

test("native toolResult with an unsupported async state stays unknown, never idle", () => {
	const weird = nativeMessage("tool-result-1", "assistant-1", 3,
		{ role: "toolResult", toolCallId: "tool-1", toolName: "read", isError: false, content: [], details: { async: { state: "unknown_state" } } });
	const final = nativeMessage("assistant-2", "tool-result-1", 4,
		{ role: "assistant", stopReason: "stop", content: [{ type: "text", text: "done" }] });
	const usage = JSON.stringify({ type: "model_usage", id: "usage-1", parentId: "assistant-2",
		timestamp: stamp(5), activeLeafId: "assistant-2" });
	const result = parseSessionJournal([header, nativeUser, nativeAssistantTools, weird, final, usage].join("\n") + "\n");
	expect(result).toMatchObject({ status: "UNKNOWN" });
});

test("native matching cancellation reconciles only its own tool", () => {
	const cancelled = nativeMessage("tool-result-1", "assistant-1", 3,
		{ role: "toolResult", toolCallId: "tool-1", toolName: "read", isError: false, content: [], details: { async: { state: "cancelled" } } });
	const final = nativeMessage("assistant-2", "tool-result-1", 4,
		{ role: "assistant", stopReason: "stop", content: [{ type: "text", text: "done" }] });
	const usage = JSON.stringify({ type: "model_usage", id: "usage-1", parentId: "assistant-2",
		timestamp: stamp(5), activeLeafId: "assistant-2" });
	const result = parseSessionJournal([header, nativeUser, nativeAssistantTools, cancelled, final, usage].join("\n") + "\n");
	expect(result).toMatchObject({ status: "KNOWN", terminalAssistantStop: true, unresolvedAsyncTool: false, oracleBusy: false });
});

test("native matching completion reconciles only its own tool", () => {
	const completed = nativeMessage("tool-result-1", "assistant-1", 3,
		{ role: "toolResult", toolCallId: "tool-1", toolName: "read", isError: false, content: [], details: { async: { state: "completed" } } });
	const final = nativeMessage("assistant-2", "tool-result-1", 4,
		{ role: "assistant", stopReason: "stop", content: [{ type: "text", text: "done" }] });
	const usage = JSON.stringify({ type: "model_usage", id: "usage-1", parentId: "assistant-2",
		timestamp: stamp(5), activeLeafId: "assistant-2" });
	const result = parseSessionJournal([header, nativeUser, nativeAssistantTools, completed, final, usage].join("\n") + "\n");
	expect(result).toMatchObject({ status: "KNOWN", terminalAssistantStop: true, unresolvedAsyncTool: false, oracleBusy: false });
});

test("native cancellation for another id never clears the pending tool", () => {
	const other = nativeMessage("tool-result-1", "assistant-1", 3,
		{ role: "toolResult", toolCallId: "tool-2", toolName: "read", isError: false, content: [], details: { async: { state: "cancelled" } } });
	const usage = JSON.stringify({ type: "model_usage", id: "usage-1", parentId: "tool-result-1",
		timestamp: stamp(4), activeLeafId: "tool-result-1" });
	const result = parseSessionJournal([header, nativeUser, nativeAssistantTools, other, usage].join("\n") + "\n");
	expect(result).toMatchObject({ status: "KNOWN", unresolvedAsyncTool: true, oracleBusy: null });
});

test("native toolResult with conflicting id aliases stays unknown, never idle", () => {
	const ambiguous = nativeMessage("tool-result-1", "assistant-1", 3,
		{ role: "toolResult", toolCallId: "tool-1", callId: "tool-2", toolName: "read", isError: false, content: [], details: {} });
	const toolTwoDone = nativeMessage("tool-result-2", "tool-result-1", 4,
		{ role: "toolResult", toolCallId: "tool-2", toolName: "read", isError: false, content: [], details: {} });
	const final = nativeMessage("assistant-2", "tool-result-2", 5,
		{ role: "assistant", stopReason: "stop", content: [{ type: "text", text: "done" }] });
	const usage = JSON.stringify({ type: "model_usage", id: "usage-1", parentId: "assistant-2",
		timestamp: stamp(6), activeLeafId: "assistant-2" });
	const result = parseSessionJournal([header, nativeUser, nativeAssistantTools, ambiguous, toolTwoDone, final, usage].join("\n") + "\n");
	expect(result).toMatchObject({ status: "UNKNOWN" });
});

test("native toolResult with matching id aliases reconciles", () => {
	const agreed = nativeMessage("tool-result-1", "assistant-1", 3,
		{ role: "toolResult", toolCallId: "tool-1", callId: "tool-1", toolName: "read", isError: false, content: [], details: {} });
	const final = nativeMessage("assistant-2", "tool-result-1", 4,
		{ role: "assistant", stopReason: "stop", content: [{ type: "text", text: "done" }] });
	const usage = JSON.stringify({ type: "model_usage", id: "usage-1", parentId: "assistant-2",
		timestamp: stamp(5), activeLeafId: "assistant-2" });
	const result = parseSessionJournal([header, nativeUser, nativeAssistantTools, agreed, final, usage].join("\n") + "\n");
	expect(result).toMatchObject({ status: "KNOWN", terminalAssistantStop: true, unresolvedAsyncTool: false, oracleBusy: false });
});

test("record-level tool_result with conflicting ids stays unknown", () => {
	const ambiguous = JSON.stringify({ type: "tool_result", id: "tool-result-1", parentId: "assistant-1",
		timestamp: stamp(3), toolCallId: "tool-1", callId: "tool-2", details: {} });
	const usage = JSON.stringify({ type: "model_usage", id: "usage-1", parentId: "tool-result-1",
		timestamp: stamp(4), activeLeafId: "tool-result-1" });
	const result = parseSessionJournal([header, nativeUser, nativeAssistantTools, ambiguous, usage].join("\n") + "\n");
	expect(result).toMatchObject({ status: "UNKNOWN" });
});

test("native metadata records keep the parent chain usable", () => {
	const custom = JSON.stringify({ type: "custom", id: "custom-1", parentId: "assistant-1",
		timestamp: stamp(3), customType: "memory_recall", data: {} });
	const modelChange = JSON.stringify({ type: "model_change", id: "model-change-1", parentId: "custom-1",
		timestamp: stamp(3), model: "m" });
	const toolDone = nativeMessage("tool-result-1", "model-change-1", 3,
		{ role: "toolResult", toolCallId: "tool-1", toolName: "read", isError: false, content: [], details: {} });
	const final = nativeMessage("assistant-2", "tool-result-1", 4,
		{ role: "assistant", stopReason: "stop", content: [{ type: "text", text: "done" }] });
	const usage = JSON.stringify({ type: "model_usage", id: "usage-1", parentId: "assistant-2",
		timestamp: stamp(5), activeLeafId: "assistant-2" });
	const result = parseSessionJournal([header, nativeUser, nativeAssistantTools, custom, modelChange, toolDone, final, usage].join("\n") + "\n");
	expect(result).toMatchObject({ status: "KNOWN", terminalAssistantStop: true, unresolvedAsyncTool: false, oracleBusy: false });
});

test("unknown record types still refuse the whole journal", () => {
	const frob = JSON.stringify({ type: "frobnicator", id: "frob-1", parentId: "user-1", timestamp: stamp(2) });
	const usage = JSON.stringify({ type: "model_usage", id: "usage-1", parentId: "frob-1",
		timestamp: stamp(3), activeLeafId: "frob-1" });
	const result = parseSessionJournal([header, nativeUser, frob, usage].join("\n") + "\n");
	expect(result).toMatchObject({ status: "UNKNOWN" });
});

// ---- OMP v3 context records (ompkit-fixjo TERNADDR1): live seats journal custom_message,
// ttsr_injection and compaction; each once refused the whole journal as INVALID_OR_DUPLICATE_ENTRY ----
const asyncResult = (id: string, parentId: string, n: number, jobs: unknown = [{ jobId: "Other", type: "task", status: "completed" }]): string =>
	JSON.stringify({ type: "custom_message", id, parentId, timestamp: stamp(n), customType: "async-result",
		content: "[redacted]", display: true, details: { meta: { source: { type: "report" } }, jobs }, attribution: "agent" });
const ttsrInjection = JSON.stringify({ type: "ttsr_injection", id: "ttsr-1", parentId: "custom-message-1",
	timestamp: stamp(3), injectedRules: ["rule-a"] });
const compaction = JSON.stringify({ type: "compaction", id: "compaction-1", parentId: "ttsr-1", timestamp: stamp(3),
	summary: "[redacted]", firstKeptEntryId: "assistant-1", tokensBefore: 1000, method: "remote" });

test("interior custom_message, ttsr_injection and compaction keep a terminal stop idle", () => {
	const toolDone = nativeMessage("tool-result-1", "compaction-1", 4,
		{ role: "toolResult", toolCallId: "tool-1", toolName: "read", isError: false, content: [], details: {} });
	const final = nativeMessage("assistant-2", "tool-result-1", 5,
		{ role: "assistant", stopReason: "stop", content: [{ type: "text", text: "done" }] });
	const usage = JSON.stringify({ type: "model_usage", id: "usage-1", parentId: "assistant-2",
		timestamp: stamp(6), activeLeafId: "assistant-2" });
	const result = parseSessionJournal([header, nativeUser, nativeAssistantTools, asyncResult("custom-message-1", "assistant-1", 3),
		ttsrInjection, compaction, toolDone, final, usage].join("\n") + "\n");
	expect(result).toMatchObject({ status: "KNOWN", leafId: "assistant-2", terminalAssistantStop: true, oracleBusy: false });
});

test("a custom_message after a terminal stop leaves the oracle without a verdict, never idle", () => {
	const usage = JSON.stringify({ type: "model_usage", id: "usage-1", parentId: "custom-message-1",
		timestamp: stamp(6), activeLeafId: "custom-message-1" });
	const result = parseSessionJournal([header, nativeUser, nativeAssistantTools, nativeToolDone, nativeFinal,
		asyncResult("custom-message-1", "assistant-2", 5), usage].join("\n") + "\n");
	expect(result).toMatchObject({ status: "KNOWN", leafId: "custom-message-1", lastMessageRole: "custom_message", oracleBusy: null });
});

test("a compaction ending the branch leaves the oracle without a verdict, never idle", () => {
	const trailing = JSON.stringify({ type: "compaction", id: "compaction-1", parentId: "assistant-2", timestamp: stamp(5),
		summary: "[redacted]", firstKeptEntryId: "assistant-2", tokensBefore: 1000 });
	const usage = JSON.stringify({ type: "model_usage", id: "usage-1", parentId: "compaction-1",
		timestamp: stamp(6), activeLeafId: "compaction-1" });
	const result = parseSessionJournal([header, nativeUser, nativeAssistantTools, nativeToolDone, nativeFinal, trailing, usage]
		.join("\n") + "\n");
	expect(result).toMatchObject({ status: "KNOWN", lastMessageRole: "compaction", oracleBusy: null });
});

test("a genuinely duplicated entry id still refuses the journal", () => {
	const result = parseSessionJournal([header, nativeUser, nativeAssistantTools, asyncResult("custom-message-1", "assistant-1", 3),
		asyncResult("custom-message-1", "assistant-1", 4), nativeUsage].join("\n") + "\n");
	expect(result).toEqual({ status: "UNKNOWN", reason: "INVALID_OR_DUPLICATE_ENTRY" });
	const duplicateMessage = parseSessionJournal([header, nativeUser, nativeUser, nativeUsage].join("\n") + "\n");
	expect(duplicateMessage).toEqual({ status: "UNKNOWN", reason: "INVALID_OR_DUPLICATE_ENTRY" });
});

// A background task's tool result stays "running" forever; OMP settles it only through an async-result delivery.
const runningTask = nativeMessage("tool-result-1", "assistant-1", 3, { role: "toolResult", toolCallId: "tool-1",
	toolName: "task", isError: false, content: [], details: { async: { state: "running", jobId: "Worker", type: "task" } } });
function deliveredJournal(jobs: unknown): string {
	const final = nativeMessage("assistant-2", "custom-message-1", 5,
		{ role: "assistant", stopReason: "stop", content: [{ type: "text", text: "done" }] });
	return [header, nativeUser, nativeAssistantTools, runningTask, asyncResult("custom-message-1", "tool-result-1", 4, jobs), final,
		nativeUsage].join("\n") + "\n";
}

test("an async-result delivery for the running job settles its tool", () => {
	for (const status of ["completed", "failed", "cancelled"]) {
		const result = parseSessionJournal(deliveredJournal([{ jobId: "Worker", type: "task", status }]));
		expect(result).toMatchObject({ status: "KNOWN", unresolvedAsyncTool: false, oracleBusy: false });
	}
});

test("an async-result delivery for another job leaves the running tool unresolved", () => {
	const result = parseSessionJournal(deliveredJournal([{ jobId: "Elsewhere", type: "task", status: "completed" }]));
	expect(result).toMatchObject({ status: "KNOWN", unresolvedAsyncTool: true, oracleBusy: null });
});

test("an async-result delivery with an unknown or missing job status stays unknown, never idle", () => {
	for (const jobs of [[{ jobId: "Worker", status: "running" }], [{ jobId: "Worker" }], "not-a-list"]) {
		expect(parseSessionJournal(deliveredJournal(jobs))).toEqual({ status: "UNKNOWN", reason: "UNSUPPORTED_ASYNC_STATE" });
	}
});

// ---- window resolution (ompkit-kdbz.2.16 TERNWINKEY1) ----
const resolutionIo = (runs: string[][], snapshot: unknown, code = 0) => ({
	run(argv: string[], _env?: Record<string, string>) {
		runs.push(argv);
		return { code, out: typeof snapshot === "string" ? snapshot : JSON.stringify(snapshot) };
	},
	readSessionFile(_path: string) { return null; },
	wait: async () => {},
});
const windowedFixture = { sessions: [{ id: 41, name: "Default" }], panes: [], clients: [], detached: [] };
const noDaemonEnv = { TERN_DAEMON_SOCKET: "", TERN_CONFIG_DIR: "/nonexistent-tern-config", HOME: "/nonexistent-home" };

test("resolution verifies an explicit key against the window's own snapshot", () => {
	const runs: string[][] = [];
	const result = resolveTernWindow(seat, resolutionIo(runs, windowedFixture), noDaemonEnv);
	expect(result).toMatchObject({ ok: true, kind: "key", windowKey: "window-1", daemonSocket: null });
	expect(runs).toEqual([["tern", "--window", "window-1", "inspect", "--json"]]);
	if (result.ok) {
		expect(ternWindowArgv(result)).toEqual(["--window", "window-1"]);
		expect(ternWindowEnv(result)).toBeUndefined();
	}
});

test("resolution maps an empty key to the documented default window without the flag", () => {
	const runs: string[][] = [];
	const result = resolveTernWindow({ ...seat, windowKey: "" }, resolutionIo(runs, windowedFixture), noDaemonEnv);
	expect(result).toMatchObject({ ok: true, kind: "default", daemonSocket: null });
	expect(runs).toEqual([["tern", "inspect", "--json"]]);
	if (result.ok) {
		expect(ternWindowArgv(result)).toEqual([]);
		expect(ternWindowEnv(result)).toBeUndefined();
	}
});

test("resolution pins an explicit daemon socket into the run env", () => {
	const runs: string[][] = [];
	const seenEnvs: (Record<string, string> | undefined)[] = [];
	const io = { run(argv: string[], env?: Record<string, string>) { runs.push(argv); seenEnvs.push(env);
		return { code: 0, out: JSON.stringify(windowedFixture) }; },
		readSessionFile(_path: string) { return null; }, wait: async () => {} };
	const result = resolveTernWindow(seat, io, { ...noDaemonEnv, TERN_DAEMON_SOCKET: "/sockets/daemon.sock" });
	expect(result).toMatchObject({ ok: true, kind: "key", daemonSocket: "/sockets/daemon.sock" });
	expect(seenEnvs).toEqual([{ TERN_DAEMON_SOCKET: "/sockets/daemon.sock" }]);
	if (result.ok) expect(ternWindowEnv(result)).toEqual({ TERN_DAEMON_SOCKET: "/sockets/daemon.sock" });
});

test("resolution refuses a key that addresses no live window", () => {
	const runs: string[][] = [];
	const result = resolveTernWindow({ ...seat, windowKey: "bogus" }, resolutionIo(runs, "", 2), noDaemonEnv);
	expect(result).toMatchObject({ ok: false, code: "PLANE_SEAT_UNBOUND" });
});

test("resolution refuses a default window missing the configured session", () => {
	const runs: string[][] = [];
	const elsewhere = { sessions: [{ id: 9, name: "elsewhere" }], panes: [], clients: [], detached: [] };
	const result = resolveTernWindow({ ...seat, windowKey: "" }, resolutionIo(runs, elsewhere), noDaemonEnv);
	expect(result).toMatchObject({ ok: false, code: "PLANE_SEAT_UNBOUND" });
	expect(runs).toEqual([["tern", "inspect", "--json"]]);
});

test("resolution refuses structural defects before running any command", () => {
	for (const bad of [{ ...seat, session: " " }, { ...seat, pane: "nope" }, { ...seat, cwd: "relative" }]) {
		const runs: string[][] = [];
		expect(resolveTernWindow(bad, resolutionIo(runs, windowedFixture), noDaemonEnv))
			.toMatchObject({ ok: false, code: "PLANE_SEAT_UNBOUND" });
		expect(runs.length).toBe(0);
	}
});

test("observer serves a default-resolved seat from the first-window snapshot", async () => {
	const result = await observeTernSeat({ ...seat, windowKey: "" }, testIo(false, terminalJournal));
	expect(result).toMatchObject({ state: "IDLE", working: false, oracleBusy: false,
		sessionFile: "/sessions/session-1.jsonl", sessionLeafId: "assistant-1" });
});

test("resolveDaemonSocket prefers the explicit override and otherwise stays null without a live socket", () => {
	expect(resolveDaemonSocket({ ...noDaemonEnv, TERN_DAEMON_SOCKET: "/x/daemon.sock" })).toBe("/x/daemon.sock");
	expect(resolveDaemonSocket(noDaemonEnv)).toBeNull();
});

// ---- SESSIONCAP1 (ompkit-774u.1.3): a session file of any size is decided from a bounded tail ----
const tailRoot = join(import.meta.dir, "..", "..", "var", "agent-tmp");
mkdirSync(tailRoot, { recursive: true });
const tailTmp = ownedTmp("plane-tern-tail", { root: tailRoot });
afterAll(() => tailTmp.cleanup());

const PAD_RECORD_BYTES = 64 * 1024;
const PAD_RECORDS = 1_120;
const OVER_CAP = 64 * 1024 * 1024;
const userText = (text: string) => ({ role: "user", content: [{ type: "text", text }] });
const stopped = { role: "assistant", stopReason: "stop", content: [{ type: "text", text: "done" }] };
const callsTool = (id: string) => ({ role: "assistant", stopReason: "toolUse", content: [{ type: "toolCall", id }] });
const runningWorker = (toolCallId: string) => ({ role: "toolResult", toolCallId, toolName: "task", isError: false, content: [],
	details: { async: { state: "running", jobId: "Worker", type: "task" } } });
/** The record omp's AgentSession#doDispose writes before cancelling every async job the process owns. */
const disposeExit = (id: string, parentId: string, pendingToolCalls?: unknown[]): string => JSON.stringify({ type: "custom", id,
	parentId, timestamp: stamp(7), customType: "session_exit",
	data: { reason: "dispose", kind: "normal", recordedAt: stamp(7), ...(pendingToolCalls ? { pendingToolCalls } : {}) } });
/** ~70 MiB before any tail: a turn whose async Worker job never reports back, then a chain of metadata records. */
const capHistory: string = (() => {
	const lines = [JSON.stringify({ type: "session", version: 3, id: "big-1", timestamp: stamp(0), cwd: "/repo" }),
		nativeMessage("user-0", null, 1, userText("start")), nativeMessage("assistant-0", "user-0", 2, callsTool("tool-0")),
		nativeMessage("tool-result-0", "assistant-0", 3, runningWorker("tool-0"))];
	const filler = "x".repeat(PAD_RECORD_BYTES);
	let parent = "tool-result-0";
	for (let n = 1; n <= PAD_RECORDS; n++) {
		lines.push(JSON.stringify({ type: "custom", id: `pad-${n}`, parentId: parent, timestamp: stamp(4), customType: "memory_recall", data: filler }));
		parent = `pad-${n}`;
	}
	return lines.join("\n") + "\n";
})();
const LAST_PAD = `pad-${PAD_RECORDS}`;
const capPath = join(tailTmp.path, "session-over-cap.jsonl");
function capSession(tail: string[], history: string = capHistory): string {
	writeFileSync(capPath, history + tail.join("\n") + "\n");
	return capPath;
}
function decideFile(path: string, windowBytes?: number): SessionJournalResult {
	const view = readSessionTail(path, windowBytes);
	expect(view).not.toBeNull();
	return parseSessionView(view!);
}
const endedTurn = [nativeMessage("user-1", LAST_PAD, 5, userText("next")), nativeMessage("assistant-1", "user-1", 6, stopped)];
/** The leaf proof a tail needs to claim IDLE. omp 18.10.3 never writes it (its ModelUsageEntry has no activeLeafId),
 * so a live over-cap tail can only reach BUSY or UNKNOWN; this stands for leaf proof in the synthetics. */
const leafPin = (leafId: string): string => JSON.stringify({ type: "model_usage", id: `usage-${leafId}`, parentId: leafId,
	timestamp: stamp(13), activeLeafId: leafId });
const endedTurnThenExit = [...endedTurn, disposeExit("exit-1", "assistant-1"), leafPin("exit-1")];
const pendingToolTail = [nativeMessage("user-1", LAST_PAD, 5, userText("next")), nativeMessage("assistant-1", "user-1", 6, callsTool("tool-1"))];

test("job lifecycle: a dispose exit settles earlier jobs dead-by-restart; without it, or after a signal exit, they stay unsettled", () => {
	const ended = nativeMessage("assistant-2", "tool-result-1", 4, stopped);
	const turn = [header, nativeUser, nativeAssistantTools, runningTask, ended];
	const withExit = parseSessionJournal([...turn, disposeExit("exit-1", "assistant-2")].join("\n") + "\n");
	expect(withExit).toMatchObject({ status: "KNOWN", leafId: "exit-1", unresolvedAsyncTool: false, oracleBusy: false });
	expect(sessionJournalDecision(withExit)).toBe("IDLE");
	const without = parseSessionJournal(turn.join("\n") + "\n");
	expect(without).toMatchObject({ status: "KNOWN", unresolvedAsyncTool: true, oracleBusy: null });
	expect(sessionJournalDecision(without)).toBe("UNKNOWN");
	// A signal exit is a postmortem hook that need not end the process (live: a job started before one was
	// delivered after it), so it settles nothing.
	const sigint = JSON.stringify({ type: "custom", id: "exit-1", parentId: "assistant-2", timestamp: stamp(7),
		customType: "session_exit", data: { reason: "sigint", kind: "signal", recordedAt: stamp(7) } });
	expect(sessionJournalDecision(parseSessionJournal([...turn, sigint].join("\n") + "\n"))).toBe("UNKNOWN");
	// omp's own pending list at the exit stays pending; an id-less entry can never be matched.
	for (const pending of [[{ toolCallId: "tool-9", toolName: "bash" }], [{ toolName: "bash" }]]) {
		expect(parseSessionJournal([...turn, disposeExit("exit-1", "assistant-2", pending)].join("\n") + "\n"))
			.toMatchObject({ status: "KNOWN", unresolvedAsyncTool: true, oracleBusy: null });
	}
	// A malformed pending list is not a checkpoint at all.
	expect(sessionJournalDecision(parseSessionJournal([...turn, disposeExit("exit-1", "assistant-2", [{ toolCallId: 7 }])]
		.join("\n") + "\n"))).toBe("UNKNOWN");
});

test("planted: a 70 MiB session whose job died at a dispose exit and whose turn ended reads IDLE from the tail", () => {
	const path = capSession(endedTurnThenExit);
	// Control: the whole-file reader refuses it, as it always did.
	expect(defaultTernIo().readSessionFile(path)).toBeNull();
	const result = decideFile(path);
	expect(result).toMatchObject({ status: "KNOWN", sessionId: "big-1", leafId: "exit-1", lastMessageRole: "assistant",
		terminalAssistantStop: true, unresolvedAsyncTool: false, oracleBusy: false, window: { anchored: true } });
	// The cut is real: the decision started within the last window, ~62 MiB past the async job's start.
	if (result.status === "KNOWN") {
		expect(result.window!.startBytes).toBeGreaterThanOrEqual(result.cursorBytes - SESSION_TAIL_WINDOW_BYTES);
		expect(result.cursorBytes).toBeGreaterThan(OVER_CAP);
	}
	expect(sessionJournalDecision(result)).toBe("IDLE");
});

test("planted: the same session with the restart record removed (its job started before the cut) is UNKNOWN, never IDLE", () => {
	expect(decideFile(capSession([...endedTurn, leafPin("assistant-1")]))).toEqual({ status: "UNKNOWN", reason: "TAIL_STATE_BEYOND_WINDOW" });
});

test("planted: an anchored tail without leaf proof is UNKNOWN, since a dead-end branch before the cut makes the whole parse refuse", () => {
	expect(decideFile(capSession([...endedTurn, disposeExit("exit-1", "assistant-1")])))
		.toEqual({ status: "UNKNOWN", reason: "TAIL_ACTIVE_LEAF_UNPROVEN" });
	// Why: omp leaves dead ends (here an aborted assistant turn that was retried); the whole parse refuses them.
	const aborted = nativeMessage("assistant-x", "user-1", 2, { role: "assistant", stopReason: "aborted", content: [] });
	const retried = nativeMessage("assistant-1", "user-1", 3, stopped);
	expect(parseSessionJournal([header, nativeUser, aborted, retried, disposeExit("exit-1", "assistant-1")].join("\n") + "\n"))
		.toEqual({ status: "UNKNOWN", reason: "ACTIVE_BRANCH_UNAVAILABLE" });
});

test("planted: a job id reused after the restart is a new job: running it reads BUSY, its own delivery settles it", () => {
	const reused = [...endedTurnThenExit, nativeMessage("user-2", "exit-1", 8, userText("again")),
		nativeMessage("assistant-2", "user-2", 9, callsTool("tool-2")), nativeMessage("tool-result-2", "assistant-2", 10, runningWorker("tool-2"))];
	const running = decideFile(capSession([...reused, leafPin("tool-result-2")]));
	expect(running).toMatchObject({ status: "KNOWN", unresolvedAsyncTool: true, oracleBusy: null, window: { anchored: true } });
	expect(sessionJournalDecision(running)).toBe("BUSY");
	const settled = decideFile(capSession([...reused,
		asyncResult("custom-message-2", "tool-result-2", 11, [{ jobId: "Worker", type: "task", status: "completed" }]),
		nativeMessage("assistant-3", "custom-message-2", 12, stopped), leafPin("assistant-3")]));
	expect(sessionJournalDecision(settled)).toBe("IDLE");
});

test("planted: a 70 MiB session whose tail has a pending tool reads BUSY; its settled control is UNKNOWN without an anchor", () => {
	const busy = decideFile(capSession(pendingToolTail));
	expect(busy).toMatchObject({ status: "KNOWN", lastMessageRole: "assistant", terminalAssistantStop: false,
		unresolvedAsyncTool: true, oracleBusy: null, window: { anchored: false } });
	expect(sessionJournalDecision(busy)).toBe("BUSY");
	const settled = decideFile(capSession([...pendingToolTail,
		nativeMessage("tool-result-1", "assistant-1", 7, { role: "toolResult", toolCallId: "tool-1", toolName: "read", isError: false, content: [], details: {} }),
		nativeMessage("assistant-2", "tool-result-1", 8, stopped)]));
	expect(settled).toEqual({ status: "UNKNOWN", reason: "TAIL_STATE_BEYOND_WINDOW" });
});

test("planted: a cut inside a record parses from the first complete record after it, never the fragment", () => {
	const path = capSession(endedTurnThenExit);
	const tailBytes = Buffer.byteLength(endedTurnThenExit.join("\n") + "\n");
	const windowBytes = tailBytes + PAD_RECORD_BYTES / 2;
	const result = decideFile(path, windowBytes);
	expect(result).toMatchObject({ status: "KNOWN", oracleBusy: false,
		window: { startBytes: Buffer.byteLength(capHistory), bytesRead: SESSION_HEAD_BYTES + windowBytes, anchored: true } });
	// Control: the first complete record after the cut is decoded strictly; corrupt it and the read refuses.
	const corrupt = ["{not json", ...endedTurnThenExit.slice(1)];
	capSession(corrupt);
	expect(decideFile(path, Buffer.byteLength(corrupt.join("\n") + "\n") + PAD_RECORD_BYTES / 2))
		.toEqual({ status: "UNKNOWN", reason: "MALFORMED_RECORD" });
	// A tail with no newline after the cut has no complete record to read.
	expect(decideFile(path, PAD_RECORD_BYTES / 2 + 1)).toMatchObject({ status: "UNKNOWN" });
	// An unterminated last record stays a partial read.
	appendFileSync(path, "{\"type\":\"message\"");
	expect(decideFile(path)).toEqual({ status: "UNKNOWN", reason: "PARTIAL_RECORD" });
});

test("bounded: a 70 MiB decision reads at most the window plus one head record cap, well inside a few seconds", () => {
	const path = capSession(endedTurnThenExit);
	const started = performance.now();
	const view = readSessionView(defaultTernIo(), path)!;
	const result = parseSessionView(view);
	const elapsedMs = performance.now() - started;
	expect(view.fileSize).toBeGreaterThan(OVER_CAP);
	expect(view.head.length + view.tail.length).toBeLessThanOrEqual(SESSION_TAIL_WINDOW_BYTES + SESSION_HEAD_BYTES);
	expect(result).toMatchObject({ status: "KNOWN", oracleBusy: false, cursorBytes: view.fileSize,
		window: { bytesRead: view.head.length + view.tail.length } });
	expect(elapsedMs).toBeLessThan(3_000);
	// Control: a file within the cap is still read and parsed whole; the tail reader declines it.
	const small = join(tailTmp.path, "session-small.jsonl");
	writeFileSync(small, terminalJournal);
	expect(defaultTernIo().readSessionTail!(small)).toBeNull();
	const whole = readSessionView(defaultTernIo(), small)!;
	expect(whole.tailStart).toBe(0);
	expect(parseSessionView(whole)).toEqual(parseSessionJournalImpl(terminalJournal));
});

function capIo(working: boolean, sessionFile: string) {
	const real = defaultTernIo();
	return {
		run(argv: string[]) {
			if (argv.includes("inspect")) {
				return { code: 0, out: JSON.stringify({ ...inspectFixture, panes: [{ ...inspectFixture.panes[0], working, omp_session_file: sessionFile }] }) };
			}
			if (argv.includes("process")) return { code: 0, out: JSON.stringify(processFixture) };
			if (argv[0] === "/bin/ps") return { code: 0, out: "Wed Oct 14 19:39:32 2026 omp --profile codex\n" };
			return { code: 2, out: "" };
		},
		readSessionFile: real.readSessionFile,
		readSessionTail: real.readSessionTail,
		wait: async () => {},
	};
}

test("observer decides an over-cap seat from its tail: IDLE when settled, never IDLE mid-turn", async () => {
	const path = capSession(endedTurnThenExit);
	expect(await observeTernSeat(seat, capIo(false, path))).toMatchObject({ state: "IDLE", working: false, oracleBusy: false,
		sessionFile: path, sessionCursorBytes: Buffer.byteLength(capHistory + endedTurnThenExit.join("\n") + "\n"), sessionLeafId: "exit-1" });
	capSession(pendingToolTail);
	expect(await observeTernSeat(seat, capIo(true, path))).toMatchObject({ state: "UNKNOWN", reason: "SESSION_TURN_IN_FLIGHT" });
	// Control: an io without the bounded reader still cannot read the file at all.
	const { readSessionTail: _dropped, ...wholeOnly } = capIo(false, path);
	expect(await observeTernSeat(seat, wholeOnly)).toMatchObject({ state: "UNKNOWN", reason: "SESSION_FILE_UNAVAILABLE" });
});

// Runs last: replays every journal fixture this file parsed.
test("equivalence: on every fixture above, a tail covering the body equals the whole parse, and no cut is less safe", () => {
	expect(journalCorpus.size).toBeGreaterThan(20);
	const comparable = (result: SessionJournalResult) =>
		result.status === "KNOWN" ? { ...result, sessionSha256: "", window: null } : result;
	let cuts = 0;
	let covered = 0;
	for (const text of journalCorpus) {
		const bytes = Buffer.from(text, "utf8");
		const whole = parseSessionJournalImpl(text);
		const wholeDecision = sessionJournalDecision(whole);
		const head = bytes.subarray(0, Math.min(SESSION_HEAD_BYTES, bytes.length));
		const tailFrom = (cut: number) => parseSessionJournalTail({ head, tail: bytes.subarray(cut), tailStart: cut,
			fileSize: bytes.length, identity: null, sha256: "fixture" });
		for (let cut = 0; cut < bytes.length; cut++) {
			const decision = sessionJournalDecision(tailFrom(cut));
			cuts++;
			if (decision !== "UNKNOWN") expect([text.length, cut, decision]).toEqual([text.length, cut, wholeDecision]);
		}
		// The smallest window that still covers the decision starts at the newline ending the session header.
		const headerLine = text.split("\n").findIndex((line) => line.includes(`"type":"session"`));
		if (headerLine < 0) continue;
		const bodyStart = Buffer.byteLength(text.split("\n").slice(0, headerLine + 1).join("\n") + "\n");
		expect(comparable(tailFrom(bodyStart - 1))).toEqual(comparable(whole));
		expect(comparable(tailFrom(0))).toEqual(comparable(whole));
		covered++;
	}
	expect(cuts).toBeGreaterThan(10_000);
	expect(covered).toBe(journalCorpus.size);
});


test("planted: a root record starting exactly at the cut is in the window; a cut mid-record still skips to the next newline", () => {
	const lines = [JSON.stringify({ type: "session", version: 3, id: "cut-1", timestamp: stamp(0), cwd: "/repo" }),
		JSON.stringify({ type: "custom", id: "pad-0", parentId: null, timestamp: stamp(1), customType: "memory_recall", data: "x".repeat(4096) }),
		nativeMessage("user-0", null, 2, userText("start")), nativeMessage("assistant-0", "user-0", 3, stopped), leafPin("assistant-0")];
	const text = lines.join("\n") + "\n";
	const rootAt = Buffer.byteLength(lines.slice(0, 2).join("\n") + "\n");
	const path = join(tailTmp.path, "session-cut-at-root.jsonl");
	writeFileSync(path, text);
	const window = Buffer.byteLength(text) - rootAt;
	const atCut = decideFile(path, window);
	expect(atCut).toMatchObject({ status: "KNOWN", leafId: "assistant-0", window: { startBytes: rootAt, anchored: true } });
	// Control: a cut 5 bytes inside the root record drops it and starts at the next record.
	const mid = decideFile(path, window - 5);
	expect(mid.status === "KNOWN" ? mid.window : mid).not.toMatchObject({ anchored: true });
	if (mid.status === "KNOWN") expect(mid.window!.startBytes).toBe(rootAt + Buffer.byteLength(lines[2]!) + 1);
});
