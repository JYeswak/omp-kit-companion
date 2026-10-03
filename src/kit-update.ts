import { createHash, randomUUID } from "node:crypto";
import { closeSync, constants, fsyncSync, lstatSync, openSync, readFileSync, readlinkSync, readSync, realpathSync, renameSync, rmSync, symlinkSync, unlinkSync, writeSync } from "node:fs";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { assertFreshKitPlan, parseReleaseIndexJson, previewKitRelease, stageKitRelease, type BinaryReleaseInfo, type KitReleasePlan, type ReleaseManifest, type ReleasePlatform, type StagedKitRelease } from "./kit-release.ts";
import { runFullTest, type FullTestInput, type FullTestReport } from "./full-test-runner.ts";
import { abortCompensatedKitUpdateReceipt, acquireKitUpdateLock, auditMutations, beginKitUpdateReceipt, inspectPendingKitUpdate, reconcileKitUpdateReceipt } from "./mutations.ts";
import { resolveOmpIdentity } from "./paths.ts";
import type { PresentationResult } from "./output.ts";
import { parseRuleManifest } from "./diagnostics.ts";
import { countCaseRows, type FastTestExpectations } from "./test-runner.ts";
import { isSha256Hex } from "./regex-guards.ts";
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
 /** Explicit local integrity-only fixture. No public index or publisher provenance is available yet. */
 indexPath: string; archivePath: string; version: string; sourceTag: string;
};
export type KitUpdatePlan = KitUpdateInput & {
 status: "CURRENT" | "UPDATE_AVAILABLE"; exitCode: 0; release: KitReleasePlan;
 current: KitInstallation; provenance: "INTEGRITY_ONLY";
};
export type KitUpdateRefusal = { status: "REFUSED" | "NETWORK_UNAVAILABLE"; exitCode: 2 | 4; reason: string; provenance: "UNVERIFIED" };
export type KitUpdatePreview = KitUpdatePlan | KitUpdateRefusal;
export type KitPostcheck = { status: "PASS" | "FAIL" | "NOT_RUN"; matcher: "PASS" | "FAIL" | "NOT_RUN"; live: "PASS" | "FAIL" | "NOT_RUN"; report?: FullTestReport; reason?: string };
export type KitUpdateResult = { status: "UPDATED" | "CURRENT" | "PARTIAL"; exitCode: 0 | 1; receiptId: string | null; activeVersion: string | null; postcheck: KitPostcheck; provenance: "INTEGRITY_ONLY" };
export type KitUndoInput = { prefix: string; stateRoot: string; receiptId: string };

type ActivationReceipt = { schema_version: 1; id: string; before: KitInstallation; after: KitInstallation; state: "READY" | "UNDO_PENDING" | "RESTORED" };

function directory(path: string): void {
 if (!isAbsolute(path) || resolve(path) !== path) throw new Error("UNSAFE_KIT_PREFIX");
 const stat = lstatSync(path);
 if (!stat.isDirectory() || realpathSync(path) !== path || stat.uid !== process.getuid?.()) throw new Error("UNSAFE_KIT_PREFIX");
}
function regular(path: string): Buffer {
 if (!isAbsolute(path) || resolve(path) !== path) throw new Error("UNSAFE_KIT_SOURCE");
 const stat = lstatSync(path);
 if (!stat.isFile() || realpathSync(path) !== path) throw new Error("UNSAFE_KIT_SOURCE");
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
 const path = join(stateRoot, `kit-activation-${receipt.id}.json`);
 const temp = join(stateRoot, `.kit-activation-${randomUUID()}.tmp`);
 const fd = openSync(temp, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, 0o600);
 try {
  const bytes = Buffer.from(JSON.stringify(receipt));
  for (let offset = 0; offset < bytes.length;) {
   const written = writeSync(fd, bytes, offset, bytes.length - offset);
   if (written <= 0) throw new Error("KIT_RECEIPT_WRITE_FAILED");
   offset += written;
  }
  fsyncSync(fd);
 } finally { closeSync(fd); }
 renameSync(temp, path);
 syncDirectory(stateRoot);
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
  // An archive is read only from the explicit source paired to the revalidated index.
  const staged = await stageKitRelease({ archive: regular(source.archivePath), plan: plan.release, stagingParent: join(plan.prefix, "releases"), probeBinaryInfo: binaryInfo });
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
   const matcher = report.fast.status === "PASS" && report.fast.proofs.G1_registration.status === "PASS" && report.fast.proofs.G2_payload.status === "PASS" && report.fast.proofs.G3_quiet_prefix.status === "PASS" ? "PASS" : "FAIL";
   const live = report.proofs.G4_live.status === "PASS" && Object.values(report.stages).every(stage => stage.status === "PASS") ? "PASS" : "FAIL";
   const observedOmp = selectedOmpSnapshot();
   const ompIdentityKnown = selectedOmp !== null && observedOmp !== null && report.omp_version !== null && report.omp_version === selectedOmp.version;
   const ompChanged = selectedOmp !== null && observedOmp !== null &&
    (!sameOmpSnapshot(selectedOmp, observedOmp) || (report.omp_version !== null && report.omp_version !== selectedOmp.version));
   postcheck = { status: !ompChanged && ompIdentityKnown && report.status === "PASS" && report.exitCode === 0 && matcher === "PASS" && live === "PASS" ? "PASS" : "FAIL",
    matcher, live, report };
   if (ompChanged) throw new Error("OMP_CHANGED_DURING_KIT_UPDATE");
   if (postcheck.status !== "PASS" || !matches(plan.prefix, next) ||
    !verifiedRelease(targetRoot, staged.manifest, plan.release.asset.manifest_sha256)) throw new Error("KIT_POSTCHECK_FAILED");
   reconcileKitUpdateReceipt(plan.stateRoot, heldLock, receiptId, () => matches(plan.prefix, next) &&
    verifiedRelease(targetRoot, staged.manifest, plan.release.asset.manifest_sha256) &&
    sameOmpSnapshot(selectedOmp, selectedOmpSnapshot()) && postcheck.status === "PASS");
   return { status: "UPDATED", exitCode: 0, receiptId, activeVersion: next.version, postcheck, provenance: "INTEGRITY_ONLY" };
  } catch (error) {
   if (!receiptId) throw error;
   const message = error instanceof Error ? error.message : "KIT_UPDATE_INTERRUPTED";
   return { status: "PARTIAL", exitCode: 1, receiptId, activeVersion: matches(plan.prefix, next) ? next.version : matches(plan.prefix, current) ? current.version : null,
    postcheck: { ...postcheck, reason: /^[A-Z][A-Z_]+$/.test(message) ? message : "KIT_UPDATE_INTERRUPTED" }, provenance: "INTEGRITY_ONLY" };
  }
 } catch (error) {
  const message = error instanceof Error ? error.message : "KIT_UPDATE_REFUSED";
  throw new Error(/^[A-Z][A-Z_]+$/.test(message) ? message : "KIT_UPDATE_REFUSED");
 } finally { heldLock.release(); }
}

/** The `update --apply` CLI envelope. A failed postcheck names its stages and changed operator paths so the operator can act. */
export function kitUpdateEnvelope(plan: KitUpdatePlan, outcome: KitUpdateResult): PresentationResult {
 const report = outcome.postcheck.report;
 const postcheckDetail = report ? {
  status: report.status, omp_version: report.omp_version, live: report.proofs.G4_live,
  failed_stages: [
   ...Object.entries(report.stages).filter(([, stage]) => stage.status === "FAIL").map(([name]) => name),
   ...(report.fast.status !== "PASS" ? ["fast-test"] : []),
   ...(report.omp_version === null ? ["omp-version"] : []),
  ],
  changed_operator_paths: [...report.snapshots.home.changed_paths, ...report.snapshots.project.changed_paths],
  failures: report.failures.slice(0, 20),
 } : null;
 const recover = outcome.status === "PARTIAL" && outcome.receiptId ? `omp-kit undo ${outcome.receiptId} --yes` : null;
 return { code: outcome.exitCode, data: { overall: outcome.status === "PARTIAL" ? "FAIL" : "UNVERIFIED",
  scope: "kit", action: outcome.status, receipt_id: outcome.receiptId, active_version: outcome.activeVersion,
  provenance: outcome.provenance, matcher: outcome.postcheck.matcher, live: outcome.postcheck.live,
  postcheck: outcome.postcheck.status, reason: outcome.postcheck.reason ?? null, postcheck_detail: postcheckDetail },
  ...(recover ? { commands: [recover], errors: [{ code: outcome.postcheck.reason ?? "KIT_POSTCHECK_FAILED",
   message: `Kit update to ${plan.release.version} did not pass its postcheck; ${postcheckDetail?.failures[0] ?? "see postcheck_detail"}`,
   remediation: `Inspect postcheck_detail (--json). To return to ${plan.current.version} and clear the pending receipt: ${recover}` }] } : {}),
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
