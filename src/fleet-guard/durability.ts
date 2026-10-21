import { execFile } from "node:child_process";
import { constants } from "node:fs";
import type { Stats } from "node:fs";
import { promisify } from "node:util";
import { open, realpath, lstat, readlink } from "node:fs/promises";
import { basename, dirname, join, relative } from "node:path";
import { resolveFilesystemWriteTarget, type FleetGuardBlock, type FleetGuardContext, type FleetGuardEvent } from "./scratch.ts";
import { pathToFileURL } from "node:url";
import { resolveOmpIdentity } from "../paths.ts";

const LIMIT = 1_048_576;
const INDEX_LIMIT = 8 * LIMIT;
const GIT_OBJECT_ID = /^[0-9a-f]{40,64}$/;
const refuse = (detail: string): FleetGuardBlock => ({ block: true,
	reason: `fleet-guard scratch-is-not-a-home: ${detail}. Keep canonical source, reusable scripts, prompts and packets in their repository home; scratch is for disposable synthetic inputs.` });
const inside = (root: string, path: string): boolean => path === root || path.startsWith(`${root}/`);

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

// No inherited Git redirection, lazy-fetch, pager, credential or network operations.
function git(repo: string, args: string[], input?: string): Promise<string> {
	const env = { ...process.env };
	for (const key of Object.keys(env)) if (key.startsWith("GIT_")) delete env[key];
	Object.assign(env, { GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null", GIT_TERMINAL_PROMPT: "0", GIT_NO_LAZY_FETCH: "1", GIT_OPTIONAL_LOCKS: "0" });
	const running = promisify(execFile)("git", ["--no-pager", "-c", "core.fsmonitor=false", "-c", "core.hooksPath=/dev/null", "-C", repo, ...args],
		{ env, timeout: 2_000, maxBuffer: INDEX_LIMIT, encoding: "utf8" });
	running.child.stdin?.on("error", () => { running.child.kill(); });
	running.child.stdin?.end(input);
	return running.then(result => result.stdout);
}

async function workingCopyMatches(repo: string, content: string, hash: string): Promise<boolean> {
	const tracked = (await git(repo, ["ls-files", "-z"])).split("\0").filter(Boolean);
	if (tracked.length > 1024) throw new Error("materialized source facts exceed admission limit");
	const size = Buffer.byteLength(content);
	const candidates: string[] = [];
	for (const candidate of tracked) {
		if (inside("var/agent-tmp", candidate)) continue;
		const path = join(repo, candidate);
		if (!inside(repo, path)) throw new Error("materialized source path escapes its repository");
		let stat: Stats;
		try { stat = await lstat(path); }
		catch (error) {
			if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
			throw error;
		}
		if (stat.isSymbolicLink()) {
			if (await readlink(path) === content) return true;
		} else if (stat.isFile() && stat.size === size) candidates.push(candidate);
	}
	if (candidates.length === 0) return false;
	const hashes = (await git(repo, ["hash-object", "--no-filters", "--", ...candidates])).trimEnd().split("\n");
	if (hashes.length !== candidates.length || hashes.some(value => !GIT_OBJECT_ID.test(value)))
		throw new Error("materialized source blob identities are unavailable");
	return hashes.includes(hash);
}


interface Target { path: string; content?: string; replacement?: { old: string; next: string; all: boolean } }
async function targets(event: FleetGuardEvent): Promise<Target[]> {
	const input = event.input;
	if (input && typeof input === "object") {
		const record = input as Record<string, unknown>;
		const path = record.path ?? record.file ?? record.file_path;
		if (typeof path === "string") {
			if (event.toolName === "write") return [{ path, content: typeof record.content === "string" ? record.content : undefined }];
			if (typeof record.oldText === "string" && typeof record.newText === "string")
				return [{ path, replacement: { old: record.oldText, next: record.newText, all: record.replace_all === true } }];
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

async function physicalTarget(path: string): Promise<string> {
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
export async function check(event: FleetGuardEvent, context: FleetGuardContext): Promise<FleetGuardBlock | undefined> {
	const cwd = context.cwd ?? (typeof event.cwd === "string" && event.cwd ? event.cwd : process.cwd());
	// Ownership metadata is written only by the native scratch lifecycle. Tool
	// payloads (including shell redirection, cp/mv, and in-place sed) must not
	// replace or adopt a live marker.
	if (event.toolName === "bash") return undefined;
	if (event.toolName !== "write" && event.toolName !== "edit") return undefined;
	try {
		const entries = await targets(event);
		if (entries.length === 0) return refuse("filesystem targets cannot be established from this payload variant");
		let referenceRepo: string | undefined;
		for (const entry of entries) {
			const path = resolveFilesystemWriteTarget(cwd, entry.path, context);
			if (path === undefined) continue;
			if (/^ssh:\/\//i.test(entry.path)) {
				if (path.includes("/var/agent-tmp/")) return refuse("remote scratch repository facts are unavailable");
				continue;
			}
			const physical = await physicalTarget(path);
			const marker = `/${join("var", "agent-tmp")}/`;
			const lexicalScratch = path.includes(marker);
			if (!physical.includes(marker) && !lexicalScratch) continue;
			// The native caller's repository is the reference, never a nested .git
			// created beneath the destination. A synthetic repository may itself
			// live in an owned test directory without making its canonical files copies.
			referenceRepo ??= await realpath((await git(cwd, ["rev-parse", "--show-toplevel"])).trimEnd());
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
			if ((await lstat(ownerPath)).isSymbolicLink()) return refuse("scratch ownership metadata is a symlink");
			const owner = await readBounded(ownerPath, 4096);
			const fields = new Map<string, string>();
			for (const line of owner.trimEnd().split("\n")) {
				const match = /^(pid|label|repo|created)=(.+)$/.exec(line);
				if (!match || fields.has(match[1]!)) return refuse("scratch ownership metadata is invalid");
				fields.set(match[1]!, match[2]!);
			}
			if (fields.size !== 4 || !/^[1-9]\d*$/.test(fields.get("pid") ?? "") || !Number.isFinite(Date.parse(fields.get("created") ?? "")) ||
				await realpath(fields.get("repo")!) !== repo) return refuse("scratch ownership metadata does not identify this repository");
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
			if (entry.replacement) {
				const before = await readBounded(physical);
				const beforeHash = (await git(repo, ["hash-object", "--stdin", "--no-filters"], before)).trim();
				if (blobs.has(beforeHash)) return refuse("tracked-source-copy existing content matches the canonical Git index");
				const { old, next, all } = entry.replacement;
				if (!old || !before.includes(old) || (!all && before.indexOf(old) !== before.lastIndexOf(old))) return refuse("edit replacement facts are ambiguous");
				content = all ? before.split(old).join(next) : before.replace(old, () => next);
			}
			if (content === undefined) return refuse("scratch edit/write content cannot be established from this payload variant");
			if (Buffer.byteLength(content) > LIMIT) return refuse("scratch content exceeds admission limit");
			if (/^#!/.test(content) || /\.sh$/i.test(physical)) return refuse("rerunnable script belongs in a repository home");
			const segments = canonical.split("/");
			if (segments.some(segment => segment.toLowerCase().includes("prompt") || segment.toLowerCase().startsWith("packet")) ||
				segments.includes("skills") || (segments[segments.length - 2] === "rules" && physical.endsWith(".md")))
				return refuse("instruction or packet artifact belongs in a repository home");
			const hash = (await git(repo, ["hash-object", "--stdin", "--no-filters"], content)).trim();
			if (!GIT_OBJECT_ID.test(hash)) return refuse("Git blob identity is unavailable");
			if (blobs.has(hash)) return refuse("tracked-source-copy content matches the canonical Git index");
			if (await workingCopyMatches(repo, content, hash)) return refuse("tracked-source-copy content matches materialized canonical source");
		}
		return undefined;
	} catch (error) {
		return refuse(`required repository or payload facts unavailable (${error instanceof Error ? error.message : String(error)})`);
	}
}
