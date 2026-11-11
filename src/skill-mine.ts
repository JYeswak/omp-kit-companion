import { accessSync, appendFileSync, constants, createReadStream, existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, realpathSync, renameSync, statSync, writeFileSync } from "node:fs";
import { createInterface } from "node:readline";
import { createHash, randomBytes } from "node:crypto";
import { delimiter, dirname, join, resolve } from "node:path";
import { run } from "./kitlib/run.ts";
import { captureMineReplay } from "./mine-replay.ts";
import { scrubText } from "../extensions/secret-output-guard.ts";
// Read-only by default. Every external read is bounded (session caps, file

export const SKILL_MINE_VERSION = 1;
export const SKILL_MINE_SINCE_DEFAULT = "21d";
export const SKILL_MINE_MAX_NEW_DEFAULT = 3;
export const SKILL_MINE_SESSION_CAP = 2000;
export const SKILL_MINE_SESSIONS_PER_PROJECT_CAP = 200;
export const SKILL_MINE_MESSAGES_PER_SESSION_CAP = 2000;
export const SKILL_MINE_MAIL_FILES_CAP = 3000;
export const SKILL_MINE_MAIL_FILE_BYTES_CAP = 64 * 1024;
export const SKILL_MINE_MAIL_THREADS_CAP = 500;
export const SKILL_MINE_SKILLS_CAP = 2000;
export const SKILL_MINE_SKILL_FILE_BYTES_CAP = 8 * 1024;
export const SKILL_MINE_QUOTE_CHARS = 200;
export const SKILL_MINE_DEDUPE_OVERLAP = 0.35;
/** Sessions larger than this are sampled via `cass view` instead of a full export. */
export const SKILL_MINE_SESSION_BYTES_CAP = 8 * 1024 * 1024;
/** Export output cap: a capped session's JSON export stays under this. */
export const SKILL_MINE_EXPORT_BYTES_CAP = 12 * 1024 * 1024;
/** `cass sessions` page size; a full page triggers per-workspace merging. */
export const SKILL_MINE_SESSIONS_PAGE = 5000;
/** View-chunk sample points per oversize session and context lines per point. */
export const SKILL_MINE_VIEW_POINTS = 6;
export const SKILL_MINE_VIEW_CONTEXT = 60;
/** Steps in a procedure sequence; single command skeletons never rank alone. */
export const SKILL_MINE_SEQ_STEPS = 3;
/** Verbatim procedure text blocks cluster only in this normalized length band. */
export const SKILL_MINE_TEXT_MIN = 32;
export const SKILL_MINE_TEXT_MAX = 400;
/** Kit/tool verbs are infrastructure: dropped from procedure signatures. */
export const INFRA_HEAD_RE = /^(omp-kit|br|am|ovnfs|cass|python3|cat|sed|rg)\b|^git (status|diff|log|show)\b/;
/** Default wall budget for the session-mining pass, in seconds. */
export const SKILL_MINE_WALL_BUDGET_S = 600;
/** Trailing calendar months of Git history considered per repository (oldest first). */
export const SKILL_MINE_GIT_MONTHS = 12;
/** Output cap for one `git log` window; an over-cap window splits instead of truncating. */
export const SKILL_MINE_GIT_LOG_BYTES_CAP = 1024 * 1024;
/** Persisted admitted chains kept per repository; oldest beyond this are evicted. */
export const SKILL_MINE_GIT_CHAINS_PER_REPO = 2000;
/** Deadline for one git plumbing call. */
export const SKILL_MINE_GIT_DEADLINE_S = 30;
/** Paths named per chain evidence entry; the rest collapse into a count. */
export const SKILL_MINE_GIT_MAX_PATHS = 3;
/** `Revert "original subject"` (git's default revert message); the body names the reverted sha. */
const GIT_REVERT_SUBJECT_RE = /^revert\s+"([^"]{1,200})"/i;
/** `This reverts commit <sha>.` trailer git writes into a revert body. */
const GIT_REVERT_BODY_RE = /^[ \t]*this reverts commit ([0-9a-f]{7,40})\b/im;
/** Conventional-commit revert (`revert(scope): …` / `revert: …`); the reverted sha comes from the body. */
const GIT_CONV_REVERT_RE = /^revert(?:\([^()\n]{0,80}\))?!?:/i;
/** `Revert: <sha>` trailer some conventional-commit repos use. */
const GIT_REVERT_TRAILER_RE = /^[ \t]*revert:[ \t]*([0-9a-f]{7,40})\b/im;
/** Any sha mention in a commit body (short-7 or full). */
const GIT_BODY_SHA_RE = /\b([0-9a-f]{7,40})\b/;
/** A commit message that claims to repair something. */
const GIT_FIX_RE = /\bfix(?:ed|es|ing)?\b|\brepair(?:ed|s)?\b|\bpatch(?:ed|es|ing)?\b|\bhotfix\b/i;
/** A commit message that admits something broke. */
const GIT_BREAK_RE = /\bbreak(?:s|ing)?\b|\bbroke[ns]?\b|\bbroken\b|\bfail(?:ed|ure|s)?\b|\bregress(?:ion|ed)?\b|\bbug\b|\bdefect\b/i;
/** A replacement commit that re-lands reverted work. */
const GIT_RELAND_RE = /\bre-?land\b|\bre-?apply\b|\bre-?introduc|\bre-?do\b/i;
/** Conventional-commit scope (`fix(scope): …`); the recurrence shape when present. */
const GIT_SCOPE_RE = /^[a-z]+(?:\(([^()\n]{1,80})\))?!?:/i;
/** Subjects that are never a failing endpoint: chores, docs, releases, version bumps. */
const GIT_ROUTINE_SUBJECT_RE = /^(?:chore|docs|release)(?:\(|:|\s)|\bversion bump\b|\bbump (?:the )?version\b|^v?\d+\.\d+(?:\.\d+)?\b/i;
/** Persisted cursor month keys look like 2026-10. */
const GIT_MONTH_RE = /^\d{4}-(?:0[1-9]|1[0-2])$/;
/** A parsed log header line starts with a full 40-hex sha. */
const GIT_SHA40_RE = /^[0-9a-f]{40}$/;
export type SkillMineSourceStatus = "OK" | "UNAVAILABLE";

export interface SkillMineSourceReport {
	status: SkillMineSourceStatus;
	reason: string;
	sessions?: number;
	messages?: number;
	threads?: number;
	files?: number;
	skills?: number;
	repos?: number;
	commits?: number;
	months_mined?: number;
}

/** Per-repository Git cursor row: which months are mined and the last error, if any. */
export interface SkillMineGitRepoCoverage {
	months_mined: string[];
	months_remaining: number;
	last_error: string | null;
}

/** Git-source coverage: per-repository month cursors plus this run's drop accounting. */
export interface SkillMineGitCoverage {
	repos: number;
	/** Month keys (YYYY-MM) mined by this run, across all repositories. */
	months_mined: string[];
	months_remaining: number;
	commits_seen: number;
	/** Chains admitted this run (named-sha, revert pair, or break-word-follows). */
	chains: number;
	/** Admitted chains known across all mined months (the persisted cluster input). */
	chains_seen: number;
	/** Known chains in clusters that do not qualify as candidates yet. */
	chains_unclustered: number;
	/** Persisted chains evicted by the per-repository cap this run. */
	chains_evicted: number;
	dropped_not_a_repo: number;
	dropped_credentials: number;
	dropped_errors: number;
	not_reached: number;
	stopped_early: boolean;
	repos_detail: Record<string, SkillMineGitRepoCoverage>;
}

/**
 * One admitted failure -> correction -> outcome chain. `kind` is revert (a
 * revert pair), named (the fix names the failing sha), or weak
 * (break-word-follows, which counts only toward cross-repository clusters).
 * For revert chains the fix slot holds the outcome (replacement, else the
 * revert itself) and referrer holds the reverted commit.
 */
export interface SkillMineGitChain {
	repo: string;
	month: string;
	kind: "revert" | "named" | "weak";
	fixSha: string;
	fixSubject: string;
	fixDateMs: number;
	failSha: string;
	failSubject: string;
	referrerSha: string | null;
	referrerSubject: string | null;
	paths: string[];
}

/** Persisted Git state: month cursors per canonical repository plus admitted chains. */
export interface SkillMineGitState {
	repos: Record<string, { months_mined: string[]; last_error: string | null }>;
	chains: SkillMineGitChain[];
}

export interface SkillMineEvidence {
	source: "cass" | "mail" | "git";
	ref: string;
	quote: string;
}

export interface SkillMineCandidate {
	workflow: string;
	/** Evidence packet for judgement (`git-recurrence`) or a fileable procedure; git packets never auto-file. */
	kind?: string;
	summary: string;
	projects: string[];
	occurrences: number;
	why_skill: string;
	evidence: SkillMineEvidence[];
	nearest_existing_skill: string | null;
	fingerprint: string;
	score: number;
	first_seen: string;
	/** Month keys (YYYY-MM) the evidence spans; set by the Git recurrence source. */
	months?: string[];
}

export interface SkillMineReject {
	workflow: string;
	covering_skill: string;
	overlap: number;
	score: number;
}

export interface SkillMineBeadFiled {
	candidate: string;
	fingerprint: string;
	project: string;
	bead: string;
}

export interface SkillMineCoverage {
	sessions_in_window: number;
	sessions_seen: number;
	sessions_mined: number;
	skipped_oversize: number;
	project_filtered: number;
	no_path: number;
	advisor_sidecar: number;
	per_project_cap: number;
	session_cap: number;
	not_reached: number;
	stopped_early: boolean;
	list_truncated: boolean;
	projects: Record<string, number>;
	git: SkillMineGitCoverage;
}

/** Empty per-run Git coverage: zero repositories resolved, nothing mined. */
export function emptySkillMineGitCoverage(): SkillMineGitCoverage {
	return {
		repos: 0, months_mined: [], months_remaining: 0, commits_seen: 0, chains: 0,
		chains_seen: 0, chains_unclustered: 0, chains_evicted: 0,
		dropped_not_a_repo: 0, dropped_credentials: 0, dropped_errors: 0, not_reached: 0,
		stopped_early: false, repos_detail: {},
	};
}

export interface SkillMineReport {
	overall: "OK" | "UNVERIFIED";
	sources: { cass: SkillMineSourceReport; mail: SkillMineSourceReport; git: SkillMineSourceReport };
	coverage: SkillMineCoverage;
	pack: string;
	candidates: SkillMineCandidate[];
	rejects: SkillMineReject[];
	projects_with_candidates: number;
	beads_filed: SkillMineBeadFiled[];
	unfiled: { candidate: string; reason: string }[];
	sink: string;
	elapsed_ms: number;
}

export interface SkillMineStatusReport {
	configured: boolean;
	last_run: string | null;
	sources: { cass: SkillMineSourceReport; mail: SkillMineSourceReport; git: SkillMineSourceReport } | null;
	candidates_total: number;
	projects_with_candidates: number;
	beads_filed: string[];
	git: {
		repos: number;
		months_mined: number;
		months_remaining: number;
		repos_detail: Record<string, SkillMineGitRepoCoverage>;
		chains_seen: number;
		chains_unclustered: number;
		chains_evicted: number;
	} | null;
}

export interface SkillMineOptions {
	since?: string;
	projects?: string[];
	skillsDirs?: string[];
	mailArchive?: string;
	sink?: string;
	maxNew?: number;
	wallBudgetS?: number;
	/** Test-only seam: lower the pick caps for SKILLMINE3 fixtures without touching the module constants. */
	sessionCap?: number;
	perProjectCap?: number;
	/** Test-only seam: cap Git months mined per repository per run (SKILLMINEGIT1-cursor). */
	gitMonthsPerRun?: number;
	/** Test-only seam: byte cap for one `git log` call (default SKILL_MINE_GIT_LOG_BYTES_CAP). */
	gitLogBytesCap?: number;
	/** Test-only seam: refuse over-cap month windows instead of splitting them. */
	gitNoSplit?: boolean;
	apply?: boolean;
	home: string;
	pathValue: string;
	cwd: string;
	stateDir: string;
	now?: number;
}

interface Observation {
	kind: "sequence" | "text-block" | "correction" | "fix-arc" | "mail-thread" | "git-chain";
	signature: string;
	workflow: string;
	summary: string;
	firstUser?: boolean;
	project: string;
	session: string;
	ref: string;
	quote: string;
	recent: boolean;
}

const STOPWORDS = new Set("a,an,the,and,or,of,to,in,on,for,with,how,what,when,why,do,does,did,is,are,was,were,be,been,by,from,at,as,it,its,this,that,these,those,you,your,we,our,they,their,i,me,my,please,thanks,thank,again,just,like,get,got,use,using,used,into,over,under,via,can,could,should,would,there,here,which,who,whom,having,has,have,had,will,shall,may,might,must,not,no,yes,if,then,else,when,where,while,about,above,after,before,between,during,throughout,within,without,all,any,both,each,few,more,most,other,some,such,only,own,same,so,than,too,very,s,t,don,now".split(","));

// Every pattern below runs on message text truncated to MESSAGE_TEXT_CAP chars
// (see observationsFromSession), so no match can scan an unbounded buffer.
export const MESSAGE_TEXT_CAP = 8000;
const CORRECTION_RE = /\b(no,|i told you|again\?|stop\b|why did you|don't\b|do not\b|that's wrong|that is wrong|you keep|not what i|wrong (file|branch|command|directory|repo)|please (stop|don't)|incorrect|mistake)\b/i;
const NEVER_AGAIN_RE = /never\b[\s\S]{0,200}?\bagain\b/i;

const FAIL_RE = /(exit (code )?([1-9][0-9]*)|rc=[1-9]\b|failed|failure|error:|traceback|command not found|no such file|ENOENT|panic:|timed out|timeout)/i;
const SUCCESS_RE = /(exit (code )?0\b|rc=0\b|ok\b|success|passed|done\b|created|updated|landed)/i;

function textOf(value: unknown, depth = 0): string {
	if (typeof value === "string") return value;
	if (depth > 3 || value === null || value === undefined) return "";
	if (Array.isArray(value)) return value.map(item => textOf(item, depth + 1)).filter(Boolean).join("\n");
	if (typeof value === "object") {
		const record = value as Record<string, unknown>;
		const parts: string[] = [];
		for (const key of ["text", "content", "body", "output", "result", "message", "command", "cmd"]) {
			if (record[key] !== undefined) {
				const part = textOf(record[key], depth + 1);
				if (part) parts.push(part);
			}
		}
		const calls = record["tool_calls"];
		if (Array.isArray(calls)) {
			for (const call of calls) {
				if (call !== null && typeof call === "object") {
					const callRecord = call as Record<string, unknown>;
					const name = typeof callRecord["name"] === "string" ? callRecord["name"] : "";
					const args = callRecord["arguments"] ?? callRecord["args"] ?? callRecord["input"];
					parts.push(`tool:${name} ${typeof args === "string" ? args : JSON.stringify(args ?? "")}`.trim());
				}
			}
		}
		// Live OMP exports embed calls as content items: {type:"toolCall", name, arguments}.
		if (typeof record["type"] === "string" && /tool.?call|function/i.test(record["type"])) {
			const name = typeof record["name"] === "string" ? record["name"]
				: typeof record["toolName"] === "string" ? record["toolName"] : "";
			const args = record["arguments"] ?? record["args"] ?? record["input"] ?? record["command"];
			parts.push(`tool:${name} ${typeof args === "string" ? args : textOf(args, depth + 1)}`.trim());
		}
		return parts.join("\n");
	}
	return "";
}

function roleOf(message: unknown): "user" | "assistant" | "tool" | "unknown" {
	if (message === null || typeof message !== "object" || Array.isArray(message)) return "unknown";
	const record = message as Record<string, unknown>;
	// SKILLMINE2: an OMP `custom_message` (kit upgrade notice, goal-continuation steer, injected prompt) is written by
	// the harness or the kit, whatever role a viewer later gives it; only a typed message is a human or agent turn.
	if (record["type"] === "custom_message") return "unknown";
	for (const key of ["role", "type", "kind", "author"]) {
		const value = record[key];
		if (typeof value === "string" && (key !== "type" || !/^(message|text|thinking)$/i.test(value))) {
			const mapped = mapRole(value);
			if (mapped !== "unknown") return mapped;
		}
	}
	// Live OMP exports wrap the turn: {type:"message", message:{role:"user"|"assistant"|"toolResult"}}.
	const inner = record["message"];
	if (inner !== null && typeof inner === "object" && !Array.isArray(inner)) {
		const innerRole = (inner as Record<string, unknown>)["role"];
		if (typeof innerRole === "string") {
			const mapped = mapRole(innerRole);
			if (mapped !== "unknown") return mapped;
		}
	}
	if (record["tool_calls"] !== undefined || record["tool_call_id"] !== undefined || record["toolCallId"] !== undefined) return "tool";
	return "unknown";
}

function mapRole(value: string): "user" | "assistant" | "tool" | "unknown" {
	const lower = value.toLowerCase();
	if (lower.includes("user") || lower.includes("human")) return "user";
	if (lower.includes("assistant") || lower.includes("agent") || lower.includes("model")) return "assistant";
	if (lower.includes("tool") || lower.includes("function") || lower.includes("observation") || lower.includes("result")) return "tool";
	return "unknown";
}

/** Normalize a shell command to a skeleton: paths, ids, numbers and quoted strings become slots. */
export function normalizeSkeleton(command: string): string {
	return command.trim().split("\n")[0]!
		.replace(/^[a-zA-Z0-9_.-]*[$#%>❯]\s*/, "")
		.replace(/"[^"]*"/g, " <q>")
		.replace(/'[^']*'/g, " <q>")
		.replace(/`[^`]*`/g, " <q>")
		.replace(/~?\/[\w.~-]+(?:\/[\w.~-]+)+/g, " <path>")
		.replace(/\b[a-f0-9]{7,64}\b/gi, " <id>")
		.replace(/\b\d[\w.-]*\b/g, " <n>")
		.replace(/\s+/g, " ")
		.trim()
		.split(" ")
		.slice(0, 6)
		.join(" ")
		.slice(0, 120);
}

export function tokensOf(text: string): string[] {
	return text.toLowerCase().replace(/[^a-z0-9]+/g, " ").split(" ").filter(token => token.length > 2 && !STOPWORDS.has(token));
}

export function fingerprintOf(workflow: string): string {
	return createHash("sha1").update(`skill-mine:v${SKILL_MINE_VERSION}:${workflow}`).digest("hex").slice(0, 16);
}

function slugOf(signature: string): string {
	return signature.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 48) || "recurring-procedure";
}

/** Redact a verbatim quote with the kit's secret screen and bound its length. */
export function redactedQuote(raw: string): string {
	const replay = captureMineReplay({ message: raw });
	const text = (replay.message ?? "").replace(/\s+/g, " ").trim();
	return text.slice(0, SKILL_MINE_QUOTE_CHARS);
}

function findOnPath(name: string, pathValue: string): string | null {
	for (const directory of pathValue.split(delimiter)) {
		if (!directory) continue;
		const candidate = join(directory, name);
		try {
			accessSync(candidate, constants.X_OK);
			if (lstatSync(candidate).isFile()) return candidate;
		} catch { /* not here */ }
	}
	return null;
}

export function parseSinceMs(since: string | undefined, now: number): number {
	const raw = (since ?? "").trim() || SKILL_MINE_SINCE_DEFAULT;
	const days = /^(\d+)d$/.exec(raw);
	if (days) return now - Number(days[1]) * 86_400_000;
	const absolute = Date.parse(raw);
	if (!Number.isNaN(absolute)) return absolute;
	throw new Error(`skill-mine: --since needs Nd (days) or an ISO date, got ${JSON.stringify(raw)}`);
}

function extractCommandStrings(text: string): string[] {
	const found: string[] = [];
	// Bare `$`/`%`/`❯` lines are pasted terminal output. `#` is a root prompt
	// but also a Markdown heading, and `>` a blockquote: live transcripts are
	// dominated by the prose readings, so neither is a command signal.
	for (const line of text.split("\n")) {
		const prompted = /^\s*[$%❯]\s+(\S.*)$/.exec(line);
		if (prompted?.[1]) found.push(prompted[1]);
	}
	// Fences default to prose (pasted liturgy, checklists): only $-prompt
	// lines inside a fence are commands, whatever the fence language.
	const fence = /```(?:sh|bash|shell|console)?\n([\s\S]*?)```/g;
	let match: RegExpExecArray | null;
	while ((match = fence.exec(text)) !== null) {
		for (const line of (match[1] ?? "").split("\n")) {
			const shell = /^\s*\$\s+(\S.*)$/.exec(line);
			if (shell?.[1]) found.push(shell[1]);
		}
	}
	return found;
}

/** Shell commands from structured tool calls, wherever they nest (fixture
 * `tool_calls` arrays and live OMP `toolCall` content items alike). The walk
 * is depth-bounded so a hostile transcript cannot blow the stack. */
function toolCommandStrings(message: unknown): string[] {
	const out: string[] = [];
	const visit = (value: unknown, depth: number): void => {
		if (depth > 4 || value === null || typeof value !== "object") return;
		if (Array.isArray(value)) {
			for (const item of value) visit(item, depth + 1);
			return;
		}
		const record = value as Record<string, unknown>;
		const kind = typeof record["type"] === "string" ? record["type"] : "";
		const name = typeof record["name"] === "string" ? record["name"]
			: typeof record["toolName"] === "string" ? record["toolName"] : "";
		const args = record["arguments"] ?? record["args"] ?? record["input"];
		const shellish = /tool.?call|function/i.test(kind) || (name !== "" && args !== undefined);
		if (shellish && name !== "" && /bash|exec|shell|command|run/i.test(name)) {
			const shape = commandOf(args);
			if (shape.trim()) out.push(shape.trim().split("\n")[0]!);
		}
		for (const child of Object.values(record)) visit(child, depth + 1);
	};
	visit(message, 0);
	return out;
}
/** Prefer a structured `command` argument; decode JSON-encoded argument strings. */
function commandOf(args: unknown): string {
	const direct = commandKey(args);
	if (direct !== null) return direct;
	if (typeof args === "string") {
		const trimmed = args.trim();
		if (trimmed.startsWith("{")) {
			try {
				const nested = commandKey(JSON.parse(trimmed) as unknown);
				if (nested !== null) return nested;
			} catch { /* fall through to the raw string */ }
		}
		return args;
	}
	return textOf(args);
}

function commandKey(value: unknown): string | null {
	if (value !== null && typeof value === "object" && !Array.isArray(value)
		&& "command" in value && typeof value.command === "string") return value.command;
	return null;
}

interface Step { skeleton: string; command: string; index: number }

/** Exported as a test seam: infrastructure verbs never form procedure signatures. */
export function isInfra(skeleton: string): boolean {
	return INFRA_HEAD_RE.test(skeleton);
}

/** Normalized distinctive-line key, or null when the line is not procedure text.
 * Commands, quotes, headings, bullets, numbered steps, JSON and tool: lines
 * are structural, not procedural wording; short lines are noise. */
export function textBlockKey(line: string): string | null {
	const collapsed = line.replace(/\s+/g, " ").trim();
	if (collapsed.length < SKILL_MINE_TEXT_MIN || collapsed.length > SKILL_MINE_TEXT_MAX) return null;
	if (!/[a-zA-Z]/.test(collapsed)) return null;
	if (/^[$%❯#> \-*[\]{`]|^\d+[.)]|^tool:/.test(collapsed)) return null;
	// Harness render furniture, not anyone's wording: tool-call echo lines (`→ read(...) ⇒ ok`), shell notices,
	// todo phase banners and injected skill file headers.
	if (/^→ |⇒ (?:ok|error)\b|^Ran in a (?:temporary|copy of)|^Active phase \d|^\[Skill file: |^### Session update\b/.test(collapsed)) return null;
	const key = collapsed.toLowerCase()
		.replace(/"[^"]*"/g, " <q>").replace(/'[^']*'/g, " <q>").replace(/`[^`]*`/g, " <q>")
		.replace(/~?\/[\w.~-]+(?:\/[\w.~-]+)+/g, " <path>")
		.replace(/\b[a-f0-9]{7,64}\b/gi, " <id>").replace(/\b\d[\w.-]*\b/g, " <n>");
	// Gate the masked key, not the raw line: a long line of pure quoted
	// strings, paths or ids would otherwise cluster under a stub key.
	if (key.length < 16) return null;
	if (key.split(" ").filter(token => /[a-z]{3,}/.test(token)).length < 2) return null;
	return key;
}

/** Tags the harness wraps around text it injects into a user turn (reminders, notices, file dumps, peer messages). */
const INJECTED_TAGS = ["system-reminder", "system-notice", "system-interrupt", "files", "irc", "memories", "task-result"];

/**
 * Remove harness-injected blocks (`<tag ...>…</tag>` for INJECTED_TAGS) from a message so only words a person or
 * agent wrote remain. A linear indexOf scan, not a backtracking regex: an unclosed tag drops the rest of the text.
 * Exported as a test seam.
 */
export function stripInjected(text: string): string {
	let out = "";
	let at = 0;
	for (;;) {
		let next = -1;
		let tag = "";
		for (const name of INJECTED_TAGS) {
			const found = text.indexOf(`<${name}`, at);
			const after = found < 0 ? "" : text.charAt(found + name.length + 1);
			if (found >= 0 && (after === ">" || after === " ") && (next < 0 || found < next)) { next = found; tag = name; }
		}
		if (next < 0) return out + text.slice(at);
		out += text.slice(at, next);
		const close = text.indexOf(`</${tag}>`, next);
		if (close < 0) return out;
		at = close + tag.length + 3;
	}
}

function observationsFromSession(project: string, sessionRef: string, messages: unknown[]): Observation[] {
	const observations: Observation[] = [];
	const bounded = messages.slice(0, SKILL_MINE_MESSAGES_PER_SESSION_CAP);
	// Injected skill/rule files are documentation the agent was shown, not work it did: they never become evidence.
	const texts = bounded.map(message => {
		const text = stripInjected(textOf(message).slice(0, MESSAGE_TEXT_CAP));
		return { role: roleOf(message), text: /^\s*\[(?:Skill|Rule) file: /.test(text) ? "" : text };
	});
	let previousAssistantAction = "";
	const firstUserIdx = texts.findIndex(row => row.role === "user");
	const steps: Step[] = [];
	const fails: { index: number; failed: string; text: string }[] = [];
	for (let index = 0; index < texts.length; index++) {
		const row = texts[index]!;
		// A session's first user message is its dispatch prompt (task, rules, template), not a correction of work done.
		if (row.role === "user" && index !== firstUserIdx && (CORRECTION_RE.test(row.text) || NEVER_AGAIN_RE.test(row.text))) {
			const complaint = row.text.replace(/\s+/g, " ").trim().slice(0, 160);
			const actionSkeleton = previousAssistantAction ? normalizeSkeleton(previousAssistantAction) : "";
			const signature = `correction:${normalizeSkeleton(complaint).split(" ").slice(0, 8).join(" ")}`;
			observations.push({
				kind: "correction", signature,
				workflow: slugOf(actionSkeleton ? `${actionSkeleton}-correction` : `correction-${complaint.slice(0, 40)}`),
				summary: actionSkeleton
					? `Users correct \`${actionSkeleton}\`; capture the constraint so the next run gets it right.`
					: "Users repeat the same correction; capture the constraint as a skill.",
				project, session: sessionRef, ref: `${sessionRef}#${index}`,
				quote: redactedQuote(`user: ${complaint}${actionSkeleton ? ` (after: ${actionSkeleton})` : ""}`),
				recent: true,
			});
		}
		if (row.role === "assistant" || row.role === "tool") {
			const commands = [...extractCommandStrings(row.text), ...toolCommandStrings(bounded[index])];
			for (const command of commands) {
				const skeleton = normalizeSkeleton(command);
				if (skeleton.length < 3) continue;
				previousAssistantAction = command;
				// Single skeletons never rank; they feed sequences and arcs below.
				steps.push({ skeleton, command, index });
			}
			if (FAIL_RE.test(row.text)) {
				const failed = [...extractCommandStrings(row.text), ...toolCommandStrings(bounded[index])].map(normalizeSkeleton)[0] ?? "";
				if (failed && !isInfra(failed)) fails.push({ index, failed, text: row.text });
			}
		}
		if (row.role === "user" || row.role === "assistant") {
			for (const line of row.text.split("\n")) {
				const key = textBlockKey(line);
				if (key === null) continue;
				observations.push({
					kind: "text-block", signature: `text:${key.slice(0, 200)}`,
					workflow: slugOf(key.split(" ").slice(0, 6).join(" ")),
					summary: "Recurring verbatim procedure text; bottle the wording and its follow-up steps.",
					project, session: sessionRef, ref: `${sessionRef}#${index}`,
					quote: redactedQuote(line.replace(/\s+/g, " ").trim()),
					firstUser: index === firstUserIdx,
					recent: true,
				});
			}
		}
	}
	// Ordered multi-step procedures over non-infra steps; infrastructure verbs
	// (kit CLIs, git plumbing, pagers) carry no procedure of their own.
	const runnable = steps.filter(step => !isInfra(step.skeleton));
	for (let start = 0; start + SKILL_MINE_SEQ_STEPS <= runnable.length; start++) {
		const window = runnable.slice(start, start + SKILL_MINE_SEQ_STEPS);
		// A retry loop (the same command re-run) is not a procedure: require at least two distinct steps.
		if (new Set(window.map(step => step.skeleton)).size < 2) continue;
		const first = window[0]!, last = window[window.length - 1]!;
		const signature = `seq:${window.map(step => step.skeleton).join(" > ")}`;
		observations.push({
			kind: "sequence", signature,
			workflow: slugOf(window.map(step => step.skeleton).join(" ")),
			summary: `Recurring ${SKILL_MINE_SEQ_STEPS}-step procedure: ${window.map(step => `\`${step.skeleton}\``).join(" → ")}; package the sequence, branches and checks.`,
			project, session: sessionRef, ref: `${sessionRef}#${first.index}-${last.index}`,
			quote: redactedQuote(window.map(step => step.command).join(" → ")),
			recent: true,
		});
	}
	for (const fail of fails) {
		const window = texts.slice(fail.index + 1, fail.index + 7);
		const fixed = window.find(w => SUCCESS_RE.test(w.text) || extractCommandStrings(w.text).length > 0);
		const fixCommands = fixed ? extractCommandStrings(fixed.text) : [];
		if (fixCommands.length === 0) continue;
		const fixSkeleton = normalizeSkeleton(fixCommands[0]!);
		if (isInfra(fixSkeleton)) continue;
		observations.push({
			kind: "fix-arc", signature: `fix:${fail.failed}->${fixSkeleton}`,
			workflow: slugOf(`recover-${fail.failed || fixSkeleton}`),
			summary: `Error->fix arc: \`${fail.failed || "a failing step"}\` resolved by \`${fixSkeleton}\`; bottle the diagnosis.`,
			project, session: sessionRef, ref: `${sessionRef}#${fail.index}`,
			quote: redactedQuote(`${fail.text.replace(/\s+/g, " ").trim().slice(0, 120)} => ${fixCommands[0]}`),
			recent: true,
		});
	}
	return observations;
}

interface CassSessionRow {
	source_path?: unknown;
	path?: unknown;
	workspace?: unknown;
	project?: unknown;
	updated_at?: unknown;
	size_bytes?: unknown;
	message_count?: unknown;
	started_at?: unknown;
}

function sessionProject(row: CassSessionRow, fallback: string): string {
	for (const key of ["workspace", "project"] as const) {
		const value = row[key];
		if (typeof value === "string" && value) return value;
	}
	return fallback;
}

async function runCass(cassBin: string, args: string[], options: SkillMineOptions, maxBytes: number): Promise<{ ok: boolean; stdout: string; reason: string }> {
	try {
		const result = await run([cassBin, ...args], {
			cwd: options.cwd, env: { HOME: options.home, PATH: options.pathValue },
			deadline_s: 30, max_output_bytes: maxBytes,
		});
		if (result.timed_out) return { ok: false, stdout: "", reason: "cass timed out after 30 s" };
		if (result.rc !== 0) return { ok: false, stdout: "", reason: `cass exited ${result.rc}: ${Buffer.from(result.stderr).toString("utf8").slice(0, 300)}` };
		return { ok: true, stdout: Buffer.from(result.stdout).toString("utf8"), reason: "" };
	} catch (error) {
		return { ok: false, stdout: "", reason: error instanceof Error ? error.message : String(error) };
	}
}

async function listSessions(cassBin: string, sinceISO: string, options: SkillMineOptions): Promise<{ rows: CassSessionRow[]; truncated: boolean }> {
	const first = await runCass(cassBin, ["sessions", "--since", sinceISO, "--json", "--limit", String(SKILL_MINE_SESSIONS_PAGE)], options, 4 * 1024 * 1024);
	if (!first.ok) throw new Error(first.reason);
	let rows: unknown;
	try {
		rows = JSON.parse(first.stdout);
	} catch {
		throw new Error("cass sessions printed unparseable JSON");
	}
	// Live 0.11.0 wraps the list: {sessions: [{path, workspace, ...}]}; older shapes print a bare array.
	const primary = (Array.isArray(rows) ? rows : sessionsOf(rows)) as CassSessionRow[];
	if (primary.length < SKILL_MINE_SESSIONS_PAGE) return { rows: primary, truncated: false };
	// Full page: list per workspace and merge, so projects beyond the page cap still count.
	const seen = new Map<string, CassSessionRow>();
	for (const row of primary) {
		const key = typeof row.source_path === "string" ? row.source_path : typeof row.path === "string" ? row.path : "";
		if (key && !seen.has(key)) seen.set(key, row);
	}
	const workspaces = [...new Set(primary.map(row => sessionProject(row, "")).filter(Boolean))];
	for (const workspace of workspaces) {
		const extra = await runCass(cassBin, ["sessions", "--since", sinceISO, "--json", "--limit", String(SKILL_MINE_SESSIONS_PAGE), "--workspace", workspace], options, 4 * 1024 * 1024);
		if (!extra.ok) continue;
		let parsed: unknown;
		try {
			parsed = JSON.parse(extra.stdout);
		} catch { continue; }
		const more = (Array.isArray(parsed) ? parsed : sessionsOf(parsed)) as CassSessionRow[];
		for (const row of more) {
			const key = typeof row.source_path === "string" ? row.source_path : typeof row.path === "string" ? row.path : "";
			if (key && !seen.has(key)) seen.set(key, row);
		}
	}
	return { rows: [...seen.values()], truncated: true };
}

/** Narrow a `cass view` payload to its message lines. */
function viewLinesOf(value: unknown): unknown[] {
	if (value !== null && typeof value === "object" && "lines" in value && Array.isArray(value.lines)) return value.lines;
	return [];
}

/** Sample an oversize session at evenly spaced message ordinals instead of dropping it. */
async function viewChunk(cassBin: string, path: string, count: number, options: SkillMineOptions): Promise<unknown[] | null> {
	const out: unknown[] = [];
	for (let point = 1; point <= SKILL_MINE_VIEW_POINTS; point++) {
		const index = Math.max(1, Math.round(count * point / (SKILL_MINE_VIEW_POINTS + 1)));
		const result = await runCass(cassBin, ["view", path, "--message-index", String(index), "-C", String(SKILL_MINE_VIEW_CONTEXT), "--json", "--timeout", "10000"], options, 4 * 1024 * 1024);
		if (!result.ok) return null;
		let parsed: unknown;
		try {
			parsed = JSON.parse(result.stdout);
		} catch { return null; }
		out.push(...viewLinesOf(parsed));
	}
	return out;
}

/**
 * SKILLMINE2: an oversize session still on disk is sampled from its own JSONL, at the same evenly spaced windows as
 * viewChunk, because its records keep their type: `cass view` lines carry only a role, so a kit notice or a
 * continuation steer reads there as a user turn. null when the file is not a readable local JSONL (archive-only).
 */
async function sampleLocalSession(path: string): Promise<unknown[] | null> {
	if (!path.endsWith(".jsonl") || !existsSync(path)) return null;
	const eachLine = async (visit: (line: string, index: number) => void): Promise<boolean> => {
		try {
			let index = 0;
			for await (const line of createInterface({ input: createReadStream(path), crlfDelay: Infinity })) visit(line, index++);
			return true;
		} catch { return false; }
	};
	let count = 0;
	if (!await eachLine(() => { count++; })) return null;
	const keep = new Set<number>();
	for (let point = 1; point <= SKILL_MINE_VIEW_POINTS; point++) {
		const center = Math.round(count * point / (SKILL_MINE_VIEW_POINTS + 1));
		for (let index = Math.max(0, center - SKILL_MINE_VIEW_CONTEXT); index <= Math.min(count - 1, center + SKILL_MINE_VIEW_CONTEXT); index++) keep.add(index);
	}
	const out: unknown[] = [];
	const read = await eachLine((line, index) => {
		if (!keep.has(index)) return;
		try { out.push(JSON.parse(line)); } catch { /* a torn or non-JSON line is not a record */ }
	});
	return read ? out : null;
}

async function mineCass(options: SkillMineOptions, sinceMs: number, deadlineMs: number): Promise<{ status: SkillMineSourceReport; observations: Observation[]; coverage: SkillMineCoverage; workspaces: string[] }> {
	const emptyCoverage = (extra: Partial<SkillMineCoverage> = {}): SkillMineCoverage => ({
		sessions_in_window: 0, sessions_seen: 0, sessions_mined: 0, skipped_oversize: 0,
		project_filtered: 0, no_path: 0, advisor_sidecar: 0, per_project_cap: 0, session_cap: 0, not_reached: 0,
		stopped_early: false, list_truncated: false, projects: {}, git: emptySkillMineGitCoverage(), ...extra,
	});
	const cassBin = findOnPath("cass", options.pathValue);
	if (cassBin === null) {
		return { status: { status: "UNAVAILABLE", reason: "cass is not on PATH; install cass or pass --project mail only" }, observations: [], coverage: emptyCoverage(), workspaces: [] };
	}
	const sinceISO = new Date(sinceMs).toISOString();
	let listed: { rows: CassSessionRow[]; truncated: boolean };
	try {
		listed = await listSessions(cassBin, sinceISO, options);
	} catch (error) {
		return { status: { status: "UNAVAILABLE", reason: error instanceof Error ? error.message : String(error) }, observations: [], coverage: emptyCoverage(), workspaces: [] };
	}
	const projects: Record<string, number> = {};
	for (const row of listed.rows) {
		const project = sessionProject(row, options.cwd);
		projects[project] = (projects[project] ?? 0) + 1;
	}
	const wanted = options.projects && options.projects.length > 0
		? listed.rows.filter(row => options.projects!.some(p => sessionProject(row, "").includes(p) || p.includes(sessionProject(row, ""))))
		: listed.rows;
	const sessionCap = options.sessionCap ?? SKILL_MINE_SESSION_CAP;
	const perProjectCap = options.perProjectCap ?? SKILL_MINE_SESSIONS_PER_PROJECT_CAP;
	const projectFiltered = listed.rows.length - wanted.length;
	let noPath = 0;
	let advisorSidecar = 0;
	let perProjectDropped = 0;
	let sessionCapDropped = 0;
	const perProject = new Map<string, number>();
	const picked: { project: string; path: string; size: number; count: number }[] = [];
	for (const row of wanted) {
		// The global cap takes precedence: every row past it counts as session_cap, whatever else fits.
		if (picked.length >= sessionCap) { sessionCapDropped++; continue; }
		const path = typeof row.source_path === "string" ? row.source_path : typeof row.path === "string" ? row.path : "";
		if (!path) { noPath++; continue; }
		// Advisor sidecars (`__advisor.<name>.jsonl`) replay their parent session's tool output and summaries;
		// mining them counts the same work twice and turns harness text into "recurring procedures".
		if (/(?:^|\/)__advisor\.[^/]*\.jsonl$/.test(path)) { advisorSidecar++; continue; }
		const project = sessionProject(row, options.cwd);
		const count = perProject.get(project) ?? 0;
		if (count >= perProjectCap) { perProjectDropped++; continue; }
		perProject.set(project, count + 1);
		picked.push({
			project, path,
			size: typeof row.size_bytes === "number" ? row.size_bytes : 0,
			count: typeof row.message_count === "number" ? row.message_count : 0,
		});
	}
	const observations: Observation[] = [];
	let messages = 0;
	let failures = 0;
	let skippedOversize = 0;
	let mined = 0;
	let stoppedEarly = false;
	for (const session of picked) {
		if (Date.now() > deadlineMs) { stoppedEarly = true; break; }
		let flat: unknown[] | null = null;
		if (session.size > SKILL_MINE_SESSION_BYTES_CAP) {
			flat = await sampleLocalSession(session.path);
			if (flat === null && session.count > 0) {
				flat = await viewChunk(cassBin, session.path, session.count, options);
			}
			if (flat === null) { skippedOversize++; continue; }
		} else {
			const exported = await runCass(cassBin, ["export", session.path, "--format", "json"], options, SKILL_MINE_EXPORT_BYTES_CAP);
			if (!exported.ok) { failures++; continue; }
			let parsed: unknown;
			try {
				parsed = JSON.parse(exported.stdout);
			} catch { failures++; continue; }
			const list = Array.isArray(parsed) ? parsed : messagesOf(parsed);
			flat = (Array.isArray(list) ? list : []).flatMap(item => Array.isArray(item) ? item : [item]);
		}
		messages += flat.length;
		mined++;
		observations.push(...observationsFromSession(session.project, session.path, flat));
	}
	const seen = mined + skippedOversize + failures;
	const notReached = picked.length - seen;
	const parts = [`mined ${mined} session(s)`,
		...(skippedOversize > 0 ? [`sampled/skipped ${skippedOversize} oversize`] : []),
		...(failures > 0 ? [`${failures} export(s) unreadable`] : []),
		...(projectFiltered > 0 ? [`${projectFiltered} filtered by project`] : []),
		...(noPath > 0 ? [`${noPath} without a session path`] : []),
		...(advisorSidecar > 0 ? [`${advisorSidecar} advisor sidecar(s)`] : []),
		...(perProjectDropped > 0 ? [`${perProjectDropped} over the per-project cap`] : []),
		...(sessionCapDropped > 0 ? [`${sessionCapDropped} over the session cap`] : []),
		...(notReached > 0 ? [`${notReached} picked but never visited (wall budget)`] : []),
		...(stoppedEarly ? ["wall budget reached"] : [])];
	const reason = parts.join("; ");
	const coverage: SkillMineCoverage = {
		sessions_in_window: listed.rows.length, sessions_seen: seen, sessions_mined: mined,
		skipped_oversize: skippedOversize, project_filtered: projectFiltered, no_path: noPath,
		advisor_sidecar: advisorSidecar, per_project_cap: perProjectDropped, session_cap: sessionCapDropped,
		not_reached: notReached, stopped_early: stoppedEarly, list_truncated: listed.truncated, projects,
		git: emptySkillMineGitCoverage(),
	};
	const workspaces = [...new Set(listed.rows.map(row => sessionProject(row, options.cwd)).filter(Boolean))].sort();
	return { status: { status: "OK", reason, sessions: mined, messages }, observations, coverage, workspaces };
}
/** Narrow the live sessions envelope without asserting an unchecked shape. */
function sessionsOf(value: unknown): unknown[] {
	if (value !== null && typeof value === "object" && "sessions" in value && Array.isArray(value.sessions)) return value.sessions;
	return [];
}
/** Narrow an export envelope without asserting an unchecked shape. */
function messagesOf(value: unknown): unknown[] {
	if (value !== null && typeof value === "object" && "messages" in value && Array.isArray(value.messages)) return value.messages;
	return [value];
}

interface MailThread {
	project: string;
	id: string;
	subject: string;
	messages: { ref: string; body: string }[];
}

const TEACHING_SUBJECT_RE = /(how[ -]?to|howto|question|help|guide|playbook|reusable|lesson|pattern|procedure|checklist|runbook|tip)/i;
const NUMBERED_STEPS_RE = /(^|\n)\s*\d+[.)]\s+\S/;
const BACKTICK_CMD_RE = /`[^`\n]{2,80}`/;

// Line-based front-matter reader: the first line opens with `---json`, the
// block ends at the first later line that is exactly `---` (or at a trailing
// `---` on the opening line). No pattern matching: nested JSON braces and
// `---` inside quoted strings never confuse a line-boundary scan.
export function parseMailFile(text: string): { front: Record<string, unknown>; body: string } | null {
	const lines = text.split("\n");
	const head = lines.slice(0, 200);
	if (!head[0]?.startsWith("---json")) return null;
	const opened = head[0]!.slice("---json".length).trim();
	let raw: string;
	let body: string;
	if (opened.endsWith("---")) {
		raw = opened.slice(0, -3).trim();
		body = lines.slice(1).join("\n");
	} else {
		let end = -1;
		for (let index = 1; index < head.length; index++) {
			if (head[index]!.trim() === "---") { end = index; break; }
		}
		if (end < 0) return null;
		const rest = head.slice(1, end).join("\n").trim();
		raw = opened ? `${opened}\n${rest}` : rest;
		body = lines.slice(end + 1).join("\n");
	}
	try {
		const front = JSON.parse(raw) as Record<string, unknown>;
		return { front, body };
	} catch {
		return null;
	}
}

function mailArchiveRoot(options: SkillMineOptions): string {
	if (options.mailArchive) return options.mailArchive;
	return join(options.home, ".mcp_agent_mail_git_mailbox_repo");
}

/**
 * The live Agent Mail storage root, as the running server reports it (`am robot status --json` storage_root),
 * so mining reads current mail rather than a retired archive copy. Runtime-detected: am absent, failing or
 * silent yields null and the caller keeps --mail-archive or the legacy default. Exported as a test seam.
 */
export async function liveMailRoot(options: SkillMineOptions): Promise<string | null> {
	const am = findOnPath("am", options.pathValue);
	if (am === null) return null;
	try {
		const result = await run([am, "robot", "status", "--json"], { cwd: options.cwd, env: { HOME: options.home, PATH: options.pathValue }, deadline_s: 20, max_output_bytes: 4 << 20 });
		if (result.timed_out || result.rc !== 0) return null;
		const match = /"storage_root"\s*:\s*"([^"\\]{1,4096})"/.exec(Buffer.from(result.stdout).toString("utf8"));
		if (!match || !match[1]!.startsWith("/") || !existsSync(join(match[1]!, "projects"))) return null;
		return match[1]!;
	} catch {
		return null;
	}
}

function mineMail(options: SkillMineOptions, sinceMs: number): { status: SkillMineSourceReport; observations: Observation[] } {
	const root = mailArchiveRoot(options);
	const projectsDir = join(root, "projects");
	let slugs: string[];
	try {
		slugs = readdirSync(projectsDir).filter(slug => {
			try { return lstatSync(join(projectsDir, slug)).isDirectory(); } catch { return false; }
		});
	} catch {
		return { status: { status: "UNAVAILABLE", reason: `mail archive not found at ${projectsDir}; pass --mail-archive DIR` }, observations: [] };
	}
	const wantedSlugs = options.projects && options.projects.length > 0
		? slugs.filter(slug => options.projects!.some(p => slug.includes(p) || p.includes(slug)))
		: slugs;
	const threads = new Map<string, MailThread>();
	let files = 0;
	let scanned = 0;
	outer: for (const slug of wantedSlugs) {
		const messagesDir = join(projectsDir, slug, "messages");
		let years: string[];
		try {
			years = readdirSync(messagesDir);
		} catch { continue; }
		for (const year of years) {
			let months: string[];
			try {
				months = readdirSync(join(messagesDir, year));
			} catch { continue; }
			for (const month of months) {
				let names: string[];
				try {
					names = readdirSync(join(messagesDir, year, month));
				} catch { continue; }
				for (const name of names) {
					if (!name.endsWith(".md")) continue;
					if (scanned >= SKILL_MINE_MAIL_FILES_CAP) break outer;
					scanned++;
					const path = join(messagesDir, year, month, name);
					let stat: { size: number; mtimeMs: number };
					try {
						stat = statSync(path);
					} catch { continue; }
					if (stat.size > SKILL_MINE_MAIL_FILE_BYTES_CAP) continue;
					let text: string;
					try {
						text = readFileSync(path, "utf8");
					} catch { continue; }
					const parsed = parseMailFile(text);
					if (!parsed) continue;
					files++;
					const created = typeof parsed.front["created"] === "string" ? Date.parse(parsed.front["created"] as string) : NaN;
					if (!Number.isNaN(created) && created < sinceMs) continue;
					const threadId = typeof parsed.front["thread_id"] === "string" ? parsed.front["thread_id"] as string : name;
					const subject = typeof parsed.front["subject"] === "string" ? parsed.front["subject"] as string : "";
					const key = `${slug}\n${threadId}`;
					let thread = threads.get(key);
					if (!thread) {
						thread = { project: slug, id: threadId, subject, messages: [] };
						threads.set(key, thread);
					}
					if (subject && !thread.subject) thread.subject = subject;
					thread.messages.push({ ref: `${slug}:${name.replace(/\.md$/, "")}`, body: parsed.body });
					if (threads.size >= SKILL_MINE_MAIL_THREADS_CAP) break outer;
				}
			}
		}
	}
	const observations: Observation[] = [];
	for (const thread of threads.values()) {
		if (thread.messages.length < 2) continue;
		const first = thread.messages[0]!.body;
		const teaching = TEACHING_SUBJECT_RE.test(thread.subject)
			|| TEACHING_SUBJECT_RE.test(first.slice(0, 500))
			|| (NUMBERED_STEPS_RE.test(first) && BACKTICK_CMD_RE.test(first));
		if (!teaching) continue;
		const steps = NUMBERED_STEPS_RE.test(first);
		const signature = `mail:${tokensOf(thread.subject || first.slice(0, 120)).slice(0, 6).join(" ")}`;
		const workflow = slugOf(`mail-${tokensOf(thread.subject).slice(0, 4).join("-") || thread.project}`);
		const summary = `Mail-taught procedure "${thread.subject || thread.id}" (${thread.messages.length} messages${steps ? ", numbered steps" : ""}); bottle it as a skill.`;
		for (const message of thread.messages.slice(0, 5)) {
			const snippet = message.body.replace(/\s+/g, " ").trim().slice(0, 120);
			observations.push({
				kind: "mail-thread", signature, workflow, summary,
				project: thread.project, session: thread.id, ref: message.ref,
				quote: redactedQuote(message === thread.messages[0] ? `${thread.subject}: ${snippet}` : snippet),
				recent: true,
			});
		}
	}
	return { status: { status: "OK", reason: `scanned ${scanned} file(s) in ${wantedSlugs.length} project(s)`, threads: threads.size, files }, observations };
}

// ---------------------------------------------------------------------------
// Git history source (SKILLMINEGIT1): failure -> correction -> outcome chains
// that Git itself can prove, mined one repository and one month at a time.
// Read-only: discovery via rev-parse, history via log. Never fetch, checkout,
// or diff bodies; a commit message line that looks like a credential drops the
// commit. Per-repository month cursors live in git-cursors.json beside the
// ledger, so a run mines the next unmined month(s) within the shared wall
// budget and a later run continues.

interface GitCommit {
	sha: string;
	dateMs: number;
	subject: string;
	body: string;
	paths: string[];
}

type SkillMineGitCursors = Record<string, { display: string; months_mined: string[]; last_error: string | null }>;

function validGitChain(value: unknown): SkillMineGitChain | null {
	if (value === null || typeof value !== "object" || Array.isArray(value)) return null;
	const row = value as Record<string, unknown>;
	if (typeof row.repo !== "string" || row.repo.length === 0) return null;
	if (typeof row.month !== "string" || !GIT_MONTH_RE.test(row.month)) return null;
	if (row.kind !== "revert" && row.kind !== "named" && row.kind !== "weak") return null;
	for (const key of ["fixSha", "fixSubject", "failSha", "failSubject"] as const) {
		if (typeof row[key] !== "string" || (row[key] as string).length === 0) return null;
	}
	if (typeof row.fixDateMs !== "number" || !Number.isFinite(row.fixDateMs)) return null;
	if (!Array.isArray(row.paths) || !row.paths.every(path => typeof path === "string")) return null;
	if (row.referrerSha !== null && row.referrerSha !== undefined && typeof row.referrerSha !== "string") return null;
	if (row.referrerSubject !== null && row.referrerSubject !== undefined && typeof row.referrerSubject !== "string") return null;
	return {
		repo: row.repo, month: row.month, kind: row.kind,
		fixSha: row.fixSha as string, fixSubject: (row.fixSubject as string).slice(0, 160), fixDateMs: row.fixDateMs as number,
		failSha: row.failSha as string, failSubject: (row.failSubject as string).slice(0, 160),
		referrerSha: (row.referrerSha as string | null) ?? null,
		referrerSubject: ((row.referrerSubject as string | null) ?? null)?.slice(0, 160) ?? null,
		paths: (row.paths as string[]).slice(0, 8),
	};
}

/** Persisted Git state, validated on read; a foreign or torn file mines from scratch. */
export function loadGitState(stateDir: string): SkillMineGitState {
	try {
		const raw = JSON.parse(readFileSync(join(stateDir, "skill-mine", "git-cursors.json"), "utf8")) as unknown;
		if (raw !== null && typeof raw === "object" && !Array.isArray(raw)) {
			const body = raw as { repos?: unknown; chains?: unknown };
			const repos: SkillMineGitCursors = {};
			if (body.repos !== null && typeof body.repos === "object" && !Array.isArray(body.repos)) {
				for (const [key, value] of Object.entries(body.repos as Record<string, unknown>)) {
					if (typeof key !== "string" || key.length === 0 || value === null || typeof value !== "object" || Array.isArray(value)) continue;
					const row = value as { display?: unknown; months_mined?: unknown; last_error?: unknown };
					if (!Array.isArray(row.months_mined) || !row.months_mined.every(month => typeof month === "string" && GIT_MONTH_RE.test(month))) continue;
					repos[key] = {
						display: typeof row.display === "string" && row.display.length > 0 ? row.display : key,
						months_mined: [...row.months_mined as string[]].sort(),
						last_error: typeof row.last_error === "string" ? row.last_error : null,
					};
				}
			}
			const chains: SkillMineGitChain[] = [];
			if (Array.isArray(body.chains)) {
				for (const item of body.chains) {
					const chain = validGitChain(item);
					if (chain) chains.push(chain);
				}
			}
			return { repos, chains };
		}
	} catch { /* first run, or a torn cursor: mine from scratch */ }
	return { repos: {}, chains: [] };
}

/** Atomic cursor write: temp file in the same directory, then rename. */
function saveGitState(stateDir: string, state: SkillMineGitState): void {
	const dir = join(stateDir, "skill-mine");
	mkdirSync(dir, { recursive: true, mode: 0o700 });
	const final = join(dir, "git-cursors.json");
	const temp = join(dir, `git-cursors.json.${randomBytes(6).toString("hex")}.tmp`);
	writeFileSync(temp, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
	renameSync(temp, final);
}

/** Trailing SKILL_MINE_GIT_MONTHS calendar months overlapping [sinceMs, now], oldest first. */
export function gitMonthKeys(now: number, sinceMs: number): string[] {
	const keys: string[] = [];
	const base = new Date(now);
	for (let back = 0; back < SKILL_MINE_GIT_MONTHS; back++) {
		const start = Date.UTC(base.getUTCFullYear(), base.getUTCMonth() - back, 1);
		const end = Date.UTC(base.getUTCFullYear(), base.getUTCMonth() - back + 1, 1);
		if (end > sinceMs && start <= now) {
			const date = new Date(start);
			keys.push(`${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, "0")}`);
		}
	}
	return keys.reverse();
}

/**
 * Whether the walk from HEAD for the window is cut by a shallow boundary: a
 * commit listed in the repo's shallow file that is an ancestor of HEAD and
 * dated at or after the window start. A shallow flag alone (an unrelated
 * entry, or a boundary older than the window) never counts as a cut.
 */
async function gitShallowCut(gitBin: string, display: string, options: SkillMineOptions, windowStartMs: number): Promise<{ sha: string } | null> {
	const located = await runGit(gitBin, ["rev-parse", "--git-path", "shallow"], display, options, 64 * 1024);
	if (!located.ok) return null;
	const rawPath = located.stdout.trim();
	if (!rawPath) return null;
	const shallowPath = rawPath.startsWith("/") ? rawPath : join(display, rawPath);
	let entries: string;
	try {
		if (statSync(shallowPath).size > 64 * 1024) return null;
		entries = readFileSync(shallowPath, "utf8");
	} catch { return null; }
	const shas = entries.split("\n").map(line => line.trim()).filter(line => /^[0-9a-f]{7,40}$/.test(line)).slice(0, 32);
	for (const sha of shas) {
		const ancestor = await runGit(gitBin, ["merge-base", "--is-ancestor", sha, "HEAD"], display, options, 64 * 1024);
		if (!ancestor.ok) continue;
		const dated = await runGit(gitBin, ["show", "-s", "--format=%cI", sha], display, options, 64 * 1024);
		if (!dated.ok) return { sha };
		const cutAt = Date.parse(dated.stdout.trim());
		if (!Number.isFinite(cutAt) || cutAt >= windowStartMs) return { sha };
	}
	return null;
}

/**
 * One bounded, read-only git call with a scrubbed environment (no GIT_* passes
 * except a harness ceiling) and repo config neutralized: a hostile repository
 * cannot run its hooks, fsmonitor, pager or config programs through log or
 * rev-parse, and git takes no locks and prompts for nothing.
 */
async function runGit(gitBin: string, args: string[], cwd: string, options: SkillMineOptions, maxBytes: number): Promise<{ ok: boolean; stdout: string; reason: string }> {
	const env: Record<string, string> = {
		HOME: options.home, PATH: options.pathValue,
		GIT_OPTIONAL_LOCKS: "0", GIT_CONFIG_NOSYSTEM: "1", GIT_TERMINAL_PROMPT: "0",
	};
	const ceiling = process.env.GIT_CEILING_DIRECTORIES;
	if (typeof ceiling === "string" && ceiling.length > 0) env.GIT_CEILING_DIRECTORIES = ceiling;
	const argv = [gitBin, "--no-pager",
		"-c", "core.fsmonitor=false", "-c", "core.hooksPath=/dev/null", "-c", "core.untrackedCache=false", "-c", "core.quotepath=off",
		...args];
	try {
		const result = await run(argv, { cwd, env, deadline_s: SKILL_MINE_GIT_DEADLINE_S, max_output_bytes: maxBytes });
		if (result.timed_out) return { ok: false, stdout: "", reason: `git ${args[0] ?? ""} timed out after ${SKILL_MINE_GIT_DEADLINE_S} s` };
		// Truncation first: an over-cap child is SIGKILLed, so its rc is null;
		// reading the exit code first would misreport the cap as a crash.
		if (result.total_truncated || result.truncated) return { ok: false, stdout: "", reason: `git ${args[0] ?? ""} output exceeded its cap; narrow --since` };
		if (result.rc !== 0) return { ok: false, stdout: "", reason: `git ${args[0] ?? ""} exited ${result.rc}: ${Buffer.from(result.stderr).toString("utf8").slice(0, 200)}` };
		return { ok: true, stdout: Buffer.from(result.stdout).toString("utf8"), reason: "" };
	} catch (error) {
		return { ok: false, stdout: "", reason: error instanceof Error ? error.message : String(error) };
	}
}

/**
 * Canonical repository for a seed path. Implicit seeds (cass workspaces, cwd)
 * only count when they ARE a repository root (a .git entry is present), so a
 * plain directory never maps to an enclosing checkout. Explicit --project
 * seeds allow upward discovery, matching the kit's project resolution. Either
 * way aliases collapse: the cursor key is the realpath of the git common dir.
 */
async function canonicalGitRepo(gitBin: string, seed: string, discover: boolean, options: SkillMineOptions): Promise<{ key: string; display: string } | null> {
	let real: string;
	try {
		real = realpathSync(resolve(options.cwd, seed));
	} catch { return null; }
	if (!discover && !existsSync(join(real, ".git"))) return null;
	const probed = await runGit(gitBin, ["rev-parse", "--show-toplevel", "--git-common-dir"], real, options, 64 * 1024);
	if (!probed.ok) return null;
	const [top, common] = probed.stdout.split("\n").map(line => line.trim());
	if (!top) return null;
	try {
		const display = realpathSync(top);
		if (!discover && display !== real) return null;
		const key = realpathSync(resolve(display, common && common.length > 0 ? common : ".git"));
		return { key, display };
	} catch { return null; }
}

/** Parse one month of `git log -z --name-only` output. NUL separates the
 * header segment from each path (neither can contain NUL); header fields are
 * \x1f-separated inside the header segment. A segment that looks like a
 * header but fails validation is corruption, not a path: null makes the month
 * error instead of mining garbage. */
function parseGitLog(out: string): GitCommit[] | null {
	const segments = out.split(" ");
	const parseHeader = (segment: string): GitCommit | null => {
		const fields = segment.split("");
		if (fields.length < 4) return null;
		const [sha, dateISO, subject, ...bodyParts] = fields as [string, string, string, ...string[]];
		if (!sha || !GIT_SHA40_RE.test(sha)) return null;
		const dateMs = Date.parse(dateISO ?? "");
		if (!Number.isFinite(dateMs)) return null;
		return { sha, dateMs, subject: subject ?? "", body: bodyParts.join(""), paths: [] };
	};
	// A zero-path commit glues git's newline separator to the next header;
	// strip one leading newline before probing, never inside a path.
	const probeHeader = (segment: string): GitCommit | null =>
		parseHeader(segment) ?? (segment.startsWith("\n") ? parseHeader(segment.slice(1)) : null);
	const commits: GitCommit[] = [];
	let index = 0;
	while (index < segments.length && segments[index] === "") index++;
	while (index < segments.length) {
		const head = probeHeader(segments[index]!);
		if (!head) return null;
		index++;
		while (index < segments.length && segments[index] === "") index++;
		const paths: string[] = [];
		while (index < segments.length && probeHeader(segments[index]!) === null) {
			const raw = segments[index]!;
			if (raw.includes("")) return null;
			const path = paths.length === 0 ? raw.replace(/^\n/, "") : raw;
			if (path.length > 0) paths.push(path);
			index++;
		}
		commits.push({ ...head, paths });
	}
	return commits;
}

function sharedPaths(a: string[], b: string[]): string[] {
	const left = new Set(a);
	return [...new Set(b.filter(path => left.has(path)))].sort();
}

/** Noise paths that can never carry a recurrence: changelogs, docs, READMEs, lock files, test-only paths. */
const GIT_NOISE_DIR_RE = /^(changelog\.d|docs)\//;
const GIT_NOISE_FILE_RE = /^(readme(?:\.[a-z0-9]+)?|package-lock\.json|bun\.lockb?|yarn\.lock|pnpm-lock\.yaml|cargo\.lock|gemfile\.lock|poetry\.lock|composer\.lock)$/i;
const GIT_TEST_PATH_RE = /(^|\/)(tests?|__tests__)\/|\.(test|spec)\.[a-z0-9]+$/i;

function gitBasename(path: string): string {
	const slash = path.lastIndexOf("/");
	return slash < 0 ? path : path.slice(slash + 1);
}

/**
 * Most specific shared source file, or null when every shared path is noise.
 * Most specific is the deepest path, then the longest.
 */
function gitChainFile(chain: SkillMineGitChain): string | null {
	const kept = chain.paths.filter(path =>
		!GIT_NOISE_DIR_RE.test(path) && !GIT_TEST_PATH_RE.test(path) && !GIT_NOISE_FILE_RE.test(gitBasename(path)));
	if (kept.length === 0) return null;
	return [...kept].sort((a, b) => b.split("/").length - a.split("/").length || b.length - a.length || (a < b ? -1 : 1))[0]!;
}

/** Remedy shape of the fix: conventional-commit scope when present, else the normalized subject. */
function gitRemedy(fixSubject: string): string {
	const scope = GIT_SCOPE_RE.exec(fixSubject)?.[1]?.trim().toLowerCase();
	if (scope) return scope;
	return normalizeSkeleton(fixSubject);
}

/** Resolve the reverted original: git trailer, conventional trailer, bare body sha, or matching subject. */
function revertOriginal(revert: GitCommit, bySha: Map<string, GitCommit>, clean: GitCommit[]): GitCommit | null {
	const subject = GIT_REVERT_SUBJECT_RE.exec(revert.subject);
	const conventional = subject === null && GIT_CONV_REVERT_RE.test(revert.subject);
	if (subject === null && !conventional) return null;
	const named = GIT_REVERT_BODY_RE.exec(revert.body)?.[1]
		?? GIT_REVERT_TRAILER_RE.exec(revert.body)?.[1]
		?? GIT_BODY_SHA_RE.exec(revert.body)?.[1];
	const original = (named ? bySha.get(named) : undefined)
		?? (subject ? clean.find(candidate => candidate.dateMs < revert.dateMs && normalizeSkeleton(candidate.subject) === normalizeSkeleton(subject[1] ?? "")) : undefined);
	if (!original || original.sha === revert.sha || original.dateMs >= revert.dateMs) return null;
	return original;
}

/**
 * Admitted failure -> correction -> outcome chains over this month's commits
 * plus older months mined earlier in the run. A chain is admitted when the
 * fix names the failing sha (full or short-7), when it is a revert pair
 * (either message form), or — weakly — when it follows a commit that admits
 * breakage on the same paths. Chores, docs, releases and version bumps are
 * never the failing endpoint. Each chain is attributed to the month its
 * outcome landed in: only outcomes from this month emit, so a later month
 * never re-mines an earlier month's chains.
 */
function gitChainsForMonth(display: string, month: string, commits: GitCommit[], history: GitCommit[]): { chains: SkillMineGitChain[]; credentialDrops: number } {
	const chains: SkillMineGitChain[] = [];
	let credentialDrops = 0;
	const current = new Set(commits.map(commit => commit.sha));
	const clean = [...history, ...commits].filter(commit => {
		if (scrubText(`${commit.subject}\n${commit.body.slice(0, MESSAGE_TEXT_CAP)}`) !== `${commit.subject}\n${commit.body.slice(0, MESSAGE_TEXT_CAP)}`) {
			credentialDrops++;
			return false;
		}
		return true;
	}).sort((a, b) => a.dateMs - b.dateMs || (a.sha < b.sha ? -1 : 1));
	const bySha = new Map(clean.map(commit => [commit.sha, commit]));
	const emittedFix = new Set<string>();
	for (const revert of clean) {
		const original = revertOriginal(revert, bySha, clean);
		if (!original) continue;
		const replacement = clean.find(candidate =>
			candidate.dateMs > revert.dateMs && candidate.sha !== revert.sha && candidate.sha !== original.sha
			&& sharedPaths(revert.paths, candidate.paths).length > 0
			&& (normalizeSkeleton(candidate.subject) === normalizeSkeleton(original.subject) || GIT_RELAND_RE.test(candidate.subject)));
		const outcome = replacement ?? revert;
		// The outcome landed this month only when the outcome did; older
		// months keep their own chains and are never re-mined.
		if (!current.has(outcome.sha)) continue;
		const paths = sharedPaths(original.paths, outcome.paths);
		chains.push({
			repo: display, month, kind: "revert",
			fixSha: outcome.sha, fixSubject: outcome.subject.slice(0, 160), fixDateMs: outcome.dateMs,
			failSha: revert.sha, failSubject: revert.subject.slice(0, 160),
			referrerSha: original.sha, referrerSubject: original.subject.slice(0, 160),
			paths: (paths.length > 0 ? paths : outcome.paths).slice(0, 8),
		});
		emittedFix.add(outcome.sha);
	}
	for (const fix of clean) {
		// Only this month's fixes emit; older months keep their own chains.
		if (!current.has(fix.sha)) continue;
		if (!GIT_FIX_RE.test(fix.subject) || emittedFix.has(fix.sha)) continue;
		const text = `${fix.subject}\n${fix.body}`;
		const candidates = [...clean].reverse().filter(candidate =>
			candidate.dateMs < fix.dateMs && candidate.sha !== fix.sha
			&& sharedPaths(candidate.paths, fix.paths).length > 0
			&& !GIT_ROUTINE_SUBJECT_RE.test(candidate.subject));
		const named = candidates.find(candidate => text.includes(candidate.sha) || text.includes(candidate.sha.slice(0, 7)));
		const weak = named ?? candidates.find(candidate =>
			(GIT_BREAK_RE.test(candidate.subject) || FAIL_RE.test(candidate.subject)) && !GIT_FIX_RE.test(candidate.subject));
		const failing = named ?? weak;
		if (!failing) continue;
		chains.push({
			repo: display, month, kind: named ? "named" : "weak",
			fixSha: fix.sha, fixSubject: fix.subject.slice(0, 160), fixDateMs: fix.dateMs,
			failSha: failing.sha, failSubject: failing.subject.slice(0, 160),
			referrerSha: null, referrerSubject: null,
			paths: sharedPaths(failing.paths, fix.paths).slice(0, 8),
		});
	}
	return { chains, credentialDrops };
}

/** Maximum recursion when an over-cap month window is halved. */
const SKILL_MINE_GIT_SPLIT_DEPTH = 10;

/**
 * One month of commits, splitting an over-cap window in half (recursively)
 * until every piece fits the log byte cap. A piece that still cannot fit is
 * an error and the month is not marked mined.
 */
async function mineMonthCommits(gitBin: string, display: string, options: SkillMineOptions, sinceISO: string, untilISO: string, month: string, depth: number): Promise<{ commits: GitCommit[] } | { error: string }> {
	const logged = await runGit(gitBin,
		["log", "--no-color", "--no-merges", "--reverse", "-z", "--name-only",
			`--format=%H%x1f%aI%x1f%s%x1f%b%x00`, `--since=${sinceISO}`, `--until=${untilISO}`],
		display, options, options.gitLogBytesCap ?? SKILL_MINE_GIT_LOG_BYTES_CAP);
	if (!logged.ok) {
		if (!options.gitNoSplit && logged.reason.includes("exceeded its cap")) {
			const sinceMs = Date.parse(sinceISO);
			const untilMs = Date.parse(untilISO);
			const midMs = Math.floor((sinceMs + untilMs) / 2000) * 1000;
			if (Number.isFinite(sinceMs) && Number.isFinite(untilMs) && depth < SKILL_MINE_GIT_SPLIT_DEPTH && midMs > sinceMs && midMs < untilMs) {
				const midISO = new Date(midMs).toISOString();
				const left = await mineMonthCommits(gitBin, display, options, sinceISO, midISO, month, depth + 1);
				if ("error" in left) return left;
				const right = await mineMonthCommits(gitBin, display, options, midISO, untilISO, month, depth + 1);
				if ("error" in right) return right;
				const seen = new Set<string>();
				const commits: GitCommit[] = [];
				for (const commit of [...left.commits, ...right.commits]) {
					if (seen.has(commit.sha)) continue;
					seen.add(commit.sha);
					commits.push(commit);
				}
				return { commits };
			}
		}
		return { error: logged.reason };
	}
	const commits = parseGitLog(logged.stdout);
	if (commits === null) return { error: `unparseable git log output for ${month}` };
	return { commits };
}
/**
 * Cluster admitted chains by the most specific shared source file and emit one
 * evidence packet per qualifying cluster: 3+ named-sha or revert chains on
 * that file in one repository, or the same file-basename-and-remedy shape in 2+
 * repositories. A chain with no qualifying shared file is unclustered.
 * Candidates are labelled `git-recurrence`: evidence for judgement, never
 * auto-filed. They carry the file, chain count, months spanned and the 5 most
 * recent failure -> fix pairs; other chains surface only as counts in coverage.
 */
function clusterGitChains(chains: SkillMineGitChain[], firstSeen: Map<string, string>, nowISO: string): { candidates: SkillMineCandidate[]; unclustered: number } {
	type Item = { chain: SkillMineGitChain; file: string };
	const filed: Item[] = [];
	let unclustered = 0;
	for (const chain of chains) {
		const file = gitChainFile(chain);
		if (!file) { unclustered++; continue; }
		filed.push({ chain, file });
	}
	const candidates: SkillMineCandidate[] = [];
	const used = new Set<SkillMineGitChain>();
	const emit = (items: Item[], file: string, key: string): void => {
		const group = items.map(item => item.chain);
		for (const item of items) used.add(item.chain);
		const repos = [...new Set(group.map(chain => chain.repo))].sort();
		const recent = [...group].sort((a, b) => b.fixDateMs - a.fixDateMs || (a.fixSha < b.fixSha ? -1 : 1));
		const months = [...new Set(group.map(chain => chain.month))].sort();
		const example = recent[0]!;
		const shown = example.paths.slice(0, SKILL_MINE_GIT_MAX_PATHS).join(", ");
		const exampleText = example.kind === "revert" && example.referrerSha
			? `"${example.fixSubject}" (${example.fixSha.slice(0, 7)} ${new Date(example.fixDateMs).toISOString().slice(0, 10)}) reverts "${example.referrerSubject ?? ""}" (${example.referrerSha.slice(0, 7)}) on ${shown}`
			: `"${example.fixSubject}" (${example.fixSha.slice(0, 7)} ${new Date(example.fixDateMs).toISOString().slice(0, 10)}) follows "${example.failSubject}" (${example.failSha.slice(0, 7)}) on ${shown}`;
		const workflow = `git-recurrence-${slugOf(key)}`;
		const fingerprint = fingerprintOf(workflow);
		const evidence = recent.slice(0, 5).map(chain => {
			const date = new Date(chain.fixDateMs).toISOString().slice(0, 10);
			const names = chain.paths.slice(0, SKILL_MINE_GIT_MAX_PATHS).join(", ");
			const quote = chain.kind === "revert" && chain.referrerSha
				? `${date} ${chain.fixSubject} reverts ${chain.referrerSha.slice(0, 7)} on ${names}`
				: `${date} ${chain.fixSubject} follows ${chain.failSha.slice(0, 7)} on ${names}`;
			return { source: "git" as const, ref: `git:${chain.repo}:${chain.fixSha.slice(0, 7)}`, quote: redactedQuote(quote) };
		});
		candidates.push({
			kind: "git-recurrence",
			workflow,
			summary: `Git recurrence on ${file}: ${group.length} chain(s) across ${repos.length} repo(s) (${months.join(", ")}); e.g. ${exampleText}.`,
			projects: repos, occurrences: group.length,
			why_skill: `Same fix shape on ${file} in ${repos.length} project(s) across ${group.length} chain(s) (${months.join(", ")}); git-proven failure->correction recurrence for judgement, never auto-filed. Key: gitfile:${key.slice(0, 100)}`,
			evidence, nearest_existing_skill: null, fingerprint,
			score: Math.round(repos.length * repos.length * group.length * 2 * 100) / 100,
			first_seen: firstSeen.get(fingerprint) ?? nowISO,
			months,
		});
	};
	// Cross-repository first: same file basename and remedy in 2+ repositories.
	const cross = new Map<string, Item[]>();
	for (const item of filed) {
		const key = `${gitBasename(item.file)}|${gitRemedy(item.chain.fixSubject)}`;
		const list = cross.get(key) ?? [];
		list.push(item);
		cross.set(key, list);
	}
	for (const [key, items] of cross) {
		const repos = new Set(items.map(item => item.chain.repo));
		if (repos.size >= 2 && items.length >= 2) {
			emit(items, key.split("|")[0]!, key);
		}
	}
	// Then single-file clusters on the remainder: 3+ strong chains in one repository.
	const single = new Map<string, Item[]>();
	for (const item of filed) {
		if (used.has(item.chain)) continue;
		const list = single.get(item.file) ?? [];
		list.push(item);
		single.set(item.file, list);
	}
	for (const [file, items] of single) {
		const strongByRepo = new Map<string, number>();
		for (const item of items) {
			if (item.chain.kind === "weak") continue;
			strongByRepo.set(item.chain.repo, (strongByRepo.get(item.chain.repo) ?? 0) + 1);
		}
		if (Math.max(0, ...strongByRepo.values()) < 3) {
			unclustered += items.length;
			continue;
		}
		emit(items, file, file);
	}
	candidates.sort((a, b) => b.score - a.score || a.workflow.localeCompare(b.workflow));
	return { candidates, unclustered };
}
/**
 * Git source: for each registered project repository (cass workspaces, or
 * --project when given) mine the next unmined month(s) within the shared wall
 * budget, one repository at a time. Aliases collapse to one canonical
 * repository and are mined once. Admitted chains persist beside the cursor so
 * clusters accumulate across monthly runs without re-mining.
 */
async function mineGit(options: SkillMineOptions, sinceMs: number, now: number, cassWorkspaces: string[], deadlineMs: number, firstSeen: Map<string, string>, nowISO: string): Promise<{ status: SkillMineSourceReport; candidates: SkillMineCandidate[]; coverage: SkillMineGitCoverage }> {
	const coverage = emptySkillMineGitCoverage();
	const gitBin = findOnPath("git", options.pathValue);
	if (gitBin === null) {
		return { status: { status: "UNAVAILABLE", reason: "git is not on PATH; Git history was not mined" }, candidates: [], coverage };
	}
	const explicit = options.projects && options.projects.length > 0 ? options.projects : [];
	const seeds = (explicit.length > 0 ? explicit : [...cassWorkspaces, options.cwd]).map(seed => ({ seed, discover: explicit.length > 0 }));
	const repos = new Map<string, { key: string; display: string }>();
	for (const { seed, discover } of seeds) {
		if (!seed) { coverage.dropped_not_a_repo++; continue; }
		const repo = await canonicalGitRepo(gitBin, seed, discover, options);
		if (!repo) { coverage.dropped_not_a_repo++; continue; }
		if (!repos.has(repo.key)) repos.set(repo.key, repo);
	}
	coverage.repos = repos.size;
	if (repos.size === 0) {
		return { status: { status: "UNAVAILABLE", reason: `no git repositories resolved${explicit.length > 0 ? " from --project" : " from session workspaces"}; pass --project PATH` }, candidates: [], coverage };
	}
	const months = gitMonthKeys(now, sinceMs);
	const monthsPerRun = options.gitMonthsPerRun ?? Number.POSITIVE_INFINITY;
	const state = loadGitState(options.stateDir);
	// Drop cursor rows for repositories that are no longer registered, after
	// reporting them once in this run's coverage.
	for (const key of Object.keys(state.repos)) {
		if (repos.has(key)) continue;
		const stale = state.repos[key]!;
		const display = stale.display ?? key;
		coverage.repos_detail[display] = {
			months_mined: [...stale.months_mined],
			months_remaining: 0,
			last_error: "repository no longer registered",
		};
		delete state.repos[key];
		state.chains = state.chains.filter(chain => chain.repo !== display);
	}
	const minedThisRun: string[] = [];
	const shallowCuts: string[] = [];
	let dirty = Object.keys(coverage.repos_detail).length > 0;
	const ordered = [...repos.values()].sort((a, b) => a.display < b.display ? -1 : 1);
	for (let index = 0; index < ordered.length; index++) {
		const repo = ordered[index]!;
		const entry = state.repos[repo.key] ?? { display: repo.display, months_mined: [], last_error: null };
		const unmined = months.filter(month => !entry.months_mined.includes(month));
		// A shallow flag alone means nothing: only a boundary that cuts the
		// window walk is reported, and mining still proceeds read-only.
		const windowStartMs = months.length > 0 ? Date.parse(`${months[0]}-01T00:00:00Z`) : Number.POSITIVE_INFINITY;
		const shallowCut = await gitShallowCut(gitBin, repo.display, options, windowStartMs);
		if (shallowCut) shallowCuts.push(`${repo.display.split("/").slice(-2).join("/")}@${shallowCut.sha.slice(0, 7)}`);
		let done = 0;
		const history: GitCommit[] = [];
		for (const month of unmined) {
			// The per-run month cap is rotation, not exhaustion: move to the
			// next repository and leave the remainder for a later run.
			if (done >= monthsPerRun) break;
			if (Date.now() > deadlineMs) {
				coverage.not_reached += unmined.length - done;
				for (let rest = index + 1; rest < ordered.length; rest++) {
					const later = state.repos[ordered[rest]!.key] ?? { months_mined: [] as string[], last_error: null };
					coverage.not_reached += months.filter(m => !later.months_mined.includes(m)).length;
				}
				coverage.stopped_early = true;
				break;
			}
			const year = Number(month.slice(0, 4));
			const mon = Number(month.slice(5, 7));
			const mined = await mineMonthCommits(gitBin, repo.display, options,
				`${month}-01T00:00:00Z`, new Date(Date.UTC(year, mon, 1)).toISOString(), month, 0);
			if ("error" in mined) {
				coverage.dropped_errors++;
				if (entry.last_error !== mined.error) { entry.last_error = mined.error; dirty = true; }
				continue;
			}
			const commits = mined.commits;
			coverage.commits_seen += commits.length;
			const found = gitChainsForMonth(repo.display, month, commits, history);
			coverage.dropped_credentials += found.credentialDrops;
			coverage.chains += found.chains.length;
			const known = new Set(state.chains.map(chain => `${chain.repo}\n${chain.fixSha}`));
			for (const chain of found.chains) {
				const key = `${chain.repo}\n${chain.fixSha}`;
				if (known.has(key)) continue;
				known.add(key);
				state.chains.push(chain);
				dirty = true;
			}
			history.push(...commits);
			entry.months_mined = [...entry.months_mined, month].sort();
			// A past month error stays visible until the repository is fully caught up.
			if (entry.months_mined.length >= months.length) entry.last_error = null;
			minedThisRun.push(month);
			done++;
			dirty = true;
		}
		entry.display = repo.display;
		state.repos[repo.key] = entry;
		if (coverage.stopped_early) break;
	}
	// Bound the persisted store on every save: drop chains older than the
	// trailing 12-month window, then cap each repository at the newest 2000.
	const oldestKept = gitMonthKeys(now, 0)[0];
	if (oldestKept !== undefined) {
		const before = state.chains.length;
		state.chains = state.chains.filter(chain => chain.month >= oldestKept);
		if (state.chains.length !== before) dirty = true;
	}
	const chainsByRepo = new Map<string, SkillMineGitChain[]>();
	for (const chain of state.chains) {
		const list = chainsByRepo.get(chain.repo) ?? [];
		list.push(chain);
		chainsByRepo.set(chain.repo, list);
	}
	state.chains = [];
	for (const list of chainsByRepo.values()) {
		const newest = [...list].sort((a, b) => b.fixDateMs - a.fixDateMs || (a.fixSha < b.fixSha ? -1 : 1));
		const kept = newest.slice(0, SKILL_MINE_GIT_CHAINS_PER_REPO);
		coverage.chains_evicted += list.length - kept.length;
		state.chains.push(...kept);
	}
	if (coverage.chains_evicted > 0) dirty = true;
	if (dirty) saveGitState(options.stateDir, state);
	for (const repo of ordered) {
		const entry = state.repos[repo.key] ?? { months_mined: [] as string[], last_error: null as string | null };
		coverage.repos_detail[repo.display] = {
			months_mined: [...entry.months_mined],
			months_remaining: months.filter(m => !entry.months_mined.includes(m)).length,
			last_error: entry.last_error,
		};
		coverage.months_remaining += coverage.repos_detail[repo.display]!.months_remaining;
	}
	coverage.months_mined = [...new Set(minedThisRun)].sort();
	const { candidates, unclustered } = clusterGitChains(state.chains, firstSeen, nowISO);
	coverage.chains_seen = state.chains.length;
	coverage.chains_unclustered = unclustered;
	const parts = [`mined ${minedThisRun.length} month(s) across ${repos.size} repo(s)`,
		...(coverage.chains > 0 ? [`${coverage.chains} chain(s) this run from ${coverage.commits_seen} commit(s)`] : [`${coverage.commits_seen} commit(s), no chains`]),
		...(coverage.chains_seen > 0 ? [`${coverage.chains_seen} known chain(s), ${coverage.chains_unclustered} unclustered`] : []),
		...(coverage.chains_evicted > 0 ? [`${coverage.chains_evicted} chain(s) evicted`] : []),
		...(coverage.dropped_not_a_repo > 0 ? [`${coverage.dropped_not_a_repo} seed(s) not a repository`] : []),
		...(coverage.dropped_credentials > 0 ? [`${coverage.dropped_credentials} credential-tainted commit(s) dropped`] : []),
		...(coverage.dropped_errors > 0 ? [`${coverage.dropped_errors} month(s) errored`] : []),
		...(shallowCuts.length > 0 ? [`shallow boundar${shallowCuts.length === 1 ? "y" : "ies"} cut history: ${shallowCuts.join(", ")}`] : []),
		...(coverage.not_reached > 0 ? [`${coverage.not_reached} month(s) never visited (wall budget)`] : []),
		...(coverage.stopped_early ? ["wall budget reached"] : [])];
	return {
		status: { status: "OK", reason: parts.join("; "), repos: repos.size, commits: coverage.commits_seen, months_mined: coverage.months_mined.length },
		candidates, coverage,
	};
}

interface SkillIndexEntry {
	name: string;
	description: string;
}

export function readSkillsIndex(directories: string[]): { skills: SkillIndexEntry[]; count: number } {
	const skills: SkillIndexEntry[] = [];
	for (const directory of directories) {
		let entries: string[];
		try {
			entries = readdirSync(directory);
		} catch { continue; }
		for (const entry of entries) {
			if (skills.length >= SKILL_MINE_SKILLS_CAP) break;
			const readme = join(directory, entry, "SKILL.md");
			let text: string;
			try {
				if (!statSync(readme).isFile()) continue;
				text = readFileSync(readme, "utf8").slice(0, SKILL_MINE_SKILL_FILE_BYTES_CAP);
			} catch { continue; }
			const front = /^---\s*\n([\s\S]*?)\n---/.exec(text)?.[1] ?? "";
			const name = /^name:\s*(.+)$/m.exec(front)?.[1]?.trim().replace(/^["']|["']$/g, "") || entry;
			const description = /^description:\s*(.+)$/m.exec(front)?.[1]?.trim().replace(/^["']|["']$/g, "") || "";
			skills.push({ name, description });
		}
	}
	return { skills, count: skills.length };
}

/**
 * Installed-skill roots to dedupe against: `OMP_KIT_SKILLS_DIRS` (path-delimiter list) when set, else the OMP-native
 * roots. Other harnesses' skill dirs are operator data: pass them with --skills-dir or the env, never hardcoded here.
 */
export function defaultSkillsDirs(home: string, env: Record<string, string | undefined> = process.env): string[] {
	const configured = (env.OMP_KIT_SKILLS_DIRS ?? "").split(delimiter).map(part => part.trim()).filter(Boolean);
	return configured.length > 0 ? configured : [join(home, ".agents", "skills"), join(home, ".omp", "agent", "skills")];
}

/** Token overlap of a candidate against one skill; the covering skill is the max. */
export function skillOverlap(candidateTokens: string[], skill: SkillIndexEntry): number {
	if (candidateTokens.length === 0) return 0;
	const skillTokens = new Set(tokensOf(`${skill.name} ${skill.description}`));
	if (skillTokens.size === 0) return 0;
	const hits = candidateTokens.filter(token => skillTokens.has(token)).length;
	return hits / candidateTokens.length;
}

interface Cluster {
	observations: Observation[];
	projects: Set<string>;
	sessions: Set<string>;
	corrections: number;
}

export function clusterObservations(observations: Observation[]): Map<string, Cluster> {
	const clusters = new Map<string, Cluster>();
	for (const observation of observations) {
		let cluster = clusters.get(observation.signature);
		if (!cluster) {
			cluster = { observations: [], projects: new Set(), sessions: new Set(), corrections: 0 };
			clusters.set(observation.signature, cluster);
		}
		cluster.observations.push(observation);
		cluster.projects.add(observation.project);
		cluster.sessions.add(`${observation.project}\n${observation.session}`);
		if (observation.kind === "correction") cluster.corrections++;
	}
	return clusters;
}

/** Corrections and cross-project recurrence weigh highest; single command
 * skeletons never reach this function as candidates. */
const KIND_BOOST: Record<Observation["kind"], number> = {
	correction: 3, "fix-arc": 2, "git-chain": 2, "mail-thread": 2, sequence: 1.5, "text-block": 1.5,
};

function clusterScore(cluster: Cluster): number {
	const recent = cluster.observations.filter(o => o.recent).length;
	const total = cluster.observations.length;
	const first = cluster.observations[0]!;
	const recency = total > 0 ? 1 + recent / total : 1;
	return Math.round(cluster.projects.size * cluster.projects.size * cluster.sessions.size * recency * KIND_BOOST[first.kind] * 100) / 100;
}

export function rankClusters(clusters: Map<string, Cluster>, firstSeen: Map<string, string>, nowISO: string): { candidates: SkillMineCandidate[]; dropped: number } {
	const candidates: SkillMineCandidate[] = [];
	let dropped = 0;
	for (const [signature, cluster] of clusters) {
		const first = cluster.observations[0]!;
		const sessions = cluster.sessions.size;
		const mailVoices = cluster.observations.filter(o => o.kind === "mail-thread").length;
		const keep = first.kind === "sequence" ? sessions >= 2
			// Boilerplate discount: first-user dispatch templates recurring widely,
			// and seat-bootstrap text confined to agent-tmp checkouts, never rank.
			: first.kind === "text-block" ? sessions >= 2 && !(cluster.observations.some(o => o.firstUser === true) && sessions >= 3)
				&& !(cluster.projects.size > 0 && [...cluster.projects].every(p => p.includes("/var/agent-tmp/")) && sessions >= 4)
			: first.kind === "correction" ? cluster.corrections >= 1
			: first.kind === "fix-arc" ? sessions >= 2
			: mailVoices >= 2;
		if (!keep) { dropped++; continue; }
		const projects = [...cluster.projects].sort();
		const evidence = cluster.observations.slice(0, 5).map(o => ({ source: (o.kind === "mail-thread" ? "mail" : "cass") as SkillMineEvidence["source"], ref: o.ref, quote: o.quote }));
		const fingerprint = fingerprintOf(first.workflow);
		const kinds = new Set(cluster.observations.map(o => o.kind));
		const why = [
			`seen in ${cluster.projects.size} project(s) across ${sessions} session(s)`,
			cluster.projects.size > 1 ? "cross-project" : null,
			cluster.corrections > 0 ? `${cluster.corrections} user correction(s)` : null,
			kinds.has("sequence") ? "ordered multi-step sequence" : null,
			kinds.has("text-block") ? "shared verbatim procedure text" : null,
			kinds.has("fix-arc") ? "error->fix arc" : null,
			kinds.has("mail-thread") ? "taught over mail" : null,
		].filter(Boolean).join("; ");
		candidates.push({
			workflow: first.workflow, summary: first.summary, projects,
			occurrences: cluster.observations.length,
			why_skill: `Same procedure ${why}; worth packaging. Signature: ${signature.slice(0, 100)}`,
			evidence, nearest_existing_skill: null, fingerprint,
			score: Math.round(clusterScore(cluster) * (first.kind === "text-block" && cluster.projects.size === 1 ? 0.5 : 1) * 100) / 100,
			first_seen: firstSeen.get(fingerprint) ?? nowISO,
		});
	}
	candidates.sort((a, b) => b.score - a.score || a.workflow.localeCompare(b.workflow));
	return { candidates, dropped };
}

export function dedupeCandidates(candidates: SkillMineCandidate[], skills: SkillIndexEntry[]): { kept: SkillMineCandidate[]; rejects: SkillMineReject[] } {
	const kept: SkillMineCandidate[] = [];
	const rejects: SkillMineReject[] = [];
	for (const candidate of candidates) {
		const candidateTokens = tokensOf(`${candidate.workflow} ${candidate.summary}`);
		let best: SkillIndexEntry | null = null;
		let bestOverlap = 0;
		for (const skill of skills) {
			const overlap = skillOverlap(candidateTokens, skill);
			if (overlap > bestOverlap) { bestOverlap = overlap; best = skill; }
		}
		if (best && bestOverlap >= SKILL_MINE_DEDUPE_OVERLAP) {
			candidate.nearest_existing_skill = best.name;
			rejects.push({ workflow: candidate.workflow, covering_skill: best.name, overlap: Math.round(bestOverlap * 100) / 100, score: candidate.score });
		} else {
			if (best) candidate.nearest_existing_skill = best.name;
			kept.push(candidate);
		}
	}
	return { kept, rejects };
}

type Ledger = Record<string, { first_seen: string; filed_bead?: string; filed_at?: string }>;

function ledgerPath(stateDir: string): string {
	return join(stateDir, "skill-mine", "ledger.json");
}

export function loadLedger(stateDir: string): Ledger {
	try {
		const raw = readFileSync(ledgerPath(stateDir), "utf8");
		const parsed = JSON.parse(raw) as unknown;
		if (parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)) return parsed as Ledger;
	} catch { /* first run */ }
	return {};
}

function saveLedger(stateDir: string, ledger: Ledger): void {
	mkdirSync(join(stateDir, "skill-mine"), { recursive: true, mode: 0o700 });
	writeFileSync(ledgerPath(stateDir), `${JSON.stringify(ledger, null, 2)}\n`, { mode: 0o600 });
}

function sinkPath(options: SkillMineOptions): string {
	if (options.sink) return options.sink;
	return join(options.stateDir, "skill-mine", "candidates.jsonl");
}

function appendSink(path: string, candidates: SkillMineCandidate[]): void {
	if (candidates.length === 0) return;
	mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
	const lines = candidates.map(candidate => `${JSON.stringify(candidate)}\n`).join("");
	appendFileSync(path, lines, { mode: 0o600 });
}

function owningProject(candidate: SkillMineCandidate): string | null {
	const counts = new Map<string, number>();
	for (const project of candidate.projects) counts.set(project, (counts.get(project) ?? 0) + 1);
	for (const [project] of [...counts.entries()].sort((a, b) => b[1] - a[1])) {
		try {
			if (statSync(project).isDirectory() && existsSync(join(project, ".beads"))) return project;
		} catch { /* not a local checkout */ }
	}
	return null;
}

/** Exported as a test seam for the per-project cap and max-new bound. */
export async function fileBeads(candidates: SkillMineCandidate[], options: SkillMineOptions, maxNew: number): Promise<{ filed: SkillMineBeadFiled[]; unfiled: { candidate: string; reason: string }[] }> {
	const filed: SkillMineBeadFiled[] = [];
	const unfiled: { candidate: string; reason: string }[] = [];
	if (!options.apply) return { filed, unfiled };
	const brBin = findOnPath("br", options.pathValue);
	if (brBin === null) {
		return { filed, unfiled: candidates.slice(0, maxNew).map(candidate => ({ candidate: candidate.workflow, reason: "br is not on PATH; filed nothing" })) };
	}
	const usedProjects = new Set<string>();
	for (const candidate of candidates.slice(0, maxNew)) {
		// Git recurrence packets are evidence for judgement, never auto-filed:
		// the skill-library seats judge these packets, so no bead carries
		// another repository's subjects, shas or paths.
		if (candidate.kind === "git-recurrence") {
			unfiled.push({ candidate: candidate.workflow, reason: "evidence packet for judgement; never auto-filed" });
			continue;
		}
		const project = owningProject(candidate);
		if (project === null) {
			unfiled.push({ candidate: candidate.workflow, reason: "no evidence project with a .beads dir; filed nothing" });
			continue;
		}
		if (usedProjects.has(project)) {
			unfiled.push({ candidate: candidate.workflow, reason: `max 1 bead per project per run; ${project} already used` });
			continue;
		}
		const title = `SKILLCAND: ${candidate.workflow}`;
		const description = `${candidate.summary}\n\nEvidence:\n${candidate.evidence.map(e => `- [${e.source}] ${e.ref}: ${e.quote}`).join("\n")}\nFingerprint: ${candidate.fingerprint}`;
		// The first resolved skills root is where an admitted skill lands; the box checks that exact path.
		const skillsRoot = (options.skillsDirs ?? defaultSkillsDirs(options.home))[0] ?? join(options.home, ".agents", "skills");
		const acceptance = `- [ ] [landed] skill pack exists: test -f "${join(skillsRoot, candidate.workflow, "SKILL.md")}" -> rc 0`;
		let result;
		try {
			result = await run([brBin, "create", "--title", title, "--type", "task", "--description", description, "--acceptance-criteria", acceptance],
				{ cwd: project, env: { HOME: options.home, PATH: options.pathValue }, deadline_s: 30, max_output_bytes: 64 * 1024 });
		} catch (error) {
			unfiled.push({ candidate: candidate.workflow, reason: error instanceof Error ? error.message : String(error) });
			continue;
		}
		if (result.timed_out || result.rc !== 0) {
			unfiled.push({ candidate: candidate.workflow, reason: `br create exited ${result.rc}: ${Buffer.from(result.stderr).toString("utf8").slice(0, 200)}` });
			continue;
		}
		const id = /([A-Za-z0-9._-]{3,64})/.exec(Buffer.from(result.stdout).toString("utf8"))?.[1] ?? "unknown";
		usedProjects.add(project);
		filed.push({ candidate: candidate.workflow, fingerprint: candidate.fingerprint, project, bead: id });
	}
	return { filed, unfiled };
}

function lastRunPath(stateDir: string): string {
	return join(stateDir, "skill-mine", "last-run.json");
}

export async function runSkillMine(options: SkillMineOptions): Promise<SkillMineReport> {
	const started = Date.now();
	const now = options.now ?? started;
	const nowISO = new Date(now).toISOString();
	const sinceMs = parseSinceMs(options.since, now);
	// One wall budget for the whole mining pass: cass, then Git, stop when it is gone.
	const wallBudgetS = options.wallBudgetS ?? SKILL_MINE_WALL_BUDGET_S;
	const deadlineMs = Date.now() + Math.max(0, wallBudgetS) * 1000;
	const cass = await mineCass(options, sinceMs, deadlineMs);
	const mailArchive = options.mailArchive ?? await liveMailRoot(options) ?? undefined;
	const mail = mineMail(mailArchive === undefined ? options : { ...options, mailArchive }, sinceMs);
	const { skills, count: skillCount } = readSkillsIndex(options.skillsDirs ?? defaultSkillsDirs(options.home));
	const ledger = loadLedger(options.stateDir);
	const firstSeen = new Map<string, string>(Object.entries(ledger).map(([fp, row]) => [fp, row.first_seen]));
	const git = await mineGit(options, sinceMs, now, cass.workspaces, deadlineMs, firstSeen, nowISO);
	const observations = [...cass.observations, ...mail.observations];
	const clusters = clusterObservations(observations);
	const { candidates: ranked } = rankClusters(clusters, firstSeen, nowISO);
	const { kept, rejects } = dedupeCandidates([...ranked, ...git.candidates], skills);
	const fresh = kept.filter(candidate => ledger[candidate.fingerprint] === undefined);
	for (const candidate of fresh) ledger[candidate.fingerprint] = { first_seen: candidate.first_seen };
	const sink = sinkPath(options);
	appendSink(sink, fresh);
	const maxNew = Math.min(Math.max(options.maxNew ?? SKILL_MINE_MAX_NEW_DEFAULT, 0), 25);
	const { filed, unfiled } = await fileBeads(fresh, options, maxNew);
	for (const row of filed) {
		const entry = ledger[row.fingerprint];
		if (entry) {
			entry.filed_bead = row.bead;
			entry.filed_at = nowISO;
		}
	}
	saveLedger(options.stateDir, ledger);
	const projects = new Set<string>();
	for (const candidate of fresh) for (const project of candidate.projects) projects.add(project);
	// The pack is the judging agent's daily read: it carries the current top clusters (kept, ranked), so a cluster
	// recurring every day stays visible; the sink and --apply stay limited to never-seen fingerprints.
	const pack = writeSkillMinePack(options.stateDir, nowISO.slice(0, 10), kept);
	const report: SkillMineReport = {
		overall: cass.status.status === "OK" || mail.status.status === "OK" || git.status.status === "OK" ? "OK" : "UNVERIFIED",
		sources: {
			cass: cass.status.status === "OK" ? { ...cass.status, reason: `${cass.status.reason}; skills indexed: ${skillCount}` } : cass.status,
			mail: mail.status,
			git: git.status,
		},
		candidates: fresh, rejects,
		projects_with_candidates: projects.size,
		beads_filed: filed, unfiled, sink,
		coverage: { ...cass.coverage, git: git.coverage },
		pack,
		elapsed_ms: Date.now() - started,
	};
	try {
		mkdirSync(join(options.stateDir, "skill-mine"), { recursive: true, mode: 0o700 });
		writeFileSync(lastRunPath(options.stateDir), `${JSON.stringify({
			last_run: nowISO, sources: report.sources,
			candidates_total: fresh.length, projects_with_candidates: projects.size,
			beads_filed: filed.map(row => row.bead),
			git: { repos: git.coverage.repos, months_mined: git.coverage.months_mined.length, months_remaining: git.coverage.months_remaining, repos_detail: git.coverage.repos_detail, chains_seen: git.coverage.chains_seen, chains_unclustered: git.coverage.chains_unclustered, chains_evicted: git.coverage.chains_evicted },
		})}\n`, { mode: 0o600 });
	} catch { /* status is best effort */ }
	return report;
}

export function readSkillMineStatus(stateDir: string): SkillMineStatusReport {
	try {
		const raw = JSON.parse(readFileSync(lastRunPath(stateDir), "utf8")) as {
			last_run?: unknown; sources?: unknown; candidates_total?: unknown; projects_with_candidates?: unknown; beads_filed?: unknown; git?: unknown;
		};
		const gitRaw = raw.git as { repos?: unknown; months_mined?: unknown; months_remaining?: unknown; repos_detail?: unknown; chains_seen?: unknown; chains_unclustered?: unknown; chains_evicted?: unknown } | null | undefined;
		const reposDetail = gitRaw !== null && typeof gitRaw === "object" && gitRaw !== undefined && gitRaw.repos_detail !== null && typeof gitRaw.repos_detail === "object" && !Array.isArray(gitRaw.repos_detail)
			? gitRaw.repos_detail as Record<string, SkillMineGitRepoCoverage>
			: null;
		return {
			configured: true,
			last_run: typeof raw.last_run === "string" ? raw.last_run : null,
			sources: (raw.sources ?? null) as SkillMineStatusReport["sources"],
			candidates_total: typeof raw.candidates_total === "number" ? raw.candidates_total : 0,
			projects_with_candidates: typeof raw.projects_with_candidates === "number" ? raw.projects_with_candidates : 0,
			beads_filed: Array.isArray(raw.beads_filed) ? raw.beads_filed.filter((b): b is string => typeof b === "string") : [],
			git: gitRaw !== null && typeof gitRaw === "object" && gitRaw !== undefined && typeof gitRaw.repos === "number" && reposDetail !== null ? {
				repos: gitRaw.repos,
				months_mined: typeof gitRaw.months_mined === "number" ? gitRaw.months_mined : 0,
				months_remaining: typeof gitRaw.months_remaining === "number" ? gitRaw.months_remaining : 0,
				repos_detail: reposDetail,
				chains_seen: typeof gitRaw.chains_seen === "number" ? gitRaw.chains_seen : 0,
				chains_unclustered: typeof gitRaw.chains_unclustered === "number" ? gitRaw.chains_unclustered : 0,
				chains_evicted: typeof gitRaw.chains_evicted === "number" ? gitRaw.chains_evicted : 0,
			} : null,
		};
	} catch {
		return { configured: false, last_run: null, sources: null, candidates_total: 0, projects_with_candidates: 0, beads_filed: [], git: null };
	}
}

export function renderSkillMineText(report: SkillMineReport): string {
	const lines = [
		`skill-mine: ${report.overall} in ${report.elapsed_ms} ms; sink ${report.sink}`,
		`cass: ${report.sources.cass.status} (${report.sources.cass.reason})`,
		`mail: ${report.sources.mail.status} (${report.sources.mail.reason})`,
		`git: ${report.sources.git.status} (${report.sources.git.reason})`,
		`coverage: ${report.coverage.sessions_mined}/${report.coverage.sessions_in_window} mined, ${report.coverage.skipped_oversize} oversize, stopped_early=${report.coverage.stopped_early}, truncated=${report.coverage.list_truncated}`,
		`candidates: ${report.candidates.length}; rejects: ${report.rejects.length}; projects: ${report.projects_with_candidates}; beads filed: ${report.beads_filed.length}`,
	];
	for (const candidate of report.candidates.slice(0, 10)) {
		lines.push(`- ${candidate.workflow} score=${candidate.score} projects=${candidate.projects.length} occ=${candidate.occurrences} fp=${candidate.fingerprint}`);
		lines.push(`  ${candidate.summary}`);
		for (const evidence of candidate.evidence.slice(0, 2)) lines.push(`  [${evidence.source}] ${evidence.ref}: ${evidence.quote}`);
	}
	for (const reject of report.rejects.slice(0, 10)) {
		lines.push(`x ${reject.workflow} covered by ${reject.covering_skill} (overlap ${reject.overlap})`);
	}
	return lines.join("\n");
}


/** Maximum evidence-pack bytes: a cold agent reads this without negotiation. */
export const SKILL_MINE_PACK_BYTES_CAP = 60 * 1024;
/** Top clusters per procedure kind included in the pack. */
export const SKILL_MINE_PACK_PER_KIND = 5;

const PACK_KINDS: Observation["kind"][] = ["git-chain", "sequence", "text-block", "correction", "fix-arc", "mail-thread"];

const PACK_KIND_TITLE: Record<Observation["kind"], string> = {
	"git-chain": "Git recurrence evidence for judgement",
	sequence: "Ordered multi-step sequences",
	"text-block": "Shared verbatim procedure text",
	correction: "Correction clusters",
	"fix-arc": "Error->fix arcs",
	"mail-thread": "Mail teaching threads",
};

/** Evidence pack for the judging agent: top clusters per procedure kind with
 * verbatim redacted quotes, refs, projects, counts and nearest-skill notes.
 * Bounded to SKILL_MINE_PACK_BYTES_CAP; excess clusters are cut with a marker. */
export function buildSkillMinePack(candidates: SkillMineCandidate[]): string {
	const lines = [
		"# skill-mine evidence pack",
		"",
		"Procedures mined from agent history for skill abstraction. Each cluster lists",
		"verbatim quotes (secret-redacted), evidence refs (session path + message index,",
		"or mail project + message id), projects, occurrence counts and the nearest",
		"installed skill (null means no installed skill covers it).",
		"",
	];
	const byKind = new Map<Observation["kind"], SkillMineCandidate[]>();
	for (const candidate of candidates) {
		const kind = PACK_KINDS.find(kind => candidate.why_skill.includes(kind === "git-chain" ? "git-proven"
			: kind === "sequence" ? "ordered multi-step"
			: kind === "text-block" ? "verbatim"
			: kind === "correction" ? "correction"
			: kind === "fix-arc" ? "error->fix" : "taught over mail"));
		if (kind === undefined) continue;
		const list = byKind.get(kind) ?? [];
		list.push(candidate);
		byKind.set(kind, list);
	}
	let truncated = false;
	outer: for (const kind of PACK_KINDS) {
		const list = (byKind.get(kind) ?? []).sort((a, b) => b.score - a.score).slice(0, SKILL_MINE_PACK_PER_KIND);
		if (list.length === 0) continue;
		lines.push(`## ${PACK_KIND_TITLE[kind]}`, "");
		for (const candidate of list) {
			lines.push(`### ${candidate.workflow}`, "", candidate.summary, "",
				`projects: ${candidate.projects.join(", ") || "(none)"}`,
				`occurrences: ${candidate.occurrences}; score: ${candidate.score}; first_seen: ${candidate.first_seen}`,
				`nearest_existing_skill: ${candidate.nearest_existing_skill ?? "null"}`,
				"evidence:");
			for (const evidence of candidate.evidence.slice(0, 4)) {
				lines.push(`- [${evidence.source}] ${evidence.ref}: ${evidence.quote.slice(0, 300)}`);
			}
			lines.push("");
			if (Buffer.byteLength(lines.join("\n"), "utf8") > SKILL_MINE_PACK_BYTES_CAP) { truncated = true; break outer; }
		}
	}
	if (truncated) lines.push("[pack truncated at 60 KB; remaining clusters omitted]");
	return lines.join("\n");
}

/** Write the evidence pack beside the sink and ledger; returns its path. */
export function writeSkillMinePack(stateDir: string, dateISO: string, candidates: SkillMineCandidate[]): string {
	const path = join(stateDir, "skill-mine", `pack-${dateISO}.md`);
	mkdirSync(join(stateDir, "skill-mine"), { recursive: true, mode: 0o700 });
	const body = buildSkillMinePack(candidates).slice(0, SKILL_MINE_PACK_BYTES_CAP);
	writeFileSync(path, body.endsWith("\n") ? body : `${body}\n`, { mode: 0o600 });
	return path;
}
