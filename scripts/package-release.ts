#!/usr/bin/env bun
import { createHash } from "node:crypto";
import { closeSync, constants, fsyncSync, linkSync, lstatSync, mkdirSync, mkdtempSync, openSync, readFileSync, readdirSync, rmSync, unlinkSync, writeSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { RELEASE_BINARY_NAME, RELEASE_MANIFEST_NAME, validateReleaseManifest, type ReleaseAsset } from "../src/kit-release.ts";

const root = resolve(import.meta.dir, "..");
const platformTargets: Record<string, string> = {
	"darwin-arm64-none": "bun-darwin-arm64",
	"darwin-x64-none": "bun-darwin-x64",
	"linux-arm64-gnu": "bun-linux-arm64",
	"linux-x64-gnu": "bun-linux-x64",
};
const roots = ["rules", "retired", "cases", "policy", "extensions", "examples", "checkers"];
const files = ["LICENSE", "MANIFEST.tsv", "package.json", "scripts/apply-policy.sh", "scripts/build-manifest.sh",
	"scripts/context-inventory.ts", "scripts/doctor.sh", "scripts/e2e-live.sh", "scripts/install-extensions.sh", "scripts/install.sh",
	"scripts/ladder.sh", "scripts/limit-process-tree.sh", "scripts/rule-class.ts", "scripts/runtime-adapter.sh",
	"scripts/ttsr-harness.ts", "scripts/external-live.mjs", "tests/live/scenarios.json", "tests/live/lib.mjs", "tests/live/mock-model.mjs",
	"tests/cli/metamorphic-baseline.json"];
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
	octal(block, 100, 8, directory ? 0o755 : path === RELEASE_BINARY_NAME || path.endsWith(".sh") ? 0o755 : 0o644);
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
	if (args.length !== 6 || args[0] !== "--version" || args[2] !== "--platform" || args[4] !== "--out")
		fail("Usage: package-release.sh --version X.Y.Z --platform darwin-arm64-none|darwin-x64-none|linux-arm64-gnu|linux-x64-gnu --out ABSOLUTE_DIR");
	const version = args[1]!, key = args[3]!, out = args[5]!;
	if (!/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z.-]+)?$/.test(version)) fail("INVALID_RELEASE_VERSION");
	if (!Object.hasOwn(platformTargets, key)) fail("UNSUPPORTED_PLATFORM");
	if (!isAbsolute(out) || resolve(out) !== out || !lstatSync(out).isDirectory() || lstatSync(out).isSymbolicLink()) fail("UNSAFE_OUTPUT_DIRECTORY");
	return { version, key, out };
}
function run(): void {
	const { version, key, out } = argumentsOf(process.argv.slice(2));
	const filename = `omp-kit-v${version}-${key}.tar`;
	const output = join(out, filename);
	try { lstatSync(output); fail("RELEASE_ARCHIVE_EXISTS"); } catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
	}
	const directory = mkdtempSync(join(out, "kit-package-"));
	try {
		const binary = join(directory, RELEASE_BINARY_NAME);
		mkdirSync(dirname(binary), { recursive: true, mode: 0o700 });
		const build = Bun.spawnSync([process.execPath, "build", "--compile", "--no-compile-autoload-dotenv",
			"--no-compile-autoload-bunfig", `--target=${platformTargets[key]}`, join(root, "src/cli.ts"), `--outfile=${binary}`], {
			cwd: root, stdout: "pipe", stderr: "pipe", env: { ...process.env, TMPDIR: process.env.TMPDIR ?? out },
		});
		if (build.exitCode !== 0) fail(`COMPILE_FAILED (${build.exitCode}): ${build.stdout.toString()} ${build.stderr.toString()}`);
		const names = [...files];
		for (const path of roots) expand(path, names);
		names.push(RELEASE_BINARY_NAME);
		names.sort();
		if (new Set(names).size !== names.length) fail("DUPLICATE_RELEASE_SOURCE");
		const content = new Map(names.map(name => [name, name === RELEASE_BINARY_NAME ? safeCompiled(binary) : safeSource(name)]));
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
		const [os, arch, libc] = key.split("-");
		const asset: ReleaseAsset = { os: os as ReleaseAsset["os"], arch: arch as ReleaseAsset["arch"],
			libc: libc as ReleaseAsset["libc"], filename, sha256: sha(readFileSync(output)), manifest_sha256: sha(manifest) };
		process.stdout.write(`${JSON.stringify(asset)}\n`);
	} finally {
		rmSync(directory, { recursive: true, force: true });
	}
}
function safeCompiled(binary: string): Buffer {
	const stat = lstatSync(binary);
	if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1) fail("UNSAFE_COMPILED_BINARY");
	return readFileSync(binary);
}
try { run(); } catch (error) {
	process.stderr.write(`package-release: ${error instanceof Error ? error.message : String(error)}\n`);
	process.exitCode = 1;
}
