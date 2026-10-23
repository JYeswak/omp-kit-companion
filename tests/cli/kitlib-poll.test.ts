// Conformance tests for src/kitlib/poll.ts (ompkit-u6k6t, KL13). Every case comes
// from tests/fixtures/kitlib-poll/corpus.json, the same corpus
// tests/scripts/kitlib_poll_test.py runs against scripts/kitlib_poll.py. cases run
// on a fake clock through the test seam; cli_cases run the Python shell adapter
// with real probes through kitlib run.
import { describe, expect, test } from "bun:test";
import { readFileSync, realpathSync, rmSync } from "node:fs";
import { join } from "node:path";
import { boundObservation, pollUntil, PollError, whenAll, type PollDetector, type PollResult } from "../../src/kitlib/poll";
import { run } from "../../src/kitlib/run";
import { ownedTmp } from "../../src/kitlib/tmp";

type Obs = Record<string, unknown>;
type Step = { cost_s: number; obs: Obs; wall_jump_s?: number };
type Expect = {
	outcome?: string; attempts?: number; min_attempts?: number; elapsed_s?: number; observation?: unknown;
	observation_truncated?: boolean; observation_max_bytes?: number; throws?: string;
};
type Case = {
	id: string; options: { deadline_s: number; interval_s: number; attempt_timeout_s?: number; max_observation_bytes?: number };
	success: { key: string; eq: unknown }[]; terminal?: { key: string; eq: unknown }[]; script: Step[];
	cancel_in_interval_of?: number; bypass?: PollDetector; expect: Expect; expect_bypassed?: Expect;
};
type CliCase = { id: string; args: string[]; expect: Record<string, unknown> & { exit: number; max_elapsed_s?: number; stdout?: string } };

const ROOT = join(import.meta.dir, "../..");
const corpus = JSON.parse(readFileSync(join(ROOT, "tests/fixtures/kitlib-poll/corpus.json"), "utf8")) as { schema: string; cases: Case[]; cli_cases: CliCase[] };
const EPS = 1e-6;

type Driven = { result?: PollResult<Obs>; error?: unknown; calls: number };

async function drive(c: Case, bypass: PollDetector[]): Promise<Driven> {
	let mono = 1000, wall = 1_700_000_000, calls = 0;
	const controller = new AbortController();
	const predicate = (p: { key: string; eq: unknown }) => (o: Obs) => o[p.key] === p.eq;
	const probe = (context: { attempt: number; remaining_s: number; attempt_timeout_s: number }): Obs => {
		calls++;
		expect(context.attempt).toBe(calls);
		expect(context.attempt_timeout_s).toBeLessThanOrEqual(context.remaining_s + EPS);
		if (c.options.attempt_timeout_s !== undefined) expect(context.attempt_timeout_s).toBeLessThanOrEqual(c.options.attempt_timeout_s);
		const step = c.script[Math.min(calls, c.script.length) - 1]!;
		const timedOut = step.cost_s > context.attempt_timeout_s;
		const cost = timedOut ? context.attempt_timeout_s : step.cost_s;
		mono += cost; wall += cost + (step.wall_jump_s ?? 0);
		return timedOut ? { timed_out: true } : step.obs;
	};
	try {
		const classify = whenAll(c.success.map(predicate), (c.terminal ?? []).map(predicate), { bypass });
		const result = await pollUntil(probe, {
			...c.options, classify, signal: controller.signal,
			_seams: {
				now: () => mono, wallNow: () => wall, bypass,
				sleep: async seconds => {
					if (c.cancel_in_interval_of === calls) { mono += seconds / 2; wall += seconds / 2; controller.abort(); return; }
					mono += seconds; wall += seconds;
				},
			},
		});
		return { result, calls };
	} catch (error) {
		return { error, calls };
	}
}

function judge(id: string, got: Driven, want: Expect): void {
	if (want.throws) {
		expect(got.error, id).toBeInstanceOf(PollError);
		expect((got.error as PollError).code).toBe(want.throws as "INVALID_ARGUMENT");
		expect(got.calls, `${id}: probe ran before refusal`).toBe(0);
		return;
	}
	if (got.error) throw got.error;
	const r = got.result!;
	const shown = `${id}: ${JSON.stringify(r).slice(0, 300)}`;
	expect(r.attempts, shown).toBe(got.calls);
	if (want.outcome !== undefined) expect(r.outcome, shown).toBe(want.outcome as PollResult<Obs>["outcome"]);
	if (want.attempts !== undefined) expect(r.attempts, shown).toBe(want.attempts);
	if (want.min_attempts !== undefined) expect(r.attempts, shown).toBeGreaterThanOrEqual(want.min_attempts);
	if (want.elapsed_s !== undefined) expect(Math.abs(r.elapsed_s - want.elapsed_s), shown).toBeLessThan(EPS);
	if (want.observation !== undefined) expect(r.observation, shown).toEqual(want.observation as Obs);
	if (want.observation_truncated !== undefined) expect(r.observation_truncated, shown).toBe(want.observation_truncated);
	if (want.observation_max_bytes !== undefined) {
		expect(typeof r.observation).toBe("string");
		expect(Buffer.byteLength(r.observation as string, "utf8")).toBeLessThanOrEqual(want.observation_max_bytes);
	}
}

describe("kitlib poll conformance corpus", () => {
	test("corpus is a kitlib-poll-corpus.v1 corpus", () => {
		expect(corpus.schema).toBe("kitlib-poll-corpus.v1");
		expect(corpus.cases.length).toBeGreaterThan(0);
	});
	for (const c of corpus.cases) {
		test(c.id, async () => {
			judge(c.id, await drive(c, []), c.expect);
			if (c.bypass) {
				const bypassed = await drive(c, [c.bypass]);
				judge(`${c.id} [bypass ${c.bypass}]`, bypassed, c.expect_bypassed!);
			}
		});
	}
	test("truncation cuts on a UTF-8 character boundary", () => {
		const { observation, truncated } = boundObservation({ s: "€€€€" }, 9);
		expect(truncated).toBe(true);
		expect(observation).toBe('{"s":"€');
	});
	test("real clock and sleep: a short budget ends in deadline near its bound", async () => {
		const started = performance.now();
		const result = await pollUntil(() => ({ ready: false }), { deadline_s: 0.3, interval_s: 0.05, classify: whenAll([(o: Obs) => o.ready === true]) });
		expect(result.outcome).toBe("deadline");
		expect((performance.now() - started) / 1000).toBeLessThan(2);
	});
});

describe("kitlib poll shell adapter", () => {
	for (const c of corpus.cli_cases) {
		test(c.id, async () => {
			const scratch = ownedTmp("kitlib-poll");
			const tmp = realpathSync(scratch.path);
			try {
				const args = c.args.map(arg => arg.replaceAll("{TMP}", tmp));
				const result = await run(["python3", "-B", join(ROOT, "scripts/kitlib_poll.py"), ...args], { deadline_s: 30 });
				const lines = new TextDecoder().decode(result.stdout).trim().split("\n");
				const final = JSON.parse(lines.at(-1)!) as Record<string, unknown>;
				const shown = `${c.id}: rc=${result.rc} ${JSON.stringify(final)}`;
				expect(result.rc, shown).toBe(c.expect.exit);
				for (const key of ["outcome", "attempts", "code"]) if (c.expect[key] !== undefined) expect(final[key], shown).toBe(c.expect[key]);
				if (c.expect.max_elapsed_s !== undefined) expect(final.elapsed_s as number).toBeLessThan(c.expect.max_elapsed_s);
				if (c.expect.stdout !== undefined) expect((final.observation as { stdout: string }).stdout).toBe(c.expect.stdout);
			} finally {
				rmSync(scratch.path, { recursive: true, force: true });
			}
		}, 40_000);
	}
});
