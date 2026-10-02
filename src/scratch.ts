import { appendFileSync, existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, utimesSync } from "node:fs";
import { delimiter, dirname, join, resolve } from "node:path";

/**
 * Scratch reaper (S2): plan/apply over operator scratch, ported from
 * zeststream-cast/scripts/lib/agent_tmp_reap.sh.
 *
 * A session directory is reapable ONLY when its recorded owner identity is gone
 * (or its PID was demonstrably reused) AND lsof reports no open descriptor.
 * Apply first atomically renames the entry into a central quarantine, revalidates
 * inode identity, owner snapshot and lsof state, then removes it. Dirs with no
 * (or malformed) owner file — including the legacy 3-field omp format — are never
 * reaped outright: past 72 h idle they move to quarantine, past 7 d quarantined
 * they are deleted after the same rechecks. Orphan kill targets ONLY kit harness
 * servers (ppid 1, older than 1 h, mock-model.mjs / external-live.mjs argv).
 */

export interface ScratchRunResult { code: number; stdout: string; stderr: string }
export type ScratchRunner = (args: readonly string[]) => ScratchRunResult;

export interface ScratchOwner { pid: number; processStart: string; label: string; repo: string; createdAt: string; argv0: string }

const OWNER_FIELDS = ["pid", "process_start", "label", "repo", "created_at", "argv0"] as const;
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
		if (!(OWNER_FIELDS as readonly string[]).includes(key)) return null;
		if (value === "" || /[\t\r\n]/.test(value)) return null;
		if (seen[key] !== undefined) return null;
		seen[key] = value;
	}
	for (const field of OWNER_FIELDS) if (seen[field] === undefined) return null;
	if (!/^[1-9][0-9]{0,5}$/.test(seen.pid!)) return null;
	return { pid: Number(seen.pid), processStart: seen.process_start!, label: seen.label!, repo: seen.repo!, createdAt: seen.created_at!, argv0: seen.argv0! };
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
export function lsofClear(dir: string, run: ScratchRunner): boolean | null {
	let out: ScratchRunResult;
	try {
		out = run(["lsof", "+D", dir]);
	} catch {
		return null;
	}
	const text = `${out.stdout}\n${out.stderr}`;
	if (text.includes("command not found") || /lsof:.*(not found|No such file)/i.test(text)) return null;
	if (out.stdout.trim() === "") {
		if (/^lsof:/m.test(text)) return null;
		return true;
	}
	if (/^lsof:/m.test(text)) return null;
	return false;
}

export function defaultRunner(args: readonly string[]): ScratchRunResult {
	try {
		const child = Bun.spawnSync([...args], { stdout: "pipe", stderr: "pipe" });
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
	"owner-changed-after-initial-check": true, "inode-proof-unavailable": true,
	"quarantine-create-failed": true, "atomic-quarantine-failed": true,
	"final-recheck-refused": true, "delete-quarantine-failed": true,
	"final-delete-recheck-failed": true, "delete-failed": true,
	"idle-proof-unavailable": true,
};

/** A terminal SKIP that means an intended mutation did not happen. */
export function isApplyFailure(verdict: ScratchVerdict): boolean {
	return verdict.action === "SKIP" && APPLY_FAILURE_REASONS[verdict.reason] === true;
}

export interface InspectDeps { liveness: LivenessDeps; run: ScratchRunner; now?: number }

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
	const state = probeOwner(owner.pid, owner.processStart, deps.liveness);
	if (state === "live" || state === "live-unreachable") return verdict("LIVE", state === "live" ? "owner-alive" : "owner-visible-but-signal-denied", owner);
	if (state === "unknown") return verdict("SKIP", "owner-liveness-unproven", owner);
	const clear = lsofClear(dir, deps.run);
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

function ownerSnapshot(owner: ScratchOwner): string {
	return [owner.pid, owner.processStart, owner.label, owner.repo, owner.createdAt, owner.argv0].join("\n");
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
	if (isSymlink(deleting) || inodeOf(deleting) !== identity || !finalOwner || ownerSnapshot(finalOwner) !== expected || lsofClear(deleting, deps.run) !== true) {
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
	if (inodeOf(moved) !== identity || lsofClear(moved, deps.run) !== true) {
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

/** Expired quarantine entries (>7d) are deleted after owner + lsof rechecks. */
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
		const { owner, malformed } = readOwner(path);
	 if (!owner || malformed) {
			if (lsofClear(path, deps.run) !== true) continue;
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
		if (lsofClear(path, deps.run) !== true) continue;
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

export function planScratch(home: string, deps: InspectDeps): ScratchPlan {
	const roots = resolveScratchRoots(home);
	const sessions: ScratchVerdict[] = [];
	for (const root of roots) {
		let entries: string[];
		try {
			entries = readdirSync(root);
		} catch {
			continue;
		}
		for (const entry of entries) {
			if (entry === "." || entry === "..") continue;
			const dir = join(root, entry);
			try {
				if (!statSync(dir).isDirectory() || isSymlink(dir)) continue;
			} catch {
				continue;
			}
		const verdict = inspectSession(dir, root, deps);
		if (verdict.action === "SKIP" && (verdict.reason === "no-owner-file" || verdict.reason === "malformed-owner-file")) {
			const freshest = idleSince(dir, deps.now ?? Date.now());
			if (freshest !== null && freshest < (deps.now ?? Date.now()) - QUARANTINE_IDLE_MS) {
				sessions.push({ ...verdict, action: "QUARANTINE", reason: "unowned-idle-72h-would-quarantine", sizeBytes: dirSize(dir) });
			} else {
				sessions.push({ ...verdict, action: "LIVE", reason: "unowned-but-active" });
			}
			continue;
		}
		sessions.push(verdict);
		}
	}
	const orphans = selectHarnessOrphans(listProcesses(deps.run));
	return { roots, sessions, orphans,
		reapableBytes: sessions.filter(v => v.action === "REAP").reduce((n, v) => n + v.sizeBytes, 0),
		quarantinableBytes: sessions.filter(v => v.action === "QUARANTINE").reduce((n, v) => n + v.sizeBytes, 0) };
}

export interface ScratchApplyResult extends ScratchPlan { applied: ScratchVerdict[]; killed: { pid: number; command: string; ok: boolean }[]; expired: ScratchVerdict[] }

export function applyScratch(home: string, deps: ApplyDeps): ScratchApplyResult {
	const plan = planScratch(home, deps);
	const applied: ScratchVerdict[] = [];
	for (const verdict of plan.sessions) {
		if (verdict.action === "REAP") {
			const root = plan.roots.find(r => verdict.dir.startsWith(`${r}/`)) ?? dirname(verdict.dir);
			applied.push(applyReap(verdict.dir, root, verdict, deps));
		} else if (verdict.action === "QUARANTINE") {
			const root = plan.roots.find(r => verdict.dir.startsWith(`${r}/`)) ?? dirname(verdict.dir);
			applied.push(applyUnowned(verdict.dir, root, deps));
		} else {
			applied.push(verdict);
		}
	}
	const killed = plan.orphans.map(proc => {
		const ok = killOrphan(proc.pid, deps);
		appendLog(home, { event: "orphan-kill", dir: "", at: new Date(deps.now ?? Date.now()).toISOString(), pid: proc.pid, command: proc.command, ok });
		return { pid: proc.pid, command: proc.command, ok };
	});
	const expired = applyQuarantineExpiry(home, deps);
	return { ...plan, sessions: applied, killed, expired,
		reapableBytes: applied.filter(v => v.action === "REAP").reduce((n, v) => n + v.sizeBytes, 0),
		quarantinableBytes: applied.filter(v => v.action === "QUARANTINE").reduce((n, v) => n + v.sizeBytes, 0) };
}

export function touchForAge(path: string, ageMs: number, now: number = Date.now()): void {
	utimesSync(path, new Date(now - ageMs), new Date(now - ageMs));
}
