import { expect, test } from "bun:test";
import { mkdirSync, readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { run } from "../../src/kitlib/run.ts";
import { ownedTmp } from "../../src/kitlib/tmp.ts";

const REPO_ROOT = resolve(import.meta.dir, "../..");
const SCAN_ROOTS = ["src", "extensions", "scripts"];
/** Static import/export with an absolute specifier: `from "/..."`, `import "..."`, `import("/...")`. Word-boundary anchored so identifiers like fromRel/fromDir do not match. Line-based, like the rg gate. */
const ABS_SPEC = [/\bfrom\s+['"]\//, /\bimport\s+['"]\//, /\bimport\s*\(\s*['"]\//];

function tsFiles(dir: string): string[] {
	const out: string[] = [];
	for (const entry of readdirSync(dir, { withFileTypes: true })) {
		const p = join(dir, entry.name);
		if (entry.isDirectory()) out.push(...tsFiles(p));
		else if (entry.isFile() && p.endsWith(".ts")) out.push(p);
	}
	return out;
}

test("ABSIMPORT1 no tracked companion file imports an absolute path", () => {
	const hits: string[] = [];
	for (const root of SCAN_ROOTS) {
		for (const file of tsFiles(join(REPO_ROOT, root))) {
			const lines = readFileSync(file, "utf8").split("\n");
			lines.forEach((line, i) => {
				if (ABS_SPEC.some(re => re.test(line))) hits.push(`${file}:${i + 1}: ${line.trim().slice(0, 160)}`);
			});
		}
	}
	expect(hits).toEqual([]);
});

test("ABSIMPORT1 production entrypoints bundle in an exact export with empty HOME", async () => {
	const head = await run(["git", "-C", REPO_ROOT, "rev-parse", "HEAD"], { cwd: REPO_ROOT, deadline_s: 60 });
	if (head.rc !== 0) throw new Error("no HEAD; unmet prerequisite: exact committed source");
	const sha = new TextDecoder().decode(head.stdout).trim();
	const top = await run(["git", "-C", REPO_ROOT, "rev-parse", "--show-toplevel"], { cwd: REPO_ROOT, deadline_s: 60 });
	if (top.rc !== 0 || resolve(new TextDecoder().decode(top.stdout).trim()) !== resolve(REPO_ROOT)) throw new Error(`source identity not exact: ${REPO_ROOT} is not a repo top-level; refusing ancestor discovery`);
	const g = process.env.GRADE_WAVE_SCRATCH || undefined;
	const root = ownedTmp("absexport", g === undefined ? {} : { root: g }).path;
	const srcExport = join(root, "export");
	mkdirSync(srcExport, { recursive: true });
	const archived = await run(["sh", "-c", `git -C ${JSON.stringify(REPO_ROOT)} archive ${JSON.stringify(sha)} | tar -x -C ${JSON.stringify(srcExport)}`], { cwd: root, deadline_s: 300 });
	if (archived.rc !== 0) throw new Error(`exact source export -> ${archived.rc}`);
	const entries = ["src/cli.ts", ...readdirSync(join(srcExport, "extensions")).filter(f => f.endsWith(".ts") && !f.endsWith(".test.ts")).map(f => `extensions/${f}`)];
	expect(entries.length).toBeGreaterThan(10);
	const emptyHome = join(root, "empty-home");
	mkdirSync(emptyHome, { recursive: true });
	const outDir = join(root, "bundles");
	mkdirSync(outDir, { recursive: true });
	const env = { ...process.env, HOME: emptyHome, TMPDIR: join(root, "tmp") } as Record<string, string>;
	mkdirSync(env.TMPDIR, { recursive: true });
	for (const entry of entries) {
		const built = await run(["bun", "build", "--target", "bun", "--outdir", join(outDir, entry.replaceAll("/", "_")), join(srcExport, entry)], { cwd: srcExport, deadline_s: 300, env });
		if (built.rc !== 0) throw new Error(`bun build ${entry} -> ${built.rc}: ${new TextDecoder().decode(built.stderr).slice(0, 500)}`);
	}
}, 600_000);
