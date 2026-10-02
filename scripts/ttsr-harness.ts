#!/usr/bin/env bun
/**
 * ttsr-harness.ts — G1 compile, coverage, G2 wire cases, G3 streamed-prefix sweep,
 * CLI crosscheck, and G5 corpus fire-rate report for omp-kit's managed rules.
 *
 * Everything runs through omp's own TtsrManager, loaded from OMP_SRC, with the match
 * context the live path builds (session/ttsr-coordinator.ts #checkStream):
 *   bash        raw partial JSON of the arguments, accumulated with checkDelta per chunk,
 *               then checkSnapshot(JSON.stringify(args)) at toolcall_end;
 *   write/edit  the decoded content digest, via checkSnapshot (it replaces the buffer), and
 *               astCondition rules via checkAstSnapshot once, at toolcall_end (#checkAstStream);
 *   text        checkDelta, accumulated.
 *
 * Usage:
 *   bun scripts/ttsr-harness.ts --observe --rule NAME --line N [--rules DIR] [--cases FILE] [--rule-sha256 EXPECTED_SHA] [--timeout-ms N]
 *   Bind an external selection with --rule-sha256; without it, output names observed bytes but cannot reject substitution.
 *   Observation workers use a disposable HOME/XDG/tmp and preserve stderr; invoking Bun's own cache is caller-managed.
 *   bun scripts/ttsr-harness.ts --gate [--rules DIR] [--cases FILE] | --gate-json [--rules DIR] [--cases FILE]
 *   bun scripts/ttsr-harness.ts --selftest
 *   bun scripts/ttsr-harness.ts --cli-crosscheck [--jobs N]
 *   bun scripts/ttsr-harness.ts --corpus [--limit-files N] [--out reports/corpus-fire-rate.tsv]
 * Env: OMP_SRC (omp TypeScript source dir), OMP_BIN (omp executable, default `omp`).
 */
import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { LoadedRule, Rule } from "./rule-class.ts";

const KIT = path.resolve(import.meta.dir, "..");
// The rule loader and this harness must read the same installed omp package.
const OMP_BIN = process.env.OMP_BIN ?? "omp";
// A separate process is required: a pathological synchronous matcher can block JS timers.
// The worker never calls a model or reads an operator profile; it receives the selected fixture.
if (process.argv.includes("--observe") && !process.argv.includes("--observe-child")) {
	const option = (flag: string): string => {
		const index = process.argv.indexOf(flag);
		return index < 0 ? "" : process.argv[index + 1] ?? "";
	};
	const rule = option("--rule");
	const caseLine = Number(option("--line"));
	const rawTimeout = option("--timeout-ms");
	const timeoutMs = rawTimeout === "" ? 30_000 : Number(rawTimeout);
	if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 120_000) {
		console.log(JSON.stringify({ status: "UNAVAILABLE", rule, case_line: caseLine, reason: "INVALID_TIMEOUT", evaluator: "UNAVAILABLE" }));
		process.exit(1);
	}
	// Importing OMP initializes its logger. Keep those writes, caches and profiles
	// inside an owned worker directory, just as the packaged runtime does.
	const privateRoot = fs.mkdtempSync(path.join(os.tmpdir(), "omp-kit-observe-"));
	let exitCode = 1;
	let timer: NodeJS.Timeout | undefined;
	try {
		const env: Record<string, string> = {};
		for (const key of ["PATH", "LANG", "LC_ALL", "CI", "NO_COLOR", "OMP_SRC"]) {
			const value = process.env[key];
			if (value !== undefined) env[key] = value;
		}
		for (const [key, directory] of [
			["HOME", "home"], ["TMPDIR", "tmp"], ["XDG_CONFIG_HOME", "xdg-config"],
			["XDG_CACHE_HOME", "xdg-cache"], ["XDG_DATA_HOME", "xdg-data"],
			["XDG_STATE_HOME", "xdg-state"], ["BUN_INSTALL", "bun-install"],
		] as const) {
			const directoryPath = path.join(privateRoot, directory);
			fs.mkdirSync(directoryPath);
			env[key] = directoryPath;
		}
		env.TMP = env.TEMP = path.join(privateRoot, "tmp");
		env.OMP_BIN = OMP_BIN;
		env.BUN_BE_BUN = "1";
		const worker = Bun.spawn([process.execPath, import.meta.path, ...process.argv.slice(2), "--observe-child"], {
			env, stdout: "pipe", stderr: "pipe",
		});
		let timedOut = false;
		timer = setTimeout(() => { timedOut = true; worker.kill("SIGKILL"); }, timeoutMs);
		const [code, stdout, stderr] = await Promise.all([
			worker.exited,
			new Response(worker.stdout).text(),
			new Response(worker.stderr).text(),
		]);
		if (stderr) process.stderr.write(stderr);
		if (timedOut) {
			console.log(JSON.stringify({ status: "UNAVAILABLE", rule, case_line: caseLine, reason: "EVALUATOR_TIMEOUT", evaluator: "UNAVAILABLE" }));
		} else {
			if (stdout) process.stdout.write(stdout);
			if (code !== 0 && !stdout.trim()) {
				console.log(JSON.stringify({ status: "UNAVAILABLE", rule, case_line: caseLine, reason: "MATCHER_CHILD_FAILED", evaluator: "UNAVAILABLE" }));
			}
			exitCode = code ?? 1;
		}
	} finally {
		clearTimeout(timer);
		fs.rmSync(privateRoot, { recursive: true, force: true });
	}
	process.exit(exitCode);
}

let OMP_SRC!: string;
let loadRuleFile!: (file: string) => LoadedRule;
let loadRules!: (dir: string) => LoadedRule[];
let ttsrMod!: Record<string, unknown>;
let ruleMod!: Record<string, unknown>;
try {
	// OMP_SRC and its native modules are selected at runtime. An unavailable matcher cannot
	// be reported as a quiet rule when the caller requested a structured witness.
	const loader = await import("./rule-class.ts");
	({ OMP_SRC, loadRuleFile, loadRules } = loader);
	ttsrMod = await import(path.join(OMP_SRC, "export/ttsr.ts"));
	ruleMod = await import(path.join(OMP_SRC, "capability/rule.ts"));
} catch (error) {
	if (!process.argv.includes("--observe")) throw error;
	const value = (flag: string) => {
		const index = process.argv.indexOf(flag);
		return index < 0 ? "" : process.argv[index + 1] ?? "";
	};
	console.log(JSON.stringify({ status: "UNAVAILABLE", rule: value("--rule"), case_line: Number(value("--line")), reason: "MATCHER_IMPORT_FAILED", evaluator: "UNAVAILABLE", detail: String(error) }));
	process.exit(1);
}

type Source = "text" | "thinking" | "tool";
interface MatchContext {
	source: Source;
	toolName?: string;
	filePaths?: string[];
	streamKey?: string;
}
interface Manager {
	addRule(rule: Rule): boolean;
	checkDelta(delta: string, ctx: MatchContext): Rule[];
	checkSnapshot(snapshot: string, ctx: MatchContext): Rule[];
	/** astCondition rules; omp runs this once per edit/write tool call, at toolcall_end. */
	checkAstSnapshot(snapshot: string, ctx: MatchContext): Promise<Rule[]>;
}
const TtsrManager = ttsrMod.TtsrManager as new (settings?: Record<string, unknown>) => Manager;
const compileRuleCondition = ruleMod.compileRuleCondition as (pattern: string) => RegExp;

// The one ttsr block every profile resolves to; the harness matches under the same settings.
const POLICY = JSON.parse(fs.readFileSync(path.join(KIT, "policy/ttsr.json"), "utf8")) as Record<string, unknown>;
const SETTINGS = { ...POLICY, enabled: true, disabledRules: [] };

// ---------------------------------------------------------------- rules
// Loading and classification live in rule-class.ts, over omp's own parser, so the harness,
// the live suite and the manifest cannot classify one file three ways.

// Same token grammar as TtsrManager#parseToolScopeToken (export/ttsr.ts). A token that fails
// it is logged and skipped live, which silently narrows or kills the rule.
const SCOPE_TOKEN = /^(?:(?<prefix>tool)(?::(?<tool>[a-z0-9_-]+))?|(?<bare>[a-z0-9_-]+))(?:\((?<path>[^)]+)\))?$/i;
function invalidScopeTokens(rule: Rule): string[] {
	const bad: string[] = [];
	for (const raw of rule.scope ?? []) {
		const t = raw.trim();
		if (t.length === 0) continue;
		const lower = t.toLowerCase();
		if (["text", "thinking", "tool", "toolcall"].includes(lower)) continue;
		if (!SCOPE_TOKEN.test(t)) bad.push(raw);
	}
	return bad;
}

interface G1Result {
	rule: string;
	ok: boolean;
	detail: string;
}

function g1(lr: LoadedRule): G1Result {
	const problems: string[] = [];
	// omp parses per-rule repeat keys as frontmatter and ignores them; only the profile policy
	// applies. Read them from omp's own parse, so a quoted or kebab-case key is still caught.
	const repeatKeys = ["repeatMode", "repeatGap"].filter(k => k in lr.frontmatter);
	if (repeatKeys.length > 0) problems.push(`unparsed frontmatter key(s): ${repeatKeys.join("; ")}`);
	for (const pattern of lr.rule.condition ?? []) {
		try {
			compileRuleCondition(pattern);
		} catch (error) {
			problems.push(`condition does not compile (omp drops it): ${pattern} :: ${(error as Error).message}`);
		}
	}
	const badScope = invalidScopeTokens(lr.rule);
	if (badScope.length > 0) problems.push(`invalid scope token(s) (omp skips them): ${badScope.join(", ")}`);
	// omp's ~/.agents/rules discovery drops a file whose frontmatter says `enabled: false`
	// (discoverRuleFromMarkdown); every other kit gate would still grade it GREEN.
	if (lr.frontmatter.enabled === false) problems.push("enabled: false: omp's discovery skips this file, so it never loads");
	// omp 18.3.0 matches astCondition asynchronously at toolcall_end and does not hold the tool for
	// the verdict. Measured live (e2e-live test-skip-ts-fire, 2026-09-24): the write landed, then
	// the interrupt told the model "Blocked before it was written". An interrupting rule needs a
	// regex condition; an AST match that interrupts reports a block that did not happen, even beside
	// a regex. prose-only is exempt: omp never interrupts a tool-source match under it.
	// Retire this check when e2e-live shows an astCondition tripwire leave its file unwritten.
	if (lr.cls === "tripwire" && lr.rule.interruptMode !== "prose-only" && (lr.rule.astCondition?.length ?? 0) > 0) {
		problems.push("astCondition on a blocking rule cannot block: omp runs it after the tool has executed (interruptMode never, or a regex condition)");
	}
	let how: string;
	if (lr.cls === "always") {
		how = "alwaysApply, no condition (system prompt)";
	} else {
		const registered = new TtsrManager(SETTINGS).addRule(lr.rule);
		if (!registered) problems.push("TtsrManager.addRule refused it: loads and never fires");
		how = registered
			? `registers (${lr.rule.condition?.length ?? 0} condition(s), ${lr.rule.astCondition?.length ?? 0} astCondition(s))`
			: "does not register";
		// self-trigger: under gap 0 a prose-scoped rule whose body matches its own condition
		// re-fires every time the model quotes the reminder, and deferred follow-ups have no
		// loop guard (ttsr-coordinator.ts:385-410). omp's own scope logic decides whether
		// text/thinking is in scope; the body is fed as the whole buffer.
		const body = lr.rule.content ?? "";
		for (const source of ["text", "thinking"] as const) {
			const m = new TtsrManager(SETTINGS);
			if (!registered || !m.addRule(lr.rule) || !hit(m.checkSnapshot(body, { source }), lr.name)) continue;
			const spans = (lr.rule.condition ?? []).flatMap(pattern => {
				const found = compileRuleCondition(pattern).exec(body);
				return found ? [JSON.stringify(found[0])] : [];
			});
			problems.push(`self-trigger: its own body fires it as ${source} (matched ${spans.join(", ") || "?"})`);
		}
	}
	return { rule: lr.name, ok: problems.length === 0, detail: problems.length === 0 ? how : problems.join(" | ") };
}

// ---------------------------------------------------------------- cases

interface Case {
	line: number;
	rule: string;
	expect: "fire" | "quiet";
	source: Source;
	tool: string;
	path: string;
	snippet: string;
	note: string;
}

function decodeSnippet(raw: string): string {
	return raw.replace(/\\([nt])/g, (_, c: string) => (c === "n" ? "\n" : "\t"));
}

function loadCases(file: string): { cases: Case[]; errors: string[] } {
	const cases: Case[] = [];
	const errors: string[] = [];
	const lines = fs.readFileSync(file, "utf8").split("\n");
	for (let i = 1; i < lines.length; i++) {
		const raw = lines[i].replace(/\r$/, "");
		if (raw.trim() === "" || raw.startsWith("#")) continue;
		const cols = raw.split("\t");
		if (cols.length < 6) {
			errors.push(`cases line ${i + 1}: ${cols.length} columns, need 7`);
			continue;
		}
		const [rule, expect, source, tool, p, snippet, note = ""] = cols;
		if (expect !== "fire" && expect !== "quiet") errors.push(`cases line ${i + 1}: expect=${expect}`);
		if (!["text", "thinking", "tool"].includes(source)) errors.push(`cases line ${i + 1}: source=${source}`);
		if (source === "tool" && !["bash", "edit", "write"].includes(tool)) errors.push(`cases line ${i + 1}: tool=${tool}`);
		cases.push({
			line: i + 1,
			rule,
			expect: expect as Case["expect"],
			source: source as Source,
			tool,
			path: p,
			snippet: decodeSnippet(snippet),
			note,
		});
	}
	return { cases, errors };
}

// Mirrors TtsrToolInspector#normalizePathCandidates (session/ttsr-outputs.ts) with the kit as cwd.
function pathCandidates(raw: string, cwd = KIT): string[] {
	const trimmed = raw.trim();
	if (trimmed.length === 0) return [];
	const input = trimmed.replaceAll("\\", "/");
	const out = new Set<string>([input]);
	if (input.startsWith("./")) out.add(input.slice(2));
	const abs = path.isAbsolute(trimmed) ? path.normalize(trimmed) : path.resolve(cwd, trimmed);
	out.add(abs.replaceAll("\\", "/"));
	const rel = path.relative(cwd, abs).replaceAll("\\", "/");
	if (rel && rel !== "." && !rel.startsWith("../") && rel !== "..") out.add(rel);
	return [...out];
}

function contextFor(c: Case): MatchContext {
	if (c.source !== "tool") return { source: c.source };
	const ctx: MatchContext = { source: "tool", toolName: c.tool, streamKey: `toolcall:harness#${c.line}` };
	if (c.path !== "-" && c.path !== "") ctx.filePaths = pathCandidates(c.path);
	return ctx;
}

/** The buffer omp matches for this case at toolcall_end / end of text. */
function wirePayload(c: Case): string {
	if (c.source === "tool" && c.tool === "bash") return JSON.stringify({ command: c.snippet });
	return c.snippet;
}

function hit(matches: Rule[], name: string): boolean {
	return matches.some(r => r.name === name);
}

const G2_CHUNK = 7;

/**
 * G2: full payload through the live-shaped path. Returns the verdict at the end of the stream.
 * For edit/write, omp also runs `astCondition` rules once at toolcall_end
 * (ttsr-coordinator.ts: `toolcall_end` -> #checkAstStream), so the verdict includes them.
 */
async function g2Fires(rule: Rule, c: Case): Promise<boolean> {
	const m = new TtsrManager(SETTINGS);
	if (!m.addRule(rule)) return false;
	const ctx = contextFor(c);
	const wire = wirePayload(c);
	if (c.source === "tool" && c.tool === "bash") {
		for (let i = 0; i < wire.length; i += G2_CHUNK) m.checkDelta(wire.slice(i, i + G2_CHUNK), ctx);
		return hit(m.checkSnapshot(wire, ctx), rule.name);
	}
	if (c.source === "tool") return hit(m.checkSnapshot(wire, ctx), rule.name) || hit(await m.checkAstSnapshot(wire, ctx), rule.name);
	return hit(m.checkSnapshot(wire, ctx), rule.name);
}

/**
 * G3: one character at a time. Returns every prefix length that fired (wire.length+1 = final
 * snapshot). astCondition rules are not swept: omp evaluates them only on the finished edit/write
 * call, so they can fire only at the final snapshot.
 */
async function g3Fires(rule: Rule, c: Case): Promise<{ fired: number[]; length: number }> {
	const m = new TtsrManager(SETTINGS);
	const fired: number[] = [];
	const wire = wirePayload(c);
	if (!m.addRule(rule)) return { fired, length: wire.length };
	const ctx = contextFor(c);
	const bash = c.source === "tool" && c.tool === "bash";
	for (let i = 1; i <= wire.length; i++) {
		const matches =
			c.source === "tool" && !bash ? m.checkSnapshot(wire.slice(0, i), ctx) : m.checkDelta(wire[i - 1], ctx);
		if (hit(matches, rule.name)) fired.push(i);
	}
	if (bash && hit(m.checkSnapshot(wire, ctx), rule.name)) fired.push(wire.length + 1);
	if (c.source === "tool" && !bash && hit(await m.checkAstSnapshot(wire, ctx), rule.name)) fired.push(wire.length + 1);
	return { fired, length: wire.length };
}

function show(s: string, max = 70): string {
	const one = JSON.stringify(s).slice(1, -1);
	return one.length > max ? `${one.slice(0, max - 1)}…` : one;
}

function ctxLabel(c: Case): string {
	if (c.source !== "tool") return c.source;
	return c.path !== "-" ? `tool:${c.tool}(${c.path})` : `tool:${c.tool}`;
}

// ---------------------------------------------------------------- gate

interface GateReport {
	failures: string[];
	lines: string[];
	counts: { rules: number; ttsrRules: number; cases: number; quietCases: number; quietPrefixFires: number };
	checks: {
		registration: { total: number; passed: number };
		coverage: { total: number; passed: number };
		payload: { total: number; passed: number };
		prefix: { total: number; passed: number; quietCases: number; quietPassed: number };
	};
	firstFires: { rule: string; line: number; expect: string; g2: string; first_fire: number | null; wire_length: number }[];
}

async function runGate(rulesDir: string, casesFile: string): Promise<GateReport> {
	const lines: string[] = [];
	const failures: string[] = [];
	let registrationPassed = 0;
	let coveragePassed = 0;
	let payloadPassed = 0;
	let prefixPassed = 0;
	let quietPassed = 0;
	const rules = loadRules(rulesDir);
	const byName = new Map(rules.map(r => [r.name, r]));
	if (rules.length === 0) failures.push(`G1 ${rulesDir}: no rules — an empty scan set is not a pass`);

	lines.push(`== G1 compile (${rules.length} rules, omp ${OMP_SRC})`);
	for (const lr of rules) {
		const r = g1(lr);
		lines.push(`${r.ok ? "PASS" : "FAIL"} G1 ${lr.name} [${lr.cls}] ${r.detail}`);
		if (r.ok) registrationPassed++;
		if (!r.ok) failures.push(`G1 ${lr.name}: ${r.detail}`);
	}

	const { cases, errors } = loadCases(casesFile);
	for (const e of errors) failures.push(`CASES ${e}`);
	if (cases.length === 0) failures.push(`CASES ${casesFile}: no cases — an empty case set is not a pass`);

	lines.push("== coverage");
	for (const lr of rules) {
		const mine = cases.filter(c => c.rule === lr.name);
		if (lr.cls === "always") {
			if (mine.length > 0) failures.push(`COVERAGE ${lr.name}: alwaysApply rule has cases it cannot match`);
			lines.push(`SKIP coverage ${lr.name} [always]: system prompt, no stream condition`);
			continue;
		}
		const nf = mine.filter(c => c.expect === "fire").length;
		const nq = mine.filter(c => c.expect === "quiet").length;
		const ok = nf > 0 && nq > 0;
		if (ok) coveragePassed++;
		lines.push(`${ok ? "PASS" : "FAIL"} coverage ${lr.name} [${lr.cls}] fire=${nf} quiet=${nq}`);
		if (!ok) failures.push(`COVERAGE ${lr.name}: fire=${nf} quiet=${nq}`);
	}
	for (const c of cases) {
		if (!byName.has(c.rule)) failures.push(`CASES line ${c.line}: unknown rule ${c.rule}`);
	}

	const quietCases = cases.filter(c => c.expect === "quiet").length;
	lines.push("== G2 wire + G3 prefix sweep");
	let quietPrefixFires = 0;
	const firstFires: GateReport["firstFires"] = [];
	for (const c of cases) {
		const lr = byName.get(c.rule);
		if (!lr || lr.cls === "always") continue;
		const g2 = await g2Fires(lr.rule, c);
		const g2ok = g2 === (c.expect === "fire");
		const { fired, length } = await g3Fires(lr.rule, c);
		const wire = wirePayload(c);
		let g3ok = true;
		let g3note: string;
		if (c.expect === "quiet") {
			g3ok = fired.length === 0;
			if (!g3ok) {
				quietPrefixFires++;
				const at = fired[0];
				g3note =
					at > length ? "fired at final snapshot" : `fired on prefix ${at}/${length}: …${show(wire.slice(0, at).slice(-50))}`;
			} else g3note = `quiet on all ${length} prefixes`;
		} else {
			g3note = fired.length > 0 ? `first fire at ${Math.min(fired[0], length)}/${length}` : "never fired while streaming";
		}
		const ok = g2ok && g3ok;
		if (g2ok) payloadPassed++;
		if (g3ok) {
			prefixPassed++;
			if (c.expect === "quiet") quietPassed++;
		}
		const tag = `${c.rule} ${c.expect} ${ctxLabel(c)} line ${c.line}`;
		lines.push(
			`${ok ? "PASS" : "FAIL"} ${tag} | G2 ${g2 ? "fire" : "quiet"}${g2ok ? "" : " (WRONG)"} | G3 ${g3note} | ${show(c.snippet)}`,
		);
		if (!g2ok) failures.push(`G2 ${tag}: wanted ${c.expect}, full payload ${g2 ? "fires" : "is quiet"}: ${show(wire)}`);
		if (!g3ok) failures.push(`G3 ${tag}: ${g3note}`);
		firstFires.push({ rule: c.rule, line: c.line, expect: c.expect, g2: g2 ? "fire" : "quiet",
			first_fire: fired.length > 0 ? Math.min(fired[0] ?? length, length) : null, wire_length: length });
	}
	return {
		failures,
		lines,
		counts: {
			rules: rules.length,
			ttsrRules: rules.filter(r => r.cls !== "always").length,
			cases: cases.length,
			quietCases,
			quietPrefixFires,
		},
		checks: {
			registration: { total: rules.length, passed: registrationPassed },
			coverage: { total: rules.filter(r => r.cls !== "always").length, passed: coveragePassed },
			payload: { total: cases.length, passed: payloadPassed },
			prefix: { total: cases.length, passed: prefixPassed, quietCases, quietPassed },
		},
		firstFires,
	};
}

function printGate(rep: GateReport, label: string): void {
	for (const l of rep.lines) console.log(l);
	console.log(`== summary (${label})`);
	console.log(
		`rules=${rep.counts.rules} ttsr_rules=${rep.counts.ttsrRules} cases=${rep.counts.cases} quiet_prefix_fires=${rep.counts.quietPrefixFires} failures=${rep.failures.length}`,
	);
	for (const f of rep.failures) console.log(`RED ${f}`);
	console.log(rep.failures.length === 0 ? "GATE: GREEN" : "GATE: RED");
}
function structuredGate(rep: GateReport) {
	return {
		schema_version: 1,
		status: rep.failures.length === 0 ? "PASS" : "FAIL",
		counts: {
			rules: rep.counts.rules,
			ttsr_rules: rep.counts.ttsrRules,
			cases: rep.counts.cases,
			quiet_cases: rep.counts.quietCases,
			quiet_prefix_fires: rep.counts.quietPrefixFires,
		},
		checks: {
			registration: rep.checks.registration,
			coverage: rep.checks.coverage,
			payload: rep.checks.payload,
			prefix: {
				total: rep.checks.prefix.total,
				passed: rep.checks.prefix.passed,
				quiet_cases: rep.checks.prefix.quietCases,
				quiet_passed: rep.checks.prefix.quietPassed,
			},
		},
		failures: rep.failures,
		cases: rep.firstFires,
	};
}

// ---------------------------------------------------------------- selftest

function writePlant(
	dir: string,
	name: string,
	p: { condition?: string; astCondition?: string; interruptMode?: string; enabled?: boolean },
	scope: string,
	body: string,
): void {
	const key = p.astCondition !== undefined ? "astCondition" : "condition";
	const value = `'${(p.astCondition ?? p.condition ?? "").replaceAll("'", "''")}'`;
	const enabled = p.enabled === false ? "enabled: false\n" : "";
	fs.writeFileSync(
		path.join(dir, `${name}.md`),
		`---\n${enabled}${key}:\n  - ${value}\nscope: "${scope}"\ninterruptMode: ${p.interruptMode ?? "always"}\n---\n${body}\n`,
	);
}

async function selftest(): Promise<number> {
	const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "ttsr-harness-selftest-"));
	const header = "rule\texpect\tsource\ttool\tpath\tsnippet\tnote\n";
	interface Plant {
		id: string;
		rule: string;
		condition?: string;
		/** An ast-grep pattern instead of a regex condition. */
		astCondition?: string;
		/** Default always (a tripwire); AST arms that must pass G1 are reminders. */
		interruptMode?: string;
		/** false writes `enabled: false`, which omp's discovery skips. */
		enabled?: boolean;
		scope: string;
		cases: string;
		/** RED the gate must report for a plant; omitted for a control, which must be GREEN. */
		wantRed?: RegExp;
		/** What a control proves; set only on controls. */
		control?: string;
		body?: string;
	}
	const plants: Plant[] = [
		{
			id: "a",
			rule: "plant-embedded-inline-flag",
			condition: "foo|(?i)bar",
			scope: "text",
			cases: "plant-embedded-inline-flag\tfire\ttext\t-\t-\tbar\tplanted\nplant-embedded-inline-flag\tquiet\ttext\t-\t-\tbaz\tplanted\n",
			wantRed: /^G1 plant-embedded-inline-flag: .*does not compile/,
		},
		{
			id: "b",
			rule: "plant-prefix-close",
			condition: "\\b(br|bd)\\s+close\\b(?![^\\n]*(--reason|-r)\\s)",
			scope: "tool:bash",
			cases:
				'plant-prefix-close\tfire\ttool\tbash\t-\tbr close x\tplanted\nplant-prefix-close\tquiet\ttool\tbash\t-\tbr close x --reason "cargo test -> 41 passed; commit a1b2c3d"\tplanted\n',
			wantRed: /^G3 plant-prefix-close quiet tool:bash line 3: fired on prefix/,
		},
		{
			id: "c",
			rule: "plant-wire-blind-reason",
			condition: "\\b(br|bd)\\s+close\\b[^\\n]*(--reason|-r)\\s+[\"']?(done|implemented|fixed|complete)\\b",
			scope: "tool:bash",
			cases:
				'plant-wire-blind-reason\tfire\ttool\tbash\t-\tbr close x --reason "done"\tplanted\nplant-wire-blind-reason\tquiet\ttool\tbash\t-\tbr close x\tplanted\n',
			wantRed: /^G2 plant-wire-blind-reason fire tool:bash line 2: wanted fire, full payload is quiet/,
		},
		{
			id: "d",
			rule: "plant-self-trigger",
			condition: "zzplant_self_trigger",
			scope: "text",
			body: "Do not write zzplant_self_trigger in prose.",
			cases: "plant-self-trigger\tfire\ttext\t-\t-\tsay zzplant_self_trigger\tplanted\nplant-self-trigger\tquiet\ttext\t-\t-\tsay zzplant_other\tplanted\n",
			wantRed: /^G1 plant-self-trigger: self-trigger: its own body fires it as text \(matched "zzplant_self_trigger"\)/,
		},
		{
			id: "e",
			rule: "plant-ast-markdown",
			astCondition: "zzplant_ast_token",
			interruptMode: "never",
			scope: "tool:write(*.md)",
			cases:
				"plant-ast-markdown\tfire\ttool\twrite\tnotes.md\tzzplant_ast_token\tplanted\nplant-ast-markdown\tquiet\ttool\twrite\tnotes.md\tThe notes mention zzplant_ast_token in passing.\tplanted\n",
			// ast-grep parses the pattern in the file's language. In Markdown a pattern with no
			// metavariable matches the same text anywhere in prose (measured on omp 18.3.0), so an
			// astCondition rule must be scoped to code files: this plant must go RED.
			wantRed: /^G2 plant-ast-markdown quiet tool:write\(notes\.md\) line 3: wanted quiet, full payload fires/,
		},
		{
			id: "f",
			rule: "plant-ast-tripwire",
			astCondition: "console.log($$$A)",
			scope: "tool:write(*.ts)",
			cases:
				'plant-ast-tripwire\tfire\ttool\twrite\tsrc/app.ts\tconsole.log("x");\tplanted\nplant-ast-tripwire\tquiet\ttool\twrite\tsrc/app.ts\tconst s = "console.log(x)";\tplanted\n',
			// Correct matches, wrong mechanism: a blocking rule that omp cannot run before the tool.
			wantRed: /^G1 plant-ast-tripwire: astCondition on a blocking rule cannot block/,
		},
		{
			id: "g",
			rule: "plant-disabled",
			condition: "zzplant_disabled",
			enabled: false,
			scope: "text",
			cases: "plant-disabled\tfire\ttext\t-\t-\tsay zzplant_disabled\tplanted\nplant-disabled\tquiet\ttext\t-\t-\tsay zzplant_other\tplanted\n",
			// Its cases pass on buildRuleFromMarkdown's object; omp's discovery would never load it.
			wantRed: /^G1 plant-disabled: enabled: false: omp's discovery skips this file/,
		},
	];
	// Controls must stay GREEN, or the gate is RED on everything and proves nothing.
	const shipped = loadRuleFile(path.join(KIT, "rules/kit-close-needs-evidence.md")).rule.condition ?? [];
	const controls: Plant[] = [
		{
			id: "control-close",
			rule: "plant-control-shipped-close",
			condition: shipped[0] ?? "",
			scope: "tool:bash",
			cases:
				'plant-control-shipped-close\tfire\ttool\tbash\t-\tbr close x\tcontrol\nplant-control-shipped-close\tquiet\ttool\tbash\t-\tbr close x --reason "cargo test -> 41 passed; commit a1b2c3d"\tcontrol\n',
			control: "shipped kit-close-needs-evidence condition is GREEN on the plant-(b) cases",
		},
		{
			id: "control-self",
			rule: "plant-control-self-trigger",
			condition: "zzplant_self_trigger",
			scope: "text",
			body: "Do not write the plant token in prose.",
			cases: "plant-control-self-trigger\tfire\ttext\t-\t-\tsay zzplant_self_trigger\tcontrol\nplant-control-self-trigger\tquiet\ttext\t-\t-\tsay zzplant_other\tcontrol\n",
			control: "plant (d) with a body that describes the trigger without spelling it is GREEN",
		},
		{
			id: "control-ast",
			rule: "plant-control-ast-code",
			astCondition: "console.log($$$A)",
			interruptMode: "never",
			scope: "tool:write(*.ts)",
			cases:
				'plant-control-ast-code\tfire\ttool\twrite\tsrc/app.ts\tconsole.log("x");\tcontrol\nplant-control-ast-code\tquiet\ttool\twrite\tsrc/app.ts\tconst s = "console.log(x)";\tcontrol\n',
			control: "an astCondition-only rule fires on code and stays quiet on a string literal, so G2/G3 run omp's AST matcher",
		},
		{
			id: "control-ast-prose-only",
			rule: "plant-control-ast-prose-only",
			astCondition: "console.log($$$A)",
			interruptMode: "prose-only",
			scope: "tool:write(*.ts)",
			cases:
				'plant-control-ast-prose-only\tfire\ttool\twrite\tsrc/app.ts\tconsole.log("x");\tcontrol\nplant-control-ast-prose-only\tquiet\ttool\twrite\tsrc/app.ts\tconst s = "console.log(x)";\tcontrol\n',
			control: "astCondition under prose-only passes G1: omp never interrupts a tool-source match under it",
		},
	];
	let bad = 0;
	for (const p of [...plants, ...controls]) {
		const dir = path.join(tmp, p.id);
		fs.mkdirSync(path.join(dir, "rules"), { recursive: true });
		writePlant(path.join(dir, "rules"), p.rule, p, p.scope, p.body ?? "planted by ttsr-harness --selftest");
		fs.writeFileSync(path.join(dir, "cases.tsv"), header + p.cases);
		const rep = await runGate(path.join(dir, "rules"), path.join(dir, "cases.tsv"));
		if (p.control) {
			const ok = rep.failures.length === 0;
			console.log(`${ok ? "ok  " : "FAIL"} control: ${p.control}`);
			for (const f of rep.failures) console.log(`       unexpected RED ${f}`);
			if (!ok) bad++;
			continue;
		}
		const wantRed = p.wantRed ?? /$^/;
		const named = rep.failures.filter(f => wantRed.test(f));
		if (named.length > 0) {
			console.log(`ok   plant (${p.id}) RED as intended: ${named[0]}`);
		} else {
			bad++;
			console.log(`FAIL plant (${p.id}) ${p.rule} did NOT go RED the named way (${wantRed}); got: ${rep.failures.join(" || ") || "GREEN"}`);
		}
	}
	fs.rmSync(tmp, { recursive: true, force: true });
	console.log(bad === 0 ? "SELFTEST: all seven plants RED and named; controls GREEN" : `SELFTEST: ${bad} arm(s) failed`);
	return bad === 0 ? 0 : 1;
}

// ---------------------------------------------------------------- cli crosscheck

async function cliCrosscheck(jobs: number): Promise<number> {
	const rules = loadRules(path.join(KIT, "rules"));
	const byName = new Map(rules.map(r => [r.name, r]));
	const { cases } = loadCases(path.join(KIT, "cases/cases.tsv"));
	const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "ttsr-harness-cli-"));
	const home = path.join(tmp, "home");
	fs.mkdirSync(home);
	// Isolated HOME, no inherited profile: OMP_PROFILE would load the profile's files.
	// --rule loads only the named file.
	const env: Record<string, string> = {};
	for (const [k, v] of Object.entries(process.env)) if (v !== undefined) env[k] = v;
	delete env.OMP_PROFILE;
	delete env.PI_PROFILE;
	delete env.PI_CODING_AGENT_DIR;
	env.HOME = home;
	let disagreements = 0;
	let errors = 0;
	const todo = cases.filter(c => byName.get(c.rule)?.cls !== "always" && byName.has(c.rule));
	const results: string[] = new Array(todo.length);
	let next = 0;
	async function worker(): Promise<void> {
		while (next < todo.length) {
			const idx = next++;
			const c = todo[idx];
			const lr = byName.get(c.rule)!;
			const snippetFile = path.join(tmp, `case-${c.line}.txt`);
			fs.writeFileSync(snippetFile, wirePayload(c));
			const args = [OMP_BIN, "ttsr", "test", "--rule", lr.file, "--source", c.source];
			if (c.source === "tool") args.push("--tool", c.tool);
			if (c.path !== "-" && c.path !== "") args.push("--path", c.path);
			args.push("--json", "--file", snippetFile);
			const proc = Bun.spawn(args, { cwd: tmp, env, stdout: "pipe", stderr: "pipe" });
			const [out, err] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
			const code = await proc.exited;
			const harness = await g2Fires(lr.rule, c);
			let cli: boolean | undefined;
			try {
				const report = JSON.parse(out.trim().split("\n").pop() ?? "") as { triggered?: { name: string }[] };
				cli = (report.triggered ?? []).some(t => t.name === c.rule);
			} catch {
				cli = undefined;
			}
			const tag = `${c.rule} ${c.expect} ${ctxLabel(c)} line ${c.line}`;
			if (cli === undefined) {
				errors++;
				results[idx] = `ERROR ${tag}: omp exit ${code}, unparseable output: ${show(out + err, 160)}`;
			} else if (cli !== harness) {
				disagreements++;
				results[idx] = `DISAGREE ${tag}: omp ttsr test=${cli ? "fire" : "quiet"} harness G2=${harness ? "fire" : "quiet"} | ${show(wirePayload(c))}`;
			} else {
				results[idx] = `AGREE ${tag}: both ${cli ? "fire" : "quiet"}`;
			}
		}
	}
	await Promise.all(Array.from({ length: Math.max(1, jobs) }, worker));
	fs.rmSync(tmp, { recursive: true, force: true });
	for (const r of results) console.log(r);
	const version = Bun.spawnSync([OMP_BIN, "--version"], { env }).stdout.toString().trim();
	console.log(`== summary: ${version}, cases=${todo.length} agree=${todo.length - disagreements - errors} disagreements=${disagreements} errors=${errors}`);
	console.log(disagreements === 0 && errors === 0 ? "CROSSCHECK: GREEN" : "CROSSCHECK: RED");
	return disagreements === 0 && errors === 0 ? 0 : 1;
}

// ---------------------------------------------------------------- corpus (G5)

function* walkJsonl(dir: string): Generator<string> {
	let entries: fs.Dirent[];
	try {
		entries = fs.readdirSync(dir, { withFileTypes: true });
	} catch {
		return;
	}
	for (const e of entries) {
		const p = path.join(dir, e.name);
		if (e.isDirectory()) yield* walkJsonl(p);
		else if (e.isFile() && e.name.endsWith(".jsonl")) yield p;
	}
}

function corpusRoots(): string[] {
	const home = os.homedir();
	const roots = [path.join(home, ".omp/agent/sessions")];
	const profiles = path.join(home, ".omp/profiles");
	try {
		for (const p of fs.readdirSync(profiles)) roots.push(path.join(profiles, p, "agent/sessions"));
	} catch {}
	return roots;
}

async function* jsonlLines(file: string): AsyncGenerator<string> {
	const decoder = new TextDecoder();
	let carry = "";
	for await (const chunk of Bun.file(file).stream()) {
		carry += decoder.decode(chunk, { stream: true });
		let nl = carry.indexOf("\n");
		while (nl !== -1) {
			yield carry.slice(0, nl);
			carry = carry.slice(nl + 1);
			nl = carry.indexOf("\n");
		}
	}
	carry += decoder.decode();
	if (carry.length > 0) yield carry;
}

const APPROX_EDIT_FIELDS = /^(new_?text|new_?string|newText|newString|content|replacement|replace|patch|diff|input|text)$/i;

async function corpus(limitFiles: number, outFile: string): Promise<number> {
	const natives = await import(path.join(path.dirname(OMP_SRC), "..", "pi-natives"));
	const editInspect = natives.editInspect as (mode: string, json: string) => { entries: { path: string; digest: string }[] };
	const rules = loadRules(path.join(KIT, "rules")).filter(r => r.cls !== "always");
	const byName = new Map(rules.map(r => [r.name, r]));
	const matchM = new TtsrManager(SETTINGS);
	const scopeM = new TtsrManager(SETTINGS);
	for (const lr of rules) {
		matchM.addRule(lr.rule);
		// Scope probe: the same rule with a match-everything condition, so omp's own scope and
		// path-glob logic decides which events count as scanned for that rule.
		scopeM.addRule({ ...lr.rule, condition: ["[\\s\\S]*"], astCondition: [] });
	}
	type Kind = "text" | "bash" | "write" | "edit" | "edit~approx";
	const stats = new Map<string, { scanned: number; fires: number; sample: string }>();
	const bump = (rule: string, kind: Kind, fired: boolean, payload: string) => {
		const key = `${rule}\t${kind}`;
		let s = stats.get(key);
		if (!s) stats.set(key, (s = { scanned: 0, fires: 0, sample: "" }));
		s.scanned++;
		if (fired) {
			s.fires++;
			if (!s.sample) s.sample = JSON.stringify(payload).slice(1, -1).replaceAll("\t", " ").slice(0, 120);
		}
	};
	const evaluate = async (payload: string, ctx: MatchContext, kind: Kind) => {
		const inScope = scopeM.checkSnapshot(payload, ctx);
		if (inScope.length === 0) return;
		// Live, an edit/write call is matched by regex while it streams and by astCondition once
		// it ends; count either, as the coordinator does.
		const matched = matchM.checkSnapshot(payload, ctx);
		if (ctx.source === "tool" && ctx.toolName !== "bash") matched.push(...(await matchM.checkAstSnapshot(payload, ctx)));
		const fired = new Set(matched.map(r => r.name));
		for (const r of inScope) bump(r.name, kind, fired.has(r.name), payload);
	};
	const files: string[] = [];
	for (const root of corpusRoots()) for (const f of walkJsonl(root)) files.push(f);
	files.sort();
	const scanFiles = limitFiles > 0 ? files.slice(0, limitFiles) : files;
	const kindCounts: Record<string, number> = {};
	let lineCount = 0;
	let parseErrors = 0;
	const started = Date.now();
	for (const [fi, file] of scanFiles.entries()) {
		for await (const line of jsonlLines(file)) {
			if (!line.includes('"assistant"')) continue;
			let entry: { type?: string; message?: { role?: string; content?: unknown } };
			try {
				entry = JSON.parse(line);
			} catch {
				parseErrors++;
				continue;
			}
			if (entry.type !== "message" || entry.message?.role !== "assistant" || !Array.isArray(entry.message.content)) continue;
			lineCount++;
			for (const block of entry.message.content as Record<string, unknown>[]) {
				if (block.type === "text" && typeof block.text === "string" && /\S/.test(block.text)) {
					kindCounts.text = (kindCounts.text ?? 0) + 1;
					await evaluate(block.text, { source: "text" }, "text");
					continue;
				}
				if (block.type !== "toolCall") continue;
				const name = String(block.name ?? "");
				const args = block.arguments;
				if (name === "bash") {
					kindCounts.bash = (kindCounts.bash ?? 0) + 1;
					const wire = typeof args === "string" ? args : JSON.stringify(args ?? {});
					await evaluate(wire, { source: "tool", toolName: "bash" }, "bash");
				} else if (name === "write" && args && typeof args === "object") {
					const a = args as Record<string, unknown>;
					if (typeof a.content !== "string") continue;
					kindCounts.write = (kindCounts.write ?? 0) + 1;
					const p = typeof a.path === "string" ? pathCandidates(a.path, "/") : undefined;
					await evaluate(a.content, { source: "tool", toolName: "write", filePaths: p }, "write");
				} else if (name === "edit" && args && typeof args === "object") {
					let entries: { path: string; digest: string }[] = [];
					for (const mode of ["hashline", "apply_patch", "patch", "replace"]) {
						try {
							entries = editInspect(mode, JSON.stringify(args)).entries.filter(e => e.digest);
						} catch {
							entries = [];
						}
						if (entries.length > 0) break;
					}
					if (entries.length > 0) {
						for (const e of entries) {
							kindCounts.edit = (kindCounts.edit ?? 0) + 1;
							await evaluate(e.digest, { source: "tool", toolName: "edit", filePaths: pathCandidates(e.path, "/") }, "edit");
						}
						continue;
					}
					// Approximate: the edit format was not parseable by any native mode, so treat
					// every new-content string field as the digest.
					const a = args as Record<string, unknown>;
					const p = typeof a.path === "string" ? pathCandidates(a.path, "/") : undefined;
					const collect = (v: unknown, key: string, out: string[]) => {
						if (typeof v === "string" && APPROX_EDIT_FIELDS.test(key)) out.push(v);
						else if (Array.isArray(v)) for (const x of v) collect(x, key, out);
						else if (v && typeof v === "object")
							for (const [k, x] of Object.entries(v as Record<string, unknown>)) collect(x, k, out);
					};
					const found: string[] = [];
					for (const [k, v] of Object.entries(a)) collect(v, k, found);
					for (const s of found) {
						kindCounts["edit~approx"] = (kindCounts["edit~approx"] ?? 0) + 1;
						await evaluate(s, { source: "tool", toolName: "edit", filePaths: p }, "edit~approx");
					}
				}
			}
		}
		if ((fi + 1) % 200 === 0) console.error(`corpus: ${fi + 1}/${scanFiles.length} files, ${lineCount} assistant messages`);
	}
	const rows: string[] = ["rule\tclass\tsource_kind\tevents_scanned\tfires\trate\tsample_fire"];
	const keyed = [...stats.entries()].map(([k, s]) => {
		const [rule, kind] = k.split("\t");
		return { rule, kind, ...s, rate: s.scanned > 0 ? s.fires / s.scanned : 0 };
	});
	keyed.sort((a, b) => b.rate - a.rate || b.fires - a.fires || a.rule.localeCompare(b.rule));
	for (const r of keyed) {
		rows.push([r.rule, byName.get(r.rule)?.cls ?? "?", r.kind, r.scanned, r.fires, r.rate.toFixed(6), r.sample].join("\t"));
	}
	for (const lr of rules) {
		if (!keyed.some(k => k.rule === lr.name)) rows.push([lr.name, lr.cls, "-", 0, 0, "0.000000", ""].join("\t"));
	}
	fs.mkdirSync(path.dirname(outFile), { recursive: true });
	fs.writeFileSync(outFile, `${rows.join("\n")}\n`);
	const secs = ((Date.now() - started) / 1000).toFixed(1);
	console.log(
		`corpus: files=${scanFiles.length}/${files.length} assistant_messages=${lineCount} parse_errors=${parseErrors} events=${JSON.stringify(kindCounts)} secs=${secs}`,
	);
	console.log(`corpus: wrote ${path.relative(KIT, outFile)} (${rows.length - 1} rows)`);
	return 0;
}
type WitnessObservation =
	| { status: "OK"; rule: string; case_line: number; registration: "REGISTERED"; whole: "fire" | "quiet"; prefix: { phase: "stream" | "final"; position: number; wire_length: number } | null; evaluator: "OK"; witness: Pick<Case, "source" | "tool" | "path" | "expect">; bindings: Record<string, string> }
	| { status: "UNAVAILABLE"; rule: string; case_line: number; reason: string; evaluator: "UNAVAILABLE"; detail?: string };

function sha256(file: string): string {
	const hash = createHash("sha256");
	const handle = fs.openSync(file, "r");
	const buffer = Buffer.allocUnsafe(64 * 1024);
	try {
		for (;;) {
			const bytes = fs.readSync(handle, buffer, 0, buffer.length, null);
			if (bytes === 0) break;
			hash.update(bytes === buffer.length ? buffer : buffer.subarray(0, bytes));
		}
	} finally {
		fs.closeSync(handle);
	}
	return hash.digest("hex");
}

function witnessBindings(ruleFile: string, casesFile: string): Record<string, string> {
	const matcher = path.join(OMP_SRC, "export/ttsr.ts");
	const nativeEntry = Bun.resolveSync("@oh-my-pi/pi-natives", matcher);
	const nativeRoot = path.resolve(path.dirname(nativeEntry), "..");
	const platformManifest = Bun.resolveSync(
		"@oh-my-pi/pi-natives-" + process.platform + "-" + process.arch + "/package.json",
		matcher,
	);
	const platformRoot = path.dirname(platformManifest);
	const addons = fs.readdirSync(platformRoot).filter(file => file.endsWith(".node")).sort();
	if (addons.length === 0) throw new Error("native addon bytes are unavailable for binding");
	const nativeDigest = createHash("sha256");
	for (const file of [path.join(nativeRoot, "package.json"), path.join(nativeRoot, "native/loader-state.js"), platformManifest, ...addons.map(file => path.join(platformRoot, file))]) {
		nativeDigest.update(path.basename(file)).update(fs.readFileSync(file));
	}
	const launcher = fs.realpathSync(OMP_BIN.includes("/") ? OMP_BIN : (Bun.which(OMP_BIN) ?? OMP_BIN));
	return {
		omp_launcher: launcher,
		omp_launcher_sha256: sha256(launcher),
		omp_package: path.resolve(OMP_SRC, ".."),
		omp_package_sha256: sha256(path.resolve(OMP_SRC, "../package.json")),
		omp_source: fs.realpathSync(OMP_SRC),
		matcher_sha256: sha256(matcher),
		omp_rule_parser_sha256: sha256(path.join(OMP_SRC, "discovery/helpers.ts")),
		native_package: fs.realpathSync(nativeRoot),
		native_sha256: nativeDigest.digest("hex"),
		kit_root: KIT,
		harness_runtime: fs.realpathSync(process.execPath),
		harness_runtime_sha256: sha256(process.execPath),
		kit_harness_sha256: sha256(import.meta.path),
		policy_sha256: sha256(path.join(KIT, "policy/ttsr.json")),
		rule_loader_sha256: sha256(path.join(KIT, "scripts/rule-class.ts")),
		rule_sha256: sha256(ruleFile),
		cases_sha256: sha256(casesFile),
	};
}

async function observeWitness(rulesDir: string, casesFile: string, ruleName: string, caseLine: number, expectedRuleSha?: string): Promise<WitnessObservation> {
	const unavailable = (reason: string, detail?: string): WitnessObservation => ({ status: "UNAVAILABLE", rule: ruleName, case_line: caseLine, reason, evaluator: "UNAVAILABLE", ...(detail ? { detail } : {}) });
	if (!/^[a-z0-9][a-z0-9_-]*$/i.test(ruleName) || !Number.isSafeInteger(caseLine) || caseLine < 2) return unavailable("INVALID_SELECTION");
	if (expectedRuleSha !== undefined && !/^[a-f0-9]{64}$/.test(expectedRuleSha)) return unavailable("INVALID_SELECTION");
	let selected: Case;
	try {
		const parsed = loadCases(casesFile);
		if (parsed.errors.length > 0) return unavailable("INVALID_CASES", parsed.errors.join(" | "));
		const found = parsed.cases.find(c => c.line === caseLine);
		if (!found || found.rule !== ruleName) return unavailable("SELECTED_CASE_NOT_FOUND");
		selected = found;
	} catch (error) {
		return unavailable("CASE_FILE_UNAVAILABLE", String(error));
	}
	try {
		const pathLauncher = Bun.which("omp");
		const configured = fs.realpathSync(OMP_BIN.includes("/") ? OMP_BIN : (Bun.which(OMP_BIN) ?? OMP_BIN));
		const selectedLauncher = pathLauncher ? fs.realpathSync(pathLauncher) : null;
		const packageRoot = fs.realpathSync(path.resolve(OMP_SRC, ".."));
		const withinPackage = path.relative(packageRoot, configured);
		if (!selectedLauncher || configured !== selectedLauncher || withinPackage === ".." || withinPackage.startsWith(".." + path.sep) || path.isAbsolute(withinPackage)) {
			return unavailable("OMP_IDENTITY_MISMATCH");
		}
	} catch (error) {
		return unavailable("OMP_IDENTITY_MISMATCH", String(error));
	}
	const ruleFile = path.join(rulesDir, `${ruleName}.md`);
	if (!fs.existsSync(ruleFile)) return unavailable("SELECTED_RULE_NOT_FOUND");
	try {
		if (expectedRuleSha && sha256(ruleFile) !== expectedRuleSha) return unavailable("BUNDLED_SUBSTITUTION");
		const lr = loadRuleFile(ruleFile);
		if (lr.rule.question?.trim()) return unavailable("JUDGE_REQUIRED");
		const validity = g1(lr);
		if (!validity.ok) return unavailable("INVALID_RULE", validity.detail);
		if (lr.cls === "always" || !new TtsrManager(SETTINGS).addRule(lr.rule)) return unavailable("RULE_NOT_REGISTERED");
		const whole = await g2Fires(lr.rule, selected);
		const { fired, length } = await g3Fires(lr.rule, selected);
		const first = fired[0];
		return {
			status: "OK", rule: lr.name, case_line: selected.line, registration: "REGISTERED",
			whole: whole ? "fire" : "quiet",
			prefix: first === undefined ? null : { phase: first > length ? "final" : "stream", position: first, wire_length: length },
			evaluator: "OK", witness: { source: selected.source, tool: selected.tool, path: selected.path, expect: selected.expect }, bindings: witnessBindings(ruleFile, casesFile),
		};
	} catch (error) {
		return unavailable("EVALUATOR_FAILED", String(error));
	}
}

// ---------------------------------------------------------------- mutants (H3)

interface MutantEdit {
	kind: string;
	condition_index: number;
	edit: string;
	source: string;
}

interface CharInfo {
	escaped: boolean;
	inClass: boolean;
	classFirst: boolean;
	depth: number;
	inFlags: boolean;
}

/** Per-character regex structure: escapes, classes (with negation/first), paren depth, (?...) flags. */
function scanPattern(src: string): CharInfo[] {
	const out: CharInfo[] = src.split("").map(() => ({ escaped: false, inClass: false, classFirst: false, depth: 0, inFlags: false }));
	let inClass = false;
	let classFirst = false;
	let depth = 0;
	let i = 0;
	while (i < src.length) {
		const ch = src[i];
		if (ch === "\\" && i + 1 < src.length) {
			out[i] = { escaped: false, inClass, classFirst: false, depth, inFlags: false };
			out[i + 1] = { escaped: true, inClass, classFirst, depth, inFlags: false };
			if (inClass) classFirst = false;
			i += 2;
			continue;
		}
		if (!inClass && ch === "(" && src[i + 1] === "?") {
			let j = i + 2;
			while (j < src.length && /[a-zA-Z]/.test(src[j] ?? "")) j++;
			if (src[j] === ")") {
				for (let k = i; k <= j; k++) out[k] = { ...out[k], inFlags: true };
				i = j + 1;
				continue;
			}
		}
		if (!inClass && ch === "[") {
			inClass = true;
			classFirst = true;
			i++;
			continue;
		}
		if (inClass && ch === "]" && !classFirst) {
			inClass = false;
			i++;
			continue;
		}
		out[i] = { ...out[i], inClass, classFirst, depth };
		if (inClass) classFirst = false;
		if (!inClass && ch === "(") depth++;
		if (!inClass && ch === ")" && depth > 0) depth--;
		i++;
	}
	return out;
}

// Widening probes: a private-use char no authored case can contain first, then
// printable fallbacks. Built by code point so no invisible literal sits in source.
const CLASS_WIDEN_PROBES: readonly string[] = [String.fromCodePoint(0xe000), "~", "_", " ", "0", "é"];

/** Token-level mutants of one condition source. Skips nothing; callers dedupe and compile-check. */
function mutateCondition(src: string, index: number): MutantEdit[] {
	const edits: MutantEdit[] = [];
	const info = scanPattern(src);
	const drop = (kind: string, edit: string, from: number, to: number): void => {
		edits.push({ kind, condition_index: index, edit, source: src.slice(0, from) + src.slice(to) });
	};
	const replace = (kind: string, edit: string, from: number, to: number, text: string): void => {
		edits.push({ kind, condition_index: index, edit, source: src.slice(0, from) + text + src.slice(to) });
	};
	const pipes: number[] = [];
	for (let i = 0; i < src.length; i++) {
		if (src[i] === "|" && !info[i]?.escaped && !info[i]?.inClass && (info[i]?.depth ?? 0) === 0) pipes.push(i);
	}
	if (pipes.length > 0) {
		const bounds = [-1, ...pipes, src.length];
		const segments: string[] = [];
		for (let b = 0; b + 1 < bounds.length; b++) segments.push(src.slice((bounds[b] ?? -1) + 1, bounds[b + 1]));
		for (let b = 0; b < segments.length; b++) {
			edits.push({ kind: "drop-alternation-branch", condition_index: index,
				edit: `drop alternation branch ${b + 1}/${segments.length}`,
				source: segments.filter((_, k) => k !== b).join("|") });
		}
	}
	for (let i = 0; i < src.length; i++) {
		const inf = info[i];
		if (!inf || inf.escaped || inf.inClass || inf.inFlags) continue;
		const ch = src[i];
		if (ch === "^") drop("drop-anchor", `drop ^ at ${i}`, i, i + 1);
		else if (ch === "$") drop("drop-anchor", `drop $ at ${i}`, i, i + 1);
		else if (ch === "+" ) replace("weaken-quantifier", `+ at ${i} to *`, i, i + 1, "*");
		else if (/[A-Za-z0-9]/.test(ch ?? "") && src[i - 1] !== "\\") replace("drop-literal", `drop literal ${ch} at ${i}`, i, i + 1, "");
		if (ch === "\\" && src[i + 1] === "b") drop("drop-word-boundary", `drop \\b at ${i}`, i, i + 2);
	}
	const brace = /\\?\{(\d+)\}/g;
	let m: RegExpExecArray | null;
	while ((m = brace.exec(src)) !== null) {
		const pos = m.index + (m[0].startsWith("\\") ? 1 : 0);
		const inf = info[pos];
		if (!inf || inf.escaped || inf.inClass || inf.inFlags) continue;
		if (m[0].startsWith("\\")) continue;
		const n = Number(m[1]);
		if (n >= 1) replace("shrink-quantifier", `{${n}} at ${pos} to {${n - 1}}`, pos, pos + m[0].length, `{${n - 1}}`);
	}
	if (!info.some(inf => inf.inFlags)) {
		edits.push({ kind: "toggle-case-flag", condition_index: index, edit: "prepend (?i)", source: `(?i)${src}` });
	} else {
		let i = 0;
		while (i < src.length) {
			if (src.startsWith("(?i)", i) && !info[i]?.escaped && !info[i]?.inClass) {
				drop("toggle-case-flag", `drop (?i) at ${i}`, i, i + 4);
				i += 4;
			} else i++;
		}
	}
	for (let i = 0; i < src.length; i++) {
		if (src[i] !== "[") continue;
		const inf = info[i];
		if (!inf || inf.escaped || inf.inClass) continue;
		let j = i + 1;
		let negated = false;
		if (src[j] === "^") {
			negated = true;
			j++;
		}
		let k = j;
		while (k < src.length) {
			if (src[k] === "\\") {
				k += 2;
				continue;
			}
			if (src[k] === "]" && k > j) break;
			k++;
		}
		if (k >= src.length) continue;
		const inner = src.slice(j, k);
		if (negated) {
			for (let p = 0; p < inner.length; p++) {
				const c = inner[p];
				if (c === "\\" || !/[A-Za-z0-9]/.test(c ?? "")) continue;
				if (p > 0 && inner[p - 1] === "\\") continue;
				edits.push({ kind: "widen-negated-class", condition_index: index,
					edit: `remove ${c} from [^...] at ${j + p} (widens)`,
					source: src.slice(0, j + p) + src.slice(j + p + 1) });
			}
		} else {
			const probe = CLASS_WIDEN_PROBES.find(c => !inner.includes(c));
			if (probe !== undefined) {
				edits.push({ kind: "widen-class", condition_index: index,
					edit: `add U+${probe.codePointAt(0)?.toString(16).toUpperCase()} to [...] at ${k} (widens)`,
					source: `${src.slice(0, k)}${probe}${src.slice(k)}` });
			}
			for (let p = 0; p < inner.length; p++) {
				const c = inner[p];
				if (!/[A-Za-z0-9]/.test(c ?? "")) continue;
				if (p > 0 && inner[p - 1] === "\\") continue;
				if (c === "-" || inner[p + 1] === "-") continue;
				edits.push({ kind: "narrow-class", condition_index: index,
					edit: `remove ${c} from [...] at ${j + p} (narrows)`,
					source: src.slice(0, j + p) + src.slice(j + p + 1) });
			}
		}
		i = k;
	}
	return edits;
}

interface MutantRuleReport {
	rule: string;
	cases: number;
	mutants: number;
	killed: number;
	score: number | null;
	skipped_compile: number;
	baseline_failures: number;
	survivors: { kind: string; edit: string; condition_index: number }[];
}

/** Baseline G2 verdicts plus quiet-prefix fire flags for one rule over its cases. */
async function baselineOutcomes(rule: Rule, cases: Case[]): Promise<{ g2: boolean[]; prefix: boolean[] }> {
	const g2: boolean[] = [];
	const prefix: boolean[] = [];
	for (const c of cases) {
		const fired = await g2Fires(rule, c);
		g2.push(fired);
		if (c.expect === "quiet" && !fired) {
			const sweep = await g3Fires(rule, c);
			prefix.push(sweep.fired.length > 0);
		} else {
			prefix.push(false);
		}
	}
	return { g2, prefix };
}

/** H3: token mutants of every condition, evaluated against the rule's own cases
 * through the real matcher. Killed means any case outcome differs from
 * baseline (G2 verdict, plus G3 quiet-prefix sweep where G2 stays quiet). */
async function runMutants(rulesDir: string, casesFile: string, budgetSecs: number, outFile: string | null): Promise<number> {
	const started = Date.now();
	const deadline = started + Math.max(1, budgetSecs) * 1000;
	const expired = (): boolean => Date.now() >= deadline;
	const { cases, errors } = loadCases(casesFile);
	if (errors.length > 0 || cases.length === 0) {
		console.error(`mutants: cases unusable: ${errors[0] ?? "no cases"}`);
		return 2;
	}
	const rules = loadRules(rulesDir).filter(r => r.cls !== "always");
	const byRule = new Map<string, Case[]>();
	for (const c of cases) {
		const list = byRule.get(c.rule) ?? [];
		list.push(c);
		byRule.set(c.rule, list);
	}
	const reports: MutantRuleReport[] = [];
	let truncated = false;
	for (const lr of rules) {
		if (expired()) {
			truncated = true;
			break;
		}
		const mine = (byRule.get(lr.name) ?? []).slice().sort((a, b) => a.line - b.line);
		const base = await baselineOutcomes(lr.rule, mine);
		const baselineFailures = mine.filter((c, i) => (base.g2[i] ? "fire" : "quiet") !== c.expect).length;
		const seen = new Set<string>();
		const mutants: MutantEdit[] = [];
		for (let ci = 0; ci < (lr.rule.condition ?? []).length; ci++) {
			const original = lr.rule.condition?.[ci] ?? "";
			for (const edit of mutateCondition(original, ci)) {
				if (edit.source === original) continue;
				if (seen.has(edit.source)) continue;
				seen.add(edit.source);
				mutants.push(edit);
			}
		}
		let killed = 0;
		let skippedCompile = 0;
		const survivors: { kind: string; edit: string; condition_index: number }[] = [];
		for (const mutant of mutants) {
			if (expired()) {
				truncated = true;
				break;
			}
			const conds = [...(lr.rule.condition ?? [])];
			conds[mutant.condition_index] = mutant.source;
			const candidate: Rule = { ...lr.rule, condition: conds };
			try {
				compileRuleCondition(mutant.source);
			} catch {
				skippedCompile++;
				continue;
			}
			const probe = new TtsrManager(SETTINGS);
			if (!probe.addRule(candidate)) {
				skippedCompile++;
				continue;
			}
			const killer: string[] = [];
			for (let i = 0; i < mine.length; i++) {
				const c = mine[i];
				const wasFiring = base.g2[i] ?? false;
				const wasPrefix = base.prefix[i] ?? false;
				if (!c) continue;
				const fired = await g2Fires(candidate, c);
				if (fired !== wasFiring) {
					killer.push(`line ${c.line} G2 ${c.expect} ${fired ? "fired" : "quiet"}`);
					break;
				}
				if (c.expect === "quiet" && !fired && !wasFiring) {
					const sweep = await g3Fires(candidate, c);
					const prefixFired = sweep.fired.length > 0;
					if (prefixFired !== wasPrefix) {
						killer.push(`line ${c.line} G3 prefix ${prefixFired ? "fired" : "quiet"}`);
						break;
					}
				}
			}
			if (killer.length > 0) {
				killed++;
			} else {
				survivors.push({ kind: mutant.kind, edit: mutant.edit, condition_index: mutant.condition_index });
			}
		}
		const evaluated = killed + survivors.length;
		reports.push({ rule: lr.name, cases: mine.length, mutants: evaluated, killed,
			score: evaluated > 0 ? killed / evaluated : null, skipped_compile: skippedCompile,
			baseline_failures: baselineFailures, survivors });
	}
	const evaluatedTotal = reports.reduce((n, r) => n + r.mutants, 0);
	const killedTotal = reports.reduce((n, r) => n + r.killed, 0);
	const report = { rules: reports,
		totals: { rules: reports.length, mutants: evaluatedTotal, killed: killedTotal,
			score: evaluatedTotal > 0 ? killedTotal / evaluatedTotal : null,
			skipped_compile: reports.reduce((n, r) => n + r.skipped_compile, 0) },
		truncated, budget_secs: budgetSecs };
	const text = JSON.stringify(report);
	if (outFile) {
		fs.mkdirSync(path.dirname(outFile), { recursive: true });
		fs.writeFileSync(outFile, `${text}\n`);
	} else {
		console.log(text);
	}
	console.error(`mutants: rules=${reports.length} mutants=${evaluatedTotal} killed=${killedTotal} truncated=${truncated}`);
	return 0;
}

// ---------------------------------------------------------------- main

function flagValue(name: string): string | undefined {
	const i = process.argv.indexOf(name);
	if (i !== -1) return process.argv[i + 1];
	const eq = process.argv.find(a => a.startsWith(`${name}=`));
	return eq?.slice(name.length + 1);
}

const mode = process.argv.find(a => ["--observe", "--gate", "--gate-json", "--selftest", "--cli-crosscheck", "--corpus", "--mutants"].includes(a));
let code: number;
switch (mode) {
	case "--observe": {
		const observation = await observeWitness(
			path.resolve(flagValue("--rules") ?? path.join(KIT, "rules")),
			path.resolve(flagValue("--cases") ?? path.join(KIT, "cases/cases.tsv")),
			flagValue("--rule") ?? "", Number(flagValue("--line") ?? NaN), flagValue("--rule-sha256"),
		);
		console.log(JSON.stringify(observation));
		code = observation.status === "OK" ? 0 : 1;
		break;
	}
	case "--gate": {
		// --rules/--cases grade another rule root (e.g. the installed ~/.agents/rules)
		// against the kit's cases, read-only.
		const rulesDir = path.resolve(flagValue("--rules") ?? path.join(KIT, "rules"));
		const casesFile = path.resolve(flagValue("--cases") ?? path.join(KIT, "cases/cases.tsv"));
		const rep = await runGate(rulesDir, casesFile);
		printGate(rep, `${path.relative(KIT, rulesDir) || "."} + ${path.relative(KIT, casesFile)}`);
		code = rep.failures.length === 0 ? 0 : 1;
		break;
	}
	case "--gate-json": {
		const rulesDir = path.resolve(flagValue("--rules") ?? path.join(KIT, "rules"));
		const casesFile = path.resolve(flagValue("--cases") ?? path.join(KIT, "cases/cases.tsv"));
		const rep = await runGate(rulesDir, casesFile);
		console.log(JSON.stringify(structuredGate(rep)));
		code = rep.failures.length === 0 ? 0 : 1;
		break;
	}
	case "--selftest":
		code = await selftest();
		break;
	case "--cli-crosscheck":
		code = await cliCrosscheck(Number(flagValue("--jobs") ?? 8));
		break;
	case "--corpus":
		code = await corpus(
			Number(flagValue("--limit-files") ?? 0),
			path.resolve(KIT, flagValue("--out") ?? "reports/corpus-fire-rate.tsv"),
		);
		break;
	case "--mutants": {
		const rulesDir = path.resolve(flagValue("--rules") ?? path.join(KIT, "rules"));
		const casesFile = path.resolve(flagValue("--cases") ?? path.join(KIT, "cases/cases.tsv"));
		const budget = Number(flagValue("--mutant-budget-secs") ?? 300);
		if (!Number.isSafeInteger(budget) || budget < 1) {
			console.error("mutants: --mutant-budget-secs needs a positive integer");
			code = 2;
			break;
		}
		const out = flagValue("--out");
		code = await runMutants(rulesDir, casesFile, budget, out ? path.resolve(KIT, out) : null);
		break;
	}
	default:
		console.error("usage: bun scripts/ttsr-harness.ts --observe --rule NAME --line N [--rules DIR] [--cases FILE] | --gate [--rules DIR] [--cases FILE] | --gate-json [--rules DIR] [--cases FILE] | --selftest | --cli-crosscheck [--jobs N] | --corpus [--limit-files N] [--out FILE] | --mutants [--rules DIR] [--cases FILE] [--mutant-budget-secs N] [--out FILE]");
		code = 2;
}
process.exit(code);
