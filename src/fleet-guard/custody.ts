import { createHash } from "node:crypto";
import { isAbsolute, normalize, resolve } from "node:path";
//
// Kit-owned enforcement; projects own DATA (held paths, handoffs), never
// enforcement code. Every refusal names its condition.
//
// Supported in-project route for the one legitimate change: the project
// director appends one ownerHandoffs row only when the worktree blob of the
// path equals the blob of the named arc commit at that path
// (git hash-object == git rev-parse <commit>:<path>). Workers, wrong blobs,
// foreign repos/DBs, import/export flags, and direct edits to
// manifests/module/trackerRowExceptions stay denied. Reads (br list/show/
// ready, bv --robot-*) never need a lease; br update/close do.


export interface HandoffRow {
	path: string;
	blob: string;
	commit: string;
	bead: string;
	signedBy: string;
}

export interface CustodyPolicy {
	/** Repo root the policy applies to (exact match required). */
	repoRoot: string;
	/** Held data paths (adoption requires a digest-bound director handoff). */
	heldPaths: readonly string[];
	/** Code/config that no in-project tool call may change. */
	protectedPaths: readonly string[];
	ownerHandoffs: readonly HandoffRow[];
	director: string;
}
export interface CustodyEvent {
	toolName?: unknown;
	input?: unknown;
	command?: unknown;
	cwd?: unknown;
}

export interface CustodyBlock {
	block: true;
	reason: string;
}

export type CustodyVerdict = "ALLOWED" | "DENIED";

const HEX40 = /^[0-9a-f]{40}$/;

function commandOf(event: CustodyEvent): string | undefined {
	if (typeof event.command === "string" && event.command.trim()) return event.command;
	const input = event.input as Record<string, unknown> | undefined;
	if (input !== undefined && input !== null && typeof input === "object" && typeof input.command === "string") return input.command;
	return undefined;
}

function eventCwd(event: CustodyEvent, fallback: string): string {
	const raw = typeof event.cwd === "string" && event.cwd ? event.cwd : fallback;
	return raw;
}

function normRepoPath(repoRoot: string, cwd: string, candidate: string): string | null {
	try {
		const abs = isAbsolute(candidate) ? normalize(candidate) : resolve(cwd, candidate);
		const root = normalize(repoRoot);
		if (abs !== root && !abs.startsWith(root.endsWith("/") ? root : `${root}/`)) return null;
		return abs.slice(root.length).replace(/^\//, "");
	} catch {
		return null;
	}
}

/** Manifest / module / trackerRowExceptions markers: never writable in-project. */
export function isProtectedTarget(policy: CustodyPolicy, repoPath: string): boolean {
	if (policy.protectedPaths.some((p) => repoPath === p || repoPath.endsWith(`/${p}`))) return true;
	const base = repoPath.split("/").pop() ?? repoPath;
	if (base === ".omp" || repoPath.startsWith(".omp/extensions/")) return true;
	if (repoPath === ".omp/custody.json" || repoPath === ".omp/held-path-custody.json") return true;
	if (/manifest/i.test(base)) return true;
	if (/trackerRowExceptions/i.test(repoPath)) return true;
	return false;
}

export function isHeldTarget(policy: CustodyPolicy, repoPath: string): boolean {
	return policy.heldPaths.some((p) => repoPath === p || repoPath.endsWith(`/${p}`));
}

// --- Hashline edit payload parsing (mirrors @oh-my-pi/hashline tokenizer) ---
// OMP's edit tool passes the target inside its opaque `input` string, so
// input.path is undefined. Parse every column-0 [PATH#4hex] header plus every
// MV DEST row. Fail closed as opaque: no header, non-string input, any [-line
// that is not a strict tagged header, or any unresolvable target.

const TAGGED_HEADER = /^\[([^\]#\n]+)#([0-9a-fA-F]{4})\]/;
const MV_ROW = /^MV\s+(\S+)\s+(\S+)\s*$/;

export type HashlineTargets = { kind: "targets"; paths: string[] } | { kind: "opaque"; reason: string };

export function parseHashlineTargets(input: unknown): HashlineTargets {
	if (typeof input !== "string") return { kind: "opaque", reason: "non-string edit payload" };
	const lines = input.split("\n");
	const paths: string[] = [];
	let sawHeader = false;
	for (const line of lines) {
		if (line.startsWith("MV ")) {
			const m = MV_ROW.exec(line);
			if (m) paths.push(m[1], m[2]);
			continue;
		}
		if (!line.startsWith("[")) continue;
		const m = TAGGED_HEADER.exec(line);
		if (!m) return { kind: "opaque", reason: `unparseable [-line: ${line.slice(0, 60)}` };
		sawHeader = true;
		paths.push(m[1]);
	}
	if (!sawHeader && paths.length === 0) return { kind: "opaque", reason: "no parseable target header" };
	return { kind: "targets", paths };
}

function fileTargets(event: CustodyEvent): { kind: "path"; value: string } | { kind: "hashline"; value: string } | undefined {
	const input = event.input as Record<string, unknown> | undefined;
	if (input !== undefined && input !== null && typeof input === "object" && typeof input.path === "string" && input.path) {
		return { kind: "path", value: input.path };
	}
	const name = (typeof event.toolName === "string" ? event.toolName : "").toLowerCase();
	if (/(?:^|[._/-])edit(?:[-_]?file)?$/.test(name)) {
		if (input !== undefined && input !== null && typeof input === "object" && typeof input.input === "string") {
			return { kind: "hashline", value: input.input };
		}
		if (typeof event.input === "string") return { kind: "hashline", value: event.input };
		return { kind: "hashline", value: "" };
	}
	if (input !== undefined && input !== null && typeof input === "object" && typeof input.input === "string" && /\[.+#[0-9a-fA-F]{4}\]/.test(input.input)) {
		return { kind: "hashline", value: input.input };
	}
	return undefined;
}

/** File-tool check: protected always DENIED; held DENIED unless a digest-bound director handoff row covers it. */
export function checkCustodyFileTool(event: CustodyEvent, policy: CustodyPolicy, repoRoot: string, cwd: string): CustodyBlock | undefined {
	const target = fileTargets(event);
	if (!target) return undefined;
	const candidates: string[] =
		target.kind === "path" ? [target.value] : (() => {
			const parsed = parseHashlineTargets(target.value);
			if (parsed.kind === "opaque") {
				return [];
			}
			return parsed.paths;
		})();
	if (target.kind === "hashline") {
		const parsed = parseHashlineTargets(target.value);
		if (parsed.kind === "opaque") {
			return { block: true, reason: `custody file: opaque edit payload denied (${parsed.reason}); no resolvable target` };
		}
	}
	for (const candidate of candidates) {
		const repoPath = normRepoPath(repoRoot, cwd, candidate);
		if (repoPath === null) {
			return { block: true, reason: "custody file: target is missing, outside the canonical project, or cannot be resolved safely" };
		}
		if (isProtectedTarget(policy, repoPath)) {
			return { block: true, reason: `custody file: protected target denied (${repoPath}); manifests, module and trackerRowExceptions cannot change through this admission path` };
		}
		if (isHeldTarget(policy, repoPath)) {
			const handoff = policy.ownerHandoffs.find((row) => row.path === repoPath || repoPath.endsWith(`/${row.path}`));
			if (!handoff) return { block: true, reason: `custody file: held path denied (${repoPath}); adoption needs a digest-bound director handoff, not a direct edit` };
		}
	}
	return undefined;
}

// --- Read-only bash ---

const READONLY_NTM_WAIT = /^ntm\s+wait(\s|$)/;
const NTM_HELP = /^ntm\s+\S+\s+(--help|-h)\s*$/;

/** ntm wait (any flags) and ntm <sub> --help/-h are read-only; send/spawn/kill stay denied. */
export function isReadOnlyCustodyBash(command: string): boolean {
	if (command.length > 4096) return false;
	let rest = command.trim();
	const cdPrefix = /^cd\s+\S+\s*&&\s*/.exec(rest);
	if (cdPrefix) rest = rest.slice(cdPrefix[0].length).trim();
	const envPrefix = /^(?:env\s+[A-Za-z_][A-Za-z0-9_]*=\S+\s+)+/.exec(rest);
	if (envPrefix) rest = rest.slice(envPrefix[0].length);
	const rooted = /^([\w./-]+\/)?ntm(\s|$)/.exec(rest);
	if (rooted) rest = `ntm${rooted[2]}${rest.slice(rooted[0].length)}`;
	if (READONLY_NTM_WAIT.test(rest)) return true;
	if (NTM_HELP.test(rest)) return true;
	return false;
}

const DENIED_MUTATING = [/^ntm\s+(send|spawn|kill)\b/, /\btmux\s+kill-server\b/, /\brm\s+-rf\b/, /\bDROP\s+(TABLE|DATABASE)\b/i];

export function checkCustodyBash(event: CustodyEvent, _policy: CustodyPolicy): CustodyBlock | undefined {
	const command = commandOf(event);
	if (!command) return undefined;
	if (isReadOnlyCustodyBash(command)) return undefined;
	for (const pattern of DENIED_MUTATING) {
		if (pattern.test(command)) {
			return { block: true, reason: `custody bash: mutating command denied (${pattern.source}); held-path work uses the director handoff route` };
		}
	}
	return undefined;
}

// --- Tracker: reads free, writes need a lease; director handoff is the one admitted write ---

const READONLY_TRACKER = /^\s*(br\s+(list|show|ready)\b|bv\s+--robot)/;
const TRACKER_WRITE = /^\s*br\s+(update|close|label\s+add|create|import|export)\b/;

export function checkCustodyTracker(
	event: CustodyEvent,
	policy: CustodyPolicy,
	actor: CustodyActor,
	repoRoot: string,
	git: CustodyGit,
	append?: (row: HandoffRow) => void,
): CustodyBlock | undefined {
	const command = commandOf(event);
	if (!command) return undefined;
	const cwd = eventCwd(event, repoRoot);
	if (cwd !== normalize(repoRoot) && !cwd.startsWith(normalize(repoRoot) + "/")) {
		if (TRACKER_WRITE.test(command)) {
			return { block: true, reason: "custody tracker: foreign repo or DB refused; the command names a path outside the canonical project" };
		}
	}
	if (READONLY_TRACKER.test(command)) return undefined;
	// Director handoff append: `br handoff add --path P --commit C --bead B`.
	const handoff = /^\s*br\s+handoff\s+add\s+--path\s+(\S+)\s+--commit\s+(\S+)\s+--bead\s+(\S+)/.exec(command);
	if (handoff) {
		const [, path, commit, bead] = handoff;
		if (!actor.isDirector) {
			return { block: true, reason: `custody handoff: worker identity refused (${actor.name}); only the project director may sign a handoff row` };
		}
		if (/\b(import|export)\b/.test(command)) {
			return { block: true, reason: "custody handoff: import/export flags refused on a handoff row" };
		}
		const blob = git.hashObject(repoRoot, path);
		const named = git.revParse(repoRoot, commit, path);
		if (!blob || !named || !HEX40.test(blob) || !HEX40.test(named)) {
			return { block: true, reason: "custody handoff: blob could not be resolved; refusing without byte evidence" };
		}
		if (blob !== named) {
			return { block: true, reason: `custody handoff: blob drift refused (worktree ${blob.slice(0, 12)} != ${commit}:${path} ${named.slice(0, 12)})` };
		}
		const repoPath = normRepoPath(repoRoot, cwd, path);
		if (repoPath === null || !isHeldTarget(policy, repoPath)) {
			return { block: true, reason: `custody handoff: not a held path (${path}); unrelated paths stay denied` };
		}
		append?.({ path: repoPath, blob, commit, bead, signedBy: actor.name });
		return undefined;
	}
	if (TRACKER_WRITE.test(command)) {
		if (/\bbr\s+(import|export)\b/.test(command)) {
			return { block: true, reason: "custody tracker: import/export flags refused" };
		}
		return { block: true, reason: `custody tracker: write without an exact lease denied (${command.trim().slice(0, 48)}); reads (br list/show/ready, bv --robot-*) need no lease` };
	}
	return undefined;
}

// --- Guard's own probe: verdicts for planted checks ---

export interface CustodyProbeDeps {
	actor: CustodyActor;
	git: CustodyGit;
}

export function createCustodyToolCallHandler(policy: CustodyPolicy, deps: CustodyProbeDeps) {
	return (event: CustodyEvent): { verdict: CustodyVerdict; reason: string } => {
		const cwd = eventCwd(event, policy.repoRoot);
		const fileBlock = checkCustodyFileTool(event, policy, policy.repoRoot, cwd);
		if (fileBlock) return { verdict: "DENIED", reason: fileBlock.reason };
		const bashBlock = checkCustodyBash(event, policy);
		if (bashBlock) return { verdict: "DENIED", reason: bashBlock.reason };
		const trackerBlock = checkCustodyTracker(event, policy, deps.actor, policy.repoRoot, deps.git);
		if (trackerBlock) return { verdict: "DENIED", reason: trackerBlock.reason };
		const target = fileTargets(event);
		if (target) {
			const candidates = target.kind === "path" ? [target.value] : ((p) => (p.kind === "targets" ? p.paths : []))(parseHashlineTargets(target.value));
			for (const candidate of candidates) {
				const repoPath = normRepoPath(policy.repoRoot, cwd, candidate);
				if (repoPath !== null) {
					const handoff = policy.ownerHandoffs.find((row) => row.path === repoPath || repoPath.endsWith(`/${row.path}`));
					if (handoff) return { verdict: "ALLOWED", reason: `custody probe: digest-bound handoff row allows ${repoPath} (blob ${handoff.blob.slice(0, 12)}, bead ${handoff.bead})` };
				}
			}
		}
		const command = commandOf(event);
		if (command && /^\s*br\s+handoff\s+add\b/.test(command)) {
			return { verdict: "ALLOWED", reason: "custody probe: director handoff append admitted (blob == named commit)" };
		}
		return { verdict: "ALLOWED", reason: "custody probe: no held or protected target touched" };
	};
}

// --- Protected apply: kit digest-checked director replacement of guard module/policy ---

export interface ProjectGuardApplyInput {
	project: string;
	fromCommit: string;
	expectSha256: string;
	sourceBytes: string;
	callerIsDirector: boolean;
}

export interface ProjectGuardApplyResult {
	ok: boolean;
	reason: string;
	beforeSha256?: string;
	afterSha256?: string;
	undo?: { project: string; beforeSha256: string; afterSha256: string };
}

export function applyProjectGuard(
	input: ProjectGuardApplyInput,
	currentBytes: string,
	recordUndo: (undo: { project: string; beforeSha256: string; afterSha256: string }) => void,
	hash: (bytes: string) => string = (b) => createHash("sha256").update(b, "utf8").digest("hex"),
): ProjectGuardApplyResult {
	if (!input.callerIsDirector) {
		return { ok: false, reason: `custody apply: worker identity refused; only the ${input.project} director may replace guard code or policy` };
	}
	const actual = hash(input.sourceBytes);
	if (actual !== input.expectSha256) {
		return { ok: false, reason: `custody apply: digest mismatch refused (expected ${input.expectSha256.slice(0, 24)}, got ${actual.slice(0, 24)}); source blob at ${input.fromCommit} untrusted` };
	}
	const before = hash(currentBytes);
	const after = actual;
	recordUndo({ project: input.project, beforeSha256: before, afterSha256: after });
	return { ok: true, reason: `custody apply: ${input.project} guard replaced from ${input.fromCommit} (before ${before.slice(0, 24)}, after ${after.slice(0, 24)})`, beforeSha256: before, afterSha256: after, undo: { project: input.project, beforeSha256: before, afterSha256: after } };
}

/** Doctor: a pane whose loaded guard bytes differ from disk must resume. */
export function doctorStaleGuard(loadedSha256: string | undefined, diskSha256: string): { stale: boolean; reason: string } {
	if (!loadedSha256) return { stale: true, reason: "custody doctor: pane reports no loaded guard digest; resume to load the on-disk guard" };
	if (loadedSha256 !== diskSha256) {
		return { stale: true, reason: `custody doctor: loaded guard older than disk (loaded ${loadedSha256.slice(0, 16)}, disk ${diskSha256.slice(0, 16)}); resume the pane on the same session` };
	}
	return { stale: false, reason: "custody doctor: loaded guard matches disk" };
}
