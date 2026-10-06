import { createHash } from "node:crypto";
import { appendFileSync, existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { basename, delimiter, dirname, join, resolve } from "node:path";

/**
 * Scratch reaper (S2): plan/apply over operator scratch, ported from
 * zeststream-cast/scripts/lib/agent_tmp_reap.sh.
 *
 * A session directory is reapable ONLY when its six-field owner identity is gone
 * (or its PID was demonstrably reused) AND lsof reports no open descriptor.
 * Entries without that process identity (including the fleet guard's four-field
 * marker and the legacy three-field format) use idle quarantine: past 72 h they
 * move to quarantine, past 7 d quarantined they are deleted after lsof rechecks.
 * Orphan kill targets ONLY kit harness servers (ppid 1, older than 1 h,
 * mock-model.mjs / external-live.mjs argv).
 */

export interface ScratchRunResult { code: number | null; stdout: string; stderr: string }
export type ScratchRunner = (args: readonly string[], opts?: { timeoutMs?: number }) => ScratchRunResult;

export interface ScratchOwner { pid: number; processStart: string | null; label: string; repo: string; createdAt: string; argv0: string | null }

const OWNER_FIELDS = ["pid", "process_start", "label", "repo", "created_at", "argv0"] as const;
const LEGACY_OWNER_FIELDS = ["pid", "label", "repo", "created"] as const;
const ALLOWED_OWNER_FIELDS = [...OWNER_FIELDS, ...LEGACY_OWNER_FIELDS];
const RELEASE_FILE = ".omp-kit-release";
const QUARANTINE_IDLE_MS = 72 * 3600 * 1000;
const QUARANTINE_TTL_MS = 7 * 24 * 3600 * 1000;
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
	const complete = OWNER_FIELDS.every(field => seen[field] !== undefined) && Object.keys(seen).length === OWNER_FIELDS.length;
	const legacy = LEGACY_OWNER_FIELDS.every(field => seen[field] !== undefined) && Object.keys(seen).length === LEGACY_OWNER_FIELDS.length;
	if (!complete && !legacy) return null;
	if (!/^[1-9][0-9]{0,5}$/.test(seen.pid!)) return null;
	return { pid: Number(seen.pid), processStart: seen.process_start ?? null, label: seen.label!,
		repo: seen.repo!, createdAt: seen.created_at ?? seen.created!, argv0: seen.argv0 ?? null };
}
function hasProcessIdentity(owner: ScratchOwner): owner is ScratchOwner & { processStart: string; argv0: string } {
	return owner.processStart !== null && owner.argv0 !== null;
}


export type OwnerState = "live" | "reused" | "dead" | "live-unreachable" | "unknown";

export interface LivenessDeps {
	signalAlive: (pid: number) => boolean;
	psVisible: (pid: number) => boolean;
	processStart: (pid: number) => string | null;
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
		return true;
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

export interface ScratchVerdict { dir: string; action: ScratchAction; reason: string; owner: ScratchOwner | null; sizeBytes: number }

const APPLY_FAILURE_REASONS: Record<string, true> = {
	"owner-changed-after-initial-check": true, "owner-release-changed-after-initial-check": true,
	"inode-proof-unavailable": true, "lsof-evidence-unavailable": true, "owner-released-but-open-fds-present": true,
	"quarantine-create-failed": true, "atomic-quarantine-failed": true,
	"final-recheck-refused": true, "delete-quarantine-failed": true,
	"final-delete-recheck-failed": true, "delete-failed": true,
	"idle-proof-unavailable": true,
};

/** A terminal SKIP that means an intended mutation did not happen. */
export function isApplyFailure(verdict: ScratchVerdict): boolean {
	return verdict.action === "SKIP" && APPLY_FAILURE_REASONS[verdict.reason] === true;
}

export interface InspectDeps { liveness: LivenessDeps; run: ScratchRunner; now?: number; lsofTimeoutMs?: number; onProgress?: (verdict: ScratchVerdict) => void; lsofSnapshot?: Set<string> | null }

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

export function inspectSession(dir: string, root: string, deps: InspectDeps, nameRequired = true): ScratchVerdict {
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
	if (!/^[A-Za-z0-9._%-]+$/.test(owner.label) || owner.label === "" || owner.label.includes("/") || owner.label.startsWith(".")) {
		return sized("SKIP", "owner-label-invalid", owner);
	}
	const name = dir.slice(root.length + 1);
	if (nameRequired && !name.endsWith(`.${owner.pid}`)) return sized("SKIP", "session-name-owner-mismatch", owner);
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
 * PID-reuse proof for owners without process identity (legacy key=value or JSON):
 * the pid is alive, but the live process started after the owner's `created` time,
 * so it cannot be the process that wrote the owner file. Null when unprovable
 * (fail closed: the caller keeps the LIVE verdict).
 */
export function reuseAfterCreated(owner: ScratchOwner, liveness: LivenessDeps): boolean | null {
	const start = liveness.processStart(owner.pid);
	if (start === null) return null;
	const startMs = parsePsStart(start) ?? Date.parse(start);
	const createdMs = Date.parse(owner.createdAt);
	if (Number.isNaN(startMs) || Number.isNaN(createdMs)) return null;
	return startMs > createdMs;
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
	const match = /\.q-(\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z)$/.exec(entryName);
	if (!match) return null;
	const stamp = match[1]!.replace(/^(\d{4}-\d{2}-\d{2}T\d{2})-(\d{2})-(\d{2})-(\d{3}Z)$/, "$1:$2:$3.$4");
	const time = Date.parse(stamp);
	return Number.isFinite(time) ? time : null;
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

export function resolveScratchRoots(home: string): string[] {
	const override = process.env.OMP_KIT_SCRATCH_ROOTS;
	if (override !== undefined && override !== "") return override.split(delimiter).map(part => part.trim()).filter(part => part !== "");
	const roots: string[] = [];
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
				roots.push(candidate);
			}
		} catch {
			continue;
		}
	}
	try {
		if (statSync(fleetTestTmpBase()).isDirectory() && !isSymlink(fleetTestTmpBase())) roots.push(fleetTestTmpBase());
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
				if (statSync(candidate).isDirectory() && !isSymlink(candidate)) roots.push(candidate);
			} catch {
				continue;
			}
		}
	}
	return [...new Set(roots)];
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
	now?: number;
}

export interface ReapEvent { event: string; dir: string; at: string; [key: string]: unknown }

function appendLog(home: string, event: ReapEvent): void {
	try {
		mkdirSync(dirname(reapLogPath(home)), { recursive: true, mode: 0o700 });
		appendFileSync(reapLogPath(home), `${JSON.stringify(event)}\n`, { mode: 0o600 });
	} catch {
		/* logging never blocks the verdict */
	}
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
		label: marker.legacyName, repo: "", createdAt: "", argv0: null };
	return { owner, ownerText, markerText, releasedAt: marker.releasedAt, legacy: true, legacyName: marker.legacyName };
}

function callerIsOwnedBy(ownerPid: number, callerPid: number, run: ScratchRunner): boolean {
	if (ownerPid === callerPid) return true;
	const out = run(["ps", "-axo", "pid=,ppid="]);
	if (out.code !== 0) return false;
	const parents = new Map<number, number>();
	for (const line of out.stdout.split("\n")) {
		const match = /^\s*(\d+)\s+(\d+)\s*$/.exec(line);
		if (!match) continue;
		parents.set(Number(match[1]), Number(match[2]));
	}
	const seen = new Set<number>([callerPid]);
	let current = callerPid;
	for (let depth = 0; depth < 256; depth++) {
		const parent = parents.get(current);
		if (parent === undefined || parent <= 0 || seen.has(parent)) return false;
		if (parent === ownerPid) return true;
		seen.add(parent);
		current = parent;
	}
	return false;
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
	if (!/^[A-Za-z0-9._%-]+$/.test(owner.label) || owner.label === "" || owner.label.includes("/") ||
		owner.label.startsWith(".") || !basename(dir).endsWith(`.${owner.pid}`))
		return { ok: false, changed: false, dir, reason: "directory-owner-mismatch", ownerPid: owner.pid };
	if (!callerIsOwnedBy(owner.pid, process.pid, deps.run))
		return { ok: false, changed: false, dir, reason: "caller-not-owner", ownerPid: owner.pid };
	if (owner.processStart !== null) {
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
	const ownerText = `pid=${process.pid}\nprocess_start=${start}\nlabel=${label}\nrepo=${repo}\ncreated_at=${createdAt}\nargv0=${argv}\n`;
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
	if (!released || dirname(dir) !== root || (released.legacy
		? basename(dir) !== released.legacyName
		: !basename(dir).endsWith(`.${released.owner.pid}`)))
		return fail("owner-release-changed-after-initial-check");
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
		afterMove.ownerText !== released.ownerText || clearAfter !== true) {
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
	return [owner.pid, owner.processStart ?? "", owner.label, owner.repo, owner.createdAt, owner.argv0 ?? ""].join("\n");
}

/** Atomic quarantine + full recheck, then delete. Returns the terminal action. */
export function applyReap(dir: string, root: string, verdict: ScratchVerdict, deps: ApplyDeps): ScratchVerdict {
	const now = deps.now ?? Date.now();
	const at = new Date(now).toISOString();
	const fail = (reason: string): ScratchVerdict => { const failed = { ...verdict, action: "SKIP" as const, reason }; appendLog(deps.home, { event: "failure", dir: failed.dir, at, action: failed.action, error: reason }); return failed; };
	if (!verdict.owner) return fail("owner-changed-after-initial-check");
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
	const recheck = inspectSession(moved, qt, deps, false);
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
	if (isSymlink(deleting) || inodeOf(deleting) !== identity || !finalOwner || ownerSnapshot(finalOwner) !== expected || lsofClearDir(deps, deleting) !== true) {
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

/** Unowned entry lifecycle: idle 72h -> quarantine, quarantined 7d -> delete (with rechecks). */
export function applyUnowned(dir: string, root: string, deps: ApplyDeps): ScratchVerdict {
	const now = deps.now ?? Date.now();
	const at = new Date(now).toISOString();
	const base: ScratchVerdict = { dir, action: "SKIP", reason: "unknown", owner: null, sizeBytes: 0 };
	if (isSymlink(dir)) return { ...base, reason: "session-is-symlink" };
	const freshest = idleSince(dir, now);
	if (freshest === null) return { ...base, reason: "idle-proof-unavailable" };
	if (freshest >= now - QUARANTINE_IDLE_MS) return { ...base, action: "LIVE", reason: "unowned-but-active" };
	const entry = quarantineEntryFor(dir.slice(root.length + 1));
	const qt = quarantineDir(deps.home);
	try {
		mkdirSync(qt, { recursive: true, mode: 0o700 });
	} catch {
		return { ...base, reason: "quarantine-create-failed" };
	}
	const moved = join(qt, entry);
	const identity = inodeOf(dir);
	if (identity === null) return { ...base, reason: "inode-proof-unavailable" };
	try {
		renameSync(dir, moved);
	} catch {
		return { ...base, reason: "atomic-quarantine-failed" };
	}
	if (inodeOf(moved) !== identity || lsofClearDir(deps, moved) !== true) {
		try {
			renameSync(moved, dir);
		} catch {
			return { ...base, dir: moved, reason: "final-recheck-refused" };
		}
		return { ...base, reason: "final-recheck-refused" };
	}
	appendLog(deps.home, { event: "quarantine", dir, at, entry, sizeBytes: dirSize(moved) });
	return { ...base, dir: moved, action: "QUARANTINE", reason: "unowned-idle-72h-quarantined", sizeBytes: dirSize(moved) };
}

/** Expired quarantine entries (>7d) are deleted after owner-release or lsof rechecks. */
export function applyQuarantineExpiry(home: string, deps: ApplyDeps): ScratchVerdict[] {
	const done: ScratchVerdict[] = [];
	const now = deps.now ?? Date.now();
	const at = new Date(now).toISOString();
	const qt = quarantineDir(home);
	let entries: string[];
	try {
		entries = readdirSync(qt);
	} catch {
		return done;
	}
	for (const entry of entries) {
		if (entry.startsWith(".") || entry.endsWith(`.delete-${process.pid}`)) continue;
		const quarantinedAt = quarantineTimeOf(entry);
		if (quarantinedAt === null || now - quarantinedAt < QUARANTINE_TTL_MS) continue;
		const path = join(qt, entry);
		if (isSymlink(path)) continue;
		const released = readReleaseRecord(path);
		if (released) {
			const identity = inodeOf(path);
			if (identity === null || lsofClearDir(deps, path) !== true) continue;
			const rechecked = readReleaseRecord(path);
			if (!rechecked || rechecked.markerText !== released.markerText || rechecked.ownerText !== released.ownerText ||
				inodeOf(path) !== identity || lsofClearDir(deps, path) !== true) continue;
			try {
				rmSync(path, { recursive: true, force: true });
			} catch {
				continue;
			}
			if (!existsSync(path)) {
				done.push({ dir: path, action: "DELETE", reason: "quarantine-expired-7d-owner-released", owner: released.owner, sizeBytes: 0 });
				appendLog(home, { event: "delete-quarantined", dir: path, at, entry, owner: released.owner.pid, reason: "owner-released" });
			}
			continue;
		}
		const { owner, malformed } = readOwner(path);
		if (!owner || malformed || !hasProcessIdentity(owner)) {
			if (lsofClearDir(deps, path) !== true) continue;
			try {
				rmSync(path, { recursive: true, force: true });
			} catch {
				continue;
			}
			if (!existsSync(path)) {
				done.push({ dir: path, action: "DELETE", reason: "quarantine-expired-7d", owner: null, sizeBytes: 0 });
				appendLog(home, { event: "delete-quarantined", dir: path, at, entry });
			}
			continue;
		}
		const state = probeOwner(owner.pid, owner.processStart, deps.liveness);
		if (state !== "dead" && state !== "reused") continue;
		if (lsofClearDir(deps, path) !== true) continue;
		try {
			rmSync(path, { recursive: true, force: true });
		} catch {
			continue;
		}
		if (!existsSync(path)) {
			done.push({ dir: path, action: "DELETE", reason: `quarantine-expired-7d-owner-${state}`, owner, sizeBytes: 0 });
			appendLog(home, { event: "delete-quarantined", dir: path, at, entry });
		}
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

/** One directory through the full plan verdict (owner release, live/dead identity and unowned age). */
export function inspectOne(dir: string, root: string, deps: InspectDeps, nameRequired = true): ScratchVerdict | null {
	try {
		if (!statSync(dir).isDirectory() || isSymlink(dir)) return null;
	} catch {
		return null;
	}
	const released = readReleaseRecord(dir);
	const releasedNameOk = released !== null && (released.legacy
		? basename(dir) === released.legacyName
		: basename(dir).endsWith(`.${released.owner.pid}`));
	if (released && dirname(dir) === root && resolve(dir) === dir && releasedNameOk) {
		return { dir, action: "QUARANTINE", reason: "owner-released-would-quarantine",
			owner: released.owner, sizeBytes: dirSize(dir) };
	}
	const verdict = inspectSession(dir, root, deps, nameRequired);
	if (verdict.action === "SKIP" && (verdict.reason === "no-owner-file" ||
		verdict.reason === "malformed-owner-file" || verdict.reason === "owner-identity-incomplete")) {
		const freshest = idleSince(dir, deps.now ?? Date.now());
		if (freshest !== null && freshest < (deps.now ?? Date.now()) - QUARANTINE_IDLE_MS) {
			return { ...verdict, action: "QUARANTINE", reason: "unowned-idle-72h-would-quarantine", sizeBytes: dirSize(dir) };
		}
		return verdict.reason === "malformed-owner-file"
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

export interface ScratchPlan { roots: string[]; sessions: ScratchVerdict[]; orphans: OrphanProcess[]; reapableBytes: number; quarantinableBytes: number; totals: ScratchTotals; unownedActiveRule: string }


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
	const roots = resolveScratchRoots(home);
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
	return { roots: allRoots, sessions: sized, orphans, totals, unownedActiveRule: UNOWNED_ACTIVE_RULE,
		reapableBytes: sized.filter(v => v.action === "REAP").reduce((n, v) => n + v.sizeBytes, 0),
		quarantinableBytes: sized.filter(v => v.action === "QUARANTINE").reduce((n, v) => n + v.sizeBytes, 0) };
}

export interface ScratchApplyResult extends ScratchPlan { applied: ScratchVerdict[]; killed: { pid: number; command: string; ok: boolean }[]; expired: ScratchVerdict[] }

export function applyScratch(home: string, deps: ApplyDeps): ScratchApplyResult {
	const roots = resolveScratchRoots(home);
	const systemWorkDirs = resolveSystemWorkDirs();
	const sessions: ScratchVerdict[] = [];
	const applied: ScratchVerdict[] = [];
	const allRoots = [...new Set([...roots, ...systemWorkDirs.map(dirname)])];
	const rootOf = (dir: string): string => allRoots.find(r => dir.startsWith(r + "/")) ?? dirname(dir);
	const snapDeps: ApplyDeps = { ...deps, lsofSnapshot: takeLsofSnapshot(deps.run, deps.lsofTimeoutMs ?? LSOF_TIMEOUT_MS) };
	const visit = (dir: string, root: string, nameRequired = true) => {
		const verdict = inspectOne(dir, root, snapDeps, nameRequired);
		if (verdict === null) return;
		sessions.push(verdict);
		let terminal = verdict;
		// Mutations move paths, so each action re-checks against a fresh snapshot.
		const fresh: ApplyDeps = { ...deps, lsofSnapshot: takeLsofSnapshot(deps.run, deps.lsofTimeoutMs ?? LSOF_TIMEOUT_MS) };
		if (verdict.action === "REAP") terminal = applyReap(verdict.dir, rootOf(verdict.dir), verdict, fresh);
		else if (verdict.action === "QUARANTINE") {
			terminal = verdict.reason === "owner-released-would-quarantine"
				? applyReleased(verdict.dir, root, verdict, fresh)
				: applyUnowned(verdict.dir, rootOf(verdict.dir), fresh);
		}
		applied.push(terminal);
			if (terminal.action === "SKIP") appendLog(home, { event: "failure", dir: terminal.dir, at: new Date(deps.now ?? Date.now()).toISOString(), action: terminal.action, error: terminal.reason });
		deps.onProgress?.(terminal);
	};
	for (const root of roots) eachSessionDir(root, dir => visit(dir, root), dir => visit(dir, root, false));
	for (const dir of systemWorkDirs) visit(dir, dirname(dir), false);
	const orphans = selectHarnessOrphans(listProcesses(deps.run));
	const killed = orphans.map(proc => {
		const ok = killOrphan(proc.pid, deps);
		appendLog(home, { event: "orphan-kill", dir: "", at: new Date(deps.now ?? Date.now()).toISOString(), pid: proc.pid, command: proc.command, ok });
		return { pid: proc.pid, command: proc.command, ok };
	});
	const expired = applyQuarantineExpiry(home, deps);
	const planEcho = dedupeNestedSizes(sessions);
	return { roots: allRoots, sessions: planEcho, orphans, applied, killed, expired,
		totals: summarizeScratch(applied, allRoots), unownedActiveRule: UNOWNED_ACTIVE_RULE,
		reapableBytes: applied.filter(v => v.action === "REAP").reduce((n, v) => n + v.sizeBytes, 0),
		quarantinableBytes: applied.filter(v => v.action === "QUARANTINE").reduce((n, v) => n + v.sizeBytes, 0) };
}

export function touchForAge(path: string, ageMs: number, now: number = Date.now()): void {
	utimesSync(path, new Date(now - ageMs), new Date(now - ageMs));
}
