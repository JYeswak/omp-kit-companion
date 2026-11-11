import { execFile } from "node:child_process";
import type { ExecFileException } from "node:child_process";
import { constants } from "node:fs";
import type { Stats } from "node:fs";
import { promisify } from "node:util";
import { open, realpath, lstat, readlink } from "node:fs/promises";
import { basename, dirname, join, relative, resolve } from "node:path";
import { resolveFilesystemWriteTarget } from "./scratch.ts";
import type { FleetGuardBlock, FleetGuardContext, FleetGuardEvent } from "./scratch.ts";
import { pathToFileURL } from "node:url";
import { resolveOmpIdentity } from "../paths.ts";
import { loadFactor } from "../kitlib/load.ts";
import { parseOwnerFile } from "../scratch.ts";

const LIMIT = 1_048_576;
const INDEX_LIMIT = 8 * LIMIT;
const GIT_OBJECT_ID = /^[0-9a-f]{40,64}$/;
// CFSCOPY1: a tracked-source copy is the one refusal whose next step is not "move it home": the agent wanted an
// isolated copy of the repo to change, so the refusal names the tool that gives one (CFS hit it ~60 times a day).
const SEPARATE_CHECKOUT = " To change tracked source in isolation, edit it in a separate checkout of the repository (for example `ovnfs new --name <x>` from the repo, which gives a full checkout outside scratch), not a copy under scratch.";
const refuse = (detail: string): FleetGuardBlock => ({ block: true,
	reason: `fleet-guard scratch-is-not-a-home: ${detail}. Keep canonical source, reusable scripts, prompts and packets in their repository home; scratch is for disposable synthetic inputs.${detail.startsWith("tracked-source-copy") ? SEPARATE_CHECKOUT : ""}` });
const inside = (root: string, path: string): boolean => path === root || path.startsWith(`${root}/`);

/** One-line admission notice for an owned-scratch path whose written bytes cannot be read. */
function unreadableScratchNotice(scratch: string, physical: string): string {
	return `fleet-guard scratch-is-not-a-home: admitted a scratch edit with no readable written bytes for ${relative(scratch, physical).replaceAll("\n", " ")}; nothing durable was judged.`;
}

/** Missing live facts block the write, but do not establish a policy match. */
export type DurabilityBlock = FleetGuardBlock & (
	{ status: "UNKNOWN"; read: string } | { status?: never; read?: never }
);

class UnknownReadError extends Error {
	constructor(readonly read: string, cause: unknown, detail = cause instanceof Error ? cause.message : String(cause)) {
		super(detail, { cause });
	}
}

async function readBounded(path: string, limit = LIMIT): Promise<string> {
	const file = await open(path, constants.O_RDONLY | constants.O_NONBLOCK);
	try {
		const stat = await file.stat();
		if (!stat.isFile() || stat.size > limit) throw new Error("file facts exceed admission limit");
		const bytes = Buffer.alloc(stat.size + 1);
		const { bytesRead } = await file.read(bytes, 0, bytes.length, 0);
		if (bytesRead > limit || bytesRead !== stat.size) throw new Error("file facts exceed admission limit or changed during read");
		return bytes.subarray(0, bytesRead).toString("utf8");
	} finally { await file.close(); }
}

const GIT_BASE_DEADLINE_MS = 2_000;

/** One git read's bound (GUARDGITLOAD1): 2 s at quiet load, scaled by the shared
 * host-load factor exactly as land.ts scales its `am` bound, so a read that answers
 * inside the scaled bound is judged instead of UNKNOWN. A read that never answers
 * still throws UnknownReadError naming the read, killed and signal. */
export function gitDeadlineMs(): number {
	return Math.ceil(GIT_BASE_DEADLINE_MS * loadFactor());
}

// No inherited Git redirection, lazy-fetch, pager, credential or network operations.
async function git(repo: string, args: string[], input?: string, retryFirstExec = false): Promise<string> {
	const env = { ...process.env };
	for (const key of Object.keys(env)) if (key.startsWith("GIT_")) delete env[key];
	Object.assign(env, { GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null", GIT_TERMINAL_PROMPT: "0", GIT_NO_LAZY_FETCH: "1", GIT_OPTIONAL_LOCKS: "0" });
	const end = args.indexOf("--");
	const read = `git ${(end < 0 ? args : args.slice(0, end)).join(" ")}`;
	for (let attempt = 0; ; attempt++) {
		const started = performance.now();
		const deadlineMs = gitDeadlineMs();
		let stdinFailed = false;
		const running = promisify(execFile)("git", ["--no-pager", "-c", "core.fsmonitor=false", "-c", "core.hooksPath=/dev/null", "-C", repo, ...args],
			{ env, timeout: deadlineMs, maxBuffer: INDEX_LIMIT, encoding: "utf8" });
		running.child.stdin?.on("error", () => { stdinFailed = true; running.child.kill(); });
		running.child.stdin?.end(input);
		try { return (await running).stdout; }
		catch (cause) {
			const error = cause as ExecFileException & { stderr?: string };
			// GUARDGITLOAD1: fresh executable startup measured 340/478/490 ms p50/p95/max
			// at load 16-17; GUARDDIAG1 also captured SIGTERM at 2004 ms. The per-read
			// bound above already scales with host load; retry only the admission's
			// first read once. A persistent hang still refuses after two scaled
			// attempts; all later reads get one.
			if (retryFirstExec && attempt === 0 && !stdinFailed && error.killed === true
				&& error.signal === "SIGTERM" && error.code === null && performance.now() - started >= deadlineMs) continue;
			// Keep the original error as cause; like git.ts firstLine(), bound stderr to 200 characters.
			const stderr = (error.stderr ?? "").slice(0, 200).split("\n", 1)[0] ?? "";
			throw new UnknownReadError(read, error, `git exec failed: killed=${error.killed ?? "UNKNOWN"}`
				+ ` signal=${error.signal === undefined ? "UNKNOWN" : error.signal}`
				+ ` code=${error.code === undefined ? "UNKNOWN" : error.code} stderr=${JSON.stringify(stderr)}`);
		}
	}
}

// SCRATCHOWNERFORM1 (ompkit-ma3sn): the bound is the work this comparison may do, not the repository's size. Real
// overload (an index past WORKING_COPY_ENTRY_LIMIT, or lstat time past the budget) still refuses, fail closed.
const WORKING_COPY_ENTRY_LIMIT = 200_000;
const WORKING_COPY_STAT_BUDGET_MS = 1_500;
const STAT_BATCH = 64;
const HASH_BATCH = 256;

async function workingCopyMatches(repo: string, content: string, hash: string): Promise<boolean> {
	const tracked = (await git(repo, ["ls-files", "-z"])).split("\0").filter(Boolean);
	if (tracked.length > WORKING_COPY_ENTRY_LIMIT) throw new Error("materialized source facts exceed admission limit");
	const size = Buffer.byteLength(content);
	const entries = tracked.filter(candidate => !inside("var/agent-tmp", candidate));
	const deadline = Date.now() + WORKING_COPY_STAT_BUDGET_MS;
	const candidates: string[] = [];
	for (let start = 0; start < entries.length; start += STAT_BATCH) {
		if (Date.now() > deadline) throw new UnknownReadError("materialized canonical source lstat", new Error("materialized source facts exceed admission time budget"));
		const facts = await Promise.all(entries.slice(start, start + STAT_BATCH).map(async candidate => {
			const path = join(repo, candidate);
			if (!inside(repo, path)) throw new Error("materialized source path escapes its repository");
			try { return { candidate, path, stat: await lstat(path) }; }
			catch (error) {
				if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
				throw new UnknownReadError("materialized canonical source lstat", error);
			}
		}));
		for (const fact of facts) {
			if (!fact) continue;
			if (fact.stat.isSymbolicLink()) {
				if (await readlink(fact.path) === content) return true;
			} else if (fact.stat.isFile() && fact.stat.size === size) candidates.push(fact.candidate);
		}
	}
	for (let start = 0; start < candidates.length; start += HASH_BATCH) {
		const batch = candidates.slice(start, start + HASH_BATCH);
		const hashes = (await git(repo, ["hash-object", "--no-filters", "--", ...batch])).trimEnd().split("\n");
		if (hashes.length !== batch.length || hashes.some(value => !GIT_OBJECT_ID.test(value)))
			throw new Error("materialized source blob identities are unavailable");
		if (hashes.includes(hash)) return true;
	}
	return false;
}


export interface Target { path: string; content?: string; replacement?: { old: string; next: string; all: boolean }; added?: string; movedFrom?: string }
/** Every filesystem target a write/edit payload names, through OMP's native edit inspection for patch payloads. */
export async function targets(event: FleetGuardEvent): Promise<Target[]> {
	const input = event.input;
	if (input && typeof input === "object") {
		const record = input as Record<string, unknown>;
		const path = record.path ?? record.file ?? record.file_path;
		if (typeof path === "string") {
			if (event.toolName === "write") return [{ path, content: typeof record.content === "string" ? record.content : undefined }];
			// The current omp replace schema names its strings old_string/new_string (older seats sent oldText/newText).
			const oldText = record.oldText ?? record.old_string;
			const newText = record.newText ?? record.new_string;
			if (typeof oldText === "string" && typeof newText === "string")
				return [{ path, replacement: { old: oldText, next: newText, all: record.replace_all === true } }];
			// OMP patch-mode edits carry unified diffs: judge the lines they add.
			if (Array.isArray(record.edits)) {
				const targets: Target[] = [];
				const added = addedFromDiffs(record.edits);
				if (added !== undefined) targets.push({ path, added });
				// A patch-mode rename writes the move source's bytes to its destination,
				// so each destination is its own target carrying its source.
				for (const edit of record.edits) {
					const rename = (edit as { rename?: unknown } | null | undefined)?.rename;
					if (typeof rename === "string" && rename !== "") targets.push({ path: rename, movedFrom: path });
				}
				if (targets.length > 0) return targets;
			}
			return [{ path }];
		}
		const patch = record.patch ?? record.input ?? record._input;
		if (typeof patch === "string") return patchTargets(patch);
		if (Array.isArray(record.paths)) return record.paths.filter((path): path is string => typeof path === "string").map(path => ({ path }));
	}
	if (typeof input === "string") return patchTargets(input);
	return [];
}

// Use the same native target inspection as OMP's approval boundary; in particular,
// move destinations are writes even when their source section is outside scratch.
async function patchTargets(patch: string): Promise<Target[]> {
	if (Buffer.byteLength(patch) > LIMIT) throw new Error("edit payload exceeds admission limit");
	const nativeRoot = resolveOmpIdentity().nativeRoot;
	if (!nativeRoot) throw new Error("native edit target inspection is unavailable");
	// The owning OMP installation selects this module at runtime; it is not a kit dependency.
	const native = await import(pathToFileURL(join(nativeRoot, "native", "index.js")).href);
	if (typeof native.editInspect !== "function") throw new Error("native edit target inspection is unavailable");
	for (const mode of ["hashline", "apply_patch"]) {
		const inspection = native.editInspect(mode, JSON.stringify({ input: patch }));
		if (!Array.isArray(inspection.paths) || !Array.isArray(inspection.fileOps))
			throw new Error("native edit target inspection is incomplete");
		const paths = [...inspection.paths];
		for (const operation of inspection.fileOps) if (operation.kind === "move") paths.push(operation.to);
		if (paths.length === 0) continue;
		if (paths.some(target => typeof target !== "string" || !target)) throw new Error("native edit targets are unavailable");
		return [...new Set<string>(paths)].map(path => ({ path }));
	}
	throw new Error("native edit targets are unavailable");
}

/** Added lines of unified diffs in an omp patch-mode `edits` array, or undefined when
 * the edits add nothing (a pure removal writes no durable bytes to the path). */
function addedFromDiffs(edits: unknown[]): string | undefined {
	const rows: string[] = [];
	for (const edit of edits) {
		const diff = (edit as { diff?: unknown } | null | undefined)?.diff;
		if (typeof diff !== "string") continue;
		for (const line of diff.split("\n")) {
			if (line.startsWith("+") && !line.startsWith("+++")) rows.push(line.slice(1));
		}
	}
	return rows.length > 0 ? `${rows.join("\n")}\n` : undefined;
}

// EDITPAYLOAD1: omp's current edit payload is one hashline `input` string (`[PATH#TAG]`
// headers, `PUT`/`CUT` ops, `+` body rows; see the installed omp edit schemas). A section's
// `+` rows are its readable added lines even when the engine simulation below yields no
// bytes for the path; a section with none (delete, move source) writes nothing durable.
// Tags are engine-hex like the reader shows (HASHLINE_FILE_TAG_RE in omp's tool-event-input).
const HASHLINE_HEADER = /^\[([^[\]]+)#([0-9A-Fa-f]{4})\]$/;
export function addedFromHashline(patch: string, cwd: string, candidates: readonly string[]): string | undefined {
	if (!patch.startsWith("*** Begin Patch")) return undefined;
	const sections: Array<{ raw: string; rows: string[] }> = [];
	let current: string[] | undefined;
	for (const line of patch.split("\n")) {
		const header = HASHLINE_HEADER.exec(line);
		if (header) { current = []; sections.push({ raw: header[1]!, rows: current }); continue; }
		if (line === "*** End Patch" || line === "*** Begin Patch") { current = undefined; continue; }
		// Body rows start with `+` and are otherwise verbatim; op lines (`PUT`/`CUT`/`MV`/`REM`,
		// including the `PUT N*:` / `PUT >N*:` block forms and `@name` pastes) never do.
		if (current !== undefined && line.startsWith("+")) current.push(line.slice(1));
	}
	const matched: string[] = [];
	for (const { raw, rows } of sections) {
		if (rows.length === 0) continue;
		let resolved: string;
		try { resolved = resolve(cwd, raw); } catch { continue; }
		// Several spellings can name one file (relative and absolute headers side by side);
		// every matching section's rows are added lines of that file.
		if (candidates.includes(resolved)) matched.push(...rows);
	}
	// The trailing newline is fallback-only: exact simulated bytes win whenever they exist,
	// and this approximation only feeds the judgment when they do not.
	return matched.length > 0 ? `${matched.join("\n")}\n` : undefined;
}

/** The patch text of an edit payload, when it is one (string or input/patch field). */
function patchText(event: FleetGuardEvent): string | undefined {
	const input = event.input;
	if (typeof input === "string") return input;
	if (!input || typeof input !== "object") return undefined;
	const record = input as Record<string, unknown>;
	if (typeof (record.path ?? record.file ?? record.file_path) === "string") return undefined;
	const patch = record.patch ?? record.input ?? record._input;
	return typeof patch === "string" ? patch : undefined;
}

/**
 * PAYLOADSIM1: final bytes of every file a hashline patch writes, computed by OMP's own edit engine
 * (native EditSession) against the files' current bytes, in memory: the host writer only records the
 * requested content and never touches disk. A patch the engine rejects (stale tag, bad anchor) writes
 * nothing, so `rejected` is set and the caller lets the real tool report its own error (EDITREJECT1:
 * CFS seats got 79 "content cannot be established" refusals in 24 h on 2026-11-10 instead of the
 * engine's stale-tag message, and retried blind).
 */
async function simulatedContents(patch: string, cwd: string, paths: readonly string[]): Promise<{ contents: Map<string, string>; rejected: boolean }> {
	const contents = new Map<string, string>();
	const unavailable = { contents, rejected: false };
	const nativeRoot = resolveOmpIdentity().nativeRoot;
	if (!nativeRoot) return unavailable;
	// Runtime-selected like patchTargets: the owning OMP installation provides this module.
	const native = await import(pathToFileURL(join(nativeRoot, "native", "index.js")).href);
	if (typeof native.EditStore !== "function" || typeof native.EditSession !== "function") return unavailable;
	const store = new native.EditStore();
	for (const path of paths) store.recordSnapshotFile(resolve(cwd, path));
	const session = new native.EditSession(store, { cwd, mode: "hashline", allowFuzzy: false, fuzzyThreshold: 1,
		enforceSeenLines: false, maxColumns: 0, blockAutoGenerated: false, planActive: false, urlSchemes: [],
		urlAliasSchemes: [], planWritableRoots: [], homeDir: cwd, rawInput: true }, null, null);
	try {
		session.setArgsJson(patch);
		session.finish();
		const requested: { path: string; moveTo?: string; content?: string }[] = [];
		const outcome = await session.apply({ lspFlush: false }, async (_error: Error | null, request: { path: string; moveTo?: string; content?: string }) => {
			requested.push(request);
			return { written: request.content ?? "" };
		});
		if (outcome.isError) return { contents, rejected: true };
		for (const request of requested) if (typeof request.content === "string") contents.set(request.moveTo ?? request.path, request.content);
	} finally { session.close(); }
	return { contents, rejected: false };
}

/** Physical path of a possibly-missing target: the nearest existing ancestor's realpath plus the missing tail. */
export async function physicalTarget(path: string): Promise<string> {
	const tail: string[] = [];
	let current = path;
	for (let depth = 0; depth < 128; depth++) {
		try { return join(await realpath(current), ...tail.reverse()); }
		catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
			if (dirname(current) === current) throw error;
			tail.push(basename(current)); current = dirname(current);
		}
	}
	throw new Error("path depth exceeds admission limit");
}

/** Ordered after scratch.check; reads local filesystem/index facts, never trusts isTrackedPath overrides.
 * Exact indexed path/blob identity is mechanical evidence, not semantic intent detection.
 * No cache: an index-only transition must affect the very next admission.
 */
export async function check(event: FleetGuardEvent, context: FleetGuardContext): Promise<DurabilityBlock | undefined> {
	const cwd = context.cwd ?? (typeof event.cwd === "string" && event.cwd ? event.cwd : process.cwd());
	// Ownership metadata is written only by the native scratch lifecycle. Tool
	// payloads (including shell redirection, cp/mv, and in-place sed) must not
	// replace or adopt a live marker.
	if (event.toolName === "bash") return undefined;
	if (event.toolName !== "write" && event.toolName !== "edit") return undefined;
	let read = "filesystem targets from tool payload";
	try {
		const entries = await targets(event);
		if (entries.length === 0) return refuse("filesystem targets cannot be established from this payload variant");
		// SCRATCHVARIANT1: codex seats deliver an edit-shaped patch as a write event
		// (`input` hashline string, no `path`/`content` fields). patchText already
		// returns undefined for path-carrying inputs, so reading it for every tool
		// only opens the patch-carrying variant; ordinary writes are untouched.
		const patch = patchText(event);
		let simulated: { contents: Map<string, string>; rejected: boolean } | undefined;
		let referenceRepo: string | undefined;
		for (const entry of entries) {
			const path = resolveFilesystemWriteTarget(cwd, entry.path, context);
			if (path === undefined) continue;
			if (/^ssh:\/\//i.test(entry.path)) {
				if (path.includes("/var/agent-tmp/")) return refuse("remote scratch repository facts are unavailable");
				continue;
			}
			read = "scratch target realpath";
			const physical = await physicalTarget(path);
			const marker = `/${join("var", "agent-tmp")}/`;
			const lexicalScratch = path.includes(marker);
			if (!physical.includes(marker) && !lexicalScratch) continue;
			// The native caller's repository is the reference, never a nested .git
			// created beneath the destination. A synthetic repository may itself
			// live in an owned test directory without making its canonical files copies.
			read = "calling repository realpath";
			referenceRepo ??= await realpath((await git(cwd, ["rev-parse", "--show-toplevel"], undefined, true)).trimEnd());
			const repo = referenceRepo;
			const scratchRoot = join(repo, "var", "agent-tmp");
			if (inside(repo, physical) && !inside(scratchRoot, physical)) {
				if (lexicalScratch && (!inside(repo, path) || inside(scratchRoot, path)))
					return refuse("scratch path escapes its calling repository's scratch root");
				continue;
			}
			if (!inside(scratchRoot, physical)) return refuse("scratch path does not belong to the calling repository");
			const beneath = relative(scratchRoot, physical).split("/");
			if (beneath.length < 2) return refuse("scratch write has no owned session child");
			const scratch = join(scratchRoot, beneath[0]!);
			const ownerPath = join(scratch, ".owner");
			read = "scratch ownership metadata lstat";
			// SCRATCHNEW1: a missing .owner is not an unreadable fact, it is a dir nobody made with `scratch new`
			// (CFS: 14 UNKNOWN refusals in 3 h, each agent retrying the same hand-made dir). Name the command.
			const ownerStat = await lstat(ownerPath).catch(error => {
				if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
				throw error;
			});
			if (ownerStat === null) return refuse(`var/agent-tmp/${beneath[0]} was not created by \`omp-kit scratch new\` (it has no .owner). Run \`omp-kit scratch new --label ${beneath[0]!.replace(/[^A-Za-z0-9._-]/g, "-").slice(0, 40)} --json\` in this repository and write under the dir it prints`);
			if (ownerStat.isSymbolicLink()) return refuse("scratch ownership metadata is a symlink");
			// The one owner parser the kit writes against: the seat owner (agent/session/bin) and the JSON owner
			// from `omp-kit scratch new` are both owned scratch, not invalid metadata (ompkit-26xhq).
			read = "scratch ownership metadata read";
			const owner = parseOwnerFile(await readBounded(ownerPath, 4096));
			if (owner === null) return refuse("scratch ownership metadata is invalid");
			read = "scratch owner repository realpath";
			const ownerRepo = await realpath(owner.repo).catch(error => {
				if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
				throw error;
			});
			if (!Number.isInteger(owner.pid) || owner.pid < 1 || !Number.isFinite(Date.parse(owner.createdAt)) || ownerRepo !== repo)
				return refuse("scratch ownership metadata does not identify this repository");
			const snapshot = await git(repo, ["ls-files", "--stage", "-z"]);
			const canonical = relative(scratch, physical);
			const blobs = new Set<string>();
			for (const row of snapshot.split("\0")) {
				if (!row) continue;
				const match = /^(\d{6}) ([0-9a-f]{40,64}) ([0-3])\t([\s\S]+)$/.exec(row);
				if (!match) return refuse("Git index facts are unsupported");
				if (inside("var/agent-tmp", match[4]!)) continue;
				if (match[4] === canonical || canonical.endsWith(`/${match[4]}`)) return refuse("tracked-source-copy path matches the canonical Git index");
				blobs.add(match[2]!);
			}
			let content = entry.content;
			if (content === undefined && !entry.replacement && patch !== undefined) {
				read = "edit result simulation";
				simulated ??= await simulatedContents(patch, cwd, entries.map(target => target.path));
				// EDITREJECT1: the engine refuses this patch, so the real tool writes nothing; its own error names the fix.
				if (simulated.rejected) continue;
				content = simulated.contents.get(path) ?? simulated.contents.get(physical);
			}
			if (entry.replacement) {
				read = "scratch edit content read";
				const before = await readBounded(physical);
				const beforeHash = (await git(repo, ["hash-object", "--stdin", "--no-filters"], before)).trim();
				if (blobs.has(beforeHash)) return refuse("tracked-source-copy existing content matches the canonical Git index");
				const { old, next, all } = entry.replacement;
				if (!old || !before.includes(old) || (!all && before.indexOf(old) !== before.lastIndexOf(old))) return refuse("edit replacement facts are ambiguous");
				content = all ? before.split(old).join(next) : before.replace(old, () => next);
			}
			if (content === undefined) {
				// EDITPAYLOAD1: a hashline section's added rows (or a patch-mode diff's) are readable even
				// when the engine simulation yields no bytes for the path, so the durable-content judgment
				// below still runs on them. A path with no readable added lines (delete, move source) writes
				// nothing durable to that path; scratch is disposable, so an edit is admitted with a one-line
				// notice while content the guard can read is still judged below. A content-less write stays
				// refused (DONEGUARD1 pins the fail-closed write): it names no edit payload variant.
				// SCRATCHVARIANT1: the added-lines fallback runs for every patch-carrying
				// event (patch is undefined for ordinary writes), so a codex write
				// variant is judged on the bytes its patch adds, exactly like an edit.
				const added = entry.added ?? (patch !== undefined ? addedFromHashline(patch, cwd, [path, physical]) : undefined);
				if (added !== undefined) {
					content = added;
				} else if (entry.movedFrom !== undefined) {
					// A patch-mode rename writes the move source's bytes to this path; judge them
					// the way the simulator judges a hashline move destination. A missing source
					// moves nothing, so like other unreadable scratch edits it is admitted with notice.
					read = "scratch move source read";
					try {
						content = await readBounded(resolve(cwd, entry.movedFrom));
					} catch (error) {
						if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
					}
				}
				if (content === undefined) {
					// SCRATCHVARIANT1: a patch-carrying write whose bytes truly cannot be
					// read (delete, move source, non-hashline patch) is admitted with the
					// same one-line notice as an edit. A write naming no payload variant
					// at all (no content, no patch) stays refused above.
					if (event.toolName !== "edit" && patch === undefined) return refuse("scratch edit/write content cannot be established from this payload variant");
					context.warn?.(unreadableScratchNotice(scratch, physical));
					continue;
				}
			}
			if (Buffer.byteLength(content) > LIMIT) return refuse("scratch content exceeds admission limit");
			if (/^#!/.test(content) || /\.sh$/i.test(physical)) return refuse("rerunnable script belongs in a repository home");
			const segments = canonical.split("/");
			if (segments.some(segment => segment.toLowerCase().includes("prompt") || segment.toLowerCase().startsWith("packet")) ||
				segments.includes("skills") || (segments[segments.length - 2] === "rules" && physical.endsWith(".md")))
				return refuse("instruction or packet artifact belongs in a repository home");
			// Empty sentinels carry no source bytes; matching an empty tracked file
			// is not copy evidence. Ownership, canonical paths and artifact checks still apply.
			if (content === "") continue;
			const hash = (await git(repo, ["hash-object", "--stdin", "--no-filters"], content)).trim();
			if (!GIT_OBJECT_ID.test(hash)) return refuse("Git blob identity is unavailable");
			if (blobs.has(hash)) return refuse("tracked-source-copy content matches the canonical Git index");
			read = "materialized canonical source";
			if (await workingCopyMatches(repo, content, hash)) return refuse("tracked-source-copy content matches materialized canonical source");
		}
		return undefined;
	} catch (error) {
		if (error instanceof UnknownReadError) read = error.read;
		return { ...refuse(`UNKNOWN required read ${read} unavailable (${error instanceof Error ? error.message : String(error)})`),
			status: "UNKNOWN", read };
	}
}
