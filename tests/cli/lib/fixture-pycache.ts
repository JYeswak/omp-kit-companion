import { mkdirSync } from "node:fs";
import { join, resolve } from "node:path";

// PYCACHE1 (ompkit-fp72.120.16.249): Apple's /usr/bin/python3 keeps bytecode under
// $HOME/Library/Caches/com.apple.python, and every hermetic fixture runs with a fresh HOME, so each fixture
// python3 recompiled and atomically rewrote every module it imported (34 .pyc per br create guard). Under
// gate load those writes took up to 18.5 s of a 23.2 s create guard. Fixture python3 processes share one
// bytecode cache per checkout instead: <checkout>/var/pycache, inside the gitignored var/. Bytecode is keyed
// on the source path and its mtime/size, so one prefix is safe for one checkout and is never shared across
// checkouts.
export const FIXTURE_PYCACHE_PREFIX = join(resolve(import.meta.dir, "../../.."), "var", "pycache");

/** The PYTHONPYCACHEPREFIX a fixture env should carry: the caller's explicit choice, else this checkout's cache. */
export function fixturePycachePrefix(env: Readonly<Record<string, string | undefined>> = process.env): string {
	const chosen = env.PYTHONPYCACHEPREFIX;
	if (chosen) return chosen;
	mkdirSync(FIXTURE_PYCACHE_PREFIX, { recursive: true });
	return FIXTURE_PYCACHE_PREFIX;
}
