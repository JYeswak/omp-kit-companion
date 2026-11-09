import { createHash } from "node:crypto";
import { existsSync, lstatSync, readFileSync, readdirSync, readlinkSync, realpathSync, unwatchFile, watchFile, type Stats } from "node:fs";
import { basename, dirname, isAbsolute, join, relative } from "node:path";
import { installedJobOwnedState, type OwnedStatePath } from "./service.ts";
import { managedBrowserProfileRoots } from "./cache-retain.ts";

/** Profile files the kit could write; agent.db, sessions and caches change under normal agent use and are not watched. */
const PROFILE_FILES = ["config.yml", "config.yaml", "config.json", "settings.json"] as const;
const MAX_ENTRIES_PER_ROOT = 20_000;
const MAX_BYTES_PER_ROOT = 512 * 1024 * 1024;
/**
 * The kit state root holds tens of thousands of small service records plus gigabyte release tarballs on a
 * real machine; lstat is cheap but content-hashing is not. Roots carrying the watched state root (see
 * WatchedPaths.stateRoot) allow far more entries, hash only small files, and record larger files by stable
 * metadata. The hash/metadata line is per-file size, never a cumulative position, so before/after snapshots
 * classify every path identically. Every other watched root keeps the strict budgets above.
 */
const MAX_STATE_ENTRIES_PER_ROOT = 500_000;
const MAX_STATE_FILE_HASH_BYTES = 1_048_576;
const MAX_CONCURRENT_WRITER_CANDIDATES = 50;
const CONCURRENT_WRITER_PROBE_MS = 1_000; // Timeout never counts as writer evidence; unobserved changes remain failures.
const EMPTY_CONCURRENT_WRITER_PATHS: ReadonlySet<string> = new Set();
const MAX_LIVE_WRITER_CANDIDATES = 5_000;
const SANDBOX_EXEC = "/usr/bin/sandbox-exec";

/**
 * Volatile browser cache directory names: regenerable HTTP/GPU/code caches a browser rewrites on its own
 * clock (tonight: a long-running Chrome's Cache/Cache_Data under the state root). The kit never writes these
 * names under a watched root — its own caches live in the isolated run's private XDG dirs and release bytecode
 * caches are pre-sealed read-only — so skipping the subtree cannot mask a kit write. Matching is exact and
 * case-sensitive (Chromium's on-disk spellings); profile data beside the caches stays watched.
 */
const VOLATILE_CACHE_DIR_NAMES: Record<string, true> = {
 Cache: true, Cache_Data: true, "Code Cache": true, GPUCache: true, DawnCache: true,
};

/**
 * Live-fleet namespaces of the kit state root: every seat's guard/wake extensions append the wake ledgers,
 * scratch accounting churns on its own clock, and the installed kit-update job records its own runs. None
 * are kit install writes, and the post-run concurrent-writer probe cannot catch writes minutes apart, so the
 * snapshot does not judge them. Matched by exact top-level name or literal prefix (never a broad pattern);
 * the two named subdirectories skip wholesale. Everything else under the state root stays watched.
 */
const LIVE_FLEET_TOP_FILES: Record<string, true> = { "gate-events.jsonl": true, "mail-wake.jsonl": true, "scratch-budgets.json": true };
const LIVE_FLEET_TOP_PREFIXES: readonly string[] = ["kit-update-job-", "git-lock-rate."];
const LIVE_FLEET_SUBDIRS: Record<string, true> = { "inbox-wake": true, "scratch-users": true };

/**
 * The live-fleet anchor for a path under the state root, or null when the path stays watched. Top-level
 * live files anchor at themselves; anything under a live subdirectory anchors at that subdirectory.
 */
function liveFleetAnchor(stateRoot: string, path: string): string | null {
	const rel = relative(stateRoot, path);
	if (rel === "" || rel.startsWith("..") || isAbsolute(rel)) return null;
	const slash = rel.indexOf("/");
	if (slash === -1) {
		if (LIVE_FLEET_TOP_FILES[rel] === true) return path;
		if (LIVE_FLEET_TOP_PREFIXES.some(prefix => rel.startsWith(prefix))) return path;
		return null;
	}
	const top = rel.slice(0, slash);
	return LIVE_FLEET_SUBDIRS[top] === true ? join(stateRoot, top) : null;
}

/** True when `path` is, or lies under, state an installed service job writes on its own clock. */
export function isOwnedState(owned: readonly OwnedStatePath[], path: string): boolean {
	return owned.some(entry => {
		const rel = relative(entry.path, path);
		if (rel.startsWith("..") || isAbsolute(rel)) return false;
		if (!entry.names) return true;
		return rel !== "" && entry.names(rel.split("/")[0]!);
	});
}

export type WatchedPaths = string[] & { owned?: readonly OwnedStatePath[]; liveState?: readonly string[]; stateRoot?: string | null };
export type WatchedSnapshot = { entries: Map<string, string>; incomplete: string[]; liveState?: string[] };
export type WatchedComparison = {
	unchanged: boolean; complete: boolean; watched: number;
	changed_paths: string[]; incomplete_paths: string[];
	/** Declared live namespaces (kit-managed browser profiles, live-fleet state), not hashed or judged as operator files. */
	live_state_paths?: string[];
	skipped_paths: { path: string; reason: "skipped-concurrent-writer" }[];
	/** Changes under the live-fleet namespaces the isolated test ran fenced off from (operatorWriteFence). */
	skipped_live_writer_paths?: { path: string; reason: "skipped-live-writer"; evidence: LiveWriterEvidence }[];
};

/**
 * Watch operator-side paths a kit run could plausibly write: OMP profile config files, rule and extension
 * directories, installed plugins, and the kit state root. Live scenarios run in a private HOME, so these
 * paths are compared before and after the run. Installed service-owned state, canonical kit-managed browser
 * profiles and known volatile browser cache subtrees are ignored as declared exceptions. A changed regular
 * file elsewhere is skipped only when its contents change again after the test runner exits, or when it lies
 * under a live-fleet namespace every isolated-test process ran write-fenced off from (liveWriterPaths).
 */
export function operatorWatchedPaths(home: string, stateRoot: string | null, owned: readonly OwnedStatePath[] = installedJobOwnedState(home)): WatchedPaths {
	const profileDirs = [join(home, ".omp", "agent")];
	const pluginDirs = [join(home, ".omp", "plugins")];
	try {
		for (const name of readdirSync(join(home, ".omp", "profiles")).sort()) {
			const root = join(home, ".omp", "profiles", name);
			profileDirs.push(join(root, "agent"));
			pluginDirs.push(join(root, "plugins"));
		}
	} catch { /* no named profiles */ }
	const paths: WatchedPaths = [join(home, ".omp", "settings.json"), join(home, ".agents", "rules"), join(home, ".agents", "omp-kit-ownership.json"),
		join(home, ".omp", "omp-extensions")];
	for (const dir of profileDirs) paths.push(...PROFILE_FILES.map(name => join(dir, name)), join(dir, "rules"));
	// OMP links one package and updates these two registry files; plugin caches are unrelated state.
	for (const dir of pluginDirs) paths.push(join(dir, "node_modules", "omp-kit-companion"),
		join(dir, "installed_plugins.json"), join(dir, "omp-plugins.lock.json"));
	if (stateRoot) paths.push(stateRoot);
	paths.owned = owned;
	paths.liveState = managedBrowserProfileRoots(home, stateRoot ?? undefined);
	paths.stateRoot = stateRoot;
	return paths;
}

/** Content and mode only: an mtime-only touch is not a change. An absent path is a recorded state, not an error. */
export function snapshotWatched(paths: readonly string[] & { owned?: readonly OwnedStatePath[]; liveState?: readonly string[]; stateRoot?: string | null }): WatchedSnapshot {
	const entries = new Map<string, string>();
	const incomplete: string[] = [];
	const liveState = new Set<string>();
	for (const root of paths) {
		if (!isAbsolute(root)) throw new Error("watched paths must be absolute");
		// Only the state root relaxes: every profile, rule, extension and plugin root keeps the strict caps.
		const relaxed = paths.stateRoot != null && root === paths.stateRoot;
		const maxEntries = relaxed ? MAX_STATE_ENTRIES_PER_ROOT : MAX_ENTRIES_PER_ROOT;
		let count = 0, bytes = 0, overflow = false;
		const visit = (path: string): void => {
			if (overflow) return;
			if (paths.owned && isOwnedState(paths.owned, path)) return;
			// Do not traverse live profiles: SQLite/LevelDB files can disappear or change mid-read.
			if (paths.liveState?.includes(path)) { liveState.add(path); return; }
			// Live-fleet namespaces of the state root churn on their own clock during the isolated run and
			// are never kit install writes: skip them like the live browser profiles, anchored for the report.
			if (relaxed) {
				const anchor = liveFleetAnchor(paths.stateRoot!, path);
				if (anchor !== null) { liveState.add(anchor); return; }
			}
			let stat;
			try { stat = lstatSync(path); }
			catch (error) {
				if ((error as NodeJS.ErrnoException).code === "ENOENT") { entries.set(path, "absent"); return; }
				incomplete.push(path); return;
			}
			if (++count > maxEntries) { overflow = true; incomplete.push(root); return; }
			const mode = (stat.mode & 0o7777).toString(8);
			if (stat.isSymbolicLink()) { entries.set(path, `link:${readlinkSync(path)}`); return; }
			if (stat.isFile()) {
				// A large state file is recorded by stable metadata, never content-hashed: an append or
				// rewrite still changes size or mtime, while the bulk never counts toward a byte budget.
				// The `file:` prefix keeps concurrent-writer attribution working on these entries.
				if (relaxed && stat.size > MAX_STATE_FILE_HASH_BYTES) {
					entries.set(path, `file:${mode}:meta:${stat.size}:${stat.mtimeMs}`);
					return;
				}
				if (!relaxed) {
					bytes += stat.size;
					if (bytes > MAX_BYTES_PER_ROOT) { overflow = true; incomplete.push(root); return; }
				}
				try { entries.set(path, `file:${mode}:${createHash("sha256").update(readFileSync(path)).digest("hex")}`); }
				catch { incomplete.push(path); }
				return;
			}
		if (stat.isDirectory()) {
			// A volatile browser cache is never operator state the kit could corrupt: skip the subtree
			// wholesale, so neither its churn nor its bulk counts toward changes, reads, or budgets.
			// The watched root itself is by construction kit-relevant and is never skipped.
			if (path !== root && VOLATILE_CACHE_DIR_NAMES[basename(path)] === true) return;
			entries.set(path, `dir:${mode}`);
			let children: string[];
			try { children = readdirSync(path).sort(); } catch { incomplete.push(path); return; }
			for (const child of children) visit(join(path, child));
			return;
		}
			entries.set(path, `other:${mode}`);
		};
		visit(root);
	}
	return { entries, incomplete, ...(liveState.size ? { liveState: [...liveState].sort() } : {}) };
}
function changedWatchedPaths(before: WatchedSnapshot, after: WatchedSnapshot): string[] {
	const changed = new Set<string>();
	for (const [path, value] of before.entries) if (after.entries.get(path) !== value) changed.add(path);
	for (const path of after.entries.keys()) if (!before.entries.has(path)) changed.add(path);
	return [...changed];
}

/** Only a post-run content hash change marks a changed file as concurrent; timed-out or unobserved changes remain failures. */
export async function activeConcurrentWriterPaths(before: WatchedSnapshot, after: WatchedSnapshot): Promise<ReadonlySet<string>> {
	const candidates = changedWatchedPaths(before, after)
		.filter(path => after.entries.get(path)?.startsWith("file:"))
		.sort()
		.slice(0, MAX_CONCURRENT_WRITER_CANDIDATES);
	if (!candidates.length) return EMPTY_CONCURRENT_WRITER_PATHS;

	// This project targets a lib without Promise.withResolvers; the watcher lifecycle owns its resolver here.
	return new Promise<ReadonlySet<string>>(resolve => {
		const active = new Set<string>();
		const listeners: { path: string; listener: (current: Stats, previous: Stats) => void }[] = [];
		let timer: NodeJS.Timeout | undefined;
		let finished = false;
		const finish = () => {
			if (finished) return;
			finished = true;
			clearTimeout(timer);
			for (const { path, listener } of listeners) unwatchFile(path, listener);
			resolve(active);
		};
		const inspect = (path: string) => {
			if (finished || active.has(path)) return;
			const finalValue = after.entries.get(path);
			if (!finalValue?.startsWith("file:")) return;
			let stat;
			try { stat = lstatSync(path); }
			catch { return; }
			if (!stat.isFile()) return;
			const mode = (stat.mode & 0o7777).toString(8);
			if (finalValue.includes(":meta:")) {
				// A large state-root file is recorded by stable metadata, not a content hash: compare
				// metadata against metadata, or every probe would disagree with the snapshot.
				if (`file:${mode}:meta:${stat.size}:${stat.mtimeMs}` !== finalValue) {
					active.add(path);
					if (active.size === candidates.length) finish();
				}
				return;
			}
			let currentHash: string;
			try { currentHash = createHash("sha256").update(readFileSync(path)).digest("hex"); }
			catch { return; }
			if (currentHash !== finalValue.slice(finalValue.lastIndexOf(":") + 1)) {
				active.add(path);
				if (active.size === candidates.length) finish();
			}
		};
		// Bun's macOS fs.watch backend missed writes; poll only the bounded changed-file set.
		timer = setTimeout(finish, CONCURRENT_WRITER_PROBE_MS);
		for (const path of candidates) {
			if (finished) break;
			const listener = (_current: Stats, _previous: Stats) => inspect(path);
			try {
				watchFile(path, { persistent: false, interval: 100 }, listener);
				listeners.push({ path, listener });
			} catch {
				// A path we cannot watch remains an ordinary changed path.
			}
		}
		if (!listeners.length) finish();
	});
}

/**
 * POSTFENCE (ompkit-6gbej): the live fleet writes three state-root namespaces on its own clock during a kit
 * update's isolated test: seat composer records, full-suite verdict logs, and disk-stage admission rows. A
 * file's content (a record's pid, a `.running.<pid>` segment, a row's pid) is written by whoever writes the
 * file, so it never proves who wrote it. Provenance is the fence instead: on darwin every isolated-test
 * process runs under sandbox-exec with this deny-list profile, so a change under these paths cannot be the
 * test's own write.
 * - file-write* is denied on <stateRoot>/composer, <stateRoot>/full-suite-verdicts (subpaths) and
 *   <stateRoot>/disk-stage/receipts.jsonl: create, overwrite, append, unlink, rename and hard links all EPERM.
 * - file-write-unlink is denied on every ancestor directory, so the test cannot rename a namespace away and
 *   recreate it; mkdir -p, touch and writes elsewhere stay allowed.
 * - /bin/ps runs unsandboxed: a sandboxed process cannot exec the setuid ps (rc 126, measured), and ps writes nothing.
 * Nested sandbox-exec still fails (rc 71); no fast or ladder stage uses it.
 * Accepted residual: the fence covers the isolated test's own processes, not IPC. An unsandboxed broker the test
 * can reach (the operator's tmux server, a launchd service, a live omp-kit seat) could write these paths on its
 * behalf. The isolated environment hands the test no such socket or session, and these namespaces are written by
 * seats, verdict runners and `omp-kit heavy`, not by request; such a write would be skipped.
 * Where the platform has no sandbox-exec (Linux), there is no fence and every change under these paths fails.
 */
export type WriteFence = {
	/** The logical state root the comparison judges (as watched); the profile names its physical path. */
	stateRoot: string;
	denied: string[];
	ancestors: string[];
	profile: string;
	profile_sha256: string;
	executable: string;
};
/** Evidence for one skipped change: the fenced namespace and the exact profile every isolated-test process ran under. */
export type LiveWriterEvidence = { source: "write-fence"; namespace: string; profile_sha256: string };
export type LiveWriterContext = {
	stateRoot: string | null;
	/** The fence every isolated-test process in this snapshot window ran under; null means none and nothing is skipped. */
	fence: WriteFence | null;
};

/** The physical path: the deepest existing ancestor resolved, the rest appended (the sandbox judges resolved paths). */
function physicalPath(path: string): string {
	const rest: string[] = [];
	let current = path;
	for (;;) {
		try { return join(realpathSync(current), ...rest.reverse()); }
		catch {
			const parent = dirname(current);
			if (parent === current) return path;
			rest.push(basename(current));
			current = parent;
		}
	}
}

function fenceNamespaces(stateRoot: string) {
	return { composer: join(stateRoot, "composer"), verdicts: join(stateRoot, "full-suite-verdicts"),
		receipts: join(stateRoot, "disk-stage", "receipts.jsonl") };
}

/** The write fence for an isolated run, or null where it cannot be applied (not darwin, or no sandbox-exec). */
export function operatorWriteFence(stateRoot: string | null, platform: NodeJS.Platform = process.platform,
	executable: string = SANDBOX_EXEC): WriteFence | null {
	if (!stateRoot || !isAbsolute(stateRoot) || platform !== "darwin" || !existsSync(executable)) return null;
	const physical = fenceNamespaces(physicalPath(stateRoot));
	const denied = [physical.composer, physical.verdicts, physical.receipts];
	const ancestors: string[] = [];
	for (let dir = dirname(physical.receipts); dir !== dirname(dir); dir = dirname(dir)) ancestors.push(dir);
	const quote = (path: string) => JSON.stringify(path);
	const profile = [
		"(version 1)",
		"(allow default)",
		`(deny file-write* (subpath ${quote(physical.composer)}) (subpath ${quote(physical.verdicts)}) (literal ${quote(physical.receipts)}))`,
		`(deny file-write-unlink ${ancestors.map(dir => `(literal ${quote(dir)})`).join(" ")})`,
		'(allow process-exec (literal "/bin/ps") (with no-sandbox))',
		"",
	].join("\n");
	return { stateRoot, denied, ancestors, profile, profile_sha256: createHash("sha256").update(profile).digest("hex"), executable };
}

/**
 * Changed paths under a fenced live-fleet namespace, when this run's isolated test ran under that fence.
 * Without a fence, or for any other path, nothing is skipped: the change stays a failure.
 */
export function liveWriterPaths(before: WatchedSnapshot, after: WatchedSnapshot, context: LiveWriterContext,
	exclude: ReadonlySet<string> = EMPTY_CONCURRENT_WRITER_PATHS): ReadonlyMap<string, LiveWriterEvidence> {
	const attributed = new Map<string, LiveWriterEvidence>();
	const { stateRoot, fence } = context;
	if (!stateRoot || !fence || fence.stateRoot !== stateRoot) return attributed;
	const namespaces = fenceNamespaces(stateRoot);
	const within = (root: string, path: string) => { const rel = relative(root, path); return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel)); };
	const namespaceOf = (path: string) => path === namespaces.receipts ? namespaces.receipts
		: within(namespaces.composer, path) ? namespaces.composer : within(namespaces.verdicts, path) ? namespaces.verdicts : null;
	const candidates = changedWatchedPaths(before, after).filter(path => !exclude.has(path) && namespaceOf(path) !== null)
		.sort().slice(0, MAX_LIVE_WRITER_CANDIDATES);
	for (const path of candidates) attributed.set(path, { source: "write-fence", namespace: namespaceOf(path)!, profile_sha256: fence.profile_sha256 });
	return attributed;
}

export function compareWatched(
	before: WatchedSnapshot,
	after: WatchedSnapshot,
	home: string,
	skippedConcurrentWriter?: ReadonlySet<string>,
	skippedLiveWriter?: ReadonlyMap<string, LiveWriterEvidence>,
): WatchedComparison {
	const changed = changedWatchedPaths(before, after);
	const display = (path: string) => path === home || path.startsWith(home + "/") ? `~/${relative(home, path)}` : path;
	const incomplete = [...new Set([...before.incomplete, ...after.incomplete])].map(display).sort();
	const concurrent = (path: string) => skippedConcurrentWriter?.has(path) === true;
	const live = (path: string) => !concurrent(path) && skippedLiveWriter?.has(path) === true;
	const changedPaths = changed.filter(path => !concurrent(path) && !live(path)).map(display).sort();
	const skippedPaths = changed.filter(concurrent).map(display).sort()
		.map(path => ({ path, reason: "skipped-concurrent-writer" as const }));
	const liveWriterSkips = changed.filter(live)
		.map(path => ({ path: display(path), reason: "skipped-live-writer" as const, evidence: skippedLiveWriter!.get(path)! }))
		.sort((left, right) => left.path < right.path ? -1 : left.path > right.path ? 1 : 0);
	return {
		unchanged: changed.length === 0,
		complete: incomplete.length === 0,
		watched: before.entries.size,
		changed_paths: changedPaths.slice(0, 50),
		incomplete_paths: incomplete.slice(0, 50),
		live_state_paths: [...new Set([...(before.liveState ?? []), ...(after.liveState ?? [])])].map(display).sort(),
		skipped_paths: skippedPaths.slice(0, 50),
		skipped_live_writer_paths: liveWriterSkips.slice(0, 50),
	};
}
