import { randomUUID } from "node:crypto";
import { lstatSync, readdirSync, readFileSync, renameSync, unlinkSync, writeFileSync, type Dirent } from "node:fs";
import { join, resolve } from "node:path";
import { admitActuator, type AdmissionInput } from "./actuator-admission.ts";
import { defaultLiveness, probeOwner, type LivenessDeps, type OwnerState } from "./scratch.ts";
const RECOVERY_ROOT = [".beads", ".br_recovery", "schema-migrations"] as const;
const RECOVERY_MARKER = "recovery-failed.json";
const LEASE_FILE = ".omp-kit-recovery-lease.json";
const BUSY_RECOVERY_ERROR = "database is busy (recovery in progress)";

export type TrackerRecoveryKind = "RECOVERY_PROCEEDED" | "RECOVERY_BLOCKED" | "RECOVERY_FAILED";
export interface TrackerRecoveryResult { kind: TrackerRecoveryKind; text: string }
export interface TrackerRecoveryCommandResult { code: number | null; stdout: string; stderr: string }
export interface TrackerRecoveryDeps {
	pid?: number;
	liveness?: LivenessDeps;
	run?: (args: readonly string[], cwd: string) => TrackerRecoveryCommandResult;
	sessionId?: (session: string, cwd: string) => string | null | undefined;
	now?: () => number;
	leaseId?: () => string;
	/**
	 * ompkit-bj08.5: pause/custody admission snapshot. When present it is
	 * consulted before any lease file is written or any command runs; a
	 * refusal blocks with zero effects. Absent, the legacy checks run.
	 */
	admission?: AdmissionInput;
}

interface RecoveryLease {
	schema_version: 1;
	lease_id: string;
	pid: number;
	process_start: string;
	session: string;
	session_id: string;
	acquired_at: string;
}

interface BusyFlag { runDirectory: string }
type LeaseInspection = { state: "live" | "stale" | "unknown"; reason: string };
type ClaimResult = { acquired: true; stale: boolean } | { acquired: false; reason: string };
type HolderResult = { state: "clear" } | { state: "held"; pid: number } | { state: "unknown"; reason: string };

/** Recover only the known BusyRecovery receipt after proving both lease and database holders are gone. */
export function recoverBusyTracker(repo: string, session: string, deps: TrackerRecoveryDeps = {}): TrackerRecoveryResult | null {
	if (deps.admission !== undefined && admitActuator({ ...deps.admission, packet: { ...deps.admission.packet, action: "tracker-recovery" } }).verdict === "REFUSE") {
		return { kind: "RECOVERY_BLOCKED", text: "Fleet Watch: tracker recovery refused by pause/custody admission; zero effects." };
	}
	if (!repo.trim() || !session.trim()) return { kind: "RECOVERY_BLOCKED", text: "Fleet Watch: tracker recovery skipped because repo or session identity is empty." };
	const root = resolve(repo, ...RECOVERY_ROOT);
	const scan = findBusyFlags(root);
	if (scan.error) return { kind: "RECOVERY_BLOCKED", text: `Fleet Watch: tracker recovery blocked; recovery flags could not be safely inspected: ${scan.error}` };
	if (scan.flags.length === 0) return null;

	const run = deps.run ?? defaultRun;
	const liveness = deps.liveness ?? defaultLiveness();
	const now = deps.now ?? Date.now;
	const ownerPid = deps.pid ?? process.pid;
	const ownerStart = liveness.processStart(ownerPid);
	const ownerSessionId = (deps.sessionId ?? defaultSessionId)(session, repo);
	if (!ownerStart) return blocked("current holder PID start time is unavailable");
	if (ownerSessionId === null) return blocked(`session ${session} is not live`);
	if (ownerSessionId === undefined) return blocked(`session ${session} liveness is unknown`);

	const owner: RecoveryLease = {
		schema_version: 1,
		lease_id: (deps.leaseId ?? randomUUID)(),
		pid: ownerPid,
		process_start: ownerStart,
		session,
		session_id: ownerSessionId,
		acquired_at: new Date(now()).toISOString(),
	};
	const acquired: string[] = [];
	let staleLease = false;
	for (const flag of scan.flags) {
		const path = join(flag.runDirectory, LEASE_FILE);
		const claim = claimLease(path, owner, repo, liveness, deps.sessionId ?? defaultSessionId, deps.leaseId ?? randomUUID);
		if (!claim.acquired) {
			releaseLeases(acquired, owner.lease_id);
			return blocked(claim.reason);
		}
		acquired.push(path);
		staleLease ||= claim.stale;
	}

	const holders = databaseHolders(join(repo, ".beads", "beads.db"), repo, run, liveness);
	if (holders.state !== "clear") {
		releaseLeases(acquired, owner.lease_id);
		return blocked(holders.state === "held" ? `database holder PID ${holders.pid} is live` : `database holder liveness is unknown: ${holders.reason}`);
	}

	let result: TrackerRecoveryResult;
	try {
		const command = run(["br", "doctor", "migrate-schema", "recover"], repo);
		if (command.code !== 0) {
			const detail = (command.stderr || command.stdout).trim().slice(0, 240);
			result = { kind: "RECOVERY_FAILED", text: `Fleet Watch: tracker recovery command exited ${String(command.code)}${detail ? `: ${detail}` : ""}.` };
		} else {
			const holderState = staleLease ? "stale holder lease isolated; zero live database holders" : "zero live holders and zero live database holders";
			result = { kind: "RECOVERY_PROCEEDED", text: `Fleet Watch: ${holderState}; proceeded with br doctor migrate-schema recover for ${scan.flags.length} recovery flag(s).` };
		}
	} catch (error) {
		result = { kind: "RECOVERY_FAILED", text: `Fleet Watch: tracker recovery command failed: ${error instanceof Error ? error.message : String(error)}` };
	}
	const releaseErrors = releaseLeases(acquired, owner.lease_id);
	if (releaseErrors.length) {
		result = { kind: "RECOVERY_FAILED", text: `${result.text} Holder lease cleanup failed for ${releaseErrors.length} flag(s).` };
	}
	return result;

	function blocked(reason: string): TrackerRecoveryResult {
		return { kind: "RECOVERY_BLOCKED", text: `Fleet Watch: tracker recovery blocked; ${reason}.` };
	}
}

function findBusyFlags(root: string): { flags: BusyFlag[]; error?: string } {
	let entries: Dirent[];
	try {
		const rootStat = lstatSync(root);
		if (rootStat.isSymbolicLink() || !rootStat.isDirectory()) return { flags: [], error: "recovery directory is not a real directory" };
		entries = readdirSync(root, { withFileTypes: true });
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return { flags: [] };
		return { flags: [], error: errorMessage(error) };
	}
	const flags: BusyFlag[] = [];
	for (const entry of entries) {
		if (!entry.isDirectory()) continue;
		const runDirectory = join(root, entry.name);
		const marker = join(runDirectory, RECOVERY_MARKER);
		try {
			if (lstatSync(runDirectory).isSymbolicLink()) return { flags: [], error: `recovery run ${entry.name} is a symbolic link` };
			const markerStat = lstatSync(marker);
			if (markerStat.isSymbolicLink() || !markerStat.isFile()) return { flags: [], error: `recovery marker ${entry.name} is not a regular file` };
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
			return { flags: [], error: errorMessage(error) };
		}
		let receipt: unknown;
		try {
			receipt = JSON.parse(readFileSync(marker, "utf8"));
		} catch (error) {
			return { flags: [], error: `invalid recovery marker ${entry.name}: ${errorMessage(error)}` };
		}
		if (receipt && typeof receipt === "object" && !Array.isArray(receipt)
			&& typeof (receipt as Record<string, unknown>).error === "string"
			&& ((receipt as Record<string, string>).error).includes(BUSY_RECOVERY_ERROR)) {
			flags.push({ runDirectory });
		}
	}
	return { flags };
}

function claimLease(path: string, owner: RecoveryLease, repo: string, liveness: LivenessDeps,
	sessionId: (session: string, cwd: string) => string | null | undefined, leaseId: () => string): ClaimResult {
	let clearedStale = false;
	for (let attempt = 0; attempt < 3; attempt++) {
		try {
			writeFileSync(path, `${JSON.stringify(owner)}\n`, { flag: "wx", mode: 0o600 });
			return { acquired: true, stale: clearedStale };
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "EEXIST") return { acquired: false, reason: `holder lease could not be created: ${errorMessage(error)}` };
		}
		const existing = readLease(path);
		if (!existing) {
			try {
				lstatSync(path);
			} catch (error) {
				if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
			}
			return { acquired: false, reason: "existing holder lease is unreadable; refusing recovery" };
		}
		const inspection = inspectLease(existing, repo, liveness, sessionId);
		if (inspection.state === "live") return { acquired: false, reason: `live holder PID ${existing.pid} in session ${existing.session} blocks recovery` };
		if (inspection.state === "unknown") return { acquired: false, reason: `holder lease liveness is unknown: ${inspection.reason}` };
		const stalePath = `${path}.stale-${leaseId()}`;
		try {
			renameSync(path, stalePath);
			clearedStale = true;
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
			return { acquired: false, reason: `stale holder lease could not be isolated: ${errorMessage(error)}` };
		}
	}
	return { acquired: false, reason: "holder lease changed during recovery admission; retry on the next Fleet Watch tick" };
}

function readLease(path: string): RecoveryLease | null {
	try {
		const value: unknown = JSON.parse(readFileSync(path, "utf8"));
		if (!value || typeof value !== "object" || Array.isArray(value)) return null;
		const lease = value as Record<string, unknown>;
		if (lease.schema_version !== 1 || typeof lease.lease_id !== "string" || lease.lease_id.length === 0
			|| !Number.isSafeInteger(lease.pid) || Number(lease.pid) <= 0
			|| typeof lease.process_start !== "string" || lease.process_start.length === 0
			|| typeof lease.session !== "string" || lease.session.length === 0
			|| typeof lease.session_id !== "string" || lease.session_id.length === 0
			|| typeof lease.acquired_at !== "string") return null;
		return lease as unknown as RecoveryLease;
	} catch {
		return null;
	}
}

function inspectLease(lease: RecoveryLease, repo: string, liveness: LivenessDeps,
	sessionId: (session: string, cwd: string) => string | null | undefined): LeaseInspection {
	const processState: OwnerState = probeOwner(lease.pid, lease.process_start, liveness);
	if (processState === "dead" || processState === "reused") return { state: "stale", reason: `holder PID ${lease.pid} is ${processState}` };
	if (processState === "unknown") return { state: "unknown", reason: `holder PID ${lease.pid} identity cannot be checked` };
	const currentSessionId = sessionId(lease.session, repo);
	if (currentSessionId === undefined) return { state: "unknown", reason: `session ${lease.session} liveness cannot be checked` };
	if (currentSessionId === null || currentSessionId !== lease.session_id) return { state: "stale", reason: `holder session ${lease.session} is gone or reused` };
	return { state: "live", reason: `holder PID ${lease.pid} and session ${lease.session} are live` };
}

function databaseHolders(databasePath: string, repo: string,
	run: (args: readonly string[], cwd: string) => TrackerRecoveryCommandResult, liveness: LivenessDeps): HolderResult {
	let result: TrackerRecoveryCommandResult;
	try {
		result = run(["lsof", "-nP", "-t", "--", databasePath], repo);
	} catch (error) {
		return { state: "unknown", reason: errorMessage(error) };
	}
	// lsof exits 1 with no output when no process holds the file: that is the clear case, not an error.
	if (result.code === 1 && result.stdout.trim() === "" && result.stderr.trim() === "") return { state: "clear" };
	if (result.code !== 0 || result.stderr.trim() !== "" || /(?:^|\n)lsof:/m.test(`${result.stdout}\n${result.stderr}`)) {
		return { state: "unknown", reason: (result.stderr || result.stdout).trim().slice(0, 200) || `lsof exited ${String(result.code)}` };
	}
	const output = result.stdout.trim();
	if (output === "") return { state: "clear" };
	const pids = output.split(/\r?\n/).map(line => /^p?(\d+)$/.exec(line.trim()));
	if (pids.some(pid => pid === null)) return { state: "unknown", reason: "lsof returned an unparseable holder list" };
	for (const match of pids) {
		const pid = Number(match![1]);
		if (liveness.signalAlive(pid) || liveness.psVisible(pid)) return { state: "held", pid };
	}
	return { state: "clear" };
}

function releaseLeases(paths: readonly string[], leaseId: string): string[] {
	const errors: string[] = [];
	for (const path of paths) {
		const lease = readLease(path);
		if (!lease || lease.lease_id !== leaseId) continue;
		try {
			unlinkSync(path);
		} catch (error) {
			errors.push(errorMessage(error));
		}
	}
	return errors;
}

/**
 * Live tmux session id, null when the session is gone, undefined when tmux gave no usable answer. Reads
 * `list-sessions` and matches the name exactly: on tmux 3.6a `display-message -t =<name>` prints an empty line
 * with exit 0 both for a live session and for a missing one, which made every session's liveness read as unknown.
 */
export function defaultSessionId(session: string, cwd: string, run: (args: readonly string[], cwd: string) => TrackerRecoveryCommandResult = defaultRun): string | null | undefined {
	const result = run(["tmux", "list-sessions", "-F", "#{session_id} #{session_name}"], cwd);
	if (result.code === 0) {
		for (const line of result.stdout.split("\n")) {
			const space = line.indexOf(" ");
			if (space > 0 && line.slice(space + 1) === session) return line.slice(0, space);
		}
		return null;
	}
	if (/no server running|no sessions|error connecting to/i.test(`${result.stdout}\n${result.stderr}`)) return null;
	return undefined;
}

function defaultRun(args: readonly string[], cwd: string): TrackerRecoveryCommandResult {
	try {
		const result = Bun.spawnSync([...args], { cwd, stdout: "pipe", stderr: "pipe" });
		return { code: result.exitCode, stdout: result.stdout.toString(), stderr: result.stderr.toString() };
	} catch (error) {
		return { code: null, stdout: "", stderr: errorMessage(error) };
	}
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}
