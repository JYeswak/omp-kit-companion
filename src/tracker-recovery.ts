import { randomUUID } from "node:crypto";
import { lstatSync, readdirSync, readFileSync, renameSync, rmSync, unlinkSync, writeFileSync, type Dirent, type Stats } from "node:fs";
import { join, resolve } from "node:path";
import { admitActuator, type AdmissionInput } from "./actuator-admission.ts";
import { defaultLiveness, type LivenessDeps } from "./scratch.ts";
import { ownerIdentity, ownerIdentityFromStart, ownerLiveness } from "./kitlib/owner.ts";
const RECOVERY_ROOT = [".beads", ".br_recovery", "schema-migrations"] as const;
const RECOVERY_MARKER = "recovery-failed.json";
const LEASE_FILE = ".omp-kit-recovery-lease.json";
const BUSY_RECOVERY_ERROR = "database is busy (recovery in progress)";
const RATE_RECEIPT = ".omp-kit-last-recover.json";

/**
 * ompkit-x5iv.2 RECOV2: at most one recover command per repo per window.
 * Twenty minutes of 120 s ticks must not run twenty recovers; an hour of
 * headroom still retries a genuinely stuck latch. br's own files already
 * coexist with our dotfiles in this directory.
 */
export const RECOVER_RATE_WINDOW_MS = 60 * 60_000;
/**
 * One native recovery output family is retained per tracker. A second run
 * would duplicate the database family in quarantine; the later reaper owns
 * removing completed artifacts before another recovery is admitted.
 */
export const RECOVERY_ARTIFACT_BOUND = 1;

export interface TrackerQuarantineReceipt {
	schema_version: 1;
	cycle_count: number;
	wal_index_artifact_count: number;
	artifact_count: number;
	artifact_bound: number;
	growth: number;
	upstream: { issue: "beads_rust#532"; br_version: string; disposition: "UNCONFIRMED; mitigation only" };
}

type QuarantineInventory = { migrationRuns: number; walIndexArtifacts: number; artifactCount: number; error?: string };

function quarantineInventory(repo: string): QuarantineInventory {
	const beads = resolve(repo, ".beads");
	let beadsEntries: Dirent[];
	try {
		const info = lstatSync(beads);
		if (info.isSymbolicLink() || !info.isDirectory()) return { migrationRuns: 0, walIndexArtifacts: 0, artifactCount: 0, error: ".beads is not a real directory" };
		beadsEntries = readdirSync(beads, { withFileTypes: true });
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return { migrationRuns: 0, walIndexArtifacts: 0, artifactCount: 0 };
		return { migrationRuns: 0, walIndexArtifacts: 0, artifactCount: 0, error: errorMessage(error) };
	}
	let walIndexArtifacts = 0;
	for (const entry of beadsEntries) if (entry.name.startsWith(".br-wal-index-")) walIndexArtifacts++;

	const migrationRoot = resolve(repo, ...RECOVERY_ROOT);
	let migrationEntries: Dirent[];
	try {
		const info = lstatSync(migrationRoot);
		if (info.isSymbolicLink() || !info.isDirectory()) return { migrationRuns: 0, walIndexArtifacts, artifactCount: walIndexArtifacts, error: "migration root is not a real directory" };
		migrationEntries = readdirSync(migrationRoot, { withFileTypes: true });
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") migrationEntries = [];
		else return { migrationRuns: 0, walIndexArtifacts, artifactCount: walIndexArtifacts, error: errorMessage(error) };
	}
	let migrationRuns = 0;
	for (const entry of migrationEntries) {
		const runDir = join(migrationRoot, entry.name);
		try {
			const entryInfo = lstatSync(runDir);
			if (entryInfo.isSymbolicLink()) return { migrationRuns, walIndexArtifacts, artifactCount: migrationRuns + walIndexArtifacts, error: `migration run ${entry.name} is a symbolic link` };
			if (!entryInfo.isDirectory()) continue;
			let artifact = false;
			for (const name of ["recovery-before", "recovery-prepared.json", COMPLETE_MARKER]) {
				try {
					const info = lstatSync(join(runDir, name));
					if (info.isSymbolicLink()) return { migrationRuns, walIndexArtifacts, artifactCount: migrationRuns + walIndexArtifacts, error: `migration artifact ${entry.name}/${name} is a symbolic link` };
					const expected = name === "recovery-before" ? info.isDirectory() : info.isFile();
					if (expected) artifact = true;
					else return { migrationRuns, walIndexArtifacts, artifactCount: migrationRuns + walIndexArtifacts, error: `migration artifact ${entry.name}/${name} has an unexpected type` };
				} catch (error) {
					if ((error as NodeJS.ErrnoException).code !== "ENOENT") return { migrationRuns, walIndexArtifacts, artifactCount: migrationRuns + walIndexArtifacts, error: errorMessage(error) };
				}
			}
			if (artifact) migrationRuns++;
		} catch (error) {
			return { migrationRuns, walIndexArtifacts, artifactCount: migrationRuns + walIndexArtifacts, error: errorMessage(error) };
		}
	}
	return { migrationRuns, walIndexArtifacts, artifactCount: migrationRuns + walIndexArtifacts };
}

function quarantineReceipt(inventory: QuarantineInventory, growth: number, run: (args: readonly string[], cwd: string) => TrackerRecoveryCommandResult, repo: string): TrackerQuarantineReceipt {
	let brVersion = "UNKNOWN";
	if (inventory.artifactCount > 0 || growth > 0) {
		try {
			const result = run(["br", "--version"], repo);
			const fields = result.stdout.trim().split(" ").filter(Boolean);
			if (result.code === 0 && fields.length > 0) brVersion = fields[fields.length - 1] ?? "UNKNOWN";
		} catch { /* Version absence does not upgrade the upstream cause claim. */ }
	}
	return {
		schema_version: 1,
		cycle_count: inventory.migrationRuns,
		wal_index_artifact_count: inventory.walIndexArtifacts,
		artifact_count: inventory.artifactCount,
		artifact_bound: RECOVERY_ARTIFACT_BOUND,
		growth: Math.max(0, growth),
		upstream: { issue: "beads_rust#532", br_version: brVersion, disposition: "UNCONFIRMED; mitigation only" },
	};
}


function rateReceiptPath(repo: string): string {
	return join(resolve(repo, ...RECOVERY_ROOT), RATE_RECEIPT);
}

function defaultReadRateReceipt(repo: string): number | null {
	let raw: string;
	try {
		raw = readFileSync(rateReceiptPath(repo), "utf8");
	} catch {
		return null;
	}
	let parsed: unknown;
	try {
		parsed = JSON.parse(raw);
	} catch {
		return null;
	}
	if (!parsed || typeof parsed !== "object" || Array.isArray(parsed) || !("at_ms" in parsed)) return null;
	const atMs: unknown = parsed.at_ms;
	return typeof atMs === "number" && Number.isFinite(atMs) && atMs >= 0 ? atMs : null;
}

function defaultWriteRateReceipt(repo: string, atMs: number, kind: string): void {
	try {
		writeFileSync(rateReceiptPath(repo), `${JSON.stringify({ schema_version: 1, at_ms: atMs, kind })}\n`, { mode: 0o600 });
	} catch {
		// A broken recovery area fails closed downstream via the lease checks.
	}
}

/**
 * ompkit-bj08.5.1: unresolved recovery flags for a repo: run directories
 * holding a matching recovery-failed.json marker, or null when the recovery
 * area is unreadable (UNKNOWN, never permission). Never throws.
 */
export function recoveryFlagDirs(repo: string): string[] | null {
	let scan: { flags: BusyFlag[]; error?: string };
	try {
		scan = findBusyFlags(resolve(repo, ...RECOVERY_ROOT));
	} catch {
		return null;
	}
	if (scan.error) return null;
	return scan.flags.map((flag) => flag.runDirectory);
}
export type TrackerRecoveryKind = "RECOVERY_PROCEEDED" | "RECOVERY_BLOCKED" | "RECOVERY_FAILED" | "RECOVERY_QUARANTINE_GROWTH";
export interface TrackerRecoveryResult { kind: TrackerRecoveryKind; text: string; receipt?: TrackerQuarantineReceipt }
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
	/** ompkit-x5iv.2: rate window override; default RECOVER_RATE_WINDOW_MS. */
	recoverRateWindowMs?: number;
	/** ompkit-x5iv.2: last recover attempt ms, or null when none. */
	readRateReceipt?: (repo: string) => number | null;
	/** ompkit-x5iv.2: record a recover attempt receipt. */
	writeRateReceipt?: (repo: string, atMs: number, kind: string) => void;
	/** Native readback after successful recovery; null or absent preserves the caller's legacy behavior. */
	postRecoverReadback?: ((repo: string, run: (args: readonly string[], cwd: string) => TrackerRecoveryCommandResult) => TrackerPostRecoverReadback) | null;
}
export interface TrackerPostRecoverReadback { ok: boolean; detail: string }

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
	const run = deps.run ?? defaultRun;
	const before = quarantineInventory(repo);
	if (before.error) return { kind: "RECOVERY_BLOCKED", text: `Fleet Watch: tracker recovery blocked; quarantine artifact inventory is unknown: ${before.error}` };
	if (before.walIndexArtifacts > 0) {
		const receipt = quarantineReceipt(before, 0, run, repo);
		return {
			kind: "RECOVERY_QUARANTINE_GROWTH",
			text: `Fleet Watch: WAL_QUARANTINE_GROWTH; ${before.walIndexArtifacts} .br-wal-index-* artifact(s) remain; write readiness is latched and no recovery ran.`,
			receipt,
		};
	}
	if (scan.flags.length === 0) return null;
	const liveness = deps.liveness ?? defaultLiveness();
	const now = deps.now ?? Date.now;
	const ownerPid = deps.pid ?? process.pid;
	const ownerStart = liveness.processStart(ownerPid);
	const ownerSessionId = (deps.sessionId ?? defaultSessionId)(session, repo);
	if (!ownerStart) return blocked("current holder PID start time is unavailable");
	if (ownerSessionId === null) return blocked(`session ${session} is not live`);
	if (ownerSessionId === undefined) return blocked(`session ${session} liveness is unknown`);
	const windowMs = deps.recoverRateWindowMs ?? RECOVER_RATE_WINDOW_MS;
	const lastRecover = (deps.readRateReceipt ?? defaultReadRateReceipt)(repo);
	const attemptAt = now();
	if (lastRecover !== null && attemptAt - lastRecover < windowMs) {
		const waitMin = Math.ceil((windowMs - (attemptAt - lastRecover)) / 60_000);
		return blocked(`recovery attempt rate-limited (last attempt ${Math.max(0, Math.floor((attemptAt - lastRecover) / 1000))}s ago, window ${Math.round(windowMs / 60_000)}m, next eligible in ~${waitMin}m); no recover command ran`);
	}
	if (before.artifactCount >= RECOVERY_ARTIFACT_BOUND) {
		const receipt = quarantineReceipt(before, 0, run, repo);
		return {
			kind: "RECOVERY_QUARANTINE_GROWTH",
			text: `Fleet Watch: WAL_QUARANTINE_GROWTH; recovery refused before intervention because ${before.artifactCount} artifact family/families meet the bound ${RECOVERY_ARTIFACT_BOUND}; no recover command ran.`,
			receipt,
		};
	}
	const beforeArtifactCount = before.artifactCount;

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
		return blocked(holders.state === "held" ? `DATABASE_HOLDER_LATCH: database holder PID ${holders.pid} is live` : `DATABASE_HOLDER_LATCH: database holder liveness is unknown: ${holders.reason}`);
	}

	// A held or unknown database must not consume the next eligible recovery tick.
	(deps.writeRateReceipt ?? defaultWriteRateReceipt)(repo, attemptAt, "attempted");
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
	const after = quarantineInventory(repo);
	if (after.error) {
		result = { kind: "RECOVERY_FAILED", text: `${result.text} Quarantine artifact readback is UNKNOWN: ${after.error}.` };
	} else {
		const growth = after.artifactCount - beforeArtifactCount;
		const receipt = quarantineReceipt(after, growth, run, repo);
		if (after.artifactCount > RECOVERY_ARTIFACT_BOUND) {
			result = {
				kind: "RECOVERY_QUARANTINE_GROWTH",
				text: `Fleet Watch: WAL_QUARANTINE_GROWTH; native recovery produced ${after.artifactCount} artifact families beyond the bound ${RECOVERY_ARTIFACT_BOUND}.`,
				receipt,
			};
		} else {
			result = { ...result, receipt };
		}
	}
	if (result.kind === "RECOVERY_PROCEEDED" && deps.postRecoverReadback != null) {
		let readback: TrackerPostRecoverReadback;
		try {
			readback = deps.postRecoverReadback(repo, run);
		} catch (error) {
			readback = { ok: false, detail: `readback threw: ${errorMessage(error)}` };
		}
		result = {
			...result,
			kind: readback.ok ? "RECOVERY_PROCEEDED" : "RECOVERY_FAILED",
			text: `${result.text} Post-recover native readback ${readback.ok ? "ok" : "failed"} for ${session} at ${repo}: ${readback.detail}`,
		};
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

/** A successful recovery command is insufficient if native tracker reads still fail. */
export function defaultPostRecoverReadback(repo: string, run: (args: readonly string[], cwd: string) => TrackerRecoveryCommandResult): TrackerPostRecoverReadback {
	let result: TrackerRecoveryCommandResult;
	try {
		result = run(["br", "list"], repo);
	} catch (error) {
		return { ok: false, detail: `native br list threw: ${errorMessage(error)}` };
	}
	if (result.code === 0) return { ok: true, detail: "native br list succeeded" };
	const detail = (result.stderr || result.stdout).trim().slice(0, 200);
	return { ok: false, detail: `native br list exited ${String(result.code)}${detail ? `: ${detail}` : ""}` };
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
	const candidates: { runDirectory: string; dirName: string; markerMs: number }[] = [];
	const completes: { dirName: string; ms: number }[] = [];
	for (const entry of entries) {
		if (!entry.isDirectory()) continue;
		const runDirectory = join(root, entry.name);
		const marker = join(runDirectory, RECOVERY_MARKER);
		try {
			if (lstatSync(runDirectory).isSymbolicLink()) return { flags: [], error: `recovery run ${entry.name} is a symbolic link` };
			try {
				const completeStat = lstatSync(join(runDirectory, COMPLETE_MARKER));
				if (!completeStat.isSymbolicLink() && completeStat.isFile()) completes.push({ dirName: entry.name, ms: completeStat.mtimeMs });
			} catch {
				// Absent or unreadable complete is not evidence; markers below still count.
			}
			const markerStat = lstatSync(marker);
			if (markerStat.isSymbolicLink() || !markerStat.isFile()) return { flags: [], error: `recovery marker ${entry.name} is not a regular file` };
			let receipt: unknown;
			try {
				receipt = JSON.parse(readFileSync(marker, "utf8"));
			} catch (error) {
				return { flags: [], error: `invalid recovery marker ${entry.name}: ${errorMessage(error)}` };
			}
			if (receipt && typeof receipt === "object" && !Array.isArray(receipt)
				&& "error" in receipt && typeof receipt.error === "string"
				&& receipt.error.includes(BUSY_RECOVERY_ERROR)) {
				candidates.push({ runDirectory, dirName: entry.name, markerMs: markerStat.mtimeMs });
			}
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
			return { flags: [], error: errorMessage(error) };
		}
	}
	return { flags: currentFlags(candidates, completes) };
}

const COMPLETE_MARKER = "recovery-complete.json";

/**
 * ompkit-x5iv.2 RECOV2: br never deletes BusyRecovery failed markers, so a
 * marker counts only while it is evidence of a live latch: no run dir sorted
 * after its own holds a recovery-complete.json, and the marker is newer than
 * the newest complete anywhere. A PROCEEDED attempt writes no marker state
 * itself; br's own complete record is what retires old markers.
 */
function currentFlags(
	candidates: { runDirectory: string; dirName: string; markerMs: number }[],
	completes: { dirName: string; ms: number }[],
): BusyFlag[] {
	const newestCompleteMs = completes.length > 0 ? Math.max(...completes.map((complete) => complete.ms)) : null;
	return candidates
		.filter((candidate) =>
			!completes.some((complete) => complete.dirName > candidate.dirName) &&
			(newestCompleteMs === null || candidate.markerMs > newestCompleteMs))
		.map((candidate) => ({ runDirectory: candidate.runDirectory }));
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
	const identity = ownerIdentityFromStart(lease.pid, lease.process_start);
	if (identity === null) return { state: "unknown", reason: `holder PID ${lease.pid} identity cannot be checked` };
	const processState = ownerLiveness(identity, { probe: liveness.probe }).state;
	if (processState === "dead" || processState === "reused" || processState === "zombie")
		return { state: "stale", reason: `holder PID ${lease.pid} is ${processState}` };
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
		const identity = ownerIdentityFromStart(pid, liveness.processStart(pid));
		if (identity === null) return { state: "unknown", reason: `database holder PID ${pid} identity cannot be checked` };
		const state = ownerLiveness(identity, { probe: liveness.probe }).state;
		if (state === "live") return { state: "held", pid };
		if (state === "unknown") return { state: "unknown", reason: `database holder PID ${pid} identity cannot be checked` };
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

/**
 * ompkit-rhy9.15 RET1: bounded retention for dead tracker quarantine.
 * Recovery freshness (rhy9.14) stops new quarantine growth but never
 * disposes of historical retained artifacts. This retention operation is
 * the canonical disposal path for the two quarantine families the native
 * BusyRecovery/migrate-schema flow leaves behind:
 * `.beads/.br-wal-index-*` dirs (prepared.json + quarantine-complete.json)
 * and `.beads/.br_recovery/schema-migrations/<run>` dirs.
 *
 * Upstream gap (named, not worked around): `br doctor` exposes no safe
 * disposal API for WAL-index quarantine families (checked: capabilities
 * are health/ls/undo/migrate-schema/explain only), so native-owned
 * artifacts cannot be disposed through a native canonical operation.
 * Disposal here is therefore owned by this operation under the
 * OWNERSHIP_FINAL_LIVENESS_DECISION protection control, with a per-path
 * receipt; it is never ad-hoc shell deletion elsewhere.
 *
 * Protection control: a path is unlinked only when an issued plan decision
 * names it REAP (positively owned, completed, dead, beyond the retention
 * bound) AND a final liveness recheck at apply time still clears it. Plan
 * decisions are single-use nonces; apply without an issued decision fails
 * the OWNERSHIP_DECISION_REQUIRED control with zero effects. Nothing is
 * ever killed: holder probes are read-only lsof observations. Live
 * database files, sidecars, certs, foreign, symlinked, held, unresolved
 * and ownership-unknown targets stay byte-identical and are reported
 * protected with a named reason.
 */
export const TRACKER_QUARANTINE_RETENTION_MS = 7 * 24 * 60 * 60_000;
const WAL_INDEX_PREFIX = ".br-wal-index-";
const WAL_INDEX_PREPARED = "prepared.json";
const WAL_INDEX_COMPLETE = "quarantine-complete.json";
const MIGRATION_PREPARED_NAMES = ["recovery-prepared.json", "prepared.json"] as const;
const MIGRATION_APPLIED = "applied.json";
const MIGRATION_COMMIT_READY = "commit-ready.json";
const LIVE_SIDECAR_PATTERN = /^beads\.db(-wal|-shm|-journal)?$/;
const CERT_PATTERN = /\.(pem|cert|crt|key)$/i;
const RETENTION_PLAN_TTL_MS = 10 * 60_000;

export type TrackerRetentionFamily = "wal-index" | "migration-run";
export type TrackerRetentionVerdict = "REAP" | "PROTECTED";
export type TrackerRetentionReason =
	| "OWNED_DEAD_COMPLETED_BEYOND_BOUND"
	| "RECENT"
	| "UNRESOLVED"
	| "HELD"
	| "FOREIGN"
	| "SYMLINK"
	| "OWNERSHIP_UNKNOWN"
	| "LIVE_DB_SIDECAR"
	| "CERT"
	| "UNEXPECTED_TYPE"
	| "FINAL_LIVENESS_RECHECK"
	| "MARKER_WITHDRAWN"
	| "TYPE_CHANGED"
	| "REAP_FAILED";
export interface TrackerRetentionCandidate {
	path: string;
	family: TrackerRetentionFamily;
	bytes: number;
	ageMs: number;
	verdict: TrackerRetentionVerdict;
	reason: TrackerRetentionReason;
}
export interface TrackerRetentionPlan {
	schema_version: 1;
	repo: string;
	retentionBoundMs: number;
	nonce: string;
	plannedAt: number;
	candidates: TrackerRetentionCandidate[];
}
export type TrackerRetentionHolder =
	| { state: "clear" }
	| { state: "held"; pid: number }
	| { state: "unknown"; reason: string };
export interface TrackerRetentionDeps {
	now?: () => number;
	run?: (args: readonly string[], cwd: string) => TrackerRecoveryCommandResult;
	holderOf?: (path: string) => TrackerRetentionHolder;
	liveness?: LivenessDeps;
}
export interface TrackerRetentionAppliedPath {
	path: string;
	action: "REAPED" | "PROTECTED";
	reason: TrackerRetentionReason;
	bytes: number;
}
export interface TrackerRetentionReceipt {
	schema_version: 1;
	repo: string;
	retentionBoundMs: number;
	paths: TrackerRetentionAppliedPath[];
	reapedCount: number;
	reapedBytes: number;
	retainedCount: number;
	retainedBytes: number;
	protectionControl: "OWNERSHIP_FINAL_LIVENESS_DECISION";
}
export interface TrackerRetentionOutcome {
	kind: "TRACKER_QUARANTINE_RETENTION";
	text: string;
	receipt: TrackerRetentionReceipt;
}
export type TrackerRetentionApplyResult =
	| { applied: true; outcome: TrackerRetentionOutcome }
	| { applied: false; control: "OWNERSHIP_DECISION_REQUIRED" | "PLAN_EXPIRED" | "REPO_MISMATCH"; text: string };

/** Issued single-use plan decisions. Apply consumes the nonce; expiry and a cap bound replay. */
const issuedRetentionPlans = new Map<string, { repo: string; expiresAt: number }>();

function registerRetentionPlan(plan: TrackerRetentionPlan): void {
	for (const [nonce, entry] of issuedRetentionPlans) if (entry.expiresAt <= plan.plannedAt) issuedRetentionPlans.delete(nonce);
	while (issuedRetentionPlans.size >= 512) {
		const oldest = issuedRetentionPlans.keys().next();
		if (oldest.done) break;
		issuedRetentionPlans.delete(oldest.value);
	}
	issuedRetentionPlans.set(plan.nonce, { repo: plan.repo, expiresAt: plan.plannedAt + RETENTION_PLAN_TTL_MS });
}

type TreeStats = { bytes: number; newestMtimeMs: number; symlink: string | null; liveSidecar: string | null; cert: string | null; special: string | null; error?: string };

function quarantineTreeStats(dir: string): TreeStats {
	const stats: TreeStats = { bytes: 0, newestMtimeMs: 0, symlink: null, liveSidecar: null, cert: null, special: null };
	try {
		stats.newestMtimeMs = lstatSync(dir).mtimeMs;
	} catch (error) {
		return { ...stats, error: errorMessage(error) };
	}
	const stack = [dir];
	while (stack.length > 0) {
		const current = stack.pop()!;
		let entries: Dirent[];
		try {
			entries = readdirSync(current, { withFileTypes: true });
		} catch (error) {
			return { ...stats, error: errorMessage(error) };
		}
		for (const entry of entries) {
			const full = join(current, entry.name);
			let info: Stats | undefined;
			try {
				info = lstatSync(full);
			} catch (error) {
				return { ...stats, error: errorMessage(error) };
			}
			if (info.mtimeMs > stats.newestMtimeMs) stats.newestMtimeMs = info.mtimeMs;
			if (info.isSymbolicLink()) {
				stats.symlink = full;
				return stats;
			}
			if (info.isDirectory()) {
				stack.push(full);
				continue;
			}
			if (!info.isFile()) {
				stats.special = full;
				return stats;
			}
			stats.bytes += info.size;
			if (LIVE_SIDECAR_PATTERN.test(entry.name)) {
				stats.liveSidecar = full;
				return stats;
			}
			if (CERT_PATTERN.test(entry.name)) {
				stats.cert = full;
				return stats;
			}
		}
	}
	return stats;
}

function readMarkerJson(dir: string, name: string): unknown | null {
	try {
		const info = lstatSync(join(dir, name));
		if (info.isSymbolicLink() || !info.isFile()) return null;
		return JSON.parse(readFileSync(join(dir, name), "utf8"));
	} catch {
		return null;
	}
}

function databasePathInsideRepo(repoAbs: string, databasePath: unknown): "inside" | "foreign" | "unknown" {
	if (typeof databasePath !== "string" || databasePath.trim() === "") return "unknown";
	const absolute = resolve(databasePath);
	if (absolute === repoAbs || absolute.startsWith(`${repoAbs}/`)) return "inside";
	return "foreign";
}

function defaultRetentionHolderOf(path: string, repo: string, run: (args: readonly string[], cwd: string) => TrackerRecoveryCommandResult): TrackerRetentionHolder {
	let result: TrackerRecoveryCommandResult;
	try {
		result = run(["lsof", "-nP", "-t", "--", path], repo);
	} catch (error) {
		return { state: "unknown", reason: errorMessage(error) };
	}
	if (result.code === 1 && result.stdout.trim() === "" && result.stderr.trim() === "") return { state: "clear" };
	if (result.code !== 0 || result.stderr.trim() !== "" || /(?:^|\n)lsof:/m.test(`${result.stdout}\n${result.stderr}`)) {
		return { state: "unknown", reason: (result.stderr || result.stdout).trim().slice(0, 200) || `lsof exited ${String(result.code)}` };
	}
	const output = result.stdout.trim();
	if (output === "") return { state: "clear" };
	// Any open handle holder blocks disposal; presence in lsof means a live
	// holder (dead processes hold no descriptors). Never killed, only observed.
	for (const line of output.split(/\r?\n/)) {
		const match = /^p?(\d+)$/.exec(line.trim());
		if (!match) return { state: "unknown", reason: "lsof returned an unparseable holder list" };
		const pid = Number(match[1]);
		const identity = ownerIdentity(pid);
		if (identity === null) return { state: "unknown", reason: `database holder PID ${pid} identity cannot be checked` };
		const state = ownerLiveness(identity).state;
		if (state === "live") return { state: "held", pid };
		if (state === "unknown") return { state: "unknown", reason: `database holder PID ${pid} identity cannot be checked` };
	}
	return { state: "clear" };
}

type ClassifyContext = { repoAbs: string; now: number; holderOf: (path: string) => TrackerRetentionHolder; liveness: LivenessDeps };

function classifyWalIndexCandidate(dir: string, ctx: ClassifyContext): TrackerRetentionCandidate {
	const base: Omit<TrackerRetentionCandidate, "verdict" | "reason"> = { path: dir, family: "wal-index", bytes: 0, ageMs: 0 };
	const tree = quarantineTreeStats(dir);
	if (tree.error) return { ...base, verdict: "PROTECTED", reason: "OWNERSHIP_UNKNOWN" };
	if (tree.symlink) return { ...base, bytes: tree.bytes, verdict: "PROTECTED", reason: "SYMLINK" };
	if (tree.special) return { ...base, bytes: tree.bytes, verdict: "PROTECTED", reason: "UNEXPECTED_TYPE" };
	if (tree.liveSidecar) return { ...base, bytes: tree.bytes, verdict: "PROTECTED", reason: "LIVE_DB_SIDECAR" };
	if (tree.cert) return { ...base, bytes: tree.bytes, verdict: "PROTECTED", reason: "CERT" };
	const complete = readMarkerJson(dir, WAL_INDEX_COMPLETE);
	if (complete === null || typeof complete !== "object" || (complete as Record<string, unknown>).stage !== "complete") {
		return { ...base, bytes: tree.bytes, ageMs: Math.max(0, ctx.now - tree.newestMtimeMs), verdict: "PROTECTED", reason: "UNRESOLVED" };
	}
	const prepared = readMarkerJson(dir, WAL_INDEX_PREPARED);
	const ownership = prepared !== null && typeof prepared === "object"
		? databasePathInsideRepo(ctx.repoAbs, (prepared as Record<string, unknown>).database_path)
		: "unknown";
	if (ownership === "foreign") return { ...base, bytes: tree.bytes, ageMs: Math.max(0, ctx.now - tree.newestMtimeMs), verdict: "PROTECTED", reason: "FOREIGN" };
	if (ownership === "unknown") return { ...base, bytes: tree.bytes, ageMs: Math.max(0, ctx.now - tree.newestMtimeMs), verdict: "PROTECTED", reason: "OWNERSHIP_UNKNOWN" };
	const ageMs = Math.max(0, ctx.now - tree.newestMtimeMs);
	if (ageMs < TRACKER_QUARANTINE_RETENTION_MS) return { ...base, bytes: tree.bytes, ageMs, verdict: "PROTECTED", reason: "RECENT" };
	const holder = ctx.holderOf(dir);
	if (holder.state !== "clear") return { ...base, bytes: tree.bytes, ageMs, verdict: "PROTECTED", reason: "HELD" };
	return { ...base, bytes: tree.bytes, ageMs, verdict: "REAP", reason: "OWNED_DEAD_COMPLETED_BEYOND_BOUND" };
}

function classifyMigrationRunCandidate(dir: string, ctx: ClassifyContext): TrackerRetentionCandidate {
	const base: Omit<TrackerRetentionCandidate, "verdict" | "reason"> = { path: dir, family: "migration-run", bytes: 0, ageMs: 0 };
	const tree = quarantineTreeStats(dir);
	if (tree.error) return { ...base, verdict: "PROTECTED", reason: "OWNERSHIP_UNKNOWN" };
	if (tree.symlink) return { ...base, bytes: tree.bytes, verdict: "PROTECTED", reason: "SYMLINK" };
	if (tree.special) return { ...base, bytes: tree.bytes, verdict: "PROTECTED", reason: "UNEXPECTED_TYPE" };
	if (tree.liveSidecar) return { ...base, bytes: tree.bytes, verdict: "PROTECTED", reason: "LIVE_DB_SIDECAR" };
	if (tree.cert) return { ...base, bytes: tree.bytes, verdict: "PROTECTED", reason: "CERT" };
	const ageMs = Math.max(0, ctx.now - tree.newestMtimeMs);
	const failed = readMarkerJson(dir, RECOVERY_MARKER);
	const complete = readMarkerJson(dir, COMPLETE_MARKER);
	const appliedPair = readMarkerJson(dir, MIGRATION_APPLIED) !== null && readMarkerJson(dir, MIGRATION_COMMIT_READY) !== null;
	const completed = complete !== null || appliedPair;
	if (failed !== null && complete === null) return { ...base, bytes: tree.bytes, ageMs, verdict: "PROTECTED", reason: "UNRESOLVED" };
	if (!completed) return { ...base, bytes: tree.bytes, ageMs, verdict: "PROTECTED", reason: "OWNERSHIP_UNKNOWN" };
	let ownership: "inside" | "foreign" | "unknown" = "unknown";
	for (const name of MIGRATION_PREPARED_NAMES) {
		const prepared = readMarkerJson(dir, name);
		if (prepared !== null && typeof prepared === "object") {
			ownership = databasePathInsideRepo(ctx.repoAbs, (prepared as Record<string, unknown>).database_path);
			break;
		}
	}
	if (ownership === "foreign") return { ...base, bytes: tree.bytes, ageMs, verdict: "PROTECTED", reason: "FOREIGN" };
	if (ownership === "unknown") return { ...base, bytes: tree.bytes, ageMs, verdict: "PROTECTED", reason: "OWNERSHIP_UNKNOWN" };
	const lease = readMarkerJson(dir, LEASE_FILE);
	if (lease !== null && typeof lease === "object") {
		const record = lease as Record<string, unknown>;
		const identity = typeof record.pid === "number" && typeof record.process_start === "string"
			? ownerIdentityFromStart(record.pid, record.process_start) : null;
		if (identity === null) return { ...base, bytes: tree.bytes, ageMs, verdict: "PROTECTED", reason: "OWNERSHIP_UNKNOWN" };
		const state = ownerLiveness(identity, { probe: ctx.liveness.probe }).state;
		if (state === "live" || state === "unknown") {
			return { ...base, bytes: tree.bytes, ageMs, verdict: "PROTECTED", reason: "HELD" };
		}
	}
	if (ageMs < TRACKER_QUARANTINE_RETENTION_MS) return { ...base, bytes: tree.bytes, ageMs, verdict: "PROTECTED", reason: "RECENT" };
	const holder = ctx.holderOf(dir);
	if (holder.state !== "clear") return { ...base, bytes: tree.bytes, ageMs, verdict: "PROTECTED", reason: "HELD" };
	return { ...base, bytes: tree.bytes, ageMs, verdict: "REAP", reason: "OWNED_DEAD_COMPLETED_BEYOND_BOUND" };
}

/**
 * Plan disposal for a repo's tracker quarantine. Returns null when no
 * quarantine candidates exist or the quarantine roots cannot be safely
 * enumerated (fail closed: no plan, no apply). Every candidate carries its
 * retained bytes/count/age, the explicit retention bound, and a verdict
 * with a named reason. Planning never mutates.
 */
export function planTrackerQuarantineRetention(repo: string, deps: TrackerRetentionDeps = {}): TrackerRetentionPlan | null {
	if (!repo.trim()) return null;
	const now = (deps.now ?? Date.now)();
	const repoAbs = resolve(repo);
	const run = deps.run ?? defaultRun;
	const holderOf = deps.holderOf ?? ((path: string) => defaultRetentionHolderOf(path, repo, run));
	const liveness = deps.liveness ?? defaultLiveness();
	const ctx: ClassifyContext = { repoAbs, now, holderOf, liveness };
	let beadsEntries: Dirent[];
	try {
		const info = lstatSync(resolve(repo, ".beads"));
		if (info.isSymbolicLink() || !info.isDirectory()) return null;
		beadsEntries = readdirSync(resolve(repo, ".beads"), { withFileTypes: true });
	} catch {
		return null;
	}
	const candidates: TrackerRetentionCandidate[] = [];
	for (const entry of beadsEntries) {
		if (!entry.name.startsWith(WAL_INDEX_PREFIX)) continue;
		const full = join(resolve(repo, ".beads"), entry.name);
		let info: Stats | undefined;
		try {
			info = lstatSync(full);
		} catch {
			continue;
		}
		if (info.isSymbolicLink()) {
			candidates.push({ path: full, family: "wal-index", bytes: 0, ageMs: 0, verdict: "PROTECTED", reason: "SYMLINK" });
			continue;
		}
		if (!info.isDirectory()) {
			candidates.push({ path: full, family: "wal-index", bytes: info.isFile() ? info.size : 0, ageMs: 0, verdict: "PROTECTED", reason: "UNEXPECTED_TYPE" });
			continue;
		}
		candidates.push(classifyWalIndexCandidate(full, ctx));
	}
	let migrationEntries: Dirent[] | null = null;
	try {
		const info = lstatSync(resolve(repo, ...RECOVERY_ROOT));
		if (!info.isSymbolicLink() && info.isDirectory()) migrationEntries = readdirSync(resolve(repo, ...RECOVERY_ROOT), { withFileTypes: true });
		else if (info.isSymbolicLink()) return null;
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "ENOENT") return null;
	}
	if (migrationEntries !== null) {
		for (const entry of migrationEntries) {
			const full = join(resolve(repo, ...RECOVERY_ROOT), entry.name);
			let info: Stats | undefined;
			try {
				info = lstatSync(full);
			} catch {
				continue;
			}
			if (info.isSymbolicLink()) {
				candidates.push({ path: full, family: "migration-run", bytes: 0, ageMs: 0, verdict: "PROTECTED", reason: "SYMLINK" });
				continue;
			}
			if (!info.isDirectory()) continue;
			candidates.push(classifyMigrationRunCandidate(full, ctx));
		}
	}
	if (candidates.length === 0) return null;
	const plan: TrackerRetentionPlan = { schema_version: 1, repo: repoAbs, retentionBoundMs: TRACKER_QUARANTINE_RETENTION_MS, nonce: randomUUID(), plannedAt: now, candidates };
	registerRetentionPlan(plan);
	return plan;
}

/**
 * Apply an issued retention plan. The plan decision is single-use: unknown,
 * foreign, expired or already-consumed decisions fail the
 * OWNERSHIP_DECISION_REQUIRED control with zero effects, which is what makes
 * bypassing the ownership/final-liveness decision fail. Every REAP path is
 * re-verified (type, completion marker, holder) immediately before unlink;
 * a holder appearing between plan and apply lands the path in
 * FINAL_LIVENESS_RECHECK, byte-identical.
 */
export function applyTrackerQuarantineRetention(plan: TrackerRetentionPlan | null | undefined, repo: string, deps: TrackerRetentionDeps = {}): TrackerRetentionApplyResult {
	const now = (deps.now ?? Date.now)();
	if (!plan || typeof plan !== "object" || plan.schema_version !== 1 || typeof plan.nonce !== "string" || !Array.isArray(plan.candidates)) {
		return { applied: false, control: "OWNERSHIP_DECISION_REQUIRED", text: "Tracker quarantine retention refused; no issued ownership/final-liveness decision was presented (OWNERSHIP_DECISION_REQUIRED); zero effects." };
	}
	const issued = issuedRetentionPlans.get(plan.nonce);
	if (!issued) {
		return { applied: false, control: "OWNERSHIP_DECISION_REQUIRED", text: "Tracker quarantine retention refused; the plan decision is unknown or already consumed (OWNERSHIP_DECISION_REQUIRED); zero effects." };
	}
	if (issued.repo !== resolve(repo) || plan.repo !== issued.repo) {
		return { applied: false, control: "REPO_MISMATCH", text: `Tracker quarantine retention refused; the plan decision names ${plan.repo}, not ${resolve(repo)} (REPO_MISMATCH); zero effects.` };
	}
	if (now > issued.expiresAt) {
		issuedRetentionPlans.delete(plan.nonce);
		return { applied: false, control: "PLAN_EXPIRED", text: "Tracker quarantine retention refused; the plan decision expired before apply (PLAN_EXPIRED); zero effects." };
	}
	if (plan.retentionBoundMs !== TRACKER_QUARANTINE_RETENTION_MS) {
		return { applied: false, control: "OWNERSHIP_DECISION_REQUIRED", text: "Tracker quarantine retention refused; the plan carries a foreign retention bound (OWNERSHIP_DECISION_REQUIRED); zero effects." };
	}
	issuedRetentionPlans.delete(plan.nonce);
	const run = deps.run ?? defaultRun;
	const holderOf = deps.holderOf ?? ((path: string) => defaultRetentionHolderOf(path, repo, run));
	const liveness = deps.liveness ?? defaultLiveness();
	const ctx: ClassifyContext = { repoAbs: resolve(repo), now, holderOf, liveness };
	const paths: TrackerRetentionAppliedPath[] = [];
	for (const candidate of plan.candidates) {
		if (candidate.verdict !== "REAP") {
			paths.push({ path: candidate.path, action: "PROTECTED", reason: candidate.reason, bytes: candidate.bytes });
			continue;
		}
		const holder = holderOf(candidate.path);
		if (holder.state !== "clear") {
			paths.push({ path: candidate.path, action: "PROTECTED", reason: "FINAL_LIVENESS_RECHECK", bytes: candidate.bytes });
			continue;
		}
		let fresh: TrackerRetentionCandidate;
		try {
			const info = lstatSync(candidate.path);
			if (info.isSymbolicLink() || !info.isDirectory()) {
				paths.push({ path: candidate.path, action: "PROTECTED", reason: "TYPE_CHANGED", bytes: candidate.bytes });
				continue;
			}
			fresh = candidate.family === "wal-index"
				? classifyWalIndexCandidate(candidate.path, ctx)
				: classifyMigrationRunCandidate(candidate.path, ctx);
		} catch {
			paths.push({ path: candidate.path, action: "PROTECTED", reason: "TYPE_CHANGED", bytes: candidate.bytes });
			continue;
		}
		if (fresh.verdict !== "REAP") {
			const reason = fresh.reason === "HELD" ? "FINAL_LIVENESS_RECHECK" satisfies TrackerRetentionReason : fresh.reason;
			paths.push({ path: candidate.path, action: "PROTECTED", reason, bytes: candidate.bytes });
			continue;
		}
		const marker = candidate.family === "wal-index" ? WAL_INDEX_COMPLETE : COMPLETE_MARKER;
		const stillComplete = candidate.family === "wal-index"
			? readMarkerJson(candidate.path, marker) !== null
			: readMarkerJson(candidate.path, marker) !== null || (readMarkerJson(candidate.path, MIGRATION_APPLIED) !== null && readMarkerJson(candidate.path, MIGRATION_COMMIT_READY) !== null);
		if (!stillComplete) {
			paths.push({ path: candidate.path, action: "PROTECTED", reason: "MARKER_WITHDRAWN", bytes: candidate.bytes });
			continue;
		}
		try {
			rmSync(candidate.path, { recursive: true });
			paths.push({ path: candidate.path, action: "REAPED", reason: "OWNED_DEAD_COMPLETED_BEYOND_BOUND", bytes: candidate.bytes });
		} catch {
			paths.push({ path: candidate.path, action: "PROTECTED", reason: "REAP_FAILED", bytes: candidate.bytes });
		}
	}
	const reaped = paths.filter(entry => entry.action === "REAPED");
	const retained = paths.filter(entry => entry.action === "PROTECTED");
	const receipt: TrackerRetentionReceipt = {
		schema_version: 1,
		repo: resolve(repo),
		retentionBoundMs: TRACKER_QUARANTINE_RETENTION_MS,
		paths,
		reapedCount: reaped.length,
		reapedBytes: reaped.reduce((sum, entry) => sum + entry.bytes, 0),
		retainedCount: retained.length,
		retainedBytes: retained.reduce((sum, entry) => sum + entry.bytes, 0),
		protectionControl: "OWNERSHIP_FINAL_LIVENESS_DECISION",
	};
	const detail = paths.map(entry => `${entry.path}: ${entry.action} ${entry.reason}`).join("; ");
	const outcome: TrackerRetentionOutcome = {
		kind: "TRACKER_QUARANTINE_RETENTION",
		text: `Fleet Watch: tracker quarantine retention reaped ${receipt.reapedCount} artifact(s) (${receipt.reapedBytes} bytes) beyond the ${TRACKER_QUARANTINE_RETENTION_MS} ms bound; retained ${receipt.retainedCount} (${receipt.retainedBytes} bytes) under OWNERSHIP_FINAL_LIVENESS_DECISION. ${detail}`,
		receipt,
	};
	return { applied: true, outcome };
}

/**
 * The canonical tracker-health retention operation: plan and apply in one
 * tick. Returns null (silent, zero effects) when no candidates exist or
 * nothing crossed the retention bound — the quiet twin. Otherwise the
 * outcome carries the per-path reason/receipt for reaped and retained
 * artifacts alike.
 */
export function retainTrackerQuarantine(repo: string, deps: TrackerRetentionDeps = {}): TrackerRetentionOutcome | null {
	const plan = planTrackerQuarantineRetention(repo, deps);
	if (!plan || !plan.candidates.some(candidate => candidate.verdict === "REAP")) return null;
	const result = applyTrackerQuarantineRetention(plan, repo, deps);
	if (!result.applied) return null;
	return result.outcome;
}

/**
 * ompkit-rhy9.16 CUTOVER: the exact successor kit that ships the registry
 * tracker-health job. The duplicated per-session (project) recovery branch
 * retires only after this kit is released AND installed AND its registry
 * tracker-health job is enabled for the tracker. Anything less blocks
 * retirement with the local incumbent intact, so there is never a gap with
 * neither recovery path responsible.
 */
export const TRACKER_RECOVERY_CUTOVER_KIT_VERSION = "0.2.63";

export interface TrackerRecoveryCutoverInput {
	/** Installed successor kit version; null when the install is missing. */
	installedKitVersion: string | null;
	/** Registry tracker-health job enabled for this tracker. */
	healthJobEnabled: boolean;
	/** Tracker present in the registry. */
	trackerRegistered: boolean;
}

export type TrackerRecoveryCutoverVerdict = { retired: true } | { retired: false; reason: string };

function cutoverBlocked(reason: string): TrackerRecoveryCutoverVerdict {
	return { retired: false, reason };
}

function versionAtLeast(have: string, want: string): boolean | null {
	const parse = (version: string): number[] | null => {
		const parts = version.trim().split(".");
		if (parts.length === 0) return null;
		const numbers: number[] = [];
		for (const part of parts) {
			if (!/^\d+$/.test(part)) return null;
			numbers.push(Number(part));
		}
		return numbers;
	};
	const haveParts = parse(have);
	const wantParts = parse(want);
	if (!haveParts || !wantParts) return null;
	const length = Math.max(haveParts.length, wantParts.length);
	for (let index = 0; index < length; index++) {
		const havePart = haveParts[index] ?? 0;
		const wantPart = wantParts[index] ?? 0;
		if (havePart > wantPart) return true;
		if (havePart < wantPart) return false;
	}
	return true;
}

/**
 * Retirement gate for the duplicated project recovery branch. Every missing
 * or stale successor precondition blocks with a named reason; only a fully
 * present successor retires. An unparseable installed version blocks rather
 * than comparing true: staleness must be proven, never assumed away.
 */
export function checkTrackerRecoveryCutover(input: TrackerRecoveryCutoverInput): TrackerRecoveryCutoverVerdict {
	if (input.installedKitVersion === null || input.installedKitVersion.trim() === "") {
		return cutoverBlocked("successor kit install is missing; local recovery stays responsible");
	}
	const fresh = versionAtLeast(input.installedKitVersion, TRACKER_RECOVERY_CUTOVER_KIT_VERSION);
	if (fresh === null) {
		return cutoverBlocked(`successor kit version ${JSON.stringify(input.installedKitVersion)} is unparseable; local recovery stays responsible`);
	}
	if (!fresh) {
		return cutoverBlocked(`successor kit install is stale (${input.installedKitVersion.trim()} < ${TRACKER_RECOVERY_CUTOVER_KIT_VERSION}); local recovery stays responsible`);
	}
	if (!input.healthJobEnabled) {
		return cutoverBlocked("registry tracker-health job is disabled; local recovery stays responsible");
	}
	if (!input.trackerRegistered) {
		return cutoverBlocked("tracker is absent from the registry; local recovery stays responsible");
	}
	return { retired: true };
}
