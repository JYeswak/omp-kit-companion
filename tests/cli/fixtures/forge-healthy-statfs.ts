// Test-only runtime fault injection for ompkit-oq1h.1 (heavy.test.ts, "planted: a forged-healthy statfs").
//
// `bun --preload` this file into the real CLI and the statfs reading that src/heavy.ts takes through
// `import { statfsSync } from "node:fs"` becomes a healthy 500 GiB free of 1 TiB, whatever the real
// filesystem holds. That forces the production statfs verdict to "ok" with no production seam: the
// shipped source and the environment the CLI reads are untouched, and the only way to get here is for a
// test to name this file on the command line.
import { mock } from "bun:test";
import * as realFs from "node:fs";

const realStatfs = realFs.statfsSync;
const snapshot = { ...realFs };

function forgedStatfs(path: realFs.PathLike, options?: never) {
	const observed = realStatfs(path, options);
	const blockSize = Number(observed.bsize);
	return { ...observed, bavail: Math.floor((500 * 1024 ** 3) / blockSize), blocks: Math.floor(1024 ** 4 / blockSize) };
}

mock.module("node:fs", () => ({ ...snapshot, default: { ...snapshot, statfsSync: forgedStatfs }, statfsSync: forgedStatfs }));
