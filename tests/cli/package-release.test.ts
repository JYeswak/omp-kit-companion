import { afterAll, beforeAll, expect, test } from "bun:test";
import { appendFileSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, truncateSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { join, resolve } from "node:path";
import { previewKitRelease, stageKitRelease, type ReleaseAsset, type ReleasePlatform } from "../../src/kit-release.ts";

const repo = resolve(import.meta.dir, "../..");
const scratch = resolve(import.meta.dir, "../../var/agent-tmp");
mkdirSync(scratch, { recursive: true });
const output = mkdtempSync(join(scratch, "p21-release-"));
const platform: ReleasePlatform = { os: process.platform as "darwin" | "linux", arch: process.arch as "arm64" | "x64", libc: process.platform === "darwin" ? "none" : "gnu" };
const key = `${platform.os}-${platform.arch}-${platform.libc}`;
const indexPath = join(output, "release-index.json");
let asset: ReleaseAsset;
let bytes: Buffer;
let index: { schema_version: number; version: string; source_tag: string; assets: Record<string, ReleaseAsset> };

beforeAll(() => {
	const built = Bun.spawnSync(["sh", join(repo, "scripts", "package-release.sh"), "--version", "1.2.3", "--platform", key, "--out", output], {
		cwd: repo, env: { ...process.env, TMPDIR: scratch }, stdout: "pipe", stderr: "pipe",
	});
	expect(built.exitCode, built.stdout.toString() + built.stderr.toString()).toBe(0);
	asset = JSON.parse(built.stdout.toString()) as ReleaseAsset;
	bytes = readFileSync(join(output, asset.filename));
	expect(createHash("sha256").update(bytes).digest("hex")).toBe(asset.sha256);
	index = { schema_version: 1, version: "1.2.3", source_tag: "v1.2.3", assets: { [key]: asset } };
	writeFileSync(indexPath, `${JSON.stringify(index)}\n`);
});
afterAll(() => rmSync(output, { recursive: true, force: true }));

test("native release contains only declared regular files, runs relocated binary, and refuses one corrupted archive byte", async () => {
	const plan = await previewKitRelease({ currentVersion: "1.2.2", platform, sourceTag: "v1.2.3", fetchIndex: async () => index });
	expect(plan.exitCode).toBe(0);
	const staged = await stageKitRelease({ archive: bytes, plan, stagingParent: output, probeBinaryInfo: async (binary) => {
		const child = Bun.spawnSync([binary, "--info", "--json"], { cwd: output, env: { ...process.env, HOME: output }, stdout: "pipe", stderr: "pipe" });
		expect(child.exitCode, child.stdout.toString() + child.stderr.toString()).toBe(0);
		const info = JSON.parse(child.stdout.toString()).data;
		return { version: info.version, source_tag: info.release.source_tag, platform: info.platform };
	} });
	expect(staged.executable).toBe(join(staged.root, "bin", "omp-kit"));
	expect(staged.manifest.files.map(file => file.path)).toEqual([...staged.manifest.files.map(file => file.path)].sort());
	expect(lstatSync(join(staged.root, "scripts", "runtime-adapter.sh")).mode & 0o111).toBeGreaterThan(0);
	for (const forbidden of ["reports/", ".git/", ".beads/", "var/", "src/", "private/"])
		expect(staged.files.some(file => file.startsWith(forbidden))).toBe(false);
	for (const essential of ["bin/omp-kit", "scripts/runtime-adapter.sh", "scripts/e2e-live.sh", "scripts/ladder.sh",
		"scripts/limit-process-tree.sh", "scripts/external-live.mjs", "checkers/check-readiness.sh", "checkers/check-claim-discipline.sh",
		"tests/live/mock-model.mjs", "MANIFEST.tsv", "cases/cases.tsv", "LICENSE"])
		expect(staged.files).toContain(essential);
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
		cwd: output, env: { ...process.env, HOME: home, TMPDIR: scratch }, stdout: "pipe", stderr: "pipe",
	});
	expect(installed.exitCode, installed.stdout.toString() + installed.stderr.toString()).toBe(0);
	return { home, installedRoot: join(prefix, "releases", "1.2.3"), installedBinary: join(prefix, "bin", "omp-kit") };
}

test("installed candidate fast proof and planted rule drift fail the full check without live execution or mutation", () => {
	const { home, installedRoot, installedBinary } = installCandidate("operator-home");
	const fast = Bun.spawnSync([installedBinary, "test", "--json"], {
		cwd: output, env: { ...process.env, HOME: home, XDG_STATE_HOME: join(home, "xdg-state"),
			XDG_CACHE_HOME: join(home, "xdg-cache"), OMP: "", OMP_BIN: "", OMP_PATH: "", OMP_SRC: "" },
		stdout: "pipe", stderr: "pipe",
	});
	expect(fast.exitCode, fast.stdout.toString() + fast.stderr.toString()).toBe(0);
	expect(JSON.parse(fast.stdout.toString()).data.test.proofs).toMatchObject({
		G1_registration: { status: "PASS", observed_rules: 18 },
		G2_payload: { status: "PASS", observed_cases: 278 },
		G3_quiet_prefix: { status: "PASS", observed_quiet_cases: 140, quiet_prefix_fires: 0 },
		G4_live: { status: "NOT_RUN" },
	});
	appendFileSync(join(installedRoot, "rules", "kit-close-needs-evidence.md"), "\n# planted post-package rule drift\n");
	const red = Bun.spawnSync([installedBinary, "test", "--full", "--json"], {
		cwd: output, env: { ...process.env, HOME: home, XDG_STATE_HOME: join(home, "xdg-state"),
			XDG_CACHE_HOME: join(home, "xdg-cache"), OMP: "", OMP_BIN: "", OMP_PATH: "", OMP_SRC: "" },
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
