// doctor --scope ownership (ompkit-774u.12 OWNERREG1): for every entry of the ownership registry, count the
// persisted records, the ones with no live owner, and the ones with no tracked terminal outcome. Read-only:
// every observation goes through OwnershipIo, which only lists, reads and stats state or observes typed owner liveness.
// A process owner is an incarnation (pid, process_start); zombie/reused/dead is not live, and unknown is never dead.
// Records with no process start require a verified seat or remain unproven, never a bare-pid liveness decision.
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import type { Finding } from "./diagnostics.ts";
import { OWNERSHIP_REGISTRY, type CensusId, type OwnershipEntry } from "./ownership-registry.ts";
import type { ProbeState } from "./kitlib/proc.ts";
import { ownerIdentityFromStart, ownerLiveness } from "./kitlib/owner.ts";
import {
	defaultLiveness, defaultRunner, listProcesses, parseOwnerFile, quarantineDir, quarantineTimeOf, quarantineTtlMs,
	resolveScratchRootEntries, selectHarnessOrphans, stateRoot, type OrphanProcess,
} from "./scratch.ts";

export interface OwnershipIo {
	home: string;
	nowMs(): number;
	/** Entry names; null when the path is absent or a plain file (ENOENT, ENOTDIR). Any other read error (EACCES) throws, so the census is UNKNOWN, never an observed zero. */
	listDir(path: string): string[] | null;
	readText(path: string): string | null;
	mtimeMs(path: string): number | null;
	/** Liveness of a recorded `{pid, start}` incarnation through kitlib proc: dead, reused and zombie are not alive; unknown is unproven. */
	incarnationState(pid: number, start: string): ProbeState;
	/** True when the omp session of a seat is leased by a live process, false when not, null when it cannot be told. */
	seatLive(agent: string, session: string): boolean | null;
	/** Scratch roots of repositories (override, ~/Developer, fleet repos); not temp bases. */
	scratchRoots(): string[];
	harnessOrphans(): OrphanProcess[] | null;
	quarantineTtlMs(): number | null;
}

export interface OwnershipCensus {
	records: number;
	no_live_owner: number;
	untracked: number;
	/** Owners or seat leases that could not be probed; these are counted as live, never as untracked. */
	unproven: number;
	/** Age in seconds of the oldest untracked record. */
	oldest_age_s: number | null;
	examples: string[];
}
type CensusOutcome = { census: OwnershipCensus } | { unknown: string };

const EXAMPLE_LIMIT = 3;

class Tally {
	records = 0;
	noLive = 0;
	untracked = 0;
	unproven = 0;
	oldestMs: number | null = null;
	examples: string[] = [];
	constructor(private readonly io: OwnershipIo) {}
	/** A record whose owner is gone and whose producer recorded no outcome. */
	untrackedRecord(label: string, sinceMs: number | null): void {
		this.noLive++;
		this.untracked++;
		if (this.examples.length < EXAMPLE_LIMIT) this.examples.push(label);
		if (sinceMs !== null && (this.oldestMs === null || sinceMs < this.oldestMs)) this.oldestMs = sinceMs;
	}
	result(): OwnershipCensus {
		return { records: this.records, no_live_owner: this.noLive, untracked: this.untracked, unproven: this.unproven,
			oldest_age_s: this.oldestMs === null ? null : Math.max(0, Math.floor((this.io.nowMs() - this.oldestMs) / 1000)), examples: this.examples };
	}
}

function jsonRecord(text: string | null): Record<string, unknown> | null {
	if (text === null) return null;
	try {
		const value: unknown = JSON.parse(text);
		return typeof value === "object" && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : null;
	} catch {
		return null;
	}
}
function pidOf(value: unknown): number | null {
	return typeof value === "number" && Number.isSafeInteger(value) && value > 0 ? value : null;
}
function plainPid(text: string | null): number | null {
	if (text === null) return null;
	const pid = Number(text.trim().split(/\s/, 1)[0]);
	return Number.isSafeInteger(pid) && pid > 0 ? pid : null;
}
function isoMs(value: unknown): number | null {
	if (typeof value !== "string") return null;
	const parsed = Date.parse(value);
	return Number.isNaN(parsed) ? null : parsed;
}

function scratchDirs(io: OwnershipIo): CensusOutcome {
	const roots = io.scratchRoots();
	if (roots.length === 0) return { unknown: "no scratch roots could be resolved" };
	const tally = new Tally(io);
	for (const root of roots) {
		for (const name of io.listDir(root) ?? []) {
			const dir = join(root, name);
			const inside = io.listDir(dir);
			if (inside === null) continue;
			tally.records++;
			const text = io.readText(join(dir, ".owner"));
			const owner = text === null ? null : parseOwnerFile(text);
			if (owner !== null) {
				if (owner.processStart === null) {
					if (owner.agent === null || owner.session === null) { tally.unproven++; continue; }
				} else {
					const state = io.incarnationState(owner.pid, owner.processStart);
					if (state === "live") continue;
					if (state === "unknown") { tally.unproven++; continue; }
				}
				if (owner.agent !== null && owner.session !== null) {
					const seat = io.seatLive(owner.agent, owner.session);
					if (seat === true) continue;
					if (seat === null) { tally.unproven++; continue; }
				}
			}
			if (inside.includes(".omp-kit-release")) { tally.noLive++; continue; }
			tally.untrackedRecord(dir, (owner === null ? null : isoMs(owner.createdAt)) ?? io.mtimeMs(dir));
		}
	}
	return { census: tally.result() };
}
/** Records with process-incarnation evidence; bare PIDs remain unproven rather than live or dead. */
function pidRecords(io: OwnershipIo, dirs: { dir: string; suffix: string; read: (path: string) => { pid: number | null; processStart: string | null; sinceMs: number | null } }[]): CensusOutcome {
	const tally = new Tally(io);
	for (const spec of dirs) {
		for (const name of io.listDir(spec.dir) ?? []) {
			if (!name.endsWith(spec.suffix)) continue;
			const path = join(spec.dir, name);
			const { pid, processStart, sinceMs } = spec.read(path);
			tally.records++;
			if (pid !== null) {
				if (processStart === null) { tally.unproven++; continue; }
				const state = io.incarnationState(pid, processStart);
				if (state === "live") continue;
				if (state === "unknown") { tally.unproven++; continue; }
			}
			tally.untrackedRecord(path, sinceMs ?? io.mtimeMs(path));
		}
	}
	return { census: tally.result() };
}

function serviceClaims(io: OwnershipIo): CensusOutcome {
	return pidRecords(io, [{ dir: join(stateRoot(io.home), "omp-kit", "jobs"), suffix: ".lock", read: (lock) => {
		const record = jsonRecord(io.readText(join(lock, "pid")));
		const started = record === null ? null : record.startedAt;
		return { pid: record === null ? null : pidOf(record.pid),
			processStart: record !== null && typeof record.process_start === "string" ? record.process_start : null,
			sinceMs: typeof started === "number" ? started : null };
	} }]);
}

function heavyQueue(io: OwnershipIo): CensusOutcome {
	const root = join(stateRoot(io.home), "omp-kit", "load");
	const tally = new Tally(io);
	const check = (path: string, since: (record: Record<string, unknown>) => number | null): void => {
		const record = jsonRecord(io.readText(path));
		if (record === null) return;
		tally.records++;
		const pid = pidOf(record.pid);
		if (pid !== null) {
			if (typeof record.process_start !== "string") { tally.unproven++; return; }
			const state = io.incarnationState(pid, record.process_start);
			if (state === "live") return;
			if (state === "unknown") { tally.unproven++; return; }
		}
		tally.untrackedRecord(path, since(record) ?? io.mtimeMs(path));
	};
	check(join(root, "mutex", "owner.json"), () => null);
	for (const name of io.listDir(join(root, "jobs")) ?? []) if (name.endsWith(".json")) check(join(root, "jobs", name), (record) => isoMs(record.queued_at));
	return { census: tally.result() };
}

function sendLocks(io: OwnershipIo): CensusOutcome {
	return pidRecords(io, [{ dir: join(stateRoot(io.home), "omp-kit", "send-locks"), suffix: ".lock", read: (lock) => {
		const text = io.readText(lock);
		const record = jsonRecord(text);
		return { pid: record === null ? plainPid(text) : pidOf(record.pid),
			processStart: record !== null && typeof record.process_start === "string" ? record.process_start : null, sinceMs: null };
	} }]);
}

function convergeLocks(io: OwnershipIo): CensusOutcome {
	const roots = io.scratchRoots();
	if (roots.length === 0) return { unknown: "no scratch roots, so no fleet repositories to look in" };
	const tally = new Tally(io);
	for (const repo of new Set(roots.map((root) => dirname(dirname(root))))) {
		const lock = join(repo, ".git", "git_converge.lock");
		const text = io.readText(lock);
		if (text === null) continue;
		tally.records++;
		const record = jsonRecord(text);
		const pid = record === null ? plainPid(text) : pidOf(record.pid);
		const processStart = record === null ? null : typeof record.process_start === "string" ? record.process_start
			: typeof record.start_time === "string" ? record.start_time : null;
		if (pid === null) { tally.untrackedRecord(lock, io.mtimeMs(lock)); continue; }
		if (processStart === null) { tally.unproven++; continue; }
		const state = io.incarnationState(pid, processStart);
		if (state === "live") continue;
		if (state === "unknown") { tally.unproven++; continue; }
		tally.untrackedRecord(lock, io.mtimeMs(lock));
	}
	return { census: tally.result() };
}

function rchLeases(io: OwnershipIo): CensusOutcome {
	const dir = join(io.home, ".local", "state", "rch", "job-leases");
	const names = io.listDir(dir);
	if (names === null) return { census: new Tally(io).result() };
	const tally = new Tally(io);
	const consumed = (id: string) => names.some((name) => name.startsWith(`${id}.recover-consumed`));
	const leaseOf = (id: string) => jsonRecord(io.readText(join(dir, `${id}.json`)));
	for (const name of names) {
		const path = join(dir, name);
		if (name.endsWith(".recovery.lock")) {
			const id = name.slice(0, -".recovery.lock".length);
			const lease = leaseOf(id);
			tally.records++;
			if (lease === null) {
				if (consumed(id)) tally.noLive++;
				else tally.untrackedRecord(path, io.mtimeMs(path));
			}
			continue;
		}
		if (!name.endsWith(".json") || !name.startsWith("rchw-")) continue;
		const lease = jsonRecord(io.readText(path));
		if (lease === null) continue;
		tally.records++;
		const wrapper = pidOf(lease.wrapper_pid);
		if (wrapper !== null) {
			const start = typeof lease.wrapper_process_start === "string" ? lease.wrapper_process_start : null;
			if (start === null) { tally.unproven++; continue; }
			const state = io.incarnationState(wrapper, start);
			if (state === "live") continue;
			if (state === "unknown") { tally.unproven++; continue; }
		}
		const id = name.slice(0, -".json".length);
		if (lease.terminal_acknowledged === true || consumed(id)) { tally.noLive++; continue; }
		const heartbeat = typeof lease.heartbeat_unix_ms === "number" ? lease.heartbeat_unix_ms : null;
		tally.untrackedRecord(path, heartbeat ?? io.mtimeMs(path));
	}
	return { census: tally.result() };
}

function ntmWatcherLocks(io: OwnershipIo): CensusOutcome {
	return pidRecords(io, [{ dir: join(io.home, ".local", "state", "ntm"), suffix: ".lock", read: (lock) => ({
		pid: plainPid(io.readText(lock)), processStart: null, sinceMs: null,
	}) }]);
}

function scratchQuarantine(io: OwnershipIo): CensusOutcome {
	const ttl = io.quarantineTtlMs();
	if (ttl === null) return { unknown: "the scratch-reaper config is invalid, so the quarantine TTL is not known" };
	const names = io.listDir(quarantineDir(io.home)) ?? [];
	const tally = new Tally(io);
	for (const name of names) {
		tally.records++;
		const at = quarantineTimeOf(name);
		// Tracked outcome: a young entry is waiting for the reaper's TTL; past it, or of unknown age, nothing is coming for it.
		if (at !== null && io.nowMs() - at <= ttl) { tally.noLive++; continue; }
		tally.untrackedRecord(name, at);
	}
	return { census: tally.result() };
}

function harnessOrphans(io: OwnershipIo): CensusOutcome {
	const found = io.harnessOrphans();
	if (found === null) return { unknown: "the process table could not be read" };
	const tally = new Tally(io);
	for (const proc of found) {
		tally.records++;
		tally.untrackedRecord(`pid ${proc.pid} ${proc.command.slice(0, 60)}`, io.nowMs() - proc.ageSeconds * 1000);
	}
	return { census: tally.result() };
}


const CENSUSES: Record<CensusId, (io: OwnershipIo) => CensusOutcome> = {
	"scratch-dirs": scratchDirs, "scratch-quarantine": scratchQuarantine, "harness-orphans": harnessOrphans,
	"service-claims": serviceClaims, "heavy-queue": heavyQueue, "send-locks": sendLocks, "converge-locks": convergeLocks,
	"rch-leases": rchLeases, "ntm-watcher-locks": ntmWatcherLocks,
};

export interface OwnershipRow {
	id: string;
	rows: readonly number[];
	class: OwnershipEntry["class"];
	owner_key: string;
	survives_respawn: boolean;
	terminal: OwnershipEntry["terminal"];
	status: "OBSERVED" | "UNKNOWN";
	reason: string | null;
	census: OwnershipCensus | null;
	owner_bead: string | null;
}

/** Run every census once. The registry is the only list of entries; a census that cannot run is UNKNOWN, never zero. */
export function censusOwnership(io: OwnershipIo, entries: readonly OwnershipEntry[] = OWNERSHIP_REGISTRY): OwnershipRow[] {
	return entries.map((entry): OwnershipRow => {
		const base = { id: entry.id, rows: entry.rows, class: entry.class, owner_key: entry.ownerKey, survives_respawn: entry.survivesRespawn,
			terminal: entry.terminal, owner_bead: entry.ownerBead };
		if (entry.census === null) return { ...base, status: "UNKNOWN", reason: entry.noCensus ?? "no census", census: null };
		let outcome: CensusOutcome;
		try {
			outcome = CENSUSES[entry.census](io);
		} catch (error) {
			outcome = { unknown: `census failed: ${error instanceof Error ? error.message : String(error)}` };
		}
		return "unknown" in outcome ? { ...base, status: "UNKNOWN", reason: outcome.unknown, census: null } : { ...base, status: "OBSERVED", reason: null, census: outcome.census };
	});
}

/** The doctor findings: one summary row first, then one row per entry. */
export function inspectOwnership(io: OwnershipIo, entries: readonly OwnershipEntry[] = OWNERSHIP_REGISTRY): Finding[] {
	const rows = censusOwnership(io, entries);
	const observed = rows.filter((row) => row.census !== null);
	const untrackedTotal = observed.reduce((sum, row) => sum + row.census!.untracked, 0);
	const noOwnerBead = observed.filter((row) => row.census!.untracked > 0 && row.owner_bead === null).map((row) => row.id);
	const unknown = rows.filter((row) => row.status === "UNKNOWN");
	// A census that is supposed to run but could not leaves the picture unproven: never OK.
	const failed = unknown.filter((row) => entries.find((entry) => entry.id === row.id)?.census !== null).map((row) => row.id);
	const summary: Finding = {
		component: "OWNERSHIP",
		status: untrackedTotal > 0 ? "DEGRADED" : failed.length > 0 ? "UNVERIFIED" : "OK",
		reason: `${rows.length} integration points: ${observed.length} observed, ${unknown.length} not countable from here; ${untrackedTotal} persisted record(s) have no live owner and no tracked outcome`
			+ (failed.length ? `; census could not run for: ${failed.join(", ")}` : "")
			+ (noOwnerBead.length ? `; no owning bead for: ${noOwnerBead.join(", ")}` : ""),
		recommended_action: untrackedTotal > 0 ? "Repair each class through its owning bead; classes with no owning bead need one filed under ompkit-774u.12."
			: failed.length > 0 ? "Fix what stopped the census and run the doctor again." : "No action required.",
		evidence: { entries: rows.length, observed: observed.length, not_countable: unknown.length, census_failed: failed, untracked_total: untrackedTotal,
			no_live_owner_total: observed.reduce((sum, row) => sum + row.census!.no_live_owner, 0), classes_without_owner_bead: noOwnerBead },
	};
	const perEntry = rows.map((row): Finding => {
		if (row.census === null) return { component: `OWNERSHIP:${row.id}`, status: "UNVERIFIED", reason: `not countable: ${row.reason}`,
			recommended_action: "No action from this doctor; the registry names the cancel, crash and respawn paths.", evidence: { ...row } };
		const { census } = row;
		const orphan = census.untracked > 0;
		return { component: `OWNERSHIP:${row.id}`, status: orphan ? "DEGRADED" : "OK",
			reason: `${census.records} record(s), ${census.no_live_owner} with no live owner, ${census.untracked} of them untracked`
				+ (census.oldest_age_s === null ? "" : `, oldest ${census.oldest_age_s} s`) + (census.unproven > 0 ? `, ${census.unproven} owner(s) or seat lease(s) unprobed` : ""),
			recommended_action: orphan ? (row.owner_bead === null ? "File an owning bead under ompkit-774u.12 for this class." : `Owner bead ${row.owner_bead}.`) : "No action required.",
			evidence: { ...row } };
	});
	return [summary, ...perEntry];
}

export function liveOwnershipIo(env: NodeJS.ProcessEnv = process.env): OwnershipIo {
	const liveness = defaultLiveness();
	const home = env.HOME ?? homedir();
	return {
		home,
		nowMs: () => Date.now(),
		listDir: (path) => {
			try {
				return readdirSync(path);
			} catch (error) {
				const code = (error as NodeJS.ErrnoException).code;
				if (code === "ENOENT" || code === "ENOTDIR") return null;
				throw error;
			}
		},
		readText: (path) => { try { return readFileSync(path, "utf8"); } catch { return null; } },
		mtimeMs: (path) => { try { return statSync(path).mtimeMs; } catch { return null; } },
		incarnationState: (pid, start) => {
			const identity = ownerIdentityFromStart(pid, start);
			return identity === null ? "unknown" : ownerLiveness(identity, { probe: liveness.probe }).state;
		},
		seatLive: (agent, session) => liveness.seatLive?.(agent, session) ?? null,
		scratchRoots: () => resolveScratchRootEntries(home)
			.filter((entry) => entry.sources.some((source) => source === "override" || source === "developer" || source.startsWith("fleet-watch:") || source.startsWith("herdr:") || source === "chief"))
			.map((entry) => entry.root).filter((root) => existsSync(root)),
		harnessOrphans: () => {
			const processes = listProcesses(defaultRunner);
			return processes.length === 0 ? null : selectHarnessOrphans(processes);
		},
		quarantineTtlMs: () => { try { return quarantineTtlMs(); } catch { return null; } },
	};
}
