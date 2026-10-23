// Conformance tests for src/kitlib/jsonl.ts (ompkit-ibgvg, KL11). Every case comes
// from tests/fixtures/kitlib-jsonl/corpus.json, the same corpus
// tests/scripts/kitlib_jsonl_test.py runs against scripts/kitlib_jsonl.py, so the
// two languages cannot drift. Concurrent writers are real processes in both
// languages appending to one file under the shared KL08 lock.
import { afterAll, describe, expect, test } from "bun:test";
import { appendFileSync, fsyncSync, lstatSync, readFileSync, realpathSync, renameSync, symlinkSync, writeFileSync, writeSync } from "node:fs";
import { join } from "node:path";
import { __testing, appendJsonl, readJsonl, type AppendState, type JsonlCursor } from "../../src/kitlib/jsonl";
import { __testing as lockTesting, privateLock, type PrivateLock } from "../../src/kitlib/lock";
import { run } from "../../src/kitlib/run";
import { cleanupAllOwnedTmp, ownedTmp } from "../../src/kitlib/tmp";

type Json = Record<string, unknown>;
type Step = Json & { op: string; when?: "normal" | "bypassed" };
type Case = { id: string; detector?: string; control?: boolean; steps: Step[] };
type Corpus = {
	schema: string; detectors: string[]; lock_detectors: Record<string, string>;
	writers: Record<"ts" | "py", string[]>; readers: Record<"ts" | "py", string[]>; cases: Case[];
};

const corpus = JSON.parse(readFileSync(join(import.meta.dir, "../fixtures/kitlib-jsonl/corpus.json"), "utf8")) as Corpus;
const MODULE_TS = join(import.meta.dir, "../../src/kitlib/jsonl.ts");
const SCRIPTS_DIR = join(import.meta.dir, "../../scripts");
const PYTHON = Bun.which("python3");
const decoder = new TextDecoder();

function substitute<T>(value: T, vars: Record<string, string>): T {
	if (typeof value === "string") return value.replace(/\{[A-Z_]+\}/g, token => vars[token.slice(1, -1)] ?? token) as T;
	if (Array.isArray(value)) return value.map(item => substitute(item, vars)) as T;
	if (value !== null && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, substitute(v, vars)])) as T;
	return value;
}

function childVars(vars: Record<string, string>): Record<string, string> {
	return { ...vars, BUN: process.execPath, PYTHON: PYTHON!, MODULE_TS, SCRIPTS_DIR };
}

class CaseRun {
	readonly cursors = new Map<string, JsonlCursor | null>();
	held: PrivateLock | undefined;
	fsyncs = 0;
	constructor(readonly testCase: Case, readonly vars: Record<string, string>, readonly bypassed: boolean) {}

	build(step: Step): (state: AppendState) => unknown {
		switch (step.build) {
		case "record": return () => step.record;
		case "throw": return () => { throw new Error("domain validation refused"); };
		case "state": return state => ({ size: state.size, created: state.created, torn: state.torn });
		case "probe-lock": return async state => {
			let locked = false;
			try {
				(await privateLock({ namespace: "kitlib-jsonl", path: this.vars.FILE! }, { deadline_s: 0, state_dir: this.vars.STATE })).release();
			} catch (error) {
				locked = (error as { code?: string }).code === "DEADLINE";
			}
			return { locked, size: state.size, torn: state.torn };
		};
		default: throw new Error(`unknown build ${String(step.build)}`);
		}
	}

	async append(step: Step, raw: Step, where: string): Promise<void> {
		const want = (this.bypassed && raw.expect_bypassed !== undefined ? step.expect_bypassed : step.expect) as Json;
		const options = step.options as Json;
		let outcome: unknown;
		try {
			outcome = await appendJsonl((step.path as string | undefined) ?? this.vars.FILE!, this.build(step), {
				deadline_s: options.deadline_s as number, tornTail: options.torn_tail as never, durable: options.durable as boolean | undefined,
				state_dir: this.vars.STATE,
			});
		} catch (error) {
			outcome = error;
		}
		if (want.ok) {
			if (outcome instanceof Error) throw new Error(`${where}: expected ok, got ${outcome.message} ${JSON.stringify((outcome as { evidence?: unknown }).evidence ?? {})}`);
			if (want.result !== undefined) expect(outcome as Json, where).toMatchObject(want.result as Json);
			return;
		}
		if (!(outcome instanceof Error)) throw new Error(`${where}: expected refusal ${JSON.stringify(want)}, got ${JSON.stringify(outcome)}`);
		const refusal = outcome as Error & { code?: string; evidence?: Json };
		expect(refusal.code, `${where}: ${refusal.message} ${JSON.stringify(refusal.evidence)}`).toBe(want.code as string);
		expect(refusal.evidence?.code, where).toBe(refusal.code);
		if (want.evidence !== undefined) expect(refusal.evidence, where).toMatchObject(want.evidence as Json);
	}

	read(step: Step, where: string): void {
		const options = (step.options as Json | undefined) ?? {};
		const result = readJsonl(this.vars.FILE!, {
			maxBytes: options.max_bytes as number | undefined,
			fromCursor: options.cursor === undefined ? undefined : this.cursors.get(options.cursor as string),
		});
		if (step.save !== undefined) this.cursors.set(step.save as string, result.cursor);
		const want = step.expect as Json;
		for (const [key, value] of Object.entries(want)) {
			if (key === "errors") {
				const expected = value as Json[];
				const got = result.errors.map((error, index) => Object.fromEntries(Object.keys(expected[index] ?? { line: 0, reason: 0 }).map(k => [k, (error as unknown as Json)[k]])));
				expect(got, `${where}: errors ${JSON.stringify(result.errors)}`).toEqual(expected);
			} else if (key === "cursor") {
				expect(result.cursor, where).toMatchObject(value as Json);
			} else {
				expect((result as unknown as Json)[key], `${where}: ${key}`).toEqual(value);
			}
		}
	}

	async step(raw: Step): Promise<void> {
		if (raw.when === "normal" && this.bypassed) return;
		if (raw.when === "bypassed" && !this.bypassed) return;
		const step = substitute(raw, this.vars);
		const where = `${this.testCase.id} step ${JSON.stringify(raw)}`;
		const path = step.path as string;
		switch (step.op) {
		case "write": writeFileSync(path, step.hex !== undefined ? Buffer.from(step.hex as string, "hex") : step.text as string); break;
		case "append-raw": appendFileSync(path, step.text as string); break;
		case "rename": renameSync(path, step.target as string); break;
		case "symlink": symlinkSync(step.target as string, path); break;
		case "hook":
			if (step.write === "max3") __testing.write = (fd, buffer, offset, length) => writeSync(fd, buffer, offset, Math.min(3, length));
			if (step.write === "zero") __testing.write = () => 0;
			if (step.fsync === "fail") __testing.fsync = () => { throw Object.assign(new Error("EIO: planted fsync failure"), { code: "EIO" }); };
			if (step.fsync === "count") __testing.fsync = fd => { this.fsyncs += 1; fsyncSync(fd); };
			if (step.before_write === "replace-target") __testing.beforeWrite = target => { renameSync(target, `${target}.old`); writeFileSync(target, ""); };
			break;
		case "hold-lock": this.held = await privateLock({ namespace: "kitlib-jsonl", path: this.vars.FILE! }, { deadline_s: 5, state_dir: this.vars.STATE }); break;
		case "release-lock": this.held?.release(); this.held = undefined; break;
		case "append": await this.append(step, raw, where); break;
		case "read": this.read(step, where); break;
		case "expect-file": {
			if (step.absent) { expect(() => lstatSync(path), where).toThrow(); break; }
			if (step.text !== undefined) expect(readFileSync(path, "utf8"), where).toBe(step.text as string);
			if (step.mode !== undefined) expect(lstatSync(path).mode & 0o777, where).toBe(Number.parseInt(step.mode as string, 8));
			break;
		}
		case "expect-fsyncs": expect(this.fsyncs, where).toBe(step.count as number); break;
		case "reader-child": {
			// Reopen in a fresh process of the other language.
			const argv = substitute(corpus.readers.py, childVars(this.vars));
			const result = await run(argv, { deadline_s: 60 });
			expect(result.rc, decoder.decode(result.stderr)).toBe(0);
			expect(JSON.parse(decoder.decode(result.stdout)), where).toEqual(step.expect_rows);
			break;
		}
		case "writers": await this.writers(step, where); break;
		default: throw new Error(`unknown corpus op ${step.op}`);
		}
	}

	async writers(step: Step, where: string): Promise<void> {
		const writers = step.writers as { lang: "ts" | "py"; id: string }[];
		const count = step.count as number, pad = step.pad as number;
		const results = await Promise.all(writers.map(writer => run(
			substitute(corpus.writers[writer.lang], { ...childVars(this.vars), ID: writer.id, COUNT: String(count), PAD: String(pad) }),
			{ deadline_s: 300 },
		)));
		for (const result of results) expect(result.rc, `${where}: ${decoder.decode(result.stderr)}`).toBe(0);
		const read = readJsonl(this.vars.FILE!, { maxBytes: 64 * 1024 * 1024 });
		expect(read.errors, where).toEqual([]);
		expect([read.rows.length, read.pending_tail_bytes, read.more], where).toEqual([writers.length * count, 0, false]);
		for (const writer of writers) {
			const mine = (read.rows as { w: string; i: number; pad: string }[]).filter(row => row.w === writer.id);
			expect(mine.map(row => row.i), `${where}: ${writer.id} order`).toEqual([...Array(count).keys()]);
			expect(mine.every(row => row.pad.length === pad), where).toBe(true);
		}
	}

	cleanup(): void {
		this.held?.release();
	}
}

function resetSeam(): void {
	__testing.disabled = new Set();
	__testing.write = undefined;
	__testing.fsync = undefined;
	__testing.beforeWrite = undefined;
	lockTesting.disabled = new Set();
}

async function runCase(testCase: Case, disabled: string[]): Promise<void> {
	const scratch = ownedTmp("kitlib-jsonl");
	const tmp = realpathSync(scratch.path);
	const vars: Record<string, string> = { TMP: tmp, STATE: join(tmp, "state"), FILE: join(tmp, "ledger.jsonl") };
	const caseRun = new CaseRun(testCase, vars, testCase.detector !== undefined && disabled.includes(testCase.detector));
	resetSeam();
	__testing.disabled = new Set(disabled);
	lockTesting.disabled = new Set(disabled.flatMap(name => corpus.lock_detectors[name] ?? []));
	try {
		for (const step of testCase.steps) await caseRun.step(step);
	} finally {
		resetSeam();
		caseRun.cleanup();
		scratch.cleanup();
	}
}

describe("kitlib jsonl conformance corpus", () => {
	test("corpus is a kitlib-jsonl-corpus.v1 corpus and python3 is present for cross-language writers", () => {
		expect(corpus.schema).toBe("kitlib-jsonl-corpus.v1");
		expect(corpus.cases.length).toBeGreaterThan(0);
		expect(PYTHON).not.toBeNull();
	});
	for (const testCase of corpus.cases) {
		test(testCase.id, () => runCase(testCase, []), 300_000);
		if (testCase.detector !== undefined) {
			test(`${testCase.id} [detector ${testCase.detector} bypassed: the negative flips]`, () => runCase(testCase, [testCase.detector!]), 60_000);
		}
		if (testCase.control) test(`${testCase.id} [every detector bypassed: valid control still passes]`, () => runCase(testCase, corpus.detectors), 60_000);
	}
});

afterAll(() => cleanupAllOwnedTmp());
