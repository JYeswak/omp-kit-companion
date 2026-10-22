import { createHash } from "node:crypto";
import { lstatSync, readFileSync, readdirSync, readlinkSync } from "node:fs";
import { isAbsolute, join, relative } from "node:path";
import { installedJobOwnedState, type OwnedStatePath } from "./service.ts";

/** Profile files the kit could write; agent.db, sessions and caches change under normal agent use and are not watched. */
const PROFILE_FILES = ["config.yml", "config.yaml", "config.json", "settings.json"] as const;
const MAX_ENTRIES_PER_ROOT = 20_000;
const MAX_BYTES_PER_ROOT = 512 * 1024 * 1024;

/** True when `path` is, or lies under, state an installed service job writes on its own clock. */
export function isOwnedState(owned: readonly OwnedStatePath[], path: string): boolean {
	return owned.some(entry => {
		const rel = relative(entry.path, path);
		if (rel.startsWith("..") || isAbsolute(rel)) return false;
		if (!entry.names) return true;
		return rel !== "" && entry.names(rel.split("/")[0]!);
	});
}

export type WatchedPaths = string[] & { owned?: readonly OwnedStatePath[] };
export type WatchedSnapshot = { entries: Map<string, string>; incomplete: string[] };
export type WatchedComparison = { unchanged: boolean; complete: boolean; watched: number; changed_paths: string[]; incomplete_paths: string[] };

/**
 * Operator-side paths a kit run could plausibly write: OMP profile config files, rule and extension
 * directories, installed plugins, and the kit state root. Live scenarios run in a private HOME, so these
 * must be byte-identical before and after; everything else in the operator HOME may change concurrently.
 * The one exception is state the kit's own service jobs write on their own clock (cc's store, ci-poller's
 * cache, the scratch quarantine...): each job declares it, and only the jobs installed in `home` are
 * excluded, so a write by anything else, including the run under test, still counts.
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
	return paths;
}

/** Content and mode only: an mtime-only touch is not a change. An absent path is a recorded state, not an error. */
export function snapshotWatched(paths: readonly string[] & { owned?: readonly OwnedStatePath[] }): WatchedSnapshot {
	const entries = new Map<string, string>();
	const incomplete: string[] = [];
	for (const root of paths) {
		if (!isAbsolute(root)) throw new Error("watched paths must be absolute");
		let count = 0, bytes = 0, overflow = false;
		const visit = (path: string): void => {
			if (overflow) return;
			if (paths.owned && isOwnedState(paths.owned, path)) return;
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
