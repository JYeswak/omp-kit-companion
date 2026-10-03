import { expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { runtimeTempRoot } from "../../src/runtime.ts";
import { calibrateCorpus, calibrateRule, wilsonInterval } from "../../src/rule-calibration.ts";

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
	const root = mkdtempSync(join(runtimeTempRoot(), "mt2-cli-"));
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
