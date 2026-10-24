import { afterAll, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { performance } from "node:perf_hooks";
import { chmodSync, copyFileSync, cpSync, existsSync, mkdirSync, readFileSync, readlinkSync, realpathSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { runFullTest } from "../../src/full-test-runner.ts";
import { runFastTest } from "../../src/test-runner.ts";
import type { ReleaseAsset, ReleasePlatform } from "../../src/kit-release.ts";
import { acquireKitUpdateLock, auditMutations, beginKitUpdateReceipt, inspectPendingKitUpdate } from "../../src/mutations.ts";
import { applyKitUpdate, judgeKitPostcheck, kitUpdateEnvelope, planKitUpdate, undoKitUpdate, updateFailureCause } from "../../src/kit-update.ts";
import { kitUpdateJobOverall } from "../../src/kit-update-job.ts";
import { serviceLabel } from "../../src/service.ts";
import { CASE_HEADER } from "../../src/case-corpus.ts";
import { cleanupAllOwnedTmp, ownedTmp } from "../../src/kitlib/tmp";

test("unknown update failure preserves its code and original message", () => {
 expect(updateFailureCause(new Error("boom lower"))).toMatchObject({
  cause_code: "Error", cause_name: "Error", cause_message: "boom lower",
 });
});
const sha = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
const platform: ReleasePlatform = { os: "darwin", arch: "arm64", libc: "none" };

const hostPlatform: ReleasePlatform = process.platform === "darwin"
	? { os: "darwin", arch: process.arch === "arm64" ? "arm64" : "x64", libc: "none" }
	: { os: "linux", arch: process.arch === "arm64" ? "arm64" : "x64", libc: "gnu" };
const scratch = process.env.TMPDIR ?? join(import.meta.dir, "../../var/agent-tmp");
type FixtureFile = { name: string; bytes: Buffer };
type FixtureContext = { root: string; prefix: string; stateRoot: string; home: string; source: string;
	indexPath: string; archivePath: string; oldBinary: Buffer; contractFiles: FixtureFile[];
	platform: ReleasePlatform; currentVersion: string; nextVersion: string };
type FixtureOptions = { platform?: ReleasePlatform; currentVersion?: string; nextVersion?: string };

function tar(entries: { name: string; bytes: Buffer }[]): Buffer {
	const blocks: Buffer[] = [];
	for (const entry of entries) {
		const header = Buffer.alloc(512);
		header.write(entry.name, 0, 100);
		header.write("0000755\0", 100, "ascii");
		header.write("0000000\0", 108, "ascii");
		header.write("0000000\0", 116, "ascii");
		header.write(entry.bytes.length.toString(8).padStart(11, "0") + "\0", 124, "ascii");
		header.write("00000000000\0", 136, "ascii");
		header.fill(32, 148, 156);
		header.write("0", 156, "ascii");
		header.write("ustar\0", 257, "ascii");
		header.write("00", 263, "ascii");
		const sum = header.reduce((total, byte) => total + byte, 0);
		header.write(sum.toString(8).padStart(6, "0") + "\0 ", 148, "ascii");
		blocks.push(header, entry.bytes, Buffer.alloc((512 - entry.bytes.length % 512) % 512));
	}
	return Buffer.concat([...blocks, Buffer.alloc(1024)]);
}
function binary(version: string, selectedPlatform: ReleasePlatform = platform): Buffer {
	const info = JSON.stringify(JSON.stringify({ version, source_tag: "v" + version,
		platform: { os: selectedPlatform.os, arch: selectedPlatform.arch } }));
	return Buffer.from("#!/bin/sh\nprintf '%s\\n' " + info + "\n");
}
function manifest(version: string, executable: Buffer, extraFiles: readonly FixtureFile[] = []): Buffer {
	const files = [{ path: "bin/omp-kit", sha256: sha(executable) },
		...extraFiles.map(({ name, bytes }) => ({ path: name, sha256: sha(bytes) }))]
		.sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
	return Buffer.from(JSON.stringify({ schema_version: 1, version, source_tag: "v" + version, files }));
}
function fixtureContractFiles(): FixtureFile[] {
	const rule = Buffer.from("# Rule A\n");
	const manifestFile = Buffer.from("name\tsha256\tclass\tpack\nrule-a\t" + sha(rule) + "\ttripwire\t1234567\n");
	const cases = Buffer.from(CASE_HEADER + "\n" +
		"rule-a\tfire\ttext\t-\t-\tbr close x\tfixture fire\t\n" +
		"rule-a\tquiet\ttext\t-\t-\tbr list\tfixture quiet\t\n");
	return [{ name: "MANIFEST.tsv", bytes: manifestFile }, { name: "cases/cases.tsv", bytes: cases }, { name: "rules/rule-a.md", bytes: rule }];
}
async function fixture<T>(run: (ctx: FixtureContext) => Promise<T>, options: FixtureOptions = {}): Promise<T> {
	const directory = ownedTmp("kit-update", { root: scratch });
	const root = realpathSync(directory.path);
	const prefix = join(root, "prefix"), stateRoot = join(root, "state"), home = join(root, "home"), source = join(root, "source");
	const selectedPlatform = options.platform ?? platform;
	const currentVersion = options.currentVersion ?? "1.2.2", nextVersion = options.nextVersion ?? "1.2.3";
	mkdirSync(join(prefix, "bin"), { recursive: true });
	mkdirSync(join(prefix, "releases", currentVersion, "bin"), { recursive: true });
	mkdirSync(home);
	mkdirSync(source);
	const oldBinary = binary(currentVersion, selectedPlatform);
	writeFileSync(join(prefix, "releases", currentVersion, "bin", "omp-kit"), oldBinary, { mode: 0o755 });
	chmodSync(join(prefix, "releases", currentVersion, "bin", "omp-kit"), 0o755);
	writeFileSync(join(prefix, "releases", currentVersion, "release-manifest.json"), manifest(currentVersion, oldBinary));
	symlinkSync("../releases/" + currentVersion + "/bin/omp-kit", join(prefix, "bin", "omp-kit"));
	const contractFiles = fixtureContractFiles();
	const next = binary(nextVersion, selectedPlatform), releaseManifest = manifest(nextVersion, next, contractFiles);
	const archive = tar([{ name: "bin/omp-kit", bytes: next }, ...contractFiles, { name: "release-manifest.json", bytes: releaseManifest }]);
	const key = [selectedPlatform.os, selectedPlatform.arch, selectedPlatform.libc].join("-");
	const filename = "omp-kit-v" + nextVersion + "-" + key + ".tar";
	const archivePath = join(source, filename), indexPath = join(source, "release-index.json");
	writeFileSync(archivePath, archive);
	writeFileSync(`${archivePath}.sigstore.json`, JSON.stringify({ fixture: true }));
	writeFileSync(indexPath, JSON.stringify({ schema_version: 1, version: nextVersion, source_tag: "v" + nextVersion, assets: {
		[key]: { ...selectedPlatform, filename, sha256: sha(archive), manifest_sha256: sha(releaseManifest) },
	} }));
	const previousPath = process.env.PATH;
	process.env.PATH = join(import.meta.dir, "../fixtures/kit-release") + ":" + previousPath;
	try { return await run({ root, prefix, stateRoot, home, source, indexPath, archivePath, oldBinary, contractFiles,
		platform: selectedPlatform, currentVersion, nextVersion }); }
	finally {
		if (previousPath === undefined) delete process.env.PATH; else process.env.PATH = previousPath;
		directory.cleanup();
	}
}
const input = (ctx: FixtureContext) => ({ prefix: ctx.prefix, stateRoot: ctx.stateRoot, home: ctx.home,
	indexPath: ctx.indexPath, archivePath: ctx.archivePath, platform: ctx.platform,
	version: ctx.nextVersion, sourceTag: "v" + ctx.nextVersion });

function copyReleaseSource(sourceRoot: string, destination: string): void {
	mkdirSync(destination, { recursive: true });
	for (const directory of ["src", "installer", "scripts", "rules", "rules-fleet", "retired", "cases", "policy", "extensions", "examples", "checkers", "config", "skills", "tests/live", "plugins/omp-kit-tern"]) {
		const target = join(destination, directory);
		mkdirSync(dirname(target), { recursive: true });
		cpSync(join(sourceRoot, directory), target, { recursive: true });
	}
	mkdirSync(join(destination, "docs"), { recursive: true });
	for (const file of ["flywheel-invariants.tsv", "tern-integration.md", "tern-verb-map.md", "tern-coverage.tsv"])
		copyFileSync(join(sourceRoot, "docs", file), join(destination, "docs", file));
	for (const file of ["LICENSE", "MANIFEST.tsv", "MANIFEST.fleet.tsv", "package.json"]) {
		const target = join(destination, file);
		mkdirSync(dirname(target), { recursive: true });
		copyFileSync(join(sourceRoot, file), target);
	}
}

function buildNPlusTwoCandidate(ctx: FixtureContext): {
	root: string; executable: string; baseCases: number; baseQuiet: number;
	targetCases: number; targetQuiet: number; packageBuildDurationMs: number;
} {
	const sourceRoot = join(ctx.root, "candidate-source");
	copyReleaseSource(resolve(import.meta.dir, "../.."), sourceRoot);
	const casesPath = join(sourceRoot, "cases", "cases.tsv");
	const rawCases = readFileSync(casesPath, "utf8").replace(/\r\n/g, "\n").replace(/\n+$/, "");
	const caseLines = rawCases.split("\n");
	if (caseLines[0] !== CASE_HEADER) throw new Error("candidate cases fixture has an unknown schema");
	const rows = caseLines.slice(1).filter(row => row.trim() !== "" && !row.startsWith("#"));
	// These existing controls have no known metamorphic breaks; N+2 tests case-count drift only.
	const fire = rows.find(row => {
		const columns = row.split("\t");
		return columns[0] === "kit-close-needs-evidence" && columns[1] === "fire" && columns[5] === "br close x";
	});
	const quiet = rows.find(row => {
		const columns = row.split("\t");
		return columns[0] === "kit-close-needs-evidence" && columns[1] === "quiet" &&
			columns[5] === 'br close x --reason "cargo test -> 41 passed; commit a1b2c3d"';
	});
	if (!fire || !quiet) throw new Error("candidate cases fixture needs metamorphic-clean fire and quiet controls");
	const annotate = (row: string, label: string): string => {
		const columns = row.split("\t");
		columns[6] = ((columns[6] ?? "") + " " + label).trim();
		return columns.join("\t");
	};
	const baseCases = rows.length, baseQuiet = rows.filter(row => row.split("\t")[1] === "quiet").length;
	const additions = [annotate(fire, "U1-N-plus-two-fire"), annotate(quiet, "U1-N-plus-two-quiet")];
	const targetCases = baseCases + additions.length;
	const targetQuiet = baseQuiet + additions.filter(row => row.split("\t")[1] === "quiet").length;
	writeFileSync(casesPath, rawCases + "\n" + additions.join("\n") + "\n");
	const output = join(ctx.root, "candidate-package");
	mkdirSync(output);
	const key = [ctx.platform.os, ctx.platform.arch, ctx.platform.libc].join("-");
	const packageBuildStarted = performance.now();
	const build = Bun.spawnSync(["sh", join(sourceRoot, "scripts", "package-release.sh"), "--version", ctx.nextVersion,
		"--platform", key, "--out", output], { cwd: sourceRoot, env: { ...process.env, TMPDIR: ctx.root }, stdout: "pipe", stderr: "pipe" });
	const packageBuildDurationMs = Math.round(performance.now() - packageBuildStarted);
	if (build.exitCode !== 0) throw new Error("N+2 candidate package build failed: " + build.stdout.toString() + build.stderr.toString());
	const asset = JSON.parse(build.stdout.toString()) as { os: string; arch: string; libc: string; filename: string; sha256: string; manifest_sha256: string };
	const packagedArchive = join(output, asset.filename), archive = readFileSync(packagedArchive);
	writeFileSync(ctx.archivePath, archive);
	writeFileSync(ctx.indexPath, JSON.stringify({ schema_version: 1, version: ctx.nextVersion, source_tag: "v" + ctx.nextVersion, assets: { [key]: asset } }));
	const root = join(ctx.root, "candidate-release");
	mkdirSync(root);
	const extract = Bun.spawnSync(["tar", "xf", packagedArchive, "-C", root], { cwd: ctx.root, env: { ...process.env, TMPDIR: ctx.root }, stdout: "pipe", stderr: "pipe" });
	if (extract.exitCode !== 0) throw new Error("N+2 candidate extraction failed: " + extract.stdout.toString() + extract.stderr.toString());
	return { root, executable: join(root, "bin", "omp-kit"), baseCases, baseQuiet, targetCases, targetQuiet, packageBuildDurationMs };
}

test("checksum-correct archive without its attestation refuses before extraction or activation", async () => fixture(async ctx => {
 const plan = await planKitUpdate(input(ctx));
 if (plan.status !== "UPDATE_AVAILABLE") throw new Error("fixture plan rejected");
 rmSync(`${ctx.archivePath}.sigstore.json`);
 await expect(applyKitUpdate(plan)).rejects.toThrow("KIT_ATTESTATION_BUNDLE_MISSING");
 expect(existsSync(join(ctx.prefix, "releases", ctx.nextVersion))).toBe(false);
 expect(readlinkSync(join(ctx.prefix, "bin", "omp-kit"))).toBe(`../releases/${ctx.currentVersion}/bin/omp-kit`);
 expect(inspectPendingKitUpdate(ctx.stateRoot)).toBeNull();
}));

test("checksum-correct archive with a rejected attestation refuses without a candidate receipt", async () => fixture(async ctx => {
 const plan = await planKitUpdate(input(ctx));
 if (plan.status !== "UPDATE_AVAILABLE") throw new Error("fixture plan rejected");
 writeFileSync(`${ctx.archivePath}.sigstore.json`, JSON.stringify({ fixture: false }));
 await expect(applyKitUpdate(plan)).rejects.toThrow("KIT_ATTESTATION_UNVERIFIED");
 expect(existsSync(join(ctx.prefix, "releases", ctx.nextVersion))).toBe(false);
 expect(readlinkSync(join(ctx.prefix, "bin", "omp-kit"))).toBe(`../releases/${ctx.currentVersion}/bin/omp-kit`);
 expect(inspectPendingKitUpdate(ctx.stateRoot)).toBeNull();
}));

test("unavailable authority verifier never becomes integrity-only activation", async () => fixture(async ctx => {
 const plan = await planKitUpdate(input(ctx));
 if (plan.status !== "UPDATE_AVAILABLE") throw new Error("fixture plan rejected");
 const python = Bun.which("python3");
 if (!python) throw new Error("fixture requires python3");
 const verifierPath = join(ctx.root, "without-authority");
 mkdirSync(verifierPath);
 symlinkSync(python, join(verifierPath, "python3"));
 const previousPath = process.env.PATH;
 // Keep the real installer verifier runnable, but no ambient gh or credential helper.
 process.env.PATH = verifierPath;
 try { await expect(applyKitUpdate(plan)).rejects.toThrow("KIT_ATTESTATION_VERIFIER_UNAVAILABLE"); }
 finally { process.env.PATH = previousPath; }
 expect(existsSync(join(ctx.prefix, "releases", ctx.nextVersion))).toBe(false);
 expect(readlinkSync(join(ctx.prefix, "bin", "omp-kit"))).toBe(`../releases/${ctx.currentVersion}/bin/omp-kit`);
 expect(auditMutations(ctx.stateRoot)).toEqual([]);
 expect(inspectPendingKitUpdate(ctx.stateRoot)).toBeNull();
}));

// A version/hash/source drift must be rejected under the same lock that owns activation.
test("stale plan and competing writer refuse without touching the stable link", async () => fixture(async ctx => {
 const planned = await planKitUpdate(input(ctx));
 expect(planned.status).toBe("UPDATE_AVAILABLE");
 if (planned.status !== "UPDATE_AVAILABLE") throw new Error("fixture plan rejected");
 const link = join(ctx.prefix, "bin", "omp-kit");
 const lock = acquireKitUpdateLock(ctx.stateRoot);
 try { await expect(applyKitUpdate(planned)).rejects.toThrow(/LOCK_BUSY/); }
 finally { lock.release(); }
 writeFileSync(ctx.indexPath, readFileSync(ctx.indexPath, "utf8").replace("v1.2.3", "v1.2.4"));
 await expect(applyKitUpdate(planned)).rejects.toThrow(/STALE_KIT_PLAN/);
 expect(readlinkSync(link)).toBe("../releases/1.2.2/bin/omp-kit");
 expect(inspectPendingKitUpdate(ctx.stateRoot)).toBeNull();
}));

test("changed installed binary hash rejects the stale plan before any receipt", async () => fixture(async ctx => {
 const planned = await planKitUpdate(input(ctx));
 if (planned.status !== "UPDATE_AVAILABLE") throw new Error("fixture plan rejected");
 writeFileSync(join(ctx.prefix, "releases", "1.2.2", "bin", "omp-kit"), Buffer.concat([ctx.oldBinary, Buffer.from("\n")]), { mode: 0o755 });
 await expect(applyKitUpdate(planned)).rejects.toThrow(/STALE_KIT_PLAN/);
 expect(readlinkSync(join(ctx.prefix, "bin", "omp-kit"))).toBe("../releases/1.2.2/bin/omp-kit");
 expect(inspectPendingKitUpdate(ctx.stateRoot)).toBeNull();
}));

test("explicit selected version mismatch refuses without state or prefix writes", async () => fixture(async ctx => {
 const mismatch = await planKitUpdate({ ...input(ctx), version: "1.2.4", sourceTag: "v1.2.4" });
 expect(mismatch).toMatchObject({ exitCode: 2, status: "REFUSED" });
 expect(existsSync(ctx.stateRoot)).toBe(false);
 expect(readlinkSync(join(ctx.prefix, "bin", "omp-kit"))).toBe("../releases/1.2.2/bin/omp-kit");
}));

test("plan reads the archive and refuses bytes that differ from the index digest before any state or prefix write", async () => fixture(async ctx => {
 const link = join(ctx.prefix, "bin", "omp-kit");
 const bytes = readFileSync(ctx.archivePath);
 const tampered = Buffer.from(bytes);
 tampered[Math.floor(tampered.length / 2)] ^= 0xff;
 writeFileSync(ctx.archivePath, tampered);
 const refused = await planKitUpdate(input(ctx));
 expect(refused).toMatchObject({ exitCode: 2, status: "REFUSED", reason: "ARCHIVE_DIGEST_MISMATCH", provenance: "UNVERIFIED" });
 expect(existsSync(ctx.stateRoot)).toBe(false);
 expect(existsSync(join(ctx.prefix, "releases", ctx.nextVersion))).toBe(false);
 expect(readlinkSync(link)).toBe("../releases/1.2.2/bin/omp-kit");
 // Control: the same index with the untouched bytes still plans, so the refusal above is the digest check, not the fixture.
 writeFileSync(ctx.archivePath, bytes);
 expect(await planKitUpdate(input(ctx))).toMatchObject({ exitCode: 0, status: "UPDATE_AVAILABLE", provenance: "INTEGRITY_ONLY" });
}));

test("plan refuses a missing archive as an incomplete local source", async () => fixture(async ctx => {
 rmSync(ctx.archivePath);
 expect(await planKitUpdate(input(ctx))).toMatchObject({ exitCode: 2, status: "REFUSED", reason: "LOCAL_SOURCE_REQUIRED" });
 expect(existsSync(ctx.stateRoot)).toBe(false);
}));

// A failed matcher/live post-check stays RED even when guarded compensation restores the prior link.
test("verified archive activates one symlink, retains old release and leaves failed live check pending", async () => fixture(async ctx => {
 const planned = await planKitUpdate(input(ctx));
 if (planned.status !== "UPDATE_AVAILABLE") throw new Error("fixture plan rejected");
 const result = await applyKitUpdate(planned);
 expect(result.status).toBe("PARTIAL");
 expect(result.postcheck.status).not.toBe("PASS");
 expect(result.receiptId).toBeTruthy();
 const link = join(ctx.prefix, "bin", "omp-kit");
 expect(readlinkSync(link)).toBe("../releases/1.2.3/bin/omp-kit");
 expect(readFileSync(join(ctx.prefix, "releases", "1.2.2", "bin", "omp-kit"))).toEqual(ctx.oldBinary);
 expect(inspectPendingKitUpdate(ctx.stateRoot)?.id).toBe(result.receiptId);
 expect(auditMutations(ctx.stateRoot)).toEqual(expect.arrayContaining([expect.objectContaining({ id: result.receiptId, status: "PENDING", scope: "kit" })]));
 const before = await planKitUpdate(input(ctx));
 expect(before.status).toBe("CURRENT");
 const undone = undoKitUpdate({ prefix: ctx.prefix, stateRoot: ctx.stateRoot, receiptId: result.receiptId! });
 expect(undone).toMatchObject({ status: "RESTORED", updatePending: false });
 expect(readlinkSync(link)).toBe("../releases/1.2.2/bin/omp-kit");
 expect(readFileSync(join(ctx.prefix, "releases", "1.2.3", "bin", "omp-kit"))).toEqual(binary("1.2.3"));
 expect(inspectPendingKitUpdate(ctx.stateRoot)).toBeNull();
 expect(auditMutations(ctx.stateRoot)).toEqual(expect.arrayContaining([
  expect.objectContaining({ id: result.receiptId, scope: "kit", status: "ABORTED_AFTER_COMPENSATION" }),
 ]));
 const retry = await planKitUpdate(input(ctx));
 expect(retry).toMatchObject({ status: "REFUSED", reason: "KIT_TARGET_EXISTS", exitCode: 2 });
 expect(inspectPendingKitUpdate(ctx.stateRoot)).toBeNull();
}));

// An operator facing PARTIAL must see which stages failed, which of their paths changed, and the exact recovery command.
test("failed postcheck envelope names failed stages, changed operator paths and the undo command", async () => fixture(async ctx => {
 const planned = await planKitUpdate(input(ctx));
 if (planned.status !== "UPDATE_AVAILABLE") throw new Error("fixture plan rejected");
 const result = await applyKitUpdate(planned);
 const report = result.postcheck.report;
 if (result.status !== "PARTIAL" || !result.receiptId || !report)
  throw new Error(`expected a PARTIAL outcome carrying its full-test report, observed ${JSON.stringify({ status: result.status, receipt: result.receiptId, postcheck: result.postcheck.status, reason: result.postcheck.reason, report: Boolean(report) })}`);
 const undoCommand = `omp-kit undo ${result.receiptId} --yes`;

 // The real failed postcheck already explains itself: the first failure is in the error message.
 const real = kitUpdateEnvelope(planned, result);
 const realDetail = real.data.postcheck_detail as { failures: string[] } | null;
 expect(realDetail?.failures.length ?? 0, JSON.stringify(real.data)).toBeGreaterThan(0);
 expect(real.errors?.[0]?.message, JSON.stringify(real.errors)).toContain(realDetail!.failures[0]!);
 const interrupted = kitUpdateEnvelope(planned, { ...result,
  postcheck: { ...result.postcheck, cause: updateFailureCause(new Error("boom lower")) } });
 expect(interrupted.data.postcheck_detail, JSON.stringify(interrupted.data)).toMatchObject({
  cause: { cause_code: "Error", cause_message: "boom lower" },
 });

 // A receipt can exist before a full-test report does; recovery must still be usable.
 const causeOnly = kitUpdateEnvelope(planned, { ...result, postcheck: {
  status: "NOT_RUN", matcher: "NOT_RUN", live: "NOT_RUN", reason: "KIT_UPDATE_INTERRUPTED",
  cause: updateFailureCause(new Error(`interrupted at ${ctx.home}/private-context`)),
 } });
 expect(causeOnly.commands).toEqual([undoCommand]);
 expect(causeOnly.data.postcheck_detail).toMatchObject({
  current_stage: null, failures: [], cause: { cause_message: "interrupted at <private-path>/private-context" },
 });
 expect(causeOnly.errors?.[0]?.remediation).toContain(undoCommand);

 // The report's original cause must not be hidden behind a generic postcheck wrapper.
 const rootCause = updateFailureCause(new Error("native interruption before completion"));
 const wrapped = kitUpdateEnvelope(planned, { ...result, postcheck: { ...result.postcheck,
  cause: updateFailureCause(new Error("KIT_POSTCHECK_FAILED")), report: { ...report, cause: rootCause },
 } });
 expect(wrapped.data.postcheck_detail).toMatchObject({ cause: rootCause });

 // Named stages, both home and project changed paths, and a capped failure list.
 const stages = Object.fromEntries(Object.entries(report.stages).map(([name, stage]) => [name, { ...stage, status: "PASS", producer_rc: 0 }])) as typeof report.stages;
 stages["harness-gate"] = { status: "FAIL", producer_rc: 1, duration_ms: 1, reason: "gate refused" };
 stages["e2e-live"] = { status: "FAIL", producer_rc: 1, duration_ms: 1, reason: "scenario missing" };
 stages["e2e-plant"] = { status: "NOT_RUN", producer_rc: null, duration_ms: null };
 const homePath = join(ctx.home, ".omp", "agent", "config.yml"), projectPath = join(ctx.home, "project", ".omp", "settings.json");
 const failures = Array.from({ length: 25 }, (_, index) => `failure ${index + 1}`);
 const failedReport = { ...report, stages, failures, snapshots: { ...report.snapshots,
  home: { ...report.snapshots.home, unchanged: false, changed_paths: [homePath] },
  project: { ...report.snapshots.project, unchanged: false, changed_paths: [projectPath] } } };
 const envelope = kitUpdateEnvelope(planned, { ...result, postcheck: { ...result.postcheck, status: "FAIL", report: failedReport } });
 expect(envelope.code).toBe(1);
 expect(envelope.data, JSON.stringify(envelope.data)).toMatchObject({ overall: "FAIL", action: "PARTIAL", postcheck: "FAIL",
  receipt_id: result.receiptId, reason: result.postcheck.reason ?? null });
 expect(envelope.data.postcheck_detail, JSON.stringify(envelope.data.postcheck_detail)).toMatchObject({
  failed_stages: ["harness-gate", "e2e-live", "fast-test", "omp-version"], changed_operator_paths: [homePath, projectPath], failures: failures.slice(0, 20) });
 expect(envelope.commands).toEqual([undoCommand]);
 expect(envelope.errors?.[0], JSON.stringify(envelope.errors)).toMatchObject({ code: result.postcheck.reason ?? "KIT_POSTCHECK_FAILED" });
 expect(envelope.errors?.[0]?.message).toContain("Kit update to 1.2.3 did not pass its postcheck; failure 1");
 expect(envelope.errors?.[0]?.remediation).toContain(`To return to 1.2.2 and clear the pending receipt: ${undoCommand}`);

 // An outcome that is not PARTIAL offers no undo and no error.
 const updated = kitUpdateEnvelope(planned, { ...result, status: "UPDATED", exitCode: 0 });
 expect({ commands: updated.commands, errors: updated.errors, overall: updated.data.overall }).toEqual({ commands: undefined, errors: undefined, overall: "UNVERIFIED" });

 // The advertised command's receipt is the one undo restores.
 expect(undoKitUpdate({ prefix: ctx.prefix, stateRoot: ctx.stateRoot, receiptId: result.receiptId })).toMatchObject({ status: "RESTORED", updatePending: false });
 expect(readlinkSync(join(ctx.prefix, "bin", "omp-kit"))).toBe("../releases/1.2.2/bin/omp-kit");
}));

// ompkit-2pkp1: on a live host the cc service writes its store every 15 s and every kit command appends its spool,
// so the postcheck's isolation guard must tell an installed job's own state from a write it should catch.
test("planted: a live cc writer during the isolated test is not an operator change; a write to an operator path still is", async () => fixture(async ctx => {
	const stateHome = join(ctx.home, ".local", "state"), kitState = join(stateHome, "omp-kit"), cc = join(kitState, "cc");
	const plist = join(ctx.home, "Library", "LaunchAgents", `${serviceLabel("cc")}.plist`);
	const unit = join(ctx.home, ".config", "systemd", "user", "omp-kit-cc.service");
	for (const definition of [plist, unit]) { mkdirSync(dirname(definition), { recursive: true }); writeFileSync(definition, "installed\n"); }
	mkdirSync(join(cc, "spool", "kit"), { recursive: true });
	mkdirSync(join(ctx.home, ".agents", "rules"), { recursive: true });
	chmodSync(kitState, 0o700);
	const ccFiles = [join(cc, "cc.db"), join(cc, "spool", "kit", "2026-10-22.jsonl")];
	const operatorFile = join(ctx.home, ".agents", "rules", "planted.md");
	// One real concurrent process writes both: the operator-path control proves it was writing inside the snapshot window.
	const appends = ccFiles.map(file => `printf '%s\\n' "$n" >> '${file}'`).join("; ");
	const writer = Bun.spawn(["/bin/sh", "-c", `n=0; while :; do n=$((n+1)); ${appends}; printf '%s\\n' "$n" > '${operatorFile}'; sleep 0.01; done`],
		{ stdout: "ignore", stderr: "inherit" });
	const previousXdg = process.env.XDG_STATE_HOME;
	process.env.XDG_STATE_HOME = stateHome;
	try {
		// Poll for the writer's first iteration (a condition, not a guessed duration).
		while (!existsSync(operatorFile)) await Bun.sleep(5);
		const planned = await planKitUpdate({ ...input(ctx), stateRoot: kitState });
		if (planned.status !== "UPDATE_AVAILABLE") throw new Error("fixture plan rejected");
		const result = await applyKitUpdate(planned);
		const report = result.postcheck.report;
		if (!report) throw new Error(`expected a full-test report, observed ${JSON.stringify(result.postcheck)}`);
		const operatorFailures = report.failures.filter(failure => failure.startsWith("Operator file changed"));
		// The guard still names a write the run itself makes to the operator state root (on a host with rch, the fast
		// stage's in-process doctor records rch-socket-ino.json there), so assert the planted pair, not the whole list.
		expect(operatorFailures, JSON.stringify(report.failures)).toContain("Operator file changed during failed fast stage: ~/.agents/rules/planted.md");
		expect(operatorFailures.filter(failure => failure.includes("/omp-kit/cc")), JSON.stringify(report.failures)).toEqual([]);
		expect(report.snapshots.home.changed_paths).toContain("~/.agents/rules/planted.md");
		expect(report.snapshots.home.changed_paths.filter(path => path.includes("/omp-kit/cc"))).toEqual([]);
	} finally {
		writer.kill("SIGKILL");
		await writer.exited;
		if (previousXdg === undefined) delete process.env.XDG_STATE_HOME; else process.env.XDG_STATE_HOME = previousXdg;
	}
}));

// ompkit-2pkp1: heavy admission deferring a ladder stage means the release was never judged; the update says DEFERRED.
test("planted: a heavy-deferred postcheck reports DEFERRED, not FAIL, and never PASS", async () => fixture(async ctx => {
	const planned = await planKitUpdate(input(ctx));
	if (planned.status !== "UPDATE_AVAILABLE") throw new Error("fixture plan rejected");
	const result = await applyKitUpdate(planned);
	const report = result.postcheck.report;
	if (result.status !== "PARTIAL" || !report) throw new Error("expected a PARTIAL outcome carrying its full-test report");
	const proofs = report.fast.proofs;
	const fast = { ...report.fast, status: "PASS" as const, proofs: { ...proofs, G1_registration: { ...proofs.G1_registration, status: "PASS" as const },
		G2_payload: { ...proofs.G2_payload, status: "PASS" as const }, G3_quiet_prefix: { ...proofs.G3_quiet_prefix, status: "PASS" as const } } };
	const stages = Object.fromEntries(Object.entries(report.stages).map(([name, stage]) => [name, { ...stage, status: "NOT_RUN" as const }])) as typeof report.stages;
	stages.manifest = { status: "PASS", producer_rc: 0, duration_ms: 1 };
	stages["harness-gate"] = { status: "DEFERRED", producer_rc: 75, duration_ms: 1, reason: "omp-kit heavy deferred the stage before it ran: queue timeout" };
	const deferral = "Stage harness-gate deferred by heavy admission (producer_rc=75): queue timeout";
	const deferredReport = { ...report, fast, stages, status: "DEFERRED" as const, exitCode: 3 as const, omp_version: "18.12.1", failures: [deferral] };
	const known = { identityKnown: true, changed: false };

	const postcheck = judgeKitPostcheck(deferredReport, known);
	expect(postcheck).toMatchObject({ status: "DEFERRED", matcher: "PASS", live: "NOT_RUN", reason: "KIT_POSTCHECK_DEFERRED" });
	// Control: the same stage FAILing is a failed live test, and an OMP change still outranks a deferral.
	const failedStages = { ...stages, "harness-gate": { ...stages["harness-gate"], status: "FAIL" as const } };
	expect(judgeKitPostcheck({ ...deferredReport, stages: failedStages, status: "FAIL", exitCode: 1 }, known))
		.toMatchObject({ status: "FAIL", live: "FAIL", reason: "KIT_LIVE_TEST_FAILED" });
	expect(judgeKitPostcheck(deferredReport, { identityKnown: true, changed: true }).status).toBe("FAIL");
	expect(judgeKitPostcheck(deferredReport, { identityKnown: false, changed: false }).status).toBe("FAIL");

	const envelope = kitUpdateEnvelope(planned, { ...result, postcheck: { ...postcheck, reason: "KIT_POSTCHECK_DEFERRED" } });
	expect(envelope.data, JSON.stringify(envelope.data)).toMatchObject({ overall: "UNVERIFIED", action: "PARTIAL", postcheck: "DEFERRED",
		live: "NOT_RUN", reason: "KIT_POSTCHECK_DEFERRED" });
	expect(envelope.data.postcheck_detail).toMatchObject({ status: "DEFERRED", deferred_stages: ["harness-gate"], failed_stages: [], failures: [deferral] });
	expect(envelope.errors?.[0]).toMatchObject({ code: "KIT_POSTCHECK_DEFERRED" });
	expect(envelope.errors?.[0]?.message).toContain(`Kit update to 1.2.3 is active but unverified: heavy admission deferred its postcheck; ${deferral}`);
	expect(envelope.commands).toEqual([`omp-kit undo ${result.receiptId} --yes`]);
	// The unattended job never reports a deferred postcheck as a clean cycle.
	expect(kitUpdateJobOverall({ status: "UPDATED", receiptId: result.receiptId, activeVersion: "1.2.3", notification: true, postcheck: postcheck.status })).toBe("FINDINGS");
}));

// A later edit to the activated binary or link defeats post-image-based undo.
test("undo refuses an edited postimage and leaves the update receipt pending", async () => fixture(async ctx => {
 const planned = await planKitUpdate(input(ctx));
 if (planned.status !== "UPDATE_AVAILABLE") throw new Error("fixture plan rejected");
 const result = await applyKitUpdate(planned);
 const link = join(ctx.prefix, "bin", "omp-kit");
 writeFileSync(join(ctx.prefix, "releases", "1.2.3", "bin", "omp-kit"), "changed");
 expect(() => undoKitUpdate({ prefix: ctx.prefix, stateRoot: ctx.stateRoot, receiptId: result.receiptId! })).toThrow(/POSTIMAGE_CHANGED/);
 expect(readlinkSync(link)).toBe("../releases/1.2.3/bin/omp-kit");
 expect(inspectPendingKitUpdate(ctx.stateRoot)?.id).toBe(result.receiptId);
}));

// Historical combined-update receipts remain visible and block a new kit-only apply.
test("historical all-scope pending receipt blocks a new kit apply without changing the stable link", async () => fixture(async ctx => {
 const planned = await planKitUpdate(input(ctx));
 if (planned.status !== "UPDATE_AVAILABLE") throw new Error("fixture plan rejected");
 const heldLock = acquireKitUpdateLock(ctx.stateRoot);
 let pending;
 try {
  pending = beginKitUpdateReceipt(ctx.stateRoot, heldLock, { scope: "all", identitySha256: sha(ctx.oldBinary), kitVersion: "1.2.2", ompVersion: null, channel: null });
 } finally { heldLock.release(); }
 await expect(applyKitUpdate(planned)).rejects.toThrow(/PENDING_RECOVERY/);
 expect(readlinkSync(join(ctx.prefix, "bin", "omp-kit"))).toBe("../releases/1.2.2/bin/omp-kit");
 expect(inspectPendingKitUpdate(ctx.stateRoot)?.id).toBe(pending.id);
 expect(auditMutations(ctx.stateRoot)).toEqual(expect.arrayContaining([expect.objectContaining({ id: pending.id, status: "PENDING", scope: "all" })]));
}));

test("a selected OMP package replaced after kit planning cannot certify the kit postcheck", async () => fixture(async ctx => {
 const packageRoot = join(ctx.home, "omp-package");
 const ompBin = join(ctx.home, "omp-bin");
 const manifestPath = join(packageRoot, "package.json");
 mkdirSync(join(packageRoot, "dist"), { recursive: true });
 mkdirSync(join(packageRoot, "node_modules", "@oh-my-pi", "pi-natives"), { recursive: true });
 for (const file of ["export/ttsr.ts", "capability/rule.ts", "discovery/helpers.ts"]) {
  const target = join(packageRoot, "src", file);
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, "export {};\n");
 }
 mkdirSync(ompBin);
 writeFileSync(manifestPath, JSON.stringify({ name: "@oh-my-pi/pi-coding-agent", version: "18.4.2" }));
 writeFileSync(join(packageRoot, "node_modules", "@oh-my-pi", "pi-natives", "package.json"), JSON.stringify({ name: "@oh-my-pi/pi-natives" }));
 const launcher = join(packageRoot, "dist", "cli.js");
 writeFileSync(launcher, "#!/bin/sh\nexit 0\n", { mode: 0o755 });
 symlinkSync(launcher, join(ompBin, "omp"));
 const next = Buffer.from(`#!/bin/sh\nprintf '%s' '{"name":"@oh-my-pi/pi-coding-agent","version":"18.4.3"}' > ${JSON.stringify(manifestPath)}\nprintf '{"version":"1.2.3","source_tag":"v1.2.3","platform":{"os":"darwin","arch":"arm64"}}\\n'\n`);
	const releaseManifest = manifest("1.2.3", next, ctx.contractFiles);
	const archive = tar([{ name: "bin/omp-kit", bytes: next }, ...ctx.contractFiles, { name: "release-manifest.json", bytes: releaseManifest }]);
 const index = JSON.parse(readFileSync(ctx.indexPath, "utf8"));
 index.assets["darwin-arm64-none"].sha256 = sha(archive);
 index.assets["darwin-arm64-none"].manifest_sha256 = sha(releaseManifest);
 writeFileSync(ctx.archivePath, archive);
 writeFileSync(ctx.indexPath, JSON.stringify(index));
 const previousPath = process.env.PATH;
 const previousOmp = { OMP: process.env.OMP, OMP_BIN: process.env.OMP_BIN,
  OMP_PATH: process.env.OMP_PATH, OMP_SRC: process.env.OMP_SRC };
 delete process.env.OMP;
 delete process.env.OMP_BIN;
 delete process.env.OMP_PATH;
 delete process.env.OMP_SRC;
 process.env.PATH = `${ompBin}:${previousPath ?? ""}`;
 try {
  const plan = await planKitUpdate(input(ctx));
  if (plan.status !== "UPDATE_AVAILABLE") throw new Error("fixture plan rejected");
  const result = await applyKitUpdate(plan);
  expect(result.status).toBe("PARTIAL");
  expect(result.postcheck.reason).toBe("OMP_CHANGED_DURING_KIT_UPDATE");
  expect(result.receiptId).toBeTruthy();
  expect(inspectPendingKitUpdate(ctx.stateRoot)?.id).toBe(result.receiptId);
  expect(JSON.parse(readFileSync(manifestPath, "utf8")).version).toBe("18.4.3");
 } finally {
  if (previousPath === undefined) delete process.env.PATH; else process.env.PATH = previousPath;
  for (const [key, value] of Object.entries(previousOmp)) {
   if (value === undefined) delete process.env[key]; else process.env[key] = value;
  }
 }
}));

test("a null full-test OMP version is a named postcheck failure, not an OMP change", async () => fixture(async ctx => {
	const packageRoot = join(ctx.home, "omp-package"), ompBin = join(ctx.home, "omp-bin");
	const manifestPath = join(packageRoot, "package.json");
	mkdirSync(join(packageRoot, "dist"), { recursive: true });
	mkdirSync(join(packageRoot, "node_modules", "@oh-my-pi", "pi-natives"), { recursive: true });
	for (const file of ["export/ttsr.ts", "capability/rule.ts", "discovery/helpers.ts"]) {
		const target = join(packageRoot, "src", file);
		mkdirSync(dirname(target), { recursive: true });
		writeFileSync(target, "export {};\n");
	}
	mkdirSync(ompBin);
	writeFileSync(manifestPath, JSON.stringify({ name: "@oh-my-pi/pi-coding-agent", version: "18.4.2" }));
	writeFileSync(join(packageRoot, "node_modules", "@oh-my-pi", "pi-natives", "package.json"), JSON.stringify({ name: "@oh-my-pi/pi-natives" }));
	const launcher = join(packageRoot, "dist", "cli.js");
	writeFileSync(launcher, "#!/bin/sh\nexit 0\n", { mode: 0o755 });
	symlinkSync(launcher, join(ompBin, "omp"));
	const previousPath = process.env.PATH;
	process.env.PATH = [ompBin, previousPath ?? ""].filter(Boolean).join(":");
	try {
		const plan = await planKitUpdate(input(ctx));
		if (plan.status !== "UPDATE_AVAILABLE") throw new Error("fixture plan rejected");
		const result = await applyKitUpdate(plan);
		expect(result.status).toBe("PARTIAL");
		expect(result.postcheck.report?.omp_version).toBeNull();
		expect(result.postcheck.reason).toBe("OMP_VERSION_UNVERIFIED");
		expect(JSON.parse(readFileSync(manifestPath, "utf8")).version).toBe("18.4.2");
		const envelope = kitUpdateEnvelope(plan, result);
		const detail = envelope.data.postcheck_detail as { omp_version: string | null; failed_stages: string[] };
		expect(detail.omp_version).toBeNull();
		expect(detail.failed_stages).toContain("fast-test");
		expect(detail.failed_stages).toContain("omp-version");
	} finally { process.env.PATH = previousPath; }
}));

test("already-current version does not create a pending receipt or re-switch the stable link", async () => fixture(async ctx => {
 const release = join(ctx.prefix, "releases", "1.2.3");
 mkdirSync(join(release, "bin"), { recursive: true });

 writeFileSync(join(release, "bin", "omp-kit"), binary("1.2.3"), { mode: 0o755 });
 chmodSync(join(release, "bin", "omp-kit"), 0o755);
 writeFileSync(join(release, "release-manifest.json"), manifest("1.2.3", binary("1.2.3")));
 renameSync(join(ctx.prefix, "bin", "omp-kit"), join(ctx.prefix, "bin", "previous"));
 symlinkSync("../releases/1.2.3/bin/omp-kit", join(ctx.prefix, "bin", "omp-kit"));
 const planned = await planKitUpdate(input(ctx));
 expect(planned.status).toBe("CURRENT");
 if (planned.status !== "CURRENT") throw new Error("fixture plan rejected");
 const result = await applyKitUpdate(planned);
 expect(result).toMatchObject({ status: "CURRENT", receiptId: null, activeVersion: "1.2.3" });
 expect(readlinkSync(join(ctx.prefix, "bin", "omp-kit"))).toBe("../releases/1.2.3/bin/omp-kit");
 expect(inspectPendingKitUpdate(ctx.stateRoot)).toBeNull();
}));

// Full N to N+2 journey: two package builds plus fast, matcher, ratchet and the
// complete e2e-live suite in postcheck. Per-scenario timeouts bound hangs; the
// 900 s budget fits the suite on slow disks.
test("update derives the N+2 fast denominator from the manifest-bound case corpus", async () => fixture(async ctx => {
	const candidate = buildNPlusTwoCandidate(ctx);
	const plan = await planKitUpdate(input(ctx));
	if (plan.status !== "UPDATE_AVAILABLE") throw new Error("fixture plan rejected");

	const baselineFastStarted = performance.now();
	const baseline = await runFastTest({ root: candidate.root, executablePath: candidate.executable, home: ctx.home });
	const baselineFastDurationMs = Math.round(performance.now() - baselineFastStarted);
	expect(baseline.status).toBe("PASS");
	expect(baseline.proofs.G2_payload).toMatchObject({ status: "PASS",
		expected_cases: candidate.targetCases, observed_cases: candidate.targetCases });
	expect(baseline.proofs.G3_quiet_prefix).toMatchObject({ status: "PASS",
		expected_cases: candidate.targetCases, expected_quiet_cases: candidate.targetQuiet,
		observed_cases: candidate.targetCases, observed_quiet_cases: candidate.targetQuiet });

	const updated = await applyKitUpdate(plan);
	const report = updated.postcheck.report;
	const stageTimings = [
		{ stage: "package-build", duration_ms: candidate.packageBuildDurationMs },
		{ stage: "baseline-fast", duration_ms: baselineFastDurationMs },
		{ stage: "fast", duration_ms: report?.fast_duration_ms ?? null },
		{ stage: "matcher", source: "harness-gate", duration_ms: report?.stages["harness-gate"].duration_ms ?? null },
		{ stage: "ratchet", source: "metamorphic-ratchet", duration_ms: report?.stages["metamorphic-ratchet"].duration_ms ?? null },
		{ stage: "cli-crosscheck", duration_ms: report?.stages["cli-crosscheck"].duration_ms ?? null },
		{ stage: "e2e-live", duration_ms: report?.stages["e2e-live"].duration_ms ?? null },
	];
	console.log("N+2 journey stage timings " + JSON.stringify(stageTimings));
	const liveLines = [report?.producer.stdout, report?.producer.stderr]
		.flatMap(output => output?.split("\n") ?? []);
	const scenarioStart = liveLines.findIndex(line => line.includes("started scenario=settings-no-checkout-remedy"));
	const scenarioOutput = scenarioStart < 0 ? liveLines.filter(line => line.includes("settings-no-checkout-remedy"))
		: liveLines.slice(scenarioStart, Math.min(scenarioStart + 80, liveLines.findIndex((line, index) =>
			index > scenarioStart && line.includes("FAIL  settings-no-checkout-remedy")) + 1 || scenarioStart + 80));
	const scenarioText = scenarioOutput.join("\n");
	const readinessStageEnd = liveLines.findIndex(line => line.startsWith("GREEN readiness-selftest producer_rc="));
	const liveStageEnd = liveLines.findIndex((line, index) => index > readinessStageEnd &&
		line.startsWith("RED   e2e-live producer_rc="));
	const stageStdout = readinessStageEnd < 0 ? scenarioText : liveLines
		.slice(readinessStageEnd + 1, liveStageEnd < 0 ? liveLines.length : liveStageEnd).join("\n");
	const policyFailure = liveLines.filter(line => line.includes("POLICY_PLAN_FAILED") ||
		line.includes("cause_code") || line.includes("cause_message")).join("\n").slice(0, 400);
	const diagnosticArtifact = report?.producer.artifacts?.directory ?? null;
	expect(updated.status, JSON.stringify({ reason: updated.postcheck.reason, matcher: updated.postcheck.matcher,
		live: updated.postcheck.live, failures: report?.failures,
		fastFailures: report?.fast.failures, stages: report?.stages,
		e2eLiveOutput: { stdout: stageStdout.slice(0, 400), producerStderr: report?.producer.stderr.slice(0, 400) ?? "" },
		producerArtifacts: report?.producer.artifacts, artifactError: report?.producer.artifact_error,
		stageTimings,
		policyFailure, diagnosticArtifact })).toBe("UPDATED");
	expect(updated.postcheck.status).toBe("PASS");
	expect(updated.postcheck.report?.fast.proofs.G2_payload).toMatchObject({ status: "PASS",
		expected_cases: candidate.targetCases, observed_cases: candidate.targetCases });
	expect(updated.postcheck.report?.fast.proofs.G3_quiet_prefix).toMatchObject({ status: "PASS",
		expected_cases: candidate.targetCases, expected_quiet_cases: candidate.targetQuiet,
		observed_cases: candidate.targetCases, observed_quiet_cases: candidate.targetQuiet });
	expect(readlinkSync(join(ctx.prefix, "bin", "omp-kit"))).toBe("../releases/" + ctx.nextVersion + "/bin/omp-kit");
	expect(inspectPendingKitUpdate(ctx.stateRoot)).toBeNull();
}, { platform: hostPlatform, currentVersion: "0.2.2", nextVersion: "0.2.3" }), 900_000);

test("unsupported source and dangling stable link refuse without creating state", async () => fixture(async ctx => {
 const unsupported = await planKitUpdate({ ...input(ctx), sourceTag: "" });
 expect(unsupported.status).toBe("REFUSED");
 expect(existsSync(ctx.stateRoot)).toBe(false);
 const planned = await planKitUpdate(input(ctx));
 if (planned.status !== "UPDATE_AVAILABLE") throw new Error("fixture plan rejected");
 renameSync(join(ctx.prefix, "bin", "omp-kit"), join(ctx.prefix, "bin", "previous"));
 symlinkSync("../releases/1.2.3/bin/omp-kit", join(ctx.prefix, "bin", "omp-kit"));
 // A dangling current link is refused rather than passed through as a current-version success.
 const refused = await planKitUpdate(input(ctx));
 expect(refused.status).toBe("REFUSED");
 expect(existsSync(ctx.stateRoot)).toBe(false);
}));

type CompiledReleaseFixture = { version: string; archivePath: string; indexPath: string };


function buildCompiledReleaseFixture(
	scratchRoot: string, repoRoot: string, home: string, version: string, selectedPlatform: ReleasePlatform,
): CompiledReleaseFixture {
	const output = join(scratchRoot, `package-${version}`);
	mkdirSync(output, { mode: 0o700 });
	const platformKey = [selectedPlatform.os, selectedPlatform.arch, selectedPlatform.libc].join("-");
	const path = [dirname(process.execPath), process.env.PATH ?? "", "/usr/local/bin", "/opt/homebrew/bin", "/usr/bin", "/bin"]
		.filter(Boolean).join(":");
	const build = Bun.spawnSync(["/bin/sh", join(repoRoot, "scripts/package-release.sh"), "--version", version,
		"--platform", platformKey, "--out", output], {
		cwd: repoRoot,
		env: { PATH: path, HOME: home, TMPDIR: scratchRoot, LANG: "C.UTF-8", LC_ALL: "C.UTF-8" },
		stdout: "pipe",
		stderr: "pipe",
	});
	if (build.exitCode !== 0) {
		throw new Error(`compiled fixture release ${version} failed (${build.exitCode}): ${build.stdout.toString()} ${build.stderr.toString()}`);
	}
	const asset = JSON.parse(build.stdout.toString()) as ReleaseAsset;
	const archivePath = join(output, asset.filename);
	const indexPath = join(output, "release-index.json");
	writeFileSync(indexPath, `${JSON.stringify({
		schema_version: 1, version, source_tag: `v${version}`, assets: { [platformKey]: asset },
	})}\n`, { mode: 0o600, flag: "wx" });
	writeFileSync(`${archivePath}.sigstore.json`, `${JSON.stringify({ fixture: true })}\n`, { mode: 0o600, flag: "wx" });
	return { version, archivePath, indexPath };
}

function writeSyntheticGhVerifier(root: string, repoRoot: string): string {
	const bin = join(root, "synthetic-gh-bin");
	mkdirSync(bin, { mode: 0o700 });
	const executable = join(bin, "gh");
	const fixture = join(repoRoot, "tests/fixtures/kit-release/gh");
	const source = `#!/usr/bin/env python3
import json, os, sys

ROOT = ${JSON.stringify(root)}
FIXTURE = ${JSON.stringify(fixture)}
GH_TOKEN = "SYNTHETIC_GH_TOKEN_V66L21_NOT_A_CREDENTIAL"
GITHUB_TOKEN = "SYNTHETIC_GITHUB_TOKEN_V66L21_NOT_A_CREDENTIAL"
args = sys.argv[1:]
source_lookup = args[:1] == ["api"] and any("/commits/v" in arg for arg in args)
bundle_verify = args[:2] == ["attestation", "verify"]
if not source_lookup and not bundle_verify:
    os.execv(sys.executable, [sys.executable, FIXTURE, *args])

config = os.environ.get("GH_CONFIG_DIR", "")
try:
    config_root = os.path.realpath(ROOT)
    config_real = os.path.realpath(config)
    config_scoped = bool(config) and os.path.isdir(config_real) and os.path.commonpath([config_root, config_real]) == config_root
except (OSError, ValueError):
    config_scoped = False
token_auth = os.environ.get("GH_TOKEN") == GH_TOKEN and os.environ.get("GITHUB_TOKEN") == GITHUB_TOKEN
config_auth = "GH_TOKEN" not in os.environ and "GITHUB_TOKEN" not in os.environ and os.path.isfile(os.path.join(config, "synthetic-gh-auth"))
report = {
    "auth_mode": "tokens" if token_auth else "config-only" if config_auth else "invalid",
    "source_lookup": source_lookup,
    "bundle_verify": bundle_verify,
    "gh_config_dir_scoped": config_scoped,
    "unrelated_context_absent": all(key not in os.environ for key in (
        "PI_BRIDGE_SENTINEL", "MCP_PROVIDER_SENTINEL", "GH_ENTERPRISE_TOKEN")),
}
if config_scoped:
    with open(os.path.join(config, "observed.ndjson"), "a", encoding="utf-8") as output:
        output.write(json.dumps(report) + "\\n")
if not config_scoped or report["auth_mode"] == "invalid" or not report["unrelated_context_absent"]:
    print("synthetic GitHub verifier context refused", file=sys.stderr)
    sys.exit(1)
if source_lookup and os.path.isfile(os.path.join(config, "reject-source")):
    print("synthetic source authority refused", file=sys.stderr)
    sys.exit(1)
os.execv(sys.executable, [sys.executable, FIXTURE, *args])
`;
	writeFileSync(executable, source, { mode: 0o700, flag: "wx" });
	chmodSync(executable, 0o755);
	return bin;
}

test("compiled synthetic predecessor authenticates, activates, and leaves unavailable postcheck pending", async () => {
	const repoRoot = realpathSync(resolve(import.meta.dir, "../.."));
	const scratchRoot = realpathSync(ownedTmp("kit-update-compiled", { root: scratch }).path);
		const home = join(scratchRoot, "home");
		const buildHome = join(scratchRoot, "build-home");
		const prefix = join(scratchRoot, "positive-prefix");
		const negativeHome = join(scratchRoot, "negative-home");
		const negativePrefix = join(scratchRoot, "negative-prefix");
		for (const directory of [home, buildHome, negativeHome]) mkdirSync(directory, { mode: 0o700 });
		const previous = buildCompiledReleaseFixture(scratchRoot, repoRoot, buildHome, "1.2.2", hostPlatform);
		const candidate = buildCompiledReleaseFixture(scratchRoot, repoRoot, buildHome, "1.2.3", hostPlatform);
		const tokenConfig = join(scratchRoot, "gh-config-token");
		const configOnly = join(scratchRoot, "gh-config-only");
		mkdirSync(tokenConfig, { mode: 0o700 });
		mkdirSync(configOnly, { mode: 0o700 });
		writeFileSync(join(configOnly, "synthetic-gh-auth"), "test fixture only\n", { mode: 0o600, flag: "wx" });
		const ghBin = writeSyntheticGhVerifier(scratchRoot, repoRoot);
		const toolBin = join(scratchRoot, "test-tools");
		mkdirSync(toolBin, { mode: 0o700 });
		const python = Bun.which("python3");
		if (!python) throw new Error("python3 is required for the compiled updater regression");
		symlinkSync(python, join(toolBin, "python3"));
		symlinkSync(process.execPath, join(toolBin, "bun"));
		const path = [ghBin, toolBin, "/usr/bin", "/bin"].join(":");
		const installerEnv = {
			PATH: path, HOME: home, TMPDIR: scratchRoot,
			GH_TOKEN: "SYNTHETIC_GH_TOKEN_V66L21_NOT_A_CREDENTIAL",
			GITHUB_TOKEN: "SYNTHETIC_GITHUB_TOKEN_V66L21_NOT_A_CREDENTIAL",
			GH_CONFIG_DIR: tokenConfig,
		};
		const installer = Bun.spawnSync(["/bin/sh", join(repoRoot, "installer/install.sh"),
			"--version", previous.version, "--index", previous.indexPath, "--offline", previous.archivePath, "--prefix", prefix], {
			cwd: repoRoot, env: installerEnv, stdout: "pipe", stderr: "pipe",
		});
		if (installer.exitCode !== 0) {
			throw new Error(`synthetic previous install failed (${installer.exitCode}): ${installer.stdout.toString()} ${installer.stderr.toString()}`);
		}

		const configOnlyEnv = { PATH: path, HOME: home, TMPDIR: scratchRoot, GH_CONFIG_DIR: configOnly };
		const configOnlyVerifier = Bun.spawnSync([python, "-I", "-c", readFileSync(join(repoRoot, "installer/install.py"), "utf8"),
			"attestation", candidate.archivePath, candidate.version, "unused"], {
			cwd: repoRoot, env: configOnlyEnv, stdout: "pipe", stderr: "pipe",
		});
		expect(configOnlyVerifier.exitCode, configOnlyVerifier.stderr.toString()).toBe(0);
		const configOnlyReports = readFileSync(join(configOnly, "observed.ndjson"), "utf8").trim()
			.split("\n").filter(Boolean).map(line => JSON.parse(line) as Record<string, unknown>);
		expect(configOnlyReports.length).toBeGreaterThan(0);
		expect(configOnlyReports.every(report => report.auth_mode === "config-only" &&
			report.gh_config_dir_scoped === true && report.unrelated_context_absent === true)).toBe(true);

		const updaterEnv = {
			PATH: path, HOME: home, TMPDIR: scratchRoot, CI: "1",
			GH_TOKEN: "SYNTHETIC_GH_TOKEN_V66L21_NOT_A_CREDENTIAL",
			GITHUB_TOKEN: "SYNTHETIC_GITHUB_TOKEN_V66L21_NOT_A_CREDENTIAL",
			GH_CONFIG_DIR: tokenConfig,
			GH_ENTERPRISE_TOKEN: "SYNTHETIC_UNRELATED_GH_TOKEN",
			PI_BRIDGE_SENTINEL: "SYNTHETIC_PI_BRIDGE_CONTEXT",
			MCP_PROVIDER_SENTINEL: "SYNTHETIC_MCP_PROVIDER_CONTEXT",
			OMP_KIT_TEST_WORK_ROOT: scratchRoot, OMP_KIT_CASE_CWD: repoRoot,
		};
		const stable = join(prefix, "bin", "omp-kit");
		const update = Bun.spawnSync([stable, "update", "--apply", "--yes", "--version", candidate.version,
			"--index", candidate.indexPath, "--archive", candidate.archivePath, "--json"], {
			cwd: home, env: updaterEnv, stdout: "pipe", stderr: "pipe",
		});
		const updateStdout = update.stdout.toString();
		const updateStderr = update.stderr.toString();
		// OMP is deliberately absent: auth must pass through activation, while the unchanged full postcheck remains blocked.
		expect(update.exitCode).toBe(1);
		const updateEnvelope = JSON.parse(updateStdout) as {
			data: {
				action: string; active_version: string | null; postcheck: string; reason: string | null; receipt_id: string | null;
				postcheck_detail: { failed_stages: string[]; failures: string[] };
			};
		};
		expect(updateEnvelope.data).toMatchObject({
			action: "PARTIAL", active_version: candidate.version, postcheck: "FAIL",
		});
		expect(updateEnvelope.data.postcheck_detail.failed_stages).toContain("fast-test");
		expect(updateEnvelope.data.postcheck_detail.failed_stages).toContain("omp-version");
		expect(updateEnvelope.data.receipt_id).toBeTruthy();
		expect(readlinkSync(stable)).toBe(`../releases/${candidate.version}/bin/omp-kit`);
		const version = Bun.spawnSync([stable, "--version"], { cwd: home, env: updaterEnv, stdout: "pipe", stderr: "pipe" });
		expect(version.exitCode).toBe(0);
		expect(version.stdout.toString().trim()).toBe(`omp-kit ${candidate.version}`);
		const stateRoot = join(home, ".local", "state", "omp-kit");
		const pending = inspectPendingKitUpdate(stateRoot);
		expect(pending?.id).toBe(updateEnvelope.data.receipt_id);
		expect(auditMutations(stateRoot)).toEqual(expect.arrayContaining([
			expect.objectContaining({ scope: "kit", status: "PENDING" }),
		]));
		const tokenReports = readFileSync(join(tokenConfig, "observed.ndjson"), "utf8").trim()
			.split("\n").filter(Boolean).map(line => JSON.parse(line) as Record<string, unknown>);
		expect(tokenReports.some(report => report.source_lookup === true && report.auth_mode === "tokens")).toBe(true);
		expect(tokenReports.some(report => report.bundle_verify === true && report.auth_mode === "tokens")).toBe(true);
		expect(tokenReports.every(report => report.gh_config_dir_scoped === true &&
			report.unrelated_context_absent === true)).toBe(true);

		const negativeInstall = Bun.spawnSync(["/bin/sh", join(repoRoot, "installer/install.sh"),
			"--version", previous.version, "--index", previous.indexPath, "--offline", previous.archivePath, "--prefix", negativePrefix], {
			cwd: repoRoot, env: installerEnv, stdout: "pipe", stderr: "pipe",
		});
		if (negativeInstall.exitCode !== 0) {
			throw new Error(`synthetic negative previous install failed (${negativeInstall.exitCode}): ${negativeInstall.stdout.toString()} ${negativeInstall.stderr.toString()}`);
		}
		writeFileSync(join(configOnly, "reject-source"), "synthetic invalid authority\n", { mode: 0o600, flag: "wx" });
		const noTokenUpdaterEnv = {
			PATH: path, HOME: negativeHome, TMPDIR: scratchRoot, GH_CONFIG_DIR: configOnly,
			OMP_KIT_TEST_WORK_ROOT: scratchRoot, OMP_KIT_CASE_CWD: repoRoot,
		};
		const negativeStable = join(negativePrefix, "bin", "omp-kit");
		const refused = Bun.spawnSync([negativeStable, "update", "--apply", "--yes", "--version", candidate.version,
			"--index", candidate.indexPath, "--archive", candidate.archivePath, "--json"], {
			cwd: negativeHome, env: noTokenUpdaterEnv, stdout: "pipe", stderr: "pipe",
		});
		expect(refused.exitCode).not.toBe(0);
		const refusal = JSON.parse(refused.stdout.toString()) as { errors?: { code?: string }[] };
		expect(refusal.errors?.[0]?.code).toBe("KIT_ATTESTATION_SOURCE_UNVERIFIED");
		expect(readlinkSync(negativeStable)).toBe(`../releases/${previous.version}/bin/omp-kit`);
		expect(existsSync(join(negativePrefix, "releases", candidate.version))).toBe(false);
		expect(inspectPendingKitUpdate(join(negativeHome, ".local", "state", "omp-kit"))).toBeNull();
		const configOnlyAfterRefusal = readFileSync(join(configOnly, "observed.ndjson"), "utf8").trim()
			.split("\n").filter(Boolean).map(line => JSON.parse(line) as Record<string, unknown>);
		expect(configOnlyAfterRefusal.some(report => report.source_lookup === true &&
			report.auth_mode === "config-only" && report.gh_config_dir_scoped === true)).toBe(true);

		const visible = [installer.stdout.toString(), installer.stderr.toString(), configOnlyVerifier.stdout.toString(),
			configOnlyVerifier.stderr.toString(), updateStdout, updateStderr, version.stdout.toString(), version.stderr.toString(),
			negativeInstall.stdout.toString(), negativeInstall.stderr.toString(), refused.stdout.toString(), refused.stderr.toString(),
			JSON.stringify(auditMutations(stateRoot)), readFileSync(join(tokenConfig, "observed.ndjson"), "utf8"),
			readFileSync(join(configOnly, "observed.ndjson"), "utf8")].join("\n");
		for (const sentinel of ["SYNTHETIC_GH_TOKEN_V66L21_NOT_A_CREDENTIAL",
			"SYNTHETIC_GITHUB_TOKEN_V66L21_NOT_A_CREDENTIAL", "SYNTHETIC_UNRELATED_GH_TOKEN",
			"SYNTHETIC_PI_BRIDGE_CONTEXT", "SYNTHETIC_MCP_PROVIDER_CONTEXT"])
			expect(visible).not.toContain(sentinel);
}, 900_000);

afterAll(() => cleanupAllOwnedTmp());
