#!/usr/bin/env bun
// affected-tests.ts — CIGATE1 (ompkit-v66l.27.1): select the test files a pushed diff affects.
//
// Usage: bun scripts/affected-tests.ts --root DIR [--changed-file PATH ...] [--explain] [--order path|distance]
//        bun scripts/affected-tests.ts --plan --budget-secs N --workers K [--timings FILE] [--deferred-out FILE]
//            [--changed-file PATH ...] -- TEST...   (wall-budget plan; see planBudget)
//
// DIR is the exact-commit export the gate judges (no .git needed). Test files are bun suites
// (*.test.ts and kin), shell suites (*.test.sh) and python suites (*_test.py, test_*.py). A test file
// is selected when
//   (a) it is itself a changed path that still exists, or
//   (b) it reaches a changed path through static edges: an import/export/require/import() that Bun's
//       own parser finds (Bun.Transpiler.scanImports, so no regex reads source), followed
//       transitively, or a literal path naming the changed file (a test that spawns `src/cli.ts` or
//       runs `$ROOT/scripts/x.sh`), one hop from the change.
// stdout: one selected test path per line, sorted. stderr: a one-line summary; with --explain, one
// `path <- changed` line per selection naming the changed path that pulled it in.
// Exit 0 with an empty stdout means no test is affected; 2 is a usage or unreadable-root error.
import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, normalize, relative, sep } from "node:path";
import process from "node:process";

const SOURCE_EXT = [".ts", ".tsx", ".mts", ".cts", ".js", ".mjs", ".cjs"];
const TEST_SUFFIX = [".test.ts", ".test.tsx", ".test.mts", ".test.js", ".test.mjs", ".test.sh", "_test.py"];
// Text scanned for literal path references: sources plus the shell and python that run them.
const SCANNED_EXT = [...SOURCE_EXT, ".sh", ".py"];
// Never source: VCS state, dependencies, peers' scratch (var/agent-tmp) and build output.
const SKIP_DIR: Record<string, true> = { ".git": true, node_modules: true, var: true, dist: true };
const FIXTURE_DIR = "tests/fixtures/";

export type Selection = { tests: string[]; reasons: Map<string, string>; distance: Map<string, number> };

function walk(root: string, at = ""): string[] {
	const out: string[] = [];
	for (const entry of readdirSync(join(root, at), { withFileTypes: true })) {
		const rel = at ? `${at}/${entry.name}` : entry.name;
		if (entry.isDirectory()) {
			if (!Object.hasOwn(SKIP_DIR, entry.name)) out.push(...walk(root, rel));
		} else if (entry.isFile()) out.push(rel);
	}
	return out;
}

export function isTestFile(rel: string): boolean {
	if (rel.startsWith(FIXTURE_DIR)) return false;
	const name = rel.slice(rel.lastIndexOf("/") + 1);
	return TEST_SUFFIX.some((suffix) => name.endsWith(suffix)) || (name.startsWith("test_") && name.endsWith(".py"));
}

function loaderFor(rel: string): "ts" | "tsx" | "js" {
	if (rel.endsWith(".tsx")) return "tsx";
	return rel.endsWith(".js") || rel.endsWith(".mjs") || rel.endsWith(".cjs") ? "js" : "ts";
}

function resolveSpecifier(files: ReadonlySet<string>, fromRel: string, spec: string): string | null {
	if (!spec.startsWith("./") && !spec.startsWith("../")) return null;
	const bare = spec.split("?")[0] ?? spec;
	const base = normalize(join(dirname(fromRel), bare)).split(sep).join("/");
	if (base.startsWith("../")) return null;
	const candidates = [base, ...SOURCE_EXT.map((ext) => base + ext), ...SOURCE_EXT.map((ext) => `${base}/index${ext}`)];
	// TypeScript sources may import "./x.js" meaning ./x.ts.
	for (const js of [".js", ".mjs"]) if (base.endsWith(js)) candidates.push(base.slice(0, -js.length) + (js === ".js" ? ".ts" : ".mts"));
	return candidates.find((candidate) => files.has(candidate)) ?? null;
}

/** A character that can continue a repo-relative path token: [A-Za-z0-9_.-/], by char code. */
function isPathChar(code: number): boolean {
	return (code >= 48 && code <= 57) || (code >= 65 && code <= 90) || (code >= 97 && code <= 122) ||
		code === 95 || code === 46 || code === 45 || code === 47;
}

// A literal path in non-test source is a dependency only when it names code (SCANNED_EXT): a script
// the source spawns or runs. A doc or data path in a source string (a help pointer, a docs link) is
// not one, so a docs-only diff selects only tests that themselves name the changed file.

/**
 * Literal paths a source names: repo-relative ("src/cli.ts", "scripts/fresh-gate.sh"), relative to
 * the source ("../../src/cli.ts" in a resolve(import.meta.dir, ...) call), or the repo-relative tail
 * of a rooted one ("$ROOT/scripts/x.sh" reads as the token "ROOT/scripts/x.sh"; the longest tail
 * that names a repo file counts). Tokens are maximal runs of path characters; a trailing sentence
 * "." is dropped.
 */
function referencedPaths(text: string, files: ReadonlySet<string>, fromRel: string): string[] {
	const found: string[] = [];
	const fromDir = dirname(fromRel);
	let at = 0;
	while (at < text.length) {
		if (!isPathChar(text.charCodeAt(at))) { at++; continue; }
		const start = at;
		let slash = false;
		while (at < text.length && isPathChar(text.charCodeAt(at))) {
			if (text.charCodeAt(at) === 47) slash = true;
			at++;
		}
		if (!slash) continue;
		let end = at;
		while (end > start && text.charCodeAt(end - 1) === 46) end--;
		const token = text.slice(start, end);
		if (files.has(token)) { found.push(token); continue; }
		if (token.startsWith("./") || token.startsWith("../")) {
			const target = normalize(join(fromDir, token)).split(sep).join("/");
			if (files.has(target)) { found.push(target); continue; }
		}
		for (let slashAt = token.indexOf("/"); slashAt !== -1; slashAt = token.indexOf("/", slashAt + 1)) {
			const tail = token.slice(slashAt + 1);
			if (files.has(tail)) { found.push(tail); break; }
		}
	}
	return found;
}

export function selectAffected(root: string, changed: readonly string[]): Selection {
	const all = walk(root);
	const files = new Set(all);
	// importers[x] = sources whose import graph reaches x in one step; namers[x] = sources that name
	// x as a literal path. Imports are followed transitively. A naming edge counts only as the first
	// hop from a changed file: a test that spawns src/cli.ts runs when cli.ts itself changes, not
	// whenever any module cli.ts imports changes (that would select every CLI suite for every src
	// edit, ~55 suites, which is CI's full run, not an affected set).
	const importers = new Map<string, Set<string>>();
	const namers = new Map<string, Set<string>>();
	const edge = (graph: Map<string, Set<string>>, from: string, to: string) => {
		if (from === to) return;
		let set = graph.get(to);
		if (!set) graph.set(to, (set = new Set()));
		set.add(from);
	};
	for (const rel of all) {
		if (!SCANNED_EXT.some((ext) => rel.endsWith(ext))) continue;
		const text = readFileSync(join(root, rel), "utf8");
		if (SOURCE_EXT.some((ext) => rel.endsWith(ext))) {
			let imports: { path: string }[] = [];
			try { imports = new Bun.Transpiler({ loader: loaderFor(rel) }).scanImports(text); }
			catch { /* An unparsable source still contributes its literal path references below. */ }
			for (const item of imports) {
				const target = resolveSpecifier(files, rel, item.path);
				if (target) edge(importers, rel, target);
			}
		}
		for (const target of referencedPaths(text, files, rel)) {
			if (isTestFile(rel) || SCANNED_EXT.some((ext) => target.endsWith(ext))) edge(namers, rel, target);
		}
	}
	const reasons = new Map<string, string>();
	// Hops from the nearest change: 0 for a changed test, 1 for a direct importer or namer, and so on.
	const distance = new Map<string, number>();
	for (const start of changed) {
		if (!files.has(start)) continue;
		const seen = new Map<string, number>([[start, 0]]);
		const queue = [start];
		for (const namer of namers.get(start) ?? []) {
			if (!seen.has(namer)) { seen.set(namer, 1); queue.push(namer); }
		}
		while (queue.length > 0) {
			const node = queue.shift() as string;
			const hops = seen.get(node) as number;
			if (isTestFile(node)) {
				if (!reasons.has(node)) reasons.set(node, start);
				if (hops < (distance.get(node) ?? Number.POSITIVE_INFINITY)) distance.set(node, hops);
			}
			for (const next of importers.get(node) ?? []) {
				if (!seen.has(next)) { seen.set(next, hops + 1); queue.push(next); }
			}
		}
	}
	return { tests: [...reasons.keys()].sort(), reasons, distance };
}

// A file with no CI timing is planned at 10 s.
const UNTIMED_MS = 10_000;

/**
 * Wall-budget plan (CIGATE1 rule 3): tests in nearest-first order, kept while the predicted wall of
 * K workers, max(total / K, longest file), stays within the budget. A changed test file, and the
 * first test, always run; whatever does not fit is deferred to CI by name.
 */
export function planBudget(tests: readonly string[], changed: ReadonlySet<string>, durations: Readonly<Record<string, number>>, budgetMs: number, workers: number): { run: string[]; deferred: string[]; predictedMs: number } {
	const run: string[] = [];
	const deferred: string[] = [];
	let total = 0;
	let longest = 0;
	for (const test of tests) {
		const ms = durations[test] ?? UNTIMED_MS;
		const predicted = Math.max((total + ms) / workers, Math.max(longest, ms));
		if (changed.has(test) || run.length === 0 || predicted <= budgetMs) {
			run.push(test);
			total += ms;
			longest = Math.max(longest, ms);
		} else deferred.push(test);
	}
	return { run, deferred, predictedMs: Math.max(total / workers, longest) };
}

const USAGE = "usage: affected-tests.ts --root DIR [--changed-file PATH ...] [--explain] [--order path|distance]\n" +
	"       affected-tests.ts --plan --budget-secs N --workers K [--timings FILE ...] [--deferred-out FILE] [--changed-file PATH ...] -- TEST...\n";

function main(argv: readonly string[]): number {
	let root = "";
	let explain = false;
	let order = "path";
	let plan = false;
	let budgetSecs = Number.NaN;
	let workers = Number.NaN;
	const timings: string[] = [];
	let deferredOut = "";
	const changed: string[] = [];
	let i = 0;
	for (; i < argv.length; i++) {
		const arg = argv[i];
		const value = argv[i + 1];
		if (arg === "--") { i++; break; }
		if (arg === "--explain") explain = true;
		else if (arg === "--plan") plan = true;
		else if (value === undefined) { process.stderr.write(USAGE); return 2; }
		else if (arg === "--root") { root = value; i++; }
		else if (arg === "--changed-file") { changed.push(value); i++; }
		else if (arg === "--order" && (value === "path" || value === "distance")) { order = value; i++; }
		else if (arg === "--budget-secs") { budgetSecs = Number(value); i++; }
		else if (arg === "--workers") { workers = Number(value); i++; }
		else if (arg === "--timings") { timings.push(value); i++; }
		else if (arg === "--deferred-out") { deferredOut = value; i++; }
		else { process.stderr.write(USAGE); return 2; }
	}
	if (plan) {
		if (!(budgetSecs > 0) || !Number.isInteger(workers) || workers < 1) { process.stderr.write(USAGE); return 2; }
		// Later tables override earlier ones: the committed CI table first, then this machine's measured
		// bun and script tables (GATESPEED1: the CI table has no shell suites, so 56 suites measured at
		// up to 440 s were each planned at the 10 s default and every scripts push blew the budget).
		const durations: Record<string, number> = {};
		for (const table of timings) {
			if (!existsSync(table)) continue;
			const parsed: unknown = JSON.parse(readFileSync(table, "utf8"));
			if (typeof parsed === "object" && parsed !== null && "files" in parsed && typeof parsed.files === "object" && parsed.files !== null)
				Object.assign(durations, parsed.files as Record<string, number>);
		}
		const result = planBudget(argv.slice(i).filter((test) => test !== ""), new Set(changed), durations, budgetSecs * 1000, workers);
		for (const test of result.run) process.stdout.write(`${test}\n`);
		if (deferredOut) writeFileSync(deferredOut, result.deferred.map((test) => `${test}\n`).join(""), { flag: "a" });
		process.stderr.write(`affected-tests plan: run ${result.run.length}, defer ${result.deferred.length}, predicted ${Math.round(result.predictedMs / 1000)} s on ${workers} workers against a ${budgetSecs} s budget\n`);
		for (const test of result.deferred) process.stderr.write(`focused: deferred ${test} (over the ${budgetSecs} s wall budget); the release's full suite runs it\n`);
		return 0;
	}
	if (!root || !existsSync(root) || !statSync(root).isDirectory()) {
		process.stderr.write(`affected-tests: --root is not a directory: ${root || "(missing)"}\n`);
		return 2;
	}
	const { tests: byPath, reasons, distance } = selectAffected(root, changed.filter((path) => path !== ""));
	const tests = order === "distance"
		? [...byPath].sort((left, right) => (distance.get(left) ?? 0) - (distance.get(right) ?? 0) || left.localeCompare(right))
		: byPath;
	for (const test of tests) process.stdout.write(`${test}\n`);
	if (explain) for (const test of tests) process.stderr.write(`affected: ${test} <- ${reasons.get(test)} (${distance.get(test)} hops)\n`);
	const direct = tests.filter((test) => distance.get(test) === 0).length;
	process.stderr.write(`affected-tests: ${tests.length} selected (${direct} changed, ${tests.length - direct} reach a changed path) from ${changed.length} changed paths under ${relative(process.cwd(), root) || "."}\n`);
	return 0;
}

if (import.meta.main) process.exit(main(process.argv.slice(2)));
