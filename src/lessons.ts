import { randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import { constants, fstatSync, fsyncSync, lstatSync, mkdirSync, mkdtempSync, openSync, readFileSync, rmSync, writeSync, closeSync } from "node:fs";
import { basename, join, resolve } from "node:path";

export const LESSONS_RELATIVE_PATH = ".omp/lessons.jsonl";

export type LessonKind = "NEGATIVE" | "GAP" | "LESSON" | "CHECKIN";
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
	applies_to: LessonAppliesTo;
	proposed_fix: string | null;
	bead: string | null;
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
}

export interface CheckinInput {
	done?: readonly string[];
	blocked?: readonly string[];
	next?: readonly string[];
	minutes?: number | null;
	tokens?: number | null;
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

const LESSON_KINDS: Record<LessonKind, true> = { NEGATIVE: true, GAP: true, LESSON: true, CHECKIN: true };
const NOFOLLOW = constants.O_NOFOLLOW ?? 0;
const OPEN_READ = constants.O_RDONLY | NOFOLLOW;
const OPEN_APPEND = constants.O_WRONLY | constants.O_CREAT | constants.O_APPEND | NOFOLLOW;

function validNonblank(value: unknown): value is string {
	return typeof value === "string" && value.trim().length > 0 && !/[\r\n]/.test(value);
}

function validClass(value: unknown): value is LessonClass {
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
		!(row.applies_to === "repo" || row.applies_to === "fleet") ||
		!(row.proposed_fix === null || typeof row.proposed_fix === "string") ||
		!(row.bead === null || typeof row.bead === "string")) return null;
	if (row.kind === "CHECKIN") {
		if (row.class !== null || !Array.isArray(row.done) || !row.done.every(validNonblank) ||
			!Array.isArray(row.blocked) || !row.blocked.every(validNonblank) ||
			!Array.isArray(row.next) || !row.next.every(validNonblank) ||
			!(row.minutes === null || finiteNonnegative(row.minutes)) ||
			!(row.tokens === null || finiteNonnegative(row.tokens))) return null;
	} else if (!validClass(row.class) || !validNonblank(row.evidence)) {
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
		invalid_lines.push({ line: index + 1,
			reason: negativeMissingEvidence ? "negative lesson has no evidence" : "schema validation failed",
			code: negativeMissingEvidence ? "NEGATIVE_EVIDENCE_MISSING" : "LESSONS_LOG_SCHEMA_INVALID" });
	}
	return { status: invalid_lines.length ? "INVALID" : "OK", path, entries, invalid_lines };
}

function lessonEntry(repoRoot: string, input: AddLessonInput, options: LessonEntryOptions): LessonEntry {
	if (!Object.prototype.hasOwnProperty.call(LESSON_KINDS, input.kind)) throw new Error("LESSON_KIND_INVALID");
	if (!validClass(input.class)) throw new Error("LESSON_CLASS_INVALID");
	if (!validNonblank(input.what)) throw new Error("LESSON_WHAT_REQUIRED");
	if (!validNonblank(input.evidence)) throw new Error("LESSON_EVIDENCE_REQUIRED");
	if (input.applies_to !== undefined && input.applies_to !== "repo" && input.applies_to !== "fleet") throw new Error("LESSON_APPLIES_TO_INVALID");
	if (input.cost_minutes !== undefined && input.cost_minutes !== null && !finiteNonnegative(input.cost_minutes)) throw new Error("LESSON_COST_INVALID");
	for (const [name, value] of [["proposed_fix", input.proposed_fix], ["bead", input.bead]] as const) {
		if (value !== undefined && value !== null && !validNonblank(value)) throw new Error(`LESSON_${name.toUpperCase()}_INVALID`);
	}
	const now = options.now ?? new Date();
	if (!Number.isFinite(now.getTime())) throw new Error("LESSON_TIMESTAMP_INVALID");
	const identity = options.identity ?? lessonIdentity(repoRoot);
	if (!validNonblank(identity.repo)) throw new Error("LESSON_REPO_INVALID");
	return {
		ts: now.toISOString(), repo: identity.repo, agent: identity.agent, pane: identity.pane, model: identity.model,
		kind: input.kind, class: input.class, what: input.what.trim(), evidence: input.evidence.trim(),
		cost_minutes: input.cost_minutes ?? null, applies_to: input.applies_to ?? "repo",
		proposed_fix: input.proposed_fix?.trim() || null, bead: input.bead?.trim() || null,
	};
}

function appendEntry(repoRoot: string, entry: LessonEntry): void {
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
		const bytes = Buffer.from(JSON.stringify(entry) + "\n", "utf8");
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
		evidence, cost_minutes: null, applies_to: "repo", proposed_fix: null, bead: null,
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

function runLessonGit(repoRoot: string, args: readonly string[], extraEnv: Record<string, string> = {}, input?: Buffer): LessonGitResult {
	const env = { ...process.env };
	delete env.GIT_DIR;
	delete env.GIT_WORK_TREE;
	delete env.GIT_COMMON_DIR;
	delete env.GIT_INDEX_FILE;
	Object.assign(env, extraEnv);
	const result = spawnSync("git", ["-C", repoRoot, ...args], {
		env, input, timeout: 30_000, maxBuffer: 16 * 1024 * 1024,
	});
	return { code: result.status, stdout: Buffer.from(result.stdout ?? []), stderr: Buffer.from(result.stderr ?? []), ...(result.error ? { error: result.error } : {}) };
}

function lessonGitText(repoRoot: string, args: readonly string[], failureCode: string, extraEnv: Record<string, string> = {}): string {
	const result = runLessonGit(repoRoot, args, extraEnv);
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

/** Pushes only caller-provided JSONL rows, built from a private index based on fetched origin/main. */
export function commitLessonLines(repoRoot: string, lines: readonly string[], message = "LESSONS: append records"): LessonsCommitResult {
	const root = resolve(repoRoot);
	const rootInfo = lstatSync(root);
	if (!rootInfo.isDirectory() || rootInfo.isSymbolicLink()) throw new Error("LESSONS_REPO_UNSAFE");
	if (lines.length === 0 || !validNonblank(message)) throw new Error("LESSONS_COMMIT_INPUT_INVALID");
	for (const line of lines) {
		if (!validNonblank(line) || /[\r\n]/.test(line)) throw new Error("LESSONS_COMMIT_LINES_INVALID");
		let parsed: unknown;
		try { parsed = JSON.parse(line); }
		catch { throw new Error("LESSONS_COMMIT_LINES_INVALID"); }
		if (!parseLessonEntry(parsed)) throw new Error("LESSONS_COMMIT_LINES_INVALID");
	}
	const top = lessonGitText(root, ["rev-parse", "--show-toplevel"], "LESSONS_COMMIT_REPOSITORY_INVALID");
	if (resolve(top) !== root) throw new Error("LESSONS_COMMIT_REPOSITORY_INVALID");
	const commonDir = lessonGitText(root, ["rev-parse", "--git-common-dir"], "LESSONS_COMMIT_REPOSITORY_INVALID");
	const gitDir = resolve(root, commonDir);
	const id = randomUUID();
	const baseRef = "refs/omp-kit/lessons/base/" + id;
	const commitRef = "refs/omp-kit/lessons/commit/" + id;
	let privateDir: string | null = null;
	let baseRefCreated = false;
	let commitRefCreated = false;
	try {
		const fetch = runLessonGit(root, ["fetch", "--no-tags", "--no-write-fetch-head", "origin", "refs/heads/main:" + baseRef]);
		if (fetch.code !== 0 || fetch.error) throw new Error("LESSONS_COMMIT_FETCH_FAILED");
		baseRefCreated = true;
		const base = lessonGitText(root, ["rev-parse", "--verify", baseRef + "^{commit}"], "LESSONS_COMMIT_BASE_INVALID");
		if (!/^[a-f0-9]{40,64}$/i.test(base)) throw new Error("LESSONS_COMMIT_BASE_INVALID");
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
		const separator = baseBytes.length > 0 && baseBytes.at(-1) !== 0x0a ? "\n" : "";
		const suffix = Buffer.from(separator + lines.join("\n") + "\n", "utf8");
		const content = Buffer.concat([baseBytes, suffix]);
		privateDir = mkdtempSync(join(gitDir, "omp-kit-lessons-index-"));
		const indexPath = join(privateDir, "index");
		const indexEnv = { GIT_INDEX_FILE: indexPath };
		const readTree = runLessonGit(root, ["read-tree", base], indexEnv);
		if (readTree.code !== 0 || readTree.error) throw new Error("LESSONS_COMMIT_INDEX_FAILED");
		const blob = lessonGitTextFromResult(runLessonGit(root, ["hash-object", "-w", "--stdin"], {}, content), "LESSONS_COMMIT_BLOB_FAILED");
		const update = runLessonGit(root, ["update-index", "--add", "--cacheinfo", "100644", blob, LESSONS_RELATIVE_PATH], indexEnv);
		if (update.code !== 0 || update.error) throw new Error("LESSONS_COMMIT_INDEX_FAILED");
		const tree = lessonGitText(root, ["write-tree"], "LESSONS_COMMIT_INDEX_FAILED", indexEnv);
		const commit = lessonGitText(root, ["commit-tree", tree, "-p", base, "-m", message], "LESSONS_COMMIT_OBJECT_FAILED");
		const ref = runLessonGit(root, ["update-ref", commitRef, commit]);
		if (ref.code !== 0 || ref.error) throw new Error("LESSONS_COMMIT_OBJECT_FAILED");
		commitRefCreated = true;
		const changed = lessonGitText(root, ["diff-tree", "--no-commit-id", "--name-status", "-r", base, commit], "LESSONS_COMMIT_DIFF_INVALID");
		const changedRows = changed.split("\n").filter(Boolean);
		if (changedRows.length !== 1 || !/^[AM]\t\.omp\/lessons\.jsonl$/.test(changedRows[0] ?? "")) throw new Error("LESSONS_COMMIT_DIFF_INVALID");
		const stat = lessonGitText(root, ["show", "--stat", "--format=", "--first-parent", commit], "LESSONS_COMMIT_DIFF_INVALID");
		if (/\b[1-9]\d*\s+deletions?\b/.test(stat)) throw new Error("LESSONS_COMMIT_DIFF_INVALID");
		const push = runLessonGit(root, ["push", "--porcelain", "--force-with-lease=refs/heads/main:" + base,
			"origin", commitRef + ":refs/heads/main"]);
		if (push.code !== 0 || push.error) {
			const detail = (push.stderr.toString("utf8") + "\n" + push.stdout.toString("utf8")).toLowerCase();
			if (/stale info|non-fast-forward|fetch first|rejected.*main/.test(detail)) throw new Error("LESSONS_COMMIT_CAS_REJECTED");
			if (/pre-push|reservation conflict|mcp-agent-mail|fresh-gate/.test(detail)) throw new Error("LESSONS_COMMIT_PUSH_GUARD_REFUSED");
			throw new Error("LESSONS_COMMIT_PUSH_FAILED");
		}
		return { base, commit };
	} finally {
		if (commitRefCreated) runLessonGit(root, ["update-ref", "-d", commitRef]);
		if (baseRefCreated) runLessonGit(root, ["update-ref", "-d", baseRef]);
		if (privateDir !== null) {
			try { rmSync(privateDir, { recursive: true, force: true }); } catch { /* Keep a successful push successful; only this private scratch directory is affected. */ }
		}
	}
}

function lessonGitTextFromResult(result: LessonGitResult, failureCode: string): string {
	if (result.code !== 0 || result.error) throw new Error(failureCode);
	return result.stdout.toString("utf8").trim();
}

export function appendLessonAndCommit(repoRoot: string, input: AddLessonInput, options: LessonEntryOptions = {}): { entry: LessonEntry; commit: LessonsCommitResult } {
	const entry = appendLesson(repoRoot, input, options);
	const commit = commitLessonLines(repoRoot, [JSON.stringify(entry)], "LESSONS: add lesson");
	return { entry, commit };
}

export function writeCheckinAndCommit(repoRoot: string, input: CheckinInput, options: CheckinOptions = {}): { entry: LessonEntry; commit: LessonsCommitResult } {
	const entry = writeCheckin(repoRoot, input, options);
	const commit = commitLessonLines(repoRoot, [JSON.stringify(entry)], "LESSONS: record check-in");
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
