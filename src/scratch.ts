import { createHash } from "node:crypto";
import { appendFileSync, closeSync, existsSync, lstatSync, mkdirSync, openSync, readdirSync, readFileSync, readlinkSync, readSync, realpathSync, renameSync, rmSync, statfsSync, statSync, unlinkSync, utimesSync, writeFileSync } from "node:fs";
import { basename, delimiter, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
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

export type ScratchBin = "throwaway" | "evidence" | "promote" | "hold";
export const SCRATCH_BINS: readonly ScratchBin[] = ["throwaway", "evidence", "promote", "hold"];

export interface ScratchOwner { pid: number; processStart: string | null; label: string; repo: string; createdAt: string; argv0: string | null;
	/** The durable owner: the agent and its omp session id. Both or neither; a pid alone is only an attribute of the current process. */
	agent: string | null; session: string | null;
	/** Where the dir goes when its work ends (ompkit-774u.15): absent means unbinned. A hold carries the bead that justifies it and an expiry within 14 days of creation. */
	bin: ScratchBin | null; purpose: string | null; bead: string | null; expires: string | null;
	/** Declared byte budget (ompkit-774u.15 P0): absent means unbounded. An over-budget live dir is flagged, never reaped for size alone. */
	budget: number | null }

const OWNER_FIELDS = ["pid", "process_start", "label", "repo", "created_at", "argv0"] as const;
const LEGACY_OWNER_FIELDS = ["pid", "label", "repo", "created"] as const;
const SEAT_FIELDS = ["agent", "session"] as const;
const BIN_FIELDS = ["bin", "purpose", "bead", "expires"] as const;
const BUDGET_FIELDS = ["budget"] as const;
const BUDGET_PATTERN = /^[1-9][0-9]{0,14}$/;
const ALLOWED_OWNER_FIELDS = [...OWNER_FIELDS, ...LEGACY_OWNER_FIELDS, ...SEAT_FIELDS, ...BIN_FIELDS, ...BUDGET_FIELDS];
const AGENT_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const SESSION_PATTERN = /^[0-9A-Za-z][0-9A-Za-z-]{7,63}$/;
const PURPOSE_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,39}$/;
const EXPIRES_PATTERN = /^\d{4}-\d{2}-\d{2}(?:T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,3})?)?Z)?$/;
const HOLD_MAX_MS = 14 * 86_400_000;
const RELEASE_FILE = ".omp-kit-release";
const QUARANTINE_IDLE_MS = 72 * 3600 * 1000;
/** While the disk is at RECLAIM pressure (free <= 20%), an unowned dir idle this long with no open fds is
 * quarantined instead of waiting out the 72 h bound (J-2026-10-22-03: 26 GB of dead unowned exports and probe
 * homes, idle 17-50 h, held the release gate at 12% free). Quarantine stays reversible for its TTL. */
const RECLAIM_IDLE_MS = 12 * 3600 * 1000;

/** The idle bound for an unowned dir at `dir`: 12 h under RECLAIM pressure, else 72 h. Plan and apply share it. */
function unownedIdleMs(dir: string, deps: InspectDeps): number {
	return classifyScratchPressure(measureDiskFreePercent(dir, deps.statfs)) === "RECLAIM" ? RECLAIM_IDLE_MS : QUARANTINE_IDLE_MS;
}

const DEFAULT_QUARANTINE_TTL_HOURS = 24;
const MAX_QUARANTINE_TTL_HOURS = 168;
const ORPHAN_MIN_AGE_S = 3600;
export const HARNESS_SERVER_PATTERNS = ["mock-model.mjs", "external-live.mjs"];

export interface OwnerFailure { field: string | null; problem: string }

type OwnerParseResult = { owner: ScratchOwner } | { failure: OwnerFailure };

export function parseOwnerFile(text: string): ScratchOwner | null {
	const parsed = parseOwnerFileEx(text);
	return "owner" in parsed ? parsed.owner : null;
}

/** Same accept set as parseOwnerFile, but the refusal names the first failing field (ompkit-774u.15.1). */
export function parseOwnerFileEx(text: string): OwnerParseResult {
	const trimmed = text.trim();
	if (trimmed === "") return { failure: { field: null, problem: "owner file holds no fields" } };
	if (trimmed.startsWith("{")) {
		let parsed: unknown;
		try {
			parsed = JSON.parse(trimmed);
		} catch {
			return { failure: { field: null, problem: "owner is not valid JSON" } };
		}
		if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed))
			return { failure: { field: null, problem: "owner JSON must be an object of string fields" } };
		const seen: Record<string, string> = {};
		for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
			if (!(ALLOWED_OWNER_FIELDS as readonly string[]).includes(key))
				return { failure: { field: key, problem: "is not an accepted owner field" } };
			if (typeof value !== "number" && typeof value !== "string")
				return { failure: { field: key, problem: "must be a string or number" } };
			seen[key] = String(value);
		}
		return validateOwnerFieldsEx(seen);
	}
	const seen: Record<string, string> = {};
	const contentLines = text.split("\n").filter(line => line !== "");
	const tokens = contentLines.length === 1 ? contentLines[0]!.trim().split(/[ \t]+/) : null;
	if (tokens !== null && tokens.length > 1) {
		for (const token of tokens) {
			const eq = token.indexOf("=");
			if (eq < 0) return { failure: { field: null, problem: `owner token '${token}' is not key=value` } };
			const key = token.slice(0, eq);
			const value = token.slice(eq + 1);
			if (!(ALLOWED_OWNER_FIELDS as readonly string[]).includes(key))
				return { failure: { field: key, problem: "is not an accepted owner field" } };
			if (value === "" || seen[key] !== undefined)
				return { failure: { field: key, problem: "must carry a non-empty value exactly once" } };
			seen[key] = value;
		}
		return validateOwnerFieldsEx(seen);
	}
	for (const line of text.split("\n")) {
		if (line === "") continue;
		let key: string, value: string;
		const eq = line.indexOf("=");
		if (eq >= 0) {
			key = line.slice(0, eq);
			value = line.slice(eq + 1);
			if (!(ALLOWED_OWNER_FIELDS as readonly string[]).includes(key))
				return { failure: { field: key, problem: "is not an accepted owner field" } };
			if (value === "" || /[\t\r\n]/.test(value))
				return { failure: { field: key, problem: "must carry a non-empty value with no tabs" } };
		} else {
			// Legacy text owners use `key: value` lines (e.g. `agent: X`, `bead: ompkit-yyy`).
			const colon = line.indexOf(": ");
			if (colon < 0) return { failure: { field: null, problem: `owner line '${line}' is neither key=value nor 'key: value'` } };
			key = line.slice(0, colon);
			value = line.slice(colon + 2);
			if (!(ALLOWED_OWNER_FIELDS as readonly string[]).includes(key))
				return { failure: { field: key, problem: "is not an accepted owner field" } };
			if (key === "" || value === "" || /[\t\r\n]/.test(value))
				return { failure: { field: key === "" ? null : key, problem: "must carry a non-empty value with no tabs" } };
		}
		if (seen[key] !== undefined)
			return { failure: { field: key, problem: "is repeated; each owner field appears once" } };
		seen[key] = value;
	}
	return validateOwnerFieldsEx(seen);
}

interface BinFields { bin: ScratchBin | null; purpose: string | null; bead: string | null; expires: string | null }
const NO_BIN: BinFields = { bin: null, purpose: null, bead: null, expires: null };

/** The optional bin group of an owner record, or the first failing field. A hold needs a bead and an expiry no later than 14 days after creation. */
function parseBinFields(seen: Record<string, string>, createdAt: string): BinFields | null {
	const parsed = parseBinFieldsEx(seen, createdAt);
	return "bins" in parsed ? parsed.bins : null;
}

function parseBinFieldsEx(seen: Record<string, string>, createdAt: string): { bins: BinFields } | { failure: OwnerFailure } {
	// Value checks come before the bin key itself so a bad value names its own
	// field even when the group key is missing (ompkit-774u.15.1 planted negative).
	if (seen.purpose !== undefined && !PURPOSE_PATTERN.test(seen.purpose))
		return { failure: { field: "purpose", problem: `is '${seen.purpose}', want 1-40 chars of A-Za-z0-9._- with no spaces` } };
	if (seen.bead !== undefined && !AGENT_PATTERN.test(seen.bead))
		return { failure: { field: "bead", problem: `is '${seen.bead}', want 1-64 chars of A-Za-z0-9._-` } };
	if (seen.expires !== undefined && (seen.bin !== "hold" || !EXPIRES_PATTERN.test(seen.expires) || !Number.isFinite(Date.parse(seen.expires))))
		return { failure: { field: "expires", problem: seen.bin !== "hold"
			? "needs bin 'hold'; only a hold carries an expiry"
			: `is '${seen.expires}', want YYYY-MM-DD[THH:MM[:SS[.mmm]]Z]` } };
	const bin = SCRATCH_BINS.find(candidate => candidate === seen.bin);
	if (bin === undefined)
		return { failure: { field: "bin", problem: seen.bin === undefined
			? "is missing; an owner that names bin fields needs a bin value"
			: `is '${seen.bin}', want one of ${[...SCRATCH_BINS].join("|")}` } };
	if (bin === "hold") {
		if (seen.bead === undefined) return { failure: { field: "bead", problem: "is required when bin is 'hold'" } };
		if (seen.expires === undefined) return { failure: { field: "expires", problem: "is required when bin is 'hold'" } };
		const lifetime = Date.parse(seen.expires) - Date.parse(createdAt);
		if (!Number.isFinite(lifetime) || lifetime <= 0 || lifetime > HOLD_MAX_MS)
			return { failure: { field: "expires", problem: "must be after creation and within 14 days of it" } };
	}
	return { bins: { bin, purpose: seen.purpose ?? null, bead: seen.bead ?? null, expires: seen.expires ?? null } };
}

function validateOwnerFields(seen: Record<string, string>): ScratchOwner | null {
	const parsed = validateOwnerFieldsEx(seen);
	return "owner" in parsed ? parsed.owner : null;
}

function validateOwnerFieldsEx(seen: Record<string, string>): OwnerParseResult {
	const seat = SEAT_FIELDS.filter(field => seen[field] !== undefined);
	if (seat.length === 1)
		return { failure: { field: seat[0]!, problem: "needs both 'agent' and 'session' to name the owning seat" } };
	const binned = BIN_FIELDS.filter(field => seen[field] !== undefined);
	const budgeted = BUDGET_FIELDS.filter(field => seen[field] !== undefined);
	const base = (fields: readonly string[]): boolean => fields.every(field => seen[field] !== undefined) &&
		Object.keys(seen).length === fields.length + seat.length + binned.length + budgeted.length;
	const complete = base(OWNER_FIELDS);
	const legacy = base(LEGACY_OWNER_FIELDS);
	if (!complete && !legacy) {
		const want = (seen.process_start !== undefined || seen.created_at !== undefined || seen.argv0 !== undefined)
			? OWNER_FIELDS : LEGACY_OWNER_FIELDS;
		const missing = want.find(field => seen[field] === undefined) ?? "pid";
		return { failure: { field: missing, problem: "is missing from the owner record" } };
	}
	if (!/^[1-9][0-9]{0,5}$/.test(seen.pid!))
		return { failure: { field: "pid", problem: `is '${seen.pid}', want 1-6 digits with no leading zero` } };
	if (seat.length === 2 && (!AGENT_PATTERN.test(seen.agent!) || !SESSION_PATTERN.test(seen.session!))) {
		const bad = !AGENT_PATTERN.test(seen.agent!) ? "agent" : "session";
		return { failure: { field: bad, problem: `is '${seen[bad]}', want 1-64 chars of A-Za-z0-9._-` } };
	}
	const createdAt = seen.created_at ?? seen.created!;
	const loneBead = binned.length === 1 && seen.bin === undefined && seen.bead !== undefined;
	if (loneBead && !AGENT_PATTERN.test(seen.bead!))
		return { failure: { field: "bead", problem: `is '${seen.bead}', want 1-64 chars of A-Za-z0-9._-` } };
	let final: BinFields;
	if (binned.length === 0 || loneBead) {
		final = NO_BIN;
	} else {
		const checked = parseBinFieldsEx(seen, createdAt);
		if ("failure" in checked) return checked;
		final = checked.bins;
	}
	if (budgeted.length === 1 && !BUDGET_PATTERN.test(seen.budget!))
		return { failure: { field: "budget", problem: `is '${seen.budget}', want a positive integer byte count` } };
	return { owner: { pid: Number(seen.pid), processStart: seen.process_start ?? null, label: seen.label!,
		repo: seen.repo!, createdAt, argv0: seen.argv0 ?? null,
		agent: seen.agent ?? null, session: seen.session ?? null, ...final,
		bead: final.bead ?? (loneBead ? seen.bead! : null),
		budget: budgeted.length === 1 ? Number(seen.budget) : null } };
}

const OWNER_FIELD_SETS = "pid,process_start,label,repo,created_at,argv0 or pid,label,repo,created";

/** One-line refusal detail naming the first failing owner field plus the accepted field sets (ompkit-774u.15.1). Null when the owner parses. */
export function diagnoseOwnerFailure(ownerText: string | null): string | null {
	if (ownerText === null) return `owner file is missing or unreadable; accepted owner field sets: ${OWNER_FIELD_SETS}`;
	const parsed = parseOwnerFileEx(ownerText);
	if ("owner" in parsed) return null;
	const { field, problem } = parsed.failure;
	const head = field === null ? "owner file" : `owner field '${field}'`;
	return `${head} ${problem}; accepted owner field sets: ${OWNER_FIELD_SETS}`;
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
/**
 * Omp sessions whose lease a process in the given pid's ancestry holds open
 * (SCRATCHOWN1 ompkit-1dnwk). Read-only: ps and lsof. Empty when no ancestor
 * holds a lease or the tables cannot be read. A pid's agent name is NOT
 * recoverable here — session leases are 0-byte locks — so attribution past
 * the session id comes from the owner's own record.
 */
export function seatSessionsOfPid(pid: number, run: ScratchRunner): string[] {
	const chain = ancestorPids(pid, run)?.filter(ancestor => ancestor > 1);
	if (chain === undefined) return [];
	const out = run(["lsof", "-a", "-p", chain.join(","), "-Fn"], { timeoutMs: LSOF_TIMEOUT_MS });
	if (out.code === null) return [];
	const locks = new Set<string>();
	for (const line of out.stdout.split("\n")) {
		if (!line.startsWith("n")) continue;
		const lock = sessionIdOf(line.slice(1), "lock");
		if (lock !== null) locks.add(lock);
	}
	return [...locks];
}

/** What an owner record attributes to: the seat and whether that seat is live. */
export interface AttributedOwnerSeat { agent: string | null; sessions: string[]; seatLive: boolean | null }

/**
 * Attribute any structured owner to its seat (SCRATCHOWN1 ompkit-1dnwk): a
 * seated record names its agent and session, resolved through seatLive; a
 * pid-only record resolves its holder's ancestry to the session leases it
 * holds, which is direct evidence of a live seat. `seatLive` is false when no
 * seat attributes — a live pid outside any session is live by the pid rule
 * but names no seat to nudge, and a dead holder names none to keep — and
 * null only when a named seat's liveness is unprovable. Reap decisions stay
 * with inspectSession; this never weakens them.
 */
export function attributeOwnerSeat(owner: ScratchOwner, deps: Pick<LivenessDeps, "seatLive"> & { run: ScratchRunner }): AttributedOwnerSeat {
	if (owner.agent !== null && owner.session !== null) {
		return { agent: owner.agent, sessions: [owner.session],
			seatLive: deps.seatLive?.(owner.agent, owner.session) ?? null };
	}
	const sessions = seatSessionsOfPid(owner.pid, deps.run);
	return { agent: null, sessions, seatLive: sessions.length > 0 };
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

export interface ScratchVerdict { dir: string; action: ScratchAction; reason: string; owner: ScratchOwner | null; sizeBytes: number; cause?: "permission" | "immutable-flag" | "open-fd" | "lsof-unavailable" | "unknown" | "delete-leftover";
	/** The OS error that failed this action (e.g. "EACCES: permission denied, mkdir '/...'"). Present only on failed mutations; a refusal never carries one. */
	error?: string }

/** An OS error as a stable verdict string: the errno plus the platform message (which already names the syscall and path). */
export function osErrorText(error: unknown): string {
	const code = (error as NodeJS.ErrnoException)?.code;
	const message = error instanceof Error ? error.message : String(error);
	return typeof code === "string" && message.startsWith(`${code}:`) ? message
		: typeof code === "string" ? `${code}: ${message}` : message;
}

 const APPLY_FAILURE_REASONS: Record<string, true> = {
 "owner-changed-after-initial-check": true, "owner-release-changed-after-initial-check": true,
 "inode-proof-unavailable": true, "lsof-evidence-unavailable": true, "owner-released-but-open-fds-present": true,
 "quarantine-create-failed": true, "atomic-quarantine-failed": true,
"quarantine-rollback-failed": true,
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
	callerSeat?: () => SeatIdentity;
	/** Removes one path under a released dir for `release --now`; defaults to a forced recursive rm. A test plants a
	 * remover that does nothing (the old marker-only release) and the physical-absence check must report it held. */
	removeTree?: (path: string) => void;
	/** The system temp dirs scanned for runtime and kitlib work dirs; defaults to TMPDIR and /tmp. A test pins its own
	 * stand-in so plan and apply never read the machine's real temp. */
	systemTempBases?: readonly string[] }

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

/** The system temp dirs work dirs are scanned in: the injected list, else TMPDIR (or /tmp) and /tmp. */
function systemTempBases(deps: Pick<InspectDeps, "systemTempBases">): string[] {
	return [...new Set(deps.systemTempBases ?? [process.env.TMPDIR ?? "/tmp", "/tmp"])];
}

/** Whether a scanned root is one of the system temp dirs, by real path. */
function isSystemTempRoot(root: string, deps: InspectDeps): boolean {
	let scanned: string;
	try { scanned = realpathSync(root); } catch { return false; }
	return systemTempBases(deps).some(base => {
		try { return scanned === realpathSync(base); } catch { return false; }
	});
}

/** The private-dir shape both system-temp work kinds require: a real dir and a regular `.owner`, both owned by this uid, modes 0700 and 0600. Null when it holds, else the failing rule. */
function privateWorkDirProblem(dir: string): string | null {
	const uid = process.getuid?.();
	let session;
	try { session = lstatSync(dir); } catch { return "dir-missing"; }
	if (session.isSymbolicLink()) return "dir-is-symlink";
	if (!session.isDirectory()) return "not-directory";
	if (uid === undefined || session.uid !== uid) return "dir-not-owned";
	if ((session.mode & 0o777) !== 0o700) return "dir-mode-not-0700";
	let marker;
	try { marker = lstatSync(join(dir, ".owner")); } catch { return "owner-missing"; }
	if (marker.isSymbolicLink()) return "owner-is-symlink";
	if (!marker.isFile()) return "owner-not-file";
	if (marker.uid !== uid) return "owner-not-owned";
	if ((marker.mode & 0o777) !== 0o600) return "owner-mode-not-0600";
	return null;
}

/**
 * A kitlib owned-temp dir (`src/kitlib/tmp.ts`, `scripts/kitlib_tmp.py`, `scripts/kitlib-tmp.sh`): `<label>.<pid>.<6 [a-z0-9]>`.
 * Anchored and bounded; every segment's class excludes the `.` that ends it, so matching is linear.
 */
export const KITLIB_TMP_NAME = /^([a-z0-9][a-z0-9-]{0,47})\.([1-9][0-9]{0,9})\.[a-z0-9]{6}$/;
/** What applyReap's quarantine renames append (quarantineEntryFor, then `.delete-<pid>`); fixed-width fields, linear. */
const QUARANTINE_ENTRY_SUFFIX = /\.q-[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}-[0-9]{2}-[0-9]{2}-[0-9]{3}Z(?:\.delete-[1-9][0-9]{0,9})?$/;

/**
 * Why a system-temp entry is not a reapable kitlib leftover, or null when it is (KITLIBREAP1): a kitlib name, the
 * private-dir shape, and a `.owner` whose label and pid are the name's. `owner` is the record the caller already
 * read; null reads and parses `.owner` here. `name` defaults to the dir's own name.
 */
export function kitlibTmpProblem(dir: string, owner: ScratchOwner | null = null, name: string = basename(dir)): string | null {
	const match = KITLIB_TMP_NAME.exec(name);
	if (match === null) return "kitlib-name-mismatch";
	const shape = privateWorkDirProblem(dir);
	if (shape !== null) return `kitlib-${shape}`;
	let record = owner;
	if (record === null) {
		const text = readText(join(dir, ".owner"));
		const parsed = text === null ? null : parseOwnerFileEx(text);
		if (parsed === null || !("owner" in parsed)) return "kitlib-owner-unparseable";
		record = parsed.owner;
	}
	if (record.label !== match[1]) return "kitlib-owner-label-mismatch";
	if (String(record.pid) !== match[2]) return "kitlib-owner-pid-mismatch";
	return null;
}

/** Bind repository scratch, or private runtime work to the native caller's release identity. */
function ownerMatchesScratchRoot(owner: ScratchOwner, root: string, dir: string, deps: InspectDeps): boolean {
	if (!isAbsolute(owner.repo)) return false;
	// A kitlib leftover in system temp binds to its name, uid and modes, never to a repo: the creator's cwd may be gone.
	// Under quarantine (applyReap's rechecks) the name carries the quarantine suffix; the scanned root stays system temp.
	if (isSystemTempRoot(root, deps)) {
		const name = dirname(dir) === root ? basename(dir) : basename(dir).replace(QUARANTINE_ENTRY_SUFFIX, "");
		if (kitlibTmpProblem(dir, owner, name) === null) return true;
	}
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
	} catch {
		return false;
	}
	return privateWorkDirProblem(dir) === null && isSystemTempRoot(root, deps);
}

const BEAD_TOKEN_CHARS = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789._-";
/** Free-prose owner fallback (`BuildW12 (LavenderBeacon), bead cfs-j2wma.12`): the bead id after a
 * `bead` keyword, the label from the `label.pid` dir name. Null when either is missing. Manual scan,
 * no pattern engine: values here reach the reaper's delete path. */
export function parseFreeOwner(text: string, dirName: string): TextOwner | null {
	const label = dirName.split(".")[0] ?? "";
	if (label === "" || label.includes("/") || label.startsWith(".")) return null;
	let bead: string | null = null;
	let at = 0;
	while (true) {
		const found = text.indexOf("bead", at);
		if (found < 0) break;
		const prev = found === 0 ? " " : (text[found - 1] ?? " ");
		let i = found + 4;
		let seps = 0;
		while (text[i] === " " || text[i] === ":") {
			i++;
			seps++;
		}
		let token = "";
		while (BEAD_TOKEN_CHARS.includes(text[i] ?? "")) {
			token += text[i];
			i++;
		}
		if (seps > 0 && !BEAD_TOKEN_CHARS.includes(prev) && token !== "") {
			bead = token;
			break;
		}
		at = found + 4;
	}
	if (bead === null) return null;
	return { agent: null, label, repo: null, bead, created: null };
}

/** Owning repo from a conventional `<repo>/var/agent-tmp` root, else null. */
export function repoOfRoot(root: string): string | null {
	if (!root.endsWith("/var/agent-tmp")) return null;
	const repo = dirname(dirname(root));
	if (repo === "" || repo === "/") return null;
	return repo;
}

/** A legacy text owner without a pid (`agent: X` / `label: Y` / `bead: Z` lines). Null when the text is not that shape. */
export interface TextOwner { agent: string | null; label: string; repo: string | null; bead: string | null; created: string | null }
export function parseTextOwner(text: string): TextOwner | null {
	// Single-line pipe format (`agent: X | label: Y | bead: Z`) is the same record with a different separator.
	const normalized = text.includes("\n") ? text : text.split("|").join("\n");
	const seen: Record<string, string> = {};
	let lines = 0;
	for (const line of normalized.split("\n")) {
		if (line.trim() === "") continue;
		lines++;
		const trimmed = line.trim();
		const colon = trimmed.indexOf(": ");
		if (colon < 0) return null;
		const key = trimmed.slice(0, colon), value = trimmed.slice(colon + 2);
		if (key === "" || value === "" || /[\t\r\n]/.test(value)) return null;
		if (!["agent", "label", "repo", "bead", "created"].includes(key)) return null;
		if (seen[key] !== undefined) return null;
		seen[key] = value;
	}
	if (lines === 0 || seen.label === undefined) return null;
	return { agent: seen.agent ?? null, label: seen.label, repo: seen.repo ?? null, bead: seen.bead ?? null, created: seen.created ?? null };
}

/** Bead status through the runner's `br show` in the owner repo, or null when unprovable (fail closed). */
function beadClosed(bead: string, repo: string | null, run: ScratchRunner): boolean | null {
	if (repo === null) return null;
	let resolved: string;
	try {
		resolved = resolve(repo);
	} catch {
		return null;
	}
	let stat;
	try {
		stat = statSync(resolved);
	} catch {
		return null;
	}
	if (!stat.isDirectory()) return null;
	let out: ScratchRunResult;
	try {
		out = run(["br", "show", bead, "--json"], { timeoutMs: 15_000 });
	} catch {
		return null;
	}
	if (out.code !== 0) return null;
	try {
		const parsed: unknown = JSON.parse(out.stdout);
		const first = Array.isArray(parsed) ? parsed[0] : parsed;
		const status = (first as Record<string, unknown>)?.status;
		if (status === "closed") return true;
		if (typeof status === "string" && status !== "") return false;
		return null;
	} catch {
		return null;
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
	if (!owner) {
		// Legacy pid-less text owners: no process to signal, so lsof-clear plus a
		// closed or missing bead means REAP. Anything unprovable stays out.
		const raw = readText(join(dir, ".owner"));
		const text = raw === null ? null : (parseTextOwner(raw) ?? parseFreeOwner(raw, dir.slice(root.length + 1)));
		if (text !== null) {
			const clear = lsofClearDir(deps, dir);
			if (clear === null) return sized("SKIP", "text-owner-lsof-unavailable");
			if (!clear) return sized("LIVE", "text-owner-open-fds-present");
			if (text.bead === null) return sized("REAP", "text-owner-no-bead-no-fds");
			const repoName = text.repo ?? repoOfRoot(root);
			if (repoName === null) return sized("REAP", "text-owner-no-repo-no-fds");
			let repoDir: string | null = null;
			try {
				const resolved = resolve(repoName);
				repoDir = statSync(resolved).isDirectory() ? resolved : null;
			} catch { /* unresolvable owner repo: context is gone */ }
			if (repoDir === null) return sized("REAP", "text-owner-repo-gone-no-fds");
			const closed = beadClosed(text.bead, repoName, deps.run);
			if (closed === true) return sized("REAP", "text-owner-bead-closed-no-fds");
			if (closed === false) return sized("LIVE", "text-owner-bead-open");
			return sized("SKIP", "text-owner-bead-unproven");
		}
		return sized("SKIP", malformed ? "malformed-owner-file" : "no-owner-file");
	}
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
	// A hold (bead plus an expiry within 14 days of creation) outlives its owner until it expires; an expired hold is
	// flagged, never reaped: the owner process died, so only a renewal on the bead can extend it (ompkit-774u.15).
	if (verdict.action === "REAP" && owner !== null && owner.bin === "hold" && owner.expires !== null)
		return Date.parse(owner.expires) > (deps.now ?? Date.now())
			? { ...verdict, action: "LIVE", reason: "held-by-bead" } : { ...verdict, action: "SKIP", reason: "hold-expired-unbinned" };
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

/**
 * Work dirs in system temp: runtime `omp-kit-work.*` dirs, and kitlib leftovers that pass kitlibTmpProblem
 * (KITLIBREAP1). Every other temp entry is never visited. An explicit scratch-root override scans none unless the
 * caller injected its own temp list.
 */
export function resolveSystemWorkDirs(deps: Pick<InspectDeps, "systemTempBases"> = {}): string[] {
	if (deps.systemTempBases === undefined && process.env.OMP_KIT_SCRATCH_ROOTS !== undefined && process.env.OMP_KIT_SCRATCH_ROOTS !== "") return [];
	const roots: string[] = [];
	for (const base of systemTempBases(deps)) {
		let entries: string[];
		try { entries = readdirSync(base); } catch { continue; }
		for (const entry of entries) {
			const dir = join(base, entry);
			if (!entry.startsWith("omp-kit-work.")) {
				if (KITLIB_TMP_NAME.test(entry) && kitlibTmpProblem(dir) === null) roots.push(dir);
				continue;
			}
			try {
				if (statSync(dir).isDirectory() && !isSymlink(dir)) roots.push(dir);
			} catch { /* concurrent deletion */ }
		}
	}
	return [...new Set(roots)];
}

/** One system-temp work dir through the plan verdict; a kitlib leftover's reason names its rule (`kitlib-owner-dead-...`). A quarantine keeps its reason: apply dispatches on it. */
function inspectSystemWorkDir(dir: string, deps: InspectDeps): ScratchVerdict | null {
	const verdict = inspectOne(dir, dirname(dir), deps, false);
	const name = basename(dir);
	if (verdict === null || verdict.action === "QUARANTINE" || name.startsWith("omp-kit-work.") || !KITLIB_TMP_NAME.test(name)) return verdict;
	return { ...verdict, reason: `kitlib-${verdict.reason}` };
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
	/** Hold discharge probe (ompkit-774u.15): true when the hold's bead is closed, false when open, null when
	unprovable. Defaults to a read-only `br show --json` through the runner; null fails open to a veto (keep). */
	beadClosed?: (bead: string) => boolean | null;
}

function isBeadClosed(bead: string, deps: ApplyDeps): boolean | null {
	if (deps.beadClosed !== undefined) {
		try {
			return deps.beadClosed(bead);
		} catch {
			return null;
		}
	}
	let result: ScratchRunResult;
	try {
		result = deps.run(["br", "show", bead, "--json", "--no-auto-import", "--no-auto-flush"], { timeoutMs: 15_000 });
	} catch {
		return null;
	}
	if (result.code !== 0) return null;
	try {
		const parsed: unknown = JSON.parse(result.stdout);
		const rows: unknown[] = Array.isArray(parsed) ? parsed : [parsed];
		const row = rows.find(item => typeof item === "object" && item !== null
			&& (item as Record<string, unknown>).id === bead) ?? (rows.length === 1 ? rows[0] : undefined);
		if (typeof row !== "object" || row === null) return null;
		const status = (row as Record<string, unknown>).status;
		if (typeof status !== "string") return null;
		return status === "closed" || status === "tombstone";
	} catch {
		return null;
	}
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
interface ReleaseRecord { owner: ScratchOwner; ownerText: string; markerText: string; releasedAt: string; legacy: boolean; legacyName: string | null;
	/** The destination the owner named when releasing (ompkit-774u.15): evidence and promote carry the reference that proves it; absent is the unbinned legacy release. */
	bin: ScratchBin | null; ref: string | null }

const RELEASE_MARKER_REQUIRED = ["version", "owner_sha256", "device", "inode", "released_at"] as const;
const RELEASE_MARKER_OPTIONAL = ["legacy", "legacy_name", "release_reason", "release_actor", "legacy_owner_b64", "bin", "ref"] as const;
const REF_PATTERN = /^(?:file:[^\s]{1,400}|bead:[A-Za-z0-9][A-Za-z0-9._-]{0,63})$/;
const RELEASE_BINS: readonly ScratchBin[] = ["throwaway", "evidence", "promote"];

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
	const bin = seen.bin === undefined ? null : RELEASE_BINS.find(candidate => candidate === seen.bin) ?? null;
	if (seen.bin !== undefined && bin === null) return null;
	if (legacy && (seen.bin !== undefined || seen.ref !== undefined)) return null;
	// Evidence and promote name where the content went; a throwaway has nothing to point at; a bin-less marker has no reference.
	if ((bin === "evidence" || bin === "promote") !== (seen.ref !== undefined)) return null;
	if (seen.ref !== undefined && !REF_PATTERN.test(seen.ref)) return null;
	return { markerText: text, releasedAt: seen.released_at!, ownerHash: seen.owner_sha256!, device: seen.device!, inode: seen.inode!,
		legacyName: seen.legacy_name ?? null, releaseReason: seen.release_reason ?? null, bin, ref: seen.ref ?? null };
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
		return { owner, ownerText, markerText, releasedAt: marker.releasedAt, legacy: false, legacyName: null, bin: marker.bin, ref: marker.ref };
	}
	const parsed = parseOwnerFile(ownerText);
	const suffixPid = /\.(\d+)$/.exec(marker.legacyName);
	const owner: ScratchOwner = parsed ?? { pid: suffixPid ? Number(suffixPid[1]) : 0, processStart: null,
		label: marker.legacyName, repo: "", createdAt: "", argv0: null, agent: null, session: null, bin: null, purpose: null, bead: null, expires: null, budget: null };
	return { owner, ownerText, markerText, releasedAt: marker.releasedAt, legacy: true, legacyName: marker.legacyName, bin: null, ref: null };
}

function callerIsOwnedBy(ownerPid: number, callerPid: number, run: ScratchRunner): boolean {
	if (ownerPid === callerPid) return true;
	// pid 1 heads every ancestor chain, and dirs with `pid=1` (hand-made owners) are nobody's in particular.
	if (ownerPid <= 1) return false;
	const chain = ancestorPids(callerPid, run);
	return chain !== null && chain.slice(1).includes(ownerPid);
}

/** A successor seat: the same agent holding the omp session the owner record names, whatever its pid. */
function callerHoldsSeat(owner: ScratchOwner, deps: InspectDeps): boolean {
	if (owner.agent === null || owner.session === null) return false;
	const seat = deps.callerSeat ? deps.callerSeat() : callerSeat(deps.run);
	return seat.agent === owner.agent && seat.sessions.includes(owner.session);
}

export interface ScratchReleaseResult { ok: boolean; changed: boolean; dir: string; reason: string; ownerPid: number | null;
	/** Refusal detail naming the first failing owner field plus the accepted field sets (ompkit-774u.15.1). */
	detail?: string }

export interface ScratchReleaseOptions { legacyOwner?: boolean; reason?: string; bin?: ScratchBin; ref?: string; now?: boolean }

/** TRANSFER1 (ompkit-jbiwx): the token a destination carries to prove it holds a released dir's content. */
export const TRANSFER_TOKEN_PREFIX = "scratch-sha256:";

/**
 * What an evidence or promote release must prove it transferred: one digest over every entry below the dir (relative
 * path, kind, content hash; the top-level owner record and release marker excluded, so the digest is the same before
 * and after release) and the sha256 of each regular file, so a byte-identical copy also counts. Symlinks hash their
 * target text and are never followed. Null when any entry cannot be read: unreadable content is never proven.
 */
export function scratchContent(dir: string): { digest: string; files: Set<string> } | null {
	const lines: string[] = [];
	const files = new Set<string>();
	const chunk = Buffer.allocUnsafe(1 << 20);
	const pending = [""];
	try {
		while (pending.length > 0) {
			const rel = pending.pop()!;
			for (const name of readdirSync(join(dir, rel))) {
				if (rel === "" && (name === ".owner" || name === RELEASE_FILE)) continue;
				const child = rel === "" ? name : `${rel}/${name}`;
				const path = join(dir, child);
				const stat = lstatSync(path);
				if (stat.isDirectory()) {
					pending.push(child);
					lines.push(`${child}\0dir\0`);
				} else if (stat.isSymbolicLink()) {
					lines.push(`${child}\0link\0${createHash("sha256").update(readlinkSync(path)).digest("hex")}`);
				} else if (stat.isFile()) {
					const hash = createHash("sha256");
					const fd = openSync(path, "r");
					try {
						for (let read = readSync(fd, chunk); read > 0; read = readSync(fd, chunk)) hash.update(chunk.subarray(0, read));
					} finally {
						closeSync(fd);
					}
					const hex = hash.digest("hex");
					files.add(hex);
					lines.push(`${child}\0file\0${hex}`);
				} else {
					lines.push(`${child}\0special\0`);
				}
			}
		}
	} catch {
		return null;
	}
	lines.sort();
	return { digest: createHash("sha256").update(lines.join("\n")).digest("hex"), files };
}

/**
 * The destination an owner names when it releases its dir (ompkit-774u.15). Null when acceptable, else the refusal.
 * A throwaway needs no reference. Evidence and promote must prove the content arrived (TRANSFER1, Joshua's lifecycle
 * review J-2026-10-22-02): `bead:<id>` whose comments cite `scratch-sha256:<digest>`, or `file:<path>` in the owner's
 * repo that is tracked, identical to HEAD, identical on the upstream branch, and that cites the digest or is a
 * byte-identical copy of one of the dir's files. An existing bead or an unrelated tracked file proves nothing. A hold
 * is declared when the dir is made, not released.
 */
function releaseBinRefusal(dir: string, owner: ScratchOwner, opts: ScratchReleaseOptions, deps: InspectDeps): { reason: string; detail?: string } | null {
	if (opts.bin === undefined) return opts.ref === undefined ? null : { reason: "ref-without-bin" };
	if (!RELEASE_BINS.includes(opts.bin)) return { reason: opts.bin === "hold" ? "hold-is-declared-at-creation" : "bin-unknown" };
	if (opts.bin === "throwaway") return opts.ref === undefined ? null : { reason: "throwaway-takes-no-ref" };
	if (opts.ref === undefined) return { reason: "ref-required" };
	if (!REF_PATTERN.test(opts.ref)) return { reason: "ref-invalid" };
	const content = scratchContent(dir);
	if (content === null) return { reason: "ref-content-unreadable" };
	const token = `${TRANSFER_TOKEN_PREFIX}${content.digest}`;
	const unproven = (reason: string, what: string) => ({ reason, detail: `${what}; this directory's content is ${token}: `
		+ "cite that token in a comment on the bead, or in a committed and pushed file (a committed and pushed byte-identical copy of one of its files also counts), then release again" });
	if (opts.ref.startsWith("bead:")) {
		const bead = opts.ref.slice("bead:".length);
		const shown = deps.run(["br", "show", bead, "--json"], { timeoutMs: 15_000 });
		if (shown.code !== 0) return { reason: "ref-bead-unverified" };
		let comments: unknown;
		try {
			const parsed: unknown = JSON.parse(shown.stdout);
			comments = (Array.isArray(parsed) ? parsed[0] : parsed as Record<string, unknown>)?.comments ?? [];
		} catch {
			return { reason: "ref-bead-unverified" };
		}
		if (!Array.isArray(comments)) return { reason: "ref-bead-unverified" };
		return comments.some((comment) => typeof comment?.text === "string" && comment.text.includes(token))
			? null : unproven("ref-transfer-unproven", `bead ${bead} has no comment citing this content`);
	}
	const repo = resolve(owner.repo);
	const target = resolve(repo, opts.ref.slice("file:".length));
	if (target !== repo && !target.startsWith(`${repo}/`)) return { reason: "ref-outside-repo" };
	let regular = false;
	try { regular = lstatSync(target).isFile(); } catch { /* absent */ }
	if (!regular) return { reason: "ref-missing" };
	const rel = relative(repo, target);
	const git = (...args: string[]) => deps.run(["git", "-C", repo, ...args], { timeoutMs: 15_000 });
	if (git("ls-files", "--error-unmatch", "--", rel).code !== 0) return { reason: "ref-not-tracked" };
	const diff = git("diff", "--quiet", "HEAD", "--", rel);
	if (diff.code === 1) return unproven("ref-uncommitted", `${rel} has staged or unstaged changes against HEAD`);
	if (diff.code !== 0) return { reason: "ref-git-unverified" };
	const head = git("rev-parse", "--verify", "--quiet", `HEAD:${rel}`);
	if (head.code !== 0 || head.stdout.trim() === "") return { reason: "ref-git-unverified" };
	const upstream = git("rev-parse", "--verify", "--quiet", `@{upstream}:${rel}`);
	if (upstream.code !== 0 || upstream.stdout.trim() !== head.stdout.trim()) {
		return unproven("ref-unpushed", `${rel} at HEAD is not the content on the upstream branch (unpushed, or no upstream)`);
	}
	let bytes: Buffer;
	try { bytes = readFileSync(target); } catch { return { reason: "ref-missing" }; }
	return content.files.has(createHash("sha256").update(bytes).digest("hex")) || bytes.includes(token)
		? null : unproven("ref-transfer-unproven", `${rel} neither cites nor copies this content`);
}

/**
 * Same-turn retirement of a just-released dir (ompkit-774u.15 delete-at-once; SCRATCHRETIRE1 ompkit-fp72.120.16.37
 * for evidence and promote, whose reference the caller verified first). Every recheck mirrors the final delete gate
 * in applyReap: pinned identity (device + inode), unchanged owner text, owner still inside the scratch root, no open
 * files. Any doubt keeps the dir with its release marker and is NOT success: the owner keeps the responsibility to
 * retire it (a later --now once clear), the reaper is only a backstop. Never moves a dir, never touches a hold,
 * never deletes on a refusal.
 */
function deleteReleasedNow(dir: string, root: string, home: string, deps: InspectDeps, owner: ScratchOwner,
ownerText: string, dev: number, ino: number, releasedAt: string, bin: ScratchBin): ScratchReleaseResult {
	const held = (reason: string): ScratchReleaseResult => ({ ok: false, changed: true, dir, reason, ownerPid: owner.pid,
		detail: "released (marker kept) but not retired; it is still yours to retire with --now once the cause clears" });
	let stat;
	try {
		stat = lstatSync(dir);
	} catch {
		return held("now-held-directory-unavailable");
	}
	if (!stat.isDirectory() || stat.isSymbolicLink()) return held("now-held-not-a-directory");
	if (String(stat.dev) !== String(dev) || String(stat.ino) !== String(ino)) return held("now-held-inode-changed");
	if (isSymlink(join(dir, ".owner"))) return held("now-held-owner-unreadable");
	const current = readText(join(dir, ".owner"));
	if (current === null || current !== ownerText) return held("now-held-owner-changed");
	if (!ownerMatchesScratchRoot(owner, root, dir, deps)) return held("now-held-owner-outside-root");
	// One system-wide open-file snapshot, the evidence apply's final delete gate uses: the legacy per-dir `lsof +D` walk
	// times out on large or cache-dense dirs and fails closed forever (a 64 GB throwaway held at
	// now-held-lsof-unavailable, 2026-10-22). A snapshot the caller injected is used as is.
	const evidence = deps.lsofSnapshot !== undefined ? deps
		: { ...deps, lsofSnapshot: takeLsofSnapshot(deps.run, deps.lsofTimeoutMs ?? LSOF_TIMEOUT_MS) };
	const clear = lsofClearDir(evidence, dir);
	if (clear !== true) return held(clear === null ? "now-held-lsof-unavailable" : "now-held-open-fds");
	// SCRATCHRETIRE1 AC5: the owner record and the release marker go last. A delete that fails partway (a nested dir the
	// owner cannot write) used to take both with the first files and leave an unowned remnant nobody could re-release.
	const remove = deps.removeTree ?? ((path: string) => rmSync(path, { recursive: true, force: true }));
	try {
		for (const name of readdirSync(dir)) {
			if (name === ".owner" || name === RELEASE_FILE) continue;
			remove(join(dir, name));
		}
		remove(join(dir, RELEASE_FILE));
		remove(join(dir, ".owner"));
		remove(dir);
	} catch {
		return held("now-held-delete-failed");
	}
	if (existsSync(dir)) return held("now-held-delete-failed");
	appendLog(home, { event: "release-deleted", dir, at: releasedAt, owner: owner.pid, bin });
	return { ok: true, changed: true, dir, reason: "owner-released-deleted", ownerPid: owner.pid };
}

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
	const binRefusal = releaseBinRefusal(dir, owner, opts, deps);
	if (binRefusal !== null) return { ok: false, changed: false, dir, reason: binRefusal.reason, ownerPid: owner.pid, ...(binRefusal.detail ? { detail: binRefusal.detail } : {}) };
	// Delete-at-once (ompkit-774u.15, Joshua J-102): a finished task retires its own scratch. Evidence and promote may
	// retire too, because releaseBinRefusal above proved their content arrived at the destination (TRANSFER1); a bin-less
	// release names no destination, and a hold is never released here.
	if (opts.now === true && opts.bin === undefined)
		return { ok: false, changed: false, dir, reason: "now-needs-bin", ownerPid: owner.pid };
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
		if (prior && prior.ownerText === ownerText) {
			// SCRATCHRETIRE1 (ompkit-fp72.120.16.37): disposal follows job completion, not the reaper. A dir its owner
			// released marker-only (without --now) is retired by that owner's later release with --now under the same bin
			// and reference, through the same rechecks, provided the marker still pins this very inode.
			if (opts.now === true && opts.bin !== undefined && prior.bin === opts.bin && (prior.ref ?? undefined) === opts.ref) {
				const pinned = parseReleaseMarker(prior.markerText);
				if (!pinned || pinned.device !== String(stat.dev) || pinned.inode !== String(stat.ino))
					return { ok: false, changed: false, dir, reason: "release-marker-inode-mismatch", ownerPid: owner.pid };
				return deleteReleasedNow(dir, root, home, deps, owner, ownerText, stat.dev, stat.ino, new Date(deps.now ?? Date.now()).toISOString(), opts.bin);
			}
			return { ok: true, changed: false, dir, reason: "already-released", ownerPid: owner.pid };
		}
		return { ok: false, changed: false, dir, reason: "release-marker-already-present", ownerPid: owner.pid };
	}
	const releasedAt = new Date(deps.now ?? Date.now()).toISOString();
	const binLines = opts.bin === undefined ? "" : `bin=${opts.bin}\n${opts.ref === undefined ? "" : `ref=${opts.ref}\n`}`;
	const markerText = `version=1\nowner_sha256=${createHash("sha256").update(ownerText).digest("hex")}\ndevice=${stat.dev}\ninode=${stat.ino}\nreleased_at=${releasedAt}\n${binLines}`;
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
	appendLog(home, { event: "release", dir, at: releasedAt, owner: owner.pid, bin: opts.bin ?? "unbinned" });
	if (opts.now === true && opts.bin !== undefined) return deleteReleasedNow(dir, root, home, deps, owner, ownerText, stat.dev, stat.ino, releasedAt, opts.bin);
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
	const detail = diagnoseOwnerFailure(ownerText) ?? undefined;
	if (opts.now === true) return { ok: false, changed: false, dir, reason: "now-needs-structured-owner", ownerPid: null, ...(detail ? { detail } : {}) };
	if (opts.bin !== undefined || opts.ref !== undefined) return { ok: false, changed: false, dir, reason: "bin-needs-structured-owner", ownerPid: null, ...(detail ? { detail } : {}) };
	if (opts.legacyOwner !== true || reason === "")
		return { ok: false, changed: false, dir, reason: "owner-file-invalid", ownerPid: null, ...(detail ? { detail } : {}) };
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
export interface ScratchCreateResult { ok: boolean; dir: string; exportLine: string; reason: string; detail?: string }

export interface ScratchCreateBin { bin?: ScratchBin; purpose?: string; bead?: string; expires?: string; budgetBytes?: number }

/**
 * Canonical scratch create: <repo>/var/agent-tmp/<label>.<pid>/ with a valid
 * .owner (pid, process start, label, repo, created). Agents call this instead
 * of hand-writing .owner files; hand-written bare-label owners are reported
 * as malformed-owner-file with per-root counts in the plan totals.
 */
/** Seat and dir byte budgets (SCRATCHQUOTA1 ompkit-774u.9.10): reservation accounting at creation.
 * Actual byte enforcement at write time belongs to the fleet guard, which reads this ledger;
 * creation refuses a seat already at cap so growth is bounded even when nothing else runs. */
export const DEFAULT_SEAT_BUDGET_BYTES = 50_000_000_000;
export const DEFAULT_DIR_BUDGET_BYTES = 1_000_000_000;
export interface BudgetDirEntry { budget: number; agent: string; bead: string | null; released: boolean }
export interface BudgetLedger { version: 1; dirs: Record<string, BudgetDirEntry> }
export function seatBudgetCap(env: NodeJS.ProcessEnv = process.env): number {
	const raw = env.OMP_KIT_SCRATCH_SEAT_CAP_BYTES;
	if (raw === undefined || raw === "") return DEFAULT_SEAT_BUDGET_BYTES;
	const parsed = Number(raw);
	return Number.isInteger(parsed) && parsed > 0 ? parsed : DEFAULT_SEAT_BUDGET_BYTES;
}
export function defaultBudgetLedgerPath(env: NodeJS.ProcessEnv = process.env): string {
	const state = env.XDG_STATE_HOME ?? join(homedir(), ".local", "state");
	return join(state, "omp-kit", "scratch-budgets.json");
}
export function readBudgetLedger(path: string): BudgetLedger | null {
	let text: string;
	try {
		text = readFileSync(path, "utf8");
	} catch {
		return { version: 1, dirs: {} };
	}
	try {
		const parsed: unknown = JSON.parse(text);
		if (typeof parsed !== "object" || parsed === null) return null;
		const dirs = (parsed as Record<string, unknown>).dirs;
		if (typeof dirs !== "object" || dirs === null) return null;
		return { version: 1, dirs: dirs as Record<string, BudgetDirEntry> };
	} catch {
		return null;
	}
}
export function writeBudgetLedger(path: string, ledger: BudgetLedger): boolean {
	try {
		mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
	} catch {
		return false;
	}
	const tmp = `${path}.${process.pid}.tmp`;
	try {
		writeFileSync(tmp, JSON.stringify(ledger), { encoding: "utf8", mode: 0o600 });
		renameSync(tmp, path);
	} catch {
		return false;
	}
	return true;
}
export function seatReservedBytes(ledger: BudgetLedger, agent: string): number {
	let total = 0;
	for (const entry of Object.values(ledger.dirs)) {
		if (!entry.released && entry.agent === agent) total += entry.budget;
	}
	return total;
}
/** Mark a released dir so its reservation stops counting against the seat. True when the ledger changed. */
export function releaseBudgetEntry(ledgerPath: string, dir: string): boolean {
	const ledger = readBudgetLedger(ledgerPath);
	if (ledger === null) return false;
	const entry = ledger.dirs[dir];
	if (!entry || entry.released) return false;
	entry.released = true;
	return writeBudgetLedger(ledgerPath, ledger);
}

export function createScratch(label: string, repoDir: string, deps: InspectDeps, bins: ScratchCreateBin = {}, jsonOwner = false, ledgerPath?: string): ScratchCreateResult {
	if (!/^[A-Za-z0-9][A-Za-z0-9._%-]*$/.test(label)) return { ok: false, dir: "", exportLine: "", reason: "label-invalid" };
	let repo: string;
	try {
		repo = resolve(repoDir);
	} catch {
		return { ok: false, dir: "", exportLine: "", reason: "repo-invalid" };
	}
	// The CLI passes its working directory here.  Refuse that directory unless it
	// is actually a repository, rather than creating a root that the reaper cannot
	// discover from any repository.  Programmatic callers may still provide a
	// fixture/alternate owner path explicitly.
	try {
		if (repo === resolve(process.cwd()) && !existsSync(join(repo, ".git"))) {
			return { ok: false, dir: "", exportLine: "", reason: "cwd-not-repository" };
		}
	} catch {
		return { ok: false, dir: "", exportLine: "", reason: "cwd-unavailable" };
	}
	const start = deps.liveness.processStart(process.pid);
	if (start === null) return { ok: false, dir: "", exportLine: "", reason: "process-identity-unavailable" };
	const root = join(repo, "var", "agent-tmp");
	const dir = join(root, `${label}.${process.pid}`);
	const createdAt = new Date(deps.now ?? Date.now()).toISOString();
	const argv = process.argv[1] ?? process.argv[0] ?? "unknown";
	// No injected seat on the programmatic path: fall back to the live lookup
	// (as release and owned-scratch do) so every dir a seated caller makes
	// names its seat (SCRATCHOWN1 ompkit-1dnwk). Unseated callers keep pid owners.
	const seat = deps.callerSeat ? deps.callerSeat() : callerSeat(deps.run);
	const fields: Record<string, string | number> = { pid: process.pid, process_start: start, label, repo, created_at: createdAt, argv0: argv };
	if (seat?.agent && seat.main) {
		if (!AGENT_PATTERN.test(seat.agent) || !SESSION_PATTERN.test(seat.main)) return { ok: false, dir: "", exportLine: "", reason: "seat-identity-invalid" };
		fields.agent = seat.agent;
		fields.session = seat.main;
	}
	for (const [key, value] of [["bin", bins.bin], ["purpose", bins.purpose], ["bead", bins.bead], ["expires", bins.expires]] as const) {
		if (value === undefined) continue;
		fields[key] = value;
	}
	if (bins.budgetBytes !== undefined) {
		if (!Number.isInteger(bins.budgetBytes) || !BUDGET_PATTERN.test(String(bins.budgetBytes))) return { ok: false, dir: "", exportLine: "", reason: "budget-invalid" };
		fields.budget = bins.budgetBytes;
	}
	const ownerText = jsonOwner ? JSON.stringify(fields) : Object.entries(fields).map(([key, value]) => `${key}=${value}\n`).join("");
	if (parseOwnerFile(ownerText) === null) return { ok: false, dir: "", exportLine: "", reason: "bin-invalid" };
	const seatKey = seat?.agent && seat.main ? seat.agent : `pid:${process.pid}`;
	const reservation = bins.budgetBytes ?? DEFAULT_DIR_BUDGET_BYTES;
	const ledgerFile = ledgerPath ?? defaultBudgetLedgerPath();
	const ledger = readBudgetLedger(ledgerFile);
	if (ledger === null) return { ok: false, dir: "", exportLine: "", reason: "ledger-unavailable",
		detail: `budget ledger ${ledgerFile} is unreadable; refusing rather than exceeding the seat cap blind` };
	// Remove reservations whose scratch directory is gone before admitting a new one.
	// Test fixtures and interrupted cleanup can remove the directory without reaching releaseBudgetEntry.
	for (const path in ledger.dirs) {
		const entry = ledger.dirs[path];
		if (!entry || entry.released) continue;
		try {
			lstatSync(path);
		} catch (error) {
			const code = (error as NodeJS.ErrnoException).code;
			if (code === "ENOENT" || code === "ENOTDIR") entry.released = true;
		}
	}
	const cap = seatBudgetCap();
	const reserved = seatReservedBytes(ledger, seatKey);
	if (reserved + reservation > cap)
		return { ok: false, dir: "", exportLine: "", reason: "seat-budget-exceeded",
			detail: `seat ${seatKey} holds ${reserved} bytes of ${cap} budgeted; dir ${label} refusing (needs ${reservation}); release a dir first` };
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
	ledger.dirs[dir] = { budget: reservation, agent: seatKey, bead: bins.bead ?? null, released: false };
	if (!writeBudgetLedger(ledgerFile, ledger)) {
		try {
			rmSync(join(dir, ".owner"), { force: true });
			rmSync(dir);
		} catch { /* best effort */ }
		return { ok: false, dir: "", exportLine: "", reason: "ledger-write-failed" };
	}
	return { ok: true, dir, exportLine: `export TMPDIR=${dir}`, reason: "created" };
}

/**
 * Exact-commit read-only export into a scratch dir: `git archive` to a tarball
 * (file output, never a pipe, so binary stays intact), extract, remove the
 * tarball. The dir already exists and is owned by the caller; on failure the
 * dir is left in place with nothing added. Null on success, else the reason.
 */
export function exportCommitToScratch(repo: string, commit: string, dir: string, run: ScratchRunner): string | null {
	const typed = run(["git", "-C", repo, "cat-file", "-t", commit], { timeoutMs: 15_000 });
	if (typed.code !== 0 || typed.stdout.trim() !== "commit") return "export-commit-unknown";
	const tarball = join(dir, ".export.tar");
	const archived = run(["git", "-C", repo, "archive", "--format=tar", `--output=${tarball}`, commit], { timeoutMs: 120_000 });
	if (archived.code !== 0) return "export-archive-failed";
	const extracted = run(["tar", "-xf", tarball, "-C", dir], { timeoutMs: 120_000 });
	try {
		rmSync(tarball, { force: true });
	} catch { /* best effort */ }
	if (extracted.code !== 0) return "export-extract-failed";
	return null;
}

/** Move an owner-released session to quarantine without requiring its process to exit. */
function applyReleased(dir: string, root: string, verdict: ScratchVerdict, deps: ApplyDeps): ScratchVerdict {
	const at = new Date(deps.now ?? Date.now()).toISOString();
	const fail = (reason: string, error?: unknown, dirOverride?: string): ScratchVerdict => {
		const failed = { ...verdict, action: "SKIP" as const, reason,
			...(dirOverride === undefined ? {} : { dir: dirOverride }),
			...(error === undefined ? {} : { error: osErrorText(error) }) };
		appendLog(deps.home, { event: reason === "final-recheck-refused" ? "skip" : "failure", dir: failed.dir, at,
			action: failed.action, reason, error: failed.error ?? reason });
		return failed;
	};
	const released = readReleaseRecord(dir);
	if (!released || dirname(dir) !== root || (released.legacy && basename(dir) !== released.legacyName))
		return fail("owner-release-changed-after-initial-check");
	if (!released.legacy && !ownerMatchesScratchRoot(released.owner, root, dir, deps)) return fail("owner-repo-outside-scratch-root");
	const identity = inodeOf(dir);
	if (identity === null) return fail("inode-proof-unavailable");
	const clearBefore = lsofClearDir(deps, dir);
	if (clearBefore !== true) return fail(clearBefore === null ? "lsof-evidence-unavailable" : "owner-released-but-open-fds-present");
	const entry = quarantineEntryFor(basename(dir), new Date(deps.now ?? Date.now()));
	const qt = quarantineDir(deps.home);
	try {
		mkdirSync(qt, { recursive: true, mode: 0o700 });
	} catch (error) {
		return fail("quarantine-create-failed", error);
	}
	const moved = join(qt, entry);
	try {
		renameSync(dir, moved);
	} catch (error) {
		return fail("atomic-quarantine-failed", error);
	}
	const afterMove = readReleaseRecord(moved);
	const clearAfter = lsofClearDir(deps, moved);
	if (inodeOf(moved) !== identity || !afterMove || afterMove.markerText !== released.markerText ||
		afterMove.ownerText !== released.ownerText || (!afterMove.legacy && !ownerMatchesScratchRoot(afterMove.owner, root, moved, deps)) ||
		clearAfter !== true) {
		try {
			renameSync(moved, dir);
		} catch (error) {
			return fail("quarantine-rollback-failed", error, moved);
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
	const fail = (reason: string, error?: unknown, dirOverride?: string): ScratchVerdict => {
		const failed = { ...verdict, action: "SKIP" as const, reason,
			...(dirOverride === undefined ? {} : { dir: dirOverride }),
			...(error === undefined ? {} : { error: osErrorText(error) }) };
		appendLog(deps.home, { event: reason === "final-recheck-refused" ? "skip" : "failure", dir: failed.dir, at,
			action: failed.action, reason, error: failed.error ?? reason });
		return failed;
	};
	const textVerdict = verdict.owner === null && verdict.reason.startsWith("text-owner-");
	if (!verdict.owner && !textVerdict) return fail("owner-changed-after-initial-check");
	let expected: string | null = null;
	if (verdict.owner) {
		if (!ownerMatchesScratchRoot(verdict.owner, root, dir, deps)) return fail("owner-repo-outside-scratch-root");
		expected = ownerSnapshot(verdict.owner);
	} else {
		const raw = readText(join(dir, ".owner"));
		if (raw === null || parseTextOwner(raw) === null) return fail("owner-changed-after-initial-check");
		expected = raw;
	}
	const identity = inodeOf(dir);
	if (identity === null) return fail("inode-proof-unavailable");
	const entry = quarantineEntryFor(dir.slice(root.length + 1));
	const qt = quarantineDir(deps.home);
	try {
		mkdirSync(qt, { recursive: true, mode: 0o700 });
	} catch (error) {
		return fail("quarantine-create-failed", error);
	}
	const moved = join(qt, entry);
	try {
		renameSync(dir, moved);
	} catch (error) {
		return fail("atomic-quarantine-failed", error);
	}
	if (isSymlink(moved)) return { ...verdict, dir: moved, action: "SKIP", reason: "path-replaced-with-non-directory" };
	if (inodeOf(moved) !== identity) return { ...verdict, dir: moved, action: "SKIP", reason: "inode-changed-before-delete" };
	const recheck = inspectSession(moved, qt, deps, false, root);
	const recheckText = textVerdict ? readText(join(moved, ".owner")) : null;
	if (recheck.action !== "REAP" || (textVerdict ? recheckText !== expected : (!recheck.owner || ownerSnapshot(recheck.owner) !== expected))) {
		try {
			renameSync(moved, dir);
		} catch (error) {
			return fail("quarantine-rollback-failed", error, moved);
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
	if (textVerdict) {
		const finalParsed = finalText === null ? null : parseTextOwner(finalText);
		if (isSymlink(deleting) || inodeOf(deleting) !== identity || finalParsed === null ||
			JSON.stringify(finalParsed) !== JSON.stringify(parseTextOwner(expected ?? "")) ||
			lsofClearDir(deps, deleting) !== true) {
			return { ...verdict, dir: deleting, action: "SKIP", reason: "final-delete-recheck-failed" };
		}
		// Bead-gated prompt delete (Joshua 2026-10-20): a bead that opened or became
		// unprovable since plan time keeps the dir; closed or missing beads delete now.
		if (finalParsed.bead !== null) {
			const closed = beadClosed(finalParsed.bead, finalParsed.repo, deps.run);
			if (closed !== true) {
				try {
					renameSync(deleting, dir);
				} catch {
					return { ...verdict, dir: deleting, action: "SKIP", reason: "quarantine-rollback-failed" };
				}
				return { ...verdict, action: "SKIP", reason: closed === false ? "text-owner-bead-open-at-apply" : "text-owner-bead-unproven-at-apply" };
			}
		}
	} else if (isSymlink(deleting) || inodeOf(deleting) !== identity || !finalOwner || ownerSnapshot(finalOwner) !== expected ||
		!ownerMatchesScratchRoot(finalOwner, root, deleting, deps) || lsofClearDir(deps, deleting) !== true) {
		return { ...verdict, dir: deleting, action: "SKIP", reason: "final-delete-recheck-failed" };
	}
	try {
		rmSync(deleting, { recursive: true, force: true });
	} catch {
		return { ...verdict, dir: deleting, action: "SKIP", reason: "delete-failed" };
	}
	if (existsSync(deleting)) return { ...verdict, dir: deleting, action: "SKIP", reason: "delete-failed" };
	appendLog(deps.home, { event: "reap", dir, at, owner: (expected ?? "").split("\n")[0], sizeBytes: verdict.sizeBytes });
	return { ...verdict, action: "REAP", reason: `${verdict.reason}-applied` };
}

/**
 * The recorded quarantine reason keeps the plan's class: a would-quarantine preview becomes its
 * quarantined twin, and an unparseable owner file that rode the unowned path is named malformed.
 */
function quarantineTerminalReason(plannedReason: string | undefined, ownerBefore: string | null, currentOwner: ScratchOwner | null): string {
	if (ownerBefore !== null && currentOwner === null) return "malformed-owner-idle-72h-quarantined";
	if (plannedReason !== undefined && plannedReason.endsWith("-would-quarantine"))
		return `${plannedReason.slice(0, -"-would-quarantine".length)}-quarantined`;
	return "unowned-idle-72h-quarantined";
}
/** Unowned entry lifecycle: idle past unownedIdleMs (72h, or 12h at RECLAIM pressure) -> quarantine, configured TTL -> delete (with rechecks). */
export function applyUnowned(dir: string, root: string, deps: ApplyDeps, planned?: ScratchVerdict): ScratchVerdict {
	const now = deps.now ?? Date.now();
	const at = new Date(now).toISOString();
	const base: ScratchVerdict = { dir, action: "SKIP", reason: "unknown", owner: planned?.owner ?? null, sizeBytes: 0 };
	// A refusal is an expected safety SKIP; a mutation failure carries its OS error. The run-level
	// receipt (applyScratch) logs every terminal SKIP, so every failure lands in the JSONL with its error.
	const stop = (reason: string, error?: unknown, dirOverride?: string, extra?: Partial<ScratchVerdict>): ScratchVerdict =>
		({ ...base, reason, ...(dirOverride === undefined ? {} : { dir: dirOverride }),
			...(error === undefined ? {} : { error: osErrorText(error) }), ...extra });
	if (isSymlink(dir)) return stop("session-is-symlink");
	const freshest = idleSince(dir, now);
	if (freshest === null) return stop("idle-proof-unavailable");
	if (freshest >= now - unownedIdleMs(dir, deps)) return stop("unowned-but-active", undefined, undefined, { action: "LIVE" });
	const ownerBefore = readText(join(dir, ".owner"));
	const currentOwner = ownerBefore === null ? null : parseOwnerFile(ownerBefore);
	if (planned && (planned.owner === null ? currentOwner !== null :
		currentOwner === null || ownerSnapshot(planned.owner) !== ownerSnapshot(currentOwner))) {
		return stop("final-recheck-refused", undefined, undefined, { owner: currentOwner });
	}
	if (currentOwner) {
		if (!ownerMatchesScratchRoot(currentOwner, root, dir, deps)) {
			return stop("owner-repo-outside-scratch-root", undefined, undefined, { owner: currentOwner });
		}
		if (inspectOne(dir, root, deps)?.action !== "QUARANTINE") {
			return stop("final-recheck-refused", undefined, undefined, { owner: currentOwner });
		}
	}
	const entry = quarantineEntryFor(dir.slice(root.length + 1));
	const qt = quarantineDir(deps.home);
	try {
		mkdirSync(qt, { recursive: true, mode: 0o700 });
	} catch (error) {
		return stop("quarantine-create-failed", error);
	}
	const identity = inodeOf(dir);
	if (identity === null) return stop("inode-proof-unavailable");
	const clearBefore = lsofClearDir(deps, dir);
	if (clearBefore !== true) return stop(
		clearBefore === null ? "lsof-evidence-unavailable" : "owner-released-but-open-fds-present",
		undefined, undefined,
		{ ...(clearBefore === false ? { cause: "open-fd" as const } : { cause: "lsof-unavailable" as const }) });
	const moved = join(qt, entry);
	try {
		renameSync(dir, moved);
	} catch (error) {
		return stop("atomic-quarantine-failed", error);
	}
	const ownerAfter = readText(join(moved, ".owner"));
	if (inodeOf(moved) !== identity || ownerAfter !== ownerBefore ||
		(currentOwner !== null && !ownerMatchesScratchRoot(currentOwner, root, moved, deps)) ||
		lsofClearDir(deps, moved) !== true) {
		try {
			renameSync(moved, dir);
		} catch (error) {
			return stop("quarantine-rollback-failed", error, moved);
		}
		return stop("final-recheck-refused");
	}
	appendLog(deps.home, { event: "quarantine", dir, at, entry, sizeBytes: dirSize(moved),
		reason: quarantineTerminalReason(planned?.reason, ownerBefore, currentOwner) });
	return { ...base, dir: moved, action: "QUARANTINE",
		reason: quarantineTerminalReason(planned?.reason, ownerBefore, currentOwner), sizeBytes: dirSize(moved) };
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
		const { owner: liveOwner } = readOwner(path);
		if (liveOwner === null) {
			const fresh = idleSince(path, now);
			if (fresh === null) {
				done.push({ dir: path, action: "SKIP", reason: "idle-proof-unavailable", owner: null, sizeBytes: dirSize(path) });
				continue;
			}
			if (fresh >= now - QUARANTINE_IDLE_MS) {
				done.push({ dir: path, action: "SKIP", reason: "quarantine-active-mtime", owner: null, sizeBytes: dirSize(path) });
				continue;
			}
		}
		if (liveOwner !== null && liveOwner.bin !== "hold" && liveOwner.agent !== null && liveOwner.session !== null) {
			const seat = deps.liveness.seatLive?.(liveOwner.agent, liveOwner.session) ?? null;
			if (seat === true) {
				done.push({ dir: path, action: "LIVE", reason: "owner-seat-alive", owner: liveOwner, sizeBytes: dirSize(path) });
				continue;
			}
			if (seat === null) {
				done.push({ dir: path, action: "SKIP", reason: "owner-seat-liveness-unproven", owner: liveOwner, sizeBytes: dirSize(path) });
				continue;
			}
		}
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
		// Holds are owed until discharged (ompkit-774u.15, Joshua scope 2026-10-20): a quarantined hold is vetoed
		// while its bead is open or unprovable, and flagged but never deleted once expired. Only a closed bead
		// discharges the hold back to the normal liveness path below. Fail-open: an unprovable bead keeps the dir.
		if (owner && !malformed && owner.bin === "hold") {
			const closed = owner.bead === null ? null : isBeadClosed(owner.bead, deps);
			if (closed !== true) {
				const ms = owner.expires === null ? NaN : Date.parse(owner.expires);
				const reason = !Number.isNaN(ms) && ms <= now ? "quarantine-hold-expired" : "quarantine-hold-active";
				appendLog(home, { event: reason, dir: path, at, bead: owner.bead, entry, sizeBytes: dirSize(path) });
				done.push({ dir: path, action: "SKIP", reason, owner, sizeBytes: dirSize(path) });
				continue;
			}
		}
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

/** What makes an unowned dir "active": newest mtime in the tree within unownedIdleMs. Stated here so plan output and help text share it. */
export const UNOWNED_ACTIVE_RULE = "unowned dir with newest mtime in tree within 72h (12h while its disk is at RECLAIM pressure, free <= 20%) is LIVE unowned-but-active; idle past that with no open fds goes to quarantine";

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
	if (verdict.action === "SKIP" && verdict.reason === "owner-label-invalid" && verdict.owner !== null) {
		// The label rule only guards the directory name; liveness decides the terminal path.
		// A live or unproven owner stays SKIP. Only a dead, fd-clear, 72 h-idle owner ages into quarantine.
		const labeled = verdict.owner;
		let dead: boolean;
		if (!hasProcessIdentity(labeled)) {
			if (deps.liveness.signalAlive(labeled.pid) || deps.liveness.psVisible(labeled.pid)) {
				dead = reuseAfterCreated(labeled, deps.liveness) === true;
			} else dead = true;
		} else {
			const state = probeOwner(labeled.pid, labeled.processStart, deps.liveness);
			if (state !== "dead" && state !== "reused") return verdict;
			dead = true;
		}
		if (dead && lsofClearDir(deps, dir) === true) {
			const nowMs = deps.now ?? Date.now();
			const freshest = idleSince(dir, nowMs);
			if (freshest !== null && freshest < nowMs - QUARANTINE_IDLE_MS) {
				return { dir, action: "QUARANTINE", reason: "owner-label-invalid-idle-72h-would-quarantine",
					owner: labeled, sizeBytes: dirSize(dir) };
			}
		}
		return verdict;
	}
	if (mismatch || (verdict.action === "SKIP" && (verdict.reason === "no-owner-file" ||
		verdict.reason === "malformed-owner-file" || verdict.reason === "owner-identity-incomplete"))) {
		const freshest = idleSince(dir, deps.now ?? Date.now());
		const idleMs = unownedIdleMs(dir, deps);
		if (freshest !== null && freshest < (deps.now ?? Date.now()) - idleMs) {
			return { ...quarantineCandidate, action: "QUARANTINE",
				reason: `${mismatch ? "mismatched-owner" : "unowned"}-${freshest < (deps.now ?? Date.now()) - QUARANTINE_IDLE_MS ? "idle-72h" : "idle-12h-reclaim"}-would-quarantine`,
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

export interface BunBuildVerdict { path: string; action: "REAP" | "KEEP"; reason: string; sizeBytes: number }

const BUN_BUILD_NAME = /^\.[A-Za-z0-9_-]+-00000000\.bun-build$/;
const BUN_BUILD_MIN_AGE_MS = 60 * 60 * 1000;

function bunBuildRepoRoots(entries: readonly ScratchRootEntry[]): string[] {
	const roots: string[] = [];
	for (const entry of entries) {
		if (!entry.root.endsWith(`${sep}var${sep}agent-tmp`)) continue;
		const repo = dirname(dirname(entry.root));
		try {
			const repoStat = lstatSync(repo);
			const rootStat = lstatSync(entry.root);
			if (repoStat.isDirectory() && !repoStat.isSymbolicLink() && rootStat.isDirectory() && !rootStat.isSymbolicLink())
				roots.push(repo);
		} catch { /* a concurrently removed fleet repo is not a candidate */ }
	}
	return [...new Set(roots)];
}

/** Find stale Bun compile leftovers only at the root of known fleet repositories. */
export function inspectBunBuildFiles(entries: readonly ScratchRootEntry[], deps: InspectDeps): BunBuildVerdict[] {
	const now = deps.now ?? Date.now();
	const snapshot = deps.lsofSnapshot !== undefined ? deps.lsofSnapshot
		: takeLsofSnapshot(deps.run, deps.lsofTimeoutMs ?? LSOF_TIMEOUT_MS);
	const rows: BunBuildVerdict[] = [];
	for (const repo of bunBuildRepoRoots(entries)) {
		let names: string[];
		try { names = readdirSync(repo); } catch { continue; }
		for (const name of names) {
			if (!BUN_BUILD_NAME.test(name)) continue;
			const path = join(repo, name);
			let stat;
			try { stat = lstatSync(path); } catch { continue; }
			if (!stat.isFile() || stat.isSymbolicLink()) continue;
			if (stat.mtimeMs >= now - BUN_BUILD_MIN_AGE_MS)
				rows.push({ path, action: "KEEP", reason: "bun-build-young", sizeBytes: stat.size });
			else if (snapshot === null)
				rows.push({ path, action: "KEEP", reason: "bun-build-lsof-unavailable", sizeBytes: stat.size });
			else if (!snapshotClear(snapshot, path))
				rows.push({ path, action: "KEEP", reason: "bun-build-open-fd", sizeBytes: stat.size });
			else rows.push({ path, action: "REAP", reason: "bun-build-stale-no-open-fd", sizeBytes: stat.size });
		}
	}
	return rows;
}

function applyBunBuildFile(row: BunBuildVerdict, entries: readonly ScratchRootEntry[], deps: ApplyDeps): BunBuildVerdict {
	if (row.action !== "REAP") return row;
	const checked = inspectBunBuildFiles(entries, {
		...deps, now: deps.now, lsofSnapshot: takeLsofSnapshot(deps.run, deps.lsofTimeoutMs ?? LSOF_TIMEOUT_MS),
	}).find(candidate => candidate.path === row.path);
	if (checked === undefined || checked.action !== "REAP") return checked ?? { ...row, action: "KEEP", reason: "bun-build-disappeared" };
	try {
		(deps.remove ?? unlinkSync)(row.path);
		return { ...row, action: "REAP", reason: "bun-build-reaped" };
	} catch {
		return { ...row, action: "KEEP", reason: "bun-build-delete-failed" };
	}
}

export interface ScratchPlan {
	roots: string[];
	sessions: ScratchVerdict[];
	bunBuilds: BunBuildVerdict[];
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
	const systemWorkDirs = resolveSystemWorkDirs(deps);
	const sessions: ScratchVerdict[] = [];
	const snapDeps: InspectDeps = { ...deps, lsofSnapshot: takeLsofSnapshot(deps.run, deps.lsofTimeoutMs ?? LSOF_TIMEOUT_MS) };
	const record = (verdict: ScratchVerdict | null) => {
		if (verdict === null) return;
		sessions.push(verdict);
		deps.onProgress?.(verdict);
	};
	const visit = (dir: string, root: string, nameRequired = true) => record(inspectOne(dir, root, snapDeps, nameRequired));
	for (const root of roots) eachSessionDir(root, dir => visit(dir, root), dir => visit(dir, root, false));
	for (const dir of systemWorkDirs) record(inspectSystemWorkDir(dir, snapDeps));
	const allRoots = [...new Set([...roots, ...systemWorkDirs.map(dirname)])];
	const orphans = selectHarnessOrphans(listProcesses(deps.run));
	const sized = dedupeNestedSizes(sessions);
	const totals = summarizeScratch(sized, allRoots);
	const rootMetrics = scratchRootMetrics(allRoots, totals.sizeByRoot, deps.statfs, rootSourceMap(entries, systemWorkDirs));
	const bunBuilds = inspectBunBuildFiles(entries, snapDeps);
	return { roots: allRoots, sessions: sized, bunBuilds, orphans, totals, rootMetrics,
		pressure: pressureForRoots(rootMetrics), quarantineBuckets: quarantineBuckets(home, deps.now ?? Date.now()),
		unownedActiveRule: UNOWNED_ACTIVE_RULE,
		reapableBytes: sized.filter(v => v.action === "REAP").reduce((n, v) => n + v.sizeBytes, 0)
			+ bunBuilds.filter(v => v.action === "REAP").reduce((n, v) => n + v.sizeBytes, 0),
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

export type ScratchGapClass = "never-released" | "pid-keyed-owner-never-released" | "released-unbinned" | "unowned" | "mismatched-owner";

/** One reclaimed dir that its owner failed to bin, with the seat that left it and the guard that should have stopped it (ompkit-774u.15 D). */
export interface ScratchGap { dir: string; label: string; agent: string | null; session: string | null; role: string; bin: ScratchBin | "unbinned";
	class: ScratchGapClass; reason: string; action: "REAP" | "QUARANTINE"; bytes: number; age_s: number | null; guard: string;
	/** Whether the dir exceeded its declared budget at reclaim time (null budget means unbounded, never over). */
	overBudget: boolean }

export interface ScratchGapReport { rows: ScratchGap[]; by_agent: Record<string, number>; by_class: Record<string, { count: number; bytes: number; guard: string }> }

export interface ScratchApplyResult extends ScratchPlan {
	applied: ScratchVerdict[];
	killed: { pid: number; command: string; ok: boolean }[];
	expired: ScratchVerdict[];
	receipt: ScratchRunReceipt;
	gapReport: ScratchGapReport;
}

const NO_GUARD = "NO GUARD: file one";
/** The bead whose guard stops each class; null when no guard exists yet, which the report says in words. */
const GAP_GUARDS: Record<ScratchGapClass, string | null> = {
	"never-released": "ompkit-774u.15",
	"pid-keyed-owner-never-released": "ompkit-774u.9.3",
	"released-unbinned": "ompkit-774u.15",
	unowned: null,
	"mismatched-owner": null,
};

/** The chief seat's agent name from the fleet-watch seat map; null when the map is absent or names none. */
function chiefAgent(home: string): string | null {
	try {
		const config: unknown = JSON.parse(readFileSync(fleetWatchConfigPath(home), "utf8"));
		if (typeof config !== "object" || config === null || !("chief" in config)) return null;
		const chief = config.chief;
		if (typeof chief !== "object" || chief === null || !("agent" in chief)) return null;
		return typeof chief.agent === "string" && AGENT_PATTERN.test(chief.agent) ? chief.agent : null;
	} catch {
		return null;
	}
}

/**
 * What each reclaimed dir says about the systems that let it die unbinned. A dir the owner released into a bin is not a
 * gap. Role comes from the seat map (the chief seat) and is UNKNOWN otherwise; it is never guessed.
 */
export function scratchGapReport(applied: readonly ScratchVerdict[], now: number, home: string): ScratchGapReport {
	const chief = chiefAgent(home);
	const rows: ScratchGap[] = [];
	for (const verdict of applied) {
		if (verdict.action !== "REAP" && verdict.action !== "QUARANTINE") continue;
		const owner = verdict.owner;
		let cls: ScratchGapClass;
		let bin: ScratchBin | "unbinned" = owner?.bin ?? "unbinned";
		if (verdict.reason.startsWith("owner-released")) {
			if (readReleaseRecord(verdict.dir)?.bin) continue;
			bin = "unbinned";
			cls = "released-unbinned";
		} else if (verdict.action === "REAP") {
			cls = owner === null ? "unowned" : owner.agent === null ? "pid-keyed-owner-never-released" : "never-released";
		} else {
			cls = verdict.reason.includes("mismatched-owner") ? "mismatched-owner" : "unowned";
		}
		const created = owner === null ? Number.NaN : Date.parse(owner.createdAt);
		const entry = basename(verdict.dir);
		const original = quarantineTimeOf(entry) === null ? entry : entry.slice(0, entry.lastIndexOf(".q-"));
		rows.push({ dir: verdict.dir, label: owner?.label ?? original, agent: owner?.agent ?? null, session: owner?.session ?? null,
			role: owner?.agent != null && owner.agent === chief ? "chief" : "UNKNOWN", bin, class: cls, reason: verdict.reason,
			action: verdict.action, bytes: verdict.sizeBytes, age_s: Number.isFinite(created) ? Math.max(0, Math.round((now - created) / 1000)) : null,
			guard: GAP_GUARDS[cls] ?? NO_GUARD, overBudget: owner?.budget != null && verdict.sizeBytes > owner.budget });
	}
	const by_agent: Record<string, number> = {};
	const by_class: ScratchGapReport["by_class"] = {};
	for (const row of rows) {
		by_agent[row.agent ?? "UNKNOWN"] = (by_agent[row.agent ?? "UNKNOWN"] ?? 0) + 1;
		const entry = by_class[row.class] ?? { count: 0, bytes: 0, guard: row.guard };
		entry.count++;
		entry.bytes += row.bytes;
		by_class[row.class] = entry;
	}
	return { rows, by_agent, by_class };
}

const MAX_GAP_FILE_DIRS = 15;
const MAX_REAP_LOG_READ_BYTES = 200 * 1024;

/** Dirs already filed to a guard bead by earlier runs (ompkit-774u.15 AC3): only new dirs are filed again. */
export function filedGapDirs(home: string, bead: string): string[] {
	let text: string;
	try {
		const stat = lstatSync(reapLogPath(home));
		if (!stat.isFile() || stat.size > 8 * MAX_REAP_LOG_READ_BYTES) return [];
		text = readFileSync(reapLogPath(home), "utf8").slice(-MAX_REAP_LOG_READ_BYTES);
	} catch {
		return [];
	}
	const filed: string[] = [];
	for (const line of text.split("\n")) {
		if (!line.includes('"event":"gap_filed"')) continue;
		try {
			const row = JSON.parse(line) as { bead?: unknown; dirs?: unknown };
			if (row.bead !== bead || !Array.isArray(row.dirs)) continue;
			for (const dir of row.dirs) if (typeof dir === "string") filed.push(dir);
		} catch { /* a partial last line is skipped */ }
	}
	return filed;
}

export interface GapFileRow { bead: string; class: ScratchGapClass; status: "filed" | "up-to-date" | "failed"; dirs: string[]; reason?: string }

export interface FileGapsOpts { actor: string; db?: string; run: ScratchRunner; now?: number }

function gapComment(bead: string, cls: ScratchGapClass, rows: ScratchGapRow[], at: string): string {
	const listed = rows.slice(0, MAX_GAP_FILE_DIRS).map(row =>
		`- ${row.dir} (${row.label}, agent ${row.agent ?? "UNKNOWN"}, role ${row.role}, ${row.action}, ${row.bytes} B)`);
	const more = rows.length > listed.length ? `\n- ... and ${rows.length - listed.length} more` : "";
	return `SCRATCH GAP (omp-kit scratch apply, ${at}): ${rows.length} reclaimed dir(s) in class ${cls} whose guard is ${bead}.\n`
		+ `${listed.join("\n")}${more}\n`
		+ `Each dir's owner ended without binning it. Release scratch when its work ends: \`omp-kit scratch release DIR --bin throwaway|evidence|promote [--ref ...]\`. Filed automatically; only dirs not filed before are listed.`;
}

type ScratchGapRow = Pick<ScratchGap, "dir" | "label" | "agent" | "role" | "action" | "bytes">;

/**
 * File each guarded gap class to its owning bead (ompkit-774u.15 AC3): one `br comments add` per bead with the dirs
 * no earlier run filed, then a `gap_filed` row in the reap log so the next run files only the delta. Classes with
 * no guard are never auto-filed; they come back as unfiled for the operator. A br failure is reported, never fatal.
 */
export function fileGapReports(home: string, report: ScratchGapReport, opts: FileGapsOpts):
	{ filed: GapFileRow[]; unfiled: { class: ScratchGapClass; count: number; example: string }[] } {
	const at = new Date(opts.now ?? Date.now()).toISOString();
	const filed: GapFileRow[] = [];
	const unfiled: { class: ScratchGapClass; count: number; example: string }[] = [];
	const byGuard: Record<string, ScratchGap[]> = {};
	for (const row of report.rows) {
		if (row.guard === NO_GUARD) {
			const entry = unfiled.find(item => item.class === row.class) ?? { class: row.class, count: 0, example: row.dir };
			entry.count++;
			if (!unfiled.includes(entry)) unfiled.push(entry);
			continue;
		}
		(byGuard[row.guard] ??= []).push(row);
	}
	for (const [bead, rows] of Object.entries(byGuard)) {
		const cls = rows[0]!.class;
		const already = new Set(filedGapDirs(home, bead));
		const fresh = rows.filter(row => !already.has(row.dir));
		if (fresh.length === 0) {
			filed.push({ bead, class: cls, status: "up-to-date", dirs: [] });
			continue;
		}
		const args = ["comments", "add", bead, "-m", gapComment(bead, cls, fresh, at), "--actor", opts.actor, ...(opts.db ? ["--db", opts.db] : [])];
		let result: ScratchRunResult;
		try {
			result = opts.run(["br", ...args], { timeoutMs: 30_000 });
		} catch (error) {
			filed.push({ bead, class: cls, status: "failed", dirs: fresh.map(row => row.dir), reason: error instanceof Error ? error.message : String(error) });
			continue;
		}
		if (result.code !== 0) {
			filed.push({ bead, class: cls, status: "failed", dirs: fresh.map(row => row.dir), reason: `br exited ${result.code}: ${result.stderr.slice(0, 200)}` });
			continue;
		}
		appendLog(home, { event: "gap_filed", dir: bead, at, bead, dirs: fresh.map(row => row.dir) });
		filed.push({ bead, class: cls, status: "filed", dirs: fresh.map(row => row.dir) });
	}
	return { filed, unfiled };
}

export function applyScratch(home: string, deps: ApplyDeps): ScratchApplyResult {
	const now = deps.now ?? Date.now();
	const startedAt = new Date(now).toISOString();
	const freePctBefore = measureDiskFreePercent(home, deps.statfs);
	const entries = resolveScratchRootEntries(home);
	const roots = entries.map(entry => entry.root);
	const systemWorkDirs = resolveSystemWorkDirs(deps);
	const allRoots = [...new Set([...roots, ...systemWorkDirs.map(dirname)])];
	const planned: { verdict: ScratchVerdict; root: string }[] = [];
	const snapDeps: ApplyDeps = { ...deps, lsofSnapshot: takeLsofSnapshot(deps.run, deps.lsofTimeoutMs ?? LSOF_TIMEOUT_MS) };
	const bunBuildPlan = inspectBunBuildFiles(entries, snapDeps);
	const collect = (dir: string, root: string, nameRequired = true) => {
		const verdict = inspectOne(dir, root, snapDeps, nameRequired);
		if (verdict !== null) planned.push({ verdict, root });
	};
	for (const root of roots) eachSessionDir(root, dir => collect(dir, root), dir => collect(dir, root, false));
	for (const dir of systemWorkDirs) {
		const verdict = inspectSystemWorkDir(dir, snapDeps);
		if (verdict !== null) planned.push({ verdict, root: dirname(dir) });
	}
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
			dir: terminal.dir, at: new Date(now).toISOString(), action: terminal.action, reason: terminal.reason,
			error: terminal.error ?? terminal.reason });
		deps.onProgress?.(terminal, { done: index + 1, total: planned.length });
	}
	const bunBuilds = bunBuildPlan.map(row => {
		const terminal = applyBunBuildFile(row, entries, deps);
		appendLog(home, { event: "bun-build", dir: terminal.path, at: new Date(now).toISOString(),
			action: terminal.action, reason: terminal.reason, bytes: terminal.sizeBytes });
		return terminal;
	});
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
	for (const verdict of bunBuilds) if (verdict.action === "REAP") reapedBytes += verdict.sizeBytes;
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
	const gapReport = scratchGapReport(applied, now, home);
	for (const row of gapReport.rows) appendLog(home, { event: "gap", dir: row.dir, at: finishedAt, ...row });
	return {
		roots: allRoots,
		sessions: planEcho,
		bunBuilds,
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
		gapReport,
	};
}

export function applyScratchForPressure(home: string, deps: ApplyDeps):
	{ free_pct: number | null; pressure: ScratchPressure; result: ScratchApplyResult | null } {
	const freePct = measureDiskFreePercent(home, deps.statfs);
	const pressure = classifyScratchPressure(freePct);
	const result = pressure === "RECLAIM" ? applyScratch(home, deps) : null;
	return { free_pct: freePct, pressure, result };
}

export type OwnedScratchState = "unreleased" | "released" | "held" | "hold-expired";

/** One dir the caller owns and where it stands: the list a disposal-point guard shows an owner that has not binned its work. */
export interface OwnedScratchRow { dir: string; label: string; state: OwnedScratchState; bin: ScratchBin | "unbinned";
	/** Live bytes on disk, the declared budget (null when unbounded), and whether the dir exceeds it. */
	bytes: number; budget: number | null; overBudget: boolean }

/**
 * The caller's own scratch dirs across the scratch roots (ompkit-774u.15 C): those whose owner record names the caller's
 * agent and a session it holds, or the caller's exact pid. Read-only; a dir
 * the owner already released is listed as released, a hold as held until its
 * expiry. Dirs of other owners and ancestor/sibling seats never appear.
*/
function disposalOwnerMatches(owner: ScratchOwner, deps: InspectDeps): boolean {
	// Disposal accounting is exact-seat ownership, not process ancestry. A child
	// seat must never be charged for a parent or sibling's scratch.
	return callerHoldsSeat(owner, deps) || owner.pid === process.pid;
}

function ownerIsLive(owner: ScratchOwner, deps: InspectDeps): boolean {
	return owner.processStart !== null && probeOwner(owner.pid, owner.processStart, deps.liveness) === "live";
}

export function ownedScratch(home: string, deps: InspectDeps): OwnedScratchRow[] {
	const now = deps.now ?? Date.now();
	// One listing reads the process table and the caller's session leases once, not once per dir: a fleet repo holds
	// thousands of owner files, and a per-dir ps and lsof made this take minutes.
	const answers = new Map<string, ScratchRunResult>();
	const run: ScratchRunner = (args, opts) => {
		const key = args.join("\0");
		let answer = answers.get(key);
		if (answer === undefined) {
			answer = deps.run(args, opts);
			answers.set(key, answer);
		}
		return answer;
	};
	let seat: SeatIdentity | undefined;
	const once: InspectDeps = { ...deps, run, callerSeat: () => (seat ??= deps.callerSeat ? deps.callerSeat() : callerSeat(run)) };
	const rows: OwnedScratchRow[] = [];
	for (const root of resolveScratchRoots(home)) {
		let names: string[];
		try {
			names = readdirSync(root);
		} catch {
			continue;
		}
		for (const name of names) {
			const dir = join(root, name);
			if (isSymlink(dir) || isSymlink(join(dir, ".owner"))) continue;
			const text = readText(join(dir, ".owner"));
			const owner = text === null ? null : parseOwnerFile(text);
			if (owner === null || !disposalOwnerMatches(owner, once) || ownerIsLive(owner, once)) continue;
			const released = readReleaseRecord(dir);
			const bytes = dirSize(dir);
			const budget = owner.budget;
			const overBudget = budget !== null && bytes > budget;
			if (released) {
				rows.push({ dir, label: owner.label, state: "released", bin: released.bin ?? "unbinned", bytes, budget, overBudget });
			} else if (owner.bin === "hold" && owner.expires !== null) {
				rows.push({ dir, label: owner.label, state: Date.parse(owner.expires) > now ? "held" : "hold-expired", bin: "hold", bytes, budget, overBudget });
			} else {
				rows.push({ dir, label: owner.label, state: "unreleased", bin: owner.bin ?? "unbinned", bytes, budget, overBudget });
			}
		}
	}
	return rows.sort((left, right) => left.dir.localeCompare(right.dir));
}

export type OwedFlagPoint = "review" | "close" | "wave" | "push" | "session-end";
export const OWED_FLAG_POINTS: readonly OwedFlagPoint[] = ["review", "close", "wave", "push", "session-end"];

/**
 * What a disposal point flags: an unreleased dir or an expired hold. The session's own dir (label omp, bin throwaway)
 * is not owed before the session ends: its owner releases it at session end, so flagging it at every close would be
 * noise, not a gap.
 */
export function owesRelease(row: OwnedScratchRow): boolean {
	if (row.label === "omp" && row.bin === "throwaway") return false;
	return row.state === "unreleased" || row.state === "hold-expired";
}

/**
 * One audit row per flag shown at a disposal point (ompkit-774u.15 C): which of the caller's own dirs were owed,
 * and where. The flag is a warning for 7 days and a refusal only if this log shows no flag that named a dir the caller
 * did not own; every row here comes from `ownedScratch`, so that is checkable against the dirs' owner files.
 */
export function logOwedFlag(home: string, point: OwedFlagPoint, rows: readonly OwnedScratchRow[], now: number = Date.now()): void {
	const owed = rows.filter(owesRelease);
	if (owed.length === 0) return;
	appendLog(home, { event: "flag", dir: owed[0]!.dir, at: new Date(now).toISOString(), point, dirs: owed.map(row => ({ dir: row.dir, state: row.state, bin: row.bin })) });
}

/**
 * Enforcement at a disposal point (ompkit-774u.15, Joshua scope 2026-10-20): bead close or hand-off to review,
 * wave close, push, and session end each refuse while the session holds an undisposed dir. Refuse on positive
 * evidence only; an unlistable ownership census is fail-open (`unproven`), never a block, so a broken measuring
 * tool cannot deadlock a seat. Every owed row carries a structured owner, so `release --bin throwaway` always
 * offers a way out; the audit row from logOwedFlag names exactly what was refused.
 */
export interface DisposalGateResult { decision: "ok" | "refuse"; owed: OwnedScratchRow[]; unproven: boolean }
export function disposalGate(home: string, point: OwedFlagPoint, deps: InspectDeps, now: number = Date.now()): DisposalGateResult {
	let rows: OwnedScratchRow[];
	try {
		rows = ownedScratch(home, deps);
	} catch {
		return { decision: "ok", owed: [], unproven: true };
	}
	const owed = rows.filter(owesRelease);
	logOwedFlag(home, point, rows, now);
	return { decision: owed.length > 0 ? "refuse" : "ok", owed, unproven: false };
}

export function touchForAge(path: string, ageMs: number, now: number = Date.now()): void {
	utimesSync(path, new Date(now - ageMs), new Date(now - ageMs));
}
