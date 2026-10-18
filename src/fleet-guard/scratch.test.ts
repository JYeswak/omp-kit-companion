import { afterEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { check, gitBlanketArgs, hostAgentName, shellTokens, shellWriteTargets, scratchDirFor, writeScratchOwner, applyScratchEnv } from "./scratch.ts";

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

test("logical write routes do not inherit a forbidden filesystem cwd", () => {
	for (const cwd of ["/tmp", "/private/tmp"]) {
		for (const toolName of ["write", "edit"]) {
			for (const path of ["proc://owned-job/kill", "agent://coordinator", "xd://report_issue", "PROC://OwnedJob/kill"]) {
				for (const input of [{ path }, { file: path }, { paths: [path] }])
					expect(check({ toolName, input }, ctx(cwd))).toBeUndefined();
			}
		}
	}
});

test("a logical route never exempts another filesystem target or a shell filename", () => {
	for (const input of [
		{ path: "proc://owned-job/kill", file: "/tmp/out" },
		{ paths: ["agent://coordinator", "/private/tmp/out", "xd://report_issue"] },
		{ path: "/tmp/proc://owned-job/kill" },
		{ path: "./proc://owned-job/kill" },
		{ path: "proc:/owned-job/kill" },
		{ path: "%70roc://owned-job/kill" },
		{ path: "unknown://owned-job/kill" },
	])
		expect(check({ toolName: "write", input }, ctx("/private/tmp"))?.reason).toContain("scratch-write");
	expect(check({ toolName: "bash", command: "echo x > proc://owned-job/kill" }, ctx("/tmp"))?.block).toBe(true);
});

test("filesystem URIs are decoded before forbidden-root classification", () => {
	const dir = home();
	const context = { cwd: join(dir, "repo"), localRoot: "/private/tmp/session/local" };
	for (const path of [
		"file:///tmp/out", "file:///private/%74mp/out", "file:///repo/%2e%2e/tmp/out",
		"ssh://host/tmp/out", "ssh://host/private/%74mp/out", "ssh://host/repo/%2e%2e/tmp/out",
		"local://out", "local:/out", "local:///out", "/repo/local://out",
	])
		expect(check({ toolName: "write", input: { path } }, context)?.reason).toContain("scratch-write");
	expect(check({ toolName: "write", input: { path: `file://${dir}/repo/out` } }, context)).toBeUndefined();
	expect(check({ toolName: "write", input: { path: "ssh://host/srv/project/out" } }, context)).toBeUndefined();
});

test("local URI paths use the caller root, not cwd, and reject traversal before normalization", () => {
	const dir = home();
	const context = { cwd: "/tmp", localRoot: join(dir, "repo", "local") };
	for (const path of ["local://notes/out", "local:/notes/out", "local:///notes/out", "local://a%3Ab/out", "local://percent%2520/out"])
		expect(check({ toolName: "write", input: { path } }, context)).toBeUndefined();
	for (const path of ["local://%2e%2e/out", "local://notes/%2e%2e/out", "local://%2ftmp/out", "local://notes/%5c..%5cout"])
		expect(check({ toolName: "write", input: { path } }, context)?.block).toBe(true);
	expect(check({ toolName: "write", input: { path: "local://out" } }, ctx(join(dir, "repo")))?.reason).toContain("backing root");
});

test("malformed filesystem URIs and invalid paths fail closed", () => {
	const dir = home();
	for (const path of [
		"file:///tmp/%ZZ", "file://remote/tmp/out", "file:///tmp/%2Fout",
		"ssh://host:bad/srv/out", "ssh://%ZZ/srv/out", "ssh://host/srv/%ZZ",
		"ssh://host/srv/out?query=1", "ssh://host/srv/out#fragment",
		"local://%ZZ", "local://notes/%00out", "file:///srv/%00out", "/srv/\0out",
	])
		expect(check({ toolName: "write", input: { path } }, { cwd: join(dir, "repo"), localRoot: join(dir, "local") })?.block).toBe(true);
});

test("long URI near misses remain bounded at the real scratch caller", () => {
	const started = performance.now();
	for (const path of [`ssh://${"a".repeat(60_000)}!`, `local://${"a".repeat(60_000)}%`, "a".repeat(65_537)]) {
		expect(check({ toolName: "write", input: { path } }, ctx("/tmp"))?.block).toBe(true);
	}
	expect(performance.now() - started).toBeLessThan(1000);
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

test("native Bash input objects retain redirection and compound blanket-staging refusals", () => {
	const dir = join(home(), "work");
	// Admission only: these strings are never executed and create no system-temp files.
	expect(check({ toolName: "bash", input: { command: "printf prohibited > /tmp/native-never-write.txt" } }, ctx(dir))?.reason).toContain("scratch-write");
	expect(check({ toolName: "bash", input: { command: "printf stock > owned.txt && git add -A" } }, ctx(dir))?.reason).toContain("blanket-git");
	expect(check({ toolName: "bash", input: { command: "printf stock > owned.txt; env -i git commit -a -m x" } }, ctx(dir))?.reason).toContain("blanket-git");
	for (const command of ["(git add -A)", "( (git add --all) )", "true && (git commit -a -m x)"])
		expect(check({ toolName: "bash", input: { command } }, ctx(dir))?.reason).toContain("blanket-git");
	for (const command of ["printf '%s' '(git add -A)'", "printf '%s' \\(git add -A\\)", "printf '%s' 'x; git add -A'",
		"cat <<'EOF'\n(git add -A)\nEOF", "printf '%s' '(git add -A) trailing junk'"])
		expect(check({ toolName: "bash", input: { command } }, ctx(dir))).toBeUndefined();
	expect(check({ toolName: "bash", input: { command: "printf '%s' 'git add -A'" } }, ctx(dir))).toBeUndefined();
	expect(check({ toolName: "bash", input: { command: "printf done && git add exact.txt" } }, ctx(dir))).toBeUndefined();
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
	// Session TMPDIR may itself be repo scratch; use an unwritten nonrepo path.
	const plainBase = "/nonexistent/ompkit-fleet-plain";
	expect(scratchDirFor(plainBase, 7)).toBe(join(plainBase, "var", "agent-tmp", "omp.7"));
});

test("OWNERKEY1: a seat owner carries agent and session together, and only when both are well formed", () => {
	const repo = mkdtempSync(join(import.meta.dir, "../../var/agent-tmp", "fleet-seat-owner-"));
	roots.push(repo);
	const dir = join(repo, "var", "agent-tmp", "omp.4242");
	const base = { pid: 4242, label: "omp", repo, created: "2026-10-02T00:00:00.000Z" };
	const session = "01a15012-af9e-7628-bee6-496084668412";
	writeScratchOwner(dir, { ...base, agent: "TurquoiseSummit", session });
	expect(readFileSync(join(dir, ".owner"), "utf8")).toBe(`pid=4242\nlabel=omp\nrepo=${repo}\ncreated=2026-10-02T00:00:00.000Z\nagent=TurquoiseSummit\nsession=${session}\n`);
	for (const partial of [{ agent: "TurquoiseSummit" }, { session }, { agent: "../evil", session }, { agent: "TurquoiseSummit", session: "short" }]) {
		writeScratchOwner(dir, { ...base, ...partial });
		expect(readFileSync(join(dir, ".owner"), "utf8")).toBe(`pid=4242\nlabel=omp\nrepo=${repo}\ncreated=2026-10-02T00:00:00.000Z\n`);
	}
});

test("OWNERKEY1: the host agent name is AGENT_NAME, else BR_ACTOR, else BR_AGENT_NAME, and never an unsafe value", () => {
	expect(hostAgentName({ AGENT_NAME: "A", BR_ACTOR: "B", BR_AGENT_NAME: "C" })).toBe("A");
	expect(hostAgentName({ BR_ACTOR: " B ", BR_AGENT_NAME: "C" })).toBe("B");
	expect(hostAgentName({ BR_AGENT_NAME: "C" })).toBe("C");
	expect(hostAgentName({ AGENT_NAME: "../x", BR_ACTOR: "ok" })).toBe("ok");
	expect(hostAgentName({})).toBeUndefined();
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
