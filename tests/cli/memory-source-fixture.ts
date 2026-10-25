import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { brotliDecompressSync } from "node:zlib";
import backend from "../fixtures/omp-compat/memory-18.12.6.json";
import config from "../fixtures/omp-compat/memory-18.12.6-config.json";

export const MEMORY_FIXTURE_VERSION = "18.12.6";
if (backend.version !== MEMORY_FIXTURE_VERSION || config.version !== MEMORY_FIXTURE_VERSION)
	throw new Error("Memory fixture source versions disagree");

const sources = Object.entries({ ...backend.files, [config.path]: config }).map(([path, source]) => {
	const bytes = brotliDecompressSync(Buffer.from(source.brotli_base64, "base64"));
	if (createHash("sha256").update(bytes).digest("hex") !== source.sha256)
		throw new Error(`Reviewed memory fixture digest mismatch: ${path}`);
	return { path, bytes };
});

export const REVIEWED_MEMORY_SOURCE_FILES = sources.map(source => source.path);

/** Materialize the reviewed static source, never whichever OMP happens to be on PATH. */
export function writeReviewedMemorySources(ompPackage: string): void {
	for (const source of sources) {
		const target = join(ompPackage, source.path);
		mkdirSync(dirname(target), { recursive: true });
		writeFileSync(target, source.bytes);
	}
}
