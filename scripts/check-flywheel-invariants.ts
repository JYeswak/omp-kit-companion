#!/usr/bin/env bun
/**
 * Release gate for docs/flywheel-invariants.tsv: every Agent Flywheel Guide kernel invariant
 * (1-9) and anti-pattern (5) maps to a mechanism that acts at the moment of the breach, and
 * every named mechanism and its fire/quiet proof exist in this tree. Prose is not a mechanism.
 *
 * Usage: bun scripts/check-flywheel-invariants.ts [--root DIR] [--json]
 * Exit 0 PASS, 1 FAIL (each failure names its row), 2 usage/read error.
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

export const KINDS = ["ttsr", "extension", "send", "doctor", "cli", "gate"] as const;
export const REQUIRED_KERNEL = ["1", "2", "3", "4", "5", "6", "7", "8", "9"];
export const REQUIRED_ANTI = [
	"Single-pass beads",
	"Skipping plan-to-bead validation",
	"Communication purgatory",
	"Holding reservations too long",
	"Not re-reading AGENTS.md after compaction",
];
const HEADER = ["id", "guide", "kind", "mechanism", "fire", "quiet"];
/** A mechanism named as a document is prose: whole-name match, so DIRECTOR_DOING_WORK is not "docs". */
const PROSE = /^(?:AGENTS\.md|CLAUDE\.md|skill text|skills?|docs?|prose|README(?:\.md)?|plan|PLAN_[A-Za-z0-9_]+\.md)$/i;

export interface Row { id: string; guide: string; kind: string; mechanism: string; fire: string; quiet: string; line: number }
export interface Result { status: "PASS" | "FAIL"; rows: number; failures: string[] }

export function parseMap(text: string): Row[] {
	const lines = text.split("\n").filter(line => line.trim() !== "");
	if (lines.length === 0) throw new Error("MAP_EMPTY");
	if (lines[0]!.split("\t").join("|") !== HEADER.join("|")) throw new Error("MAP_HEADER");
	return lines.slice(1).map((line, index) => {
		const cells = line.split("\t");
		if (cells.length !== HEADER.length) throw new Error(`MAP_COLUMNS line ${index + 2}`);
		const [id, guide, kind, mechanism, fire, quiet] = cells as [string, string, string, string, string, string];
		return { id, guide, kind, mechanism, fire, quiet, line: index + 2 };
	});
}

function corpusRows(root: string): Set<string> {
	const path = join(root, "cases/cases.tsv");
	const out = new Set<string>();
	if (!existsSync(path)) return out;
	for (const line of readFileSync(path, "utf8").split("\n").slice(1)) {
		const [rule, expect] = line.split("\t");
		if (rule && expect) out.add(`${rule}::${expect}`);
	}
	return out;
}

function testExists(root: string, file: string, name: string): boolean {
	const path = join(root, file);
	if (!existsSync(path)) return false;
	const source = readFileSync(path, "utf8");
	return [`test("${name}`, `it("${name}`, `test('${name}`, `it('${name}`].some(opener => source.includes(opener));
}

function symbolExists(root: string, file: string, symbol: string): boolean {
	const path = join(root, file);
	return existsSync(path) && readFileSync(path, "utf8").includes(symbol);
}

/** Directories a release archive ships; `--packaged` checks only proofs that live in them. */
export const SHIPPED_ROOTS = ["rules/", "cases/", "extensions/", "scripts/", "docs/"];

/** A proof cell is `file::test name`, `file::SYMBOL`, or `cases/cases.tsv::rule::fire|quiet`. */
function proofExists(root: string, cell: string, corpus: Set<string>, packaged: boolean): boolean {
	const parts = cell.split("::");
	if (parts.length < 2) return false;
	const [file, ...rest] = parts as [string, ...string[]];
	if (packaged && !SHIPPED_ROOTS.some(prefix => file.startsWith(prefix))) return true;
	if (file === "cases/cases.tsv") return rest.length === 2 && corpus.has(`${rest[0]}::${rest[1]}`);
	const target = rest.join("::");
	if (/\.test\.[cm]?[jt]s$/.test(file)) return testExists(root, file, target);
	return symbolExists(root, file, target);
}

function mechanismExists(root: string, row: Row, corpus: Set<string>, packaged: boolean): boolean {
	switch (row.kind) {
		case "ttsr":
			return existsSync(join(root, "rules", `${row.mechanism}.md`)) && corpus.has(`${row.mechanism}::fire`) && corpus.has(`${row.mechanism}::quiet`);
		case "extension":
			return existsSync(join(root, "extensions", `${row.mechanism}.ts`)) && existsSync(join(root, "extensions", `${row.mechanism}.test.ts`));
		case "send":
			return packaged || symbolExists(root, "src/send.ts", row.mechanism);
		case "doctor":
		case "cli":
		case "gate":
			return true; // proven by the fire/quiet cells, which name the implementing file
		default:
			return false;
	}
}

/** `packaged`: the root is an installed release, which ships rules/cases/extensions but not src/ or tests/. */
export function check(root: string, text: string, packaged = false): Result {
	const failures: string[] = [];
	let rows: Row[];
	try { rows = parseMap(text); } catch (error) { return { status: "FAIL", rows: 0, failures: [(error as Error).message] }; }
	const corpus = corpusRows(root);
	const ids = new Set<string>();
	for (const row of rows) {
		const where = `${row.id} (line ${row.line})`;
		if (ids.has(row.id)) failures.push(`${where}: DUPLICATE_ID`);
		ids.add(row.id);
		if (!(KINDS as readonly string[]).includes(row.kind)) failures.push(`${where}: KIND_NOT_A_MECHANISM ${row.kind}`);
		if (PROSE.test(row.mechanism) || PROSE.test(row.kind)) failures.push(`${where}: PROSE_IS_NOT_A_MECHANISM ${row.mechanism}`);
		if (!mechanismExists(root, row, corpus, packaged)) failures.push(`${where}: MECHANISM_MISSING ${row.kind}:${row.mechanism}`);
		if (!proofExists(root, row.fire, corpus, packaged)) failures.push(`${where}: FIRE_PROOF_MISSING ${row.fire}`);
		if (!proofExists(root, row.quiet, corpus, packaged)) failures.push(`${where}: QUIET_PROOF_MISSING ${row.quiet}`);
	}
	for (const n of REQUIRED_KERNEL) {
		if (!rows.some(row => row.guide.includes("The Kernel: 9 Invariants >") && row.guide.split("> ").pop()!.startsWith(`${n} `)))
			failures.push(`kernel invariant ${n}: UNMAPPED`);
	}
	for (const name of REQUIRED_ANTI) {
		if (!rows.some(row => row.guide.endsWith(`Anti-Patterns to Avoid > ${name}`))) failures.push(`anti-pattern "${name}": UNMAPPED`);
	}
	return { status: failures.length ? "FAIL" : "PASS", rows: rows.length, failures };
}

if (import.meta.main) {
	const args = process.argv.slice(2);
	const rootAt = args.indexOf("--root");
	const root = rootAt >= 0 ? args[rootAt + 1] : join(import.meta.dir, "..");
	if (!root) { console.error("usage: check-flywheel-invariants.ts [--root DIR] [--packaged] [--json]"); process.exit(2); }
	let text = "";
	try { text = readFileSync(join(root, "docs/flywheel-invariants.tsv"), "utf8"); }
	catch (error) { console.error(`FLYWHEEL-INVARIANTS: cannot read map: ${(error as Error).message}`); process.exit(2); }
	const packaged = args.includes("--packaged");
	const result = check(root, text, packaged);
	if (args.includes("--json")) console.log(JSON.stringify(result));
	else {
		for (const failure of result.failures) console.log(`FAIL ${failure}`);
		console.log(`FLYWHEEL-INVARIANTS: ${result.status} rows=${result.rows} failures=${result.failures.length}`);
	}
	process.exitCode = result.status === "PASS" ? 0 : 1;
}
