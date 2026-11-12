import { afterAll, expect, test } from "bun:test";
import { chmodSync, cpSync, existsSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { cleanupAllOwnedTmp, ownedTmp } from "../../src/kitlib/tmp.ts";
import { fixtureDeadlineS, runFixture, runFixtureAsync } from "./fixture-process.ts";
afterAll(cleanupAllOwnedTmp);

const ROOT = join(import.meta.dir, "..", "..");
const localScript = readFileSync(join(ROOT, "scripts/release-local.sh"), "utf8");
function releaseStage(start: string, end: string): string {
	const first = localScript.indexOf(start);
	const last = localScript.indexOf(end, first + start.length);
	if (first < 0 || last < 0) throw new Error(`release stage boundary missing: ${start} / ${end}`);
	return localScript.slice(first, last);
}
// Isolated git identity for the fixture repositories, mirroring release-local.test.ts.
function gitFixtureEnv(work: string): Record<string, string> {
	const env: Record<string, string> = {};
	for (const [name, value] of Object.entries(process.env)) if (value !== undefined) env[name] = value;
	delete env.GIT_DIR; delete env.GIT_WORK_TREE; delete env.GIT_INDEX_FILE;
	return { ...env, GIT_CEILING_DIRECTORIES: work, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null" };
}
const helperScript = releaseStage("bounded() {", "# ---------------------------------------------------------------------------------------------- 1. preflight");
const resumeStage = releaseStage('if [ "${RESUME_FROM_DRAFT:-0}" = 1 ]; then\nstage resume\n', "# VERSIONSRC1");
// The draft adoption slice asserts its own prelude contract, like the sibling
// release-local fixtures: production stage text, real git/curl/checksums, stubbed gh.
function resumePrelude(root: string): string {
	return `set -euo pipefail
die() { echo "release-local: refused: $*" >&2; exit 4; }
say() { echo "== $*"; }
WORK=$1; ROOT=${root}; REPO=fixture/release; VERSION=0.0.1; RESUME_FROM_DRAFT=1
STAGE_LOG="$WORK/stages"; : >"$STAGE_LOG"
${helperScript}`;
}

// Minimal USTAR writer: the draft adoption proves archives through the real
// installer index check and release_reuse verify-archive (filename + sha256),
// so archives need only be well-formed compressed bytes with recorded digests.
function ustar(name: string, data: Uint8Array): Uint8Array {
	const enc = new TextEncoder();
	const header = new Uint8Array(512);
	header.set(enc.encode(name).subarray(0, 100), 0);
	header.set(enc.encode("0000644\0"), 100);
	header.set(enc.encode("0000000\0"), 108);
	header.set(enc.encode("0000000\0"), 116);
	header.set(enc.encode(data.length.toString(8).padStart(11, "0") + "\0"), 124);
	header.set(enc.encode("00000000000\0"), 136);
	header.set(enc.encode("        "), 148);
	header[156] = 48;
	header.set(enc.encode("ustar\0"), 257);
	header.set(enc.encode("00"), 263);
	let sum = 0;
	for (const byte of header) sum += byte;
	header.set(enc.encode(sum.toString(8).padStart(6, "0") + "\0 "), 148);
	const pad = (512 - (data.length % 512)) % 512;
	const out = new Uint8Array(512 + data.length + pad);
	out.set(header, 0);
	out.set(data, 512);
	return out;
}
function tarball(files: [string, Uint8Array][]): Uint8Array {
	const parts = files.map(([name, data]) => ustar(name, data));
	const body = parts.reduce((total, part) => total + part.length, 0);
	const out = new Uint8Array(body + 1024);
	let offset = 0;
	for (const part of parts) { out.set(part, offset); offset += part.length; }
	return out;
}
const sha256 = (bytes: Uint8Array): string => new Bun.CryptoHasher("sha256").update(bytes).digest("hex");

const VERSION = "0.0.1";
const PLATFORMS = ["darwin-arm64-none", "linux-arm64-gnu", "linux-x64-gnu"] as const;
const assetName = (platform: string): string => `omp-kit-v${VERSION}-${platform}.tar.gz`;

type DraftCase = "match" | "tampered" | "published";
function buildFixture(label: string, draft: DraftCase): {
	work: string; env: Record<string, string>; root: string; bin: string;
} {
	const work = realpathSync(ownedTmp(label, { root: process.env.TMPDIR ?? join(ROOT, "var", "agent-tmp") }).path);
	const env = { ...gitFixtureEnv(work), GIT_AUTHOR_NAME: "Fixture", GIT_AUTHOR_EMAIL: "fixture@example.invalid",
		GIT_COMMITTER_NAME: "Fixture", GIT_COMMITTER_EMAIL: "fixture@example.invalid" };
	const bin = join(work, "bin");
	mkdirSync(bin, { recursive: true });
	// A release source checkout: exact-tagged commit stating VERSION, with an
	// origin remote, plus the scripts the adoption stage reuses. bun pin is the
	// runner's own, so the export preflight passes on any current bun.
	const origin = join(work, "origin");
	const git = (cwd: string, args: string[]) => {
		const result = runFixture(["git", "-C", cwd, ...args], { cwd, env, floor_s: 30 });
		if (result.rc !== 0) throw new Error(`git ${args.join(" ")}: ${new TextDecoder().decode(result.stderr)}`);
		return new TextDecoder().decode(result.stdout).trim();
	};
	git(work, ["init", "-q", origin]);
	mkdirSync(join(origin, "scripts"), { recursive: true });
	mkdirSync(join(origin, "installer"), { recursive: true });
	cpSync(join(ROOT, "scripts", "release-preflight.sh"), join(origin, "scripts", "release-preflight.sh"));
	cpSync(join(ROOT, "scripts", "release-train.sh"), join(origin, "scripts", "release-train.sh"));
	cpSync(join(ROOT, "scripts", "release_reuse.py"), join(origin, "scripts", "release_reuse.py"));
	cpSync(join(ROOT, "scripts", "kitlib_io.py"), join(origin, "scripts", "kitlib_io.py"));
	cpSync(join(ROOT, "installer", "install.py"), join(origin, "installer", "install.py"));
	const versioned = runFixture(["bun", "--version"], { cwd: work, env, floor_s: 30 });
	if (versioned.rc !== 0) throw new Error("bun --version is required for the resume export fixture");
	const pinned = new TextDecoder().decode(versioned.stdout).trim();
	writeFileSync(join(origin, "package.json"), `{\n  "name": "fixture",\n  "version": "${VERSION}",\n  "source_revision": "$Format:%H$",\n  "omp": {\n    "version": "${VERSION}"\n  }\n}\n`);
	writeFileSync(join(origin, ".gitattributes"), "package.json export-subst\n");
	writeFileSync(join(origin, ".bun-version"), pinned + "\n");
	git(origin, ["add", "-A"]);
	git(origin, ["commit", "-qm", "fixture source"]);
	git(origin, ["tag", `v${VERSION}`]);
	const root = join(work, "root");
	// --no-hardlinks: export-tree filesystems refuse the local-clone hardlink optimization.
	git(work, ["clone", "-q", "--no-hardlinks", origin, root]);
	// Draft assets: crafted archives plus an index and checksums over them, all
	// recorded with real digests. The tampered case serves different archive
	// bytes than the recorded digests, exactly like a draft that is not the
	// signed bytes.
	const assets = join(work, "assets");
	mkdirSync(assets, { recursive: true });
	const archives = new Map<string, Uint8Array>();
	for (const platform of PLATFORMS) {
		const binary = new TextEncoder().encode(`fixture binary for ${platform}\n`);
		const manifest = new TextEncoder().encode(JSON.stringify({ schema_version: 1, version: VERSION,
			source_tag: `v${VERSION}`, files: [{ path: "bin/omp-kit", sha256: sha256(binary) }] }) + "\n");
		const archive = Bun.gzipSync(tarball([["bin/omp-kit", binary], ["release-manifest.json", manifest]]));
		archives.set(assetName(platform), archive);
	}
	const index = { schema_version: 1, version: VERSION, source_tag: `v${VERSION}`, assets: Object.fromEntries(
		PLATFORMS.map((platform) => {
			const [os, arch, libc] = platform.split("-");
			const filename = assetName(platform);
			return [platform, { os, arch, libc, filename, sha256: sha256(archives.get(filename)!), manifest_sha256: sha256(new TextEncoder().encode(filename)) }];
		})) };
	writeFileSync(join(assets, "release-index.json"), JSON.stringify(index, null, 2) + "\n");
	const names = ["SHA256SUMS", "release-index.json", ...PLATFORMS.map(assetName)];
	for (const [name, bytes] of archives) writeFileSync(join(assets, name), bytes);
	const sums = names.filter((name) => name !== "SHA256SUMS").map((name) => `${sha256(readFileSync(join(assets, name)))}  ${name}\n`).join("");
	writeFileSync(join(assets, "SHA256SUMS"), sums);
	const draftAssets = names.map((name) => ({ name, digest: `sha256:${sha256(readFileSync(join(assets, name)))}` }));
	// The stub serves API responses from separate source files: the script
	// redirects each answer into releases.json/draft.json, which would truncate
	// the file the stub reads if they were the same path.
	writeFileSync(join(work, "releases-page.json"), JSON.stringify([[
		{ tag_name: "v0.0.0", draft: false, prerelease: false },
		{ tag_name: `v${VERSION}`, draft: true, prerelease: false },
	]]));
	writeFileSync(join(work, "draft-page.json"), JSON.stringify({ tagName: `v${VERSION}`,
		isDraft: draft !== "published", assets: draftAssets }));
	// Stubbed gh: authenticated, serves the recorded releases/draft, and
	// materializes the draft assets. Tamper replaces one archive after the
	// digests are recorded, so the real SHA256SUMS check must refuse.
	writeFileSync(join(bin, "gh"), `#!/bin/sh
printf '%s\\n' "$*" >>"$RELEASE_TEST_WORK/gh-calls"
case "$*" in
"auth status"*) exit 0 ;;
"api --paginate --slurp"*) cat "$RELEASE_TEST_WORK/releases-page.json" ;;
"release view"*) cat "$RELEASE_TEST_WORK/draft-page.json" ;;
"release download"*)
	dir=""; prev=""
	for arg in "$@"; do
		if [ "$prev" = "--dir" ]; then dir="$arg"; fi
		prev="$arg"
	done
	for name in ${names.join(" ")}; do cp "$RELEASE_TEST_ASSETS/$name" "$dir/$name"; done
	if [ -n "$RELEASE_TEST_TAMPER" ]; then printf '%s' "$RELEASE_TEST_TAMPER" > "$dir/$RELEASE_TEST_TAMPER_NAME"; fi ;;
*) exit 99 ;;
esac
`);
	chmodSync(join(bin, "gh"), 0o755);
	if (draft === "tampered") {
		writeFileSync(join(work, "tamper"), "tamper");
	}
	return { work, env, root, bin };
}

test.skipIf(process.platform !== "darwin")("RELRESUME1 resume adopts the tag and draft and proves both before attest", async () => {
	const { work, env, root, bin } = buildFixture("relresume-ok", "match");
	try {
		const result = await runFixtureAsync(["bash", "-c", `${resumePrelude(root)}\n${resumeStage}`, "relresume-ok", work], {
			cwd: ROOT, env: { ...env, TMPDIR: work, PATH: `${bin}:${process.env.PATH ?? ""}`, RELEASE_TEST_WORK: work, RELEASE_TEST_ASSETS: join(work, "assets") }, floor_s: 10,
		});
		const stderr = new TextDecoder().decode(result.stderr);
		const stdout = new TextDecoder().decode(result.stdout);
		expect(result.rc, stderr).toBe(0);
		expect(stdout).toContain(`resumed v${VERSION} from its draft`);
		for (const name of ["SHA256SUMS", "release-index.json", ...PLATFORMS.map(assetName)])
			expect(existsSync(join(work, "dist", name)), name).toBe(true);
		expect(new TextDecoder().decode(result.stderr)).not.toContain("never re-tagged");
		const calls = readFileSync(join(work, "gh-calls"), "utf8");
		expect(calls).toContain("release download");
		expect(calls).not.toContain("release create");
		expect(calls).not.toContain("workflow run");
	} finally {
		rmSync(work, { recursive: true, force: true });
	}
}, fixtureDeadlineS(20) * 1_000);

test.skipIf(process.platform !== "darwin")("RELRESUME1 planted negative: a draft asset whose digest differs refuses", async () => {
	const { work, env, root, bin } = buildFixture("relresume-tamper", "tampered");
	try {
		const result = await runFixtureAsync(["bash", "-c", `${resumePrelude(root)}\n${resumeStage}`, "relresume-tamper", work], {
			cwd: ROOT, env: { ...env, TMPDIR: work, PATH: `${bin}:${process.env.PATH ?? ""}`, RELEASE_TEST_WORK: work,
				RELEASE_TEST_ASSETS: join(work, "assets"),
				RELEASE_TEST_TAMPER: "not the signed bytes\n", RELEASE_TEST_TAMPER_NAME: assetName("linux-x64-gnu") }, floor_s: 10,
		});
		const stderr = new TextDecoder().decode(result.stderr);
		expect(result.rc, stderr).toBe(4);
		expect(stderr).toContain("draft SHA256SUMS check failed");
	} finally {
		rmSync(work, { recursive: true, force: true });
	}
}, fixtureDeadlineS(20) * 1_000);

test.skipIf(process.platform !== "darwin")("RELRESUME1 planted negative: an already-published release is not a resumable draft", async () => {
	const { work, env, root, bin } = buildFixture("relresume-pub", "published");
	try {
		const result = await runFixtureAsync(["bash", "-c", `${resumePrelude(root)}\n${resumeStage}`, "relresume-pub", work], {
			cwd: ROOT, env: { ...env, TMPDIR: work, PATH: `${bin}:${process.env.PATH ?? ""}`, RELEASE_TEST_WORK: work, RELEASE_TEST_ASSETS: join(work, "assets") }, floor_s: 10,
		});
		const stderr = new TextDecoder().decode(result.stderr);
		expect(result.rc, stderr).toBe(4);
		expect(stderr).toContain("not a resumable draft");
	} finally {
		rmSync(work, { recursive: true, force: true });
	}
}, fixtureDeadlineS(20) * 1_000);

test("RELRESUME1 resume needs --version alone, and never re-tags or recreates the draft", () => {
	const script = readFileSync(join(ROOT, "scripts/release-local.sh"), "utf8");
	// Usage refuses every conflicting mode with exit 2, before TMPDIR is required.
	for (const args of [["--resume-from-draft"], ["--resume-from-draft", "--version", VERSION, "--dry-run"],
		["--resume-from-draft", "--version", VERSION, "--advance-only", "--version", VERSION]]) {
		const result = runFixture(["bash", join(ROOT, "scripts/release-local.sh"), ...args], {
			cwd: ROOT, env: { ...process.env, TMPDIR: join(ROOT, "var", "agent-tmp") }, floor_s: 30,
		});
		expect(result.rc, new TextDecoder().decode(result.stderr)).toBe(2);
	}
	// The tag push, draft creation and attest dispatch all sit inside the
	// non-resume branch; the resume adoption downloads the draft instead.
	const adoption = script.indexOf("stage resume");
	const guard = script.indexOf('if [ "${RESUME_FROM_DRAFT:-0}" = 0 ]; then');
	const tagPush = script.indexOf('push --porcelain origin "$SOURCE:refs/tags/v$VERSION"');
	const draftCreate = script.indexOf("gh release create");
	const attestDispatch = script.indexOf("gh workflow run release.yml");
	const download = script.indexOf("gh release download", adoption);
	expect(Math.min(adoption, guard)).toBeGreaterThan(-1);
	expect(guard).toBeLessThan(tagPush);
	expect(tagPush).toBeGreaterThan(guard);
	expect(draftCreate).toBeGreaterThan(guard);
	expect(attestDispatch).toBeGreaterThan(guard);
	expect(download).toBeGreaterThan(adoption);
	expect(download).toBeLessThan(attestDispatch);
	expect(runFixture(["bash", "-n", join(ROOT, "scripts/release-local.sh")], { cwd: ROOT, floor_s: 30 }).rc).toBe(0);
});
