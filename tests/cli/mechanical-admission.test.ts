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

	test("the real guard returns one verdict per case, dispatched once and shared by every exact partition", async () => {
		for (const [c, expected] of [[fireCase, true], [quietCase, false]] as const) {
			const guard = counted(durabilityCheck);
			expect(await mechanicalVerdicts(c, WIDTHS, { kit: KIT, evaluate: guard.evaluate })).toEqual(WIDTHS.map(() => expected));
			expect(guard.calls()).toBe(1);
		}
	});

	test("a partition whose reassembly differs from the wire is refused before any dispatch", async () => {
		const guard = counted(durabilityCheck);
		const losesLastCharacterAtWidthOne = (wire: string, width: number) => width === 1 ? reassemble(wire, width).slice(0, -1) : reassemble(wire, width);
		await expect(mechanicalVerdicts(fireCase, WIDTHS, { kit: KIT, evaluate: guard.evaluate, join: losesLastCharacterAtWidthOne }))
			.rejects.toThrow(PARTITION_ERROR);
		expect(guard.calls()).toBe(0);
	});

	test("the real guard is deterministic on one fixture: two dispatches agree with the corpus expectation", async () => {
		expect(await assertDeterministicAdmission(fireCase, { kit: KIT })).toBe(true);
		expect(await assertDeterministicAdmission(quietCase, { kit: KIT })).toBe(false);
	});

	test("a planted nondeterministic evaluator fails the determinism check", async () => {
		let flip = false;
		const nondeterministic: AdmissionEvaluator = async (event, context) => {
			flip = !flip;
			return flip ? durabilityCheck(event, context) : undefined;
		};
		await expect(assertDeterministicAdmission(fireCase, { kit: KIT, evaluate: nondeterministic })).rejects.toThrow(NONDETERMINISM_ERROR);
	});
});
