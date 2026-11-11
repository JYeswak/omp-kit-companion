import { expect, test } from "bun:test";
import { chmodSync, mkdirSync, writeFileSync } from "node:fs";
import { delimiter, join } from "node:path";
import { resolveOmpIdentity } from "../../src/paths.ts";
import { run as runBounded } from "../../src/kitlib/run.ts";
import { caseCwd, nativeCacheEnv, output, sourceRevision, installCandidate } from "./package-release-fixture.ts";
import { releaseProcess } from "./release-process.ts";
import { fixtureDeadlineS } from "./fixture-process.ts";
test("installed integrations and invariant gate run from the package", async () => {
	const { home, installedBinary } = await installCandidate("integrations-home");
	const agentDir = join(home, ".omp", "profiles", "packaging-probe", "agent");
	mkdirSync(agentDir, { recursive: true });
	writeFileSync(join(agentDir, "config.yml"), "extensions:\n");
	const stubBin = join(output, "omp-stub");
	mkdirSync(stubBin, { recursive: true });
	const stubOmp = join(stubBin, "omp");
	writeFileSync(stubOmp, "#!/bin/sh\nprintf 'omp stub\\n'\n");
	chmodSync(stubOmp, 0o755);
	const args = [installedBinary, "test", "--integrations", "--profile", "packaging-probe", "--json"];
	const env = { ...process.env, HOME: home, TMPDIR: output, TMP: output, TEMP: output, PATH: stubBin,
		OMP: "", OMP_BIN: "", OMP_PATH: "", OMP_SRC: "" };
	const installed = await releaseProcess(args, { cwd: home, env, stdout: "pipe", stderr: "pipe", deadline_s: fixtureDeadlineS(120) });
	const stdout = installed.stdout.toString();
	expect(installed.exitCode, `${stdout}\n${installed.stderr.toString()}`).toBe(0);
	const report = JSON.parse(stdout) as {
		data?: {
			overall?: string;
			integrations?: { matrix?: Array<{ profile: string; integration: string; verdict: string }> };
		};
	};
	const matrix = report.data?.integrations?.matrix ?? [];
	expect(report.data?.overall).toBe("OK");
	expect(matrix.some(row => row.profile === "packaging-probe" && row.integration === "dcg" && row.verdict === "ABSENT")).toBe(true);
	expect(matrix.every(row => row.profile === "packaging-probe" && row.verdict === "ABSENT")).toBe(true);
	const ompIdentity = resolveOmpIdentity(process.env);
	const ladderPath = [join(home, ".local", "opt", "omp-kit", "bin"), process.env.PATH ?? ""].join(delimiter);
	const packageEnv = { ...process.env, ...nativeCacheEnv, HOME: home, TMPDIR: output, TMP: output, TEMP: output,
		XDG_STATE_HOME: join(home, "xdg-state"), XDG_CACHE_HOME: join(home, "xdg-cache"),
		OMP_KIT_CASE_CWD: caseCwd, OMP_KIT_TEST_WORK_ROOT: output, PATH: ladderPath };
	const appliedEnv: Record<string, string> = {};
	for (const [name, value] of Object.entries(packageEnv)) {
		if (value !== undefined) appliedEnv[name] = value;
	}
	const appliedRules = await runBounded([installedBinary, "apply", "rules", "--apply", "--yes", "--json"], {
		cwd: home, env: appliedEnv, deadline_s: fixtureDeadlineS(120),
	});
	const applyStdout = new TextDecoder().decode(appliedRules.stdout);
	const applyStderr = new TextDecoder().decode(appliedRules.stderr);
	expect(appliedRules.rc, `${applyStdout}\n${applyStderr}`).toBe(0);
	const full = await releaseProcess([installedBinary, "test", "--full", "--json"], { cwd: home,
		env: { ...packageEnv, OMP: ompIdentity.launcher, OMP_BIN: ompIdentity.launcher,
			OMP_PATH: ompIdentity.launcher, OMP_SRC: ompIdentity.source },
		stdout: "pipe", stderr: "pipe", deadline_s: fixtureDeadlineS(900) });
	const fullOutput = `${full.stdout.toString()}\n${full.stderr.toString()}`;
	expect(full.exitCode, fullOutput).toBe(0);
	const fullReport = JSON.parse(full.stdout.toString()).data.test;
	expect(fullReport.producer.stdout).toContain("GREEN flywheel-invariants");
	expect(fullReport.stages.manifest.status).toBe("PASS");
	expect(fullReport.producer.result_ref).toMatchObject({
		source_revision: sourceRevision, producer_exit: 0, runner_exit: 0,
		execution_capture_complete: true, missing_fields: [], failing_names: [],
		counts: { protocol: "OMP_KIT_CASES", unit: "TEST_CASE_EXECUTION", fail: 0 },
		retention: { status: "UNRETAINED", durable: false },
	});
// The full ladder runs the complete e2e-live suite (~200 s locally); same budget as kit-update's N+2 journey.
}, fixtureDeadlineS(900) * 1_000);
