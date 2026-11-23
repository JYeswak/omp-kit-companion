import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { parseCaseCorpus } from "../../src/case-corpus.ts";
import { OMP_SRC, loadRuleFile } from "../../scripts/rule-class.ts";
import { fixtureDeadlineS } from "../cli/fixture-process.ts";

const root = resolve(import.meta.dir, "../..");
/** Minimal compiler surface of omp's capability/rule.ts; the module lives in the
 * runtime-selected OMP_SRC tree, so only a dynamic import can reach it. */
interface RuleCompiler {
	compileRuleCondition(pattern: string): { test(input: string): boolean };
}

// OLD conditions: exact condition strings from rules/kit-no-gh-poll.md before the
// cost rewrite (leading-literal + lookbehind restructure). Kept verbatim so the
// rewrite proves language equality against them instead of against itself.
const OLD0 = String.raw`(?i)(?:\{"command":"(?:\s|\\[nrt]|\\\\\\[nrt])*|[;&|()](?:\s|\\[nrt]|\\\\\\[nrt])*|\\n(?:\\{1,3}t|\s)*|\b(?:if|then|do|while|until)(?:\s|\\[nrt]|\\\\\\[nrt])+)(?=((?:[A-Za-z_][A-Za-z0-9_]*=[^\s"\\;&|]*(?:\s|\\[nrt]|\\\\\\[nrt])+)*))\1gh(?:\s|\\[nrt]|\\\\\\[nrt])+run(?:\s|\\[nrt]|\\\\\\[nrt])+watch\b`;
const OLD1 = String.raw`(?i)(?:\{"command":"(?:\s|\\[nrt]|\\\\\\[nrt])*|[;&|()](?:\s|\\[nrt]|\\\\\\[nrt])*|\\n(?:\\{1,3}t|\s)*|\b(?:if|then|do)(?:\s|\\[nrt]|\\\\\\[nrt])+)(?=((?:[A-Za-z_][A-Za-z0-9_]*=[^\s"\\;&|]*(?:\s|\\[nrt]|\\\\\\[nrt])+)*))\1(?:for|while|until)\b(?=(?:\s|\\[nrt]|\\\\\\[nrt])*(?=((?:[A-Za-z_][A-Za-z0-9_]*=[^\s"\\;&|]*(?:\s|\\[nrt]|\\\\\\[nrt])+)*))\2gh(?:\s|\\[nrt]|\\\\\\[nrt])+(?:run(?:\s|\\[nrt]|\\\\\\[nrt])+(?:view|list)|api)\b|(?:(?!\bdone\b)[\s\S]){0,2048}(?:[;&|()](?:\s|\\[nrt]|\\\\\\[nrt])*|\b(?:if|then|do|while|until)(?:\s|\\[nrt]|\\\\\\[nrt])+|\\n(?:\\{1,3}t|\s)*)(?=((?:[A-Za-z_][A-Za-z0-9_]*=[^\s"\\;&|]*(?:\s|\\[nrt]|\\\\\\[nrt])+)*))\3gh(?:\s|\\[nrt]|\\\\\\[nrt])+(?:run(?:\s|\\[nrt]|\\\\\\[nrt])+(?:view|list)|api)\b)(?=(?:\s|\\[nrt]|\\\\\\[nrt])*(?=((?:[A-Za-z_][A-Za-z0-9_]*=[^\s"\\;&|]*(?:\s|\\[nrt]|\\\\\\[nrt])+)*))\4sleep\b|(?:(?!\bdone\b)[\s\S]){0,2048}(?:[;&|()](?:\s|\\[nrt]|\\\\\\[nrt])*|\b(?:if|then|do|while|until)(?:\s|\\[nrt]|\\\\\\[nrt])+|\\n(?:\\{1,3}t|\s)*)(?=((?:[A-Za-z_][A-Za-z0-9_]*=[^\s"\\;&|]*(?:\s|\\[nrt]|\\\\\\[nrt])+)*))\5sleep\b)(?:(?!\bdone\b)[\s\S]){0,2048}\bdone\b`;

/** Deterministic PRNG so the generated corpus replays byte-identically. */
function mulberry32(seed: number): () => number {
	let a = seed >>> 0;
	return () => {
		a |= 0;
		a = (a + 0x6d2b79f5) | 0;
		let t = Math.imul(a ^ (a >>> 15), 1 | a);
		t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	};
}

const GEN_SEPS = [";", " ; ", " && ", " || ", " | ", " (", ") ", "\n", "\\n", "\\t", "\\n\\t", "\t", " ", " if ", " then ", " do ", " while ", " until ", " for ", ";;", ";;\n", "\\n\\n", "\n\n"];
const GEN_CORES = [
	"gh run watch", "gh run watch 37416392819 -R a/b --exit-status", "gh run list", "gh run list -L 8 --json conclusion",
	"gh run view 1", "gh run view 1 --json status", "gh api repos/a/b", "gh api /repos/a/b/actions/runs",
	"gh pr list", "gh pr list --limit 5", "gh run watches", "agh run watch", "gh run watch2", "echo gh run watch",
	"printf '%s' 'gh run watch'", "echo 'gh run list'", "sleep 5", "sleep 30", "done", "for", "while", "until",
	"do", "if", "then", "gh workflow run release.yml", "echo done", "adone", "donee", "before for after",
	"gh", "gh run", "run watch", "g h run watch", "GH RUN WATCH", "Gh Run View 1", "GH API X",
	"echo 'gh run view 1'", "FOO=bar", "A=1 B=2", "exit 0", "false", "true", "sleep", "watch",
];
const GEN_ENVS = ["", "", "A=1 ", "FOO=bar BAZ=qux ", "X=\"a b\" ", "N=0 M=1 ", "GH_TOKEN=sekrit ", "A= B=2 "];
const GEN_LOOPS: Array<(inner: string) => string> = [
	(inner) => `for i in 1 2 3; do ${inner}; sleep 5; done`,
	(inner) => `while true; do ${inner}; sleep 1; done`,
	(inner) => `until ./ready.sh; do ${inner}; sleep 10; done`,
	(inner) => `for f in *.md; do ${inner}; done`,
	(inner) => `while true; do sleep 1; ${inner}; sleep 2; done`,
];

/** Seeded command grammar: env assignments, gh subcommands, loops with sleep, separators in raw/escaped forms. */
function generatedCommands(): string[] {
	const rand = mulberry32(0xc0ffee);
	const pick = <T,>(xs: readonly T[]): T => xs[Math.floor(rand() * xs.length)] as T;
	const out = new Set<string>();
	for (let i = 0; i < 600 && out.size < 460; i++) {
		const parts = 1 + Math.floor(rand() * 3);
		let cmd = GEN_ENVS[Math.floor(rand() * GEN_ENVS.length)] as string;
		for (let p = 0; p < parts; p++) {
			if (p > 0) cmd += pick(GEN_SEPS);
			cmd += pick(GEN_CORES);
		}
		if (rand() < 0.35) {
			cmd = pick(GEN_LOOPS)(cmd);
			if (rand() < 0.15) cmd = pick(GEN_LOOPS)(cmd);
		}
		out.add(cmd);
	}
	// Force escaped-separator coverage: real newline, backslash-n, backslash-t mixes.
	for (let i = 0; i < 60; i++) {
		const sep = pick(["\n", "\\n", "\\t", "\\n\\t", "\t\n", "\\n\\n"]);
		out.add(`${pick(GEN_ENVS)}${pick(GEN_CORES)}${sep}${pick(GEN_CORES)}`);
	}
	return [...out];
}

// Hand-picked boundary cases: embedded words, done/sleep variants, case, quoting, near-misses.
const BOUNDARY_COMMANDS = [
	"gh run watch 1",
	";gh run watch",
	"false && gh run watch 1 --exit-status",
	"A=1 gh run watch",
	"FOO=bar BAZ=qux gh run watch --exit-status",
	"(gh run watch)",
	"echo hi; gh run watch",
	"if true; then gh run watch; fi",
	"echo a | gh run watch",
	"do gh run watch",
	"false\ngh run watch",
	"false\\ngh run watch",
	"false\\\n\\ngh run watch",
	"false\tgh run watch",
	"; GH RUN WATCH",
	"; Gh Run Watch --exit-status",
	"gh run watches",
	"agh run watch",
	"echo gh run watch",
	"printf '%s' 'gh run watch'",
	"gh run list",
	"gh pr list",
	"for i in 1 2 3; do gh run view 1; sleep 5; done",
	"while true; do gh run list; sleep 5; done",
	"until ./ready; do gh api repos/x; sleep 10; done",
	"for i in 1 2 3; do echo hi; gh run view 1 --json status; sleep 5; done",
	"A=1 for i in x; do B=2 gh api y; C=3 sleep 4; done",
	"While True; Do Gh Run List; Sleep 5; Done",
	"for i in 1;\tdo gh run view 1;\tsleep 5;\tdone",
	"for i in 1\n2 3; do gh run view 1; sleep 5; done",
	"for a in 1 2; do for b in 3; do gh run list; sleep 1; done; done",
	"while true; do sleep 1; gh run list; sleep 2; done",
	"gh run list -L 8",
	"for i in 1 2 3; do echo hi; done",
	"while true; do gh pr list; sleep 5; done",
	"for i in 1; do gh run view 1; done",
	"while true; do gh run list; sleep 5; echo done",
	"adone for i in 1; do gh run list; sleep 1; done",
	"while true; do gh run list; sleep 1; donee",
	"while true; do gh run list; sleep 1; adone",
];

function longNearMisses(): string[] {
	return [
		"x".repeat(16000),
		`${"; echo padding\n".repeat(1200)}gh run list`,
		`${"for i in 1; do echo $i; sleep 1; done\n".repeat(300)}`,
		"for i in $(seq 1 40); do if true; then echo ok; fi; sleep 30; done",
		`${"while true; do echo tick; sleep 1; done\n".repeat(200)}gh run list`,
	];
}

test("kit-no-gh-poll cost rewrite preserves every verdict", async () => {
	const loaded = loadRuleFile(join(root, "rules/kit-no-gh-poll.md"));
	expect(loaded.name).toBe("kit-no-gh-poll");
	const fresh = loaded.rule.condition ?? [];
	expect(fresh.length).toBe(2);
	if (fresh[0] === undefined || fresh[1] === undefined) throw new Error("kit-no-gh-poll needs two conditions");

	const strip = (pattern: string): string => pattern.replace(/^\(\?i\)/, "");
	// Exception to static imports: OMP_SRC resolves at runtime (env/PATH/source cache).
	const ruleMod: RuleCompiler = await import(join(OMP_SRC, "capability/rule.ts"));

	const wires: Array<{ name: string; wire: string }> = [];
	const { cases, errors } = parseCaseCorpus(readFileSync(join(root, "cases/cases.tsv"), "utf8"));
	expect(errors).toEqual([]);
	let corpusCount = 0;
	for (const c of cases) {
		if (c.rule !== "kit-no-gh-poll" || c.source !== "tool" || c.tool !== "bash") continue;
		wires.push({ name: `corpus:${c.expect}:L${c.line}`, wire: JSON.stringify({ command: c.snippet }) });
		corpusCount++;
	}
	expect(corpusCount).toBeGreaterThan(0);

	const scenarios = JSON.parse(readFileSync(join(root, "tests/live/scenarios.json"), "utf8")) as Array<{
		rule?: string; id?: string; turns?: Array<{ tool?: { name?: string; args?: { command?: string } } }>;
	}>;
	let scenarioCount = 0;
	for (const s of scenarios) {
		if (s.rule !== "kit-no-gh-poll") continue;
		for (const turn of s.turns ?? []) {
			if (turn.tool?.name !== "bash" || typeof turn.tool.args?.command !== "string") continue;
			wires.push({ name: `scenario:${s.id}`, wire: JSON.stringify({ command: turn.tool.args.command }) });
			scenarioCount++;
		}
	}

	const generated = generatedCommands();
	expect(generated.length).toBeGreaterThanOrEqual(300);
	for (const cmd of generated) wires.push({ name: "generated", wire: JSON.stringify({ command: cmd }) });
	for (const cmd of BOUNDARY_COMMANDS) wires.push({ name: `boundary:${cmd.slice(0, 40)}`, wire: JSON.stringify({ command: cmd }) });
	for (const cmd of longNearMisses()) wires.push({ name: `near-miss:${cmd.length}B`, wire: JSON.stringify({ command: cmd }) });
	wires.push({ name: "live-wire", wire: JSON.stringify({ command: readFileSync(join(root, "scripts/e2e-live.sh"), "utf8") }) });

	const checks = [
		{ oldSource: OLD0, newSource: fresh[0] },
		{ oldSource: OLD1, newSource: fresh[1] },
	];
	const disagreements: string[] = [];
	checks.forEach((pair, index) => {
		const oldNative = new RegExp(strip(pair.oldSource), "i");
		const newNative = new RegExp(strip(pair.newSource), "i");
		const oldOmp = ruleMod.compileRuleCondition(pair.oldSource);
		const newOmp = ruleMod.compileRuleCondition(pair.newSource);
		for (const { name, wire } of wires) {
			const votes = [oldNative.test(wire), newNative.test(wire), oldOmp.test(wire), newOmp.test(wire)];
			if (votes[0] !== votes[1] || votes[0] !== votes[2] || votes[0] !== votes[3]) {
				disagreements.push(`cond${index} ${name}: old-native=${votes[0]} new-native=${votes[1]} old-omp=${votes[2]} new-omp=${votes[3]}`);
			}
		}
	});
	console.log(`kit-no-gh-poll equivalence: ${wires.length} wires x 2 conditions x 4 engines (native+omp@${OMP_SRC}), corpus=${corpusCount} generated=${generated.length} scenarios=${scenarioCount} boundary=${BOUNDARY_COMMANDS.length}`);
	expect(disagreements).toEqual([]);

	// Mutant sensitivity: a deliberately broken NEW must disagree with OLD, or this test is vacuous.
	const mutantChecks = [
		{ oldSource: OLD0, mutant: fresh[0].replace("watch", "warch") },
		{ oldSource: OLD1, mutant: fresh[1].replace(/\\bdone\\b/g, "\\bdonex\\b") },
	];
	mutantChecks.forEach(({ oldSource, mutant }, index) => {
		const oldRe = new RegExp(strip(oldSource), "i");
		const mutantRe = new RegExp(strip(mutant), "i");
		const kills = wires.filter(({ wire }) => oldRe.test(wire) !== mutantRe.test(wire)).length;
		console.log(`kit-no-gh-poll mutant cond${index}: ${kills} killing wires`);
		expect(kills).toBeGreaterThan(0);
	});
}, fixtureDeadlineS(20) * 1000);
