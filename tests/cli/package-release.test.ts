import { afterAll, beforeAll, expect, test } from "bun:test";
import { appendFileSync, chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, readlinkSync, rmSync, truncateSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { delimiter, join, resolve } from "node:path";
import { countCaseRows } from "../../src/test-runner.ts";
import { resolveOmpIdentity } from "../../src/paths.ts";
import { previewKitRelease, stageKitRelease, validateReleaseManifest, type ReleaseAsset, type ReleasePlatform } from "../../src/kit-release.ts";
import { ompSourceCacheRoot } from "../../src/omp-source-cache.ts";
import { packageSourceRevision } from "../../scripts/package-release.ts";

const repo = resolve(import.meta.dir, "../..");
const caseCwd = process.env.OMP_KIT_CASE_CWD || process.env.GITHUB_WORKSPACE || repo;
const sourceCacheRoot = ompSourceCacheRoot(process.env);
const nativeCacheEnv = sourceCacheRoot ? { OMP_KIT_OMP_SRC_CACHE: resolve(sourceCacheRoot) } : {};
const scratch = resolve(import.meta.dir, "../../var/agent-tmp");
const output = mkdtempSync(join(scratch, "p21-release-"));
writeFileSync(join(output, ".owner"), `pid=${process.pid}\nlabel=p21-release\nrepo=omp-kit-companion\ncreated=${new Date().toISOString()}\n`);
const stubBin = join(output, "stub-bin");
mkdirSync(stubBin, { recursive: true });
writeFileSync(join(stubBin, "omp"), "#!/bin/sh\nprintf 'omp stub\\n'\n");
chmodSync(join(stubBin, "omp"), 0o755);
const stubFirstPath = [stubBin, process.env.PATH ?? ""].join(delimiter);
// Explicitly synthetic authority-policy double, not real signature evidence.
const authorityPath = [join(repo, "tests/fixtures/kit-release"), process.env.PATH ?? ""].join(delimiter);
const platform: ReleasePlatform = { os: process.platform as "darwin" | "linux", arch: process.arch as "arm64" | "x64", libc: process.platform === "darwin" ? "none" : "gnu" };
const key = `${platform.os}-${platform.arch}-${platform.libc}`;
const indexPath = join(output, "release-index.json");
let asset: ReleaseAsset;
let bytes: Buffer;
let index: { schema_version: number; version: string; source_tag: string; assets: Record<string, ReleaseAsset> };
let sourceRevision: string;

function sourceGit(directory: string, args: string[]): Buffer {
	const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("GIT_")));
	const result = Bun.spawnSync(["git", "-C", directory, ...args], { cwd: directory,
		env: { ...env, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null", GIT_AUTHOR_NAME: "SourceStamp",
			GIT_AUTHOR_EMAIL: "source@example.invalid", GIT_COMMITTER_NAME: "SourceStamp", GIT_COMMITTER_EMAIL: "source@example.invalid" },
		stdout: "pipe", stderr: "pipe" });
	expect(result.exitCode, result.stderr.toString()).toBe(0);
	return result.stdout;
}
function sourceTree(directory: string, mode: "freeze" | "digest" | "release"): string {
	const digest = createHash("sha256");
	const visit = (path: string, name: string): void => {
		const stat = lstatSync(path);
		if (stat.isDirectory()) {
			if (mode === "release") chmodSync(path, 0o700);
			for (const child of readdirSync(path).sort()) visit(join(path, child), `${name}/${child}`);
			if (mode === "freeze") chmodSync(path, 0o555);
			digest.update(JSON.stringify([name, "directory", lstatSync(path).mode]));
		} else if (stat.isSymbolicLink()) {
			digest.update(JSON.stringify([name, "symlink", readlinkSync(path)]));
		} else {
			if (mode === "freeze") chmodSync(path, stat.mode & 0o111 ? 0o555 : 0o444);
			digest.update(JSON.stringify([name, lstatSync(path).mode,
				createHash("sha256").update(readFileSync(path)).digest("hex")]));
		}
	};
	visit(directory, "");
	return digest.digest("hex");
}

beforeAll(() => {
	const metadata: unknown = JSON.parse(readFileSync(join(repo, "package.json"), "utf8"));
	const exported = metadata !== null && typeof metadata === "object" && !Array.isArray(metadata)
		&& "source_revision" in metadata && typeof metadata.source_revision === "string"
		&& metadata.source_revision !== "$Format:%H$" ? metadata.source_revision : undefined;
	const selected = process.env.OMP_KIT_CASE_SOURCE_SHA ?? exported;
	// An admitted archive has no HEAD; its expanded revision selects objects from the explicit caller.
	const objectStore = exported === undefined ? repo : caseCwd;
	sourceRevision = sourceGit(objectStore, ["rev-parse", "--verify", "--end-of-options", `${selected ?? "HEAD"}^{commit}`]).toString().trim();
	if (selected !== undefined) expect(sourceRevision).toBe(selected);
	const sourceArchive = join(output, "selected-source.tar");
	sourceGit(objectStore, ["archive", "--format=tar", `--output=${sourceArchive}`, sourceRevision]);
	const archived = join(output, "archived-source");
	mkdirSync(archived);
	const extracted = Bun.spawnSync(["tar", "-xf", sourceArchive, "-C", archived], { stdout: "pipe", stderr: "pipe" });
	expect(extracted.exitCode, extracted.stderr.toString()).toBe(0);
	expect(existsSync(join(archived, "MANIFEST.tsv"))).toBe(false);
	const sourceBefore = sourceTree(archived, "freeze");
	const built = Bun.spawnSync(["sh", join(archived, "scripts", "package-release.sh"), "--version", "1.2.3", "--platform", key, "--out", output], {
		cwd: output, env: { ...process.env, TMPDIR: output }, stdout: "pipe", stderr: "pipe",
	});
	expect(built.exitCode, built.stdout.toString() + built.stderr.toString()).toBe(0);
	expect(sourceTree(archived, "digest")).toBe(sourceBefore);
	expect(existsSync(join(archived, "MANIFEST.tsv"))).toBe(false);
	asset = JSON.parse(built.stdout.toString()) as ReleaseAsset;
	bytes = readFileSync(join(output, asset.filename));
	expect(createHash("sha256").update(bytes).digest("hex")).toBe(asset.sha256);
	index = { schema_version: 1, version: "1.2.3", source_tag: "v1.2.3", assets: { [key]: asset } };
	writeFileSync(indexPath, `${JSON.stringify(index)}\n`);
	writeFileSync(join(output, `${asset.filename}.sigstore.json`), '{"fixture":true}\n');
}, 30_000);
afterAll(() => {
	const archived = join(output, "archived-source");
	if (existsSync(archived)) sourceTree(archived, "release");
	rmSync(output, { recursive: true, force: true });
});

test("native release derives the rule manifest from rules, covers it in archive integrity, and refuses corrupted bytes", async () => {
	const plan = await previewKitRelease({ currentVersion: "1.2.2", platform, sourceTag: "v1.2.3", fetchIndex: async () => index });
	expect(plan.exitCode).toBe(0);
	const staged = await stageKitRelease({ archive: bytes, plan, stagingParent: output, probeBinaryInfo: async (binary) => {
		const child = Bun.spawnSync([binary, "--info", "--json"], { cwd: output, env: { ...process.env, HOME: output, PATH: stubFirstPath, OMP: "", OMP_BIN: "", OMP_PATH: "", OMP_SRC: "" }, stdout: "pipe", stderr: "pipe" });
		expect(child.exitCode, child.stdout.toString() + child.stderr.toString()).toBe(0);
		const info = JSON.parse(child.stdout.toString()).data;
		return { version: info.version, source_tag: info.release.source_tag, platform: info.platform };
	} });
	expect(staged.files).toContain("skills/jeff-planning-enhanced/SKILL.md");
	expect(readFileSync(join(staged.root, "skills", "jeff-planning-enhanced", "SKILL.md")))
		.toEqual(readFileSync(join(output, "archived-source", "skills", "jeff-planning-enhanced", "SKILL.md")));
	expect(staged.files).toContain("config/planning-score.toml");
	expect(readFileSync(join(staged.root, "config", "planning-score.toml")))
		.toEqual(readFileSync(join(output, "archived-source", "config", "planning-score.toml")));
	const shippedRule = readFileSync(join(staged.root, "rules", "kit-close-needs-evidence.md"));
	const generatedRuleManifest = readFileSync(join(staged.root, "MANIFEST.tsv"), "utf8");
	const ruleRow = generatedRuleManifest.split("\n").find(row => row.startsWith("kit-close-needs-evidence\t"));
	expect(shippedRule).toEqual(readFileSync(join(output, "archived-source", "rules", "kit-close-needs-evidence.md")));
	expect(ruleRow?.split("\t")[1]).toBe(createHash("sha256").update(shippedRule).digest("hex"));
	expect(staged.manifest.files.find(file => file.path === "MANIFEST.tsv")?.sha256)
		.toBe(createHash("sha256").update(generatedRuleManifest).digest("hex"));
	const stagedPackage = JSON.parse(readFileSync(join(staged.root, "package.json"), "utf8")) as { version?: unknown; omp?: { version?: unknown } };
	expect(stagedPackage.version).toBe("1.2.3");
	expect(stagedPackage.omp?.version).toBe("1.2.3");
	expect(staged.manifest.version).toBe("1.2.3");
	expect(Object.keys(staged.manifest).sort()).toEqual(["files", "schema_version", "source_tag", "version"]);
	expect(JSON.parse(readFileSync(join(staged.root, "package.json"), "utf8")).source_revision).toBe(sourceRevision);
	expect(staged.manifest.files.find(file => file.path === "package.json")?.sha256)
		.toBe(createHash("sha256").update(readFileSync(join(staged.root, "package.json"))).digest("hex"));
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
	const compiled = Bun.spawnSync([staged.executable, "--info", "--json"], { cwd: output, env: { ...process.env, HOME: output, PATH: stubFirstPath, OMP: "", OMP_BIN: "", OMP_PATH: "", OMP_SRC: "" }, stdout: "pipe", stderr: "pipe" });
	expect(compiled.exitCode).toBe(0);
	expect(JSON.parse(compiled.stdout.toString()).data.release.source_tag).toBe("v1.2.3");
	const dirty = Buffer.from(bytes);
	dirty[dirty.length - 1030] ^= 1;
	await expect(stageKitRelease({ archive: dirty, plan, stagingParent: output, probeBinaryInfo: async () => { throw new Error("must not execute unverified archive"); } })).rejects.toThrow("ARCHIVE_DIGEST_MISMATCH");
	expect(readdirSync(output).filter(name => name.startsWith("kit-stage-"))).toHaveLength(1);
	expect(lstatSync(staged.executable).isFile()).toBe(true);
	expect(existsSync(join(staged.root, "reports"))).toBe(false);
});

test("packaging's manifest producer supersedes stale input and changed rule bytes without editing archived source", async () => {
 const selected = join(output, "archived-source", "tests", "fixtures", "package-manifest-inputs");
 // Module bytes come from the runtime-selected Git revision, not this test harness's tree.
 const { packageRuleManifest } = await import(join(output, "archived-source", "scripts", "package-release.ts"));
 const rule = readFileSync(join(selected, "rules", "fixture.md"));
 const stale = readFileSync(join(selected, "MANIFEST.tsv"), "utf8");
 const oldHash = stale.split("\n").find(row => row.startsWith("fixture\t"))!.split("\t")[1];
 const changedHash = createHash("sha256").update(rule).digest("hex");
 expect(changedHash).not.toBe(oldHash);
 const generated = packageRuleManifest(selected, output).toString("utf8").split("\n").find(row => row.startsWith("fixture\t"))!;
 expect(generated.split("\t").slice(0, 3)).toEqual(["fixture", changedHash, "always"]);
 expect(readFileSync(join(selected, "MANIFEST.tsv"), "utf8")).toBe(stale);
});

test("SourceStamp uses the physical source checkout and refuses dirty, missing, or unexpanded identity", () => {
	const selected = join(output, "source-stamp-checkout");
	mkdirSync(selected);
	const packagePath = join(selected, "package.json");
	const packageBytes = Buffer.from(JSON.stringify({ source_revision: "$Format:%H$" }));
	writeFileSync(packagePath, packageBytes);
	sourceGit(selected, ["init", "-q"]);
	sourceGit(selected, ["add", "package.json"]);
	sourceGit(selected, ["-c", "core.hooksPath=/dev/null", "commit", "-qm", "SourceStamp fixture"]);
	const revision = sourceGit(selected, ["rev-parse", "HEAD"]).toString().trim();
	expect(packageSourceRevision(selected, packageBytes)).toBe(revision);
	expect(packageSourceRevision(selected, packageBytes, revision)).toBe(revision);
	const originalGitDir = process.env.GIT_DIR;
	const originalWorkTree = process.env.GIT_WORK_TREE;
	try {
		process.env.GIT_DIR = join(repo, ".git");
		process.env.GIT_WORK_TREE = repo;
		expect(packageSourceRevision(selected, packageBytes)).toBe(revision);
	} finally {
		if (originalGitDir === undefined) delete process.env.GIT_DIR; else process.env.GIT_DIR = originalGitDir;
		if (originalWorkTree === undefined) delete process.env.GIT_WORK_TREE; else process.env.GIT_WORK_TREE = originalWorkTree;
	}
	appendFileSync(packagePath, "\n");
	expect(packageSourceRevision(selected, readFileSync(packagePath))).toBe(null);
	expect(packageSourceRevision(selected, readFileSync(packagePath), revision)).toBe(null);
	sourceGit(selected, ["add", "package.json"]);
	expect(packageSourceRevision(selected, readFileSync(packagePath))).toBe(null);
	sourceGit(selected, ["-c", "core.hooksPath=/dev/null", "commit", "-qm", "SourceStamp changed fixture"]);
	const changedRevision = sourceGit(selected, ["rev-parse", "HEAD"]).toString().trim();
	expect(changedRevision).not.toBe(revision);
	expect(packageSourceRevision(selected, readFileSync(packagePath))).toBe(changedRevision);
	expect(packageSourceRevision(selected, readFileSync(packagePath), revision)).toBe(null);
	expect(packageSourceRevision(selected, readFileSync(packagePath), null)).toBe(null);
	writeFileSync(join(selected, "untracked-source.ts"), "export const changed = true;\n");
	expect(packageSourceRevision(selected, readFileSync(packagePath))).toBe(null);
	const nested = join(selected, "gitless-source");
	mkdirSync(nested);
	expect(packageSourceRevision(nested, packageBytes)).toBe(null);
	expect(packageSourceRevision(join(output, "does-not-exist"), packageBytes)).toBe(null);
	expect(packageSourceRevision(join(output, "does-not-exist"), packageBytes, revision)).toBe(null);
});

test("SourceStamp retains actual Git archive expansion without selecting an ancestor checkout", () => {
	const archived = join(output, "archived-source");
	expect(packageSourceRevision(archived, readFileSync(join(archived, "package.json")))).toBe(sourceRevision);
	expect(packageSourceRevision(archived, readFileSync(join(archived, "package.json")), sourceRevision)).toBe(sourceRevision);
	for (const stamp of ["$Format:%H$", "v1.2.3", "abc1234", "a".repeat(40) + "\n", "a".repeat(64) + "\n", "A".repeat(40), "x".repeat(1_000_000)]) {
		expect(packageSourceRevision(archived, Buffer.from(JSON.stringify({ source_revision: stamp })))).toBe(null);
	}
});

test("SourceStamp stays outside the closed release manifest schema", () => {
	const legacy = { schema_version: 1, version: "1.2.3", source_tag: "v1.2.3",
		files: [{ path: "bin/omp-kit", sha256: "a".repeat(64) }] };
	expect(validateReleaseManifest(legacy)).toEqual(legacy);
	for (const source_revision of [undefined, null, sourceRevision, "b".repeat(64), 123, "", "main", "a".repeat(39), "a".repeat(41), "a".repeat(40) + "\n", "f".repeat(1_000_000)]) {
		expect(() => validateReleaseManifest({ ...legacy, source_revision })).toThrow("INVALID_RELEASE_MANIFEST");
	}
	expect(() => validateReleaseManifest({ ...legacy, source_revision: sourceRevision, extra: true })).toThrow("INVALID_RELEASE_MANIFEST");
});

function installCandidate(name: string): { home: string; installedRoot: string; installedBinary: string } {
	const home = join(output, name);
	mkdirSync(home);
	const prefix = join(home, ".local", "opt", "omp-kit");
	const installed = Bun.spawnSync(["sh", join(repo, "installer", "install.sh"), "--version", "1.2.3",
		"--index", indexPath, "--offline", join(output, asset.filename), "--prefix", prefix], {
		cwd: output, env: { ...process.env, PATH: authorityPath, HOME: home, TMPDIR: output, OMP: "", OMP_BIN: "", OMP_PATH: "", OMP_SRC: "" }, stdout: "pipe", stderr: "pipe",
	});
	expect(installed.exitCode, installed.stdout.toString() + installed.stderr.toString()).toBe(0);
	return { home, installedRoot: join(prefix, "releases", "1.2.3"), installedBinary: join(prefix, "bin", "omp-kit") };
}

function installerBoundary(name: string, substitute: boolean): { root: string; environment: Record<string, string>; binary: string } {
	const root = join(output, name);
	mkdirSync(root);
	const capture = join(root, "candidate-env");
	const binary = `#!/bin/sh\n/usr/bin/env > '${capture}'\nprintf '%s\\n' '${JSON.stringify({ data: { version: "1.2.3", release: { source_tag: "v1.2.3" }, platform: { os: platform.os, arch: platform.arch } } })}'\n`;
	const archive = join(root, "boundary.tar");
	const fixtureIndex = join(root, "release-index.json");
	// Real USTAR bytes and manifest consumed by the standalone installer.
	const generated = Bun.spawnSync(["python3", "-c", `
import hashlib, io, json, pathlib, sys, tarfile
root, binary, platform, key = sys.argv[1:]
root = pathlib.Path(root)
digest = lambda data: hashlib.sha256(data).hexdigest()
payload = binary.encode()
manifest = json.dumps({"schema_version":1,"version":"1.2.3","source_tag":"v1.2.3","files":[{"path":"bin/omp-kit","sha256":digest(payload)}]}).encode()
archive = root / "boundary.tar"
with tarfile.open(archive, "w", format=tarfile.USTAR_FORMAT) as tar:
    for name, data in [("bin/omp-kit",payload),("release-manifest.json",manifest)]:
        entry = tarfile.TarInfo(name)
        entry.size = len(data)
        tar.addfile(entry,io.BytesIO(data))
asset = dict(json.loads(platform), filename=archive.name, sha256=digest(archive.read_bytes()), manifest_sha256=digest(manifest))
(root / "release-index.json").write_text(json.dumps({"schema_version":1,"version":"1.2.3","source_tag":"v1.2.3","assets":{key:asset}}))
`, root, binary, JSON.stringify(platform), key], { cwd: output, env: { ...process.env, TMPDIR: output }, stdout: "pipe", stderr: "pipe" });
	expect(generated.exitCode, generated.stderr.toString()).toBe(0);
	writeFileSync(`${archive}.sigstore.json`, '{"fixture":true}\n');
	const expected = createHash("sha256").update(readFileSync(archive)).digest("hex");
	const installed = Bun.spawnSync(["python3", join(repo, "installer/install.py"), "install", fixtureIndex,
		"1.2.3", key, archive, join(root, "prefix"), "0"], {
		cwd: output, env: { ...process.env, PATH: authorityPath, TMPDIR: output, HOME: root,
			GH_TOKEN: "private-credential-sentinel", OMP_KIT_PRIVATE_SENTINEL: "private-env-sentinel",
			XDG_CONFIG_HOME: root, BUN_OPTIONS: "private-tool-config-sentinel",
			SYNTHETIC_GH_EXPECT_SHA256: expected,
			...(substitute ? { SYNTHETIC_GH_REPLACE_ARCHIVE: archive } : {}) },
		stdout: "pipe", stderr: "pipe",
	});
	expect(installed.exitCode, installed.stdout.toString() + installed.stderr.toString()).toBe(0);
	if (substitute) expect(readFileSync(archive, "utf8")).toBe("substituted original archive");
	return { root, binary, environment: Object.fromEntries(readFileSync(capture, "utf8").trim().split("\n").map(line => {
		const at = line.indexOf("=");
		return [line.slice(0, at), line.slice(at + 1)];
	})) };
}

test("installer boundary authenticates and installs one private archive snapshot despite original-path substitution", () => {
	const { root, binary } = installerBoundary("snapshot-boundary", true);
	expect(readFileSync(join(root, "prefix/releases/1.2.3/bin/omp-kit"), "utf8")).toBe(binary);
});

test("installer boundary excludes operator credentials and tool configuration from candidate environment", () => {
	const { root, environment } = installerBoundary("environment-boundary", false);
	expect(JSON.stringify(environment)).not.toContain("private-");
	expect(environment.GH_TOKEN).toBeUndefined();
	expect(environment.OMP_KIT_PRIVATE_SENTINEL).toBeUndefined();
	expect(environment.BUN_OPTIONS).toBeUndefined();
	expect(environment.HOME).not.toBe(root);
	expect(environment.XDG_CONFIG_HOME).toBe(join(environment.HOME, "config"));
	expect(environment.TMPDIR).toBe(environment.HOME);
	expect(existsSync(environment.HOME)).toBe(false);
});

test("installed integrations and invariant gate run from the package", () => {
	const { home, installedBinary } = installCandidate("integrations-home");
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
		env: { ...process.env, ...nativeCacheEnv, HOME: home, TMPDIR: output, TMP: output, TEMP: output,
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
// The full ladder runs the complete e2e-live suite (~200 s locally); same budget as kit-update's N+2 journey.
}, 900_000);

test("installed integrations refuse a planted missing tests/live/integrations.json and name the matrix", () => {
	const { home, installedRoot, installedBinary } = installCandidate("missing-matrix-home");
	const matrixPath = join(installedRoot, "tests/live/integrations.json");
	rmSync(matrixPath);
	const missing = Bun.spawnSync([installedBinary, "test", "--integrations", "--profile", "claude", "--json"], {
		cwd: home, env: { ...process.env, HOME: home, TMPDIR: output, TMP: output, TEMP: output,
			OMP: "", OMP_BIN: "", OMP_PATH: "", OMP_SRC: "" },
		stdout: "pipe", stderr: "pipe",
	});
	expect(missing.exitCode, `${missing.stdout.toString()}\n${missing.stderr.toString()}`).toBe(3);
	const failure = JSON.parse(missing.stdout.toString()) as { errors?: Array<{ code: string; message: string }> };
	expect(failure.errors?.[0]?.code).toBe("INTEGRATIONS_UNAVAILABLE");
	expect(failure.errors?.[0]?.message).toContain(matrixPath);
}, 120_000);

test("installed integrations run packaged mock-model fire and quiet turns through real OMP", () => {
	const { home, installedRoot, installedBinary } = installCandidate("embedded-mock-home");
	const agentDir = join(home, ".omp", "profiles", "claude", "agent");
	mkdirSync(agentDir, { recursive: true });
	writeFileSync(join(agentDir, "config.yml"), `extensions:\n  - ${join(installedRoot, "extensions", "kit-guard-optin.ts")}\n`);
	const installed = Bun.spawnSync([installedBinary, "test", "--integrations", "--profile", "claude", "--json"], {
		cwd: home, env: { ...process.env, ...nativeCacheEnv, HOME: home, TMPDIR: output, TMP: output, TEMP: output },
		stdout: "pipe", stderr: "pipe",
	});
	expect(installed.exitCode, `${installed.stdout.toString()}\n${installed.stderr.toString()}`).toBe(0);
	const report = JSON.parse(installed.stdout.toString()) as { data?: { integrations?: {
		matrix?: Array<{ profile: string; integration: string; verdict: string; quiet?: { outcome: string } }>
	} } };
	const guard = report.data?.integrations?.matrix?.find(row => row.profile === "claude" && row.integration === "kit-guard");
	expect(guard?.verdict).toBe("WIRED");
	expect(guard?.quiet?.outcome).toBe("ALLOWED");
}, 300_000);

test("installed candidate fast proof and planted rule drift fail the full check without live execution or mutation", () => {
	const { home, installedRoot, installedBinary } = installCandidate("operator-home");
	const fast = Bun.spawnSync([installedBinary, "test", "--json"], {
		cwd: output, env: { ...process.env, ...nativeCacheEnv, HOME: home, XDG_STATE_HOME: join(home, "xdg-state"),
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
		cwd: output, env: { ...process.env, ...nativeCacheEnv, HOME: home, XDG_STATE_HOME: join(home, "xdg-state"),
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
	const env = { ...process.env, ...nativeCacheEnv, HOME: home, XDG_STATE_HOME: join(home, "xdg-state"),
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
