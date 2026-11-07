import { randomUUID } from "node:crypto";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

/** OMP 18.18.0 extensions/types.ts:565-581,825-826: host-owned session identity, NOT tool input.
 * structured-subagent.ts:684-695 supplies the spawn key; executor.ts:4465-4466 places the
 * child's own transcript beside its parent's artifacts. No file or environment grants authority.
 * Symbol storage is shared by separately bundled extensions in the SAME OMP process only.
 */
export interface NativeContext {
	cwd: string;
	agent?: { kind: "main" | "sub"; id?: string; parentId?: string };
	sessionManager?: { getSessionId?(): string; getSessionFile?(): string | undefined };
}
export type NativeExec = (command: string, args: string[], options?: { cwd?: string; timeout?: number }) => Promise<{ code: number; stdout: string; stderr?: string; killed?: boolean }>;
export interface NativeIdentity {
	readonly principal: string;
	readonly id: string;
	readonly parentId: string;
	readonly session: string;
	readonly transcript: string;
}
interface Grant {
	principal: string; id: string; parentId: string; parentSession: string; transcript: string;
	identity?: NativeIdentity;
}
interface Permit { sha: string; digest: string; at: number; repo: string; tracker: string }
interface Authority {
	grants: Map<string, Grant>;
	writes: Map<string, Set<string>>;
	executions: Map<string, Set<string>>;
	permits: Map<string, Permit>;
}
const KEY = Symbol.for("omp-kit.native-identity.v1");
const shared = globalThis as typeof globalThis & { [key: symbol]: Authority };
const authority = shared[KEY] ??= { grants: new Map(), writes: new Map(), executions: new Map(), permits: new Map() };
const ownSession = (ctx: NativeContext) => ctx.sessionManager?.getSessionId?.();
const safeId = (id: string) => id.length > 0 && id.length <= 128 && [...id].every(c => "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789._-".includes(c));

export function mintNativeSpawn(event: { spawnKey?: string }, ctx: NativeContext): void {
	const id = event.spawnKey;
	const parentId = ctx.agent?.id;
	const parentSession = ownSession(ctx);
	const file = ctx.sessionManager?.getSessionFile?.();
	if (!id || !safeId(id) || !parentId || !parentSession || !file?.endsWith(".jsonl") || !isAbsolute(file)) return;
	const transcript = join(file.slice(0, -6), `${id}.jsonl`);
	const key = `${parentSession}\0${id}`;
	if (!authority.grants.has(key)) authority.grants.set(key, { principal: randomUUID(), id, parentId, parentSession, transcript });
}

export function nativeIdentity(ctx: NativeContext): NativeIdentity | null {
	const agent = ctx.agent;
	const session = ownSession(ctx);
	const transcript = ctx.sessionManager?.getSessionFile?.();
	if (agent?.kind !== "sub" || !agent.id || !agent.parentId || !session || !transcript) return null;
	for (const grant of authority.grants.values()) {
		if (grant.id !== agent.id || grant.parentId !== agent.parentId || grant.transcript !== transcript || grant.parentSession === session) continue;
		if (grant.identity) return grant.identity.session === session ? grant.identity : null;
		grant.identity = Object.freeze({ principal: grant.principal, id: grant.id, parentId: grant.parentId, session, transcript });
		return grant.identity;
	}
	return null;
}

/** A worktree and its canonical checkout share this key; repo-local relative paths stay distinct. */
export async function nativeRepo(cwd: string, exec: NativeExec): Promise<{ root: string; key: string }> {
	const result = await exec("git", ["rev-parse", "--show-toplevel", "--git-common-dir"], { cwd, timeout: 10_000 });
	const lines = result.stdout.trim().split("\n");
	if (result.code !== 0 || result.killed || lines.length !== 2 || !lines[0] || !lines[1]) throw Object.assign(new Error("NATIVE_AUTHORSHIP_UNPROVEN: git repository identity unavailable"), {
		outsideRepo: !result.killed && result.code === 128 && result.stderr?.includes("not a git repository") === true,
	});
	return { root: resolve(cwd, lines[0]), key: resolve(cwd, lines[1]) };
}

/** Deliberately lexical, not a shell parser: only one fixed read/setup invocation is exempt.
 * Quoted metacharacters are refused too. Archive is not exempt: output placement is unproven.
 */
function nativeReadOnlyCommand(command: unknown): boolean {
	if (typeof command !== "string" || command.length > 65_536) return false;
	for (const char of command) if (";&|<>`$()\n\r".includes(char)) return false;
	const words = command.trim().split(" ").filter(Boolean);
	if (words[0] === "omp-kit") return words[1] === "scratch" && words[2] === "new";
	if (words[0] === "git") return ["fetch", "rev-parse", "show", "log", "diff", "status"].includes(words[1] ?? "");
	if (words[0] === "br") return ["show", "comments", "search", "ready"].includes(words[1] ?? "");
	return false;
}

/** Conservative attempted-write ownership: a failed write never creates a false independence claim. */
export async function observeNativeWrite(event: { toolName?: unknown; input?: unknown }, ctx: NativeContext, exec: NativeExec): Promise<void> {
	// Bash/eval can write without edit/write tool calls. Verifier execution in the source repo
	// therefore forfeits independence unless it is one of the fixed read/setup invocations.
	// Residual: commands are NOT parsed. A bash write by absolute path from an outside cwd is
	// unseen; verifiers must run in their own exact export and use `git -C` for source reads.
	// Eval can retain interpreter cwd/state across calls, so ANY eval forfeits independence.
	if ((event.toolName === "bash" || event.toolName === "eval") && ctx.agent?.kind === "sub") {
		const session = ownSession(ctx);
		if (!session) return;
		const input = event.input as { cwd?: unknown; command?: unknown } | undefined;
		if (event.toolName === "bash" && nativeReadOnlyCommand(input?.command)) return;
		const executions = authority.executions.get(session) ?? new Set<string>();
		if (event.toolName === "eval") executions.add("*");
		else {
			const cwd = typeof input?.cwd === "string" && input.cwd.trim() ? resolve(ctx.cwd, input.cwd) : ctx.cwd;
			try { executions.add((await nativeRepo(cwd, exec)).key); }
			catch (error) {
				// Proven repo-less cwd is the explicit outside-repo control. Unknown discovery fails closed.
				if (!(error instanceof Error) || !("outsideRepo" in error) || error.outsideRepo !== true) executions.add("*");
			}
		}
		authority.executions.set(session, executions);
		return;
	}
	if (event.toolName !== "write" && event.toolName !== "edit") return;
	const input = event.input as { path?: unknown; file_path?: unknown; patch?: unknown; diff?: unknown } | undefined;
	const paths: string[] = [];
	const path = input?.path ?? input?.file_path;
	if (typeof path === "string" && !path.includes("://")) paths.push(path);
	const patch = typeof event.input === "string" ? event.input : input?.patch ?? input?.diff;
	if (typeof patch === "string" && patch.length <= 4 * 1024 * 1024) {
		for (const line of patch.split("\n")) {
			if (line.startsWith("[")) {
				const hash = line.lastIndexOf("#");
				if (hash > 1 && line.endsWith("]")) paths.push(line.slice(1, hash));
			}
			for (const header of ["*** Update File: ", "*** Add File: ", "*** Delete File: "]) {
				if (line.startsWith(header)) paths.push(line.slice(header.length));
			}
		}
	}
	if (paths.length === 0) return;
	const session = ownSession(ctx);
	if (!session) return;
	const writes = authority.writes.get(session) ?? new Set<string>();
	for (const path of paths) {
		const absolute = resolve(ctx.cwd, path);
		writes.add(absolute);
		try {
			const repo = await nativeRepo(dirname(absolute), exec);
			const file = relative(repo.root, absolute);
			if (file !== ".." && !file.startsWith(`..${sep}`) && !isAbsolute(file)) writes.add(join(repo.key, file));
		} catch { /* Repo-less writes stay attributed by absolute path; ordinary editing is not a git gate. */ }
	}
	authority.writes.set(session, writes);
}

export function requireNativeNonAuthor(ctx: NativeContext, authors: readonly string[], repo: { root: string; key: string; files: readonly string[] }): NativeIdentity {
	const identity = nativeIdentity(ctx);
	if (!identity) throw new Error("NATIVE_IDENTITY_UNBOUND: only a spawn-minted child with its own live session may verify");
	if (authors.length === 0 || authors.some(author => author.trim().toLowerCase() === identity.id.toLowerCase())) throw new Error("NATIVE_SELF_REFUSED: caller authored this bead or its commits, or the author is unknown");
	const executions = authority.executions.get(identity.session);
	if (executions?.has("*") || executions?.has(repo.key)) throw new Error("NATIVE_UNTRACKED_EXEC: child ran write-capable bash/eval in the implementation repo, or execution provenance is unknown; use a fresh verifier running from its independent export");
	const writes = authority.writes.get(identity.session);
	if (repo.files.some(file => writes?.has(join(repo.key, file)) || writes?.has(join(repo.root, file)))) throw new Error("NATIVE_SELF_REFUSED: caller wrote implementation or fixture paths for this bead (session ownership survives renaming)");
	return identity;
}

export function rememberNativePregrade(ctx: NativeContext, bead: string, sha: string, digest: string, repo: string, tracker: string): void {
	const identity = nativeIdentity(ctx);
	if (!identity) throw new Error("NATIVE_IDENTITY_UNBOUND");
	authority.permits.set(`${identity.principal}\0${bead}`, { sha, digest, at: Date.now(), repo, tracker });
}
export function nativePregrade(ctx: NativeContext, bead: string): Permit | null {
	const identity = nativeIdentity(ctx);
	if (!identity) return null;
	const permit = authority.permits.get(`${identity.principal}\0${bead}`);
	return permit && Date.now() - permit.at <= 24 * 60 * 60 * 1000 ? permit : null;
}

/** The server still requires a separately registered name. Never borrow the inherited parent's hold. */
export function nativeReservationIdentity(ctx: NativeContext, claimed: unknown): string {
	const identity = nativeIdentity(ctx);
	if (!identity) throw new Error("NATIVE_IDENTITY_UNBOUND: child reservation requires an authenticated spawn and session");
	if (typeof claimed !== "string" || claimed.toLowerCase() !== identity.id.toLowerCase()) throw new Error("AM_IDENTITY_MISMATCH: a native child may reserve or release only under its own registered child name, never its inherited parent name");
	return identity.id;
}
