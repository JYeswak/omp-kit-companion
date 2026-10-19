import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseCaseCorpus } from "../../src/case-corpus.ts";
import { check as durabilityCheck } from "../../src/fleet-guard/durability.ts";
import {
	assertDeterministicAdmission, mechanicalVerdicts, NONDETERMINISM_ERROR, PARTITION_ERROR,
	reassemble, type AdmissionEvaluator, type MechanicalCase,
} from "../../src/mechanical-admission.ts";

const KIT = fileURLToPath(new URL("../..", import.meta.url));
const corpus = parseCaseCorpus(readFileSync(join(KIT, "cases", "cases.tsv"), "utf8"));
const admissionCases = corpus.cases.filter(c => c.rule === "scratch-is-not-a-home" && c.source === "tool");
const fireCase: MechanicalCase = admissionCases.find(c => c.expect === "fire")!;
const quietCase: MechanicalCase = admissionCases.find(c => c.expect === "quiet")!;
const WIDTHS = [undefined, 1, 7, 4096] as const;

function counted(evaluate: AdmissionEvaluator): { evaluate: AdmissionEvaluator; calls: () => number } {
	let calls = 0;
	return { evaluate: async (event, context) => { calls++; return evaluate(event, context); }, calls: () => calls };
}

describe("mechanical admission dispatch", () => {
	test("the shipped corpus supplies a fire and a quiet tool case for the admission guard", () => {
		expect(corpus.errors).toEqual([]);
		expect(fireCase).toBeDefined();
		expect(quietCase).toBeDefined();
	});

	test("the real guard returns one verdict per case, dispatched twice for the determinism check and shared by every exact partition", async () => {
		for (const [c, expected] of [[fireCase, true], [quietCase, false]] as const) {
			const guard = counted(durabilityCheck);
			expect(await mechanicalVerdicts(c, WIDTHS, { kit: KIT, evaluate: guard.evaluate })).toEqual(WIDTHS.map(() => expected));
			expect(guard.calls()).toBe(2);
		}
	});

	test("a partition whose reassembly differs from the wire is refused before any dispatch", async () => {
		const guard = counted(durabilityCheck);
		const losesLastCharacterAtWidthOne = (wire: string, width: number) => width === 1 ? reassemble(wire, width).slice(0, -1) : reassemble(wire, width);
		await expect(mechanicalVerdicts(fireCase, WIDTHS, { kit: KIT, evaluate: guard.evaluate, join: losesLastCharacterAtWidthOne }))
			.rejects.toThrow(PARTITION_ERROR);
		expect(guard.calls()).toBe(0);
	});

	test("the real guard is deterministic on every corpus admission case: two dispatches agree with the corpus expectation", async () => {
		expect(admissionCases.length).toBeGreaterThan(2);
		for (const c of admissionCases)
			expect(await assertDeterministicAdmission(c, { kit: KIT }), `line ${c.line}: ${c.note}`).toBe(c.expect === "fire");
	});

	test("the gate dispatch path checks every corpus admission case with exactly one extra dispatch", async () => {
		for (const c of admissionCases) {
			const guard = counted(durabilityCheck);
			expect(await mechanicalVerdicts(c, WIDTHS, { kit: KIT, evaluate: guard.evaluate }), `line ${c.line}`).toEqual(WIDTHS.map(() => c.expect === "fire"));
			expect(guard.calls()).toBe(2);
		}
	});

	test("a planted evaluator that flips its verdict on the second call fails the check on every corpus admission case", async () => {
		for (const c of admissionCases) {
			const calls = new Map<string, number>();
			const flipping: AdmissionEvaluator = async (event, context) => {
				const call = (calls.get(context.cwd) ?? 0) + 1;
				calls.set(context.cwd, call);
				const verdict = (await durabilityCheck(event, context))?.block === true;
				return (call === 2 ? !verdict : verdict) ? { block: true, reason: "planted flip" } : undefined;
			};
			await expect(assertDeterministicAdmission(c, { kit: KIT, evaluate: flipping }), `line ${c.line}`).rejects.toThrow(NONDETERMINISM_ERROR);
			await expect(mechanicalVerdicts(c, WIDTHS, { kit: KIT, evaluate: flipping }), `line ${c.line}`).rejects.toThrow(NONDETERMINISM_ERROR);
		}
	});
});
