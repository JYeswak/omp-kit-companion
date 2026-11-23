// Coverage: scripts/fresh-gate.sh, scripts/full-suite-verdict-store.py.
import { afterAll, expect, test } from "bun:test";
import { chmodSync, cpSync, existsSync, mkdirSync, readFileSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { cleanupAllOwnedTmp } from "../../src/kitlib/tmp";
import { runSync } from "../../src/kitlib/run";
import { AMPLE, affectedArchive, candidateRepo, copyJudgingFiles, gate, gateTree, MANIFEST_HEADER, root, saveFixture } from "./fresh-gate.helpers";
import { fixtureDeadlineS } from "./fixture-process";

afterAll(() => cleanupAllOwnedTmp());

// LANDJUDGE1 (ompkit-xewv5): a FULL-plan gate reads the exact-tree main PASS back with the store. The verdict recorder keys a
// record by the judging closure it ran under, so a candidate that changes the closure is only ever recorded under its own
// identity. The gate must therefore read under the candidate archive as the judge root exactly when the candidate's closure
// identity differs from this run's (parent) judge, and under its own judge otherwise. The store is stubbed (as in
// fresh-gate-full-reuse.test.ts) and records every real require-pass argument; no operator verdicts are read or written.
type Closure = "differs" | "same" | "incomplete";

function runArchive(pass: boolean, closure: Closure) {
	const fx = saveFixture(0, { max_load: 1000, reserve_gib: 0 });
	const archive = affectedArchive(fx, 1, 1);
	const repo = candidateRepo(fx);
	const scripts = gateTree(fx, MANIFEST_HEADER);
	const source = readFileSync(gate, "utf8");
	const dispatch = "\nrun_gate &\n";
	expect(source.split(dispatch)).toHaveLength(2);
	const script = join(scripts, "fresh-gate.sh");
	if (existsSync(script)) unlinkSync(script);
	writeFileSync(script, source.replace(dispatch, "\nrun_gate() { gate_focused; }\nrun_gate &\n"));
	mkdirSync(join(archive, "scripts"));
	for (const name of ["build-manifest.sh", "ttsr-harness.ts"]) writeFileSync(join(archive, "scripts", name), "");
	if (closure !== "incomplete") {
		// The candidate carries the full judging closure. The gate tree's suite-metrics.py is the fixture variant, so the
		// untouched real closure differs from it; the fixture variant itself is the same closure as the gate tree.
		copyJudgingFiles(archive, ["scripts/build-manifest.sh", "scripts/ttsr-harness.ts"]);
	}
	const calls = join(fx.dir, "store-call");
	const python = Bun.which("python3");
	if (!python) throw new Error("python3 is required");
	const shim = join(fx.dir, "bin/python3");
	writeFileSync(shim, `#!/bin/sh
if [ "$1" = full-suite-verdict-store.py ]; then
  printf '%s\\n' "$@" >${JSON.stringify(calls)}
  echo ${pass ? "PASS" : "MISS"}
  exit ${pass ? 0 : 1}
fi
exec '${python}' "$@"
`);
	chmodSync(shim, 0o755);
	const policy = join(scripts, "fixed-env.sh");
	const pinned = readFileSync(policy, "utf8");
	unlinkSync(policy);
	writeFileSync(policy, `${pinned}\nPATH="${join(fx.dir, "bin")}:$PATH"\nexport PATH\n`);
	if (closure === "same") {
		// The same closure: mirror every judging file from the gate tree itself, the fixture variants and the policy file
		// rewritten above included, plus the CI-only manifest the identity binds when the root carries one.
		const listed = runSync(["python3", "-m", "suite-metrics", "judging-files"], { env: { ...process.env, PYTHONPATH: join(root, "scripts") } as Record<string, string>, deadline_s: fixtureDeadlineS(10) });
		for (const name of [...Buffer.from(listed.stdout).toString().trim().split("\n"), "scripts/gate-ci-only.tsv"]) {
			const from = join(scripts, "..", name);
			if (!name.startsWith("scripts/") || !existsSync(from)) continue;
			rmSync(join(archive, name), { force: true });
			cpSync(from, join(archive, name), { dereference: true });
		}
	}
	const git = (args: string[]) => {
		const result = runSync(["git", "-C", repo, ...args], { deadline_s: fixtureDeadlineS(10) });
		if (result.rc !== 0) throw new Error(Buffer.from(result.stderr).toString());
		return Buffer.from(result.stdout).toString().trim();
	};
	const commit = git(["rev-parse", "HEAD"]);
	const tree = git(["rev-parse", `${commit}^{tree}`]);
	const env: Record<string, string | undefined> = { ...process.env, ...fx.env, STORE_CALL: calls, FRESH_GATE_LEDGER: "", FRESH_GATE_REPO: repo };
	const result = runSync(["sh", script, "--commit", commit, "--archive-dir", archive, "--changed-file", "scripts/pysafe.py"], { env, deadline_s: fixtureDeadlineS(120) });
	const args = existsSync(calls) ? readFileSync(calls, "utf8").trim().split("\n") : [];
	const expected = (judgeRoot: string) => ["full-suite-verdict-store.py", "require-pass", "--repo", repo, "--tree", tree, "--role", "main", "--judge-root", judgeRoot, "--suite-root", resolve(archive)];
	return { code: result.rc, out: Buffer.from(result.stdout).toString() + Buffer.from(result.stderr).toString(), args, expected, parentJudge: `${scripts}/..`, archive: resolve(archive), repo, commit };
}

(AMPLE ? test : test.skip)("LANDJUDGE1 a candidate that changes the judging closure is read back under the candidate as judge root", () => {
	const result = runArchive(true, "differs");
	expect(result.out).toContain("FRESH-GATE: VERDICT FULL_SUITE_REUSED");
	expect(result.code).toBe(0);
	expect(result.args).toEqual(result.expected(result.archive));
}, fixtureDeadlineS(120) * 1000);

(AMPLE ? test : test.skip)("LANDJUDGE1 a candidate with the same judging closure keeps reading through the parent judge", () => {
	const result = runArchive(true, "same");
	expect(result.out).toContain("FRESH-GATE: VERDICT FULL_SUITE_REUSED");
	expect(result.code).toBe(0);
	expect(result.args).toEqual(result.expected(result.parentJudge));
}, fixtureDeadlineS(120) * 1000);

(AMPLE ? test : test.skip)("LANDJUDGE1 an archive whose closure identity cannot be computed fails closed to the parent judge", () => {
	const result = runArchive(true, "incomplete");
	expect(result.code).toBe(0);
	expect(result.args).toEqual(result.expected(result.parentJudge));
}, fixtureDeadlineS(120) * 1000);

(AMPLE ? test : test.skip)("LANDJUDGE1 a MISS under a changed closure teaches recording the candidate's own judge from the commit", () => {
	const result = runArchive(false, "differs");
	expect(result.code).toBe(1);
	expect(result.out).toContain("FULL_SUITE_REQUIRED");
	expect(result.out).toContain(`git -C ${result.repo} archive ${result.commit}`);
	expect(result.args).toEqual(result.expected(result.archive));
}, fixtureDeadlineS(120) * 1000);
