import { afterAll, expect, test } from "bun:test";
import { cpSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { cleanupAllOwnedTmp, ownedTmp } from "../../src/kitlib/tmp.ts";
afterAll(cleanupAllOwnedTmp);

// LOCAL-RELEASE-V1 (ompkit-v66l.27.11, docs/release-signing.md): enabling release.yml must never start the
// expensive pipeline. Its default mode runs only attest-local; every other job needs mode=ci-pipeline.
const ROOT = join(import.meta.dir, "..", "..");
type Job = { if?: string; needs?: string | string[]; steps?: { run?: string; uses?: string; with?: Record<string, unknown> }[] };
type Workflow = { on: Record<string, { inputs?: Record<string, { default?: unknown; options?: string[] }> } | null>; jobs: Record<string, Job> };
const release = Bun.YAML.parse(readFileSync(join(ROOT, ".github/workflows/release.yml"), "utf8")) as Workflow;

test("release.yml has only a manual trigger and defaults to local-attest", () => {
	expect(Object.keys(release.on)).toEqual(["workflow_dispatch"]);
	const mode = release.on.workflow_dispatch!.inputs!.mode!;
	expect(mode.default).toBe("local-attest");
	expect(mode.options).toEqual(["local-attest", "ci-pipeline"]);
});

test("every pipeline job requires the explicit ci-pipeline mode; attest-local requires local-attest", () => {
	const jobs = Object.entries(release.jobs);
	expect(jobs.length).toBeGreaterThan(5);
	for (const [name, job] of jobs) {
		if (name === "attest-local") expect(job.if).toStartWith("inputs.mode == 'local-attest' &&");
		else expect(job.if ?? "").toContain("inputs.mode == 'ci-pipeline' &&");
	}
	// The negative control: a job without the gate fails the same check.
	expect("github.event.repository.private == false").not.toContain("inputs.mode == 'ci-pipeline' &&");
});

test("attest-local verifies the draft and the consumer policy before it publishes", () => {
	const steps = release.jobs["attest-local"]!.steps!;
	const scripts = steps.map(step => step.run ?? "").join("\n");
	expect(scripts).toContain('[[ "$GITHUB_REF" == "refs/tags/v$VERSION" ]]');
	expect(scripts).toContain("sha256sum --strict -c SHA256SUMS");
	expect(scripts).toContain("mkdir dist sbom"); // v0.2.56's attest-local died on ENOENT writing sbom/ (run 39205018538)
	expect(scripts).toContain('python3 -I -c "$(cat installer/install.py)" attestation "$archive" "$VERSION" unused');
	expect(scripts).toContain("--signer-workflow \"$GITHUB_REPOSITORY/.github/workflows/release.yml\"");
	expect(scripts).not.toContain("--clobber");
	const order = steps.map(step => step.uses?.split("@")[0] ?? (step.run?.includes("--draft=false") ? "publish" : step.run?.includes("attestation \"$archive\"") ? "consumer-verify" : "run"));
	expect(order.indexOf("actions/attest-build-provenance")).toBeLessThan(order.indexOf("consumer-verify"));
	expect(order.indexOf("consumer-verify")).toBeLessThan(order.indexOf("publish"));
});

test("the train's release.yml dispatches pass mode=ci-pipeline", () => {
	const reuse = readFileSync(join(ROOT, "scripts/release_reuse.py"), "utf8");
	expect(reuse).toContain('RELEASE_PIPELINE_MODE = "ci-pipeline"');
	const dispatches = reuse.split("\n").filter(line => line.includes("_native_dispatch(") && line.includes('"release.yml"'));
	expect(dispatches.length).toBe(3);
	expect(reuse.split('"mode": RELEASE_PIPELINE_MODE').length - 1).toBe(3);
	const train = readFileSync(join(ROOT, ".github/workflows/release-train.yml"), "utf8");
	for (const line of train.split("\n").filter(line => line.includes("gh workflow run release.yml"))) expect(line).toContain("-f mode=ci-pipeline");
});

test("release-local.sh dry run never reaches a remote write", () => {
	const script = readFileSync(join(ROOT, "scripts/release-local.sh"), "utf8");
	// The dry-run branch may open with comment lines (a shellcheck directive for its `ls`) before its say.
	const dryExit = script.search(/if \[ "\$DRY_RUN" = 1 \]; then\n(?:\t#[^\n]*\n)*\tsay "dry run/);
	expect(dryExit).toBeGreaterThan(0);
	for (const write of ["push --porcelain origin", "gh release create", "gh workflow run release.yml"])
		expect(script.indexOf(write)).toBeGreaterThan(dryExit);
	expect(script.split("\n").filter(line => line.includes(" push ") && line.includes("--force"))).toEqual([]);
	expect(script).not.toContain("-f mode=ci-pipeline");
	expect(Bun.spawnSync(["bash", "-n", join(ROOT, "scripts/release-local.sh")]).exitCode).toBe(0);
});

test("release-local runs the bundled TTSR selftest after coverage, and its removal is RED", () => {
	const script = readFileSync(join(ROOT, "scripts/release-local.sh"), "utf8");
	const gate = script.indexOf('stage rule-gate');
	const selftest = script.indexOf('ttsr-harness.ts" --selftest', gate);
	expect(gate).toBeGreaterThanOrEqual(0);
	expect(selftest).toBeGreaterThan(gate);
	expect(script.slice(gate, selftest)).toContain('ttsr-harness.ts" --gate-json');
	expect(script.slice(selftest)).toContain('die "ttsr-harness --selftest failed');

	// Planted negative: removing the selftest invocation must fail this contract.
	const mutant = script.replace(/\nbounded 600 bun "\$SRC\/scripts\/ttsr-harness\.ts" --selftest[^]*?say "rule selftest PASS"\n/, "\n");
	expect(mutant).not.toContain('ttsr-harness.ts" --selftest');
	expect(mutant.slice(gate)).not.toContain('die "ttsr-harness --selftest failed');
});

test("release gate refuses a kit rule with its fire fixture removed", () => {
	const work = realpathSync(ownedTmp("kitpost-gate", { root: process.env.TMPDIR ?? join(ROOT, "var", "agent-tmp") }).path);
	const cases = join(ROOT, "cases", "cases.tsv");
	const mutated = join(work, "cases.tsv");
	try {
		cpSync(cases, mutated);
		const rows = readFileSync(mutated, "utf8").split("\n").map(row => row.endsWith("\r") ? row.slice(0, -1) : row);
		const target = "kit-tool-result-is-not-json\tfire\t";
		const index = rows.findIndex(row => row.startsWith(target));
		if (index < 0) throw new Error("KITPOST fixture is missing its fire row");
		rows.splice(index, 1);
		writeFileSync(mutated, rows.join("\n"));
		const run = (casesPath: string) => Bun.spawnSync(["bun", "scripts/ttsr-harness.ts", "--gate-json",
			"--rules", join(ROOT, "rules"), "--cases", casesPath], {
			// No HOME-derived OMP_SRC: rule-class.ts resolves the launcher's exact-version package itself
			// (beside the launcher, bun global, or the OMP_KIT_OMP_SRC_CACHE source cache under the scrub).
			cwd: ROOT, env: { ...process.env },
			stdout: "pipe", stderr: "pipe",
		});
		const control = run(cases);
		expect(control.exitCode, control.stderr.toString()).toBe(0);
		const negative = run(mutated);
		expect(negative.exitCode).not.toBe(0);
		expect(negative.stdout.toString() + negative.stderr.toString()).toContain("COVERAGE kit-tool-result-is-not-json");
	} finally {
		rmSync(work, { recursive: true, force: true });
	}
});
