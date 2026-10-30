import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { chmodSync, closeSync, copyFileSync, existsSync, lstatSync, mkdirSync, openSync, readFileSync, readlinkSync, readdirSync, renameSync, rmdirSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import type { Stats } from "node:fs";
import type { CliResult, ParsedCommand } from "./cli.ts";

/** Native implementation based on git_converge.py (a58ef61, blob 9ffa2446cb6016132897059f4348028f468a98bb).
 * The .138 owner gate additionally covers every independently both-changed path, even equal results;
 * the qualified helper only detected merge-tree conflicts. Its qualification does not certify TS.
 * Temporary indexes are transactions on the real index, never publication candidates.
 */
export type ConvergeOptions = {
	repo: string;
	apply?: boolean;
	push?: boolean;
	fetch?: boolean;
	resolutions?: Readonly<Record<string, "ours" | "theirs">>;
	beforePush?: (candidateSha: string, baseSha: string) =>
		{ allow: boolean; reason?: string } | Promise<{ allow: boolean; reason?: string }>;
};
export type ConvergeConflict = { path: string; kind: string; detail?: string; class?: "true_divergence"; hint?: "theirs_behind" | "ours_behind" };
export type ConvergeResult = {
	repo: string;
	state: "AHEAD" | "FAST_FORWARD" | "MERGED" | "REFUSED" | null;
	reason: string | null;
	applied: boolean;
	pushed: boolean;
	conflicts: ConvergeConflict[];
	elapsed_s: number;
	old?: string;
	up?: string;
	paths?: number;
	resolutions?: Readonly<Record<string, "ours" | "theirs">>;
	new_head?: string;
	worktree_written?: number;
	index_updated?: number;
	races?: string[];
	restore_skipped?: string[];
	published_commits?: number;
	remote_after?: string;
	push_error?: string;
};
type Side = readonly [mode: string, oid: string] | null;
type DiskSide = Side | readonly ["dir", null];
type Entry = readonly [mode: string, oid: string, stage: string];
type Entries = Map<string, Entry[]>;
type Change = { path: string; old: Side; new: Side; seen: Entry[]; index: "update" | "keep"; worktree: "write" | "keep" };
type Plan = { remote: "origin"; old: string; up: string; state: "AHEAD" | "FAST_FORWARD" | "MERGED"; tree: string | null; changes: Change[]; filemode: boolean; resolutions: Record<string, "ours" | "theirs"> };
type IndexRecord = { path: string; seen: Entry[]; side: Side };
const ZERO = "0".repeat(40);
class Refused extends Error {
	constructor(readonly reason: string, readonly conflicts: ConvergeConflict[] = []) { super(reason); }
}
class RefMoved extends Error {
	constructor(readonly restore_skipped: string[] = []) { super("refs/heads/main moved"); }
}
function errno(error: unknown, code: string): boolean { return error instanceof Error && "code" in error && error.code === code; }
function environment(extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
	const env: NodeJS.ProcessEnv = {};
	for (const [key, value] of Object.entries(process.env)) if (!key.startsWith("GIT_")) env[key] = value;
	return { ...env, GIT_TERMINAL_PROMPT: "0", ...extra };
}
function git(repo: string, args: string[], input?: string | Buffer, extra?: NodeJS.ProcessEnv) {
	const p = spawnSync("git", ["-C", repo, ...args], { cwd: repo, env: environment(extra), input, maxBuffer: 64 * 1024 * 1024 });
	if (p.error) throw new Error(`git ${args.join(" ")}: ${p.error.message}`, { cause: p.error });
	return { code: p.status ?? 1, out: p.stdout ?? Buffer.alloc(0), err: (p.stderr ?? Buffer.alloc(0)).toString("utf8").trim() };
}
function out(repo: string, args: string[], input?: string | Buffer, extra?: NodeJS.ProcessEnv): string {
	const p = git(repo, args, input, extra);
	if (p.code !== 0) throw new Error(`git ${args.join(" ")}: ${p.err}`);
	return p.out.toString("utf8").trim();
}
function checkedBytes(repo: string, args: string[], input?: string | Buffer): Buffer {
	const p = git(repo, args, input);
	if (p.code !== 0) throw new Error(`git ${args.join(" ")}: ${p.err}`);
	return p.out;
}
function ancestor(repo: string, a: string, b: string): boolean { return git(repo, ["merge-base", "--is-ancestor", a, b]).code === 0; }
function side(mode: string, oid: string): Side { return mode === "000000" || oid === ZERO ? null : [mode, oid]; }
function equal(a: DiskSide, b: DiskSide, filemode = true): boolean {
	if (a === null || b === null) return a === b;
	return a[1] === b[1] && (a[0] === b[0] || (!filemode && (a[0] === "100644" || a[0] === "100755") && (b[0] === "100644" || b[0] === "100755")));
}
function entriesEqual(a: Entry[], b: Entry[]): boolean {
	return a.length === b.length && a.every((entry, i) => entry.every((value, j) => value === b[i]?.[j]));
}
function diffSides(repo: string, old: string, target: string): { path: string; old: Side; new: Side }[] {
	const tokens = checkedBytes(repo, ["diff-tree", "-r", "-z", "--no-renames", old, target]).toString("utf8").split("\0");
	const changes: { path: string; old: Side; new: Side }[] = [];
	for (let i = 0; i < tokens.length - 1;) {
		const meta = tokens[i++] ?? "";
		if (!meta.startsWith(":")) continue;
		const [om, nm, oo, no] = meta.slice(1).split(" ");
		const path = tokens[i++];
		if (!om || !nm || !oo || !no || path === undefined) throw new Error("Invalid git diff-tree record");
		changes.push({ path, old: side(om, oo), new: side(nm, no) });
	}
	return changes;
}
function indexEntries(repo: string, paths: string[]): Entries {
	const entries: Entries = new Map();
	for (let start = 0; start < paths.length; start += 400) {
		const bytes = checkedBytes(repo, ["ls-files", "-s", "-z", "--", ...paths.slice(start, start + 400).map(p => `:(literal)${p}`)]);
		for (const rec of bytes.toString("utf8").split("\0")) {
			if (!rec) continue;
			const tab = rec.indexOf("\t");
			const [mode, oid, stage] = rec.slice(0, tab).split(" ");
			if (tab < 0 || !mode || !oid || !stage) throw new Error("Invalid git ls-files record");
			const path = rec.slice(tab + 1), list = entries.get(path) ?? [];
			list.push([mode, oid, stage]); entries.set(path, list);
		}
	}
	return entries;
}
type ParentSnapshot = { path: string; dev: number; ino: number };
function containedParents(repo: string, path: string, create = false): ParentSnapshot[] {
	const components = path.split("/");
	if (!path || components.some(c => !c || c === "." || c === "..")) throw new Refused("UNSAFE_PARENT", [{ path, kind: "UNSAFE_PARENT" }]);
	const parents: ParentSnapshot[] = [];
	let current = repo;
	for (const component of components.slice(0, -1)) {
		current = join(current, component);
		let st: Stats;
		try { st = lstatSync(current); }
		catch (error) {
			if (!errno(error, "ENOENT")) throw error;
			if (!create) break;
			try { mkdirSync(current); } catch (created) { if (!errno(created, "EEXIST")) throw created; }
			st = lstatSync(current);
		}
		if (!st.isDirectory() || st.isSymbolicLink()) throw new Refused("UNSAFE_PARENT", [{ path, kind: "UNSAFE_PARENT", detail: current }]);
		parents.push({ path: current, dev: st.dev, ino: st.ino });
	}
	return parents;
}
function recheckParents(repo: string, path: string, expected: ParentSnapshot[]): void {
	const now = containedParents(repo, path);
	if (now.length !== expected.length || now.some((p, i) => p.dev !== expected[i]?.dev || p.ino !== expected[i]?.ino)) throw new Refused("UNSAFE_PARENT", [{ path, kind: "UNSAFE_PARENT", detail: "Parent directory changed during the write" }]);
}
function worktreeSides(repo: string, paths: string[], filemode: boolean): Map<string, DiskSide> {
	const sides = new Map<string, DiskSide>();
	for (const path of paths) {
		containedParents(repo, path);
		const full = join(repo, path);
		let st: Stats;
		try { st = lstatSync(full); } catch (error) { if (errno(error, "ENOENT")) { sides.set(path, null); continue; } throw error; }
		if (st.isSymbolicLink()) sides.set(path, ["120000", out(repo, ["hash-object", "--stdin"], readlinkSync(full, { encoding: "buffer" }))]);
		else if (st.isDirectory()) sides.set(path, ["dir", null]);
		else sides.set(path, [filemode && (st.mode & 0o100) !== 0 ? "100755" : "100644", out(repo, ["hash-object", "--", path])]);
	}
	return sides;
}
function sideAt(repo: string, rev: string, path: string): Side {
	const p = git(repo, ["ls-tree", "-z", rev, "--", `:(literal)${path}`]);
	if (p.code !== 0) throw new Error(`git ls-tree: ${p.err}`);
	const rec = p.out.toString("utf8").split("\0")[0];
	if (!rec) return null;
	const [mode, , oid] = rec.split("\t")[0]?.split(" ") ?? [];
	if (!mode || !oid) throw new Error("Invalid git ls-tree record");
	return [mode, oid];
}
function pathHistory(repo: string, rev: string, exclude: string, start: Side, path: string): Side[] | null {
	const text = out(repo, ["-c", "core.quotePath=false", "log", "--full-history", "--topo-order", "--reverse", "--no-renames", "--raw", "--no-abbrev", "--format=%x01%P", rev, `^${exclude}`, "--", `:(literal)${path}`]);
	const seq: Side[] = []; let prev = start;
	for (const commit of text.split("\x01").slice(1)) {
		const lines = commit.split("\n"), raws = lines.slice(1).filter(line => line.startsWith(":"));
		if ((lines[0]?.trim().split(" ").filter(Boolean).length ?? 0) > 1 || raws.length !== 1) return null;
		const raw = raws[0] ?? "", tab = raw.indexOf("\t");
		const [om, nm, oo, no] = raw.slice(1, tab).split(" ");
		if (tab < 0 || !om || !nm || !oo || !no || raw.slice(tab + 1) !== path || !equal(side(om, oo), prev)) return null;
		prev = side(nm, no); seq.push(prev);
	}
	return seq;
}
function strictPrefix(a: Side[] | null, b: Side[] | null): boolean { return a !== null && b !== null && a.length < b.length && a.every((s, i) => equal(s, b[i] ?? null)); }
function indexBody(records: { path: string; side: Side }[]): Buffer {
	return Buffer.from(records.map(({ path, side: s }) => `${s ? `${s[0]} ${s[1]}` : `0 ${ZERO}`}\t${path}\0`).join(""));
}
function resolveConflicts(repo: string, old: string, up: string, tree: string, conflicted: string[], resolutions: Readonly<Record<string, "ours" | "theirs">>): { tree: string; labels: Record<string, "ours" | "theirs"> } {
	const unused = Object.keys(resolutions).filter(p => !conflicted.includes(p)).sort();
	if (unused.length) throw new Refused("RESOLUTION_UNUSED", unused.map(path => ({ path, kind: "RESOLUTION_UNUSED" })));
	const bases = conflicted.length ? out(repo, ["merge-base", "--all", old, up]).split("\n").filter(Boolean) : [];
	const chosen: { path: string; side: Side }[] = [], labels: Record<string, "ours" | "theirs"> = {}, unresolved: ConvergeConflict[] = [];
	for (const path of conflicted) {
		const resolution = Object.hasOwn(resolutions, path) ? resolutions[path] : undefined;
		if (resolution === "ours" || resolution === "theirs") { chosen.push({ path, side: sideAt(repo, resolution === "ours" ? old : up, path) }); labels[path] = resolution; continue; }
		const starts = bases.map(b => sideAt(repo, b, path));
		let ours: Side[] | null = null, theirs: Side[] | null = null;
		if (starts.length && starts.every(s => equal(s, starts[0] ?? null))) { ours = pathHistory(repo, old, up, starts[0] ?? null, path); theirs = pathHistory(repo, up, old, starts[0] ?? null, path); }
		const conflict: ConvergeConflict = { path, kind: "CONTENT_CONFLICT", class: "true_divergence" };
		if (strictPrefix(theirs, ours)) conflict.hint = "theirs_behind";
		else if (strictPrefix(ours, theirs)) conflict.hint = "ours_behind";
		unresolved.push(conflict);
	}
	if (unresolved.length) throw new Refused("MERGE_CONFLICT", unresolved);
	if (!chosen.length) return { tree, labels };
	const idx = join(out(repo, ["rev-parse", "--absolute-git-dir"]), `git_converge.${process.pid}.${randomUUID()}.idx`), extra = { GIT_INDEX_FILE: idx };
	try {
		out(repo, ["read-tree", tree], undefined, extra);
		out(repo, ["update-index", "-z", "--index-info"], indexBody(chosen), extra);
		return { tree: out(repo, ["write-tree"], undefined, extra), labels };
	} finally { if (existsSync(idx)) unlinkSync(idx); }
}
function planConverge(repo: string, fetch: boolean, resolutions: Readonly<Record<string, "ours" | "theirs">>): Plan {
	const symbolic = git(repo, ["symbolic-ref", "-q", "HEAD"]);
	if (symbolic.code !== 0 || symbolic.out.toString().trim() !== "refs/heads/main") throw new Refused("NOT_ON_MAIN");
	if (fetch) {
		const p = git(repo, ["fetch", "--no-tags", "-q", "origin", "+refs/heads/main:refs/remotes/origin/main"]);
		if (p.code !== 0) throw new Refused("FETCH_FAILED", [{ path: "", kind: "FETCH_FAILED", detail: p.err }]);
	}
	const old = out(repo, ["rev-parse", "--verify", "refs/heads/main^{commit}"]), up = out(repo, ["rev-parse", "--verify", "refs/remotes/origin/main^{commit}"]);
	const ahead = ancestor(repo, up, old), behind = ancestor(repo, old, up);
	if ((ahead || behind) && Object.keys(resolutions).length) throw new Refused("RESOLUTION_UNUSED", Object.keys(resolutions).sort().map(path => ({ path, kind: "RESOLUTION_UNUSED" })));
	const plan: Plan = { remote: "origin", old, up, tree: null, changes: [], state: ahead ? "AHEAD" : behind ? "FAST_FORWARD" : "MERGED", filemode: true, resolutions: {} };
	if (ahead) return plan;
	let target = up;
	if (!behind) {
		const p = git(repo, ["merge-tree", "--write-tree", "-z", "--name-only", "--no-messages", old, up]);
		if (p.code !== 0 && p.code !== 1) throw new Error(`git merge-tree: ${p.err}`);
		const fields = p.out.toString("utf8").split("\0"), tree = fields[0]?.trim();
		if (!tree) throw new Error("git merge-tree did not return a tree");
		const conflicted = new Set<string>(p.code === 1 ? fields.slice(1).filter(Boolean) : []);
		// Git can merge disjoint hunks, but recurring/compatible bytes do not establish owner intent.
		// Compare whole-path sides against every merge base, not merely merge-tree's conflict list.
		for (const base of out(repo, ["merge-base", "--all", old, up]).split("\n").filter(Boolean)) {
			const ours = new Map(diffSides(repo, base, old).map(c => [c.path, c.new]));
			for (const theirs of diffSides(repo, base, up)) {
				if (ours.has(theirs.path)) conflicted.add(theirs.path);
			}
		}
		const resolved = resolveConflicts(repo, old, up, tree, [...conflicted].sort(), resolutions);
		plan.tree = resolved.tree; plan.resolutions = resolved.labels; target = resolved.tree;
	}
	const changes = diffSides(repo, old, target), paths = changes.map(c => c.path);
	plan.filemode = git(repo, ["config", "--bool", "core.filemode"]).out.toString().trim() !== "false";
	const index = indexEntries(repo, paths), disk = worktreeSides(repo, paths, plan.filemode), conflicts: ConvergeConflict[] = [];
	for (const c of changes) {
		const { path } = c;
		if (path.includes("\n") || path.includes("\ufffd") || c.old?.[0] === "160000" || c.new?.[0] === "160000") { conflicts.push({ path, kind: "UNSUPPORTED_PATH" }); continue; }
		const seen = index.get(path) ?? [];
		if (seen.some(e => e[2] !== "0")) { conflicts.push({ path, kind: "UNMERGED" }); continue; }
		const first = seen[0], idx: Side = first ? [first[0], first[1]] : null;
		const indexAction = equal(idx, c.old, plan.filemode) ? "update" : equal(idx, c.new, plan.filemode) ? "keep" : null;
		if (!indexAction) { conflicts.push({ path, kind: "STAGED_OVERLAP" }); continue; }
		const wt = disk.get(path) ?? null;
		if (wt?.[0] === "dir") conflicts.push({ path, kind: "TYPE_MISMATCH" });
		else if (equal(wt, c.old, plan.filemode)) plan.changes.push({ ...c, seen, index: indexAction, worktree: "write" });
		else if (equal(wt, c.new, plan.filemode)) plan.changes.push({ ...c, seen, index: indexAction, worktree: "keep" });
		else conflicts.push({ path, kind: "DIRTY_OVERLAP" });
	}
	if (conflicts.length) throw new Refused("OVERLAP", conflicts);
	return plan;
}
function sleep(ms: number): void { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms); }
function indexTransaction(repo: string, paths: string[], decide: (now: Entries) => { path: string; side: Side }[]): void {
	const index = resolve(repo, out(repo, ["rev-parse", "--git-path", "index"])), lock = `${index}.lock`, tmp = `${index}.git-converge.${process.pid}.${randomUUID()}`;
	let held = false;
	for (let attempt = 0; attempt < 40; attempt++) {
		try { closeSync(openSync(lock, "wx", 0o644)); held = true; break; }
		catch (error) { if (!errno(error, "EEXIST")) throw error; sleep(Math.min(50 * (attempt + 1), 500)); }
	}
	if (!held) throw new Error("git index.lock stayed held for 10 s");
	try {
		const records = decide(indexEntries(repo, paths));
		if (!records.length) return;
		if (existsSync(index)) copyFileSync(index, tmp);
		out(repo, ["update-index", "-z", "--index-info"], indexBody(records), { GIT_INDEX_FILE: tmp });
		renameSync(tmp, lock); renameSync(lock, index); held = false;
	} finally { if (existsSync(tmp)) unlinkSync(tmp); if (held) unlinkSync(lock); }
}
function setIndex(repo: string, records: IndexRecord[]): void {
	if (!records.length) return;
	indexTransaction(repo, records.map(r => r.path), now => {
		const raced = records.filter(r => !entriesEqual(now.get(r.path) ?? [], r.seen));
		if (raced.length) throw new Refused("INDEX_RACE", raced.map(r => ({ path: r.path, kind: "INDEX_RACE" })));
		return records;
	});
}
function restoreIndex(repo: string, plan: Plan, records: IndexRecord[]): string[] {
	const skipped: string[] = [];
	if (!records.length) return skipped;
	indexTransaction(repo, records.map(r => r.path), now => {
		const main = out(repo, ["rev-parse", "--verify", "refs/heads/main^{commit}"]), back: { path: string; side: Side }[] = [];
		for (const r of records) {
			const wrote: Entry[] = r.side ? [[r.side[0], r.side[1], "0"]] : [];
			const change = plan.changes.find(c => c.path === r.path);
			if (change && entriesEqual(now.get(r.path) ?? [], wrote) && equal(sideAt(repo, main, r.path), change.old)) {
				const first = r.seen[0]; back.push({ path: r.path, side: first ? [first[0], first[1]] : null });
			} else skipped.push(r.path);
		}
		return back;
	});
	return skipped;
}
function writePath(repo: string, path: string, next: Side): void {
	const parents = containedParents(repo, path, next !== null);
	const full = join(repo, path);
	if (next === null) {
		recheckParents(repo, path, parents);
		unlinkSync(full);
		let parent = dirname(full);
		while (parent !== repo && readdirSync(parent).length === 0) { rmdirSync(parent); parent = dirname(parent); }
		return;
	}
	const bytes = checkedBytes(repo, ["cat-file", "--filters", `--path=${path}`, next[1]]);
	recheckParents(repo, path, parents);
	const tmp = `${full}.git-converge.${process.pid}.${randomUUID()}.tmp`;
	try {
		recheckParents(repo, path, parents);
		if (next[0] === "120000") symlinkSync(bytes, tmp);
		else { writeFileSync(tmp, bytes, { flag: "wx" }); chmodSync(tmp, next[0] === "100755" ? 0o755 : 0o644); }
		recheckParents(repo, path, parents);
		renameSync(tmp, full);
	} finally {
		// Never follow a replacement parent while cleaning up our temporary leaf.
		try { recheckParents(repo, path, parents); if (existsSync(tmp)) unlinkSync(tmp); }
		catch (error) { if (!(error instanceof Refused) || error.reason !== "UNSAFE_PARENT") throw error; }
	}
}
function applyConverge(repo: string, plan: Plan): { new_head: string; worktree_written: number; index_updated: number; races: string[] } {
	if (plan.state === "AHEAD") return { new_head: plan.old, worktree_written: 0, index_updated: 0, races: [] };
	for (const c of plan.changes) containedParents(repo, c.path);
	const updates: IndexRecord[] = plan.changes.filter(c => c.index === "update").map(c => ({ path: c.path, seen: c.seen, side: c.new }));
	setIndex(repo, updates);
	let next: string;
	try {
		if (plan.state === "MERGED") {
			if (!plan.tree) throw new Error("Missing merge tree");
			const note = Object.entries(plan.resolutions).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([p, label]) => `\n${p}=${label}`).join("");
			next = out(repo, ["commit-tree", plan.tree, "-p", plan.old, "-p", plan.up, "-m", `Merge ${plan.remote}/main into main (git_converge)${note ? `\n\nResolved:${note}` : ""}`]);
		} else next = plan.up;
		if (git(repo, ["update-ref", "-m", "git_converge", "refs/heads/main", next, plan.old]).code !== 0) throw new RefMoved();
	} catch (error) {
		const skipped = restoreIndex(repo, plan, updates);
		if (error instanceof RefMoved) throw new RefMoved(skipped);
		if (skipped.length) throw new Error(`${error instanceof Error ? error.message : String(error)}; index restore left peer-restaged paths ${JSON.stringify(skipped)}`, { cause: error });
		throw error;
	}
	let written = 0; const races: string[] = [];
	for (const c of plan.changes) {
		if (c.worktree !== "write") continue;
		try {
			if (!equal(worktreeSides(repo, [c.path], plan.filemode).get(c.path) ?? null, c.old, plan.filemode)) { races.push(c.path); continue; }
			writePath(repo, c.path, c.new); written++;
		} catch (error) {
			if (!(error instanceof Refused) || error.reason !== "UNSAFE_PARENT") throw error;
			races.push(c.path);
		}
	}
	// A dirty unrelated path legitimately makes refresh return nonzero; it is not an apply failure.
	git(repo, ["update-index", "-q", "--refresh"]);
	return { new_head: next, worktree_written: written, index_updated: updates.length, races };
}
type ConvergeLock = { path: string; ref: string; token: string };
function liveOwner(text: string): number | null {
	const pidText = text.split("\n")[0]?.trim() ?? "", pid = Number(pidText);
	if (!pidText || !Number.isSafeInteger(pid) || pid < 0 || [...pidText].some(c => c < "0" || c > "9")) throw new Refused("CONVERGE_LOCK_UNVERIFIED", [{ path: "", kind: "CONVERGE_LOCK_UNVERIFIED", detail: "Lock owner PID is not verifiable" }]);
	try { process.kill(pid, 0); return pid; }
	catch (error) { if (errno(error, "ESRCH")) return null; if (errno(error, "EPERM")) return pid; throw error; }
}
function releaseLock(repo: string, lock: ConvergeLock): void {
	// Keep the CAS authority until the conventional PID file has been released.
	// Another conforming acquirer cannot replace that file during this interval.
	if (out(repo, ["rev-parse", "--verify", lock.ref]) !== lock.token) throw new Error("Converge lock authority changed before release");
	try {
		if (readFileSync(lock.path, "utf8") !== String(process.pid)) throw new Error("Converge PID file changed before release");
		unlinkSync(lock.path);
	} finally {
		if (git(repo, ["update-ref", "-d", lock.ref, lock.token]).code !== 0) throw new Error("Converge lock authority changed before release");
	}
}
function takeLock(repo: string): ConvergeLock {
	const path = join(out(repo, ["rev-parse", "--absolute-git-dir"]), "git_converge.lock"), ref = "refs/omp-kit/converge-lock";
	// Git serializes ref updates and compares the exact prior unique token. Unlike
	// pathname check/unlink, stale takeover cannot delete a replacement owner's lock.
	const token = out(repo, ["hash-object", "-w", "--stdin"], `${process.pid}\n${randomUUID()}\n`);
	for (let attempt = 0; attempt < 20; attempt++) {
		const observed = git(repo, ["rev-parse", "-q", "--verify", ref]);
		if (observed.code !== 0 && observed.code !== 1) throw new Error(`git rev-parse lock authority: ${observed.err}`);
		const previous = observed.code === 0 ? observed.out.toString().trim() : null;
		if (previous) {
			const owner = git(repo, ["cat-file", "blob", previous]);
			if (owner.code !== 0 || owner.out.toString().trim().split("\n").length !== 2) throw new Refused("CONVERGE_LOCK_UNVERIFIED", [{ path: "", kind: "CONVERGE_LOCK_UNVERIFIED", detail: "Lock authority token is not verifiable" }]);
			const holder = liveOwner(owner.out.toString());
			if (holder !== null) throw new Refused("CONVERGE_BUSY", [{ path: "", kind: "CONVERGE_BUSY", detail: `pid ${holder}` }]);
		}
		if (git(repo, ["update-ref", ref, token, previous ?? "0".repeat(token.length)]).code !== 0) { sleep(10); continue; }
		let heldFile = false;
		try {
			// Admission for the incumbent PID-file protocol is serialized by our CAS
			// authority. Never reclaim it on an unprotected read/check/unlink path.
			try {
				const text = readFileSync(path, "utf8");
				// A dead CAS token also proves ownership of an interrupted empty PID-file write.
				// Without that prior authority an empty file is not safely reclaimable.
				const holder = !text.trim() && previous ? null : liveOwner(text);
				if (holder !== null) throw new Refused("CONVERGE_BUSY", [{ path: "", kind: "CONVERGE_BUSY", detail: `pid ${holder}` }]);
				unlinkSync(path);
			} catch (error) { if (!errno(error, "ENOENT")) throw error; }
			const fd = openSync(path, "wx", 0o644);
			try { writeFileSync(fd, String(process.pid)); heldFile = true; } finally { closeSync(fd); }
			return { path, ref, token };
		} catch (error) {
			if (heldFile) unlinkSync(path);
			if (git(repo, ["update-ref", "-d", ref, token]).code !== 0) throw new Error("Converge lock authority changed during failed admission", { cause: error });
			throw error;
		}
	}
	throw new Refused("CONVERGE_BUSY");
}
/** Report by default. --push implies apply. Refusals preserve peer state; unexpected Git/I/O failures throw. */
export async function convergeRepository(options: ConvergeOptions): Promise<ConvergeResult> {
	const repo = resolve(options.repo), apply = options.apply === true || options.push === true, start = performance.now();
	const result: ConvergeResult = { repo, state: null, reason: null, applied: false, pushed: false, conflicts: [], elapsed_s: 0 };
	const done = (): ConvergeResult => { result.elapsed_s = Math.round((performance.now() - start)) / 1000; return result; };
	let lock: ConvergeLock | undefined;
	try {
		if (apply) lock = takeLock(repo);
		for (let attempt = 0; attempt < 3; attempt++) {
			const plan = planConverge(repo, options.fetch !== false || attempt > 0, options.resolutions ?? {});
			Object.assign(result, { state: plan.state, old: plan.old, up: plan.up, paths: plan.changes.length, resolutions: plan.resolutions });
			if (!apply) return done();
			try { Object.assign(result, applyConverge(repo, plan), { applied: true }); }
			catch (error) { if (!(error instanceof RefMoved)) throw error; if (error.restore_skipped.length) (result.restore_skipped ??= []).push(...error.restore_skipped); continue; }
			if (!options.push) return done();
			const head = out(repo, ["rev-parse", "refs/heads/main"]);
			const publishedCommits = Number(out(repo, ["rev-list", "--count", `${plan.up}..${head}`]));
			if (options.beforePush) {
				const admission = await options.beforePush(head, plan.up);
				if (!admission.allow) {
					result.state = "REFUSED";
					result.reason = admission.reason ?? "PRE_PUSH_REFUSED";
					return done();
				}
			}
			const pushed = git(repo, ["push", "--porcelain", plan.remote, `${head}:refs/heads/main`]);
			const remote = out(repo, ["ls-remote", plan.remote, "refs/heads/main"]).split("\t")[0];
			if (remote === head) { result.pushed = true; result.remote_after = head; result.published_commits = publishedCommits; return done(); }
			if (remote === plan.up) {
				result.reason = "PUSH_FAILED";
				result.push_error = pushed.err.slice(-400);
				result.remote_after = remote;
				return done();
			}
			if (options.beforePush) {
				result.state = "REFUSED";
				result.reason = "PUSH_REJECTED";
				result.push_error = pushed.err.slice(-400);
				result.remote_after = remote;
				return done();
			}
		}
		result.reason = "RETRIES_EXHAUSTED"; return done();
	} catch (error) {
		if (!(error instanceof Refused)) throw error;
		result.state = "REFUSED"; result.reason = error.reason; result.conflicts = error.conflicts; return done();
	} finally { if (lock) releaseLock(repo, lock); }
}
export async function convergeCommand(request: ParsedCommand): Promise<CliResult> {
	const usage = (message: string): CliResult => ({ code: 2, data: { overall: "NOT_RUN" }, errors: [{ code: "CONVERGE_USAGE", message, remediation: "Use converge --repo PATH [--apply] [--push] [--no-fetch] [--ours PATH]... [--theirs PATH]..." }], verification: "NOT_RUN" });
	const repo = request.flags.get("--repo");
	if (typeof repo !== "string" || !repo) return usage("--repo requires a repository path");
	const resolutions: Record<string, "ours" | "theirs"> = Object.create(null);
	// The CLI preserves original converge arguments here, including cross-flag declaration order.
	const args = request.commandArgs ?? [];
	for (let i = 0; i < args.length; i++) {
		const arg = args[i];
		const flag = arg?.startsWith("--ours=") ? "--ours" : arg?.startsWith("--theirs=") ? "--theirs" : arg;
		if (flag !== "--ours" && flag !== "--theirs") continue;
		const path = arg === flag ? args[++i] : arg?.slice(flag.length + 1);
		if (!path || path.startsWith("--")) return usage(`${flag} needs a path`);
		resolutions[path] = flag === "--ours" ? "ours" : "theirs";
	}
	if (!args.length && (request.flags.has("--ours") || request.flags.has("--theirs"))) return usage("Owner declarations require their original ordered arguments");
	try {
		const result = await convergeRepository({ repo, apply: request.flags.has("--apply"), push: request.flags.has("--push"), fetch: !request.flags.has("--no-fetch"), resolutions });
		return { code: result.state === "REFUSED" ? 1 : request.flags.has("--push") && !result.pushed ? 3 : 0, data: { ...result }, verification: "PERFORMED" };
	} catch (error) {
		return { code: 3, data: { overall: "UNVERIFIED" }, errors: [{ code: "CONVERGE_FAILED", message: error instanceof Error ? error.message : String(error), remediation: "Inspect the reported Git/I/O failure and repository state before retrying; do not force-push." }], verification: "UNVERIFIED" };
	}
}
