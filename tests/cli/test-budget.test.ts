import { afterAll, expect, test } from "bun:test";
import { copyFileSync, mkdirSync, unlinkSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { run } from "../../src/kitlib/run.ts";
import { cleanupAllOwnedTmp, ownedTmp } from "../../src/kitlib/tmp.ts";

afterAll(cleanupAllOwnedTmp);
const script = resolve(import.meta.dir, "../../scripts/test-budget.ts");
const verdictStore = resolve(import.meta.dir, "../../scripts/full-suite-verdict-store.py");
function fixture() {
	const root = ownedTmp("test-budget").path;
	mkdirSync(join(root, ".github"));
	copyFileSync(resolve(import.meta.dir, "../../.github/test-budget.json"), join(root, ".github/test-budget.json"));
	writeFileSync(join(root, ".github/core-test-timings.json"), JSON.stringify({ version: 1, files: { "tests/a.test.ts": 10000, "tests/b.test.ts": 20000 } }));
	writeFileSync(join(root, ".github/script-test-timings.json"), JSON.stringify({ version: 1, files: { "tests/c.test.sh": 30000 } }));
	return root;
}
function timingEnv(root: string): NodeJS.ProcessEnv {
	return { ...process.env, FULL_SUITE_VERDICT_CACHE_DIR: join(root, "shared-verdict-store") };
}
async function invoke(root: string, ...args: string[]) {
	const timingArgs = args.includes("--derive") && !args.includes("--timings-dir") ? ["--timings-dir", ".github"] : [];
	const result = await run([process.execPath, script, "--repo", root, ...timingArgs, ...args], {
		deadline_s: 15, env: timingEnv(root),
	});
	return { rc: result.rc, stdout: new TextDecoder().decode(result.stdout), stderr: new TextDecoder().decode(result.stderr) };
}

test("derives actual table work and identifies requirements without phantom queueing measurements", async () => {
	const result = await invoke(fixture(), "--derive", "--check", "--workers", "3", "--json");
	expect(result.rc).toBe(0);
	const data = JSON.parse(result.stdout);
	expect(data).toMatchObject({ W_s: 60, p_max_s: 30, p_max_path: "tests/c.test.sh", m: 3, full_cycle_s: 900, push_p95_s: 600, per_file_cap_s: 225, queueing: { status: "NOT_MEASURED", guarantee: "NONE" } });
	expect(data.per_file_cap_status).toBe("INITIAL_HEURISTIC_NOT_DISTRIBUTION_DERIVED");
});

test("recorded excessive p_max names the file and both seconds values", async () => {
	const root = fixture();
	writeFileSync(join(root, ".github/script-test-timings.json"), JSON.stringify({ version: 1, files: { "slow.sh": 300000 } }));
	const result = await invoke(root, "--derive", "--check");
	expect(result.rc).toBe(0);
	expect(result.stdout).toContain("OVER_BUDGET slow.sh 300 225");
});

for (const elapsed of [0, 10000, 225000, 225001, 300000]) {
	test(`measured enforcement boundary ${elapsed}ms`, async () => {
		const root = fixture();
		writeFileSync(join(root, "rows.json"), JSON.stringify([{ path: "actual.test.ts", elapsed_ms: elapsed }]));
		const result = await invoke(root, "--enforce", "rows.json", "--json");
		expect(result.rc).toBe(0);
		const data = JSON.parse(result.stdout);
		expect(data.violations).toEqual(elapsed > 225000 ? [{ code: "OVER_BUDGET", path: "actual.test.ts", elapsed_s: elapsed / 1000, cap_s: 225 }] : []);
	});
}

for (const value of [null, "10", -1, {}, [], { version: 2, files: { "test.ts": 10 } }, { "flat.test.ts": 10 }, { version: 1, files: {} }, { version: 1, files: { "missing.test.ts": null } }, { version: 1, files: { "missing.test.ts": "100" } }, { version: 1, files: { "missing.test.ts": -1 } }]) {
	test(`malformed timing map fails closed: ${JSON.stringify(value)}`, async () => {
		const root = fixture();
		writeFileSync(join(root, ".github/core-test-timings.json"), JSON.stringify(value));
		expect((await invoke(root, "--derive", "--check")).rc).toBe(1);
	});
}

for (const rows of [[], [{}], [{ path: "test.ts" }], [{ path: "test.ts", elapsed_ms: "300000" }], [{ path: "", elapsed_ms: 10 }]]) {
	test(`malformed measured rows fail closed: ${JSON.stringify(rows)}`, async () => {
		const root = fixture();
		writeFileSync(join(root, "rows.json"), JSON.stringify(rows));
		expect((await invoke(root, "--enforce", "rows.json")).rc).toBe(1);
	});
}

test("unknown flags and missing input fail closed", async () => {
	const root = fixture();
	for (const args of [["--unknown"], ["--enforce", "absent.json"], ["--workers"], ["--derive", "--workers", "0"], ["--derive", "--workers", "NaN"]]) expect((await invoke(root, ...args)).rc).toBe(1);
	writeFileSync(join(root, ".github/core-test-timings.json"), '{"version":1,"files":{"bad":1e999}}');
	expect((await invoke(root, "--derive")).rc).toBe(1);
	writeFileSync(join(root, ".github/core-test-timings.json"), "{");
	expect((await invoke(root, "--derive")).rc).toBe(1);
});

test("actual arrival/service samples yield variability and utilisation, not a queueing guarantee", async () => {
	const root = fixture();
	writeFileSync(join(root, "history.json"), JSON.stringify([{ arrival_ms: 0, service_ms: 1000 }, { arrival_ms: 10000, service_ms: 2000 }, { arrival_ms: 30000, service_ms: 3000 }]));
	const result = await invoke(root, "--derive", "--workers", "1", "--verdict-history", "history.json", "--json");
	expect(result.rc).toBe(0);
	const data = JSON.parse(result.stdout).queueing;
	expect(data.status).toBe("MEASURED_DIAGNOSTICS");
	expect(data.utilisation).toBeCloseTo(2 / 15);
	expect(data.arrival_cv2).toBeCloseTo(1 / 9);
	expect(data.service_cv2).toBeCloseTo(1 / 6);
	expect(data.kingman_single_server_wait_s).toBeGreaterThan(0);
	expect(data.guarantee).toBe("NONE");
});

test("supplied malformed history is never silently treated as unmeasured", async () => {
	const root = fixture();
	writeFileSync(join(root, "history.json"), JSON.stringify([{ arrival_ms: 0 }]));
	expect((await invoke(root, "--derive", "--verdict-history", "history.json")).rc).toBe(1);
});

test("missing timing table and malformed requirement numbers fail closed", async () => {
	const root = fixture();
	unlinkSync(join(root, ".github/script-test-timings.json"));
	expect((await invoke(root, "--derive", "--check")).rc).toBe(1);
	writeFileSync(join(root, ".github/test-budget.json"), JSON.stringify({ version: 1, requirements: { push_p95_s: "600", full_cycle_s: 900 }, initial_heuristic: { per_file_cap_s: 225 } }));
	writeFileSync(join(root, "rows.json"), JSON.stringify([{ path: "healthy.ts", elapsed_ms: 10000 }]));
	expect((await invoke(root, "--enforce", "rows.json")).rc).toBe(1);
});

test("heuristic cap rejects enforce policy and reports the same measured overage in report mode", async () => {
	const root = fixture();
	const policyPath = join(root, ".github/test-budget.json");
	const policy = JSON.parse(await Bun.file(policyPath).text());
	const rowsPath = join(root, "rows.json");
	writeFileSync(rowsPath, JSON.stringify([{ path: "original-overage.test.ts", elapsed_ms: 300000 }]));
	policy.initial_heuristic.mode = "enforce";
	writeFileSync(policyPath, JSON.stringify(policy));
	const enforced = await invoke(root, "--enforce", "rows.json", "--json");
	expect(enforced.rc).toBe(1);
	expect(JSON.parse(enforced.stdout)).toMatchObject({ status: "ERROR" });
	expect(JSON.parse(enforced.stdout).error).toContain("heuristic mode");

	policy.initial_heuristic.mode = "report";
	writeFileSync(policyPath, JSON.stringify(policy));
	const reported = await invoke(root, "--enforce", "rows.json", "--json");
	expect(reported.rc).toBe(0);
	expect(JSON.parse(reported.stdout)).toMatchObject({
		status: "OVER_BUDGET",
		per_file_cap_mode: "report",
		violations: [{ code: "OVER_BUDGET", path: "original-overage.test.ts", elapsed_s: 300, cap_s: 225 }],
	});
});

test("stdin enforcement uses actual rows and reports the planted 300 second file without refusing", async () => {
	const root = fixture();
	const result = await run([process.execPath, script, "--repo", root, "--enforce", "-"], {
		deadline_s: 15,
		stdin: JSON.stringify([{ path: "planted.test.ts", elapsed_ms: 300000 }]),
	});
	expect(result.rc).toBe(0);
	expect(new TextDecoder().decode(result.stdout)).toContain("OVER_BUDGET planted.test.ts 300 225");
});

for (const count of [18, 20]) {
	test(`necessary makespan lower bound for ${count} files at 200 seconds on four workers`, async () => {
		const root = fixture();
		const files = Object.fromEntries(Array.from({ length: count - 1 }, (_, index) => [`tests/file-${index}.ts`, 200000]));
		writeFileSync(join(root, ".github/core-test-timings.json"), JSON.stringify({ version: 1, files }));
		writeFileSync(join(root, ".github/script-test-timings.json"), JSON.stringify({ version: 1, files: { "tests/shell.sh": 200000 } }));
		const result = await invoke(root, "--derive", "--check", "--workers", "4", "--json");
		expect(result.rc).toBe(count === 20 ? 1 : 0);
		const data = JSON.parse(result.stdout);
		expect(data.makespan_lower_bound_s).toBe(count * 200 / 4);
		expect(data.status).toBe(count === 20 ? "AGGREGATE_OVER_BUDGET" : "OK");
		expect(data.violations).toEqual([]);
		expect(data.makespan_bound_note).toContain("not a scheduling or p95 guarantee");
	});
}

test("explicit timing directory is authoritative and missing maps are never fabricated", async () => {
	const root = fixture();
	const timings = join(root, "measured");
	mkdirSync(timings);
	writeFileSync(join(timings, "core-test-timings.json"), JSON.stringify({ version: 1, files: { "actual.ts": 40000 } }));
	writeFileSync(join(timings, "script-test-timings.json"), JSON.stringify({ version: 1, files: { "actual.sh": 50000 } }));
	const result = await invoke(root, "--derive", "--check", "--timings-dir", timings, "--json");
	expect(result.rc).toBe(0);
	expect(JSON.parse(result.stdout)).toMatchObject({ W_s: 90, timings_dir: timings });
	unlinkSync(join(timings, "script-test-timings.json"));
	expect((await invoke(root, "--derive", "--check", "--timings-dir", timings)).rc).toBe(1);
});

test("default prefers complete shared-store timing maps, falls back only when a map is absent", async () => {
	const root = fixture();
	expect((await run(["git", "init", "--quiet", root], { deadline_s: 10 })).rc).toBe(0);
	const env = timingEnv(root);
	const store = await run(["python3", verdictStore, "timings", "--repo", root], { deadline_s: 15, env });
	expect(store.rc, new TextDecoder().decode(store.stderr)).toBe(0);
	const timings = new TextDecoder().decode(store.stdout).trim();
	mkdirSync(timings, { recursive: true });
	writeFileSync(join(timings, "core-test-timings.json"), JSON.stringify({ version: 1, files: { "cached.ts": 40000 } }));
	writeFileSync(join(timings, "script-test-timings.json"), JSON.stringify({ version: 1, files: { "cached.sh": 50000 } }));
	const command = [process.execPath, script, "--repo", root, "--derive", "--check", "--json"];
	const cached = await run(command, { deadline_s: 15, env });
	expect(cached.rc).toBe(0);
	expect(JSON.parse(new TextDecoder().decode(cached.stdout))).toMatchObject({ W_s: 90, timings_dir: timings });
	writeFileSync(join(timings, "script-test-timings.json"), "{");
	expect((await run(command, { deadline_s: 15, env })).rc).toBe(1);
	unlinkSync(join(timings, "script-test-timings.json"));
	const fallback = await run(command, { deadline_s: 15, env });
	expect(fallback.rc).toBe(0);
	expect(JSON.parse(new TextDecoder().decode(fallback.stdout))).toMatchObject({ W_s: 60, timings_dir: join(root, ".github") });
});

function measured(root: string, file: string, elapsed: number, changed = file, telemetry: Record<string, unknown> = {}) {
	const { gate_workers = telemetry.workers ?? 1, default_workers = 1, ...sample } = telemetry;
	writeFileSync(join(root, "changed.txt"), changed + "\n");
	writeFileSync(join(root, "rows.json"), JSON.stringify([{
		path: file, elapsed_ms: elapsed, complete: true, rc: 0,
		cpu_user_ms: 1000, cpu_system_ms: 1000, ncpu: 32, workers: 1, load_1m: 4, load_1m_end: 4,
		...sample,
	}]));
	return invoke(root, "--enforce", "rows.json", "--changed-files", "changed.txt", "--workers", String(gate_workers), "--default-workers", String(default_workers), "--annotate-records", "--json");
}
function budget(cap_s = 90, grandfathered: Record<string, unknown> = {}, references: Record<string, unknown> = {}) {
	return { version: 2, cap_s, grandfathered, references, envelope: { max_load_per_cpu: 0.5, worker_rule: "gate-default-widths" } };
}
function reference(wall_s = 90, cpu_s = 45) {
	return { wall_s, cpu_s, evidence: { tree: "a".repeat(40), verdict_sha256: "b".repeat(64), judge_sha256: "c".repeat(64), output_sha256: "d".repeat(64) } };
}

test("FILEBUDGET1 refuses a planted slow changed file, accepts the boundary and leaves unchanged slow files alone", async () => {
	const root = fixture();
	for (const elapsed of [1000, 90000, 90001]) {
		const result = await measured(root, "new.test.ts", elapsed);
		expect(result.rc).toBe(elapsed > 90000 ? 1 : 0);
		const data = JSON.parse(result.stdout);
		expect(data.file_budget.cap_s).toBe(90);
		if (elapsed > 90000) {
			expect(data.file_budget.violations[0]).toMatchObject({ path: "new.test.ts", elapsed_s: 90.001, cap_s: 90 });
			expect(data.file_budget.violations[0].remedy).toContain("private-index-land-2/-3 and kit-update-*");
		} else expect(data.file_budget.violations).toEqual([]);
	}
	expect((await measured(root, "existing.test.ts", 300000, "docs/notes.md")).rc).toBe(0);
});

test("FILEBUDGET1 grandfather passes at its measured ceiling and fails when it grows", async () => {
	const root = fixture();
	const policyPath = join(root, ".github/test-budget.json");
	const policy = JSON.parse(await Bun.file(policyPath).text());
	policy.changed_file_budget.grandfathered = { "legacy.test.ts": { measured_s: 131, evidence: "owned fixture observation" } };
	writeFileSync(policyPath, JSON.stringify(policy));
	expect((await measured(root, "legacy.test.ts", 131000)).rc).toBe(0);
	const grown = await measured(root, "legacy.test.ts", 131001);
	expect(grown.rc).toBe(1);
	expect(JSON.parse(grown.stdout).file_budget.violations[0]).toMatchObject({ path: "legacy.test.ts", elapsed_s: 131.001, cap_s: 131 });
});

test("FILEBUDGET1 policy ratchet permits removals/reductions, refuses growth/additions/deletion and malformed evidence", async () => {
	const root = fixture();
	const policyPath = join(root, ".github/test-budget.json");
	const baseline = JSON.parse(await Bun.file(policyPath).text());
	baseline.changed_file_budget.grandfathered = { "legacy.test.ts": { measured_s: 131, evidence: "owned baseline" } };
	writeFileSync(join(root, "base-policy.json"), JSON.stringify(baseline));
	const check = async (budget: unknown) => {
		writeFileSync(policyPath, JSON.stringify({ ...baseline, changed_file_budget: budget }));
		return invoke(root, "--check-file-policy", "--base-policy", "base-policy.json", "--json");
	};
	expect((await check(budget())).rc).toBe(0);
	expect((await check(budget(80, { "legacy.test.ts": { measured_s: 130, evidence: "reduction" } }))).rc).toBe(0);
	for (const next of [
		budget(91),
		budget(90, { "legacy.test.ts": { measured_s: 132, evidence: "growth" } }),
		budget(90, { "new.test.ts": { measured_s: 131, evidence: "new exemption" } }),
		budget(90, { "legacy.test.ts": { measured_s: 131, evidence: "" } }),
		undefined,
	]) expect((await check(next)).rc).toBe(1);
	// Removing an allowance is irreversible in the next baseline.
	writeFileSync(join(root, "base-policy.json"), JSON.stringify({ ...baseline, changed_file_budget: budget() }));
	expect((await check(baseline.changed_file_budget)).rc).toBe(1);
});

test("FILEBUDGET1 does not accept failed or incomplete timing rows", async () => {
	const root = fixture();
	writeFileSync(join(root, "changed.txt"), "new.test.ts\n");
	for (const row of [{ complete: false, rc: 0 }, { complete: true, rc: 1 }]) {
		writeFileSync(join(root, "rows.json"), JSON.stringify([{ path: "new.test.ts", elapsed_ms: 1, ...row }]));
		expect((await invoke(root, "--enforce", "rows.json", "--changed-files", "changed.txt")).rc).toBe(1);
	}
});

test("FILEBUDGET1 v2 same file outside the envelope is NOT_CALIBRATED, never a wall refusal or PASS", async () => {
	const root = fixture();
	const qualified = await measured(root, "same.test.ts", 90001);
	expect(qualified.rc).toBe(1);
	expect(JSON.parse(qualified.stdout).file_budget.violations[0].clock).toBe("qualified-wall");
	for (const telemetry of [
		{ load_1m: 16.001 }, { load_1m_end: 48 }, { workers: 5 }, { ncpu: undefined }, { load_1m_end: undefined },
	]) {
		const busy = await measured(root, "same.test.ts", 90001, "same.test.ts", telemetry);
		expect(busy.rc).toBe(75);
		expect(JSON.parse(busy.stdout).status).toBe("NOT_CALIBRATED");
		expect(JSON.parse(busy.stdout).file_budget.violations).toEqual([]);
		expect(busy.stderr).toContain("busy machine");
		expect(busy.stdout + busy.stderr).not.toContain("Split this file");
	}
	// A genuinely new file has no CPU substitute for a qualifying observation.
	expect((await measured(root, "new.test.ts", 1000, "new.test.ts", { load_1m: 48 })).rc).toBe(75);
});

test("FILEBUDGET1 v2 frozen CPU-equivalent overage refuses at every load, without normalizing wall", async () => {
	const root = fixture();
	const policyPath = join(root, ".github/test-budget.json");
	const policy = JSON.parse(await Bun.file(policyPath).text());
	policy.changed_file_budget.references["same.test.ts"] = reference();
	writeFileSync(policyPath, JSON.stringify(policy));
	for (const load of [4, 48]) {
		const result = await measured(root, "same.test.ts", 1000, "same.test.ts", { cpu_user_ms: 46000, cpu_system_ms: 0, load_1m: load, load_1m_end: load });
		expect(result.rc).toBe(1);
		expect(JSON.parse(result.stdout).file_budget.violations[0]).toMatchObject({ clock: "cpu-equivalent", equivalent_wall_s: 92, cap_s: 90 });
	}
	const busy = await measured(root, "same.test.ts", 139600, "same.test.ts", { cpu_user_ms: 44000, cpu_system_ms: 0, load_1m: 48 });
	expect(busy.rc).toBe(75); // Equivalent 88 s does not turn an unqualified wall observation into PASS.
});

test("FILEBUDGET1 v2 original grandfather references preserve their exact evidence-bound CPU ceilings", async () => {
	const root = fixture();
	const policy = JSON.parse(await Bun.file(join(root, ".github/test-budget.json")).text());
	for (const [name, value] of Object.entries(policy.changed_file_budget.references)) {
		const pair = value as { cpu_s: number; wall_s: number };
		const at = await measured(root, name, pair.wall_s * 1000, name, { cpu_user_ms: pair.cpu_s * 1000, cpu_system_ms: 0 });
		expect(at.rc, at.stdout).toBe(0);
		const grown = await measured(root, name, 1000, name, { cpu_user_ms: (pair.cpu_s + 0.001) * 1000, cpu_system_ms: 0, load_1m: 48 });
		expect(grown.rc).toBe(1);
		expect(JSON.parse(grown.stdout).file_budget.violations[0].clock).toBe("cpu-equivalent");
	}
});

test("FILEBUDGET1 v2 ratchet freezes reference pairs/evidence and only tightens the envelope", async () => {
	const root = fixture();
	const policyPath = join(root, ".github/test-budget.json");
	const baseline = JSON.parse(await Bun.file(policyPath).text());
	baseline.changed_file_budget = budget(90, {}, { "same.test.ts": reference() });
	writeFileSync(join(root, "same.test.ts"), "// owned fixture source\n");
	writeFileSync(join(root, "base-policy.json"), JSON.stringify(baseline));
	const check = async (next: unknown) => {
		writeFileSync(policyPath, JSON.stringify({ ...baseline, changed_file_budget: next }));
		return invoke(root, "--check-file-policy", "--base-policy", "base-policy.json", "--json");
	};
	expect((await check(baseline.changed_file_budget)).rc).toBe(0);
	for (const pair of [reference(91, 45), reference(90, 46), reference(89, 45), { ...reference(), evidence: { ...reference().evidence, tree: "e".repeat(40) } }]) {
		const result = await check(budget(90, {}, { "same.test.ts": pair }));
		expect(result.rc).toBe(1);
		expect(JSON.parse(result.stdout).error).toContain("reference pair and evidence are frozen");
	}
	expect((await check(budget())).rc).toBe(1); // Removing the reference cannot bypass the CPU check.
	const tighter = budget(90, {}, { "same.test.ts": reference() });
	tighter.envelope.max_load_per_cpu = 0.25;
	expect((await check(tighter)).rc).toBe(0);
	writeFileSync(join(root, "base-policy.json"), JSON.stringify({ ...baseline, changed_file_budget: tighter }));
	expect((await check(baseline.changed_file_budget)).rc).toBe(1);
});

test("FILEBUDGET1 v2 the default combined 4+4 workers are qualified; non-default widths are not", async () => {
	const root = fixture();
	const defaultWidths = await measured(root, "same.test.ts", 90001, "same.test.ts", { workers: 4, gate_workers: 8, default_workers: 8 });
	expect(defaultWidths.rc).toBe(1);
	expect(JSON.parse(defaultWidths.stdout).file_budget.violations[0].clock).toBe("qualified-wall");
	const overridden = await measured(root, "same.test.ts", 90001, "same.test.ts", { workers: 2, gate_workers: 4, default_workers: 8 });
	expect(overridden.rc).toBe(75);
	const recorded = JSON.parse(await Bun.file(join(root, "rows.json")).text());
	expect(recorded[0].rc).toBe(0); // Native-test outcome remains successful.
	expect(recorded[0].file_budget.status).toBe("NOT_CALIBRATED");
	expect(recorded[0].file_budget.default_workers).toBe(8);
});
