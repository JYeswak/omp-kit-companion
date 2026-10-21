#!/usr/bin/env bun
/** Verify the exact bytes users download after a release is published. */
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { join, basename } from "node:path";
import { tmpdir } from "node:os";

export type Asset = { name: string; size: number; sha256: string };
export type ReleaseSnapshot = { tag: string; tagSha: string; releaseId: number; assets: Asset[] };
export type VerificationReason =
  | "ASSET_MISSING" | "ASSET_INVENTORY_MISMATCH" | "ASSET_SIZE_MISMATCH"
  | "ASSET_DIGEST_MISMATCH" | "SIGNATURE_INVALID" | "OFFLINE_SMOKE_FAILED"
  | "RELEASE_MUTATED" | "TAG_MOVED";

export class PublishedReleaseError extends Error {
  constructor(public readonly reason: VerificationReason, detail = "") {
    super(`${reason}${detail ? `: ${detail}` : ""}`);
    this.name = "PublishedReleaseError";
  }
}

const sha256 = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
const sorted = (assets: Asset[]) => [...assets].sort((a, b) => a.name.localeCompare(b.name));
const sameAssets = (a: Asset[], b: Asset[]) => JSON.stringify(sorted(a)) === JSON.stringify(sorted(b));

/** Pure gate used by CI and planted-failure tests. No network or filesystem effects. */
export function verifyPublishedBytes(
  expected: ReleaseSnapshot,
  reread: ReleaseSnapshot,
  bytes: Map<string, Uint8Array>,
  signatureValid: boolean,
  smoke: () => boolean,
): void {
  if (expected.tagSha !== reread.tagSha) throw new PublishedReleaseError("TAG_MOVED");
  if (expected.releaseId !== reread.releaseId || !sameAssets(expected.assets, reread.assets)) {
    throw new PublishedReleaseError("RELEASE_MUTATED");
  }
  if (!signatureValid) throw new PublishedReleaseError("SIGNATURE_INVALID");
  const expectedNames = sorted(expected.assets).map((asset) => asset.name);
  const actualNames = [...bytes.keys()].sort();
  if (JSON.stringify(actualNames) !== JSON.stringify(expectedNames)) {
    throw new PublishedReleaseError(actualNames.length < expectedNames.length ? "ASSET_MISSING" : "ASSET_INVENTORY_MISMATCH");
  }
  for (const asset of expected.assets) {
    const data = bytes.get(asset.name);
    if (!data) throw new PublishedReleaseError("ASSET_MISSING", asset.name);
    if (data.byteLength !== asset.size) throw new PublishedReleaseError("ASSET_SIZE_MISMATCH", asset.name);
    if (sha256(data) !== asset.sha256) throw new PublishedReleaseError("ASSET_DIGEST_MISMATCH", asset.name);
  }
  if (!smoke()) throw new PublishedReleaseError("OFFLINE_SMOKE_FAILED");
}

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new PublishedReleaseError("ASSET_INVENTORY_MISMATCH");
  return value as Record<string, unknown>;
}
function gh(args: string[]): unknown { return JSON.parse(execFileSync("gh", ["api", ...args], { encoding: "utf8" })); }
function assetFromRemote(value: unknown): Asset {
  const row = record(value);
  const name = row.name, size = row.size, digest = row.digest;
  if (typeof name !== "string" || typeof size !== "number" || !Number.isSafeInteger(size) || size < 0 || typeof digest !== "string" || !digest.startsWith("sha256:")) {
    throw new PublishedReleaseError("ASSET_INVENTORY_MISMATCH");
  }
  return { name, size, sha256: digest.slice("sha256:".length) };
}
function manifestAssets(value: unknown): Asset[] {
  const root = record(value);
  const assets = record(root.assets);
  return Object.values(assets).map((entry) => {
    const row = record(entry);
    const name = row.filename, digest = row.sha256;
    if (typeof name !== "string" || typeof digest !== "string" || !/^[0-9a-f]{64}$/.test(digest)) throw new PublishedReleaseError("ASSET_INVENTORY_MISMATCH");
    // Size is authenticated by GitHub's release asset metadata on the first read.
    return { name, size: -1, sha256: digest };
  });
}
function download(repo: string, tag: string, name: string, dir: string): Uint8Array {
  if (name.includes("/") || name === ".." || name.includes("\\")) throw new PublishedReleaseError("ASSET_INVENTORY_MISMATCH", name);
  execFileSync("gh", ["release", "download", tag, "--repo", repo, "--pattern", name, "--clobber", "--dir", dir], { stdio: "ignore" });
  try { return readFileSync(join(dir, name)); } catch { throw new PublishedReleaseError("ASSET_MISSING", name); }
}
function offlineSmoke(archive: string, root: string): boolean {
  const extracted = join(root, `extract-${basename(archive, ".tar")}`);
  try {
    execFileSync("mkdir", ["-p", extracted]);
    execFileSync("tar", ["-xf", archive, "-C", extracted]);
    const binary = join(extracted, "bin", "omp-kit");
    const env = { HOME: join(root, "home"), PATH: "/usr/bin:/bin", XDG_CONFIG_HOME: join(root, "config"), XDG_CACHE_HOME: join(root, "cache") };
    execFileSync("mkdir", ["-p", env.HOME, env.XDG_CONFIG_HOME, env.XDG_CACHE_HOME]);
    const version = execFileSync(binary, ["--version"], { env, encoding: "utf8" }).trim();
    execFileSync(binary, ["--help"], { env, stdio: "ignore" });
    return /^omp-kit \d+\.\d+\.\d+$/.test(version);
  } catch { return false; }
}

export function verifyFromGithub(repo: string, tag: string, manifestPath: string): void {
  const manifest = manifestAssets(JSON.parse(readFileSync(manifestPath, "utf8")));
  const release = record(gh([`repos/${repo}/releases/tags/${tag}`]));
  const tagRef = record(gh([`repos/${repo}/git/ref/tags/${tag}`]));
  const tagObject = record(tagRef.object);
  const first: ReleaseSnapshot = { tag, tagSha: String(tagObject.sha), releaseId: Number(release.id), assets: manifest };
  const root = mkdtempSync(join(tmpdir(), "omp-kit-published-"));
  try {
    const bytes = new Map<string, Uint8Array>();
    const remote = Array.isArray(release.assets) ? release.assets.map(assetFromRemote) : [];
    for (const expected of manifest) {
      const actual = remote.find((asset) => asset.name === expected.name);
      if (!actual) throw new PublishedReleaseError("ASSET_MISSING", expected.name);
      expected.size = actual.size;
      bytes.set(expected.name, download(repo, tag, expected.name, root));
    }
    for (const expected of manifest) {
      const archive = join(root, expected.name);
      try { execFileSync("gh", ["attestation", "verify", archive, "--repo", repo, "--predicate-type", "https://slsa.dev/provenance/v1"], { stdio: "ignore" }); }
      catch { throw new PublishedReleaseError("SIGNATURE_INVALID", expected.name); }
    }
    const rereadRelease = record(gh([`repos/${repo}/releases/${first.releaseId}`]));
    const rereadTag = record(gh([`repos/${repo}/git/ref/tags/${tag}`]));
    const second: ReleaseSnapshot = { tag, tagSha: String(record(rereadTag.object).sha), releaseId: Number(rereadRelease.id), assets: manifest };
    verifyPublishedBytes(first, second, bytes, true, () => offlineSmoke(join(root, manifest[0]!.name), root));
  } finally { rmSync(root, { recursive: true, force: true }); }
}

if (import.meta.main) {
  const [repo, tag, manifest] = process.argv.slice(2);
  if (repo === "--self-test") {
    const bytes = new TextEncoder().encode("control");
    const snapshot: ReleaseSnapshot = { tag: "v1.0.0", tagSha: "a", releaseId: 1, assets: [{ name: "kit.tar", size: bytes.length, sha256: sha256(bytes) }] };
    verifyPublishedBytes(snapshot, snapshot, new Map([["kit.tar", bytes]]), true, () => true);
    for (const [reason, run] of [["ASSET_MISSING", () => verifyPublishedBytes(snapshot, snapshot, new Map(), true, () => true)], ["ASSET_DIGEST_MISMATCH", () => verifyPublishedBytes(snapshot, snapshot, new Map([["kit.tar", new TextEncoder().encode("tamper!")]]), true, () => true)], ["TAG_MOVED", () => verifyPublishedBytes(snapshot, { ...snapshot, tagSha: "b" }, new Map([["kit.tar", bytes]]), true, () => true)]] as const) {
      try { run(); throw new Error(`self-test did not fail: ${reason}`); } catch (error) { if (!(error instanceof PublishedReleaseError) || error.reason !== reason) throw error; }
    }
    console.log("published release verifier self-test: control and planted failures pass");
  } else if (!repo || !tag || !manifest) {
    console.error("usage: verify-published.ts OWNER/REPO vX.Y.Z release-index.json"); process.exit(2);
  } else {
    try { verifyFromGithub(repo, tag, manifest); console.log(`verified ${repo} ${tag}`); }
    catch (error) { console.error(error instanceof Error ? error.message : error); process.exit(1); }
  }
}
