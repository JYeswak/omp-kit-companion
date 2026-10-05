import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { chmodSync, copyFileSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { runFullTest } from "../../src/full-test-runner.ts";
import { runFastTest } from "../../src/test-runner.ts";
import type { ReleasePlatform } from "../../src/kit-release.ts";
import { acquireKitUpdateLock, auditMutations, beginKitUpdateReceipt, inspectPendingKitUpdate } from "../../src/mutations.ts";
import { applyKitUpdate, kitUpdateEnvelope, planKitUpdate, undoKitUpdate } from "../../src/kit-update.ts";

const sha = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
const platform: ReleasePlatform = { os: "darwin", arch: "arm64", libc: "none" };

const hostPlatform: ReleasePlatform = process.platform === "darwin"
	? { os: "darwin", arch: process.arch === "arm64" ? "arm64" : "x64", libc: "none" }
	: { os: "linux", arch: process.arch === "arm64" ? "arm64" : "x64", libc: "gnu" };
const scratch = join(import.meta.dir, "../../var/agent-tmp");
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
	const cases = Buffer.from("rule\texpect\tsource\ttool\tpath\tsnippet\tnote\n" +
		"rule-a\tfire\ttext\t-\t-\tbr close x\tfixture fire\n" +
		"rule-a\tquiet\ttext\t-\t-\tbr list\tfixture quiet\n");
	return [{ name: "MANIFEST.tsv", bytes: manifestFile }, { name: "cases/cases.tsv", bytes: cases }, { name: "rules/rule-a.md", bytes: rule }];
}
async function fixture<T>(run: (ctx: FixtureContext) => Promise<T>, options: FixtureOptions = {}): Promise<T> {
	const root = mkdtempSync(join(scratch, "kit-update-"));
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
	writeFileSync(indexPath, JSON.stringify({ schema_version: 1, version: nextVersion, source_tag: "v" + nextVersion, assets: {
		[key]: { ...selectedPlatform, filename, sha256: sha(archive), manifest_sha256: sha(releaseManifest) },
	} }));
	try { return await run({ root, prefix, stateRoot, home, source, indexPath, archivePath, oldBinary, contractFiles,
		platform: selectedPlatform, currentVersion, nextVersion }); }
	finally { rmSync(root, { recursive: true, force: true }); }
}
const input = (ctx: FixtureContext) => ({ prefix: ctx.prefix, stateRoot: ctx.stateRoot, home: ctx.home,
	indexPath: ctx.indexPath, archivePath: ctx.archivePath, platform: ctx.platform,
	version: ctx.nextVersion, sourceTag: "v" + ctx.nextVersion });

function copyReleaseSource(sourceRoot: string, destination: string): void {
	mkdirSync(destination, { recursive: true });
	for (const directory of ["src", "scripts", "rules", "retired", "cases", "policy", "extensions", "examples", "checkers", "config", "skills", "tests/live"]) {
		const target = join(destination, directory);
		mkdirSync(dirname(target), { recursive: true });
		cpSync(join(sourceRoot, directory), target, { recursive: true });
	}
	for (const file of ["LICENSE", "MANIFEST.tsv", "package.json"]) {
		const target = join(destination, file);
		mkdirSync(dirname(target), { recursive: true });
		copyFileSync(join(sourceRoot, file), target);
	}
}

function buildNPlusTwoCandidate(ctx: FixtureContext): { root: string; executable: string; baseCases: number; baseQuiet: number; targetCases: number; targetQuiet: number } {
	const sourceRoot = join(ctx.root, "candidate-source");
	copyReleaseSource(resolve(import.meta.dir, "../.."), sourceRoot);
	const casesPath = join(sourceRoot, "cases", "cases.tsv");
	const rawCases = readFileSync(casesPath, "utf8").replace(/\r\n/g, "\n").replace(/\n+$/, "");
	const caseLines = rawCases.split("\n");
	if (caseLines[0] !== "rule\texpect\tsource\ttool\tpath\tsnippet\tnote") throw new Error("candidate cases fixture has an unknown schema");
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
	const build = Bun.spawnSync(["sh", join(sourceRoot, "scripts", "package-release.sh"), "--version", ctx.nextVersion,
		"--platform", key, "--out", output], { cwd: sourceRoot, env: { ...process.env, TMPDIR: ctx.root }, stdout: "pipe", stderr: "pipe" });
	if (build.exitCode !== 0) throw new Error("N+2 candidate package build failed: " + build.stdout.toString() + build.stderr.toString());
	const asset = JSON.parse(build.stdout.toString()) as { os: string; arch: string; libc: string; filename: string; sha256: string; manifest_sha256: string };
	const packagedArchive = join(output, asset.filename), archive = readFileSync(packagedArchive);
	writeFileSync(ctx.archivePath, archive);
	writeFileSync(ctx.indexPath, JSON.stringify({ schema_version: 1, version: ctx.nextVersion, source_tag: "v" + ctx.nextVersion, assets: { [key]: asset } }));
	const root = join(ctx.root, "candidate-release");
	mkdirSync(root);
	const extract = Bun.spawnSync(["tar", "xf", packagedArchive, "-C", root], { cwd: ctx.root, env: { ...process.env, TMPDIR: ctx.root }, stdout: "pipe", stderr: "pipe" });
	if (extract.exitCode !== 0) throw new Error("N+2 candidate extraction failed: " + extract.stdout.toString() + extract.stderr.toString());
	return { root, executable: join(root, "bin", "omp-kit"), baseCases, baseQuiet, targetCases, targetQuiet };
}

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

 // Named stages, both home and project changed paths, and a capped failure list.
 const stages = Object.fromEntries(Object.keys(report.stages).map(name => [name, { status: "PASS", producer_rc: 0 }])) as typeof report.stages;
 stages["harness-gate"] = { status: "FAIL", producer_rc: 1, reason: "gate refused" };
 stages["e2e-live"] = { status: "FAIL", producer_rc: 1, reason: "scenario missing" };
 stages["e2e-plant"] = { status: "NOT_RUN", producer_rc: null };
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
 } finally { process.env.PATH = previousPath; }
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
		expect(result.postcheck.reason).toBe("KIT_POSTCHECK_FAILED");
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

	const baseline = await runFastTest({ root: candidate.root, executablePath: candidate.executable, home: ctx.home });
	expect(baseline.status).toBe("PASS");
	expect(baseline.proofs.G2_payload).toMatchObject({ status: "PASS",
		expected_cases: candidate.targetCases, observed_cases: candidate.targetCases });
	expect(baseline.proofs.G3_quiet_prefix).toMatchObject({ status: "PASS",
		expected_cases: candidate.targetCases, expected_quiet_cases: candidate.targetQuiet,
		observed_cases: candidate.targetCases, observed_quiet_cases: candidate.targetQuiet });

	const updated = await applyKitUpdate(plan);
	expect(updated.status).toBe("UPDATED");
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
