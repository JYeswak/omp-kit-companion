import { createHash } from "node:crypto";
import { existsSync, lstatSync, opendirSync, rmSync, type BigIntStats } from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { appendJsonl } from "./kitlib/jsonl.ts";
import { runSync } from "./kitlib/run.ts";
import { snapshotClear, takeLsofSnapshot, type ScratchRunner } from "./scratch.ts";
import { redactFullTestCause } from "./full-test-runner.ts";

const DAY = 86_400_000;
const JOURNAL_ADMISSION_BYTES = 8 << 20;
export type CacheRetentionKind = "cache" | "log" | "receipt" | "browser-cache";
/** Conservative shipped expiry decisions; paths and liveness are discovered, never copied from a census. */
export const CACHE_RETENTION_AGE_MS: Readonly<Record<CacheRetentionKind, number>> = {
	cache: 30 * DAY, log: 30 * DAY, receipt: 90 * DAY, "browser-cache": 30 * DAY,
};
export interface CacheRetentionTarget {
	id: string;
	root: string;
	/** Selected namespace boundary: operator home or the explicitly selected kit state root. */
	anchorRoot: string;
	kind: CacheRetentionKind;
	maxAgeMs: number;
	/** Any open descendant of this owner keeps the whole target, including between cache accesses. */
	guardRoot: string | null;
	selection: "all" | "logs" | "operational-receipts";
}
export interface CacheRetentionDirectory {
	id: string; max_age_ms: number; status: "COMPLETE" | "ABSENT" | "HELD" | "UNSAFE" | "FAILED";
	removed: number; kept: number; held: number;
}
export interface CacheRetentionReport {
	overall: "OK" | "FINDINGS" | "UNVERIFIED";
	removed: number; kept: number; held: number; bytesRemoved: number;
	directories: CacheRetentionDirectory[]; errors: string[];
}
export interface CacheRetentionOptions {
	nowMs?: number;
	/** Bind the job's existing XDG/private-state selection rather than cleaning an unrelated default. */
	stateRoot?: string;
	/** A caller may share an already collected system-wide observation. Null never grants deletion. */
	openFiles?: Set<string> | null;
}

const BROWSER_CACHE_NAMES = ["Cache", "Code Cache", "GPUCache", "DawnCache", "GraphiteDawnCache", "ShaderCache", "GrShaderCache"] as const;
const PROTECTED_NAMES: Readonly<Record<string, true>> = {
	"Cookies": true, "Login Data": true, "Web Data": true, "Local State": true,
	"Preferences": true, "Secure Preferences": true, ".owner": true, ".users": true,
	"browser-profiles": true, "chrome-jfp": true,
};

function info(path: string): BigIntStats | null {
	try { return lstatSync(path, { bigint: true }); }
	catch (error) {
		if (error !== null && typeof error === "object" && "code" in error && error.code === "ENOENT") return null;
		throw error;
	}
}
function childDirectories(path: string): string[] {
	const stat = info(path);
	if (stat === null || !stat.isDirectory() || stat.isSymbolicLink()) return [];
	const names: string[] = [];
	const directory = opendirSync(path);
	try {
		for (let entry = directory.readSync(); entry !== null; entry = directory.readSync()) {
			if (entry.isDirectory() || entry.isSymbolicLink()) names.push(entry.name);
		}
	} finally { directory.closeSync(); }
	return names.sort();
}

function browserOwners(base: string): string[] {
	const owners = [base];
	for (const name of childDirectories(base)) {
		const path = join(base, name), stat = info(path);
		if (stat === null || stat.isSymbolicLink() || !stat.isDirectory()) continue;
		if (info(join(path, "Default"))?.isDirectory() || info(join(path, "Local State"))?.isFile()) owners.push(path);
	}
	return owners;
}

/** Canonical kit-managed browser namespaces, shared by retention and isolated-test snapshots. */
export function managedBrowserProfileRoots(home: string, stateRoot?: string): string[] {
	const omp = join(home, ".omp"), kit = stateRoot ?? join(home, ".local", "state", "omp-kit");
	const bases = [join(kit, "chrome-jfp"), join(kit, "browser-profiles"), join(omp, "browser-profiles"),
		join(omp, "agent", "cache", "browser-profiles")];
	for (const profile of childDirectories(join(omp, "profiles"))) {
		const owner = join(omp, "profiles", profile);
		if (info(owner)?.isSymbolicLink() === true) continue;
		bases.push(join(owner, "agent", "cache", "browser-profiles"));
		const daemons = join(owner, "run", "daemons");
		for (const daemon of childDirectories(daemons)) {
			if (info(join(daemons, daemon))?.isSymbolicLink() !== true)
				bases.push(join(daemons, daemon, "omp.browser.headless.profile"));
		}
	}
	return bases;
}

/** Only explicitly regenerable namespaces are registered. Session journals and operator configuration are not caches. */
export function cacheRetentionTargets(home: string, stateRoot?: string): CacheRetentionTarget[] {
	if (!isAbsolute(home) || resolve(home) !== home || home.includes("\0")) throw new Error("CACHE_RETAIN_HOME_INVALID");
	const omp = join(home, ".omp"), kit = stateRoot ?? join(home, ".local", "state", "omp-kit");
	if (!isAbsolute(kit) || resolve(kit) !== kit || kit.includes("\0")) throw new Error("CACHE_RETAIN_STATE_ROOT_INVALID");
	const targets: CacheRetentionTarget[] = [];
	const browserBases = managedBrowserProfileRoots(home, kit);
	const add = (id: string, root: string, kind: CacheRetentionKind, guardRoot: string | null = null,
		selection: CacheRetentionTarget["selection"] = "all") => {
		const anchorRoot = root === kit || root.startsWith(`${kit}/`) ? kit : home;
		targets.push({ id, root, anchorRoot, kind, guardRoot, selection, maxAgeMs: CACHE_RETENTION_AGE_MS[kind] });
	};
	add("omp-cache", join(omp, "cache"), "cache");
	add("omp-web-cache", join(omp, "webcache"), "cache");
	add("omp-agent-cache", join(omp, "agent", "cache"), "cache", join(omp, "agent"));
	add("omp-logs", join(omp, "logs"), "log");
	for (const profile of childDirectories(join(omp, "profiles"))) {
		const owner = join(omp, "profiles", profile);
		add(`omp-profile-cache:${profile}`, join(owner, "agent", "cache"), "cache", owner);
		add(`omp-profile-logs:${profile}`, join(owner, "logs"), "log");
	}
	add("kit-receipts", join(kit, "receipts"), "receipt");
	add("kit-operational-receipts", kit, "receipt", null, "operational-receipts");
	add("kit-job-logs", join(kit, "jobs"), "log", null, "logs");
	for (const name of ["composer", "tracker-snapshot", "reopen-rate", "diagnostics"]) {
		add(`kit-cache:${name}`, join(kit, name), "cache");
	}
	// These are cache leaves, not permission to expire a Chrome user-data directory or its login data.
	for (const base of browserBases) for (const owner of browserOwners(base)) {
		const profiles = childDirectories(owner).filter(name => name === "Default" || name.startsWith("Profile "));
		if (!profiles.includes("Default")) profiles.push("Default");
		for (const profile of profiles) for (const cache of BROWSER_CACHE_NAMES) {
			add(`browser-cache:${relative(home, owner)}:${profile}:${cache}`, join(owner, profile, cache), "browser-cache", owner);
		}
		for (const cache of ["GraphiteDawnCache", "ShaderCache", "component_crx_cache", "extensions_crx_cache"]) {
			add(`browser-cache:${relative(home, owner)}:${cache}`, join(owner, cache), "browser-cache", owner);
		}
	}
	return targets;
}

function safeRoot(anchor: string, root: string): BigIntStats | null {
	const parts = relative(anchor, root).split(sep);
	if (parts[0] === ".." || isAbsolute(relative(anchor, root))) throw new Error("CACHE_RETAIN_OUTSIDE_HOME");
	let path = anchor;
	const anchorInfo = info(anchor);
	if (anchorInfo === null) return null;
	if (anchorInfo.isSymbolicLink() || !anchorInfo.isDirectory()) throw new Error("CACHE_RETAIN_UNSAFE_DIRECTORY");
	let current = anchorInfo;
	for (const part of parts) {
		if (part === "") continue;
		path = join(path, part);
		const next = info(path);
		if (next === null) return null;
		if (next.isSymbolicLink() || !next.isDirectory()) throw new Error("CACHE_RETAIN_UNSAFE_DIRECTORY");
		current = next;
	}
	return current;
}
function selected(target: CacheRetentionTarget, name: string): boolean {
	if (target.selection === "logs") return name.endsWith(".log") || name.includes(".log.") || name.endsWith(".out") || name.endsWith(".err");
	if (target.selection === "operational-receipts") return name.endsWith(".json") &&
		(name.startsWith("claude-save-") || name.startsWith("kit-activation-") || name.startsWith("kit-reconcile-"));
	return true;
}
function protectedEntry(target: CacheRetentionTarget, path: string, name: string): boolean {
	if (PROTECTED_NAMES[name] === true || name.endsWith(".lock") || name.endsWith("-wal") || name.endsWith("-shm")) return true;
	if (existsSync(`${path}-wal`) || existsSync(`${path}-shm`)) return true;
	return target.kind === "receipt" && name.endsWith(".json") &&
		existsSync(join(target.anchorRoot, "backups", name.slice(0, -5)));
}

/** A cache bundle is retired whole, never left as a partially deleted reusable environment. */
function expiredBytes(path: string, cutoff: bigint): bigint | null {
	let bytes = 0n;
	const pending = [path];
	while (pending.length > 0) {
		const current = pending.pop()!;
		const stat = info(current);
		if (stat === null || stat.isSymbolicLink() || stat.mtimeNs > cutoff || PROTECTED_NAMES[basename(current)] === true) return null;
		if (stat.isFile()) {
			if (stat.nlink !== 1n) return null;
			bytes += stat.size;
		} else if (stat.isDirectory()) {
			const directory = opendirSync(current);
			try {
				for (let entry = directory.readSync(); entry !== null; entry = directory.readSync()) pending.push(join(current, entry.name));
			} finally { directory.closeSync(); }
		} else return null;
	}
	return bytes;
}
function sdkSnapshot(): Set<string> | null {
	const runner: ScratchRunner = (args, options) => {
		const result = runSync(args, { deadline_s: (options?.timeoutMs ?? 15000) / 1000, max_output_bytes: 16 << 20 });
		return { code: result.timed_out || result.truncated ? null : result.rc,
			stdout: new TextDecoder().decode(result.stdout), stderr: new TextDecoder().decode(result.stderr) };
	};
	return takeLsofSnapshot(runner, 15000);
}
function heldEntries(snapshot: Set<string>, root: string): Set<string> {
	const names = new Set<string>(), prefix = `${root}/`;
	for (const path of snapshot) if (path.startsWith(prefix)) {
		const tail = path.slice(prefix.length), slash = tail.indexOf("/");
		names.add(slash < 0 ? tail : tail.slice(0, slash));
	}
	return names;
}
function safeText(text: string, home: string): string {
	return redactFullTestCause({ cause_code: "", cause_name: "", cause_message: text, cause_stack_head: null }, [home]).cause_message;
}

/** Enforce registered expiry only; no browser/process is stopped and no production job is enabled here. */
export async function retainFleetCaches(home: string, recordPath: string, options: CacheRetentionOptions = {}): Promise<CacheRetentionReport> {
	const now = options.nowMs ?? Date.now();
	if (!Number.isSafeInteger(now) || now < 0 || !isAbsolute(recordPath) || resolve(recordPath) !== recordPath) throw new Error("CACHE_RETAIN_ARGUMENT_INVALID");
	const targets = cacheRetentionTargets(home, options.stateRoot);
	// Persistent coordination, not a temp directory: fixtures and alternate state roots stay isolated.
	const journalState = join(dirname(recordPath), "cache-retain.locks");
	const journalOptions = { deadline_s: 5, durable: true, mode: 0o600, state_dir: journalState };
	const report: CacheRetentionReport = { overall: "OK", removed: 0, kept: 0, held: 0, bytesRemoved: 0, directories: [], errors: [] };
	const snapshot = options.openFiles === undefined ? sdkSnapshot() : options.openFiles;
	if (snapshot === null) {
		report.overall = "UNVERIFIED";
		report.errors.push("CACHE_RETAIN_LIVENESS_UNAVAILABLE");
		return report;
	}
	for (const target of targets) {
		const row: CacheRetentionDirectory = { id: safeText(target.id, home), max_age_ms: target.maxAgeMs, status: "COMPLETE", removed: 0, kept: 0, held: 0 };
		report.directories.push(row);
		try {
			const rootInfo = safeRoot(target.anchorRoot, target.root);
			if (rootInfo === null) { row.status = "ABSENT"; continue; }
			if (snapshot.has(target.root) || (target.guardRoot !== null && snapshotClear(snapshot, target.guardRoot) !== true)) {
				row.status = "HELD"; row.held++; report.held++; continue;
			}
			const held = target.guardRoot === null ? heldEntries(snapshot, target.root) : null;
			const cutoff = BigInt(now - target.maxAgeMs) * 1_000_000n;
			const directory = opendirSync(target.root);
			try {
				for (let entry = directory.readSync(); entry !== null; entry = directory.readSync()) {
					const path = join(target.root, entry.name);
					if (path === recordPath || recordPath.startsWith(`${path}/`) || path === journalState ||
						journalState.startsWith(`${path}/`) || !selected(target, entry.name)) continue;
					const before = info(path);
					if (before === null) continue;
					if (held?.has(entry.name) || protectedEntry(target, path, entry.name)) { row.held++; report.held++; continue; }
					const bytes = expiredBytes(path, cutoff);
					if (bytes === null) { row.kept++; report.kept++; continue; }
					const total = BigInt(report.bytesRemoved) + bytes;
					if (total > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error("CACHE_RETAIN_BYTES_UNREPRESENTABLE");
					const event = { at: new Date(now).toISOString(), target: safeText(target.id, home), entry: safeText(entry.name, home),
						path_sha256: createHash("sha256").update(path).digest("hex"), bytes: Number(bytes) };
					await appendJsonl(recordPath, state => {
						if (state.size >= JOURNAL_ADMISSION_BYTES) throw new Error("CACHE_RETAIN_JOURNAL_FULL");
						return { ...event, event: "planned" };
					}, journalOptions);
					const currentRoot = safeRoot(target.anchorRoot, target.root), current = info(path);
					if (currentRoot === null || currentRoot.dev !== rootInfo.dev || currentRoot.ino !== rootInfo.ino ||
						current === null || current.dev !== before.dev || current.ino !== before.ino || current.mtimeNs !== before.mtimeNs || current.size !== before.size) {
						row.held++; report.held++; continue;
					}
					// The durable journal can wait on another writer; a directory inode alone misses refreshed descendants.
					if (expiredBytes(path, cutoff) !== bytes) { row.held++; report.held++; continue; }
					rmSync(path, { recursive: before.isDirectory() });
					row.removed++; report.removed++; report.bytesRemoved = Number(total);
					await appendJsonl(recordPath, () => ({ ...event, event: "removed" }), journalOptions);
				}
			} finally { directory.closeSync(); }
		} catch (error) {
			const reason = error instanceof Error ? error.message : "CACHE_RETAIN_IO_FAILED";
			row.status = reason.includes("UNSAFE") || reason.includes("OUTSIDE_HOME") ? "UNSAFE" : "FAILED";
			report.overall = "FINDINGS";
			report.errors.push(`${safeText(target.id, home)}: ${safeText(reason, home)}`);
		}
	}
	return report;
}
