import { afterAll, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { chmodSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { delimiter, join } from "node:path";
import { validateReleaseIndex, validateReleaseManifest, previewKitRelease, verifyKitArchive, assertFreshKitPlan, stageKitRelease, type KitReleasePlan } from "../../src/kit-release";
import { cleanupAllOwnedTmp, ownedTmp } from "../../src/kitlib/tmp";
import { run } from "../../src/kitlib/run";

const fixture = join(import.meta.dir, "..", "fixtures", "kit-release", "release-manifest.json");
const manifestBytes = readFileSync(fixture);
const binary = Buffer.from("#!/bin/sh\nprintf '{\"version\":\"1.2.3\",\"source_tag\":\"v1.2.3\",\"platform\":{\"os\":\"darwin\",\"arch\":\"arm64\"}}\\n'\n");
const digest = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
const receiptOutput = new TextDecoder();

// Minimal ustar fixture: independent of the reader's serialization logic.
function tar(entries: { name: string; bytes: Buffer; type?: string }[]): Buffer {
 const blocks: Buffer[] = [];
 for (const entry of entries) {
  const header = Buffer.alloc(512);
  header.write(entry.name, 0, 100, "utf8");
  header.write("0000755\0", 100, "ascii");
  header.write("0000000\0", 108, "ascii");
  header.write("0000000\0", 116, "ascii");
  header.write(entry.bytes.length.toString(8).padStart(11, "0") + "\0", 124, "ascii");
  header.write("00000000000\0", 136, "ascii");
  header.fill(32, 148, 156);
  header.write(entry.type ?? "0", 156, "ascii");
  header.write("ustar\0", 257, "ascii");
  header.write("00", 263, "ascii");
  const sum = header.reduce((acc, byte) => acc + byte, 0);
  header.write(sum.toString(8).padStart(6, "0") + "\0 ", 148, "ascii");
  blocks.push(header, entry.bytes, Buffer.alloc((512 - entry.bytes.length % 512) % 512));
 }
 blocks.push(Buffer.alloc(1024));
 return Buffer.concat(blocks);
}
const manifest = { name: "release-manifest.json", bytes: manifestBytes };
const executable = { name: "bin/omp-kit", bytes: binary };
const archive = tar([executable, manifest]);
const asset = { os: "darwin", arch: "arm64", libc: "none", filename: "omp-kit-v1.2.3-darwin-arm64-none.tar", sha256: digest(archive), manifest_sha256: digest(manifestBytes) };
const index = { schema_version: 1, version: "1.2.3", source_tag: "v1.2.3", assets: { "darwin-arm64-none": asset } };
const platform = { os: "darwin", arch: "arm64", libc: "none" } as const;
const info = { version: "1.2.3", source_tag: "v1.2.3", platform: { os: "darwin", arch: "arm64" } };

async function fixturePlan(): Promise<KitReleasePlan> {
 const plan = await previewKitRelease({ currentVersion: "1.2.2", sourceTag: "v1.2.3", platform, fetchIndex: async () => index });
 if (plan.exitCode !== 0) throw new Error(`Fixture rejected: ${plan.reason}`);
 return plan;
}

// Removing SHA verification would allow the altered archive to be staged.
describe("versioned release contract", () => {
 test("valid fixture previews only matching platform and verifies every archive file", async () => {
  const plan = await previewKitRelease({ currentVersion: "1.2.2", platform, fetchIndex: async () => index, sourceTag: "v1.2.3" });
  expect(plan).toMatchObject({ exitCode: 0, status: "UPDATE_AVAILABLE", version: "1.2.3", asset });
  expect(verifyKitArchive({ archive, plan, binaryInfo: info }).files).toEqual(["bin/omp-kit", "release-manifest.json"]);
  expect(validateReleaseManifest(JSON.parse(manifestBytes.toString())).files[0]?.path).toBe("bin/omp-kit");
 });
 test("offline preview keeps local facts and returns retryable code without installation writes", async () => {
  const result = await previewKitRelease({ currentVersion: "1.2.2", platform, fetchIndex: async () => { throw new Error("offline"); } });
  expect(result).toEqual({ exitCode: 4, status: "NETWORK_UNAVAILABLE", currentVersion: "1.2.2", reason: "RELEASE_INDEX_UNAVAILABLE" });
 });
 test("rejects missing, duplicate and off-platform asset identities", async () => {
  expect(await previewKitRelease({ currentVersion: "1.2.2", sourceTag: "v1.2.3", platform: { os: "linux", arch: "x64", libc: "gnu" }, fetchIndex: async () => index })).toMatchObject({ reason: "ASSET_MISSING" });
  expect(() => validateReleaseIndex({ ...index, assets: { ...index.assets, "linux-arm64-gnu": asset } })).toThrow("ASSET_PLATFORM_MISMATCH");
  expect(() => validateReleaseIndex({ ...index, assets: { ...index.assets, "darwin-arm64-none": asset, "darwin-arm64-none-alt": asset } })).toThrow("ASSET_PLATFORM_MISMATCH");
  const duplicate = `{\"schema_version\":1,\"version\":\"1.2.3\",\"source_tag\":\"v1.2.3\",\"assets\":{\"darwin-arm64-none\":${JSON.stringify(asset)},\"darwin-arm64-none\":${JSON.stringify(asset)}}}`;
  expect(await previewKitRelease({ currentVersion: "1.2.2", sourceTag: "v1.2.3", platform, fetchIndex: async () => duplicate })).toMatchObject({ reason: "DUPLICATE_ASSET" });
 });
 test("tag, downgrade and stale preview refuse before activation", async () => {
  expect(await previewKitRelease({ currentVersion: "1.2.4", sourceTag: "v1.2.3", platform, fetchIndex: async () => index })).toMatchObject({ reason: "DOWNGRADE_REQUIRES_SELECTION" });
  expect((await previewKitRelease({ currentVersion: "1.2.4", selectedVersion: "1.2.3", sourceTag: "v1.2.3", platform, fetchIndex: async () => index })).status).toBe("UPDATE_AVAILABLE");
  expect(await previewKitRelease({ currentVersion: "1.2.2", sourceTag: "v9.0.0", platform, fetchIndex: async () => index })).toMatchObject({ reason: "TAG_MISMATCH" });
  expect(await previewKitRelease({ currentVersion: "1.2.2", platform, fetchIndex: async () => index })).toMatchObject({ reason: "TAG_UNVERIFIED" });
  const plan = await fixturePlan();
  expect(() => assertFreshKitPlan(plan, { currentVersion: "1.2.3", index, platform })).toThrow("STALE_KIT_PLAN");
  expect(() => assertFreshKitPlan(plan, { currentVersion: "1.2.2", index: { ...index, version: "1.2.5", source_tag: "v1.2.5" }, platform })).toThrow("STALE_KIT_PLAN");
  const pinned = await previewKitRelease({ currentVersion: "1.2.2", currentSha256: digest(Buffer.from("installed-before")), sourceTag: "v1.2.3", platform, fetchIndex: async () => index });
  expect(() => assertFreshKitPlan(pinned, { currentVersion: "1.2.2", currentSha256: digest(Buffer.from("operator-edited")), index, platform })).toThrow("STALE_KIT_PLAN");
 });
 test("rejects changed archive, changed file with matching outer checksum, and link escape", async () => {
  const plan = await fixturePlan();
  expect(() => verifyKitArchive({ archive: tar([{ name: "bin/omp-kit", bytes: Buffer.from("tampered") }, manifest]), plan, binaryInfo: info })).toThrow("ARCHIVE_DIGEST_MISMATCH");
  const changedManifest = Buffer.from(manifestBytes.toString().replace("v1.2.3", "v1.2.4"));
  const changedArchive = tar([executable, { name: "release-manifest.json", bytes: changedManifest }]);
  expect(() => verifyKitArchive({ archive: changedArchive, plan: { ...plan, asset: { ...asset, sha256: digest(changedArchive) } }, binaryInfo: info })).toThrow("MANIFEST_DIGEST_MISMATCH");
  expect(() => verifyKitArchive({ archive: changedArchive, plan: { ...plan, asset: { ...asset, sha256: digest(changedArchive), manifest_sha256: digest(changedManifest) } }, binaryInfo: info })).toThrow("INVALID_RELEASE_MANIFEST");
  const changed = tar([{ name: "bin/omp-kit", bytes: Buffer.from("tampered") }, manifest]);
  const changedPlan = { ...plan, asset: { ...asset, sha256: digest(changed) } };
  expect(() => verifyKitArchive({ archive: changed, plan: changedPlan, binaryInfo: info })).toThrow("FILE_DIGEST_MISMATCH");
  const linked = tar([{ name: "bin/omp-kit", bytes: Buffer.alloc(0), type: "2" }, manifest]);
  expect(() => verifyKitArchive({ archive: linked, plan: { ...plan, asset: { ...asset, sha256: digest(linked) } }, binaryInfo: info })).toThrow("ARCHIVE_UNSAFE_MEMBER");
 });
 test("rejects an archive whose package.json version disagrees with its manifest", async () => {
  const plan = await fixturePlan();
  const baseManifest = JSON.parse(manifestBytes.toString());
  const goodPkg = Buffer.from(JSON.stringify({ name: "omp-kit-companion", version: "1.2.3", omp: { version: "1.2.3" } }));
  const goodManifest = { ...baseManifest, files: [...baseManifest.files, { path: "package.json", sha256: digest(goodPkg) }] };
  const goodManifestBytes = Buffer.from(JSON.stringify(goodManifest));
  const goodArchive = tar([executable, { name: "release-manifest.json", bytes: goodManifestBytes }, { name: "package.json", bytes: goodPkg }]);
  const goodPlan = { ...plan, asset: { ...asset, sha256: digest(goodArchive), manifest_sha256: digest(goodManifestBytes) } };
  expect(verifyKitArchive({ archive: goodArchive, plan: goodPlan, binaryInfo: info }).files).toContain("package.json");
  // Skewed tree: manifest honestly lists the package bytes, but the package
  // version was never stamped to the release version.
  const badPkg = Buffer.from(JSON.stringify({ name: "omp-kit-companion", version: "9.9.9", omp: { version: "9.9.9" } }));
  const skewManifest = { ...baseManifest, files: [...baseManifest.files, { path: "package.json", sha256: digest(badPkg) }] };
  const skewManifestBytes = Buffer.from(JSON.stringify(skewManifest));
  const skewArchive = tar([executable, { name: "release-manifest.json", bytes: skewManifestBytes }, { name: "package.json", bytes: badPkg }]);
  const skewPlan = { ...plan, asset: { ...asset, sha256: digest(skewArchive), manifest_sha256: digest(skewManifestBytes) } };
  expect(() => verifyKitArchive({ archive: skewArchive, plan: skewPlan, binaryInfo: info })).toThrow("PACKAGE_VERSION_MISMATCH");
 });

 test("rejects mismatched archive binary identity despite valid bytes", async () => {
  const plan = await fixturePlan();
  expect(() => verifyKitArchive({ archive, plan, binaryInfo: { ...info, source_tag: "v1.2.2" } })).toThrow("BINARY_IDENTITY_MISMATCH");
  expect(() => verifyKitArchive({ archive, plan, binaryInfo: { ...info, platform: { os: "linux", arch: "arm64" } } })).toThrow("BINARY_IDENTITY_MISMATCH");
 });
 test("stages verified bytes only in a disposable root and checks the staged executable --info", async () => {
  const base = join(import.meta.dir, "..", "..", "var", "agent-tmp");
  const stagingParent = join(ownedTmp("kit-release-test", { root: base }).path, "staging");
  mkdirSync(stagingParent);
  try {
   const plan = await fixturePlan();
   const probeBinaryInfo = async (executable: string) => {
    const child = Bun.spawn([executable, "--info"], { stdout: "pipe", stderr: "pipe" });
    const output = await new Response(child.stdout).text();
    expect(await child.exited).toBe(0);
    return JSON.parse(output) as typeof info;
   };
   const staged = await stageKitRelease({ archive, plan, stagingParent, probeBinaryInfo });
   expect(readFileSync(staged.executable)).toEqual(binary);
   expect(staged.root.startsWith(`${stagingParent}/kit-stage.`)).toBe(true);
   const badInfo = async () => ({ ...info, version: "9.9.9" });
   await expect(stageKitRelease({ archive, plan, stagingParent, probeBinaryInfo: badInfo })).rejects.toThrow("BINARY_IDENTITY_MISMATCH");
   expect(readdirSync(stagingParent)).toEqual([staged.root.slice(stagingParent.length + 1)]);
  } finally { rmSync(stagingParent, { recursive: true, force: true }); }
 });
 for (const route of ["staging", "standalone"] as const) {
  test(`installed receipt CLI remains executable through ${route} without trusting arbitrary archive modes`, async () => {
   const repo = join(import.meta.dir, "..", "..");
   const base = join(repo, "var", "agent-tmp");
   mkdirSync(base, { recursive: true });
   const work = ownedTmp("receipt-install", { root: base }).path;
   writeFileSync(join(work, ".owner"), `pid=${process.pid}\nlabel=receipt-install\nrepo=${repo}\ncreated=${new Date().toISOString()}\n`);
   try {
    const probeData = { version: info.version, release: { source_tag: info.source_tag }, platform: info.platform };
    const files = [
     { name: "bin/omp-kit", bytes: Buffer.from(`#!/bin/sh\nprintf '%s\\n' '${JSON.stringify({ data: probeData })}'\n`) },
     { name: "scripts/receipt.py", bytes: readFileSync(join(repo, "scripts/receipt.py")) },
     { name: "scripts/kitlib_tmp.py", bytes: readFileSync(join(repo, "scripts/kitlib_tmp.py")) },
     { name: "scripts/kitlib_artifact.py", bytes: readFileSync(join(repo, "scripts/kitlib_artifact.py")) },
     { name: "scripts/ordinary.py", bytes: Buffer.from("print('ordinary data file')\n") },
    ].sort((left, right) => left.name.localeCompare(right.name));
    const releaseManifest = Buffer.from(JSON.stringify({
     schema_version: 1, version: "1.2.3", source_tag: "v1.2.3",
     files: files.map(file => ({ path: file.name, sha256: digest(file.bytes) })),
    }));
    const releaseArchive = tar([...files, { name: "release-manifest.json", bytes: releaseManifest }]);
    const releaseAsset = { ...asset, sha256: digest(releaseArchive), manifest_sha256: digest(releaseManifest) };
    const key = `${platform.os}-${platform.arch}-${platform.libc}`;
    const releaseIndex = { ...index, assets: { [key]: releaseAsset } };
    let installed: string;
    if (route === "staging") {
     const plan = await previewKitRelease({ currentVersion: "1.2.2", sourceTag: "v1.2.3", platform, fetchIndex: async () => releaseIndex });
     if (plan.exitCode !== 0) throw new Error(plan.reason);
     const staged = await stageKitRelease({
      archive: releaseArchive, plan, stagingParent: work,
      probeBinaryInfo: async executablePath => {
       const child = Bun.spawn([executablePath, "--info"], { stdout: "pipe", stderr: "pipe" });
       const output = await new Response(child.stdout).text();
       expect(await child.exited).toBe(0);
       const observed = JSON.parse(output).data;
       return { version: observed.version, source_tag: observed.release.source_tag, platform: observed.platform };
      },
     });
     installed = staged.root;
    } else {
     const archivePath = join(work, releaseAsset.filename);
     const indexPath = join(work, "index.json");
     const prefix = join(work, "installed");
     writeFileSync(archivePath, releaseArchive);
     writeFileSync(indexPath, JSON.stringify(releaseIndex));
     // This policy double is explicitly synthetic; no real Sigstore claim.
     writeFileSync(`${archivePath}.sigstore.json`, '{"fixture":true}\n');
     const result = Bun.spawnSync(["python3", join(repo, "installer/install.py"), "install",
      indexPath, "1.2.3", key, archivePath, prefix, "0"], {
      cwd: work, env: { ...process.env, TMPDIR: work, PYTHONDONTWRITEBYTECODE: "1",
       PATH: [join(repo, "tests/fixtures/kit-release"), process.env.PATH ?? ""].join(delimiter) },
      stdout: "pipe", stderr: "pipe",
     });
     expect(result.exitCode, result.stdout.toString() + result.stderr.toString()).toBe(0);
     installed = join(prefix, "releases", "1.2.3");
    }
    const receipt = join(installed, "scripts/receipt.py");
    expect(statSync(receipt).mode & 0o111).toBe(0o111);
    expect(statSync(join(installed, "scripts/ordinary.py")).mode & 0o111).toBe(0);
    expect(statSync(join(installed, "scripts/kitlib_artifact.py")).mode & 0o111).toBe(0);
    const runReceipt = (...args: string[]) => run([receipt, ...args], {
     deadline_s: 15, cwd: work,
     env: { PATH: process.env.PATH ?? "/usr/bin:/bin", TMPDIR: work, PYTHONPATH: "", PYTHONHOME: "", PYTHONDONTWRITEBYTECODE: "1" },
    });
    const result = await runReceipt("selftest");
    expect(result.rc, receiptOutput.decode(result.stdout) + receiptOutput.decode(result.stderr)).toBe(0);
    // Exercise the installed CLI directly: selftest's quiet negatives also catch unexpected import errors.
    const good = join(work, "good.receipt.json");
    const signed = await runReceipt("sign", "--producer", "receipt-install", "--operation", "release.test",
     "--param", "timeout_ms=30", "--param", "ratio=0.5", "--limitation", "3-case sample",
     "--result-sha256", "a".repeat(64), "--result-bytes", "10", "--out", good);
    expect(signed.rc, receiptOutput.decode(signed.stdout) + receiptOutput.decode(signed.stderr)).toBe(0);
    const verified = await runReceipt("verify", good);
    expect(verified.rc, receiptOutput.decode(verified.stdout) + receiptOutput.decode(verified.stderr)).toBe(0);
    // sign emits recursively sorted keys; changing one value preserves canonical projection order.
    // Rehash the invalid integer so refusal must come from the domain, not a stale evidence_id.
    const forged = JSON.parse(readFileSync(good, "utf8"));
    delete forged.evidence_id;
    forged.parameters.timeout_ms = 2 ** 53;
    const forgedId = "ev_" + digest(Buffer.from(JSON.stringify(forged)));
    const bad = join(work, "bad.receipt.json");
    writeFileSync(bad, JSON.stringify({ ...forged, evidence_id: forgedId }));
    const refused = await runReceipt("verify", bad);
    expect(refused.rc, receiptOutput.decode(refused.stdout) + receiptOutput.decode(refused.stderr)).toBe(1);
   } finally {
    rmSync(work, { recursive: true, force: true });
   }
  }, 15_000);
 }
 // ompkit-2pkp1: cc, skills and hooks import the release's scripts/pysafe.py; their bytecode must never land in the release.
 for (const route of ["staging", "standalone"] as const) {
  test(`planted: a kit Python import writes no bytecode into a release installed through ${route}`, async () => {
   const repo = join(import.meta.dir, "..", "..");
   const base = join(repo, "var", "agent-tmp");
   mkdirSync(base, { recursive: true });
   const work = ownedTmp("bytecode-seal", { root: base }).path;
   writeFileSync(join(work, ".owner"), `pid=${process.pid}\nlabel=bytecode-seal\nrepo=${repo}\ncreated=${new Date().toISOString()}\n`);
   try {
    const probeData = { version: info.version, release: { source_tag: info.source_tag }, platform: info.platform };
    const files = [
     { name: "bin/omp-kit", bytes: Buffer.from(`#!/bin/sh\nprintf '%s\\n' '${JSON.stringify({ data: probeData })}'\n`) },
     { name: "scripts/pysafe.py", bytes: readFileSync(join(repo, "scripts/pysafe.py")) },
     { name: "scripts/kitlib_run.py", bytes: readFileSync(join(repo, "scripts/kitlib_run.py")) },
     { name: "scripts/kitlib_tmp.py", bytes: readFileSync(join(repo, "scripts/kitlib_tmp.py")) },
     { name: "skills/demo/scripts/helper.py", bytes: Buffer.from("VALUE = 7\n") },
    ].sort((left, right) => left.name.localeCompare(right.name));
    const releaseManifest = Buffer.from(JSON.stringify({
     schema_version: 1, version: "1.2.3", source_tag: "v1.2.3",
     files: files.map(file => ({ path: file.name, sha256: digest(file.bytes) })),
    }));
    const releaseArchive = tar([...files, { name: "release-manifest.json", bytes: releaseManifest }]);
    const releaseAsset = { ...asset, sha256: digest(releaseArchive), manifest_sha256: digest(releaseManifest) };
    const key = `${platform.os}-${platform.arch}-${platform.libc}`;
    const releaseIndex = { ...index, assets: { [key]: releaseAsset } };
    let installed: string;
    if (route === "staging") {
     const plan = await previewKitRelease({ currentVersion: "1.2.2", sourceTag: "v1.2.3", platform, fetchIndex: async () => releaseIndex });
     if (plan.exitCode !== 0) throw new Error(plan.reason);
     installed = (await stageKitRelease({
      archive: releaseArchive, plan, stagingParent: work,
      probeBinaryInfo: async executablePath => {
       const child = Bun.spawn([executablePath, "--info"], { stdout: "pipe", stderr: "pipe" });
       const observed = JSON.parse(await new Response(child.stdout).text()).data;
       expect(await child.exited).toBe(0);
       return { version: observed.version, source_tag: observed.release.source_tag, platform: observed.platform };
      },
     })).root;
    } else {
     const archivePath = join(work, releaseAsset.filename), indexPath = join(work, "index.json"), prefix = join(work, "installed");
     writeFileSync(archivePath, releaseArchive);
     writeFileSync(indexPath, JSON.stringify(releaseIndex));
     // This policy double is explicitly synthetic; no real Sigstore claim.
     writeFileSync(`${archivePath}.sigstore.json`, '{"fixture":true}\n');
     const result = Bun.spawnSync(["python3", join(repo, "installer/install.py"), "install", indexPath, "1.2.3", key, archivePath, prefix, "0"], {
      cwd: work, env: { ...process.env, TMPDIR: work, PYTHONDONTWRITEBYTECODE: "1",
       PATH: [join(repo, "tests/fixtures/kit-release"), process.env.PATH ?? ""].join(delimiter) },
      stdout: "pipe", stderr: "pipe",
     });
     expect(result.exitCode, result.stdout.toString() + result.stderr.toString()).toBe(0);
     installed = join(prefix, "releases", "1.2.3");
    }
    const tree = (): string[] => {
     const rows: string[] = [];
     const visit = (path: string, rel: string): void => {
      const stat = statSync(path);
      rows.push(`${rel}:${(stat.mode & 0o7777).toString(8)}:${stat.size}:${stat.mtimeMs}`);
      if (stat.isDirectory()) for (const name of readdirSync(path).sort()) visit(join(path, name), rel ? `${rel}/${name}` : name);
     };
     visit(installed, "");
     return rows;
    };
    const before = tree();
    expect(before.filter(row => row.includes("__pycache__")).map(row => row.split(":").slice(0, 2).join(":"))).toEqual([
     "scripts/__pycache__:500", "skills/demo/scripts/__pycache__:500",
    ]);
    // The live importers' shape (cc_service, runbook_gate, skill hooks): scripts/ on sys.path, bytecode writing left on.
    // Apple's /usr/bin/python3 redirects bytecode through sys.pycache_prefix; the fleet's Homebrew/uv 3.12-3.15 do not,
    // and those wrote the release's __pycache__ on 2026-10-22, so the importer clears the prefix to behave like them.
    const env: Record<string, string> = { ...process.env as Record<string, string>, TMPDIR: work };
    delete env.PYTHONDONTWRITEBYTECODE;
    delete env.PYTHONPYCACHEPREFIX;
    const importer = (root: string) => Bun.spawnSync(["python3", "-c",
     `import sys; sys.pycache_prefix = None; sys.path.insert(0, ${JSON.stringify(join(root, "scripts"))}); sys.path.insert(0, ${JSON.stringify(join(root, "skills/demo/scripts"))}); import kitlib_run, pysafe, helper; print(sys.dont_write_bytecode, helper.VALUE, pysafe.OK)`],
     { cwd: work, env, stdout: "pipe", stderr: "pipe" });
    const run = importer(installed);
    expect(run.exitCode, run.stderr.toString()).toBe(0);
    expect(run.stdout.toString().split(" ").slice(0, 2)).toEqual(["False", "7"]);
    expect(tree()).toEqual(before);
    // Control: the same importer against an unsealed cache does write bytecode, so the check above can fail.
    chmodSync(join(installed, "scripts", "__pycache__"), 0o700);
    expect(importer(installed).exitCode).toBe(0);
    expect(readdirSync(join(installed, "scripts", "__pycache__")).filter(name => name.endsWith(".pyc")).length).toBeGreaterThan(0);
   } finally {
    rmSync(work, { recursive: true, force: true });
   }
  }, 30_000);
 }
});

afterAll(() => cleanupAllOwnedTmp());
