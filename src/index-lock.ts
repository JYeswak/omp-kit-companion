import { appendFileSync, closeSync, mkdirSync, openSync, readdirSync, realpathSync, renameSync, statSync, unlinkSync } from "node:fs";
import { dirname, isAbsolute, join, relative, sep } from "node:path";
import { parseEtime, type ScratchRunner } from "./scratch.ts";
export type { ScratchRunner } from "./scratch.ts";

/**
 * Guarded stale index.lock dry-run reporter (ompkit-rz5.101).
 *
 * Predicate: the lock is EMPTY (a non-empty lock is never touched), older
 * than the configured age, has no open file holder and no live index-writing
 * git command in its worktree. A dry-run returns evidence and never renames.
 *
 * Age threshold: read from configuration, never pinned. The reporter reads
 * OMP_KIT_INDEX_LOCK_STALE_MS (positive integer milliseconds); the default
 * is 600000 (10 min). Derivation: legitimate index writes take seconds, so
 * 10 min sits orders above any single write; a queued commit hook can hold
 * longer (SUITE_VERDICT_WAIT default 7200 s), but a queued writer still
 * counts even between open fds; the process gate carries that safety.
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

export interface LockHolder {
	pid: number;
	command: string;
	reason: "open-file" | "index-writer";
}

export interface LsofFileResult {
	/** null means the evidence is unavailable, not permission to move the lock. */
	clear: boolean | null;
	holders: LockHolder[];
}

interface GitProcess {
	pid: number;
	ppid: number;
	startedAt: string;
	ageSeconds: number;
	command: string;
}

interface LsofProcess { pid: number; command: string; cwd?: string }

function lsofProcesses(args: string[], run: ScratchRunner, timeoutMs: number): LsofProcess[] | null {
	try {
		const out = run(["lsof", ...args], { timeoutMs });
		if (out.stderr.trim() !== "") return null;
		if (out.code === 1 && out.stdout.trim() === "") return [];
		if (out.code !== 0) return null;
		const rows: LsofProcess[] = [];
		let current: LsofProcess | undefined, fd: string | undefined;
		for (const line of out.stdout.split("\n")) {
			const tag = line[0], body = line.slice(1);
			if (tag === "p") {
				const pid = Number(body);
				if (!Number.isSafeInteger(pid) || pid <= 1) return null;
				current = { pid, command: "" };
				rows.push(current);
				fd = undefined;
			} else if (tag === "c" && current) current.command = body;
			else if (tag === "f") fd = body;
			else if (tag === "n" && current && fd === "cwd") current.cwd = body;
		}
		return rows.length > 0 && rows.every(row => row.command !== "") ? rows : null;
	} catch {
		return null;
	}
}

/** ps is a liveness/argv check, not a signal. Zombies and vanished processes cannot hold a lock. */
function liveProcess(pid: number, run: ScratchRunner, timeoutMs: number): GitProcess | "dead" | null {
	try {
		const out = run(["ps", "-ww", "-p", String(pid), "-o", "pid=,ppid=,stat=,etime=,lstart=,command="], { timeoutMs });
		if (out.stderr.trim() !== "") return null;
		if (out.code === 1 && out.stdout.trim() === "") return "dead";
		if (out.code !== 0 || out.stdout.length > 65_536 || out.stdout.trim().includes("\n")) return null;
		const fields = out.stdout.trim().split(/\s+/);
		if (fields.length < 10 || Number(fields[0]) !== pid) return null;
		if (/^[ZX]/.test(fields[2]!)) return "dead";
		const ageSeconds = parseEtime(fields[3]!);
		const ppid = Number(fields[1]);
		if (ageSeconds === null || !Number.isSafeInteger(ppid) || ppid < 0) return null;
		return { pid, ppid, ageSeconds, startedAt: fields.slice(4, 9).join(" "), command: fields.slice(9).join(" ") };
	} catch {
		return null;
	}
}

function fileHolders(path: string, run: ScratchRunner, timeoutMs: number): LsofFileResult {
	const rows = lsofProcesses(["-F", "pc", path], run, timeoutMs);
	if (rows === null) return { clear: null, holders: [] };
	const holders: LockHolder[] = [];
	let unknown = false;
	for (const row of rows) {
		const live = liveProcess(row.pid, run, timeoutMs);
		if (live === null) unknown = true;
		else if (live !== "dead") holders.push({ pid: live.pid, command: live.command, reason: "open-file" });
	}
	return { clear: holders.length > 0 ? false : unknown ? null : true, holders };
}

/** Compatibility for the tri-state file probe; HELD results use fileHolders so attribution cannot be lost. */
export function lsofFileClear(path: string, run: ScratchRunner, timeoutMs = 15000): boolean | null {
	return fileHolders(path, run, timeoutMs).clear;
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
 * J-2026-10-18-48): it stacks empty + age + lsof + index-writer + identity gates
 * and renames (never unlinks) with a ledger receipt.
 */
export function maybeMoveStaleIndexLock(
	gitDir: string,
	deps: MoveDeps,
): { verdict: LockVerdict; holders?: LockHolder[]; receipt?: LockMoveReceipt } {
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

	let result: { verdict: LockVerdict; holders?: LockHolder[]; receipt?: LockMoveReceipt };
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
			const held = indexLockHolders(lock, dirname(repoGitDir), deps.run, deps.lsofTimeoutMs ?? 15000);
			if (held.clear === null) return { verdict: "UNKNOWN" as const };
			if (!held.clear) return { verdict: "HELD" as const, holders: held.holders };
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
 * tick plus one slow hook chain) -> lsof shows no holder -> no live index-writing
 * git command in this worktree -> dev/ino/size/mtime recheck ->
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

const INDEX_WRITERS: Record<string, true> = {
	add: true, commit: true, checkout: true, switch: true, restore: true, merge: true, rebase: true, reset: true,
	"read-tree": true, "update-index": true, am: true, rm: true, mv: true, "cherry-pick": true, revert: true,
	stash: true, pull: true, bisect: true, "sparse-checkout": true,
	status: true, diff: true, // These commands may refresh the on-disk index.
};
const INDEX_READERS: Record<string, true> = {
	blame: true, log: true, show: true, fetch: true, push: true, "ls-files": true, "ls-tree": true, "rev-parse": true,
	"rev-list": true, "cat-file": true, "diff-tree": true, "diff-files": true, "diff-index": true, "check-attr": true,
	"check-ignore": true, "check-ref-format": true, "for-each-ref": true, "show-ref": true, branch: true, tag: true,
	config: true, remote: true, describe: true, reflog: true, shortlog: true, grep: true, help: true, version: true,
	init: true, clone: true, gc: true, maintenance: true, repack: true, prune: true, fsck: true, "count-objects": true,
};
const NETWORK_HELPERS: Record<string, true> = {
	"fetch-pack": true, "send-pack": true, "upload-pack": true, "receive-pack": true, "index-pack": true, "pack-objects": true,
};

function gitInvocation(command: string): { subcommand: string; args: string[]; noOptionalLocks: boolean } | null {
	if (command.length > 65_536) return null;
	// ps joins argv without quoting. Match the executable first (including a path with spaces);
	// ambiguous global-option values remain UNKNOWN rather than inventing a holder or clearing it.
	const executable = /^(?:\/[^\n]*?\/)?git(?:-([a-z0-9-]+))?(?:\s+|$)/.exec(command);
	if (!executable) return null;
	const words = command.slice(executable[0].length).trim().split(/\s+/).filter(Boolean);
	if (executable[1]) return { subcommand: executable[1], args: words, noOptionalLocks: false };
	let noOptionalLocks = false;
	while (words.length > 0) {
		const word = words.shift()!;
		if (["-C", "-c", "--git-dir", "--work-tree", "--namespace", "--config-env", "--super-prefix", "--exec-path"].includes(word)) {
			if (words.shift() === undefined) return null;
		} else if (/^(?:-[Cc].+|--(?:git-dir|work-tree|namespace|config-env|super-prefix|exec-path)=)/.test(word)) continue;
		else if (word === "--no-optional-locks") noOptionalLocks = true;
		else if (["--no-pager", "--paginate", "-p", "-P", "--bare", "--no-replace-objects",
			"--literal-pathspecs", "--glob-pathspecs", "--noglob-pathspecs", "--icase-pathspecs", "--no-lazy-fetch"].includes(word)) continue;
		else if (word.startsWith("-")) return null;
		else return { subcommand: word, args: words, noOptionalLocks };
	}
	return null;
}

function networkHelper(subcommand: string): boolean {
	return subcommand.startsWith("remote-") || Object.hasOwn(NETWORK_HELPERS, subcommand);
}

function writesIndex(command: string): boolean | null {
	const invocation = gitInvocation(command);
	if (!invocation) return null;
	const { subcommand, args, noOptionalLocks } = invocation;
	// LOCKREADER1: git's --no-optional-locks stops status/diff from taking the index lock to refresh it
	// (git docs: "Do not perform optional operations that require locks"), so such a process only reads.
	if (noOptionalLocks && (subcommand === "status" || subcommand === "diff")) return false;
	if (networkHelper(subcommand) || subcommand.startsWith("credential-") || Object.hasOwn(INDEX_READERS, subcommand)) return false;
	if (subcommand === "apply") return args.some(arg => ["--index", "--cached", "--3way", "-3"].includes(arg));
	if (subcommand === "reset" && args.includes("--soft")) return false;
	if (subcommand === "stash" && ["list", "show", "export"].includes(args[0] ?? "")) return false;
	return Object.hasOwn(INDEX_WRITERS, subcommand) ? true : null;
}

function inWorktree(cwd: string | undefined, root: string): boolean {
	if (cwd === undefined) return false;
	const within = relative(root, cwd);
	return within === "" || (within !== ".." && !within.startsWith(`..${sep}`) && !isAbsolute(within));
}

function gitProcesses(repoRoot: string, run: ScratchRunner, timeoutMs: number): { processes: GitProcess[]; unknown: boolean } {
	let root: string;
	try { root = realpathSync(repoRoot); } catch { return { processes: [], unknown: true }; }
	const rows = lsofProcesses(["-a", "-c", "git", "-d", "cwd", "-F", "pcfn"], run, timeoutMs);
	if (rows === null) return { processes: [], unknown: true };
	const processes: GitProcess[] = [];
	let unknown = false;
	for (const row of rows) {
		if (row.cwd === undefined) { unknown = true; continue; }
		if (!inWorktree(row.cwd, root)) continue;
		const live = liveProcess(row.pid, run, timeoutMs);
		if (live === null) unknown = true;
		else if (live !== "dead") processes.push(live);
	}
	return { processes, unknown };
}

function indexLockHolders(lock: string, repoRoot: string, run: ScratchRunner, timeoutMs: number): LsofFileResult {
	const file = fileHolders(lock, run, timeoutMs);
	if (file.clear !== true) return file;
	const snapshot = gitProcesses(repoRoot, run, timeoutMs);
	const holders: LockHolder[] = [];
	let unknown = snapshot.unknown;
	for (const live of snapshot.processes) {
		const writer = writesIndex(live.command);
		if (writer === null) unknown = true;
		else if (writer) holders.push({ pid: live.pid, command: live.command, reason: "index-writer" });
	}
	return { clear: holders.length > 0 ? false : unknown ? null : true, holders };
}

export type OrphanGitHelper = GitProcess;

/** Report only: an orphaned helper is never signal authority and never an index-lock holder by cwd alone. */
export function reportOrphanedGitHelpers(repoRoot: string, run: ScratchRunner, timeoutMs = 15000): {
	status: "OK" | "UNKNOWN"; helpers: OrphanGitHelper[];
} {
	const snapshot = gitProcesses(repoRoot, run, timeoutMs);
	const helpers = snapshot.processes.filter(live => {
		const invocation = gitInvocation(live.command);
		return invocation !== null && networkHelper(invocation.subcommand);
	});
	const orphaned = new Set(helpers.filter(live => live.ppid === 1).map(live => live.pid));
	// Include the network children of a reparented dispatcher, not just its ppid=1 root.
	for (let changed = true; changed;) {
		changed = false;
		for (const live of helpers) if (!orphaned.has(live.pid) && orphaned.has(live.ppid)) {
			orphaned.add(live.pid);
			changed = true;
		}
	}
	return { status: snapshot.unknown ? "UNKNOWN" : "OK",
		helpers: helpers.filter(live => orphaned.has(live.pid) && live.ageSeconds > 30 * 60) };
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
): { verdict: ReapVerdict; holders?: LockHolder[]; receipt?: ReapReceipt } {
	const lock = join(repoGitDir, name);
	let stat;
	try {
		stat = statSync(lock);
	} catch {
		return { verdict: "NOT_FOUND" };
	}
	if (!stat.isFile() || stat.size !== 0) return { verdict: "NON_EMPTY" };
	if (now - stat.mtimeMs < staleAfter) return { verdict: "TOO_YOUNG" };
	const held = indexLockHolders(lock, repoRoot, run, lsofTimeoutMs);
	if (held.clear === null) return { verdict: "UNKNOWN" };
	if (!held.clear) return { verdict: "HELD", holders: held.holders };
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
		checks: "empty,age,file-clear,index-writer-clear,identity", guardClean: true,
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
export function reapStaleIndexLock(gitDir: string, deps: ReapDeps): { verdict: ReapVerdict; holders?: LockHolder[]; receipt?: ReapReceipt } {
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

export interface RepoReapResult { file: string; verdict: ReapVerdict; holders?: LockHolder[]; receipt?: ReapReceipt }

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
		return { verdict: r.verdict, ...(r.holders ? { holders: r.holders } : {}), ...(r.receipt ? { receipt: r.receipt } : {}) };
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
