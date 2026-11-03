import { afterAll, expect, test } from "bun:test";
import { readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import process from "node:process";
import { cleanupAllOwnedTmp } from "../../src/kitlib/tmp";
import { fixtureDeadlineS } from "./fixture-process.ts";
import { fixture, configure, invoke, seedJob, forgeHealthyStatfs } from "./heavy-fixtures.ts";

// Separate processes own these platform-clock deadlines; parent fake timers cannot drive them.
// They run through the real CLI entry (`omp-kit heavy --max-runtime`).
// At measured load 41, CLI startup made the old 10/15/20 s harness watchdogs
// fire before the product cases completed. Scale only those fixture watchdogs;
// max_wait_s, --max-runtime, grace periods and their result assertions stay fixed.
async function invokeRuntime(root: string, maxRuntime?: string, label = "runtime", childCode = "setTimeout(() => process.exit(7), 30000)") {
	return invoke(root, ["heavy", "--label", label, ...(maxRuntime === undefined ? [] : ["--max-runtime", maxRuntime]),
		"--", process.execPath, "-e", childCode]);
}

test.concurrent("HEAVYRUNTIME planted: admitted child outlives admission wait and preserves exit 7", async () => {
	const root = fixture();
	configure(root, { slots: 1, max_wait_s: 2 });
	const result = await invokeRuntime(root, "30", "planted", "setTimeout(() => process.exit(7), 4000)");
	expect({ code: result.code, stderr: result.stderr }).toEqual({ code: 7, stderr: "" });
}, fixtureDeadlineS(15) * 1000);

test.concurrent("HEAVYRUNTIME control: never admitted still defers at queue timeout", async () => {
	const root = fixture();
	configure(root, { slots: 1, max_wait_s: 1 });
	const jobs = await seedJob(root, { id: "held" });
	const result = await invoke(root, ["heavy", "--", process.execPath, "-e", "process.exit(7)"]);
	expect(result.code).toBe(75);
	expect(result.stderr).toContain("RESOURCE_DEFERRED");
	expect(result.stderr).toContain("queue timeout");
	expect(readdirSync(jobs)).toEqual(["held.json"]);
}, fixtureDeadlineS(10) * 1000);

test.concurrent("HEAVYRUNTIME cuts runtime at flag budget and removes the job", async () => {
	const root = fixture();
	configure(root, { max_wait_s: 5, runtime_budget_s: { runtime: 3 } });
	const result = await invokeRuntime(root, "2");
	expect(result.code).toBe(124);
	expect(result.stderr).toContain("RUNTIME_BUDGET_EXCEEDED: child ran ");
	expect(result.stderr).toContain("> --max-runtime 2s (label runtime)");
	expect(readdirSync(join(root, "state", "omp-kit", "load", "jobs"))).toEqual([]);
}, fixtureDeadlineS(15) * 1000);

test.concurrent("HEAVYRUNTIME declared label table stops child; undeclared label has no global default", async () => {
	const root = fixture();
	// The removed global fallback is scaled to one second; the child crosses it.
	configure(root, { max_wait_s: 5, default_runtime_s: 1, runtime_budget_s: { runtime: 1 } });
	const labeled = await invokeRuntime(root);
	expect(labeled.code).toBe(124);
	expect(labeled.stderr).toContain("1s (label runtime)");
	expect(labeled.stderr).toContain("source=label table load.json runtime_budget_s.runtime");
	const fallback = await invokeRuntime(root, undefined, "other", "setTimeout(() => process.exit(7), 2200)");
	expect({ code: fallback.code, stderr: fallback.stderr }).toEqual({ code: 7, stderr: "" });
}, fixtureDeadlineS(15) * 1000);

test.concurrent("HEAVYRUNTIME explicit flag overrides the label table", async () => {
	const root = fixture();
	configure(root, { max_wait_s: 5, runtime_budget_s: { runtime: 1 } });
	const result = await invokeRuntime(root, "4", "runtime", "setTimeout(() => process.exit(7), 2200)");
	expect({ code: result.code, stderr: result.stderr }).toEqual({ code: 7, stderr: "" });
}, fixtureDeadlineS(10) * 1000);

test.concurrent("HEAVYRUNTIME shipped label table and global-default mutant use the real CLI", async () => {
	const root = fixture();
	// This is a runtime-budget probe, not an sbh-adapter timing test. Use the
	// already-forged healthy statfs reading so an observer refusal cannot hide
	// the label-table/control/mutant behavior (release run returned 69, not 124).
	configure(root, { max_wait_s: 5, disk_observer: "statfs" });
	// The child uses a real process clock; parent fake timers cannot drive it.
	// Scale only this shipped row to 1s, then restore the old global fallback in memory.
	const preload = join(root, "runtime-probe.ts");
	const probe = (mutant: boolean) => {
		writeFileSync(preload, `
			import ${JSON.stringify(forgeHealthyStatfs)};
			import { plugin } from "bun";
			import { readFileSync } from "node:fs";
			plugin({ name: "runtime-budget-probe", setup(build) {
				build.onLoad({ filter: /heavy[.]ts$/ }, ({ path }) => {
					let contents = readFileSync(path, "utf8");
					const original = "const runtimeSeconds = flagRuntime ?? configured ?? declared?.seconds;";
					const replacement = ${JSON.stringify(mutant
						? "const runtimeSeconds = flagRuntime ?? configured ?? (job.label === \"cli-tests\" && declared ? 1 : declared?.seconds) ?? 1;"
						: "const runtimeSeconds = flagRuntime ?? configured ?? (job.label === \"cli-tests\" && declared ? 1 : declared?.seconds);")};
					if (!contents.includes(original)) throw new Error("runtime probe target missing");
					contents = contents.replace(original, replacement);
					return { contents, loader: "ts" };
				});
			}});
		`);
	};
	const args = (label: string) => ["heavy", "--label", label, "--", process.execPath, "-e",
		'console.log("CHILD_START"); setTimeout(() => { console.log("CHILD_DONE"); process.exit(7) }, 2200)'];
	probe(false);
	const declared = await invoke(root, args("cli-tests"), {}, { preload });
	expect(declared.code, declared.stderr).toBe(124);
	expect(declared.stdout).toContain("CHILD_START");
	expect(declared.stdout).not.toContain("CHILD_DONE");
	expect(declared.stderr).toContain("1s (label cli-tests)");
	expect(declared.stderr).toContain("source=label table config/heavy-labels.json");
	const control = await invoke(root, args("undeclared-runtime-probe"), {}, { preload });
	expect(control.code).toBe(7);
	expect(control.stdout).toContain("CHILD_DONE");
	expect(control.stderr).toBe("");
	probe(true);
	const mutant = await invoke(root, args("undeclared-runtime-probe"), {}, { preload });
	expect(mutant.stdout).toContain("CHILD_START");
	expect(mutant.stdout).not.toContain("CHILD_DONE");
	expect(mutant.code).toBe(124);
	expect(mutant.stderr).toContain("source=none");
}, fixtureDeadlineS(15) * 1000);

test.concurrent("HEAVYRUNTIME rejects nonpositive and noninteger flag budgets", async () => {
	const root = fixture();
	for (const value of ["0", "abc", "1.5", "-1"]) {
		const result = await invokeRuntime(root, value);
		expect(result.code).toBe(2);
		expect(result.stderr).toContain("--max-runtime");
	}
}, fixtureDeadlineS(15) * 1000);

test.concurrent("HEAVYRUNTIME escalates a SIGTERM-resistant child after the grace period", async () => {
	const root = fixture();
	configure(root, { max_wait_s: 5 });
	const result = await invokeRuntime(root, "1", "resistant",
		'process.on("SIGTERM", () => process.stdout.write("term-received")); setTimeout(() => process.exit(7), 30000)');
	expect(result.code).toBe(124);
	expect(result.stdout).toBe("term-received");
	expect(result.stderr).toContain("> --max-runtime 1s (label resistant)");
	expect(readdirSync(join(root, "state", "omp-kit", "load", "jobs"))).toEqual([]);
}, fixtureDeadlineS(20) * 1000);

test.concurrent("HEAVYRUNTIME long positive budgets do not overflow native timers", async () => {
	const root = fixture();
	const result = await invokeRuntime(root, "2147484", "long", "setTimeout(() => process.exit(7), 100)");
	expect(result.code).toBe(7);
	expect(result.stderr).toBe("");
}, fixtureDeadlineS(10) * 1000);

afterAll(() => cleanupAllOwnedTmp());
