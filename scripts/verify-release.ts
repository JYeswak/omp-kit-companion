#!/usr/bin/env bun
// Verify release signatures and SBOMs on a machine that did not build them.
// Only needs the public key plus the published files; never the signing key.
//
// Sig mode (detached Ed25519 over exact published bytes):
//   verify-release.sh --pubkey RELEASE.SPKI.PUB --file ARCHIVE.TAR --sig ARCHIVE.TAR.sig
// SBOM mode (SBOM describes the exact archive sealed beside it):
//   verify-release.sh --sbom ARCHIVE.TAR.sbom.spdx.json --archive ARCHIVE.TAR
import { createHash, createPublicKey, verify } from "node:crypto";
import { lstatSync, readFileSync } from "node:fs";

const fail = (reason: string): never => { throw new Error(reason); };
const record = (value: unknown): value is Record<string, unknown> =>
	typeof value === "object" && value !== null && !Array.isArray(value);
const safeFile = (label: string, path: string): Buffer => {
	let stat;
	try {
		stat = lstatSync(path);
	} catch {
		fail(`${label}_NOT_FOUND`);
	}
	if (!stat.isFile() || stat.isSymbolicLink()) fail(`${label}_NOT_FOUND`);
	return readFileSync(path);
};
const usage = (): never => fail("Usage: verify-release.sh (--pubkey PUB --file FILE --sig SIG | --sbom SBOM --archive ARCHIVE)");

function verifySignature(pubkeyPath: string, filePath: string, sigPath: string): void {
	let key;
	try {
		key = createPublicKey(readFileSync(pubkeyPath, "utf8"));
	} catch {
		fail("INVALID_PUBKEY");
	}
	if (key.asymmetricKeyType !== "ed25519") fail("INVALID_PUBKEY");
	const bytes = safeFile("FILE", filePath);
	const sig = safeFile("SIG", sigPath);
	if (sig.length !== 64) fail("SIGNATURE_MISMATCH");
	if (!verify(null, bytes, key, sig)) fail("SIGNATURE_MISMATCH");
	process.stdout.write(`VERIFY=ok file=${filePath}\n`);
}

function tarFiles(archive: Buffer): { path: string; bytes: Buffer }[] {
	const members: { path: string; bytes: Buffer }[] = [];
	for (let offset = 0; offset + 512 <= archive.length;) {
		const block = archive.subarray(offset, offset + 512);
		if (block.every(byte => byte === 0)) break;
		const magic = block.subarray(257, 263);
		if (magic[5] !== 0 || magic.subarray(0, 5).toString("ascii") !== "ustar") fail("TAR_UNREADABLE");
		const name = block.subarray(0, 100).toString("ascii").split("\0", 1)[0];
		const sizeText = block.subarray(124, 136).toString("ascii").split("\0", 1)[0].trim();
		const octal = sizeText.length > 0 && sizeText.split("").every(char => char >= "0" && char <= "7");
		if (!octal) fail("TAR_UNREADABLE");
		const size = parseInt(sizeText, 8);
		if (!Number.isSafeInteger(size)) fail("TAR_UNREADABLE");
		const type = String.fromCharCode(block[156]);
		const start = offset + 512;
		const end = start + size;
		if (end > archive.length) fail("TAR_UNREADABLE");
		if (type === "0" || type === "\0") members.push({ path: name, bytes: Buffer.from(archive.subarray(start, end)) });
		offset = start + Math.ceil(size / 512) * 512;
	}
	return members;
}

function checksumOf(pkg: unknown): string {
	if (!record(pkg)) return "";
	const sums = pkg["checksums"];
	if (!Array.isArray(sums)) return "";
	for (const sum of sums) {
		if (record(sum) && sum["algorithm"] === "SHA256" && typeof sum["checksumValue"] === "string") return sum["checksumValue"];
	}
	return "";
}

function verifySbom(sbomPath: string, archivePath: string): void {
	let sbom: unknown;
	try {
		sbom = JSON.parse(safeFile("SBOM", sbomPath).toString("utf8"));
	} catch {
		fail("SBOM_UNREADABLE");
	}
	if (!record(sbom) || sbom["spdxVersion"] !== "SPDX-2.3") fail("SBOM_NOT_SPDX_23");
	const archiveBytes = safeFile("ARCHIVE", archivePath);
	const packages = sbom["packages"];
	if (!Array.isArray(packages) || packages.length === 0) fail("SBOM_NO_PACKAGES");
	const byId: Record<string, Record<string, unknown>> = {};
	for (const entry of packages) {
		if (!record(entry) || typeof entry["SPDXID"] !== "string") fail("SBOM_NO_PACKAGES");
		byId[entry["SPDXID"]] = entry;
	}
	const archiveEntry = byId["SPDXRef-Archive"];
	if (!archiveEntry || checksumOf(archiveEntry) !== createHash("sha256").update(archiveBytes).digest("hex")) fail("SBOM_ARCHIVE_MISMATCH");
	const runtime = byId["SPDXRef-Runtime-Bun"];
	if (!runtime || typeof runtime["versionInfo"] !== "string" || runtime["versionInfo"].length === 0) fail("SBOM_RUNTIME_MISSING");
	const members = tarFiles(archiveBytes);
	const manifestRaw = members.find(member => member.path === "release-manifest.json")?.bytes;
	if (!manifestRaw) fail("SBOM_MANIFEST_MISSING");
	let manifest: unknown;
	try {
		manifest = JSON.parse(manifestRaw.toString("utf8"));
	} catch {
		fail("SBOM_MANIFEST_MISSING");
	}
	if (!record(manifest) || !Array.isArray(manifest["files"])) fail("SBOM_MANIFEST_MISSING");
	const manifestFiles: { path: string; sha256: string }[] = [];
	for (const file of manifest["files"]) {
		if (!record(file) || typeof file["path"] !== "string" || typeof file["sha256"] !== "string") fail("SBOM_MANIFEST_MISSING");
		manifestFiles.push({ path: file["path"], sha256: file["sha256"] });
	}
	const listed = sbom["files"];
	if (!Array.isArray(listed)) fail("SBOM_INCOMPLETE");
	const sbomMap: Record<string, string> = {};
	for (const entry of listed) {
		if (!record(entry) || typeof entry["fileName"] !== "string" || checksumOf(entry) === "") fail("SBOM_INCOMPLETE");
		sbomMap[entry["fileName"]] = checksumOf(entry);
	}
	if (Object.keys(sbomMap).length !== manifestFiles.length) fail("SBOM_INCOMPLETE");
	for (const file of manifestFiles) {
		if (sbomMap[file.path] !== file.sha256) fail("SBOM_INCOMPLETE");
	}
	const binaryEntry = manifestFiles.find(file => file.path === "bin/omp-kit");
	if (!binaryEntry || checksumOf(byId["SPDXRef-Binary"]) !== binaryEntry.sha256) fail("SBOM_BINARY_MISMATCH");
	process.stdout.write(`VERIFY=ok sbom=${sbomPath} archive=${archivePath} files=${manifestFiles.length}\n`);
}

function run(): void {
	const args = process.argv.slice(2);
	const at = (flag: string): string | null => {
		const index = args.indexOf(flag);
		if (index === -1) return null;
		const value = args[index + 1];
		if (value === undefined || value.startsWith("--")) usage();
		return value as string;
	};
	const pubkey = at("--pubkey"), file = at("--file"), sig = at("--sig");
	const sbom = at("--sbom"), archive = at("--archive");
	if (pubkey && file && sig && !sbom && !archive && args.length === 6) verifySignature(pubkey, file, sig);
	else if (sbom && archive && !pubkey && !file && !sig && args.length === 4) verifySbom(sbom, archive);
	else usage();
}
try {
	run();
} catch (error) {
	process.stderr.write(`verify-release: ${error instanceof Error ? error.message : String(error)}\n`);
	process.exitCode = error instanceof Error && error.message.startsWith("Usage:") ? 2 : 1;
}
