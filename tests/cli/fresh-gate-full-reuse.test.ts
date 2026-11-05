// Coverage: scripts/fresh-gate.sh, scripts/full-suite-verdict-store.py.
import { afterAll, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { cleanupAllOwnedTmp } from "../../src/kitlib/tmp";
import { runSync } from "../../src/kitlib/run";
import { AMPLE, affectedArchive, candidateRepo, gate, gateTree, MANIFEST_HEADER, saveFixture } from "./fresh-gate.helpers";

import { fixtureDeadlineS } from "./fixture-process";
afterAll(() => cleanupAllOwnedTmp());

// Keep the production argument parser, archive setup and focused gate intact. Only the unrelated
// compile/manifest/harness phases are excluded, as in runFocused, so this tests pre-push's call shape.
function runArchive(pass: boolean, supplyRepo = true) {
	const fx = saveFixture(0, { max_load: 1000, reserve_gib: 0 });
	const archive = affectedArchive(fx, 1, 1);
	const repo = candidateRepo(fx);
	const scripts = gateTree(fx, MANIFEST_HEADER);
	const source = readFileSync(gate, "utf8");
	const dispatch = "\nrun_gate &\n";
	expect(source.split(dispatch)).toHaveLength(2);
	const script = join(scripts, "fresh-gate.sh");
	// gateTree links judging scripts to source; replace only this fixture-owned link.
	if (existsSync(script)) unlinkSync(script);
	writeFileSync(script, source.replace(dispatch, "\nrun_gate() { gate_focused; }\nrun_gate &\n"));
	// Startup checks require these archive members; the focused phase never executes them.
	mkdirSync(join(archive, "scripts"));
	for (const name of ["build-manifest.sh", "ttsr-harness.ts"]) writeFileSync(join(archive, "scripts", name), "");
	const calls = join(fx.dir, "store-call");
	const python = Bun.which("python3");
	if (!python) throw new Error("python3 is required");
	// Stub only the store response, recording every real require-pass argument. Other Python work
	// (including record_run) uses the real interpreter. No operator verdicts are read or written.
	const shim = join(fx.dir, "bin/python3");
	writeFileSync(shim, `#!/bin/sh
if [ "$1" = full-suite-verdict-store.py ]; then
  printf '%s\\n' "$@" >"$STORE_CALL"
  echo ${pass ? "PASS" : "MISS"}
  exit ${pass ? 0 : 1}
fi
exec '${python}' "$@"
`);
	chmodSync(shim, 0o755);
	const git = (args: string[]) => {
		const result = runSync(["git", "-C", repo, ...args], { deadline_s: fixtureDeadlineS(10) });
		if (result.rc !== 0) throw new Error(Buffer.from(result.stderr).toString());
		return Buffer.from(result.stdout).toString().trim();
	};
	const commit = git(["rev-parse", "HEAD"]);
	const tree = git(["rev-parse", `${commit}^{tree}`]);
	const env: Record<string, string | undefined> = { ...process.env, ...fx.env, STORE_CALL: calls, FRESH_GATE_LEDGER: "" };
	delete env.FRESH_GATE_REPO;
	if (supplyRepo) env.FRESH_GATE_REPO = repo;
	const result = runSync(["sh", script, "--commit", commit, "--archive-dir", archive, "--changed-file", "scripts/pysafe.py"], { env, deadline_s: fixtureDeadlineS(120) });
	return { code: result.rc, out: Buffer.from(result.stdout).toString() + Buffer.from(result.stderr).toString(),
		args: existsSync(calls) ? readFileSync(calls, "utf8").trim().split("\n") : [],
		expected: ["full-suite-verdict-store.py", "require-pass", "--repo", repo, "--tree", tree, "--role", "main", "--judge-root", `${scripts}/..`, "--suite-root", resolve(archive)] };
}

(AMPLE ? test : test.skip)("FULLREUSE1 reuses the exact candidate tree PASS through pre-push archive arguments", () => {
	const result = runArchive(true);
	expect(result.out).toContain("FRESH-GATE: VERDICT FULL_SUITE_REUSED");
	expect(result.code).toBe(0);
	expect(result.args).toEqual(result.expected);
}, 120_000);

(AMPLE ? test : test.skip)("FULLREUSE1 refuses the same archive call when no PASS is recorded", () => {
	const result = runArchive(false);
	expect(result.out).toContain("FULL_SUITE_REQUIRED");
	expect(result.code).toBe(1);
	expect(result.args).toEqual(result.expected);
}, 120_000);

(AMPLE ? test : test.skip)("FULLREUSE1 caller-owned archive without candidate repo never consults the store", () => {
	const result = runArchive(true, false);
	expect(result.out).toContain("FULL_SUITE_REQUIRED");
	expect(result.code).toBe(1);
	expect(result.args).toEqual([]);
}, 120_000);
