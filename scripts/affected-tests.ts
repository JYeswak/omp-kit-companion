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
//       transitively, including literal code paths (a test that spawns `src/cli.ts` or runs
//       `$ROOT/scripts/x.sh`). Doc/data references count only directly from a test.
//   (c) an exact required_tests policy obligation names it for the changed file, where static
//       inference cannot recover a known consumer (for example an imported data-path constant).
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
const SKIP_DIR: Record<string, true> = { ".git": true, node_modules: true, var: true, dist: true, __pycache__: true };
const FIXTURE_DIRS: Record<string, true> = { fixtures: true, __fixtures__: true };

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
	if (rel.split("/").some((part) => Object.hasOwn(FIXTURE_DIRS, part))) return false;
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

export type SelectionGraph = {
	files: ReadonlySet<string>;
	dependencies: ReadonlyMap<string, ReadonlySet<string>>;
	testReferences: ReadonlyMap<string, ReadonlySet<string>>;
	problems: ReadonlyMap<string, string>;
};

export function isCodeFile(rel: string): boolean {
	return SCANNED_EXT.some((ext) => rel.endsWith(ext));
}

function isCodePath(rel: string): boolean {
	return isCodeFile(rel) &&
		!rel.split("/").some((part) => Object.hasOwn(FIXTURE_DIRS, part));
}

export type SelectionPolicy = {
	noTest: Map<string, string>;
	requiredTests: Map<string, { tests: string[]; reason: string }>;
};

export function isExactSelectionPath(path: string): boolean {
	return path.length > 0 && path.trim() === path && !path.includes("\\") &&
		!["*", "?", "[", "]", "{", "}", "\0", "\n", "\r"].some((char) => path.includes(char)) &&
		path.split("/").every((part) => part !== "" && part !== "." && part !== "..");
}

function policyObject(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function noTestReason(file: string, reason: unknown, files: ReadonlySet<string>): string {
	if (!isExactSelectionPath(file)) throw new Error(`no_test key is not an exact repository-relative file: ${JSON.stringify(file)}`);
	if (!files.has(file)) throw new Error(`no_test declaration names a missing regular file: ${file}`);
	if (typeof reason !== "string" || !reason.trim()) throw new Error(`no_test reason must be nonempty for ${file}`);
	return reason;
}

function requiredTestObligation(file: string, value: unknown, files: ReadonlySet<string>): { tests: string[]; reason: string } {
	if (!isExactSelectionPath(file) || !files.has(file))
		throw new Error(`required_tests source must be an exact existing regular file: ${JSON.stringify(file)}`);
	if (!policyObject(value) || Object.keys(value).length !== 2 ||
		!Object.hasOwn(value, "tests") || !Object.hasOwn(value, "reason") ||
		!Array.isArray(value.tests) || value.tests.length === 0 ||
		typeof value.reason !== "string" || !value.reason.trim())
		throw new Error(`required_tests ${file} must contain exactly nonempty tests and reason`);
	const tests: string[] = [];
	for (const test of value.tests) {
		if (typeof test !== "string" || !isExactSelectionPath(test) || !files.has(test) || !isTestFile(test))
			throw new Error(`required_tests ${file} names a missing, invalid, or fixture test: ${JSON.stringify(test)}`);
		if (tests.includes(test)) throw new Error(`required_tests ${file} repeats test ${test}`);
		tests.push(test);
	}
	return { tests, reason: value.reason };
}

/** Human no-test decisions and irreducible obligations only, never generated graph snapshots. */
export function readSelectionPolicy(root: string, files: ReadonlySet<string>): SelectionPolicy {
	const policy: SelectionPolicy = { noTest: new Map(), requiredTests: new Map() };
	const path = join(root, ".github/test-selection.json");
	if (!existsSync(path)) return policy;
	const value: unknown = JSON.parse(readFileSync(path, "utf8"));
	if (!policyObject(value) || value.version !== 1 || !policyObject(value.no_test) ||
		!Object.hasOwn(value, "version") || !Object.hasOwn(value, "no_test") ||
		Object.keys(value).some((key) => key !== "version" && key !== "no_test" && key !== "required_tests"))
		throw new Error("expected version:1, exact no_test reasons, and optional required_tests obligations only");
	for (const [file, reason] of Object.entries(value.no_test))
		policy.noTest.set(file, noTestReason(file, reason, files));
	if (Object.hasOwn(value, "required_tests")) {
		if (!policyObject(value.required_tests)) throw new Error("required_tests must be an object of exact-file obligations");
		for (const [file, obligation] of Object.entries(value.required_tests))
			policy.requiredTests.set(file, requiredTestObligation(file, obligation, files));
	}
	return policy;
}

/** Return the next position, or the same position when no comment starts here. */
function skipPathComment(text: string, at: number, literalsOnly: boolean): number {
	if ((literalsOnly && text.startsWith("//", at)) || (!literalsOnly && text.charAt(at) === "#")) {
		const end = text.indexOf("\n", at);
		return end === -1 ? text.length : end + 1;
	}
	if (literalsOnly && text.startsWith("/*", at)) {
		const end = text.indexOf("*/", at + 2);
		return end === -1 ? text.length : end + 2;
	}
	return at;
}

function isHexText(text: string, length: number): boolean {
	if (text.length !== length) return false;
	for (const char of text) if (!"0123456789abcdefABCDEF".includes(char)) return false;
	return true;
}

/** Append one decoded literal without allocating a token object; return its ending position. */
function appendQuotedPath(text: string, at: number, parts: string[]): number {
	const quote = text.charAt(at++);
	let literal = "";
	while (at < text.length) {
		const next = text.charAt(at++);
		if (next === quote) break;
		if (next !== "\\" || at >= text.length) { literal += next; continue; }
		const escaped = text.charAt(at++);
		if (escaped !== "u" && escaped !== "x") {
			literal += escaped === "n" || escaped === "r" || escaped === "t" ? " " : escaped;
			continue;
		}
		const length = escaped === "u" ? 4 : 2;
		const digits = text.slice(at, at + length);
		if (isHexText(digits, length)) {
			literal += String.fromCharCode(Number.parseInt(digits, 16));
			at += length;
		} else literal += " ";
	}
	parts.push(literal);
	return at;
}

type PathCall = { path: boolean; suffix: string[]; literal: string | null; other: boolean };

function finishPathArgument(call: PathCall): void {
	if (!call.other && call.literal !== null) call.suffix.push(call.literal);
	else call.suffix.length = 0;
	call.literal = null;
	call.other = false;
}

function isPathCallAt(text: string, at: number): boolean {
	let end = at;
	while (end > 0 && text.charAt(end - 1).trim() === "") end--;
	let start = end;
	while (start > 0 && "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789_$".includes(text.charAt(start - 1))) start--;
	const name = text.slice(start, end);
	return name === "join" || name === "resolve";
}

function recordCallLiteral(calls: PathCall[], literal: string): void {
	const call = calls[calls.length - 1];
	if (!call) return;
	if (call.literal !== null) call.other = true;
	call.literal = literal;
}

function recordCallCharacter(text: string, at: number, calls: PathCall[], parts: string[]): void {
	const char = text.charAt(at);
	const call = calls[calls.length - 1];
	if (char === "(") {
		if (call) call.other = true;
		calls.push({ path: isPathCallAt(text, at), suffix: [], literal: null, other: false });
	} else if (char === ")") {
		const closed = calls.pop();
		if (!closed?.path) return;
		finishPathArgument(closed);
		if (closed.suffix.length > 1) parts.push(closed.suffix.join("/"), "\n");
	} else if (char === "," && call) finishPathArgument(call);
	else if (call && char.trim() !== "") call.other = true;
}

/**
 * Bun parses TS/JS before we examine its literal strings, not comments or identifiers.
 * Static template fragments count too; computed paths without a literal repo tail cannot be
 * inferred. Shell/Python also admit unquoted command paths, but discard line comments.
 * This is lexical path recognition, not an assertion that a named command is executed.
 */
function pathText(text: string, literalsOnly: boolean): string {
	const parts: string[] = [];
	const calls: PathCall[] = [];
	const slashParts: string[] = [];
	let previousEnd = -1;
	for (let at = 0; at < text.length;) {
		const afterComment = skipPathComment(text, at, literalsOnly);
		if (afterComment !== at) { parts.push("\n"); at = afterComment; continue; }
		const char = text.charAt(at);
		if (char !== '"' && char !== "'" && char !== "`") {
			if (literalsOnly) recordCallCharacter(text, at, calls, parts);
			else parts.push(char);
			at++;
			continue;
		}
		const start = at;
		at = appendQuotedPath(text, at, parts);
		const literal = parts[parts.length - 1] ?? "";
		parts.push("\n");
		if (literalsOnly) { recordCallLiteral(calls, literal); continue; }
		// pathlib's literal / segments also occur in Python embedded in shell heredocs.
		if (previousEnd < 0 || text.slice(previousEnd, start).trim() !== "/") slashParts.length = 0;
		slashParts.push(literal);
		if (slashParts.length > 1) parts.push(slashParts.join("/"), "\n");
		previousEnd = at;
	}
	return parts.join("");
}

/** Static dirname/cd/pwd shell idiom; never guess an arbitrary command's basename. */
function shellJoinedPaths(text: string): string {
	const paths: string[] = [];
	for (const line of text.split("\n")) {
		if (line.trimStart().startsWith("#")) continue;
		const pwd = line.indexOf("&& pwd");
		if (pwd === -1) continue;
		const close = line.indexOf(")", pwd);
		if (close === -1 || line.charAt(close + 1) !== "/") continue;
		const command = line.slice(pwd + 2, close).trim();
		if (command !== "pwd" && command !== "pwd -P") continue;
		const quoteEnd = line.lastIndexOf('"', pwd);
		const quoteStart = line.lastIndexOf('"', quoteEnd - 1);
		if (quoteStart === -1 || quoteEnd === -1) continue;
		let directory = line.slice(quoteStart + 1, quoteEnd);
		// The opening quote may belong to "$0" inside $(dirname ...).
		const dirnameEnd = directory.lastIndexOf(")");
		if (dirnameEnd !== -1) directory = directory.slice(dirnameEnd + 1);
		if (directory.startsWith("/../") || directory.startsWith("/./")) directory = directory.slice(1);
		let end = close + 2;
		while (end < line.length && isPathChar(line.charCodeAt(end))) end++;
		paths.push(directory + line.slice(close + 1, end));
	}
	return paths.join("\n");
}

function parseSource(
	rel: string,
	text: string,
	files: ReadonlySet<string>,
	parsers: Map<string, Bun.Transpiler>,
	targets: Set<string>,
): string {
	// Bun executes hashbang sources, but Transpiler scanning rejects #!. Treat only the
	// initial directive as a same-width comment; retain every newline/source position.
	const parseText = text.startsWith("#!") ? `//${text.slice(2)}` : text;
	const loader = loaderFor(rel);
	let parser = parsers.get(loader);
	if (!parser) parsers.set(loader, (parser = new Bun.Transpiler({ loader })));
	for (const item of parser.scanImports(parseText)) {
		const target = resolveSpecifier(files, rel, item.path);
		if (target) targets.add(target);
		else if (item.path.startsWith("./") || item.path.startsWith("../"))
			throw new Error(`unresolved local import ${JSON.stringify(item.path)}`);
	}
	// scanImports alone can accept a prefix; transform validates the whole source body.
	return parser.transformSync(parseText);
}

/** Shared parsing only: selection walks reverse edges; the coverage oracle walks forward. */
export function buildSelectionGraph(root: string): SelectionGraph {
	const all = walk(root);
	const files = new Set(all);
	const dependencies = new Map<string, Set<string>>();
	const testReferences = new Map<string, Set<string>>();
	const problems = new Map<string, string>();
	const parsers = new Map<string, Bun.Transpiler>();
	for (const rel of all) {
		if (!isCodePath(rel)) continue;
		try {
			const text = readFileSync(join(root, rel), "utf8");
			const targets = new Set<string>();
			const source = SOURCE_EXT.some((ext) => rel.endsWith(ext));
			const literalSource = source ? parseSource(rel, text, files, parsers, targets) : text;
			const direct = new Set<string>();
			const named = pathText(literalSource, source) + (rel.endsWith(".sh") ? `\n${shellJoinedPaths(text)}` : "");
			for (const target of referencedPaths(named, files, rel)) {
				if (isCodePath(target)) targets.add(target);
				else if (isTestFile(rel)) direct.add(target);
			}
			dependencies.set(rel, targets);
			if (direct.size > 0) testReferences.set(rel, direct);
		} catch (error) {
			problems.set(rel, error instanceof Error ? error.message : String(error));
		}
	}
	return { files, dependencies, testReferences, problems };
}

export function selectAffected(root: string, changed: readonly string[]): Selection {
	const graph = buildSelectionGraph(root);
	const files = graph.files;
	if (graph.problems.size > 0) {
		const [file, reason] = graph.problems.entries().next().value as [string, string];
		throw new Error(`SELECTION_GAP ${file}: dependency analysis failed: ${reason}`);
	}
	let policy: SelectionPolicy;
	try { policy = readSelectionPolicy(root, files); }
	catch (error) {
		throw new Error(`SELECTION_GAP .github/test-selection.json: ${error instanceof Error ? error.message : String(error)}`);
	}
	const importers = new Map<string, Set<string>>();
	const namers = new Map<string, Set<string>>();
	const reverse = (forward: ReadonlyMap<string, ReadonlySet<string>>, into: Map<string, Set<string>>) => {
		for (const [from, targets] of forward) for (const target of targets) {
			let parents = into.get(target);
			if (!parents) into.set(target, (parents = new Set()));
			parents.add(from);
		}
	};
	reverse(graph.dependencies, importers);
	reverse(graph.testReferences, namers);
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
		for (const test of policy.requiredTests.get(start)?.tests ?? []) {
			if (!seen.has(test)) { seen.set(test, 1); queue.push(test); }
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
