import { afterAll, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ownedTmp } from "../../src/kitlib/tmp.ts";

// DEVID-SIGN-V1 (docs/release-signing.md): CI attests the locally signed darwin archive only after
// scripts/devid_release.py proves it is the qualified archive plus a code signature. These fixtures are a
// USTAR archive in scripts/package-release.ts's exact header format and a synthetic thin arm64 Mach-O, so the
// structural derivation runs on any runner; the codesign/notarization half needs macOS and a real identity.
const ROOT = join(import.meta.dir, "..", "..");
const TOOL = join(ROOT, "scripts", "devid_release.py");
const VERSION = "1.2.3";
const PLATFORM = "darwin-arm64-none";
const FILENAME = `omp-kit-v${VERSION}-${PLATFORM}.tar`;
const owned = ownedTmp("devid-release");
const work = owned.path;
afterAll(() => owned.cleanup());

const sha = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");

function octal(block: Buffer, offset: number, width: number, value: number): void {
	block.write(`${value.toString(8).padStart(width - 1, "0")}\0`, offset, width, "ascii");
}
function header(path: string, size: number, directory: boolean): Buffer {
	const block = Buffer.alloc(512);
	block.write(directory ? `${path}/` : path, 0, 100, "utf8");
	octal(block, 100, 8, directory || path === "bin/omp-kit" ? 0o755 : 0o644);
	octal(block, 108, 8, 0);
	octal(block, 116, 8, 0);
	octal(block, 124, 12, size);
	octal(block, 136, 12, 0);
	block.fill(32, 148, 156);
	block[156] = directory ? 53 : 48;
	block.write("ustar\0", 257, 6, "ascii");
	block.write("00", 263, 2, "ascii");
	octal(block, 148, 8, block.reduce((sum, byte) => sum + byte, 0));
	return block;
}
/** A thin arm64 MH_EXECUTE: __LINKEDIT plus LC_CODE_SIGNATURE, with the signature blob ending the file. */
function macho(code: Buffer, signature: Buffer): Buffer {
	const commands = 120;
	const dataoff = Math.ceil((commands + code.length) / 16) * 16;
	const total = dataoff + signature.length;
	const out = Buffer.alloc(total);
	out.writeUInt32LE(0xfeedfacf, 0);
	out.writeUInt32LE(0x0100000c, 4);
	out.writeUInt32LE(2, 12);
	out.writeUInt32LE(2, 16);
	out.writeUInt32LE(88, 20);
	out.writeUInt32LE(0x19, 32);
	out.writeUInt32LE(72, 36);
	out.write("__LINKEDIT", 40, "ascii");
	out.writeBigUInt64LE(0x100000000n, 56);
	out.writeBigUInt64LE(BigInt(Math.ceil((total - commands) / 0x4000) * 0x4000), 64);
	out.writeBigUInt64LE(BigInt(commands), 72);
	out.writeBigUInt64LE(BigInt(total - commands), 80);
	out.writeUInt32LE(1, 88);
	out.writeUInt32LE(1, 92);
	out.writeUInt32LE(0x1d, 104);
	out.writeUInt32LE(16, 108);
	out.writeUInt32LE(dataoff, 112);
	out.writeUInt32LE(signature.length, 116);
	code.copy(out, commands);
	signature.copy(out, dataoff);
	return out;
}
const CODE = Buffer.from(Array.from({ length: 3000 }, (_, i) => (i * 31 + 7) % 251));
const ADHOC = macho(CODE, Buffer.alloc(700, 0xa1));
const DEVID = macho(CODE, Buffer.alloc(1900, 0xd5));

type Files = Record<string, Buffer>;
function baseFiles(binary: Buffer): Files {
	return { LICENSE: Buffer.from("MIT\n"), "bin/omp-kit": binary, "package.json": Buffer.from(`{"version":"${VERSION}"}\n`),
		"rules/a.md": Buffer.from("# rule a\n") };
}
/** scripts/package-release.ts's layout: sorted files and parent directories, manifest of every file, 1024-byte end. */
function archive(files: Files, manifestFiles: Files = files): { tar: Buffer; manifest: Buffer } {
	const names = Object.keys(manifestFiles).sort();
	const manifest = Buffer.from(`${JSON.stringify({ schema_version: 1, version: VERSION, source_tag: `v${VERSION}`,
		files: names.map(path => ({ path, sha256: sha(manifestFiles[path]!) })) })}\n`);
	const content: Files = { ...files, "release-manifest.json": manifest };
	const dirs = new Set<string>();
	for (const name of Object.keys(content)) for (let parent = name.split("/").slice(0, -1).join("/"); parent; parent = parent.split("/").slice(0, -1).join("/")) dirs.add(parent);
	const parts: Buffer[] = [];
	for (const name of [...Object.keys(content), ...dirs].sort()) {
		const bytes = content[name];
		parts.push(header(name, bytes?.length ?? 0, !bytes));
		if (bytes) parts.push(bytes, Buffer.alloc((512 - bytes.length % 512) % 512));
	}
	parts.push(Buffer.alloc(1024));
	return { tar: Buffer.concat(parts), manifest };
}
function index(tar: Buffer, manifest: Buffer): Buffer {
	const asset = { arch: "arm64", filename: FILENAME, libc: "none", manifest_sha256: sha(manifest), os: "darwin", sha256: sha(tar) };
	return Buffer.from(`${JSON.stringify({ assets: { [PLATFORM]: asset }, schema_version: 1, source_tag: `v${VERSION}`, version: VERSION })}\n`);
}
let cases = 0;
function caseDir(): string {
	const dir = join(work, `case-${++cases}`);
	mkdirSync(dir);
	return dir;
}
function write(dir: string, name: string, bytes: Buffer): string {
	const path = join(dir, name);
	mkdirSync(join(path, ".."), { recursive: true });
	writeFileSync(path, bytes);
	return path;
}
function tool(args: string[]): { code: number; stdout: string; stderr: string } {
	const result = Bun.spawnSync(["python3", TOOL, ...args], { stdout: "pipe", stderr: "pipe", env: { ...process.env, TMPDIR: work } });
	return { code: result.exitCode ?? -1, stdout: result.stdout.toString(), stderr: result.stderr.toString() };
}
function qualified(dir: string, files: Files = baseFiles(ADHOC)): { archive: string; index: string } {
	const built = archive(files);
	return { archive: write(dir, `qualified/${FILENAME}`, built.tar), index: write(dir, "qualified/release-index.json", index(built.tar, built.manifest)) };
}
function verify(q: { archive: string; index: string }, signed: string, extra: string[] = ["--structural-only"]) {
	return tool(["verify", "--qualified-archive", q.archive, "--qualified-index", q.index, "--signed-archive", signed, "--version", VERSION, ...extra]);
}

test("prepare, repack and verify derive a signed archive whose index changes only the darwin digests", () => {
	const dir = caseDir();
	const q = qualified(dir);
	const prepared = tool(["prepare", "--archive", q.archive, "--index", q.index, "--version", VERSION, "--out", join(dir, "signed")]);
	expect(prepared.code, prepared.stderr).toBe(0);
	expect(JSON.parse(prepared.stdout).members).toEqual([{ path: "bin/omp-kit", identifier: "ai.zeststream.omp-kit", sha256: sha(ADHOC) }]);
	expect(readFileSync(join(dir, "signed/bin/omp-kit"))).toEqual(ADHOC);
	writeFileSync(join(dir, "signed/bin/omp-kit"), DEVID); // what codesign does: same code, new signature
	const signed = join(dir, FILENAME);
	const repacked = tool(["repack", "--archive", q.archive, "--index", q.index, "--version", VERSION, "--signed-dir", join(dir, "signed"),
		"--out-archive", signed, "--out-index", join(dir, "repack-index.json")]);
	expect(repacked.code, repacked.stderr).toBe(0);
	// Byte-for-byte what package-release.ts would emit for the signed binary.
	expect(readFileSync(signed)).toEqual(archive(baseFiles(DEVID)).tar);
	const verified = verify(q, signed, ["--structural-only", "--signed-sha256", sha(readFileSync(signed)), "--index-out", join(dir, "final-index.json")]);
	expect(verified.code, verified.stderr).toBe(0);
	expect(JSON.parse(verified.stdout)).toMatchObject({ verified: "structural", archive_sha256: sha(readFileSync(signed)), signed: ["bin/omp-kit"] });
	const final = readFileSync(join(dir, "final-index.json"));
	expect(final).toEqual(readFileSync(join(dir, "repack-index.json")));
	const before = JSON.parse(readFileSync(q.index, "utf8"));
	const after = JSON.parse(final.toString());
	expect(after.assets[PLATFORM]).toEqual({ ...before.assets[PLATFORM], sha256: sha(readFileSync(signed)),
		manifest_sha256: sha(archive(baseFiles(DEVID)).manifest) });
	expect({ ...after, assets: {} }).toEqual({ ...before, assets: {} });
});

test("a planted change to a non-Mach-O member is refused even with a consistent manifest", () => {
	const dir = caseDir();
	const q = qualified(dir);
	const files = { ...baseFiles(DEVID), "rules/a.md": Buffer.from("# rule a, tampered\n") };
	const result = verify(q, write(dir, FILENAME, archive(files).tar));
	expect(result.code).toBe(4);
	expect(result.stderr).toContain("rules/a.md: differs from the qualified archive");
});

test("a planted change to the binary's code is refused even when re-signed", () => {
	const dir = caseDir();
	const q = qualified(dir);
	const code = Buffer.from(CODE);
	code[1500] ^= 0xff;
	const result = verify(q, write(dir, FILENAME, archive(baseFiles(macho(code, Buffer.alloc(1900, 0xd5)))).tar));
	expect(result.code).toBe(4);
	expect(result.stderr).toContain("bin/omp-kit: code before the signature differs");
});

test("an archive other than the dispatched digest, a tampered qualified archive or an added member is refused", () => {
	const dir = caseDir();
	const q = qualified(dir);
	const signed = write(dir, FILENAME, archive(baseFiles(DEVID)).tar);
	const wrongDigest = verify(q, signed, ["--structural-only", "--signed-sha256", "0".repeat(64)]);
	expect(wrongDigest.code).toBe(4);
	expect(wrongDigest.stderr).toContain("is not the dispatched");

	const tampered = Buffer.from(readFileSync(q.archive));
	tampered[600] ^= 0x01;
	const qualifiedTampered = { archive: write(dir, `tampered/${FILENAME}`, tampered), index: q.index };
	const refusedQualified = verify(qualifiedTampered, signed);
	expect(refusedQualified.code).toBe(4);
	expect(refusedQualified.stderr).toContain("installer verification failed");

	const added = verify(q, write(dir, `added/${FILENAME}`, archive({ ...baseFiles(DEVID), "rules/b.md": Buffer.from("extra\n") }).tar));
	expect(added.code).toBe(4);
	expect(added.stderr).toContain("member list");
});

test("a signature that does not end the binary, or a Mach-O with no pinned identifier, is refused", () => {
	const dir = caseDir();
	const q = qualified(dir);
	const trailing = verify(q, write(dir, FILENAME, archive(baseFiles(Buffer.concat([DEVID, Buffer.from("appended")]))).tar));
	expect(trailing.code).toBe(4);
	expect(trailing.stderr).toContain("does not end the file");

	const unknown = qualified(join(dir, "unknown"), { ...baseFiles(ADHOC), "lib/helper.dylib": ADHOC });
	const prepared = tool(["prepare", "--archive", unknown.archive, "--index", unknown.index, "--version", VERSION, "--out", join(dir, "unknown-out")]);
	expect(prepared.code).toBe(4);
	expect(prepared.stderr).toContain("without a pinned identifier: lib/helper.dylib");
});

test("without --structural-only a binary lacking a valid Developer ID signature is refused", () => {
	const dir = caseDir();
	const q = qualified(dir);
	// On Linux codesign is absent; on macOS the synthetic signature blob fails codesign --verify. Neither passes.
	const result = verify(q, write(dir, FILENAME, archive(baseFiles(DEVID)).tar), ["--execute"]);
	expect(result.code).toBe(4);
	expect(result.stderr).toContain("codesign");
});

type Step = { name?: string; uses?: string; if?: string; run?: string; with?: Record<string, unknown> };
type Job = { needs?: string[]; if?: string; "runs-on"?: string; steps?: Step[] };
type Workflow = { jobs: Record<string, Job> };
const ON = "needs.validate-tag.outputs.developer_id == 'true'";
test("developer-id mode attests the darwin archive only after the derivation proof; adhoc mode keeps today's sources", () => {
	const release = Bun.YAML.parse(readFileSync(join(ROOT, ".github/workflows/release.yml"), "utf8")) as Workflow;
	const developer = release.jobs["developer-id"]!;
	expect(developer["runs-on"]).toBe("macos-15");
	expect(developer.if).toContain(ON);
	const proof = developer.steps!.map(step => step.run ?? "").find(run => run.includes("devid_release.py verify"))!;
	for (const flag of ['--signed-sha256 "$DARWIN_SHA256"', "--execute", "--index-out final/release-index.json"]) expect(proof).toContain(flag);
	for (const weakening of ["--structural-only", "--no-notarization"]) expect(proof).not.toContain(weakening);
	expect(release.jobs["attest-platforms"]!.needs).toContain("developer-id");
	expect(release.jobs["attest-platforms"]!.if).toContain("(needs.validate-tag.outputs.developer_id != 'true' || needs['developer-id'].result == 'success')");
	const attest = release.jobs.attest!.steps!;
	expect(attest.find(step => step.with?.name === "devid-darwin-arm64-none-attempt-${{ github.run_attempt }}")!.if)
		.toBe(`matrix.platform == 'darwin-arm64-none' && ${ON}`);
	// adhoc (OFF): every platform, darwin included, attests the qualified candidate and index exactly as before.
	const qualified = attest.find(step => step.with?.name === "candidate-${{ matrix.platform }}-attempt-${{ needs.validate-tag.outputs.artifact_attempt }}")!;
	expect(qualified.if).toBe("matrix.platform != 'darwin-arm64-none' || needs.validate-tag.outputs.developer_id != 'true'");
	expect(qualified.with!["run-id"]).toBe("${{ needs.validate-tag.outputs.artifact_run_id || github.run_id }}");
	const index = attest.find(step => String(step.with?.name ?? "").startsWith("unpublished-candidate-index-attempt-"))!;
	expect(index.with!.name).toBe(`unpublished-candidate-index-attempt-\${{ ${ON} && github.run_attempt || needs.validate-tag.outputs.artifact_attempt }}`);
	expect(index.with!["run-id"]).toBe(`\${{ ${ON} && github.run_id || (needs.validate-tag.outputs.artifact_run_id || github.run_id) }}`);
	const signedIndex = release.jobs["attest-index"]!.steps!.find(step => String(step.with?.name ?? "").startsWith("unpublished-candidate-index-attempt-"))!;
	expect(signedIndex.with!["run-id"]).toBe(`\${{ ${ON} && github.run_id || needs.validate-tag.outputs.artifact_run_id }}`);
	const gate = release.jobs["signing-complete"]!;
	expect(gate.needs).toContain("developer-id");
	const script = gate.steps!.map(step => step.run ?? "").join("\n");
	expect(script).toContain('if [[ "$DEVELOPER_ID" == true ]]; then expected=success; fi');
	expect(script).toContain('if [[ "$DEVELOPER_ID_RESULT" != "$expected" ]]; then');
	const identity = release.jobs["validate-tag"]!.steps!.map(step => step.run ?? "").join("\n");
	expect(identity).toContain('[[ -z "$DARWIN_SHA256" ]]');
	expect(identity).toContain('[[ "$DARWIN_SHA256" =~ ^[0-9a-f]{64}$ ]]');
	const train = Bun.YAML.parse(readFileSync(join(ROOT, ".github/workflows/release-train.yml"), "utf8")) as Workflow;
	const tag = train.jobs["tag-qualified"]!.steps!;
	expect(tag.find(step => step.name === "Dispatch signing after durable creation acknowledgment")!.if).toContain("steps.authority.outputs.devid != 'true'");
	expect(tag.find(step => step.name === "Leave tag-ref signing to the local Developer ID signer")!.if).toBe("steps.authority.outputs.devid == 'true'");
});

test("the checked-in switch names one known darwin signing mode", () => {
	const config = JSON.parse(readFileSync(join(ROOT, "scripts/release-signing.json"), "utf8"));
	expect(Object.keys(config).sort()).toEqual(["darwin_signing", "schema_version"]);
	expect(config.schema_version).toBe(1);
	expect(["adhoc", "developer-id"]).toContain(config.darwin_signing);
});
