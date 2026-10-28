import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdirSync, readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { run } from "../../src/kitlib/run.ts";
import { ownedTmp } from "../../src/kitlib/tmp.ts";

const REPO_ROOT = resolve(import.meta.dir, "../..");
const SCAN_ROOTS = ["src", "extensions", "scripts"];
/** Static import/export with an absolute specifier: `from "/..."`, `import "..."`, `import("/...")`. Word-boundary anchored so identifiers like fromRel/fromDir do not match. Line-based, like the rg gate. */
const ABS_SPEC = [/\bfrom\s+['"]\//, /\bimport\s+['"]\//, /\bimport\s*\(\s*['"]\//];

const utf8 = (b: Uint8Array) => new TextDecoder().decode(b);

function tsFiles(dir: string): string[] {
	const out: string[] = [];
	for (const entry of readdirSync(dir, { withFileTypes: true })) {
		const p = join(dir, entry.name);
		if (entry.isDirectory()) out.push(...tsFiles(p));
		else if (entry.isFile() && p.endsWith(".ts")) out.push(p);
	}
	return out;
}

let cachedExport: { srcExport: string; identity: Record<string, string> } | null = null;
/** Exact source tree in owned scratch. Normal path archives verified HEAD (top-level guard refuses ancestor discovery); cold path uses a caller-provided tarball verified by sha256 (TRUSTED_SOURCE_TARBALL + TRUSTED_SOURCE_SHA), no git required. Either way the scan and builds run on the extract, never on a discovered ancestor. The tarball bytes are the source identity: `git archive` output is deterministic per commit. */
async function exactSource(): Promise<{ srcExport: string; identity: Record<string, string> }> {
	if (cachedExport) return cachedExport;
	const g = process.env.GRADE_WAVE_SCRATCH || undefined;
	const root = ownedTmp("absexport", g === undefined ? {} : { root: g }).path;
	const srcExport = join(root, "export");
	mkdirSync(srcExport, { recursive: true });
	const tarball = join(root, "source.tar");
	const trustedTar = process.env.TRUSTED_SOURCE_TARBALL;
	const trustedSha = process.env.TRUSTED_SOURCE_SHA;
	let identity: Record<string, string>;
	if (trustedTar && trustedSha) {
		const actual = createHash("sha256").update(readFileSync(trustedTar)).digest("hex");
		if (actual !== trustedSha) throw new Error(`untrusted source: tarball sha ${actual} != expected ${trustedSha}`);
		const ex = await run(["tar", "-x", "-f", trustedTar, "-C", srcExport], { cwd: root, deadline_s: 300 });
		if (ex.rc !== 0) throw new Error(`trusted source extract -> ${ex.rc}`);
		identity = { tarballSha256: actual, provenance: "trusted-input" };
	} else {
		const head = await run(["git", "-C", REPO_ROOT, "rev-parse", "HEAD"], { cwd: REPO_ROOT, deadline_s: 60 });
		if (head.rc !== 0) throw new Error("no HEAD; unmet prerequisite: exact committed source (or set TRUSTED_SOURCE_TARBALL + TRUSTED_SOURCE_SHA)");
		const sha = utf8(head.stdout).trim();
		const top = await run(["git", "-C", REPO_ROOT, "rev-parse", "--show-toplevel"], { cwd: REPO_ROOT, deadline_s: 60 });
		if (top.rc !== 0 || resolve(utf8(top.stdout).trim()) !== resolve(REPO_ROOT)) throw new Error(`source identity not exact: ${REPO_ROOT} is not a repo top-level; refusing ancestor discovery`);
		const tree = await run(["git", "-C", REPO_ROOT, "rev-parse", `${sha}^{tree}`], { cwd: REPO_ROOT, deadline_s: 60 });
		const treeSha = tree.rc === 0 ? utf8(tree.stdout).trim() : "unknown";
		const arch = await run(["sh", "-c", `git -C ${JSON.stringify(REPO_ROOT)} archive ${JSON.stringify(sha)} | tee ${JSON.stringify(tarball)} | tar -x -C ${JSON.stringify(srcExport)}`], { cwd: root, deadline_s: 300 });
		if (arch.rc !== 0) throw new Error(`exact source export -> ${arch.rc}`);
		identity = { headSha: sha, headTree: treeSha, tarballSha256: createHash("sha256").update(readFileSync(tarball)).digest("hex"), provenance: "git-archive" };
	}
	console.log(`ABSIMPORT1 source identity: ${JSON.stringify(identity)}`);
	cachedExport = { srcExport, identity };
	return cachedExport;
}

test("ABSIMPORT1 no tracked companion file imports an absolute path", async () => {
	const { srcExport } = await exactSource();
	const hits: string[] = [];
	for (const root of SCAN_ROOTS) {
		for (const file of tsFiles(join(srcExport, root))) {
			const lines = readFileSync(file, "utf8").split("\n");
			lines.forEach((line, i) => {
				if (ABS_SPEC.some(re => re.test(line))) hits.push(`${file}:${i + 1}: ${line.trim().slice(0, 160)}`);
			});
		}
	}
	expect(hits).toEqual([]);
});

test("ABSIMPORT1 production entrypoints bundle in an exact export with empty HOME", async () => {
	const { srcExport, identity } = await exactSource();
	const entries = ["src/cli.ts", ...readdirSync(join(srcExport, "extensions")).filter(f => f.endsWith(".ts") && !f.endsWith(".test.ts")).map(f => `extensions/${f}`)];
	expect(entries.length).toBeGreaterThan(10);
	const emptyHome = join(srcExport, "..", "empty-home");
	mkdirSync(emptyHome, { recursive: true });
	const outDir = join(srcExport, "..", "bundles");
	mkdirSync(outDir, { recursive: true });
	const env = { ...process.env, HOME: emptyHome, TMPDIR: join(srcExport, "..", "tmp") } as Record<string, string>;
	mkdirSync(env.TMPDIR, { recursive: true });
	const pkgVer = (JSON.parse(readFileSync(join(srcExport, "package.json"), "utf8")) as { version: string }).version;
	console.log(`ABSIMPORT1 digest record: ${JSON.stringify({ ...identity, pkgVer, entries: entries.length })}`);
	for (const entry of entries) {
		const built = await run(["bun", "build", "--target", "bun", "--outdir", join(outDir, entry.replaceAll("/", "_")), join(srcExport, entry)], { cwd: srcExport, deadline_s: 300, env });
		if (built.rc !== 0) throw new Error(`bun build ${entry} -> ${built.rc}: ${utf8(built.stderr).slice(0, 500)}`);
	}
}, 600_000);
