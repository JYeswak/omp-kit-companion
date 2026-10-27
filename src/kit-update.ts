import { createHash, randomUUID } from "node:crypto";
import { closeSync, constants, fsyncSync, lstatSync, openSync, readFileSync, readlinkSync, readSync, realpathSync, renameSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { atomicReplaceBytes } from "./kitlib/io.ts";
import { ownedTmp } from "./kitlib/tmp.ts";
import { run } from "./kitlib/run.ts";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { assertFreshKitPlan, parseReleaseIndexJson, previewKitRelease, stageKitRelease, type BinaryReleaseInfo, type KitReleasePlan, type ReleaseManifest, type ReleasePlatform, type StagedKitRelease } from "./kit-release.ts";
import { redactFullTestCause, runFullTest, type FullTestCause, type FullTestInput, type FullTestReport } from "./full-test-runner.ts";
import { abortCompensatedKitUpdateReceipt, acquireKitUpdateLock, auditMutations, beginKitUpdateReceipt, inspectPendingKitUpdate, reconcileKitUpdateReceipt, writePrivate } from "./mutations.ts";
import { resolveOmpIdentity } from "./paths.ts";
import type { PresentationResult } from "./output.ts";
import { parseRuleManifest } from "./diagnostics.ts";
import { countCaseRows, type FastTestExpectations } from "./test-runner.ts";
import { isSha256Hex } from "./regex-guards.ts";
import installerVerifierPath from "../installer/install.py";
const hashBuffer = Buffer.allocUnsafe(128 * 1024);
function shaFile(path: string): string {
 const digest = createHash("sha256");
 const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
 try {
  for (let count = readSync(fd, hashBuffer, 0, hashBuffer.length, null); count > 0;
   count = readSync(fd, hashBuffer, 0, hashBuffer.length, null)) digest.update(hashBuffer.subarray(0, count));
  return digest.digest("hex");
 } finally { closeSync(fd); }
}
const VERSION = /^[0-9]+\.[0-9]+\.[0-9]+(?:-[0-9A-Za-z.-]+)?$/;
const RECEIPT_ID = /^[a-f0-9-]+$/;

type KitInstallation = { version: string; sha256: string; target: string; binary: string };
export type KitUpdateInput = {
 prefix: string; stateRoot: string; home: string; project?: string; platform: ReleasePlatform;
 /** Explicit local index/archive tuple; activation additionally requires its authentic Sigstore bundle,
  * co-hosted as `<archive>.sigstore.json` or fetched from the attestation authority when absent. */
 indexPath: string; archivePath: string; version: string; sourceTag: string;
};
export type KitUpdatePlan = KitUpdateInput & {
 status: "CURRENT" | "UPDATE_AVAILABLE"; exitCode: 0; release: KitReleasePlan;
 current: KitInstallation; provenance: "INTEGRITY_ONLY";
};
export type KitUpdateRefusal = { status: "REFUSED" | "NETWORK_UNAVAILABLE"; exitCode: 2 | 4; reason: string; provenance: "UNVERIFIED" };
export type KitUpdatePreview = KitUpdatePlan | KitUpdateRefusal;
/** DEFERRED: heavy admission refused a ladder stage, so the release was never judged; it is not PASS and not a FAIL verdict. */
export type KitPostcheck = { status: "PASS" | "FAIL" | "DEFERRED" | "NOT_RUN"; matcher: "PASS" | "FAIL" | "NOT_RUN"; live: "PASS" | "FAIL" | "NOT_RUN"; report?: FullTestReport; reason?: string; cause?: FullTestCause };
export type KitUpdateResult = { status: "UPDATED" | "CURRENT" | "PARTIAL"; exitCode: 0 | 1; receiptId: string | null; activeVersion: string | null; postcheck: KitPostcheck; provenance: "INTEGRITY_ONLY" | "SIGSTORE_VERIFIED" };
export type KitUndoInput = { prefix: string; stateRoot: string; receiptId: string };
export function updateFailureCause(error: unknown, roots: readonly string[] = []): FullTestCause {
 const isError = error instanceof Error;
 const record = error !== null && typeof error === "object" ? error as { code?: unknown } : null;
 const message = isError ? error.message : String(error);
 return redactFullTestCause({
  cause_code: typeof record?.code === "string" ? record.code : isError ? error.name : "UNKNOWN_ERROR",
  cause_name: isError ? error.name : typeof error,
  cause_message: message,
  cause_stack_head: isError && error.stack ? error.stack : null,
 }, roots);
}

type ActivationReceipt = { schema_version: 1; id: string; before: KitInstallation; after: KitInstallation; state: "READY" | "UNDO_PENDING" | "RESTORED" };

function directory(path: string): void {
 if (!isAbsolute(path) || resolve(path) !== path) throw new Error("UNSAFE_KIT_PREFIX");
 const stat = lstatSync(path);
 if (!stat.isDirectory() || realpathSync(path) !== path || stat.uid !== process.getuid?.()) throw new Error("UNSAFE_KIT_PREFIX");
}
function assertRegular(path: string): void {
 if (!isAbsolute(path) || resolve(path) !== path) throw new Error("UNSAFE_KIT_SOURCE");
 const stat = lstatSync(path);
 if (!stat.isFile() || realpathSync(path) !== path) throw new Error("UNSAFE_KIT_SOURCE");
}
function regular(path: string): Buffer {
 assertRegular(path);
 return readFileSync(path);
}
function relativeTarget(version: string): string {
 if (!VERSION.test(version)) throw new Error("KIT_VERSION_UNVERIFIED");
 return `../releases/${version}/bin/omp-kit`;
}
function installedBinary(prefix: string, version: string): string {
 return join(prefix, "releases", version, "bin", "omp-kit");
}
function verifiedRelease(root: string, manifest: ReleaseManifest, manifestSha256: string): boolean {
 try {
  const file = join(root, "release-manifest.json");
  if (!lstatSync(file).isFile() || shaFile(file) !== manifestSha256) return false;
  return manifest.files.every(entry => {
   const target = join(root, entry.path);
   return lstatSync(target).isFile() && shaFile(target) === entry.sha256;
  });
 } catch { return false; }
}

function releaseTestExpectations(staged: StagedKitRelease): FastTestExpectations {
	try {
		const root = staged.root, manifest = staged.manifest;
		const readVerified = (path: string): Buffer => {
			const entry = manifest.files.find(file => file.path === path);
			if (!entry) throw new Error("KIT_POSTCHECK_FAILED");
			const bytes = regular(join(root, path));
			if (createHash("sha256").update(bytes).digest("hex") !== entry.sha256) throw new Error("KIT_POSTCHECK_FAILED");
			return bytes;
		};
		const rules = parseRuleManifest(readVerified("MANIFEST.tsv").toString("utf8"));
		const { cases, quietCases } = countCaseRows(readVerified("cases/cases.tsv").toString("utf8"));
		let ttsrRules = 0;
		for (const rule of rules) if (rule.ruleClass !== "always") ttsrRules++;
		return { rules: rules.length, ttsrRules, cases, quietCases };
	} catch {
		rmSync(staged.root, { recursive: true, force: true });
		throw new Error("KIT_POSTCHECK_FAILED");
	}
}
function readInstallation(prefix: string): { target: string; binary: string; sha256: string } {
 directory(prefix);
 directory(join(prefix, "bin"));
 directory(join(prefix, "releases"));
 const link = join(prefix, "bin", "omp-kit");
 if (!lstatSync(link).isSymbolicLink()) throw new Error("KIT_LINK_UNVERIFIED");
 const target = readlinkSync(link);
 const match = /^\.\.\/releases\/([^/]+)\/bin\/omp-kit$/.exec(target);
 if (!match || target !== relativeTarget(match[1]!)) throw new Error("KIT_LINK_UNVERIFIED");
 const releaseRoot = join(prefix, "releases", match[1]!);
 directory(releaseRoot);
 directory(join(releaseRoot, "bin"));
 const binary = installedBinary(prefix, match[1]!);
 if (!lstatSync(binary).isFile() || realpathSync(binary) !== binary) throw new Error("KIT_BINARY_UNVERIFIED");
 return { target, binary, sha256: shaFile(binary) };
}

/** Probe the actual installed/staged executable without inheriting the operator's HOME or OMP environment. */
async function binaryInfo(path: string): Promise<BinaryReleaseInfo> {
 const child = Bun.spawn([path, "--info", "--json"], {
  env: { PATH: "/usr/bin:/bin", HOME: "/nonexistent", XDG_CONFIG_HOME: "/nonexistent", XDG_DATA_HOME: "/nonexistent", XDG_STATE_HOME: "/nonexistent" },
  stdout: "pipe", stderr: "pipe",
 });
 const [code, stdout] = await Promise.all([child.exited, new Response(child.stdout).text()]);
 if (code !== 0) throw new Error("KIT_IDENTITY_UNVERIFIED");
 let value: unknown;
 try { value = JSON.parse(stdout); } catch { throw new Error("KIT_IDENTITY_UNVERIFIED"); }
 if (!value || typeof value !== "object") throw new Error("KIT_IDENTITY_UNVERIFIED");
 const envelope = value as Record<string, unknown>;
 const data: unknown = envelope.data && typeof envelope.data === "object" ? envelope.data : envelope;
 if (!data || typeof data !== "object" || !("version" in data) || typeof data.version !== "string" ||
  !("platform" in data) || !data.platform || typeof data.platform !== "object" ||
  !("os" in data.platform) || typeof data.platform.os !== "string" ||
  !("arch" in data.platform) || typeof data.platform.arch !== "string") throw new Error("KIT_IDENTITY_UNVERIFIED");
 const release: unknown = "release" in data && data.release && typeof data.release === "object" ? data.release : data;
 if (!release || typeof release !== "object" || !("source_tag" in release) || typeof release.source_tag !== "string")
  throw new Error("KIT_IDENTITY_UNVERIFIED");
 return { version: data.version, source_tag: release.source_tag, platform: { os: data.platform.os, arch: data.platform.arch } };
}
async function currentInstallation(prefix: string, platform: ReleasePlatform): Promise<KitInstallation> {
 const observed = readInstallation(prefix);
 const info = await binaryInfo(observed.binary);
 if (info.platform.os !== platform.os || info.platform.arch !== platform.arch || observed.target !== relativeTarget(info.version) || info.source_tag !== `v${info.version}`)
  throw new Error("KIT_IDENTITY_UNVERIFIED");
 return { ...observed, version: info.version };
}
function localIndex(input: KitUpdateInput): { raw: string; archivePath: string } {
 if (!VERSION.test(input.version) || input.sourceTag !== `v${input.version}` ||
  !isAbsolute(input.indexPath) || !isAbsolute(input.archivePath)) throw new Error("LOCAL_SOURCE_REQUIRED");
 const raw = regular(input.indexPath).toString("utf8");
 const index = parseReleaseIndexJson(raw);
 const asset = index.assets[`${input.platform.os}-${input.platform.arch}-${input.platform.libc}`];
 if (index.version !== input.version || index.source_tag !== input.sourceTag || !asset ||
  basename(input.archivePath) !== asset.filename || dirname(input.archivePath) !== dirname(input.indexPath)) throw new Error("LOCAL_SOURCE_REQUIRED");
 // A plan must not print a digest it never observed: hash the archive bytes against the index before previewing.
 let observed: string;
 try { assertRegular(input.archivePath); observed = shaFile(input.archivePath); }
 catch (error) { throw new Error(error instanceof Error && error.message === "UNSAFE_KIT_SOURCE" ? "UNSAFE_KIT_SOURCE" : "LOCAL_SOURCE_REQUIRED"); }
 if (observed !== asset.sha256) throw new Error("ARCHIVE_DIGEST_MISMATCH");
 return { raw, archivePath: input.archivePath };
}

/** Read-only preview. Checksums co-hosted with an index prove integrity, not publisher authenticity. */
export async function planKitUpdate(input: KitUpdateInput): Promise<KitUpdatePreview> {
 try {
  if (!isAbsolute(input.home) || input.project && !isAbsolute(input.project)) throw new Error("UNSAFE_KIT_INPUT");
  const current = await currentInstallation(input.prefix, input.platform);
  const source = localIndex(input);
  const release = await previewKitRelease({ currentVersion: current.version, currentSha256: current.sha256, platform: input.platform,
   selectedVersion: input.version, sourceTag: input.sourceTag, fetchIndex: async () => source.raw });
  if (release.exitCode !== 0) return { status: release.status, exitCode: release.exitCode, reason: release.reason, provenance: "UNVERIFIED" };
  if (release.status === "UPDATE_AVAILABLE" &&
   lstatSync(join(input.prefix, "releases", release.version), { throwIfNoEntry: false }))
   throw new Error("KIT_TARGET_EXISTS");
  return { ...input, current, release, status: release.status, exitCode: 0, provenance: "INTEGRITY_ONLY" };
 } catch (error) {
  const message = error instanceof Error ? error.message : "KIT_STATE_UNVERIFIED";
  const reason = /^[A-Z][A-Z_]+$/.test(message) ? message : "KIT_STATE_UNVERIFIED";
  return { status: "REFUSED", exitCode: 2, reason, provenance: "UNVERIFIED" };
 }
}

function syncDirectory(path: string): void {
 const fd = openSync(path, constants.O_RDONLY);
 try { fsyncSync(fd); } finally { closeSync(fd); }
}
function writeReceipt(stateRoot: string, receipt: ActivationReceipt): void {
 atomicReplaceBytes(join(stateRoot, `kit-activation-${receipt.id}.json`), Buffer.from(JSON.stringify(receipt)), { mode: 0o600, durability: "full" });
}
function readReceipt(stateRoot: string, id: string): ActivationReceipt {
 if (!RECEIPT_ID.test(id)) throw new Error("KIT_RECEIPT_INVALID");
 const path = join(stateRoot, `kit-activation-${id}.json`);
 const stat = lstatSync(path);
 if (!stat.isFile() || stat.mode & 0o077 || stat.uid !== process.getuid?.()) throw new Error("KIT_RECEIPT_INVALID");
 const value: unknown = JSON.parse(regular(path).toString("utf8"));
 if (!value || typeof value !== "object") throw new Error("KIT_RECEIPT_INVALID");
 const receipt = value as ActivationReceipt;
 if (receipt.schema_version !== 1 || receipt.id !== id || !["READY", "UNDO_PENDING", "RESTORED"].includes(receipt.state) ||
  !receipt.before || !receipt.after || !VERSION.test(receipt.before.version) || !VERSION.test(receipt.after.version) ||
  ![receipt.before.sha256, receipt.after.sha256].every(hash => isSha256Hex(hash))) throw new Error("KIT_RECEIPT_INVALID");
 return receipt;
}
function switchLink(prefix: string, version: string): void {
 const bin = join(prefix, "bin");
 directory(bin);
 const staged = join(bin, `.omp-kit-switch-${randomUUID()}`);
 symlinkSync(relativeTarget(version), staged);
 try { renameSync(staged, join(bin, "omp-kit")); syncDirectory(bin); }
 finally {
  try { unlinkSync(staged); }
  catch (error) {
   if (!error || typeof error !== "object" || !("code" in error) || error.code !== "ENOENT") throw error;
  }
 }
}
function matches(prefix: string, image: KitInstallation): boolean {
 try {
  const current = readInstallation(prefix);
  return current.target === image.target && current.binary === image.binary && current.sha256 === image.sha256;
 } catch { return false; }
}
const notRun = (): KitPostcheck => ({ status: "NOT_RUN", matcher: "NOT_RUN", live: "NOT_RUN" });

type OmpSnapshot = { launcher: string; packageRoot: string; source: string; nativeRoot: string;
 version: string; launcherSha256: string; manifestSha256: string; matcherSha256: string };
function selectedOmpSnapshot(): OmpSnapshot | null {
 try {
  const identity = resolveOmpIdentity(process.env);
  const manifestPath = join(identity.packageRoot, "package.json");
  const parsed: unknown = JSON.parse(readFileSync(manifestPath, "utf8"));
  if (!parsed || typeof parsed !== "object" || !("version" in parsed) || typeof parsed.version !== "string" || !VERSION.test(parsed.version))
   return null;
  const matcher = createHash("sha256");
  for (const file of ["export/ttsr.ts", "capability/rule.ts", "discovery/helpers.ts"])
   matcher.update(shaFile(join(identity.source, file)));
  return { ...identity, version: parsed.version, launcherSha256: shaFile(identity.launcher),
   manifestSha256: shaFile(manifestPath), matcherSha256: matcher.digest("hex") };
 } catch { return null; }
}
function sameOmpSnapshot(before: OmpSnapshot | null, after: OmpSnapshot | null): boolean {
 return !!before && !!after && before.launcher === after.launcher && before.packageRoot === after.packageRoot &&
  before.source === after.source && before.nativeRoot === after.nativeRoot && before.version === after.version &&
  before.launcherSha256 === after.launcherSha256 && before.manifestSha256 === after.manifestSha256 &&
  before.matcherSha256 === after.matcherSha256;
}
/** owner/repo slug for the attestation authority; mirrors kit-update-job.ts so the compiled updater never imports it. */
const UPDATE_REPO_PATTERN = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const UPDATE_REPO_DEFAULT = "JYeswak/omp-kit-companion";
const MAX_ATTESTATION_BYTES = 16 * 1024 * 1024;

/** The attestation authority: OMP_KIT_UPDATE_REPO or the release default both release-local.sh and install.py assume. */
function attestationRepo(): string {
 const repo = process.env.OMP_KIT_UPDATE_REPO ?? UPDATE_REPO_DEFAULT;
 if (!UPDATE_REPO_PATTERN.test(repo)) throw new Error("KIT_UPDATE_POLL_CONFIG: OMP_KIT_UPDATE_REPO must be owner/repo");
 return repo;
}

/** Child environment for the authority calls: caller GitHub authentication without unrelated process secrets. */
function attestationEnv(home: string, tmpdir: string): Record<string, string> {
 const env: Record<string, string> = {
  PATH: process.env.PATH ?? "/usr/bin:/bin",
  HOME: home,
  TMPDIR: tmpdir,
  XDG_CACHE_HOME: join(tmpdir, "cache"),
 };
 for (const key of ["GH_CONFIG_DIR", "GH_TOKEN", "GITHUB_TOKEN"] as const) {
  const value = process.env[key];
  if (value) env[key] = value;
 }
 return env;
}

/**
 * Fetch the Sigstore bundle the authority filed for this exact archive digest, exactly as
 * scripts/release-local.sh:383 and kit-update-job.ts do. Anything short of usable bytes refuses with
 * KIT_ATTESTATION_BUNDLE_UNAVAILABLE: the fetch, never the archive, is what failed.
 */
async function fetchAttestationBundle(archive: Buffer, home: string, tmpdir: string): Promise<Buffer> {
 const digest = createHash("sha256").update(archive).digest("hex");
 const fetched = await run(["gh", "api", "--hostname", "github.com", `repos/${attestationRepo()}/attestations/sha256:${digest}`,
  "--jq", ".attestations[].bundle | tojson"], { deadline_s: 60, env: attestationEnv(home, tmpdir) });
 // The lead's manual fetch of this exact endpoint completed in under 2 s; 60 s is a generous bound.
 if (fetched.timed_out) throw new Error("KIT_ATTESTATION_BUNDLE_UNAVAILABLE: gh api timed out after 60 s");
 const stderr = new TextDecoder().decode(fetched.stderr);
 if (fetched.rc !== 0 || fetched.stdout.byteLength === 0 || fetched.stdout.byteLength > MAX_ATTESTATION_BYTES)
  throw new Error(`KIT_ATTESTATION_BUNDLE_UNAVAILABLE: ${stderr.trim().slice(-1000)}`);
 return Buffer.from(fetched.stdout);
}

/** Verify the exact in-memory archive subsequently staged, never a mutable source pathname. */
async function authenticateUpdateArchive(plan: KitUpdatePlan, archive: Buffer): Promise<void> {
 const snapshot = ownedTmp("kit-attestation", { root: plan.stateRoot }).path;
 try {
  // A co-hosted bundle still wins; only an absent sibling is fetched, never a present-but-unusable one.
  const bundlePath = `${plan.archivePath}.sigstore.json`;
  const bundleStat = lstatSync(bundlePath, { throwIfNoEntry: false });
  let bundle: Buffer;
  if (bundleStat === undefined) bundle = await fetchAttestationBundle(archive, plan.home, snapshot);
  else {
   if (!bundleStat.isFile() || bundleStat.isSymbolicLink()) throw new Error("KIT_ATTESTATION_BUNDLE_MISSING");
   if (bundleStat.size > MAX_ATTESTATION_BYTES) throw new Error("KIT_ATTESTATION_BUNDLE_INVALID");
   bundle = regular(bundlePath);
  }
  const artifact = join(snapshot, basename(plan.archivePath));
  writeFileSync(artifact, archive, { mode: 0o600, flag: "wx" });
  writeFileSync(`${artifact}.sigstore.json`, bundle, { mode: 0o600, flag: "wx" });
  let child;
  try {
   child = Bun.spawn(["python3", "-I", "-c", readFileSync(installerVerifierPath, "utf8"), "attestation", artifact, plan.version, "unused"], {
    env: attestationEnv(plan.home, snapshot),
    stdout: "pipe", stderr: "pipe",
   });
  } catch { throw new Error("KIT_ATTESTATION_VERIFIER_UNAVAILABLE"); }
  const [code, , stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
  if (code !== 0) {
   const reason = ["KIT_ATTESTATION_BUNDLE_MISSING", "KIT_ATTESTATION_BUNDLE_INVALID", "KIT_ATTESTATION_BUNDLE_UNAVAILABLE", "KIT_ATTESTATION_SOURCE_UNVERIFIED", "KIT_ATTESTATION_VERIFIER_UNAVAILABLE"]
    .find(code => stderr.includes(code)) ?? "KIT_ATTESTATION_UNVERIFIED";
   throw new Error(`${reason}: ${stderr.trim().slice(-1200)}`);
  }
 } finally { rmSync(snapshot, { recursive: true, force: true }); }
}

/**
 * The kit postcheck verdict from a full-test report and the selected OMP's identity. PASS needs an unchanged, known
 * OMP and every matcher, live and stage proof. A report DEFERRED by heavy admission becomes DEFERRED with reason
 * KIT_POSTCHECK_DEFERRED and live NOT_RUN: the release was not judged, which is neither its pass nor its failure.
 */
export function judgeKitPostcheck(report: FullTestReport, omp: { identityKnown: boolean; changed: boolean }): KitPostcheck {
 const matcher = report.fast.status === "PASS" && report.fast.proofs.G1_registration.status === "PASS" && report.fast.proofs.G2_payload.status === "PASS" && report.fast.proofs.G3_quiet_prefix.status === "PASS" ? "PASS" : "FAIL";
 const deferred = report.status === "DEFERRED";
 const live = deferred ? "NOT_RUN" : report.proofs.G4_live.status === "PASS" && Object.values(report.stages).every(stage => stage.status === "PASS") ? "PASS" : "FAIL";
 const reason = !omp.identityKnown
  ? report.omp_version === null ? "OMP_VERSION_UNVERIFIED" : "OMP_VERSION_MISMATCH"
  : matcher !== "PASS" ? "KIT_FAST_TEST_FAILED"
  : deferred ? "KIT_POSTCHECK_DEFERRED"
  : live !== "PASS" ? "KIT_LIVE_TEST_FAILED"
  : report.status !== "PASS" || report.exitCode !== 0 ? "KIT_POSTCHECK_FAILED" : undefined;
 const judged = !omp.changed && omp.identityKnown && matcher === "PASS";
 const status = !judged ? "FAIL" : deferred ? "DEFERRED" : report.status === "PASS" && report.exitCode === 0 && live === "PASS" ? "PASS" : "FAIL";
 return { status, matcher, live, report, ...(reason ? { reason } : {}) };
}

/** Retains the update lock across staged activation, the real matcher, and the isolated P09 ladder. */
export async function applyKitUpdate(plan: KitUpdatePlan): Promise<KitUpdateResult> {
 if (plan.exitCode !== 0 || plan.provenance !== "INTEGRITY_ONLY") throw new Error("STALE_KIT_PLAN");
 const heldLock = acquireKitUpdateLock(plan.stateRoot);
 let receiptId: string | null = null;
 try {
  const current = await currentInstallation(plan.prefix, plan.platform);
  let source: { raw: string; archivePath: string };
  try { source = localIndex(plan); } catch { throw new Error("STALE_KIT_PLAN"); }
  assertFreshKitPlan(plan.release, { currentVersion: current.version, currentSha256: current.sha256, index: parseReleaseIndexJson(source.raw), platform: plan.platform });
  if (current.target !== plan.current.target || current.binary !== plan.current.binary) throw new Error("STALE_KIT_PLAN");
  if (inspectPendingKitUpdate(plan.stateRoot)) throw new Error("PENDING_RECOVERY");
  if (plan.status === "CURRENT") return { status: "CURRENT", exitCode: 0, receiptId: null, activeVersion: current.version, postcheck: notRun(), provenance: "INTEGRITY_ONLY" };
  if (plan.status !== "UPDATE_AVAILABLE" || plan.release.status !== "UPDATE_AVAILABLE") throw new Error("STALE_KIT_PLAN");
  directory(join(plan.prefix, "releases"));
  const targetRoot = join(plan.prefix, "releases", plan.release.version);
  if (lstatSync(targetRoot, { throwIfNoEntry: false })) throw new Error("KIT_TARGET_EXISTS");
  const selectedOmp = selectedOmpSnapshot();
  // Authenticate a private snapshot before any extraction, candidate execution, or activation.
  const archive = regular(source.archivePath);
  await authenticateUpdateArchive(plan, archive);
  const staged = await stageKitRelease({ archive, plan: plan.release, stagingParent: join(plan.prefix, "releases"), probeBinaryInfo: binaryInfo });
  const expectedCounts = releaseTestExpectations(staged);
  const next: KitInstallation = { version: staged.version, target: relativeTarget(staged.version), binary: installedBinary(plan.prefix, staged.version),
   sha256: staged.manifest.files.find(file => file.path === "bin/omp-kit")!.sha256 };
  let postcheck = notRun();
  try {
   receiptId = beginKitUpdateReceipt(plan.stateRoot, heldLock, {
    scope: "kit", identitySha256: current.sha256, kitVersion: current.version, ompVersion: null, channel: null,
   }).id;
   writeReceipt(plan.stateRoot, { schema_version: 1, id: receiptId, before: current, after: next, state: "READY" });
   if (!matches(plan.prefix, current)) throw new Error("STALE_KIT_PLAN");
   renameSync(staged.root, targetRoot);
   syncDirectory(join(plan.prefix, "releases"));
   if (!verifiedRelease(targetRoot, staged.manifest, plan.release.asset.manifest_sha256)) throw new Error("KIT_STAGE_CHANGED");
   switchLink(plan.prefix, staged.version);
   if (!matches(plan.prefix, next)) throw new Error("KIT_POSTIMAGE_CHANGED");
   const report = await runFullTest({ root: targetRoot, executablePath: join(plan.prefix, "bin", "omp-kit"), home: plan.home, project: plan.project, stateRoot: plan.stateRoot } satisfies FullTestInput, expectedCounts);
   const observedOmp = selectedOmpSnapshot();
   const ompIdentityKnown = selectedOmp !== null && observedOmp !== null && report.omp_version !== null && report.omp_version === selectedOmp.version;
   const ompChanged = selectedOmp !== null && observedOmp !== null &&
    (!sameOmpSnapshot(selectedOmp, observedOmp) || (report.omp_version !== null && report.omp_version !== selectedOmp.version));
   postcheck = judgeKitPostcheck(report, { identityKnown: ompIdentityKnown, changed: ompChanged });
   if (ompChanged) throw new Error("OMP_CHANGED_DURING_KIT_UPDATE");
   if (postcheck.status !== "PASS" || !matches(plan.prefix, next) ||
    !verifiedRelease(targetRoot, staged.manifest, plan.release.asset.manifest_sha256)) throw new Error(postcheck.reason ?? "KIT_POSTCHECK_FAILED");
   reconcileKitUpdateReceipt(plan.stateRoot, heldLock, receiptId, () => matches(plan.prefix, next) &&
    verifiedRelease(targetRoot, staged.manifest, plan.release.asset.manifest_sha256) &&
    sameOmpSnapshot(selectedOmp, selectedOmpSnapshot()) && postcheck.status === "PASS");
   return { status: "UPDATED", exitCode: 0, receiptId, activeVersion: next.version, postcheck, provenance: "SIGSTORE_VERIFIED" };
  } catch (error) {
   if (!receiptId) throw error;
   const cause = updateFailureCause(error, [plan.home, plan.stateRoot, plan.prefix, plan.project ?? ""]);
   const message = error instanceof Error ? error.message : "KIT_UPDATE_INTERRUPTED";
   return { status: "PARTIAL", exitCode: 1, receiptId, activeVersion: matches(plan.prefix, next) ? next.version : matches(plan.prefix, current) ? current.version : null,
    postcheck: { ...postcheck, reason: /^[A-Z][A-Z_]+$/.test(message) ? message : "KIT_UPDATE_INTERRUPTED", cause }, provenance: "SIGSTORE_VERIFIED" };
  }
 } catch (error) {
  const message = error instanceof Error ? error.message : "KIT_UPDATE_REFUSED";
  if (error instanceof Error && message.startsWith("KIT_ATTESTATION_")) throw error;
  throw new Error(/^[A-Z][A-Z_]+$/.test(message) ? message : "KIT_UPDATE_REFUSED");
 } finally { heldLock.release(); }
}

/** A postcheck's named failed and heavy-deferred stages, changed operator paths, cause and first failures; null when nothing was reported. */
export type KitPostcheckDetail =
 | { status: FullTestReport["status"]; omp_version: string | null; live: FullTestReport["proofs"]["G4_live"]; failed_stages: string[];
  deferred_stages: string[]; current_stage: FullTestReport["current_stage"]; cause: FullTestCause | null; changed_operator_paths: string[]; failures: string[] }
 | { current_stage: null; cause: FullTestCause; failures: string[] };
/**
 * The detail of `postcheck`, redacted under `roots`, capped at 20 failures.
 * Shared by the `update --apply` envelope and the kit-update job record, so a failed unattended cycle keeps its reason.
 */
export function kitPostcheckDetail(postcheck: KitPostcheck, roots: readonly string[]): KitPostcheckDetail | null {
 const report = postcheck.report;
 const originalCause = report?.cause ?? postcheck.cause;
 const cause = originalCause ? redactFullTestCause(originalCause, roots) : null;
 return report ? {
  status: report.status, omp_version: report.omp_version, live: report.proofs.G4_live,
  failed_stages: [
   ...Object.entries(report.stages).filter(([, stage]) => stage.status === "FAIL").map(([name]) => name),
   ...(report.fast.status !== "PASS" ? ["fast-test"] : []),
   ...(report.omp_version === null ? ["omp-version"] : []),
  ],
  deferred_stages: Object.entries(report.stages).filter(([, stage]) => stage.status === "DEFERRED").map(([name]) => name),
  current_stage: report.current_stage,
  cause,
  changed_operator_paths: [...report.snapshots.home.changed_paths, ...report.snapshots.project.changed_paths],
  failures: report.failures.slice(0, 20),
 } : cause ? { current_stage: null, cause, failures: [] } : null;
}

/**
 * The `update --apply` CLI envelope. A failed postcheck names its stages and changed operator paths so the operator can act;
 * one heavy admission deferred is UNVERIFIED, not FAIL, and says so.
 */
export function kitUpdateEnvelope(plan: KitUpdatePlan, outcome: KitUpdateResult): PresentationResult {
 const postcheckDetail = kitPostcheckDetail(outcome.postcheck, [plan.home, plan.stateRoot, plan.prefix, plan.project ?? ""]);
 const recover = outcome.status === "PARTIAL" && outcome.receiptId ? `omp-kit undo ${outcome.receiptId} --yes` : null;
 const deferred = outcome.postcheck.status === "DEFERRED";
 return { code: outcome.exitCode, data: { overall: outcome.status === "PARTIAL" && !deferred ? "FAIL" : "UNVERIFIED",
  scope: "kit", action: outcome.status, receipt_id: outcome.receiptId, active_version: outcome.activeVersion,
  provenance: outcome.provenance, matcher: outcome.postcheck.matcher, live: outcome.postcheck.live,
  postcheck: outcome.postcheck.status, reason: outcome.postcheck.reason ?? null, postcheck_detail: postcheckDetail },
  ...(recover ? { commands: [recover], errors: [{ code: outcome.postcheck.reason ?? "KIT_POSTCHECK_FAILED",
   message: deferred
    ? `Kit update to ${plan.release.version} is active but unverified: heavy admission deferred its postcheck; ${postcheckDetail?.failures[0] ?? "see postcheck_detail"}`
    : `Kit update to ${plan.release.version} did not pass its postcheck; ${postcheckDetail?.failures[0] ?? "see postcheck_detail"}`,
   remediation: deferred
    ? `Run omp-kit test --full --record when load allows heavy work. To return to ${plan.current.version} and clear the pending receipt: ${recover}`
    : `Inspect postcheck_detail (--json). To return to ${plan.current.version} and clear the pending receipt: ${recover}` }] } : {}),
  verification: "UNVERIFIED" };
}

/** Only the recorded, unchanged postimage may switch back; the new release remains intact. */
export function undoKitUpdate(input: KitUndoInput): { status: "RESTORED"; receiptId: string; activeVersion: string; updatePending: boolean } {
 const heldLock = acquireKitUpdateLock(input.stateRoot);
 try {
  const receipt = readReceipt(input.stateRoot, input.receiptId);
  if (receipt.state !== "READY" || receipt.before.binary !== installedBinary(input.prefix, receipt.before.version) ||
   receipt.after.binary !== installedBinary(input.prefix, receipt.after.version) || receipt.before.target !== relativeTarget(receipt.before.version) ||
   receipt.after.target !== relativeTarget(receipt.after.version)) throw new Error("KIT_RECEIPT_INVALID");
  const known = auditMutations(input.stateRoot).find(row => row.id === receipt.id && row.kind === "update");
  if (!known || !["PENDING", "RECONCILED"].includes(known.status)) throw new Error("KIT_RECEIPT_INVALID");
  if (!matches(input.prefix, receipt.after)) throw new Error("POSTIMAGE_CHANGED");
  const priorBinary = installedBinary(input.prefix, receipt.before.version);
  if (!lstatSync(priorBinary).isFile() || realpathSync(priorBinary) !== priorBinary || shaFile(priorBinary) !== receipt.before.sha256)
   throw new Error("PRIOR_RELEASE_CHANGED");
  writeReceipt(input.stateRoot, { ...receipt, state: "UNDO_PENDING" });
  switchLink(input.prefix, receipt.before.version);
  if (!matches(input.prefix, receipt.before)) throw new Error("KIT_UNDO_PARTIAL");
  writeReceipt(input.stateRoot, { ...receipt, state: "RESTORED" });
  // A failed kit-only update is finished as compensated, never as a successful post-check.
  // An all-scope receipt may also cover an OMP change: keep it pending for separate recovery.
  const pending = inspectPendingKitUpdate(input.stateRoot);
  if (pending?.id === receipt.id && pending.scope === "kit") {
   try {
    abortCompensatedKitUpdateReceipt(input.stateRoot, heldLock, receipt.id, () => {
     const recorded = readReceipt(input.stateRoot, receipt.id);
     return recorded.state === "RESTORED" && matches(input.prefix, receipt.before) &&
      shaFile(installedBinary(input.prefix, receipt.after.version)) === receipt.after.sha256;
    });
   } catch { /* The symlink was restored; leave uncertain finalization visibly pending. */ }
  }
  const updatePending = inspectPendingKitUpdate(input.stateRoot)?.id === receipt.id;
  return { status: "RESTORED", receiptId: receipt.id, activeVersion: receipt.before.version, updatePending };
 } catch (error) {
  const message = error instanceof Error ? error.message : "KIT_UNDO_REFUSED";
  throw new Error(/^[A-Z][A-Z_]+$/.test(message) ? message : "KIT_UNDO_REFUSED");
 } finally { heldLock.release(); }
}

export interface KitReconcileVerified { target: string; binary: string; sha256: string; version: string }
export interface KitReconcileResult {
 status: "RECONCILED"; receiptId: string; activeVersion: string; verified: KitReconcileVerified;
}

/**
 * ompkit-3isy.1 UPDREC1: resolve a PARTIAL update whose postimages are in fact
 * correct (false postcheck). Marks RECONCILED — the bead's COMPENSATED/ACCEPTED —
 * only when the live install still matches the receipt's recorded postimage:
 * symlink target, binary path and binary bytes. Anything else refuses with the
 * pending receipt intact, so a later update stays blocked until a real fix.
 * Writes a reconcile record naming exactly what was verified.
 */
export function reconcilePendingUpdate(input: { stateRoot: string; prefix?: string | null; id: string }): KitReconcileResult {
 const heldLock = acquireKitUpdateLock(input.stateRoot);
 try {
  const pending = inspectPendingKitUpdate(input.stateRoot);
  if (!pending || pending.id !== input.id) throw new Error("KIT_RECEIPT_INVALID");
  let receipt;
  try {
   receipt = readReceipt(input.stateRoot, input.id);
  } catch (error) {
   if (error instanceof Error && "code" in error && error.code === "ENOENT") throw new Error("KIT_RECEIPT_INVALID");
   throw error;
  }
  if (receipt.state !== "READY") throw new Error("KIT_RECEIPT_INVALID");
  // The running binary's release root names the WRONG install on a stuck
  // machine (it predates the reconcile command). The recorded postimage
  // names the right one: strip the release suffix the same shape undo
  // already validates. An explicit --prefix wins outright and is validated
  // the same way, by matching rather than by derivation.
  let effectivePrefix: string;
  if (input.prefix !== undefined && input.prefix !== null) {
   effectivePrefix = input.prefix;
  } else {
   if (receipt.after.target !== relativeTarget(receipt.after.version)) throw new Error("KIT_RECEIPT_INVALID");
   const suffix = `/releases/${receipt.after.version}/bin/omp-kit`;
   if (!receipt.after.binary.endsWith(suffix)) throw new Error("KIT_RECEIPT_INVALID");
   effectivePrefix = receipt.after.binary.slice(0, receipt.after.binary.length - suffix.length);
   if (!isAbsolute(effectivePrefix) || resolve(effectivePrefix) !== effectivePrefix) throw new Error("KIT_RECEIPT_INVALID");
   if (receipt.after.binary !== installedBinary(effectivePrefix, receipt.after.version)) throw new Error("KIT_RECEIPT_INVALID");
  }
  let verified: KitReconcileVerified = { target: receipt.after.target, binary: receipt.after.binary,
   sha256: receipt.after.sha256, version: receipt.after.version };
  const rescan = (): boolean => {
   try {
    const live = readInstallation(effectivePrefix);
    if (live.target !== receipt.after.target || live.sha256 !== receipt.after.sha256) return false;
    verified = { target: live.target, binary: live.binary, sha256: live.sha256, version: receipt.after.version };
    return true;
   } catch { return false; }
  };
  reconcileKitUpdateReceipt(input.stateRoot, heldLock, input.id, rescan);
  writePrivate(join(input.stateRoot, `kit-reconcile-${input.id}.json`),
   JSON.stringify({ schema_version: 1, id: input.id, state: "RECONCILED", scope: pending.scope, verified }));
  return { status: "RECONCILED", receiptId: input.id, activeVersion: receipt.after.version, verified };
 } catch (error) {
  const message = error instanceof Error ? error.message : "KIT_RECONCILE_REFUSED";
  throw new Error(/^[A-Z][A-Z_]+$/.test(message) ? message : "KIT_RECONCILE_REFUSED");
 } finally { heldLock.release(); }
}
