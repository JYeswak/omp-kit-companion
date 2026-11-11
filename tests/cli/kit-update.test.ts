import { afterAll, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, readFileSync, readlinkSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { classifyLadder, fullTestVerdict, runFullTest } from "../../src/full-test-runner.ts";
import { runIsolatedShell } from "../../src/runtime.ts";
import { activeConcurrentWriterPaths, compareWatched, operatorWatchedPaths, snapshotWatched } from "../../src/operator-snapshot.ts";
import { acquireKitUpdateLock, auditMutations, beginKitUpdateReceipt, inspectPendingKitUpdate } from "../../src/mutations.ts";
import { applyKitUpdate, isUndoneCandidateReleaseDir, judgeKitPostcheck, kitPostcheckDetail, kitUpdateEnvelope, planKitUpdate, runKitPostcheck, undoKitUpdate, updateFailureCause } from "../../src/kit-update.ts";
import type { KitUpdatePlan, KitUpdateResult } from "../../src/kit-update.ts";
import { kitUpdateJobOverall, pollPublishedRelease } from "../../src/kit-update-job.ts";
import { serviceLabel } from "../../src/service.ts";
import { cleanupAllOwnedTmp, ownedTmp } from "../../src/kitlib/tmp";
import { run as runBounded } from "../../src/kitlib/run";
const repoRoot = resolve(import.meta.dir, "../..");
import { sha, binary, manifest, tar, fixture, input, RECONCILE_PROFILES,
 reconcilePluginLink, preparePartialReconcile, runPartialReconcile,
 buildCompiledReleaseFixture, hostPlatform, runCandidateFullTest, scratch } from "./kit-update-fixture.ts";
import type { CompiledReleaseFixture } from "./kit-update-fixture.ts";
import { fixtureDeadlineS } from "./fixture-process.ts";
import { gzipSync } from "node:zlib";

for (const compressed of [false, true]) test(`DRAFTGZIP1: published ${compressed ? ".tar.gz" : ".tar"} is downloaded, authenticated and extracted`, async () => fixture(async ctx => {
	const index = JSON.parse(readFileSync(ctx.indexPath, "utf8"));
	const asset = Object.values(index.assets)[0] as { filename: string; sha256: string };
	const bytes = compressed ? gzipSync(readFileSync(ctx.archivePath)) : readFileSync(ctx.archivePath);
	if (compressed) asset.filename += ".gz";
	asset.sha256 = sha(bytes);
	const previous = { poll: process.env.OMP_KIT_UPDATE_POLL, repo: process.env.OMP_KIT_UPDATE_REPO };
	process.env.OMP_KIT_UPDATE_POLL = "github";
	process.env.OMP_KIT_UPDATE_REPO = "fixture/kit";
	const patterns: string[] = [];
	try {
		const tuple = await pollPublishedRelease(ctx.prefix, ctx.stateRoot, ctx.platform, { exec: async argv => {
			if (argv[1] === "release" && argv[2] === "view") return { exit: 0, stdout: `v${ctx.nextVersion}`, stderr: "" };
			if (argv[1] === "release" && argv[2] === "download") {
				const pattern = argv[argv.indexOf("--pattern") + 1]!;
				patterns.push(pattern);
				const dir = argv[argv.indexOf("--dir") + 1]!;
				writeFileSync(join(dir, pattern), pattern === "release-index.json" ? JSON.stringify(index) : bytes);
				return { exit: 0, stdout: "", stderr: "" };
			}
			return { exit: 0, stdout: JSON.stringify({ fixture: true }), stderr: "" };
		} });
		expect(patterns).toEqual(["release-index.json", asset.filename]);
		expect(tuple).not.toBeNull();
		const plan = await planKitUpdate({ ...input(ctx), ...tuple });
		const result = await applyKitUpdate(plan);
		expect(result.status).toBe("PARTIAL");
		expect(result.provenance).toBe("SIGSTORE_VERIFIED");
		expect(existsSync(join(ctx.prefix, "releases", ctx.nextVersion, "bin", "omp-kit"))).toBe(true);
		// Planted: preserve the index's digest but replace the published asset's bytes.
		rmSync(tuple!.archivePath!);
		await expect(pollPublishedRelease(join(ctx.root, "uninstalled"), ctx.stateRoot, ctx.platform, { exec: async argv => {
			if (argv[2] === "view") return { exit: 0, stdout: `v${ctx.nextVersion}`, stderr: "" };
			const pattern = argv[argv.indexOf("--pattern") + 1]!;
			const dir = argv[argv.indexOf("--dir") + 1]!;
			writeFileSync(join(dir, pattern), pattern === "release-index.json" ? JSON.stringify(index) : Buffer.from("planted wrong bytes"));
			return { exit: 0, stdout: "", stderr: "" };
		} })).rejects.toThrow("KIT_UPDATE_POLL_UNVERIFIED");
	} finally {
		if (previous.poll === undefined) delete process.env.OMP_KIT_UPDATE_POLL; else process.env.OMP_KIT_UPDATE_POLL = previous.poll;
		if (previous.repo === undefined) delete process.env.OMP_KIT_UPDATE_REPO; else process.env.OMP_KIT_UPDATE_REPO = previous.repo;
	}
}), fixtureDeadlineS(60) * 1000);

test("KITUPDATELOAD1: a candidate scenario that cannot pass names its FAIL line in postcheck_detail; a passing run has none", async () => {
	const owned = ownedTmp("kit-update-fail-lines", { root: scratch });
	try {
		const scratchRoot = owned.path, buildHome = join(scratchRoot, "build-home");
		mkdirSync(buildHome, { mode: 0o700 });
		const detailOf = async (release: CompiledReleaseFixture) => {
			const report = await runCandidateFullTest(release, scratchRoot);
			return { report, detail: kitPostcheckDetail(judgeKitPostcheck(report, { identityKnown: true, changed: false }), [scratchRoot]) };
		};
		const control = await detailOf(await buildCompiledReleaseFixture(scratchRoot, repoRoot, buildHome, "1.2.3", hostPlatform));
		expect(control.report.status, JSON.stringify(control.report.failures)).toBe("PASS");
		expect(control.detail?.failures.filter(line => line.startsWith("FAIL  ")) ?? []).toEqual([]);
		// Planted: close-bare-fire still expects its block, but its command no longer closes anything.
		const planted = await detailOf(await buildCompiledReleaseFixture(scratchRoot, repoRoot, buildHome, "1.2.4", hostPlatform, source => {
			const path = join(source, "tests", "live", "scenarios.json");
			const bytes = readFileSync(path, "utf8");
			const mutated = bytes.replace("touch .ran_close-bare-fire; br close x", "touch .ran_close-bare-fire; br list");
			if (mutated === bytes) throw new Error("close-bare-fire plant did not apply");
			writeFileSync(path, mutated);
		}));
		expect(planted.report.status).toBe("FAIL");
		// KITUPDATECAUSE1: the CI-only runs that failed here kept no cause; print the planted report.
		expect(planted.detail?.failed_stages, JSON.stringify(planted.report)).toContain("e2e-live");
		expect(planted.detail?.failures.some(line => line.startsWith("FAIL  close-bare-fire :: ")), JSON.stringify(planted.detail)).toBe(true);
	} finally { owned.cleanup(); }
}, fixtureDeadlineS(1200) * 1000);

// A target owns its report and stage vocabulary; the old updater must not run its harness again.
test("UPDPOST1: candidate-owned postcheck preserves target failures and rejects malformed or contradictory output", async () => {
	const owned = ownedTmp("candidate-postcheck", { root: scratch });
	try {
		const executablePath = join(owned.path, "candidate");
		const invocation = { executablePath, home: owned.path, stateRoot: join(owned.path, "omp-kit") };
		const failed = { status: "FAIL", exitCode: 1, failures: ["Stage target-only returned producer_rc=7"],
			fast: { status: "FAIL", proofs: { G1_registration: { status: "FAIL" }, G2_payload: { status: "NOT_RUN" }, G3_quiet_prefix: { status: "NOT_RUN" } } },
			omp_version: null, stages: { "target-only": { status: "FAIL", producer_rc: 7 } },
			proofs: { G4_live: { status: "NOT_RUN" } }, snapshots: { home: { changed_paths: [] }, project: { changed_paths: [] } } };
		const candidate = (output: unknown, rc: number) => {
			writeFileSync(executablePath, `#!/bin/sh\nprintf '%s\\n' '${JSON.stringify(output).replaceAll("'", "'\\''")}'\nexit ${rc}\n`, { mode: 0o755 });
			chmodSync(executablePath, 0o755);
		};
		candidate({ data: { test: failed } }, 1);
		expect(await runKitPostcheck(invocation)).toEqual(failed);
		candidate({ data: { test: failed } }, 0);
		await expect(runKitPostcheck(invocation)).rejects.toThrow("KIT_POSTCHECK_REPORT_INVALID");
		candidate({ data: { test: { status: "PASS", exitCode: 0 } } }, 0);
		await expect(runKitPostcheck(invocation)).rejects.toThrow("KIT_POSTCHECK_REPORT_INVALID");
		candidate({ version: "future" }, 0);
		await expect(runKitPostcheck(invocation)).rejects.toThrow("KIT_POSTCHECK_REPORT_INVALID");
	} finally { owned.cleanup(); }
}, fixtureDeadlineS(10) * 1000);


test("unknown update failure preserves its code and original message", () => {
 expect(updateFailureCause(new Error("boom lower"))).toMatchObject({
  cause_code: "Error", cause_name: "Error", cause_message: "boom lower",
 });
});

test("UPDATERELINK1: native reconcile relinks every covered profile to the verified release", async () => fixture(async ctx => {
	const prepared = preparePartialReconcile(ctx);
	// STATERETAIN1: a reconcile is how every local install since 0.2.106 ended, so it retains like update does.
	const old = ["1.1.0", "1.1.1", "1.1.2", "1.1.3", "1.1.4", "1.1.5", "1.1.6"];
	for (const version of old) mkdirSync(join(ctx.prefix, "releases", version, "bin"), { recursive: true });
	const result = await runPartialReconcile(prepared);
	expect(result.rc).toBe(0);
	for (const profile of RECONCILE_PROFILES)
		expect(readlinkSync(reconcilePluginLink(ctx.home, profile))).toBe(prepared.store);
	expect(result.output.data).toMatchObject({ overall: "OK", action: "RECONCILED", plugin_relink: "APPLIED", active_version: ctx.nextVersion,
		retention: { status: "APPLIED" } });
	for (const version of ["1.1.0", "1.1.1", "1.1.2"]) expect(existsSync(join(ctx.prefix, "releases", version))).toBe(false);
	// Planted negative: the active release and the five before it, including the predecessor, survive.
	for (const version of ["1.1.3", "1.1.4", "1.1.5", "1.1.6", ctx.currentVersion, ctx.nextVersion])
		expect(existsSync(join(ctx.prefix, "releases", version))).toBe(true);
}), fixtureDeadlineS(60) * 1000);

test("UPDATERELINK1 planted negative: an incomplete profile relink cannot report OK", async () => fixture(async ctx => {
	const prepared = preparePartialReconcile(ctx, "codex");
	const result = await runPartialReconcile(prepared);
	expect(result.rc).toBe(1);
	expect(result.output.data).toMatchObject({ overall: "FINDINGS", action: "RECONCILED", plugin_relink: "NOT_RUN", active_version: ctx.nextVersion });
	expect(readlinkSync(reconcilePluginLink(ctx.home, "codex"))).toBe(prepared.oldStore);
	for (const profile of RECONCILE_PROFILES.filter(profile => profile !== "codex"))
		expect(readlinkSync(reconcilePluginLink(ctx.home, profile))).toBe(prepared.store);
}), fixtureDeadlineS(60) * 1000);



// ompkit-v66l.22 FLEETUPG1: 0.2.77 refused KIT_ATTESTATION_BUNDLE_MISSING because release-local.sh fetches
// the bundle only into its own verify step. The update verb now fetches it itself, exactly as
// scripts/release-local.sh:383 and kit-update-job.ts do, then verifies it with the same verifier.
test("a missing attestation bundle is fetched from the authority and verified before activation", async () => fixture(async ctx => {
 const plan = await planKitUpdate(input(ctx));
 if (plan.status !== "UPDATE_AVAILABLE") throw new Error("fixture plan rejected");
 rmSync(`${ctx.archivePath}.sigstore.json`);
 const result = await applyKitUpdate(plan);
 expect(result.status).toBe("PARTIAL");
 expect(result.receiptId).toBeTruthy();
 expect(result.provenance).toBe("SIGSTORE_VERIFIED");
 expect(result.postcheck.status).not.toBe("PASS");
 // The fetch authenticates a private snapshot; the operator's source tuple is left untouched.
 expect(existsSync(`${ctx.archivePath}.sigstore.json`)).toBe(false);
 expect(readlinkSync(join(ctx.prefix, "bin", "omp-kit"))).toBe("../releases/1.2.3/bin/omp-kit");
 expect(inspectPendingKitUpdate(ctx.stateRoot)?.id).toBe(result.receiptId);
}));

/** A gh double for the attestation authority: offline fetch, or a bundle filed for another archive. */
function fakeAuthorityGh(dir: string, behavior: "offline" | "wrong"): void {
 mkdirSync(dir, { recursive: true });
 const real = join(import.meta.dir, "../fixtures/kit-release/gh");
 const attestations = behavior === "offline"
  ? `if printf '%s\\n' "$@" | grep -q "attestations/sha256:"; then echo "fake gh: attestation store offline" >&2; exit 1; fi`
  : `if printf '%s\\n' "$@" | grep -q "attestations/sha256:"; then printf '{"fixture":false}'; exit 0; fi`;
 writeFileSync(join(dir, "gh"), `#!/bin/sh\n${attestations}\nexec "${real}" "$@"\n`, { mode: 0o755 });
 chmodSync(join(dir, "gh"), 0o755);
 process.env.PATH = `${dir}:${process.env.PATH}`;
}

test("planted: an unreachable attestation authority refuses without extraction or activation", async () => fixture(async ctx => {
 const plan = await planKitUpdate(input(ctx));
 if (plan.status !== "UPDATE_AVAILABLE") throw new Error("fixture plan rejected");
 rmSync(`${ctx.archivePath}.sigstore.json`);
 fakeAuthorityGh(join(ctx.root, "gh-offline"), "offline");
 await expect(applyKitUpdate(plan)).rejects.toThrow("KIT_ATTESTATION_BUNDLE_UNAVAILABLE");
 expect(existsSync(join(ctx.prefix, "releases", ctx.nextVersion))).toBe(false);
 expect(readlinkSync(join(ctx.prefix, "bin", "omp-kit"))).toBe(`../releases/${ctx.currentVersion}/bin/omp-kit`);
 expect(inspectPendingKitUpdate(ctx.stateRoot)).toBeNull();
}));

test("planted: a fetched bundle filed for another archive refuses without extraction or activation", async () => fixture(async ctx => {
 const plan = await planKitUpdate(input(ctx));
 if (plan.status !== "UPDATE_AVAILABLE") throw new Error("fixture plan rejected");
 rmSync(`${ctx.archivePath}.sigstore.json`);
 fakeAuthorityGh(join(ctx.root, "gh-wrong"), "wrong");
 await expect(applyKitUpdate(plan)).rejects.toThrow("KIT_ATTESTATION_UNVERIFIED");
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
 const refused = await planKitUpdate(input(ctx));
 expect(refused).toMatchObject({ exitCode: 2, status: "REFUSED", provenance: "UNVERIFIED" });
 const reason = refused.status === "REFUSED" ? refused.reason : "";
 expect(reason.startsWith("LOCAL_SOURCE_REQUIRED")).toBe(true);
 expect(reason).toContain(ctx.archivePath);
 expect(existsSync(ctx.stateRoot)).toBe(false);
}));

test("OUTSIDERDOCS1: a missing --archive path is refused naming the path", async () => fixture(async ctx => {
 const missing = join(ctx.source, "omp-kit-absent.tar");
 const refused = await planKitUpdate({ ...input(ctx), archivePath: missing });
 expect(refused).toMatchObject({ exitCode: 2, status: "REFUSED", provenance: "UNVERIFIED" });
 const reason = refused.status === "REFUSED" ? refused.reason : "";
 expect(reason.startsWith("LOCAL_SOURCE_REQUIRED")).toBe(true);
 expect(reason).toContain(missing);
 expect(existsSync(ctx.stateRoot)).toBe(false);
 // Control: the fixture's real paths still plan, so the refusal above is the missing path, not the fixture.
 expect(await planKitUpdate(input(ctx))).toMatchObject({ exitCode: 0, status: "UPDATE_AVAILABLE", provenance: "INTEGRITY_ONLY" });
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
 // UNDONETARGET1: the undone candidate is not a rollback target, so the same version re-plans and re-applies.
 const retry = await planKitUpdate(input(ctx));
 if (retry.status !== "UPDATE_AVAILABLE") throw new Error("compensated retry plan rejected");
 const retried = await applyKitUpdate(retry);
 expect(retried.status).toBe("PARTIAL");
 expect(retried.postcheck.status).not.toBe("PASS");
 expect(retried.receiptId).toBeTruthy();
 expect(retried.receiptId).not.toBe(result.receiptId);
 expect(readlinkSync(link)).toBe("../releases/1.2.3/bin/omp-kit");
 expect(inspectPendingKitUpdate(ctx.stateRoot)?.id).toBe(retried.receiptId);
}));

// ompkit-1ra0d.101: after a compensated (undone) update the same version re-applies without
// KIT_TARGET_EXISTS; a release dir that is the active install, pinned, or unknown still refuses.
test("UNDONETARGET1 planted: a compensated update retries the same version; other dirs still refuse", async () => fixture(async ctx => {
 const link = join(ctx.prefix, "bin", "omp-kit");
 const compensate = async () => {
  const planned = await planKitUpdate(input(ctx));
  if (planned.status !== "UPDATE_AVAILABLE") throw new Error("fixture plan rejected");
  const result = await applyKitUpdate(planned);
  if (result.status !== "PARTIAL" || !result.receiptId) throw new Error("fixture compensation rejected");
  const undone = undoKitUpdate({ prefix: ctx.prefix, stateRoot: ctx.stateRoot, receiptId: result.receiptId });
  expect(undone).toMatchObject({ status: "RESTORED", updatePending: false });
  expect(readlinkSync(link)).toBe("../releases/1.2.2/bin/omp-kit");
  return result.receiptId;
 };
 // Planted: the undone candidate is proven by its RESTORED receipt, so the retry clears it under lock.
 await compensate();
 expect(isUndoneCandidateReleaseDir(ctx.prefix, ctx.stateRoot, "1.2.3")).toBe(true);
 const retry = await planKitUpdate(input(ctx));
 if (retry.status !== "UPDATE_AVAILABLE") throw new Error("compensated retry plan rejected: " + JSON.stringify(retry));
 const retried = await applyKitUpdate(retry);
 expect(retried.status).toBe("PARTIAL");
 expect(readlinkSync(link)).toBe("../releases/1.2.3/bin/omp-kit");
 expect(inspectPendingKitUpdate(ctx.stateRoot)?.id).toBe(retried.receiptId);
}));

test("UNDONETARGET1 controls: active, pinned, unknown, and tampered dirs still refuse KIT_TARGET_EXISTS", async () => fixture(async ctx => {
 const link = join(ctx.prefix, "bin", "omp-kit");
 const targetRoot = join(ctx.prefix, "releases", "1.2.3");
 const plantDir = (bytes: Buffer) => {
  mkdirSync(join(targetRoot, "bin"), { recursive: true });
  writeFileSync(join(targetRoot, "bin", "omp-kit"), bytes);
 };
 // Control: a pinned/unknown dir with no undone proof refuses at plan time.
 const planned = await planKitUpdate(input(ctx));
 if (planned.status !== "UPDATE_AVAILABLE") throw new Error("fixture plan rejected");
 plantDir(binary("1.2.3"));
 expect(isUndoneCandidateReleaseDir(ctx.prefix, ctx.stateRoot, "1.2.3")).toBe(false);
 const refused = await planKitUpdate(input(ctx));
 expect(refused).toMatchObject({ status: "REFUSED", reason: "KIT_TARGET_EXISTS", exitCode: 2 });
 await expect(applyKitUpdate(planned)).rejects.toThrow("KIT_TARGET_EXISTS");
 // Control: a tampered undone candidate (bytes no longer match the receipt) refuses too.
 rmSync(targetRoot, { recursive: true, force: true });
 const compensate = async () => {
  const fresh = await planKitUpdate(input(ctx));
  if (fresh.status !== "UPDATE_AVAILABLE") throw new Error("fixture plan rejected");
  const result = await applyKitUpdate(fresh);
  if (result.status !== "PARTIAL" || !result.receiptId) throw new Error("fixture compensation rejected");
  expect(undoKitUpdate({ prefix: ctx.prefix, stateRoot: ctx.stateRoot, receiptId: result.receiptId }))
   .toMatchObject({ status: "RESTORED" });
 };
 await compensate();
 expect(isUndoneCandidateReleaseDir(ctx.prefix, ctx.stateRoot, "1.2.3")).toBe(true);
 writeFileSync(join(targetRoot, "bin", "omp-kit"), Buffer.from("tampered"));
 expect(isUndoneCandidateReleaseDir(ctx.prefix, ctx.stateRoot, "1.2.3")).toBe(false);
 expect(await planKitUpdate(input(ctx))).toMatchObject({ status: "REFUSED", reason: "KIT_TARGET_EXISTS", exitCode: 2 });
 // Control: the dir the live link points into is never cleared, even with a matching receipt.
 writeFileSync(join(targetRoot, "bin", "omp-kit"), binary("1.2.3"));
 expect(isUndoneCandidateReleaseDir(ctx.prefix, ctx.stateRoot, "1.2.3")).toBe(true);
 renameSync(link, join(ctx.prefix, "bin", "omp-kit.before"));
 symlinkSync("../releases/1.2.3/bin/omp-kit", link);
 expect(isUndoneCandidateReleaseDir(ctx.prefix, ctx.stateRoot, "1.2.3")).toBe(false);
 expect((await planKitUpdate(input(ctx))).status).toBe("CURRENT");
 renameSync(join(ctx.prefix, "bin", "omp-kit.before"), link);
}));

test("KITREC1: null activation requires known-good binary repair, not undo or reconciliation", async () => fixture(async ctx => {
 const planned = await planKitUpdate(input(ctx));
 if (planned.status !== "UPDATE_AVAILABLE") throw new Error("fixture plan rejected");
 const partial = { status: "PARTIAL" as const, exitCode: 1 as const, receiptId: "receipt-smoke",
  activeVersion: "1.2.4", provenance: "SIGSTORE_VERIFIED" as const,
  postcheck: { status: "NOT_RUN" as const, matcher: "NOT_RUN" as const, live: "NOT_RUN" as const,
   reason: "KIT_POSTIMAGE_CHANGED" } };
 const active = kitUpdateEnvelope(planned, partial);
 expect(active.code).toBe(1);
 expect(active.data.reason).toBe("KIT_POSTIMAGE_CHANGED");
 expect(active.commands).toEqual(["omp-kit undo receipt-smoke --yes"]);
 expect(active.errors?.[0]?.code).toBe("KIT_POSTIMAGE_CHANGED");

 const unverified = kitUpdateEnvelope(planned, { ...partial, activeVersion: null });
 expect(unverified.code).toBe(1);
 expect(unverified.data).toMatchObject({ overall: "FAIL", active_version: null, reason: "KIT_ACTIVATION_UNVERIFIED" });
 expect(unverified.commands ?? []).toEqual([]);
 expect(unverified.errors?.[0]?.code).toBe("KIT_ACTIVATION_UNVERIFIED");
 expect(unverified.errors?.[0]?.message).toContain("activation");
 expect(unverified.errors?.[0]?.remediation).toContain("known-good release binary");
 expect(unverified.errors?.[0]?.remediation).toContain("repair the stable link");
 expect(unverified.errors?.[0]?.remediation).not.toContain("omp-kit undo");
 expect(unverified.errors?.[0]?.remediation).not.toContain("omp-kit update --reconcile");
}));

// ACTGUIDE1 runs the canonical source in a fresh runtime. The default seam loads it
// unchanged; mutants are memory-only, so no product flag or copied source can ship.
async function actguideFixture(fixtureNumber: 1 | 2, arm: "case" | "mutant" = "case"): Promise<void> {
 await fixture(async ctx => {
  const script = `
import assert from "node:assert/strict";
import { readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { plugin } from "bun";
const fixtureNumber = ${fixtureNumber}, arm = ${JSON.stringify(arm)};
const target = ${JSON.stringify(join(repoRoot, "src"))} + (fixtureNumber === 1 ? "/kit-update.ts" : "/kit-update-job.ts");
let intercepted = false;
await plugin({ name: "actguide1-source", setup(build) {
 build.onLoad({ filter: /\\/src\\/kit-update(?:-job)?\\.ts$/ }, args => {
  let contents = readFileSync(args.path, "utf8");
  if (args.path === target) {
   intercepted = true;
   if (arm === "mutant") {
    // Restore the old undo-on-null policy; fixture 2's locked recovery now also rejects a guard bypass.
    const before = fixtureNumber === 1
     ? 'outcome.status === "PARTIAL" && outcome.activeVersion === null'
     : '"Use a known-good release binary to inspect the activation receipt and repair the stable link before reconciling."';
    const after = fixtureNumber === 1
     ? "false"
     : '("Run omp-kit undo " + result.receiptId + " --yes to restore the prior release.")';
    assert.equal(contents.split(before).length, 2, "ACTGUIDE1 mutant must change exactly one decision");
    contents = contents.replace(before, after);
   }
  }
  return { contents, loader: "ts" };
 });
} });
// Dynamic imports are intentional: the source-loader seam must register before module loading.
const { planKitUpdate, kitUpdateEnvelope } = await import(${JSON.stringify(join(repoRoot, "src/kit-update.ts"))});
const { acquireKitUpdateLock, beginKitUpdateReceipt, inspectPendingKitUpdate } = await import(${JSON.stringify(join(repoRoot, "src/mutations.ts"))});
const input = ${JSON.stringify(input(ctx))};
const plan = await planKitUpdate(input);
assert.equal(plan.status, "UPDATE_AVAILABLE");
const partial = { status: "PARTIAL", exitCode: 1, receiptId: "receipt-actguide1",
 activeVersion: null, provenance: "SIGSTORE_VERIFIED",
 postcheck: { status: "NOT_RUN", matcher: "NOT_RUN", live: "NOT_RUN", reason: "KIT_POSTIMAGE_CHANGED" } };
let guidance;
if (fixtureNumber === 1) {
 const envelope = kitUpdateEnvelope(plan, partial);
 assert.equal(envelope.code, 1);
 assert.equal(envelope.data.active_version, null);
 guidance = [...(envelope.commands ?? []), ...(envelope.errors ?? []).map(error => error.remediation ?? "")];
 if (arm === "case") {
  assert.equal(envelope.data.reason, "KIT_ACTIVATION_UNVERIFIED");
  assert.deepEqual(envelope.commands ?? [], []);
  assert.equal(envelope.errors[0].code, "KIT_ACTIVATION_UNVERIFIED");
  assert.ok(envelope.errors[0].remediation.includes("known-good release binary"));
 }
} else {
 const { runKitUpdateJob } = await import(${JSON.stringify(join(repoRoot, "src/kit-update-job.ts"))});
 const notes = [];
 const result = await runKitUpdateJob({ ...input, enabled: true, pollRelease: async () => input }, {
  plan: async () => plan,
  apply: async () => {
   const lock = acquireKitUpdateLock(input.stateRoot);
   try {
    partial.receiptId = beginKitUpdateReceipt(input.stateRoot, lock, { scope: "kit",
     identitySha256: "a".repeat(64), kitVersion: plan.current.version, ompVersion: null, channel: null }).id;
   } finally { lock.release(); }
   rmSync(join(input.prefix, "bin", "omp-kit"));
   return partial;
  },
  exec: async () => { throw new Error("ACTGUIDE1 must not contact the network"); },
  relink: async () => { throw new Error("ACTGUIDE1 must not relink an unverified activation"); },
  notify: message => { notes.push(message); },
 });
 assert.equal(result.status, "PENDING");
 assert.equal(result.activeVersion, null);
 assert.equal(result.receiptId, partial.receiptId);
 assert.equal(inspectPendingKitUpdate(input.stateRoot)?.id, partial.receiptId);
 assert.equal(result.relink, "NOT_RUN");
 assert.equal(result.service, "NOT_RUN");
 assert.equal(notes.length, 1);
 if (arm === "case") {
  assert.equal(result.reason, "KIT_ACTIVATION_UNVERIFIED");
  assert.ok(notes[0].includes("known-good release binary"));
 }
 guidance = notes;
}
assert.ok(intercepted, "source-loader seam must exercise the selected canonical path");
const wrong = Number(guidance.some(text => text.includes("omp-kit undo ")));
console.log(JSON.stringify({ wrong }));
`;
  const ran = await runBounded([process.execPath, "--no-env-file", "--config=/dev/null", "-e", script], {
   cwd: repoRoot, env: { ...process.env, OMP_KIT_UPDATE_POLL: "" },
   deadline_s: fixtureDeadlineS(30), max_output_bytes: 128 * 1024,
  });
  const stdout = new TextDecoder().decode(ran.stdout), stderr = new TextDecoder().decode(ran.stderr);
  expect({ rc: ran.rc, timed_out: ran.timed_out, truncated: ran.truncated }, stdout + stderr)
   .toEqual({ rc: 0, timed_out: false, truncated: false });
  const { wrong } = JSON.parse(stdout);
  console.log(`ACTGUIDE1 arm=${arm} fixture=${fixtureNumber} wrong=${wrong}`);
  expect(wrong).toBe(arm === "case" ? 0 : 1);
 }, { nextVersion: "1.2.4" });
}

test("ACTGUIDE1 case 1", () => actguideFixture(1), fixtureDeadlineS(40) * 1000);
test("ACTGUIDE1 case 2", () => actguideFixture(2), fixtureDeadlineS(40) * 1000);
test("ACTGUIDE1 mutant 1", () => actguideFixture(1, "mutant"), fixtureDeadlineS(40) * 1000);
test("ACTGUIDE1 mutant 2", () => actguideFixture(2, "mutant"), fixtureDeadlineS(40) * 1000);

// An operator facing PARTIAL must see which stages failed, which of their paths changed, and the exact recovery command.
test("failed postcheck envelope names failed stages, changed operator paths and the undo command", async () => fixture(async ctx => {
 const planned = await planKitUpdate(input(ctx));
 if (planned.status !== "UPDATE_AVAILABLE") throw new Error("fixture plan rejected");
 const result = await applyKitUpdate(planned);
 const report = result.postcheck.report;
 if (result.status !== "PARTIAL" || !result.receiptId || !report)
  throw new Error(`expected a PARTIAL outcome carrying its full-test report, observed ${JSON.stringify({ status: result.status, receipt: result.receiptId, postcheck: result.postcheck.status, reason: result.postcheck.reason, report: Boolean(report) })}`);
 const undoCommand = `omp-kit undo ${result.receiptId} --yes`;

 // The target's failed report already explains itself: the first failure is in the error message.
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
  // As applyKitUpdate does: redact with the plan roots before the 200-character bound, or a long export path is cut
  // mid-root and can no longer be redacted.
  cause: updateFailureCause(new Error(`interrupted at ${ctx.home}/private-context`), [planned.home, planned.stateRoot, planned.prefix]),
 } });
 expect(causeOnly.commands).toEqual([undoCommand]);
 expect(causeOnly.data.postcheck_detail).toMatchObject({
  current_stage: null, failures: [], cause: { cause_message: "interrupted at <private-path>/private-context" },
 });
 expect(causeOnly.errors?.[0]?.remediation).toContain(undoCommand);

 // Excluded browser namespaces are separately visible; a pending receipt needs reconcile, not only undo.
 const liveStateReport = { ...report, failures: [], cause: null, snapshots: {
  release: { unchanged: true, complete: true },
  home: { ...report.snapshots.home, changed_paths: [], incomplete_paths: [], complete: true,
   live_state_paths: ["~/.local/state/omp-kit/chrome-jfp"] },
  project: { ...report.snapshots.project, changed_paths: [], incomplete_paths: [], complete: true },
 } };
 const liveStateOutcome = { ...result, postcheck: { ...result.postcheck, matcher: "PASS" as const, live: "PASS" as const, report: liveStateReport } };
 const liveState = kitUpdateEnvelope(planned, liveStateOutcome);
 const reconcileCommand = `omp-kit update --reconcile ${result.receiptId} --yes`;
 expect(liveState.commands).toEqual([reconcileCommand]);
 expect(liveState.errors?.[0]?.remediation).toContain(reconcileCommand);
 expect(liveState.data.postcheck_detail).toMatchObject({ changed_operator_paths: [], live_state_paths: ["~/.local/state/omp-kit/chrome-jfp"] });
 const unverifiedLiveState = kitUpdateEnvelope(planned, { ...liveStateOutcome, activeVersion: null });
 expect(unverifiedLiveState.data.reason).toBe("KIT_ACTIVATION_UNVERIFIED");
 expect(unverifiedLiveState.commands ?? []).toEqual([]);
 expect(unverifiedLiveState.errors?.[0]?.remediation).toContain("known-good release binary");
 expect(unverifiedLiveState.errors?.[0]?.remediation).not.toContain(reconcileCommand);
 const operatorChanged = kitUpdateEnvelope(planned, { ...liveStateOutcome, postcheck: { ...liveStateOutcome.postcheck,
  report: { ...liveStateReport, failures: ["Operator file changed during isolated test: ~/.agents/rules/planted.md"],
   snapshots: { ...liveStateReport.snapshots, home: { ...liveStateReport.snapshots.home, changed_paths: ["~/.agents/rules/planted.md"] } } },
 } });
 expect(operatorChanged.commands).toEqual([undoCommand]);

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

/** One real concurrent process churns files and an operator-path control: the control proves it wrote inside the snapshot window. */
function startLoopWriter(files: string[], operatorFile: string): { stop: () => Promise<void> } {
	const appends = files.map(file => `printf '%s\\n' "$n" >> '${file}'`).join("; ");
	const writer = Bun.spawn(["/bin/sh", "-c", `n=0; while :; do n=$((n+1)); ${appends}; printf '%s\\n' "$n" > '${operatorFile}'; sleep 0.01; done`],
		{ stdout: "ignore", stderr: "inherit" });
	return { stop: async () => { writer.kill("SIGKILL"); await writer.exited; } };
}

/**
 * Deterministic snapshot-window write. The postcheck signals its before snapshots through
 * OMP_KIT_POSTCHECK_WINDOW_DIR (see holdPostcheckWindowForTestWrite) and waits for release;
 * this test's synchronous write then lands provably inside the snapshot window, while the
 * loop writer keeps churning so the concurrent-writer probe still observes a live writer.
 */
async function applyKitUpdateWithWindowWrite(planned: KitUpdatePlan, operatorFile: string): Promise<KitUpdateResult> {
	const window = ownedTmp("kit-update-window", { root: scratch });
	try {
		const previous = process.env.OMP_KIT_POSTCHECK_WINDOW_DIR;
		process.env.OMP_KIT_POSTCHECK_WINDOW_DIR = window.path;
		try {
			const pending = applyKitUpdate(planned);
			const beforeSentinel = join(window.path, "postcheck-before"), goSentinel = join(window.path, "postcheck-go");
			// Real-clock poll for a file the postcheck child writes; no fake timer reaches another process.
			// Bound by fixtureDeadlineS, well inside this test's own deadline so a stuck postcheck fails loudly.
			const deadline = Date.now() + fixtureDeadlineS(20) * 1000;
			while (!existsSync(beforeSentinel) && Date.now() < deadline) await Bun.sleep(10);
			const opened = existsSync(beforeSentinel);
			if (opened) writeFileSync(operatorFile, "postcheck window write\n");
			writeFileSync(goSentinel, "go\n");
			const result = await pending;
			if (!opened) throw new Error("postcheck window did not open: the postcheck never signaled its before snapshot");
			return result;
		} finally {
			if (previous === undefined) delete process.env.OMP_KIT_POSTCHECK_WINDOW_DIR; else process.env.OMP_KIT_POSTCHECK_WINDOW_DIR = previous;
		}
	} finally { window.cleanup(); }
}

// ompkit-2pkp1: on a live host the cc service writes its store every 15 s and every kit command appends its spool,
// so the postcheck must distinguish installed-job state and an unrelated live operator writer.
test("POSTCHECKBROWSER1: a concurrent operator writer is skipped; installed cc state remains ignored", async () => fixture(async ctx => {
	const stateHome = join(ctx.home, ".local", "state"), kitState = join(stateHome, "omp-kit"), cc = join(kitState, "cc");
	const plist = join(ctx.home, "Library", "LaunchAgents", `${serviceLabel("cc")}.plist`);
	const unit = join(ctx.home, ".config", "systemd", "user", "omp-kit-cc.service");
	for (const definition of [plist, unit]) { mkdirSync(dirname(definition), { recursive: true }); writeFileSync(definition, "installed\n"); }
	mkdirSync(join(cc, "spool", "kit"), { recursive: true });
	mkdirSync(join(ctx.home, ".agents", "rules"), { recursive: true });
	chmodSync(kitState, 0o700);
	const ccFiles = [join(cc, "cc.db"), join(cc, "spool", "kit", "2026-10-22.jsonl")];
	const operatorFile = join(ctx.home, ".agents", "rules", "planted.md");
	const loop = startLoopWriter(ccFiles, operatorFile);
	const previousXdg = process.env.XDG_STATE_HOME;
	process.env.XDG_STATE_HOME = stateHome;
	try {
		const planned = await planKitUpdate({ ...input(ctx), stateRoot: kitState });
		if (planned.status !== "UPDATE_AVAILABLE") throw new Error("fixture plan rejected");
		const result = await applyKitUpdateWithWindowWrite(planned, operatorFile);
		const report = result.postcheck.report;
		if (!report) throw new Error(`expected a full-test report, observed ${JSON.stringify(result.postcheck)}`);
		const operatorFailures = report.failures.filter(failure => failure.startsWith("Operator file changed"));
		expect(operatorFailures.some(failure => failure.endsWith("~/.agents/rules/planted.md")), JSON.stringify(report.failures)).toBe(false);
		expect(operatorFailures.filter(failure => failure.includes("/omp-kit/cc")), JSON.stringify(report.failures)).toEqual([]);
		expect(report.snapshots.home.changed_paths).not.toContain("~/.agents/rules/planted.md");
		expect(report.snapshots.home.unchanged).toBe(false);
		expect(report.snapshots.home.skipped_paths).toContainEqual({ path: "~/.agents/rules/planted.md", reason: "skipped-concurrent-writer" });
		expect(report.snapshots.home.changed_paths.filter(path => path.includes("/omp-kit/cc"))).toEqual([]);
	} finally {
		await loop.stop();
		if (previousXdg === undefined) delete process.env.XDG_STATE_HOME; else process.env.XDG_STATE_HOME = previousXdg;
	}
}, { postcheck: "real" }), fixtureDeadlineS(60) * 1000);


// ompkit-v66l.22 FLEETUPG1: browser caches are volatile; profile files that a separate live browser continues
// writing must be reported as skipped-concurrent-writer rather than failing the operator postcheck.
test("POSTCHECKBROWSER1: live browser profile writer is skipped while its cache subtree stays ignored", async () => fixture(async ctx => {
	const kitState = join(ctx.home, ".local", "state", "omp-kit");
	mkdirSync(kitState, { recursive: true });
	chmodSync(kitState, 0o700);
	const cacheDir = join(kitState, "chrome-jfp", "Default", "Cache", "Cache_Data");
	mkdirSync(cacheDir, { recursive: true });
	const cacheFiles = [join(cacheDir, "2f139af954fbeb4a_0"), join(cacheDir, "4e2f1001f03d45fd_0")];
	for (const file of cacheFiles) writeFileSync(file, "seed\n");
	mkdirSync(join(ctx.home, ".agents", "rules"), { recursive: true });
	const operatorFile = join(ctx.home, ".agents", "rules", "planted-cache.md");
	const loop = startLoopWriter(cacheFiles, operatorFile);
	try {
		const planned = await planKitUpdate({ ...input(ctx), stateRoot: kitState });
		if (planned.status !== "UPDATE_AVAILABLE") throw new Error("fixture plan rejected");
		const result = await applyKitUpdateWithWindowWrite(planned, operatorFile);
		const report = result.postcheck.report;
		if (!report) throw new Error(`expected a full-test report, observed ${JSON.stringify(result.postcheck)}`);
		const operatorFailures = report.failures.filter(failure => failure.startsWith("Operator file changed"));
		expect(operatorFailures.some(failure => failure.endsWith("~/.agents/rules/planted-cache.md")), JSON.stringify(report.failures)).toBe(false);
		expect(report.snapshots.home.changed_paths.filter(path => path.includes("chrome-jfp"))).toEqual([]);
		expect(report.snapshots.home.skipped_paths).toContainEqual({ path: "~/.agents/rules/planted-cache.md", reason: "skipped-concurrent-writer" });
		expect(report.snapshots.home.incomplete_paths.filter(path => path.includes("chrome-jfp"))).toEqual([]);
	} finally {
		await loop.stop();
	}
}, { postcheck: "real" }), fixtureDeadlineS(60) * 1000);

test("POSTCHECKBROWSER1 planted negative: an isolated test write to operator state remains a change", async () => fixture(async ctx => {
	const releaseRoot = join(ctx.prefix, "releases", ctx.currentVersion);
	const executablePath = join(releaseRoot, "bin", "omp-kit");
	const scriptDirectory = join(releaseRoot, "scripts");
	const rulesDirectory = join(ctx.home, ".agents", "rules");
	const operatorFile = join(rulesDirectory, "isolated-test.md");
	mkdirSync(scriptDirectory, { recursive: true });
	mkdirSync(rulesDirectory, { recursive: true });
	const quotedOperatorFile = `'${operatorFile.replaceAll("'", "'\\''")}'`;
	writeFileSync(join(scriptDirectory, "ladder.sh"),
		`#!/bin/sh\nprintf '%s\\n' 'written by isolated test' > ${quotedOperatorFile}\n`, { mode: 0o755 });
	const watched = operatorWatchedPaths(ctx.home, ctx.stateRoot);
	const before = snapshotWatched(watched);
	const result = await runIsolatedShell("scripts/ladder.sh", [], releaseRoot, executablePath);
	expect(result.code).toBe(0);
	const after = snapshotWatched(watched);
	const activeWriters = await activeConcurrentWriterPaths(before, after);
	const comparison = compareWatched(before, after, ctx.home, activeWriters);
	expect(comparison.changed_paths).toContain("~/.agents/rules/isolated-test.md");
	expect(comparison.skipped_paths).toEqual([]);
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

// ompkit-1ra0d.100: a regex-budget INCONCLUSIVE because the host is too slow to judge
// (REFERENCE_RATIO_ABOVE_CLAMP) defers the postcheck instead of failing the release; a genuinely
// over-budget rule at nominal load, and any other non-PASS stage, still fails it.
test("POSTCHECKLOAD1 planted: a too-slow-host regex-budget stage reports DEFERRED and keeps the release", async () => fixture(async ctx => {
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
 stages["regex-budget"] = { status: "DEFERRED", producer_rc: 75, duration_ms: 1,
  reason: "regex-budget INCONCLUSIVE on a too-slow host: REGEX-BUDGET: INCONCLUSIVE REFERENCE_RATIO_ABOVE_CLAMP (reference ratio 13.30 exceeds 8; this host is too slow to judge; not judged, not PASS)" };
 const deferral = "Stage regex-budget deferred: host too slow to judge (REFERENCE_RATIO_ABOVE_CLAMP)";
 // A candidate-owned report carries the slow-host stage without promoting report.status itself.
 const slowReport = { ...report, fast, stages, status: "FAIL" as const, exitCode: 1 as const, omp_version: "18.12.1", failures: [deferral] };
 const known = { identityKnown: true, changed: false };

 const postcheck = judgeKitPostcheck(slowReport, known);
 expect(postcheck).toMatchObject({ status: "DEFERRED", matcher: "PASS", live: "NOT_RUN", reason: "KIT_POSTCHECK_DEFERRED" });
 // Control: a genuinely over-budget rule at nominal load still fails the postcheck.
 const failedStages = { ...stages, "regex-budget": { status: "FAIL" as const, producer_rc: 1, duration_ms: 1,
  reason: "REGEX-BUDGET: FAIL rule slow-rule took 2.10x budget on the live stream at nominal reference ratio" } };
 expect(judgeKitPostcheck({ ...slowReport, stages: failedStages }, known))
  .toMatchObject({ status: "FAIL", live: "FAIL", reason: "KIT_LIVE_TEST_FAILED" });
 // Control: a DEFERRED regex-budget for any other INCONCLUSIVE reason still fails.
 const otherStages = { ...stages, "regex-budget": { status: "DEFERRED" as const, producer_rc: 75, duration_ms: 1,
  reason: "regex-budget INCONCLUSIVE: REFERENCE_TRACKING_DIVERGED (rule-mix ratio and reference ratio differ 9.40x)" } };
 expect(judgeKitPostcheck({ ...slowReport, stages: otherStages }, known).status).toBe("FAIL");
 expect(judgeKitPostcheck(slowReport, { identityKnown: true, changed: true }).status).toBe("FAIL");
 expect(judgeKitPostcheck(slowReport, { identityKnown: false, changed: false }).status).toBe("FAIL");

 const envelope = kitUpdateEnvelope(planned, { ...result, postcheck });
 expect(envelope.data, JSON.stringify(envelope.data)).toMatchObject({ overall: "UNVERIFIED", action: "PARTIAL", postcheck: "DEFERRED",
  live: "NOT_RUN", reason: "KIT_POSTCHECK_DEFERRED" });
 expect(envelope.data.postcheck_detail).toMatchObject({ deferred_stages: ["regex-budget"], failed_stages: [], failures: [deferral] });
 expect(envelope.errors?.[0]).toMatchObject({ code: "KIT_POSTCHECK_DEFERRED" });
 expect(envelope.errors?.[0]?.message).toContain(`Kit update to 1.2.3 is active but unverified: this host was too slow to judge its postcheck timing; ${deferral}`);
 expect(envelope.commands).toEqual([`omp-kit undo ${result.receiptId} --yes`]);
 // The unattended job never reports a deferred postcheck as a clean cycle.
 expect(kitUpdateJobOverall({ status: "UPDATED", receiptId: result.receiptId, activeVersion: "1.2.3", notification: true, postcheck: postcheck.status })).toBe("FINDINGS");
}));

test("POSTCHECKLOAD1: classifyLadder maps only a clamp-exceeding regex-budget INCONCLUSIVE to DEFERRED", async () => {
 const green = (name: string) => `OMP_KIT_STAGE_START name=${name}\n${name} ok\n\nGREEN ${name} producer_rc=0 duration_ms=10\n`;
 const ladder = (tail: string) => ["manifest", "harness-gate", "harness-selftest", "flywheel-invariants"].map(green).join("") + tail;
 const slowStdout = ladder("OMP_KIT_STAGE_START name=regex-budget\nREGEX-BUDGET: INCONCLUSIVE REFERENCE_RATIO_ABOVE_CLAMP (reference ratio 13.30 exceeds 8; this host is too slow to judge; not judged, not PASS)\n\nRED   regex-budget producer_rc=75 duration_ms=20\n");
 const slow = classifyLadder({ code: 75, stdout: slowStdout, stderr: "" }, []);
 expect(slow.stages["regex-budget"].status).toBe("DEFERRED");
 expect(slow.stages["regex-budget"].reason).toContain("REFERENCE_RATIO_ABOVE_CLAMP");
 expect(slow.failures).toEqual(["Stage regex-budget deferred: host too slow to judge (REFERENCE_RATIO_ABOVE_CLAMP)"]);
 expect(fullTestVerdict({ passed: false, blocked: false, cause: null, failures: slow.failures, stages: slow.stages }))
  .toEqual({ status: "DEFERRED", exitCode: 3 });
 // Control: an over-budget FAIL at nominal load stays FAIL.
 const failStdout = ladder("OMP_KIT_STAGE_START name=regex-budget\nREGEX-BUDGET: FAIL rule slow-rule took 2.10x budget on the live stream at nominal reference ratio\n\nRED   regex-budget producer_rc=1 duration_ms=20\n");
 const failed = classifyLadder({ code: 1, stdout: failStdout, stderr: "" }, []);
 expect(failed.stages["regex-budget"].status).toBe("FAIL");
 expect(fullTestVerdict({ passed: false, blocked: false, cause: null, failures: failed.failures, stages: failed.stages }).status).toBe("FAIL");
 // Control: an INCONCLUSIVE for any other reason stays FAIL.
 const otherStdout = ladder("OMP_KIT_STAGE_START name=regex-budget\nREGEX-BUDGET: INCONCLUSIVE REFERENCE_TRACKING_DIVERGED (rule-mix ratio and reference ratio differ 9.40x; not judged, not PASS)\n\nRED   regex-budget producer_rc=75 duration_ms=20\n");
 const other = classifyLadder({ code: 75, stdout: otherStdout, stderr: "" }, []);
 expect(other.stages["regex-budget"].status).toBe("FAIL");
});

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
}, { postcheck: "real" }), fixtureDeadlineS(60) * 1000);

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



afterAll(() => cleanupAllOwnedTmp());
