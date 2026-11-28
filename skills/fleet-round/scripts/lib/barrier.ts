// Barrier timer: read the configured Board root thread as bounded primary evidence.
import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { runSync } from "../../../../src/kitlib/run.ts";
import type { BarrierPhase } from "./collect.ts";
import { isRecord } from "./model.ts";
import { labeledLines } from "./report.ts";

type BoardMessage = {
	id: string;
	channel: string;
	thread: string;
	replyTo: string | null;
	re: string | null;
	createdAt: string;
	editedAt: string | null;
	text: string;
	revision: number;
	by: { profile: string; actor: string };
};
export type BoardRead = { available: true; thread: string; messages: BoardMessage[] } | { available: false; reason: string };
const messageId = (value: unknown): value is string => typeof value === "string" && /^[1-9]\d*$/.test(value);
const timestamp = (value: unknown): value is string => typeof value === "string" &&
	/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{1,3})?Z$/.test(value) && Number.isFinite(Date.parse(value));
const submittedAt = (message: BoardMessage): number => Date.parse(message.editedAt ?? message.createdAt);

function parseMessage(value: unknown): BoardMessage | null {
	if (!isRecord(value) || !messageId(value.id) || typeof value.channel !== "string" ||
		typeof value.thread !== "string" || !value.thread.trim() ||
		(value.replyTo !== null && !messageId(value.replyTo)) || (value.re !== null && !messageId(value.re)) ||
		!timestamp(value.createdAt) ||
		(value.editedAt !== null && (!timestamp(value.editedAt) || Date.parse(value.editedAt) < Date.parse(value.createdAt))) ||
		typeof value.text !== "string" || value.deleted !== false ||
		typeof value.revision !== "number" || !Number.isSafeInteger(value.revision) || value.revision < 1 ||
		!isRecord(value.by) || typeof value.by.profile !== "string" || !value.by.profile.trim() ||
		typeof value.by.actor !== "string" || !value.by.actor.trim()) return null;
	return value as BoardMessage;
}
export function parseBoardThread(raw: string, rootId: string, channel: string): BoardRead {
	try {
		const parsed: unknown = JSON.parse(raw);
		if (!isRecord(parsed) || !Array.isArray(parsed.replies) || typeof parsed.cursor !== "string" || !parsed.cursor)
			return { available: false, reason: "Board returned an invalid read envelope" };
		const root = parseMessage(parsed.message);
		if (!root || root.id !== rootId || root.channel !== channel || root.replyTo !== null || root.re !== null) return { available: false, reason: "Board root evidence is missing or mismatched" };
		const replies = new Map<string, BoardMessage>();
		for (const value of parsed.replies) {
			const reply = parseMessage(value);
			if (!reply || reply.channel !== channel || reply.thread !== root.thread || reply.id === rootId || replies.has(reply.id))
				return { available: false, reason: "Board reply evidence is invalid, mismatched, or duplicated" };
			replies.set(reply.id, reply);
		}
		for (const reply of replies.values()) {
			// Board supplies re for the root; replyTo may instead name an ordinary parent in that same thread.
			if ((reply.re !== null && reply.re !== rootId) ||
				(reply.re === null && reply.replyTo !== rootId) ||
				(reply.replyTo !== null && reply.replyTo !== rootId && (reply.replyTo === reply.id || !replies.has(reply.replyTo))))
				return { available: false, reason: "Board reply does not belong to the selected root" };
		}
		const messages = [root, ...replies.values()];
		messages.sort((a, b) => submittedAt(a) - submittedAt(b) || a.id.length - b.id.length || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
		return { available: true, thread: root.thread, messages };
	} catch { return { available: false, reason: "Board returned malformed JSON" }; }
}
export function readBoardThread(root: string | null, channel: string | null, cwd: string): BoardRead {
	if (!messageId(root) || !channel) return { available: false, reason: "Board root or channel authority is unavailable" };
	if (!process.env.BOARD_URL || !process.env.BOARD_PROFILE)
		return { available: false, reason: "Board authority requires BOARD_URL and BOARD_PROFILE" };
	try {
		const result = runSync([process.env.OMP_KIT_BOARD_CLI || "vb", "read", root, "--json"], { cwd, deadline_s: 10, max_output_bytes: 1 << 20 });
		if (result.rc !== 0 || result.killed || result.timed_out || result.truncated || result.total_truncated) return { available: false, reason: "Board read failed or exceeded its output bound" };
		return parseBoardThread(new TextDecoder().decode(result.stdout), root, channel);
	} catch { return { available: false, reason: "Board CLI could not be started" }; }
}
export function reportHeader(body: string): { round: string | null; project: string | null; phase: string | null } {
	const first = (key: string): string | null => labeledLines(body).lines.find(line => line.key === key && line.id === null)?.value ?? null;
	return { round: first("ROUND"), project: first("PROJECT"), phase: first("PHASE") };
}
export type Validation = { status: "ACCEPTED" | "REJECTED" | "UNKNOWN"; reasons: string[] };
export type Verdict = "ACCEPTED" | "REJECTED" | "MISSING" | "LATE" | "UNKNOWN";
export type BarrierStatus = "OPEN" | "MET" | "MISSED" | "UNKNOWN";
export type ProjectResult = { project: string; verdict: Verdict; reasons: string[]; message: { id: string; sender: string; created_at: string } | null; reports: number; cached: boolean; blocker: string | null; consecutive_misses: number; escalate: boolean };
export type BarrierResult = { schema: "fleet-round.barrier/v2"; round: number; phase: BarrierPhase; report_phase: string; thread: string | null; board_root: string | null; board_channel: string | null; opened_at: string; timebox_hours: number; deadline: string; now: string; state: BarrierStatus; board: { available: boolean; reason: string | null; messages: number; other_messages: number }; projects: ProjectResult[]; escalate: string[]; unavailable: string[] };
export type DeliveryTarget = { session: string; pane: string };
export type Delivery = { key: string; session: string; pane: string; text: string };
export const STATE_SCHEMA = "fleet-round.barrier-state/v1";
export const STATE_FILE = "barrier-state.json";
type Outcome = { verdict: Verdict; blocker: string | null; message_id: string | null };
type StoredBarrier = { round: number; phase: BarrierPhase; opened_at: string; deadline: string; updated_at: string; outcomes: Record<string, Outcome> };
type StoredValidation = { project: string; status: "ACCEPTED" | "REJECTED"; reasons: string[]; validated_at: string };
export type BarrierStateFile = { schema: typeof STATE_SCHEMA; barriers: Record<string, StoredBarrier>; validated: Record<string, StoredValidation>; notified?: Record<string, string> };
export function loadState(dir: string): BarrierStateFile {
	const path = join(dir, STATE_FILE);
	if (!existsSync(path)) return { schema: STATE_SCHEMA, barriers: {}, validated: {} };
	const json: unknown = JSON.parse(readFileSync(path, "utf8"));
	if (!isRecord(json) || json.schema !== STATE_SCHEMA || !isRecord(json.barriers) || !isRecord(json.validated)) throw new Error(`${path}: not a ${STATE_SCHEMA} file`);
	return json as BarrierStateFile;
}
export function writeAtomic(path: string, text: string): void { const temp = `${path}.${process.pid}.tmp`; writeFileSync(temp, text, { mode: 0o600 }); renameSync(temp, path); }
export function saveState(dir: string, state: BarrierStateFile): void { writeAtomic(join(dir, STATE_FILE), `${JSON.stringify(state, null, 2)}\n`); }
function shape(text: string): string { let out = "", digits = false; for (const ch of text) { const digit = ch >= "0" && ch <= "9"; if (!digit) out += ch; else if (!digits) out += "#"; digits = digit; } return out; }
export function blockerOf(verdict: Verdict, reasons: string[]): string | null {
	if (verdict === "MISSING" || verdict === "LATE") return verdict;
	if (verdict === "REJECTED") return `REJECTED: ${[...new Set(reasons.map(shape))].sort().join("; ")}`;
	return null;
}
const iso = (ms: number): string => new Date(ms).toISOString();
export type BarrierInput = { round: number; phase: BarrierPhase; reportPhase: string; projects: string[]; openedAt: number; timeboxHours: number; now: number; boardRoot: string | null; boardChannel: string | null };
export function runBarrier(input: BarrierInput, board: BoardRead, validate: (project: string, body: string) => Validation, state: BarrierStateFile): BarrierResult {
	const deadline = input.openedAt + input.timeboxHours * 3_600_000;
	const byProject = new Map<string, BoardMessage[]>(input.projects.map(p => [p, []]));
	let other = 0;
	for (const message of board.available ? board.messages : []) {
		const head = reportHeader(message.text), bucket = head.project === null ? undefined : byProject.get(head.project);
		if (bucket && head.round === String(input.round) && head.phase === input.reportPhase) bucket.push(message);
		else other++;
	}
	const ref = (m: BoardMessage) => ({ id: m.id, sender: m.by.actor, created_at: m.createdAt });
	const results: ProjectResult[] = input.projects.map(project => {
		const base = { project, reasons: [] as string[], message: null as ProjectResult["message"], reports: 0, cached: false, blocker: null, consecutive_misses: 0, escalate: false };
		if (!board.available) return { ...base, verdict: "UNKNOWN", reasons: [board.reason] };
		const reports = byProject.get(project)!;
		const onTime = reports.filter(m => submittedAt(m) <= deadline);
		const late = reports.filter(m => submittedAt(m) > deadline);
		const lateResult = (extra: string[]): ProjectResult => {
			const last = late.at(-1)!;
			return { ...base, reports: reports.length, verdict: "LATE", message: ref(last),
				reasons: [`report ${last.id} arrived or was edited ${iso(submittedAt(last))}, after the deadline ${iso(deadline)}`, ...extra] };
		};
		if (!onTime.length) return late.length ? lateResult([]) : { ...base, verdict: "MISSING",
			reasons: [`no ${input.reportPhase} report for round ${input.round} in Board #${input.boardRoot}`] };
		const latest = onTime.at(-1)!, cacheKey = `${input.boardChannel ?? ""}:${input.boardRoot ?? ""}:${latest.id}:${latest.revision}`, stored = state.validated[cacheKey];
		const validation: Validation = stored && stored.project === project ? { status: stored.status, reasons: stored.reasons } : validate(project, latest.text);
		if (!stored && validation.status !== "UNKNOWN") state.validated[cacheKey] = { project, status: validation.status, reasons: validation.reasons, validated_at: iso(input.now) };
		const judged = { ...base, reports: reports.length, message: ref(latest), cached: stored !== undefined };
		if (validation.status === "ACCEPTED" || validation.status === "UNKNOWN") return { ...judged, verdict: validation.status, reasons: validation.reasons };
		if (late.length) return { ...lateResult(validation.reasons.map(r => `on-time report ${latest.id} was rejected: ${r}`)), cached: judged.cached };
		return { ...judged, verdict: "REJECTED", reasons: validation.reasons };
	});
	for (const result of results) result.blocker = blockerOf(result.verdict, result.reasons);
	const unavailable = results.filter(r => r.verdict === "UNKNOWN").map(r => r.project);
	const status: BarrierStatus = unavailable.length > 0 ? "UNKNOWN" : results.every(r => r.verdict === "ACCEPTED") ? "MET" : input.now < deadline ? "OPEN" : results.some(r => r.blocker !== null) ? "MISSED" : "UNKNOWN";
	const key = `${input.round}:${input.phase}`;
	if (status !== "OPEN" && status !== "UNKNOWN") {
		const previous = state.barriers[key], outcomes: Record<string, Outcome> = { ...(previous?.outcomes ?? {}) };
		for (const r of results) outcomes[r.project] = { verdict: r.verdict, blocker: r.blocker, message_id: r.message?.id ?? null };
		state.barriers[key] = { round: input.round, phase: input.phase, opened_at: iso(input.openedAt), deadline: iso(deadline), updated_at: iso(input.now), outcomes };
	}
	const ordered = Object.entries(state.barriers).sort(([ka, a], [kb, b]) => a.deadline.localeCompare(b.deadline) || ka.localeCompare(kb));
	for (const result of results) {
		const run: string[] = [];
		for (const [, barrier] of ordered) { const outcome = barrier.outcomes[result.project]; if (!outcome) continue; if (outcome.blocker === null) run.length = 0; else run.push(outcome.blocker); }
		result.consecutive_misses = run.length;
		result.escalate = status !== "OPEN" && status !== "UNKNOWN" && result.blocker !== null && run.length >= 2 && run.at(-1) === run.at(-2);
	}
	return {
		schema: "fleet-round.barrier/v2", round: input.round, phase: input.phase, report_phase: input.reportPhase,
		thread: board.available ? board.thread : null, board_root: input.boardRoot, board_channel: input.boardChannel,
		opened_at: iso(input.openedAt), timebox_hours: input.timeboxHours, deadline: iso(deadline), now: iso(input.now), state: status,
		board: { available: board.available, reason: board.available ? null : board.reason,
			messages: board.available ? board.messages.length : 0, other_messages: other },
		projects: results, escalate: results.filter(r => r.escalate).map(r => r.project), unavailable,
	};
}
export function planDelivery(result: BarrierResult, state: BarrierStateFile, deliver: boolean, chief: DeliveryTarget | null, directors: Record<string, DeliveryTarget>, mdPath: string | null): Delivery[] {
	if (!deliver || result.state === "UNKNOWN" || result.unavailable.length > 0) return [];
	const sent = state.notified ?? {}, out: Delivery[] = [];
	const queue = (key: string, target: DeliveryTarget | null | undefined, text: string): void => { if (target && sent[key] === undefined) out.push({ key, session: target.session, pane: target.pane, text }); };
	for (const r of result.projects) {
		if (r.verdict === "REJECTED" && !r.cached && r.message !== null)
			queue(`rejected:${result.round}:${result.phase}:${r.project}:${r.message.id}`, directors[r.project],
				`fleet-round-${result.round} ${result.phase}: ${r.project} report ${r.message.id} REJECTED: ${r.reasons.join("; ")}. Fix and resend to Board #${result.board_root} (${result.board_channel}).`);
	}
	const where = mdPath === null ? "no barrier md written" : `barrier md ${mdPath}`;
	if (result.state === "MET" || result.state === "MISSED") queue(`barrier:${result.round}:${result.phase}:${result.state}`, chief, `fleet-round-${result.round} ${result.phase}: ${result.state} (${where}).`);
	for (const project of result.escalate) queue(`escalated:${result.round}:${result.phase}:${project}`, chief, `fleet-round-${result.round} ${result.phase}: ${project} ESCALATE, blocked the same way twice running (${where}).`);
	return out;
}
export function barrierExit(result: BarrierResult): number { if (result.unavailable.length) return 3; return result.state === "MET" ? 0 : result.state === "MISSED" ? 1 : result.state === "OPEN" ? 4 : 3; }
const cell = (text: string): string => text.split("|").join("\\|").split("\n").join(" ");
export function barrierMarkdown(result: BarrierResult): string {
	const source = result.board.available ? `${result.board.messages} messages, ${result.board.other_messages} not this barrier's report from a configured project`
		: `UNAVAILABLE (${result.board.reason})`;
	const out = [
		`# fleet-round barrier: round ${result.round} ${result.phase}: ${result.state}`,
		"",
		`- opened ${result.opened_at}, deadline ${result.deadline} (${result.timebox_hours} h), now ${result.now}`,
		`- Board #${result.board_root ?? "unavailable"} in ${result.board_channel ?? "unavailable"}: ${source}`,
		"",
		"| project | verdict | report | arrived | misses in a row | detail |",
		"|---|---|---|---|---|---|",
	];
	for (const r of result.projects) {
		const verdict = r.escalate ? `ESCALATE (${r.verdict})` : r.verdict;
		const report = r.message ? `${r.message.id} from ${cell(r.message.sender)}` : "-";
		out.push(`| ${cell(r.project)} | ${verdict} | ${report} | ${r.message?.created_at ?? "-"} | ${r.consecutive_misses} | ${cell(r.reasons.join("; ") || "-")} |`);
	}
	return `${out.join("\n")}\n`;
}
