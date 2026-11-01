#!/usr/bin/env bun
// SKIPTEST1: independently audit the selector's output before wall-budget deferral.
// Shared parsing is not shared selection: this module starts at every actual test and walks
// forward, never calling selectAffected or trusting its reasons/distance/reverse traversal.
import { readFileSync, statSync } from "node:fs";
import process from "node:process";
import {
	buildSelectionGraph, isCodeFile, isExactSelectionPath as exactPath, isTestFile,
	readSelectionPolicy, type SelectionGraph, type SelectionPolicy,
} from "./affected-tests";

export type CoverageGap = { file: string; reason: string };

const POLICY = ".github/test-selection.json";


/** Each test is visited once; each source is parsed once, regardless of changed-path count. */
function consumers(graph: SelectionGraph): Map<string, Set<string>> {
	const expected = new Map<string, Set<string>>();
	const record = (file: string, test: string) => {
		let tests = expected.get(file);
		if (!tests) expected.set(file, (tests = new Set()));
		tests.add(test);
	};
	for (const test of graph.files) {
		if (!isTestFile(test)) continue;
		const seen = new Set<string>();
		const pending = [test];
		while (pending.length > 0) {
			const file = pending.pop();
			if (file === undefined || seen.has(file)) continue;
			seen.add(file);
			record(file, test);
			for (const target of graph.dependencies.get(file) ?? []) pending.push(target);
		}
		// Doc/data pointers are a direct test assertion, never a production dependency or a
		// transitive edge through a helper (e.g. a CLI's help link to a markdown document).
		for (const target of graph.testReferences.get(test) ?? []) record(target, test);
	}
	return expected;
}

type AuditInputs = { graph: SelectionGraph; policy: SelectionPolicy; gaps: CoverageGap[] };

function acquireAuditInputs(root: string): AuditInputs | CoverageGap {
	let graph: SelectionGraph;
	try {
		graph = buildSelectionGraph(root);
	} catch (error) {
		return { file: ".", reason: `cannot inventory repository: ${error instanceof Error ? error.message : String(error)}` };
	}
	const gaps: CoverageGap[] = [];
	for (const [file, reason] of graph.problems)
		gaps.push({ file, reason: `dependency analysis failed: ${reason}` });
	let policy: SelectionPolicy;
	try {
		policy = readSelectionPolicy(root, graph.files);
	} catch (error) {
		gaps.push({ file: POLICY, reason: `invalid declared coverage: ${error instanceof Error ? error.message : String(error)}` });
		policy = { noTest: new Map(), requiredTests: new Map() };
	}
	return { graph, policy, gaps };
}

function checkSelectedTests(files: ReadonlySet<string>, chosen: ReadonlySet<string>, gaps: CoverageGap[]): void {
	for (const file of chosen) {
		if (!exactPath(file) || !files.has(file) || !isTestFile(file))
			gaps.push({ file, reason: "selected path is not an existing runnable test file (fixture suites do not count)" });
	}
}

function mergeRequiredConsumers(expected: Map<string, Set<string>>, policy: SelectionPolicy): void {
	for (const [file, obligation] of policy.requiredTests) {
		let tests = expected.get(file);
		if (!tests) expected.set(file, (tests = new Set()));
		for (const test of obligation.tests) tests.add(test);
	}
}

type PathAudit = {
	files: ReadonlySet<string>;
	policy: SelectionPolicy;
	expected: ReadonlyMap<string, ReadonlySet<string>>;
	chosen: ReadonlySet<string> | null;
};

function diagnosePath(file: string, context: PathAudit): CoverageGap | null {
	if (!exactPath(file))
		return { file, reason: "changed path is not an exact repository-relative file; coverage cannot be established" };
	// A diff can name a deleted path. An exact-tree export has no Git metadata to distinguish
	// deletion from a typo; surviving unresolved imports still fail dependency analysis.
	if (!context.files.has(file)) return null;
	const required = context.expected.get(file);
	if (!required || required.size === 0) {
		// Unconsumed prose/data outside product trees retains the docs-only fast path.
		// A discovered direct reader still imposes its full selected-consumer obligation.
		if (!file.startsWith("src/") && !file.startsWith("scripts/") && !isCodeFile(file)) return null;
		if (context.policy.noTest.has(file)) return null;
		return { file, reason: `no reachable test consumer and no exact nonempty no_test reason in ${POLICY}` };
	}
	const chosen = context.chosen;
	if (chosen === null) return null;
	const missing = [...required].filter((test) => !chosen.has(test)).sort();
	if (missing.length === 0) return null;
	const obligation = context.policy.requiredTests.get(file);
	const why = obligation && missing.some((test) => obligation.tests.includes(test))
		? `; declared obligation: ${obligation.reason}` : "";
	return { file, reason: `missing required test consumer${missing.length === 1 ? "" : "s"}: ${missing.join(", ")}${why}` };
}

function audit(root: string, changed: readonly string[] | null, selected: readonly string[]): CoverageGap[] {
	const inputs = acquireAuditInputs(root);
	if (!("graph" in inputs)) return [inputs];
	const { graph, policy, gaps } = inputs;
	const chosen = new Set(selected);
	checkSelectedTests(graph.files, chosen, gaps);
	const expected = consumers(graph);
	mergeRequiredConsumers(expected, policy);
	const context: PathAudit = { files: graph.files, policy, expected, chosen: changed === null ? null : chosen };
	const paths = changed ?? [...graph.files].filter((file) => file.startsWith("src/") || file.startsWith("scripts/"));
	for (const file of new Set(paths)) {
		const gap = diagnosePath(file, context);
		if (gap) gaps.push(gap);
	}
	return gaps.sort((left, right) => left.file.localeCompare(right.file) || left.reason.localeCompare(right.reason));
}

export function auditSelection(root: string, changed: readonly string[], selected: readonly string[]): CoverageGap[] {
	return audit(root, changed, selected);
}

export function auditCoverage(root: string): CoverageGap[] {
	return audit(root, null, []);
}

const USAGE = "usage: selection-coverage.ts --root DIR --changed-file PATH [--changed-file PATH ...] --selected-file FILE\n" +
	"       selection-coverage.ts --root DIR --all\n";

function main(argv: readonly string[]): number {
	let root = "";
	let selectedFile = "";
	let all = false;
	const changed: string[] = [];
	for (let i = 0; i < argv.length; i++) {
		const flag = argv[i];
		if (flag === "--all" && !all) { all = true; continue; }
		const value = argv[i + 1];
		if (value === undefined || value.startsWith("--") || value === "") { process.stderr.write(USAGE); return 2; }
		if (flag === "--root" && !root) root = value;
		else if (flag === "--changed-file") changed.push(value);
		else if (flag === "--selected-file" && !selectedFile) selectedFile = value;
		else { process.stderr.write(USAGE); return 2; }
		i++;
	}
	if (!root || (all ? changed.length > 0 || !!selectedFile : changed.length === 0 || !selectedFile)) {
		process.stderr.write(USAGE);
		return 2;
	}
	let selected: string[] = [];
	try {
		if (!statSync(root).isDirectory()) throw new Error(`--root is not a directory: ${root}`);
		if (!all) {
			const lines = readFileSync(selectedFile, "utf8").split("\n");
			selected = lines.map((line) => line.endsWith("\r") ? line.slice(0, -1) : line).filter((line) => line !== "");
		}
	} catch (error) {
		process.stderr.write(`selection-coverage: invalid input: ${error instanceof Error ? error.message : String(error)}\n`);
		return 2;
	}
	const gaps = all ? auditCoverage(root) : auditSelection(root, changed, selected);
	for (const gap of gaps) process.stderr.write(`SELECTION_GAP ${gap.file}: ${gap.reason}\n`);
	return gaps.length === 0 ? 0 : 1;
}

if (import.meta.main) process.exit(main(process.argv.slice(2)));
