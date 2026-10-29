/**
 * Shared exact-source identity for tests that run from history-free archives
 * as well as git checkouts (71989, 72066: one helper for runtime.test.ts,
 * absolute-imports.test.ts and savefirst-pre-push.test.sh).
 *
 * A tree is a git checkout only when .git exists AND HEAD resolves to a
 * commit (a bare `git init` with no commits is not one; fresh gates run
 * exactly that in the archive). Otherwise a stamped full-sha
 * source_revision (export-subst, same shape packageSourceRevision enforces
 * for its stamp branch) identifies the tree; anything else is null, never a
 * silent pass. No ancestor repository is ever discovered and no process is
 * ever spawned, so staged callers stay kitlib-clean.
 */
import { existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

export type ExactSourceIdentity =
	| { readonly kind: "git" }
	| { readonly kind: "stamped"; readonly revision: string };

const HEX_SHA = /^[0-9a-f]{40}$|^[0-9a-f]{64}$/i;

function isFullSha(value: unknown): value is string {
	return typeof value === "string" && HEX_SHA.test(value);
}

/** .git directory for a repo, or the linked gitdir for a worktree; null when absent. */
function gitDirFor(sourceRoot: string): string | null {
	try {
		const dotGit = join(sourceRoot, ".git");
		const st = statSync(dotGit);
		if (st.isDirectory()) return dotGit;
		if (!st.isFile()) return null;
		const body = readFileSync(dotGit, "utf8").trim();
		const target = /^gitdir:\s*(\S+)\s*$/.exec(body)?.[1];
		if (target === undefined) return null;
		return target.startsWith("/") ? target : join(sourceRoot, target);
	} catch {
		return null;
	}
}

/** Main repo dir backing a gitdir (itself for a plain repo, via commondir for a worktree). */
function mainRepoDir(gitDir: string): string {
	try {
		const raw = readFileSync(join(gitDir, "commondir"), "utf8").trim();
		if (raw === "" || raw === ".") return gitDir;
		return raw.startsWith("/") ? raw : join(gitDir, raw);
	} catch {
		return gitDir;
	}
}

function refResolves(gitDir: string, ref: string): boolean {
	for (const base of [gitDir, mainRepoDir(gitDir)]) {
		try {
			if (isFullSha(readFileSync(join(base, ref), "utf8").trim())) return true;
		} catch {
			// fall through to packed-refs
		}
		try {
			for (const line of readFileSync(join(base, "packed-refs"), "utf8").split("\n")) {
				const m = /^([0-9a-f]{40,64})\s+(\S+)\s*$/.exec(line.trim());
				if (m !== null && m[2] === ref && isFullSha(m[1])) return true;
			}
		} catch {
			// absent packed-refs
		}
	}
	return false;
}

/** HEAD resolves to a commit object through the tree's own gitdir (worktree-aware). */
function headResolves(sourceRoot: string): boolean {
	const gitDir = gitDirFor(sourceRoot);
	if (gitDir === null) return false;
	let head: string;
	try {
		head = readFileSync(join(gitDir, "HEAD"), "utf8").trim();
	} catch {
		return false;
	}
	if (isFullSha(head)) return true;
	const ref = /^ref:\s*(\S+)\s*$/.exec(head)?.[1];
	return ref !== undefined && refResolves(gitDir, ref);
}

function stampedRevision(packageBytes: Uint8Array): string | null {
	let parsed: unknown;
	try {
		parsed = JSON.parse(Buffer.from(packageBytes).toString("utf8"));
	} catch {
		return null;
	}
	if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return null;
	if (!("source_revision" in parsed)) return null;
	const rev: unknown = parsed.source_revision;
	return isFullSha(rev) ? rev : null;
}

export function identifyExactSource(sourceRoot: string, packageBytes: Uint8Array): ExactSourceIdentity | null {
	if (headResolves(sourceRoot)) return { kind: "git" };
	const revision = stampedRevision(packageBytes);
	if (revision === null) return null;
	return { kind: "stamped", revision };
}

function usage(): never {
	console.error("usage: exact-source.ts --root DIR  (prints GIT or the stamped revision; else exits 1)");
	process.exit(2);
}

if (import.meta.main) {
	const flag = process.argv.indexOf("--root");
	const dir = flag === -1 ? undefined : process.argv[flag + 1];
	if (dir === undefined || dir === "" || dir.startsWith("-")) usage();
	const identity = identifyExactSource(dir, readFileSync(join(dir, "package.json")));
	if (identity === null) {
		console.error(`no exact source identity; unmet prerequisite: stamped archive export (${dir})`);
		process.exit(1);
	}
	console.log(identity.kind === "git" ? "GIT" : identity.revision);
}
