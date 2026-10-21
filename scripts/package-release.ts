#!/usr/bin/env bun
import { createHash, createPrivateKey, sign } from "node:crypto";
import { closeSync, constants, existsSync, fsyncSync, linkSync, lstatSync, mkdirSync, mkdtempSync, openSync, readFileSync, readdirSync, realpathSync, rmSync, unlinkSync, writeSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { RELEASE_BINARY_NAME, RELEASE_MANIFEST_NAME, validateReleaseManifest, type ReleaseAsset } from "../src/kit-release.ts";
import { RELEASE_DATA_FILES } from "../src/release-assets.ts";
import { authorizeSourceAct } from "../src/source-authority.ts";
const root = resolve(import.meta.dir, "..");
const platformTargets: Record<string, string> = {
	"darwin-arm64-none": "bun-darwin-arm64",
	"darwin-x64-none": "bun-darwin-x64",
	"linux-arm64-gnu": "bun-linux-arm64",
	"linux-x64-gnu": "bun-linux-x64",
	// dsr resolves platform targets to Rust triples; accept those spellings too.
	"aarch64-apple-darwin": "bun-darwin-arm64",
	"x86_64-apple-darwin": "bun-darwin-x64",
	"aarch64-unknown-linux-gnu": "bun-linux-arm64",
	"x86_64-unknown-linux-gnu": "bun-linux-x64",
};
const roots = new Set(["rules", "retired", "cases", "policy", "extensions", "examples", "checkers", "config", "skills", "plugins/omp-kit-tern"]);
for (const file of RELEASE_DATA_FILES) {
	const directory = dirname(file);
	if (directory !== ".") roots.add(directory);
}
const files = ["LICENSE", "package.json", "scripts/apply-policy.sh", "scripts/build-manifest.sh",
	"scripts/package-release.sh", "scripts/receipt.py", "scripts/pysafe.py", "scripts/pysafe_check.py", "scripts/check-staged-pysafe.sh",
	"scripts/tern-docs-census.py", "scripts/tern-script-routes.json",
	"docs/tern-integration.md", "docs/tern-verb-map.md", "docs/tern-coverage.tsv",
	"scripts/context-inventory.ts", "scripts/doctor.sh", "scripts/regex-budget.ts", "scripts/e2e-live.sh", "scripts/install-extensions.sh", "scripts/install.sh",
	"scripts/ladder.sh", "scripts/test-case-report.sh", "scripts/limit-process-tree.sh", "scripts/rule_pipeline.py", "scripts/rule-class.ts", "scripts/runtime-adapter.sh",
	"scripts/check-flywheel-invariants.ts", "scripts/ttsr-harness.ts", "scripts/external-live.mjs", "docs/flywheel-invariants.tsv"];
const BUNDLE_ERRORS: Record<string, string | undefined> = {
	"extensions/fleet-guard.ts": "FLEET_GUARD_BUNDLE_FAILED",
	"extensions/kit-flywheel-guard.ts": "FLYWHEEL_GUARD_BUNDLE_FAILED",
	"scripts/ttsr-harness.ts": "HARNESS_BUNDLE_FAILED",
	"tests/live/admission-extension.mjs": "ADMISSION_FIXTURE_BUNDLE_FAILED",
};
const sha = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
const fail = (reason: string): never => { throw new Error(reason); };
const octal = (header: Buffer, offset: number, width: number, value: number) => {
	const digits = value.toString(8);
	if (digits.length >= width) fail("USTAR_SIZE_UNSUPPORTED");
	header.write(`${digits.padStart(width - 1, "0")}\0`, offset, width, "ascii");
};
function header(path: string, size: number, directory: boolean): Buffer {
	const entry = directory ? `${path}/` : path;
	if (Buffer.byteLength(entry) > 100 || entry.startsWith("/") || entry.split("/").some(part => part === ".." || part === ".")) fail("USTAR_PATH_UNSUPPORTED");
	const block = Buffer.alloc(512);
	block.write(entry, 0, 100, "utf8");
	octal(block, 100, 8, directory ? 0o755 : path === RELEASE_BINARY_NAME || path === "scripts/receipt.py" || path.endsWith(".sh") ? 0o755 : 0o644);
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
function writeAll(fd: number, bytes: Uint8Array): void {
	for (let offset = 0; offset < bytes.length;) {
		const count = writeSync(fd, bytes, offset, bytes.length - offset);
		if (count <= 0) fail("ARCHIVE_WRITE_FAILED");
		offset += count;
	}
}
/**
 * STAMP1 (ompkit-fp72.3): stamp the release version into the archived
 * package.json (.version and, when present, .omp.version) so the archive
 * carries the version it was built for, independent of the source tree's
 * working version. Preserve other metadata and bind source_revision to the
 * selected build source (or null). Refuses unparseable package.json fail-closed.
 */
function stampPackageVersion(source: Buffer, version: string, sourceRevision: string | null): Buffer {
	let parsed: unknown;
	try {
		parsed = JSON.parse(source.toString("utf8"));
	} catch {
		fail("PACKAGE_VERSION_UNSTAMPABLE");
	}
	if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return fail("PACKAGE_VERSION_UNSTAMPABLE");
	const stamped: Record<string, unknown> = {};
	for (const [key, value] of Object.entries(parsed)) stamped[key] = value;
	stamped.version = version;
	stamped.source_revision = sourceRevision;
	const omp = stamped.omp;
	if (omp && typeof omp === "object" && !Array.isArray(omp)) {
		const ompOut: Record<string, unknown> = {};
		for (const [key, value] of Object.entries(omp)) ompOut[key] = value;
		ompOut.version = version;
		stamped.omp = ompOut;
	}
	return Buffer.from(JSON.stringify(stamped, null, 2) + "\n");
}

/**
 * Build-source metadata only, not authenticated provenance. An archive's expanded
 * export-subst stamp survives without Git; a checkout must have its own clean HEAD.
 * Never discover an ancestor repository or let inherited GIT_* select another tree.
 * A final observation may only retain the initially observed revision, never upgrade it.
 */
export function packageSourceRevision(sourceRoot: string, sourcePackage: Uint8Array, initialRevision?: string | null): string | null {
 if (initialRevision === null) return null;
 try {
  const physicalRoot = realpathSync(sourceRoot);
  if (!existsSync(join(physicalRoot, ".git"))) {
   const parsed: unknown = JSON.parse(Buffer.from(sourcePackage).toString("utf8"));
   if (!parsed || typeof parsed !== "object" || Array.isArray(parsed) || !("source_revision" in parsed)) return null;
   return typeof parsed.source_revision === "string" && (parsed.source_revision.length === 40 || parsed.source_revision.length === 64) && /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(parsed.source_revision)
    && (initialRevision === undefined || initialRevision === parsed.source_revision) ? parsed.source_revision : null;
  }
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("GIT_")));
  const git = (args: string[]): string | null => {
   const child = Bun.spawnSync(["git", "-C", physicalRoot, ...args], { cwd: physicalRoot, env, stdout: "pipe", stderr: "pipe" });
   return child.exitCode === 0 ? child.stdout.toString().trim() : null;
  };
  const top = git(["rev-parse", "--show-toplevel"]);
  if (!top || realpathSync(top) !== physicalRoot || git(["status", "--porcelain=v1", "--untracked-files=all"]) !== "") return null;
  const revision = git(["rev-parse", "--verify", "HEAD"]);
  return revision && (revision.length === 40 || revision.length === 64) && /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(revision)
   && (initialRevision === undefined || initialRevision === revision) ? revision : null;
 } catch {
  return null;
 }
}

function safeSource(name: string): Buffer {
	const source = join(root, name);
	const stat = lstatSync(source);
	if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1) fail(`UNSAFE_RELEASE_SOURCE: ${name}`);
	return readFileSync(source);
}
function expand(directory: string, result: string[]): void {
	const absolute = join(root, directory);
	if (!lstatSync(absolute).isDirectory()) fail(`UNSAFE_RELEASE_DIRECTORY: ${directory}`);
	for (const name of readdirSync(absolute).sort()) {
		const child = `${directory}/${name}`;
		const stat = lstatSync(join(root, child));
		if (stat.isDirectory()) expand(child, result);
		else if (stat.isFile() && !stat.isSymbolicLink() && stat.nlink === 1) result.push(child);
		else fail(`UNSAFE_RELEASE_SOURCE: ${child}`);
	}
}
function argumentsOf(args: string[]) {
	if ((args.length !== 6 && args.length !== 8) || args[0] !== "--version" || args[2] !== "--platform" || args[4] !== "--out"
		|| (args.length === 8 && args[6] !== "--sign-key"))
		fail("Usage: package-release.sh --version [v]X.Y.Z --platform darwin-arm64-none|darwin-x64-none|linux-arm64-gnu|linux-x64-gnu|native --out ABSOLUTE_DIR [--sign-key ED25519_PRIVATE_PEM]");
	const rawVersion = args[1]!;
	// Accept an optional v prefix (dsr displays v-prefixed versions); the archive records bare.
	const version = rawVersion.startsWith("v") ? rawVersion.slice(1) : rawVersion;
	const rawKey = args[3]!;
	const out = args[5]!;
	if (!/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z.-]+)?$/.test(version)) fail("INVALID_RELEASE_VERSION");
	// dsr resolves platform targets to Rust triples, and builds natively per
	// host without passing a target at all. Normalize every spelling to the
	// kit triple so filenames and asset records keep one naming scheme.
	const kitTriple: Record<string, string> = {
		"aarch64-apple-darwin": "darwin-arm64-none",
		"x86_64-apple-darwin": "darwin-x64-none",
		"aarch64-unknown-linux-gnu": "linux-arm64-gnu",
		"x86_64-unknown-linux-gnu": "linux-x64-gnu",
		"darwin:arm64": "darwin-arm64-none",
		"darwin:x64": "darwin-x64-none",
		"linux:arm64": "linux-arm64-gnu",
		"linux:x64": "linux-x64-gnu",
	};
	const hostKey = `${process.platform}:${process.arch}`;
	const key = kitTriple[rawKey] ?? (rawKey === "native" ? kitTriple[hostKey] : undefined) ?? rawKey;
	if (!Object.hasOwn(platformTargets, key)) fail("UNSUPPORTED_PLATFORM");
	if (!isAbsolute(out) || resolve(out) !== out || !lstatSync(out).isDirectory() || lstatSync(out).isSymbolicLink()) fail("UNSAFE_OUTPUT_DIRECTORY");
	const signKey = args.length === 8 ? args[7]! : null;
	if (signKey !== null) {
		const stat = lstatSync(signKey);
		if (!stat.isFile() || stat.isSymbolicLink()) fail("UNSAFE_SIGNING_KEY");
	}
	return { version, key, out, signKey };
}
/** Packaging always regenerates from the actual rule inputs; a stale source MANIFEST.tsv is never an input. */
export function packageRuleManifest(sourceRoot: string, temporaryRoot: string): Buffer {
 const built = Bun.spawnSync(["/bin/sh", join(sourceRoot, "scripts/build-manifest.sh"), "--stdout"], {
  cwd: sourceRoot, stdout: "pipe", stderr: "pipe", env: { ...process.env, TMPDIR: process.env.TMPDIR ?? temporaryRoot },
 });
 if (built.exitCode !== 0) fail(`MANIFEST_GENERATION_FAILED (${built.exitCode}): ${built.stdout.toString()} ${built.stderr.toString()}`);
 if (built.stdout.length === 0) fail("EMPTY_GENERATED_MANIFEST");
 return built.stdout;
}
/**
 * GUARDLOAD1 (bead ompkit-v66l.31): refuse to seal a package whose shipped
 * extensions do not all import from the packaged tree. v0.2.61 shipped
 * extensions/kit-flywheel-guard.ts with `import ... from "../src/cc-spool.ts"`
 * but no src/ directory, so the flywheel, save and agent-mail guards failed
 * to load on every seat. The gate imports every non-test extensions/*.ts
 * file with the staged root as cwd and reports each failure with its
 * resolution message. Pure filesystem + subprocess probe: safe to run against
 * any expanded tree (staged package, installed release, fixture).
 */
export function checkPackagedExtensionLoads(stagedRoot: string): { file: string; error: string }[] {
	const failures: { file: string; error: string }[] = [];
	let entries: string[];
	try {
		entries = readdirSync(join(stagedRoot, "extensions"));
	} catch {
		return [{ file: "extensions/", error: "MISSING_EXTENSIONS_DIR" }];
	}
	for (const entry of entries.sort()) {
		if (!entry.endsWith(".ts") || entry.endsWith(".test.ts")) continue;
		const probed = Bun.spawnSync([process.execPath, "-e", `import("./extensions/${entry}")`], {
			cwd: stagedRoot, stdout: "pipe", stderr: "pipe",
		});
		if (probed.exitCode !== 0) {
			const detail = `${probed.stdout.toString()}${probed.stderr.toString()}`.trim().split("\n").slice(0, 3).join(" | ");
			failures.push({ file: `extensions/${entry}`, error: detail.slice(0, 300) || `EXIT_${probed.exitCode}` });
		}
	}
	return failures;
}

async function run(): Promise<void> {
	const { version, key, out, signKey } = argumentsOf(process.argv.slice(2));
	try {
		const privateRoots = join(root, "var", "agent-tmp");
		authorizeSourceAct({ canonicalRoot: root, privateRoots: existsSync(privateRoots) ? [privateRoots] : [] }, { path: root, act: "build" });
	} catch (error) {
		fail(error instanceof Error ? error.message : String(error));
	}
	const sourcePackage = safeSource("package.json");
	const initialSourceRevision = packageSourceRevision(root, sourcePackage);
	const filename = `omp-kit-v${version}-${key}.tar`;
	const output = join(out, filename);
	try { lstatSync(output); fail("RELEASE_ARCHIVE_EXISTS"); } catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
	}
	const directory = mkdtempSync(join(out, "kit-package-"));
	const compileTmp = mkdtempSync(join(out, "kit-compile-"));
	try {
		const ruleManifest = packageRuleManifest(root, out);
		const binary = join(directory, RELEASE_BINARY_NAME);
		mkdirSync(dirname(binary), { recursive: true, mode: 0o700 });
		const build = Bun.spawnSync([process.execPath, "build", "--compile", "--no-compile-autoload-dotenv",
			"--no-compile-autoload-bunfig", `--target=${platformTargets[key]}`, join(root, "src/cli.ts"), `--outfile=${binary}`], {
			// Bun's cross-target compiler stages a runtime image in TMPDIR. Keep
			// that scratch tree separate from cwd: when both are the package
			// directory, Bun attempts to copy its scratch image onto itself.
			cwd: directory, stdout: "pipe", stderr: "pipe", env: { ...process.env, TMPDIR: compileTmp },
		});
		if (build.exitCode !== 0) fail(`COMPILE_FAILED (${build.exitCode}): ${build.stdout.toString()} ${build.stderr.toString()}`);
		const names = [...files, ...RELEASE_DATA_FILES.filter(path => dirname(path) === ".")];
		for (const path of roots) expand(path, names);
		names.push(RELEASE_BINARY_NAME, "MANIFEST.tsv", "licenses/tern-sdk/LICENSE");
		names.sort();
		if (new Set(names).size !== names.length) fail("DUPLICATE_RELEASE_SOURCE");
		const content = new Map<string, Buffer>();
		for (const name of names) {
			if (name === RELEASE_BINARY_NAME) content.set(name, safeCompiled(binary));
			else if (name === "MANIFEST.tsv") content.set(name, ruleManifest);
			else if (name === "licenses/tern-sdk/LICENSE") content.set(name, safeSource("src/tern/LICENSE"));
			else if (BUNDLE_ERRORS[name]) {
				// Bundle local helpers so the installed script needs no checkout source tree.
				const bundled = await Bun.build({ entrypoints: [join(root, name)], target: "bun", format: "esm", minify: false });
				if (!bundled.success || bundled.outputs.length !== 1) fail(BUNDLE_ERRORS[name]!);
				content.set(name, Buffer.from(await bundled.outputs[0]!.text()));
			} else if (name === "package.json") continue;
			else content.set(name, safeSource(name));
		}
		// GUARDLOAD1 (bead ompkit-v66l.31): load every packaged extension from
		// the exact bytes about to be sealed, with no checkout src/ to fall
		// back on. A packaged extension that resolves outside the package
		// (e.g. ../src/cc-spool.ts in v0.2.61) refuses the build here.
		const loadStage = join(directory, "load-gate");
		mkdirSync(loadStage, { recursive: true, mode: 0o700 });
		for (const [name, bytes] of content) {
			const staged = join(loadStage, name);
			mkdirSync(dirname(staged), { recursive: true, mode: 0o700 });
			const stageFd = openSync(staged, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY, 0o600);
			try { writeAll(stageFd, bytes); } finally { closeSync(stageFd); }
		}
		const loadFailures = checkPackagedExtensionLoads(loadStage);
		if (loadFailures.length > 0) fail(`EXTENSION_LOAD_FAILED: ${loadFailures.map(failure => `${failure.file} (${failure.error})`).join("; ")}`);
		// Reobserve after compilation and resource reads. This detects an observed
		// changed/dirty HEAD, not transient edit-and-revert or authenticated source binding.
		const finalSourcePackage = safeSource("package.json");
		const source_revision = finalSourcePackage.equals(sourcePackage)
			? packageSourceRevision(root, finalSourcePackage, initialSourceRevision) : null;
		content.set("package.json", stampPackageVersion(sourcePackage, version, source_revision));
		const manifest = Buffer.from(`${JSON.stringify({ schema_version: 1, version, source_tag: `v${version}`,
			files: names.map(path => ({ path, sha256: sha(content.get(path)!) })) })}\n`);
		validateReleaseManifest(JSON.parse(manifest.toString("utf8")));
		content.set(RELEASE_MANIFEST_NAME, manifest);
		const dirs = new Set<string>();
		for (const name of content.keys()) for (let parent = dirname(name); parent !== "."; parent = dirname(parent)) dirs.add(parent);
		const entries = [...content.keys(), ...dirs].sort();
		const draft = join(directory, "candidate.tar");
		const fd = openSync(draft, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY, 0o600);
		try {
			for (const name of entries) {
				const bytes = content.get(name);
				writeAll(fd, header(name, bytes?.length ?? 0, !bytes));
				if (bytes) {
					writeAll(fd, bytes);
					const padding = (512 - bytes.length % 512) % 512;
					if (padding) writeAll(fd, Buffer.alloc(padding));
				}
			}
			writeAll(fd, Buffer.alloc(1024));
			fsyncSync(fd);
		} finally { closeSync(fd); }
		// Publishing via hard link cannot overwrite an existing candidate, even if another build raced us.
		linkSync(draft, output);
		unlinkSync(draft);
		const archiveBytes = readFileSync(output);
		const archiveSha = sha(archiveBytes);
		const sbomFilename = `${filename}.sbom.spdx.json`;
		const sbom = Buffer.from(`${JSON.stringify(spdxSbom({ version, key, filename, archiveSha, bunVersion: Bun.version,
			binarySha: sha(content.get(RELEASE_BINARY_NAME)!),
			files: names.map(path => ({ path, sha256: sha(content.get(path)!) })) }))}\n`);
		const sbomPath = join(out, sbomFilename);
		const sbomFd = openSync(sbomPath, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY, 0o644);
		try {
			writeAll(sbomFd, sbom);
			fsyncSync(sbomFd);
		} finally { closeSync(sbomFd); }
		if (signKey !== null) {
			let privateKey;
			try {
				privateKey = createPrivateKey(readFileSync(signKey, "utf8"));
			} catch { fail("INVALID_SIGNING_KEY"); }
			if (privateKey.asymmetricKeyType !== "ed25519") fail("INVALID_SIGNING_KEY");
			for (const [name, bytes] of [[filename, archiveBytes], [sbomFilename, sbom]] as const) {
				const sigFd = openSync(join(out, `${name}.sig`), constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY, 0o644);
				try {
					writeAll(sigFd, sign(null, bytes, privateKey));
					fsyncSync(sigFd);
				} finally { closeSync(sigFd); }
			}
		}
		const [os, arch, libc] = key.split("-");
		const asset: ReleaseAsset = { os: os as ReleaseAsset["os"], arch: arch as ReleaseAsset["arch"],
			libc: libc as ReleaseAsset["libc"], filename, sha256: archiveSha, manifest_sha256: sha(manifest) };
		process.stdout.write(`${JSON.stringify(asset)}\n`);
	} finally {
		rmSync(directory, { recursive: true, force: true });
		rmSync(compileTmp, { recursive: true, force: true });
	}
}
type SpdxInput = { version: string; key: string; filename: string; archiveSha: string; bunVersion: string; binarySha: string; files: { path: string; sha256: string }[] };
/** Deterministic SPDX 2.3 document derived from the exact bytes just sealed into the archive:
 * the archive itself, the compiled binary, the embedding Bun toolchain (the bundled runtime;
 * this kit ships zero third-party runtime dependencies), and every bundled source file. */
function spdxSbom(input: SpdxInput) {
	const iso = new Date().toISOString();
	const created = `${iso.slice(0, 19)}Z`;
	const fileEntries = input.files.map((file, index) => ({
		fileName: file.path,
		SPDXID: `SPDXRef-File-${index + 1}`,
		checksums: [{ algorithm: "SHA256", checksumValue: file.sha256 }],
		licenseConcluded: "NOASSERTION",
		copyrightText: "NOASSERTION",
	}));
	return {
		spdxVersion: "SPDX-2.3",
		dataLicense: "CC0-1.0",
		SPDXID: "SPDXRef-DOCUMENT",
		name: `omp-kit-v${input.version}-${input.key}`,
		documentNamespace: `https://omp-kit.invalid/sbom/v${input.version}/${input.key}`,
		creationInfo: {
			created,
			creators: ["Tool: omp-kit-package-release"],
			licenseListVersion: "3.24",
		},
		packages: [
			{
				name: input.filename,
				SPDXID: "SPDXRef-Archive",
				versionInfo: input.version,
				downloadLocation: "NOASSERTION",
				filesAnalyzed: false,
				checksums: [{ algorithm: "SHA256", checksumValue: input.archiveSha }],
				licenseConcluded: "NOASSERTION",
				copyrightText: "NOASSERTION",
				primaryPackagePurpose: "ARCHIVE",
			},
			{
				name: RELEASE_BINARY_NAME,
				SPDXID: "SPDXRef-Binary",
				versionInfo: input.version,
				downloadLocation: "NOASSERTION",
				filesAnalyzed: false,
				checksums: [{ algorithm: "SHA256", checksumValue: input.binarySha }],
				licenseConcluded: "NOASSERTION",
				copyrightText: "NOASSERTION",
				primaryPackagePurpose: "APPLICATION",
				comment: "Single-file compiled binary; embeds the Bun toolchain below.",
			},
			{
				name: "bun",
				SPDXID: "SPDXRef-Runtime-Bun",
				versionInfo: input.bunVersion,
				downloadLocation: "NOASSERTION",
				filesAnalyzed: false,
				licenseConcluded: "NOASSERTION",
				copyrightText: "NOASSERTION",
				primaryPackagePurpose: "OTHER",
				comment: "Bundled runtime: compiler toolchain embedded in the binary. Reported from the builder's actual Bun runtime; no third-party runtime dependencies ship in this kit.",
			},
		],
		files: fileEntries,
		relationships: [
			{ spdxElementId: "SPDXRef-DOCUMENT", relationshipType: "DESCRIBES", relatedSpdxElement: "SPDXRef-Archive" },
			{ spdxElementId: "SPDXRef-Archive", relationshipType: "CONTAINS", relatedSpdxElement: "SPDXRef-Binary" },
			...fileEntries.map(file => ({ spdxElementId: "SPDXRef-Archive", relationshipType: "CONTAINS", relatedSpdxElement: file.SPDXID })),
			{ spdxElementId: "SPDXRef-Binary", relationshipType: "GENERATED_FROM", relatedSpdxElement: "SPDXRef-Runtime-Bun" },
		],
	};
}

function safeCompiled(binary: string): Buffer {
	const stat = lstatSync(binary);
	if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1) fail("UNSAFE_COMPILED_BINARY");
	return readFileSync(binary);
}
if (import.meta.main) {
 try { await run(); } catch (error) {
  process.stderr.write(`package-release: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
 }
}
