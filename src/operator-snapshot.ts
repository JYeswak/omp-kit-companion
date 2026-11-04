import { createHash } from "node:crypto";
import { existsSync, lstatSync, readFileSync, readdirSync, readlinkSync, unwatchFile, watchFile, type Stats } from "node:fs";
import { basename, dirname, isAbsolute, join, relative } from "node:path";
import { installedJobOwnedState, type OwnedStatePath } from "./service.ts";
import { managedBrowserProfileRoots } from "./cache-retain.ts";
import { runSync } from "./kitlib/run.ts";

/** Profile files the kit could write; agent.db, sessions and caches change under normal agent use and are not watched. */
const PROFILE_FILES = ["config.yml", "config.yaml", "config.json", "settings.json"] as const;
const MAX_ENTRIES_PER_ROOT = 20_000;
const MAX_BYTES_PER_ROOT = 512 * 1024 * 1024;
const MAX_CONCURRENT_WRITER_CANDIDATES = 50;
const CONCURRENT_WRITER_PROBE_MS = 1_000; // Timeout never counts as writer evidence; unobserved changes remain failures.
const EMPTY_CONCURRENT_WRITER_PATHS: ReadonlySet<string> = new Set();
const MAX_LIVE_WRITER_CANDIDATES = 5_000;
const MAX_WRITER_PROCESS_LOOKUPS = 256;
const MAX_WRITER_ANCESTRY = 32;
const MAX_APPENDED_ROWS = 1_000;
const WRITER_PS_DEADLINE_S = 2;
const COMPOSER_RECORD = /^[0-9a-f]{16}\.json$/;
const RUNNING_PID = /\.running\.(\d+)(?=[./]|$)/g;

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

/** True when `path` is, or lies under, state an installed service job writes on its own clock. */
export function isOwnedState(owned: readonly OwnedStatePath[], path: string): boolean {
	return owned.some(entry => {
		const rel = relative(entry.path, path);
		if (rel.startsWith("..") || isAbsolute(rel)) return false;
		if (!entry.names) return true;
		return rel !== "" && entry.names(rel.split("/")[0]!);
	});
}

export type WatchedPaths = string[] & { owned?: readonly OwnedStatePath[]; liveState?: readonly string[] };
export type WatchedSnapshot = { entries: Map<string, string>; incomplete: string[]; liveState?: string[] };
export type WatchedComparison = {
	unchanged: boolean; complete: boolean; watched: number;
	changed_paths: string[]; incomplete_paths: string[];
	/** Declared live browser namespaces, not hashed or judged as operator files. */
	live_state_paths?: string[];
	skipped_paths: { path: string; reason: "skipped-concurrent-writer" }[];
	/** Changes whose declared writer pid was proven to be a live-fleet process, never the isolated test. */
	skipped_live_writer_paths?: { path: string; reason: "skipped-live-writer"; evidence: LiveWriterEvidence }[];
};

/**
 * Watch operator-side paths a kit run could plausibly write: OMP profile config files, rule and extension
 * directories, installed plugins, and the kit state root. Live scenarios run in a private HOME, so these
 * paths are compared before and after the run. Installed service-owned state, canonical kit-managed browser
 * profiles and known volatile browser cache subtrees are ignored as declared exceptions. A changed regular
 * file elsewhere is skipped only when its contents change again after the test runner exits, or when the
 * change names a writer process proven to be outside the isolated test (liveWriterPaths).
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
	return paths;
}

/** Content and mode only: an mtime-only touch is not a change. An absent path is a recorded state, not an error. */
export function snapshotWatched(paths: readonly string[] & { owned?: readonly OwnedStatePath[]; liveState?: readonly string[] }): WatchedSnapshot {
	const entries = new Map<string, string>();
	const incomplete: string[] = [];
	const liveState = new Set<string>();
	for (const root of paths) {
		if (!isAbsolute(root)) throw new Error("watched paths must be absolute");
		let count = 0, bytes = 0, overflow = false;
		const visit = (path: string): void => {
			if (overflow) return;
			if (paths.owned && isOwnedState(paths.owned, path)) return;
			// Do not traverse live profiles: SQLite/LevelDB files can disappear or change mid-read.
			if (paths.liveState?.includes(path)) { liveState.add(path); return; }
			let stat;
			try { stat = lstatSync(path); }
			catch (error) {
				if ((error as NodeJS.ErrnoException).code === "ENOENT") { entries.set(path, "absent"); return; }
				incomplete.push(path); return;
			}
			if (++count > MAX_ENTRIES_PER_ROOT) { overflow = true; incomplete.push(root); return; }
			const mode = (stat.mode & 0o7777).toString(8);
			if (stat.isSymbolicLink()) { entries.set(path, `link:${readlinkSync(path)}`); return; }
			if (stat.isFile()) {
				bytes += stat.size;
				if (bytes > MAX_BYTES_PER_ROOT) { overflow = true; incomplete.push(root); return; }
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
			const current = snapshotWatched([path]);
			if (current.incomplete.includes(path)) return;
			const currentValue = current.entries.get(path);
			const finalValue = after.entries.get(path);
			if (currentValue?.startsWith("file:") && finalValue?.startsWith("file:")
				&& currentValue.slice(currentValue.lastIndexOf(":") + 1) !== finalValue.slice(finalValue.lastIndexOf(":") + 1)) {
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
 * Writer evidence for one change: the declared writer, or (for an exited disk-stage writer, darwin only) its
 * recorded parent, verified by a bounded `ps` lookup. A pid alone is never evidence, because pids are reused.
 * - started-before-run: alive now and started before the before-snapshot, so it held that pid through the whole
 *   run and cannot be an isolated-test process (all of them start after the snapshot).
 * - alive-outside-runner (darwin): alive, started before the change was written (so the pid was not reused after
 *   the write), outside the runner's process group, and its first ancestor that predates the run is neither the
 *   runner nor launchd. The isolated test's processes descend from the runner and are orphaned to launchd, so
 *   their chains end there. Linux is excluded: a subreaper (systemd --user) adopts orphans and would hide them.
 *   Residual: a pre-run broker the test asked to spawn a process (for example the operator's tmux server)
 *   would pass; the isolated environment does not hand the test those sockets.
 */
export type WriterProof = {
	pid: number;
	rule: "started-before-run" | "alive-outside-runner";
	/** Upper bound of the process start time (ps etime, rounded up one second). */
	started_by: string;
	pgid: number;
	/** Set when the row's own writer had exited and its recorded parent carries the proof. */
	parent_of?: number;
	ancestor?: { pid: number; started_by: string };
};
/**
 * The namespace selects which field names the writer, never whether the change is skipped: composer records carry
 * the seat's own `pid`, full-suite verdict paths embed `.running.<$$>`, and disk-stage rows carry `pid`/`ppid`.
 */
export type LiveWriterEvidence = { source: "composer-record" | "verdict-running-path" | "disk-stage-append"; writers: WriterProof[] };
export type LiveWriterContext = {
	stateRoot: string | null;
	/** Wall clock taken before the before-snapshot: every isolated-test process started after it. */
	runStartedMs: number;
	/** The process that spawned the isolated test (default: this process); it and its group never count as outside. */
	runnerPid?: number;
	platform?: NodeJS.Platform;
};
type ProcessFacts = { startedByMs: number; pgid: number; ppid: number };

const PS = existsSync("/bin/ps") ? "/bin/ps" : "/usr/bin/ps";

class WriterJudge {
	private readonly facts = new Map<number, ProcessFacts | null>();
	private lookups = 0;
	private readonly runnerPid: number;
	private readonly runnerPgid: number | null;
	private readonly darwin: boolean;
	constructor(private readonly context: LiveWriterContext) {
		this.runnerPid = context.runnerPid ?? process.pid;
		this.darwin = (context.platform ?? process.platform) === "darwin";
		this.runnerPgid = this.lookup(this.runnerPid)?.pgid ?? null;
	}

	private lookup(pid: number): ProcessFacts | null {
		if (this.facts.has(pid)) return this.facts.get(pid)!;
		if (++this.lookups > MAX_WRITER_PROCESS_LOOKUPS) return null;
		let facts: ProcessFacts | null = null;
		try {
			const result = runSync([PS, "-o", "etime=,pgid=,ppid=", "-p", String(pid)],
				{ deadline_s: WRITER_PS_DEADLINE_S, max_output_bytes: 4096, env: { PATH: "/bin:/usr/bin", LC_ALL: "C" } });
			const sampledMs = Date.now();
			const match = result.rc === 0 && !result.truncated
				? /^\s*(?:(\d+)-)?(?:(\d+):)?(\d+):(\d+)\s+(\d+)\s+(\d+)\s*$/.exec(new TextDecoder().decode(result.stdout)) : null;
			if (match) {
				const elapsedS = Number(match[1] ?? 0) * 86_400 + Number(match[2] ?? 0) * 3_600 + Number(match[3]) * 60 + Number(match[4]);
				facts = { startedByMs: sampledMs - elapsedS * 1000 + 1000, pgid: Number(match[5]), ppid: Number(match[6]) };
			}
		} catch { /* an unreadable process is no evidence */ }
		this.facts.set(pid, facts);
		return facts;
	}

	/** `writtenMs` is when the change was written (file mtime or the row's own ts); null when unknown. */
	prove(pid: number, writtenMs: number | null): WriterProof | null {
		if (!Number.isSafeInteger(pid) || pid <= 1 || pid === this.runnerPid) return null;
		const facts = this.lookup(pid);
		if (!facts) return null;
		const base = { pid, started_by: new Date(facts.startedByMs).toISOString(), pgid: facts.pgid };
		if (facts.startedByMs < this.context.runStartedMs) return { ...base, rule: "started-before-run" };
		if (!this.darwin || writtenMs === null || !(facts.startedByMs < writtenMs) || this.runnerPgid === null || facts.pgid === this.runnerPgid) return null;
		let ancestor = facts.ppid;
		for (let depth = 0; depth < MAX_WRITER_ANCESTRY; depth++) {
			if (ancestor <= 1 || ancestor === this.runnerPid) return null;
			const up = this.lookup(ancestor);
			if (!up || up.pgid === this.runnerPgid) return null;
			if (up.startedByMs < this.context.runStartedMs)
				return { ...base, rule: "alive-outside-runner", ancestor: { pid: ancestor, started_by: new Date(up.startedByMs).toISOString() } };
			ancestor = up.ppid;
		}
		return null;
	}

	/** An exited writer's recorded parent, proven to have held that pid when the row was written (darwin: no subreapers). */
	proveParent(ppid: number, writtenMs: number, child: number): WriterProof | null {
		if (!this.darwin) return null;
		const proof = this.prove(ppid, writtenMs);
		return proof ? { ...proof, parent_of: child } : null;
	}
}

/** The after-snapshot bytes of a regular file, read only when still identical to what was compared. */
function comparedFile(path: string, after: WatchedSnapshot): { bytes: Buffer; mtimeMs: number } | null {
	const value = after.entries.get(path);
	if (!value?.startsWith("file:")) return null;
	try {
		const first = lstatSync(path);
		const bytes = readFileSync(path);
		const second = lstatSync(path);
		if (!first.isFile() || first.mtimeMs !== second.mtimeMs || first.size !== second.size) return null;
		if (createHash("sha256").update(bytes).digest("hex") !== value.slice(value.lastIndexOf(":") + 1)) return null;
		return { bytes, mtimeMs: second.mtimeMs };
	} catch { return null; }
}

function composerWriter(path: string, after: WatchedSnapshot, judge: WriterJudge): LiveWriterEvidence | null {
	const file = comparedFile(path, after);
	if (!file) return null;
	let record: unknown;
	try { record = JSON.parse(file.bytes.toString("utf8")); } catch { return null; }
	if (typeof record !== "object" || record === null || !("schema" in record) || record.schema !== 1 || !("pid" in record) || typeof record.pid !== "number") return null;
	const proof = judge.prove(record.pid, file.mtimeMs);
	return proof ? { source: "composer-record", writers: [proof] } : null;
}

function runningPathWriter(path: string, verdicts: string, after: WatchedSnapshot, judge: WriterJudge): LiveWriterEvidence | null {
	const pids = new Set([...relative(verdicts, path).matchAll(RUNNING_PID)].map(match => Number(match[1])));
	if (pids.size !== 1) return null;
	let writtenMs: number | null = null;
	const value = after.entries.get(path);
	if (value !== undefined && value !== "absent") {
		try { writtenMs = lstatSync(path).mtimeMs; } catch { /* gone since: start-before-run evidence only */ }
	}
	const proof = judge.prove([...pids][0]!, writtenMs);
	return proof ? { source: "verdict-running-path", writers: [proof] } : null;
}

/** Only appended rows count: the before bytes must be an exact line-boundary prefix of the after bytes, and every new row must name a proven writer. */
function appendedRowWriters(path: string, before: WatchedSnapshot, after: WatchedSnapshot, judge: WriterJudge): LiveWriterEvidence | null {
	const file = comparedFile(path, after);
	if (!file) return null;
	const previous = before.entries.get(path);
	const current = after.entries.get(path)!;
	let offset: number | null = null;
	if (previous === undefined || previous === "absent") offset = 0;
	// Same `file:<mode>` prefix: a mode change is not an append.
	else if (previous.startsWith("file:") && previous.slice(0, previous.lastIndexOf(":")) === current.slice(0, current.lastIndexOf(":"))) {
		const want = previous.slice(previous.lastIndexOf(":") + 1);
		const hash = createHash("sha256");
		if (hash.copy().digest("hex") === want) offset = 0;
		let start = 0;
		while (offset === null) {
			const newline = file.bytes.indexOf(0x0a, start);
			if (newline < 0) break;
			hash.update(file.bytes.subarray(start, newline + 1));
			start = newline + 1;
			if (hash.copy().digest("hex") === want) offset = start;
		}
	}
	if (offset === null || offset >= file.bytes.length || file.bytes[file.bytes.length - 1] !== 0x0a) return null;
	const rows = file.bytes.subarray(offset, file.bytes.length - 1).toString("utf8").split("\n");
	if (rows.length > MAX_APPENDED_ROWS) return null;
	const writers: WriterProof[] = [];
	for (const line of rows) {
		let row: unknown;
		try { row = JSON.parse(line); } catch { return null; }
		if (typeof row !== "object" || row === null || !("pid" in row) || typeof row.pid !== "number" || !("ts" in row) || typeof row.ts !== "string") return null;
		const writtenMs = Date.parse(row.ts);
		if (!Number.isFinite(writtenMs)) return null;
		const ppid = "ppid" in row && typeof row.ppid === "number" ? row.ppid : null;
		const proof = judge.prove(row.pid, writtenMs) ?? (ppid === null ? null : judge.proveParent(ppid, writtenMs, row.pid));
		if (!proof) return null;
		writers.push(proof);
	}
	return { source: "disk-stage-append", writers };
}

/**
 * Changed paths whose writer is proven to be a live-fleet process outside the isolated test (see WriterProof).
 * Anything without such evidence, including every path outside these writer-declaring namespaces, stays a change.
 */
export function liveWriterPaths(before: WatchedSnapshot, after: WatchedSnapshot, context: LiveWriterContext,
	exclude: ReadonlySet<string> = EMPTY_CONCURRENT_WRITER_PATHS): ReadonlyMap<string, LiveWriterEvidence> {
	const attributed = new Map<string, LiveWriterEvidence>();
	const stateRoot = context.stateRoot;
	if (!stateRoot) return attributed;
	const composer = join(stateRoot, "composer"), verdicts = join(stateRoot, "full-suite-verdicts");
	const diskStage = join(stateRoot, "disk-stage", "receipts.jsonl");
	const under = (root: string, path: string) => { const rel = relative(root, path); return rel !== "" && !rel.startsWith("..") && !isAbsolute(rel); };
	const candidates = changedWatchedPaths(before, after).filter(path => !exclude.has(path)
		&& (path === diskStage || (dirname(path) === composer && COMPOSER_RECORD.test(basename(path))) || under(verdicts, path)))
		.sort().slice(0, MAX_LIVE_WRITER_CANDIDATES);
	if (!candidates.length) return attributed;
	const judge = new WriterJudge(context);
	for (const path of candidates) {
		const evidence = path === diskStage ? appendedRowWriters(path, before, after, judge)
			: under(verdicts, path) ? runningPathWriter(path, verdicts, after, judge)
			: composerWriter(path, after, judge);
		if (evidence) attributed.set(path, evidence);
	}
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
