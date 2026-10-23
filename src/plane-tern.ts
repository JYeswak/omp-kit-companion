import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { closeSync, fstatSync, openSync, readFileSync, readSync, statSync } from "node:fs";
import { basename, isAbsolute, relative, resolve, sep } from "node:path";

/** Whole-file parse cap; a larger session file is decided from a bounded tail (ompkit-774u.1.3). */
const MAX_SESSION_BYTES = 64 * 1024 * 1024;
/** Tail window for an over-cap session file: the decision reads at most this plus SESSION_HEAD_BYTES. */
export const SESSION_TAIL_WINDOW_BYTES = 8 * 1024 * 1024;
/** Head read for the session header (one record cap; live headers end within 653 bytes). */
export const SESSION_HEAD_BYTES = 64 * 1024;
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


/** Configured Tern destination. An empty window key resolves to Tern's
documented default window (ompkit-kdbz.2.16); it is never sent blind.
Resolution (resolveTernWindow) verifies the key against the addressed
window's own snapshot before any effect, so every send argv is either
`--window KEY` for a verified key or the verified default addressing. */
export interface TernSeatBinding {
	session: string;
	pane: string;
	windowKey: string;
	cwd: string;
	previousBinding?: TernRuntimeBinding | null;
}

/** Addressable Tern window from resolveTernWindow: a verified explicit key,
or Tern's documented default (first) window when the seat carries no key.
Tern 0.9.x sets TERN_WINDOW_KEY on no local window (verified live
2026-10-20, even in window-attached panes), and any other --window value
leaves the local daemon (remote dial + hang), so the default is the only
addressing for the fleet window. daemonSocket pins the daemon connection
($TERN_DAEMON_SOCKET, else the configured default socket). */
export type TernWindowResolution =
	| { ok: true; kind: "key"; windowKey: string; daemonSocket: string | null }
	| { ok: true; kind: "default"; daemonSocket: string | null }
	| { ok: false; code: "PLANE_SEAT_UNBOUND"; reason: string };

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
		/** File size the decision read up to. */
		cursorBytes: number;
		/** Whole-file parse: sha256 of the file. Tail decision: the view fingerprint (inode, size, head, window). */
		sessionSha256: string;
		terminalAssistantStop: boolean;
		lastMessageRole: string;
		unresolvedAsyncTool: boolean;
		oracleBusy: boolean | null;
		/** Null for a whole-file parse; how a bounded tail decided otherwise. */
		window: SessionWindowInfo | null;
	}
	| { status: "UNKNOWN"; reason: string };

/** How a tail decision was read. Unless the state is anchored and the leaf proven, the result only ever reports
 * a not-idle verdict (oracleBusy null): tool calls and async jobs before the cut are unseen, so
 * `unresolvedAsyncTool` and `terminalAssistantStop` are then lower bounds read from the window alone. */
export interface SessionWindowInfo {
	/** File offset of the first complete record parsed after the cut. */
	startBytes: number;
	/** Bytes the view holds: head plus tail window. */
	bytesRead: number;
	/** The active branch reached its root or an omp process-exit checkpoint inside the window. */
	anchored: boolean;
	/** The window holds the whole body or the last `model_usage.activeLeafId` pin. */
	leafProven: boolean;
}

/** A session file as read: whole (tailStart 0, from text) or a bounded tail of one inode. */
export interface SessionJournalView {
	/** Bytes [0, head.length), at most SESSION_HEAD_BYTES: the leading title and session header. */
	head: Buffer;
	/** Bytes [tailStart, fileSize). */
	tail: Buffer;
	tailStart: number;
	fileSize: number;
	/** `dev:ino` of the file read; null for a text read that does not report it. */
	identity: string | null;
	/** Change fingerprint: sha256 of the text for a whole read, else of identity, size, head and tail. */
	sha256: string;
}

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

/** Test seam at the external command and session-file read boundaries. `readSessionFile` returns the whole
 * file within the parse cap; `readSessionTail`, when present, is the bounded fallback for a larger file. */
export interface TernObserverIo {
	run(argv: string[], env?: Record<string, string>): { code: number; out: string };
	readSessionFile(path: string): string | null;
	readSessionTail?(path: string): SessionJournalView | null;
	wait(ms: number): Promise<void>;
}

/** Real OMP v3 metadata records: chain topology only, never verdicts. Unknown types still refuse. */
const METADATA_TYPES: Record<string, true> = {
	model_change: true, custom: true, thinking_level_change: true, credential_pin: true, title_change: true,
	ttsr_injection: true, label: true, service_tier_change: true, session_init: true,
};
/** OMP v3 records that change model context without a role message (an extension message can start a turn,
 * a compaction can precede an auto-retry); one ending the branch leaves the oracle with no verdict. */
const CONTEXT_TYPES: Record<string, true> = {
	custom_message: true, compaction: true, branch_summary: true, reset_boundary: true,
};
/** OMP async job outcomes; a running tool result is settled only by an `async-result` delivery naming its job. */
const TERMINAL_JOB_STATES: Record<string, true> = { completed: true, failed: true, cancelled: true };
interface DeliveredJob { jobId: string; status: string }
interface JournalEntry {
	id: string;
	parentId: string | null;
	type: "message" | "tool_result" | "mode_change" | "model_usage" | "metadata" | "context";
	role: string | null;
	stopReason: string | null;
	toolCallIds: string[];
	toolCallId: string | null;
	asyncState: string | null;
	activeLeafId: string | null;
	offset: number;
	/** Job id a running async tool result waits on. */
	asyncJobId?: string | undefined;
	/** Jobs an `async-result` custom_message delivers; "malformed" when its details do not name them. */
	deliveredJobs?: readonly DeliveredJob[] | "malformed" | undefined;
	/** A process-exit checkpoint: the tool calls omp recorded pending when it disposed the session. */
	checkpoint?: ExitCheckpoint | undefined;
}
interface ExitCheckpoint { pending: readonly string[]; idless: boolean }

function objectValue(value: unknown): Record<string, unknown> | null {
	if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
	return value as Record<string, unknown>;
}

/** Resolve the two tool-call id spellings; conflicting aliases refuse the record. */
function toolResultId(primary: unknown, alias: unknown): { id: string | null } | { conflict: true } {
	const first = typeof primary === "string" && primary ? primary : null;
	const second = typeof alias === "string" && alias ? alias : null;
	if (first !== null && second !== null && first !== second) return { conflict: true };
	return { id: first ?? second };
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

/** Pin the daemon connection without hardcoding a home directory: explicit
$TERN_DAEMON_SOCKET wins, else $TERN_CONFIG_DIR/daemon.sock, else the
default settings-directory socket, each only when it exists. Null leaves
the tern CLI's own fallback alone. */
export function resolveDaemonSocket(env: Record<string, string | undefined> = process.env): string | null {
	const override = env.TERN_DAEMON_SOCKET;
	if (typeof override === "string" && override.trim() !== "") return override;
	const candidates: string[] = [];
	const configDir = env.TERN_CONFIG_DIR;
	if (typeof configDir === "string" && configDir.trim() !== "") candidates.push(`${configDir}/daemon.sock`);
	const home = env.HOME;
	if (typeof home === "string" && home !== "") {
		candidates.push(`${home}/Library/Application Support/Tern/daemon.sock`);
	}
	for (const candidate of candidates) {
		try {
			if (statSync(candidate).isSocket()) return candidate;
		} catch { /* absent or unreadable: not this daemon */ }
	}
	return null;
}


/** Resolve the window a seat's effects address (ompkit-kdbz.2.16). Structural
defects refuse before any command runs. Otherwise the addressed window's own
`inspect` snapshot must list the configured session: explicit keys verify
with `--window KEY`, empty keys verify without the flag (Tern's documented
default/first window). Anything else is PLANE_SEAT_UNBOUND, never a blind
send: callers build send argv only from an ok resolution. */
export function resolveTernWindow(
	seat: TernSeatBinding,
	io: TernObserverIo,
	env: Record<string, string | undefined> = process.env,
): TernWindowResolution {
	if (typeof seat.session !== "string" || !seat.session.trim() || typeof seat.cwd !== "string" || !isAbsolute(seat.cwd)) {
		return { ok: false, code: "PLANE_SEAT_UNBOUND", reason: "Tern seat needs a configured session and absolute repository cwd" };
	}
	if (typeof seat.pane !== "string" || paneNumber(seat) === null) {
		return { ok: false, code: "PLANE_SEAT_UNBOUND", reason: "Tern pane must be an exact decimal block id or tern:<id>" };
	}
	const socket = resolveDaemonSocket(env);
	const runEnv = socket === null ? undefined : { TERN_DAEMON_SOCKET: socket };
	const explicit = typeof seat.windowKey === "string" && seat.windowKey.trim() !== "";
	let raw: { code: number; out: string };
	try {
		raw = io.run(explicit ? ["tern", "--window", seat.windowKey, "inspect", "--json"] : ["tern", "inspect", "--json"], runEnv);
	} catch {
		return { ok: false, code: "PLANE_SEAT_UNBOUND",
			reason: explicit ? "window key did not address a live window" : "default Tern window did not resolve" };
	}
	const decoded = parseJson(raw.out);
	const root = "error" in decoded ? null : objectValue(decoded.value);
	const sessionListed = !!root && Array.isArray(root.sessions) && root.sessions.some((rawSession) => {
		const candidate = objectValue(rawSession);
		return !!candidate && (candidate.name === seat.session || String(candidate.id) === seat.session);
	});
	if (raw.code !== 0 || !sessionListed) {
		return { ok: false, code: "PLANE_SEAT_UNBOUND",
			reason: explicit ? "window key did not address a window hosting the configured session"
				: "configured Tern session is absent from the default window" };
	}
	return explicit ? { ok: true, kind: "key", windowKey: seat.windowKey, daemonSocket: socket }
		: { ok: true, kind: "default", daemonSocket: socket };
}

/** Send-addressing argv for a resolved window: `--window KEY`, or nothing
(Tern's documented default window). Never invent a flag for a refusal. */
export function ternWindowArgv(resolution: Extract<TernWindowResolution, { ok: true }>): string[] {
	return resolution.kind === "key" ? ["--window", resolution.windowKey] : [];
}

/** Daemon-connection env for a resolved window; undefined leaves the CLI default. */
export function ternWindowEnv(resolution: Extract<TernWindowResolution, { ok: true }>): Record<string, string> | undefined {
	return resolution.daemonSocket === null ? undefined : { TERN_DAEMON_SOCKET: resolution.daemonSocket };
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
			const resolved = toolResultId(message.toolCallId, message.callId);
			if ("conflict" in resolved) return null;
			const toolCallId = resolved.id;
			const details = objectValue(message.details);
			const async = details ? objectValue(details.async) : null;
			return { id: raw.id, parentId, type: "tool_result", role: "toolResult", stopReason: null,
				toolCallIds: [], toolCallId, asyncState: async && typeof async.state === "string" ? async.state : null,
				activeLeafId: null, offset, asyncJobId: async && typeof async.jobId === "string" && async.jobId ? async.jobId : undefined };
		}
		return { id: raw.id, parentId, type, role: message.role,
			stopReason: typeof message.stopReason === "string" ? message.stopReason : null,
			toolCallIds, toolCallId: null, asyncState: null, activeLeafId: null, offset };
	}
	if (type === "tool_result" || type === "toolResult") {
		const resolved = toolResultId(raw.toolCallId, raw.callId);
		if ("conflict" in resolved) return null;
		const toolCallId = resolved.id;
		const details = objectValue(raw.details);
		const async = details ? objectValue(details.async) : null;
		return { id: raw.id, parentId, type: "tool_result", role: "toolResult", stopReason: null,
			toolCallIds: [], toolCallId, asyncState: async && typeof async.state === "string" ? async.state : null,
			activeLeafId: null, offset, asyncJobId: async && typeof async.jobId === "string" && async.jobId ? async.jobId : undefined };
	}
	if (type === "mode_change") {
		return { id: raw.id, parentId, type, role: null, stopReason: null, toolCallIds: [], toolCallId: null,
			asyncState: null, activeLeafId: null, offset };
	}
	if (typeof type === "string" && METADATA_TYPES[type] === true) {
		return { id: raw.id, parentId, type: "metadata", role: null, stopReason: null, toolCallIds: [],
			toolCallId: null, asyncState: null, activeLeafId: null, offset,
			checkpoint: type === "custom" && raw.customType === "session_exit" ? exitCheckpoint(raw.data) : undefined };
	}
	if (typeof type === "string" && CONTEXT_TYPES[type] === true) {
		return { id: raw.id, parentId, type: "context", role: type, stopReason: null, toolCallIds: [],
			toolCallId: null, asyncState: null, activeLeafId: null, offset,
			deliveredJobs: type === "custom_message" && raw.customType === "async-result" ? deliveredJobs(raw.details) : undefined };
	}
	return null;
}

function deliveredJobs(rawDetails: unknown): readonly DeliveredJob[] | "malformed" {
	const jobs = objectValue(rawDetails)?.jobs;
	if (!Array.isArray(jobs)) return "malformed";
	const delivered: DeliveredJob[] = [];
	for (const rawJob of jobs) {
		const job = objectValue(rawJob);
		if (!job || typeof job.jobId !== "string" || !job.jobId || typeof job.status !== "string") return "malformed";
		delivered.push({ jobId: job.jobId, status: job.status });
	}
	return delivered;
}

/** A process-exit checkpoint, or undefined when the record is not one. omp writes `session_exit` with reason
 * "dispose" (kind "normal") only from AgentSession#doDispose, which then cancels every async job the process owns
 * (pi-coding-agent session/agent-session.ts #disposeOwnedAsyncJobs), and its `pendingToolCalls` is omp's own
 * pending set for the branch at that moment. Signal exits ("sigint", "sigterm") come from a postmortem hook that
 * need not end the process (live: a job started before a sigint exit was delivered after it), so they never settle
 * a job; neither does a dispose record whose pending list is malformed. */
function exitCheckpoint(rawData: unknown): ExitCheckpoint | undefined {
	const data = objectValue(rawData);
	if (!data || data.reason !== "dispose" || data.kind !== "normal") return undefined;
	if (data.pendingToolCalls === undefined) return { pending: [], idless: false };
	if (!Array.isArray(data.pendingToolCalls)) return undefined;
	const pending: string[] = [];
	let idless = false;
	for (const rawCall of data.pendingToolCalls) {
		const call = objectValue(rawCall);
		if (!call || typeof call.toolName !== "string") return undefined;
		if (call.toolCallId === undefined) idless = true;
		else if (typeof call.toolCallId === "string" && call.toolCallId) pending.push(call.toolCallId);
		else return undefined;
	}
	return { pending, idless };
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

interface JournalScan { sessionId: string | null; cwd: string | null; entries: JournalEntry[]; byId: Map<string, JournalEntry> }

/** The identity of a valid OMP v3 session header record, else null. */
function sessionHeader(raw: Record<string, unknown>): { id: string; cwd: string } | null {
	if (typeof raw.id !== "string" || !raw.id || typeof raw.cwd !== "string" || !isAbsolute(raw.cwd)
		|| (raw.version !== undefined && raw.version !== 3)) return null;
	return { id: raw.id, cwd: raw.cwd };
}

/** Decode the newline-terminated records of `text` (starting at file offset `base`) into `scan`; null on
 * success, else the refusal reason. */
function scanRecords(text: string, base: number, scan: JournalScan): string | null {
	let offset = base;
	const lines = text.split("\n");
	for (let index = 0; index < lines.length; index++) {
		const line = lines[index]!;
		const start = offset;
		offset += Buffer.byteLength(line, "utf8") + (index < lines.length - 1 ? 1 : 0);
		if (!line) continue;
		let decoded: unknown;
		try { decoded = JSON.parse(line) as unknown; }
		catch { return "MALFORMED_RECORD"; }
		const raw = objectValue(decoded);
		if (!raw || typeof raw.type !== "string") return "INVALID_RECORD";
		if (raw.type === "title") continue;
		if (raw.type === "session") {
			const header = scan.sessionId === null && scan.entries.length === 0 ? sessionHeader(raw) : null;
			if (header === null) return "INVALID_SESSION_HEADER";
			scan.sessionId = header.id;
			scan.cwd = header.cwd;
			continue;
		}
		if (scan.sessionId === null) return "SESSION_HEADER_MISSING";
		const entry = parseJournalEntry(raw, start);
		if (!entry || scan.byId.has(entry.id)) return "INVALID_OR_DUPLICATE_ENTRY";
		scan.entries.push(entry);
		scan.byId.set(entry.id, entry);
		if (scan.entries.length > MAX_SESSION_RECORDS) return "SESSION_RECORD_LIMIT";
	}
	return null;
}

interface BranchState {
	lastMessageRole: string | null;
	latestAssistant: JournalEntry | undefined;
	pendingTools: Set<string>;
	unresolvedAsyncWithoutId: boolean;
	unsupportedAsyncState: boolean;
	/** A root or a process-exit checkpoint fixed every earlier tool call and async job. */
	anchored: boolean;
}

/** Replay a branch, or the in-window suffix of one, in order. */
function evaluateBranch(branch: readonly JournalEntry[], rooted: boolean): BranchState {
	const state: BranchState = { lastMessageRole: null, latestAssistant: undefined, pendingTools: new Set(),
		unresolvedAsyncWithoutId: false, unsupportedAsyncState: false, anchored: rooted };
	const runningJobs = new Map<string, string>();
	for (const entry of branch) {
		if (entry.checkpoint !== undefined) {
			// Dead-by-restart: the exiting process cancelled every async job it owned, and a job id reused after
			// it names a new job. omp's own pending list at exit replaces the replayed one.
			state.pendingTools = new Set(entry.checkpoint.pending);
			runningJobs.clear();
			state.unresolvedAsyncWithoutId = entry.checkpoint.idless;
			state.unsupportedAsyncState = false;
			state.anchored = true;
		}
		if (entry.type === "message" || entry.type === "context") {
			state.lastMessageRole = entry.role;
			if (entry.role === "assistant") state.latestAssistant = entry;
		}
		if (entry.type === "message" && entry.role === "assistant") {
			for (const id of entry.toolCallIds) state.pendingTools.add(id);
		}
		if (entry.type === "tool_result") {
			if (entry.asyncState === "running" || entry.asyncState === "pending") {
				if (entry.toolCallId !== null) {
					state.pendingTools.add(entry.toolCallId);
					if (entry.asyncJobId !== undefined) runningJobs.set(entry.asyncJobId, entry.toolCallId);
				} else state.unresolvedAsyncWithoutId = true;
			} else if (entry.asyncState === null || entry.asyncState === "completed" || entry.asyncState === "cancelled") {
				if (entry.toolCallId !== null) state.pendingTools.delete(entry.toolCallId);
			} else state.unsupportedAsyncState = true;
		}
		if (entry.deliveredJobs === "malformed") state.unsupportedAsyncState = true;
		else if (entry.deliveredJobs !== undefined) {
			for (const job of entry.deliveredJobs) {
				if (TERMINAL_JOB_STATES[job.status] !== true) { state.unsupportedAsyncState = true; continue; }
				const toolCallId = runningJobs.get(job.jobId);
				if (toolCallId === undefined) continue;
				state.pendingTools.delete(toolCallId);
				runningJobs.delete(job.jobId);
			}
		}
	}
	return state;
}

interface JournalIdentity {
	sessionId: string;
	cwd: string;
	leafId: string;
	cursorBytes: number;
	sessionSha256: string;
	window: SessionWindowInfo | null;
}

function journalVerdict(state: BranchState, identity: JournalIdentity): SessionJournalResult {
	if (state.unsupportedAsyncState) return { status: "UNKNOWN", reason: "UNSUPPORTED_ASYNC_STATE" };
	const lastMessageRole = state.lastMessageRole;
	if (!lastMessageRole) return { status: "UNKNOWN", reason: "ACTIVE_BRANCH_HAS_NO_MESSAGE" };
	const terminalAssistantStop = state.latestAssistant !== undefined
		&& TERMINAL_STOP_REASONS[state.latestAssistant.stopReason ?? ""] === true;
	const unresolvedAsyncTool = state.unresolvedAsyncWithoutId || state.pendingTools.size > 0;
	const oracleBusy = unresolvedAsyncTool ? null
		: lastMessageRole === "assistant" && terminalAssistantStop ? false
		: lastMessageRole === "user" ? true : null;
	return { status: "KNOWN", sessionId: identity.sessionId, cwd: identity.cwd, leafId: identity.leafId,
		cursorBytes: identity.cursorBytes, sessionSha256: identity.sessionSha256, terminalAssistantStop, lastMessageRole,
		unresolvedAsyncTool, oracleBusy, window: identity.window };
}

/** Parse OMP journal metadata only; message bodies and tool arguments never leave this parser. */
export function parseSessionJournal(text: string): SessionJournalResult {
	return parseWholeJournal(text, Buffer.byteLength(text, "utf8"), createHash("sha256").update(text, "utf8").digest("hex"));
}

function parseWholeJournal(text: string, cursorBytes: number, sessionSha256: string): SessionJournalResult {
	if (!text.endsWith("\n")) return { status: "UNKNOWN", reason: "PARTIAL_RECORD" };
	if (cursorBytes > MAX_SESSION_BYTES) return { status: "UNKNOWN", reason: "SESSION_FILE_TOO_LARGE" };
	const scan: JournalScan = { sessionId: null, cwd: null, entries: [], byId: new Map() };
	const refused = scanRecords(text, 0, scan);
	if (refused !== null) return { status: "UNKNOWN", reason: refused };
	if (scan.sessionId === null || scan.cwd === null) return { status: "UNKNOWN", reason: "SESSION_IDENTITY_MISSING" };
	const leafId = activeLeaf(scan.entries, scan.byId);
	if (leafId === null) return { status: "UNKNOWN", reason: "ACTIVE_BRANCH_UNAVAILABLE" };
	const branch = activeBranch(leafId, scan.byId);
	if (branch === null) return { status: "UNKNOWN", reason: "ACTIVE_BRANCH_INCOMPLETE" };
	return journalVerdict(evaluateBranch(branch, true),
		{ sessionId: scan.sessionId, cwd: scan.cwd, leafId, cursorBytes, sessionSha256, window: null });
}

/** The session header from a view's head: leading titles, then the session record, each newline-terminated. */
function headSessionHeader(head: Buffer): { id: string; cwd: string; bodyStart: number } | { reason: string } {
	let position = 0;
	for (;;) {
		const newline = head.indexOf(0x0a, position);
		if (newline < 0) return { reason: "SESSION_HEADER_BEYOND_HEAD" };
		const line = head.toString("utf8", position, newline);
		position = newline + 1;
		if (!line) continue;
		let raw: Record<string, unknown> | null;
		try { raw = objectValue(JSON.parse(line) as unknown); }
		catch { return { reason: "MALFORMED_RECORD" }; }
		if (!raw || typeof raw.type !== "string") return { reason: "INVALID_RECORD" };
		if (raw.type === "title") continue;
		if (raw.type !== "session") return { reason: "SESSION_HEADER_MISSING" };
		const header = sessionHeader(raw);
		return header === null ? { reason: "INVALID_SESSION_HEADER" } : { ...header, bodyStart: position };
	}
}

/**
 * Decide from a bounded tail (ompkit-774u.1.3): the header comes from the head; records start at the first
 * complete one after the cut (the record after the window's first newline). The answer equals the whole-file
 * parse only when the window proves both halves of it:
 * - the state: the active branch reaches its root, or a process-exit checkpoint that fixes every earlier tool
 *   call and async job, with the branch's last message after the cut;
 * - the leaf: the window holds the whole body, or the last `model_usage.activeLeafId` pin. Without a pin the
 *   window's only leaf is the file's last entry, but a dead-end branch before the cut (omp leaves them: retried
 *   or aborted assistant turns, side `model_usage` and `session_exit` records) makes the whole parse refuse as
 *   ACTIVE_BRANCH_UNAVAILABLE, and the cut hides it.
 * Otherwise the result is never IDLE: a verdict the prefix cannot turn idle (mid-turn, visible pending work) is
 * KNOWN with oracleBusy null, and a settled-looking tail is UNKNOWN (TAIL_STATE_BEYOND_WINDOW, or
 * TAIL_ACTIVE_LEAF_UNPROVEN when only the leaf is missing).
 */
export function parseSessionJournalTail(view: SessionJournalView): SessionJournalResult {
	const { head, tail, tailStart, fileSize } = view;
	if (tailStart < 0 || tailStart + tail.length !== fileSize || head.length > fileSize) {
		return { status: "UNKNOWN", reason: "TAIL_READ_INCONSISTENT" };
	}
	if (tail.length === 0 || tail[tail.length - 1] !== 0x0a) return { status: "UNKNOWN", reason: "PARTIAL_RECORD" };
	const header = headSessionHeader(head);
	if ("reason" in header) return { status: "UNKNOWN", reason: header.reason };
	const firstRecord = tailStart === 0 ? 0 : tailStart + tail.indexOf(0x0a) + 1;
	const coversBody = firstRecord <= header.bodyStart;
	const from = Math.max(firstRecord, header.bodyStart);
	const scan: JournalScan = { sessionId: header.id, cwd: header.cwd, entries: [], byId: new Map() };
	const refused = scanRecords(tail.toString("utf8", from - tailStart), from, scan);
	if (refused !== null) return { status: "UNKNOWN", reason: refused };
	if (scan.entries.length === 0) {
		return { status: "UNKNOWN", reason: coversBody ? "ACTIVE_BRANCH_UNAVAILABLE" : "TAIL_WINDOW_HAS_NO_ENTRY" };
	}
	let pinned: string | null = null;
	for (const entry of scan.entries) if (entry.type === "model_usage" && entry.activeLeafId !== null) pinned = entry.activeLeafId;
	if (pinned !== null && !scan.byId.has(pinned) && !coversBody) {
		return { status: "UNKNOWN", reason: "TAIL_ACTIVE_LEAF_BEYOND_WINDOW" };
	}
	const leafId = activeLeaf(scan.entries, scan.byId);
	if (leafId === null) return { status: "UNKNOWN", reason: "ACTIVE_BRANCH_UNAVAILABLE" };
	const suffix: JournalEntry[] = [];
	const seen = new Set<string>();
	let rooted = false;
	for (let current: string | null = leafId; current !== null;) {
		if (seen.has(current)) return { status: "UNKNOWN", reason: "ACTIVE_BRANCH_INCOMPLETE" };
		seen.add(current);
		const entry = scan.byId.get(current);
		if (!entry) {
			if (coversBody) return { status: "UNKNOWN", reason: "ACTIVE_BRANCH_INCOMPLETE" };
			break;
		}
		suffix.push(entry);
		current = entry.parentId;
		rooted = current === null;
	}
	suffix.reverse();
	const state = evaluateBranch(suffix, rooted);
	const identity: JournalIdentity = { sessionId: header.id, cwd: header.cwd, leafId, cursorBytes: fileSize,
		sessionSha256: view.sha256, window: { startBytes: from, bytesRead: head.length + tail.length, anchored: state.anchored,
			leafProven: coversBody || pinned !== null } };
	// A checkpoint fixes tools and jobs, but the branch's last message must still be in the window.
	const stateExact = state.anchored && (rooted || state.lastMessageRole !== null);
	if (stateExact && (coversBody || pinned !== null)) return journalVerdict(state, identity);
	if (state.unsupportedAsyncState) return { status: "UNKNOWN", reason: "UNSUPPORTED_ASYNC_STATE" };
	const verdict = journalVerdict(state, identity);
	if (verdict.status !== "KNOWN" || verdict.oracleBusy === false) {
		return { status: "UNKNOWN", reason: stateExact ? "TAIL_ACTIVE_LEAF_UNPROVEN" : "TAIL_STATE_BEYOND_WINDOW" };
	}
	return { ...verdict, oracleBusy: null };
}

export type SessionDecision = "IDLE" | "BUSY" | "UNKNOWN";

/** The journal's own verdict. IDLE: a terminal assistant stop with nothing pending. BUSY: the branch ends
 * mid-turn (a user message, or an assistant message without a terminal stop, e.g. awaiting its tools).
 * Everything else, including a finished turn with an unsettled async job, is UNKNOWN. */
export function sessionJournalDecision(journal: SessionJournalResult): SessionDecision {
	if (journal.status !== "KNOWN") return "UNKNOWN";
	if (journal.oracleBusy === false) return "IDLE";
	if (journal.lastMessageRole === "user" || (journal.lastMessageRole === "assistant" && !journal.terminalAssistantStop)) {
		return "BUSY";
	}
	return "UNKNOWN";
}

/** A whole-file view of session text (a readSessionFile result). */
export function sessionViewOfText(text: string): SessionJournalView {
	const tail = Buffer.from(text, "utf8");
	return { head: tail.subarray(0, Math.min(SESSION_HEAD_BYTES, tail.length)), tail, tailStart: 0,
		fileSize: tail.length, identity: null, sha256: createHash("sha256").update(tail).digest("hex") };
}

/** Decide a view: a whole file parses in full, a bounded tail through parseSessionJournalTail. */
export function parseSessionView(view: SessionJournalView): SessionJournalResult {
	if (view.tailStart !== 0) return parseSessionJournalTail(view);
	return parseWholeJournal(view.tail.toString("utf8"), view.fileSize, view.sha256);
}

function readExactly(fd: number, position: number, length: number): Buffer | null {
	const buffer = Buffer.allocUnsafe(length);
	let filled = 0;
	while (filled < length) {
		const count = readSync(fd, buffer, filled, length - filled, position + filled);
		if (count === 0) return null;
		filled += count;
	}
	return buffer;
}

/**
 * Bounded positioned read of a session file: its head (SESSION_HEAD_BYTES) and its last `windowBytes`, both
 * from one open inode that must not change size, mtime or ctime while read; null on any failure. Not kitlib
 * readLocalArtifact: that reads from offset 0 and refuses any file larger than its bound, which is exactly the
 * file this exists for.
 */
export function readSessionTail(path: string, windowBytes: number = SESSION_TAIL_WINDOW_BYTES): SessionJournalView | null {
	let fd: number | null = null;
	try {
		fd = openSync(path, "r");
		const before = fstatSync(fd);
		if (!before.isFile()) return null;
		const fileSize = before.size;
		const tailStart = Math.max(0, fileSize - windowBytes);
		const head = readExactly(fd, 0, Math.min(SESSION_HEAD_BYTES, fileSize));
		const tail = readExactly(fd, tailStart, fileSize - tailStart);
		const after = fstatSync(fd);
		if (head === null || tail === null || after.size !== before.size || after.mtimeMs !== before.mtimeMs
			|| after.ctimeMs !== before.ctimeMs || after.ino !== before.ino || after.dev !== before.dev) return null;
		const identity = `${before.dev}:${before.ino}`;
		const sha256 = createHash("sha256").update(`${identity}:${fileSize}:${head.length}\n`).update(head).update(tail).digest("hex");
		return { head, tail, tailStart, fileSize, identity, sha256 };
	} catch {
		return null;
	} finally {
		if (fd !== null) try { closeSync(fd); } catch { /* already closed */ }
	}
}

/** The seat's session file: whole within the parse cap, else the io's bounded tail; null when unreadable. */
export function readSessionView(io: TernObserverIo, path: string): SessionJournalView | null {
	try {
		const text = io.readSessionFile(path);
		if (text !== null) return sessionViewOfText(text);
		return io.readSessionTail ? io.readSessionTail(path) : null;
	} catch {
		return null;
	}
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
			evidence: ["tern-inspect", "tern-process", "session-file"],
			reason: sessionJournalDecision(journal) === "BUSY" ? "SESSION_TURN_IN_FLIGHT" : "SESSION_ORACLE_STATE_UNKNOWN" };
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


export function defaultTernIo(): TernObserverIo {
	return {
		run(argv, env) {
			try {
				// Merge overrides into the live environment: a bare {env} would
				// wipe PATH and break binary lookup (ompkit-kdbz.2.16: the
				// resolved TERN_DAEMON_SOCKET must ride along, not alone).
				const child = spawnSync(argv[0]!, argv.slice(1), { encoding: "utf8", timeout: PROCESS_TIMEOUT_MS,
					maxBuffer: COMMAND_MAX_BUFFER, ...(env ? { env: { ...process.env, ...env } } : {}) });
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
		readSessionTail(path) {
			const view = readSessionTail(path);
			return view !== null && view.fileSize > MAX_SESSION_BYTES ? view : null;
		},
		wait(ms) { return new Promise<void>((resolve) => setTimeout(resolve, ms)); },
	};
}

/** Parse-layer marker for a seat resolved to Tern's documented default
window (parse-only; send argv comes from the resolution kind, never from
this string, so it can never reach --window). */
const RESOLVED_DEFAULT_WINDOW = "tern-default-window";

function observationFromReads(
	seat: TernSeatBinding,
	io: TernObserverIo,
	resolution: Extract<TernWindowResolution, { ok: true }>,
): TernObservation {
	const windowFlag = ternWindowArgv(resolution);
	const windowEnv = ternWindowEnv(resolution);
	// The pure parser still requires a key; a default-resolved seat proved
	// its binding in resolution, so it parses under the marker, never argv.
	const addressed: TernSeatBinding = resolution.kind === "key" ? seat : { ...seat, windowKey: RESOLVED_DEFAULT_WINDOW };
	const firstInspect = runCommand(io, ["tern", ...windowFlag, "inspect", "--json"], "inspect", windowEnv);
	if ("error" in firstInspect) return unknownObservation(firstInspect.error);
	const inspection = parseTernInspection(firstInspect.value, addressed);
	if (inspection.status === "DEAD") {
		return { state: "DEAD", working: false, oracleBusy: null, sessionFile: inspection.sessionFile,
			sessionSha: null, sessionCursorBytes: null, sessionLeafId: null, fg: null, runtimeBinding: null,
			evidence: ["tern-inspect"], reason: inspection.reason };
	}
	if (inspection.status !== "FOUND") return unknownObservation(inspection.status === "REFUSED" ? inspection.code : inspection.reason);
	const processJson = runCommand(io, ["tern", ...windowFlag, "process", String(inspection.paneId), "--json"], "process", windowEnv);
	if ("error" in processJson) return unknownObservation(processJson.error);
	const process = addProcessStart(io, parseTernProcess(processJson.value, seat.cwd, inspection.paneId));
	if (process.status !== "FOUND") return unknownObservation(process.reason);
	const view = readSessionView(io, inspection.sessionFile);
	if (view === null) return unknownObservation("SESSION_FILE_UNAVAILABLE");
	const journal = parseSessionView(view);
	const observation = classifyTernObservation(inspection, process, journal);
	if (observation.state === "UNKNOWN" && observation.reason === "WORKING_ORACLE_DISAGREEMENT") return observation;
	if (observation.state !== "IDLE" && observation.state !== "BUSY") return observation;
	const secondInspect = runCommand(io, ["tern", ...windowFlag, "inspect", "--json"], "inspect", windowEnv);
	if ("error" in secondInspect) return unknownObservation(secondInspect.error);
	const inspectionAfter = parseTernInspection(secondInspect.value, addressed);
	if (inspectionAfter.status !== "FOUND") return unknownObservation("OBSERVATION_CHANGED_DURING_READ");
	const processAfterJson = runCommand(io, ["tern", ...windowFlag, "process", String(inspectionAfter.paneId), "--json"], "process", windowEnv);
	if ("error" in processAfterJson) return unknownObservation(processAfterJson.error);
	const processAfter = addProcessStart(io, parseTernProcess(processAfterJson.value, seat.cwd, inspectionAfter.paneId));
	if (processAfter.status !== "FOUND") return unknownObservation(processAfter.reason);
	if (processAfter.foreground.started === null) return unknownObservation("FOREGROUND_INCARNATION_UNAVAILABLE");
	const viewAfter = readSessionView(io, inspectionAfter.sessionFile);
	if (viewAfter === null) return unknownObservation("SESSION_FILE_UNAVAILABLE");
	const journalAfter = parseSessionView(viewAfter);
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

/** Observe one window-resolved Tern seat; missing evidence is never IDLE.
The window resolves (and re-resolves per call) before any read; an
unresolvable seat is UNKNOWN with its refusal code, never observed blind. */
export async function observeTernSeat(seat: TernSeatBinding, io: TernObserverIo = defaultTernIo()): Promise<TernObservation> {
	const window = resolveTernWindow(seat, io);
	if (!window.ok) return unknownObservation(window.code);
	for (let retry = 0; retry <= OBSERVE_RETRIES; retry++) {
		const observation = observationFromReads(seat, io, window);
		if (observation.reason !== "WORKING_ORACLE_DISAGREEMENT") return observation;
		if (retry < OBSERVE_RETRIES) await io.wait(OBSERVE_RETRY_MS);
		else return { ...observation, reason: "WORKING_ORACLE_DISAGREEMENT_AFTER_RETRIES" };
	}
	return unknownObservation("OBSERVATION_UNAVAILABLE");
}

/** Validate the exact Agent Mail recipient and current runtime incarnation for a Tern seat. */
export async function identifyTernSeat(seat: TernSeatBinding, io: TernObserverIo = defaultTernIo()): Promise<TernIdentityResult> {
	const window = resolveTernWindow(seat, io);
	if (!window.ok) return { status: "REFUSED", code: window.code, reason: window.reason, agent: null,
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
