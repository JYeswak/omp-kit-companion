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
