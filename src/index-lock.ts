import { appendFileSync, closeSync, mkdirSync, openSync, readdirSync, realpathSync, renameSync, statSync, unlinkSync } from "node:fs";
import { dirname, join } from "node:path";
import type { ScratchRunner } from "./scratch.ts";

/**
 * Guarded stale index.lock dry-run reporter (ompkit-rz5.101).
 *
 * Predicate (all three, in order): the lock is EMPTY (a non-empty lock is
 * never touched — e.g. localbench's 71 KB interrupted write is a director
 * one-off, not kit-mover work); older than the configured age; lsof shows
 * no holder. A dry-run returns a receipt and never renames the lock.
 *
 * Age threshold: read from configuration, never pinned. The reporter reads
 * OMP_KIT_INDEX_LOCK_STALE_MS (positive integer milliseconds); the default
 * is 600000 (10 min). Derivation: legitimate index writes take seconds, so
 * 10 min sits orders above any single write; a queued commit hook can hold
 * longer (SUITE_VERDICT_WAIT default 7200 s), but a queued holder keeps the
 * lock visibly held, so the lsof gate — not the age — carries that safety.
 * Age exists to avoid racing a just-created lock against lsof TOCTOU.
 */
export const DEFAULT_INDEX_LOCK_STALE_MS = 600_000;

export function indexLockStaleAfterMs(env: Record<string, string | undefined> = process.env): number {
	const raw = env.OMP_KIT_INDEX_LOCK_STALE_MS;
	if (raw === undefined || raw.trim() === "") return DEFAULT_INDEX_LOCK_STALE_MS;
	const parsed = Number(raw);
	if (!Number.isInteger(parsed) || parsed <= 0) return DEFAULT_INDEX_LOCK_STALE_MS;
	return parsed;
}
export type LockVerdict =
	| "NOT_FOUND"
	| "NON_EMPTY"
	| "TOO_YOUNG"
	| "UNKNOWN"
	| "APPLY_REFUSED"
	| "HELD"
	| "WOULD_MOVE"
	| "CHANGED"
	| "BUSY";
export interface LockMoveReceipt {
	lock: string;
	movedTo: string;
	guardPath: string;
	dev: number;
	ino: number;
	sizeBytes: number;
	mtimeMs: number;
	ageMs: number;
	staleAfterMs: number;
	atMs: string;
}

export interface LsofFileResult {
	/** true = rc 1 with empty output (clear); false = holders listed; null = unknown. */
	clear: boolean | null;
}

/**
 * Tri-state lsof for one file. ONLY rc 1 with empty stdout counts as clear.
 * rc 0 means matches were listed (held). Anything else — rc 2, signal or
 * timeout (code null), spawn failure, unparseable output, lsof errors — is
 * UNKNOWN and the lock stays untouched.
 */
export function lsofFileClear(path: string, run: ScratchRunner, timeoutMs = 15000): boolean | null {
	let out;
	try {
		out = run(["lsof", path], { timeoutMs });
	} catch {
		return null;
	}
	if (out.code === null) return null;
	const text = `${out.stdout}\n${out.stderr}`;
	if (/command not found/i.test(text) || /lsof:.*(not found|No such file)/i.test(text)) return null;
	if (/^lsof:/m.test(text)) return null;
	if (out.code === 1 && out.stdout.trim() === "") return true;
	if (out.code === 0) return false;
	return null;
}

export interface MoveDeps {
	run: ScratchRunner;
	nowMs?: () => number;
	lsofTimeoutMs?: number;
	dryRun?: boolean;
	staleAfterMs?: number;
}

/**
 * Stale Git index.lock handling is dry-run-only here. The final-stat-to-rename
 * syscall window is nonzero; a link-back cannot restore writer exclusion if
 * another process takes the lock name, so this reporter never renames.
 * The gated apply path lives below in reapStaleIndexLock (ompkit-fp72.19.1.9,
 * J-2026-10-18-48): it stacks empty + age + lsof + git-cwd + identity gates
 * and renames (never unlinks) with a ledger receipt.
 */
export function maybeMoveStaleIndexLock(
	gitDir: string,
	deps: MoveDeps,
): { verdict: LockVerdict; receipt?: LockMoveReceipt } {
	if (deps.dryRun !== true) return { verdict: "APPLY_REFUSED" };
	let repoGitDir: string;
	try {
		repoGitDir = realpathSync(gitDir);
	} catch {
		return { verdict: "UNKNOWN" };
	}
	const lock = join(repoGitDir, "index.lock");
	const guardPath = join(repoGitDir, ".omp-kit-index-lock-mover");
	let guardFd: number;
	try {
		guardFd = openSync(guardPath, "wx", 0o600);
	} catch (error) {
		if (typeof error === "object" && error !== null && "code" in error && error.code === "EEXIST") {
			return { verdict: "BUSY" };
		}
		return { verdict: "UNKNOWN" };
	}

	let result: { verdict: LockVerdict; receipt?: LockMoveReceipt };
	try {
		result = (() => {
			let stat;
			try {
				stat = statSync(lock);
			} catch {
				return { verdict: "NOT_FOUND" as const };
			}
			if (!stat.isFile() || stat.size !== 0) return { verdict: "NON_EMPTY" as const };
			const now = deps.nowMs ? deps.nowMs() : Date.now();
			const staleAfter = deps.staleAfterMs ?? DEFAULT_INDEX_LOCK_STALE_MS;
			if (now - stat.mtimeMs < staleAfter) return { verdict: "TOO_YOUNG" as const };
			const clear = lsofFileClear(lock, deps.run, deps.lsofTimeoutMs ?? 15000);
			if (clear === null) return { verdict: "UNKNOWN" as const };
			if (!clear) return { verdict: "HELD" as const };
			let current;
			try {
				current = statSync(lock);
			} catch {
				return { verdict: "CHANGED" as const };
			}
			if (!current.isFile() || current.dev !== stat.dev || current.ino !== stat.ino
				|| current.size !== stat.size || current.mtimeMs !== stat.mtimeMs) return { verdict: "CHANGED" as const };
			const movedTo = `${lock}.stale-${new Date(now).toISOString().replace(/[:.]/g, "-")}`;
			const observation: LockMoveReceipt = {
				lock, movedTo, guardPath, dev: stat.dev, ino: stat.ino, sizeBytes: stat.size,
				mtimeMs: stat.mtimeMs, ageMs: now - stat.mtimeMs, staleAfterMs: staleAfter,
				atMs: new Date(now).toISOString(),
			};
			return { verdict: "WOULD_MOVE" as const, receipt: observation };
		})();
	} catch {
		result = { verdict: "UNKNOWN" };
	}

	let cleanupFailed = false;
	try {
		closeSync(guardFd);
	} catch {
		cleanupFailed = true;
	}
	try {
		unlinkSync(guardPath);
	} catch {
		cleanupFailed = true;
	}
	if (cleanupFailed) return result.receipt ? { verdict: "UNKNOWN", receipt: result.receipt } : { verdict: "UNKNOWN" };
	return result;
}

/**
 * Gated stale-lock reaper (ompkit-fp72.19.1.9 GITLOCK1, decision J-2026-10-18-48).
 *
 * Gates, in order, for each candidate (index.lock and next-index-*.lock):
 * EMPTY (non-empty is never touched) -> older than staleAfterMs (default
 * 120 s: legitimate index writes take seconds, and the fleet-watch tick that
 * drives this runs on the order of a minute, so 120 s sits above one missed
 * tick plus one slow hook chain) -> lsof shows no holder -> no live `git`
 * process has the repo root as cwd -> dev/ino/size/mtime recheck ->
 * rename aside (never unlink: the bytes stay as evidence and the name is
 * freed) with a receipt appended to the ledger. Any UNKNOWN keeps the lock.
 */
export const DEFAULT_REAP_STALE_MS = 120_000;

export function reapStaleAfterMs(env: Record<string, string | undefined> = process.env): number {
	const raw = env.OMP_KIT_GITLOCK_REAP_STALE_MS;
	if (raw === undefined || raw.trim() === "") return DEFAULT_REAP_STALE_MS;
	const parsed = Number(raw);
	if (!Number.isInteger(parsed) || parsed <= 0) return DEFAULT_REAP_STALE_MS;
	return parsed;
}

/**
 * Tri-state cwd gate: true when no live `git` process has repoRoot as its
 * working directory. Parses `lsof -c git -F pcfn` records (p<pid> / c<command>
 * headers, then f<fd> / n<name> pairs); only an exact command `git` with an
 * `fcwd` entry equal to the canonical repo root counts as held. rc 1 with
 * empty output means no git process exists (clear). Spawn failure,
 * timeout/signal (code null), lsof diagnostics, or output with no parseable
 * process record is UNKNOWN and the lock stays untouched.
 */
export function gitCwdClear(repoRoot: string, run: ScratchRunner, timeoutMs = 15000): boolean | null {
	let root: string;
	try {
		root = realpathSync(repoRoot);
	} catch {
		return null;
	}
	let out;
	try {
		out = run(["lsof", "-c", "git", "-F", "pcfn"], { timeoutMs });
	} catch {
		return null;
	}
	if (out.code === null) return null;
	const text = `${out.stdout}\n${out.stderr}`;
	if (/command not found/i.test(text) || /lsof:.*(not found|No such file)/i.test(text)) return null;
	if (/^lsof:/m.test(text)) return null;
	if (out.code === 1 && out.stdout.trim() === "" && out.stderr.trim() === "") return true;
	if (out.code !== 0) return null;
	let pid: string | null = null, cmd: string | null = null, fd: string | null = null, seenProcess = false;
	for (const line of out.stdout.split("\n")) {
		const tag = line[0], body = line.slice(1);
		if (tag === "p") { pid = body; cmd = null; fd = null; seenProcess = true; }
		else if (tag === "c") cmd = body;
		else if (tag === "f") fd = body;
		else if (tag === "n") {
			const held = fd === "cwd" && pid !== null && cmd === "git" && body === root;
			fd = null;
			if (held) return false;
		}
	}
	return seenProcess ? true : null;
}

export type ReapVerdict = LockVerdict | "REAPED";

export interface ReapReceipt {
	repo: string;
	lock: string;
	movedTo: string;
	dev: number;
	ino: number;
	sizeBytes: number;
	mtimeMs: number;
	ageMs: number;
	staleAfterMs: number;
	atMs: string;
	checks: string;
	guardClean: boolean;
}

export interface ReapDeps {
	run: ScratchRunner;
	nowMs?: () => number;
	lsofTimeoutMs?: number;
	staleAfterMs?: number;
	repoRoot?: string;
}

function reapLockFile(
	repoGitDir: string, repoRoot: string, name: string, now: number, staleAfter: number,
	run: ScratchRunner, lsofTimeoutMs: number,
): { verdict: ReapVerdict; receipt?: ReapReceipt } {
	const lock = join(repoGitDir, name);
	let stat;
	try {
		stat = statSync(lock);
	} catch {
		return { verdict: "NOT_FOUND" };
	}
	if (!stat.isFile() || stat.size !== 0) return { verdict: "NON_EMPTY" };
	if (now - stat.mtimeMs < staleAfter) return { verdict: "TOO_YOUNG" };
	const fileClear = lsofFileClear(lock, run, lsofTimeoutMs);
	if (fileClear === null) return { verdict: "UNKNOWN" };
	if (!fileClear) return { verdict: "HELD" };
	const cwdClear = gitCwdClear(repoRoot, run, lsofTimeoutMs);
	if (cwdClear === null) return { verdict: "UNKNOWN" };
	if (!cwdClear) return { verdict: "HELD" };
	let current;
	try {
		current = statSync(lock);
	} catch {
		return { verdict: "CHANGED" };
	}
	if (!current.isFile() || current.dev !== stat.dev || current.ino !== stat.ino
		|| current.size !== stat.size || current.mtimeMs !== stat.mtimeMs) return { verdict: "CHANGED" };
	const movedTo = `${lock}.stale-${new Date(now).toISOString().replace(/[:.]/g, "-")}`;
	try {
		renameSync(lock, movedTo);
	} catch {
		return { verdict: "UNKNOWN" };
	}
	return { verdict: "REAPED", receipt: {
		repo: repoRoot, lock, movedTo, dev: stat.dev, ino: stat.ino,
		sizeBytes: stat.size, mtimeMs: stat.mtimeMs, ageMs: now - stat.mtimeMs,
		staleAfterMs: staleAfter, atMs: new Date(now).toISOString(),
		checks: "empty,age,file-clear,cwd-clear,identity", guardClean: true,
	} };
}

function withReapGuard<T extends { receipt?: ReapReceipt }>(repoGitDir: string, work: () => T[]): { guard: "ok"; results: T[] } | { guard: "BUSY" | "UNKNOWN" } {
	const guardPath = join(repoGitDir, ".omp-kit-index-lock-mover");
	let guardFd: number;
	try {
		guardFd = openSync(guardPath, "wx", 0o600);
	} catch (error) {
		if (typeof error === "object" && error !== null && "code" in error && error.code === "EEXIST") {
			return { guard: "BUSY" };
		}
		return { guard: "UNKNOWN" };
	}
	let results: T[];
	try {
		results = work();
	} catch {
		results = [] as T[];
	}
	let guardClean = true;
	try {
		closeSync(guardFd);
	} catch {
		guardClean = false;
	}
	try {
		unlinkSync(guardPath);
	} catch {
		guardClean = false;
	}
	if (!guardClean) for (const r of results) if (r.receipt) r.receipt.guardClean = false;
	return { guard: "ok", results };
}

function resolveRepoGitDir(repo: string): { root: string; gitDir: string } | null {
	let root: string;
	try {
		root = realpathSync(repo);
	} catch {
		return null;
	}
	const gitDir = join(root, ".git");
	try {
		if (!statSync(gitDir).isDirectory()) return null;
	} catch {
		return null;
	}
	return { root, gitDir: realpathSync(gitDir) };
}

/** Reap .git/index.lock in one checkout; worktree .git files and missing dirs are UNKNOWN. */
export function reapStaleIndexLock(gitDir: string, deps: ReapDeps): { verdict: ReapVerdict; receipt?: ReapReceipt } {
	let repoGitDir: string;
	try {
		repoGitDir = realpathSync(gitDir);
	} catch {
		return { verdict: "UNKNOWN" };
	}
	try {
		if (!statSync(repoGitDir).isDirectory()) return { verdict: "UNKNOWN" };
	} catch {
		return { verdict: "UNKNOWN" };
	}
	const now = deps.nowMs ? deps.nowMs() : Date.now();
	const staleAfter = deps.staleAfterMs ?? DEFAULT_REAP_STALE_MS;
	const repoRoot = deps.repoRoot ?? dirname(repoGitDir);
	const timeout = deps.lsofTimeoutMs ?? 15000;
	const run = deps.run;
	const guarded = withReapGuard(repoGitDir, () => [reapLockFile(repoGitDir, repoRoot, "index.lock", now, staleAfter, run, timeout)]);
	return guarded.guard === "ok" ? guarded.results[0]! : { verdict: guarded.guard };
}

export interface RepoReapResult { file: string; verdict: ReapVerdict; receipt?: ReapReceipt }

/** Reap index.lock plus next-index-*.lock in one checkout under a single guard. */
export function reapRepoGitLocks(repo: string, deps: ReapDeps): RepoReapResult[] {
	const resolved = resolveRepoGitDir(repo);
	if (resolved === null) return [{ file: join(repo, ".git", "index.lock"), verdict: "UNKNOWN" }];
	const { root, gitDir } = resolved;
	const now = deps.nowMs ? deps.nowMs() : Date.now();
	const staleAfter = deps.staleAfterMs ?? DEFAULT_REAP_STALE_MS;
	const timeout = deps.lsofTimeoutMs ?? 15000;
	const run = deps.run;
	let names: string[];
	try {
		names = readdirSync(gitDir);
	} catch {
		names = [];
	}
	const candidates = ["index.lock", ...names.filter((n) => /^next-index-[^/\n]*\.lock$/.test(n) && n !== "index.lock")];
	const guarded = withReapGuard(gitDir, () => candidates.map((name) => {
		const r = reapLockFile(gitDir, root, name, now, staleAfter, run, timeout);
		return { verdict: r.verdict, ...(r.receipt ? { receipt: r.receipt } : {}) };
	}));
	if (guarded.guard !== "ok") return candidates.map((name) => ({ file: join(gitDir, name), verdict: guarded.guard }));
	return candidates.map((name, i) => ({ file: join(gitDir, name), ...guarded.results[i]! }));
}

export function defaultGitLockLedgerPath(home: string): string {
	return join(home, ".local", "state", "omp-kit", "index-lock-ledger.jsonl");
}

/** Append one reap receipt line; creates the ledger directory. False only when unwritable. */
export function appendReapReceipt(ledgerPath: string, receipt: ReapReceipt): boolean {
	try {
		mkdirSync(dirname(ledgerPath), { recursive: true });
		appendFileSync(ledgerPath, JSON.stringify({ kind: "GITLOCK_REAPED", ...receipt }) + "\n");
		return true;
	} catch {
		return false;
	}
}
