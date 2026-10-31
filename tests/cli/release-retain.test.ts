import { afterEach, expect, test } from "bun:test";
import { chmodSync, copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, statSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { kitUpdateJobOverall, runKitUpdateJob, type KitUpdateJobConfig, type KitUpdateJobDependencies } from "../../src/kit-update-job.ts";
import { ownedTmp, type OwnedTmp } from "../../src/kitlib/tmp.ts";
import { run } from "../../src/kitlib/run.ts";

const roots: OwnedTmp[] = [];
afterEach(() => { for (const root of roots.splice(0)) root.cleanup(); });

function fixture(versions = ["1.0.0", "1.0.1", "1.0.2", "1.0.3", "1.0.4", "1.0.5", "1.1.0"], active = "1.0.5", pollVersions = versions) {
	const owned = ownedTmp("release-retain"); roots.push(owned);
	const prefix = realpathSync(owned.path);
	const stateRoot = join(prefix, "state");
	mkdirSync(stateRoot, { mode: 0o700 });
	for (const version of versions) {
		const bin = join(prefix, "releases", version, "bin");
		mkdirSync(bin, { recursive: true });
		writeFileSync(join(bin, "omp-kit"), version, { mode: 0o555 });
		chmodSync(bin, 0o555); chmodSync(dirname(bin), 0o555);
	}
	for (const version of pollVersions) {
		mkdirSync(join(stateRoot, `poll-${version}`), { recursive: true });
		writeFileSync(join(stateRoot, `poll-${version}`, "archive.tar"), version);
	}
	mkdirSync(join(prefix, "bin"));
	const stable = join(prefix, "bin", "omp-kit");
	symlinkSync("../releases/1.0.0/bin/omp-kit", stable);
	const config: KitUpdateJobConfig = {
		enabled: true, prefix, stateRoot, home: prefix,
		platform: { os: "darwin", arch: "arm64", libc: "none" },
		pollRelease: async () => ({ indexPath: join(prefix, "index.json"), archivePath: join(prefix, "kit.tar"), version: active, sourceTag: `v${active}` }),
	};
	const dependencies: KitUpdateJobDependencies = {
		plan: async input => ({
			...input, status: "UPDATE_AVAILABLE", exitCode: 0, provenance: "INTEGRITY_ONLY",
			current: { version: "1.0.0", sha256: "a".repeat(64), target: "../releases/1.0.0/bin/omp-kit", binary: stable },
			release: {
				exitCode: 0, status: "UPDATE_AVAILABLE", currentVersion: "1.0.0", version: active, sourceTag: `v${active}`, provenance: "INTEGRITY_ONLY",
				platform: input.platform, indexSha256: "b".repeat(64),
				asset: { ...input.platform, filename: "kit.tar", sha256: "c".repeat(64), manifest_sha256: "d".repeat(64) },
			},
		}),
		apply: async () => {
			unlinkSync(stable); symlinkSync(`../releases/${active}/bin/omp-kit`, stable);
			return { status: "UPDATED", exitCode: 0, receiptId: "retention-fixture", activeVersion: active, postcheck: { status: "PASS", matcher: "PASS", live: "PASS" }, provenance: "INTEGRITY_ONLY" };
		},
		relink: async () => ({ ok: true, detail: "fixture profile relink", receiptId: "fixture-plugin", undoCommand: "omp-kit undo fixture-plugin --yes" }),
		reconcile: async () => ({ ok: true, detail: "fixture service reconcile" }),
		refreshHooks: async () => ({ repos: 0, refreshed: 0, fresh: 0, pending_commit: 0, failed: 0, results: [] }),
	};
	return { prefix, stateRoot, config, dependencies };
}

test("successful update retires older read-only releases and matching polls, preserving two predecessors", async () => {
	const f = fixture();
	const result = await runKitUpdateJob(f.config, f.dependencies);
	expect(result.status).toBe("UPDATED");
	expect(readdirSync(join(f.prefix, "releases")).sort()).toEqual(["1.0.3", "1.0.4", "1.0.5", "1.1.0"]);
	for (const version of ["1.0.0", "1.0.1", "1.0.2"]) expect(existsSync(join(f.stateRoot, `poll-${version}`))).toBe(false);
	for (const version of ["1.0.3", "1.0.4", "1.0.5", "1.1.0"]) {
		expect(readFileSync(join(f.prefix, "releases", version, "bin", "omp-kit"), "utf8")).toBe(version);
		expect(readFileSync(join(f.stateRoot, `poll-${version}`, "archive.tar"), "utf8")).toBe(version);
	}
});

test("a partial update preserves all release and poll recovery artifacts", async () => {
	const f = fixture();
	f.dependencies.apply = async () => ({
		status: "PARTIAL", exitCode: 1, receiptId: "partial-fixture", activeVersion: "1.0.5",
		postcheck: { status: "FAIL", matcher: "FAIL", live: "NOT_RUN" }, provenance: "INTEGRITY_ONLY",
	});
	f.dependencies.reconcileReceipt = () => { throw new Error("fixture postimage mismatch"); };
	const before = readdirSync(join(f.prefix, "releases")).sort();
	const result = await runKitUpdateJob(f.config, f.dependencies);
	expect(result.status).toBe("PENDING");
	expect(readdirSync(join(f.prefix, "releases")).sort()).toEqual(before);
	for (const version of before) expect(readFileSync(join(f.stateRoot, `poll-${version}`, "archive.tar"), "utf8")).toBe(version);
});

test("retention failure cannot report an overall clean update or delete through an unverified active link", async () => {
	const f = fixture();
	f.dependencies.apply = async () => ({
		status: "UPDATED", exitCode: 0, receiptId: "wrong-link-fixture", activeVersion: "1.0.5",
		postcheck: { status: "PASS", matcher: "PASS", live: "PASS" }, provenance: "INTEGRITY_ONLY",
	});
	const before = readdirSync(join(f.prefix, "releases")).sort();
	const result = await runKitUpdateJob(f.config, f.dependencies);
	expect(kitUpdateJobOverall(result)).toBe("FINDINGS");
	expect(result.retention).toMatchObject({ status: "FAILED", reason: "KIT_RETENTION_ACTIVE_UNVERIFIED" });
	expect(readdirSync(join(f.prefix, "releases")).sort()).toEqual(before);
	for (const version of before) expect(existsSync(join(f.stateRoot, `poll-${version}`))).toBe(true);
});

test("old poll orphans are removed but unrelated names and symlink targets are untouched", async () => {
	const f = fixture();
	const outside = join(f.prefix, "outside");
	mkdirSync(outside); writeFileSync(join(outside, "keep"), "outside sentinel"); chmodSync(outside, 0o555);
	const oldBin = join(f.prefix, "releases", "1.0.1", "bin");
	chmodSync(oldBin, 0o755); symlinkSync(outside, join(oldBin, "outside-link")); chmodSync(oldBin, 0o555);
	for (const name of ["operator-data", "0.0.1\n", "0.0.9007199254740993"]) {
		mkdirSync(join(f.prefix, "releases", name)); writeFileSync(join(f.prefix, "releases", name, "keep"), name);
	}
	symlinkSync(outside, join(f.prefix, "releases", "0.0.9"));
	symlinkSync(outside, join(f.stateRoot, "poll-0.0.9"));
	mkdirSync(join(f.stateRoot, "poll-0.0.8")); writeFileSync(join(f.stateRoot, "poll-0.0.8", "archive.tar"), "orphan");
	const result = await runKitUpdateJob(f.config, f.dependencies);
	expect(existsSync(join(f.stateRoot, "poll-0.0.8"))).toBe(false);
	expect(result.retention?.status).toBe("APPLIED");
	expect(readFileSync(join(outside, "keep"), "utf8")).toBe("outside sentinel");
	expect(statSync(outside).mode & 0o777).toBe(0o555);
	expect(readFileSync(join(f.prefix, "releases", "0.0.9", "keep"), "utf8")).toBe("outside sentinel");
	expect(readFileSync(join(f.stateRoot, "poll-0.0.9", "keep"), "utf8")).toBe("outside sentinel");
	for (const name of ["operator-data", "0.0.1\n", "0.0.9007199254740993"]) {
		expect(readFileSync(join(f.prefix, "releases", name, "keep"), "utf8")).toBe(name);
	}
});

test("the actual running executable survives even when older than the two rollback releases", async () => {
	const f = fixture();
	const executable = join(f.prefix, "releases", "1.0.0", "bin", "omp-kit");
	chmodSync(executable, 0o755);
	copyFileSync(realpathSync(process.execPath), executable);
	const before = statSync(executable);
	const stable = join(f.prefix, "bin", "omp-kit");
	unlinkSync(stable); symlinkSync("../releases/1.0.3/bin/omp-kit", stable);
	const source = await f.config.pollRelease();
	if (!source || !f.dependencies.plan) throw new Error("release-retention fixture tuple is missing");
	const plan = await f.dependencies.plan({ ...f.config, ...source });
	const driver = join(f.prefix, "running-retention.mjs");
	writeFileSync(driver, `
import { runKitUpdateJob } from ${JSON.stringify(new URL("../../src/kit-update-job.ts", import.meta.url).href)};
import { symlinkSync, unlinkSync } from "node:fs";
import { join } from "node:path";
const { config, source, plan } = JSON.parse(process.argv[2]);
const result = await runKitUpdateJob({ ...config, pollRelease: async () => source }, {
	plan: async () => plan,
	apply: async () => {
		const stable = join(config.prefix, "bin", "omp-kit");
		unlinkSync(stable); symlinkSync("../releases/1.0.5/bin/omp-kit", stable);
		return { status: "UPDATED", exitCode: 0, receiptId: "running-fixture", activeVersion: "1.0.5",
			postcheck: { status: "PASS", matcher: "PASS", live: "PASS" }, provenance: "INTEGRITY_ONLY" };
	},
	relink: async () => ({ ok: true, detail: "fixture", receiptId: "plugin-fixture", undoCommand: "fixture undo" }),
	reconcile: async () => ({ ok: true, detail: "fixture" }),
	refreshHooks: async () => ({ repos: 0, refreshed: 0, fresh: 0, pending_commit: 0, failed: 0, results: [] }),
});
console.log(JSON.stringify({ executable: process.execPath, result }));
`);
	const childEnv: Record<string, string> = {};
	for (const [key, value] of Object.entries(process.env)) if (typeof value === "string") childEnv[key] = value;
	childEnv.OMP_KIT_UPDATE_POLL = "";
	const child = await run([executable, driver, JSON.stringify({ config: f.config, source, plan })],
		{ deadline_s: 30, cwd: f.prefix, env: childEnv });
	const stdout = new TextDecoder().decode(child.stdout), stderr = new TextDecoder().decode(child.stderr);
	expect(child.rc, stdout + stderr).toBe(0);
	const observed = JSON.parse(stdout);
	expect(observed.executable).toBe(executable);
	expect(statSync(executable).ino).toBe(before.ino);
	expect(statSync(executable).size).toBe(before.size);
	expect(existsSync(join(f.prefix, "releases", "1.0.1"))).toBe(false);
	expect(existsSync(join(f.prefix, "releases", "1.0.2"))).toBe(false);
	expect(observed.result.retention.status).toBe("APPLIED");
	expect(observed.result.retention.kept).toEqual(["1.0.0", "1.0.3", "1.0.4", "1.0.5", "1.1.0"]);
}, 45_000);

test("the original 49-release and 28-poll accumulation is pruned in numeric version order", async () => {
	const versions = Array.from({ length: 49 }, (_, patch) => `1.0.${patch}`);
	const f = fixture(versions, "1.0.48", versions.slice(0, 28));
	const result = await runKitUpdateJob(f.config, f.dependencies);
	expect(readdirSync(join(f.prefix, "releases")).sort()).toEqual(["1.0.46", "1.0.47", "1.0.48"]);
	expect(readdirSync(f.stateRoot).filter(name => name.startsWith("poll-"))).toEqual([]);
	expect(result.retention?.status).toBe("APPLIED");
	expect(result.retention?.removed.sort()).toEqual(versions.slice(0, 46).sort());
});
