import { createHash } from "node:crypto";
import { appendFileSync, existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, realpathSync, renameSync, rmSync, statfsSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { basename, delimiter, dirname, isAbsolute, join, resolve, sep } from "node:path";
import { homedir } from "node:os";

/**
 * Scratch reaper (S2): plan/apply over operator scratch, ported from
 * zeststream-cast/scripts/lib/agent_tmp_reap.sh.
 *
 * A session directory is reapable ONLY when its six-field owner identity is gone
 * (or its PID was demonstrably reused) AND lsof reports no open descriptor.
 * Entries without that process identity (including the fleet guard's four-field
 * marker and the legacy three-field format) use idle quarantine: past 72 h they
 * move to quarantine, then the configured TTL (24 h by default) plus owner/lsof
 * rechecks must pass before deletion. Orphan kill targets ONLY kit harness servers
 * (ppid 1, older than 1 h, mock-model.mjs / external-live.mjs argv).
 */

export interface ScratchRunResult { code: number | null; stdout: string; stderr: string }
export type ScratchRunner = (args: readonly string[], opts?: { timeoutMs?: number }) => ScratchRunResult;

export interface ScratchOwner { pid: number; processStart: string | null; label: string; repo: string; createdAt: string; argv0: string | null;
	/** The durable owner: the agent and its omp session id. Both or neither; a pid alone is only an attribute of the current process. */
	agent: string | null; session: string | null }

const OWNER_FIELDS = ["pid", "process_start", "label", "repo", "created_at", "argv0"] as const;
const LEGACY_OWNER_FIELDS = ["pid", "label", "repo", "created"] as const;
const SEAT_FIELDS = ["agent", "session"] as const;
const ALLOWED_OWNER_FIELDS = [...OWNER_FIELDS, ...LEGACY_OWNER_FIELDS, ...SEAT_FIELDS];
const AGENT_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const SESSION_PATTERN = /^[0-9A-Za-z][0-9A-Za-z-]{7,63}$/;
const RELEASE_FILE = ".omp-kit-release";
const QUARANTINE_IDLE_MS = 72 * 3600 * 1000;
const DEFAULT_QUARANTINE_TTL_HOURS = 24;
const MAX_QUARANTINE_TTL_HOURS = 168;
const ORPHAN_MIN_AGE_S = 3600;
export const HARNESS_SERVER_PATTERNS = ["mock-model.mjs", "external-live.mjs"];

export function parseOwnerFile(text: string): ScratchOwner | null {
	const trimmed = text.trim();
	if (trimmed.startsWith("{")) {
		let parsed: unknown;
		try {
			parsed = JSON.parse(trimmed);
		} catch {
			return null;
		}
		if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return null;
		const seen: Record<string, string> = {};
		for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
			if (!(ALLOWED_OWNER_FIELDS as readonly string[]).includes(key)) return null;
			if (typeof value !== "number" && typeof value !== "string") return null;
			seen[key] = String(value);
		}
		return validateOwnerFields(seen);
	}
	const seen: Record<string, string> = {};
	const contentLines = text.split("\n").filter(line => line !== "");
	const tokens = contentLines.length === 1 ? contentLines[0]!.trim().split(/[ \t]+/) : null;
	if (tokens !== null && tokens.length > 1) {
		for (const token of tokens) {
			const eq = token.indexOf("=");
			if (eq < 0) return null;
			const key = token.slice(0, eq);
			const value = token.slice(eq + 1);
			if (!(ALLOWED_OWNER_FIELDS as readonly string[]).includes(key)) return null;
			if (value === "" || seen[key] !== undefined) return null;
			seen[key] = value;
		}
		return validateOwnerFields(seen);
	}
	for (const line of text.split("\n")) {
		if (line === "") continue;
		const eq = line.indexOf("=");
		if (eq < 0) return null;
		const key = line.slice(0, eq);
		const value = line.slice(eq + 1);
		if (!(ALLOWED_OWNER_FIELDS as readonly string[]).includes(key)) return null;
		if (value === "" || /[\t\r\n]/.test(value)) return null;
		if (seen[key] !== undefined) return null;
		seen[key] = value;
	}
	return validateOwnerFields(seen);
}

function validateOwnerFields(seen: Record<string, string>): ScratchOwner | null {
	const seat = SEAT_FIELDS.filter(field => seen[field] !== undefined);
	if (seat.length === 1) return null;
	const base = (fields: readonly string[]): boolean => fields.every(field => seen[field] !== undefined) &&
		Object.keys(seen).length === fields.length + seat.length;
	const complete = base(OWNER_FIELDS);
	const legacy = base(LEGACY_OWNER_FIELDS);
	if (!complete && !legacy) return null;
	if (!/^[1-9][0-9]{0,5}$/.test(seen.pid!)) return null;
	if (seat.length === 2 && (!AGENT_PATTERN.test(seen.agent!) || !SESSION_PATTERN.test(seen.session!))) return null;
	return { pid: Number(seen.pid), processStart: seen.process_start ?? null, label: seen.label!,
		repo: seen.repo!, createdAt: seen.created_at ?? seen.created!, argv0: seen.argv0 ?? null,
		agent: seen.agent ?? null, session: seen.session ?? null };
}
function hasProcessIdentity(owner: ScratchOwner): owner is ScratchOwner & { processStart: string; argv0: string } {
	return owner.processStart !== null && owner.argv0 !== null;
}


export type OwnerState = "live" | "reused" | "dead" | "live-unreachable" | "unknown";

export interface LivenessDeps {
	signalAlive: (pid: number) => boolean;
	psVisible: (pid: number) => boolean;
	processStart: (pid: number) => string | null;
	/**
	 * True when the omp session of a named seat is held by a live process, false when nothing holds it,
	 * null when that cannot be told. The session id is the unique key; the agent name is the owner's claim.
	 */
	seatLive?: (agent: string, session: string) => boolean | null;
}

/** Directory of the omp session-ownership leases (`<session id>.lock`, held by the live seat's process). */
export function sessionOwnersDir(env: NodeJS.ProcessEnv = process.env): string {
	return env.OMP_KIT_SESSION_OWNERS_DIR ?? join(homedir(), ".omp", "run", "session-owners");
}

export function defaultLiveness(): LivenessDeps {
	return {
		signalAlive: (pid: number): boolean => {
			try {
				process.kill(pid, 0);
				return true;
			} catch (error) {
				return (error as NodeJS.ErrnoException).code === "EPERM";
			}
		},
		psVisible: (pid: number): boolean => {
			try {
				const out = Bun.spawnSync(["ps", "-p", String(pid), "-o", "pid="], { stdout: "pipe", stderr: "ignore" });
				return out.exitCode === 0 && out.stdout.toString().trim() !== "";
			} catch {
				return false;
			}
		},
		processStart: (pid: number): string | null => {
			try {
				const out = Bun.spawnSync(["ps", "-p", String(pid), "-o", "lstart="], { stdout: "pipe", stderr: "ignore" });
				if (out.exitCode !== 0) return null;
				const start = out.stdout.toString().trim();
				return start === "" ? null : start;
			} catch {
				return null;
			}
		},
		seatLive: (_agent: string, session: string): boolean | null => {
			if (!SESSION_PATTERN.test(session)) return null;
			const lock = join(sessionOwnersDir(), `${session}.lock`);
			if (!existsSync(lock)) return false;
			try {
				const out = Bun.spawnSync(["lsof", "-t", "--", lock], { stdout: "pipe", stderr: "pipe" });
				if (out.exitCode === 0 && out.stdout.toString().trim() !== "") return true;
				return out.exitCode === 1 && out.stderr.toString().trim() === "" ? false : null;
			} catch {
				return null;
			}
		},
	};
}

export function probeOwner(pid: number, expectedStart: string, deps: LivenessDeps): OwnerState {
	if (deps.signalAlive(pid)) {
		const current = deps.processStart(pid);
		if (current === null) return "unknown";
		return current === expectedStart ? "live" : "reused";
	}
	// kill -0 false is ambiguous: ESRCH means gone, EPERM already returned true above,
	// so recheck with ps; a visible PID is never treated as dead.
	if (deps.psVisible(pid)) return "live-unreachable";
	return "dead";
}

/** The calling process and its ancestors, nearest first; null when the process table cannot be read. */
function ancestorPids(callerPid: number, run: ScratchRunner): number[] | null {
	const out = run(["ps", "-axo", "pid=,ppid="]);
	if (out.code !== 0) return null;
	const parents = new Map<number, number>();
	for (const line of out.stdout.split("\n")) {
		const match = /^\s*(\d+)\s+(\d+)\s*$/.exec(line);
		if (!match) continue;
		parents.set(Number(match[1]), Number(match[2]));
	}
	const chain = [callerPid];
	let current = callerPid;
	for (let depth = 0; depth < 256; depth++) {
		const parent = parents.get(current);
		if (parent === undefined || parent <= 0 || chain.includes(parent)) break;
		chain.push(parent);
		current = parent;
	}
	return chain;
}

export interface SeatIdentity {
	agent: string | null;
	/** Every omp session lease held by the caller's ancestors (the main session, advisors, subagents). */
	sessions: string[];
	/** The one main session, or null when it cannot be told apart. */
	main: string | null;
}

function sessionIdOf(path: string, kind: "lock" | "transcript"): string | null {
	const parts = path.split("/");
	const name = parts[parts.length - 1] ?? "";
	let id: string | null = null;
	if (kind === "lock" && parts[parts.length - 2] === "session-owners" && name.endsWith(".lock")) id = name.slice(0, -".lock".length);
	// A main transcript is <sessions>/<project>/<timestamp>_<id>.jsonl; advisors nest one directory deeper.
	if (kind === "transcript" && parts[parts.length - 3] === "sessions" && name.endsWith(".jsonl") && name.includes("_"))
		id = name.slice(name.lastIndexOf("_") + 1, -".jsonl".length);
	return id !== null && SESSION_PATTERN.test(id) ? id : null;
}

/**
 * Who is calling: the host agent name (AGENT_NAME, else BR_ACTOR, else BR_AGENT_NAME) and the omp sessions whose
 * lease a process in the caller's ancestry holds open. Read-only: ps and lsof.
 */
export function callerSeat(run: ScratchRunner, env: NodeJS.ProcessEnv = process.env, pid: number = process.pid): SeatIdentity {
	const agent = [env.AGENT_NAME, env.BR_ACTOR, env.BR_AGENT_NAME].map(value => value?.trim()).find(value => value !== undefined && AGENT_PATTERN.test(value)) ?? null;
	const chain = ancestorPids(pid, run)?.filter(ancestor => ancestor > 1);
	if (chain === undefined) return { agent, sessions: [], main: null };
	const out = run(["lsof", "-a", "-p", chain.join(","), "-Fn"], { timeoutMs: LSOF_TIMEOUT_MS });
	if (out.code === null) return { agent, sessions: [], main: null };
	const locks = new Set<string>();
	const transcripts = new Set<string>();
	for (const line of out.stdout.split("\n")) {
		if (!line.startsWith("n")) continue;
		const lock = sessionIdOf(line.slice(1), "lock");
		if (lock !== null) locks.add(lock);
		const transcript = sessionIdOf(line.slice(1), "transcript");
		if (transcript !== null) transcripts.add(transcript);
	}
	const sessions = [...locks];
	const both = sessions.filter(id => transcripts.has(id));
	const main = both.length === 1 ? both[0]! : both.length === 0 && sessions.length === 1 ? sessions[0]! : null;
	return { agent, sessions, main };
}

const PS_MONTHS: Record<string, number> = { Jan: 0, Feb: 1, Mar: 2, Apr: 3, May: 4, Jun: 5,
	Jul: 6, Aug: 7, Sep: 8, Oct: 9, Nov: 10, Dec: 11 };

/** Parse `ps -o lstart=` ctime output ("Mon Oct  5 13:27:00 2026") to epoch ms; null when unparseable. */
export function parsePsStart(text: string): number | null {
	const match = /^[A-Z][a-z]{2} ([A-Z][a-z]{2})\s+(\d{1,2}) (\d{2}):(\d{2}):(\d{2}) (\d{4})$/.exec(text.trim());
	if (!match) return null;
	const month = PS_MONTHS[match[1]!];
	if (month === undefined) return null;
	const ms = Date.UTC(Number(match[6]), month, Number(match[2]), Number(match[3]), Number(match[4]), Number(match[5]));
	return Number.isNaN(ms) ? null : ms;
}

function isSymlink(path: string): boolean {
	try {
		return lstatSync(path).isSymbolicLink();
	} catch {
		return false;
	}
}

/** true = no open descriptors; false = open descriptors present; null = lsof evidence unavailable. */
export function lsofClear(dir: string, run: ScratchRunner, timeoutMs = 0): boolean | null {
	let out: ScratchRunResult;
	try {
		out = timeoutMs > 0 ? run(["lsof", "+D", dir], { timeoutMs }) : run(["lsof", "+D", dir]);
	} catch {
		return null;
	}
	if (out.code === null) return null;
	const text = `${out.stdout}\n${out.stderr}`;
	if (text.includes("command not found") || /lsof:.*(not found|No such file)/i.test(text)) return null;
	if (out.stdout.trim() === "") {
		if (/^lsof:/m.test(text)) return null;
		return out.code === 1 ? true : null;
	}
	if (/^lsof:/m.test(text)) return null;
	return false;
}

export const LSOF_TIMEOUT_MS = 15000;

/**
 * One system-wide open-file snapshot per plan/apply (`lsof -nP -Fn`, ~2 s at
 * load 34): per-dir `lsof +D` tree walks take 30 s+ on cache-dense dirs and
 * time out, failing closed forever. Null when the snapshot itself fails or
 * times out (callers fail closed). Absolute `n<path>` lines only.
 */
export function takeLsofSnapshot(run: ScratchRunner, timeoutMs = LSOF_TIMEOUT_MS): Set<string> | null {
	let out: ScratchRunResult;
	try {
		out = timeoutMs > 0 ? run(["lsof", "-nP", "-Fn"], { timeoutMs }) : run(["lsof", "-nP", "-Fn"], {});
	} catch {
		return null;
	}
	if (out.code === null) return null;
	const text = `${out.stdout}\n${out.stderr}`;
	if (text.includes("command not found") || /lsof:.*(not found|No such file)/i.test(text)) return null;
	if (/^lsof:/m.test(text)) return null;
	const paths = new Set<string>();
	for (const line of out.stdout.split("\n")) {
		if (line.startsWith("n/")) paths.add(line.slice(1));
	}
	return paths;
}

/** Same safety meaning as lsofClear against a snapshot: any open file at or under the dir means held. */
export function snapshotClear(snapshot: Set<string> | null, dir: string): boolean | null {
	if (snapshot === null) return null;
	const prefix = dir.endsWith("/") ? dir : `${dir}/`;
	for (const path of snapshot) {
		if (path === dir || path.startsWith(prefix)) return false;
	}
	return true;
}

/** Snapshot when the invocation provides one, otherwise the legacy per-dir walk. */
function lsofClearDir(deps: InspectDeps, dir: string): boolean | null {
	if (deps.lsofSnapshot !== undefined) return snapshotClear(deps.lsofSnapshot, dir);
	return lsofClear(dir, deps.run, deps.lsofTimeoutMs ?? LSOF_TIMEOUT_MS);
}

export function defaultRunner(args: readonly string[], opts?: { timeoutMs?: number }): ScratchRunResult {
	try {
		const child = Bun.spawnSync([...args], { stdout: "pipe", stderr: "pipe", timeout: opts?.timeoutMs });
		return { code: child.exitCode, stdout: child.stdout.toString(), stderr: child.stderr.toString() };
	} catch (error) {
		return { code: 127, stdout: "", stderr: error instanceof Error ? error.message : String(error) };
	}
}

function readText(path: string): string | null {
	try {
		return readFileSync(path, "utf8");
	} catch {
		return null;
	}
}
export type ScratchAction = "REAP" | "QUARANTINE" | "DELETE" | "LIVE" | "SKIP";

export interface ScratchVerdict { dir: string; action: ScratchAction; reason: string; owner: ScratchOwner | null; sizeBytes: number; cause?: "permission" | "immutable-flag" | "open-fd" | "lsof-unavailable" | "unknown" | "delete-leftover" }

const APPLY_FAILURE_REASONS: Record<string, true> = {
	"owner-changed-after-initial-check": true, "owner-release-changed-after-initial-check": true,
	"inode-proof-unavailable": true, "lsof-evidence-unavailable": true, "owner-released-but-open-fds-present": true,
	"quarantine-create-failed": true, "atomic-quarantine-failed": true,
	"delete-quarantine-failed": true, "quarantine-ttl-config-invalid": true, "quarantine-read-failed": true,
	"final-delete-recheck-failed": true, "delete-failed": true,
	"idle-proof-unavailable": true,
};

/** A final-recheck refusal is an expected safety SKIP, not a failed run. */
export function isApplyFailure(verdict: ScratchVerdict): boolean {
	return verdict.action === "SKIP" && APPLY_FAILURE_REASONS[verdict.reason] === true;
}

export interface DiskCapacity { bavail: number; blocks: number }
export interface InspectDeps { liveness: LivenessDeps; run: ScratchRunner; now?: number; lsofTimeoutMs?: number; statfs?: (path: string) => DiskCapacity | null; onInspect?: (path: string) => void; onProgress?: (verdict: ScratchVerdict, progress?: { done: number; total: number }) => void; lsofSnapshot?: Set<string> | null; runtimeRepo?: string | null;
	/** Who is calling (host agent and held omp sessions); defaults to the real ps/lsof lookup for release, and is absent for create. */
	callerSeat?: () => SeatIdentity }

function dirSize(dir: string): number {
	let total = 0;
	const stack: string[] = [dir];
	while (stack.length > 0) {
		const current = stack.pop()!;
		let entries: string[];
		try {
			entries = readdirSync(current);
		} catch {
			continue;
		}
		for (const entry of entries) {
			const path = join(current, entry);
			let stat;
			try {
				stat = lstatSync(path);
			} catch {
				continue;
			}
		if (stat.isDirectory() && !stat.isSymbolicLink()) stack.push(path);
		else total += stat.size;
		}
	}
	return total;
}

function readOwner(dir: string): { owner: ScratchOwner | null; malformed: boolean } {
	const path = join(dir, ".owner");
	if (isSymlink(path)) return { owner: null, malformed: true };
	const text = readText(path);
	if (text === null) return { owner: null, malformed: false };
	const owner = parseOwnerFile(text);
	return owner ? { owner, malformed: false } : { owner: null, malformed: true };
}

/** Bind repository scratch, or private runtime work to the native caller's release identity. */
function ownerMatchesScratchRoot(owner: ScratchOwner, root: string, dir: string, deps: InspectDeps): boolean {
	if (!isAbsolute(owner.repo)) return false;
	let repo: string;
	let scanned: string;
	try {
		repo = realpathSync(owner.repo);
		scanned = realpathSync(root);
	} catch {
		return false;
	}
	const expected = join(repo, "var", "agent-tmp");
	try {
		if (realpathSync(expected) === expected && (scanned === expected || scanned.startsWith(expected + sep))) return true;
	} catch { /* An installed runtime release need not contain repository scratch. */ }
	// This identity comes from the executing kit, never from an owner marker or a CLI flag.
	if (!deps.runtimeRepo || owner.label !== "omp-kit-work" || !basename(dir).startsWith("omp-kit-work.")) return false;
	try {
		if (repo !== realpathSync(deps.runtimeRepo)) return false;
		const uid = process.getuid?.();
		const session = lstatSync(dir);
		const marker = lstatSync(join(dir, ".owner"));
		if (uid === undefined || session.uid !== uid || marker.uid !== uid || !session.isDirectory() ||
			session.isSymbolicLink() || !marker.isFile() || marker.isSymbolicLink() ||
			(session.mode & 0o777) !== 0o700 || (marker.mode & 0o777) !== 0o600) return false;
		let temporary = false;
		try { temporary = scanned === realpathSync(process.env.TMPDIR ?? "/tmp"); } catch { /* Try the platform fallback. */ }
		if (!temporary) {
			try { temporary = scanned === realpathSync("/tmp"); } catch { /* No recognized system work root. */ }
		}
		return temporary;
	} catch {
		return false;
	}
}

function inspectByPid(dir: string, root: string, deps: InspectDeps, nameRequired = true, ownerRoot = root): ScratchVerdict {
	const sized = (action: ScratchAction, reason: string, owner: ScratchOwner | null = null): ScratchVerdict =>
		({ dir, action, reason, owner, sizeBytes: dirSize(dir) });
	if (isSymlink(dir)) return { dir, action: "SKIP", reason: "session-is-symlink", owner: null, sizeBytes: 0 };
	let stat;
	try {
		stat = statSync(dir);
	} catch {
		return { dir, action: "SKIP", reason: "not-directory", owner: null, sizeBytes: 0 };
	}
	if (!stat.isDirectory()) return { dir, action: "SKIP", reason: "not-directory", owner: null, sizeBytes: 0 };
	if (resolve(dir) !== dir || !dir.startsWith(root)) return { dir, action: "SKIP", reason: "session-outside-root", owner: null, sizeBytes: 0 };
	const { owner, malformed } = readOwner(dir);
	if (!owner) return sized("SKIP", malformed ? "malformed-owner-file" : "no-owner-file");
	if (!ownerMatchesScratchRoot(owner, ownerRoot, dir, deps)) return sized("SKIP", "owner-repo-outside-scratch-root", owner);
	if (!/^[A-Za-z0-9._%-]+$/.test(owner.label) || owner.label === "" || owner.label.includes("/") || owner.label.startsWith(".")) {
		return sized("SKIP", "owner-label-invalid", owner);
	}
	const name = dir.slice(root.length + 1);
	// Owner pid must be one whole `.`-delimited segment after the label: `label.pid` or `label.pid.suffix`.
	if (nameRequired && !name.split(".").slice(1).includes(String(owner.pid))) return sized("SKIP", "session-name-owner-mismatch", owner);
	if (!hasProcessIdentity(owner)) {
		if (!deps.liveness.signalAlive(owner.pid) && !deps.liveness.psVisible(owner.pid)) {
			// Dead pid with an identity-free (one-line or legacy JSON) owner file:
			// no pid reuse is possible, so lsof-clear means REAP. (Was: SKIP
			// owner-identity-incomplete, which stranded dead-owner dirs as unowned.)
			const clear = lsofClearDir(deps, dir);
			if (clear === null) return sized("SKIP", "lsof-evidence-unavailable", owner);
			if (!clear) return sized("LIVE", "owner-dead-but-open-fds-present", owner);
			return sized("REAP", "owner-dead-no-open-fds", owner);
		}
		const reuse = reuseAfterCreated(owner, deps.liveness);
		if (reuse === true) {
			const clear = lsofClearDir(deps, dir);
			if (clear === null) return sized("SKIP", "lsof-evidence-unavailable", owner);
			if (!clear) return sized("LIVE", "owner-dead-pid-reused-but-open-fds-present", owner);
			return sized("REAP", "owner-dead-pid-reused-no-open-fds", owner);
		}
		return sized("LIVE", "owner-alive-start-unverified", owner);
	}
	const state = probeOwner(owner.pid, owner.processStart, deps.liveness);
	if (state === "live" || state === "live-unreachable") return sized("LIVE", state === "live" ? "owner-alive" : "owner-visible-but-signal-denied", owner);
	if (state === "unknown") return sized("SKIP", "owner-liveness-unproven", owner);
	const clear = lsofClearDir(deps, dir);
	if (clear === null) return sized("SKIP", "lsof-evidence-unavailable", owner);
	if (!clear) return sized("LIVE", `owner-${state}-but-open-fds-present`, owner);
	return sized("REAP", `owner-${state}-no-open-fds`, owner);
}

/**
 * Owner liveness is the pid proof OR a live seat: an owner that names an agent and an omp session stays LIVE
 * while that session's lease is held, even after a respawn changed the pid or the tool shell that wrote the
 * record exited. A pid-only owner keeps the pid rule. A seat that cannot be probed is never reaped.
 */
export function inspectSession(dir: string, root: string, deps: InspectDeps, nameRequired = true, ownerRoot = root): ScratchVerdict {
	const verdict = inspectByPid(dir, root, deps, nameRequired, ownerRoot);
	const owner = verdict.owner;
	if (verdict.action !== "REAP" || owner === null || owner.agent === null || owner.session === null) return verdict;
	const seat = deps.liveness.seatLive?.(owner.agent, owner.session) ?? null;
	if (seat === true) return { ...verdict, action: "LIVE", reason: "owner-seat-alive" };
	if (seat === null) return { ...verdict, action: "SKIP", reason: "owner-seat-liveness-unproven" };
	return verdict;
}

/**
 * PID-reuse proof for owners without process identity (legacy key=value or JSON):
 * the pid is alive, but the live process started after the latest instant the owner
 * could have been created, so it cannot be the process that wrote the owner file.
 * Null when unprovable (fail closed: the caller keeps the LIVE verdict).
 */
export function reuseAfterCreated(owner: ScratchOwner, liveness: LivenessDeps): boolean | null {
	const start = liveness.processStart(owner.pid);
	if (start === null) return null;
	const startMs = parsePsStart(start) ?? Date.parse(start);
	const createdMs = createdLatestMs(owner.createdAt);
	if (Number.isNaN(startMs) || createdMs === null) return null;
	return startMs > createdMs;
}

const CREATED_DATE = /^\d{4}-\d{2}-\d{2}$/;
const CREATED_MINUTE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?:Z|[+-]\d{2}:?\d{2})?$/;
const CREATED_SECOND = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:Z|[+-]\d{2}:?\d{2})?$/;
const CREATED_FRACTION = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{1,9}(?:Z|[+-]\d{2}:?\d{2})?$/;
/**
 * The latest instant a `created` value can denote, from its own precision. A bare
 * date names a whole day in an unknown zone (Date.parse reads it as UTC midnight),
 * so it covers 24 h plus the widest UTC offset; a date-only owner written at 07:16Z
 * by a live process must not read as that process's PID reused. Other formats are
 * not trusted to carry their precision: null.
 */
export function createdLatestMs(created: string): number | null {
	const ms = Date.parse(created);
	if (Number.isNaN(ms)) return null;
	if (CREATED_DATE.test(created)) return ms + (24 + 14) * 3600 * 1000;
	if (CREATED_MINUTE.test(created)) return ms + 60 * 1000;
	if (CREATED_SECOND.test(created)) return ms + 1000;
	if (CREATED_FRACTION.test(created)) return ms + 1;
	return null;
}

/** Latest activity in a tree: dir mtime first (cheap), then a bounded walk for newer entries. */
export function idleSince(dir: string, now: number = Date.now()): number | null {
	let freshest = 0;
	try {
		freshest = lstatSync(dir).mtimeMs;
	} catch {
		return null;
	}
	if (freshest >= now - QUARANTINE_IDLE_MS) return freshest;
	const stack: string[] = [dir];
	while (stack.length > 0) {
		const current = stack.pop()!;
		let entries: string[];
		try {
			entries = readdirSync(current);
		} catch {
			return null;
		}
		for (const entry of entries) {
			const path = join(current, entry);
			let stat;
			try {
				stat = lstatSync(path);
			} catch {
				continue;
			}
			if (stat.mtimeMs > freshest) {
				freshest = stat.mtimeMs;
				if (freshest >= now - QUARANTINE_IDLE_MS) return freshest;
			}
			if (stat.isDirectory() && !stat.isSymbolicLink()) stack.push(path);
		}
	}
	return freshest;
}

export function stateRoot(home: string): string {
	return process.env.XDG_STATE_HOME ?? join(home, ".local", "state");
}

export function quarantineDir(home: string): string {
	return join(stateRoot(home), "omp-kit", "scratch-quarantine");
}

export function reapLogPath(home: string): string {
	return join(stateRoot(home), "omp-kit", "scratch-reap-log.jsonl");
}

export function quarantineEntryFor(dirName: string, at: Date = new Date()): string {
	// Nested session-relative paths carry slashes; flatten so the entry is a single quarantine dir name.
	return `${dirName.split("/").join("__")}.q-${at.toISOString().replace(/[:.]/g, "-")}`;
}

export function quarantineTimeOf(entryName: string): number | null {
	if (entryName.length > 255) return null;
	const match = /\.q-(\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z)(?:\.delete-\d+)?$/.exec(entryName);
	if (!match) return null;
	const stamp = match[1]!.replace(/^(\d{4}-\d{2}-\d{2}T\d{2})-(\d{2})-(\d{2})-(\d{3}Z)$/, "$1:$2:$3.$4");
	const time = Date.parse(stamp);
	return Number.isFinite(time) ? time : null;
}

export function quarantineTtlMs(): number {
	const configPath = join(process.env.XDG_CONFIG_HOME ?? join(homedir(), ".config"), "omp-kit", "scratch-reaper.json");
	let raw: string;
	try {
		raw = readFileSync(configPath, "utf8");
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return DEFAULT_QUARANTINE_TTL_HOURS * 3600 * 1000;
		throw error;
	}
	let value: unknown;
	try {
		value = JSON.parse(raw);
	} catch {
		throw new Error(`invalid scratch-reaper config: ${configPath}`);
	}
	if (typeof value !== "object" || value === null || Array.isArray(value)) {
		throw new Error(`invalid scratch-reaper config: ${configPath}`);
	}
	const config = value as Record<string, unknown>;
	const hours = Object.hasOwn(config, "quarantine_ttl_hours") ? config.quarantine_ttl_hours : DEFAULT_QUARANTINE_TTL_HOURS;
	if (typeof hours !== "number" || !Number.isInteger(hours) || hours < 1 || hours > MAX_QUARANTINE_TTL_HOURS) {
		throw new Error(`invalid scratch-reaper config: quarantine_ttl_hours must be 1..${MAX_QUARANTINE_TTL_HOURS}`);
	}
	return hours * 3600 * 1000;
}

export function resolveSystemWorkDirs(): string[] {
	if (process.env.OMP_KIT_SCRATCH_ROOTS !== undefined && process.env.OMP_KIT_SCRATCH_ROOTS !== "") return [];
	const roots: string[] = [];
	for (const base of new Set([process.env.TMPDIR ?? "/tmp", "/tmp"])) {
		let entries: string[];
		try { entries = readdirSync(base); } catch { continue; }
		for (const entry of entries) {
			if (!entry.startsWith("omp-kit-work.")) continue;
			const dir = join(base, entry);
			try {
				if (statSync(dir).isDirectory() && !isSymlink(dir)) roots.push(dir);
			} catch { /* concurrent deletion */ }
		}
	}
	return [...new Set(roots)];
}
/**
 * Fleet-wide suite TMPDIR base (localbench lesson 2026-10-05): suite temp inside a
 * repo tree breaks git-tree guards, and anything under ~ breaks the scratch rule,
 * so fleet test temp lives outside every git tree and outside ~.
 */
export function fleetTestTmpBase(): string {
	return process.platform === "darwin" ? "/Users/Shared/omp-kit-tmp" : join("/tmp", "omp-kit-tmp");
}

export interface ScratchRootEntry {
	root: string;
	/** Where this root came from: override, developer, fleet-watch:<session>, herdr:<session>, chief, fleet-test-tmp or temp. */
	sources: string[];
}

function fleetWatchConfigPath(home: string): string {
	return process.env.OMP_KIT_FLEET_WATCH_CONFIG ?? join(home, ".config", "omp-kit", "fleet-watch.json");
}

/**
 * The fleet's repos named by fleet-watch.json (every `sessions[].repo`, `herdr[].repo` and `chief.repo` that is an
 * absolute path). Read leniently: a stock user without the file, or a file that does not parse, names none.
 */
export function fleetWatchRepos(home: string): { repo: string; source: string }[] {
	let config: unknown;
	try {
		config = JSON.parse(readFileSync(fleetWatchConfigPath(home), "utf8"));
	} catch {
		return [];
	}
	if (typeof config !== "object" || config === null) return [];
	const record = config as Record<string, unknown>;
	const found: { repo: string; source: string }[] = [];
	const take = (entry: unknown, source: string): void => {
		if (typeof entry !== "object" || entry === null) return;
		const repo = (entry as Record<string, unknown>).repo;
		if (typeof repo === "string" && isAbsolute(repo)) found.push({ repo, source });
	};
	for (const key of ["sessions", "herdr"] as const) {
		const rows = record[key];
		if (!Array.isArray(rows)) continue;
		for (const row of rows) {
			const name = typeof row === "object" && row !== null ? (row as Record<string, unknown>).session : undefined;
			take(row, `${key === "sessions" ? "fleet-watch" : "herdr"}:${typeof name === "string" ? name : "unnamed"}`);
		}
	}
	take(record.chief, "chief");
	return found;
}

/**
 * Scratch roots with their sources, de-duplicated by real path so a symlink alias and its target are one root:
 * the explicit override alone, else ~/Developer/*, every repo fleet-watch.json names (outside ~/Developer too),
 * the fleet test base and the omp-* temp dirs. Without fleet-watch.json this is exactly the earlier list.
 */
export function resolveScratchRootEntries(home: string): ScratchRootEntry[] {
	const override = process.env.OMP_KIT_SCRATCH_ROOTS;
	if (override !== undefined && override !== "") {
		return override.split(delimiter).map(part => part.trim()).filter(part => part !== "").map(root => ({ root, sources: ["override"] }));
	}
	const byReal = new Map<string, ScratchRootEntry>();
	const add = (root: string, source: string): void => {
		let key = root;
		try {
			key = realpathSync(root);
		} catch { /* keep the spelling */ }
		const known = byReal.get(key);
		if (known === undefined) byReal.set(key, { root, sources: [source] });
		else if (!known.sources.includes(source)) known.sources.push(source);
	};
	const dev = join(home, "Developer");
	let projects: string[] = [];
	try {
		projects = readdirSync(dev);
	} catch {
		projects = [];
	}
	for (const project of projects) {
		const candidate = join(dev, project, "var", "agent-tmp");
		try {
			const stat = statSync(candidate);
			if (stat.isDirectory() && !isSymlink(candidate) && !isSymlink(join(dev, project, "var")) && !isSymlink(join(dev, project))) {
				add(candidate, "developer");
			}
		} catch {
			continue;
		}
	}
	for (const { repo, source } of fleetWatchRepos(home)) {
		try {
			// A fleet repo may be named through an alias; its real path is the repo.
			const real = realpathSync(repo);
			const candidate = join(real, "var", "agent-tmp");
			if (statSync(candidate).isDirectory() && !isSymlink(candidate) && !isSymlink(join(real, "var"))) add(candidate, source);
		} catch {
			continue;
		}
	}
	try {
		if (statSync(fleetTestTmpBase()).isDirectory() && !isSymlink(fleetTestTmpBase())) add(fleetTestTmpBase(), "fleet-test-tmp");
	} catch {
		/* absent until a suite creates it */
	}
	const tmpdir = process.env.TMPDIR ?? "/tmp";
	for (const base of [tmpdir, "/tmp"]) {
		let entries: string[] = [];
		try {
			entries = readdirSync(base);
		} catch {
			continue;
		}
		for (const entry of entries) {
			if (!entry.startsWith("omp-")) continue;
			const candidate = join(base, entry);
			try {
				if (statSync(candidate).isDirectory() && !isSymlink(candidate)) add(candidate, "temp");
			} catch {
				continue;
			}
		}
	}
	return [...byReal.values()];
}

export function resolveScratchRoots(home: string): string[] {
	return resolveScratchRootEntries(home).map(entry => entry.root);
}

export interface OrphanProcess { pid: number; ppid: number; ageSeconds: number; command: string }

export function parseEtime(text: string): number | null {
	const match = /^(?:(\d+)-)?(?:(\d+):)?(\d{1,2}):(\d{2})$/.exec(text.trim());
	if (!match) return null;
	const days = Number(match[1] ?? 0);
	const hours = Number(match[2] ?? 0);
	const minutes = Number(match[3]);
	const seconds = Number(match[4]);
	if (![days, hours, minutes, seconds].every(Number.isFinite)) return null;
	return ((days * 24 + hours) * 60 + minutes) * 60 + seconds;
}

export function isHarnessServer(command: string): boolean {
	return HARNESS_SERVER_PATTERNS.some(pattern => command.includes(pattern));
}

export function selectHarnessOrphans(processes: OrphanProcess[]): OrphanProcess[] {
	return processes.filter(proc =>
		proc.ppid === 1 && proc.ageSeconds > ORPHAN_MIN_AGE_S && isHarnessServer(proc.command));
}

export function listProcesses(run: ScratchRunner): OrphanProcess[] {
	const out = run(["ps", "-axo", "pid=,ppid=,etime=,command="]);
	if (out.code !== 0) return [];
	const rows: OrphanProcess[] = [];
	for (const line of out.stdout.split("\n")) {
		const match = /^\s*(\d+)\s+(\d+)\s+(\S+)\s+(.*\S)\s*$/.exec(line);
		if (!match) continue;
		const age = parseEtime(match[3]!);
		if (age === null) continue;
		rows.push({ pid: Number(match[1]), ppid: Number(match[2]), ageSeconds: age, command: match[4]! });
	}
	return rows;
}

function inodeOf(path: string): string | null {
	try {
		const stat = statSync(path);
		return `${stat.dev}:${stat.ino}`;
	} catch {
		return null;
	}
}

export interface ApplyDeps extends InspectDeps {
	home: string;
	kill?: (pid: number) => boolean;
	remove?: (path: string) => void;
}

export interface ReapEvent { event: string; dir: string; at: string; [key: string]: unknown }

const MAX_REAP_LOG_BYTES = 1_048_576;

function appendLog(home: string, event: ReapEvent): void {
	try {
		const path = reapLogPath(home);
		mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
		let record = `${JSON.stringify(event)}\n`;
		if (Buffer.byteLength(record) > MAX_REAP_LOG_BYTES) return;
		if (existsSync(path)) {
			const current = lstatSync(path);
			if (!current.isFile() || current.isSymbolicLink()) return;
			if (current.size + Buffer.byteLength(record) > MAX_REAP_LOG_BYTES) {
				const rotated = `${path}.1`;
				if (existsSync(rotated)) {
					const prior = lstatSync(rotated);
					if (!prior.isFile() || prior.isSymbolicLink()) return;
					rmSync(rotated);
				}
				if (current.size <= MAX_REAP_LOG_BYTES) renameSync(path, rotated);
				else rmSync(path);
			}
		}
		appendFileSync(path, record, { mode: 0o600 });
	} catch {
		/* logging never blocks the verdict */
	}
}

function immutableFlagPresent(path: string, deps: ApplyDeps): boolean {
	const result = deps.run(["/bin/ls", "-ldO", path]);
	if (result.code !== 0 || result.stdout.length > 8192) return false;
	const end = result.stdout.indexOf("\n");
	const line = end < 0 ? result.stdout : result.stdout.slice(0, end);
	let flags: string | null = null;
	let field = 0;
	let offset = 0;
	while (offset < line.length && field < 5) {
		while (offset < line.length && (line[offset] === " " || line[offset] === "\t" || line[offset] === "\r")) offset++;
		const start = offset;
		while (offset < line.length && line[offset] !== " " && line[offset] !== "\t" && line[offset] !== "\r") offset++;
		if (start === offset) break;
		if (field === 4) {
			flags = line.slice(start, offset);
			break;
		}
		field++;
	}
	return flags !== null && flags.split(",").some(flag => flag === "uchg" || flag === "schg");
}

function removeExpiredEntry(path: string, entry: string, owner: ScratchOwner | null, reason: string,
	home: string, deps: ApplyDeps, at: string): ScratchVerdict {
	let original: { dev: number; ino: number } | null = null;
	try {
		const stat = lstatSync(path);
		if (!stat.isSymbolicLink()) original = { dev: stat.dev, ino: stat.ino };
	} catch {
		/* A missing path cannot be safely marked after the delete attempt. */
	}
	const bytesBefore = dirSize(path);
	let errorCode: string | null = null;
	try {
		if (deps.remove) deps.remove(path);
		else rmSync(path, { recursive: true, force: true });
	} catch (error) {
		errorCode = (error as NodeJS.ErrnoException).code ?? null;
	}
	if (errorCode === "ENOENT" && !existsSync(path)) errorCode = null;
	if (errorCode !== null || existsSync(path)) {
		const clear = lsofClearDir(deps, path);
		const immutable = errorCode === "EPERM" && immutableFlagPresent(path, deps);
		const cause = clear === false ? "open-fd"
			: clear === null ? "lsof-unavailable"
				: errorCode === "EACCES" ? "permission"
					: immutable ? "immutable-flag"
						: errorCode === "EPERM" ? "unknown"
							: existsSync(path) ? "delete-leftover" : "unknown";
		let failedPath = path;
		if (clear === true && original !== null && !entry.includes(".delete-")) {
			try {
				const current = lstatSync(path);
				const marked = `${path}.delete-${process.pid}`;
				if (current.isDirectory() && current.dev === original.dev && current.ino === original.ino &&
					!existsSync(marked)) {
					renameSync(path, marked);
					failedPath = marked;
				}
			} catch {
				/* Keep the original path when a durable marker cannot be written safely. */
			}
		}
		const failed: ScratchVerdict = { dir: failedPath, action: "SKIP", reason: "delete-failed",
			owner, sizeBytes: dirSize(failedPath), cause };
		appendLog(home, { event: "delete-failed", dir: failedPath, at, entry: basename(failedPath), source_entry: entry,
			cause, error_code: errorCode });
		return failed;
	}
	const deleted: ScratchVerdict = { dir: path, action: "DELETE", reason, owner, sizeBytes: bytesBefore };
	appendLog(home, { event: "delete-quarantined", dir: path, at, entry, owner: owner?.pid ?? null });
	return deleted;
}
interface ReleaseRecord { owner: ScratchOwner; ownerText: string; markerText: string; releasedAt: string; legacy: boolean; legacyName: string | null }

const RELEASE_MARKER_REQUIRED = ["version", "owner_sha256", "device", "inode", "released_at"] as const;
const RELEASE_MARKER_OPTIONAL = ["legacy", "legacy_name", "release_reason", "release_actor", "legacy_owner_b64"] as const;

function parseReleaseMarker(text: string): Omit<ReleaseRecord, "owner" | "ownerText" | "legacy" | "legacyName"> & { ownerHash: string; device: string; inode: string; legacyName: string | null; releaseReason: string | null } | null {
	const seen: Record<string, string> = {};
	for (const line of text.split("\n")) {
		if (line === "") continue;
		const eq = line.indexOf("=");
		if (eq < 0) return null;
		const key = line.slice(0, eq);
		const value = line.slice(eq + 1);
		if (!(RELEASE_MARKER_REQUIRED as readonly string[]).includes(key) &&
			!(RELEASE_MARKER_OPTIONAL as readonly string[]).includes(key)) return null;
		if (value === "" || /[\t\r\n]/.test(value) || seen[key] !== undefined) return null;
		seen[key] = value;
	}
	for (const key of RELEASE_MARKER_REQUIRED) if (seen[key] === undefined) return null;
	if (seen.version !== "1" || !/^[0-9a-f]{64}$/.test(seen.owner_sha256!) || !/^\d+$/.test(seen.device!) ||
		!/^\d+$/.test(seen.inode!) || !Number.isFinite(Date.parse(seen.released_at!))) return null;
	const legacy = seen.legacy === "1";
	if (seen.legacy !== undefined && !legacy) return null;
	if (legacy && (seen.legacy_name === undefined || seen.release_reason === undefined)) return null;
	if (!legacy && (seen.legacy_name !== undefined || seen.release_reason !== undefined ||
		seen.release_actor !== undefined || seen.legacy_owner_b64 !== undefined)) return null;
	return { markerText: text, releasedAt: seen.released_at!, ownerHash: seen.owner_sha256!, device: seen.device!, inode: seen.inode!,
		legacyName: seen.legacy_name ?? null, releaseReason: seen.release_reason ?? null };
}

function readReleaseRecord(dir: string): ReleaseRecord | null {
	if (isSymlink(dir)) return null;
	const ownerPath = join(dir, ".owner");
	const markerPath = join(dir, RELEASE_FILE);
	if (isSymlink(markerPath)) return null;
	const markerText = readText(markerPath);
	if (markerText === null || isSymlink(ownerPath)) return null;
	const ownerText = readText(ownerPath);
	if (ownerText === null) return null;
	const marker = parseReleaseMarker(markerText);
	if (!marker) return null;
	let stat;
	try {
		stat = lstatSync(dir);
	} catch {
		return null;
	}
	if (!stat.isDirectory() || stat.isSymbolicLink() ||
		createHash("sha256").update(ownerText).digest("hex") !== marker.ownerHash ||
		String(stat.dev) !== marker.device || String(stat.ino) !== marker.inode) return null;
	if (!marker.legacyName) {
		const owner = parseOwnerFile(ownerText);
		if (!owner) return null;
		return { owner, ownerText, markerText, releasedAt: marker.releasedAt, legacy: false, legacyName: null };
	}
	const parsed = parseOwnerFile(ownerText);
	const suffixPid = /\.(\d+)$/.exec(marker.legacyName);
	const owner: ScratchOwner = parsed ?? { pid: suffixPid ? Number(suffixPid[1]) : 0, processStart: null,
		label: marker.legacyName, repo: "", createdAt: "", argv0: null, agent: null, session: null };
	return { owner, ownerText, markerText, releasedAt: marker.releasedAt, legacy: true, legacyName: marker.legacyName };
}

function callerIsOwnedBy(ownerPid: number, callerPid: number, run: ScratchRunner): boolean {
	if (ownerPid === callerPid) return true;
	const chain = ancestorPids(callerPid, run);
	return chain !== null && chain.slice(1).includes(ownerPid);
}

/** A successor seat: the same agent holding the omp session the owner record names, whatever its pid. */
function callerHoldsSeat(owner: ScratchOwner, deps: InspectDeps): boolean {
	if (owner.agent === null || owner.session === null) return false;
	const seat = deps.callerSeat ? deps.callerSeat() : callerSeat(deps.run);
	return seat.agent === owner.agent && seat.sessions.includes(owner.session);
}

export interface ScratchReleaseResult { ok: boolean; changed: boolean; dir: string; reason: string; ownerPid: number | null }

export interface ScratchReleaseOptions { legacyOwner?: boolean; reason?: string }

export function releaseScratch(path: string, home: string, deps: InspectDeps, opts: ScratchReleaseOptions = {}): ScratchReleaseResult {
	let dir: string;
	try {
		dir = resolve(path);
	} catch {
		return { ok: false, changed: false, dir: path, reason: "path-invalid", ownerPid: null };
	}
	const roots = resolveScratchRoots(home).map(root => resolve(root));
	const root = roots.find(candidate => dirname(dir) === candidate);
	if (!root || isSymlink(root)) return { ok: false, changed: false, dir, reason: "outside-scratch-root", ownerPid: null };
	let stat;
	try {
		stat = lstatSync(dir);
	} catch {
		return { ok: false, changed: false, dir, reason: "directory-unavailable", ownerPid: null };
	}
	if (!stat.isDirectory() || stat.isSymbolicLink()) return { ok: false, changed: false, dir, reason: "not-a-directory", ownerPid: null };
	const ownerPath = join(dir, ".owner");
	if (isSymlink(ownerPath)) return { ok: false, changed: false, dir, reason: "owner-file-unreadable", ownerPid: null };
	const ownerText = readText(ownerPath);
	const owner = ownerText === null ? null : parseOwnerFile(ownerText);
	if (!owner) return releaseLegacy(dir, home, deps, stat.dev, stat.ino, ownerText, opts);
	// The directory name is not part of the release authority: a respawn rewrites .owner to the successor's pid and keeps
	// the name (respawn_seat rehome), so the name suffix is the creator's pid. The caller check below is what binds the
	// release to its owner, and the marker pins the owner text and inode.
	if (!/^[A-Za-z0-9._%-]+$/.test(owner.label) || owner.label === "" || owner.label.includes("/") || owner.label.startsWith("."))
		return { ok: false, changed: false, dir, reason: "directory-owner-mismatch", ownerPid: owner.pid };
	const seatOwned = callerHoldsSeat(owner, deps);
	if (!seatOwned && !callerIsOwnedBy(owner.pid, process.pid, deps.run))
		return { ok: false, changed: false, dir, reason: "caller-not-owner", ownerPid: owner.pid };
	if (owner.processStart !== null && !seatOwned) {
		const state = probeOwner(owner.pid, owner.processStart, deps.liveness);
		if (state !== "live") {
			return { ok: false, changed: false, dir,
				reason: state === "reused" ? "owner-process-reused" : "owner-process-identity-unverified", ownerPid: owner.pid };
		}
	}
	const markerPath = join(dir, RELEASE_FILE);
	if (existsSync(markerPath)) {
		const prior = readReleaseRecord(dir);
		if (prior && prior.ownerText === ownerText) return { ok: true, changed: false, dir, reason: "already-released", ownerPid: owner.pid };
		return { ok: false, changed: false, dir, reason: "release-marker-already-present", ownerPid: owner.pid };
	}
	const releasedAt = new Date(deps.now ?? Date.now()).toISOString();
	const markerText = `version=1\nowner_sha256=${createHash("sha256").update(ownerText).digest("hex")}\ndevice=${stat.dev}\ninode=${stat.ino}\nreleased_at=${releasedAt}\n`;
	try {
		writeFileSync(markerPath, markerText, { encoding: "utf8", flag: "wx", mode: 0o600 });
	} catch {
		const prior = readReleaseRecord(dir);
		if (prior && prior.ownerText === ownerText) return { ok: true, changed: false, dir, reason: "already-released", ownerPid: owner.pid };
		return { ok: false, changed: false, dir, reason: "release-marker-write-failed", ownerPid: owner.pid };
	}
	const released = readReleaseRecord(dir);
	if (!released || released.markerText !== markerText || released.ownerText !== ownerText ||
		`${stat.dev}:${stat.ino}` !== inodeOf(dir))
		return { ok: false, changed: false, dir, reason: "directory-changed-during-release", ownerPid: owner.pid };
	appendLog(home, { event: "release", dir, at: releasedAt, owner: owner.pid });
	return { ok: true, changed: true, dir, reason: "owner-released", ownerPid: owner.pid };
}

/**
 * Operator release for dirs whose .owner is free-form (bare label, JSON, partial):
 * records the original owner text, the reason and the actor in the marker and
 * receipt. Refused without a reason; never marks a dir with open fds.
 */
function releaseLegacy(dir: string, home: string, deps: InspectDeps, dev: number, ino: number,
	ownerText: string | null, opts: ScratchReleaseOptions): ScratchReleaseResult {
	const reason = opts.reason?.trim() ?? "";
	if (opts.legacyOwner !== true || reason === "")
		return { ok: false, changed: false, dir, reason: "owner-file-invalid", ownerPid: null };
	if (/[\r\n\t]/.test(reason) || /[\r\n]/.test(basename(dir)))
		return { ok: false, changed: false, dir, reason: "release-reason-invalid", ownerPid: null };
	if (ownerText === null) return { ok: false, changed: false, dir, reason: "owner-file-unreadable", ownerPid: null };
	const clear = lsofClearDir(deps, dir);
	if (clear !== true) return { ok: false, changed: false, dir,
		reason: clear === null ? "lsof-evidence-unavailable" : "release-open-fds-present", ownerPid: null };
	const markerPath = join(dir, RELEASE_FILE);
	if (existsSync(markerPath)) {
		const prior = readReleaseRecord(dir);
		if (prior && prior.legacy && prior.ownerText === ownerText) return { ok: true, changed: false, dir, reason: "already-released", ownerPid: prior.owner.pid };
		return { ok: false, changed: false, dir, reason: "release-marker-already-present", ownerPid: null };
	}
	const releasedAt = new Date(deps.now ?? Date.now()).toISOString();
	const markerText = `version=1\nlegacy=1\nlegacy_name=${basename(dir)}\nrelease_reason=${reason}\nrelease_actor=${process.pid}\nlegacy_owner_b64=${Buffer.from(ownerText, "utf8").toString("base64")}\nowner_sha256=${createHash("sha256").update(ownerText).digest("hex")}\ndevice=${dev}\ninode=${ino}\nreleased_at=${releasedAt}\n`;
	try {
		writeFileSync(markerPath, markerText, { encoding: "utf8", flag: "wx", mode: 0o600 });
	} catch {
		const prior = readReleaseRecord(dir);
		if (prior && prior.legacy && prior.ownerText === ownerText) return { ok: true, changed: false, dir, reason: "already-released", ownerPid: prior.owner.pid };
		return { ok: false, changed: false, dir, reason: "release-marker-write-failed", ownerPid: null };
	}
	const released = readReleaseRecord(dir);
	if (!released || !released.legacy || released.markerText !== markerText || released.ownerText !== ownerText ||
		`${dev}:${ino}` !== inodeOf(dir))
		return { ok: false, changed: false, dir, reason: "directory-changed-during-release", ownerPid: null };
	appendLog(home, { event: "release", dir, at: releasedAt, owner: released.owner.pid, legacy: true, reason });
	return { ok: true, changed: true, dir, reason: "owner-released-legacy", ownerPid: released.owner.pid };
}
export interface ScratchCreateResult { ok: boolean; dir: string; exportLine: string; reason: string }

/**
 * Canonical scratch create: <repo>/var/agent-tmp/<label>.<pid>/ with a valid
 * .owner (pid, process start, label, repo, created). Agents call this instead
 * of hand-writing .owner files; hand-written bare-label owners are reported
 * as malformed-owner-file with per-root counts in the plan totals.
 */
export function createScratch(label: string, repoDir: string, deps: InspectDeps): ScratchCreateResult {
	if (!/^[A-Za-z0-9][A-Za-z0-9._%-]*$/.test(label)) return { ok: false, dir: "", exportLine: "", reason: "label-invalid" };
	let repo: string;
	try {
		repo = resolve(repoDir);
	} catch {
		return { ok: false, dir: "", exportLine: "", reason: "repo-invalid" };
	}
	const start = deps.liveness.processStart(process.pid);
	if (start === null) return { ok: false, dir: "", exportLine: "", reason: "process-identity-unavailable" };
	const root = join(repo, "var", "agent-tmp");
	const dir = join(root, `${label}.${process.pid}`);
	const createdAt = new Date(deps.now ?? Date.now()).toISOString();
	const argv = process.argv[1] ?? process.argv[0] ?? "unknown";
	const seat = deps.callerSeat?.();
	const durable = seat?.agent && seat.main ? `agent=${seat.agent}\nsession=${seat.main}\n` : "";
	const ownerText = `pid=${process.pid}\nprocess_start=${start}\nlabel=${label}\nrepo=${repo}\ncreated_at=${createdAt}\nargv0=${argv}\n${durable}`;
	try {
		mkdirSync(root, { recursive: true, mode: 0o700 });
	} catch {
		return { ok: false, dir: "", exportLine: "", reason: "root-create-failed" };
	}
	try {
		mkdirSync(dir, { mode: 0o700 });
	} catch {
		return { ok: false, dir: "", exportLine: "", reason: "directory-create-failed" };
	}
	try {
		writeFileSync(join(dir, ".owner"), ownerText, { encoding: "utf8", flag: "wx", mode: 0o600 });
	} catch {
		return { ok: false, dir: "", exportLine: "", reason: "owner-write-failed" };
	}
	const parsed = parseOwnerFile(ownerText);
	if (!parsed || parsed.pid !== process.pid) return { ok: false, dir, exportLine: "", reason: "owner-unreadable-after-create" };
	return { ok: true, dir, exportLine: `export TMPDIR=${dir}`, reason: "created" };
}

/** Move an owner-released session to quarantine without requiring its process to exit. */
function applyReleased(dir: string, root: string, verdict: ScratchVerdict, deps: ApplyDeps): ScratchVerdict {
	const fail = (reason: string): ScratchVerdict => ({ ...verdict, action: "SKIP", reason });
	const released = readReleaseRecord(dir);
	if (!released || dirname(dir) !== root || (released.legacy && basename(dir) !== released.legacyName))
		return fail("owner-release-changed-after-initial-check");
	if (!released.legacy && !ownerMatchesScratchRoot(released.owner, root, dir, deps)) return fail("owner-repo-outside-scratch-root");
	const identity = inodeOf(dir);
	if (identity === null) return fail("inode-proof-unavailable");
	const clearBefore = lsofClearDir(deps, dir);
	if (clearBefore !== true) return fail(clearBefore === null ? "lsof-evidence-unavailable" : "owner-released-but-open-fds-present");
	const at = new Date(deps.now ?? Date.now()).toISOString();
	const entry = quarantineEntryFor(basename(dir), new Date(deps.now ?? Date.now()));
	const qt = quarantineDir(deps.home);
	try {
		mkdirSync(qt, { recursive: true, mode: 0o700 });
	} catch {
		return fail("quarantine-create-failed");
	}
	const moved = join(qt, entry);
	try {
		renameSync(dir, moved);
	} catch {
		return fail("atomic-quarantine-failed");
	}
	const afterMove = readReleaseRecord(moved);
	const clearAfter = lsofClearDir(deps, moved);
	if (inodeOf(moved) !== identity || !afterMove || afterMove.markerText !== released.markerText ||
		afterMove.ownerText !== released.ownerText || (!afterMove.legacy && !ownerMatchesScratchRoot(afterMove.owner, root, moved, deps)) ||
		clearAfter !== true) {
		try {
			renameSync(moved, dir);
		} catch {
			return { ...verdict, dir: moved, action: "SKIP", reason: "final-recheck-refused" };
		}
		return fail("final-recheck-refused");
	}
	appendLog(deps.home, { event: "quarantine", dir, at, entry, owner: released.owner.pid, reason: "owner-released", sizeBytes: verdict.sizeBytes });
	return { ...verdict, dir: moved, action: "QUARANTINE", reason: "owner-released-quarantined" };
}


function ownerSnapshot(owner: ScratchOwner): string {
	return [owner.pid, owner.processStart ?? "", owner.label, owner.repo, owner.createdAt, owner.argv0 ?? "", owner.agent ?? "", owner.session ?? ""].join("\n");
}

/** Atomic quarantine + full recheck, then delete. Returns the terminal action. */
export function applyReap(dir: string, root: string, verdict: ScratchVerdict, deps: ApplyDeps): ScratchVerdict {
	const now = deps.now ?? Date.now();
	const at = new Date(now).toISOString();
	const fail = (reason: string): ScratchVerdict => {
		const failed = { ...verdict, action: "SKIP" as const, reason };
		appendLog(deps.home, { event: reason === "final-recheck-refused" ? "skip" : "failure", dir: failed.dir, at,
			action: failed.action, reason, error: reason });
		return failed;
	};
	if (!verdict.owner) return fail("owner-changed-after-initial-check");
	if (!ownerMatchesScratchRoot(verdict.owner, root, dir, deps)) return fail("owner-repo-outside-scratch-root");
	const expected = ownerSnapshot(verdict.owner);
	const identity = inodeOf(dir);
	if (identity === null) return fail("inode-proof-unavailable");
	const entry = quarantineEntryFor(dir.slice(root.length + 1));
	const qt = quarantineDir(deps.home);
	try {
		mkdirSync(qt, { recursive: true, mode: 0o700 });
	} catch {
		return fail("quarantine-create-failed");
	}
	const moved = join(qt, entry);
	try {
		renameSync(dir, moved);
	} catch {
		return fail("atomic-quarantine-failed");
	}
	if (isSymlink(moved)) return { ...verdict, dir: moved, action: "SKIP", reason: "path-replaced-with-non-directory" };
	if (inodeOf(moved) !== identity) return { ...verdict, dir: moved, action: "SKIP", reason: "inode-changed-before-delete" };
	const recheck = inspectSession(moved, qt, deps, false, root);
	if (recheck.action !== "REAP" || !recheck.owner || ownerSnapshot(recheck.owner) !== expected) {
		try {
			renameSync(moved, dir);
		} catch {
			return { ...verdict, dir: moved, action: "SKIP", reason: "final-recheck-refused" };
		}
		return fail("final-recheck-refused");
	}
	const deleting = join(qt, `${entry}.delete-${process.pid}`);
	try {
		renameSync(moved, deleting);
	} catch {
		return { ...verdict, dir: moved, action: "SKIP", reason: "delete-quarantine-failed" };
	}
	const finalText = readText(join(deleting, ".owner"));
	const finalOwner = finalText === null ? null : parseOwnerFile(finalText);
	if (isSymlink(deleting) || inodeOf(deleting) !== identity || !finalOwner || ownerSnapshot(finalOwner) !== expected ||
		!ownerMatchesScratchRoot(finalOwner, root, deleting, deps) || lsofClearDir(deps, deleting) !== true) {
		return { ...verdict, dir: deleting, action: "SKIP", reason: "final-delete-recheck-failed" };
	}
	try {
		rmSync(deleting, { recursive: true, force: true });
	} catch {
		return { ...verdict, dir: deleting, action: "SKIP", reason: "delete-failed" };
	}
	if (existsSync(deleting)) return { ...verdict, dir: deleting, action: "SKIP", reason: "delete-failed" };
	appendLog(deps.home, { event: "reap", dir, at, owner: expected.split("\n")[0], sizeBytes: verdict.sizeBytes });
	return { ...verdict, action: "REAP", reason: `${verdict.reason}-applied` };
}

/** Unowned entry lifecycle: idle 72h -> quarantine, configured TTL -> delete (with rechecks). */
export function applyUnowned(dir: string, root: string, deps: ApplyDeps, planned?: ScratchVerdict): ScratchVerdict {
	const now = deps.now ?? Date.now();
	const at = new Date(now).toISOString();
	const base: ScratchVerdict = { dir, action: "SKIP", reason: "unknown", owner: planned?.owner ?? null, sizeBytes: 0 };
	if (isSymlink(dir)) return { ...base, reason: "session-is-symlink" };
	const freshest = idleSince(dir, now);
	if (freshest === null) return { ...base, reason: "idle-proof-unavailable" };
	if (freshest >= now - QUARANTINE_IDLE_MS) return { ...base, action: "LIVE", reason: "unowned-but-active" };
	const ownerBefore = readText(join(dir, ".owner"));
	const currentOwner = ownerBefore === null ? null : parseOwnerFile(ownerBefore);
	if (planned && (planned.owner === null ? currentOwner !== null :
		currentOwner === null || ownerSnapshot(planned.owner) !== ownerSnapshot(currentOwner))) {
		return { ...base, owner: currentOwner, reason: "final-recheck-refused" };
	}
	if (currentOwner) {
		if (!ownerMatchesScratchRoot(currentOwner, root, dir, deps)) {
			return { ...base, owner: currentOwner, reason: "owner-repo-outside-scratch-root" };
		}
		if (inspectOne(dir, root, deps)?.action !== "QUARANTINE") {
			return { ...base, owner: currentOwner, reason: "final-recheck-refused" };
		}
	}
	const entry = quarantineEntryFor(dir.slice(root.length + 1));
	const qt = quarantineDir(deps.home);
	try {
		mkdirSync(qt, { recursive: true, mode: 0o700 });
	} catch {
		return { ...base, reason: "quarantine-create-failed" };
	}
	const identity = inodeOf(dir);
	if (identity === null) return { ...base, reason: "inode-proof-unavailable" };
	const clearBefore = lsofClearDir(deps, dir);
	if (clearBefore !== true) return { ...base,
		reason: clearBefore === null ? "lsof-evidence-unavailable" : "owner-released-but-open-fds-present",
		...(clearBefore === false ? { cause: "open-fd" as const } : { cause: "lsof-unavailable" as const }) };
	const moved = join(qt, entry);
	try {
		renameSync(dir, moved);
	} catch {
		return { ...base, reason: "atomic-quarantine-failed" };
	}
	const ownerAfter = readText(join(moved, ".owner"));
	if (inodeOf(moved) !== identity || ownerAfter !== ownerBefore ||
		(currentOwner !== null && !ownerMatchesScratchRoot(currentOwner, root, moved, deps)) ||
		lsofClearDir(deps, moved) !== true) {
		try {
			renameSync(moved, dir);
		} catch {
			return { ...base, dir: moved, reason: "final-recheck-refused" };
		}
		return { ...base, reason: "final-recheck-refused" };
	}
	appendLog(deps.home, { event: "quarantine", dir, at, entry, sizeBytes: dirSize(moved) });
	const mismatch = planned?.reason === "mismatched-owner-idle-72h-would-quarantine";
	return { ...base, dir: moved, action: "QUARANTINE",
		reason: mismatch ? "mismatched-owner-idle-72h-quarantined" : "unowned-idle-72h-quarantined", sizeBytes: dirSize(moved) };
}

/** Expired quarantine entries are deleted after owner-release or lsof rechecks. */
export function applyQuarantineExpiry(home: string, deps: ApplyDeps): ScratchVerdict[] {
	const done: ScratchVerdict[] = [];
	const now = deps.now ?? Date.now();
	const at = new Date(now).toISOString();
	const qt = quarantineDir(home);
	let ttlMs: number;
	try {
		ttlMs = quarantineTtlMs();
	} catch (error) {
		const failed: ScratchVerdict = { dir: qt, action: "SKIP", reason: "quarantine-ttl-config-invalid",
			owner: null, sizeBytes: 0 };
		done.push(failed);
		appendLog(home, { event: "quarantine-ttl-config-invalid", dir: qt, at, error: error instanceof Error ? error.message : String(error) });
		return done;
	}
	let entries: string[];
	try {
		entries = readdirSync(qt);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return done;
		const failed: ScratchVerdict = { dir: qt, action: "SKIP", reason: "quarantine-read-failed", owner: null, sizeBytes: 0 };
		done.push(failed);
		appendLog(home, { event: "quarantine-read-failed", dir: qt, at, error: error instanceof Error ? error.message : String(error) });
		return done;
	}
	for (const entry of entries) {
		if (entry.startsWith(".")) continue;
		const quarantinedAt = quarantineTimeOf(entry);
		if (quarantinedAt === null || now - quarantinedAt < ttlMs) continue;
		const path = join(qt, entry);
		if (isSymlink(path)) {
			done.push({ dir: path, action: "SKIP", reason: "quarantine-symlink", owner: null, sizeBytes: 0 });
			continue;
		}
		const released = readReleaseRecord(path);
		if (released) {
			const identity = inodeOf(path);
			if (identity === null) {
				done.push({ dir: path, action: "SKIP", reason: "inode-proof-unavailable", owner: released.owner, sizeBytes: dirSize(path) });
				continue;
			}
			const clearBefore = lsofClearDir(deps, path);
			if (clearBefore !== true) {
				done.push({ dir: path, action: "SKIP", reason: clearBefore === null ? "lsof-evidence-unavailable" : "owner-released-but-open-fds-present",
					owner: released.owner, sizeBytes: dirSize(path), ...(clearBefore === false ? { cause: "open-fd" as const } : { cause: "lsof-unavailable" as const }) });
				continue;
			}
			const rechecked = readReleaseRecord(path);
			if (!rechecked || rechecked.markerText !== released.markerText || rechecked.ownerText !== released.ownerText ||
				inodeOf(path) !== identity || lsofClearDir(deps, path) !== true) {
				done.push({ dir: path, action: "SKIP", reason: "final-recheck-refused", owner: released.owner, sizeBytes: dirSize(path) });
				continue;
			}
			done.push(removeExpiredEntry(path, entry, released.owner, "quarantine-expired-owner-released", home, deps, at));
			continue;
		}
		const { owner, malformed } = readOwner(path);
		if (!owner || malformed || !hasProcessIdentity(owner)) {
			const clear = lsofClearDir(deps, path);
			if (clear !== true) {
				done.push({ dir: path, action: "SKIP", reason: clear === null ? "lsof-evidence-unavailable" : "owner-released-but-open-fds-present",
					owner, sizeBytes: dirSize(path), ...(clear === false ? { cause: "open-fd" as const } : { cause: "lsof-unavailable" as const }) });
				continue;
			}
			done.push(removeExpiredEntry(path, entry, owner, "quarantine-expired", home, deps, at));
			continue;
		}
		const state = probeOwner(owner.pid, owner.processStart, deps.liveness);
		if (state !== "dead" && state !== "reused") {
			done.push({ dir: path, action: "SKIP", reason: state === "unknown" ? "owner-liveness-unproven" : "quarantine-owner-active", owner, sizeBytes: dirSize(path) });
			continue;
		}
		const clear = lsofClearDir(deps, path);
		if (clear !== true) {
			done.push({ dir: path, action: "SKIP", reason: clear === null ? "lsof-evidence-unavailable" : "owner-released-but-open-fds-present",
				owner, sizeBytes: dirSize(path), ...(clear === false ? { cause: "open-fd" as const } : { cause: "lsof-unavailable" as const }) });
			continue;
		}
		done.push(removeExpiredEntry(path, entry, owner, `quarantine-expired-owner-${state}`, home, deps, at));
	}
	return done;
}

/** TERM, bounded wait, then KILL; true iff the pid is gone after. Exported as a test seam. */
export function killOrphan(pid: number, deps: ApplyDeps): boolean {
	const kill = deps.kill ?? ((target: number): boolean => {
		try {
			process.kill(target, "SIGTERM");
		} catch (error) {
			// Already gone is the goal, not a failure (the orphan raced us).
			return (error as NodeJS.ErrnoException).code === "ESRCH";
		}
		const end = Date.now() + 5000;
		while (Date.now() < end) {
			try {
				process.kill(target, 0);
			} catch {
				return true;
			}
			Bun.sleepSync(200);
		}
		try {
			process.kill(target, "SIGKILL");
		} catch {
			return false;
		}
		try {
			process.kill(target, 0);
			return false;
		} catch {
			return true;
		}
	});
	return kill(pid);
}

export interface ScratchTotals { sizeByVerdict: Record<string, number>; countByVerdict: Record<string, number>; sizeByRoot: Record<string, number>; malformedByRoot: Record<string, number> }

/** What makes an unowned dir "active": newest mtime in the tree within 72h. Stated here so plan output and help text share it. */
export const UNOWNED_ACTIVE_RULE = "unowned dir with newest mtime in tree within 72h is LIVE unowned-but-active; idle past 72h with no open fds goes to quarantine";

export function summarizeScratch(sessions: ScratchVerdict[], roots: string[]): ScratchTotals {
	const totals: ScratchTotals = { sizeByVerdict: {}, countByVerdict: {}, sizeByRoot: {}, malformedByRoot: {} };
	for (const verdict of sessions) {
		const key = `${verdict.action}:${verdict.reason}`;
		totals.sizeByVerdict[key] = (totals.sizeByVerdict[key] ?? 0) + verdict.sizeBytes;
		totals.countByVerdict[key] = (totals.countByVerdict[key] ?? 0) + 1;
		const root = roots.find(candidate => verdict.dir.startsWith(candidate + "/")) ?? dirname(verdict.dir);
		totals.sizeByRoot[root] = (totals.sizeByRoot[root] ?? 0) + verdict.sizeBytes;
		if (verdict.reason === "malformed-owner-file" || verdict.reason === "malformed-owner-file-but-active")
			totals.malformedByRoot[root] = (totals.malformedByRoot[root] ?? 0) + 1;
	}
	return totals;
}

export type ScratchPressure = "NORMAL" | "WARN" | "RECLAIM" | "UNKNOWN";
/** `sources` records where the root came from (override, developer, fleet-watch:<session>, herdr:<session>, chief, fleet-test-tmp, temp, system-work). */
export interface ScratchRootMetric { root: string; free_pct: number | null; scratch_gb: number; sources: string[] }
export interface QuarantineBucket { entries: number; bytes: number }
export interface QuarantineBucketReport {
	young: QuarantineBucket;
	expiredHeld: QuarantineBucket;
	failed: QuarantineBucket;
	oldestAgeMs: number | null;
	readable: boolean;
	ttlValid: boolean;
}

export function measureDiskFreePercent(path: string, readStats?: (path: string) => DiskCapacity | null): number | null {
	let stats: DiskCapacity | null;
	try {
		stats = readStats ? readStats(path) : statfsSync(path);
	} catch {
		return null;
	}
	if (stats === null || !Number.isFinite(stats.bavail) || !Number.isFinite(stats.blocks) ||
		stats.blocks <= 0 || stats.bavail < 0) return null;
	return Math.min(100, stats.bavail / stats.blocks * 100);
}

export function classifyScratchPressure(freePct: number | null): ScratchPressure {
	if (freePct === null || !Number.isFinite(freePct) || freePct < 0) return "UNKNOWN";
	if (freePct <= 20) return "RECLAIM";
	if (freePct <= 25) return "WARN";
	return "NORMAL";
}

export function scratchRootMetrics(roots: string[], sizeByRoot: Record<string, number>,
	readStats?: (path: string) => DiskCapacity | null, sources: ReadonlyMap<string, string[]> = new Map()): ScratchRootMetric[] {
	const metrics: ScratchRootMetric[] = [];
	for (const root of roots) {
		metrics.push({
			root,
			free_pct: measureDiskFreePercent(root, readStats),
			scratch_gb: (sizeByRoot[root] ?? 0) / 1_000_000_000,
			sources: sources.get(root) ?? [],
		});
	}
	return metrics;
}

/** Sources per root for the plan: the resolved roots keep theirs, system work parents are recorded as system-work. */
function rootSourceMap(entries: readonly ScratchRootEntry[], systemWorkDirs: readonly string[]): Map<string, string[]> {
	const sources = new Map<string, string[]>(entries.map(entry => [entry.root, entry.sources]));
	for (const parent of systemWorkDirs.map(dirname)) {
		const known = sources.get(parent);
		if (known === undefined) sources.set(parent, ["system-work"]);
		else if (!known.includes("system-work")) known.push("system-work");
	}
	return sources;
}

export function quarantineBuckets(home: string, now = Date.now(), ttlMs?: number,
	failedPaths: ReadonlySet<string> = new Set()): QuarantineBucketReport {
	const report: QuarantineBucketReport = {
		young: { entries: 0, bytes: 0 },
		expiredHeld: { entries: 0, bytes: 0 },
		failed: { entries: 0, bytes: 0 },
		oldestAgeMs: null,
		readable: true,
		ttlValid: true,
	};
	let ttl = ttlMs;
	if (ttl === undefined) {
		try {
			ttl = quarantineTtlMs();
		} catch {
			ttl = DEFAULT_QUARANTINE_TTL_HOURS * 3600 * 1000;
			report.ttlValid = false;
		}
	}
	const path = quarantineDir(home);
	let entries: string[];
	try {
		entries = readdirSync(path);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "ENOENT") report.readable = false;
		return report;
	}
	for (const entry of entries) {
		const quarantinedAt = quarantineTimeOf(entry);
		if (quarantinedAt === null) continue;
		const age = Math.max(0, now - quarantinedAt);
		report.oldestAgeMs = report.oldestAgeMs === null ? age : Math.max(report.oldestAgeMs, age);
		const itemPath = join(path, entry);
		let bytes: number;
		try {
			bytes = isSymlink(itemPath) ? lstatSync(itemPath).size : dirSize(itemPath);
		} catch {
			report.readable = false;
			continue;
		}
		const bucket = age < ttl ? report.young
			: entry.includes(".delete-") || failedPaths.has(itemPath) ? report.failed
				: report.expiredHeld;
		bucket.entries++;
		bucket.bytes += bytes;
	}
	return report;
}

function pressureForRoots(metrics: ScratchRootMetric[]): ScratchPressure {
	let minimum: number | null = null;
	for (const metric of metrics) {
		if (metric.free_pct === null) continue;
		minimum = minimum === null ? metric.free_pct : Math.min(minimum, metric.free_pct);
	}
	return classifyScratchPressure(minimum);
}

/** One directory through the full plan verdict (owner release, live/dead identity and unowned age). */
export function inspectOne(dir: string, root: string, deps: InspectDeps, nameRequired = true): ScratchVerdict | null {
	deps.onInspect?.(dir);
	try {
		if (!statSync(dir).isDirectory() || isSymlink(dir)) return null;
	} catch {
		return null;
	}
	const released = readReleaseRecord(dir);
	// A verified owner release (marker bound to the owner text, device and inode) stands whatever the directory's name,
	// since a respawn rehomes .owner to the successor and keeps the creator's pid in the name.
	const releasedNameOk = released !== null && (!released.legacy || basename(dir) === released.legacyName);
	if (released && !released.legacy && !ownerMatchesScratchRoot(released.owner, root, dir, deps)) {
		return { dir, action: "SKIP", reason: "owner-repo-outside-scratch-root", owner: released.owner, sizeBytes: dirSize(dir) };
	}
	if (released && dirname(dir) === root && resolve(dir) === dir && releasedNameOk) {
		return { dir, action: "QUARANTINE", reason: "owner-released-would-quarantine",
			owner: released.owner, sizeBytes: dirSize(dir) };
	}
	const verdict = inspectSession(dir, root, deps, nameRequired);
	const mismatch = verdict.action === "SKIP" && verdict.reason === "session-name-owner-mismatch";
	let quarantineCandidate = verdict;
	if (mismatch) {
		const proof = inspectSession(dir, root, deps, false);
		// A live or unproven owner stays SKIP. Only a dead, fd-clear owner can age into quarantine.
		if (proof.action !== "REAP") return verdict;
		quarantineCandidate = proof;
	}
	if (mismatch || (verdict.action === "SKIP" && (verdict.reason === "no-owner-file" ||
		verdict.reason === "malformed-owner-file" || verdict.reason === "owner-identity-incomplete"))) {
		const freshest = idleSince(dir, deps.now ?? Date.now());
		if (freshest !== null && freshest < (deps.now ?? Date.now()) - QUARANTINE_IDLE_MS) {
			return { ...quarantineCandidate, action: "QUARANTINE",
				reason: mismatch ? "mismatched-owner-idle-72h-would-quarantine" : "unowned-idle-72h-would-quarantine",
				sizeBytes: dirSize(dir) };
		}
		if (!mismatch) return verdict.reason === "malformed-owner-file"
			? { ...verdict, action: "LIVE", reason: "malformed-owner-file-but-active" }
			: { ...verdict, action: "LIVE", reason: "unowned-but-active" };
	}
	return verdict;
}

/** Test-run work dirs nested inside a session dir (omp-kit-integrations-* and omp-kit-work.*): visited without the name-pid suffix rule so the dead-pid rule applies wherever TMPDIR put them. Pid-less names fall through to the unowned lifecycle. */
const NESTED_WORKDIR = /^omp-kit-(integrations-|work\.)/;

function eachSessionDir(root: string, visit: (dir: string) => void, visitNested: (dir: string) => void = visit): void {
	let entries: string[];
	try {
		entries = readdirSync(root);
	} catch {
		return;
	}
	for (const entry of entries) {
		if (entry === "." || entry === "..") continue;
		visit(join(root, entry));
	}
	for (const entry of entries) {
		if (entry === "." || entry === "..") continue;
		let children: string[];
		try {
			children = readdirSync(join(root, entry));
		} catch {
			continue;
		}
		for (const child of children) {
			if (NESTED_WORKDIR.test(child)) visitNested(join(root, entry, child));
		}
	}
}

export interface ScratchPlan {
	roots: string[];
	sessions: ScratchVerdict[];
	orphans: OrphanProcess[];
	reapableBytes: number;
	quarantinableBytes: number;
	totals: ScratchTotals;
	rootMetrics: ScratchRootMetric[];
	pressure: ScratchPressure;
	quarantineBuckets: QuarantineBucketReport;
	unownedActiveRule: string;
}


/**
 * REAP2 (ompkit-azpk): strip nested rows' bytes from ancestors so each byte
 * counts once. A parent session dir's dirSize sums its whole tree, but nested
 * session dirs (omp-kit-integrations-*) are plan rows themselves.
 */
export function dedupeNestedSizes(sessions: ScratchVerdict[]): ScratchVerdict[] {
	const sizes = new Map(sessions.map(verdict => [verdict.dir, verdict.sizeBytes] as const));
	return sessions.map(verdict => {
		let own = verdict.sizeBytes;
		for (const [dir, size] of sizes) {
			if (dir !== verdict.dir && dir.startsWith(verdict.dir + "/")) own -= size;
		}
		return own === verdict.sizeBytes ? verdict : { ...verdict, sizeBytes: Math.max(0, own) };
	});
}
export function planScratch(home: string, deps: InspectDeps): ScratchPlan {
	const entries = resolveScratchRootEntries(home);
	const roots = entries.map(entry => entry.root);
	const systemWorkDirs = resolveSystemWorkDirs();
	const sessions: ScratchVerdict[] = [];
	const snapDeps: InspectDeps = { ...deps, lsofSnapshot: takeLsofSnapshot(deps.run, deps.lsofTimeoutMs ?? LSOF_TIMEOUT_MS) };
	const visit = (dir: string, root: string, nameRequired = true) => {
		const verdict = inspectOne(dir, root, snapDeps, nameRequired);
		if (verdict === null) return;
		sessions.push(verdict);
		deps.onProgress?.(verdict);
	};
	for (const root of roots) eachSessionDir(root, dir => visit(dir, root), dir => visit(dir, root, false));
	for (const dir of systemWorkDirs) visit(dir, dirname(dir), false);
	const allRoots = [...new Set([...roots, ...systemWorkDirs.map(dirname)])];
	const orphans = selectHarnessOrphans(listProcesses(deps.run));
	const sized = dedupeNestedSizes(sessions);
	const totals = summarizeScratch(sized, allRoots);
	const rootMetrics = scratchRootMetrics(allRoots, totals.sizeByRoot, deps.statfs, rootSourceMap(entries, systemWorkDirs));
	return { roots: allRoots, sessions: sized, orphans, totals, rootMetrics,
		pressure: pressureForRoots(rootMetrics), quarantineBuckets: quarantineBuckets(home, deps.now ?? Date.now()),
		unownedActiveRule: UNOWNED_ACTIVE_RULE,
		reapableBytes: sized.filter(v => v.action === "REAP").reduce((n, v) => n + v.sizeBytes, 0),
		quarantinableBytes: sized.filter(v => v.action === "QUARANTINE").reduce((n, v) => n + v.sizeBytes, 0) };
}

export interface ScratchRunReceipt {
	started_at: string;
	finished_at: string;
	free_pct_before: number | null;
	free_pct_after: number | null;
	reaped_gb: number;
	quarantined_gb: number;
	deleted_gb: number;
	failed_count: number;
	failed_gb: number;
	refused_count: number;
	refused_gb: number;
}

export interface ScratchApplyResult extends ScratchPlan {
	applied: ScratchVerdict[];
	killed: { pid: number; command: string; ok: boolean }[];
	expired: ScratchVerdict[];
	receipt: ScratchRunReceipt;
}

export function applyScratch(home: string, deps: ApplyDeps): ScratchApplyResult {
	const now = deps.now ?? Date.now();
	const startedAt = new Date(now).toISOString();
	const freePctBefore = measureDiskFreePercent(home, deps.statfs);
	const entries = resolveScratchRootEntries(home);
	const roots = entries.map(entry => entry.root);
	const systemWorkDirs = resolveSystemWorkDirs();
	const allRoots = [...new Set([...roots, ...systemWorkDirs.map(dirname)])];
	const planned: { verdict: ScratchVerdict; root: string }[] = [];
	const snapDeps: ApplyDeps = { ...deps, lsofSnapshot: takeLsofSnapshot(deps.run, deps.lsofTimeoutMs ?? LSOF_TIMEOUT_MS) };
	const collect = (dir: string, root: string, nameRequired = true) => {
		const verdict = inspectOne(dir, root, snapDeps, nameRequired);
		if (verdict !== null) planned.push({ verdict, root });
	};
	for (const root of roots) eachSessionDir(root, dir => collect(dir, root), dir => collect(dir, root, false));
	for (const dir of systemWorkDirs) collect(dir, dirname(dir), false);
	const sessions: ScratchVerdict[] = [];
	const applied: ScratchVerdict[] = [];
	for (let index = 0; index < planned.length; index++) {
		const row = planned[index]!;
		const verdict = row.verdict;
		sessions.push(verdict);
		let terminal = verdict;
		const fresh: ApplyDeps = { ...deps, lsofSnapshot: takeLsofSnapshot(deps.run, deps.lsofTimeoutMs ?? LSOF_TIMEOUT_MS) };
		let actionRoot = dirname(verdict.dir);
		for (const candidate of allRoots) {
			if (verdict.dir.startsWith(candidate + "/")) {
				actionRoot = candidate;
				break;
			}
		}
		if (verdict.action === "REAP") terminal = applyReap(verdict.dir, actionRoot, verdict, fresh);
		else if (verdict.action === "QUARANTINE") {
			terminal = verdict.reason === "owner-released-would-quarantine"
				? applyReleased(verdict.dir, row.root, verdict, fresh)
				: applyUnowned(verdict.dir, actionRoot, fresh, verdict);
		}
		applied.push(terminal);
		if (terminal.action === "SKIP") appendLog(home, { event: isApplyFailure(terminal) ? "failure" : "skip",
			dir: terminal.dir, at: new Date(now).toISOString(), action: terminal.action, reason: terminal.reason, error: terminal.reason });
		deps.onProgress?.(terminal, { done: index + 1, total: planned.length });
	}
	const orphans = selectHarnessOrphans(listProcesses(deps.run));
	const killed = orphans.map(proc => {
		const ok = killOrphan(proc.pid, deps);
		appendLog(home, { event: "orphan-kill", dir: "", at: new Date(now).toISOString(), pid: proc.pid, command: proc.command, ok });
		return { pid: proc.pid, command: proc.command, ok };
	});
	const expired = applyQuarantineExpiry(home, deps);
	const planEcho = dedupeNestedSizes(sessions);
	const totals = summarizeScratch(planEcho, allRoots);
	const rootMetrics = scratchRootMetrics(allRoots, totals.sizeByRoot, deps.statfs, rootSourceMap(entries, systemWorkDirs));
	const pressure = pressureForRoots(rootMetrics);
	const failedPaths = new Set<string>();
	for (const verdict of expired) if (verdict.reason === "delete-failed") failedPaths.add(verdict.dir);
	const buckets = quarantineBuckets(home, now, undefined, failedPaths);
	const freePctAfter = measureDiskFreePercent(home, deps.statfs);
	let reapedBytes = 0;
	let quarantinedBytes = 0;
	let deletedBytes = 0;
	let failedBytes = 0;
	let refusedBytes = 0;
	let failedCount = 0;
	let refusedCount = 0;
	for (const verdict of applied) {
		if (verdict.action === "REAP") reapedBytes += verdict.sizeBytes;
		if (verdict.action === "QUARANTINE") quarantinedBytes += verdict.sizeBytes;
		if (verdict.action !== "SKIP") continue;
		if (isApplyFailure(verdict)) {
			failedCount++;
			failedBytes += verdict.sizeBytes;
		} else {
			refusedCount++;
			refusedBytes += verdict.sizeBytes;
		}
	}
	for (const verdict of expired) {
		if (verdict.action === "DELETE") deletedBytes += verdict.sizeBytes;
		if (verdict.action !== "SKIP") continue;
		if (isApplyFailure(verdict)) {
			failedCount++;
			failedBytes += verdict.sizeBytes;
		} else {
			refusedCount++;
			refusedBytes += verdict.sizeBytes;
		}
	}
	for (const kill of killed) if (!kill.ok) failedCount++;
	const finishedAt = new Date(now).toISOString();
	const receipt: ScratchRunReceipt = {
		started_at: startedAt,
		finished_at: finishedAt,
		free_pct_before: freePctBefore,
		free_pct_after: freePctAfter,
		reaped_gb: reapedBytes / 1_000_000_000,
		quarantined_gb: quarantinedBytes / 1_000_000_000,
		deleted_gb: deletedBytes / 1_000_000_000,
		failed_count: failedCount,
		failed_gb: failedBytes / 1_000_000_000,
		refused_count: refusedCount,
		refused_gb: refusedBytes / 1_000_000_000,
	};
	appendLog(home, { event: "run-receipt", dir: "", at: finishedAt, ...receipt });
	return {
		roots: allRoots,
		sessions: planEcho,
		orphans,
		applied,
		killed,
		expired,
		totals,
		rootMetrics,
		pressure,
		quarantineBuckets: buckets,
		unownedActiveRule: UNOWNED_ACTIVE_RULE,
		reapableBytes: reapedBytes,
		quarantinableBytes: quarantinedBytes,
		receipt,
	};
}

export function applyScratchForPressure(home: string, deps: ApplyDeps):
	{ free_pct: number | null; pressure: ScratchPressure; result: ScratchApplyResult | null } {
	const freePct = measureDiskFreePercent(home, deps.statfs);
	const pressure = classifyScratchPressure(freePct);
	const result = pressure === "RECLAIM" ? applyScratch(home, deps) : null;
	return { free_pct: freePct, pressure, result };
}

export function touchForAge(path: string, ageMs: number, now: number = Date.now()): void {
	utimesSync(path, new Date(now - ageMs), new Date(now - ageMs));
}
