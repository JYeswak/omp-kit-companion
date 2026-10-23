// Conformance tests for src/kitlib/artifact.ts (ompkit-gvp4j, KL10). Every case comes from
// tests/fixtures/kitlib-artifact/corpus.json, the same corpus tests/scripts/kitlib_artifact_test.py runs
// against scripts/kitlib_artifact.py, so the two languages cannot drift. Each planted negative runs with
// its detector on (it refuses with its code) and bypassed through the test seam (its result flips); each
// control also runs with every detector bypassed and still passes.
import { afterAll, describe, expect, test } from "bun:test";
import { linkSync, mkdirSync, readFileSync, realpathSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { __testing, ArtifactError, readLocalArtifact, rejectUnknownFields, strictJson, strictJsonl, type LocalArtifact } from "../../src/kitlib/artifact";
import { cleanupAllOwnedTmp, ownedTmp } from "../../src/kitlib/tmp";

type Json = Record<string, unknown>;
type Step = Json & { op: string };
type Case = { id: string; detector?: string; control?: boolean; steps: Step[] };
type Corpus = { schema: string; detectors: string[]; cases: Case[] };

const corpus = JSON.parse(readFileSync(join(import.meta.dir, "../fixtures/kitlib-artifact/corpus.json"), "utf8")) as Corpus;

function substitute<T>(value: T, vars: Record<string, string>): T {
	if (typeof value === "string") return value.replace(/\{[A-Z_]+\}/g, token => vars[token.slice(1, -1)] ?? token) as T;
	if (Array.isArray(value)) return value.map(item => substitute(item, vars)) as T;
	if (value !== null && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, substitute(v, vars)])) as T;
	return value;
}

/** The owner's validator, built from the corpus: unknown fields through the helper, then required fields. */
function ownerValidator(spec: Json | undefined): ((row: unknown) => string[]) | undefined {
	if (spec === undefined) return undefined;
	return row => [
		...(spec.allowed === undefined ? [] : rejectUnknownFields(row, spec.allowed as string[])),
		...((spec.required as string[] | undefined) ?? [])
			.filter(key => row === null || typeof row !== "object" || !Object.hasOwn(row, key))
			.map(key => `missing field ${JSON.stringify(key)}`),
	];
}

function inputBytes(step: Step, artifact: LocalArtifact | undefined): Uint8Array {
	if (step.source === "artifact") return artifact!.bytes;
	return step.hex !== undefined ? Buffer.from(step.hex as string, "hex") : Buffer.from(step.text as string, "utf8");
}

async function runCase(testCase: Case, disabled: string[]): Promise<void> {
	const scratch = ownedTmp("kitlib-artifact");
	const tmp = realpathSync(scratch.path);
	const vars = { TMP: tmp, ROOT: join(tmp, "root"), OUT: join(tmp, "outside") };
	mkdirSync(vars.ROOT);
	mkdirSync(vars.OUT);
	const bypassed = testCase.detector !== undefined && disabled.includes(testCase.detector);
	__testing.disabled = new Set(disabled);
	let artifact: LocalArtifact | undefined;
	try {
		for (const raw of testCase.steps) {
			const step = substitute(raw, vars);
			const where = `${testCase.id} step ${JSON.stringify(raw)}`;
			const want = (bypassed && step.expect_bypassed !== undefined ? step.expect_bypassed : step.expect) as Json;
			const options = (step.options as Json | undefined) ?? {};
			switch (step.op) {
			case "write": writeFileSync(step.path as string, step.text as string); break;
			case "mkdir": mkdirSync(step.path as string); break;
			case "symlink": symlinkSync(step.target as string, step.path as string); break;
			case "hardlink": linkSync(step.target as string, step.path as string); break;
			case "read": {
				let outcome: LocalArtifact | Error;
				try {
					outcome = readLocalArtifact(step.path as string, {
						allowedRoot: vars.ROOT, maxBytes: options.max_bytes as number,
						filePolicy: { symlinks: options.symlinks as never, hardlinks: options.hardlinks as never },
						distinctFrom: options.distinct_from as string[] | undefined,
					});
				} catch (error) {
					outcome = error as Error;
				}
				if (want.ok) {
					if (outcome instanceof Error) throw new Error(`${where}: expected ok, got ${outcome.message} ${JSON.stringify((outcome as ArtifactError).evidence ?? {})}`);
					artifact = outcome;
					const result = (want.result as Json | undefined) ?? {};
					const got: Json = { path: outcome.path, realpath: outcome.realpath, size: outcome.size, sha256: outcome.sha256, text: Buffer.from(outcome.bytes).toString("utf8") };
					for (const key of Object.keys(result)) expect(got[key], `${where}: ${key}`).toEqual(result[key]);
					expect(outcome.bytes.length, where).toBe(outcome.size);
					if (step.provenance) {
						const seen = statSync(outcome.realpath);
						expect([outcome.dev, outcome.ino], where).toEqual([seen.dev, seen.ino]);
						expect(Buffer.from(outcome.bytes).equals(readFileSync(outcome.realpath)), where).toBe(true);
					}
				} else {
					if (!(outcome instanceof ArtifactError)) throw new Error(`${where}: expected ${String(want.code)}, got ${outcome instanceof Error ? outcome.message : "ok"}`);
					expect(outcome.code, `${where}: ${JSON.stringify(outcome.evidence)}`).toBe(want.code as never);
					expect(outcome.evidence.code, where).toBe(outcome.code);
					if (want.evidence !== undefined) expect(outcome.evidence, where).toMatchObject(want.evidence as Json);
				}
				break;
			}
			case "json": {
				let outcome: { value: unknown } | Error;
				try {
					outcome = { value: strictJson(inputBytes(step, artifact), { path: (step.path as string | undefined) ?? "<inline>", maxDepth: options.max_depth as number | undefined }) };
				} catch (error) {
					outcome = error as Error;
				}
				if (want.ok) {
					if (outcome instanceof Error) throw new Error(`${where}: expected ok, got ${outcome.message} ${JSON.stringify((outcome as ArtifactError).evidence ?? {})}`);
					if (want.value !== undefined) expect(outcome.value, where).toEqual(want.value);
				} else {
					if (!(outcome instanceof ArtifactError)) throw new Error(`${where}: expected ${String(want.code)}, got ${JSON.stringify(outcome)}`);
					expect(outcome.code, `${where}: ${JSON.stringify(outcome.evidence)}`).toBe(want.code as never);
					expect(outcome.evidence, where).toMatchObject({ path: (step.path as string | undefined) ?? "<inline>", ...(want.evidence as Json) });
				}
				break;
			}
			case "jsonl": {
				const result = strictJsonl(inputBytes(step, artifact), {
					path: (step.path as string | undefined) ?? "<inline>", maxRows: options.max_rows as number | undefined,
					maxRowBytes: options.max_row_bytes as number | undefined, validate: ownerValidator(options.validator as Json | undefined),
				});
				if (want.rows !== undefined) expect(result.rows, where).toEqual(want.rows as never);
				if (want.row_count !== undefined) expect(result.rows.length, where).toBe(want.row_count as number);
				const expected = want.errors as Json[];
				const got = result.errors.map((error, index) => Object.fromEntries(Object.keys(expected[index] ?? { line: 0, reason: 0 }).map(k => [k, (error as unknown as Json)[k]])));
				expect(got, `${where}: errors ${JSON.stringify(result.errors)}`).toEqual(expected);
				break;
			}
			default: throw new Error(`unknown corpus op ${step.op}`);
			}
		}
	} finally {
		__testing.disabled = new Set();
		scratch.cleanup();
	}
}

describe("kitlib artifact conformance corpus", () => {
	test("corpus is a kitlib-artifact-corpus.v1 corpus and every detector has a planted negative", () => {
		expect(corpus.schema).toBe("kitlib-artifact-corpus.v1");
		expect(corpus.cases.some(c => c.control)).toBe(true);
		expect(new Set(corpus.cases.flatMap(c => c.detector ?? []))).toEqual(new Set(corpus.detectors));
	});
	for (const testCase of corpus.cases) {
		test(testCase.id, () => runCase(testCase, []));
		if (testCase.detector !== undefined) {
			test(`${testCase.id} [detector ${testCase.detector} bypassed: the negative flips]`, () => runCase(testCase, [testCase.detector!]));
		}
		if (testCase.control) test(`${testCase.id} [every detector bypassed: valid control still passes]`, () => runCase(testCase, corpus.detectors));
	}
});

afterAll(() => cleanupAllOwnedTmp());
