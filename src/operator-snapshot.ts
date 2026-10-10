import { createHash } from "node:crypto";
import { lstatSync, readFileSync, readdirSync, readlinkSync } from "node:fs";
import { isAbsolute, join, relative } from "node:path";

/** Profile files the kit could write; agent.db, sessions and caches change under normal agent use and are not watched. */
const PROFILE_FILES = ["config.yml", "config.yaml", "config.json", "settings.json"] as const;
const MAX_ENTRIES_PER_ROOT = 20_000;
const MAX_BYTES_PER_ROOT = 512 * 1024 * 1024;

/**
 * Children of the kit state root that the kit's own scheduled service jobs write on their own clock:
 * ci-poller (ci-runs.json), load-watch and heavy (load/), every job's lock and status (jobs/),
 * fleet-flush and fleet-watch logs and state, scratch-reaper (scratch-quarantine/, scratch-reap-log.jsonl),
 * the service TMPDIR (service-tmp/) and claude-save receipts. They change during any isolated test on a
 * machine running those jobs, and scratch-quarantine alone can hold over a million entries, so watching
 * them made every live update postcheck fail. Everything else under the state root stays watched,
 * including any new top-level file a run creates.
 */
const SERVICE_OWNED_STATE: Record<string, true> = {
	"ci-runs.json": true, load: true, jobs: true, "fleet-flush.jsonl": true, "fleet-watch.jsonl": true,
	"fleet-watch-state.json": true, "scratch-quarantine": true, "scratch-reap-log.jsonl": true, "service-tmp": true,
};
const SERVICE_OWNED_STATE_FILE = /^claude-save-[A-Za-z0-9._-]+\.json$/;

/** True when `path` is, or lies under, a service-owned child of `stateRoot`. */
export function isServiceOwnedState(stateRoot: string, path: string): boolean {
	const rel = relative(stateRoot, path);
	if (!rel || rel.startsWith("..") || isAbsolute(rel)) return false;
	const top = rel.split("/")[0]!;
	return SERVICE_OWNED_STATE[top] === true || (top === rel && SERVICE_OWNED_STATE_FILE.test(top));
}

export type WatchedPaths = string[] & { stateRoot?: string };
export type WatchedSnapshot = { entries: Map<string, string>; incomplete: string[] };
export type WatchedComparison = { unchanged: boolean; complete: boolean; watched: number; changed_paths: string[]; incomplete_paths: string[] };

/**
 * Operator-side paths a kit run could plausibly write: OMP profile config files, rule and extension
 * directories, installed plugins, and the kit state root. Live scenarios run in a private HOME, so these
 * must be byte-identical before and after; everything else in the operator HOME may change concurrently.
 */
export function operatorWatchedPaths(home: string, stateRoot: string | null): WatchedPaths {
	const profileDirs = [join(home, ".omp", "agent")];
	try {
		for (const name of readdirSync(join(home, ".omp", "profiles")).sort())
			profileDirs.push(join(home, ".omp", "profiles", name, "agent"));
	} catch { /* no named profiles */ }
	const paths: WatchedPaths = [join(home, ".omp", "settings.json"), join(home, ".agents", "rules"), join(home, ".agents", "omp-kit-ownership.json"),
		join(home, ".omp", "omp-extensions"), join(home, ".omp", "plugins")];
	for (const dir of profileDirs) paths.push(...PROFILE_FILES.map(name => join(dir, name)), join(dir, "rules"));
	if (stateRoot) { paths.push(stateRoot); paths.stateRoot = stateRoot; }
	return paths;
}

/** Content and mode only: an mtime-only touch is not a change. An absent path is a recorded state, not an error. */
export function snapshotWatched(paths: readonly string[] & { stateRoot?: string }): WatchedSnapshot {
	const entries = new Map<string, string>();
	const incomplete: string[] = [];
	for (const root of paths) {
		if (!isAbsolute(root)) throw new Error("watched paths must be absolute");
		let count = 0, bytes = 0, overflow = false;
		const visit = (path: string): void => {
			if (overflow) return;
			if (paths.stateRoot && isServiceOwnedState(paths.stateRoot, path)) return;
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
	return { entries, incomplete };
}

export function compareWatched(before: WatchedSnapshot, after: WatchedSnapshot, home: string): WatchedComparison {
	const changed = new Set<string>();
	for (const [path, value] of before.entries) if (after.entries.get(path) !== value) changed.add(path);
	for (const path of after.entries.keys()) if (!before.entries.has(path)) changed.add(path);
	const display = (path: string) => path === home || path.startsWith(home + "/") ? `~/${relative(home, path)}` : path;
	const incomplete = [...new Set([...before.incomplete, ...after.incomplete])].map(display).sort();
	const changedPaths = [...changed].map(display).sort();
	return { unchanged: changed.size === 0, complete: incomplete.length === 0, watched: before.entries.size,
		changed_paths: changedPaths.slice(0, 50), incomplete_paths: incomplete.slice(0, 50) };
}
