// intake-deliver: ROUTE delivery + proof + fleet_report hourly counts.
// INTAKE1 slice of ompkit-fp72.19.1.19. Delivery path per slice contract:
// br assignee update (spawnSync "br", like intake-record.ts) + Agent Mail
// (`am mail send`, the kit mail CLI) + tern delivery (deliverToTernSeat
// from send.ts, the existing tern send path). Proof reads the recipient
// session file for the delivery marker (SEND1: one retry, then a
// drop-folder fallback copy). Hourly counts extend the fleet-report
// vocabulary (report-inject-job.ts REPORT_INJECT_JOB "fleet-report" runs
// hourly): they are computed from the one existing ledger
// (decisions/joshua.jsonl, owned by the record slice) — this file creates
// no second ledger. The session-file marker is the delivery record.

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
import { deliverToTernSeat, type TernDeliverResult } from "./send.ts";
import type { TernSeatBinding } from "./plane-tern.ts";
import { ownerRoleFor } from "./intake-route.ts";
import type { BrRunner } from "./intake-record.ts";

export const INTAKE_DELIVER_BR_TIMEOUT_MS = 30_000;
export const INTAKE_DELIVER_MAIL_TIMEOUT_MS = 30_000;
export const INTAKE_DELIVER_TERN_DEADLINE_MS = 15_000;
export const INTAKE_DELIVER_PROOF_RETRY_WAIT_MS = 1_000;
export const INTAKE_DELIVER_HOUR_MS = 3_600_000;

export interface MailRun {
	code: number;
	out: string;
}

export type MailRunner = (argv: string[]) => MailRun;

export type TernDeliver = (args: {
	seat: TernSeatBinding;
	text: string;
	dropDir: string;
}) => Promise<TernDeliverResult>;

export type SessionFileReader = (path: string) => string | null;

export type Sleeper = (ms: number) => Promise<void>;

export interface DeliverInput {
	/** Absolute repo root: br cwd and ledger root. */
	repo: string;
	bead: string;
	/** Receiving seat: br assignee and mail recipient. */
	seat: string;
	/** Verbatim request text. */
	text: string;
	/** Agent Mail project key (required flag on `am mail send`). */
	project: string;
	/** Mail sender; Joshua's intake defaults to joshua. */
	from?: string;
	/** Tern binding of the receiving seat. */
	session: string;
	pane: string;
	windowKey: string;
	/** Recipient session file for the marker proof; skips the pre-check when absent. */
	sessionFile?: string | null;
	/** Drop folder for unproven deliveries (SEND1 fallback). */
	dropDir: string;
	subject?: string;
}

export interface DeliverDeps {
	runBr?: BrRunner;
	runMail?: MailRunner;
	deliver?: TernDeliver;
	readSessionFile?: SessionFileReader;
	wait?: Sleeper;
	now?: () => number;
}

export type DeliverStatus = "DELIVERED" | "ALREADY_DELIVERED" | "FALLBACK" | "BR_FAILED" | "MAIL_FAILED";

export interface DeliverResult {
	status: DeliverStatus;
	bead: string;
	seat: string;
	marker: string;
	/** Tern sends this call made; 0 when nothing was sent. */
	sends: number;
	sessionFile: string | null;
	dropPath: string | null;
	detail: string;
	counts: IntakeHourlyCounts;
	countsLine: string;
}

/**
 * Deterministic delivery marker: sha256(bead, seat, text), 12 hex.
 * Identical redeliveries share a marker, so the session-file proof doubles
 * as the idempotency key (no second ledger). Distinct deliveries collide
 * with ~2^-48 probability; a collision would misattribute proof.
 */
export function markerFor(bead: string, seat: string, text: string): string {
	const digest = createHash("sha256").update(`${bead}\n${seat}\n${text}`, "utf8").digest("hex");
	return `kit-send-${digest.slice(0, 12)}`;
}

function defaultBr(argv: string[], opts: { cwd: string; timeoutMs: number }): { argv: string[]; code: number; out: string } {
	const result = spawnSync(argv[0], argv.slice(1), {
		cwd: opts.cwd,
		encoding: "utf8",
		timeout: opts.timeoutMs,
		maxBuffer: 4 * 1024 * 1024,
	});
	return { argv, code: result.status ?? 1, out: result.error?.message ?? result.stdout ?? "" };
}

function defaultMail(argv: string[]): MailRun {
	const result = spawnSync(argv[0], argv.slice(1), {
		encoding: "utf8",
		timeout: INTAKE_DELIVER_MAIL_TIMEOUT_MS,
		maxBuffer: 4 * 1024 * 1024,
	});
	return { code: result.status ?? 1, out: result.error?.message ?? result.stdout ?? "" };
}

function defaultReadSessionFile(path: string): string | null {
	try {
		return readFileSync(path, "utf8");
	} catch {
		return null;
	}
}

async function defaultTernDeliver(args: { seat: TernSeatBinding; text: string; dropDir: string }): Promise<TernDeliverResult> {
	return deliverToTernSeat({
		seat: args.seat,
		text: args.text,
		dropDir: args.dropDir,
		deadlineMs: INTAKE_DELIVER_TERN_DEADLINE_MS,
		io: {
			run(argv, env) {
				const result = spawnSync(argv[0], argv.slice(1), {
					encoding: "utf8",
					timeout: INTAKE_DELIVER_TERN_DEADLINE_MS,
					maxBuffer: 4 * 1024 * 1024,
					...(env ? { env } : {}),
				});
				return { code: result.status ?? 1, out: result.error?.message ?? result.stdout ?? "" };
			},
			readSessionFile: defaultReadSessionFile,
			wait: async (ms: number) => {
				await new Promise<void>((resolvePromise) => setTimeout(resolvePromise, ms));
			},
		},
	});
}

/** Drop-folder fallback copy, mirroring send.ts dropMessage naming. */
export function writeDeliverDrop(dropDir: string, session: string, pane: string, marker: string, bead: string, seat: string, text: string): string {
	mkdirSync(dropDir, { recursive: true });
	const stamp = new Date().toISOString().replace(/[:.]/g, "-");
	const safePane = pane.replace(/[^A-Za-z0-9]+/g, "_");
	const path = join(dropDir, `${session}-${safePane}-${stamp}-${marker}.md`);
	const body = `# intake delivery fallback\n\n- bead: ${bead}\n- seat: ${seat}\n- marker: ${marker}\n- at: ${new Date().toISOString()}\n\n${text}\n`;
	writeFileSync(path, body, { encoding: "utf8", mode: 0o600 });
	return path;
}

function safeRead(read: SessionFileReader, path: string): string | null {
	try {
		return read(path);
	} catch {
		return null;
	}
}

export interface IntakeCountRow {
	at: string;
	kind: string;
	route: string;
	text: string;
	role: string;
}

export interface IntakeHourlyCounts {
	hour: string;
	received: number;
	routed: number;
	doneInRole: number;
	overridden: number;
}

/**
 * Read the one intake ledger (decisions/joshua.jsonl, owned by the record
 * slice). Missing file -> []. Malformed lines are skipped. Throws only on a
 * malformed repo path, like the record slice.
 */
export function readIntakeRows(repo: string): IntakeCountRow[] {
	if (typeof repo !== "string" || repo.trim() === "") throw new Error("intake deliver refused: empty repo path");
	if (!isAbsolute(repo)) throw new Error("intake deliver refused: repo path must be absolute: " + repo);
	const root = resolve(repo);
	let raw: string;
	try {
		raw = readFileSync(join(root, "decisions", "joshua.jsonl"), "utf8");
	} catch (error) {
		if ((error as NodeJS.ErrnoException)?.code === "ENOENT") return [];
		return [];
	}
	const rows: IntakeCountRow[] = [];
	for (const line of raw.split("\n")) {
		if (!line.trim()) continue;
		let parsed: unknown;
		try {
			parsed = JSON.parse(line);
		} catch {
			continue;
		}
		if (parsed === null || typeof parsed !== "object") continue;
		const row = parsed as Record<string, unknown>;
		if (typeof row.at !== "string" || !Number.isFinite(Date.parse(row.at))) continue;
		if (typeof row.kind !== "string" || typeof row.route !== "string" || typeof row.text !== "string") continue;
		rows.push({
			at: row.at,
			kind: row.kind,
			route: row.route,
			text: row.text,
			role: typeof row.role === "string" ? row.role : "",
		});
	}
	return rows;
}

/**
 * Hourly fleet_report intake counts over ledger rows in
 * [hourStartMs, hourStartMs + 1h):
 * - received: every valid row in the hour.
 * - routed: route "ROUTE <bead> -> <seat>".
 * - doneInRole: work rows done (DO) by the role that owns the text
 *   (ownerRoleFor, shared with the route slice).
 * - overridden: work rows done (DO) by any other named role — the self-do
 *   case that needs Joshua's --role-override words. Rule rows are Joshua's
 *   own directives and count in received only.
 */
export function summarizeIntakeHour(rows: readonly IntakeCountRow[], hourStartMs: number): IntakeHourlyCounts {
	const end = hourStartMs + INTAKE_DELIVER_HOUR_MS;
	let received = 0;
	let routed = 0;
	let doneInRole = 0;
	let overridden = 0;
	for (const row of rows) {
		const at = Date.parse(row.at);
		if (!Number.isFinite(at) || at < hourStartMs || at >= end) continue;
		received++;
		if (row.route.startsWith("ROUTE")) routed++;
		// DO-family: bare "DO" from the record slice or "DO <bead>" print form.
		if (row.kind === "work" && (row.route === "DO" || row.route.startsWith("DO "))) {
			const owner = ownerRoleFor(row.text);
			if (row.role === owner) doneInRole++;
			else if (row.role !== "") overridden++;
		}
	}
	return { hour: new Date(hourStartMs).toISOString(), received, routed, doneInRole, overridden };
}

/** One-line counts shaped for the fleet-report digest. */
export function intakeCountsLine(counts: IntakeHourlyCounts): string {
	return `intake: hour=${counts.hour} received=${counts.received} routed=${counts.routed} done_in_role=${counts.doneInRole} overridden=${counts.overridden}`;
}

function countNow(repo: string, nowMs: number): { counts: IntakeHourlyCounts; countsLine: string } {
	let rows: IntakeCountRow[];
	try {
		rows = readIntakeRows(repo);
	} catch {
		rows = [];
	}
	const hourStart = Math.floor(nowMs / INTAKE_DELIVER_HOUR_MS) * INTAKE_DELIVER_HOUR_MS;
	const counts = summarizeIntakeHour(rows, hourStart);
	return { counts, countsLine: intakeCountsLine(counts) };
}

/**
 * Deliver one ROUTE assignment: br assignee update, Agent Mail to the seat,
 * tern delivery, then the session-file marker proof (one retry, then the
 * drop-folder fallback). br failure aborts before anything is sent; mail
 * failure aborts before tern. A redelivery whose marker already sits in the
 * session file sends nothing (ALREADY_DELIVERED).
 */
export async function deliverRoute(input: DeliverInput, deps: DeliverDeps = {}): Promise<DeliverResult> {
	const bead = input.bead.trim();
	const seat = input.seat.trim();
	const text = input.text.trim();
	if (bead === "" || seat === "" || text === "") throw new Error("intake deliver refused: bead, seat and text are all required");
	if (typeof input.repo !== "string" || input.repo.trim() === "" || !isAbsolute(input.repo)) {
		throw new Error("intake deliver refused: repo path must be absolute");
	}
	if (typeof input.project !== "string" || input.project.trim() === "") throw new Error("intake deliver refused: mail project is required");
	if (typeof input.session !== "string" || input.session.trim() === "") throw new Error("intake deliver refused: tern session is required");
	if (typeof input.pane !== "string" || input.pane.trim() === "") throw new Error("intake deliver refused: tern pane is required");
	if (typeof input.windowKey !== "string" || input.windowKey.trim() === "") {
		throw new Error("intake deliver refused: tern window key is required (no first-window fallback)");
	}
	if (typeof input.dropDir !== "string" || input.dropDir.trim() === "") throw new Error("intake deliver refused: drop dir is required");

	const runBr = deps.runBr ?? defaultBr;
	const runMail = deps.runMail ?? defaultMail;
	const deliver = deps.deliver ?? defaultTernDeliver;
	const readSessionFile = deps.readSessionFile ?? defaultReadSessionFile;
	const wait = deps.wait ?? (async (ms: number) => {
		await new Promise<void>((resolvePromise) => setTimeout(resolvePromise, ms));
	});
	const now = deps.now ?? Date.now;
	const repo = resolve(input.repo);
	const marker = markerFor(bead, seat, text);
	const finish = (partial: Omit<DeliverResult, "counts" | "countsLine">): DeliverResult => ({ ...partial, ...countNow(repo, now()) });

	const prePath = typeof input.sessionFile === "string" && input.sessionFile !== "" ? input.sessionFile : null;
	if (prePath !== null) {
		const existing = safeRead(readSessionFile, prePath);
		if (existing !== null && existing.includes(marker)) {
			return finish({ status: "ALREADY_DELIVERED", bead, seat, marker, sends: 0, sessionFile: prePath,
				dropPath: null, detail: `marker ${marker} already in ${prePath}; nothing resent` });
		}
	}

	let brOut: { argv: string[]; code: number; out: string };
	try {
		brOut = runBr(["br", "update", bead, "--assignee", seat, "--json"], { cwd: repo, timeoutMs: INTAKE_DELIVER_BR_TIMEOUT_MS });
	} catch (error) {
		return finish({ status: "BR_FAILED", bead, seat, marker, sends: 0, sessionFile: prePath, dropPath: null,
			detail: `br assignee update threw: ${error instanceof Error ? error.message : String(error)}` });
	}
	if (brOut.code !== 0) {
		return finish({ status: "BR_FAILED", bead, seat, marker, sends: 0, sessionFile: prePath, dropPath: null,
			detail: `br assignee update exited ${brOut.code}: ${brOut.out.slice(0, 200)}` });
	}

	const from = (input.from ?? "joshua").trim() || "joshua";
	const subject = input.subject ?? `intake route ${bead} -> ${seat}`;
	const body = `Routing ${bead} to ${seat}: ${text}\n\nmarker: ${marker}\nbead: ${bead}`;
	let mailOut: MailRun;
	try {
		mailOut = runMail(["am", "mail", "send", "--project", input.project.trim(), "--from", from, "--to", seat,
			"--subject", subject, "--body", body]);
	} catch (error) {
		return finish({ status: "MAIL_FAILED", bead, seat, marker, sends: 0, sessionFile: prePath, dropPath: null,
			detail: `agent mail send threw: ${error instanceof Error ? error.message : String(error)}` });
	}
	if (mailOut.code !== 0) {
		return finish({ status: "MAIL_FAILED", bead, seat, marker, sends: 0, sessionFile: prePath, dropPath: null,
			detail: `agent mail send exited ${mailOut.code}: ${mailOut.out.slice(0, 200)}` });
	}

	const binding: TernSeatBinding = { session: input.session.trim(), pane: input.pane.trim(), windowKey: input.windowKey.trim(), cwd: repo };
	const payload = `${text}\n[${marker}]`;
	let tern: TernDeliverResult;
	try {
		tern = await deliver({ seat: binding, text: payload, dropDir: input.dropDir });
	} catch (error) {
		const dropPath = writeDeliverDrop(input.dropDir, binding.session, binding.pane, marker, bead, seat, text);
		return finish({ status: "FALLBACK", bead, seat, marker, sends: 0, sessionFile: prePath, dropPath,
			detail: `tern delivery threw (${error instanceof Error ? error.message : String(error)}); proof unproven; recovery copy written` });
	}
	const sessionFile = tern.sessionFile ?? prePath;
	const proofPath = typeof sessionFile === "string" && sessionFile !== "" ? sessionFile : null;
	if (proofPath !== null) {
		const first = safeRead(readSessionFile, proofPath);
		if (first !== null && first.includes(marker)) {
			return finish({ status: "DELIVERED", bead, seat, marker, sends: tern.sends, sessionFile: proofPath, dropPath: null,
				detail: `marker ${marker} proven in ${proofPath}; ${tern.detail}` });
		}
		await wait(INTAKE_DELIVER_PROOF_RETRY_WAIT_MS);
		const second = safeRead(readSessionFile, proofPath);
		if (second !== null && second.includes(marker)) {
			return finish({ status: "DELIVERED", bead, seat, marker, sends: tern.sends, sessionFile: proofPath, dropPath: null,
				detail: `marker ${marker} proven in ${proofPath} on retry; ${tern.detail}` });
		}
	}
	const dropPath = writeDeliverDrop(input.dropDir, binding.session, binding.pane, marker, bead, seat, text);
	return finish({ status: "FALLBACK", bead, seat, marker, sends: tern.sends, sessionFile: proofPath, dropPath,
		detail: `marker ${marker} unproven after one retry (${tern.status}: ${tern.detail}); recovery copy written` });
}
