import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { readFileSync, statSync } from "node:fs";
import { basename, isAbsolute, relative, resolve, sep } from "node:path";

const MAX_SESSION_BYTES = 64 * 1024 * 1024;
const MAX_SESSION_RECORDS = 200_000;
const OBSERVE_RETRIES = 3;
const OBSERVE_RETRY_MS = 2_000;
const PROCESS_TIMEOUT_MS = 5_000;
const COMMAND_MAX_BUFFER = 16 * 1024 * 1024;
const TERMINAL_STOP_REASONS: Record<string, true> = {
	stop: true,
	length: true,
	error: true,
	aborted: true,
};


/** Configured Tern destination. A window key is mandatory; no first-window fallback exists. */
export interface TernSeatBinding {
	session: string;
	pane: string;
	windowKey: string;
	cwd: string;
	previousBinding?: TernRuntimeBinding | null;
}

export interface TernRuntimeBinding {
	sessionId: number;
	sessionFile: string;
	sessionUuid: string;
	paneId: number;
	foregroundPid: number;
	foregroundName: string;
	foregroundStarted: string;
	foregroundArgv: string[];
	cwd: string;
}

export interface TernForegroundProcess {
	pid: number;
	name: string;
	cwd: string;
	argv: string[];
	started: string | null;
}

export type TernInspectionResult =
	| { status: "FOUND"; sessionId: number; sessionName: string | null; paneId: number; cwd: string; working: boolean; exited: null; sessionFile: string }
	| { status: "DEAD"; sessionId: number; sessionName: string | null; paneId: number; cwd: string | null; working: false; exited: number | null; sessionFile: string | null; reason: string }
	| { status: "REFUSED"; code: "PLANE_SEAT_UNBOUND" | "TERN_WINDOW_UNBOUND" | "SEAT_REBOUND" | "SEAT_CWD_MISMATCH"; reason: string }
	| { status: "UNKNOWN"; reason: string };

export type TernProcessResult =
	| { status: "FOUND"; foreground: TernForegroundProcess }
	| { status: "UNKNOWN"; reason: string };

export type SessionJournalResult =
	| {
		status: "KNOWN";
		sessionId: string;
		cwd: string;
		leafId: string;
		cursorBytes: number;
		sessionSha256: string;
		terminalAssistantStop: boolean;
		lastMessageRole: string;
		unresolvedAsyncTool: boolean;
		oracleBusy: boolean | null;
	}
	| { status: "UNKNOWN"; reason: string };

export type TernObservation = {
	state: "BUSY" | "IDLE" | "DEAD" | "UNKNOWN";
	working: boolean | null;
	oracleBusy: boolean | null;
	sessionFile: string | null;
	sessionSha: string | null;
	sessionCursorBytes: number | null;
	sessionLeafId: string | null;
	fg: TernForegroundProcess | null;
	runtimeBinding: TernRuntimeBinding | null;
	evidence: string[];
	reason: string | null;
};

export type TernIdentityResult =
	| {
		status: "IDENTIFIED";
		agent: string;
		binding: string;
		cwdOk: true;
		runtimeBinding: TernRuntimeBinding;
	}
	| {
		status: "REFUSED";
		code: "PLANE_SEAT_UNBOUND" | "TERN_WINDOW_UNBOUND" | "SEAT_REBOUND" | "SEAT_CWD_MISMATCH" | "FOREGROUND_OMP_MISSING" | "FOREGROUND_OMP_AMBIGUOUS";
		reason: string;
		agent: null;
		binding: string | null;
		cwdOk: boolean;
		runtimeBinding: TernRuntimeBinding | null;
	}
	| { status: "UNKNOWN"; reason: string; agent: null; binding: null; cwdOk: false; runtimeBinding: null };

/** Test seam at the external command and session-file read boundaries. */
export interface TernObserverIo {
	run(argv: string[], env?: Record<string, string>): { code: number; out: string };
	readSessionFile(path: string): string | null;
	wait(ms: number): Promise<void>;
}

/** Real OMP v3 metadata records: chain topology only, never verdicts. Unknown types still refuse. */
const METADATA_TYPES: Record<string, true> = {
	model_change: true, custom: true, thinking_level_change: true, credential_pin: true, title_change: true,
};
interface JournalEntry {
	id: string;
	parentId: string | null;
	type: "message" | "tool_result" | "mode_change" | "model_usage" | "metadata";
	role: string | null;
	stopReason: string | null;
	toolCallIds: string[];
	toolCallId: string | null;
	asyncState: string | null;
	activeLeafId: string | null;
	offset: number;
}

function objectValue(value: unknown): Record<string, unknown> | null {
	if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
	return value as Record<string, unknown>;
}

function paneNumber(seat: TernSeatBinding): number | null {
	const value = seat.pane.startsWith("tern:") ? seat.pane.slice(5) : seat.pane;
	const paneId = Number(value);
	return Number.isSafeInteger(paneId) && paneId > 0 && String(paneId) === value ? paneId : null;
}

function withinRepo(repo: string, cwd: string): boolean {
	if (!isAbsolute(repo) || !isAbsolute(cwd)) return false;
	const pathFromRepo = relative(resolve(repo), resolve(cwd));
	return pathFromRepo === "" || (pathFromRepo !== ".." && !pathFromRepo.startsWith(`..${sep}`) && !isAbsolute(pathFromRepo));
}

type SeatValidation =
	| { ok: true; paneId: number }
	| { ok: false; code: "PLANE_SEAT_UNBOUND" | "TERN_WINDOW_UNBOUND"; reason: string };

function validateSeat(seat: TernSeatBinding): SeatValidation {
	if (typeof seat.session !== "string" || !seat.session.trim() || typeof seat.cwd !== "string" || !isAbsolute(seat.cwd)) {
		return { ok: false, code: "PLANE_SEAT_UNBOUND", reason: "Tern seat needs a configured session and absolute repository cwd" };
	}
	if (typeof seat.windowKey !== "string" || !seat.windowKey.trim()) {
		return { ok: false, code: "TERN_WINDOW_UNBOUND", reason: "Tern seat needs an explicit window key" };
	}
	if (typeof seat.pane !== "string") {
		return { ok: false, code: "PLANE_SEAT_UNBOUND", reason: "Tern pane must be an exact decimal block id or tern:<id>" };
	}
	const paneId = paneNumber(seat);
	if (paneId === null) {
		return { ok: false, code: "PLANE_SEAT_UNBOUND", reason: "Tern pane must be an exact decimal block id or tern:<id>" };
	}
	return { ok: true, paneId };
}


function parseJson(raw: unknown): { value: unknown } | { error: string } {
	if (typeof raw !== "string") return { value: raw };
	try { return { value: JSON.parse(raw) as unknown }; }
	catch { return { error: "MALFORMED_JSON" }; }
}

/** Join Tern's session/tab/block tree to panes[]; never infer a target from the first window. */
export function parseTernInspection(snapshot: unknown, seat: TernSeatBinding): TernInspectionResult {
	const validation = validateSeat(seat);
	if (!validation.ok) return { status: "REFUSED", code: validation.code, reason: validation.reason };
	const paneId = validation.paneId;

	const decoded = parseJson(snapshot);
	if ("error" in decoded) return { status: "UNKNOWN", reason: decoded.error };
	const root = objectValue(decoded.value);
	if (!root || !Array.isArray(root.sessions) || !Array.isArray(root.panes)) {
		return { status: "UNKNOWN", reason: "INSPECT_SCHEMA_UNKNOWN" };
	}
	const matchingSessions: { id: number; name: string | null; tabs: unknown[] }[] = [];
	for (const rawSession of root.sessions) {
		const session = objectValue(rawSession);
		if (!session || !Number.isSafeInteger(session.id) || (typeof session.name !== "string" && session.name !== null)
			|| !Array.isArray(session.tabs)) {
			return { status: "UNKNOWN", reason: "INSPECT_SESSION_SCHEMA_UNKNOWN" };
		}
		if (session.name === seat.session || String(session.id) === seat.session) {
			matchingSessions.push({ id: session.id as number, name: typeof session.name === "string" ? session.name : null, tabs: session.tabs });
		}
	}
	if (matchingSessions.length !== 1) {
		return { status: "REFUSED", code: "SEAT_REBOUND", reason: matchingSessions.length === 0
			? "configured Tern session is absent from the selected window" : "configured Tern session name is ambiguous" };
	}
	const selected = matchingSessions[0]!;
	let blockCount = 0;
	for (const rawTab of selected.tabs) {
		const tab = objectValue(rawTab);
		if (!tab || !Array.isArray(tab.blocks)) return { status: "UNKNOWN", reason: "INSPECT_TAB_SCHEMA_UNKNOWN" };
		for (const rawBlock of tab.blocks) {
			const block = objectValue(rawBlock);
			if (!block || !Number.isSafeInteger(block.id)) return { status: "UNKNOWN", reason: "INSPECT_BLOCK_SCHEMA_UNKNOWN" };
			if (block.id === paneId) blockCount++;
		}
	}
	if (blockCount === 0) {
		return { status: "DEAD", sessionId: selected.id, sessionName: selected.name, paneId, cwd: null, working: false,
			exited: null, sessionFile: null, reason: "PANE_MISSING_FROM_CONFIGURED_SESSION" };
	}
	if (blockCount !== 1) return { status: "UNKNOWN", reason: "INSPECT_BLOCK_AMBIGUOUS" };
	const matchingPanes = root.panes.filter((rawPane) => objectValue(rawPane)?.pane === paneId);
	if (matchingPanes.length !== 1) return { status: "UNKNOWN", reason: "INSPECT_PANE_ROW_MISSING_OR_DUPLICATE" };
	const pane = objectValue(matchingPanes[0]);
	if (!pane || typeof pane.cwd !== "string" || typeof pane.working !== "boolean"
		|| (pane.exited !== null && (typeof pane.exited !== "number" || !Number.isFinite(pane.exited)))) {
		return { status: "UNKNOWN", reason: "INSPECT_PANE_SCHEMA_UNKNOWN" };
	}
	const cwd = pane.cwd;
	if (cwd && !withinRepo(seat.cwd, cwd)) {
		return { status: "REFUSED", code: "SEAT_CWD_MISMATCH", reason: "Tern pane cwd is outside the configured repository" };
	}
	const sessionFile = pane.omp_session_file;
	if (pane.exited !== null) {
		return { status: "DEAD", sessionId: selected.id, sessionName: selected.name, paneId, cwd: cwd || null,
			working: false, exited: pane.exited, sessionFile: typeof sessionFile === "string" ? sessionFile : null, reason: "PANE_EXITED" };
	}
	if (!cwd || !isAbsolute(cwd) || typeof sessionFile !== "string" || !isAbsolute(sessionFile)) {
		return { status: "UNKNOWN", reason: "SESSION_FILE_OR_CWD_UNAVAILABLE" };
	}
	return { status: "FOUND", sessionId: selected.id, sessionName: selected.name, paneId, cwd, working: pane.working,
		exited: null, sessionFile };
}

function commandIsOmp(process: Record<string, unknown>, argv: string[]): boolean {
	const name = typeof process.name === "string" ? process.name.toLowerCase() : "";
	const executable = typeof process.executable === "string" ? basename(process.executable).toLowerCase() : "";
	const command = argv.length > 0 ? basename(argv[0]!).toLowerCase() : "";
	return name === "omp" || executable === "omp" || command === "omp";
}

/** Parse Tern's actual per-pane process result; only its foreground OMP process is accepted. */
export function parseTernProcess(snapshot: unknown, repo: string, paneId: number): TernProcessResult {
	const decoded = parseJson(snapshot);
	if ("error" in decoded) return { status: "UNKNOWN", reason: decoded.error };
	const root = objectValue(decoded.value);
	if (!root || root.pane !== paneId) return { status: "UNKNOWN", reason: "PROCESS_PANE_MISMATCH" };
	const foreground = objectValue(root.foreground);
	if (!foreground || !Array.isArray(foreground.argv)) return { status: "UNKNOWN", reason: "PROCESS_SCHEMA_UNKNOWN" };
	const argv = foreground.argv as string[];
	for (const arg of argv) {
		if (typeof arg !== "string") return { status: "UNKNOWN", reason: "PROCESS_SCHEMA_UNKNOWN" };
	}
	if (!commandIsOmp(foreground, argv)) return { status: "UNKNOWN", reason: "FOREGROUND_OMP_MISSING" };
	if (typeof foreground.pid !== "number" || !Number.isSafeInteger(foreground.pid)
		|| typeof foreground.cwd !== "string" || !isAbsolute(foreground.cwd) || typeof foreground.name !== "string") {
		return { status: "UNKNOWN", reason: "FOREGROUND_OMP_SCHEMA_UNKNOWN" };
	}
	if (!withinRepo(repo, foreground.cwd)) return { status: "UNKNOWN", reason: "FOREGROUND_OMP_CWD_MISMATCH" };
	return { status: "FOUND", foreground: { pid: foreground.pid, name: foreground.name, cwd: foreground.cwd,
		argv: [...argv], started: null } };
}

function parseJournalEntry(raw: Record<string, unknown>, offset: number): JournalEntry | null {
	const type = raw.type;
	if (type === "title") return null;
	if (typeof raw.id !== "string" || !raw.id) return null;
	const parentId = raw.parentId === null || raw.parentId === undefined ? null
		: typeof raw.parentId === "string" ? raw.parentId : undefined;
	if (parentId === undefined) return null;
	if (type === "model_usage") {
		return { id: raw.id, parentId, type, role: null, stopReason: null, toolCallIds: [], toolCallId: null,
			asyncState: null, activeLeafId: typeof raw.activeLeafId === "string" ? raw.activeLeafId : null, offset };
	}
	if (type === "message") {
		const message = objectValue(raw.message);
		if (!message || typeof message.role !== "string") return null;
		const toolCallIds: string[] = [];
		if (Array.isArray(message.toolCallIds)) {
			for (const value of message.toolCallIds) {
				if (typeof value !== "string" || !value) return null;
				toolCallIds.push(value);
			}
		}
		if (Array.isArray(message.content)) {
			for (const rawBlock of message.content) {
				const block = objectValue(rawBlock);
				if (!block || (block.type !== "toolCall" && block.type !== "tool_call")) continue;
				const id = typeof block.id === "string" ? block.id : block.toolCallId;
				if (typeof id !== "string" || !id) return null;
				if (!toolCallIds.includes(id)) toolCallIds.push(id);
			}
		}
		if (message.role === "toolResult") {
			const toolCallId = typeof message.toolCallId === "string" && message.toolCallId ? message.toolCallId
				: typeof message.callId === "string" && message.callId ? message.callId : null;
			const details = objectValue(message.details);
			const async = details ? objectValue(details.async) : null;
			return { id: raw.id, parentId, type: "tool_result", role: "toolResult", stopReason: null,
				toolCallIds: [], toolCallId, asyncState: async && typeof async.state === "string" ? async.state : null,
				activeLeafId: null, offset };
		}
		return { id: raw.id, parentId, type, role: message.role,
			stopReason: typeof message.stopReason === "string" ? message.stopReason : null,
			toolCallIds, toolCallId: null, asyncState: null, activeLeafId: null, offset };
	}
	if (type === "tool_result" || type === "toolResult") {
		const details = objectValue(raw.details);
		const async = details ? objectValue(details.async) : null;
		const toolCallId = typeof raw.toolCallId === "string" ? raw.toolCallId
			: typeof raw.callId === "string" ? raw.callId : null;
		return { id: raw.id, parentId, type: "tool_result", role: "toolResult", stopReason: null,
			toolCallIds: [], toolCallId, asyncState: async && typeof async.state === "string" ? async.state : null,
			activeLeafId: null, offset };
	}
	if (type === "mode_change") {
		return { id: raw.id, parentId, type, role: null, stopReason: null, toolCallIds: [], toolCallId: null,
			asyncState: null, activeLeafId: null, offset };
	}
	if (typeof type === "string" && METADATA_TYPES[type] === true) {
		return { id: raw.id, parentId, type: "metadata", role: null, stopReason: null, toolCallIds: [],
			toolCallId: null, asyncState: null, activeLeafId: null, offset };
	}
	return null;
}

function activeLeaf(entries: readonly JournalEntry[], byId: ReadonlyMap<string, JournalEntry>): string | null {
	let selected: string | null = null;
	for (const entry of entries) if (entry.type === "model_usage" && entry.activeLeafId !== null) selected = entry.activeLeafId;
	if (selected !== null) return byId.has(selected) ? selected : null;
	const parents = new Set(entries.map((entry) => entry.parentId).filter((id): id is string => id !== null));
	const leaves = entries.filter((entry) => !parents.has(entry.id)).map((entry) => entry.id);
	return leaves.length === 1 ? leaves[0]! : null;
}

function activeBranch(leafId: string, byId: ReadonlyMap<string, JournalEntry>): JournalEntry[] | null {
	const branch: JournalEntry[] = [];
	const seen = new Set<string>();
	let current: string | null = leafId;
	while (current !== null) {
		if (seen.has(current)) return null;
		seen.add(current);
		const entry = byId.get(current);
		if (!entry) return null;
		branch.push(entry);
		current = entry.parentId;
	}
	branch.reverse();
	return branch;
}

/** Parse OMP journal metadata only; message bodies and tool arguments never leave this parser. */
export function parseSessionJournal(text: string): SessionJournalResult {
	if (!text.endsWith("\n")) return { status: "UNKNOWN", reason: "PARTIAL_RECORD" };
	if (Buffer.byteLength(text, "utf8") > MAX_SESSION_BYTES) return { status: "UNKNOWN", reason: "SESSION_FILE_TOO_LARGE" };
	const entries: JournalEntry[] = [];
	const byId = new Map<string, JournalEntry>();
	let sessionId: string | null = null;
	let cwd: string | null = null;
	let offset = 0;
	const lines = text.split("\n");
	for (let index = 0; index < lines.length; index++) {
		const line = lines[index]!;
		const start = offset;
		offset += Buffer.byteLength(line, "utf8") + (index < lines.length - 1 ? 1 : 0);
		if (!line) continue;
		let decoded: unknown;
		try { decoded = JSON.parse(line) as unknown; }
		catch { return { status: "UNKNOWN", reason: "MALFORMED_RECORD" }; }
		const raw = objectValue(decoded);
		if (!raw || typeof raw.type !== "string") return { status: "UNKNOWN", reason: "INVALID_RECORD" };
		if (raw.type === "title") continue;
		if (raw.type === "session") {
			if (sessionId !== null || entries.length !== 0 || typeof raw.id !== "string" || !raw.id
				|| typeof raw.cwd !== "string" || !isAbsolute(raw.cwd) || (raw.version !== undefined && raw.version !== 3)) {
				return { status: "UNKNOWN", reason: "INVALID_SESSION_HEADER" };
			}
			sessionId = raw.id;
			cwd = raw.cwd;
			continue;
		}
		if (sessionId === null) return { status: "UNKNOWN", reason: "SESSION_HEADER_MISSING" };
		const entry = parseJournalEntry(raw, start);
		if (!entry || byId.has(entry.id)) return { status: "UNKNOWN", reason: "INVALID_OR_DUPLICATE_ENTRY" };
		entries.push(entry);
		byId.set(entry.id, entry);
		if (entries.length > MAX_SESSION_RECORDS) return { status: "UNKNOWN", reason: "SESSION_RECORD_LIMIT" };
	}
	if (sessionId === null || cwd === null) return { status: "UNKNOWN", reason: "SESSION_IDENTITY_MISSING" };
	const leafId = activeLeaf(entries, byId);
	if (leafId === null) return { status: "UNKNOWN", reason: "ACTIVE_BRANCH_UNAVAILABLE" };
	const branch = activeBranch(leafId, byId);
	if (branch === null) return { status: "UNKNOWN", reason: "ACTIVE_BRANCH_INCOMPLETE" };
	let lastMessageRole: string | null = null;
	let latestAssistant: JournalEntry | undefined;
	const pendingTools = new Set<string>();
	let unresolvedAsyncWithoutId = false;
	let unsupportedAsyncState = false;
	for (const entry of branch) {
		if (entry.type === "message") {
			lastMessageRole = entry.role;
			if (entry.role === "assistant") latestAssistant = entry;
		}
		if (entry.type === "message" && entry.role === "assistant") {
			for (const id of entry.toolCallIds) pendingTools.add(id);
		}
		if (entry.type === "tool_result") {
			if (entry.asyncState === "running" || entry.asyncState === "pending") {
				if (entry.toolCallId !== null) pendingTools.add(entry.toolCallId);
				else unresolvedAsyncWithoutId = true;
			} else if (entry.asyncState === null || entry.asyncState === "completed" || entry.asyncState === "cancelled") {
				if (entry.toolCallId !== null) pendingTools.delete(entry.toolCallId);
			} else unsupportedAsyncState = true;
		}
	}
	if (unsupportedAsyncState) return { status: "UNKNOWN", reason: "UNSUPPORTED_ASYNC_STATE" };
	const terminalAssistantStop = latestAssistant !== undefined
		&& TERMINAL_STOP_REASONS[latestAssistant.stopReason ?? ""] === true;
	const unresolvedAsyncTool = unresolvedAsyncWithoutId || pendingTools.size > 0;
	if (!lastMessageRole) return { status: "UNKNOWN", reason: "ACTIVE_BRANCH_HAS_NO_MESSAGE" };
	const oracleBusy = unresolvedAsyncTool ? null
		: lastMessageRole === "assistant" && terminalAssistantStop ? false
		: lastMessageRole === "user" ? true : null;
	return {
		status: "KNOWN", sessionId, cwd, leafId, cursorBytes: Buffer.byteLength(text, "utf8"),
		sessionSha256: createHash("sha256").update(text, "utf8").digest("hex"), terminalAssistantStop,
		lastMessageRole, unresolvedAsyncTool, oracleBusy,
	};
}

function unknownObservation(reason: string): TernObservation {
	return { state: "UNKNOWN", working: null, oracleBusy: null, sessionFile: null, sessionSha: null,
		sessionCursorBytes: null, sessionLeafId: null, fg: null, runtimeBinding: null, evidence: [], reason };
}

/** Classify only agreement between Tern's live flag and the independent OMP session journal. */
export function classifyTernObservation(
	inspection: TernInspectionResult,
	process: TernProcessResult,
	journal: SessionJournalResult,
): TernObservation {
	if (inspection.status === "DEAD") {
		return { state: "DEAD", working: false, oracleBusy: null, sessionFile: inspection.sessionFile,
			sessionSha: null, sessionCursorBytes: null, sessionLeafId: null, fg: null, runtimeBinding: null,
			evidence: ["tern-inspect"], reason: inspection.reason };
	}
	if (inspection.status !== "FOUND") return unknownObservation(inspection.status === "REFUSED" ? inspection.code : inspection.reason);
	if (process.status !== "FOUND") return unknownObservation(process.reason);
	if (journal.status !== "KNOWN") return unknownObservation(journal.reason);
	if (journal.cwd !== inspection.cwd) return unknownObservation("SESSION_CWD_MISMATCH");
	if (journal.oracleBusy === null) {
		return { state: "UNKNOWN", working: inspection.working, oracleBusy: null, sessionFile: inspection.sessionFile,
			sessionSha: journal.sessionSha256, sessionCursorBytes: journal.cursorBytes, sessionLeafId: journal.leafId,
			fg: process.foreground, runtimeBinding: null,
			evidence: ["tern-inspect", "tern-process", "session-file"], reason: "SESSION_ORACLE_STATE_UNKNOWN" };
	}
	if (inspection.working !== journal.oracleBusy) {
		return { state: "UNKNOWN", working: inspection.working, oracleBusy: journal.oracleBusy,
			sessionFile: inspection.sessionFile, sessionSha: journal.sessionSha256, sessionCursorBytes: journal.cursorBytes,
			sessionLeafId: journal.leafId, fg: process.foreground, runtimeBinding: null,
			evidence: ["tern-inspect", "tern-process", "session-file"], reason: "WORKING_ORACLE_DISAGREEMENT" };
	}
	if (process.foreground.started === null) {
		return { state: "UNKNOWN", working: inspection.working, oracleBusy: journal.oracleBusy,
			sessionFile: inspection.sessionFile, sessionSha: journal.sessionSha256, sessionCursorBytes: journal.cursorBytes,
			sessionLeafId: journal.leafId, fg: process.foreground, runtimeBinding: null,
			evidence: ["tern-inspect", "tern-process", "session-file"], reason: "FOREGROUND_INCARNATION_UNAVAILABLE" };
	}
	const runtimeBinding: TernRuntimeBinding = {
		sessionId: inspection.sessionId, sessionFile: inspection.sessionFile, sessionUuid: journal.sessionId,
		paneId: inspection.paneId, foregroundPid: process.foreground.pid, foregroundName: process.foreground.name,
		foregroundStarted: process.foreground.started, foregroundArgv: [...process.foreground.argv], cwd: inspection.cwd,
	};
	return { state: inspection.working ? "BUSY" : "IDLE", working: inspection.working, oracleBusy: journal.oracleBusy,
		sessionFile: inspection.sessionFile, sessionSha: journal.sessionSha256, sessionCursorBytes: journal.cursorBytes,
		sessionLeafId: journal.leafId, fg: process.foreground,
		runtimeBinding, evidence: ["tern-inspect", "tern-process", "session-file"], reason: null };
}
function sameRuntime(left: TernRuntimeBinding, right: TernRuntimeBinding): boolean {
	if (left.foregroundArgv.length !== right.foregroundArgv.length) return false;
	for (let index = 0; index < left.foregroundArgv.length; index++) {
		if (left.foregroundArgv[index] !== right.foregroundArgv[index]) return false;
	}
	return left.sessionId === right.sessionId && left.sessionFile === right.sessionFile && left.sessionUuid === right.sessionUuid
		&& left.paneId === right.paneId && left.foregroundPid === right.foregroundPid
		&& left.foregroundName === right.foregroundName && left.foregroundStarted === right.foregroundStarted
		&& left.cwd === right.cwd;
}


function runCommand(
	io: TernObserverIo,
	argv: string[],
	operation: string,
	env?: Record<string, string>,
): { value: unknown } | { error: string } {
	try {
		const result = io.run(argv, env);
		if (result.code !== 0) return { error: `${operation.toUpperCase()}_FAILED` };
		try { return { value: JSON.parse(result.out) as unknown }; }
		catch { return { error: `${operation.toUpperCase()}_MALFORMED_JSON` }; }
	} catch {
		return { error: `${operation.toUpperCase()}_FAILED` };
	}
}

function runTextCommand(
	io: TernObserverIo,
	argv: string[],
	operation: string,
	env?: Record<string, string>,
): { value: string } | { error: string } {
	try {
		const result = io.run(argv, env);
		return result.code === 0 ? { value: result.out } : { error: `${operation.toUpperCase()}_FAILED` };
	} catch {
		return { error: `${operation.toUpperCase()}_FAILED` };
	}
}

function parseProcessStart(text: string, expectedArgv: readonly string[]): string | null {
	const fields: string[] = [];
	for (const field of text.trim().split(" ")) if (field.length > 0) fields.push(field);
	if (fields.length !== expectedArgv.length + 5) return null;
	for (let index = 0; index < expectedArgv.length; index++) {
		if (fields[index + 5] !== expectedArgv[index]) return null;
	}
	return fields.slice(0, 5).join(" ");
}

function addProcessStart(io: TernObserverIo, process: TernProcessResult): TernProcessResult {
	if (process.status !== "FOUND") return process;
	const result = runTextCommand(io, ["/bin/ps", "-p", String(process.foreground.pid), "-o", "lstart=", "-o", "command="],
		"process_start", { LC_ALL: "C" });
	if ("error" in result) return { status: "UNKNOWN", reason: result.error };
	const started = parseProcessStart(result.value, process.foreground.argv);
	if (started === null) return { status: "UNKNOWN", reason: "FOREGROUND_INCARNATION_UNAVAILABLE" };
	return { status: "FOUND", foreground: { ...process.foreground, started } };
}


function defaultTernIo(): TernObserverIo {
	return {
		run(argv, env) {
			try {
				const child = spawnSync(argv[0]!, argv.slice(1), { encoding: "utf8", timeout: PROCESS_TIMEOUT_MS,
					maxBuffer: COMMAND_MAX_BUFFER, ...(env ? { env } : {}) });
				return { code: child.status ?? 1, out: String(child.stdout ?? "") };
			} catch {
				return { code: 1, out: "" };
			}
		},
		readSessionFile(path) {
			try {
				const before = statSync(path);
				if (!before.isFile() || before.size > MAX_SESSION_BYTES) return null;
				const text = readFileSync(path, "utf8");
				const after = statSync(path);
				if (before.dev !== after.dev || before.ino !== after.ino || before.size !== after.size
					|| before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs) return null;
				return text;
			} catch { return null; }
		},
		wait(ms) { return new Promise<void>((resolve) => setTimeout(resolve, ms)); },
	};
}

function observationFromReads(seat: TernSeatBinding, io: TernObserverIo): TernObservation {
	const firstInspect = runCommand(io, ["tern", "--window", seat.windowKey, "inspect", "--json"], "inspect");
	if ("error" in firstInspect) return unknownObservation(firstInspect.error);
	const inspection = parseTernInspection(firstInspect.value, seat);
	if (inspection.status === "DEAD") {
		return { state: "DEAD", working: false, oracleBusy: null, sessionFile: inspection.sessionFile,
			sessionSha: null, sessionCursorBytes: null, sessionLeafId: null, fg: null, runtimeBinding: null,
			evidence: ["tern-inspect"], reason: inspection.reason };
	}
	if (inspection.status !== "FOUND") return unknownObservation(inspection.status === "REFUSED" ? inspection.code : inspection.reason);
	const processJson = runCommand(io, ["tern", "--window", seat.windowKey, "process", String(inspection.paneId), "--json"], "process");
	if ("error" in processJson) return unknownObservation(processJson.error);
	const process = addProcessStart(io, parseTernProcess(processJson.value, seat.cwd, inspection.paneId));
	if (process.status !== "FOUND") return unknownObservation(process.reason);
	let journalText: string | null;
	try { journalText = io.readSessionFile(inspection.sessionFile); }
	catch { return unknownObservation("SESSION_FILE_UNAVAILABLE"); }
	if (journalText === null) return unknownObservation("SESSION_FILE_UNAVAILABLE");
	const journal = parseSessionJournal(journalText);
	const observation = classifyTernObservation(inspection, process, journal);
	if (observation.state === "UNKNOWN" && observation.reason === "WORKING_ORACLE_DISAGREEMENT") return observation;
	if (observation.state !== "IDLE" && observation.state !== "BUSY") return observation;
	const secondInspect = runCommand(io, ["tern", "--window", seat.windowKey, "inspect", "--json"], "inspect");
	if ("error" in secondInspect) return unknownObservation(secondInspect.error);
	const inspectionAfter = parseTernInspection(secondInspect.value, seat);
	if (inspectionAfter.status !== "FOUND") return unknownObservation("OBSERVATION_CHANGED_DURING_READ");
	const processAfterJson = runCommand(io, ["tern", "--window", seat.windowKey, "process", String(inspectionAfter.paneId), "--json"], "process");
	if ("error" in processAfterJson) return unknownObservation(processAfterJson.error);
	const processAfter = addProcessStart(io, parseTernProcess(processAfterJson.value, seat.cwd, inspectionAfter.paneId));
	if (processAfter.status !== "FOUND") return unknownObservation(processAfter.reason);
	if (processAfter.foreground.started === null) return unknownObservation("FOREGROUND_INCARNATION_UNAVAILABLE");
	let journalAfterText: string | null;
	try { journalAfterText = io.readSessionFile(inspectionAfter.sessionFile); }
	catch { return unknownObservation("SESSION_FILE_UNAVAILABLE"); }
	if (journalAfterText === null) return unknownObservation("SESSION_FILE_UNAVAILABLE");
	const journalAfter = parseSessionJournal(journalAfterText);
	if (journal.status !== "KNOWN" || journalAfter.status !== "KNOWN" || journalAfter.sessionId !== journal.sessionId
		|| journalAfter.cursorBytes !== journal.cursorBytes || journalAfter.sessionSha256 !== journal.sessionSha256) {
		return unknownObservation("SESSION_CHANGED_DURING_READ");
	}
	const afterBinding: TernRuntimeBinding = {
		sessionId: inspectionAfter.sessionId, sessionFile: inspectionAfter.sessionFile, sessionUuid: journalAfter.sessionId,
		paneId: inspectionAfter.paneId, foregroundPid: processAfter.foreground.pid,
		foregroundName: processAfter.foreground.name, foregroundStarted: processAfter.foreground.started,
		foregroundArgv: [...processAfter.foreground.argv], cwd: inspectionAfter.cwd,
	};
	if (!sameRuntime(observation.runtimeBinding!, afterBinding) || observation.working !== inspectionAfter.working) {
		return unknownObservation("OBSERVATION_CHANGED_DURING_READ");
	}
	return observation;
}

/** Observe one explicitly window-scoped Tern seat; missing evidence is never IDLE. */
export async function observeTernSeat(seat: TernSeatBinding, io: TernObserverIo = defaultTernIo()): Promise<TernObservation> {
	const validation = validateSeat(seat);
	if (!validation.ok) return unknownObservation(validation.code);
	for (let retry = 0; retry <= OBSERVE_RETRIES; retry++) {
		const observation = observationFromReads(seat, io);
		if (observation.reason !== "WORKING_ORACLE_DISAGREEMENT") return observation;
		if (retry < OBSERVE_RETRIES) await io.wait(OBSERVE_RETRY_MS);
		else return { ...observation, reason: "WORKING_ORACLE_DISAGREEMENT_AFTER_RETRIES" };
	}
	return unknownObservation("OBSERVATION_UNAVAILABLE");
}

/** Validate the exact Agent Mail recipient and current runtime incarnation for a Tern seat. */
export async function identifyTernSeat(seat: TernSeatBinding, io: TernObserverIo = defaultTernIo()): Promise<TernIdentityResult> {
	const validation = validateSeat(seat);
	if (!validation.ok) return { status: "REFUSED", code: validation.code, reason: validation.reason, agent: null,
		binding: null, cwdOk: false, runtimeBinding: null };
	const observation = await observeTernSeat(seat, io);
	if (observation.state === "DEAD") return { status: "REFUSED", code: "PLANE_SEAT_UNBOUND", reason: "Tern pane is dead",
		agent: null, binding: null, cwdOk: false, runtimeBinding: null };
	if (observation.state !== "IDLE" && observation.state !== "BUSY") {
		const reason = observation.reason ?? "Tern identity observation unavailable";
		if (reason === "PLANE_SEAT_UNBOUND" || reason === "TERN_WINDOW_UNBOUND" || reason === "SEAT_REBOUND"
			|| reason === "SEAT_CWD_MISMATCH" || reason === "FOREGROUND_OMP_MISSING"
			|| reason === "FOREGROUND_OMP_AMBIGUOUS") {
			return { status: "REFUSED", code: reason, reason, agent: null, binding: null, cwdOk: false,
				runtimeBinding: observation.runtimeBinding };
		}
		return { status: "UNKNOWN", reason, agent: null, binding: null, cwdOk: false, runtimeBinding: null };
	}
	const paneId = paneNumber(seat)!;
	const resolution = runCommand(io, ["am", "agents", "resolve-pane", "--project", seat.cwd,
		"--pane", `tern:${paneId}`, "--json"], "agent_resolution");
	if ("error" in resolution) return { status: "REFUSED", code: "PLANE_SEAT_UNBOUND", reason: "Agent Mail identity did not resolve",
		agent: null, binding: null, cwdOk: false, runtimeBinding: observation.runtimeBinding };
	const row = objectValue(resolution.value);
	if (!row || typeof row.agent_name !== "string" || !row.agent_name || row.pane_id !== `tern:${paneId}`
		|| row.project_key !== resolve(seat.cwd) || typeof row.binding !== "string" || !row.binding) {
		return { status: "REFUSED", code: "PLANE_SEAT_UNBOUND", reason: "Agent Mail identity does not bind this exact Tern pane and project",
			agent: null, binding: typeof row?.binding === "string" ? row.binding : null, cwdOk: false,
			runtimeBinding: observation.runtimeBinding };
	}
	const priorBindingMatches = seat.previousBinding ? sameRuntime(seat.previousBinding, observation.runtimeBinding!) : false;
	if (seat.previousBinding && !priorBindingMatches) {
		return { status: "REFUSED", code: "SEAT_REBOUND", reason: "Tern runtime incarnation changed since bind",
			agent: null, binding: row.binding, cwdOk: false, runtimeBinding: observation.runtimeBinding };
	}
	if (row.binding !== "verified-live" && !(row.binding === "legacy-unverified" && priorBindingMatches)) {
		return { status: "REFUSED", code: "PLANE_SEAT_UNBOUND", reason: "Agent Mail pane binding is not verified against this runtime",
			agent: null, binding: row.binding, cwdOk: false, runtimeBinding: observation.runtimeBinding };
	}
	return { status: "IDENTIFIED", agent: row.agent_name, binding: row.binding, cwdOk: true,
		runtimeBinding: observation.runtimeBinding! };
}
