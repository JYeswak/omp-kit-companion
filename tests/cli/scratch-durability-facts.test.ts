import { afterAll, afterEach, expect, test } from "bun:test";
import { mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { check } from "../../src/fleet-guard/durability.ts";
import { resolveOmpIdentity } from "../../src/paths.ts";
import { handleToolCall } from "../../extensions/fleet-guard.ts";
import { cleanupAllOwnedTmp, ownedTmp } from "../../src/kitlib/tmp.ts";
afterAll(cleanupAllOwnedTmp);

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

function fixture() {
	const base = join(import.meta.dir, "../../var/agent-tmp");
	mkdirSync(base, { recursive: true });
	const repo = ownedTmp("durability-facts", { root: base }).path;
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

test("DONEGUARD1: empty queue sentinels are not copies of indexed empty files", async () => {
	const f = fixture();
	f.index("src/__init__.py", "");
	const path = join(f.scratch, "omp-workers", "queue", "worker", "DONE");
	expect(await handleToolCall({ toolName: "write", input: { path, content: "" } }, f.context)).toBeUndefined();
	// A sentinel name is not a bypass for real source bytes.
	const source = "export const canonical = 1;\n";
	f.index("src/canonical.ts", source);
	expect((await handleToolCall({ toolName: "write", input: { path, content: source } }, f.context))?.reason)
		.toContain("tracked-source-copy content");
	expect((await handleToolCall({ toolName: "write", input: { path } }, f.context))?.reason)
		.toContain("content cannot be established");
});

test("DONEGUARD1: materialized empty files do not turn empty writes into source copies", async () => {
	const f = fixture();
	const source = "export const canonical = 1;\n";
	f.index("canonical.ts", source);
	writeFileSync(join(f.repo, "canonical.ts"), "");
	const path = join(f.scratch, "queue", "complete");
	expect(await handleToolCall({ toolName: "write", input: { path, content: "" } }, f.context)).toBeUndefined();
	// Path identity still proves a copy even when the payload is empty.
	expect((await handleToolCall({ toolName: "write", input: { path: join(f.scratch, "canonical.ts"), content: "" } }, f.context))?.reason)
		.toContain("tracked-source-copy path");
	writeFileSync(join(f.repo, "canonical.ts"), "modified canonical source\n");
	expect((await handleToolCall({ toolName: "write", input: { path, content: "modified canonical source\n" } }, f.context))?.reason)
		.toContain("materialized canonical source");
});
test("SCRATCHFP1: nested synthetic src fixture stays quiet while byte-equal shadow copy fires", async () => {
	const f = fixture();
	const syntheticPath = join(f.scratch, "crates", "uds", "src", "var", "fixture.fixture");
	expect(await check({ toolName: "write", input: { path: syntheticPath, content: "synthetic fixture bytes\n" } }, f.context)).toBeUndefined();
	const source = "export const canonicalValue = 42;\n";
	f.index("src/canonical.ts", source);
	const shadowPath = join(f.scratch, "src_copy", "renamed.ts");
	expect((await check({ toolName: "write", input: { path: shadowPath, content: source } }, f.context))?.reason).toContain("tracked-source-copy");
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
	// SCRATCHNEW1: a hand-made dir still blocks, now naming the command that makes an owned one, never UNKNOWN.
	const missing = await check(event, f.context);
	expect(missing?.block).toBe(true);
	expect(missing?.status).toBeUndefined();
	expect(missing?.reason).toContain("was not created by `omp-kit scratch new` (it has no .owner). Run `omp-kit scratch new --label");
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

test("PAYLOADSIM1 a hashline edit is judged on its resulting bytes: a notes edit passes, a source copy or a new shebang is refused", async () => {
	const f = fixture();
	const path = join(f.scratch, "notes.md");
	writeFileSync(path, "draft one\ndraft two\n");
	// The tag a reader of the current bytes holds, from OMP's own engine (runtime-selected native module).
	const native = await import(pathToFileURL(join(resolveOmpIdentity().nativeRoot!, "native", "index.js")).href);
	const tag = (): string => new native.EditStore().recordSnapshotFile(path);
	const edit = (body: string) => ({ toolName: "edit", input: `*** Begin Patch\n[${path}#${tag()}]\n${body}\n*** End Patch` });
	expect(await check(edit("PUT 2.=2:\n+draft TWO"), f.context)).toBeUndefined();
	f.index("src/original.ts", "draft one\nexport const sample = 2;\n");
	expect((await check(edit("PUT 2.=2:\n+export const sample = 2;"), f.context))?.reason).toContain("tracked-source-copy content");
	expect((await check(edit("PUT <1:\n+#!/bin/sh"), f.context))?.reason).toContain("rerunnable script");
	// The file on disk is never written by the judgment.
	expect(readFileSync(path, "utf8")).toBe("draft one\ndraft two\n");
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
