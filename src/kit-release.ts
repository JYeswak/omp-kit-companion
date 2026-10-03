import { createHash } from "node:crypto";
import { closeSync, constants, fchmodSync, fsyncSync, lstatSync, mkdirSync, mkdtempSync, openSync, readFileSync, realpathSync, rmSync, writeSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { gunzipSync } from "node:zlib";
import { isSha256Hex } from "./regex-guards.ts";
export const RELEASE_SCHEMA_VERSION = 1;
export const RELEASE_MANIFEST_NAME = "release-manifest.json";
export const RELEASE_BINARY_NAME = "bin/omp-kit";
export type ReleasePlatform = { os: "darwin" | "linux"; arch: "arm64" | "x64"; libc: "none" | "gnu" | "musl" };
export type ReleaseAsset = ReleasePlatform & { filename: string; sha256: string; manifest_sha256: string };
export type ReleaseIndex = { schema_version: 1; version: string; source_tag: string; assets: Record<string, ReleaseAsset> };
export type ReleaseManifest = { schema_version: 1; version: string; source_tag: string; files: { path: string; sha256: string }[] };
export type KitReleasePlan = {
 exitCode: 0; status: "UPDATE_AVAILABLE" | "CURRENT"; currentVersion: string; currentSha256?: string; version: string; sourceTag: string;
 asset: ReleaseAsset; platform: ReleasePlatform; indexSha256: string; provenance: "INTEGRITY_ONLY";
};
export type KitReleaseRefusal = { exitCode: 2 | 4; status: "REFUSED" | "NETWORK_UNAVAILABLE"; currentVersion: string; reason: string };
export type KitReleasePreview = KitReleasePlan | KitReleaseRefusal;
export type KitReleaseInput = { currentVersion: string; currentSha256?: string; selectedVersion?: string; sourceTag?: string; platform: ReleasePlatform; fetchIndex: () => Promise<unknown> };
export type BinaryReleaseInfo = { version: string; source_tag: string; platform: { os: string; arch: string } };
export type KitArchiveInput = { archive: Uint8Array; plan: KitReleasePreview; binaryInfo: BinaryReleaseInfo };
export type VerifiedKitArchive = { version: string; sourceTag: string; files: string[]; manifest: ReleaseManifest; archiveSha256: string };
export type StageKitInput = {
 archive: Uint8Array; plan: KitReleasePreview; stagingParent: string;
 probeBinaryInfo: (executable: string) => Promise<BinaryReleaseInfo>;
};
export type StagedKitRelease = VerifiedKitArchive & { root: string; executable: string };

const sha256 = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
const hash = (value: unknown) => sha256(Buffer.from(JSON.stringify(value, (_key, item: unknown) => record(item) ? Object.fromEntries(Object.entries(item).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)) : item)));
const fail = (reason: string): never => { throw new Error(reason); };
const record = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);
const digest = (value: unknown): value is string => isSha256Hex(value);
const version = (value: unknown): value is string => {
 if (typeof value !== "string" || !/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/.test(value)) return false;
 const suffix = value.indexOf("-");
 return suffix < 0 || value.slice(suffix + 1).split(".").every(part => !/^[0-9]+$/.test(part) || part === "0" || !part.startsWith("0"));
};
const safeName = (name: unknown): name is string => typeof name === "string" && name.length > 0 && !name.includes("\\") && !name.includes("\0") && !name.startsWith("/") && name.split("/").every(part => part !== "" && part !== "." && part !== "..");

/** Schema v1 is intentionally closed: producers and consumers must agree before publishing. */
export function validateReleaseIndex(value: unknown): ReleaseIndex {
 if (!record(value) || Object.keys(value).sort().join(",") !== "assets,schema_version,source_tag,version" || value.schema_version !== RELEASE_SCHEMA_VERSION || !version(value.version) || value.source_tag !== `v${value.version}` || !record(value.assets) || !Object.keys(value.assets).length) fail("INVALID_RELEASE_INDEX");
 for (const [key, raw] of Object.entries(value.assets)) {
  if (!record(raw) || Object.keys(raw).sort().join(",") !== "arch,filename,libc,manifest_sha256,os,sha256" || !["darwin", "linux"].includes(raw.os as string) || !["arm64", "x64"].includes(raw.arch as string) || !["none", "gnu", "musl"].includes(raw.libc as string) || (raw.os === "darwin") !== (raw.libc === "none") || key !== `${raw.os}-${raw.arch}-${raw.libc}`) fail("ASSET_PLATFORM_MISMATCH");
  if (!safeName(raw.filename) || raw.filename.includes("/") || !/\.tar(?:\.gz)?$/.test(raw.filename) || !digest(raw.sha256) || !digest(raw.manifest_sha256)) fail("INVALID_RELEASE_ASSET");
 }
 return value as ReleaseIndex;
}

/** Use this parser on fetched bytes: JSON.parse alone silently overwrites duplicate asset keys. */
export function parseReleaseIndexJson(raw: string): ReleaseIndex {
 if (Buffer.byteLength(raw) > 1024 * 1024) fail("INVALID_RELEASE_INDEX");
 let value: unknown;
 try { value = JSON.parse(raw); } catch { return fail("INVALID_RELEASE_INDEX"); }
 let cursor = 0;
 const space = () => { while (/\s/.test(raw[cursor] ?? "") && cursor < raw.length) cursor++; };
 const quoted = (): string => {
  const begin = cursor++;
  while (cursor < raw.length) {
   if (raw[cursor] === "\\") { cursor += 2; continue; }
   if (raw[cursor++] === '"') break;
  }
  return JSON.parse(raw.slice(begin, cursor)) as string;
 };
 const scan = (owner = ""): void => {
  space();
  if (raw[cursor] === "{") {
   cursor++; space();
   const seen = new Set<string>();
   while (raw[cursor] !== "}") {
    const key = quoted();
    if (seen.has(key)) fail(owner === "assets" ? "DUPLICATE_ASSET" : "DUPLICATE_RELEASE_KEY");
    seen.add(key);
    space(); cursor++; // colon; JSON.parse above has already established syntax.
    scan(key);
    space();
    if (raw[cursor] !== ",") break;
    cursor++; space();
   }
   cursor++;
  } else if (raw[cursor] === "[") {
   cursor++; space();
   while (raw[cursor] !== "]") {
    scan();
    space();
    if (raw[cursor] !== ",") break;
    cursor++; space();
   }
   cursor++;
  } else if (raw[cursor] === '"') quoted();
  else while (cursor < raw.length && !/[,\]}\s]/.test(raw[cursor]!)) cursor++;
 };
 scan();
 return validateReleaseIndex(value);
}

export function validateReleaseManifest(value: unknown): ReleaseManifest {
 if (!record(value) || Object.keys(value).sort().join(",") !== "files,schema_version,source_tag,version" || value.schema_version !== RELEASE_SCHEMA_VERSION || !version(value.version) || value.source_tag !== `v${value.version}` || !Array.isArray(value.files) || !value.files.length) fail("INVALID_RELEASE_MANIFEST");
 let previous = "";
 for (const entry of value.files) {
  if (!record(entry) || Object.keys(entry).sort().join(",") !== "path,sha256" || !safeName(entry.path) || entry.path === RELEASE_MANIFEST_NAME || !digest(entry.sha256) || entry.path <= previous) fail("INVALID_RELEASE_MANIFEST");
  previous = entry.path;
 }
 if (!value.files.some(entry => entry.path === RELEASE_BINARY_NAME)) fail("BINARY_MISSING");
 return value as ReleaseManifest;
}

export function releasePlatformKey(platform: ReleasePlatform): string {
 return `${platform.os}-${platform.arch}-${platform.libc}`;
}

/** Network errors alone use exit 4. Parsed but inconsistent metadata is a non-retryable refusal. */
export async function previewKitRelease(input: KitReleaseInput): Promise<KitReleasePreview> {
 let raw: unknown;
 try { raw = await input.fetchIndex(); }
 catch { return { exitCode: 4, status: "NETWORK_UNAVAILABLE", currentVersion: input.currentVersion, reason: "RELEASE_INDEX_UNAVAILABLE" }; }
 const refuse = (reason: string): KitReleaseRefusal => ({ exitCode: 2, status: "REFUSED", currentVersion: input.currentVersion, reason });
 let index: ReleaseIndex;
 try {
  index = typeof raw === "string" ? parseReleaseIndexJson(raw) : validateReleaseIndex(raw);
 } catch (error) { return refuse((error as Error).message); }
 if (!input.sourceTag) return refuse("TAG_UNVERIFIED");
 if (index.source_tag !== input.sourceTag) return refuse("TAG_MISMATCH");
 if (input.selectedVersion && input.selectedVersion !== index.version) return refuse("SELECTED_VERSION_MISMATCH");
 const key = releasePlatformKey(input.platform);
 const asset = index.assets[key];
 if (!asset) return refuse("ASSET_MISSING");
 if (!version(input.currentVersion)) return refuse("CURRENT_VERSION_UNVERIFIED");
 if (input.currentSha256 !== undefined && !digest(input.currentSha256)) return refuse("CURRENT_DIGEST_UNVERIFIED");
 if (compareReleaseVersions(index.version, input.currentVersion) < 0 && input.selectedVersion !== index.version) return refuse("DOWNGRADE_REQUIRES_SELECTION");
 return { exitCode: 0, status: index.version === input.currentVersion ? "CURRENT" : "UPDATE_AVAILABLE", currentVersion: input.currentVersion, currentSha256: input.currentSha256, version: index.version, sourceTag: index.source_tag, asset, platform: input.platform, indexSha256: hash(index), provenance: "INTEGRITY_ONLY" };
}

function compareReleaseVersions(a: string, b: string): number {
 const aSeparator = a.indexOf("-"), bSeparator = b.indexOf("-");
 const baseA = aSeparator < 0 ? a : a.slice(0, aSeparator);
 const baseB = bSeparator < 0 ? b : b.slice(0, bSeparator);
 const preA = aSeparator < 0 ? undefined : a.slice(aSeparator + 1);
 const preB = bSeparator < 0 ? undefined : b.slice(bSeparator + 1);
 const aa = baseA.split(".").map(BigInt), bb = baseB.split(".").map(BigInt);
 for (let i = 0; i < 3; i++) if (aa[i] !== bb[i]) return aa[i]! < bb[i]! ? -1 : 1;
 if (preA === preB) return 0;
 if (preA === undefined) return 1;
 if (preB === undefined) return -1;
 const aParts = preA.split("."), bParts = preB.split(".");
 for (let i = 0; i < Math.min(aParts.length, bParts.length); i++) {
  const left = aParts[i]!, right = bParts[i]!;
  if (left === right) continue;
  const leftNumeric = /^[0-9]+$/.test(left), rightNumeric = /^[0-9]+$/.test(right);
  if (leftNumeric && rightNumeric) return BigInt(left) < BigInt(right) ? -1 : 1;
  if (leftNumeric !== rightNumeric) return leftNumeric ? -1 : 1;
  return left < right ? -1 : 1;
 }
 return aParts.length < bParts.length ? -1 : 1;
}

/** Call under P10's shared update lock immediately before any activation. */
export function assertFreshKitPlan(plan: KitReleasePreview, observed: { currentVersion: string; currentSha256?: string; index: unknown; platform: ReleasePlatform }): asserts plan is KitReleasePlan {
 if (plan.exitCode !== 0) fail("STALE_KIT_PLAN");
 let index: ReleaseIndex;
 try { index = validateReleaseIndex(observed.index); } catch { return fail("STALE_KIT_PLAN"); }
 const asset = index.assets[releasePlatformKey(observed.platform)];
 if (plan.currentVersion !== observed.currentVersion || plan.currentSha256 !== observed.currentSha256 || plan.version !== index.version || plan.sourceTag !== index.source_tag || plan.indexSha256 !== hash(index) || !asset || releasePlatformKey(plan.platform) !== releasePlatformKey(observed.platform) || hash(asset) !== hash(plan.asset)) fail("STALE_KIT_PLAN");
}

type Member = { path: string; bytes: Buffer; kind: "file" | "directory" };
function tarMembers(archive: Buffer): Member[] {
 let payload: Buffer;
 try { payload = archive[0] === 0x1f && archive[1] === 0x8b ? gunzipSync(archive, { maxOutputLength: 256 * 1024 * 1024 }) : archive; }
 catch { return fail("ARCHIVE_INVALID"); }
 if (payload.length > 256 * 1024 * 1024) fail("ARCHIVE_INVALID");
 const members: Member[] = [];
 const names = new Set<string>();
 let offset = 0;
 let ended = false;
 while (offset + 512 <= payload.length) {
  const header = payload.subarray(offset, offset + 512);
  if (header.every(byte => byte === 0)) { ended = true; break; }
  const octal = (start: number, length: number): number => {
   const raw = header.toString("ascii", start, start + length).replace(/\0.*$/, "").trim();
   return /^[0-7]+$/.test(raw) ? Number.parseInt(raw, 8) : NaN;
  };
  const size = octal(124, 12), sum = octal(148, 8);
  let check = 0;
  for (let i = 0; i < 512; i++) check += i >= 148 && i < 156 ? 32 : header[i]!;
  if (!Number.isSafeInteger(size) || size < 0 || check !== sum) fail("ARCHIVE_INVALID");
  const name = header.toString("utf8", 0, 100).split("\0", 1)[0]!;
  const prefix = header.toString("utf8", 345, 500).split("\0", 1)[0]!;
  const rawPath = prefix ? `${prefix}/${name}` : name;
  const type = header[156];
  const directory = type === 53;
  const path = directory && rawPath.endsWith("/") ? rawPath.slice(0, -1) : rawPath;
  if (!safeName(path) || names.has(path) || (type !== 0 && type !== 48 && !directory) || (directory && size !== 0)) fail("ARCHIVE_UNSAFE_MEMBER");
  names.add(path);
  offset += 512;
  if (size > payload.length - offset) fail("ARCHIVE_INVALID");
  members.push({ path, bytes: payload.subarray(offset, offset + size), kind: directory ? "directory" : "file" });
  offset += Math.ceil(size / 512) * 512;
 }
 if (!ended || payload.length - offset < 1024 || !payload.subarray(offset).every(byte => byte === 0)) fail("ARCHIVE_INVALID");
 for (const member of members) {
  const parts = member.path.split("/");
  for (let i = 1; i < parts.length; i++) if (names.has(parts.slice(0, i).join("/")) && members.find(item => item.path === parts.slice(0, i).join("/"))?.kind !== "directory") fail("ARCHIVE_UNSAFE_MEMBER");
 }
 return members;
}

/** Validate all bytes and member types before anyone extracts or executes an archive. */
function inspectKitArchive(archive: Uint8Array, plan: KitReleasePreview): { verified: VerifiedKitArchive; members: Member[] } {
 if (plan.exitCode !== 0 || sha256(archive) !== plan.asset.sha256) fail("ARCHIVE_DIGEST_MISMATCH");
 if (plan.asset.filename.endsWith(".tar.gz") !== (archive[0] === 0x1f && archive[1] === 0x8b)) fail("ARCHIVE_INVALID");
 const view = Buffer.isBuffer(archive) ? archive : Buffer.from(archive.buffer as ArrayBuffer, archive.byteOffset, archive.byteLength);
 const members = tarMembers(view);
 const manifestMember = members.find(member => member.path === RELEASE_MANIFEST_NAME && member.kind === "file");
 if (!manifestMember || sha256(manifestMember.bytes) !== plan.asset.manifest_sha256) fail("MANIFEST_DIGEST_MISMATCH");
 let manifest: ReleaseManifest;
 try { manifest = validateReleaseManifest(JSON.parse(manifestMember.bytes.toString("utf8"))); }
 catch (error) { if (error instanceof Error && error.message === "BINARY_MISSING") throw error; return fail("INVALID_RELEASE_MANIFEST"); }
 if (manifest.version !== plan.version || manifest.source_tag !== plan.sourceTag) fail("MANIFEST_IDENTITY_MISMATCH");
 const regular = members.filter(member => member.kind === "file" && member.path !== RELEASE_MANIFEST_NAME).sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
 if (regular.length !== manifest.files.length) fail("FILE_INVENTORY_MISMATCH");
 for (let i = 0; i < regular.length; i++) {
  if (regular[i]!.path !== manifest.files[i]!.path) fail("FILE_INVENTORY_MISMATCH");
  if (sha256(regular[i]!.bytes) !== manifest.files[i]!.sha256) fail("FILE_DIGEST_MISMATCH");
 }
 for (const member of members) {
  if (member.kind === "directory" && !manifest.files.some(file => file.path.startsWith(`${member.path}/`))) fail("FILE_INVENTORY_MISMATCH");
 }
 return { members, verified: { version: manifest.version, sourceTag: manifest.source_tag, files: regular.map(member => member.path).concat(RELEASE_MANIFEST_NAME), manifest, archiveSha256: plan.asset.sha256 } };
}

function assertBinaryIdentity(info: BinaryReleaseInfo, plan: KitReleasePlan, verified: VerifiedKitArchive): void {
 if (!record(info) || !record(info.platform) || info.version !== verified.version || info.source_tag !== verified.sourceTag ||
  info.platform.os !== plan.platform.os || info.platform.arch !== plan.platform.arch) fail("BINARY_IDENTITY_MISMATCH");
}

/** A binary identity must be observed from that staged executable's --info output. */
export function verifyKitArchive(input: KitArchiveInput): VerifiedKitArchive {
 const { verified } = inspectKitArchive(input.archive, input.plan);
 if (input.plan.exitCode !== 0) fail("STALE_KIT_PLAN");
 assertBinaryIdentity(input.binaryInfo, input.plan, verified);
 return verified;
}

/** Writes only into a new child of a caller-owned disposable staging parent.
 * The callback must invoke that exact staged binary with --info; never infer identity from its manifest.
 * P18 still rechecks assertFreshKitPlan while holding the shared P10 lock before activation.
 */
export async function stageKitRelease(input: StageKitInput): Promise<StagedKitRelease> {
 if (input.plan.exitCode !== 0) fail("STALE_KIT_PLAN");
 // All archive bytes and member types are checked before a staging directory is created.
 const { verified, members } = inspectKitArchive(input.archive, input.plan);
 try {
  if (!isAbsolute(input.stagingParent) || resolve(input.stagingParent) !== input.stagingParent ||
   !lstatSync(input.stagingParent).isDirectory() || realpathSync(input.stagingParent) !== input.stagingParent) fail("UNSAFE_STAGE_PARENT");
 } catch { fail("UNSAFE_STAGE_PARENT"); }
 const root = mkdtempSync(join(input.stagingParent, "kit-stage-"));
 try {
  for (const member of members) {
   const target = join(root, member.path);
   if (member.kind === "directory") { mkdirSync(target, { recursive: true, mode: 0o700 }); continue; }
   mkdirSync(dirname(target), { recursive: true, mode: 0o700 });
   const fd = openSync(target, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, 0o600);
   try {
    for (let offset = 0; offset < member.bytes.length;) {
     const written = writeSync(fd, member.bytes, offset, member.bytes.length - offset);
     if (written <= 0) fail("STAGING_FAILED");
     offset += written;
    }
    fchmodSync(fd, member.path === RELEASE_BINARY_NAME || member.path.startsWith("scripts/") && member.path.endsWith(".sh") ? 0o755 : 0o644);
    fsyncSync(fd);
   } finally { closeSync(fd); }
  }
  const executable = join(root, RELEASE_BINARY_NAME);
  const identity = await input.probeBinaryInfo(executable);
  assertBinaryIdentity(identity, input.plan, verified);
  if (sha256(readFileSync(executable)) !== verified.manifest.files.find(file => file.path === RELEASE_BINARY_NAME)?.sha256) fail("STAGING_FAILED");
  return { ...verified, root, executable };
 } catch (error) {
  rmSync(root, { recursive: true, force: true });
  throw error;
 }
}
