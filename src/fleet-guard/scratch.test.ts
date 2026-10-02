import { afterEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { check, gitBlanketArgs, shellTokens, shellWriteTargets, scratchDirFor, writeScratchOwner, applyScratchEnv } from "./scratch.ts";

const roots: string[] = [];
afterEach(() => {
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

const savedHome = process.env.HOME;
const savedTmp = { TMPDIR: process.env.TMPDIR, TMP: process.env.TMP, TEMP: process.env.TEMP };
afterEach(() => {
	if (savedHome === undefined) delete process.env.HOME;
	else process.env.HOME = savedHome;
	for (const [key, value] of Object.entries(savedTmp) as ["TMPDIR" | "TMP" | "TEMP", string | undefined][]) {
		if (value === undefined) delete process.env[key];
		else process.env[key] = value;
	}
});

function home(): string {
	const dir = mkdtempSync(join(import.meta.dir, "../../var/agent-tmp", "fleet-home-"));
	roots.push(dir);
	process.env.HOME = dir;
	return dir;
}

function ctx(cwd: string) {
	return { cwd };
}

test("write tool to tmp roots is blocked and names the rule", () => {
	const dir = home();
	for (const target of ["/tmp/x", "/private/tmp/x", "/var/tmp/x", "/private/var/folders/a/b"]) {
		const blocked = check({ toolName: "write", input: { path: target } }, ctx(dir));
		expect(blocked?.block).toBe(true);
		expect(blocked?.reason).toContain("fleet-guard scratch-write");
		expect(blocked?.reason).toContain("AGENTS.md");
	}
});

test("reads stay allowed and repo scratch stays writable", () => {
	const dir = home();
	expect(check({ toolName: "read", input: { path: "/tmp/x" } }, ctx(dir))).toBeUndefined();
	expect(check({ toolName: "write", input: { path: join(dir, "var", "agent-tmp", "w.1", "out.txt") } }, ctx(dir))).toBeUndefined();
	expect(check({ toolName: "write", input: { path: join(dir, "proj", "file.txt") } }, ctx(dir))).toBeUndefined();
	expect(check({ toolName: "grep", input: { path: "/tmp/x" } }, ctx(dir))).toBeUndefined();
	expect(check({ toolName: "unknown-tool", input: { path: "/tmp/x" } }, ctx(dir))).toBeUndefined();
});

test("writes directly under HOME root are blocked, nested writes allowed", () => {
	const dir = home();
	expect(check({ toolName: "write", input: { path: join(dir, "notes.md") } }, ctx(dir))?.block).toBe(true);
	expect(check({ toolName: "edit", input: { path: join(dir, "sub", "notes.md") } }, ctx(dir))).toBeUndefined();
	expect(check({ toolName: "edit", input: { paths: [join(dir, "ok.md"), "/tmp/bad"] } }, ctx(dir))?.block).toBe(true);
});

test("bash redirects and sink operands to tmp are blocked", () => {
	const dir = home();
	expect(check({ toolName: "bash", command: "echo hi > /tmp/x" }, ctx(dir))?.block).toBe(true);
	expect(check({ toolName: "bash", command: "echo hi >> /private/var/folders/z" }, ctx(dir))?.block).toBe(true);
	expect(check({ toolName: "bash", command: "cat /tmp/x" }, ctx(dir))).toBeUndefined();
	expect(check({ toolName: "bash", command: "echo 'never write to /tmp/old'" }, ctx(dir))).toBeUndefined();
	expect(check({ toolName: "bash", command: "echo ok | tee /tmp/a" }, ctx(dir))?.block).toBe(true);
	expect(check({ toolName: "bash", command: "cp a /tmp/b" }, ctx(dir))?.block).toBe(true);
	expect(check({ toolName: "bash", command: "cp /tmp/a b" }, ctx(join(dir, "work")))).toBeUndefined();
	expect(check({ toolName: "bash", command: "cp /tmp/a b" }, ctx(dir))?.block).toBe(true);
	expect(check({ toolName: "bash", command: "mv a /tmp/b" }, ctx(dir))?.block).toBe(true);
	expect(check({ toolName: "bash", command: "mkdir -p /tmp/d" }, ctx(dir))?.block).toBe(true);
	expect(check({ toolName: "bash", command: "mkdir -p sub/dir" }, ctx(dir))).toBeUndefined();
	expect(check({ toolName: "bash", command: "echo ok; echo hi > /tmp/x" }, ctx(dir))?.block).toBe(true);
	expect(check({ toolName: "bash", command: "cp -t /tmp/d f1 f2" }, ctx(dir))?.block).toBe(true);
});

test("shellWriteTargets covers every sink in a compound command", () => {
	expect(shellWriteTargets("echo ok; echo hi > /tmp/x")).toEqual(["/tmp/x"]);
	expect(shellWriteTargets("tee a b | cat")).toEqual(["a", "b"]);
	expect(shellWriteTargets("cp -t /tmp/d f1")).toEqual(["/tmp/d"]);
	expect(shellWriteTargets("echo x > a > b")).toEqual(["a", "b"]);
	expect(shellTokens("echo 'a > b'")[1]).toMatchObject({ text: "a > b", quoted: true });
});

test("blanket git staging is blocked, normal git flows", () => {
	expect(gitBlanketArgs(["git", "add", "-A"])).toBe(true);
	expect(gitBlanketArgs(["git", "add", "--all"])).toBe(true);
	expect(gitBlanketArgs(["git", "add", "."])).toBe(true);
	expect(gitBlanketArgs(["git", "-C", "dir", "add", "-A"])).toBe(true);
	expect(gitBlanketArgs(["git", "commit", "-a", "-m", "x"])).toBe(true);
	expect(gitBlanketArgs(["git", "commit", "--all"])).toBe(true);
	expect(gitBlanketArgs(["git", "switch", "main"])).toBe(false);
	expect(gitBlanketArgs(["git", "add", "file"])).toBe(false);
	expect(gitBlanketArgs(["git", "commit", "-m", "x"])).toBe(false);
	expect(gitBlanketArgs(["git", "status"])).toBe(false);
	expect(gitBlanketArgs(["hg", "add", "-A"])).toBe(false);
});

test("check routes bash git blankets to the shared-tree rule", () => {
	const dir = home();
	const blocked = check({ toolName: "bash", command: "git add -A" }, ctx(dir));
	expect(blocked?.block).toBe(true);
	expect(blocked?.reason).toContain("fleet-guard blanket-git");
	expect(check({ toolName: "bash", command: "git switch main" }, ctx(dir))).toBeUndefined();
	expect(check({ toolName: "bash", command: "git add file.txt" }, ctx(dir))).toBeUndefined();
});

test("session scratch dir matches the S2 owner-name contract", () => {
	const repo = mkdtempSync(join(import.meta.dir, "../../var/agent-tmp", "fleet-repo-"));
	roots.push(repo);
	mkdirSync(join(repo, ".git"), { recursive: true });
	const dir = scratchDirFor(join(repo, "sub"), 4242);
	expect(dir).toBe(join(repo, "var", "agent-tmp", "omp.4242"));
	writeScratchOwner(dir, { pid: 4242, label: "omp", repo, created: "2026-10-02T00:00:00.000Z" });
	expect(readFileSync(join(dir, ".owner"), "utf8")).toBe("pid=4242\nlabel=omp\nrepo=" + repo + "\ncreated=2026-10-02T00:00:00.000Z\n");
	const plainBase = mkdtempSync(join(realpathSync(tmpdir()), "fleet-plain-"));
	roots.push(plainBase);
	expect(scratchDirFor(plainBase, 7)).toBe(join(plainBase, "var", "agent-tmp", "omp.7"));
});

test("applyScratchEnv points child tools at the session dir", () => {
	applyScratchEnv("/tmp/should-not-persist");
	expect(process.env.TMPDIR).toBe("/tmp/should-not-persist");
	expect(process.env.TMP).toBe("/tmp/should-not-persist");
	expect(process.env.TEMP).toBe("/tmp/should-not-persist");
});

test("five hundred checks settle well inside budget without I/O", () => {
	const dir = home();
	const event = { toolName: "write", input: { path: join(dir, "ok.txt") } };
	const started = Date.now();
	for (let i = 0; i < 500; i++) check(event, ctx(dir));
	expect(Date.now() - started).toBeLessThan(5000);
});
