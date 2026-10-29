/**
 * Shared exact-source identity for tests that run from history-free archives
 * as well as git checkouts (71989: one helper for runtime.test.ts,
 * absolute-imports.test.ts and savefirst-pre-push.test.sh).
 *
 * A source tree with its own .git keeps plain Git behavior: callers verify
 * the top level and archive HEAD themselves. A history-free tree resolves
 * through the packaged seam (packageSourceRevision): the stamped
 * package.json source_revision (export-subst), or null when unstamped. Never
 * discovers an ancestor repository; never passes silently. Spawns nothing, so
 * staged callers stay kitlib-clean.
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { packageSourceRevision } from "./package-release.ts";

export type ExactSourceIdentity =
	| { readonly kind: "git" }
	| { readonly kind: "stamped"; readonly revision: string };

/** Null only when there is no .git AND no full-sha stamp to resolve. */
export function identifyExactSource(sourceRoot: string, packageBytes: Uint8Array): ExactSourceIdentity | null {
	if (existsSync(join(sourceRoot, ".git"))) return { kind: "git" };
	const revision = packageSourceRevision(sourceRoot, packageBytes);
	if (revision === null) return null;
	return { kind: "stamped", revision };
}

function usage(): never {
	console.error("usage: exact-source.ts --root DIR  (prints the stamped source revision, else exits 1)");
	process.exit(2);
}

if (import.meta.main) {
	const flag = process.argv.indexOf("--root");
	const dir = flag === -1 ? undefined : process.argv[flag + 1];
	if (dir === undefined || dir === "" || dir.startsWith("-")) usage();
	if (existsSync(join(dir, ".git"))) {
		console.error("has .git; resolve HEAD with git instead");
		process.exit(2);
	}
	const identity = identifyExactSource(dir, readFileSync(join(dir, "package.json")));
	if (identity === null || identity.kind !== "stamped") {
		console.error(`no exact source identity; unmet prerequisite: stamped archive export (${dir})`);
		process.exit(1);
	}
	console.log(identity.revision);
}
