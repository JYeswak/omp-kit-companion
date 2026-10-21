import { lstatSync, realpathSync } from "node:fs";
import { isAbsolute, relative, resolve, sep } from "node:path";

export type SourceAct = "edit" | "build" | "publish";
export type SourceDisposition = "product" | "private-control" | "tracker" | "grade-export" | "unmanaged";
export interface SourceAuthority { readonly canonicalRoot: string; readonly privateRoots?: readonly string[]; readonly frozenRoots?: readonly string[]; }
export interface SourceActRequest { readonly path: string; readonly act: SourceAct; readonly disposition?: SourceDisposition; readonly exactCommit?: string; readonly readOnly?: boolean; }
export interface SourceActDecision { readonly status: "ALLOWED"; readonly act: SourceAct; readonly path: string; readonly canonicalRoot: string; readonly disposition: SourceDisposition; }
const COMMIT = /^[0-9a-f]{40,64}$/i;
function canonical(path: string, code: string): string {
	if (!isAbsolute(path) || resolve(path) !== path) throw new Error(code);
	try { const stat = lstatSync(path); if (!stat.isDirectory() && !stat.isFile()) throw new Error(code); return realpathSync(path); } catch { throw new Error(code); }
}
function under(path: string, root: string): boolean { const rel = relative(root, path); return rel === "" || (rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel)); }
function roots(values: readonly string[] | undefined): string[] { return (values ?? []).map(value => canonical(value, "SOURCE_AUTHORITY_INVALID")); }
/** Authorize before opening product source, spawning a build, or claiming delivery. */
export function authorizeSourceAct(authority: SourceAuthority, request: SourceActRequest): SourceActDecision {
	const root = canonical(authority.canonicalRoot, "SOURCE_AUTHORITY_INVALID");
	const path = canonical(request.path, "SOURCE_PATH_INVALID");
	const privateRoots = roots(authority.privateRoots), frozenRoots = roots(authority.frozenRoots);
	const disposition = request.disposition ?? "product";
	if (disposition === "grade-export") {
		if (!request.readOnly || !request.exactCommit || !COMMIT.test(request.exactCommit)) throw new Error("SOURCE_GRADE_EXPORT_NOT_READONLY");
		return { status: "ALLOWED", act: request.act, path, canonicalRoot: root, disposition };
	}
	if (disposition === "private-control" || disposition === "tracker" || disposition === "unmanaged") throw new Error(`SOURCE_ACT_NOT_PRODUCT:${disposition}`);
	if (frozenRoots.some(candidate => under(path, candidate))) throw new Error(`SOURCE_ROOT_MISMATCH: canonical target ${root}; frozen source ${path}`);
	if (!under(path, root)) throw new Error(`SOURCE_ROOT_MISMATCH: canonical target ${root}; requested source ${path}`);
	if (privateRoots.some(candidate => under(path, candidate))) throw new Error("SOURCE_ACT_NOT_PRODUCT:private-control");
	return { status: "ALLOWED", act: request.act, path, canonicalRoot: root, disposition };
}
