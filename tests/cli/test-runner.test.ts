import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { chmodSync, cpSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, readlinkSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import process from "node:process";
import { delimiter, dirname, join, relative, resolve } from "node:path";
import { resolveOmpIdentity } from "../../src/paths.ts";
import type { FastTestInput, FastTestReport } from "../../src/test-runner.ts";

const REPO_ROOT = resolve(import.meta.dir, "../..");
let fixtureBase = "";
let releaseRoot = "";
let stableExecutable = "";

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
		expect(report.producers.gate.stdout).toContain("rules=18 ttsr_rules=17 cases=274 quiet_prefix_fires=0 failures=0");
		expect(report.producers.gate.stdout).toContain("GATE: GREEN");
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
		expect(report.producers.gate.stdout).toContain("RED G3 kit-close-reason-no-evidence quiet tool:bash");
		expect(readFileSync(join(plant.root, "cases", "cases.tsv"), "utf8")).toBe(casesBefore);
		expect(snapshotTree(plant.root)).toBe(plantReleaseBefore);
		expect(snapshotTree(home)).toBe(homeBefore);
		expect(snapshotTree(project)).toBe(projectBefore);
	});
});
