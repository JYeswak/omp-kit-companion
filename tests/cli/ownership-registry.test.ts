// ompkit-774u.12 OWNERREG1: the registry covers every non-NONE row of the 2026-10-18 pid-keyed state inventory,
// and the lint refuses a pid-keyed writer that no entry accounts for.
import { afterAll, afterEach, expect, test } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { lintOwnership, persistsPid } from "../../src/ownership-lint.ts";
import { OWNERSHIP_REGISTRY, entriesForRow, type OwnershipEntry } from "../../src/ownership-registry.ts";
import { cleanupAllOwnedTmp, ownedTmp } from "../../src/kitlib/tmp.ts";
afterAll(cleanupAllOwnedTmp);

const repoRoot = resolve(import.meta.dir, "../..");
// Rows of docs/evidence/pid-keyed-state-inventory-20261018.md (omp-kit private repo, 282f630) that are not class NONE.
// The NONE rows (14, 16, 19, 22, 23, 26, 27) are keyed by name, session or block and need no entry.
const REQUIRED_ROWS = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 15, 17, 18, 20, 21, 24, 25];
const NONE_ROWS = [14, 16, 19, 22, 23, 26, 27];

const cleanup: string[] = [];
afterEach(() => { for (const dir of cleanup.splice(0)) rmSync(dir, { recursive: true, force: true }); });
mkdirSync(join(repoRoot, "var", "agent-tmp"), { recursive: true });

test("every non-NONE inventory row has an entry, and no NONE row is claimed", () => {
	for (const row of REQUIRED_ROWS) expect({ row, entries: entriesForRow(row).length > 0 }).toEqual({ row, entries: true });
	for (const row of NONE_ROWS) expect({ row, entries: entriesForRow(row).map((entry) => entry.id) }).toEqual({ row, entries: [] });
	expect(lintOwnership({ root: repoRoot, requiredRows: REQUIRED_ROWS })).toEqual([]);
});

test("planted: removing the entry for a row makes the coverage lint name that row", () => {
	const without = OWNERSHIP_REGISTRY.filter((entry) => !entry.rows.includes(20));
	const violations = lintOwnership({ root: repoRoot, entries: without, requiredRows: REQUIRED_ROWS });
	expect(violations.filter((violation) => violation.code === "ROW_UNCOVERED")).toEqual([
		{ code: "ROW_UNCOVERED", row: 20, message: "inventory row 20 has no ownership entry" },
	]);
});

test("the checked-in registry is well formed: unique ids, a census or its reason, real writers, owner beads for classes with a census", () => {
	const ids = OWNERSHIP_REGISTRY.map((entry) => entry.id);
	expect(new Set(ids).size).toBe(ids.length);
	for (const entry of OWNERSHIP_REGISTRY) {
		expect({ id: entry.id, shape: (entry.census === null) === (entry.noCensus !== undefined) }).toEqual({ id: entry.id, shape: true });
		for (const field of [entry.cancel, entry.crash, entry.respawn, entry.terminal.producer, entry.title]) expect(field.trim().length).toBeGreaterThan(2);
		if (entry.ownerBead !== null) expect(entry.ownerBead).toMatch(/^ompkit-[0-9a-z]+(\.[0-9]+)*$/);
	}
	// Seats are keyed by something that survives a respawn; nothing seat-scoped is keyed by a pid.
	for (const entry of OWNERSHIP_REGISTRY.filter((candidate) => candidate.scope === "seat")) expect(entry.survivesRespawn).toBe(true);
});

function fixtureRepo(files: Record<string, string>): string {
	const root = ownedTmp("ownership-lint", { root: join(repoRoot, "var", "agent-tmp") }).path;
	cleanup.push(root);
	for (const [path, text] of Object.entries(files)) {
		mkdirSync(join(root, path, ".."), { recursive: true });
		writeFileSync(join(root, path), text);
	}
	return root;
}
const PID_WRITER = [
	'import { writeFileSync } from "node:fs";',
	"export function claim(dir: string): void {",
	"\twriteFileSync(`${dir}/.owner`, `pid=${process.pid}\\nprocess_start=fixture-start\\n`);",
	"}",
].join("\n");
const entryFor = (over: Partial<OwnershipEntry>): OwnershipEntry => ({
	id: "fixture-writer", title: "A fixture writer of a pid-keyed record", rows: [], class: "RELEASE", ownerKey: "pid+start", scope: "cli-run",
	survivesRespawn: false, writers: ["src/claim.ts"], cancel: "the writer removes the record", crash: "the next run takes it over",
	respawn: "a short-lived CLI, not a seat", terminal: { outcome: "self-heals", producer: "fixture takeover" }, census: null, noCensus: "fixture", ownerBead: null, ...over,
});

test("planted: a pid-keyed persisted record in an unregistered writer fails the lint; registering it with a truthful owner key passes", () => {
	const root = fixtureRepo({ "src/claim.ts": PID_WRITER, "src/quiet.ts": "export const x = 1;\n" });
	expect(persistsPid(PID_WRITER)).toBe(true);
	const unregistered = lintOwnership({ root, entries: [] });
	expect(unregistered).toEqual([expect.objectContaining({ code: "UNREGISTERED_PID_WRITER", file: "src/claim.ts" })]);
	expect(lintOwnership({ root, entries: [entryFor({})] })).toEqual([]);
	// A seat-scoped record under a pid-only key is refused even when its writer is registered.
	const seatByPid = lintOwnership({ root, entries: [entryFor({ scope: "seat", ownerKey: "pid", survivesRespawn: false })] });
	expect(seatByPid).toEqual([expect.objectContaining({ code: "SEAT_KEYED_BY_PID", entry: "fixture-writer" })]);
	expect(lintOwnership({ root, entries: [entryFor({ scope: "seat", ownerKey: "agent+session", survivesRespawn: true })] })).toEqual([]);
});

test("the lint also refuses a writer file that does not exist, a duplicate id, and a census with no reason", () => {
	const root = fixtureRepo({ "src/claim.ts": PID_WRITER });
	const violations = lintOwnership({ root, entries: [
		entryFor({ writers: ["src/claim.ts", "src/gone.ts"] }), entryFor({ census: null, noCensus: undefined }),
	] });
	expect(violations.map((violation) => violation.code).sort()).toEqual(["CENSUS_SHAPE", "DUPLICATE_ENTRY", "WRITER_MISSING"]);
});

test("files that only name a pid, or only write, are not pid-keyed writers; test files are not scanned", () => {
	expect(persistsPid("const own = process.pid;\n")).toBe(false);
	expect(persistsPid('writeFileSync(path, "x");\n')).toBe(false);
	const root = fixtureRepo({
		"src/claim.test.ts": PID_WRITER,
		"src/reader.ts": "export const own = process.pid;\n",
		"scripts/claim_test.py": "(work / '.owner').write_text(f'pid={os.getpid()}\\nlabel=x\\n')",
	});
	expect(lintOwnership({ root, entries: [] })).toEqual([]);
});
test("planted: registering a writer does not permit a bare PID owner record", () => {
	const root = fixtureRepo({ "src/claim.ts": [
		'import { writeFileSync } from "node:fs";',
		"export function claim(path: string): void {",
		"\tconst owner = { pid: process.pid, label: \"build\" };",
		"\twriteFileSync(path, JSON.stringify(owner));",
		"}",
	].join("\n") });
	const violations = lintOwnership({ root, entries: [entryFor({})] });
	expect(violations).toEqual([expect.objectContaining({ code: "BARE_PID_OWNER", file: "src/claim.ts" })]);
});

test("control: a registered owner record with process_start is accepted", () => {
	const root = fixtureRepo({ "src/claim.ts": [
		'import { writeFileSync } from "node:fs";',
		"export function claim(path: string): void {",
		"\tconst owner = { pid: process.pid, process_start: start, label: \"build\" };",
		"\twriteFileSync(path, JSON.stringify(owner));",
		"}",
	].join("\n") });
	expect(lintOwnership({ root, entries: [entryFor({})] })).toEqual([]);
});

test("planted: Python and shell owner records need process_start", () => {
	const bare = fixtureRepo({
		"scripts/claim.py": String.raw`from pathlib import Path
Path(".owner").write_text(f"pid={os.getpid()}\nlabel=fixture\n")
`,
		"scripts/claim.sh": String.raw`printf 'pid=%s\nlabel=fixture\n' "$$" > "$work/.owner"
`,
	});
	const violations = lintOwnership({ root: bare, entries: [], scanDirs: ["scripts"] });
	expect(violations.map(violation => `${violation.file}:${violation.code}`).sort()).toEqual([
		"scripts/claim.py:BARE_PID_OWNER",
		"scripts/claim.sh:BARE_PID_OWNER",
	]);

	const modern = fixtureRepo({
		"scripts/claim.py": String.raw`from pathlib import Path
Path(".owner").write_text(f"pid={os.getpid()}\nprocess_start={start}\nlabel=fixture\n")
`,
		"scripts/claim.sh": String.raw`printf 'pid=%s\nprocess_start=%s\nlabel=fixture\n' "$$" "$start" > "$work/.owner"
`,
	});
	expect(lintOwnership({ root: modern, entries: [], scanDirs: ["scripts"] })).toEqual([]);
});
