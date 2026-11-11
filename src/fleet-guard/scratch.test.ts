import { afterEach, expect, test } from "bun:test";
import { linkSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { ownedTmp, type OwnedTmp } from "../kitlib/tmp.ts";
import { runFixture } from "../../tests/cli/fixture-process.ts";
import { fleetPolicyState } from "../../extensions/fleet-policy.ts";
import { adoptOwnerlessDir, autoCompletedLine, check, checkSystemTemp, createdScratchTops, gitBlanketArgs, hostAgentName, parseSessionTmpLiteral, rewriteShellCommand, rewriteToolInput, shellTokenSpans, shellTokens, shellWordSpans, shellWriteBases, shellWriteTargets, scratchDirFor, writeScratchOwner, applyScratchEnv } from "./scratch.ts";

const agentTmp = join(import.meta.dir, "../../var/agent-tmp");
mkdirSync(agentTmp, { recursive: true });
const owned: OwnedTmp[] = [];
afterEach(() => {
	for (const t of owned.splice(0)) t.cleanup();
});

function ownedRoot(label: string): string {
	const t = ownedTmp(label, { root: agentTmp });
	owned.push(t);
	return t.path;
}

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
	const dir = ownedRoot("fleet-home");
	process.env.HOME = dir;
	return dir;
}

function ctx(cwd: string) {
	return { cwd };
}

test("write tool to tmp roots is blocked and names the rule", () => {
	const dir = home();
	for (const target of ["/tmp/x", "/private/tmp/x", "/var/tmp/x", "/private/var/folders/a/b"]) { // tempsafe: fake guard input path, never touched on disk
		const blocked = check({ toolName: "write", input: { path: target } }, ctx(dir));
		expect(blocked?.block).toBe(true);
		expect(blocked?.reason).toContain("fleet-guard scratch-write");
	}
});

test("reads stay allowed and repo scratch stays writable", () => {
	const dir = home();
	expect(check({ toolName: "read", input: { path: "/tmp/x" } }, ctx(dir))).toBeUndefined(); // tempsafe: fake guard input path, never touched on disk
	expect(check({ toolName: "write", input: { path: join(dir, "var", "agent-tmp", "w.1", "out.txt") } }, ctx(dir))).toBeUndefined();
	expect(check({ toolName: "write", input: { path: join(dir, "proj", "file.txt") } }, ctx(dir))).toBeUndefined();
	expect(check({ toolName: "grep", input: { path: "/tmp/x" } }, ctx(dir))).toBeUndefined(); // tempsafe: fake guard input path, never touched on disk
	expect(check({ toolName: "unknown-tool", input: { path: "/tmp/x" } }, ctx(dir))).toBeUndefined(); // tempsafe: fake guard input path, never touched on disk
});

test("writes directly under HOME root are blocked, nested writes allowed", () => {
	const dir = home();
	expect(check({ toolName: "write", input: { path: join(dir, "notes.md") } }, ctx(dir))?.block).toBe(true);
	expect(check({ toolName: "edit", input: { path: join(dir, "sub", "notes.md") } }, ctx(dir))).toBeUndefined();
	expect(check({ toolName: "edit", input: { paths: [join(dir, "ok.md"), "/tmp/bad"] } }, ctx(dir))?.block).toBe(true); // tempsafe: fake guard input path, never touched on disk
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
		{ path: "proc://owned-job/kill", file: "/tmp/out" }, // tempsafe: fake guard input path, never touched on disk
		{ paths: ["agent://coordinator", "/private/tmp/out", "xd://report_issue"] },
		{ path: "/tmp/proc://owned-job/kill" }, // tempsafe: fake guard input path, never touched on disk
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
	// cwd is HOME: a cwd-based resolution of local://out would be HOME/out, refused as a HOME-root write, so the
	// admission proves the caller root was used wherever the test tree lives (the commit gate exports under $TMPDIR).
	const context = { cwd: dir, localRoot: join(dir, "repo", "local") };
	for (const path of ["local://out", "local:/out", "local:///out", "local://notes/out", "local://a%3Ab/out", "local://percent%2520/out"])
		expect(check({ toolName: "write", input: { path } }, context)).toBeUndefined();
	expect(check({ toolName: "write", input: { path: join(dir, "out") } }, context)?.reason).toContain("$HOME");
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
	expect(shellWriteTargets("echo ok; echo hi > /tmp/x")).toEqual(["/tmp/x"]); // tempsafe: parsed command text only, nothing executed
	expect(shellWriteTargets("tee a b | cat")).toEqual(["a", "b"]);
	expect(shellWriteTargets("cp -t /tmp/d f1")).toEqual(["/tmp/d"]); // tempsafe: parsed command text only, nothing executed
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

// TMPALLOC1 (ompkit-fp72.120.16.36). Admission only: no command below is executed and nothing is allocated.
const FRESHPI1 = "root=$(mktemp -d /tmp/pi1-installed-real.XXXXXX); mkdir -p \"$root/home/.omp\"; cp -R \"$HOME/.omp/profiles\" \"$root/home/.omp/\"";

test("TMPALLOC1: an executed mktemp outside repo-local var/agent-tmp is refused before anything runs", () => {
	// The caller's cwd is a work tree below HOME, as in the incident; HOME itself has its own direct-child rule.
	const work = join(home(), "work");
	const bash = (command: string) => check({ toolName: "bash", input: { command } }, ctx(work));
	expect(bash(FRESHPI1)?.reason).toContain("fleet-guard scratch-alloc");
	expect(bash(FRESHPI1)?.reason).toContain("/tmp/pi1-installed-real.XXXXXX"); // tempsafe: expected reason text, nothing created
	for (const command of [
		"root=$(mktemp -d)\ncp -R \"$HOME/.omp/profiles\" \"$root/home/.omp/\"",
		"root=`mktemp -d /tmp/pi1.XXXXXX` && cp -R a \"$root\"",
		"printf '%s' \"$(mktemp -d)\"",
		"echo start\nmktemp -d /tmp/x.XXXXXX",
		"echo start # comment\nmktemp -d /private/tmp/x.XXXXXX",
		"mktemp",
		"mktemp -q",
		"mktemp -d -t ompXXXXXX",
		"mktemp -dt omp",
		"mktemp -u /tmp/omp.XXXXXX",
		"mktemp --dry-run /tmp/omp.XXXXXX",
		"mktemp --tmpdir x.XXXXXX",
		"mktemp -p /tmp x.XXXXXX",
		"mktemp var/agent-tmp/owned/a.XXXXXX /tmp/b.XXXXXX",
		"mktemp -d -- /tmp/x.XXXXXX",
		"mktemp -Z /tmp/x.XXXXXX",
		"mktemp -d \"$TMPDIR/x.XXXXXX\"",
		"mktemp -d ~/x.XXXXXX",
		"mktemp -d /opt/elsewhere.XXXXXX",
		"/usr/bin/mktemp -d /tmp/x.XXXXXX",
		"TMPDIR=/tmp mktemp -d",
		"env -i FOO=1 mktemp -d /tmp/x.XXXXXX",
		"if mktemp -d /tmp/x.XXXXXX; then :; fi",
		"{ mktemp -d /tmp/x.XXXXXX; }",
		"(cd sub && mktemp -d /tmp/x.XXXXXX)",
		"nice -n 10 mktemp -d /tmp/x.XXXXXX",
		"sh -c 'root=$(mktemp -d); : \"$root\"'",
		"bash -lc \"mktemp -d /tmp/x.XXXXXX\"",
		"bash <<'EOF'\nmktemp -d /tmp/x.XXXXXX\nEOF",
		"bash <<< 'mktemp -d /tmp/x.XXXXXX'",
		"eval 'mktemp -d /tmp/x.XXXXXX'",
		"cat <<EOF\n$(mktemp -d /tmp/x.XXXXXX)\nEOF",
		"echo ok > \"$(mktemp /tmp/x.XXXXXX)\"",
		"diff a <(mktemp /tmp/x.XXXXXX)",
		"x=\"${HOME:-$(mktemp -d /tmp/x.XXXXXX)}\"",
	])
		expect(bash(command)?.reason, command).toContain("fleet-guard scratch-alloc");
	// The literal sink refusal is unchanged.
	expect(bash("cp -R profiles /tmp/oq16-dirty")?.reason).toContain("fleet-guard scratch-write");
});

test("TMPALLOC1: inert text naming mktemp and explicit repo-local templates stay allowed", () => {
	const dir = home();
	const bash = (command: string, cwd = dir) => check({ toolName: "bash", input: { command } }, ctx(cwd));
	for (const command of [
		"echo \"mktemp /tmp/x\"",
		"echo 'mktemp -d /tmp/x'",
		"printf '%s\\n' 'mktemp -d /tmp/not-real'",
		"grep mktemp file",
		"grep -rn \"mktemp -d /tmp\" src",
		"man mktemp",
		"command -v mktemp",
		"echo hi # mktemp -d /tmp/x.XXXXXX",
		"# mktemp -d /tmp/x.XXXXXX\necho hi",
		"echo \"\\$(mktemp -d /tmp/x.XXXXXX)\"",
		"echo \\$\\(mktemp -d /tmp/x.XXXXXX\\)",
		"echo '`mktemp /tmp/x.XXXXXX`'",
		"cat <<'EOF'\nmktemp -d /tmp/not-real\nroot=$(mktemp -d /tmp/x.XXXXXX)\nEOF",
		"cat <<EOF\nmktemp -d /tmp/not-real\nEOF",
		"cat <<-\"EOF\"\n\t$(mktemp -d /tmp/x.XXXXXX)\n\tEOF\necho after",
		"mktemp -d var/agent-tmp/owned/x.XXXX",
		"mktemp -d ./var/agent-tmp/owned/probe.XXXXXX",
		"mktemp var/agent-tmp/owned/a.XXXXXX var/agent-tmp/owned/b.XXXXXX",
		"root=$(mktemp -d var/agent-tmp/owned/pi1.XXXXXX); mkdir -p \"$root/home\"; cp -R profiles \"$root/home/\"",
		"root=$(mktemp -d 'var/agent-tmp/owned/quoted.XXXXXX') && echo \"$root\"",
	])
		expect(bash(command), command).toBeUndefined();
	expect(bash("mktemp -d ../var/agent-tmp/owned/x.XXXXXX", join(dir, "sub"))).toBeUndefined();
	// -p DIR is a Darwin mktemp option; the pinned portable dialect refuses it rather than guess.
	const viaTmpdir = bash("mktemp -d -p var/agent-tmp/owned x.XXXXXX");
	if (process.platform === "darwin") expect(viaTmpdir).toBeUndefined();
	else expect(viaTmpdir?.reason).toContain("fleet-guard scratch-alloc");
});

test("TMPALLOC1: shell text the guard cannot inspect is refused, never allowed", () => {
	const dir = home();
	const bash = (command: string) => check({ toolName: "bash", input: { command } }, ctx(dir));
	for (const command of ["root=$(mktemp -d /tmp/x.XXXXXX", "echo 'unterminated", "echo \"$(echo hi\"", "x=`mktemp /tmp/x.XXXXXX"])
		expect(bash(command)?.reason, command).toContain("could not be inspected");
	const deep = "echo " + "$(".repeat(40) + "mktemp -d var/agent-tmp/owned/x.XXXXXX" + ")".repeat(40);
	expect(bash(deep)?.reason).toContain("budget");
});

test("session scratch dir matches the S2 owner-name contract", () => {
	const repo = ownedRoot("fleet-repo");
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
	const repo = ownedRoot("fleet-seat-owner");
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

test("SCRATCHBIN1: a seat owner may name its throwaway bin, and no other bin is writable here", () => {
	const repo = ownedRoot("fleet-seat-bin");
	const dir = join(repo, "var", "agent-tmp", "omp.4242");
	const base = { pid: 4242, label: "omp", repo, created: "2026-10-02T00:00:00.000Z" };
	writeScratchOwner(dir, { ...base, bin: "throwaway" });
	expect(readFileSync(join(dir, ".owner"), "utf8")).toBe(`pid=4242\nlabel=omp\nrepo=${repo}\ncreated=2026-10-02T00:00:00.000Z\nbin=throwaway\n`);
	// Anything else is not written: the type allows only the one bin, and the writer ignores a smuggled value.
	writeScratchOwner(dir, { ...base, bin: "hold" as never });
	expect(readFileSync(join(dir, ".owner"), "utf8")).toBe(`pid=4242\nlabel=omp\nrepo=${repo}\ncreated=2026-10-02T00:00:00.000Z\n`);
});

test("OWNERKEY1: the host agent name is AGENT_NAME, else BR_ACTOR, else BR_AGENT_NAME, and never an unsafe value", () => {
	expect(hostAgentName({ AGENT_NAME: "A", BR_ACTOR: "B", BR_AGENT_NAME: "C" })).toBe("A");
	expect(hostAgentName({ BR_ACTOR: " B ", BR_AGENT_NAME: "C" })).toBe("B");
	expect(hostAgentName({ BR_AGENT_NAME: "C" })).toBe("C");
	expect(hostAgentName({ AGENT_NAME: "../x", BR_ACTOR: "ok" })).toBe("ok");
	expect(hostAgentName({})).toBeUndefined();
});

test("applyScratchEnv points child tools at the session dir", () => {
	applyScratchEnv("/tmp/should-not-persist"); // tempsafe: env value only, restored afterEach and never created
	expect(process.env.TMPDIR).toBe("/tmp/should-not-persist"); // tempsafe: expected env value, nothing created
	expect(process.env.TMP).toBe("/tmp/should-not-persist"); // tempsafe: expected env value, nothing created
	expect(process.env.TEMP).toBe("/tmp/should-not-persist"); // tempsafe: expected env value, nothing created
});

test("five hundred checks settle well inside budget without I/O", () => {
	const dir = home();
	const event = { toolName: "write", input: { path: join(dir, "ok.txt") } };
	const started = Date.now();
	for (let i = 0; i < 500; i++) check(event, ctx(dir));
	expect(Date.now() - started).toBeLessThan(5000);
});

test("TMPWRITE1: clone/worktree/rsync/tar destinations are shell write targets; their sources are not", () => {
	expect(shellWriteTargets("git clone --depth 1 -b main https://h/r.git dest")).toEqual(["dest"]);
	expect(shellWriteTargets("git -C repo clone https://h/team/r.git/")).toEqual(["r"]);
	expect(shellWriteTargets("git clone --separate-git-dir=gd src out")).toEqual(["gd", "out"]);
	expect(shellWriteTargets("git worktree add -b topic ../wt main")).toEqual(["../wt"]);
	expect(shellWriteTargets("rsync -av -e ssh src/ dst/")).toEqual(["dst/"]);
	expect(shellWriteTargets("rsync -a src/ host:/tmp/x")).toEqual([]);
	expect(shellWriteTargets("tar -xzf a.tgz -C out && tar --directory=o2 -xf b.tar")).toEqual(["out", "o2"]);
	expect(shellWriteTargets("tar czf out.tgz -C src .")).toEqual(["out.tgz"]);
	expect(shellWriteTargets("tar -tf in.tar")).toEqual([]);
	expect(shellWriteTargets("echo git clone a /x")).toEqual([]);
});

test("TMPWRITE1: checkSystemTemp refuses every system-temp sink with the scratch remedy, outside any opt-in", () => {
	const dir = home();
	process.env.TMPDIR = "/var/folders/zz/T";
	for (const command of ["mktemp -d /tmp/x.XXXXXX", "mktemp", "mktemp -d -t x", "mktemp -d -p /var/tmp x.XXX", "mktemp -d \"$TMPDIR/x.XXX\"",
		"git clone https://h/r.git /tmp/x", "git worktree add /private/tmp/wt", "cp a /var/tmp/b", "rsync -a s/ /var/folders/a/b",
		"tar -x -f a.tar -C /private/var/folders/c", "echo x > $TMPDIR/f", "echo x | tee /tmp/a", "x=$(mktemp -d /tmp/y.XXX)"]) {
		const reason = checkSystemTemp({ toolName: "bash", input: { command } }, ctx(dir))?.reason;
		expect(reason, command).toContain("fleet-guard system-temp");
		expect(reason).toContain("omp-kit scratch new");
	}
	expect(checkSystemTemp({ toolName: "write", input: { path: "/private/var/tmp/x" } }, ctx(dir))?.block).toBe(true);
	expect(checkSystemTemp({ toolName: "bash", input: { command: "git clone https://h/r.git" } }, ctx("/tmp"))?.block).toBe(true);
	const scratch = join(dir, "repo", "var", "agent-tmp");
	process.env.TMPDIR = scratch;
	for (const command of ["mktemp -d var/agent-tmp/x.XXXXXX", "mktemp -d", "echo x > $TMPDIR/f", "cat /tmp/x", "ls /var/folders",
		"cp /tmp/a var/agent-tmp/b", "git clone /tmp/src var/agent-tmp/c", "omp-kit scratch new --label x --json", "tar -cf var/agent-tmp/a.tar -C /tmp src"])
		expect(checkSystemTemp({ toolName: "bash", input: { command } }, ctx(join(dir, "repo"))), command).toBeUndefined();
	expect(checkSystemTemp({ toolName: "read", input: { path: "/tmp/x" } }, ctx(dir))).toBeUndefined(); // tempsafe: judged only
	// A repository hosted in system temp (the commit gate's export) keeps its own scratch; temp's own var/agent-tmp does not count.
	const hosted = "/var/folders/zz/T/export/repo";
	expect(checkSystemTemp({ toolName: "bash", input: { command: "mktemp -d var/agent-tmp/x.XXX" } }, ctx(join(hosted, "sub")))).toBeUndefined();
	expect(checkSystemTemp({ toolName: "write", input: { path: `${hosted}/var/agent-tmp/f` } }, ctx(hosted))).toBeUndefined();
	expect(checkSystemTemp({ toolName: "write", input: { path: `${hosted}/f` } }, ctx(hosted))?.block).toBe(true);
	expect(checkSystemTemp({ toolName: "bash", input: { command: "echo x > var/agent-tmp/f" } }, ctx("/tmp"))?.block).toBe(true);
	expect(check({ toolName: "write", input: { path: "/var/folders/zz/T/other/var/agent-tmp/f" } }, ctx(hosted))?.block).toBe(true);
});

// APPLICSCRATCH1 (ompkit-1ra0d.127): a call inside an ovnfs checkout (an external gitdir file,
// not an ordinary .git directory) is judged under that repository's own policy instead of refused
// as unverifiable; a dead gitdir pointer with a marker stays unavailable (never verified).
function applicGitInit(dir: string): void {
	const result = runFixture(["git", "init", "-q", dir], { cwd: dirname(dir), label: "applic-git-init" });
	if (result.rc !== 0) throw new Error(`git init failed: ${new TextDecoder().decode(result.stderr)}`);
}

test("APPLICSCRATCH1: an edit inside an ovnfs checkout of an opted-in repository is judged under its policy", async () => {
	const donor = ownedRoot("applic-donor");
	applicGitInit(donor);
	const co = ownedRoot("applic-co");
	writeFileSync(join(co, ".git"), `gitdir: ${join(donor, ".git")}\n`);
	mkdirSync(join(co, ".omp"), { recursive: true });
	writeFileSync(join(co, ".omp", "fleet.json"), '{"enabled":true}');
	expect(await fleetPolicyState(co)).toEqual({ kind: "on", root: co });
	// planted negative: the empty-.git-dir shape refuses on the old code; the new code defers
	// to the nearest real repository's policy.
	const fake = join(co, "sub");
	mkdirSync(join(fake, ".git"), { recursive: true });
	mkdirSync(join(fake, ".omp"), { recursive: true });
	writeFileSync(join(fake, ".omp", "fleet.json"), '{"enabled":true}');
	expect(await fleetPolicyState(fake)).toEqual({ kind: "on", root: co });
	// escape shape: a dead gitdir pointer plus marker inside an opted-in repo stays unavailable.
	const evil = join(co, "evil");
	mkdirSync(evil, { recursive: true });
	writeFileSync(join(evil, ".git"), "gitdir: /nonexistent/ovnfs/git/applic-evil\n");
	mkdirSync(join(evil, ".omp"), { recursive: true });
	writeFileSync(join(evil, ".omp", "fleet.json"), '{"enabled":true}');
	expect(await fleetPolicyState(evil)).toMatchObject({ kind: "unavailable", root: evil });
});

test("APPLICSCRATCH1-path: a sibling-relative redirect after cd resolves where the agent wrote", () => {
	const dir = home();
	const repo = join(dir, "work", "proj");
	mkdirSync(join(repo, "var", "agent-tmp", "w"), { recursive: true });
	// the ledger shape: cd into an existing scratch dir, write ../../name — the file lands
	// in-repo, so nothing is blocked.
	expect(check({ toolName: "bash", input: { command: "cd var/agent-tmp/w && echo hi > ../../out" } }, ctx(repo))).toBeUndefined();
	// cd into a missing dir keeps today's resolution: the write would land in the home root.
	const missing = check({ toolName: "bash", input: { command: "cd var/agent-tmp/NOPE && echo hi > ../../out" } }, ctx(repo));
	expect(missing?.block).toBe(true);
	expect(missing?.reason).toContain("under $HOME");
	// the same redirect without cd is a real home-root write: still refused.
	const blocked = check({ toolName: "bash", input: { command: "echo hi > ../../out" } }, ctx(repo));
	expect(blocked?.block).toBe(true);
	expect(blocked?.reason).toContain("under $HOME");
	// a cd into system temp does not smuggle the write past the temp rule.
	const tmp = checkSystemTemp({ toolName: "bash", input: { command: "cd /tmp && echo hi > x" } }, ctx(repo));
	expect(tmp?.block).toBe(true);
	expect(tmp?.reason).toContain("fleet-guard system-temp");
	expect(shellWriteBases("cd var/agent-tmp/w && echo hi > ../../out", repo, dir))
		.toEqual([{ target: "../../out", base: join(repo, "var", "agent-tmp", "w") }]);
	expect(shellWriteBases("cd var/agent-tmp/NOPE && echo hi > ../../out", repo, dir))
		.toEqual([{ target: "../../out", base: repo }]);
	expect(shellWriteBases("cd $D && echo hi > ../../out", repo, dir)).toEqual([{ target: "../../out", base: repo }]);
	expect(shellWriteBases('cd "~/w" && echo hi > ../../out', repo, dir)).toEqual([{ target: "../../out", base: repo }]);
	// a symlinked cd target is judged where the write really lands.
	symlinkSync("/tmp", join(repo, "var", "agent-tmp", "ltmp"));
	const linkedTmp = checkSystemTemp({ toolName: "bash", input: { command: "cd var/agent-tmp/ltmp && echo hi > x" } }, ctx(repo));
	expect(linkedTmp?.block).toBe(true);
	expect(linkedTmp?.reason).toContain("fleet-guard system-temp");
	symlinkSync(dir, join(repo, "var", "agent-tmp", "lhome"));
	const linkedHome = check({ toolName: "bash", input: { command: "cd var/agent-tmp/lhome && echo hi > notes.md" } }, ctx(repo));
	expect(linkedHome?.block).toBe(true);
	expect(linkedHome?.reason).toContain("under $HOME");
	// a backgrounded or piped cd never moves the parent: the pending move is dropped.
	expect(shellWriteBases("cd var/agent-tmp/w & echo hi > ../../out", repo, dir))
		.toEqual([{ target: "../../out", base: repo }]);
	expect(shellWriteBases("cd /tmp | cat; echo hi > x", repo, dir)).toEqual([{ target: "x", base: repo }]);
	const bg = check({ toolName: "bash", input: { command: "cd var/agent-tmp/w & echo hi > ../../out" } }, ctx(repo));
	expect(bg?.block).toBe(true);
	expect(bg?.reason).toContain("under $HOME");
	expect(checkSystemTemp({ toolName: "bash", input: { command: "cd /tmp | cat; echo hi > x" } }, ctx(repo))).toBeUndefined();
	// a cd settled inside parentheses never leaks out: the subshell is gone when `)` closes.
	const sub = check({ toolName: "bash", input: { command: "(cd var/agent-tmp/w && true); echo hi > ../../out" } }, ctx(repo));
	expect(sub?.block).toBe(true);
	expect(sub?.reason).toContain("under $HOME");
	expect(shellWriteBases("(cd var/agent-tmp/w && true); echo hi > ../../out", repo, dir))
		.toEqual([{ target: "../../out", base: repo }]);
	const subst = check({ toolName: "bash", input: { command: "x=$(cd var/agent-tmp/w && pwd); echo hi > ../../out" } }, ctx(repo));
	expect(subst?.block).toBe(true);
	expect(subst?.reason).toContain("under $HOME");
	const nested = check({ toolName: "bash", input: { command: "((cd var/agent-tmp/w && true)); echo hi > ../../out" } }, ctx(repo));
	expect(nested?.block).toBe(true);
	expect(nested?.reason).toContain("under $HOME");
	// an unbalanced `)` never underflows the scope stack.
	expect(shellWriteBases("echo hi > x)", repo, dir)).toEqual([{ target: "x", base: repo }]);
});

// TMPREWRITE1 (ompkit-1ra0d.144): a literal simple /tmp file lands in the session scratch.
function rewriteFixture(label: string): { repo: string; sessionDir: string; aliases: Map<string, string> } {
	const repo = ownedRoot(`rewrite-${label}`);
	mkdirSync(join(repo, ".git"), { recursive: true });
	const sessionDir = ownedRoot(`rewrite-${label}-session`);
	mkdirSync(sessionDir, { recursive: true });
	return { repo, sessionDir, aliases: new Map() };
}

test("TMPREWRITE1: spans mirror shellTokens word boundaries and fail visibly", () => {
	const corpus = [
		"echo hi > /tmp/x.json",
		"cat /tmp/a | tee /tmp/b; echo done > ./out",
		"echo 'quoted /tmp/no' > /tmp/yes",
		"FOO=1 env BAR=2 echo hi",
		"x=$(cat /tmp/r) && echo hi > /tmp/w",
		"cd sub && echo hi > ../out",
		"echo hi >| /tmp/nc",
		"echo hi > $'/tmp/ansi.json'",
		"tee /tmp/a < /tmp/b",
	];
	for (const command of corpus) {
		const lexed = shellWordSpans(command);
		expect("error" in lexed).toBe(false);
		if ("error" in lexed) continue;
		// spans cover the words; shellTokens additionally yields the operators, which carry no rewrite.
		const words = shellTokens(command).map((token) => token.text).filter((text) => !/^[;&|()<>-]+$/.test(text));
		expect(lexed.spans.map((span) => span.text)).toEqual(words);
		for (const span of lexed.spans) {
			expect(command.slice(span.start, span.end).includes(span.text)).toBe(true);
		}
	}
	expect(shellWordSpans("echo 'unterminated")).toMatchObject({ error: "unterminated single quote" });
	expect(shellWordSpans('echo "unterminated')).toMatchObject({ error: "unterminated double quote" });
});

test("TMPREWRITE1: write-tool and bash redirect land in session scratch; later read follows", () => {
	const { repo, sessionDir, aliases } = rewriteFixture("basic");
	const context = { cwd: repo };
	expect(checkSystemTemp({ toolName: "write", input: { path: "/tmp/x.json", content: "{}" } }, ctx(repo))?.block).toBe(true); // tempsafe: fake guard input path, never touched on disk
	expect(checkSystemTemp({ toolName: "bash", input: { command: "echo hi > /tmp/x.json" } }, ctx(repo))?.block).toBe(true);
	const write = rewriteToolInput("write", { path: "/tmp/x.json", content: "{}" }, { cwd: repo, context, sessionDir, aliases }); // tempsafe: fake guard input path, never touched on disk
	expect("input" in (write as object)).toBe(true);
	if (!("input" in (write as object))) return;
	expect(write.input.path).toBe(join(sessionDir, "x.json"));
	expect(write.mapped).toEqual([{ from: "/tmp/x.json", to: join(sessionDir, "x.json") }]); // tempsafe: fake guard input path, never touched on disk
	expect(autoCompletedLine("/tmp/x.json", join(sessionDir, "x.json"))).toBe(`AUTO_COMPLETED: /tmp/x.json -> ${join(sessionDir, "x.json")}`); // tempsafe: fake guard input path, never touched on disk
	expect(checkSystemTemp({ toolName: "write", input: write.input }, ctx(repo))).toBeUndefined();
	const bash = rewriteShellCommand("echo hi > /tmp/x.json", { cwd: repo, home: process.env.HOME ?? "", sessionDir, aliases });
	expect("command" in (bash as object)).toBe(true);
	if (!("command" in (bash as object))) return;
	expect(bash.command).toBe(`echo hi > ${join(sessionDir, "x.json")}`);
	expect(bash.command.includes("/tmp/")).toBe(false);
	expect(checkSystemTemp({ toolName: "bash", input: { command: bash.command } }, ctx(repo))).toBeUndefined();
	const read = rewriteToolInput("read", { path: "/tmp/x.json" }, { cwd: repo, context, sessionDir, aliases }); // tempsafe: fake guard input path, never touched on disk
	expect("input" in (read as object)).toBe(true);
	if (!("input" in (read as object))) return;
	expect(read.input.path).toBe(join(sessionDir, "x.json"));
	const patch = "*** Begin Patch\n[/tmp/note.json#AB12]\nPUT 1.=1:\n+hi\n*** End Patch\n";
	const edit = rewriteToolInput("edit", { input: patch }, { cwd: repo, context, sessionDir, aliases });
	expect("input" in (edit as object)).toBe(true);
	if (!("input" in (edit as object))) return;
	expect(edit.input.input).toContain(`[${join(sessionDir, "note.json")}#AB12]`);
});

test("TMPREWRITE1-kept: non-literal, remote, nested and allocation shapes stay refused", () => {
	const { repo, sessionDir, aliases } = rewriteFixture("kept");
	const context = { cwd: repo };
	const home = process.env.HOME ?? "";
	const stillBlocked = (command: string): void => {
		const result = rewriteShellCommand(command, { cwd: repo, home, sessionDir, aliases });
		expect("refuse" in (result as object)).toBe(true);
		expect(checkSystemTemp({ toolName: "bash", input: { command } }, ctx(repo))?.block).toBe(true);
	};
	const stillUntouched = (command: string): void => {
		const result = rewriteShellCommand(command, { cwd: repo, home, sessionDir, aliases });
		expect("refuse" in (result as object)).toBe(true);
		expect(checkSystemTemp({ toolName: "bash", input: { command } }, ctx(repo))).toBeUndefined();
	};
	// $TMPDIR is env-dependent (repo-local in the export tree), so the variable-built case names /tmp explicitly.
	stillBlocked("echo hi > /tmp/$name");
	stillBlocked("echo hi > /tmp/*.json");
	stillBlocked("mkdir -p /tmp/x.json");
	stillBlocked("mktemp /tmp/x.json.XXXXXX");
	stillBlocked("echo hi > \"/tmp/x.json\"");
	stillBlocked("echo hi > /tmp/sub/x.json");
	stillBlocked("echo hi > /tmp/");
	stillBlocked("echo hi >| /tmp/nc.json");
	stillBlocked("echo hi > $'/tmp/ansi.json'");
	stillBlocked("ln -s else /tmp/linked");
	stillBlocked("install -m 644 a /tmp/b");
	// file-operation destinations create directories or trees, so the literal never names the opened file.
	stillBlocked("cp a /tmp/b");
	stillBlocked("mv a /tmp/b");
	stillBlocked("git clone https://example.invalid/r.git /tmp/x");
	stillBlocked("tar -xzf a.tgz -C /tmp/out");
	// remote or nested execution contexts: nothing local is written, so today allows them;
	// the rewrite still refuses, so the path is never substituted into another machine or interpreter.
	stillUntouched("ssh deploy \"echo hi > /tmp/x.json\"");
	stillUntouched("scp out.json deploy:/tmp/x.json");
	stillUntouched("rsync -a out.json deploy:/tmp/x.json");
	stillUntouched("docker exec app sh -c 'echo hi > /tmp/x.json'");
	stillUntouched("sh -c 'echo hi > /tmp/x.json'");
	stillUntouched("node -e \"require('fs').writeFileSync('/tmp/x.json','h')\"");
	const ssh = rewriteShellCommand("ssh deploy \"echo hi > /tmp/x.json\"", { cwd: repo, home, sessionDir, aliases });
	expect("refuse" in (ssh as object)).toBe(true);
	expect("refuse" in (rewriteToolInput("write", { path: "/tmp/$name" }, { cwd: repo, context, sessionDir, aliases }) as object)).toBe(true); // tempsafe: fake guard input path, never touched on disk
	expect("refuse" in (rewriteToolInput("write", { path: "/tmp/sub/x.json" }, { cwd: repo, context, sessionDir, aliases }) as object)).toBe(true); // tempsafe: fake guard input path, never touched on disk
	expect(rewriteToolInput("read", { path: "/tmp/fresh.json" }, { cwd: repo, context, sessionDir, aliases })).toBeUndefined(); // tempsafe: fake guard input path, never touched on disk
	expect(checkSystemTemp({ toolName: "read", input: { path: "/tmp/fresh.json" } }, ctx(repo))).toBeUndefined(); // tempsafe: fake guard input path, never touched on disk
});

test("TMPREWRITE1-kept: here-document and here-string bodies are never rewritten", () => {
	const { repo, sessionDir, aliases } = rewriteFixture("kept-heredoc");
	const home = process.env.HOME ?? "";
	const heredoc = ["cat <<EOF", "/tmp/x.json", "EOF"].join("\n"); // tempsafe: parsed command text only, nothing executed
	const heredocResult = rewriteShellCommand(heredoc, { cwd: repo, home, sessionDir, aliases });
	expect("refuse" in (heredocResult as object)).toBe(true);
	const stripped = rewriteShellCommand("cat <<< /tmp/x.json", { cwd: repo, home, sessionDir, aliases });
	expect("refuse" in (stripped as object)).toBe(true);
});

test("TMPREWRITE1-adopt: only a session-created ownerless dir is adopted, with an exclusive owner", () => {
	const repo = ownedRoot("rewrite-adopt");
	mkdirSync(join(repo, ".git"), { recursive: true });
	const agent = "AdoptSeat";
	const session = "01a1502a-5647-76ba-89c5-949087f3e283";
	const target = join(repo, "var", "agent-tmp", "hand.1", "out.json");
	// the session made the dir: an admitted mkdir records its top before the tool creates it.
	expect(createdScratchTops("bash", "mkdir -p var/agent-tmp/hand.1", [], repo)).toEqual([join(repo, "var", "agent-tmp", "hand.1")]);
	mkdirSync(join(repo, "var", "agent-tmp", "hand.1"), { recursive: true });
	// planted negative: an ownerless directory this session did not create keeps today's refusal.
	expect(adoptOwnerlessDir(target, { cwd: repo, agent, session, createdDirs: new Set() })).toMatchObject({ refuse: "scratch directory was not created by this session" });
	expect(adoptOwnerlessDir(target, { cwd: repo, agent, session })).toMatchObject({ refuse: "scratch directory was not created by this session" });
	const created = new Set([join(repo, "var", "agent-tmp", "hand.1")]);
	const adopted = adoptOwnerlessDir(target, { cwd: repo, agent, session, createdDirs: created });
	expect("dir" in adopted).toBe(true);
	if (!("dir" in adopted)) return;
	expect(adopted.dir).toBe(join(repo, "var", "agent-tmp", "hand.1"));
	const owner = readFileSync(join(adopted.dir, ".owner"), "utf8");
	expect(owner).toContain(`agent=${agent}\n`);
	expect(owner).toContain(`session=${session}\n`);
	expect(owner).toContain("bin=throwaway\n");
	// exclusive create: a second adopt (or a meanwhile-appeared owner) is not a steal.
	expect(adoptOwnerlessDir(target, { cwd: repo, agent, session, createdDirs: created })).toMatchObject({ refuse: "scratch directory already has an owner" });
	mkdirSync(join(repo, "var", "agent-tmp", "theirs.2"), { recursive: true });
	writeScratchOwner(join(repo, "var", "agent-tmp", "theirs.2"), { pid: process.pid, label: "theirs.2", repo, created: new Date().toISOString(), agent: "OtherSeat", session, bin: "throwaway" });
	expect(adoptOwnerlessDir(join(repo, "var", "agent-tmp", "theirs.2", "out.json"), { cwd: repo, agent, session, createdDirs: new Set([join(repo, "var", "agent-tmp", "theirs.2")]) })).toMatchObject({ refuse: "scratch directory already has an owner" });
	expect(adoptOwnerlessDir("/tmp/hand/out.json", { cwd: repo, agent, session, createdDirs: created })).toMatchObject({ refuse: "outside the calling repository scratch root" }); // tempsafe: fake guard input path, never touched on disk
	expect(adoptOwnerlessDir(join(repo, "var", "agent-tmp"), { cwd: repo, agent, session, createdDirs: created })).toMatchObject({ refuse: "the scratch root itself is not adoptable" });
	expect(parseSessionTmpLiteral("/tmp/x.json")).toEqual({ root: "/tmp", base: "x.json" }); // tempsafe: fake guard input path, never touched on disk
	expect(parseSessionTmpLiteral("/tmp/sub/x.json")).toBeUndefined(); // tempsafe: fake guard input path, never touched on disk
	expect(parseSessionTmpLiteral("/tmp/")).toBeUndefined();
});

test("TMPREWRITE1-H1: planted links, dirs and hard links at the destination refuse", () => {
	const { repo, sessionDir, aliases } = rewriteFixture("h1");
	const context = { cwd: repo };
	const attempt = (path: string): unknown => rewriteToolInput("write", { path, content: "{}" }, { cwd: repo, context, sessionDir, aliases });
	const refusalOf = (value: unknown): string | undefined => {
		if (typeof value !== "object" || value === null || !("refuse" in value)) return undefined;
		return typeof value.refuse === "string" ? value.refuse : undefined;
	};
	// planted negative: today's guard still refuses the original literal either way.
	expect(checkSystemTemp({ toolName: "write", input: { path: "/tmp/link.json", content: "{}" } }, ctx(repo))?.block).toBe(true); // tempsafe: fake guard input path, never touched on disk
	symlinkSync(join(repo, "elsewhere"), join(sessionDir, "link.json"));
	expect(refusalOf(attempt("/tmp/link.json"))).toContain("symlink"); // tempsafe: fake guard input path, never touched on disk
	mkdirSync(join(sessionDir, "dir.json"));
	expect(refusalOf(attempt("/tmp/dir.json"))).toContain("not a regular file"); // tempsafe: fake guard input path, never touched on disk
	const hardTarget = join(sessionDir, "hard.json");
	writeFileSync(hardTarget, "{}\n");
	linkSync(hardTarget, join(sessionDir, "hard-alias.json"));
	expect(refusalOf(attempt("/tmp/hard.json"))).toContain("hard link"); // tempsafe: fake guard input path, never touched on disk
	// an absent destination, or a plain single-link file the session already wrote, admits.
	expect("input" in (attempt("/tmp/ok.json") as object)).toBe(true); // tempsafe: fake guard input path, never touched on disk
	writeFileSync(join(sessionDir, "ok.json"), "{}\n");
	expect("input" in (attempt("/tmp/ok.json") as object)).toBe(true); // tempsafe: fake guard input path, never touched on disk
	expect(checkSystemTemp({ toolName: "bash", input: { command: "echo hi > /tmp/h1bash.json" } }, ctx(repo))?.block).toBe(true);
	symlinkSync(join(repo, "elsewhere"), join(sessionDir, "h1bash.json"));
	expect("refuse" in (rewriteShellCommand("echo hi > /tmp/h1bash.json", { cwd: repo, home: process.env.HOME ?? "", sessionDir, aliases }) as object)).toBe(true);
});

test("TMPREWRITE1-H2: a noclobber redirect is refused as a system-temp write, never rewritten", () => {
	const { repo, sessionDir, aliases } = rewriteFixture("h2");
	const home = process.env.HOME ?? "";
	const command = "echo hi >| /tmp/nc.json";
	// the tokenizer now sees the combined operator, so the target is judged.
	expect(shellWriteTargets(command)).toEqual(["/tmp/nc.json"]); // tempsafe: expected value only, nothing created
	expect("refuse" in (rewriteShellCommand(command, { cwd: repo, home, sessionDir, aliases }) as object)).toBe(true);
	expect(checkSystemTemp({ toolName: "bash", input: { command } }, ctx(repo))?.block).toBe(true);
});

test("TMPREWRITE1-H3: ANSI-C quoted temp paths resolve to system temp and refuse", () => {
	const { repo, sessionDir, aliases } = rewriteFixture("h3");
	const home = process.env.HOME ?? "";
	const command = "echo hi > $'/tmp/ansi.json'";
	expect("refuse" in (rewriteShellCommand(command, { cwd: repo, home, sessionDir, aliases }) as object)).toBe(true);
	expect(checkSystemTemp({ toolName: "bash", input: { command } }, ctx(repo))?.block).toBe(true);
	expect(checkSystemTemp({ toolName: "bash", input: { command: "echo hi > $'/tmp/ok'extra" } }, ctx(repo))?.block).toBe(true);
});

test("TMPREWRITE1-M1: a tee input redirect is never a write target", () => {
	const { repo, sessionDir, aliases } = rewriteFixture("m1");
	const home = process.env.HOME ?? "";
	expect(shellWriteTargets("tee /tmp/a < /tmp/b")).toEqual(["/tmp/a"]); // tempsafe: expected value only, nothing created
	const command = "tee /tmp/a < /tmp/b";
	expect("refuse" in (rewriteShellCommand(command, { cwd: repo, home, sessionDir, aliases }) as object)).toBe(true);
	expect(checkSystemTemp({ toolName: "bash", input: { command } }, ctx(repo))?.block).toBe(true);
});

test("TMPREWRITE1-M2: mapped reads note a competing real file at the literal", () => {
	const { repo, sessionDir, aliases } = rewriteFixture("m2");
	const context = { cwd: repo };
	const home = process.env.HOME ?? "";
	const mappedOf = (value: unknown): Array<{ from: unknown; to: unknown; note?: unknown }> | undefined => {
		if (typeof value !== "object" || value === null || !("mapped" in value)) return undefined;
		const mapped: unknown = value.mapped;
		return Array.isArray(mapped) ? mapped : undefined;
	};
	const write = rewriteToolInput("write", { path: "/tmp/m2.json", content: "{}" }, { cwd: repo, context, sessionDir, aliases }); // tempsafe: fake guard input path, never touched on disk
	expect("input" in (write as object)).toBe(true);
	// no other file at the literal: the notice is plain.
	const plain = rewriteToolInput("read", { path: "/tmp/m2.json" }, { cwd: repo, context, sessionDir, aliases, originalExists: () => false }); // tempsafe: fake guard input path, never touched on disk
	expect(mappedOf(plain)).toEqual([{ from: "/tmp/m2.json", to: join(sessionDir, "m2.json") }]); // tempsafe: fake guard input path, never touched on disk
	// a different real file sits at the original path: the notice says the read serves the session copy.
	const noted = rewriteToolInput("read", { path: "/tmp/m2.json" }, { cwd: repo, context, sessionDir, aliases, originalExists: () => true }); // tempsafe: fake guard input path, never touched on disk
	expect(mappedOf(noted)).toEqual([{ from: "/tmp/m2.json", to: join(sessionDir, "m2.json"), note: "a different file exists at /tmp/m2.json; reading the session copy" }]); // tempsafe: fake guard input path, never touched on disk
	const shell = rewriteShellCommand("cat /tmp/m2.json", { cwd: repo, home, sessionDir, aliases, originalExists: () => true });
	expect("command" in (shell as object)).toBe(true);
	expect(mappedOf(shell)?.[0]?.note).toContain("reading the session copy");
});

test("TMPREWRITE1-M4: comments never contribute rewrite words", () => {
	const lexed = shellWordSpans("echo hi > /tmp/x # /tmp/y");
	expect("error" in lexed).toBe(false);
	if ("error" in lexed) return;
	expect(lexed.spans.map((span) => span.text)).toEqual(["echo", "hi", "/tmp/x"]); // tempsafe: expected value only, nothing created
});

test("TMPREWRITE1-track: admitted mkdir and write calls record session-created tops", () => {
	const repo = ownedRoot("rewrite-track");
	mkdirSync(join(repo, ".git"), { recursive: true });
	mkdirSync(join(repo, "var", "agent-tmp", "old.2"), { recursive: true });
	expect(createdScratchTops("bash", "mkdir -p var/agent-tmp/new.1", [], repo)).toEqual([join(repo, "var", "agent-tmp", "new.1")]);
	expect(createdScratchTops("bash", "mkdir -p var/agent-tmp/old.2", [], repo)).toEqual([]);
	expect(createdScratchTops("write", undefined, [join(repo, "var", "agent-tmp", "w.3", "f")], repo)).toEqual([join(repo, "var", "agent-tmp", "w.3")]);
	expect(createdScratchTops("write", undefined, [join(repo, "notes.md")], repo)).toEqual([]);
});

test("TMPREWRITE1-L2: remote operands after sudo, xargs and find -exec refuse", () => {
	const { repo, sessionDir, aliases } = rewriteFixture("l2");
	const home = process.env.HOME ?? "";
	const refusalOf = (value: unknown): string | undefined => {
		if (typeof value !== "object" || value === null || !("refuse" in value)) return undefined;
		return typeof value.refuse === "string" ? value.refuse : undefined;
	};
	const sudoRemote = rewriteShellCommand("sudo ssh deploy \"echo hi > /tmp/x.json\"", { cwd: repo, home, sessionDir, aliases });
	expect("refuse" in (sudoRemote as object)).toBe(true);
	expect(refusalOf(sudoRemote)).toContain("remote operand after sudo");
	const findRemote = rewriteShellCommand("find . -exec ssh {} \\;", { cwd: repo, home, sessionDir, aliases });
	expect("refuse" in (findRemote as object)).toBe(true);
	// a local redirect under sudo still completes: the redirect belongs to the calling shell.
	const local = rewriteShellCommand("sudo echo hi > /tmp/local.json", { cwd: repo, home, sessionDir, aliases });
	expect("command" in (local as object)).toBe(true);
	if (typeof local !== "object" || local === null || !("command" in local)) return;
	expect(local.command).toBe(`sudo echo hi > ${join(sessionDir, "local.json")}`);
});

test("TMPREWRITE1-F1: file operations after wrappers are never spliced", () => {
	const { repo, sessionDir, aliases } = rewriteFixture("f1");
	const home = process.env.HOME ?? "";
	const refusalOf = (value: unknown): string | undefined => {
		if (typeof value !== "object" || value === null || !("refuse" in value)) return undefined;
		return typeof value.refuse === "string" ? value.refuse : undefined;
	};
	// planted negative: the old gate saw no file operation past the wrapper and spoke of
	// "outside a write" (xargs/find) or missed the destination entirely.
	for (const command of ["xargs -I{} cp {} /tmp/b", "find . -exec cp {} /tmp/b \\;", "sudo cp a /tmp/b"]) {
		const rewritten = rewriteShellCommand(command, { cwd: repo, home, sessionDir, aliases });
		expect("refuse" in (rewritten as object)).toBe(true);
		expect(refusalOf(rewritten)).toContain("file-operation destination after");
	}
});

test("TMPREWRITE1-F2: --target-directory names the destination", () => {
	expect(shellWriteTargets("cp --target-directory=/tmp a b")).toEqual(["/tmp"]);
	expect(shellWriteTargets("cp --target-directory /tmp a b")).toEqual(["/tmp"]);
	const { repo } = rewriteFixture("f2");
	// planted negative: the old walk read the last operand and missed the real destination.
	expect(checkSystemTemp({ toolName: "bash", input: { command: "cp --target-directory=/tmp a b" } }, ctx(repo))?.block).toBe(true);
	expect(checkSystemTemp({ toolName: "bash", input: { command: "cp --target-directory /tmp a b" } }, ctx(repo))?.block).toBe(true);
});

test("TMPREWRITE1-F3: dd of= is a write target", () => {
	const { repo, sessionDir, aliases } = rewriteFixture("f3");
	const context = { cwd: repo };
	const home = process.env.HOME ?? "";
	expect(shellWriteTargets("dd if=in of=/tmp/a")).toEqual(["/tmp/a"]); // tempsafe: parsed command text only, nothing executed
	expect(shellWriteTargets("dd if=/tmp/in of=out")).toEqual(["out"]);
	const rewritten = rewriteShellCommand("dd if=in of=/tmp/a", { cwd: repo, home, sessionDir, aliases });
	expect("command" in (rewritten as object)).toBe(true);
	if (typeof rewritten !== "object" || rewritten === null || !("command" in rewritten)) return;
	expect(rewritten.command).toBe(`dd if=in of=${join(sessionDir, "a")}`);
	// planted negative: the old guard saw no write at all.
	expect(checkSystemTemp({ toolName: "bash", input: { command: "dd if=in of=/tmp/a" } }, ctx(repo))?.block).toBe(true);
	expect(check({ toolName: "bash", input: { command: "dd if=in of=/tmp/a" } }, ctx(repo))?.block).toBe(true);
	// a non-literal of= stays refused on both paths.
	expect("refuse" in (rewriteShellCommand("dd of=/tmp/$f", { cwd: repo, home, sessionDir, aliases }) as object)).toBe(true);
	expect(checkSystemTemp({ toolName: "bash", input: { command: "dd of=/tmp/$f" } }, ctx(repo))?.block).toBe(true);

});

test("TMPREWRITE1-F4: expanded temp names in write position are blocked", () => {
	const { repo, sessionDir, aliases } = rewriteFixture("f4");
	const home = process.env.HOME ?? "";
	const command = "echo hi > ${x:-/tmp/a}";
	// planted negative: the guard used to allow this while only the rewrite refused it.
	expect("refuse" in (rewriteShellCommand(command, { cwd: repo, home, sessionDir, aliases }) as object)).toBe(true);
	const blocked = checkSystemTemp({ toolName: "bash", input: { command } }, ctx(repo));
	expect(blocked?.block).toBe(true);
	expect(blocked?.reason).toContain("system-temp");
	expect(check({ toolName: "bash", input: { command } }, ctx(repo))?.reason).toContain("scratch-write");
	// controls: pure expansions without /tmp stay allowed, and mktemp keeps its own refusal.
	expect(checkSystemTemp({ toolName: "bash", input: { command: "echo hi > $f" } }, ctx(repo))).toBeUndefined();
	expect(check({ toolName: "bash", input: { command: "echo ok > \"$(mktemp /tmp/x.XXXXXX)\"" } }, ctx(repo))?.reason).toContain("scratch-alloc");
});

test("TMPREWRITE1-F5: fd-noclobber operators combine and refuse", () => {
	const { repo, sessionDir, aliases } = rewriteFixture("f5");
	const home = process.env.HOME ?? "";
	expect(shellTokens("echo hi &>>| /tmp/a").map((token) => token.text)).toEqual(["echo", "hi", "&>>|", "/tmp/a"]); // tempsafe: parsed command text only, nothing executed
	expect(shellWriteTargets("echo hi &>> /tmp/a")).toEqual(["/tmp/a"]); // tempsafe: parsed command text only, nothing executed
	const command = "echo hi &>>| /tmp/a";
	expect("refuse" in (rewriteShellCommand(command, { cwd: repo, home, sessionDir, aliases }) as object)).toBe(true);
	expect(checkSystemTemp({ toolName: "bash", input: { command } }, ctx(repo))?.block).toBe(true);
});

test("TMPREWRITE1-mirror: shellTokenSpans mirrors shellTokens exactly, including new shapes", () => {
	const corpus = [
		"echo hi > /tmp/x.json",
		"echo hi >| /tmp/nc.json",
		"echo hi &>>| /tmp/a",
		"echo hi > $'/tmp/ansi.json'",
		"tee /tmp/a < /tmp/b",
		"cat <<EOF\n/tmp/x\nEOF",
		"sudo ssh deploy \"echo hi > /tmp/x.json\"",
		"dd if=in of=/tmp/a",
		"cp --target-directory=/tmp a b",
		"echo 'a > b'",
		"echo hi # comment /tmp/c",
	];
	for (const command of corpus) {
		const tokens = shellTokens(command);
		const spans = shellTokenSpans(command);
		expect(spans.length, command).toBe(tokens.length);
		for (const [index, span] of spans.entries()) {
			expect(span.text, command).toBe(tokens[index]!.text);
			expect(span.quoted, command).toBe(tokens[index]!.quoted);
		}
	}
});
