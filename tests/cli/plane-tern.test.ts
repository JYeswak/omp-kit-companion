import { expect, test } from "bun:test";

import {
	classifyTernObservation,
	identifyTernSeat,
	observeTernSeat,
	parseSessionJournal,
	parseTernInspection,
	parseTernProcess,
	resolveDaemonSocket,
	resolveTernWindow,
	ternWindowArgv,
	ternWindowEnv,
} from "../../src/plane-tern.ts";


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

test("Tern inspect reports a missing block as DEAD", () => {
	expect(parseTernInspection(inspectFixture, { ...seat, pane: "999" })).toMatchObject({ status: "DEAD" });
});

test("Tern inspect rejects cwd outside the configured repository", () => {
	const snapshot = { ...inspectFixture, panes: [{ ...inspectFixture.panes[0], cwd: "/outside" }] };
	expect(parseTernInspection(snapshot, seat)).toMatchObject({ status: "REFUSED", code: "SEAT_CWD_MISMATCH" });
});

test("Tern inspect requires an explicit window key", () => {
	expect(parseTernInspection(inspectFixture, { ...seat, windowKey: "" }))
		.toMatchObject({ status: "REFUSED", code: "TERN_WINDOW_UNBOUND" });
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
		unresolvedAsyncTool: false, oracleBusy: true } as const;
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

