import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { constants, fstatSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, realpathSync, writeSync, closeSync } from "node:fs";
import { basename, isAbsolute, join, relative, resolve, sep } from "node:path";

export const LESSONS_RELATIVE_PATH = ".omp/lessons.jsonl";

export type LessonKind = "NEGATIVE" | "GAP" | "LESSON" | "CHECKIN" | "CORRECTION";
export const LESSON_CLASS_DESCRIPTIONS = {
	SCOPE_GAP: "Description promises behavior that acceptance does not test",
	FALSE_CLAIM: "Notes or state contradict code or the tracker",
	MISSING_EDGE: "A required dependency or evidence edge is missing",
	PRIORITY: "Priority does not match the demonstrated urgency",
	PINNED_LIVE_VALUE: "A runtime inventory or live value is pinned",
	UNDEFINED_TERM: "A requirement uses an unclear or unrunnable term",
	STALE_TEXT: "Documentation or notes no longer match the current behavior",
	CYCLE: "The dependency graph contains a cycle",
	DUPLICATE: "The lesson duplicates another lesson or issue",
	OVERSCOPE: "The stated scope exceeds the requested or evidenced work",
	"OTHER:unspecified": "No canonical class fits the evidence",
} as const;
export type LessonClass = keyof typeof LESSON_CLASS_DESCRIPTIONS | `OTHER:${string}`;
export type LessonAppliesTo = "repo" | "fleet";

export interface LessonIdentity {
	repo: string;
	agent: string | null;
	pane: string | null;
	model: string | null;
}

export interface LessonActivity {
	kind: "commit" | "close";
	id: string;
	agent: string;
	ts: string;
}

export interface LessonCommandResult {
	code: number | null;
	stdout: string;
	stderr: string;
}

export type LessonCommandRunner = (args: readonly string[]) => LessonCommandResult;

export interface ActivityCollection {
	status: "OK" | "PARTIAL" | "UNAVAILABLE";
	events: LessonActivity[];
	warnings: string[];
}

export interface LessonEntry {
	ts: string;
	repo: string;
	agent: string | null;
	pane: string | null;
	model: string | null;
	kind: LessonKind;
	class: LessonClass | null;
	what: string;
	evidence: string | null;
	cost_minutes: number | null;
	applies_to?: LessonAppliesTo | null;
	proposed_fix: string | null;
	bead: string | null;
	superseded_by?: string;
	corrects?: string;
	done?: string[];
	blocked?: string[];
	next?: string[];
	minutes?: number | null;
	tokens?: number | null;
}

export interface AddLessonInput {
	kind: Exclude<LessonKind, "CHECKIN">;
	class: LessonClass;
	what: string;
	evidence: string;
	cost_minutes?: number | null;
	applies_to?: LessonAppliesTo;
	proposed_fix?: string | null;
	bead?: string | null;
	superseded_by?: string;
	corrects?: string;
}

export interface CheckinInput {
	done?: readonly string[];
	blocked?: readonly string[];
	next?: readonly string[];
	minutes?: number | null;
	tokens?: number | null;
	bead?: string | null;
}

export interface LessonsReadResult {
	status: "MISSING" | "OK" | "INVALID";
	path: string;
	entries: LessonEntry[];
	invalid_lines: { line: number; reason: string; code?: string }[];
}

export interface LessonEntryOptions {
	identity?: LessonIdentity;
	now?: Date;
}

export interface CheckinOptions extends LessonEntryOptions {
	/** Activity from Git and the configured tracker; injectable for deterministic fixtures. */
	activity?: readonly LessonActivity[];
}

export interface ActivityCollectionOptions {
	run?: LessonCommandRunner;
	/** Include every actor, for the per-repository doctor; check-in collection stays agent-scoped. */
	allAgents?: boolean;
}

export interface LessonsDoctorOptions {
	intervalMs: number;
	now?: Date;
	identity?: LessonIdentity;
	trackerRoot?: string | null;
	activity?: readonly LessonActivity[];
	run?: LessonCommandRunner;
}

export interface LessonsDoctorFinding {
	code: string;
	status: "FAIL" | "UNVERIFIED";
	message: string;
	agent?: string;
	line?: number;
}

export interface LessonsDoctorReport {
	overall: "OK" | "FAIL" | "UNVERIFIED";
	log_status: LessonsReadResult["status"];
	log_path: string;
	activity_status: ActivityCollection["status"];
	findings: LessonsDoctorFinding[];
	agents: { agent: string; last_checkin_at: string | null; last_activity_at: string; overdue: boolean; overdue_minutes: number | null }[];
	close_followup: { closed: number | null; followed_by_checkin: number | null; share: number | null };
}

const LESSON_KINDS: Record<LessonKind, true> = { NEGATIVE: true, GAP: true, LESSON: true, CHECKIN: true, CORRECTION: true };
const NOFOLLOW = constants.O_NOFOLLOW ?? 0;
const OPEN_READ = constants.O_RDONLY | NOFOLLOW;
const OPEN_APPEND = constants.O_WRONLY | constants.O_CREAT | constants.O_APPEND | NOFOLLOW;

function validNonblank(value: unknown): value is string {
	return typeof value === "string" && value.trim().length > 0 && !/[\r\n]/.test(value);
}

function optionalLessonField(value: unknown, field: "BEAD" | "PROPOSED_FIX"): string | null {
	if (value === undefined || value === null) return null;
	if (!validNonblank(value)) throw new Error(`LESSON_${field}_INVALID`);
	return value.trim();
}

export function isLessonClass(value: unknown): value is LessonClass {
	return typeof value === "string" && (Object.prototype.hasOwnProperty.call(LESSON_CLASS_DESCRIPTIONS, value) || /^OTHER:[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(value));
}

function finiteNonnegative(value: unknown): value is number {
	return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

/** Parse persisted JSON at the log boundary; malformed rows never become typed lesson records. */
function parseLessonEntry(value: unknown): LessonEntry | null {
	if (value === null || typeof value !== "object" || Array.isArray(value)) return null;
	const row = value as Record<string, unknown>;
	if (typeof row.ts !== "string" || !Number.isFinite(Date.parse(row.ts)) || !validNonblank(row.repo) ||
		!(row.agent === null || typeof row.agent === "string") || !(row.pane === null || typeof row.pane === "string") ||
		!(row.model === null || typeof row.model === "string") || typeof row.kind !== "string" ||
		!Object.prototype.hasOwnProperty.call(LESSON_KINDS, row.kind) || !validNonblank(row.what) ||
		!(row.evidence === null || typeof row.evidence === "string") ||
		!(row.cost_minutes === null || finiteNonnegative(row.cost_minutes)) ||
		!(row.applies_to === undefined || row.applies_to === null || row.applies_to === "repo" || row.applies_to === "fleet") ||
		!(row.proposed_fix === null || typeof row.proposed_fix === "string") ||
		!(row.bead === null || typeof row.bead === "string")) return null;
	if (row.superseded_by !== undefined && !validNonblank(row.superseded_by)) return null;
	if (row.kind === "CORRECTION" ? !validNonblank(row.corrects) || !validNonblank(row.superseded_by) : row.corrects !== undefined) return null;
	if (row.kind === "CHECKIN") {
		if (row.class !== null || !Array.isArray(row.done) || !row.done.every(validNonblank) ||
			!Array.isArray(row.blocked) || !row.blocked.every(validNonblank) ||
			!Array.isArray(row.next) || !row.next.every(validNonblank) ||
			!(row.minutes === null || finiteNonnegative(row.minutes)) ||
			!(row.tokens === null || finiteNonnegative(row.tokens))) return null;
	} else if (!isLessonClass(row.class) || !validNonblank(row.evidence)) {
		return null;
	}
	return row as unknown as LessonEntry;
}

function readRegularFile(path: string): Buffer {
	const fd = openSync(path, OPEN_READ);
	try {
		if (!fstatSync(fd).isFile()) throw new Error("LESSONS_LOG_UNSAFE");
		return readFileSync(fd);
	} finally {
		closeSync(fd);
	}
}

export function lessonIdentity(repoRoot: string, env: Record<string, string | undefined> = process.env): LessonIdentity {
	return {
		repo: basename(resolve(repoRoot)),
		agent: env.AGENT_NAME?.trim() || env.OMP_AGENT_NAME?.trim() || null,
		pane: env.TMUX_PANE?.trim() || null,
		model: env.OMP_MODEL?.trim() || env.PI_MODEL?.trim() || null,
	};
}

export function latestCheckinAt(entries: readonly LessonEntry[], agent: string | null): string | null {
	if (!agent) return null;
	let latest: string | null = null;
	for (const entry of entries) {
		if (entry.kind === "CHECKIN" && entry.agent === agent && (latest === null || Date.parse(entry.ts) > Date.parse(latest))) latest = entry.ts;
	}
	return latest;
}

export function readLessonsLog(repoRoot: string): LessonsReadResult {
	const root = resolve(repoRoot);
	const path = join(root, LESSONS_RELATIVE_PATH);
	let bytes: Buffer;
	try {
		const info = lstatSync(path);
		if (!info.isFile() || info.isSymbolicLink()) {
			return { status: "INVALID", path, entries: [], invalid_lines: [{ line: 0, reason: "not a regular file", code: "LESSONS_LOG_UNSAFE" }] };
		}
		bytes = readRegularFile(path);
	} catch (error) {
		if (error instanceof Error && "code" in error && error.code === "ENOENT")
			return { status: "MISSING", path, entries: [], invalid_lines: [] };
		return { status: "INVALID", path, entries: [], invalid_lines: [{ line: 0, reason: "unreadable file", code: "LESSONS_LOG_UNREADABLE" }] };
	}
	const rawLines = bytes.toString("utf8").split("\n");
	if (rawLines.at(-1) === "") rawLines.pop();
	const entries: LessonEntry[] = [];
	const invalid_lines: LessonsReadResult["invalid_lines"] = [];
	for (const [index, line] of rawLines.entries()) {
		let parsed: unknown;
		try { parsed = JSON.parse(line); }
		catch {
			invalid_lines.push({ line: index + 1, reason: "invalid JSON", code: "LESSONS_LOG_INVALID_JSON" });
			continue;
		}
		const entry = parseLessonEntry(parsed);
		if (entry) { entries.push(entry); continue; }
		const negativeMissingEvidence = parsed !== null && typeof parsed === "object" && !Array.isArray(parsed) &&
			"kind" in parsed && parsed.kind === "NEGATIVE" && !("evidence" in parsed && validNonblank(parsed.evidence));
		const invalidSupersession = parsed !== null && typeof parsed === "object" && !Array.isArray(parsed) &&
			"superseded_by" in parsed && !validNonblank(parsed.superseded_by);
		invalid_lines.push({ line: index + 1,
			reason: invalidSupersession ? "superseded_by must be a non-empty string" :
				negativeMissingEvidence ? "negative lesson has no evidence" : "schema validation failed",
			code: invalidSupersession ? "LESSON_SUPERSEDED_BY_INVALID" :
				negativeMissingEvidence ? "NEGATIVE_EVIDENCE_MISSING" : "LESSONS_LOG_SCHEMA_INVALID" });
	}
	return { status: invalid_lines.length ? "INVALID" : "OK", path, entries, invalid_lines };
}

export interface LessonCurrencyRow {
	id: string;
	entry: LessonEntry;
}

export interface LessonCurrency {
	active: (LessonCurrencyRow & { entry: LessonEntry & { applies_to: LessonAppliesTo } })[];
	history: LessonCurrencyRow[];
	unresolved: (LessonCurrencyRow & { reason: string })[];
	anchor_notes: { target: string; verification: "FILE_EXISTS_ONLY"; note: string }[];
}

/** Record identity, not actor identity. Correction targets disambiguate audit rows; replacements and numeric telemetry do not. */
export function lessonRecordId(entry: LessonEntry): string {
	const fields = [
		"omp-kit.lesson/v1", entry.ts, entry.repo, entry.agent, entry.pane, entry.model,
		entry.kind, entry.class, entry.what, entry.evidence, entry.applies_to ?? null,
		entry.proposed_fix, entry.bead,
	];
	if (entry.kind === "CORRECTION") fields.push(entry.corrects ?? null);
	return "lesson_" + createHash("sha256").update(JSON.stringify(fields)).digest("hex");
}

function lessonDocumentPath(target: string): string | null {
	const hash = target.lastIndexOf("#");
	if (hash > 0 && target.slice(hash + 1).trim()) return target.slice(0, hash);
	const colon = target.lastIndexOf(":");
	if (colon <= 0) return null;
	const line = target.slice(colon + 1);
	if (!line || !Number.isSafeInteger(Number(line)) || Number(line) <= 0) return null;
	for (let index = 0; index < line.length; index++) {
		const code = line.charCodeAt(index);
		if (code < 48 || code > 57) return null;
	}
	return target.slice(0, colon);
}

function insideRoot(root: string, path: string): boolean {
	const local = relative(root, path);
	return local !== ".." && !local.startsWith(".." + sep) && !isAbsolute(local);
}

/** Existence only: neither heading names nor line contents are certified by this filesystem read. */
export function lessonDocumentAnchors(repoRoot: string, entries: readonly LessonEntry[]): ReadonlySet<string> {
	const found = new Set<string>();
	let root: string;
	try { root = realpathSync(repoRoot); } catch { return found; }
	for (const entry of entries) {
		if (!entry.superseded_by) continue;
		const target = entry.superseded_by.trim();
		if (found.has(target)) continue;
		const path = lessonDocumentPath(target);
		if (path === null || isAbsolute(path)) continue;
		const candidate = resolve(root, path);
		if (!insideRoot(root, candidate)) continue;
		try {
			const actual = realpathSync(candidate);
			if (insideRoot(root, actual) && lstatSync(actual).isFile()) found.add(target);
		} catch { /* Missing or inaccessible documents remain unresolved. */ }
	}
	return found;
}

function applicableLesson(entry: LessonEntry): entry is LessonEntry & { applies_to: LessonAppliesTo } {
	return entry.applies_to === "repo" || entry.applies_to === "fleet";
}

/** Pure, iterative functional-graph walk. Original rows remain intact; unresolved edges never become advice. */
export function resolveLessonCurrency(entries: readonly LessonEntry[], documentAnchors?: ReadonlySet<string>): LessonCurrency {
	type Resolution = { status: "active" | "history" } | { status: "unresolved"; reason: string };
	type Node = { row: LessonCurrencyRow; index: number; target?: string; error?: string };
	const result: LessonCurrency = { active: [], history: [], unresolved: [], anchor_notes: [] };
	const rows: { row: LessonCurrencyRow; index: number }[] = [];
	const nodes = new Map<string, Node>();
	const resolutions = new Map<string, Resolution>();
	const corrections = new Map<string, string>();
	const notedAnchors = new Set<string>();
	for (let index = 0; index < entries.length; index++) {
		const entry = entries[index]!;
		if (entry.kind === "CHECKIN") continue;
		const row = { id: lessonRecordId(entry), entry };
		rows.push({ row, index });
		if (entry.kind !== "CORRECTION") nodes.set(row.id, { row, index, target: entry.superseded_by?.trim() });
	}
	for (const { row, index } of rows) {
		if (row.entry.kind !== "CORRECTION") continue;
		const target = row.entry.corrects ? nodes.get(row.entry.corrects.trim()) : undefined;
		if (!target || target.index >= index) {
			resolutions.set(row.id, { status: "unresolved", reason: "CORRECTION_TARGET_NOT_EARLIER" });
			continue;
		}
		corrections.set(row.id, target.row.id);
		if (!applicableLesson(row.entry)) {
			resolutions.set(row.id, { status: "unresolved", reason: "LESSON_APPLICABILITY_MISSING" });
			target.error = "CORRECTION_APPLICABILITY_MISSING";
		} else if (!validNonblank(row.entry.superseded_by)) {
			resolutions.set(row.id, { status: "unresolved", reason: "CORRECTION_REPLACEMENT_MISSING" });
			target.error = "CORRECTION_REPLACEMENT_MISSING";
		} else {
			target.error = undefined;
			target.target = row.entry.superseded_by.trim();
		}
	}
	for (const start of nodes.keys()) {
		if (resolutions.has(start)) continue;
		const path: string[] = [];
		const visiting = new Set<string>();
		let current = start;
		let terminal: Resolution;
		for (;;) {
			const known = resolutions.get(current);
			if (known) { terminal = known; break; }
			if (visiting.has(current)) { terminal = { status: "unresolved", reason: "SUPERSESSION_CYCLE" }; break; }
			visiting.add(current);
			path.push(current);
			const node = nodes.get(current)!;
			if (node.error) {
				terminal = { status: "unresolved", reason: node.error };
			} else if (!applicableLesson(node.row.entry)) {
				terminal = { status: "unresolved", reason: "LESSON_APPLICABILITY_MISSING" };
			} else if (!node.target) {
				terminal = { status: "active" };
			} else if (lessonDocumentPath(node.target) !== null) {
				if (!documentAnchors?.has(node.target)) {
					terminal = { status: "unresolved", reason: "SUPERSESSION_DOCUMENT_MISSING" };
				} else {
					terminal = { status: "history" };
					if (!notedAnchors.has(node.target)) {
						notedAnchors.add(node.target);
						result.anchor_notes.push({ target: node.target, verification: "FILE_EXISTS_ONLY", note: "Line or anchor content is unverified." });
					}
				}
			} else if (!nodes.has(node.target)) {
				terminal = { status: "unresolved", reason: "SUPERSESSION_TARGET_MISSING" };
			} else {
				current = node.target;
				continue;
			}
			resolutions.set(current, terminal);
			break;
		}
		for (let index = path.length - 1; index >= 0; index--) {
			const id = path[index]!;
			const known = resolutions.get(id);
			if (known) { terminal = known; continue; }
			if (terminal.status !== "unresolved") terminal = { status: "history" };
			resolutions.set(id, terminal);
		}
	}
	for (const { row } of rows) {
		const resolution = resolutions.get(row.id) ?? resolutions.get(corrections.get(row.id) ?? "");
		if (!resolution || resolution.status === "unresolved") {
			result.unresolved.push({ ...row, reason: resolution?.reason ?? "CORRECTION_TARGET_NOT_EARLIER" });
		} else if (resolution.status === "history" || row.entry.kind === "CORRECTION") {
			result.history.push(row);
		} else if (applicableLesson(row.entry)) {
			result.active.push({ id: row.id, entry: row.entry });
		}
	}
	return result;
}

function lessonEntry(repoRoot: string, input: AddLessonInput, options: LessonEntryOptions): LessonEntry {
	if (!Object.prototype.hasOwnProperty.call(LESSON_KINDS, input.kind)) throw new Error("LESSON_KIND_INVALID");
	if (!isLessonClass(input.class)) throw new Error("LESSON_CLASS_INVALID");
	if (!validNonblank(input.what)) throw new Error("LESSON_WHAT_REQUIRED");
	if (!validNonblank(input.evidence)) throw new Error("LESSON_EVIDENCE_REQUIRED");
	if (input.applies_to !== undefined && input.applies_to !== "repo" && input.applies_to !== "fleet") throw new Error("LESSON_APPLIES_TO_INVALID");
	if (input.cost_minutes !== undefined && input.cost_minutes !== null && !finiteNonnegative(input.cost_minutes)) throw new Error("LESSON_COST_INVALID");
	if (input.superseded_by !== undefined && !validNonblank(input.superseded_by)) throw new Error("LESSON_SUPERSEDED_BY_INVALID");
	if (input.kind === "CORRECTION" ? !validNonblank(input.corrects) || !validNonblank(input.superseded_by) : input.corrects !== undefined) throw new Error("LESSON_CORRECTION_INVALID");
	const now = options.now ?? new Date();
	if (!Number.isFinite(now.getTime())) throw new Error("LESSON_TIMESTAMP_INVALID");
	const identity = options.identity ?? lessonIdentity(repoRoot);
	if (!validNonblank(identity.repo)) throw new Error("LESSON_REPO_INVALID");
	const entry: LessonEntry = {
		ts: now.toISOString(), repo: identity.repo, agent: identity.agent, pane: identity.pane, model: identity.model,
		kind: input.kind, class: input.class, what: input.what.trim(), evidence: input.evidence.trim(),
		cost_minutes: input.cost_minutes ?? null, applies_to: input.applies_to ?? "repo",
		proposed_fix: optionalLessonField(input.proposed_fix, "PROPOSED_FIX"), bead: optionalLessonField(input.bead, "BEAD"),
	};
	if (input.superseded_by !== undefined) entry.superseded_by = input.superseded_by.trim();
	if (input.corrects !== undefined) entry.corrects = input.corrects.trim();
	return entry;
}

function appendLessonText(repoRoot: string, text: string): void {
	const root = resolve(repoRoot);
	const rootInfo = lstatSync(root);
	if (!rootInfo.isDirectory() || rootInfo.isSymbolicLink()) throw new Error("LESSONS_REPO_UNSAFE");
	const directory = join(root, ".omp");
	try { mkdirSync(directory, { recursive: true, mode: 0o755 }); }
	catch { throw new Error("LESSONS_DIRECTORY_UNAVAILABLE"); }
	const directoryInfo = lstatSync(directory);
	if (!directoryInfo.isDirectory() || directoryInfo.isSymbolicLink()) throw new Error("LESSONS_DIRECTORY_UNSAFE");
	const path = join(root, LESSONS_RELATIVE_PATH);
	try {
		const existing = readRegularFile(path);
		if (existing.length > 0 && existing.at(-1) !== 0x0a) throw new Error("LESSONS_LOG_CORRUPT");
	} catch (error) {
		if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
	}
	const fd = openSync(path, OPEN_APPEND, 0o644);
	try {
		const bytes = Buffer.from(text, "utf8");
		let offset = 0;
		while (offset < bytes.length) {
			const written = writeSync(fd, bytes, offset, bytes.length - offset);
			if (written <= 0) throw new Error("LESSONS_APPEND_FAILED");
			offset += written;
		}
		fsyncSync(fd);
	} finally {
		closeSync(fd);
	}
}

function appendEntry(repoRoot: string, entry: LessonEntry): void {
	appendLessonText(repoRoot, JSON.stringify(entry) + "\n");
}

export function appendLesson(repoRoot: string, input: AddLessonInput, options: LessonEntryOptions = {}): LessonEntry {
	const entry = lessonEntry(repoRoot, input, options);
	appendEntry(repoRoot, entry);
	return entry;
}

function lessonCheckinEntry(repoRoot: string, input: CheckinInput, options: CheckinOptions): LessonEntry {
	const now = options.now ?? new Date();
	if (!Number.isFinite(now.getTime())) throw new Error("LESSON_TIMESTAMP_INVALID");
	const identity = options.identity ?? lessonIdentity(repoRoot);
	if (!validNonblank(identity.repo)) throw new Error("LESSON_REPO_INVALID");
	const previous = readLessonsLog(repoRoot);
	if (previous.status === "INVALID") throw new Error("LESSONS_LOG_INVALID");
	const previousCheckin = latestCheckinAt(previous.entries, identity.agent);
	const activity = options.activity ?? [];
	const done = input.done === undefined
		? [...activity]
			.filter(event => event.agent === identity.agent && Date.parse(event.ts) > (previousCheckin === null ? -Infinity : Date.parse(previousCheckin)))
			.sort((left, right) => Date.parse(left.ts) - Date.parse(right.ts) || left.id.localeCompare(right.id))
			.map(event => event.id)
		: [...input.done];
	const list = (name: string, value: readonly string[] | undefined): string[] => {
		const entries = value ?? [];
		if (!entries.every(validNonblank)) throw new Error(`CHECKIN_${name.toUpperCase()}_INVALID`);
		return [...new Set(entries.map(item => item.trim()))];
	};
	const blocked = list("blocked", input.blocked), next = list("next", input.next), doneItems = list("done", done);
	for (const [name, value] of [["minutes", input.minutes], ["tokens", input.tokens]] as const) {
		if (value !== undefined && value !== null && !finiteNonnegative(value)) throw new Error(`CHECKIN_${name.toUpperCase()}_INVALID`);
	}
	const evidence = doneItems.length ? doneItems.join(", ") : null;
	return {
		ts: now.toISOString(), repo: identity.repo, agent: identity.agent, pane: identity.pane, model: identity.model,
		kind: "CHECKIN", class: null,
		what: `Check-in recorded with ${doneItems.length} done, ${blocked.length} blocked, and ${next.length} next item(s).`,
		evidence, cost_minutes: null, applies_to: "repo", proposed_fix: null, bead: optionalLessonField(input.bead, "BEAD"),
		done: doneItems, blocked, next, minutes: input.minutes ?? null, tokens: input.tokens ?? null,
	};
}

export function writeCheckin(repoRoot: string, input: CheckinInput, options: CheckinOptions = {}): LessonEntry {
	const entry = lessonCheckinEntry(repoRoot, input, options);
	appendEntry(repoRoot, entry);
	return entry;
}

export interface LessonsCommitResult {
	base: string;
	commit: string;
}

interface LessonGitResult {
	code: number | null;
	stdout: Buffer;
	stderr: Buffer;
	error?: Error;
}

function runLessonGit(repoRoot: string, args: readonly string[]): LessonGitResult {
	const env = { ...process.env };
	delete env.GIT_DIR;
	delete env.GIT_WORK_TREE;
	delete env.GIT_COMMON_DIR;
	delete env.GIT_INDEX_FILE;
	env.GIT_TERMINAL_PROMPT = "0";
	const result = spawnSync("git", ["-C", repoRoot, ...args], {
		env, timeout: 30_000, maxBuffer: 16 * 1024 * 1024,
	});
	return { code: result.status, stdout: Buffer.from(result.stdout ?? []), stderr: Buffer.from(result.stderr ?? []), ...(result.error ? { error: result.error } : {}) };
}

function lessonGitText(repoRoot: string, args: readonly string[], failureCode: string): string {
	const result = runLessonGit(repoRoot, args);
	if (result.code !== 0 || result.error) throw new Error(failureCode);
	return result.stdout.toString("utf8").trim();
}

function validateBaseLessons(bytes: Buffer): void {
	if (bytes.length === 0) return;
	const text = bytes.toString("utf8");
	if (!Buffer.from(text, "utf8").equals(bytes) || bytes.at(-1) !== 0x0a) throw new Error("LESSONS_COMMIT_BASE_LOG_INVALID");
	const lines = text.slice(0, -1).split("\n");
	for (const line of lines) {
		let value: unknown;
		try { value = JSON.parse(line); }
		catch { throw new Error("LESSONS_COMMIT_BASE_LOG_INVALID"); }
		if (!parseLessonEntry(value)) throw new Error("LESSONS_COMMIT_BASE_LOG_INVALID");
	}
}

/** Append only to a clean lesson path, commit it on shared main, then fast-forward origin. */
export function commitLessonLines(repoRoot: string, lines: readonly string[], message = "LESSONS: append records [pending]"): LessonsCommitResult {
	const root = resolve(repoRoot);
	const rootInfo = lstatSync(root);
	if (!rootInfo.isDirectory() || rootInfo.isSymbolicLink()) throw new Error("LESSONS_REPO_UNSAFE");
	if (lines.length === 0 || !validNonblank(message)) throw new Error("LESSONS_COMMIT_INPUT_INVALID");
	let commitMessage = message;
	let hasBead = false;
	for (const line of lines) {
		if (!validNonblank(line) || /[\r\n]/.test(line)) throw new Error("LESSONS_COMMIT_LINES_INVALID");
		let parsed: unknown;
		try { parsed = JSON.parse(line); }
		catch { throw new Error("LESSONS_COMMIT_LINES_INVALID"); }
		const entry = parseLessonEntry(parsed);
		if (!entry || (entry.bead !== null && !validNonblank(entry.bead))) throw new Error("LESSONS_COMMIT_LINES_INVALID");
		if (entry.bead !== null) {
			commitMessage += "\n\nBead: " + entry.bead;
			hasBead = true;
		}
	}
	if (!hasBead) throw new Error("LESSONS_COMMIT_BEAD_REQUIRED");
	const top = lessonGitText(root, ["rev-parse", "--show-toplevel"], "LESSONS_COMMIT_REPOSITORY_INVALID");
	if (resolve(top) !== root) throw new Error("LESSONS_COMMIT_REPOSITORY_INVALID");
	const branch = lessonGitText(root, ["symbolic-ref", "--quiet", "--short", "HEAD"], "LESSONS_COMMIT_NOT_ON_MAIN");
	if (branch !== "main") throw new Error("LESSONS_COMMIT_NOT_ON_MAIN");
	const base = lessonGitText(root, ["rev-parse", "--verify", "HEAD^{commit}"], "LESSONS_COMMIT_BASE_INVALID");
	const treeListing = runLessonGit(root, ["ls-tree", "-z", base, "--", LESSONS_RELATIVE_PATH]);
	if (treeListing.code !== 0 || treeListing.error) throw new Error("LESSONS_COMMIT_BASE_LOG_INVALID");
	const records = treeListing.stdout.toString("utf8").split("\0").filter(Boolean);
	if (records.length > 1) throw new Error("LESSONS_COMMIT_BASE_LOG_INVALID");
	let baseBytes = Buffer.alloc(0);
	if (records.length === 1) {
		const record = records[0]!;
		const tab = record.indexOf("\t");
		const [mode, type, oid] = record.slice(0, tab).split(" ");
		if (tab < 0 || record.slice(tab + 1) !== LESSONS_RELATIVE_PATH || mode !== "100644" || type !== "blob" || !oid)
			throw new Error("LESSONS_COMMIT_BASE_LOG_INVALID");
		const blob = runLessonGit(root, ["cat-file", "blob", oid]);
		if (blob.code !== 0 || blob.error) throw new Error("LESSONS_COMMIT_BASE_LOG_INVALID");
		baseBytes = blob.stdout;
	}
	validateBaseLessons(baseBytes);
	let workingBytes: Buffer;
	try { workingBytes = readRegularFile(join(root, LESSONS_RELATIVE_PATH)); }
	catch (error) {
		if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
		workingBytes = Buffer.alloc(0);
	}
	const staged = runLessonGit(root, ["status", "--porcelain=v1", "-z", "--", LESSONS_RELATIVE_PATH]);
	if (staged.code !== 0 || staged.error || staged.stdout.length !== 0 || !workingBytes.equals(baseBytes))
		throw new Error("LESSONS_COMMIT_LOG_DIRTY: preserve the lesson path and resolve with its current reservation holder");
	const suffix = lines.join("\n") + "\n";
	const expected = Buffer.concat([baseBytes, Buffer.from(suffix, "utf8")]);
	appendLessonText(root, suffix);
	const stagedAgain = runLessonGit(root, ["diff", "--cached", "--quiet", "--", LESSONS_RELATIVE_PATH]);
	const modeChanges = runLessonGit(root, ["diff", "--summary", "--", LESSONS_RELATIVE_PATH]);
	if (!readRegularFile(join(root, LESSONS_RELATIVE_PATH)).equals(expected) ||
		lessonGitText(root, ["rev-parse", "HEAD"], "LESSONS_COMMIT_BASE_INVALID") !== base ||
		lessonGitText(root, ["symbolic-ref", "--quiet", "--short", "HEAD"], "LESSONS_COMMIT_NOT_ON_MAIN") !== "main" ||
		stagedAgain.code !== 0 || stagedAgain.error || modeChanges.code !== 0 || modeChanges.error || modeChanges.stdout.length !== 0)
		throw new Error("LESSONS_COMMIT_STATE_CHANGED");
	if (records.length === 0) {
		const add = runLessonGit(root, ["add", "--", LESSONS_RELATIVE_PATH]);
		if (add.code !== 0 || add.error) throw new Error("LESSONS_COMMIT_INDEX_FAILED");
	}
	const saved = runLessonGit(root, ["commit", "--only", "-m", commitMessage, "--", LESSONS_RELATIVE_PATH]);
	if (saved.code !== 0 || saved.error) throw new Error("LESSONS_COMMIT_SAVE_REFUSED: the appended rows remain local");
	const commit = lessonGitText(root, ["rev-parse", "HEAD"], "LESSONS_COMMIT_OBJECT_FAILED");
	const changed = lessonGitText(root, ["diff-tree", "--no-commit-id", "--name-only", "-r", base, commit], "LESSONS_COMMIT_DIFF_INVALID");
	const committed = runLessonGit(root, ["show", commit + ":" + LESSONS_RELATIVE_PATH]);
	if (changed !== LESSONS_RELATIVE_PATH || committed.code !== 0 || committed.error || !committed.stdout.equals(expected))
		throw new Error("LESSONS_COMMIT_STATE_CHANGED: saved main is retained; publication refused");
	if (lessonGitText(root, ["symbolic-ref", "--quiet", "--short", "HEAD"], "LESSONS_COMMIT_NOT_ON_MAIN") !== "main" ||
		runLessonGit(root, ["merge-base", "--is-ancestor", commit, "refs/heads/main"]).code !== 0)
		throw new Error("LESSONS_COMMIT_STATE_CHANGED: lesson commit is not on shared main");
	const push = runLessonGit(root, ["push", "--porcelain", "origin", "main"]);
	if (push.code !== 0 || push.error) {
		const contention = push.stdout.toString("utf8").split("\n").some((line: string) =>
			line === "!\trefs/heads/main:refs/heads/main\t[rejected] (non-fast-forward)" ||
			line === "!\trefs/heads/main:refs/heads/main\t[rejected] (fetch first)");
		if (contention)
			throw new Error("LESSONS_COMMIT_CAS_REJECTED: saved on main; converge the shared checkout before publishing");
		const detail = (push.stderr.toString("utf8") + "\n" + push.stdout.toString("utf8")).toLowerCase();
		if (detail.includes("pre-push") || detail.includes("reservation conflict") || detail.includes("mcp-agent-mail") ||
			detail.includes("fresh-gate") || detail.includes("check-pushed-on-main"))
			throw new Error("LESSONS_COMMIT_PUSH_GUARD_REFUSED: saved on main; publication refused");
		throw new Error("LESSONS_COMMIT_PUSH_FAILED: saved on main; publication failed");
	}
	if (runLessonGit(root, ["merge-base", "--is-ancestor", commit, "refs/remotes/origin/main"]).code !== 0)
		throw new Error("LESSONS_COMMIT_PUSH_UNVERIFIED: remote-main ancestry was not established");
	return { base, commit };
}


export function appendLessonAndCommit(repoRoot: string, input: AddLessonInput, options: LessonEntryOptions = {}): { entry: LessonEntry; commit: LessonsCommitResult } {
	const entry = lessonEntry(repoRoot, input, options);
	const commit = commitLessonLines(repoRoot, [JSON.stringify(entry)], "LESSONS: add lesson [pending]");
	return { entry, commit };
}

export function writeCheckinAndCommit(repoRoot: string, input: CheckinInput, options: CheckinOptions = {}): { entry: LessonEntry; commit: LessonsCommitResult } {
	const entry = lessonCheckinEntry(repoRoot, input, options);
	const commit = commitLessonLines(repoRoot, [JSON.stringify(entry)], "LESSONS: record check-in [pending]");
	return { entry, commit };
}

export function collectCheckinActivity(
	repoRoot: string,
	trackerRoot: string | null,
	identity: LessonIdentity,
	since: string | null,
	options: ActivityCollectionOptions = {},
): ActivityCollection {
	const agent = identity.agent;
	if (!agent && !options.allAgents) return { status: "UNAVAILABLE", events: [], warnings: ["agent identity unavailable"] };
	const afterMs = since === null ? Number.NEGATIVE_INFINITY : Date.parse(since);
	if (!Number.isFinite(afterMs) && afterMs !== Number.NEGATIVE_INFINITY)
		return { status: "UNAVAILABLE", events: [], warnings: ["check-in cutoff timestamp is invalid"] };
	const run = options.run ?? ((args: readonly string[]): LessonCommandResult => {
		const program = args[0];
		if (!program) return { code: null, stdout: "", stderr: "empty command" };
		const result = spawnSync(program, args.slice(1), { encoding: "utf8", timeout: 15_000, maxBuffer: 16 * 1024 * 1024 });
		return { code: result.status, stdout: result.stdout ?? "", stderr: result.error?.message ?? result.stderr ?? "" };
	});
	const events: LessonActivity[] = [];
	const warnings: string[] = [];
	const gitArgs = ["git", "-C", resolve(repoRoot), "log", "--all", "--format=%H%x09%an%x09%cI"];
	if (since !== null) gitArgs.push("--since=" + since);
	const gitResult = run(gitArgs);
	if (gitResult.code !== 0) warnings.push("git activity unavailable");
	else {
		for (const line of gitResult.stdout.split("\n")) {
			const [id, author, ts] = line.split("\t", 3);
			const time = typeof ts === "string" ? Date.parse(ts) : Number.NaN;
			if (id && author && (options.allAgents || author === agent) && Number.isFinite(time) && time > afterMs)
				events.push({ kind: "commit", id, agent: author, ts: new Date(time).toISOString() });
		}
	}
	let trackerAvailable = false;
	if (trackerRoot !== null) {
		const trackerPath = resolve(trackerRoot);
		const database = trackerPath.endsWith(".db") ? trackerPath
			: basename(trackerPath) === ".beads" ? join(trackerPath, "beads.db") : join(trackerPath, ".beads", "beads.db");
		const global = ["--db", database, "--no-auto-import", "--no-auto-flush"];
		const listResult = run(["br", ...global, "list", "--status", "closed", "--all", "--format", "json"]);
		let issues: unknown[] | null = null;
		if (listResult.code === 0) {
			try {
				const parsed: unknown = JSON.parse(listResult.stdout);
				if (parsed !== null && typeof parsed === "object" && !Array.isArray(parsed) &&
					"issues" in parsed && Array.isArray(parsed.issues)) issues = parsed.issues;
			} catch { /* Report the source as unavailable below. */ }
		}
		if (issues === null) warnings.push("tracker issue list unavailable or invalid");
		else {
			trackerAvailable = true;
			const checked = new Set<string>();
			for (const value of issues) {
				if (value === null || typeof value !== "object" || Array.isArray(value)) continue;
				const issue = value as Record<string, unknown>;
				if (typeof issue.id !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(issue.id) ||
					typeof issue.closed_at !== "string") continue;
				const id = issue.id;
				const closedAt = Date.parse(issue.closed_at);
				if (!Number.isFinite(closedAt) || closedAt <= afterMs || checked.has(id)) continue;
				checked.add(id);
				const audit = run(["br", ...global, "audit", "log", id, "--json"]);
				if (audit.code !== 0) { warnings.push("tracker close audit unavailable for " + id); continue; }
				try {
					const parsed: unknown = JSON.parse(audit.stdout);
					if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed) || !("events" in parsed) || !Array.isArray(parsed.events)) {
						warnings.push("tracker close audit invalid for " + id);
						continue;
					}
					for (const event of parsed.events) {
						if (event === null || typeof event !== "object" || Array.isArray(event)) continue;
						const row = event as Record<string, unknown>;
						const eventTime = typeof row.timestamp === "string" ? Date.parse(row.timestamp) : Number.NaN;
						const actor = typeof row.actor === "string" ? row.actor : "";
						if (row.event_type === "closed" && actor && (options.allAgents || actor === agent) && Number.isFinite(eventTime) && eventTime > afterMs)
							events.push({ kind: "close", id, agent: actor, ts: new Date(eventTime).toISOString() });
					}
				} catch { warnings.push("tracker close audit invalid for " + id); }
			}
		}
	} else warnings.push("tracker path is not configured");
	events.sort((left, right) => Date.parse(left.ts) - Date.parse(right.ts) || left.id.localeCompare(right.id));
	const gitAvailable = gitResult.code === 0;
	const status = gitAvailable && trackerAvailable && warnings.length === 0 ? "OK"
		: gitAvailable || trackerAvailable ? "PARTIAL" : "UNAVAILABLE";
	return { status, events, warnings };
}

export function inspectLessons(repoRoot: string, options: LessonsDoctorOptions): LessonsDoctorReport {
	const now = options.now ?? new Date();
	const log = readLessonsLog(repoRoot);
	const findings: LessonsDoctorFinding[] = [];
	if (!Number.isFinite(now.getTime()) || !Number.isFinite(options.intervalMs) || options.intervalMs <= 0) {
		return { overall: "UNVERIFIED", log_status: log.status, log_path: log.path, activity_status: "UNAVAILABLE",
			findings: [{ code: "LESSONS_DOCTOR_CONFIG_INVALID", status: "UNVERIFIED", message: "A valid check-in interval and current time are required." }],
			agents: [], close_followup: { closed: null, followed_by_checkin: null, share: null } };
	}
	if (log.status === "MISSING") findings.push({ code: "LESSONS_LOG_MISSING", status: "UNVERIFIED", message: "No .omp/lessons.jsonl log exists in this repository." });
	for (const row of log.invalid_lines) findings.push({
		code: row.code ?? "LESSONS_LOG_INVALID", status: "FAIL",
		message: row.reason, line: row.line,
	});
	let collection: ActivityCollection;
	if (options.activity !== undefined) collection = { status: "OK", events: [...options.activity], warnings: [] };
	else {
		const identity = options.identity ?? lessonIdentity(repoRoot);
		collection = collectCheckinActivity(repoRoot, options.trackerRoot ?? null, { ...identity, agent: null }, null,
			{ ...(options.run ? { run: options.run } : {}), allAgents: true });
	}
	if (collection.status !== "OK") findings.push({ code: "ACTIVITY_SOURCE_UNAVAILABLE", status: "UNVERIFIED",
		message: collection.warnings.join("; ") || "Git or tracker activity could not be fully read." });
	const lastCheckinByAgent = new Map<string, LessonEntry>();
	for (const entry of log.entries) if (entry.kind === "CHECKIN" && entry.agent) {
		const prior = lastCheckinByAgent.get(entry.agent);
		if (!prior || Date.parse(entry.ts) > Date.parse(prior.ts)) lastCheckinByAgent.set(entry.agent, entry);
	}
	const activityByAgent = new Map<string, LessonActivity[]>();
	for (const event of collection.events) {
		const rows = activityByAgent.get(event.agent) ?? [];
		rows.push(event);
		activityByAgent.set(event.agent, rows);
	}
	const agents: LessonsDoctorReport["agents"] = [];
	for (const [agent, events] of activityByAgent) {
		const lastCheckin = lastCheckinByAgent.get(agent)?.ts ?? null;
		const uncovered = events.filter(event => lastCheckin === null || Date.parse(event.ts) > Date.parse(lastCheckin));
		const latestActivity = events.reduce((latest, event) => Date.parse(event.ts) > Date.parse(latest) ? event.ts : latest, events[0]!.ts);
		const oldestUncovered = uncovered.reduce<string | null>((oldest, event) => oldest === null || Date.parse(event.ts) < Date.parse(oldest) ? event.ts : oldest, null);
		const overdueMinutes = oldestUncovered === null ? null : Math.floor((now.getTime() - Date.parse(oldestUncovered)) / 60_000);
		const overdue = overdueMinutes !== null && overdueMinutes * 60_000 > options.intervalMs;
		agents.push({ agent, last_checkin_at: lastCheckin, last_activity_at: latestActivity, overdue, overdue_minutes: overdue ? overdueMinutes : null });
		if (overdue) findings.push({ code: "CHECKIN_OVERDUE", status: "FAIL",
			message: "Agent has commit or close activity without a check-in within the configured interval.", agent });
	}
	const closes = collection.events.filter(event => event.kind === "close");
	const followed = closes.filter(close => log.entries.some(entry => entry.kind === "CHECKIN" && entry.agent === close.agent &&
		Date.parse(entry.ts) > Date.parse(close.ts) && (entry.done ?? []).includes(close.id))).length;
	const close_followup = collection.status === "OK"
		? { closed: closes.length, followed_by_checkin: followed, share: closes.length ? followed / closes.length : null }
		: { closed: null, followed_by_checkin: null, share: null };
	const hasFailure = findings.some(finding => finding.status === "FAIL");
	const hasUnknown = findings.some(finding => finding.status === "UNVERIFIED");
	return { overall: hasFailure ? "FAIL" : hasUnknown ? "UNVERIFIED" : "OK", log_status: log.status,
		log_path: log.path, activity_status: collection.status, findings, agents, close_followup };
}
