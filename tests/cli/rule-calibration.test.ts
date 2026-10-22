import { afterAll, expect, test } from "bun:test";
import { readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { runtimeTempRoot } from "../../src/runtime.ts";
import { calibrateCorpus, calibrateRule, wilsonInterval } from "../../src/rule-calibration.ts";
import { cleanupAllOwnedTmp, ownedTmp } from "../../src/kitlib/tmp.ts";
afterAll(cleanupAllOwnedTmp);

test("calibrates a sampled false-fire rate with its Wilson interval", () => {
	const result = calibrateRule({
		rule: "kit-test-skip", kind: "write", scanned: 100, fires: 20,
		session_count: 10,
		labels: [true, false, false, true, false, false, false, true, false, false],
		noisy_lower_bound: 0.05,
	});
	expect(result.sample_size).toBe(10);
	expect(result.false_fires).toBe(7);
	expect(result.false_fire_rate).toBeCloseTo(0.7);
	expect(result.ci_low).toBeLessThan(0.7);
	expect(result.ci_high).toBeGreaterThan(0.7);
	expect(result.noisy).toBe(true);
	expect(result.fire_rate).toBe(0.2);
});

test("uses a deterministic seeded sample and does not confuse fire rate with false-fire rate", () => {
	const corpus = {
		files: 20,
		rules: [
			{ rule: "rule-a", kind: "bash", scanned: 20, fires: 4 },
			{ rule: "dead-rule", kind: "bash", scanned: 20, fires: 0 },
		],
	};
	const labels = Array.from({ length: 20 }, (_, index) => ({
		rule: "rule-a", kind: "bash", event_index: index, false_fire: index % 2 === 0,
	}));
	const first = calibrateCorpus({ corpus, labels, seed: 17, sample_size: 8, noisy_lower_bound: 0.2 });
	const second = calibrateCorpus({ corpus, labels, seed: 17, sample_size: 8, noisy_lower_bound: 0.2 });
	expect(first).toEqual(second);
	expect(first.rules.find((rule) => rule.rule === "rule-a")?.false_fire_rate).not.toBe(0.2);
	expect(first.dead_rules).toEqual([{ rule: "dead-rule", kind: "bash", sessions: 20 }]);
});

test("Wilson intervals reject invalid counts instead of manufacturing precision", () => {
	expect(wilsonInterval(2, 0)).toEqual({ low: 0, high: 0 });
	expect(wilsonInterval(3, 2)).toEqual({ low: 0, high: 0 });
});


test("doctor rules exposes calibrated noisy and dead rules from explicit reports", () => {
	const root = ownedTmp("mt2-cli", { root: runtimeTempRoot() }).path;
	try {
		const corpus = join(root, "corpus.json");
		const labels = join(root, "labels.json");
		writeFileSync(corpus, JSON.stringify({ files: 20, rules: [{ rule: "rule-a", kind: "bash", scanned: 20, fires: 4 }, { rule: "dead", kind: "bash", scanned: 20, fires: 0 }] }));
		writeFileSync(labels, JSON.stringify([{ rule: "rule-a", kind: "bash", event_index: 1, false_fire: true }, { rule: "rule-a", kind: "bash", event_index: 2, false_fire: true }, { rule: "rule-a", kind: "bash", event_index: 3, false_fire: false }]));
		const result = Bun.spawnSync([process.execPath, resolve(import.meta.dir, "../../src/cli.ts"), "doctor", "--scope", "rules", "--corpus-report", corpus, "--labels", labels, "--seed", "7", "--sample-size", "10", "--json"], { stdout: "pipe", stderr: "pipe" });
		expect(result.exitCode).toBe(0);
		const envelope = JSON.parse(result.stdout.toString()) as { data?: { calibration?: { dead_rules?: unknown[] } } };
		expect(envelope.data?.calibration?.dead_rules).toEqual([{ rule: "dead", kind: "bash", sessions: 20 }]);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("planted false-fire rate is recovered within its Wilson interval", () => {
	const planted = 0.5;
	const truth = Array.from({ length: 40 }, (_, index) => index % 2 === 0);
	const result = calibrateRule({
		rule: "planted-rule", kind: "bash", scanned: 200, fires: 40,
		session_count: 12, labels: truth, noisy_lower_bound: 0.05,
	});
	expect(result.sample_size).toBe(40);
	expect(result.false_fires).toBe(20);
	expect(result.false_fire_rate).toBeCloseTo(planted);
	expect(result.ci_low).toBeLessThanOrEqual(planted);
	expect(result.ci_high).toBeGreaterThanOrEqual(planted);
});

test("invalid counts refuse with a named error", () => {
	expect(() => calibrateRule({
		rule: "bad-counts", kind: "bash", scanned: 5, fires: 9,
		session_count: 3, labels: [true], noisy_lower_bound: 0.05,
	})).toThrow("CALIBRATION_COUNT_INVALID");
	expect(() => calibrateCorpus({
		corpus: { files: -1, rules: [] }, labels: [], seed: 17, sample_size: 8, noisy_lower_bound: 0.05,
	})).toThrow("CALIBRATION_SCHEMA_INVALID");
});

test("doctor rules refuses invalid counts and invalid schema with named errors", () => {
	const root = ownedTmp("mt2-refuse", { root: runtimeTempRoot() }).path;
	try {
		const corpus = join(root, "corpus.json");
		const labels = join(root, "labels.json");
		const goodLabels = join(root, "good-labels.json");
		writeFileSync(corpus, JSON.stringify({ files: 12, rules: [{ rule: "bad", kind: "bash", scanned: 5, fires: 9 }] }));
		writeFileSync(labels, JSON.stringify([{ rule: "bad", kind: "bash", event_index: 0, false_fire: true }]));
		writeFileSync(goodLabels, JSON.stringify([{ rule: "bad", kind: "bash", event_index: 0, false_fire: true }]));
		const run = (corpusPath: string, labelsPath: string) => Bun.spawnSync(
			[process.execPath, resolve(import.meta.dir, "../../src/cli.ts"), "doctor", "--scope", "rules",
				"--corpus-report", corpusPath, "--labels", labelsPath, "--json"], { stdout: "pipe", stderr: "pipe" });
		const counts = run(corpus, labels);
		expect(counts.exitCode).toBe(2);
		const countsEnvelope = JSON.parse(counts.stdout.toString()) as { errors?: { code?: string; message?: string }[] };
		expect(countsEnvelope.errors?.[0]?.code).toBe("CALIBRATION_INPUT_INVALID");
		expect(countsEnvelope.errors?.[0]?.message).toContain("CALIBRATION_COUNT_INVALID");
		writeFileSync(corpus, "{not valid json");
		const schema = run(corpus, goodLabels);
		expect(schema.exitCode).toBe(2);
		const schemaEnvelope = JSON.parse(schema.stdout.toString()) as { errors?: { code?: string }[] };
		expect(schemaEnvelope.errors?.[0]?.code).toBe("CALIBRATION_INPUT_INVALID");
		writeFileSync(corpus, JSON.stringify({ files: 12 }));
		const shape = run(corpus, goodLabels);
		expect(shape.exitCode).toBe(2);
		const shapeEnvelope = JSON.parse(shape.stdout.toString()) as { errors?: { code?: string; message?: string }[] };
		expect(shapeEnvelope.errors?.[0]?.code).toBe("CALIBRATION_INPUT_INVALID");
		expect(shapeEnvelope.errors?.[0]?.message).toContain("CALIBRATION_SCHEMA_INVALID");
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("dead-rule list matches the checked-in fixture", () => {
	const fixture = JSON.parse(readFileSync(resolve(import.meta.dir, "fixtures/rule-calibration-dead.json"), "utf8")) as {
		seed: number; sample_size: number; noisy_lower_bound: number; dead_rules: unknown[];
	};
	const labels = Array.from({ length: 12 }, (_, index) => ({
		rule: "live-gamma", kind: "bash", event_index: index, false_fire: index % 3 === 0,
	}));
	const report = calibrateCorpus({
		corpus: {
			files: 12,
			rules: [
				{ rule: "live-gamma", kind: "bash", scanned: 12, fires: 6 },
				{ rule: "dead-alpha", kind: "bash", scanned: 12, fires: 0 },
				{ rule: "dead-beta", kind: "write", scanned: 12, fires: 0 },
			],
		},
		labels,
		seed: fixture.seed,
		sample_size: fixture.sample_size,
		noisy_lower_bound: fixture.noisy_lower_bound,
	});
	expect(report.dead_rules).toEqual(fixture.dead_rules);
});
