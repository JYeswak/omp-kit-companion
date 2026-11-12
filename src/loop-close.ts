import { appendFileSync, closeSync, existsSync, mkdirSync, openSync, readFileSync, readSync, renameSync, statSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { dirname, join } from "node:path";
import { run } from "./kitlib/run.ts";
import { callAgentMail } from "./fleet-guard/reservations.ts";
import { jobReceiptPath, KNOWN_JOBS } from "./service.ts";
import { lifecycleGaps, lifecycleManifestPath, loadLifecycleManifest, validateLifecycleManifest, type LifecycleGap, type LifecycleManifest } from "./lifecycle.ts";
import { LIVE_READBACK_LABEL, liveReadback } from "./verify.ts";

// LOOPCLOSE1 (ompkit-1ra0d.211): the daily consumer. Every measured signal gets an
// automatic consumer: silent refusal codes get a retire bead, new codes wake the lead,
// live readbacks run, red services get a bead. A human is never the scheduled consumer.
//
// Every external input is injectable (LoopCloseDeps): the gate-events ledger path, the
// tracker (br through kitlib run, the way verify.ts files live-readback beads), the
// Agent Mail send (callAgentMail, the way release-verdict-mail.ts sends), the service
// status reader, and the live-readback list/visit pair (the bounded form of
// verify --live-readback --all: liveReadbackAll's discovery plus its per-bead
// liveReadback, with an overall deadline). Production defaults wire each seam;
// tests inject fakes.

/** Refusal-code canonicalisation, ported from omp-kit scripts/turnline.py (private). */
// Only kind == "refuse" rows count as refusals; these prefixes never do.
const ERROR_PREFIXES = ["tool-error:", "validation:", "timeout:", "assertion:", "agent-input:", "finding:", "mcp-transport:"];
// Old rows carrying the guard's own name with no code.
const BARE_NON_REFUSAL_GATES = ["kit-flywheel-guard", "kit-flywheel-guard:"];
const GF_PREFIX = "guard-friction:";
const CR_PREFIX = "commit-refusal:";
// dcg and SLB are separate safety tools kept on purpose: each counts as one code.
const SAFETY_TOOL_CODES: Record<string, string> = { "dcg-denied": "dcg", "slb-caution": "slb", "slb-dangerous": "slb" };

export function isNonRefusalGate(gate: unknown): boolean {
	if (typeof gate !== "string") return false;
	if (gate === BARE_NON_REFUSAL_GATES[0] || gate === BARE_NON_REFUSAL_GATES[1]) return true;
	return ERROR_PREFIXES.some(prefix => gate.startsWith(prefix));
}

export function canonicalCode(gate: unknown): string {
	let code = typeof gate === "string" ? gate : "";
	if (code.startsWith(GF_PREFIX)) code = code.slice(GF_PREFIX.length);
	else if (code.startsWith(CR_PREFIX)) code = code.slice(CR_PREFIX.length);
	const safety = SAFETY_TOOL_CODES[code];
	if (safety !== undefined) return safety;
	// A lowercase dotted rule id (dcg rules are pack.category-rule) counts as one code.
	const head = code[0];
	if (code.includes(".") && code === code.toLowerCase() && head !== undefined
		&& head.toLowerCase() === head && head.toUpperCase() !== head) return "dcg";
	return code;
}

/** turnline parse_ts: ISO with Z or offset; a naive timestamp is UTC, never local. */
export function parseGateTs(value: unknown): number | null {
	if (typeof value !== "string" || value.length === 0) return null;
	let normalized = value;
	if (normalized.endsWith("Z") || normalized.endsWith("z")) normalized = `${normalized.slice(0, -1)}+00:00`;
	else {
		const t = normalized.indexOf("T");
		const afterT = t < 0 ? "" : normalized.slice(t + 1);
		if (!afterT.includes("+") && !afterT.includes("-")) normalized = `${normalized}Z`;
	}
	const ms = Date.parse(normalized);
	return Number.isFinite(ms) ? ms : null;
}

export const LOOP_CLOSE_LABEL = "loop-close";
export const LOOP_CLOSE_RETIRE_DAYS = 30;
export const LOOP_CLOSE_RED_HOURS = 24;

/** LIFECYCLEMANIFEST1: new gap-bead filings per run; updates to filed beads are uncapped. */
export const LIFECYCLE_FILE_CAP = 5;
const DAY_MS = 24 * 60 * 60 * 1000;
/** Bounded ledger read; gate-events stays small but never unbounded. */
const MAX_LEDGER_BYTES = 8 * 1024 * 1024;
/** Bounded state read; the dedup map is keys to bead ids. */
const MAX_STATE_BYTES = 1024 * 1024;

export interface LoopCloseBrResult { rc: number | null; stdout: string; stderr: string }
export interface LoopCloseMail { subject: string; bodyMd: string }
export interface LoopCloseMailResult { delivered: boolean; detail: string }
export interface LoopCloseServiceState { name: string; red: boolean; redSinceMs: number | null }
export interface LoopCloseLiveVisit { ok: boolean }
export interface LoopCloseLiveReadback { ok: boolean; visited: number; skipped: number }

export interface LoopCloseDeps {
	ledgerPath: string;
	/** Dedup state file under the kit state root; keys are stable, values are bead ids. */
	statePath: string;
	home: string;
	/** cwd for br. */
	repo: string;
	actor: string;
	env?: Record<string, string>;
	nowMs?: number;
	/** Overall live-readback budget; unset leaves the readback unbounded. */
	capMs?: number;
	/** Advancing clock for the readback deadline; default Date.now. */
	clockMs?: () => number;
	/** REPORT mail recipient; unset skips the wake with a finding. */
	mailTo?: string;
	mailProjectKey?: string;
	/** Tracker seam; argv excludes the `br` binary name (the production seam prepends it). */
	runBr?: (argv: string[]) => Promise<LoopCloseBrResult>;
	sendMail?: (mail: LoopCloseMail) => Promise<LoopCloseMailResult>;
	readServiceStatus?: () => Promise<LoopCloseServiceState[]>;
	/** Open live-readback bead ids in visit order; default ports liveReadbackAll's discovery. */
	listLiveReadbacks?: () => Promise<string[]>;
	/** One bead visit; default is verify.ts liveReadback, the same per-bead fn --all uses. */
	runLiveReadback?: (bead: string) => Promise<LoopCloseLiveVisit>;
	/** Lifecycle manifest path; default docs/lifecycle.json under the run repo. */
	lifecycleManifestPath?: string;
}

export interface LoopCloseResult {
	ok: boolean;
	retiredFiled: string[];
	retiredUpdated: string[];
	redFiled: string[];
	redUpdated: string[];
	/** LIFECYCLEMANIFEST1: gap beads filed, updated, and closed-comment this run. */
	lifecycleFiled: string[];
	lifecycleUpdated: string[];
	lifecycleClosed: string[];
	newCodes: string[];
	mail: "SENT" | "SKIPPED-NEW-MAIL-SEEN" | "SKIPPED-QUIET" | "SKIPPED-UNCONFIGURED" | "SKIPPED-TRUNCATED" | "FAILED";
	liveReadback: LoopCloseLiveReadback | null;
	/** The overall readback deadline this run enforced, or null when unbounded. */
	deadlineMs: number | null;
	findings: string[];
	summary: string;
}

interface CodeStats { minTs: number; maxTs: number; inWindow: boolean }

/** A stable per-key label lets a later run adopt the bead even when the state file is lost. */
function stableLabelFor(key: string): string {
	return `loop-close:${key.split(",").join("_")}`;
}

/** Bounded ledger lines; an oversize ledger contributes its tail (recent rows win). */
function readLedgerLines(ledgerPath: string, findings: string[]): { lines: string[]; truncated: boolean } {
	try {
		if (!existsSync(ledgerPath)) {
			findings.push("LEDGER_UNAVAILABLE: gate-events ledger is absent; retire and new-code loops are skipped");
			return { lines: [], truncated: false };
		}
		const size = statSync(ledgerPath).size;
		let text: string;
		let truncated = false;
		if (size <= MAX_LEDGER_BYTES) {
			text = readFileSync(ledgerPath, "utf8");
		} else {
			truncated = true;
			findings.push(`LEDGER_TRUNCATED: gate-events ledger exceeds ${MAX_LEDGER_BYTES} bytes; only the tail is read`);
			const fd = openSync(ledgerPath, "r");
			try {
				const buf = Buffer.alloc(MAX_LEDGER_BYTES);
				let read = 0;
				while (read < MAX_LEDGER_BYTES) {
					const n = readSync(fd, buf, read, MAX_LEDGER_BYTES - read, size - MAX_LEDGER_BYTES + read);
					if (n <= 0) break;
					read += n;
				}
				const tail = new TextDecoder().decode(buf.subarray(0, read));
				text = tail.slice(tail.indexOf("\n") + 1);
			} finally {
				closeSync(fd);
			}
		}
		return { lines: text.split("\n"), truncated };
	} catch (error) {
		findings.push(`LEDGER_UNAVAILABLE: gate-events ledger cannot be read: ${error instanceof Error ? error.message : String(error)}`);
		return { lines: [], truncated: false };
	}
}

function summarizeLedger(lines: string[], nowMs: number): { silent: { code: string; lastFire: number }[]; newCodes: string[] } {
	const cutoff7 = nowMs - 7 * DAY_MS;
	const cutoff30 = nowMs - LOOP_CLOSE_RETIRE_DAYS * DAY_MS;
	const seen = new Map<string, CodeStats>();
	for (const line of lines) {
		const trimmed = line.trim();
		if (trimmed === "") continue;
		let row: unknown;
		try {
			row = JSON.parse(trimmed);
		} catch {
			continue;
		}
		if (row === null || typeof row !== "object" || Array.isArray(row)) continue;
		const record = row as Record<string, unknown>;
		if (isNonRefusalGate(record.gate)) continue;
		const ts = parseGateTs(record.ts);
		if (ts === null) continue;
		if (record.kind !== "refuse") continue;
		const code = canonicalCode(record.gate);
		const stats = seen.get(code) ?? { minTs: ts, maxTs: ts, inWindow: false };
		if (ts < stats.minTs) stats.minTs = ts;
		if (ts > stats.maxTs) stats.maxTs = ts;
		if (ts >= cutoff7) stats.inWindow = true;
		seen.set(code, stats);
	}
	const silent = [...seen.entries()]
		.filter(([, stats]) => stats.maxTs < cutoff30)
		.map(([code, stats]) => ({ code, lastFire: stats.maxTs }))
		.sort((a, b) => a.code < b.code ? -1 : a.code > b.code ? 1 : 0);
	const newCodes = [...seen.entries()]
		.filter(([, stats]) => stats.inWindow && stats.minTs >= cutoff7)
		.map(([code]) => code)
		.sort();
	return { silent, newCodes };
}

interface LoopCloseStateFile { version: 1; filed: Record<string, string>; redSince: Record<string, number> }

function loadState(statePath: string, findings: string[]): LoopCloseStateFile {
	try {
		if (!existsSync(statePath)) return { version: 1, filed: {}, redSince: {} };
		if (statSync(statePath).size > MAX_STATE_BYTES) {
			findings.push("STATE_OVERSIZE: dedup state exceeds its bound; starting fresh");
			return { version: 1, filed: {}, redSince: {} };
		}
		const parsed: unknown = JSON.parse(readFileSync(statePath, "utf8"));
		if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
			findings.push("STATE_CORRUPT: dedup state is not a version-1 map; starting fresh");
			return { version: 1, filed: {}, redSince: {} };
		}
		const record = parsed as Record<string, unknown>;
		if (record.version !== 1 || record.filed === null || typeof record.filed !== "object" || Array.isArray(record.filed)) {
			findings.push("STATE_CORRUPT: dedup state is not a version-1 map; starting fresh");
			return { version: 1, filed: {}, redSince: {} };
		}
		const filed: Record<string, string> = {};
		for (const [key, value] of Object.entries(record.filed)) {
			if (typeof value === "string" && value !== "") filed[key] = value;
		}
		const redSince: Record<string, number> = {};
		if (record.redSince !== undefined) {
			if (record.redSince === null || typeof record.redSince !== "object" || Array.isArray(record.redSince)) {
				findings.push("STATE_CORRUPT: dedup state redSince is not a map; dropping red streaks");
			} else {
				for (const [name, firstSeen] of Object.entries(record.redSince)) {
					if (typeof firstSeen === "number" && Number.isFinite(firstSeen)) redSince[name] = firstSeen;
				}
			}
		}
		return { version: 1, filed, redSince };
	} catch (error) {
		findings.push(`STATE_UNREADABLE: dedup state cannot be read: ${error instanceof Error ? error.message : String(error)}; starting fresh`);
		return { version: 1, filed: {}, redSince: {} };
	}
}

function saveState(statePath: string, state: LoopCloseStateFile): boolean {
	try {
		mkdirSync(dirname(statePath), { recursive: true, mode: 0o700 });
		const tmp = `${statePath}.tmp-${process.pid}`;
		writeFileSync(tmp, `${JSON.stringify(state)}\n`, { mode: 0o600 });
		renameSync(tmp, statePath);
		return true;
	} catch {
		return false;
	}
}

function fileId(stdout: string): string | null {
	try {
		const doc: unknown = JSON.parse(stdout);
		const row: unknown = Array.isArray(doc) ? doc[0] : doc;
		if (row !== null && typeof row === "object" && "id" in row && typeof row.id === "string" && row.id !== "") return row.id;
		return null;
	} catch {
		return null;
	}
}

interface TrackedBead { id: string; status: string; labels: string[] }

/** Rows of one `br list --label loop-close` result; tolerates the doc.issues envelope and bare arrays. */
function parseTrackedBeads(stdout: string): TrackedBead[] | null {
	try {
		const doc: unknown = JSON.parse(stdout);
		const rows: unknown = doc !== null && typeof doc === "object" && "issues" in doc ? doc.issues : doc;
		if (!Array.isArray(rows)) return null;
		const beads: TrackedBead[] = [];
		for (const row of rows) {
			if (row === null || typeof row !== "object" || !("id" in row) || typeof row.id !== "string" || row.id === "") return null;
			const status = "status" in row && typeof row.status === "string" ? row.status : "";
			const labels = "labels" in row && Array.isArray(row.labels) ? row.labels.filter((label): label is string => typeof label === "string") : [];
			beads.push({ id: row.id, status, labels });
		}
		return beads;
	} catch {
		return null;
	}
}

/** Production br seam: kitlib run with argv, never a shell string. The seam prepends
 * the `br` binary name and threads the verify.ts `...db` spread, so write call sites
 * carry no tracker literal of their own. */
async function defaultRunBr(argv: string[], deps: LoopCloseDeps): Promise<LoopCloseBrResult> {
	const env: Record<string, string> = {};
	for (const [key, value] of Object.entries(deps.env ?? process.env)) {
		if (typeof value === "string") env[key] = value;
	}
	const db = env.BEADS_DB ? ["--db", env.BEADS_DB] : [];
	const result = await run(["br", ...argv, ...db], { cwd: deps.repo, deadline_s: 60, env });
	const text = new TextDecoder();
	return { rc: result.rc, stdout: text.decode(result.stdout), stderr: text.decode(result.stderr) };
}

/** Production mail seam: Agent Mail send_message (release-verdict-mail.ts sends this way). */
async function defaultSendMail(mail: LoopCloseMail, deps: LoopCloseDeps): Promise<LoopCloseMailResult> {
	const sender = process.env.AGENT_NAME;
	const senderToken = process.env.AGENT_MAIL_SENDER_TOKEN;
	if (!sender || !senderToken || !deps.mailTo || !deps.mailProjectKey) {
		throw new Error("loop-close mail sender or recipient is unconfigured");
	}
	const key = createHash("sha256").update(JSON.stringify([deps.mailProjectKey, deps.mailTo.toLowerCase(), mail.subject, mail.bodyMd])).digest("hex");
	const result = await callAgentMail("send_message", {
		project_key: deps.mailProjectKey, sender_name: sender, sender_token: senderToken, to: [deps.mailTo],
		subject: mail.subject, body_md: mail.bodyMd, ack_required: false,
		idempotency_key: `loop-close-${key}`,
	}, AbortSignal.timeout(20_000));
	if (typeof result !== "object" || result === null || !("count" in result) || result.count !== 1) {
		throw new Error("loop-close mail delivery unconfirmed");
	}
	return { delivered: true, detail: "delivered" };
}

/**
 * Production status seam: a service is red when its last receipt failed (exit != 0 and
 * not a skip); redSince is the receipt's finished_at. Absent receipts are unknown, never red.
 */
async function defaultReadServiceStatus(deps: LoopCloseDeps): Promise<LoopCloseServiceState[]> {
	const states: LoopCloseServiceState[] = [];
	for (const name of Object.keys(KNOWN_JOBS)) {
		try {
			const parsed: unknown = JSON.parse(readFileSync(jobReceiptPath(deps.home, name), "utf8"));
			if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) continue;
			const receipt = parsed as Record<string, unknown>;
			if (typeof receipt.exit !== "number" || receipt.exit === 0) continue;
			if (typeof receipt.status === "string" && receipt.status.startsWith("SKIPPED")) continue;
			const finished = typeof receipt.finished_at === "string" ? Date.parse(receipt.finished_at) : NaN;
			states.push({ name, red: true, redSinceMs: Number.isFinite(finished) ? finished : null });
		} catch {
			continue;
		}
	}
	return states;
}

/** Production list seam: the liveReadbackAll discovery query, verbatim. */
async function defaultListLiveReadbacks(runBr: (argv: string[]) => Promise<LoopCloseBrResult>): Promise<string[]> {
	const listed = await runBr(["list", "--status", "open", "--label", LIVE_READBACK_LABEL, "--limit", "0", "--json"]);
	if (listed.rc !== 0) throw new Error(`br list rc ${listed.rc}: ${listed.stderr.slice(0, 200)}`);
	let doc: unknown = null;
	try {
		doc = JSON.parse(listed.stdout);
	} catch {
		throw new Error(`br list printed no JSON: ${listed.stdout.slice(0, 200)}`);
	}
	const rows: unknown = doc !== null && typeof doc === "object" && "issues" in doc ? doc.issues : doc;
	if (!Array.isArray(rows)) throw new Error("br list printed no issue rows");
	return rows
		.map(row => row !== null && typeof row === "object" && "id" in row && typeof row.id === "string" ? row.id : "")
		.filter(id => id !== "")
		.sort();
}

/** Production visit seam: verify.ts liveReadback, the same per-bead fn --all uses. */
async function defaultRunLiveReadback(bead: string, deps: LoopCloseDeps): Promise<LoopCloseLiveVisit> {
	const result = await liveReadback({ repo: deps.repo, actor: deps.actor, env: deps.env, bead });
	return { ok: result.ok };
}

function retireDescription(code: string, lastFire: number, nowMs: number): string {
	const days = Math.floor((nowMs - lastFire) / DAY_MS);
	return `WHAT: refusal code \`${code}\` last fired ${new Date(lastFire).toISOString()} (${days} d ago): 0 fires in the last ${LOOP_CLOSE_RETIRE_DAYS} d. Per the policy/gates.jsonl 30-day-zero retirement rule this code is a retire candidate.\n\nWHY: every measured signal gets an automatic consumer (lifecycle map 2026-11-12, LOOPCLOSE1 ompkit-1ra0d.211); a silent code nobody examines is measurement theatre.`;
}

function redDescription(name: string, redSinceMs: number): string {
	return `WHAT: service \`${name}\` has been red since ${new Date(redSinceMs).toISOString()} (over ${LOOP_CLOSE_RED_HOURS} h): its last receipt failed.\n\nWHY: a red service with no consumer stays red (lifecycle map 2026-11-12, LOOPCLOSE1 ompkit-1ra0d.211); 6 of 16 services were red and silent.`;
}

/** One red incident: the service plus the UTC date its current red streak started. */
function redIncidentKey(name: string, redSinceMs: number): string {
	return `red-service:${name}:${new Date(redSinceMs).toISOString().slice(0, 10)}`;
}

/** LIFECYCLEMANIFEST1: one bead per manifest gap, closed with a comment. */
function lifecycleGapTitle(gap: LifecycleGap): string {
	return `LIFECYCLE: ${gap.phase} missing ${gap.facet}`;
}

function lifecycleGapDescription(gap: LifecycleGap, manifest: LifecycleManifest): string {
	const row = manifest.rows.find(candidate => candidate.phase === gap.phase);
	const exit = row !== undefined ? row.exit_criterion : "unknown";
	return `WHAT: lifecycle phase \`${gap.phase}\` is missing its ${gap.facet} (exit criterion: ${exit}).\n\nWHY: the lifecycle manifest (docs/lifecycle.json) is the checked phase map (LIFECYCLEMANIFEST1 ompkit-1ra0d.217); every gap gets an automatic consumer, never a human reader.`;
}

function lifecycleGapAcceptance(gap: LifecycleGap): string {
	return `- [ ] Fill the ${gap.facet} for phase \`${gap.phase}\` in docs/lifecycle.json\n- [ ] Run \`bun scripts/lifecycle-check.ts --check\` green\n- [ ] Close this bead when the gap row is complete`;
}

export async function runLoopClose(deps: LoopCloseDeps): Promise<LoopCloseResult> {
	const findings: string[] = [];
	const nowMs = deps.nowMs ?? Date.now();
	const clock = deps.clockMs ?? Date.now;
	const deadline = deps.capMs === undefined ? null : clock() + deps.capMs;
	const runBr = deps.runBr ?? ((argv: string[]) => defaultRunBr(argv, deps));
	const readServiceStatus = deps.readServiceStatus ?? (() => defaultReadServiceStatus(deps));
	const listLiveReadbacks = deps.listLiveReadbacks ?? (() => defaultListLiveReadbacks(runBr));
	const runLiveReadback = deps.runLiveReadback ?? ((bead: string) => defaultRunLiveReadback(bead, deps));
	const result: LoopCloseResult = {
		ok: true, retiredFiled: [], retiredUpdated: [], redFiled: [], redUpdated: [],
		lifecycleFiled: [], lifecycleUpdated: [], lifecycleClosed: [],
		newCodes: [], mail: "SKIPPED-QUIET", liveReadback: null, deadlineMs: deadline, findings, summary: "",
	};

	const ledger = readLedgerLines(deps.ledgerPath, findings);
	const { silent, newCodes } = summarizeLedger(ledger.lines, nowMs);
	result.newCodes = newCodes;

	const state = loadState(deps.statePath, findings);
	const persist = (why: string): void => {
		if (!saveState(deps.statePath, state)) {
			result.ok = false;
			findings.push(`STATE_UNWRITABLE: dedup state cannot be saved after ${why}; a later run may duplicate filings`);
		}
	};

	// Tracker-side backstop, queried lazily: a bead carrying the stable label is
	// adopted (open: update it; closed: keep the mapping, the loop already closed)
	// so a lost state file or a crash between filing and save never refiles.
	let backstop: TrackedBead[] | null = null;
	let backstopDead = false;
	const ensureBackstop = async (): Promise<TrackedBead[]> => {
		if (backstop !== null) return backstop;
		if (backstopDead) return [];
		try {
			const listed = await runBr(["list", "--label", LOOP_CLOSE_LABEL, "--limit", "0", "--json"]);
			if (listed.rc !== 0) {
				findings.push(`TRACKER_LIST_FAILED: backstop list rc ${String(listed.rc)}: ${listed.stderr.slice(0, 300)}`);
				backstopDead = true;
				return [];
			}
			const beads = parseTrackedBeads(listed.stdout);
			if (beads === null) {
				findings.push(`TRACKER_LIST_FAILED: backstop list printed no bead rows: ${listed.stdout.slice(0, 300)}`);
				backstopDead = true;
				return [];
			}
			backstop = beads;
			return backstop;
		} catch (error) {
			findings.push(`TRACKER_LIST_FAILED: backstop list threw: ${error instanceof Error ? error.message.slice(0, 300) : String(error).slice(0, 300)}`);
			backstopDead = true;
			return [];
		}
	};

	const fileOrUpdate = async (key: string, title: string, description: string, acceptance: string,
		filed: string[], updated: string[]): Promise<void> => {
		const existing = state.filed[key];
		if (existing !== undefined) {
			const refreshed = await runBr(["update", existing, "--description", description, "--actor", deps.actor]);
			if (refreshed.rc === 0) updated.push(existing);
			else findings.push(`TRACKER_UPDATE_FAILED: ${key} bead ${existing} not refreshed (rc ${String(refreshed.rc)}): ${refreshed.stderr.slice(0, 300)}`);
			return;
		}
		const label = stableLabelFor(key);
		const known = await ensureBackstop();
		const adopted = known.find(bead => bead.labels.includes(label) && bead.status === "open")
			?? known.find(bead => bead.labels.includes(label));
		if (adopted !== undefined) {
			state.filed[key] = adopted.id;
			persist(`adopting ${key}`);
			if (adopted.status === "open") {
				const refreshed = await runBr(["update", adopted.id, "--description", description, "--actor", deps.actor]);
				if (refreshed.rc === 0) updated.push(adopted.id);
				else findings.push(`TRACKER_UPDATE_FAILED: ${key} bead ${adopted.id} not refreshed (rc ${String(refreshed.rc)}): ${refreshed.stderr.slice(0, 300)}`);
			}
			return;
		}
		const created = await runBr(["create", title, "-t", "task", "-l", `${LOOP_CLOSE_LABEL},${label}`,
			"--description", description, "--acceptance-criteria", acceptance, "--json", "--actor", deps.actor]);
		if (created.rc !== 0) {
			findings.push(`TRACKER_FILE_FAILED: ${key} not filed (rc ${String(created.rc)}): ${created.stderr.slice(0, 300)}`);
			return;
		}
		const id = fileId(created.stdout);
		if (id === null) {
			findings.push(`TRACKER_FILE_FAILED: ${key} create printed no bead id: ${created.stdout.slice(0, 300)}`);
			return;
		}
		state.filed[key] = id;
		persist(`filing ${key}`);
		filed.push(id);
	};

	for (const entry of silent) {
		await fileOrUpdate(`retire-code:${entry.code}`, `RETIRE: ${entry.code} silent ${LOOP_CLOSE_RETIRE_DAYS} d`,
			retireDescription(entry.code, entry.lastFire, nowMs),
			`- [ ] Retire the rule or hook behind \`${entry.code}\`, or record why it stays\n- [ ] Close this bead when the retirement lands`,
			result.retiredFiled, result.retiredUpdated);
	}

	if (newCodes.length > 0) {
		// A truncated ledger reads only the tail, so an old code's surviving rows look
		// like a first sighting: retiring silent codes stays sound, but the new-code
		// wake would false-fire. Skip it with a finding.
		if (ledger.truncated) {
			result.mail = "SKIPPED-TRUNCATED";
			findings.push("MAIL_SKIPPED_TRUNCATED: gate-events ledger is truncated; new-code first-seen is approximate so no REPORT is sent");
		} else {
			const mailKey = `new-codes:${createHash("sha256").update(JSON.stringify(newCodes)).digest("hex")}`;
			if (state.filed[mailKey] !== undefined) {
				result.mail = "SKIPPED-NEW-MAIL-SEEN";
			} else if (!deps.mailTo || !deps.mailProjectKey) {
				result.mail = "SKIPPED-UNCONFIGURED";
				findings.push("MAIL_UNCONFIGURED: new refusal codes need a wake but no recipient is configured");
			} else {
				const sendMail = deps.sendMail ?? ((mail: LoopCloseMail) => defaultSendMail(mail, deps));
				const bodyMd = `New refusal codes in the last 7 d (turnline new_codes_7d):\n${newCodes.map(code => `- \`${code}\``).join("\n")}\n\nFiled by the daily loop-close job (LOOPCLOSE1 ompkit-1ra0d.211).`;
				try {
					const sent = await sendMail({ subject: `REPORT loop-close: ${newCodes.length} new refusal code(s)`, bodyMd });
					if (sent.delivered) {
						state.filed[mailKey] = "sent";
						persist("recording the new-code REPORT");
						result.mail = "SENT";
					} else {
						result.mail = "FAILED";
						findings.push(`MAIL_FAILED: new-code REPORT not delivered: ${sent.detail.slice(0, 300)}`);
					}
				} catch (error) {
					result.mail = "FAILED";
					findings.push(`MAIL_FAILED: new-code REPORT threw: ${error instanceof Error ? error.message.slice(0, 300) : String(error).slice(0, 300)}`);
				}
			}
		}
	}

	try {
		const statuses = await readServiceStatus();
		// Red streaks: the receipt keeps only the last run, so a persistently red
		// service would re-key every day. First-seen-red lives here instead; the
		// incident key and the 24 h gate both use it, and green clears it.
		let streaksDirty = false;
		for (const row of statuses) {
			if (!row.red) continue;
			if (row.redSinceMs === null) {
				if (state.redSince[row.name] === undefined) {
					findings.push(`STATUS_AGE_UNKNOWN: ${row.name} is red but its last receipt has no parseable finished_at; skipped until its age is known`);
				}
				continue;
			}
			if (state.redSince[row.name] === undefined) {
				state.redSince[row.name] = row.redSinceMs;
				streaksDirty = true;
			}
		}
		for (const name of Object.keys(state.redSince)) {
			if (!statuses.some(row => row.red && row.name === name)) {
				delete state.redSince[name];
				streaksDirty = true;
			}
		}
		if (streaksDirty) persist("recording red streaks");
		const due = Object.entries(state.redSince)
			.filter(([, firstSeen]) => nowMs - firstSeen >= LOOP_CLOSE_RED_HOURS * 60 * 60 * 1000)
			.map(([name, firstSeen]) => ({ name, firstSeen }))
			.sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0);
		for (const service of due) {
			await fileOrUpdate(redIncidentKey(service.name, service.firstSeen), `RED ${LOOP_CLOSE_RED_HOURS} h: ${service.name} failing`,
				redDescription(service.name, service.firstSeen),
				`- [ ] Repair or reinstall \`${service.name}\` and confirm a green receipt\n- [ ] Close this bead when the service holds green`,
				result.redFiled, result.redUpdated);
		}
	} catch (error) {
		findings.push(`STATUS_FAILED: service status unreadable: ${error instanceof Error ? error.message.slice(0, 300) : String(error).slice(0, 300)}`);
	}

	// LIFECYCLEMANIFEST1: audit the checked phase map; every gap files or updates
	// one bead, and a closed gap gets a closing comment on its old bead (the
	// tracker has no close route here, so the mapping stays for a reopen).
	try {
		const manifestPath = deps.lifecycleManifestPath ?? lifecycleManifestPath(deps.repo);
		const loaded = loadLifecycleManifest(manifestPath);
		if (loaded.reason === "absent") {
			// Trees without the manifest predate the loop; nothing to audit.
		} else if (loaded.reason !== "ok" || loaded.manifest === null) {
			findings.push(`LIFECYCLE_MANIFEST_UNREADABLE: ${manifestPath} cannot be loaded (${loaded.reason}); gap beads are skipped`);
		} else {
			const problems = validateLifecycleManifest(loaded.manifest, deps.repo);
			if (problems.length > 0) {
				const first = problems[0] ?? "unknown problem";
				findings.push(`LIFECYCLE_MANIFEST_INVALID: ${first.slice(0, 300)}${problems.length > 1 ? ` (+${problems.length - 1} more)` : ""}; gap beads are skipped`);
			} else {
				const manifest = loaded.manifest as LifecycleManifest;
				const open = lifecycleGaps(manifest);
				const openKeys = new Set(open.map(gap => `lifecycle:${gap.phase}:${gap.facet}`));
				let newFiled = 0;
				for (const gap of open) {
					const key = `lifecycle:${gap.phase}:${gap.facet}`;
					// First-run burst cap: new filings stop at the cap in manifest
					// order; already-filed keys update freely below the cap.
					if (state.filed[key] === undefined && newFiled >= LIFECYCLE_FILE_CAP) continue;
					const before = result.lifecycleFiled.length;
					await fileOrUpdate(key, lifecycleGapTitle(gap),
						lifecycleGapDescription(gap, manifest), lifecycleGapAcceptance(gap),
						result.lifecycleFiled, result.lifecycleUpdated);
					if (result.lifecycleFiled.length > before) newFiled += 1;
				}
				for (const key of Object.keys(state.filed)) {
					if (!key.startsWith("lifecycle:") || openKeys.has(key)) continue;
					const bead = state.filed[key];
					if (bead === undefined) continue;
					const refreshed = await runBr(["update", bead, "--description",
						`The lifecycle gap \`${key}\` is closed: docs/lifecycle.json now completes that row. This bead stays as the record; reopen it if the gap returns.`,
						"--actor", deps.actor]);
					if (refreshed.rc === 0) result.lifecycleClosed.push(bead);
					else findings.push(`TRACKER_UPDATE_FAILED: ${key} bead ${bead} not comment-closed (rc ${String(refreshed.rc)}): ${refreshed.stderr.slice(0, 300)}`);
				}
			}
		}
	} catch (error) {
		findings.push(`LIFECYCLE_AUDIT_FAILED: lifecycle audit threw: ${error instanceof Error ? error.message.slice(0, 300) : String(error).slice(0, 300)}`);
	}

	try {
		const beads = await listLiveReadbacks();
		let visited = 0;
		let allOk = true;
		for (const bead of beads) {
			if (deadline !== null && clock() >= deadline) break;
			try {
				const visit = await runLiveReadback(bead);
				visited += 1;
				if (!visit.ok) allOk = false;
			} catch (error) {
				visited += 1;
				allOk = false;
				findings.push(`LIVE_READBACK_FAILED: ${bead} threw: ${error instanceof Error ? error.message.slice(0, 300) : String(error).slice(0, 300)}`);
			}
		}
		result.liveReadback = { ok: allOk, visited, skipped: beads.length - visited };
	} catch (error) {
		findings.push(`LIVE_READBACK_LIST_FAILED: live-readback discovery failed: ${error instanceof Error ? error.message.slice(0, 300) : String(error).slice(0, 300)}`);
	}

	result.summary = `loop-close retired_filed=${result.retiredFiled.length} retired_updated=${result.retiredUpdated.length} red_filed=${result.redFiled.length} red_updated=${result.redUpdated.length} lifecycle_filed=${result.lifecycleFiled.length} lifecycle_updated=${result.lifecycleUpdated.length} lifecycle_closed=${result.lifecycleClosed.length} new_codes=${result.newCodes.length} mail=${result.mail} live_readback=${result.liveReadback === null ? "failed" : `ok=${result.liveReadback.ok} visited=${result.liveReadback.visited} skipped=${result.liveReadback.skipped}`} findings=${findings.length}`;
	try {
		mkdirSync(dirname(deps.statePath), { recursive: true, mode: 0o700 });
		appendFileSync(join(dirname(deps.statePath), "loop-close-runs.jsonl"),
			`${JSON.stringify({ ts: new Date(nowMs).toISOString(), ...result, findings })}\n`, { mode: 0o600 });
	} catch (error) {
		findings.push(`SUMMARY_UNWRITABLE: summary row not appended: ${error instanceof Error ? error.message : String(error)}`);
	}
	return result;
}
