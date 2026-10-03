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
	const seen: Record<string, string> = {};
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

export interface InspectDeps { liveness: LivenessDeps; run: ScratchRunner; now?: number; lsofTimeoutMs?: number; onProgress?: (verdict: ScratchVerdict) => void }

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
	const verdict = (action: ScratchAction, reason: string, owner: ScratchOwner | null = null): ScratchVerdict =>
		({ dir, action, reason, owner, sizeBytes: 0 });
	if (isSymlink(dir)) return verdict("SKIP", "session-is-symlink");
	let stat;
	try {
		stat = statSync(dir);
	} catch {
		return verdict("SKIP", "not-directory");
	}
	if (!stat.isDirectory()) return verdict("SKIP", "not-directory");
	if (resolve(dir) !== dir || !dir.startsWith(root)) return verdict("SKIP", "session-outside-root");
	const { owner, malformed } = readOwner(dir);
	if (!owner) return verdict("SKIP", malformed ? "malformed-owner-file" : "no-owner-file");
	if (!/^[A-Za-z0-9._%-]+$/.test(owner.label) || owner.label === "" || owner.label.includes("/") || owner.label.startsWith(".")) {
		return verdict("SKIP", "owner-label-invalid", owner);
	}
	const name = dir.slice(root.length + 1);
	if (nameRequired && name !== `${owner.label}.${owner.pid}`) return verdict("SKIP", "session-name-owner-mismatch", owner);
	if (!hasProcessIdentity(owner)) {
		if (deps.liveness.signalAlive(owner.pid) || deps.liveness.psVisible(owner.pid))
			return verdict("LIVE", "owner-alive-start-unverified", owner);
		return verdict("SKIP", "owner-identity-incomplete", owner);
	}
	const state = probeOwner(owner.pid, owner.processStart, deps.liveness);
	if (state === "live" || state === "live-unreachable") return verdict("LIVE", state === "live" ? "owner-alive" : "owner-visible-but-signal-denied", owner);
	if (state === "unknown") return verdict("SKIP", "owner-liveness-unproven", owner);
	const clear = lsofClear(dir, deps.run, deps.lsofTimeoutMs ?? LSOF_TIMEOUT_MS);
	if (clear === null) return verdict("SKIP", "lsof-evidence-unavailable", owner);
	if (!clear) return verdict("LIVE", `owner-${state}-but-open-fds-present`, owner);
	return { dir, action: "REAP", reason: `owner-${state}-no-open-fds`, owner, sizeBytes: dirSize(dir) };
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
	return `${dirName}.q-${at.toISOString().replace(/[:.]/g, "-")}`;
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
interface ReleaseRecord { owner: ScratchOwner; ownerText: string; markerText: string; releasedAt: string }

function parseReleaseMarker(text: string): Omit<ReleaseRecord, "owner" | "ownerText"> & { ownerHash: string; device: string; inode: string } | null {
	const seen: Record<string, string> = {};
	for (const line of text.split("\n")) {
		if (line === "") continue;
		const eq = line.indexOf("=");
		if (eq < 0) return null;
		const key = line.slice(0, eq);
		const value = line.slice(eq + 1);
		if (!["version", "owner_sha256", "device", "inode", "released_at"].includes(key) ||
			value === "" || /[\t\r\n]/.test(value) || seen[key] !== undefined) return null;
		seen[key] = value;
	}
	if (Object.keys(seen).length !== 5 || seen.version !== "1" ||
		!/^[0-9a-f]{64}$/.test(seen.owner_sha256!) || !/^\d+$/.test(seen.device!) ||
		!/^\d+$/.test(seen.inode!) || !Number.isFinite(Date.parse(seen.released_at!))) return null;
	return { markerText: text, releasedAt: seen.released_at!, ownerHash: seen.owner_sha256!, device: seen.device!, inode: seen.inode! };
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
	const owner = parseOwnerFile(ownerText);
	const marker = parseReleaseMarker(markerText);
	if (!owner || !marker) return null;
	let stat;
	try {
		stat = lstatSync(dir);
	} catch {
		return null;
	}
	if (!stat.isDirectory() || stat.isSymbolicLink() ||
		createHash("sha256").update(ownerText).digest("hex") !== marker.ownerHash ||
		String(stat.dev) !== marker.device || String(stat.ino) !== marker.inode) return null;
	return { owner, ownerText, markerText, releasedAt: marker.releasedAt };
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

export function releaseScratch(path: string, home: string, deps: InspectDeps): ScratchReleaseResult {
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
	if (!owner) return { ok: false, changed: false, dir, reason: "owner-file-invalid", ownerPid: null };
	if (!/^[A-Za-z0-9._%-]+$/.test(owner.label) || owner.label === "" || owner.label.includes("/") ||
		owner.label.startsWith(".") || basename(dir) !== `${owner.label}.${owner.pid}`)
		return { ok: false, changed: false, dir, reason: "directory-owner-mismatch", ownerPid: owner.pid };
	if (!callerIsOwnedBy(owner.pid, process.pid, deps.run))
		return { ok: false, changed: false, dir, reason: "caller-not-owner", ownerPid: owner.pid };
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

/** Move an owner-released session to quarantine without requiring its process to exit. */
function applyReleased(dir: string, root: string, verdict: ScratchVerdict, deps: ApplyDeps): ScratchVerdict {
	const fail = (reason: string): ScratchVerdict => ({ ...verdict, action: "SKIP", reason });
	const released = readReleaseRecord(dir);
	if (!released || dirname(dir) !== root || basename(dir) !== `${released.owner.label}.${released.owner.pid}`)
		return fail("owner-release-changed-after-initial-check");
	const identity = inodeOf(dir);
	if (identity === null) return fail("inode-proof-unavailable");
	const clearBefore = lsofClear(dir, deps.run, deps.lsofTimeoutMs ?? LSOF_TIMEOUT_MS);
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
	const clearAfter = lsofClear(moved, deps.run, deps.lsofTimeoutMs ?? LSOF_TIMEOUT_MS);
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
	const fail = (reason: string): ScratchVerdict => ({ ...verdict, action: "SKIP", reason });
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
	if (isSymlink(deleting) || inodeOf(deleting) !== identity || !finalOwner || ownerSnapshot(finalOwner) !== expected || lsofClear(deleting, deps.run, deps.lsofTimeoutMs ?? LSOF_TIMEOUT_MS) !== true) {
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
	if (inodeOf(moved) !== identity || lsofClear(moved, deps.run, deps.lsofTimeoutMs ?? LSOF_TIMEOUT_MS) !== true) {
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
			if (identity === null || lsofClear(path, deps.run, deps.lsofTimeoutMs ?? LSOF_TIMEOUT_MS) !== true) continue;
			const rechecked = readReleaseRecord(path);
			if (!rechecked || rechecked.markerText !== released.markerText || rechecked.ownerText !== released.ownerText ||
				inodeOf(path) !== identity || lsofClear(path, deps.run, deps.lsofTimeoutMs ?? LSOF_TIMEOUT_MS) !== true) continue;
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
			if (lsofClear(path, deps.run, deps.lsofTimeoutMs ?? LSOF_TIMEOUT_MS) !== true) continue;
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
		if (lsofClear(path, deps.run, deps.lsofTimeoutMs ?? LSOF_TIMEOUT_MS) !== true) continue;
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

export interface ScratchPlan { roots: string[]; sessions: ScratchVerdict[]; orphans: OrphanProcess[]; reapableBytes: number; quarantinableBytes: number }

/** One directory through the full plan verdict (owner release, live/dead identity and unowned age). */
export function inspectOne(dir: string, root: string, deps: InspectDeps, nameRequired = true): ScratchVerdict | null {
	try {
		if (!statSync(dir).isDirectory() || isSymlink(dir)) return null;
	} catch {
		return null;
	}
	const released = readReleaseRecord(dir);
	if (released && dirname(dir) === root && resolve(dir) === dir &&
		basename(dir) === `${released.owner.label}.${released.owner.pid}`) {
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
		return { ...verdict, action: "LIVE", reason: "unowned-but-active" };
	}
	return verdict;
}

function eachSessionDir(root: string, visit: (dir: string) => void): void {
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
}

export function planScratch(home: string, deps: InspectDeps): ScratchPlan {
	const roots = resolveScratchRoots(home);
	const systemWorkDirs = resolveSystemWorkDirs();
	const sessions: ScratchVerdict[] = [];
	const visit = (dir: string, root: string, nameRequired = true) => {
		const verdict = inspectOne(dir, root, deps, nameRequired);
		if (verdict === null) return;
		sessions.push(verdict);
		deps.onProgress?.(verdict);
	};
	for (const root of roots) eachSessionDir(root, dir => visit(dir, root));
	for (const dir of systemWorkDirs) visit(dir, dirname(dir), false);
	const allRoots = [...new Set([...roots, ...systemWorkDirs.map(dirname)])];
	const orphans = selectHarnessOrphans(listProcesses(deps.run));
	return { roots: allRoots, sessions, orphans,
		reapableBytes: sessions.filter(v => v.action === "REAP").reduce((n, v) => n + v.sizeBytes, 0),
		quarantinableBytes: sessions.filter(v => v.action === "QUARANTINE").reduce((n, v) => n + v.sizeBytes, 0) };
}

export interface ScratchApplyResult extends ScratchPlan { applied: ScratchVerdict[]; killed: { pid: number; command: string; ok: boolean }[]; expired: ScratchVerdict[] }

export function applyScratch(home: string, deps: ApplyDeps): ScratchApplyResult {
	const roots = resolveScratchRoots(home);
	const systemWorkDirs = resolveSystemWorkDirs();
	const sessions: ScratchVerdict[] = [];
	const applied: ScratchVerdict[] = [];
	const allRoots = [...new Set([...roots, ...systemWorkDirs.map(dirname)])];
	const rootOf = (dir: string): string => allRoots.find(r => dir.startsWith(r + "/")) ?? dirname(dir);
	const visit = (dir: string, root: string, nameRequired = true) => {
		const verdict = inspectOne(dir, root, deps, nameRequired);
		if (verdict === null) return;
		sessions.push(verdict);
		let terminal = verdict;
		if (verdict.action === "REAP") terminal = applyReap(verdict.dir, rootOf(verdict.dir), verdict, deps);
		else if (verdict.action === "QUARANTINE") {
			terminal = verdict.reason === "owner-released-would-quarantine"
				? applyReleased(verdict.dir, root, verdict, deps)
				: applyUnowned(verdict.dir, rootOf(verdict.dir), deps);
		}
		applied.push(terminal);
		deps.onProgress?.(terminal);
	};
	for (const root of roots) eachSessionDir(root, dir => visit(dir, root));
	for (const dir of systemWorkDirs) visit(dir, dirname(dir), false);
	const orphans = selectHarnessOrphans(listProcesses(deps.run));
	const killed = orphans.map(proc => {
		const ok = killOrphan(proc.pid, deps);
		appendLog(home, { event: "orphan-kill", dir: "", at: new Date(deps.now ?? Date.now()).toISOString(), pid: proc.pid, command: proc.command, ok });
		return { pid: proc.pid, command: proc.command, ok };
	});
	const expired = applyQuarantineExpiry(home, deps);
	return { roots: allRoots, sessions, orphans, applied, killed, expired,
		reapableBytes: applied.filter(v => v.action === "REAP").reduce((n, v) => n + v.sizeBytes, 0),
		quarantinableBytes: applied.filter(v => v.action === "QUARANTINE").reduce((n, v) => n + v.sizeBytes, 0) };
}

export function touchForAge(path: string, ageMs: number, now: number = Date.now()): void {
	utimesSync(path, new Date(now - ageMs), new Date(now - ageMs));
}
