import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { validateReleaseIndex, validateReleaseManifest, previewKitRelease, verifyKitArchive, assertFreshKitPlan, stageKitRelease, type KitReleasePlan } from "../../src/kit-release";

const fixture = join(import.meta.dir, "..", "fixtures", "kit-release", "release-manifest.json");
const manifestBytes = readFileSync(fixture);
const binary = Buffer.from("#!/bin/sh\nprintf '{\"version\":\"1.2.3\",\"source_tag\":\"v1.2.3\",\"platform\":{\"os\":\"darwin\",\"arch\":\"arm64\"}}\\n'\n");
const digest = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");

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
 test("rejects mismatched archive binary identity despite valid bytes", async () => {
  const plan = await fixturePlan();
  expect(() => verifyKitArchive({ archive, plan, binaryInfo: { ...info, source_tag: "v1.2.2" } })).toThrow("BINARY_IDENTITY_MISMATCH");
  expect(() => verifyKitArchive({ archive, plan, binaryInfo: { ...info, platform: { os: "linux", arch: "arm64" } } })).toThrow("BINARY_IDENTITY_MISMATCH");
 });
 test("stages verified bytes only in a disposable root and checks the staged executable --info", async () => {
  const base = join(import.meta.dir, "..", "..", "var", "agent-tmp");
  const stagingParent = mkdtempSync(join(base, "kit-release-test-"));
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
   expect(staged.root.startsWith(`${stagingParent}/kit-stage-`)).toBe(true);
   const badInfo = async () => ({ ...info, version: "9.9.9" });
   await expect(stageKitRelease({ archive, plan, stagingParent, probeBinaryInfo: badInfo })).rejects.toThrow("BINARY_IDENTITY_MISMATCH");
   expect(readdirSync(stagingParent)).toEqual([staged.root.slice(stagingParent.length + 1)]);
  } finally { rmSync(stagingParent, { recursive: true, force: true }); }
 });
});
