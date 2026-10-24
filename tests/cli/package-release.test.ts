import { afterAll, beforeAll, expect, test } from "bun:test";
import { appendFileSync, chmodSync, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, readlinkSync, rmSync, truncateSync, writeFileSync } from "node:fs";
import { createHash, generateKeyPairSync } from "node:crypto";
import { delimiter, join, resolve } from "node:path";
import { countCaseRows } from "../../src/test-runner.ts";
import { resolveOmpIdentity } from "../../src/paths.ts";
import { previewKitRelease, stageKitRelease, validateReleaseManifest, type ReleaseAsset, type ReleasePlatform } from "../../src/kit-release.ts";
import { ompSourceCacheRoot } from "../../src/omp-source-cache.ts";
import { packageSourceRevision } from "../../scripts/package-release.ts";
import { checkPackagedExtensionLoads } from "../../scripts/package-release.ts";
import { cleanupAllOwnedTmp, ownedTmp } from "../../src/kitlib/tmp.ts";
import { run as runBounded } from "../../src/kitlib/run.ts";

const repo = resolve(import.meta.dir, "../..");
const caseCwd = process.env.OMP_KIT_CASE_CWD || process.env.GITHUB_WORKSPACE || repo;
const sourceCacheRoot = ompSourceCacheRoot(process.env);
const nativeCacheEnv = sourceCacheRoot ? { OMP_KIT_OMP_SRC_CACHE: resolve(sourceCacheRoot) } : {};
const scratch = resolve(import.meta.dir, "../../var/agent-tmp");
const outputTmp = ownedTmp("p21-release", { root: scratch });
const output = outputTmp.path;
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
	if (exported === undefined)
		expect(sourceGit(repo, ["rev-parse", "--show-toplevel"]).toString().trim()).toBe(repo);
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
		cwd: output, env: { ...process.env, OMP_KIT_TEST_WORK_ROOT: output, TMPDIR: output }, stdout: "pipe", stderr: "pipe",
	});
	expect(built.exitCode, built.stdout.toString() + built.stderr.toString()).toBe(0);
	expect(readdirSync(output).filter(name => name.startsWith("omp-kit-work."))).toEqual([]);
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
	try {
		if (existsSync(archived)) sourceTree(archived, "release");
	} finally {
		try { outputTmp.cleanup(); }
		finally { cleanupAllOwnedTmp(); }
	}
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
	expect(readdirSync(output).filter(name => name.startsWith("kit-stage."))).toHaveLength(1);
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
	const previousWorkRoot = process.env.OMP_KIT_TEST_WORK_ROOT;
	const previousCaseCwd = process.env.OMP_KIT_CASE_CWD;
	let generated: Buffer;
	try {
		process.env.OMP_KIT_TEST_WORK_ROOT = output;
		process.env.OMP_KIT_CASE_CWD = repo;
		generated = packageRuleManifest(selected, output);
	} finally {
		if (previousWorkRoot === undefined) delete process.env.OMP_KIT_TEST_WORK_ROOT;
		else process.env.OMP_KIT_TEST_WORK_ROOT = previousWorkRoot;
		if (previousCaseCwd === undefined) delete process.env.OMP_KIT_CASE_CWD;
		else process.env.OMP_KIT_CASE_CWD = previousCaseCwd;
	}
	const generatedRow = generated.toString("utf8").split("\n").find(row => row.startsWith("fixture\t"))!;
	expect(generatedRow.split("\t").slice(0, 3)).toEqual(["fixture", changedHash, "always"]);
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

type Candidate = { home: string; installedRoot: string; installedBinary: string };
function installArgs(name: string): { home: string; prefix: string; command: string[]; options: { cwd: string; env: Record<string, string | undefined> } } {
	const home = join(output, name);
	mkdirSync(home);
	const prefix = join(home, ".local", "opt", "omp-kit");
	return { home, prefix, command: ["sh", join(repo, "installer", "install.sh"), "--version", "1.2.3",
		"--index", indexPath, "--offline", join(output, asset.filename), "--prefix", prefix],
	options: { cwd: output, env: { ...process.env, PATH: authorityPath, HOME: home, TMPDIR: output, OMP: "", OMP_BIN: "", OMP_PATH: "", OMP_SRC: "" } } };
}
function installCandidate(name: string): Candidate {
	const { home, prefix, command, options } = installArgs(name);
	const installed = Bun.spawnSync(command, { ...options, stdout: "pipe", stderr: "pipe" });
	expect(installed.exitCode, installed.stdout.toString() + installed.stderr.toString()).toBe(0);
	return { home, installedRoot: join(prefix, "releases", "1.2.3"), installedBinary: join(prefix, "bin", "omp-kit") };
}
type Run = { exitCode: number | null; stdout: string; stderr: string };
async function run(command: string[], options: { cwd: string; env: Record<string, string | undefined> }): Promise<Run> {
	const child = Bun.spawn(command, { ...options, stdout: "pipe", stderr: "pipe" });
	const [stdout, stderr, exitCode] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
	return { exitCode, stdout, stderr };
}
// Each candidate below needs its own pristine install; the installs are independent, so they
// run concurrently once here instead of serially inside the per-test time budget.
const PREINSTALLED = ["operator-home", "drift-home", "bounded-home", "bounded-watched-home"] as const;
const preinstalled = new Map<string, Candidate>();
beforeAll(async () => {
	await Promise.all(PREINSTALLED.map(async name => {
		const { home, prefix, command, options } = installArgs(name);
		const installed = await run(command, options);
		expect(installed.exitCode, installed.stdout + installed.stderr).toBe(0);
		preinstalled.set(name, { home, installedRoot: join(prefix, "releases", "1.2.3"), installedBinary: join(prefix, "bin", "omp-kit") });
	}));
}, 30_000);
function candidate(name: (typeof PREINSTALLED)[number]): Candidate {
	const found = preinstalled.get(name);
	expect(found, `preinstalled candidate ${name}`).toBeDefined();
	return found!;
}
function candidateEnv(home: string, extra: Record<string, string> = {}): Record<string, string | undefined> {
	return { ...process.env, ...nativeCacheEnv, HOME: home, XDG_STATE_HOME: join(home, "xdg-state"),
		XDG_CACHE_HOME: join(home, "xdg-cache"), OMP: "", OMP_BIN: "", OMP_PATH: "", OMP_SRC: "", ...extra };
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

test("installed integrations and invariant gate run from the package", async () => {
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
	const packageEnv = { ...process.env, ...nativeCacheEnv, HOME: home, TMPDIR: output, TMP: output, TEMP: output,
		XDG_STATE_HOME: join(home, "xdg-state"), XDG_CACHE_HOME: join(home, "xdg-cache"),
		OMP_KIT_CASE_CWD: caseCwd, OMP_KIT_TEST_WORK_ROOT: output, PATH: ladderPath };
	const appliedEnv: Record<string, string> = {};
	for (const [name, value] of Object.entries(packageEnv)) {
		if (value !== undefined) appliedEnv[name] = value;
	}
	const appliedRules = await runBounded([installedBinary, "apply", "rules", "--apply", "--yes", "--json"], {
		cwd: home, env: appliedEnv, deadline_s: 120,
	});
	const applyStdout = new TextDecoder().decode(appliedRules.stdout);
	const applyStderr = new TextDecoder().decode(appliedRules.stderr);
	expect(appliedRules.rc, `${applyStdout}\n${applyStderr}`).toBe(0);
	const full = Bun.spawnSync([installedBinary, "test", "--full", "--json"], {
		cwd: home,
		env: { ...packageEnv, OMP: ompIdentity.launcher, OMP_BIN: ompIdentity.launcher,
			OMP_PATH: ompIdentity.launcher, OMP_SRC: ompIdentity.source },
		stdout: "pipe", stderr: "pipe",
	});
	const fullOutput = `${full.stdout.toString()}\n${full.stderr.toString()}`;
	expect(full.exitCode, fullOutput).toBe(0);
	const fullReport = JSON.parse(full.stdout.toString()).data.test;
	expect(fullReport.producer.stdout).toContain("GREEN flywheel-invariants");
	expect(fullReport.stages.manifest.status).toBe("PASS");
	expect(fullReport.producer.result_ref).toMatchObject({
		source_revision: sourceRevision, producer_exit: 0, runner_exit: 0,
		execution_capture_complete: true, missing_fields: [], failing_names: [],
		counts: { protocol: "OMP_KIT_CASES", unit: "TEST_CASE_EXECUTION", fail: 0 },
		retention: { status: "UNRETAINED", durable: false },
	});
// The full ladder runs the complete e2e-live suite (~200 s locally); same budget as kit-update's N+2 journey.
}, 900_000);

test("native full-test retains a real named failing case without counting later stages as skips", () => {
	const { home, installedBinary } = installCandidate("named-failure-home");
	const identity = resolveOmpIdentity(process.env);
	const faultBin = join(output, "archived-source", "tests", "fixtures", "full-test-claim-failure");
	const failed = Bun.spawnSync([installedBinary, "test", "--full", "--json"], {
		cwd: home, env: { ...process.env, ...nativeCacheEnv, HOME: home, TMPDIR: output,
			XDG_STATE_HOME: join(home, "xdg-state"), XDG_CACHE_HOME: join(home, "xdg-cache"),
			OMP_KIT_CASE_CWD: caseCwd, OMP_KIT_TEST_WORK_ROOT: output,
			PATH: [faultBin, join(home, ".local", "opt", "omp-kit", "bin"), process.env.PATH ?? ""].join(delimiter),
			OMP: identity.launcher, OMP_BIN: identity.launcher, OMP_PATH: identity.launcher, OMP_SRC: identity.source },
		stdout: "pipe", stderr: "pipe",
	});
	expect(failed.exitCode, failed.stdout.toString() + failed.stderr.toString()).toBe(1);
	const report = JSON.parse(failed.stdout.toString()).data.test;
	expect(report.status).toBe("FAIL");
	expect(report.stages["claim-selftest"]).toMatchObject({ status: "FAIL", producer_rc: 1 });
	expect(report.stages["cli-crosscheck"].status).toBe("NOT_RUN");
	const reference = report.producer.result_ref;
	expect(reference).toMatchObject({
		source_revision: sourceRevision, producer_exit: 1, runner_exit: 1,
		execution_capture_complete: true, missing_fields: [],
		counts: { protocol: "OMP_KIT_CASES", unit: "TEST_CASE_EXECUTION", fail: 1, skip: 0 },
		failing_names: ["claim-selftest: unmatched-pattern"],
		retention: { status: "UNRETAINED", durable: false },
	});
	for (const name of ["stdout", "stderr"] as const) {
		const stream = reference[name];
		const stored = readFileSync(stream.path);
		expect(stored.byteLength).toBe(stream.bytes);
		expect(createHash("sha256").update(stored).digest("hex")).toBe(stream.sha256);
		expect(stream.identity_matches).toBe(true);
		expect(stream.capture_complete).toBe(true);
	}
	expect(readFileSync(reference.stdout.path, "utf8")).toContain("SELFTEST_FAIL: planted unmatched enforce=yes row was accepted");
}, 120_000);

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

test("installed candidate fast proof and planted rule drift fail the full check without live execution or mutation", async () => {
	// The fast proof needs a pristine candidate and the full check a drifted one; two installs of
	// the same archive let the two independent runs proceed concurrently.
	const { home, installedRoot, installedBinary } = candidate("operator-home");
	const drifted = candidate("drift-home");
	appendFileSync(join(drifted.installedRoot, "rules", "kit-close-needs-evidence.md"), "\n# planted post-package rule drift\n");
	const [fast, red] = await Promise.all([
		run([installedBinary, "test", "--json"], { cwd: output, env: candidateEnv(home, { OMP_KIT_CASE_CWD: caseCwd }) }),
		run([drifted.installedBinary, "test", "--full", "--json"], { cwd: output, env: candidateEnv(drifted.home, { OMP_KIT_CASE_CWD: caseCwd }) }),
	]);
	expect(fast.exitCode, fast.stdout + fast.stderr).toBe(0);
	const corpus = countCaseRows(readFileSync(join(installedRoot, "cases", "cases.tsv"), "utf8"));
	const ruleCount = readdirSync(join(installedRoot, "rules")).filter((name) => name.endsWith(".md")).length;
	expect(ruleCount).toBeGreaterThan(0);
	expect(JSON.parse(fast.stdout).data.test.proofs).toMatchObject({
		G1_registration: { status: "PASS", observed_rules: ruleCount },
		G2_payload: { status: "PASS", expected_cases: corpus.cases, observed_cases: corpus.cases },
		G3_quiet_prefix: { status: "PASS", expected_cases: corpus.cases, expected_quiet_cases: corpus.quietCases,
			observed_cases: corpus.cases, observed_quiet_cases: corpus.quietCases, quiet_prefix_fires: 0 },
		G4_live: { status: "NOT_RUN" },
	});
	expect(red.exitCode, red.stdout + red.stderr).toBe(1);
	const report = JSON.parse(red.stdout).data.test;
	expect(report.status).toBe("FAIL");
	expect(report.proofs.G4_live.status).toBe("NOT_RUN");
	expect(report.snapshots.release).toEqual({ unchanged: true, complete: true });
	expect(report.snapshots.home.unchanged).toBe(true);
	expect(report.snapshots.home.complete).toBe(true);
});

test("oversized operator files bound the watched snapshot only where the kit could write", async () => {
	// Two drifted candidates: one holds only the unwatched oversized file, the other holds it
	// plus an oversized watched file, so both bounded snapshots are observed concurrently.
	const homes = [candidate("bounded-home"), candidate("bounded-watched-home")];
	for (const { home, installedRoot } of homes) {
		appendFileSync(join(installedRoot, "rules", "kit-close-needs-evidence.md"), "\n# planted post-package rule drift\n");
		const unwatched = join(home, "large-private-file");
		writeFileSync(unwatched, "");
		truncateSync(unwatched, 600 * 1024 * 1024);
	}
	const watchedHome = homes[1]!.home;
	mkdirSync(join(watchedHome, ".agents", "rules"), { recursive: true });
	const watched = join(watchedHome, ".agents", "rules", "oversized.md");
	writeFileSync(watched, "");
	truncateSync(watched, 512 * 1024 * 1024 + 1);
	const [ignored, bounded] = await Promise.all(homes.map(({ home, installedBinary }) =>
		run([installedBinary, "test", "--full", "--json"], { cwd: output, env: candidateEnv(home) })));
	expect(ignored!.exitCode, ignored!.stdout + ignored!.stderr).toBe(1);
	expect(JSON.parse(ignored!.stdout).data.test.snapshots.home).toMatchObject({ unchanged: true, complete: true, incomplete_paths: [] });
	expect(bounded!.exitCode, bounded!.stdout + bounded!.stderr).toBe(1);
	expect(JSON.parse(bounded!.stdout).data.test.snapshots.home).toMatchObject({ unchanged: true, complete: false, incomplete_paths: ["~/.agents/rules"] });
});

test("release SBOM is SPDX 2.3 and names the exact archive, runtime, binary, and every manifest file", () => {
	const sbomPath = join(output, `${asset.filename}.sbom.spdx.json`);
	expect(existsSync(sbomPath)).toBe(true);
	const sbom = JSON.parse(readFileSync(sbomPath, "utf8")) as { spdxVersion: string; packages: { SPDXID: string; versionInfo?: string; checksums?: { algorithm: string; checksumValue: string }[] }[];
		files: { fileName: string; checksums: { algorithm: string; checksumValue: string }[] }[] };
	expect(sbom.spdxVersion).toBe("SPDX-2.3");
	const shaOf = (pkg: { checksums?: { algorithm: string; checksumValue: string }[] }): string =>
		pkg.checksums?.find(sum => sum.algorithm === "SHA256")?.checksumValue ?? "";
	const byId = Object.fromEntries(sbom.packages.map(pkg => [pkg.SPDXID, pkg]));
	expect(shaOf(byId["SPDXRef-Archive"])).toBe(asset.sha256);
	expect(typeof byId["SPDXRef-Runtime-Bun"].versionInfo).toBe("string");
	expect(byId["SPDXRef-Runtime-Bun"].versionInfo!.length).toBeGreaterThan(0);
	const manifestRaw = Bun.spawnSync(["tar", "-xOf", join(output, asset.filename), "release-manifest.json"],
		{ cwd: output, stdout: "pipe", stderr: "pipe" });
	expect(manifestRaw.exitCode).toBe(0);
	const manifest = JSON.parse(manifestRaw.stdout.toString()) as { files: { path: string; sha256: string }[] };
	expect(shaOf(byId["SPDXRef-Binary"])).toBe(manifest.files.find(file => file.path === "bin/omp-kit")?.sha256);
	expect(sbom.files).toHaveLength(manifest.files.length);
	for (const file of manifest.files) {
		const listed = sbom.files.find(entry => entry.fileName === file.path);
		expect(listed, `SBOM omits bundled file ${file.path}`).toBeDefined();
		expect(shaOf(listed!)).toBe(file.sha256);
	}
	const verify = Bun.spawnSync(["sh", join(repo, "scripts", "verify-release.sh"), "--sbom", sbomPath, "--archive", join(output, asset.filename)],
		{ cwd: repo, stdout: "pipe", stderr: "pipe" });
	expect(verify.exitCode, verify.stdout.toString() + verify.stderr.toString()).toBe(0);
	expect(verify.stdout.toString()).toContain("VERIFY=ok");
	const planted = JSON.parse(JSON.stringify(sbom));
	planted.packages.find((pkg: { SPDXID: string }) => pkg.SPDXID === "SPDXRef-Archive").checksums[0].checksumValue = "0".repeat(64);
	const plantedPath = join(output, "planted-tampered.spdx.json");
	writeFileSync(plantedPath, `${JSON.stringify(planted)}\n`);
	const refused = Bun.spawnSync(["sh", join(repo, "scripts", "verify-release.sh"), "--sbom", plantedPath, "--archive", join(output, asset.filename)],
		{ cwd: repo, stdout: "pipe", stderr: "pipe" });
	expect(refused.exitCode).toBe(1);
	expect(refused.stderr.toString()).toContain("SBOM_ARCHIVE_MISMATCH");
}, 60_000);

test("detached signatures verify on a fresh copy; planted tampering, wrong keys, and missing sigs fail", () => {
	const archived = join(output, "archived-source");
	const signed = join(output, "signed-release");
	const stranger = join(output, "stranger-release");
	const fresh = join(output, "fresh-release");
	for (const directory of [signed, stranger, fresh]) mkdirSync(directory, { recursive: true });
	const { privateKey, publicKey } = generateKeyPairSync("ed25519");
	const { publicKey: wrongPublic } = generateKeyPairSync("ed25519");
	const keyPath = join(signed, "release.key");
	const pubPath = join(signed, "release.pub");
	const wrongPubPath = join(signed, "stranger.pub");
	writeFileSync(keyPath, privateKey.export({ format: "pem", type: "pkcs8" }));
	writeFileSync(pubPath, publicKey.export({ format: "pem", type: "spki" }));
	writeFileSync(wrongPubPath, wrongPublic.export({ format: "pem", type: "spki" }));
	const built = Bun.spawnSync(["sh", join(archived, "scripts", "package-release.sh"), "--version", "9.9.9", "--platform", key, "--out", signed, "--sign-key", keyPath], {
		cwd: output, env: { ...process.env, TMPDIR: output }, stdout: "pipe", stderr: "pipe",
	});
	expect(built.exitCode, built.stdout.toString() + built.stderr.toString()).toBe(0);
	const receipt = JSON.parse(built.stdout.toString()) as ReleaseAsset;
	const sbomName = `${receipt.filename}.sbom.spdx.json`;
	const archiveSig = `${receipt.filename}.sig`;
	const sbomSig = `${sbomName}.sig`;
	for (const name of [receipt.filename, sbomName, archiveSig, sbomSig]) {
		expect(existsSync(join(signed, name)), `missing sidecar ${name}`).toBe(true);
	}
	for (const name of [receipt.filename, sbomName, archiveSig, sbomSig, "release.pub"]) {
		const copied = Bun.spawnSync(["cp", join(signed, name), fresh], { stdout: "pipe", stderr: "pipe" });
		expect(copied.exitCode).toBe(0);
	}
	for (const [kind, name, signame] of [["archive", receipt.filename, archiveSig], ["sbom", sbomName, sbomSig]] as const) {
		const ok = Bun.spawnSync(["sh", join(repo, "scripts", "verify-release.sh"), "--pubkey", join(fresh, "release.pub"),
			"--file", join(fresh, name), "--sig", join(fresh, signame)], { cwd: repo, stdout: "pipe", stderr: "pipe" });
		expect(ok.exitCode, `${kind}: ` + ok.stdout.toString() + ok.stderr.toString()).toBe(0);
		expect(ok.stdout.toString()).toContain("VERIFY=ok");
	}
	const tampered = join(stranger, receipt.filename);
	Bun.spawnSync(["cp", join(fresh, receipt.filename), tampered], { stdout: "pipe", stderr: "pipe" });
	const bytes = readFileSync(tampered);
	bytes[bytes.length - 1030] ^= 1;
	writeFileSync(tampered, bytes);
	Bun.spawnSync(["cp", join(fresh, archiveSig), stranger], { stdout: "pipe", stderr: "pipe" });
	const dirty = Bun.spawnSync(["sh", join(repo, "scripts", "verify-release.sh"), "--pubkey", join(fresh, "release.pub"),
		"--file", tampered, "--sig", join(stranger, archiveSig)], { cwd: repo, stdout: "pipe", stderr: "pipe" });
	expect(dirty.exitCode).toBe(1);
	expect(dirty.stderr.toString()).toContain("SIGNATURE_MISMATCH");
	const wrongKey = Bun.spawnSync(["sh", join(repo, "scripts", "verify-release.sh"), "--pubkey", wrongPubPath,
		"--file", join(fresh, receipt.filename), "--sig", join(fresh, archiveSig)], { cwd: repo, stdout: "pipe", stderr: "pipe" });
	expect(wrongKey.exitCode).toBe(1);
	expect(wrongKey.stderr.toString()).toContain("SIGNATURE_MISMATCH");
	const missing = Bun.spawnSync(["sh", join(repo, "scripts", "verify-release.sh"), "--pubkey", join(fresh, "release.pub"),
		"--file", join(fresh, receipt.filename), "--sig", join(fresh, "no-such.sig")], { cwd: repo, stdout: "pipe", stderr: "pipe" });
	expect(missing.exitCode).toBe(1);
	expect(missing.stderr.toString()).toContain("SIG_NOT_FOUND");
}, 120_000);

test("GUARDLOAD1: bundled kit-flywheel-guard carries no ../src/ escape and loads with no src/ present", async () => {
	const bundled = await Bun.build({ entrypoints: [join(repo, "extensions", "kit-flywheel-guard.ts")],
		target: "bun", format: "esm", minify: false });
	expect(bundled.success).toBe(true);
	expect(bundled.outputs.length).toBe(1);
	const text = await bundled.outputs[0]!.text();
	expect(text).not.toContain("../src/");
	expect(text).toContain("export");
	const root = ownedTmp("gate-shipped", { root: output }).path;
	mkdirSync(join(root, "extensions"), { recursive: true });
	writeFileSync(join(root, "extensions", "kit-flywheel-guard.ts"), text);
	expect(checkPackagedExtensionLoads(root)).toEqual([]);
});

test("GUARDLOAD1: extension load gate fails a ../src/ escape naming file and module, passes a bundled tree", () => {
	const broken = ownedTmp("gate-broken", { root: output }).path;
	const fixed = ownedTmp("gate-fixed", { root: output }).path;
	for (const root of [broken, fixed]) mkdirSync(join(root, "extensions"), { recursive: true });
	writeFileSync(join(broken, "extensions", "kit-flywheel-guard.ts"),
		'import { ccSpool } from "../src/cc-spool.ts";\nexport const guard = ccSpool;\n');
	writeFileSync(join(broken, "extensions", "kit-flywheel-guard.test.ts"),
		'import { expect, test } from "bun:test";\ntest("skip", () => { expect(1).toBe(1); });\n');
	writeFileSync(join(fixed, "extensions", "kit-flywheel-guard.ts"),
		'export function ccSpool(): null { return null; }\nexport const guard = ccSpool;\n');
	const brokenFailures = checkPackagedExtensionLoads(broken);
	expect(brokenFailures.map(failure => failure.file)).toEqual(["extensions/kit-flywheel-guard.ts"]);
	expect(brokenFailures[0]?.error ?? "").toContain("../src/cc-spool.ts");
	expect(checkPackagedExtensionLoads(fixed)).toEqual([]);
});
