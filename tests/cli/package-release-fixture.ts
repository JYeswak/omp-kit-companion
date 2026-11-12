import { afterAll, beforeAll, expect } from "bun:test";
import { chmodSync, copyFileSync, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, readlinkSync, realpathSync, symlinkSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { delimiter, join, resolve } from "node:path";
import type { ReleaseAsset, ReleasePlatform } from "../../src/kit-release.ts";
import { ompSourceCacheRoot } from "../../src/omp-source-cache.ts";
import { cleanupAllOwnedTmp, ownedTmp } from "../../src/kitlib/tmp.ts";
import { runSync } from "../../src/kitlib/run.ts";
import { releaseProcess } from "./release-process.ts";
import { fixtureDeadlineS } from "./fixture-process.ts";

const repo = resolve(import.meta.dir, "../..");

const caseCwd = realpathSync(process.env.OMP_KIT_CASE_CWD || process.env.GITHUB_WORKSPACE || repo);
const sourceCacheRoot = ompSourceCacheRoot(process.env);
const nativeCacheEnv = sourceCacheRoot ? { OMP_KIT_OMP_SRC_CACHE: resolve(sourceCacheRoot) } : {};
const scratch = join(caseCwd, "var", "agent-tmp");
mkdirSync(scratch, { recursive: true, mode: 0o700 });
const outputTmp = ownedTmp("p21-release", { root: scratch });
const output = outputTmp.path;
// As in retainProducerOutput, bind the kitlib marker to the caller workspace,
// not an exact-commit export's cwd or the runner's unrelated TMPDIR.
writeFileSync(join(output, ".owner"),
	`pid=${process.pid}\nlabel=p21-release\nrepo=${caseCwd}\ncreated=${new Date().toISOString()}\n`, { mode: 0o600 });
// Runtime identity rebuilds fixed-env PATH from this private HOME, not stubFirstPath.
// CI installs Bun under the original HOME; retain the actual executable in this one too.
const homeBunBin = join(output, ".bun", "bin");
mkdirSync(homeBunBin, { recursive: true });
symlinkSync(process.execPath, join(homeBunBin, "bun"));
const stubBin = join(output, "stub-bin");
mkdirSync(stubBin, { recursive: true });
writeFileSync(join(stubBin, "omp"), "#!/bin/sh\nprintf 'omp stub\\n'\n");
chmodSync(join(stubBin, "omp"), 0o755);
const stubFirstPath = [stubBin, process.env.PATH ?? ""].join(delimiter);
// Explicitly synthetic authority-policy double, not real signature evidence.
const authorityPath = [join(repo, "tests/fixtures/kit-release"), process.env.PATH ?? ""].join(delimiter);
const platform: ReleasePlatform = { os: process.platform as "darwin" | "linux", arch: process.arch as "arm64" | "x64", libc: process.platform === "darwin" ? "none" : "gnu" };
const key = `${platform.os}-${platform.arch}-${platform.libc}`;
const indexPath = join(output, "release-index.json");
let asset: ReleaseAsset;
let bytes: Buffer;
let index: { schema_version: number; version: string; source_tag: string; assets: Record<string, ReleaseAsset> };
let sourceRevision: string;

function sourceGit(directory: string, args: string[]): Buffer {
	const env = Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] =>
		!entry[0].startsWith("GIT_") && entry[1] !== undefined));
	const result = runSync(["git", "-C", directory, ...args], { cwd: directory, deadline_s: 15,
		env: { ...env, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null", GIT_AUTHOR_NAME: "SourceStamp",
			GIT_AUTHOR_EMAIL: "source@example.invalid", GIT_COMMITTER_NAME: "SourceStamp", GIT_COMMITTER_EMAIL: "source@example.invalid" } });
	expect(result.rc, Buffer.from(result.stderr).toString()).toBe(0);
	return Buffer.from(result.stdout);
}
function sourceTree(directory: string, mode: "freeze" | "digest" | "release"): string {
	const digest = createHash("sha256");
	const visit = (path: string, name: string): void => {
		const stat = lstatSync(path);
		if (stat.isDirectory()) {
			if (mode === "release") chmodSync(path, 0o700);
			for (const child of readdirSync(path).sort()) visit(join(path, child), `${name}/${child}`);
			if (mode === "freeze") chmodSync(path, 0o555);
			digest.update(JSON.stringify([name, "directory", lstatSync(path).mode]));
		} else if (stat.isSymbolicLink()) {
			digest.update(JSON.stringify([name, "symlink", readlinkSync(path)]));
		} else {
			if (mode === "freeze") chmodSync(path, stat.mode & 0o111 ? 0o555 : 0o444);
			digest.update(JSON.stringify([name, lstatSync(path).mode,
				createHash("sha256").update(readFileSync(path)).digest("hex")]));
		}
	};
	visit(directory, "");
	return digest.digest("hex");
}
const sourceRevisionPattern = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/;
function readExportStamp(directory: string): string | undefined {
	// Commit-preflight's verdict export records the HEAD it archived plus the
	// judged overlay. The export's git holds no objects, so this stamp (not
	// rev-parse) names the revision an export builds from.
	const raw = join(directory, ".git", "omp-kit-export.json");
	if (!existsSync(raw)) return undefined;
	const stamp: unknown = JSON.parse(readFileSync(raw, "utf8"));
	if (stamp === null || typeof stamp !== "object" || Array.isArray(stamp)
		|| !("source_revision" in stamp) || typeof stamp.source_revision !== "string"
		|| !sourceRevisionPattern.test(stamp.source_revision)) return undefined;
	return stamp.source_revision;
}
function copyExportTree(root: string, dest: string): void {
	// `git archive` without its object store: the export already holds the
	// archived HEAD plus the judged overlay, so copy that tree, skipping what
	// an archive never carries (the export's fresh .git, scratch, linked
	// dependencies) and what the gate generates beside the judged tree.
	const visit = (rel: string): void => {
		const parts = rel === "" ? [] : rel.split("/");
		if (parts.includes(".git") || parts.includes("node_modules")
			|| parts[0] === "var" || (parts.length === 1 && parts[0] === "MANIFEST.tsv")) return;
		const from = join(root, rel);
		const to = join(dest, rel);
		const stat = lstatSync(from);
		if (stat.isDirectory()) {
			mkdirSync(to, { recursive: true });
			for (const child of readdirSync(from).sort()) visit(rel === "" ? child : `${rel}/${child}`);
			chmodSync(to, stat.mode & 0o7777);
		} else if (stat.isSymbolicLink()) {
			symlinkSync(readlinkSync(from), to);
		} else if (stat.isFile()) {
			copyFileSync(from, to);
			chmodSync(to, stat.mode & 0o7777);
		} else {
			throw new Error(`package-release fixture: cannot copy special file ${rel}`);
		}
	};
	visit("");
}

beforeAll(async () => {
	const metadata: unknown = JSON.parse(readFileSync(join(repo, "package.json"), "utf8"));
	const exported = metadata !== null && typeof metadata === "object" && !Array.isArray(metadata)
		&& "source_revision" in metadata && typeof metadata.source_revision === "string"
		&& metadata.source_revision !== "$Format:%H$" ? metadata.source_revision : undefined;
	const stampRevision = readExportStamp(repo);
	const selected = process.env.OMP_KIT_CASE_SOURCE_SHA ?? stampRevision ?? exported;
	const archived = join(output, "archived-source");
	if (stampRevision !== undefined || exported !== undefined) {
		// Export layout (commit-preflight's verdict export or the push gate's
		// exact-commit archive): the fresh `git init -q` leaves HEAD unborn
		// with no objects, so rev-parse/archive would refuse. Both layouts
		// stamp the revision instead (.git/omp-kit-export.json names HEAD;
		// git's export-subst stamps package.json on archive); cross-check the
		// two git-authored stamps and build from the exported tree, never the
		// caller's checkout or its history.
		expect(selected).toMatch(sourceRevisionPattern);
		if (stampRevision !== undefined && exported !== undefined) expect(exported).toBe(stampRevision);
		sourceRevision = selected as string;
		copyExportTree(repo, archived);
	} else {
		// A real checkout carries its history; resolve and archive HEAD there.
		expect(sourceGit(repo, ["rev-parse", "--show-toplevel"]).toString().trim()).toBe(repo);
		sourceRevision = sourceGit(repo, ["rev-parse", "--verify", "--end-of-options", `${selected ?? "HEAD"}^{commit}`]).toString().trim();
		if (selected !== undefined) expect(sourceRevision).toBe(selected);
		const sourceArchive = join(output, "selected-source.tar");
		sourceGit(repo, ["archive", "--format=tar", `--output=${sourceArchive}`, sourceRevision]);
		mkdirSync(archived);
		const extracted = await releaseProcess(["tar", "-xf", sourceArchive, "-C", archived], { stdout: "pipe", stderr: "pipe", deadline_s: fixtureDeadlineS(120) });
		expect(extracted.exitCode, extracted.stderr.toString()).toBe(0);
	}
	expect(existsSync(join(archived, "MANIFEST.tsv"))).toBe(false);
	const sourceBefore = sourceTree(archived, "freeze");
	const built = await releaseProcess(["sh", join(archived, "scripts", "package-release.sh"), "--version", "1.2.3", "--platform", key, "--out", output], { cwd: output, env: { ...process.env, OMP_KIT_TEST_WORK_ROOT: output, TMPDIR: output }, stdout: "pipe", stderr: "pipe", deadline_s: fixtureDeadlineS(120) });
	expect(built.exitCode, built.stdout.toString() + built.stderr.toString()).toBe(0);
	expect(readdirSync(output).filter(name => name.startsWith("omp-kit-work."))).toEqual([]);
	expect(sourceTree(archived, "digest")).toBe(sourceBefore);
	expect(existsSync(join(archived, "MANIFEST.tsv"))).toBe(false);
	asset = JSON.parse(built.stdout.toString()) as ReleaseAsset;
	bytes = readFileSync(join(output, asset.filename));
	expect(createHash("sha256").update(bytes).digest("hex")).toBe(asset.sha256);
	index = { schema_version: 1, version: "1.2.3", source_tag: "v1.2.3", assets: { [key]: asset } };
	writeFileSync(indexPath, `${JSON.stringify(index)}\n`);
	writeFileSync(join(output, `${asset.filename}.sigstore.json`), '{"fixture":true}\n');
}, fixtureDeadlineS(300) * 1_000);
afterAll(() => {
	const archived = join(output, "archived-source");
	try {
		if (existsSync(archived)) sourceTree(archived, "release");
	} finally {
		try { outputTmp.cleanup(); }
		finally { cleanupAllOwnedTmp(); }
	}
});

export { repo, caseCwd, nativeCacheEnv, output, stubFirstPath, authorityPath, platform, key,
 indexPath, asset, bytes, index, sourceRevision, sourceGit, sourceTree, installArgs, installCandidate, run, candidateEnv };
export type { Candidate };
type Candidate = { home: string; installedRoot: string; installedBinary: string };
function installArgs(name: string): { home: string; prefix: string; command: string[]; options: { cwd: string; env: Record<string, string | undefined> } } {
	const home = join(output, name);
	mkdirSync(home);
	const prefix = join(home, ".local", "opt", "omp-kit");
	return { home, prefix, command: ["sh", join(repo, "installer", "install.sh"), "--version", "1.2.3",
		"--index", indexPath, "--offline", join(output, asset.filename), "--prefix", prefix],
	options: { cwd: output, env: { ...process.env, PATH: authorityPath, HOME: home, TMPDIR: output, OMP: "", OMP_BIN: "", OMP_PATH: "", OMP_SRC: "" } } };
}
async function installCandidate(name: string): Promise<Candidate> {
	const { home, prefix, command, options } = installArgs(name);
	const installed = await releaseProcess(command, { ...options, stdout: "pipe", stderr: "pipe", deadline_s: fixtureDeadlineS(120) });
	expect(installed.exitCode, installed.stdout.toString() + installed.stderr.toString()).toBe(0);
	return { home, installedRoot: join(prefix, "releases", "1.2.3"), installedBinary: join(prefix, "bin", "omp-kit") };
}
type Run = { exitCode: number | null; stdout: string; stderr: string };
async function run(command: string[], options: { cwd: string; env: Record<string, string | undefined> }): Promise<Run> {
	const child = await releaseProcess(command, { ...options, deadline_s: fixtureDeadlineS(120) });
	return { exitCode: child.exitCode, stdout: child.stdout.toString(), stderr: child.stderr.toString() };
}
function candidateEnv(home: string, extra: Record<string, string> = {}): Record<string, string | undefined> {
	return { ...process.env, ...nativeCacheEnv, HOME: home, XDG_STATE_HOME: join(home, "xdg-state"),
		XDG_CACHE_HOME: join(home, "xdg-cache"), TMPDIR: output,
		OMP_KIT_CASE_CWD: caseCwd, OMP_KIT_TEST_WORK_ROOT: output,
		OMP: "", OMP_BIN: "", OMP_PATH: "", OMP_SRC: "", ...extra };
}
