#!/usr/bin/env bun
/**
 * seed-sdk-source.ts — provision one exact SDK source version into a private owned cache root.
 *
 * Used only by scripts/suite-hermetic-env.sh for the two native SDK suites, which run their
 * consumers with OMP_KIT_OMP_SRC_FETCH=0 under an isolated HOME. Reuses a forwarded verified
 * cache read-only when it already holds the exact version; otherwise provisions that one
 * version with the existing ensureOmpSource verifier (fetch enabled only in this setup child).
 * Never writes to or prunes the reused root. Prints the chosen verified cache root on stdout;
 * any other outcome is a refusal on stderr with a non-zero exit.
 *
 * Usage: bun --no-env-file scripts/seed-sdk-source.ts --kind lifecycle|pty --cache-root <dir> [--reuse-root <dir>]
 */
import { isAbsolute } from "node:path";
import { cachedOmpPackage, ensureOmpSource } from "../src/omp-source-cache.ts";
import { sdkSourceVersion } from "../tests/cli/kit-sdk-source.ts";


const argv = Bun.argv.slice(2);
let kind: string | null = null;
let cacheRoot: string | null = null;
let reuseRoot: string | null = null;
for (let i = 0; i < argv.length; i++) {
	const arg = argv[i];
	if ((arg === "--kind" || arg === "--cache-root" || arg === "--reuse-root") && i + 1 < argv.length) {
		i++;
		if (arg === "--kind") kind = argv[i];
		else if (arg === "--cache-root") cacheRoot = argv[i];
		else reuseRoot = argv[i];
	} else {
		process.stderr.write("usage: seed-sdk-source.ts --kind lifecycle|pty --cache-root <dir> [--reuse-root <dir>]\n");
		process.exit(2);
	}
}
if ((kind !== "lifecycle" && kind !== "pty") || !cacheRoot || !isAbsolute(cacheRoot)) {
	process.stderr.write("usage: seed-sdk-source.ts --kind lifecycle|pty --cache-root <dir> [--reuse-root <dir>]\n");
	process.exit(2);
}
const version = sdkSourceVersion(kind, process.env);
if (reuseRoot) {
	if (cachedOmpPackage(version, { OMP_KIT_OMP_SRC_CACHE: reuseRoot })) {
		process.stdout.write(`${JSON.stringify(reuseRoot)}\n`);
		process.exit(0);
	}
}
const env: Record<string, string | undefined> = { ...process.env, OMP_KIT_OMP_SRC_CACHE: cacheRoot };
ensureOmpSource(version, env);
process.stdout.write(`${JSON.stringify(cacheRoot)}\n`);
