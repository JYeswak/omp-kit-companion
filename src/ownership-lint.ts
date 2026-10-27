// Lint for the ownership registry (ompkit-774u.12 OWNERREG1): a persisted record keyed by a pid must have its
// writer registered with an owner key that matches what the keyed process is, and the registry must stay honest.
// Heuristic by design: a source file that reads its own pid (the process id and parent process id properties) AND calls
// a file-writing function is a pid-keyed writer candidate. It catches a NEW writer file; it does not read what an
// already registered file writes.
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { OWNERSHIP_REGISTRY, type OwnershipEntry } from "./ownership-registry.ts";

export type OwnershipLintCode =
	| "UNREGISTERED_PID_WRITER" | "SEAT_KEYED_BY_PID" | "WRITER_MISSING" | "DUPLICATE_ENTRY" | "CENSUS_SHAPE" | "ROW_UNCOVERED";
export interface OwnershipLintViolation { code: OwnershipLintCode; message: string; file?: string; entry?: string; row?: number }

// Assembled from parts so this file never contains the tokens it searches for.
const PID_TOKENS = ["pid", "ppid"].map(field => ["process", field].join("."));
const WRITE_TOKENS = ["writeFileSync(", "appendFileSync(", "writeFile(", "Bun.write(", "renameSync(", "mkdtempSync(", "mkdirSync("];
const DEFAULT_SCAN_DIRS = ["src", "extensions"];

function sourceFiles(dir: string, found: string[] = []): string[] {
	let names: string[];
	try {
		names = readdirSync(dir);
	} catch {
		return found;
	}
	for (const name of names) {
		const path = join(dir, name);
		let isDir = false;
		try {
			isDir = statSync(path).isDirectory();
		} catch {
			continue;
		}
		if (isDir) sourceFiles(path, found);
		else if (name.endsWith(".ts") && !name.endsWith(".test.ts")) found.push(path);
	}
	return found;
}

/** Whether a source text is a pid-keyed writer candidate. */
export function persistsPid(text: string): boolean {
	return PID_TOKENS.some(token => text.includes(token)) && WRITE_TOKENS.some(token => text.includes(token));
}

export interface OwnershipLintInput {
	/** Repository root the registry's repo-relative writer paths are resolved against. */
	root: string;
	entries?: readonly OwnershipEntry[];
	scanDirs?: readonly string[];
	/** Inventory rows that must each have an entry (the non-NONE rows of the pid-keyed state inventory). */
	requiredRows?: readonly number[];
}

export function lintOwnership(input: OwnershipLintInput): OwnershipLintViolation[] {
	const entries = input.entries ?? OWNERSHIP_REGISTRY;
	const violations: OwnershipLintViolation[] = [];
	const ids = new Set<string>();
	for (const entry of entries) {
		if (ids.has(entry.id)) violations.push({ code: "DUPLICATE_ENTRY", entry: entry.id, message: `registry entry id ${entry.id} appears twice` });
		ids.add(entry.id);
		if (entry.scope === "seat" && !entry.survivesRespawn)
			violations.push({ code: "SEAT_KEYED_BY_PID", entry: entry.id, message: `${entry.id} persists a seat-scoped record under ${entry.ownerKey}, which does not survive a respawn; key it by agent+session` });
		if ((entry.census === null) === (entry.noCensus === undefined))
			violations.push({ code: "CENSUS_SHAPE", entry: entry.id, message: `${entry.id} must name either a census or the reason it has none` });
		for (const writer of entry.writers) {
			if (writer.startsWith("external:")) continue;
			if (!existsSync(join(input.root, writer))) violations.push({ code: "WRITER_MISSING", entry: entry.id, file: writer, message: `${entry.id} names writer ${writer}, which does not exist` });
		}
	}
	const registered = new Set(entries.flatMap(entry => entry.writers));
	for (const dir of input.scanDirs ?? DEFAULT_SCAN_DIRS) {
		for (const path of sourceFiles(join(input.root, dir))) {
			const file = relative(input.root, path);
			let text: string;
			try {
				text = readFileSync(path, "utf8");
			} catch {
				continue;
			}
			if (persistsPid(text) && !registered.has(file))
				violations.push({ code: "UNREGISTERED_PID_WRITER", file, message: `${file} writes files and reads its own pid but no ownership entry lists it as a writer; register its owner key, cancel and crash paths in src/ownership-registry.ts` });
		}
	}
	for (const row of input.requiredRows ?? []) {
		if (!entries.some(entry => entry.rows.includes(row))) violations.push({ code: "ROW_UNCOVERED", row, message: `inventory row ${row} has no ownership entry` });
	}
	return violations;
}
