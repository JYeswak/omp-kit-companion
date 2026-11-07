import { randomUUID } from "node:crypto";
import { isAbsolute, join } from "node:path";

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
interface Authority {
	grants: Map<string, Grant>;
}
const KEY = Symbol.for("omp-kit.native-identity.v1");
const shared = globalThis as typeof globalThis & { [key: symbol]: Authority };
const authority = shared[KEY] ??= { grants: new Map() };
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

/** The server still requires a separately registered name. Never borrow the inherited parent's hold. */
export function nativeReservationIdentity(ctx: NativeContext, claimed: unknown): string {
	const identity = nativeIdentity(ctx);
	if (!identity) throw new Error("NATIVE_IDENTITY_UNBOUND: child reservation requires an authenticated spawn and session");
	if (typeof claimed !== "string" || claimed.toLowerCase() !== identity.id.toLowerCase()) throw new Error("AM_IDENTITY_MISMATCH: a native child may reserve or release only under its own registered child name, never its inherited parent name");
	return identity.id;
}
