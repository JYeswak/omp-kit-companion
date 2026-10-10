import { afterAll, beforeAll, expect, test } from "bun:test";
import { appendFileSync, chmodSync, cpSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, truncateSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { delimiter, join, resolve } from "node:path";
import { countCaseRows } from "../../src/test-runner.ts";
import { resolveOmpIdentity } from "../../src/paths.ts";
import { previewKitRelease, stageKitRelease, type ReleaseAsset, type ReleasePlatform } from "../../src/kit-release.ts";

const repo = resolve(import.meta.dir, "../..");
const caseCwd = process.env.OMP_KIT_CASE_CWD || process.env.GITHUB_WORKSPACE || repo;
const scratch = resolve(import.meta.dir, "../../var/agent-tmp");
const output = mkdtempSync(join(scratch, "p21-release-"));
writeFileSync(join(output, ".owner"), `pid=${process.pid}\nlabel=p21-release\nrepo=omp-kit-companion\ncreated=${new Date().toISOString()}\n`);
const platform: ReleasePlatform = { os: process.platform as "darwin" | "linux", arch: process.arch as "arm64" | "x64", libc: process.platform === "darwin" ? "none" : "gnu" };
const key = `${platform.os}-${platform.arch}-${platform.libc}`;
const indexPath = join(output, "release-index.json");
let asset: ReleaseAsset;
let bytes: Buffer;
let index: { schema_version: number; version: string; source_tag: string; assets: Record<string, ReleaseAsset> };
function copyReleaseSource(destination: string): void {
	mkdirSync(destination);
	for (const directory of ["src", "rules", "retired", "cases", "policy", "extensions", "examples", "checkers", "scripts", "tests/live"]) {
		cpSync(join(repo, directory), join(destination, directory), { recursive: true });
	}
	const skillDir = join(destination, "skills", "jeff-planning-enhanced");
	mkdirSync(skillDir, { recursive: true });
	writeFileSync(join(skillDir, "SKILL.md"), "fixture skill\n");
	const configDir = join(destination, "config");
	mkdirSync(configDir, { recursive: true });
	writeFileSync(join(configDir, "planning-score.toml"), "fixture configuration\n");
	for (const file of ["LICENSE", "package.json", "tsconfig.json"]) {
		const source = join(repo, file);
		if (existsSync(source)) cpSync(source, join(destination, file));
	}
	const docs = join(destination, "docs");
	mkdirSync(docs);
	cpSync(join(repo, "docs/flywheel-invariants.tsv"), join(docs, "flywheel-invariants.tsv"));
	writeFileSync(join(destination, "MANIFEST.tsv"), "stale generated manifest sentinel\n");
	appendFileSync(join(destination, "rules", "kit-close-needs-evidence.md"), "\n<!-- package-time manifest fixture -->\n");
}

beforeAll(() => {
	const source = join(output, "source");
	copyReleaseSource(source);
	const built = Bun.spawnSync(["sh", join(source, "scripts", "package-release.sh"), "--version", "1.2.3", "--platform", key, "--out", output], {
		cwd: source, env: { ...process.env, TMPDIR: output }, stdout: "pipe", stderr: "pipe",
	});
	expect(built.exitCode, built.stdout.toString() + built.stderr.toString()).toBe(0);
	expect(readFileSync(join(source, "MANIFEST.tsv"), "utf8")).toBe("stale generated manifest sentinel\n");
	asset = JSON.parse(built.stdout.toString()) as ReleaseAsset;
	bytes = readFileSync(join(output, asset.filename));
	expect(createHash("sha256").update(bytes).digest("hex")).toBe(asset.sha256);
	index = { schema_version: 1, version: "1.2.3", source_tag: "v1.2.3", assets: { [key]: asset } };
	writeFileSync(indexPath, `${JSON.stringify(index)}\n`);
}, 30_000);
afterAll(() => rmSync(output, { recursive: true, force: true }));

test("native release derives the rule manifest from rules, covers it in archive integrity, and refuses corrupted bytes", async () => {
	const plan = await previewKitRelease({ currentVersion: "1.2.2", platform, sourceTag: "v1.2.3", fetchIndex: async () => index });
	expect(plan.exitCode).toBe(0);
	const staged = await stageKitRelease({ archive: bytes, plan, stagingParent: output, probeBinaryInfo: async (binary) => {
		const child = Bun.spawnSync([binary, "--info", "--json"], { cwd: output, env: { ...process.env, HOME: output }, stdout: "pipe", stderr: "pipe" });
		expect(child.exitCode, child.stdout.toString() + child.stderr.toString()).toBe(0);
		const info = JSON.parse(child.stdout.toString()).data;
		return { version: info.version, source_tag: info.release.source_tag, platform: info.platform };
	} });
	expect(staged.files).toContain("skills/jeff-planning-enhanced/SKILL.md");
	expect(readFileSync(join(staged.root, "skills", "jeff-planning-enhanced", "SKILL.md"), "utf8")).toBe("fixture skill\n");
	expect(staged.files).toContain("config/planning-score.toml");
	expect(readFileSync(join(staged.root, "config", "planning-score.toml"), "utf8")).toBe("fixture configuration\n");
	const shippedRule = readFileSync(join(staged.root, "rules", "kit-close-needs-evidence.md"));
	const generatedRuleManifest = readFileSync(join(staged.root, "MANIFEST.tsv"), "utf8");
	const ruleRow = generatedRuleManifest.split("\n").find(row => row.startsWith("kit-close-needs-evidence\t"));
	expect(generatedRuleManifest).not.toContain("stale generated manifest sentinel");
	expect(ruleRow?.split("\t")[1]).toBe(createHash("sha256").update(shippedRule).digest("hex"));
	expect(staged.manifest.files.find(file => file.path === "MANIFEST.tsv")?.sha256)
		.toBe(createHash("sha256").update(generatedRuleManifest).digest("hex"));
	expect(staged.executable).toBe(join(staged.root, "bin", "omp-kit"));
	expect(staged.manifest.files.map(file => file.path)).toEqual([...staged.manifest.files.map(file => file.path)].sort());
	expect(lstatSync(join(staged.root, "scripts", "runtime-adapter.sh")).mode & 0o111).toBeGreaterThan(0);
	for (const forbidden of ["reports/", ".git/", ".beads/", "var/", "src/", "private/"])
		expect(staged.files.some(file => file.startsWith(forbidden))).toBe(false);
	for (const essential of ["bin/omp-kit", "scripts/runtime-adapter.sh", "scripts/e2e-live.sh", "scripts/ladder.sh",
		"scripts/limit-process-tree.sh", "scripts/external-live.mjs", "checkers/check-readiness.sh", "checkers/check-claim-discipline.sh",
		"tests/live/mock-model.mjs", "MANIFEST.tsv", "cases/cases.tsv", "LICENSE"])
		expect(staged.files).toContain(essential);
	expect(staged.files).toContain("tests/live/integrations.json");
	expect(staged.files).toContain("scripts/check-flywheel-invariants.ts");
	expect(staged.files).toContain("docs/flywheel-invariants.tsv");

	const shippedFleetGuard = readFileSync(join(staged.root, "extensions", "fleet-guard.ts"), "utf8");
	expect(shippedFleetGuard).not.toContain("../src/fleet-guard/");
	expect(shippedFleetGuard).toContain("export");
	expect(staged.files).not.toContain("scripts/role-check.ts");
	const compiled = Bun.spawnSync([staged.executable, "--info", "--json"], { cwd: output, env: { ...process.env, HOME: output }, stdout: "pipe", stderr: "pipe" });
	expect(compiled.exitCode).toBe(0);
	expect(JSON.parse(compiled.stdout.toString()).data.release.source_tag).toBe("v1.2.3");
	const dirty = Buffer.from(bytes);
	dirty[dirty.length - 1030] ^= 1;
	await expect(stageKitRelease({ archive: dirty, plan, stagingParent: output, probeBinaryInfo: async () => { throw new Error("must not execute unverified archive"); } })).rejects.toThrow("ARCHIVE_DIGEST_MISMATCH");
	expect(readdirSync(output).filter(name => name.startsWith("kit-stage-"))).toHaveLength(1);
	expect(lstatSync(staged.executable).isFile()).toBe(true);
	expect(existsSync(join(staged.root, "reports"))).toBe(false);
});

function installCandidate(name: string): { home: string; installedRoot: string; installedBinary: string } {
	const home = join(output, name);
	mkdirSync(home);
	const prefix = join(home, ".local", "opt", "omp-kit");
	const installed = Bun.spawnSync(["sh", join(repo, "installer", "install.sh"), "--version", "1.2.3",
		"--index", indexPath, "--offline", join(output, asset.filename), "--prefix", prefix], {
		cwd: output, env: { ...process.env, HOME: home, TMPDIR: output }, stdout: "pipe", stderr: "pipe",
	});
	expect(installed.exitCode, installed.stdout.toString() + installed.stderr.toString()).toBe(0);
	return { home, installedRoot: join(prefix, "releases", "1.2.3"), installedBinary: join(prefix, "bin", "omp-kit") };
}

test("installed integrations and invariant gate run from the package; absent integration data refuses", () => {
	const { home, installedRoot, installedBinary } = installCandidate("integrations-home");
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
	const installed = Bun.spawnSync(args, { cwd: home, env, stdout: "pipe", stderr: "pipe" });
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
	const full = Bun.spawnSync([installedBinary, "test", "--full", "--json"], {
		cwd: home,
		env: { ...process.env, HOME: home, TMPDIR: output, TMP: output, TEMP: output,
			XDG_STATE_HOME: join(home, "xdg-state"), XDG_CACHE_HOME: join(home, "xdg-cache"),
			OMP_KIT_CASE_CWD: caseCwd, PATH: ladderPath,
			OMP: ompIdentity.launcher, OMP_BIN: ompIdentity.launcher,
			OMP_PATH: ompIdentity.launcher, OMP_SRC: ompIdentity.source },
		stdout: "pipe", stderr: "pipe",
	});
	const fullOutput = `${full.stdout.toString()}\n${full.stderr.toString()}`;
	expect(full.exitCode, fullOutput).toBe(0);
	const fullReport = JSON.parse(full.stdout.toString()).data.test;
	expect(fullReport.producer.stdout).toContain("GREEN flywheel-invariants");
	expect(fullReport.stages.manifest.status).toBe("PASS");

	rmSync(join(installedRoot, "tests/live/integrations.json"));
	const missing = Bun.spawnSync(args, { cwd: home, env, stdout: "pipe", stderr: "pipe" });
	expect(missing.exitCode).toBe(3);
	const failure = JSON.parse(missing.stdout.toString()) as { errors?: Array<{ code: string }> };
	expect(failure.errors?.[0]?.code).toBe("INTEGRATIONS_UNAVAILABLE");
}, 180_000);

test("installed candidate fast proof and planted rule drift fail the full check without live execution or mutation", () => {
	const { home, installedRoot, installedBinary } = installCandidate("operator-home");
	const fast = Bun.spawnSync([installedBinary, "test", "--json"], {
		cwd: output, env: { ...process.env, HOME: home, XDG_STATE_HOME: join(home, "xdg-state"),
			XDG_CACHE_HOME: join(home, "xdg-cache"), OMP: "", OMP_BIN: "", OMP_PATH: "", OMP_SRC: "", OMP_KIT_CASE_CWD: caseCwd },
		stdout: "pipe", stderr: "pipe",
	});
	expect(fast.exitCode, fast.stdout.toString() + fast.stderr.toString()).toBe(0);
	const corpus = countCaseRows(readFileSync(join(installedRoot, "cases", "cases.tsv"), "utf8"));
	const ruleCount = readdirSync(join(installedRoot, "rules")).filter((name) => name.endsWith(".md")).length;
	expect(ruleCount).toBeGreaterThan(0);
	expect(JSON.parse(fast.stdout.toString()).data.test.proofs).toMatchObject({
		G1_registration: { status: "PASS", observed_rules: ruleCount },
		G2_payload: { status: "PASS", expected_cases: corpus.cases, observed_cases: corpus.cases },
		G3_quiet_prefix: { status: "PASS", expected_cases: corpus.cases, expected_quiet_cases: corpus.quietCases,
			observed_cases: corpus.cases, observed_quiet_cases: corpus.quietCases, quiet_prefix_fires: 0 },
		G4_live: { status: "NOT_RUN" },
	});
	appendFileSync(join(installedRoot, "rules", "kit-close-needs-evidence.md"), "\n# planted post-package rule drift\n");
	const red = Bun.spawnSync([installedBinary, "test", "--full", "--json"], {
		cwd: output, env: { ...process.env, HOME: home, XDG_STATE_HOME: join(home, "xdg-state"),
			XDG_CACHE_HOME: join(home, "xdg-cache"), OMP: "", OMP_BIN: "", OMP_PATH: "", OMP_SRC: "", OMP_KIT_CASE_CWD: caseCwd },
		stdout: "pipe", stderr: "pipe",
	});
	expect(red.exitCode, red.stdout.toString() + red.stderr.toString()).toBe(1);
	const report = JSON.parse(red.stdout.toString()).data.test;
	expect(report.status).toBe("FAIL");
	expect(report.proofs.G4_live.status).toBe("NOT_RUN");
	expect(report.snapshots.release).toEqual({ unchanged: true, complete: true });
	expect(report.snapshots.home.unchanged).toBe(true);
	expect(report.snapshots.home.complete).toBe(true);
});

test("oversized operator files bound the watched snapshot only where the kit could write", () => {
	const { home, installedRoot, installedBinary } = installCandidate("bounded-home");
	appendFileSync(join(installedRoot, "rules", "kit-close-needs-evidence.md"), "\n# planted post-package rule drift\n");
	const env = { ...process.env, HOME: home, XDG_STATE_HOME: join(home, "xdg-state"),
		XDG_CACHE_HOME: join(home, "xdg-cache"), OMP: "", OMP_BIN: "", OMP_PATH: "", OMP_SRC: "" };
	const unwatched = join(home, "large-private-file");
	writeFileSync(unwatched, "");
	truncateSync(unwatched, 600 * 1024 * 1024);
	const ignored = Bun.spawnSync([installedBinary, "test", "--full", "--json"], { cwd: output, env, stdout: "pipe", stderr: "pipe" });
	expect(ignored.exitCode, ignored.stdout.toString() + ignored.stderr.toString()).toBe(1);
	expect(JSON.parse(ignored.stdout.toString()).data.test.snapshots.home).toMatchObject({ unchanged: true, complete: true, incomplete_paths: [] });
	mkdirSync(join(home, ".agents", "rules"), { recursive: true });
	const watched = join(home, ".agents", "rules", "oversized.md");
	writeFileSync(watched, "");
	truncateSync(watched, 512 * 1024 * 1024 + 1);
	const bounded = Bun.spawnSync([installedBinary, "test", "--full", "--json"], { cwd: output, env, stdout: "pipe", stderr: "pipe" });
	expect(bounded.exitCode, bounded.stdout.toString() + bounded.stderr.toString()).toBe(1);
	expect(JSON.parse(bounded.stdout.toString()).data.test.snapshots.home).toMatchObject({ unchanged: true, complete: false, incomplete_paths: ["~/.agents/rules"] });
});
