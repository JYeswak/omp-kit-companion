import { afterAll, expect, test } from "bun:test";
import { chmodSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { cleanupAllOwnedTmp } from "../../src/kitlib/tmp";
import { run } from "../../src/kitlib/run";
import { fixtureDeadlineS } from "./fixture-process.ts";
import { REPO_ROOT, liveTree, workRoot } from "./e2e-live-tree.ts";

// RELFLAKE1 (ompkit-1ra0d.109): a live scenario whose omp exits 1 right after a TTSR abort with too few model requests is
// rerun once. Its own file keeps each suite under the focused gate's per-file wall budget; the five runs go in parallel.

test("RELFLAKE1: an omp exit 1 after a TTSR abort with too few requests is rerun once and counted; any other failure is the verdict", async () => {
	// A stub OMP counts its runs and, for the first `fails` runs, sends one tool-bearing request to the scenario's mock model,
	// prints the TTSR line when `ttsr` is set and exits `exitCode` (the hosted-ladder and updater-postcheck signature is exit 1
	// after the TTSR line); a later run sends two requests and writes the file the near-miss scenario expects. Control: a stub that
	// fails once passes on the rerun and the line FLAKY_OMP_TTSR_ABORT stays in the output. Planted: a stub that fails every run
	// still fails, after exactly one rerun; one without the TTSR line, one that exits 2, and the same stub with the rerun turned
	// off, are never rerun.
	const fixture = workRoot("e2e-ttsr-retry");
	try {
		const tree = await liveTree(fixture.path);
		const attempt = async (label: string, fails: number, ttsr: boolean, extra: Record<string, string> = {}, exitCode = 1, requests = 1) => {
			const count = join(fixture.path, `count-${label}`);
			const stub = join(fixture.path, `stub-${label}.sh`);
			writeFileSync(stub, [
				"#!/bin/sh",
				'if [ "$1" = "--version" ]; then echo "stub-omp 0.0.0"; exit 0; fi',
				`count=${JSON.stringify(count)}`,
				'n=$(cat "$count" 2>/dev/null || echo 0); n=$((n+1)); echo "$n" > "$count"',
				"port=$(sed -n 's#.*baseUrl: http://127.0.0.1:\\([0-9]*\\)/v1#\\1#p' \"$HOME/.omp/agent/models.yml\")",
				'ask() { curl -sS -o /dev/null -X POST -H "content-type: application/json" "http://127.0.0.1:$port/v1/chat/completions" -d \'{"tools":[{"type":"function","function":{"name":"write"}}],"messages":[{"role":"user","content":"go"}]}\'; }',
				`if [ "$n" -le ${fails} ]; then ${Array.from({ length: requests }, () => "ask;").join(" ")} ${ttsr ? 'echo "TTSR matched rule: rs-unsafe-added-router";' : ""} exit ${exitCode}; fi`,
				"ask; ask; mkdir -p notes; : > notes/ffi.txt; exit 0",
				"",
			].join("\n"));
			chmodSync(stub, 0o755);
			const env = Object.fromEntries(Object.entries({
				...process.env, OMP: stub, ONLY: "unsafe-router-near", TIMEOUT: "60", OMP_KIT_TEST_NO_COVERAGE: "1",
				OMP_KIT_TEST_WORK_ROOT: fixture.path, OMP_KIT_CASE_CWD: REPO_ROOT, ...extra,
			}).filter((entry): entry is [string, string] => entry[1] !== undefined));
			const result = await run(["sh", join(tree, "scripts/e2e-live.sh")], { cwd: REPO_ROOT, env, deadline_s: fixtureDeadlineS(150) });
			const stdout = Buffer.from(result.stdout).toString(), stderr = Buffer.from(result.stderr).toString();
			const kept = /kept private e2e output: \S+ \(work root (\S+)\)/.exec(stdout);
			if (kept) rmSync(kept[1]!, { recursive: true, force: true });
			return { rc: result.rc, out: stdout + stderr, runs: Number(readFileSync(count, "utf8").trim()), flaky: stdout.split("\n").filter(line => line.startsWith("FLAKY_OMP_TTSR_ABORT ")).length };
		};
		const [flaky, persistent, silent, off, otherExit, enough] = await Promise.all([
			attempt("flaky", 1, true),
			attempt("persistent", 9, true),
			attempt("silent", 9, false),
			attempt("off", 1, true, { OMP_KIT_E2E_TTSR_RETRY: "0" }),
			attempt("other-exit", 9, true, {}, 2),
			attempt("enough-requests", 9, true, {}, 1, 2),
		]);
		expect(flaky.out).toContain("ok    unsafe-router-near");
		expect({ rc: flaky.rc, runs: flaky.runs, flaky: flaky.flaky }, flaky.out).toEqual({ rc: 0, runs: 2, flaky: 1 });
		expect(persistent.out).toContain("FAIL  unsafe-router-near :: FAIL: 1 model request(s), want >=2");
		expect({ rc: persistent.rc, runs: persistent.runs, flaky: persistent.flaky }, persistent.out).toEqual({ rc: 1, runs: 2, flaky: 1 });
		expect({ rc: silent.rc, runs: silent.runs, flaky: silent.flaky }, silent.out).toEqual({ rc: 1, runs: 1, flaky: 0 });
		expect({ rc: off.rc, runs: off.runs, flaky: off.flaky }, off.out).toEqual({ rc: 1, runs: 1, flaky: 0 });
		expect({ rc: otherExit.rc, runs: otherExit.runs, flaky: otherExit.flaky }, otherExit.out).toEqual({ rc: 1, runs: 1, flaky: 0 });
		// Two requests were made, so the verdict is the missing file and not "too few requests": a different failure is never rerun.
		expect(enough.out).toContain("notes/ffi.txt was not written");
		expect({ rc: enough.rc, runs: enough.runs, flaky: enough.flaky }, enough.out).toEqual({ rc: 1, runs: 1, flaky: 0 });
	} finally { fixture.cleanup(); }
}, fixtureDeadlineS(300) * 1000);

afterAll(() => cleanupAllOwnedTmp());
