import { afterEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { check } from "../../src/fleet-guard/durability.ts";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

function fixture() {
	const base = join(import.meta.dir, "../../var/agent-tmp");
	mkdirSync(base, { recursive: true });
	const repo = mkdtempSync(join(base, "durability-facts-"));
	roots.push(repo);
	const env = { ...process.env };
	for (const key of Object.keys(env)) if (key.startsWith("GIT_")) delete env[key];
	Object.assign(env, { GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null", GIT_TERMINAL_PROMPT: "0" });
	const git = (args: string[], input?: string) => {
		const result = Bun.spawnSync(["git", "-C", repo, ...args], { env, stdout: "pipe", stderr: "pipe", timeout: 2_000,
			...(input === undefined ? {} : { stdin: Buffer.from(input) }) });
		if (result.exitCode !== 0) throw new Error(result.stderr.toString());
		return result.stdout.toString().trim();
	};
	git(["init", "--quiet"]);
	const scratch = join(repo, "var", "agent-tmp", `facts.${process.pid}`);
	mkdirSync(scratch, { recursive: true });
	const owner = join(scratch, ".owner");
	writeFileSync(owner, `pid=${process.pid}\nlabel=facts\nrepo=${repo}\ncreated=${new Date().toISOString()}\n`);
	const index = (path: string, content: string) => {
		const hash = git(["hash-object", "-w", "--stdin"], content);
		git(["update-index", "--add", "--cacheinfo", `100644,${hash},${path}`]);
	};
	return { repo, scratch, owner, index, git, context: { cwd: repo } };
}

test("index-only source content blocks even a differently named scratch target without cached allows", async () => {
	const f = fixture();
	const event = { toolName: "write", input: { path: join(f.scratch, "generated.ts"), content: "export const sample = 41;\n" } };
	expect(await check(event, f.context)).toBeUndefined();
	f.index("src/canonical.ts", event.input.content);
	expect((await check(event, f.context))?.reason).toContain("tracked-source-copy content");
});

test("canonical path evidence blocks a modified copy even without matching blob content", async () => {
	const f = fixture();
	f.index("src/canonical.ts", "export const sample = 41;\n");
	for (const suffix of ["src/canonical.ts", "shadow/src/canonical.ts"])
		expect((await check({ toolName: "write", input: { path: join(f.scratch, suffix), content: "export const sample = 42;\n" } }, f.context))?.reason).toContain("tracked-source-copy path");
});

test("a renamed copy of modified tracked source is still source, not synthetic input", async () => {
	const f = fixture();
	mkdirSync(join(f.repo, "src"), { recursive: true });
	const source = join(f.repo, "src", "canonical.ts");
	writeFileSync(source, "export const sample = 1;\n");
	f.index("src/canonical.ts", "export const sample = 1;\n");
	const modified = "export const sample = 2;\n";
	writeFileSync(source, modified);
	expect((await check({ toolName: "write", input: { path: join(f.scratch, "renamed.ts"), content: modified } }, f.context))?.reason).toContain("tracked-source-copy");
});

test("canonical edits do not become scratch copies because the reference repository has a scratch ancestor", async () => {
	const f = fixture();
	expect(await check({ toolName: "write", input: { path: join(f.repo, "new-source.ts"), content: "export const value = 1;\n" } }, f.context)).toBeUndefined();
});

test("a destination's nested Git repository and event cwd cannot replace the native caller's reference", async () => {
	const f = fixture();
	f.index("src/canonical.ts", "export const original = 1;\n");
	const shadow = join(f.scratch, "shadow");
	mkdirSync(shadow, { recursive: true });
	f.git(["-C", shadow, "init", "--quiet"]);
	expect((await check({ toolName: "write", cwd: shadow, input: { path: join(shadow, "src/canonical.ts"), content: "export const modified = 2;\n" } }, f.context))?.reason).toContain("tracked-source-copy path");
});

test("a scratch symlink cannot turn a canonical-source write into an owned scratch write", async () => {
	const f = fixture();
	const destination = join(f.repo, "canonical");
	mkdirSync(destination);
	symlinkSync(destination, join(f.scratch, "alias"));
	expect((await check({ toolName: "write", input: { path: join(f.scratch, "alias", "source.ts"), content: "export const value = 1;\n" } }, f.context))?.reason).toContain("escapes");
});

test("local URI uses actual backing root, and logical handler routes are not filesystem paths", async () => {
	const f = fixture();
	const event = { toolName: "write", input: { path: "local://sample.ts", content: "export const sample = 1;\n" } };
	expect(await check(event, { ...f.context, localRoot: f.scratch })).toBeUndefined();
	f.index("src/canonical.ts", event.input.content);
	expect((await check(event, { ...f.context, localRoot: f.scratch }))?.block).toBe(true);
	expect((await check(event, f.context))?.block).toBe(true);
	expect(await check({ toolName: "write", input: { path: "agent://Worker", content: event.input.content } }, f.context)).toBeUndefined();
});

test("missing, malformed, or redirected ownership facts never admit scratch", async () => {
	const f = fixture();
	const event = { toolName: "write", input: { path: join(f.scratch, "sample.json"), content: "{\"sample\":1}" } };
	writeFileSync(f.owner, "pid=1\nlabel=facts\nrepo=/unavailable\ncreated=invalid\n");
	expect((await check(event, f.context))?.block).toBe(true);
	rmSync(f.owner);
	expect((await check(event, f.context))?.block).toBe(true);
	const alternate = join(f.repo, "owner-data");
	writeFileSync(alternate, `pid=1\nlabel=facts\nrepo=${f.repo}\ncreated=2026-10-17T00:00:00Z\n`);
	symlinkSync(alternate, f.owner);
	expect((await check(event, f.context))?.block).toBe(true);
});

test("replacement edit evaluates resulting bytes, while native structural edits refuse unknown content", async () => {
	const f = fixture();
	const path = join(f.scratch, "sample.ts");
	writeFileSync(path, "export const sample = 1;\n");
	const edit = { toolName: "edit", input: { path, oldText: "1", newText: "2" } };
	expect(await check(edit, f.context)).toBeUndefined();
	f.index("src/original.ts", "export const sample = 2;\n");
	expect((await check(edit, f.context))?.block).toBe(true);
	expect((await check({ toolName: "edit", input: `*** Begin Patch\n[${path}#ABCD]\nPUT 1.=1:\n+export const sample = 3;\n*** End Patch` }, f.context))?.reason).toContain("payload variant");
});

test("native hashline move destinations retain canonical source refusal, including quoted paths", async () => {
	const f = fixture();
	f.index("src/canonical.ts", "export const sample = 1;\n");
	const move = (destination: string) => ({
		toolName: "edit",
		input: { input: `*** Begin Patch\n[src/canonical.ts#ABCD]\nMV ${JSON.stringify(destination)}\n*** End Patch` },
	});
	expect(await check(move("src/renamed.ts"), f.context)).toBeUndefined();
	const target = join(f.scratch, "src", "canonical.ts");
	expect((await check(move(target), f.context))?.reason).toContain("tracked-source-copy path");
	expect((await check(move(join(f.scratch, "renamed source.ts")), f.context))?.reason).toContain("content cannot be established");
});

test("clean CRLF materialization is canonical source even when index bytes differ", async () => {
	const f = fixture();
	f.git(["config", "core.autocrlf", "true"]);
	const indexed = "export const sample = 1;\n";
	const materialized = "export const sample = 1;\r\n";
	f.index("src/canonical.ts", indexed);
	mkdirSync(join(f.repo, "src"));
	writeFileSync(join(f.repo, "src", "canonical.ts"), materialized);
	expect(f.git(["ls-files", "--modified"])).toBe("");
	const input = { path: join(f.scratch, "renamed.ts"), content: materialized };
	expect((await check({ toolName: "write", input }, f.context))?.reason).toContain("materialized canonical source");
	expect(await check({ toolName: "write", input: { ...input, content: materialized.replace("1", "2") } }, f.context)).toBeUndefined();
});

test("scripts and instruction artifacts refuse independently of index matches", async () => {
	const f = fixture();
	for (const [path, content] of [["run.sh", "echo hi"], ["GRADER-PROMPT.md", "instructions"], ["packet/job.json", "{}"], ["sample", "#!/bin/sh\necho hi"]]) {
		expect((await check({ toolName: "write", input: { path: join(f.scratch, path!), content } }, f.context))?.block).toBe(true);
	}
});

test("ordinary Markdown report data is not classified as an instruction by its extension", async () => {
	const f = fixture();
	expect(await check({ toolName: "write", input: { path: join(f.scratch, "report.md"), content: "packet: PACKET-D0-R4.md" } }, f.context)).toBeUndefined();
});
