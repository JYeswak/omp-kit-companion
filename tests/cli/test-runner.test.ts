import { createHash } from "node:crypto";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { chmodSync, cpSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, readlinkSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import process from "node:process";
import { delimiter, dirname, join, relative, resolve } from "node:path";
import { resolveOmpIdentity } from "../../src/paths.ts";
import type { FastTestInput, FastTestReport, MatcherObservationInput, MatcherObservationReport } from "../../src/test-runner.ts";

const REPO_ROOT = resolve(import.meta.dir, "../..");
let fixtureBase = "";
let releaseRoot = "";
let stableExecutable = "";
let matcherRoot = "";
let matcherExecutable = "";
let matcherCaller = "";
function copyPackResources(destination: string): void {
	for (const directory of ["rules", "retired", "cases", "policy", "extensions"]) {
		cpSync(join(REPO_ROOT, directory), join(destination, directory), { recursive: true });
	}
	for (const file of ["MANIFEST.tsv"]) writeFileSync(join(destination, file), readFileSync(join(REPO_ROOT, file)));
	mkdirSync(join(destination, "scripts"), { recursive: true });
	for (const file of ["ttsr-harness.ts", "rule-class.ts"]) {
		writeFileSync(join(destination, "scripts", file), readFileSync(join(REPO_ROOT, "scripts", file)));
	}
}

function snapshotTree(root: string): string {
	const entries: string[] = [];
	const visit = (directory: string) => {
		for (const entry of readdirSync(directory, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
			const path = join(directory, entry.name);
			const stat = lstatSync(path);
			const name = relative(root, path);
			entries.push(`${name}\t${stat.mode & 0o777}\t${stat.size}\t${stat.mtimeMs}`);
			if (stat.isFile() && /\.(?:md|ts|tsv|json|ya?ml|sh|txt)$/i.test(entry.name)) {
				entries.push(readFileSync(path, "utf8"));
			}
			if (entry.isDirectory()) visit(path);
			else if (entry.isSymbolicLink()) entries.push(`${name}\t->${readlinkSync(path)}`);
		}
	};
	visit(root);
	return entries.join("\n");
}

function makeTestHome(name: string): string {
	const home = join(fixtureBase, name);
	for (const path of [
		home,
		join(home, "tmp"),
		join(home, "xdg-config"),
		join(home, "xdg-cache"),
		join(home, "xdg-data"),
		join(home, "xdg-state"),
		join(home, "bun-install"),
	]) mkdirSync(path, { recursive: true });
	writeFileSync(join(home, "operator-canary"), `${name}:unchanged\n`);
	return home;
}

function environment(home: string, pathValue: string): Record<string, string> {
	return {
		HOME: home,
		TMPDIR: join(home, "tmp"),
		TMP: join(home, "tmp"),
		TEMP: join(home, "tmp"),
		XDG_CONFIG_HOME: join(home, "xdg-config"),
		XDG_CACHE_HOME: join(home, "xdg-cache"),
		XDG_DATA_HOME: join(home, "xdg-data"),
		XDG_STATE_HOME: join(home, "xdg-state"),
		BUN_INSTALL: join(home, "bun-install"),
		PATH: pathValue,
	};
}

function withOmpIdentity(env: Record<string, string>, launcher: string, source: string): Record<string, string> {
	return { ...env, OMP: launcher, OMP_BIN: launcher, OMP_PATH: launcher, OMP_SRC: source };
}

function invoke(input: FastTestInput, env: Record<string, string>) {
	const result = Bun.spawnSync([stableExecutable], {
		cwd: fixtureBase,
		env: { ...env, OMP_KIT_TEST_INPUT: JSON.stringify(input) },
		stdout: "pipe",
		stderr: "pipe",
	});
	const stdout = result.stdout.toString();
	const stderr = result.stderr.toString();
	const report = JSON.parse(stdout) as FastTestReport;
	return { result, stdout, stderr, report };
}
async function invokeMatcher(input: MatcherObservationInput, env: Record<string, string>, cwd = fixtureBase) {
	const child = Bun.spawn([matcherCaller], {
		cwd, env: { ...env, OMP_KIT_MATCHER_INPUT: JSON.stringify(input) }, stdout: "pipe", stderr: "pipe",
	});
	const [exitCode, stdout, stderr] = await Promise.all([
		child.exited, new Response(child.stdout).text(), new Response(child.stderr).text(),
	]);
	if (exitCode !== 0) throw new Error(`matcher caller failed (${exitCode}): ${stdout}\n${stderr}`);
	const report = JSON.parse(stdout) as MatcherObservationReport;
	return { result: { exitCode }, stdout, stderr, report };
}

function createOmpWithoutNative(root: string): { launcher: string; source: string } {
	const versioned = join(root, "releases", "v-test");
	const source = join(versioned, "src");
	const launcher = join(root, "bin", "omp");
	for (const path of [join(source, "export"), join(source, "capability"), join(source, "discovery"), join(versioned, "dist"), dirname(launcher)]) {
		mkdirSync(path, { recursive: true });
	}
	writeFileSync(join(versioned, "package.json"), JSON.stringify({ name: "@oh-my-pi/pi-coding-agent", version: "18.4.2" }));
	writeFileSync(join(versioned, "dist", "cli.js"), "#!/bin/sh\nexit 0\n");
	chmodSync(join(versioned, "dist", "cli.js"), 0o755);
	for (const relativePath of ["export/ttsr.ts", "capability/rule.ts", "discovery/helpers.ts"]) {
		writeFileSync(join(source, relativePath), "export {};\n");
	}
	symlinkSync(join(versioned, "dist", "cli.js"), launcher);
	return { launcher, source };
}

function createPlantedRelease(): { root: string; stable: string; executable: string } {
	const prefix = join(fixtureBase, "plant-kit");
	const root = join(prefix, "releases", "v1.0.0");
	mkdirSync(join(root, "bin"), { recursive: true });
	copyPackResources(root);
	const executable = join(root, "bin", "omp-kit");
	cpSync(join(releaseRoot, "bin", "omp-kit"), executable);
	chmodSync(executable, 0o755);
	const stable = join(prefix, "bin", "omp-kit");
	mkdirSync(dirname(stable), { recursive: true });
	symlinkSync(executable, stable);

	const rulePath = join(root, "rules", "kit-close-reason-no-evidence.md");
	const original = readFileSync(rulePath, "utf8");
	const planted = original.replace(/^condition:\r?\n(?:[ \t].*\r?\n)+(?=scope:)/m, "condition:\n  - '.'\n");
	if (planted === original) throw new Error("quiet-prefix fixture could not replace the temporary rule condition");
	writeFileSync(rulePath, planted);
	return { root, stable, executable };
}

beforeAll(() => {
	fixtureBase = mkdtempSync(join(tmpdir(), "omp-kit-fast-test-"));
	const prefix = join(fixtureBase, "kit");
	releaseRoot = join(prefix, "releases", "v1.0.0");
	mkdirSync(join(releaseRoot, "bin"), { recursive: true });
	copyPackResources(releaseRoot);

	const buildRoot = join(fixtureBase, "builder");
	const buildEnv = {
		HOME: join(buildRoot, "home"),
		TMPDIR: join(buildRoot, "tmp"),
		XDG_CONFIG_HOME: join(buildRoot, "xdg-config"),
		XDG_CACHE_HOME: join(buildRoot, "xdg-cache"),
		XDG_DATA_HOME: join(buildRoot, "xdg-data"),
		XDG_STATE_HOME: join(buildRoot, "xdg-state"),
		BUN_INSTALL: join(buildRoot, "bun-install"),
		PATH: process.env.PATH ?? "/usr/bin:/bin",
	};
	for (const key of ["HOME", "TMPDIR", "XDG_CONFIG_HOME", "XDG_CACHE_HOME", "XDG_DATA_HOME", "XDG_STATE_HOME", "BUN_INSTALL"] as const) {
		mkdirSync(buildEnv[key], { recursive: true });
	}
	const executable = join(releaseRoot, "bin", "omp-kit");
	const build = Bun.spawnSync([
		process.execPath,
		"build",
		join(REPO_ROOT, "tests", "cli", "test-runner-fixture.ts"),
		"--compile",
		"--no-compile-autoload-dotenv",
		"--no-compile-autoload-bunfig",
		"--no-compile-autoload-tsconfig",
		`--outfile=${executable}`,
	], { cwd: REPO_ROOT, env: { ...buildEnv, TMP: buildEnv.TMPDIR, TEMP: buildEnv.TMPDIR }, stdout: "pipe", stderr: "pipe" });
	if (build.exitCode !== 0) throw new Error(`fixture compile failed (${build.exitCode}): ${build.stdout.toString()}\n${build.stderr.toString()}`);
	chmodSync(executable, 0o755);
	stableExecutable = join(prefix, "bin", "omp-kit");
	mkdirSync(dirname(stableExecutable), { recursive: true });
	symlinkSync(executable, stableExecutable);
	matcherRoot = join(fixtureBase, "matcher-kit", "releases", "v1.0.0");
	mkdirSync(join(matcherRoot, "bin"), { recursive: true });
	copyPackResources(matcherRoot);
	const matcherBinary = join(matcherRoot, "bin", "omp-kit");
	const matcherBuild = Bun.spawnSync([
		process.execPath,
		"build",
		join(REPO_ROOT, "src", "cli.ts"),
		"--compile",
		"--no-compile-autoload-dotenv",
		"--no-compile-autoload-bunfig",
		"--no-compile-autoload-tsconfig",
		`--outfile=${matcherBinary}`,
	], { cwd: REPO_ROOT, env: { ...buildEnv, TMP: buildEnv.TMPDIR, TEMP: buildEnv.TMPDIR }, stdout: "pipe", stderr: "pipe" });
	if (matcherBuild.exitCode !== 0) throw new Error(`matcher CLI compile failed (${matcherBuild.exitCode}): ${matcherBuild.stdout.toString()}\n${matcherBuild.stderr.toString()}`);
	chmodSync(matcherBinary, 0o755);
	matcherExecutable = join(fixtureBase, "matcher-kit", "bin", "omp-kit");
	mkdirSync(dirname(matcherExecutable), { recursive: true });
	symlinkSync(matcherBinary, matcherExecutable);
	const callerSource = join(fixtureBase, "matcher-caller.ts");
	writeFileSync(callerSource, [
		`import { runMatcherObservation } from ${JSON.stringify(join(REPO_ROOT, "src", "test-runner.ts"))};`,
		"const input = JSON.parse(process.env.OMP_KIT_MATCHER_INPUT ?? \"null\");",
		"const report = await runMatcherObservation(input);",
		"process.stdout.write(JSON.stringify(report));",
	].join("\n"));
	matcherCaller = join(fixtureBase, "matcher-caller");
	const callerBuild = Bun.spawnSync([
		process.execPath,
		"build",
		callerSource,
		"--compile",
		"--no-compile-autoload-dotenv",
		"--no-compile-autoload-bunfig",
		"--no-compile-autoload-tsconfig",
		`--outfile=${matcherCaller}`,
	], { cwd: REPO_ROOT, env: { ...buildEnv, TMP: buildEnv.TMPDIR, TEMP: buildEnv.TMPDIR }, stdout: "pipe", stderr: "pipe" });
	if (callerBuild.exitCode !== 0) throw new Error(`matcher caller compile failed (${callerBuild.exitCode}): ${callerBuild.stdout.toString()}\n${callerBuild.stderr.toString()}`);
	chmodSync(matcherCaller, 0o755);
});

afterAll(() => {
	if (fixtureBase) rmSync(fixtureBase, { recursive: true, force: true });
});

describe("runFastTest", () => {
	test("runs the real packaged matcher and reports missing install, project shadow, and live as unverified or not run", () => {
		const identity = resolveOmpIdentity(process.env);
		const home = makeTestHome("positive-home");
		const project = join(fixtureBase, "project");
		const projectRules = join(project, ".omp", "rules");
		mkdirSync(projectRules, { recursive: true });
		writeFileSync(join(projectRules, "kit-close-reason-no-evidence.md"), "project-local shadow\n");
		const projectMarker = join(fixtureBase, "project-command-ran");
		const projectScript = join(project, "must-not-run.sh");
		writeFileSync(projectScript, `#!/bin/sh\nprintf executed > '${projectMarker}'\n`);
		chmodSync(projectScript, 0o755);
		const input: FastTestInput = { root: releaseRoot, executablePath: stableExecutable, home, project };
		const env = withOmpIdentity(environment(home, process.env.PATH ?? "/usr/bin:/bin"), identity.launcher, identity.source);
		const homeBefore = snapshotTree(home);
		const projectBefore = snapshotTree(project);
		const releaseBefore = snapshotTree(dirname(dirname(stableExecutable)));

		const { result, report } = invoke(input, env);

		expect(result.exitCode).toBe(0);
		expect(report.exitCode).toBe(0);
		expect(report.status).toBe("PASS");
		expect(report.proofs.G1_registration.status).toBe("PASS");
		expect(report.proofs.G1_registration.expected_rules).toBe(18);
		expect(report.proofs.G1_registration.observed_rules).toBe(18);
		expect(report.proofs.G2_payload.status).toBe("PASS");
		expect(report.proofs.G2_payload.expected_cases).toBe(274);
		expect(report.proofs.G2_payload.observed_cases).toBe(274);
		expect(report.proofs.G3_quiet_prefix.status).toBe("PASS");
		expect(report.proofs.G3_quiet_prefix.expected_quiet_cases).toBe(138);
		expect(report.proofs.G3_quiet_prefix.quiet_prefix_fires).toBe(0);
		expect(report.proofs.G3_quiet_prefix.seeded_plant).toBe("PASS");
		expect(report.proofs.G4_live.status).toBe("NOT_RUN");
		expect(report.diagnostics.installed_rules.status).toBe("DEGRADED");
		expect(report.diagnostics.installed_rules.evidence?.ownership).toBe("UNVERIFIED");
		expect(report.diagnostics.installed_rules.evidence?.missing).toHaveLength(18);
		expect(report.diagnostics.project_rules.status).toBe("DEGRADED");
		expect(report.diagnostics.project_rules.evidence?.mismatched_shadows).toContain("kit-close-reason-no-evidence");
		expect(report.diagnostics.effective_profile.status).toBe("UNVERIFIED");
		expect(report.producers.gate.producer_rc).toBe(0);
		const gate = JSON.parse(report.producers.gate.stdout);
		expect(gate).toMatchObject({ schema_version: 1, status: "PASS", counts: { rules: 18, ttsr_rules: 17, cases: 274, quiet_cases: 138, quiet_prefix_fires: 0 } });
		expect(gate.failures).toEqual([]);
		expect(report.producers.selftest.producer_rc).toBe(0);
		expect(report.producers.selftest.stdout).toContain("plant (b) RED as intended");
		expect(report.producers.gate.stdout).not.toContain(identity.source);
		expect(report.producers.gate.stdout).not.toContain("/omp-kit-runtime-");
		expect(snapshotTree(home)).toBe(homeBefore);
		expect(snapshotTree(project)).toBe(projectBefore);
		expect(snapshotTree(dirname(dirname(stableExecutable)))).toBe(releaseBefore);
		expect(existsSync(projectMarker)).toBe(false);
		expect(existsSync(join(home, ".agents", "rules"))).toBe(false);
	});

	test("returns exit 3 without launching the matcher when OMP is absent or has no native matcher", () => {
		const home = makeTestHome("missing-omp-home");
		const emptyBin = join(fixtureBase, "no-omp-bin");
		mkdirSync(emptyBin, { recursive: true });
		const missingInput: FastTestInput = { root: releaseRoot, executablePath: stableExecutable, home };
		const missing = invoke(missingInput, environment(home, [emptyBin, "/usr/bin", "/bin"].join(delimiter)));
		expect(missing.result.exitCode).toBe(3);
		expect(missing.report.exitCode).toBe(3);
		expect(missing.report.status).toBe("BLOCKED");
		expect(missing.report.blocker?.kind).toBe("OMP_UNAVAILABLE");
		expect(missing.report.blocker?.remedy).toContain("will not install it");
		expect(missing.report.producers.gate.producer_rc).toBe(null);
		expect(missing.report.producers.selftest.producer_rc).toBe(null);
		expect(missing.report.proofs.G1_registration.status).toBe("NOT_RUN");

		const fakeRoot = join(fixtureBase, "omp-without-native");
		const fake = createOmpWithoutNative(fakeRoot);
		const nativeHome = makeTestHome("missing-native-home");
		const nativeEnv = withOmpIdentity(environment(nativeHome, [dirname(fake.launcher), "/usr/bin", "/bin"].join(delimiter)), fake.launcher, fake.source);
		const native = invoke({ root: releaseRoot, executablePath: stableExecutable, home: nativeHome }, nativeEnv);
		expect(native.result.exitCode).toBe(3);
		expect(native.report.exitCode).toBe(3);
		expect(native.report.blocker?.kind).toBe("NATIVE_MATCHER_UNAVAILABLE");
		expect(native.report.blocker?.remedy).toContain("@oh-my-pi/pi-natives");
		expect(native.report.producers.gate.producer_rc).toBe(null);
	});

	test("returns exit 1 and G3 evidence for a quiet-prefix plant in the unchanged 274-case corpus", () => {
		const plant = createPlantedRelease();
		const identity = resolveOmpIdentity(process.env);
		const home = makeTestHome("plant-home");
		const project = join(fixtureBase, "plant-project");
		mkdirSync(project, { recursive: true });
		const input: FastTestInput = { root: plant.root, executablePath: plant.stable, home, project };
		const env = withOmpIdentity(environment(home, process.env.PATH ?? "/usr/bin:/bin"), identity.launcher, identity.source);
		const casesBefore = readFileSync(join(plant.root, "cases", "cases.tsv"), "utf8");
		const homeBefore = snapshotTree(home);
		const projectBefore = snapshotTree(project);
		const plantReleaseBefore = snapshotTree(plant.root);

		const { result, report } = invoke(input, env);

		expect(result.exitCode).toBe(1);
		expect(report.exitCode).toBe(1);
		expect(report.status).toBe("FAIL");
		expect(report.proofs.G3_quiet_prefix.status).toBe("FAIL");
		expect(report.proofs.G3_quiet_prefix.quiet_prefix_fires).toBeGreaterThan(0);
		expect(report.producers.gate.producer_rc).toBe(1);
		const gate = JSON.parse(report.producers.gate.stdout);
		expect(gate).toMatchObject({ schema_version: 1, status: "FAIL" });
		expect(gate.failures.join("\n")).toContain("G3 kit-close-reason-no-evidence quiet tool:bash");
		expect(readFileSync(join(plant.root, "cases", "cases.tsv"), "utf8")).toBe(casesBefore);
		expect(snapshotTree(plant.root)).toBe(plantReleaseBefore);
		expect(snapshotTree(home)).toBe(homeBefore);
		expect(snapshotTree(project)).toBe(projectBefore);
	});
	test("observes a selected external witness through the native matcher, not the bundled pack", async () => {
		const identity = resolveOmpIdentity(process.env);
		const root = join(fixtureBase, "external-witness");
		const rules = join(root, "rules");
		const cases = join(root, "cases.tsv");
		mkdirSync(rules, { recursive: true });
		writeFileSync(join(rules, "external-zebra.md"), "---\ncondition: 'ZEBRA_42'\nscope: text\ninterruptMode: never\n---\nExternal witness.\n");
		writeFileSync(cases, "rule\texpect\tsource\ttool\tpath\tsnippet\tnote\nexternal-zebra\tfire\ttext\t-\t-\tZEBRA_42 trailing context\tpositive\nexternal-zebra\tquiet\ttext\t-\t-\tZEBRA_4x\tnear miss\n");
		const expectedRuleHash = createHash("sha256").update(readFileSync(join(rules, "external-zebra.md"))).digest("hex");
		const home = makeTestHome("external-witness-home");
		const workerTmp = join(fixtureBase, "external-witness-tmp");
		mkdirSync(workerTmp);
		const homeBefore = snapshotTree(home);
		const observeEnv = {
			...environment(home, process.env.PATH ?? "/usr/bin:/bin"),
			TMPDIR: workerTmp, TMP: workerTmp, TEMP: workerTmp,
			// The hosting Bun process may cache this script before its JS starts.
			XDG_CACHE_HOME: join(workerTmp, "caller-cache"),
			OMP_SRC: identity.source, OMP_BIN: identity.launcher,
		};
		const observe = async (line: number, rulesDir = rules, expectedSha = expectedRuleHash) => {
			const result = Bun.spawn([process.execPath, join(REPO_ROOT, "scripts", "ttsr-harness.ts"), "--observe", "--rules", rulesDir, "--cases", cases, "--rule", "external-zebra", "--line", String(line), "--rule-sha256", expectedSha], {
				cwd: REPO_ROOT,
				env: observeEnv,
				stdout: "pipe",
				stderr: "pipe",
			});
			const [code, stdout, stderr] = await Promise.all([
				result.exited, new Response(result.stdout).text(), new Response(result.stderr).text(),
			]);
			return { code, stdout, stderr };
		};
		const [positive, nearMiss] = await Promise.all([observe(2), observe(3)]);
		expect(positive.code).toBe(0);
		const fire = JSON.parse(positive.stdout);
		expect(fire).toMatchObject({ status: "OK", rule: "external-zebra", case_line: 2, registration: "REGISTERED", whole: "fire", prefix: { phase: "stream", position: 8, wire_length: 25 }, evaluator: "OK" });
		expect(fire.bindings.matcher_sha256).toMatch(/^[a-f0-9]{64}$/);
		expect(fire.bindings.rule_sha256).toMatch(/^[a-f0-9]{64}$/);
		expect(nearMiss.code).toBe(0);
		expect(JSON.parse(nearMiss.stdout)).toMatchObject({ status: "OK", rule: "external-zebra", case_line: 3, whole: "quiet", prefix: null, evaluator: "OK" });
		expect(snapshotTree(home)).toBe(homeBefore);
		const originalCaseSha = fire.bindings.cases_sha256;
		writeFileSync(cases, readFileSync(cases, "utf8") + "# revised witness note\n");
		const substitutedRules = join(root, "bundled-substitution");
		mkdirSync(substitutedRules);
		const substituteFile = join(substitutedRules, "external-zebra.md");
		writeFileSync(substituteFile, "---\ncondition: 'OTHER_MARKER'\nscope: text\ninterruptMode: never\n---\nDifferent packaged rule.\n");
		// Complete every reader before the next fixture mutation; keep the same test deadline.
		const [revised, missing, substituted, neutralized] = await Promise.all([
			observe(2),
			observe(2, join(REPO_ROOT, "rules")),
			observe(2, substitutedRules),
			observe(2, substitutedRules, createHash("sha256").update(readFileSync(substituteFile)).digest("hex")),
		]);
		expect(revised.code).toBe(0);
		const revisedWitness = JSON.parse(revised.stdout);
		expect(revisedWitness).toMatchObject({ status: "OK", whole: "fire", case_line: 2 });
		expect(revisedWitness.bindings.cases_sha256).not.toBe(originalCaseSha);
		expect(revisedWitness.bindings.rule_sha256).toBe(fire.bindings.rule_sha256);
		expect(missing.code).toBe(1);
		expect(JSON.parse(missing.stdout)).toMatchObject({ status: "UNAVAILABLE", reason: "SELECTED_RULE_NOT_FOUND", rule: "external-zebra", case_line: 2 });
		expect(substituted.code).toBe(1);
		expect(JSON.parse(substituted.stdout)).toMatchObject({ status: "UNAVAILABLE", reason: "BUNDLED_SUBSTITUTION", rule: "external-zebra", case_line: 2 });
		expect(neutralized.code).toBe(0);
		expect(JSON.parse(neutralized.stdout)).toMatchObject({ status: "OK", whole: "quiet", prefix: null });
		const selectedFile = join(rules, "external-zebra.md");
		writeFileSync(selectedFile, readFileSync(selectedFile, "utf8") + "Revised body.\n");
		const historical = await observe(2);
		expect(historical.code).toBe(1);
		expect(JSON.parse(historical.stdout)).toMatchObject({ status: "UNAVAILABLE", reason: "BUNDLED_SUBSTITUTION" });
		expect(snapshotTree(home)).toBe(homeBefore);
	});
	test("binds selected write witness to source, tool, and path scope", () => {
		const identity = resolveOmpIdentity(process.env);
		const root = join(fixtureBase, "path-witness");
		const rules = join(root, "rules");
		const cases = join(root, "cases.tsv");
		mkdirSync(rules, { recursive: true });
		writeFileSync(join(rules, "external-path.md"), "---\ncondition: 'WRITE_MARKER'\nscope: 'tool:write(**/owned/*.md)'\ninterruptMode: never\n---\nPath witness.\n");
		writeFileSync(cases, "rule\texpect\tsource\ttool\tpath\tsnippet\tnote\nexternal-path\tfire\ttool\twrite\towned/note.md\tWRITE_MARKER\tin scope\nexternal-path\tquiet\ttool\twrite\tother/note.md\tWRITE_MARKER\tout of scope\n");
		const run = (line: number) => Bun.spawnSync([process.execPath, join(REPO_ROOT, "scripts", "ttsr-harness.ts"), "--observe", "--rules", rules, "--cases", cases, "--rule", "external-path", "--line", String(line)], { cwd: REPO_ROOT, env: { ...process.env, OMP_SRC: identity.source, OMP_BIN: identity.launcher }, stdout: "pipe", stderr: "pipe" });
		const inScope = run(2);
		expect(inScope.exitCode).toBe(0);
		expect(JSON.parse(inScope.stdout.toString())).toMatchObject({ status: "OK", whole: "fire", witness: { source: "tool", tool: "write", path: "owned/note.md", expect: "fire" } });
		const outOfScope = run(3);
		expect(outOfScope.exitCode).toBe(0);
		expect(JSON.parse(outOfScope.stdout.toString())).toMatchObject({ status: "OK", whole: "quiet", prefix: null, witness: { source: "tool", tool: "write", path: "other/note.md", expect: "quiet" } });
	});

	test("does not misreport a judged-rule candidate as a quiet native evaluator", () => {
		const identity = resolveOmpIdentity(process.env);
		const root = join(fixtureBase, "judged-witness");
		const rules = join(root, "rules");
		const cases = join(root, "cases.tsv");
		mkdirSync(rules, { recursive: true });
		writeFileSync(join(rules, "external-judged.md"), "---\nquestion: 'Was the marker ignored?'\nscope: text\ninterruptMode: never\n---\nJudged witness.\n");
		writeFileSync(cases, "rule\texpect\tsource\ttool\tpath\tsnippet\tnote\nexternal-judged\tfire\ttext\t-\t-\tmarker\tjudge required\n");
		const result = Bun.spawnSync([process.execPath, join(REPO_ROOT, "scripts", "ttsr-harness.ts"), "--observe", "--rules", rules, "--cases", cases, "--rule", "external-judged", "--line", "2"], { cwd: REPO_ROOT, env: { ...process.env, OMP_SRC: identity.source, OMP_BIN: identity.launcher }, stdout: "pipe", stderr: "pipe" });
		expect(result.exitCode).toBe(1);
		expect(JSON.parse(result.stdout.toString())).toMatchObject({ status: "UNAVAILABLE", rule: "external-judged", reason: "JUDGE_REQUIRED", evaluator: "UNAVAILABLE" });
	});
	test("reports unavailable rather than quiet when the selected native matcher cannot import", () => {
		const result = Bun.spawnSync([process.execPath, join(REPO_ROOT, "scripts", "ttsr-harness.ts"), "--observe", "--rule", "bash-glob-silenced", "--line", "2"], {
			cwd: REPO_ROOT,
			env: { ...process.env, OMP_SRC: join(fixtureBase, "missing-omp-src") },
			stdout: "pipe", stderr: "pipe",
		});
		expect(result.exitCode).toBe(1);
		expect(JSON.parse(result.stdout.toString())).toMatchObject({ status: "UNAVAILABLE", rule: "bash-glob-silenced", case_line: 2, reason: "MATCHER_IMPORT_FAILED", evaluator: "UNAVAILABLE" });
	});
	test("reports a bounded matcher timeout as unavailable, never quiet", () => {
		const result = Bun.spawnSync([process.execPath, join(REPO_ROOT, "scripts", "ttsr-harness.ts"), "--observe", "--rule", "bash-glob-silenced", "--line", "2", "--timeout-ms", "1"], { cwd: REPO_ROOT, stdout: "pipe", stderr: "pipe" });
		expect(result.exitCode).toBe(1);
		expect(JSON.parse(result.stdout.toString())).toMatchObject({ status: "UNAVAILABLE", rule: "bash-glob-silenced", case_line: 2, reason: "EVALUATOR_TIMEOUT", evaluator: "UNAVAILABLE" });
	});
	test("completed payload remains quiet when an earlier streamed prefix fired", () => {
		const identity = resolveOmpIdentity(process.env);
		const root = join(fixtureBase, "anchored-witness");
		const rules = join(root, "rules");
		const cases = join(root, "cases.tsv");
		mkdirSync(rules, { recursive: true });
		writeFileSync(join(rules, "external-anchor.md"), "---\ncondition: '^AAAAAAA$'\nscope: text\ninterruptMode: never\n---\nAnchor witness.\n");
		writeFileSync(cases, "rule\texpect\tsource\ttool\tpath\tsnippet\tnote\nexternal-anchor\tquiet\ttext\t-\t-\tAAAAAAAB\tearlier prefix only\n");
		const result = Bun.spawnSync([process.execPath, join(REPO_ROOT, "scripts", "ttsr-harness.ts"), "--observe", "--rules", rules, "--cases", cases, "--rule", "external-anchor", "--line", "2"], { cwd: REPO_ROOT, env: { ...process.env, OMP_SRC: identity.source, OMP_BIN: identity.launcher }, stdout: "pipe", stderr: "pipe" });
		expect(result.exitCode).toBe(0);
		expect(JSON.parse(result.stdout.toString())).toMatchObject({ status: "OK", whole: "quiet", prefix: { phase: "stream", position: 7, wire_length: 8 } });
	});

	test("refuses a partially invalid rule instead of claiming a complete evaluation", () => {
		const identity = resolveOmpIdentity(process.env);
		const root = join(fixtureBase, "invalid-condition");
		const rules = join(root, "rules");
		const cases = join(root, "cases.tsv");
		mkdirSync(rules, { recursive: true });
		writeFileSync(join(rules, "external-invalid.md"), "---\ncondition: ['[', '^MARKER$']\nscope: text\ninterruptMode: never\n---\nInvalid witness.\n");
		writeFileSync(cases, "rule\texpect\tsource\ttool\tpath\tsnippet\tnote\nexternal-invalid\tfire\ttext\t-\t-\tMARKER\tpartial condition\n");
		const result = Bun.spawnSync([process.execPath, join(REPO_ROOT, "scripts", "ttsr-harness.ts"), "--observe", "--rules", rules, "--cases", cases, "--rule", "external-invalid", "--line", "2"], { cwd: REPO_ROOT, env: { ...process.env, OMP_SRC: identity.source, OMP_BIN: identity.launcher }, stdout: "pipe", stderr: "pipe" });
		expect(result.exitCode).toBe(1);
		expect(JSON.parse(result.stdout.toString())).toMatchObject({ status: "UNAVAILABLE", reason: "INVALID_RULE", evaluator: "UNAVAILABLE" });
	});
	test("observes bash arguments on JSON wire, not decoded command text", () => {
		const identity = resolveOmpIdentity(process.env);
		const root = join(fixtureBase, "bash-wire-witness");
		const rules = join(root, "rules");
		const cases = join(root, "cases.tsv");
		mkdirSync(rules, { recursive: true });
		writeFileSync(join(rules, "external-bash-wire.md"), "---\ncondition: '\"command\":\"WIRE_KEY\"'\nscope: tool:bash\ninterruptMode: never\n---\nBash wire witness.\n");
		writeFileSync(cases, "rule\texpect\tsource\ttool\tpath\tsnippet\tnote\nexternal-bash-wire\tfire\ttool\tbash\t-\tWIRE_KEY\tJSON wire\nexternal-bash-wire\tquiet\ttool\tbash\t-\tWIRE_KEy\tnear miss\n");
		const run = (line: number) => Bun.spawnSync([process.execPath, join(REPO_ROOT, "scripts", "ttsr-harness.ts"), "--observe", "--rules", rules, "--cases", cases, "--rule", "external-bash-wire", "--line", String(line)], { cwd: REPO_ROOT, env: { ...process.env, OMP_SRC: identity.source, OMP_BIN: identity.launcher }, stdout: "pipe", stderr: "pipe" });
		const positive = run(2);
		expect(positive.exitCode).toBe(0);
		expect(JSON.parse(positive.stdout.toString())).toMatchObject({ status: "OK", whole: "fire", prefix: { phase: "stream", position: 21, wire_length: 22 }, witness: { source: "tool", tool: "bash" } });
		const quiet = run(3);
		expect(quiet.exitCode).toBe(0);
		expect(JSON.parse(quiet.stdout.toString())).toMatchObject({ status: "OK", whole: "quiet", prefix: null });
	});

	test("records an AST-only write hit at final snapshot, not a streamed prefix", () => {
		const identity = resolveOmpIdentity(process.env);
		const root = join(fixtureBase, "ast-final-witness");
		const rules = join(root, "rules");
		const cases = join(root, "cases.tsv");
		mkdirSync(rules, { recursive: true });
		writeFileSync(join(rules, "external-ast.md"), "---\nastCondition: 'console.log($$$A)'\nscope: 'tool:write(*.ts)'\ninterruptMode: never\n---\nAST witness.\n");
		writeFileSync(cases, "rule\texpect\tsource\ttool\tpath\tsnippet\tnote\nexternal-ast\tfire\ttool\twrite\tsrc/app.ts\tconsole.log(\"x\");\tAST final\nexternal-ast\tquiet\ttool\twrite\tsrc/app.ts\tconst s = \"console.log(x)\";\tAST near miss\n");
		const run = (line: number) => Bun.spawnSync([process.execPath, join(REPO_ROOT, "scripts", "ttsr-harness.ts"), "--observe", "--rules", rules, "--cases", cases, "--rule", "external-ast", "--line", String(line)], { cwd: REPO_ROOT, env: { ...process.env, OMP_SRC: identity.source, OMP_BIN: identity.launcher }, stdout: "pipe", stderr: "pipe" });
		const positive = run(2);
		expect(positive.exitCode).toBe(0);
		expect(JSON.parse(positive.stdout.toString())).toMatchObject({ status: "OK", whole: "fire", prefix: { phase: "final", position: 18, wire_length: 17 }, witness: { source: "tool", tool: "write", path: "src/app.ts" } });
		const quiet = run(3);
		expect(quiet.exitCode).toBe(0);
		expect(JSON.parse(quiet.stdout.toString())).toMatchObject({ status: "OK", whole: "quiet", prefix: null });
	});
	test("rejects a launcher that does not belong to the selected OMP package", () => {
		const identity = resolveOmpIdentity(process.env);
		const result = Bun.spawnSync([process.execPath, join(REPO_ROOT, "scripts", "ttsr-harness.ts"), "--observe", "--rule", "bash-glob-silenced", "--line", "2"], {
			cwd: REPO_ROOT,
			env: { ...process.env, OMP_SRC: identity.source, OMP_BIN: "/usr/bin/true" },
			stdout: "pipe", stderr: "pipe",
		});
		expect(result.exitCode).toBe(1);
		expect(JSON.parse(result.stdout.toString())).toMatchObject({ status: "UNAVAILABLE", rule: "bash-glob-silenced", reason: "OMP_IDENTITY_MISMATCH", evaluator: "UNAVAILABLE" });
	});
});

describe("runMatcherObservation", () => {
	test("returns native fire/quiet witnesses bound to the selected source and leaves caller roots unchanged", async () => {
		const identity = resolveOmpIdentity(process.env);
		const home = makeTestHome("matcher-observation-home");
		const project = join(fixtureBase, "matcher-observation-project");
		mkdirSync(project, { recursive: true });
		writeFileSync(join(project, ".env"), "OMP=/usr/bin/false\n");
		writeFileSync(join(project, "bunfig.toml"), "[install]\nauto = false\n");
		const rules = join(matcherRoot, "rules");
		const cases = join(matcherRoot, "cases", "cases.tsv");
		const rule = "bash-glob-silenced";
		const expectedRuleSha256 = createHash("sha256").update(readFileSync(join(REPO_ROOT, "rules", `${rule}.md`))).digest("hex");
		const env = withOmpIdentity(environment(home, process.env.PATH ?? "/usr/bin:/bin"), identity.launcher, identity.source);
		const homeBefore = snapshotTree(home);
		const projectBefore = snapshotTree(project);
		const releaseBefore = snapshotTree(matcherRoot);
		const observe = (caseLine: number, ruleSha = expectedRuleSha256) => invokeMatcher({
			root: matcherRoot,
			executablePath: matcherExecutable,
			rules,
			cases,
			rule,
			caseLine,
			expectedRuleSha256: ruleSha,
		}, env, project);

		const [positive, quiet, mismatch] = await Promise.all([observe(2), observe(3), observe(2, "0".repeat(64))]);
		expect(positive.result.exitCode).toBe(0);
		expect(positive.report.observation).toMatchObject({ status: "OK", rule, case_line: 2, whole: "fire", registration: "REGISTERED", evaluator: "OK", witness: { source: "tool", tool: "bash" } });
		if (positive.report.observation.status !== "OK") throw new Error("expected a positive matcher observation");
		expect(positive.report.observation.bindings).toMatchObject({
			omp_launcher: identity.launcher,
			omp_package: identity.packageRoot,
			omp_source: identity.source,
			native_package: identity.nativeRoot,
			kit_root: realpathSync(matcherRoot),
			harness_runtime: realpathSync(matcherExecutable),
			rule_sha256: expectedRuleSha256,
		});
		expect(positive.report.producer.producer_rc).toBe(0);


		expect(quiet.report.observation).toMatchObject({ status: "OK", rule, case_line: 3, whole: "quiet", prefix: null });

		expect(mismatch.report.observation).toMatchObject({ status: "UNAVAILABLE", evaluator: "UNAVAILABLE" });
		expect(mismatch.report.producer.producer_rc).toBe(1);
		expect(mismatch.report.observation.status === "UNAVAILABLE" && mismatch.report.observation.reason).not.toBe("QUIET");
		expect(snapshotTree(home)).toBe(homeBefore);
		expect(snapshotTree(project)).toBe(projectBefore);
		expect(snapshotTree(matcherRoot)).toBe(releaseBefore);
	});

	test("redacts private root, HOME, and native paths from consumer-visible unavailable reports", async () => {
		const identity = resolveOmpIdentity(process.env);
		const home = makeTestHome("matcher-redaction-home");
		const prefix = join(fixtureBase, "matcher-redaction-kit");
		const root = join(prefix, "releases", "v1.0.0");
		mkdirSync(join(root, "bin"), { recursive: true });
		copyPackResources(root);
		const executable = join(root, "bin", "omp-kit");
		cpSync(join(matcherRoot, "bin", "omp-kit"), executable);
		chmodSync(executable, 0o755);
		const stable = join(prefix, "bin", "omp-kit");
		mkdirSync(dirname(stable), { recursive: true });
		symlinkSync(executable, stable);

		const privateEvidence = `root=${root} home=${home} native=${identity.nativeRoot}`;
		const observation = {
			status: "UNAVAILABLE",
			rule: "bash-glob-silenced",
			case_line: 2,
			evaluator: "UNAVAILABLE",
			reason: "NATIVE_MATCHER_UNAVAILABLE",
			detail: privateEvidence,
		};
		writeFileSync(join(root, "scripts", "ttsr-harness.ts"), [
			`process.stdout.write(${JSON.stringify(JSON.stringify(observation))});`,
			`process.stderr.write(${JSON.stringify(privateEvidence)});`,
			"process.exitCode = 1;",
		].join("\n"));
		const identityEnv = withOmpIdentity(environment(home, process.env.PATH ?? "/usr/bin:/bin"), identity.launcher, identity.source);
		const expectedRuleSha256 = createHash("sha256").update(readFileSync(join(REPO_ROOT, "rules", "bash-glob-silenced.md"))).digest("hex");
		const report = (await invokeMatcher({
			root,
			executablePath: stable,
			rules: join(root, "rules"),
			cases: join(root, "cases", "cases.tsv"),
			rule: "bash-glob-silenced",
			caseLine: 2,
			expectedRuleSha256,
		}, identityEnv)).report;

		expect(report.observation).toMatchObject({ status: "UNAVAILABLE", evaluator: "UNAVAILABLE", reason: "NATIVE_MATCHER_UNAVAILABLE" });
		expect(report.observation.status === "UNAVAILABLE" && report.observation.detail).toContain("<release-root>");
		expect(report.observation.status === "UNAVAILABLE" && report.observation.detail).toContain("<home>");
		expect(report.observation.status === "UNAVAILABLE" && report.observation.detail).toContain("<omp-native>");
		expect(report.producer.producer_rc).toBe(1);
		for (const output of [report.producer.stdout, report.producer.stderr]) {
			expect(output).not.toContain(root);
			expect(output).not.toContain(home);
			expect(output).not.toContain(identity.nativeRoot);
		}
		expect(report.producer.stderr).toContain("<release-root>");
		expect(report.producer.stderr).toContain("<home>");
		expect(report.producer.stderr).toContain("<omp-native>");
	});
	test("redacts a PATH-selected malformed OMP launcher when identity resolution fails", async () => {
		const home = makeTestHome("path-omp-redaction-home");
		const installation = join(fixtureBase, "path-selected-omp");
		const pathBin = join(fixtureBase, "path-selected-omp-bin");
		const target = join(installation, "omp-real");
		const alias = join(pathBin, "omp");
		mkdirSync(pathBin, { recursive: true });
		mkdirSync(installation, { recursive: true });
		writeFileSync(target, "#!/bin/sh\nexit 0\n");
		chmodSync(target, 0o755);
		symlinkSync(target, alias);
		const canonical = realpathSync(alias);
		const env = environment(home, [pathBin, "/usr/bin", "/bin"].join(delimiter));
		const expectedRuleSha256 = createHash("sha256").update(readFileSync(join(REPO_ROOT, "rules", "bash-glob-silenced.md"))).digest("hex");

		const report = (await invokeMatcher({
			root: matcherRoot,
			executablePath: matcherExecutable,
			rules: join(matcherRoot, "rules"),
			cases: join(matcherRoot, "cases", "cases.tsv"),
			rule: "bash-glob-silenced",
			caseLine: 2,
			expectedRuleSha256,
		}, env)).report;

		expect(relative(home, canonical).startsWith("..")).toBe(true);
		expect(report.observation).toMatchObject({ status: "UNAVAILABLE", evaluator: "UNAVAILABLE", reason: "BUNDLED_RUNTIME_UNAVAILABLE" });
		if (report.observation.status !== "UNAVAILABLE") throw new Error("malformed PATH-selected OMP must remain unavailable");

		expect(report.observation.detail).not.toContain(canonical);
		expect(report.observation.detail).not.toContain(alias);
		expect(report.producer.producer_rc).toBe(null);
	});
	test.each(["missing-source", "missing-native"])("redacts package paths for a PATH-selected %s installation", async (kind) => {
		const home = makeTestHome(`path-${kind}-home`);
		const installation = join(fixtureBase, `private-package-${kind}`);
		const selected = createOmpWithoutNative(installation);
		if (kind === "missing-source") rmSync(selected.source, { recursive: true });
		const env = environment(home, [dirname(selected.launcher), "/usr/bin", "/bin"].join(delimiter));
		const report = (await invokeMatcher({
			root: matcherRoot, executablePath: matcherExecutable, rules: join(matcherRoot, "rules"),
			cases: join(matcherRoot, "cases/cases.tsv"), rule: "bash-glob-silenced", caseLine: 2,
			expectedRuleSha256: createHash("sha256").update(readFileSync(join(matcherRoot, "rules/bash-glob-silenced.md"))).digest("hex"),
		}, env)).report;
		expect(report.observation).toMatchObject({ status: "UNAVAILABLE", evaluator: "UNAVAILABLE", reason: "NATIVE_MATCHER_UNAVAILABLE" });
		if (report.observation.status !== "UNAVAILABLE") throw new Error("incomplete native installation must remain unavailable");

		expect(JSON.stringify(report)).not.toContain(installation);
		expect(JSON.stringify(report)).not.toContain(realpathSync(installation));
		expect(report.producer.producer_rc).toBeNull();
	});
});
