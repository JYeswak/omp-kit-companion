// Barrier timer. At a round barrier, each configured project's report for the phase must have
// arrived in Agent Mail thread fleet-round-<N> before the deadline and been ACCEPTED by the report
// validator. This module reads the thread from Agent Mail's SQLite store (readonly; columns observed
// in references/evidence.md), judges each project, decides the barrier state, and keeps the miss
// history that escalates a project blocked the same way at two consecutive barriers. It never
// writes to Agent Mail, a tracker or a pane; its only write is the state file in the round dir.
import { Database } from "bun:sqlite";
import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { BarrierPhase } from "./collect.ts";
import { isRecord } from "./model.ts";
import { labeledLines } from "./report.ts";

export type MailMessage = { id: number; sender: string | null; created_ms: number; body: string };
export type MailRead = { available: true; messages: MailMessage[] } | { available: false; reason: string };
/** Columns the timer reads, per table (REA evidence ev_245b51e8..., references/evidence.md). */
const COLUMNS: Record<string, string[]> = {
	projects: ["id", "human_key"],
	agents: ["id", "name"],
	messages: ["id", "project_id", "sender_id", "thread_id", "body_md", "created_ts"],
};

/** Every message of `threadId` in the Agent Mail project `projectKey`, oldest first. Unavailable, never empty, when the store cannot be read as observed. */
export function readThread(database: string, projectKey: string, threadId: string): MailRead {
	const unavailable = (reason: string): MailRead => ({ available: false, reason });
	if (!existsSync(database)) return unavailable(`Agent Mail database ${database} does not exist`);
	let db: Database | null = null;
	try {
		db = new Database(database, { readonly: true });
		for (const [table, needed] of Object.entries(COLUMNS)) {
			const have = new Set(db.query(`PRAGMA table_info(${table})`).all().map(row => (isRecord(row) && typeof row.name === "string" ? row.name : "")));
			const missing = needed.filter(column => !have.has(column));
			if (missing.length > 0) return unavailable(`Agent Mail table ${table} lacks ${missing.join(", ")}: schema differs from the observed store`);
		}
		const projects = db.query("SELECT id FROM projects WHERE human_key = ?").all(projectKey);
		const project = projects[0];
		if (projects.length !== 1 || !isRecord(project) || typeof project.id !== "number") return unavailable(`Agent Mail has ${projects.length} projects with key ${projectKey}; expected exactly one`);
		const rows = db
			.query("SELECT m.id AS id, a.name AS sender, m.created_ts AS created_ts, typeof(m.created_ts) AS ts_type, m.body_md AS body FROM messages m LEFT JOIN agents a ON a.id = m.sender_id WHERE m.project_id = ? AND m.thread_id = ? ORDER BY m.created_ts, m.id")
			.all(project.id, threadId);
		const messages: MailMessage[] = [];
		for (const row of rows) {
			// created_ts is integer microseconds since the epoch (observed: 1791768295454448 = 2026-10-12T01:24:55.454448Z).
			if (!isRecord(row) || typeof row.id !== "number" || row.ts_type !== "integer" || typeof row.created_ts !== "number" || typeof row.body !== "string") return unavailable(`Agent Mail message ${isRecord(row) ? String(row.id) : "?"} in ${threadId} has an unobserved shape`);
			messages.push({ id: row.id, sender: typeof row.sender === "string" ? row.sender : null, created_ms: Math.floor(row.created_ts / 1000), body: row.body });
		}
		return { available: true, messages };
	} catch (error) {
		return unavailable(`Agent Mail database ${database}: ${(error as Error).message}`);
	} finally {
		db?.close();
	}
}

/** First ROUND, PROJECT and PHASE labeled lines of a message body (top-level, verbatim; lib/report.ts). */
export function reportHeader(body: string): { round: string | null; project: string | null; phase: string | null } {
	const first = (key: string): string | null => labeledLines(body).lines.find(line => line.key === key && line.id === null)?.value ?? null;
	return { round: first("ROUND"), project: first("PROJECT"), phase: first("PHASE") };
}

export type Validation = { status: "ACCEPTED" | "REJECTED" | "UNKNOWN"; reasons: string[] };
export type Verdict = "ACCEPTED" | "REJECTED" | "MISSING" | "LATE" | "UNKNOWN";
export type BarrierStatus = "OPEN" | "MET" | "MISSED" | "UNKNOWN";
export type ProjectResult = {
	project: string;
	verdict: Verdict;
	reasons: string[];
	/** The message the verdict rests on: the latest on-time report, or the latest late one. */
	message: { id: number; sender: string | null; created_at: string } | null;
	reports: number;
	/** The validation came from the state file: a report is judged once, when first seen, so later tracker work cannot flip it. */
	cached: boolean;
	blocker: string | null;
	consecutive_misses: number;
	escalate: boolean;
};
export type BarrierResult = {
	schema: "fleet-round.barrier/v1";
	round: number;
	phase: BarrierPhase;
	report_phase: string;
	thread: string;
	mail_project: string;
	database: string;
	opened_at: string;
	timebox_hours: number;
	deadline: string;
	now: string;
	state: BarrierStatus;
	mail: { available: boolean; reason: string | null; messages: number; other_messages: number };
	projects: ProjectResult[];
	escalate: string[];
	unavailable: string[];
};

export const STATE_SCHEMA = "fleet-round.barrier-state/v1";
export const STATE_FILE = "barrier-state.json";
type Outcome = { verdict: Verdict; blocker: string | null; message_id: number | null };
type StoredBarrier = { round: number; phase: BarrierPhase; opened_at: string; deadline: string; updated_at: string; outcomes: Record<string, Outcome> };
type StoredValidation = { project: string; status: "ACCEPTED" | "REJECTED"; reasons: string[]; validated_at: string };
export type BarrierStateFile = { schema: typeof STATE_SCHEMA; barriers: Record<string, StoredBarrier>; validated: Record<string, StoredValidation> };

export function loadState(dir: string): BarrierStateFile {
	const path = join(dir, STATE_FILE);
	if (!existsSync(path)) return { schema: STATE_SCHEMA, barriers: {}, validated: {} };
	const json: unknown = JSON.parse(readFileSync(path, "utf8"));
	if (!isRecord(json) || json.schema !== STATE_SCHEMA || !isRecord(json.barriers) || !isRecord(json.validated)) throw new Error(`${path}: not a ${STATE_SCHEMA} file`);
	return json as BarrierStateFile; // written only by saveState below
}

/** Write via a temp file and rename, so a reader of the round dir never sees half a file. */
export function writeAtomic(path: string, text: string): void {
	const temp = `${path}.${process.pid}.tmp`;
	writeFileSync(temp, text, { mode: 0o600 });
	renameSync(temp, path);
}

export function saveState(dir: string, state: BarrierStateFile): void {
	writeAtomic(join(dir, STATE_FILE), `${JSON.stringify(state, null, 2)}\n`);
}

/** Digit runs collapsed to `#`, so the same failure with different counts or line numbers is the same blocker. */
function shape(text: string): string {
	let out = "";
	let digits = false;
	for (const ch of text) {
		const digit = ch >= "0" && ch <= "9";
		if (!digit) out += ch;
		else if (!digits) out += "#";
		digits = digit;
	}
	return out;
}

/** What kept a project from the barrier, comparable across barriers; null when it met it or is unknown. */
export function blockerOf(verdict: Verdict, reasons: string[]): string | null {
	if (verdict === "MISSING" || verdict === "LATE") return verdict;
	if (verdict === "REJECTED") return `REJECTED: ${[...new Set(reasons.map(shape))].sort().join("; ")}`;
	return null;
}

const iso = (ms: number): string => new Date(ms).toISOString();

export type BarrierInput = {
	round: number;
	phase: BarrierPhase;
	reportPhase: string;
	projects: string[];
	openedAt: number;
	timeboxHours: number;
	now: number;
	database: string;
	mailProject: string;
};

/**
 * Judge one barrier. `validate` runs the report validator on a body for a project (UNKNOWN when its
 * sources cannot be read). Mutates `state`: caches each first-seen validation by message id, and
 * once the barrier is decided (MET, or the deadline passed) records every known outcome.
 */
export function runBarrier(input: BarrierInput, mail: MailRead, validate: (project: string, body: string) => Validation, state: BarrierStateFile): BarrierResult {
	const deadline = input.openedAt + input.timeboxHours * 3_600_000;
	const thread = `fleet-round-${input.round}`;
	const byProject = new Map<string, MailMessage[]>(input.projects.map(p => [p, []]));
	let other = 0;
	for (const message of mail.available ? mail.messages : []) {
		const head = reportHeader(message.body);
		const bucket = head.project === null ? undefined : byProject.get(head.project);
		if (bucket && head.round === String(input.round) && head.phase === input.reportPhase) bucket.push(message);
		else other++;
	}
	const ref = (m: MailMessage) => ({ id: m.id, sender: m.sender, created_at: iso(m.created_ms) });
	const results: ProjectResult[] = input.projects.map(project => {
		const base = { project, reasons: [] as string[], message: null as ProjectResult["message"], reports: 0, cached: false, blocker: null, consecutive_misses: 0, escalate: false };
		if (!mail.available) return { ...base, verdict: "UNKNOWN", reasons: [mail.reason] };
		const reports = byProject.get(project)!;
		const onTime = reports.filter(m => m.created_ms <= deadline);
		const late = reports.filter(m => m.created_ms > deadline);
		const lateResult = (extra: string[]): ProjectResult => {
			const last = late.at(-1)!;
			return { ...base, reports: reports.length, verdict: "LATE", message: ref(last), reasons: [`report ${last.id} arrived ${iso(last.created_ms)}, after the deadline ${iso(deadline)}`, ...extra] };
		};
		if (onTime.length === 0) return late.length > 0 ? lateResult([]) : { ...base, verdict: "MISSING", reasons: [`no ${input.reportPhase} report for round ${input.round} in ${thread}`] };
		const latest = onTime.at(-1)!;
		const stored = state.validated[String(latest.id)];
		const validation: Validation = stored && stored.project === project ? { status: stored.status, reasons: stored.reasons } : validate(project, latest.body);
		if (!stored && validation.status !== "UNKNOWN") state.validated[String(latest.id)] = { project, status: validation.status, reasons: validation.reasons, validated_at: iso(input.now) };
		const judged = { ...base, reports: reports.length, message: ref(latest), cached: stored !== undefined };
		if (validation.status === "ACCEPTED" || validation.status === "UNKNOWN") return { ...judged, verdict: validation.status, reasons: validation.reasons };
		if (late.length > 0) return { ...lateResult(validation.reasons.map(r => `on-time report ${latest.id} was rejected: ${r}`)), cached: judged.cached };
		return { ...judged, verdict: "REJECTED", reasons: validation.reasons };
	});
	for (const result of results) result.blocker = blockerOf(result.verdict, result.reasons);

	const unavailable = results.filter(r => r.verdict === "UNKNOWN").map(r => r.project);
	const status: BarrierStatus = results.every(r => r.verdict === "ACCEPTED")
		? "MET"
		: input.now < deadline
			? "OPEN"
			: results.some(r => r.blocker !== null)
				? "MISSED"
				: "UNKNOWN";
	const key = `${input.round}:${input.phase}`;
	if (status !== "OPEN") {
		const previous = state.barriers[key];
		const outcomes: Record<string, Outcome> = { ...(previous?.outcomes ?? {}) };
		for (const r of results) if (r.verdict !== "UNKNOWN") outcomes[r.project] = { verdict: r.verdict, blocker: r.blocker, message_id: r.message?.id ?? null };
		state.barriers[key] = { round: input.round, phase: input.phase, opened_at: iso(input.openedAt), deadline: iso(deadline), updated_at: iso(input.now), outcomes };
	}
	const ordered = Object.entries(state.barriers).sort(([ka, a], [kb, b]) => a.deadline.localeCompare(b.deadline) || ka.localeCompare(kb));
	for (const result of results) {
		const run: string[] = [];
		for (const [, barrier] of ordered) {
			const outcome = barrier.outcomes[result.project];
			if (!outcome) continue;
			if (outcome.blocker === null) run.length = 0;
			else run.push(outcome.blocker);
		}
		result.consecutive_misses = run.length;
		result.escalate = status !== "OPEN" && result.blocker !== null && run.length >= 2 && run.at(-1) === run.at(-2);
	}
	return {
		schema: "fleet-round.barrier/v1",
		round: input.round,
		phase: input.phase,
		report_phase: input.reportPhase,
		thread,
		mail_project: input.mailProject,
		database: input.database,
		opened_at: iso(input.openedAt),
		timebox_hours: input.timeboxHours,
		deadline: iso(deadline),
		now: iso(input.now),
		state: status,
		mail: { available: mail.available, reason: mail.available ? null : mail.reason, messages: mail.available ? mail.messages.length : 0, other_messages: other },
		projects: results,
		escalate: results.filter(r => r.escalate).map(r => r.project),
		unavailable,
	};
}

/** 0 MET, 1 MISSED, 3 any source unavailable (checked first: never MET on unknown), 4 OPEN. */
export function barrierExit(result: BarrierResult): number {
	if (result.unavailable.length > 0) return 3;
	return result.state === "MET" ? 0 : result.state === "MISSED" ? 1 : result.state === "OPEN" ? 4 : 3;
}

const cell = (text: string): string => text.split("|").join("\\|").split("\n").join(" ");

export function barrierMarkdown(result: BarrierResult): string {
	const out = [
		`# fleet-round barrier: round ${result.round} ${result.phase}: ${result.state}`,
		"",
		`- opened ${result.opened_at}, deadline ${result.deadline} (${result.timebox_hours} h), now ${result.now}`,
		`- thread ${result.thread} in ${result.mail_project}: ${result.mail.available ? `${result.mail.messages} messages, ${result.mail.other_messages} not this barrier's report from a configured project` : `UNAVAILABLE (${result.mail.reason})`}`,
		"",
		"| project | verdict | report | arrived | misses in a row | detail |",
		"|---|---|---|---|---|---|",
	];
	for (const r of result.projects) {
		const verdict = r.escalate ? `ESCALATE (${r.verdict})` : r.verdict;
		out.push(`| ${r.project} | ${verdict} | ${r.message ? `${r.message.id} from ${r.message.sender ?? "?"}` : "-"} | ${r.message?.created_at ?? "-"} | ${r.consecutive_misses} | ${cell(r.reasons.join("; ") || "-")} |`);
	}
	return `${out.join("\n")}\n`;
}
