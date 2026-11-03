import { afterAll, expect, test } from "bun:test";
import { performance } from "node:perf_hooks";
import { readlinkSync } from "node:fs";
import { join } from "node:path";
import { runFastTest } from "../../src/test-runner.ts";
import { inspectPendingKitUpdate } from "../../src/mutations.ts";
import { applyKitUpdate, planKitUpdate } from "../../src/kit-update.ts";
import { cleanupAllOwnedTmp } from "../../src/kitlib/tmp";
import { buildNPlusTwoCandidate, fixture, hostPlatform, input } from "./kit-update-fixture.ts";
afterAll(() => cleanupAllOwnedTmp());
// Full N to N+2 journey: two package builds plus fast, matcher, ratchet and the
// complete e2e-live suite in postcheck. Per-scenario timeouts bound hangs; the
// 900 s budget fits the suite on slow disks.
test("update derives the N+2 fast denominator from the manifest-bound case corpus", async () => fixture(async ctx => {
	const candidate = await buildNPlusTwoCandidate(ctx);
	const plan = await planKitUpdate(input(ctx));
	if (plan.status !== "UPDATE_AVAILABLE") throw new Error("fixture plan rejected");

	const baselineFastStarted = performance.now();
	const baseline = await runFastTest({ root: candidate.root, executablePath: candidate.executable, home: ctx.home });
	const baselineFastDurationMs = Math.round(performance.now() - baselineFastStarted);
	expect(baseline.status).toBe("PASS");
	expect(baseline.proofs.G2_payload).toMatchObject({ status: "PASS",
		expected_cases: candidate.targetCases, observed_cases: candidate.targetCases });
	expect(baseline.proofs.G3_quiet_prefix).toMatchObject({ status: "PASS",
		expected_cases: candidate.targetCases, expected_quiet_cases: candidate.targetQuiet,
		observed_cases: candidate.targetCases, observed_quiet_cases: candidate.targetQuiet });

	const updated = await applyKitUpdate(plan);
	const report = updated.postcheck.report;
	const stageTimings = [
		{ stage: "package-build", duration_ms: candidate.packageBuildDurationMs },
		{ stage: "baseline-fast", duration_ms: baselineFastDurationMs },
		{ stage: "fast", duration_ms: report?.fast_duration_ms ?? null },
		{ stage: "matcher", source: "harness-gate", duration_ms: report?.stages["harness-gate"].duration_ms ?? null },
		{ stage: "ratchet", source: "metamorphic-ratchet", duration_ms: report?.stages["metamorphic-ratchet"].duration_ms ?? null },
		{ stage: "cli-crosscheck", duration_ms: report?.stages["cli-crosscheck"].duration_ms ?? null },
		{ stage: "e2e-live", duration_ms: report?.stages["e2e-live"].duration_ms ?? null },
	];
	console.log("N+2 journey stage timings " + JSON.stringify(stageTimings));
	if (process.env.OMP_KIT_E2E_PROFILE === "1")
		console.log([report?.producer.stdout, report?.producer.stderr].join("\n").split("\n").filter(line => line.startsWith("E2E_PROFILE ")).join("\n"));
	const liveLines = [report?.producer.stdout, report?.producer.stderr]
		.flatMap(output => output?.split("\n") ?? []);
	const scenarioStart = liveLines.findIndex(line => line.includes("started scenario=settings-no-checkout-remedy"));
	const scenarioOutput = scenarioStart < 0 ? liveLines.filter(line => line.includes("settings-no-checkout-remedy"))
		: liveLines.slice(scenarioStart, Math.min(scenarioStart + 80, liveLines.findIndex((line, index) =>
			index > scenarioStart && line.includes("FAIL  settings-no-checkout-remedy")) + 1 || scenarioStart + 80));
	const scenarioText = scenarioOutput.join("\n");
	const readinessStageEnd = liveLines.findIndex(line => line.startsWith("GREEN readiness-selftest producer_rc="));
	const liveStageEnd = liveLines.findIndex((line, index) => index > readinessStageEnd &&
		line.startsWith("RED   e2e-live producer_rc="));
	const stageStdout = readinessStageEnd < 0 ? scenarioText : liveLines
		.slice(readinessStageEnd + 1, liveStageEnd < 0 ? liveLines.length : liveStageEnd).join("\n");
	const policyFailure = liveLines.filter(line => line.includes("POLICY_PLAN_FAILED") ||
		line.includes("cause_code") || line.includes("cause_message")).join("\n").slice(0, 400);
	const diagnosticArtifact = report?.producer.artifacts?.directory ?? null;
	expect(updated.status, JSON.stringify({ reason: updated.postcheck.reason, matcher: updated.postcheck.matcher,
		live: updated.postcheck.live, failures: report?.failures,
		fastFailures: report?.fast.failures, stages: report?.stages,
		e2eLiveOutput: { stdout: stageStdout.slice(0, 400), producerStderr: report?.producer.stderr.slice(0, 400) ?? "" },
		producerArtifacts: report?.producer.artifacts, artifactError: report?.producer.artifact_error,
		stageTimings,
		policyFailure, diagnosticArtifact })).toBe("UPDATED");
	expect(updated.postcheck.status).toBe("PASS");
	expect(updated.postcheck.report?.fast.proofs.G2_payload).toMatchObject({ status: "PASS",
		expected_cases: candidate.targetCases, observed_cases: candidate.targetCases });
	expect(updated.postcheck.report?.fast.proofs.G3_quiet_prefix).toMatchObject({ status: "PASS",
		expected_cases: candidate.targetCases, expected_quiet_cases: candidate.targetQuiet,
		observed_cases: candidate.targetCases, observed_quiet_cases: candidate.targetQuiet });
	expect(readlinkSync(join(ctx.prefix, "bin", "omp-kit"))).toBe("../releases/" + ctx.nextVersion + "/bin/omp-kit");
	expect(inspectPendingKitUpdate(ctx.stateRoot)).toBeNull();
}, { platform: hostPlatform, currentVersion: "0.2.2", nextVersion: "0.2.3" }), 900_000);
