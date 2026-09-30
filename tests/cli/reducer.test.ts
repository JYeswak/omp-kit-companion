import { afterAll, beforeAll, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { reduceCandidate, type PredicateOutcome, type ReducerOptions, type ReducerPredicate } from "../../src/reducer.ts";
import { runtimeTempRoot } from "../../src/runtime.ts";
import { runMatcherObservation, type MatcherObservationReport } from "../../src/test-runner.ts";

const repo = resolve(import.meta.dir, "../..");
const open = "BEGIN PUBLIC DEMO\n";
const close = "END PUBLIC DEMO\n";
const original = `${open}noise one\nPUBLIC DANGER\nnoise two\n${close}`;
const wanted = `${open}PUBLIC DANGER\n${close}`;
const header = "rule\texpect\tsource\ttool\tpath\tsnippet\tnote\n";
const sha = (value: string | Buffer) => createHash("sha256").update(value).digest("hex");
let base = "";
let release = "";
let executablePath = "";
let rules = "";
let ruleSha = "";

beforeAll(() => {
	base = realpathSync(mkdtempSync(join(runtimeTempRoot(), "omp-kit-reducer-test-")));
	release = join(base, "release");
	executablePath = join(release, "bin", "omp-kit");
	rules = join(base, "synthetic-rules");
	for (const path of [join(release, "bin"), join(release, "scripts"), rules]) mkdirSync(path, { recursive: true });
	for (const path of ["rules", "retired", "cases", "policy", "extensions"]) cpSync(join(repo, path), join(release, path), { recursive: true });
	for (const path of ["MANIFEST.tsv", "scripts/ttsr-harness.ts", "scripts/rule-class.ts"]) {
		writeFileSync(join(release, path), readFileSync(join(repo, path)));
	}
	const rule = "---\ncondition:\n  - 'PUBLIC DANGER'\nscope:\n  - text\ninterruptMode: never\n---\nPublic synthetic reduction fixture.\n";
	writeFileSync(join(rules, "synthetic-reduction.md"), rule);
	ruleSha = sha(rule);
	const build = Bun.spawnSync([process.execPath, "build", "--compile", "--no-compile-autoload-dotenv", "--no-compile-autoload-bunfig",
		join(repo, "src/cli.ts"), "--outfile", executablePath], { cwd: base, stdout: "pipe", stderr: "pipe" });
	if (build.exitCode !== 0) throw new Error(`fixture compile failed: ${build.stdout.toString()}\n${build.stderr.toString()}`);
}, 60_000);

afterAll(() => { if (base) rmSync(base, { recursive: true, force: true }); });

function nativeOracle(expectedRuleSha256 = ruleSha): { evaluate: ReducerPredicate; reports: MatcherObservationReport[] } {
	const cases = join(mkdtempSync(join(base, "oracle-")), "cases.tsv");
	const reports: MatcherObservationReport[] = [];
	const evaluate: ReducerPredicate = async (candidate, context) => {
		if (context.signal.aborted) return { status: "UNAVAILABLE", reason: "aborted" };
		const encoded = candidate.replace(/\n/g, "\\n").replace(/\t/g, "\\t");
		const bytes = `${header}synthetic-reduction\tfire\ttext\t-\t-\t${encoded}\tpublic synthetic payload\n`;
		writeFileSync(cases, bytes);
		const report = await runMatcherObservation({ root: release, executablePath, rules, cases,
			rule: "synthetic-reduction", caseLine: 2, expectedRuleSha256,
			timeoutMs: Math.max(1, Math.min(5_000, Math.floor(context.remainingMs))) });
		reports.push(report);
		const observation = report.observation;
		if (observation.status !== "OK") return { status: "UNAVAILABLE", reason: observation.reason, evidence: report };
		if (observation.bindings.cases_sha256 !== sha(bytes)) return { status: "UNAVAILABLE", reason: "candidate-bytes-changed", evidence: report };
		const { cases_sha256: _candidateHash, ...identity } = observation.bindings;
		return { status: candidate.startsWith(open) && candidate.endsWith(close) && observation.whole === "fire" ? "HOLD" : "LOSE",
			identity, evidence: report };
	};
	return { evaluate, reports };
}

function options(predicate: ReducerPredicate, finalReplay = predicate): ReducerOptions {
	return { grammar: "lines", maxAttempts: 30, timeBudgetMs: 30_000, predicate, finalReplay };
}

const syntheticIdentity = { oracle: "authored-line-predicate-v1" };
const keepLine: ReducerPredicate = async candidate => ({ status: candidate.includes("KEEP\n") ? "HOLD" : "LOSE", identity: syntheticIdentity });

test("real native payload becomes smaller while benign context and independent final fire are preserved", async () => {
	const oracle = nativeOracle();
	const replay = nativeOracle();
	const result = await reduceCandidate(original, options(oracle.evaluate, replay.evaluate));
	expect(result.status).toBe("REDUCED");
	expect(result.candidate).toBe(wanted);
	expect(result.originalBytes).toBe(Buffer.byteLength(original));
	expect(result.candidateBytes).toBe(Buffer.byteLength(wanted));
	expect(result.stopReason).toBe("no-improvement");
	expect(result.finalReplay?.status).toBe("HOLD");
	expect(result.trace[0]?.candidateSha256).toBe(sha(original));
	expect(result.trace[result.trace.length - 1]?.candidateSha256).toBe(sha(wanted));
	let previous = Buffer.byteLength(original);
	for (const step of result.trace) {
		if (!step.accepted) continue;
		expect(step.bytes).toBeLessThan(previous);
		previous = step.bytes;
	}
	expect(previous).toBe(Buffer.byteLength(wanted));
	expect(replay.reports).toHaveLength(1);
	expect(replay.reports[0]).toMatchObject({ producer: { producer_rc: 0 },
		observation: { status: "OK", rule: "synthetic-reduction", whole: "fire", witness: { source: "text", tool: "-", path: "-" } } });
}, 60_000);

test("LOST_PREDICATE: false acceptance of a real quiet payload cannot survive independent native replay", async () => {
	const oracle = nativeOracle();
	const replay = nativeOracle();
	const faulty: ReducerPredicate = async (candidate, context) => {
		const actual = await oracle.evaluate(candidate, context);
		return actual.status === "UNAVAILABLE" ? actual : { ...actual, status: "HOLD" };
	};
	const result = await reduceCandidate(original, options(faulty, replay.evaluate));
	expect(result.status).toBe("MINIMIZATION_INCOMPLETE");
	expect(result.stopReason).toBe("final-predicate-lost");
	expect(result.candidate).toBeNull();
	expect(result.candidateBytes).toBeNull();
	expect(result.finalReplay?.status).toBe("LOSE");
	expect(replay.reports).toHaveLength(1);
	expect(replay.reports[0]).toMatchObject({ producer: { producer_rc: 0 }, observation: { status: "OK", whole: "quiet" } });
}, 60_000);

test("unavailable native rule identity is never treated as a losing or quiet candidate", async () => {
	const oracle = nativeOracle("0".repeat(64));
	const result = await reduceCandidate(original, options(oracle.evaluate));
	expect(result.status).toBe("UNAVAILABLE");
	expect(result.stopReason).toBe("BUNDLED_SUBSTITUTION");
	expect(result.candidate).toBeNull();
	expect(result.attempts).toBe(1);
	expect(result.finalReplay).toBeNull();
	expect(oracle.reports[0]).toMatchObject({ producer: { producer_rc: 1 }, observation: { status: "UNAVAILABLE", reason: "BUNDLED_SUBSTITUTION" } });
}, 30_000);

test("line search is deterministic and no-improvement does not claim a reduction", async () => {
	const input = "noise\nKEEP\nnoise two\n";
	const first = await reduceCandidate(input, options(keepLine));
	const second = await reduceCandidate(input, options(keepLine));
	expect(first).toEqual(second);
	expect(first.status).toBe("REDUCED");
	expect(first.candidate).toBe("KEEP\n");
	const unchanged = await reduceCandidate("KEEP\n", options(keepLine));
	expect(unchanged.status).toBe("UNCHANGED");
	expect(unchanged.stopReason).toBe("no-improvement");
	expect(unchanged.candidate).toBe("KEEP\n");
	expect(unchanged.finalReplay?.status).toBe("HOLD");
});

test("attempt budget reserves final replay and labels the searched subset incomplete", async () => {
	const partial = await reduceCandidate("noise\nKEEP\nnoise two\n", { ...options(keepLine), maxAttempts: 3 });
	expect(partial.status).toBe("MINIMIZATION_INCOMPLETE");
	expect(partial.stopReason).toBe("attempt-budget");
	expect(partial.attempts).toBe(3);
	expect(partial.candidate).toBe("KEEP\nnoise two\n");
	expect(partial.finalReplay?.status).toBe("HOLD");
	const noReplay = await reduceCandidate("KEEP\n", { ...options(keepLine), maxAttempts: 1 });
	expect(noReplay.status).toBe("MINIMIZATION_INCOMPLETE");
	expect(noReplay.attempts).toBe(1);
	expect(noReplay.candidate).toBeNull();
	expect(noReplay.finalReplay).toBeNull();
});

test("unavailable evaluation stops immediately instead of retrying or accepting prior unverified progress", async () => {
	let calls = 0;
	const predicate: ReducerPredicate = async () => ++calls === 1
		? { status: "HOLD", identity: syntheticIdentity }
		: { status: "UNAVAILABLE", reason: "evaluator-unavailable" };
	const result = await reduceCandidate("noise\nKEEP\n", options(predicate));
	expect(result.status).toBe("UNAVAILABLE");
	expect(result.stopReason).toBe("evaluator-unavailable");
	expect(calls).toBe(2);
	expect(result.candidate).toBeNull();
	expect(result.finalReplay).toBeNull();
});

for (const phase of ["candidate", "final_replay"] as const) {
	test(`changed evaluator identity during ${phase} invalidates the proposed result`, async () => {
		let calls = 0;
		const predicate: ReducerPredicate = async candidate => ({ status: candidate.includes("KEEP\n") ? "HOLD" : "LOSE",
			identity: { oracle: phase === "candidate" && ++calls > 1 ? "changed" : "original" } });
		const replay: ReducerPredicate = async () => ({ status: "HOLD", identity: { oracle: "changed" } });
		const result = await reduceCandidate("noise\nKEEP\n", options(predicate, phase === "final_replay" ? replay : predicate));
		expect(result.status).toBe("UNAVAILABLE");
		expect(result.stopReason).toBe("identity-changed");
		expect(result.candidate).toBeNull();
	});
}

test("time budget signals cancellation and cannot publish a candidate from an unfinished evaluator", async () => {
	let cancelled = false;
	const pending: ReducerPredicate = (_candidate, context) => new Promise<PredicateOutcome>(resolve => {
		context.signal.addEventListener("abort", () => {
			cancelled = true;
			resolve({ status: "UNAVAILABLE", reason: "cancelled" });
		}, { once: true });
	});
	const result = await reduceCandidate("KEEP\n", { ...options(pending), timeBudgetMs: 10 });
	expect(result.status).toBe("MINIMIZATION_INCOMPLETE");
	expect(result.stopReason).toBe("time-budget");
	expect(cancelled).toBe(true);
	expect(result.candidate).toBeNull();
	expect(result.finalReplay).toBeNull();
});
