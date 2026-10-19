#!/usr/bin/env bun
/**
 * Expiring test quarantine (ompkit-v66l.27.2), after pi_agent_rust .github/workflows/ci.yml:365-595.
 *
 *   bun scripts/test-quarantine.ts check [--file tests/quarantine.json] [--today YYYY-MM-DD]
 *   bun scripts/test-quarantine.ts gate --junit FILE --bun-exit N [--file F] [--today D] [--report OUT]
 *   bun scripts/test-quarantine.ts run --junit FILE [--file F] [--today D] [--report OUT] -- bun test ARGS...
 *
 * check: every entry is complete (test id, category, owner, bead, evidence, repro, reason,
 *   remove_when), spans at most 14 days, and has not expired. An expired entry fails.
 * gate: check, then judge one bun JUnit report. Nothing is skipped: a quarantined test runs and
 *   is reported (QUARANTINED-FAIL or QUARANTINED-PASS); only its failure stops failing the step.
 *   Any other failing test fails, bun's exit status must be explained by failing testcases, and
 *   an entry naming a test that is gone from a file that ran fails as stale.
 * run: runs the bun test command once with a JUnit reporter appended, then gates it. No retries.
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

export const MAX_QUARANTINE_DAYS = 14;
export const CATEGORIES = ["FLAKE-TIMING", "FLAKE-ENV", "FLAKE-RACE", "FLAKE-RES", "FLAKE-EXT", "FLAKE-LOGIC"] as const;
const DEFAULT_FILE = resolve(import.meta.dir, "..", "tests", "quarantine.json");
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const BEAD = /^[a-z][a-z0-9]*-[a-z0-9][a-z0-9.]*$/;
const DAY_MS = 86_400_000;

export interface QuarantineEntry {
	/** `<file>::<describe> > ... > <test name>`, exactly as bun's JUnit report places it. */
	test: string;
	category: (typeof CATEGORIES)[number];
	owner: string;
	bead: string;
	quarantined: string;
	expires: string;
	/** CI run or job ids (or URLs) where the flake was observed. */
	evidence: string[];
	repro: string;
	reason: string;
	remove_when: string;
}
export interface EntryStatus { test: string; bead: string; owner: string; expires: string; days_remaining: number; status: "active" | "expiring-soon" | "expired" }
export interface RegistryReport { today: string; entries: EntryStatus[]; live: Map<string, QuarantineEntry>; errors: string[]; warnings: string[] }

function day(value: string): number | null {
	if (!DATE.test(value)) return null;
	const time = Date.parse(`${value}T00:00:00Z`);
	return Number.isNaN(time) || new Date(time).toISOString().slice(0, 10) !== value ? null : time;
}
const filled = (value: unknown): value is string => typeof value === "string" && value.trim() !== "";

/** Validates the registry against `today` (UTC date); expired and malformed entries are errors. */
export function checkRegistry(raw: string, today: string): RegistryReport {
	const report: RegistryReport = { today, entries: [], live: new Map(), errors: [], warnings: [] };
	const now = day(today);
	if (now === null) throw new Error(`invalid --today ${today}`);
	let parsed: unknown;
	try { parsed = JSON.parse(raw); } catch (error) {
		report.errors.push(`quarantine registry is not JSON: ${(error as Error).message}`);
		return report;
	}
	const document = parsed as { schema_version?: unknown; entries?: unknown };
	if (document?.schema_version !== 1 || !Array.isArray(document.entries)) {
		report.errors.push("quarantine registry needs schema_version 1 and an entries array");
		return report;
	}
	for (const [index, value] of document.entries.entries()) {
		const entry = value as Partial<QuarantineEntry>;
		const name = filled(entry?.test) ? entry.test : `entries[${index}]`;
		const missing = (["test", "owner", "bead", "repro", "reason", "remove_when"] as const).filter(key => !filled(entry?.[key]));
		if (missing.length) { report.errors.push(`${name}: missing ${missing.join(", ")}`); continue; }
		if (!entry.test!.includes("::")) { report.errors.push(`${name}: test must be <file>::<describe> > <name>`); continue; }
		if (!CATEGORIES.includes(entry.category as QuarantineEntry["category"])) { report.errors.push(`${name}: category must be one of ${CATEGORIES.join(", ")}`); continue; }
		if (!BEAD.test(entry.bead!)) { report.errors.push(`${name}: bead ${entry.bead} is not a bead id`); continue; }
		if (!Array.isArray(entry.evidence) || entry.evidence.length === 0 || !entry.evidence.every(filled)) {
			report.errors.push(`${name}: evidence must list the CI runs that observed the flake`); continue;
		}
		const from = day(entry.quarantined ?? ""), until = day(entry.expires ?? "");
		if (from === null || until === null) { report.errors.push(`${name}: quarantined and expires must be YYYY-MM-DD dates`); continue; }
		const span = (until - from) / DAY_MS;
		if (span < 0) { report.errors.push(`${name}: expires ${entry.expires} precedes quarantined ${entry.quarantined}`); continue; }
		if (span > MAX_QUARANTINE_DAYS) { report.errors.push(`${name}: quarantine window ${span}d exceeds ${MAX_QUARANTINE_DAYS}d`); continue; }
		if (from > now) { report.errors.push(`${name}: quarantined ${entry.quarantined} is after today ${today}`); continue; }
		if (report.live.has(entry.test!) || report.entries.some(row => row.test === entry.test)) { report.errors.push(`${name}: duplicate entry`); continue; }
		const daysRemaining = (until - now) / DAY_MS;
		const status = daysRemaining < 0 ? "expired" : daysRemaining <= 2 ? "expiring-soon" : "active";
		report.entries.push({ test: entry.test!, bead: entry.bead!, owner: entry.owner!, expires: entry.expires!, days_remaining: daysRemaining, status });
		if (status === "expired") report.errors.push(`${name}: EXPIRED ${-daysRemaining}d ago (bead ${entry.bead}, owner ${entry.owner}); fix the test or remove the entry`);
		else {
			report.live.set(entry.test!, entry as QuarantineEntry);
			if (status === "expiring-soon") report.warnings.push(`${name}: expires in ${daysRemaining}d (bead ${entry.bead}); fix it or refresh the evidence`);
		}
	}
	return report;
}

export interface JunitCase { id: string; file: string; status: "pass" | "fail" | "skip" }

function unescapeXml(value: string): string {
	return value.replace(/&(#x[0-9a-fA-F]{1,6}|#[0-9]{1,7}|lt|gt|amp|quot|apos);/g, (_, code: string) =>
		code === "lt" ? "<" : code === "gt" ? ">" : code === "amp" ? "&" : code === "quot" ? "\"" : code === "apos" ? "'"
			: String.fromCodePoint(code[1] === "x" ? Number.parseInt(code.slice(2), 16) : Number(code.slice(1))));
}

// Sticky and tried only at a `<` (tags) or where the previous match ended (attributes), and
// no class crosses the next `<`/`>`/`"`, so a report is scanned in linear time even when malformed.
const JUNIT_TAG = /<(\/?)(testsuites|testsuite|testcase|failure|error|skipped)\b([^<>]*)>/y;
const JUNIT_ATTRIBUTE = /\s*([A-Za-z_][\w.-]*)="([^"]*)"/y;

function attributesOf(text: string): Record<string, string> {
	const attributes: Record<string, string> = {};
	JUNIT_ATTRIBUTE.lastIndex = 0;
	for (let match = JUNIT_ATTRIBUTE.exec(text); match; match = JUNIT_ATTRIBUTE.exec(text)) attributes[match[1]!] = unescapeXml(match[2]!);
	return attributes;
}

/** Reads bun's JUnit report: one case per testcase, identified by file and its describe path. */
export function readJunit(xml: string): JunitCase[] {
	const cases: JunitCase[] = [];
	const suites: string[] = [];
	let open: JunitCase | null = null;
	for (let at = xml.indexOf("<"); at >= 0; at = xml.indexOf("<", at + 1)) {
		JUNIT_TAG.lastIndex = at;
		const tag = JUNIT_TAG.exec(xml);
		if (!tag) continue;
		const [, closing, name, rest] = tag as unknown as [string, string, string, string];
		const selfClosing = rest.endsWith("/");
		const attributes = attributesOf(rest);
		if (name === "testsuite") {
			if (closing) suites.pop();
			else if (!selfClosing) suites.push(attributes.file !== undefined && attributes.name === attributes.file ? "" : attributes.name ?? "");
		} else if (name === "testcase" && !closing) {
			const path = suites.filter(Boolean);
			const file = attributes.file ?? "";
			open = { id: `${file}::${[...path, attributes.name ?? ""].join(" > ")}`, file, status: "pass" };
			cases.push(open);
			if (selfClosing) open = null;
		} else if (name === "testcase") open = null;
		else if (open && !closing && (name === "failure" || name === "error")) open.status = "fail";
		else if (open && !closing && name === "skipped" && open.status === "pass") open.status = "skip";
	}
	return cases;
}

export interface GateResult { exitCode: 0 | 1; lines: string[]; report: Record<string, unknown> }

/** Judges one JUnit report under the registry; returns the step's exit code and its report. */
export function gate(registry: RegistryReport, cases: JunitCase[], bunExit: number): GateResult {
	const lines = [...registry.warnings.map(text => `WARNING ${text}`), ...registry.errors.map(text => `ERROR ${text}`)];
	const errors = [...registry.errors];
	if (cases.length === 0) errors.push("the JUnit report holds no testcases; the suite did not report");
	const failing = cases.filter(test => test.status === "fail");
	const quarantinedFail = failing.filter(test => registry.live.has(test.id));
	const unquarantinedFail = failing.filter(test => !registry.live.has(test.id));
	const ran = new Set(cases.map(test => test.file));
	const ids = new Set(cases.map(test => test.id));
	const stale = [...registry.live.keys()].filter(id => ran.has(id.slice(0, id.indexOf("::"))) && !ids.has(id));
	for (const id of stale) errors.push(`${id}: stale quarantine entry; its file ran but the test is gone`);
	if (bunExit !== 0 && failing.length === 0) errors.push(`bun test exited ${bunExit} but no testcase failed (crash, load error or hook failure outside a test)`);
	if (bunExit === 0 && failing.length > 0) errors.push(`bun test exited 0 with ${failing.length} failing testcase(s)`);
	for (const test of quarantinedFail) {
		const entry = registry.live.get(test.id)!;
		lines.push(`QUARANTINED-FAIL ${test.id} (bead ${entry.bead}, expires ${entry.expires}, repro: ${entry.repro})`);
	}
	for (const test of cases.filter(test => test.status === "pass" && registry.live.has(test.id))) {
		lines.push(`QUARANTINED-PASS ${test.id} (remove when: ${registry.live.get(test.id)!.remove_when})`);
	}
	for (const test of unquarantinedFail) lines.push(`FAIL ${test.id}`);
	for (const text of errors.slice(registry.errors.length)) lines.push(`ERROR ${text}`);
	const exitCode = errors.length || unquarantinedFail.length ? 1 : 0;
	lines.push(`quarantine gate: ${cases.length} ran, ${failing.length} failed (${quarantinedFail.length} quarantined), ${registry.live.size} live entr${registry.live.size === 1 ? "y" : "ies"}, ${exitCode === 0 ? "PASS" : "FAIL"}`);
	return { exitCode, lines, report: {
		schema: "omp-kit.test.quarantine_report.v1", today: registry.today, max_quarantine_days: MAX_QUARANTINE_DAYS,
		bun_exit: bunExit, status: exitCode === 0 ? "PASS" : "FAIL", ran: cases.length, failed: failing.length,
		quarantined_failures: quarantinedFail.map(test => test.id), unquarantined_failures: unquarantinedFail.map(test => test.id),
		entries: registry.entries, stale, errors,
	} };
}

function flag(args: string[], name: string): string | undefined {
	const index = args.indexOf(name);
	return index >= 0 ? args[index + 1] : undefined;
}

if (import.meta.main) {
	const separator = process.argv.indexOf("--");
	const args = process.argv.slice(2, separator >= 0 ? separator : undefined);
	const [mode] = args;
	const today = flag(args, "--today") ?? new Date().toISOString().slice(0, 10);
	const file = flag(args, "--file") ?? DEFAULT_FILE;
	const registry = checkRegistry(readFileSync(file, "utf8"), today);
	if (mode === "check") {
		for (const text of registry.warnings) console.log(`WARNING ${text}`);
		for (const text of registry.errors) console.error(`ERROR ${text}`);
		console.log(`quarantine registry: ${registry.entries.length} entr${registry.entries.length === 1 ? "y" : "ies"}, ${registry.errors.length} error(s), ${registry.errors.length ? "FAIL" : "PASS"}`);
		process.exit(registry.errors.length ? 1 : 0);
	}
	const junit = flag(args, "--junit");
	if ((mode !== "gate" && mode !== "run") || !junit) {
		console.error("usage: test-quarantine.ts check | gate --junit FILE --bun-exit N | run --junit FILE -- bun test ARGS...");
		process.exit(2);
	}
	let bunExit: number;
	if (mode === "run") {
		const command = separator >= 0 ? process.argv.slice(separator + 1) : [];
		if (command[0] !== "bun" || command[1] !== "test") {
			console.error("run takes a bun test command after --");
			process.exit(2);
		}
		const child = Bun.spawnSync([process.execPath, ...command.slice(1), "--reporter=junit", `--reporter-outfile=${junit}`],
			{ stdin: "inherit", stdout: "inherit", stderr: "inherit" });
		bunExit = child.exitCode ?? 1;
	} else {
		bunExit = Number(flag(args, "--bun-exit"));
		if (!Number.isInteger(bunExit)) {
			console.error("gate needs --bun-exit with bun test's exit status");
			process.exit(2);
		}
	}
	const result = gate(registry, existsSync(junit) ? readJunit(readFileSync(junit, "utf8")) : [], bunExit);
	const reportPath = flag(args, "--report");
	if (reportPath) writeFileSync(reportPath, `${JSON.stringify(result.report, null, 2)}\n`);
	for (const line of result.lines) (line.startsWith("ERROR") || line.startsWith("FAIL") ? console.error : console.log)(line);
	process.exit(result.exitCode);
}
