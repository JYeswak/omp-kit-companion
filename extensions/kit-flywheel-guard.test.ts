import { afterAll, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import kitFlywheelGuard, { FLYWHEEL_EXEC_TIMEOUT_MS, isMutatingCall, trackerRequests, normalizeRemoteUrl } from "./kit-flywheel-guard";
import type { FlywheelBeforeSubagentSpawnEvent, FlywheelContext, FlywheelExecResult, FlywheelToolCallResult } from "./kit-flywheel-guard";
import { createFlywheelHost, toolCall, bashInput } from "../tests/fleet-guard/kit-flywheel-host";
import type { FakeHost, Responder } from "../tests/fleet-guard/kit-flywheel-host";
import { ownedTmp } from "../src/kitlib/tmp.ts";
import { run, runSync } from "../src/kitlib/run.ts";
import { fixtureDeadlineS, runFixtureAsync } from "../tests/cli/fixture-process.ts";
import { briefContract, briefTargets, checkTaskBrief, renderBrief } from "../src/brief.ts";
import { loadSpawnModelRuntime } from "../src/spawn-model.ts";
import type { SpawnModelIdentity } from "../src/spawn-model.ts";

let freshSeq = 0;
/** A unique empty child dir under an owned parent; the parent's cleanup removes it. */
function freshDir(parent: string, prefix: string): string {
	const dir = join(parent, `${prefix}${process.pid}-${++freshSeq}`);
	mkdirSync(dir);
	return dir;
}

const base = ownedTmp("kit-flywheel-guard").path;

afterAll(() => {
	rmSync(base, { recursive: true, force: true });
});


function identityHome(project: string, paneKey: string, content: string): string {
	const home = freshDir(base, "home-");
	const hash = createHash("sha1").update(project).digest("hex").slice(0, 12);
	const dir = join(home, ".config", "agent-mail", "identity", hash);
	mkdirSync(dir, { recursive: true });
	writeFileSync(join(dir, paneKey), content);
	return home;
}

type BeadComment = { author: string; text: string };

function bead(id: string, assignee: string | null, createdBy: string | null = null, comments: BeadComment[] = []): FlywheelExecResult {
	return {
		stdout: JSON.stringify([{ id, title: "t", status: "in_progress", assignee, created_by: createdBy, comments }]),
		stderr: "",
		code: 0,
	};
}

/** tmux has no composite key; `br show` answers from a table, misses shaped like br 0.7.4 (JSON error on stdout, tracing on stderr). */
function brTable(table: Record<string, FlywheelExecResult>): Responder {
	return call => {
		if (call.command === "tmux") return { stdout: "", stderr: "no server", code: 1 };
		// LINTEVERY1: the bead-lint helper (`env ... python3 br-*-lint.py`) answers lint-clean here.
		if (call.command === "env") return { stdout: "", stderr: "", code: 0 };
		const id = call.args[1] ?? "";
		return table[id] ?? {
			stdout: JSON.stringify({ error: { code: "ISSUE_NOT_FOUND", message: `Issue not found: ${id}` } }),
			stderr: "2026-10-09T20:42:45Z  INFO fsqlite::runtime: event=\"region_closed\"\n",
			code: 3,
		};
	};
}


// Human questions remain native tool interactions, independent of roster role.

async function askSeat(name?: string, roster: unknown = {
	chiefs: { lead: "PeachLeopard", peers: ["QuietBadger"] },
	sessions: { "omp-test": { seats: {
		SilverCondor: { role: "builder" }, JadeThrush: { role: "grader" }, RusticPine: { role: "director" },
	} } },
}, held = true, input: unknown = { question: "Which option?" }, mode?: string) {
	const home = freshDir(base, "ask-home-");
	const dir = join(home, ".config", "omp-kit");
	mkdirSync(dir, { recursive: true });
	if (roster !== null) writeFileSync(join(dir, "fleet-roster.json"), typeof roster === "string" ? roster : JSON.stringify(roster));
	const h = await createFlywheelHost(base, { home, env: name ? { AGENT_NAME: name } : {}, respond: () => ({
		code: 0, stdout: JSON.stringify(held ? [{ id: "ompkit-worker-task", status: "in_progress", assignee: name }] : []),
	}) });
	const entries = mode === undefined ? [] : [{ type: "mode_change", mode: "goal" }, { type: "message" }, { type: "mode_change", mode }];
	const ctx = { ...h.ctx(base), sessionManager: { getEntries: () => entries } };
	const [result] = await h.emit("tool_call", { toolCallId: "ask-1", toolName: "ask", input }, ctx);
	return { h, result: result as FlywheelToolCallResult | undefined };
}


const withDefault = { questions: [
	{ id: "a", question: "Scope?", options: [{ label: "Narrow" }, { label: "Wide" }] },
	{ id: "b", question: "Busy-seat send verdict?", options: [{ label: "Drop" }, { label: "Queue and retry" }], recommended: 1 },
] };

// --- COMPACTION_REREAD ---------------------------------------------------

function stockRepo(parent = base): string {
	const cwd = freshDir(parent, "stock-repo-");
	const git = runSync(["git", "init", "--quiet", "--template=", cwd], {
		deadline_s: fixtureDeadlineS(),
		env: { PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: base, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null" },
	});
	if (git.rc !== 0) throw new Error(new TextDecoder().decode(git.stderr));
	return cwd;
}

function brPath(cwd: string): string {
	const bin = join(cwd, "bin");
	mkdirSync(bin);
	// An executable PATH entry is enough for discovery; these tests never run it.
	symlinkSync(process.execPath, join(bin, "br"));
	return bin;
}

test("stock compaction: a git repo without AGENTS.md or br remains editable and summarizes nothing held", async () => {
	const cwd = stockRepo();
	const h = await createFlywheelHost(base, { env: { PATH: join(cwd, "no-tools") } });
	await h.emit("session_compact", {}, h.ctx(cwd));
	for (const [tool, input] of [
		["edit", { path: "f.ts", diff: "+x" }],
		["write", { path: "f.ts", content: "x" }],
		["bash", { command: "git commit -m change" }],
	] as const) {
		expect(await callAs(h, cwd, tool, tool, input)).toEqual([undefined]);
	}
	expect(h.sent).toHaveLength(1);
	expect(h.sent[0]!.message.content).toContain("none found");
	expect(h.sent[0]!.message.content).toContain("none held");
});

test("EXPORTINDEX1 quiet control: own git stays allowed inside nested hermetic scratch with a gitless export root", async () => {
	const exported = freshDir(base, "gitless-export-");
	const nested = join(exported, "var", "agent-tmp", "suite-hermetic", "kit-flywheel-guard");
	mkdirSync(nested, { recursive: true });
	const cwd = stockRepo(nested);
	expect(existsSync(join(exported, ".git"))).toBe(false);
	const h = await createFlywheelHost(base, { env: { GIT_CEILING_DIRECTORIES: exported } });
	const result = await toolCall(h, cwd, "git commit -m local");
	expect(result?.block).not.toBe(true);
	expect(h.execs.some(call => call.command === "env" && call.args.includes("--git-common-dir"))).toBe(true);
});

test("COMPACTION_REREAD: session_compact summarizes the nearest AGENTS.md", async () => {
	const root = freshDir(base, "proj-");
	const repo = join(root, "repo");
	const cwd = join(repo, "pkg", "deep");
	mkdirSync(cwd, { recursive: true });
	writeFileSync(join(root, "AGENTS.md"), "outer\n");
	writeFileSync(join(repo, "AGENTS.md"), "inner\n");
	mkdirSync(join(repo, ".beads"));
	const h = await createFlywheelHost(base, { env: { PATH: brPath(repo) } });
	await h.emit("session_compact", { compactionEntry: { type: "compaction", id: "e1" }, fromExtension: false }, h.ctx(cwd));
	expect(h.sent.length).toBe(1);
	const { message, options } = h.sent[0]!;
	expect(message.content).toContain(join(repo, "AGENTS.md"));
	expect(message.content).not.toContain(join(root, "AGENTS.md"));
	expect(message.content).toContain("none held");
	expect(h.execs).toEqual([]);
	expect(message.details).toEqual({ behavior: "COMPACTION_REREAD" });
	expect(options?.deliverAs).toBe("nextTurn");
});

test("COMPACTION_REREAD: mid-run compaction injects at the next step boundary and names the pane identity", async () => {
	const cwd = freshDir(base, "proj-");
	writeFileSync(join(cwd, "AGENTS.md"), "rules\n");
	const home = identityHome(cwd, "41", "{\"name\":\"AmberHeron\"}");
	mkdirSync(join(cwd, ".beads"));
	const h = await createFlywheelHost(base, { env: { PATH: brPath(cwd), TMUX_PANE: "%41" }, home, respond: brTable({}) });
	await h.emit("session_compact", { compactionEntry: {}, fromExtension: false }, h.ctx(cwd, false));
	expect(h.sent.length).toBe(1);
	expect(h.sent[0]!.options?.deliverAs).toBe("aside");
	expect(h.sent[0]!.message.content).toContain("AmberHeron");
});

test("COMPACTION_REREAD negative: an ordinary turn emits nothing", async () => {
	const cwd = freshDir(base, "proj-");
	writeFileSync(join(cwd, "AGENTS.md"), "rules\n");
	const h = await createFlywheelHost(base);
	const c = h.ctx(cwd);
	for (const type of ["session_start", "turn_start", "message_start", "message_end", "turn_end", "agent_end"]) await h.emit(type, {}, c);
	expect(await toolCall(h, cwd, "ls -la && git status --short")).toBeUndefined();
	expect(h.sent).toEqual([]);
	expect(h.execs).toEqual([]);
});

// --- EXPORTINDEX1 ---------------------------------------------------------

async function exportIndexFixture() {
	const project = freshDir(base, "export-index-");
	const exported = join(project, "var", "agent-tmp", "manual-export", "src");
	mkdirSync(exported, { recursive: true });
	const env: Record<string, string> = {
		PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: base,
		GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null",
		GIT_AUTHOR_NAME: "Fixture", GIT_AUTHOR_EMAIL: "fixture@example.invalid",
		GIT_COMMITTER_NAME: "Fixture", GIT_COMMITTER_EMAIL: "fixture@example.invalid",
	};
	const execute = async (argv: string[], cwd = project) => {
		const result = await run(argv, { cwd, env, deadline_s: fixtureDeadlineS(), max_output_bytes: 65536 });
		return { code: result.rc ?? -1, stdout: new TextDecoder().decode(result.stdout), stderr: new TextDecoder().decode(result.stderr) };
	};
	const git = async (args: string[], cwd = project) => {
		const result = await execute(["git", "-c", "core.hooksPath=/dev/null", ...args], cwd);
		expect(result.code, result.stderr).toBe(0);
		return result.stdout.trim();
	};
	await git(["init", "-q"]);
	writeFileSync(join(project, "tracked.txt"), "committed\n");
	await git(["add", "--", "tracked.txt"]);
	await git(["commit", "-qm", "fixture"]);
	writeFileSync(join(project, "tracked.txt"), "staged work that read-tree must not drop\n");
	await git(["add", "--", "tracked.txt"]);
	const index = readFileSync(join(project, ".git", "index"));
	const head = await git(["rev-parse", "HEAD"]);
	const h = await createFlywheelHost(base, { env, respond: call => execute([call.command, ...call.args], call.options?.cwd ?? project) });
	return { project, exported, git, execute, index, head, h };
}

test("EXPORTINDEX1 planted: export git mutations are refused before the shared index or refs change", async () => {
	const f = await exportIndexFixture();
	for (const verb of ["read-tree HEAD", "update-index --refresh", "add tracked.txt", "commit -m bad", "reset HEAD",
		"checkout HEAD", "restore --staged tracked.txt", "stash", "update-ref refs/heads/main HEAD"]) {
		const result = await toolCall(f.h, f.exported, `git ${verb}`);
		expect(result?.block, verb).toBe(true);
		expect(result?.reason).toContain("EXPORT_INDEX_REFUSED");
	}
	for (const command of [
		`git -C '${f.exported}' read-tree HEAD`,
		`cd '${f.exported}' && git read-tree HEAD`,
		`env GIT_OBJECT_DIRECTORY='${f.project}/.git/objects' sh -c "cd '${f.exported}' && git read-tree HEAD"`,
	]) expect((await toolCall(f.h, f.project, command))?.reason, command).toContain("EXPORT_INDEX_REFUSED");
	expect((await bashInput(f.h, { command: "git read-tree HEAD", cwd: f.exported }))?.reason).toContain("EXPORT_INDEX_REFUSED");
	expect(readFileSync(join(f.project, ".git", "index"))).toEqual(f.index);
	expect(await f.git(["rev-parse", "HEAD"])).toBe(f.head);
});

test("EXPORTINDEX1 controls: checkout root, read-only export git, own git init and ceiling stay allowed", async () => {
	const f = await exportIndexFixture();
	expect((await toolCall(f.h, f.project, "git read-tree HEAD"))?.block).not.toBe(true);
	for (const args of [["status", "--short"], ["log", "-1", "--oneline"], ["show", "HEAD:tracked.txt"],
		["branch", "--show-current"], ["tag", "--list"], ["symbolic-ref", "HEAD"], ["reflog", "show"],
		["worktree", "list"], ["notes", "list"], ["stash", "list"]]) {
		expect((await toolCall(f.h, f.exported, `git ${args.join(" ")}`))?.block).not.toBe(true);
		await f.git(args, f.exported);
	}
	const ceiling = `GIT_CEILING_DIRECTORIES='${join(f.project, "var", "agent-tmp", "manual-export")}'`;
	expect((await toolCall(f.h, f.exported, `${ceiling} git read-tree HEAD`))?.block).not.toBe(true);
	const stopped = await f.execute(["env", ceiling.replaceAll("'", ""), "git", "read-tree", "HEAD"], f.exported);
	expect(stopped.code).not.toBe(0);
	expect(stopped.stderr).toContain("not a git repository");
	await f.git(["init", "-q"], f.exported);
	await f.git(["commit", "--allow-empty", "-qm", "local"], f.exported);
	expect((await toolCall(f.h, f.exported, "git read-tree HEAD"))?.block).not.toBe(true);
	await f.git(["read-tree", "HEAD"], f.exported);
	expect(readFileSync(join(f.project, ".git", "index"))).toEqual(f.index);
});

test("EXPORTINDEX1 planted: own .git and a ceiling never authorize explicit outside git/index overrides", async () => {
	const f = await exportIndexFixture();
	await f.git(["init", "-q"], f.exported);
	symlinkSync(join(f.project, ".git"), join(f.exported, "outside-index"));
	for (const command of [
		`GIT_DIR='${f.project}/.git' git read-tree HEAD`,
		`git --git-dir='${f.project}/.git' read-tree HEAD`,
		`GIT_INDEX_FILE='${f.project}/.git/index' git read-tree HEAD`,
		`GIT_INDEX_FILE='${f.exported}/outside-index/index' git read-tree HEAD`,
		`GIT_COMMON_DIR='${f.project}/.git' git read-tree HEAD`,
		`GIT_CEILING_DIRECTORIES='${f.exported}' GIT_DIR='${f.project}/.git' git read-tree HEAD`,
		"GIT_DIR=$PARENT_GIT_DIR git read-tree HEAD",
		"git --git-dir=$PARENT_GIT_DIR read-tree HEAD",
		"GIT_DIR=~/outside-checkout/.git git read-tree HEAD",
	]) expect((await toolCall(f.h, f.exported, command))?.reason, command).toContain("EXPORT_INDEX_REFUSED");
	expect(readFileSync(join(f.project, ".git", "index"))).toEqual(f.index);
});

// --- CLONEGUARD1 ----------------------------------------------------------

/** A checkout `repo` beside a sibling `companion`, each with only a `.git/config` naming its origin. */
async function cloneGuardFixture() {
	const parent = freshDir(base, "clone-guard-");
	const project = join(parent, "repo");
	for (const [dir, origin] of [[project, "https://github.com/JYeswak/omp-kit"], [join(parent, "companion"), "git@github.com:JYeswak/omp-kit-companion.git"]] as const) {
		mkdirSync(join(dir, ".git"), { recursive: true });
		writeFileSync(join(dir, ".git", "config"), `[core]\n\tbare = false\n[remote "upstream"]\n\turl = https://github.com/someone/other\n[remote "origin"]\n\turl = ${origin}\n\tfetch = +refs/heads/*:refs/remotes/origin/*\n`);
	}
	const scratch = join(project, "var", "agent-tmp", "a.1");
	mkdirSync(join(scratch, "fixture"), { recursive: true });
	mkdirSync(join(scratch, "f"), { recursive: true });
	const h = await createFlywheelHost(base, { env: { TMPDIR: scratch }, respond: () => ({ code: 128, stdout: "", stderr: "fatal: not a git repository" }) });
	return { project, scratch, h };
}

test("CLONEGUARD1 planted: a clone or fetch of an outside repository into scratch is refused, naming the alternatives", async () => {
	const f = await cloneGuardFixture();
	for (const command of [
		"git clone --shared /Users/x/repo var/agent-tmp/a.1/c",
		"cd var/agent-tmp/a.1 && git clone --shared /Users/x/repo c",
		"cd var/agent-tmp/a.1 && git clone /Users/x/repo.git",
		"git clone --reference /Users/x/repo --local /Users/x/repo var/agent-tmp/a.1/l",
		"git clone -b main --mirror -- /Users/x/repo var/agent-tmp/a.1/m",
		"git -C var/agent-tmp/a.1 clone file:///Users/x/repo c",
		"env GIT_TRACE=0 sh -c 'cd var/agent-tmp/a.1 && git clone --shared /Users/x/repo c'",
		"git clone --shared /Users/x/repo \"$TMPDIR/c\"",
		"export SCRATCH=var/agent-tmp/a.1; git clone /Users/x/repo $SCRATCH/c",
		"git clone /Users/x/repo \"$(mktemp -d var/agent-tmp/a.1/x.XXXX)\"",
		"git clone https://github.com/JYeswak/omp-kit-companion.git var/agent-tmp/a.1/x",
		"git clone --depth 1 ssh://git@GitHub.com:22/JYeswak/omp-kit-companion/ var/agent-tmp/a.1/x2",
		"cd var/agent-tmp/a.1/f && git clone git@github.com:JYeswak/omp-kit var/agent-tmp/a.1/own",
		"cd var/agent-tmp/a.1/f && git fetch /Users/x/repo main",
		"cd var/agent-tmp/a.1/f && git pull ../../../../outside main",
	]) {
		const result = await toolCall(f.h, f.project, command);
		expect(result?.block, command).toBe(true);
		expect(result?.reason, command).toContain("CLONEGUARD1");
		expect(result?.reason, command).toContain("omp-kit scratch new --export <sha>");
		expect(result?.reason, command).toContain("git init");
		expect(result?.reason, command).toContain("UNVERIFIED");
	}
});

test("CLONEGUARD1 controls: same-scratch fixture clones, git init, clones outside scratch and remote-name fetches stay admitted", async () => {
	const f = await cloneGuardFixture();
	for (const command of [
		"git clone var/agent-tmp/a.1/fixture var/agent-tmp/a.1/c2",
		"cd var/agent-tmp/a.1 && git clone --shared fixture c3",
		"git clone \"$TMPDIR/fixture\" \"$TMPDIR/c4\"",
		"git init var/agent-tmp/a.1/f",
		"cd var/agent-tmp/a.1 && git init -q new-fixture",
		"git clone https://github.com/x/repo /Users/x/Developer/repo",
		"git clone /Users/x/repo /Users/x/copy",
		"git clone --help",
		"git clone https://github.com/someone/other var/agent-tmp/a.1/y",
		"git clone git@gitlab.com:JYeswak/omp-kit-companion.git var/agent-tmp/a.1/other-host",
	]) {
		const result = await toolCall(f.h, f.project, command);
		expect(result?.block === true ? result.reason : "admitted", command).toBe("admitted");
	}
	for (const command of ["cd var/agent-tmp/a.1/f && git fetch origin", "cd var/agent-tmp/a.1/f && git log -1"]) {
		expect((await toolCall(f.h, f.project, command))?.reason ?? "", command).not.toContain("CLONEGUARD1");
	}
	// Bounded: 16 KiB colon-laden, slash-laden and `$`-laden near-miss words parse in linear time.
	const started = performance.now();
	for (const command of [
		`git clone ${"a:".repeat(8192)} /Users/x/elsewhere${"$a".repeat(4096)}`,
		`git clone ${"a:".repeat(8192)} var/agent-tmp/a.1/z`,
		`git clone https://h/${"/".repeat(16000)}x var/agent-tmp/a.1/z2`,
	]) {
		const long = await toolCall(f.h, f.project, command);
		expect(long?.block === true ? long.reason : "admitted").toBe("admitted");
	}
	const elapsed = performance.now() - started;
	console.log(`CLONEGUARD1 three 16 KiB near-misses: ${elapsed.toFixed(3)} ms`);
	expect(elapsed).toBeLessThan(fixtureDeadlineS(1) * 1000);
});

test("CLONEGUARD1 remote normalization: scp, ssh and https forms of one repository compare equal", () => {
	for (const url of ["git@github.com:JYeswak/omp-kit-companion.git", "https://GitHub.com/JYeswak/omp-kit-companion", "ssh://git@github.com:22/JYeswak/omp-kit-companion.git/", "https://user@github.com/JYeswak/omp-kit-companion.git"]) {
		expect(normalizeRemoteUrl(url), url).toBe("github.com/JYeswak/omp-kit-companion");
	}
	for (const url of ["/Users/x/repo", "./repo", "file:///Users/x/repo", "https://github.com", "relative/a:b"]) expect(normalizeRemoteUrl(url), url).toBeUndefined();
	expect(normalizeRemoteUrl("https://github.com/JYeswak/Other")).not.toBe(normalizeRemoteUrl("https://github.com/JYeswak/other"));
});

// --- SELF_CLOSE_REFUSED --------------------------------------------------

test("SELF_CLOSE_REFUSED planted: a seat's non-author background verifier cannot close that seat's bead", async () => {
	const project = freshDir(base, "subagent-close-");
	for (const seat of ["PeachLeopard", "IndependentSeat"]) {
		const h = await createFlywheelHost(base, { env: { AGENT_NAME: seat },
			respond: brTable({ "kit-parent": bead("kit-parent", "PeachLeopard", "PeachLeopard") }) });
		const [raw] = await h.emit("tool_call", { toolCallId: "subagent-close", toolName: "bash",
			input: { command: "br close kit-parent --actor SpawnVerifier --reason 'verified export abcdef123456'" } },
		{ ...h.ctx(project), agent: { kind: "sub" } });
		const result = raw as FlywheelToolCallResult | undefined;
		if (seat === "PeachLeopard") {
			expect(result?.block).toBe(true);
			expect(result?.reason).toContain("SELF_CLOSE_REFUSED");
			expect(result?.reason).toContain("PeachLeopard");
		} else expect(result?.block).not.toBe(true);
	}
});

test("SELF_CLOSE_REFUSED: closing a bead assigned to the caller's pane identity is blocked", async () => {
	const project = freshDir(base, "proj-");
	const tracker = join(project, "tracker");
	mkdirSync(tracker);
	const home = identityHome(project, "77", "{\"name\":\"BlueFox\"}");
	const h = await createFlywheelHost(base, { env: { TMUX_PANE: "%77" }, home, respond: brTable({ "kit-1": bead("kit-1", "BlueFox") }) });
	const result = await toolCall(h, project, "cd tracker && br close kit-1 --reason \"done, tests pass\"");
	expect(result?.block).toBe(true);
	expect(result?.reason).toContain("SELF_CLOSE_REFUSED");
	expect(result?.reason).toContain("kit-1 is assigned to BlueFox");
});

test("SELF_CLOSE_REFUSED: bd close, composite pane key and plain-text identity file are honoured", async () => {
	const project = freshDir(base, "proj-");
	const home = identityHome(project, "fleet-0-3", "GreenLynx\n");
	const respond: Responder = call => call.command === "tmux"
		? { stdout: "fleet:0:3\n", stderr: "", code: 0 }
		: bead("kit-2", "GreenLynx");
	const h = await createFlywheelHost(base, { env: { TMUX_PANE: "%90" }, home, respond });
	const result = await toolCall(h, project, "bd close kit-2");
	expect(result?.block).toBe(true);
});

test("SELF_CLOSE_REFUSED: --actor, BR_ACTOR and BR_AGENT_NAME identify the caller", async () => {
	const project = freshDir(base, "proj-");
	const table = brTable({ "kit-3": bead("kit-3", "RedOwl") });
	const flag = await createFlywheelHost(base, { respond: table });
	expect((await toolCall(flag, project, "br --actor RedOwl close kit-3"))?.block).toBe(true);
	const inline = await createFlywheelHost(base, { respond: table });
	expect((await toolCall(inline, project, "BR_ACTOR=RedOwl br close kit-3"))?.block).toBe(true);
	const env = await createFlywheelHost(base, { env: { BR_AGENT_NAME: "RedOwl" }, respond: table });
	expect((await toolCall(env, project, "br close --db .beads/beads.db kit-3"))?.block).toBe(true);
});

test("SELF_CLOSE_REFUSED negative: a different closer is allowed silently", async () => {
	const project = freshDir(base, "proj-");
	const home = identityHome(project, "77", "{\"name\":\"Director\"}");
	const h = await createFlywheelHost(base, { env: { TMUX_PANE: "%77" }, home, respond: brTable({ "kit-1": bead("kit-1", "BlueFox") }) });
	expect(await toolCall(h, project, "br close kit-1 --reason \"bun test extensions/kit-flywheel-guard.test.ts -> 26 passed\"")).toBeUndefined();
	expect(h.notices).toEqual([]);
});


// --- FILERCLOSE1 ---------------------------------------------------------

test("FILERCLOSE1: the bead filer cannot close their own bead", async () => {
	const project = freshDir(base, "proj-");
	const h = await createFlywheelHost(base, { respond: brTable({ "kit-filer": bead("kit-filer", "Builder", "Filer") }) });
	const result = await toolCall(h, project, "br --actor Filer close kit-filer --reason \"ev_filerclose1\"");
	expect(result?.block).toBe(true);
	expect(result?.reason).toContain("SELF_CLOSE_REFUSED");
	expect(result?.reason).toContain("Filer");
});

test("FILERCLOSE1: every DONE-first commenter is treated as an author", async () => {
	const comments = [
		{ author: "FirstDone", text: "DONE first evidence" },
		{ author: "SecondDone", text: "  DONE second evidence" },
	];
	for (const actor of ["FirstDone", "SecondDone"]) {
		const project = freshDir(base, "proj-");
		const h = await createFlywheelHost(base, { respond: brTable({ "kit-done": bead("kit-done", "Builder", "Filer", comments) }) });
		const result = await toolCall(h, project, `br --actor ${actor} close kit-done --reason "ev_filerclose1"`);
		expect(result?.block).toBe(true);
		expect(result?.reason).toContain("SELF_CLOSE_REFUSED");
		expect(result?.reason).toContain(actor);
	}
});

test("FILERCLOSE1 control: a non-author can close with evidence", async () => {
	const project = freshDir(base, "proj-");
	const h = await createFlywheelHost(base, { respond: brTable({ "kit-independent": bead("kit-independent", "Builder", "Filer", [
		{ author: "DoneAuthor", text: "DONE validated" },
	]) }) });
	expect(await toolCall(h, project, "br --actor Verifier close kit-independent --reason \"ev_filerclose1\"")).toBeUndefined();
});

test("FILERCLOSE1 control: an ordinary commenter is not a DONE author", async () => {
	const project = freshDir(base, "proj-");
	const h = await createFlywheelHost(base, { respond: brTable({ "kit-comment": bead("kit-comment", "Builder", "Filer", [
		{ author: "Commenter", text: "Progress update" },
	]) }) });
	expect(await toolCall(h, project, "br --actor Commenter close kit-comment --reason \"ev_filerclose1\"")).toBeUndefined();
});

test("FILERCLOSE1: incomplete author metadata refuses a close", async () => {
	const project = freshDir(base, "proj-");
	const incomplete: FlywheelExecResult = {
		stdout: JSON.stringify([{ id: "kit-incomplete", title: "t", status: "in_progress", assignee: "Builder" }]),
		stderr: "",
		code: 0,
	};
	const h = await createFlywheelHost(base, { respond: brTable({ "kit-incomplete": incomplete }) });
	const result = await toolCall(h, project, "br --actor Verifier close kit-incomplete --reason \"ev_filerclose1\"");
	expect(result?.block).toBe(true);
	expect(result?.reason).toContain("SELF_CLOSE_REFUSED");
	expect(result?.reason).toContain("authorship");
});

// --- NARROWCLOSE1 --------------------------------------------------------

for (const reason of [
	"LIMITS: AC1's literal 900 s case was not run",
	"box 2 UNVERIFIED",
	"AC1 PASS; LIMITS: original boundary case not run",
	"Acceptance case 3 was not tested",
	"The original live test was skipped",
	"AC2 is carried as a limit",
	"no UNVERIFIED boxes, but AC2 was not run",
]) {
	test(`NARROWCLOSE1: incomplete evidence refuses close: ${reason}`, async () => {
		const project = freshDir(base, "proj-");
		const h = await createFlywheelHost(base, { respond: brTable({ "kit-narrow": bead("kit-narrow", "Builder", "Filer") }) });
		const result = await toolCall(h, project, `br --actor Verifier close kit-narrow --reason ${JSON.stringify(reason)}`);
		expect(result?.block).toBe(true);
		expect(result?.reason).toContain("NARROW_CLOSE_REFUSED");
		expect(result?.reason).toContain("kit-narrow");
		expect(result?.reason).toContain(reason.slice(reason.lastIndexOf(";") + 1).trim());
	});
}

test("NARROWCLOSE1: closing through update --status closed cannot bypass the evidence refusal", async () => {
	const project = freshDir(base, "proj-");
	const h = await createFlywheelHost(base, { respond: brTable({ "kit-narrow": bead("kit-narrow", "Builder", "Filer") }) });
	const result = await toolCall(h, project, "br --actor Verifier update kit-narrow --status closed --reason=\"box 2 UNVERIFIED\"");
	expect(result?.block).toBe(true);
	expect(result?.reason).toContain("NARROW_CLOSE_REFUSED");
	expect(result?.reason).toContain("box 2 UNVERIFIED");
});

test("NARROWCLOSE1: a wrapped incomplete-check clause cannot bypass refusal", async () => {
	const project = freshDir(base, "proj-");
	const h = await createFlywheelHost(base, { respond: brTable({ "kit-narrow": bead("kit-narrow", "Builder", "Filer") }) });
	const result = await toolCall(h, project, "br --actor Verifier close kit-narrow --reason 'AC1 was not\nrun'");
	expect(result?.block).toBe(true);
	expect(result?.reason).toContain("NARROW_CLOSE_REFUSED");
	expect(result?.reason).toContain("AC1 was not\nrun");
});

for (const reason of [
	"AC1 PASS; box 2 PASS; all original acceptance cases ran",
	"All acceptance cases PASS; no UNVERIFIED boxes and zero tests skipped",
	"AC1 PASS; every original case executed; 0 skipped",
]) {
	test(`NARROWCLOSE1 control: completed evidence permits independent close: ${reason}`, async () => {
		const project = freshDir(base, "proj-");
		const h = await createFlywheelHost(base, { respond: brTable({ "kit-complete": bead("kit-complete", "Builder", "Filer") }) });
		expect(await toolCall(h, project, `br --actor Verifier close kit-complete --reason ${JSON.stringify(reason)}`)).toBeUndefined();
	});
}

test("NARROWCLOSE1: matcher removal permits the original incomplete closes", async () => {
	const reasons = [
		"AC1's literal 900 s case was not run",
		"box 2 UNVERIFIED",
		"LIMITS: original boundary case not run",
		"AC1 PASS; every original case executed; 0 skipped",
	];
	const moduleUrl = new URL("./kit-flywheel-guard.ts", import.meta.url).href;
	const script = `
		import { plugin } from "bun";
		let applied = false;
		plugin({ name: "narrowclose1-mutant", setup(build) {
			build.onLoad({ filter: /kit-flywheel-guard[.]ts$/ }, async ({ path }) => {
				const source = await Bun.file(path).text();
				const site = "const incomplete = incompleteCloseClause(request.reason);";
				if (source.split(site).length !== 2) throw new Error("MUTATION_SITE_NOT_UNIQUE");
				applied = true;
				return { contents: source.replace(site, "const incomplete = null;"), loader: "ts" };
			});
		}});
		// Loading-boundary test: a static import would run before the mutation plugin.
		const { checkTrackerMutations } = await import(${JSON.stringify(moduleUrl)});
		const deps = { env: {}, home: process.cwd(), sessionCwd: process.cwd(),
			exec: async () => ({ code: 0, stderr: "", stdout: JSON.stringify([{
				id: "fixture-close", status: "in_review", assignee: "Builder", created_by: "Filer", comments: [],
			}]) }),
		};
		const results = [];
		for (const reason of ${JSON.stringify(reasons)}) {
			const command = "br --actor Verifier close fixture-close --reason " + JSON.stringify(reason);
			const verdict = await checkTrackerMutations({ toolName: "bash", input: { command } }, deps);
			results.push({ reason, blocked: verdict?.block === true });
		}
		console.log(JSON.stringify({ applied, results }));
	`;
	const result = await run([process.execPath, "--eval", script], {
		cwd: process.cwd(), deadline_s: 60, max_output_bytes: 65536,
	});
	expect(result.rc).toBe(0);
	expect(JSON.parse(new TextDecoder().decode(result.stdout))).toEqual({
		applied: true, results: reasons.map(reason => ({ reason, blocked: false })),
	});
});

// GATEEVENTS1 (ompkit-fp72.135.3.12): the guard's verdict on a tracker act lands in the gate-events ledger under the
// host's state dir, refusal and pass alike, so refusal chains and first-attempt success are measured.
test("GATEEVENTS1: a refused close writes a refuse row and an allowed close writes a pass row; planted: a plain bash call writes nothing", async () => {
	const project = freshDir(base, "proj-");
	const home = identityHome(project, "77", "{\"name\":\"BlueFox\"}");
	const state = join(home, "state");
	const h = await createFlywheelHost(base, { env: { TMUX_PANE: "%77", XDG_STATE_HOME: state }, home, respond: brTable({ "kit-1": bead("kit-1", "BlueFox"), "kit-9": bead("kit-9", "Someone") }) });
	expect((await toolCall(h, project, "cd tracker && br close kit-1 --reason \"x\""))?.block).toBe(true);
	expect(await toolCall(h, project, "br close kit-9 --reason \"bun test x -> 3 passed\"")).toBeUndefined();
	expect(await toolCall(h, project, "ls -la")).toBeUndefined();
	const rows = readFileSync(join(state, "omp-kit", "gate-events.jsonl"), "utf8").trim().split("\n").map(line => JSON.parse(line));
	expect(rows.map(r => [r.act, r.target, r.gate, r.kind, r.seat])).toEqual([
		["close", "kit-1", "SELF_CLOSE_REFUSED", "refuse", "BlueFox"],
		["close", "kit-9", "kit-flywheel-guard", "pass", "BlueFox"],
	]);
});

test("SELF_CLOSE_REFUSED negative: an unassigned bead is allowed with a warning", async () => {
	const project = freshDir(base, "proj-");
	const home = identityHome(project, "77", "{\"name\":\"BlueFox\"}");
	const h = await createFlywheelHost(base, { env: { TMUX_PANE: "%77" }, home, respond: brTable({ "kit-4": bead("kit-4", null) }) });
	const result = await toolCall(h, project, "br close kit-4");
	expect(result?.block).toBeUndefined();
	expect(result?.additionalContext).toContain("kit-4 has no assignee");
	expect(h.notices.length).toBe(1);
});

test("SELF_CLOSE_REFUSED: a close whose authorship probe fails is refused, never skipped (ompkit-xa5s.13)", async () => {
	const project = freshDir(base, "proj-");
	const home = identityHome(project, "77", "{\"name\":\"BlueFox\"}");
	const h = await createFlywheelHost(base, { env: { TMUX_PANE: "%77" }, home, respond: brTable({}) });
	const result = await toolCall(h, project, "br close kit-404 --reason \"bun test extensions/kit-flywheel-guard.test.ts -> 26 passed\"");
	expect(result?.block).toBe(true);
	expect(result?.reason).toContain("SELF_CLOSE_REFUSED");
	expect(result?.reason).toContain("kit-404");
	expect(result?.reason).toContain("Issue not found: kit-404");
	expect(result?.reason).toContain("no close was executed");
	const thrown = await createFlywheelHost(base, { env: { BR_ACTOR: "BlueFox" }, respond: () => { throw new Error("spawn br ENOENT"); } });
	const crashed = await toolCall(thrown, project, "br close kit-1 --reason \"bun test extensions/kit-flywheel-guard.test.ts -> 26 passed\"");
	expect(crashed?.block).toBe(true);
	expect(crashed?.reason).toContain("SELF_CLOSE_REFUSED");
});

test("SELF_CLOSE_REFUSED: garbled-probe close is refused with the s49q shape, exit 3 Issue not found (ompkit-xa5s.13)", async () => {
	const project = freshDir(base, "proj-");
	const home = identityHome(project, "77", "{\"name\":\"BlueFox\"}");
	// Planted negative replaying the jev s49q close sequence: the guard's own
	// `br show` probe ran with mangled args, exited 3, and the old code let
	// the close proceed. The probe error must refuse, never skip.
	const garbled: Responder = call => call.command === "tmux"
		? { stdout: "", stderr: "no server", code: 1 }
		: {
			stdout: JSON.stringify({ error: { code: "ISSUE_NOT_FOUND", message: "Issue not found: 2>" } }),
			stderr: "2026-10-13T00:00:00Z  INFO fsqlite::runtime: event=\"region_closed\"\n",
			code: 3,
		};
	const h = await createFlywheelHost(base, { env: { TMUX_PANE: "%77" }, home, respond: garbled });
	const result = await toolCall(h, project, "br close s49q --reason \"jevidence\"");
	expect(result?.block).toBe(true);
	expect(result?.reason).toContain("SELF_CLOSE_REFUSED");
	expect(result?.reason).toContain("s49q");
	expect(result?.reason).toContain("Issue not found: 2>");
	expect(result?.reason).not.toContain("was allowed");
});

test("SELF_CLOSE_REFUSED negative: legit non-author close of s49q by CobaltCoyote still passes (ompkit-xa5s.13)", async () => {
	const project = freshDir(base, "proj-");
	const home = identityHome(project, "77", "{\"name\":\"CobaltCoyote\"}");
	const h = await createFlywheelHost(base, { env: { TMUX_PANE: "%77" }, home, respond: brTable({ "s49q": bead("s49q", "BlueFox") }) });
	expect(await toolCall(h, project, "br close s49q --reason \"bun test extensions/kit-flywheel-guard.test.ts -> pass\"")).toBeUndefined();
	expect(h.notices).toEqual([]);
});

test("SELF_CLOSE_REFUSED negative: unknown caller identity is allowed with a warning", async () => {
	const project = freshDir(base, "proj-");
	const h = await createFlywheelHost(base, { respond: brTable({ "kit-1": bead("kit-1", "BlueFox") }) });
	const result = await toolCall(h, project, "br close kit-1");
	expect(result?.block).toBeUndefined();
	expect(result?.additionalContext).toContain("caller identity unknown");
});

test("SELF_CLOSE_REFUSED negative: close text that is not a br/bd close never consults br", async () => {
	const project = stockRepo();
	const h = await createFlywheelHost(base, { env: { BR_ACTOR: "BlueFox" }, respond: brTable({ "kit-1": bead("kit-1", "BlueFox") }) });
	for (const command of [
		"echo 'br close kit-1'",
		"git commit -m \"br close kit-1 after review\"",
		"br show kit-1 # then br close kit-1 later",
		"br update kit-1 --notes close",
		"gh issue close 12",
	]) expect(await toolCall(h, project, command)).toBeUndefined();
	// AUTOCOMPLETE1 consults git on a `git commit` (toplevel, index); br is never consulted for these texts.
	expect(h.execs.filter(e => e.command === "br" || e.command === "bd")).toEqual([]);
	const write = await h.emit("tool_call", { toolName: "write", input: { path: "x", content: "br close kit-1" } }, h.ctx(project));
	expect(write).toEqual([undefined]);
});

test("REDIRECTION_IDS: shell redirections never become bead ids (ompkit-xa5s.8)", () => {
	const ids = (command: string) => trackerRequests(command, "/tmp", "/tmp").flatMap(r => r.ids);
	expect(ids("br close real-id --reason ok")).toEqual(["real-id"]);
	expect(ids("br close real-id --reason ok 2>&1 | tail -3")).toEqual(["real-id"]);
	expect(ids("br close real-id --reason ok 2>/dev/null")).toEqual(["real-id"]);
	expect(ids("br close real-id --reason ok > out.txt")).toEqual(["real-id"]);
	expect(ids("br close real-id --reason ok 2> err.txt")).toEqual(["real-id"]);
	// Attached operators consume no following argument; only a bare operator
	// consumes the next word. A fix swallowing the second subject would skip
	// its self-close check.
	expect(ids("br close id1 2>&1 id2")).toEqual(["id1", "id2"]);
	expect(ids("br close id1 >out.txt id2")).toEqual(["id1", "id2"]);
	expect(ids("br close id1 > out.txt id2")).toEqual(["id1", "id2"]);
	expect(ids("br close id1 2>&- id2")).toEqual(["id1", "id2"]);
});

test("SELF_CLOSE_REFUSED with redirection: assignee match still blocks, lookup uses the clean id", async () => {
	const project = freshDir(base, "proj-");
	const home = identityHome(project, "77", "{\"name\":\"BlueFox\"}");
	const h = await createFlywheelHost(base, { env: { TMUX_PANE: "%77" }, home, respond: brTable({ "kit-9": bead("kit-9", "BlueFox") }) });
	const result = await toolCall(h, project, "br close kit-9 --reason ok 2>&1 | tail -3");
	expect(result?.block).toBe(true);
	expect(result?.reason).toContain("SELF_CLOSE_REFUSED");
});


test("BGDEADLINE1: finite async bash jobs reject timeout zero and accept native bounded defaults", async () => {
	const h = await createFlywheelHost(base);
	const unsafe = await bashInput(h, { command: "bun test", async: true, timeout: 0 });
	expect(unsafe?.block).toBe(true);
	expect(unsafe?.reason).toContain("FINITE_JOB_NO_DEADLINE");
	expect(unsafe?.reason).toContain("positive timeout");
	expect((await bashInput(h, { command: "cargo test", async: false, timeout: 0 }))?.block).toBe(true);
	expect((await bashInput(h, { command: "bun test", async: true, timeout: "0" }))?.reason).toContain("FINITE_JOB_DEADLINE_UNKNOWN");
	expect(await bashInput(h, { command: "bun test", async: true, timeout: 30 })).toBeUndefined();
	expect(await bashInput(h, { command: "bun test", async: true })).toBeUndefined();
	expect(h.execs).toHaveLength(0);
});

test("BGDEADLINE1: named services need readiness and cannot disguise a finite suite", async () => {
	const h = await createFlywheelHost(base);
	const finite = await bashInput(h, { command: "cargo test", name: "tests", ready: { log: "completed" } });
	expect(finite?.block).toBe(true);
	expect(finite?.reason).toContain("FINITE_SUITE_AS_SERVICE");
	const unready = await bashInput(h, { command: "bun run dev", name: "web" });
	expect(unready?.block).toBe(true);
	expect(unready?.reason).toContain("SERVICE_READINESS_REQUIRED");
	expect(await bashInput(h, { command: "bun run dev", name: "web", ready: { port: 3000 } })).toBeUndefined();
});

test("BGDEADLINE1: timeout-zero refusal attributes job, owner, command, deadline, and owner-session cancel", async () => {
	const h = await createFlywheelHost(base, { env: { BR_ACTOR: "TestOwner" } });
	const unsafe = await bashInput(h, { command: "bun test", async: true, timeout: 0 });
	expect(unsafe?.block).toBe(true);
	const reason = JSON.parse(unsafe?.reason ?? "{}");
	expect(reason.guard).toBe("kit-flywheel-guard");
	expect(reason.code).toBe("FINITE_JOB_NO_DEADLINE");
	expect(reason.job).toBe("c1");
	expect(reason.owner).toBe("TestOwner");
	expect(reason.command.sha256).toBe(createHash("sha256").update("bun test").digest("hex"));
	expect(reason.deadline).toBe(0);
	expect(reason.cancel).toContain("owning OMP session");
	expect(reason.cancel).not.toContain("kill -9");
	expect(h.execs).toHaveLength(0);
});

test("BGDEADLINE1: tool input cannot spoof the refusal owner", async () => {
	const h = await createFlywheelHost(base, { env: { BR_ACTOR: "TestOwner" } });
	const spoofed = await bashInput(h, { command: "bun test", async: true, timeout: 0, owner: "Pretender", actor: "Pretender", agent: "Pretender" });
	expect(JSON.parse(spoofed?.reason ?? "{}").owner).toBe("TestOwner");
	const anon = await createFlywheelHost(base);
	const claimed = await bashInput(anon, { command: "bun test", async: true, timeout: 0, owner: "Pretender" });
	expect(JSON.parse(claimed?.reason ?? "{}").owner).toBeNull();
});

test("BGDEADLINE1: unknown and service refusals carry job and deadline", async () => {
	const h = await createFlywheelHost(base);
	const unknown = JSON.parse((await bashInput(h, { command: "bun test", async: true, timeout: "0" }))?.reason ?? "{}");
	expect(unknown.code).toBe("FINITE_JOB_DEADLINE_UNKNOWN");
	expect(unknown.job).toBe("c1");
	expect(unknown.deadline).toBe("unknown");
	const conflict = JSON.parse((await bashInput(h, { command: "bun run dev", name: "web", ready: { port: 3000 }, timeout: 10 }))?.reason ?? "{}");
	expect(conflict.code).toBe("SERVICE_MODE_CONFLICT");
	expect(conflict.job).toBe("c1");
	expect(conflict.deadline).toBe(10);
	expect(conflict.next).toStartWith("this call sets name, which runs it as a long-lived service; for finite work drop name");
	const unready = JSON.parse((await bashInput(h, { command: "bun run dev", name: "web" }))?.reason ?? "{}");
	expect(unready.code).toBe("SERVICE_READINESS_REQUIRED");
	expect(unready.job).toBe("c1");
	expect(unready.deadline).toBeNull();
	// GUARDNAME1 planted: the finite command a codex seat labelled with `name` is told to drop it, first.
	const labelled = JSON.parse((await bashInput(h, { command: "br show ompkit-1 --json", name: "br-show", timeout: 60 }))?.reason ?? "{}");
	expect(labelled.code).toBe("SERVICE_MODE_CONFLICT");
	expect(labelled.next).toStartWith("this call sets name, which runs it as a long-lived service; for finite work drop name");
	expect(unready.next).toStartWith("this call sets name, which runs it as a long-lived service; for finite work drop name");
	expect(h.execs).toHaveLength(0);
});

// --- COMPACTION_REREAD gate (ompkit-xa5s.24) ----------------------------------

/** Compacted host whose nearest AGENTS.md is `cwd/AGENTS.md`; identity TestWorker. */
async function rereadHost(extra: string[] = [], identity: string | null = "TestWorker", respond?: Responder): Promise<{ h: FakeHost; cwd: string; agents: string }> {
	const cwd = stockRepo();
	const agents = join(cwd, "AGENTS.md");
	writeFileSync(agents, "rules\n");
	for (const name of extra) writeFileSync(join(cwd, name), "x\n");
	mkdirSync(join(cwd, ".beads"));
	const env: Record<string, string> = { PATH: brPath(cwd) };
	if (identity !== null) env.BR_ACTOR = identity;
	const h = await createFlywheelHost(base, { env, ...(respond ? { respond } : {}) });
	await h.emit("session_compact", { compactionEntry: { type: "compaction", id: "e1" }, fromExtension: false }, h.ctx(cwd));
	return { h, cwd, agents };
}

async function callAs(h: FakeHost, cwd: string, id: string, toolName: string, input: Record<string, unknown>): Promise<unknown[]> {
	return h.emit("tool_call", { toolCallId: id, toolName, input }, h.ctx(cwd));
}

test("GOAL_END_REFUSED: a fleet seat cannot drop or complete its own goal (J-2026-10-18-44)", async () => {
	const cwd = freshDir(base, "goal-");
	for (const env of [{ AGENT_NAME: "CopperTrout" }, { BR_ACTOR: "CopperTrout" }]) {
		const h = await createFlywheelHost(base, { env });
		for (const op of ["drop", "complete"]) {
			const [result] = await callAs(h, cwd, `g-${op}`, "goal", { op });
			expect((result as FlywheelToolCallResult)?.block).toBe(true);
			expect((result as FlywheelToolCallResult)?.reason).toContain("GOAL_END_REFUSED");
			expect((result as FlywheelToolCallResult)?.reason).toContain(`may not ${op} its own goal`);
			expect((result as FlywheelToolCallResult)?.reason).toContain("send one NO-WORK line to your director and end the turn");
			expect((result as FlywheelToolCallResult)?.reason).not.toContain("downtime");
		}
	}
});

test("GOAL_END_REFUSED negatives: get, create and resume pass; a session with no fleet identity may drop", async () => {
	const cwd = freshDir(base, "goal-");
	const seat = await createFlywheelHost(base, { env: { AGENT_NAME: "CopperTrout" } });
	for (const input of [{ op: "get" }, { op: "create", objective: "x" }, { op: "resume" }]) {
		expect(await callAs(seat, cwd, `g-${input.op}`, "goal", input)).toEqual([undefined]);
	}
	const person = await createFlywheelHost(base, { env: {} });
	expect(await callAs(person, cwd, "g-drop", "goal", { op: "drop" })).toEqual([undefined]);
	expect(await callAs(seat, cwd, "b-drop", "bash", { command: "echo goal drop" })).toEqual([undefined]);
});

test("GOAL_SEND_REFUSED: a fleet seat cannot type a /goal line into any pane, bare or wrapped (J-2026-10-18-45)", async () => {
	const cwd = freshDir(base, "goal-");
	const h = await createFlywheelHost(base, { env: { AGENT_NAME: "RusticPine" } });
	for (const command of [
		"tern send 5 paste '/goal set Do whatever I like'",
		"tern send 5 text \"/goal drop\"",
		"AGENT_NAME=X env tern send 1756641624117 paste '  /GOAL set x' && tern send 1756641624117 keys Enter",
		"bash -lc \"tern send 5 paste '/goal set x'\"",
		"omp-kit send omp-test 2 '/goal set x'",
		"ntm send fleet --pane 2 '/goal x'",
	]) {
		const [result] = await callAs(h, cwd, "s", "bash", { command });
		expect((result as FlywheelToolCallResult)?.block).toBe(true);
		expect((result as FlywheelToolCallResult)?.reason).toContain("GOAL_SEND_REFUSED");
	}
});

test("GOAL_SEND_REFUSED negatives: arm_seat, ordinary sends, mentions and identity-less sessions pass", async () => {
	const cwd = freshDir(base, "goal-");
	const seat = await createFlywheelHost(base, { env: { AGENT_NAME: "RusticPine" } });
	for (const command of [
		"python3 ~/.claude/skills/omp-kit-orchestration/scripts/arm_seat.py --session omp-test --block 4117 --version 18 --set --apply",
		"tern send 5 paste 'please review ompkit-1 /goal is fine'",
		"tern send 5 keys Enter",
		"echo tern send 5 paste '/goal set x'",
		"grep -n '/goal set' scripts/arm_seat.py",
	]) {
		expect(await callAs(seat, cwd, "s", "bash", { command })).toEqual([undefined]);
	}
	const person = await createFlywheelHost(base, { env: {} });
	expect(await callAs(person, cwd, "s", "bash", { command: "tern send 5 paste '/goal set x'" })).toEqual([undefined]);
});


test("shell -c flag pattern: matches -c and -lc, rejects --c and -cx, and stays linear on a long near-miss", () => {
	const flag = /^-[A-Za-z]*c$/;
	expect(["-c", "-lc", "-ec"].every(word => flag.test(word))).toBe(true);
	expect(["--c", "-cx", "c", "-l"].some(word => flag.test(word))).toBe(false);
	const nearMiss = "-" + "a".repeat(200_000) + "x";
	const started = performance.now();
	expect(flag.test(nearMiss)).toBe(false);
	expect(performance.now() - started).toBeLessThan(50);
});

// --- COMPACTION_REREAD summary (ompkit-j27dd): the guard rereads itself and never blocks ---

const emptyList = JSON.stringify({ issues: [], total: 0, limit: 0, offset: 0, has_more: false });
/** A `br list` responder: `list` answers per tracker cwd, everything else is benign. */
function listResponder(lists: (call: Parameters<Responder>[0]) => FlywheelExecResult): Responder {
	return call => {
		if (call.command === "tmux") return { stdout: "", stderr: "no server", code: 1 };
		if (call.command === "env") return { stdout: "", stderr: "", code: 0 };
		if (call.command === "br" && call.args[0] === "list") return lists(call);
		if (call.command === "br") return { stdout: "[]", stderr: "", code: 0 };
		return { stdout: "", stderr: "", code: 0 };
	};
}

test("COMPACTION_REREAD: no tool call is blocked after compaction", async () => {
	const { h, cwd, agents } = await rereadHost();
	expect(h.sent).toHaveLength(1);
	expect(h.sent[0]!.message.content).toContain(agents);
	for (const [tool, input] of [
		["edit", { path: "f.ts", diff: "+x" }],
		["write", { path: "f.ts", content: "x" }],
		["bash", { command: "git commit -m change" }],
		["bash", { command: "git push origin master" }],
	] as const) {
		expect(await callAs(h, cwd, tool, tool, input)).toEqual([undefined]);
	}
});

test("COMPACTION_REREAD: the reminder lists a held in_progress bead from a fixture tracker", async () => {
	const rows = { stdout: JSON.stringify([{ id: "k-1", title: "t", status: "in_progress", assignee: "TestWorker" }]), stderr: "", code: 0 };
	const { h, cwd } = await rereadHost([], "TestWorker", listResponder(() => rows));
	expect(h.sent).toHaveLength(1);
	const content = h.sent[0]!.message.content;
	expect(content).toContain("k-1");
	expect(content).toContain("in_progress");
	expect(content).toContain("t");
	const probe = h.execs.find(call => call.command === "br" && call.args[0] === "list");
	expect(probe?.args).toEqual(["list", "--assignee", "TestWorker", "--limit", "0", "--json", "--no-auto-import", "--no-auto-flush"]);
	expect(probe?.options?.timeout).toBe(FLYWHEEL_EXEC_TIMEOUT_MS);
	expect(probe?.options?.cwd).toBe(cwd);
	expect(await callAs(h, cwd, "e1", "edit", { path: "f.ts", diff: "+x" })).toEqual([undefined]);
});

test("COMPACTION_REREAD: the reminder says none held for an empty tracker", async () => {
	const { h, cwd } = await rereadHost([], "TestWorker", listResponder(() => ({ stdout: emptyList, stderr: "", code: 0 })));
	expect(h.sent).toHaveLength(1);
	const content = h.sent[0]!.message.content;
	expect(content).toContain("none held");
	expect(content).not.toContain("Unreadable trackers");
	expect(await callAs(h, cwd, "e1", "edit", { path: "f.ts", diff: "+x" })).toEqual([undefined]);
});

/** A session that touched tracker B before compacting in A; B's `br list` fails the guard's own read. */
async function touchedFailingTracker(failure: FlywheelExecResult): Promise<{ h: FakeHost; cwd: string; b: string }> {
	const cwd = freshDir(base, "reread-a-");
	writeFileSync(join(cwd, "AGENTS.md"), "rules\n");
	mkdirSync(join(cwd, ".beads"));
	const b = freshDir(base, "reread-b-");
	mkdirSync(join(b, ".beads"));
	const respond = listResponder(call => (call.options?.cwd === b ? failure : { stdout: emptyList, stderr: "", code: 0 }));
	const h = await createFlywheelHost(base, { env: { PATH: brPath(cwd), BR_ACTOR: "TestWorker" }, respond });
	await callAs(h, cwd, "t1", "bash", { command: "br ready --json", cwd: b });
	await h.emit("tool_execution_end", { toolCallId: "t1", toolName: "bash",
		result: { content: [{ type: "text", text: "[]" }] } }, h.ctx(cwd));
	await h.emit("session_compact", {}, h.ctx(cwd));
	return { h, cwd, b };
}

test("COMPACTION_REREAD: a failing remembered tracker is named with its error and blocks nothing", async () => {
	for (const [failure, error] of [
		[{ stdout: "", stderr: "db locked", code: 5 }, "exit code 5"],
		[{ stdout: "", stderr: "", code: 0, killed: true }, "timed out"],
	] as const) {
		const { h, cwd, b } = await touchedFailingTracker({ ...failure });
		expect(h.sent).toHaveLength(1);
		const content = h.sent[0]!.message.content;
		expect(content).toContain(`root:${b}`);
		expect(content).toContain(error);
		expect(content).toContain("none held");
		expect(await callAs(h, cwd, "e1", "edit", { path: "f.ts", diff: "+x" })).toEqual([undefined]);
	}
});

test("COMPACTION_REREAD planted negative: rows come only from the guard's own list query", async () => {
	const { h } = await rereadHost([], "TestWorker", call => {
		if (call.command === "tmux") return { stdout: "", stderr: "no server", code: 1 };
		if (call.command === "br" && call.args[0] === "list") return { stdout: emptyList, stderr: "", code: 0 };
		if (call.command === "br" && call.args[0] === "show") return bead("k-1", "TestWorker");
		return { stdout: "", stderr: "", code: 0 };
	});
	const content = h.sent[0]!.message.content;
	expect(content).toContain("none held");
	expect(content).not.toContain("k-1");
	expect(h.execs.some(call => call.command === "br" && call.args[0] === "show")).toBe(false);
});

test("REREAD: without compaction nothing is blocked", async () => {
	const cwd = stockRepo();
	const h = await createFlywheelHost(base, { env: { BR_ACTOR: "TestWorker" }, respond: brTable({ "k-1": bead("k-1", null) }) });
	const c = h.ctx(cwd);
	expect(await h.emit("tool_call", { toolCallId: "e1", toolName: "edit", input: { path: "f" } }, c)).toEqual([undefined]);
	expect(await h.emit("tool_call", { toolCallId: "b1", toolName: "bash", input: { command: "git push" } }, c)).toEqual([undefined]);
	expect(await h.emit("tool_call", { toolCallId: "b2", toolName: "bash", input: { command: "br update k-1 --status open" } }, c)).toEqual([undefined]);
});

test("isMutatingCall: edit/write, br mutations and git commit/push; never reads or queries", () => {
	const mutating = (toolName: string, input: Record<string, unknown> = {}): boolean =>
		isMutatingCall({ toolName, input });
	expect(mutating("edit", { path: "f" })).toBe(true);
	expect(mutating("write", { path: "f" })).toBe(true);
	expect(mutating("bash", { command: "br update k-1 --status open" })).toBe(true);
	expect(mutating("bash", { command: "bd close k-1" })).toBe(true);
	expect(mutating("bash", { command: "br comments add k-1 'evidence'" })).toBe(true);
	expect(mutating("bash", { command: "cd sub && git commit -m done" })).toBe(true);
	expect(mutating("bash", { command: "git -C sub push origin master" })).toBe(true);
	expect(mutating("bash", { command: "git commit -m push" })).toBe(true);
	expect(mutating("read", { path: "AGENTS.md" })).toBe(false);
	expect(mutating("grep", { pattern: "x" })).toBe(false);
	expect(mutating("bash", { command: "git status --short" })).toBe(false);
	expect(mutating("bash", { command: "br show k-1 --json" })).toBe(false);
	expect(mutating("bash", { command: "git log --grep=push" })).toBe(false);
	expect(mutating("bash", {})).toBe(false);
});

// --- BLOCK_REFUSED (ompkit-fp72.131 BLOCKEDADMIT1) ------------------------------

interface BlockFixture { labels?: string[]; comments?: string[]; edges?: Array<{ type: string; status: string }> }

/** `br show --json` and `br dep list --json` answer from one fixture; shaped like the real br 0.7.4 envelopes. */
function blockResponder(fixture: BlockFixture, fail: "show" | "dep" | null = null): Responder {
	return call => {
		if (call.command === "tmux") return { stdout: "", stderr: "no server", code: 1 };
		const verb = call.args[0];
		if (verb === "show") {
			if (fail === "show") return { stdout: "", stderr: "boom", code: 1 };
			return { stdout: JSON.stringify([{ id: "kit-9", status: "open", assignee: "BlueFox", labels: fixture.labels ?? [],
				comments: (fixture.comments ?? []).map(text => ({ author: "X", text })) }]), stderr: "", code: 0 };
		}
		if (verb === "dep") {
			if (fail === "dep") return { stdout: "", stderr: "boom", code: 1 };
			return { stdout: JSON.stringify((fixture.edges ?? []).map(edge => ({ issue_id: "kit-9", depends_on_id: "kit-fix", ...edge }))), stderr: "", code: 0 };
		}
		return { stdout: "[]", stderr: "", code: 0 };
	};
}

async function blockCall(fixture: BlockFixture, command: string, fail: "show" | "dep" | null = null): Promise<FlywheelToolCallResult | undefined> {
	const project = freshDir(base, "proj-");
	const h = await createFlywheelHost(base, { respond: blockResponder(fixture, fail) });
	return toolCall(h, project, command);
}

const SET_BLOCKED = "br --actor BlueFox update kit-9 --status blocked";

test("BLOCK_REFUSED: blocked with no blocks edge is refused, with an open blocks edge it is allowed", async () => {
	const refused = await blockCall({}, SET_BLOCKED);
	expect(refused?.block).toBe(true);
	expect(refused?.reason).toContain("BLOCK_REFUSED");
	expect(refused?.reason).toContain("kit-9 has no open blocks edge to a fix");
	expect(refused?.reason).toContain("A decision owed by a director, chief or owner is an assigned bead with the decision as its next action");
	expect(await blockCall({ edges: [{ type: "blocks", status: "open" }] }, SET_BLOCKED)).toBeUndefined();
	expect(await blockCall({ edges: [{ type: "blocks", status: "in_progress" }] }, "br update kit-9 -s blocked")).toBeUndefined();
});

test("BLOCK_REFUSED: a closed blocker, a parent-child edge or a related edge is not a fix", async () => {
	expect((await blockCall({ edges: [{ type: "blocks", status: "closed" }] }, SET_BLOCKED))?.block).toBe(true);
	expect((await blockCall({ edges: [{ type: "blocks", status: "tombstone" }] }, SET_BLOCKED))?.block).toBe(true);
	expect((await blockCall({ edges: [{ type: "parent-child", status: "open" }] }, SET_BLOCKED))?.block).toBe(true);
	expect((await blockCall({ edges: [{ type: "related", status: "open" }] }, SET_BLOCKED))?.block).toBe(true);
	expect(await blockCall({ edges: [{ type: "blocks", status: "closed" }, { type: "blocks", status: "open" }] }, SET_BLOCKED)).toBeUndefined();
});

test("BLOCK_REFUSED: human-gate needs a comment naming the effect only Joshua can perform", async () => {
	const label = await blockCall({ labels: ["human-gate"] }, SET_BLOCKED);
	expect(label?.block).toBe(true);
	expect(label?.reason).toContain("no comment names the effect only Joshua can perform");
	const vague = await blockCall({ labels: ["human-gate"], comments: ["HUMAN-GATE: later"] }, SET_BLOCKED);
	expect(vague?.block).toBe(true);
	const named = { labels: ["human-gate"], comments: ["HUMAN-GATE: rotate the Infisical machine token in the vault UI"] };
	expect(await blockCall(named, SET_BLOCKED)).toBeUndefined();
	expect(await blockCall({ comments: named.comments }, `${SET_BLOCKED} --add-label human-gate`)).toBeUndefined();
	expect((await blockCall({}, `${SET_BLOCKED} --add-label human-gate`))?.block).toBe(true);
});

test("BLOCK_REFUSED: other status updates, other verbs and unreadable beads", async () => {
	expect(await blockCall({}, "br update kit-9 --status open")).toBeUndefined();
	expect(await blockCall({}, "br update kit-9 --priority 1")).toBeUndefined();
	expect(await blockCall({}, "br show kit-9 --json")).toBeUndefined();
	const showDown = await blockCall({ edges: [{ type: "blocks", status: "open" }] }, SET_BLOCKED, "show");
	expect(showDown?.block).toBe(true);
	expect(showDown?.reason).toContain("cannot be checked");
	expect((await blockCall({ edges: [{ type: "blocks", status: "open" }] }, SET_BLOCKED, "dep"))?.block).toBe(true);
});

test("BLOCK_REFUSED AC5: no br binary or no tracker stands the check down; a live tracker that cannot answer stays refused", async () => {
	const project = freshDir(base, "proj-");
	const stock = async (respond: Responder) => toolCall(await createFlywheelHost(base, { respond }), project, SET_BLOCKED);
	const tmux = { stdout: "", stderr: "no server", code: 1 };
	const noBr: Responder = call => {
		if (call.command === "tmux") return tmux;
		throw new Error("spawn br ENOENT");
	};
	expect(await stock(noBr)).toBeUndefined();
	const noTracker: Responder = call => {
		if (call.command === "tmux") return tmux;
		return { stdout: JSON.stringify({ error: { code: "NOT_INITIALIZED", message: "Beads not initialized: run 'br init' first" } }), stderr: "", code: 2 };
	};
	expect(await stock(noTracker)).toBeUndefined();
	const lostBead: Responder = call => {
		if (call.command === "tmux") return tmux;
		return { stdout: JSON.stringify({ error: { code: "ISSUE_NOT_FOUND", message: "Issue not found: kit-9" } }), stderr: "", code: 3 };
	};
	const refused = await stock(lostBead);
	expect(refused?.block).toBe(true);
	expect(refused?.reason).toContain("BLOCK_REFUSED");
	expect(refused?.reason).toContain("cannot be checked");
});

test("BLOCK_REFUSED: a br update wrapped in sh -c, bash -lc or nested shells is checked like the bare command", async () => {
	const open = { edges: [{ type: "blocks", status: "open" }] };
	for (const wrapped of [
		`sh -c "${SET_BLOCKED}"`,
		`bash -lc '${SET_BLOCKED}'`,
		`zsh -c "bash -c '${SET_BLOCKED}'"`,
		`BR_ACTOR=BlueFox sh -c "br update kit-9 --status blocked"`,
		`cd /tmp && sh -c "${SET_BLOCKED}"`,
	]) {
		const refused = await blockCall({}, wrapped);
		expect(refused?.block).toBe(true);
		expect(refused?.reason).toContain("BLOCK_REFUSED");
		expect(await blockCall(open, wrapped)).toBeUndefined();
	}
});

test("BLOCK_REFUSED: shell words that only mention br, plain sh, and over-deep or odd -c flags are not parsed as mutations", async () => {
	expect(await blockCall({}, `sh -c "echo br update kit-9 --status blocked"`)).toBeUndefined();
	expect(await blockCall({}, "sh script.sh")).toBeUndefined();
	expect(await blockCall({}, `sh -x ${SET_BLOCKED}`)).toBeUndefined();
	const deep = `sh -c "sh -c \\"sh -c \\\\\\"sh -c '${SET_BLOCKED}'\\\\\\"\\""`;
	expect(trackerRequests(deep, "/proj", "/home/u")).toEqual([]);
	const started = performance.now();
	expect(trackerRequests(`sh -${"a".repeat(50_000)}b "${SET_BLOCKED}"`, "/proj", "/home/u")).toEqual([]);
	expect(performance.now() - started).toBeLessThan(500);
});

test("trackerRequests: wrapped close and claim keep the caller's inline identity", () => {
	const [close] = trackerRequests(`BR_ACTOR=RedOwl sh -c "br close kit-3"`, "/proj", "/home/u");
	expect(close?.operation).toBe("close");
	expect(close?.identities).toContain("RedOwl");
	expect(close?.actor).toBe("RedOwl");
});

// --- BLOCK_RELEASE_REQUIRED (ompkit-fp72.131 AC4) -------------------------------

interface ReleaseFixture {
	dependents?: Array<{ id: string; status: string; dependency_type: string }>;
	edges?: Record<string, Array<{ type: string; depends_on_id: string; status: string }>>;
}

function releaseResponder(fixture: ReleaseFixture): Responder {
	return call => {
		if (call.command === "tmux") return { stdout: "", stderr: "no server", code: 1 };
		if (call.args[0] === "show") {
			return { stdout: JSON.stringify([{ id: "kit-x", status: "in_progress", assignee: null, dependents: fixture.dependents ?? [] }]), stderr: "", code: 0 };
		}
		if (call.args[0] === "dep") return { stdout: JSON.stringify((fixture.edges ?? {})[call.args[2] ?? ""] ?? []), stderr: "", code: 0 };
		return { stdout: "[]", stderr: "", code: 0 };
	};
}

async function closeCall(fixture: ReleaseFixture, command: string): Promise<FlywheelToolCallResult | undefined> {
	const project = freshDir(base, "proj-");
	const h = await createFlywheelHost(base, { respond: releaseResponder(fixture) });
	return toolCall(h, project, command);
}

const ONLY_X = { edges: { "kit-d1": [{ type: "blocks", depends_on_id: "kit-x", status: "open" }] } };
const D1_BLOCKED = [{ id: "kit-d1", status: "blocked", dependency_type: "blocks" }];

test("BLOCK_RELEASE_REQUIRED: closing the only open blocker of a blocked bead is refused until it is released", async () => {
	const refused = await closeCall({ dependents: D1_BLOCKED, ...ONLY_X }, "br close kit-x --reason done");
	expect(refused?.block).toBe(true);
	expect(refused?.reason).toContain("BLOCK_RELEASE_REQUIRED");
	expect(refused?.reason).toContain("kit-d1");
	const released = await closeCall({ dependents: D1_BLOCKED, ...ONLY_X }, "br update kit-d1 --status open && br close kit-x --reason done");
	expect(released?.block).toBeUndefined();
	expect((await closeCall({ dependents: D1_BLOCKED, ...ONLY_X }, `sh -c "br close kit-x"`))?.block).toBe(true);
});

test("BLOCK_RELEASE_REQUIRED: another open blocker, a non-blocked dependent or a non-blocks edge allow the close", async () => {
	const other = { dependents: D1_BLOCKED, edges: { "kit-d1": [
		{ type: "blocks", depends_on_id: "kit-x", status: "open" },
		{ type: "blocks", depends_on_id: "kit-y", status: "open" },
	] } };
	expect((await closeCall(other, "br close kit-x"))?.block).toBeUndefined();
	const closedOther = { dependents: D1_BLOCKED, edges: { "kit-d1": [
		{ type: "blocks", depends_on_id: "kit-x", status: "open" },
		{ type: "blocks", depends_on_id: "kit-y", status: "closed" },
	] } };
	expect((await closeCall(closedOther, "br close kit-x"))?.block).toBe(true);
	expect((await closeCall({ dependents: [{ id: "kit-d1", status: "open", dependency_type: "blocks" }], ...ONLY_X }, "br close kit-x"))?.block).toBeUndefined();
	expect((await closeCall({ dependents: [{ id: "kit-d1", status: "blocked", dependency_type: "parent-child" }], ...ONLY_X }, "br close kit-x"))?.block).toBeUndefined();
	expect((await closeCall({}, "br close kit-x"))?.block).toBeUndefined();
});

test("BLOCK_RELEASE_REQUIRED AC5: outside a tracker a close is never a stranding refusal", async () => {
	const project = freshDir(base, "proj-");
	const h = await createFlywheelHost(base, { respond: call => {
		if (call.command === "tmux") return { stdout: "", stderr: "no server", code: 1 };
		return { stdout: JSON.stringify({ error: { code: "NOT_INITIALIZED", message: "Beads not initialized" } }), stderr: "", code: 2 };
	} });
	const result = await toolCall(h, project, "br close kit-x --reason done");
	if (result?.block === true) expect(result.reason).not.toContain("BLOCK_RELEASE_REQUIRED");
});

// --- SCRATCH_DISPOSAL_REFUSED (ompkit-774u.15 enforcement, Joshua scope 2026-10-20): refuse at in_review and close ---

function mineAnswer(rows: { dir: string; label?: string; state: string; bin: string }[]): FlywheelExecResult {
	return { stdout: JSON.stringify({ ok: true, data: { overall: "FINDINGS", unreleased: rows.length, dirs: rows.map(row => ({ label: "seat", ...row })) } }), stderr: "", code: 0 };
}

function scratchResponder(mine: FlywheelExecResult, beads: Record<string, FlywheelExecResult> = {}): Responder {
	const brAnswers = brTable(beads);
	return call => call.command === "omp-kit" ? mine : brAnswers(call);
}

const OWED = [{ dir: "/r/var/agent-tmp/probe.1", state: "unreleased", bin: "unbinned" }, { dir: "/r/var/agent-tmp/hold.2", state: "hold-expired", bin: "hold" }];

test("SCRATCH_DISPOSAL_REFUSED: moving a bead to in_review with unreleased dirs is refused, naming each dir", async () => {
	const project = freshDir(base, "proj-");
	const h = await createFlywheelHost(base, { env: { AGENT_NAME: "BlueFox" }, respond: scratchResponder(mineAnswer(OWED)) });
	const result = await toolCall(h, project, "br update kit-1 --status in_review --actor BlueFox");
	expect(result?.block).toBe(true);
	expect(result?.reason).toContain("SCRATCH_DISPOSAL_REFUSED");
	expect(result?.reason).toContain("/r/var/agent-tmp/probe.1 (unreleased, bin unbinned)");
	expect(result?.reason).toContain("/r/var/agent-tmp/hold.2 (hold-expired, bin hold)");
	expect(result?.reason).toContain("omp-kit scratch release DIR --bin throwaway|evidence|promote");
	const mine = h.execs.filter(call => call.command === "omp-kit");
	expect(mine.map(call => call.args)).toEqual([["scratch", "mine", "--at", "review", "--json"]]);
	expect(mine[0]?.options?.cwd).toBe(project);
});

test("SCRATCH_DISPOSAL_REFUSED: a verifier's close of another seat's bead is refused while the verifier owes dirs, logged as close", async () => {
	const project = freshDir(base, "proj-");
	const h = await createFlywheelHost(base, { env: { AGENT_NAME: "Verifier" },
		respond: scratchResponder(mineAnswer(OWED.slice(0, 1)), { "kit-2": bead("kit-2", "BlueFox") }) });
	const result = await toolCall(h, project, "br close kit-2 --reason \"replayed\"");
	expect(result?.block).toBe(true);
	expect(result?.reason).toContain("you still own 1 scratch dir(s)");
	expect(h.execs.find(call => call.command === "omp-kit")?.args).toEqual(["scratch", "mine", "--at", "close", "--json"]);
});

// SCRATCHSIBLING1 (ompkit-fp72.120.16.214): the guard runs in the seat's omp process, which every background agent
// shares with the lead, so `scratch mine` from that process cannot tell them apart. The responder plays omp-kit: asked
// with the calling agent's own session it lists only that agent's dir; asked with the process environment it lists the
// lead's live TMPDIR as well (the 2026-11-04 lead-hooks2.13390 case). Agent B's advice must name B's dir, never A's.
test("SCRATCHSIBLING1: SCRATCH_OWED for background agent B asks omp-kit as B's own session and never names A's live dir", async () => {
	const project = freshDir(base, "proj-");
	const B = "01a1a751-0cd4-7400-9971-c4c20abcaa82";
	const bDir = "/r/var/agent-tmp/bwork.1";
	const aDir = "/r/var/agent-tmp/lead-hooks2.13390";
	const h = await createFlywheelHost(base, { env: { AGENT_NAME: "BlueFox" }, respond: call => {
		if (call.command === "omp-kit" && call.args.includes("--session") && call.args[call.args.indexOf("--session") + 1] === B)
			return mineAnswer([{ dir: bDir, state: "unreleased", bin: "unbinned" }]);
		if (call.command === "omp-kit")
			return mineAnswer([{ dir: bDir, state: "unreleased", bin: "unbinned" }, { dir: aDir, state: "unreleased", bin: "unbinned" }]);
		return brTable({})(call);
	} });
	const [result] = await h.emit("tool_call", { toolCallId: "c1", toolName: "bash", input: { command: "br update kit-1 --status in_review --actor BlueFox" } },
		{ ...h.ctx(project), sessionManager: { getSessionId: () => B } }) as (FlywheelToolCallResult | undefined)[];
	expect(result?.block).toBe(true);
	expect(result?.reason).toContain(`${bDir} (unreleased, bin unbinned)`);
	expect(result?.reason).not.toContain(aDir);
	const census = h.execs.filter(call => call.command === "omp-kit");
	expect(census.map(call => call.args)).toEqual([["scratch", "mine", "--at", "review", "--session", B, "--json"]]);
	expect(census[0]?.options?.cwd).toBe(project);
});

test("SCRATCH_OWED negatives: nothing owed, only the live session dir, or an unusable answer yields no advice", async () => {
	const project = freshDir(base, "proj-");
	const unusable: FlywheelExecResult[] = [
		mineAnswer([]),
		mineAnswer([{ dir: "/r/var/agent-tmp/omp.7", label: "omp", state: "unreleased", bin: "throwaway" }]),
		mineAnswer([{ dir: "/r/var/agent-tmp/ok.1", state: "released", bin: "throwaway" }, { dir: "/r/var/agent-tmp/held.1", state: "held", bin: "hold" }]),
		{ stdout: "", stderr: "omp-kit: command not found", code: 127 },
		{ stdout: JSON.stringify({ ok: true, data: { dirs: [{ dir: "/x", label: "p", state: "unreleased", bin: "unbinned" }] } }), stderr: "", code: 0, killed: true },
		{ stdout: "not json", stderr: "", code: 0 },
		{ ...mineAnswer(OWED), code: 1 },
		{ stdout: JSON.stringify({ ok: true, data: {} }), stderr: "", code: 0 },
	];
	for (const answer of unusable) {
		const h = await createFlywheelHost(base, { env: { AGENT_NAME: "BlueFox" }, respond: scratchResponder(answer) });
		expect(await toolCall(h, project, "br update kit-1 --status in_review --actor BlueFox")).toBeUndefined();
		expect(h.notices).toEqual([]);
	}
});

test("SCRATCH_DISPOSAL_REFUSED: a thrown exec never blocks (fail-open) and a long list is refused with a count", async () => {
	const project = freshDir(base, "proj-");
	const throwing = await createFlywheelHost(base, { env: { AGENT_NAME: "BlueFox" }, respond: call => { if (call.command === "omp-kit") throw new Error("spawn failed"); return { stdout: "", code: 127 }; } });
	expect(await toolCall(throwing, project, "br update kit-1 --status in_review --actor BlueFox")).toBeUndefined();
	const many = Array.from({ length: 8 }, (_, index) => ({ dir: `/r/var/agent-tmp/d.${index}`, state: "unreleased", bin: "unbinned" }));
	const long = await createFlywheelHost(base, { env: { AGENT_NAME: "BlueFox" }, respond: scratchResponder(mineAnswer(many)) });
	const result = await toolCall(long, project, "br update kit-1 --status in_review --actor BlueFox");
	expect(result?.block).toBe(true);
	expect(result?.reason).toContain("SCRATCH_DISPOSAL_REFUSED");
	expect(result?.reason).toContain("you still own 8 scratch dir(s)");
	expect(result?.reason).toContain("and 3 more");
	expect(result?.reason).not.toContain("d.5");
});

test("SCRATCH_OWED: other tracker commands and refused closes never ask omp-kit", async () => {
	const project = freshDir(base, "proj-");
	const home = identityHome(project, "77", "{\"name\":\"BlueFox\"}");
	const h = await createFlywheelHost(base, { env: { TMUX_PANE: "%77" }, home, respond: scratchResponder(mineAnswer(OWED), { "kit-1": bead("kit-1", "BlueFox") }) });
	const refused = await toolCall(h, project, "br close kit-1 --reason \"x\"");
	expect(refused?.block).toBe(true);
	expect(h.execs.some(call => call.command === "omp-kit")).toBe(false);
	await toolCall(h, project, "br show kit-1 --json");
	await toolCall(h, project, "br update kit-1 --status in_progress --add-label x");
	await toolCall(h, project, "br comments add kit-1 -f /x");
	expect(h.execs.some(call => call.command === "omp-kit")).toBe(false);
});

test("trackerRequests: update --status in_review is a review request, in either spelling", () => {
	const parsed = (command: string) => trackerRequests(command, "/r", "/h").map(request => [request.operation, request.ids]);
	expect(parsed("br update kit-1 --status in_review")).toEqual([["review", ["kit-1"]]]);
	expect(parsed("br update kit-1 --status=InReview")).toEqual([["review", ["kit-1"]]]);
	expect(parsed("br update kit-1 --status open")).toEqual([["release", ["kit-1"]]]);
});
// --- DRAIN1 (ompkit-kdbz.1.1): atomic parking + one-active claim ---------------

interface DrainRow { id?: string; status: string; assignee: string | null; updatedAt?: string }

/** `br show` rows plus `br list --assignee` answers, shaped like br 0.7.4. */
function drainResponder(shows: Record<string, DrainRow>, lists: Record<string, DrainRow[]> = {}): Responder {
	return call => {
		if (call.command === "tmux") return { stdout: "", stderr: "no server", code: 1 };
		if (call.args[0] === "list") {
			const flag = call.args.indexOf("--assignee");
			const name = flag >= 0 ? call.args[flag + 1] ?? "" : "";
			const rows = lists[name] ?? [];
			return { stdout: JSON.stringify({ issues: rows.map(row => ({ id: row.id ?? "", status: row.status, assignee: row.assignee })), total: rows.length }), stderr: "", code: 0 };
		}
		const id = call.args[1] ?? "";
		const row = shows[id];
		if (row === undefined) {
			return { stdout: JSON.stringify({ error: { code: "ISSUE_NOT_FOUND", message: `Issue not found: ${id}` } }), stderr: "", code: 3 };
		}
		return { stdout: JSON.stringify([{ id, title: "t", status: row.status, assignee: row.assignee, labels: ["pillar:proven"], updated_at: row.updatedAt ?? "2026-10-19T19:00:00Z" }]), stderr: "", code: 0 };
	};
}

async function drainCall(shows: Record<string, DrainRow>, lists: Record<string, DrainRow[]>, command: string, actor = "Holder"): Promise<FlywheelToolCallResult | undefined> {
	const project = freshDir(base, "proj-");
	const h = await createFlywheelHost(base, { env: { BR_ACTOR: actor }, respond: drainResponder(shows, lists) });
	return toolCall(h, project, command);
}

const LIVE = { "k-1": { status: "in_progress", assignee: "Holder" } };
const ATOMIC = 'br update k-1 --status open --assignee "" --if-unchanged 2026-10-19T19:00:00Z';

test("DRAIN1: bare release of a live held claim is refused until it clears assignee under revision", async () => {
	const refused = await drainCall(LIVE, {}, "br update k-1 --status open");
	expect(refused?.block).toBe(true);
	expect(refused?.reason).toContain("PARTIAL_RELEASE_REFUSED");
	expect(refused?.reason).toContain("k-1 is in_progress/Holder at revision 2026-10-19T19:00:00Z");
	const noClear = await drainCall(LIVE, {}, "br update k-1 --status open --if-unchanged 2026-10-19T19:00:00Z");
	expect(noClear?.block).toBe(true);
	expect(noClear?.reason).toContain('--assignee ""');
	const noRev = await drainCall(LIVE, {}, 'br update k-1 --status open --assignee ""');
	expect(noRev?.block).toBe(true);
	expect(noRev?.reason).toContain("--if-unchanged");
});

test("DRAIN1: third-party park of a live claim is refused; holder atomic release passes", async () => {
	const foreign = await drainCall(LIVE, {}, ATOMIC, "Intruder");
	expect(foreign?.block).toBe(true);
	expect(foreign?.reason).toContain("only the holder parks a live claim");
	expect(await drainCall(LIVE, {}, ATOMIC)).toBeUndefined();
});

test("DRAIN1: repair releases of ownerless or already-open beads pass untouched", async () => {
	expect(await drainCall({ "k-9": { status: "in_progress", assignee: null } }, {}, "br update k-9 --status open")).toBeUndefined();
	expect(await drainCall({ "k-9": { status: "open", assignee: "Holder" } }, {}, "br update k-9 --status open")).toBeUndefined();
});

test("DRAIN1: second active claim is refused naming the held id; re-claim of the held bead passes", async () => {
	const shows = { "k-1": { status: "in_progress", assignee: "Holder" }, "k-2": { status: "open", assignee: null } };
	const lists = { Holder: [{ id: "k-1", status: "in_progress", assignee: "Holder" }] };
	const second = await drainCall(shows, lists, "br --actor Holder update k-2 --claim");
	expect(second?.block).toBe(true);
	expect(JSON.parse(second?.reason ?? "{}").refusal.next).toContain("already holds active k-1");
	expect(await drainCall(shows, lists, "br --actor Holder update k-1 --claim")).toBeUndefined();
	const fresh: Record<string, DrainRow[]> = {};
	expect(await drainCall(shows, fresh, "br --actor Holder update k-2 --claim")).toBeUndefined();
});

test("DRAIN1: claim on a stale-held bead stays refused; nonauthor review still passes", async () => {
	const shows = { "k-2": { status: "open", assignee: null }, "k-3": { status: "in_progress", assignee: "Ghost" } };
	const stale = await drainCall(shows, {}, "br --actor Holder update k-3 --claim");
	expect(stale?.block).toBe(true);
	expect(JSON.parse(stale?.reason ?? "{}").refusal.next).toContain("Ghost retains k-3");
	expect(await drainCall(shows, {}, "br --actor Holder update k-2 --status in_review")).toBeUndefined();
});

test("DRAIN1: ownerless start still refuses with the atomic claim route", async () => {
	const refused = await drainCall({ "k-2": { status: "open", assignee: null } }, {}, "br --actor Holder update k-2 --status in_progress");
	expect(refused?.block).toBe(true);
	expect(JSON.parse(refused?.reason ?? "{}").refusal.next).toContain("--claim");
});

test("DRAIN1 custody: bare assignee clear on a live held claim is refused (fp72.95 shape)", async () => {
	const parsed = trackerRequests('br update k-1 --assignee ""', "/r", "/h").map(request => [request.operation, request.ids]);
	expect(parsed).toEqual([["custody", ["k-1"]]]);
	const holder = await drainCall(LIVE, {}, 'br update k-1 --assignee ""');
	expect(holder?.block).toBe(true);
	expect(holder?.reason).toContain("PARTIAL_RELEASE_REFUSED");
	expect(holder?.reason).toContain("leaves an ownerless in_progress bead");
	const foreign = await drainCall(LIVE, {}, 'br update k-1 --assignee ""', "Intruder");
	expect(foreign?.block).toBe(true);
	expect(foreign?.reason).toContain("only the holder changes custody");
	const reassign = await drainCall(LIVE, {}, "br update k-1 --assignee Next");
	expect(reassign?.block).toBe(true);
	expect(reassign?.reason).toContain("splits custody from the one-active check");
});

test("DRAIN1 custody: repairs on ownerless or open beads pass", async () => {
	expect(await drainCall({ "k-9": { status: "in_progress", assignee: null } }, {}, 'br update k-9 --assignee ""')).toBeUndefined();
	expect(await drainCall({ "k-9": { status: "open", assignee: null } }, {}, "br update k-9 --assignee Next")).toBeUndefined();
});

// Native custody reads remain authoritative; train metadata is irrelevant.
type CutBead = { id: string; status: string; assignee: string | null; labels?: string[] | null };

async function cutFixture() {
	const repo = freshDir(base, "cutclaim-");
	const config = join(repo, "fleet-watch.json");
	const milestone = { epic: "cut", due: "2026-11-01", declaredAt: "2026-10-30T00:00:00Z", pinned: ["k-1"] };
	writeFileSync(config, JSON.stringify({ sessions: [{ session: "fixture", repo, milestone }] }));
	const rows: Record<string, CutBead> = {};
	for (const id of ["k-1", "k-2", "k-3"]) rows[id] = { id, status: "open", assignee: null, labels: [] };
	// No global graph reads: only the target and the caller's actual claims matter.
	const respond: Responder = call => {
		if (call.command === "tmux") return { code: 1, stdout: "", stderr: "no server" };
		if (call.command === "env") return { code: 0, stdout: "", stderr: "" };
		if (call.args[0] === "show") {
			const ids = call.args.slice(1).filter(arg => !arg.startsWith("--") && !arg.endsWith(".db"));
			if (ids.some(id => !rows[id])) return { code: 3, stdout: "", stderr: "missing fixture bead" };
			return { code: 0, stdout: JSON.stringify(ids.map(id => rows[id])) };
		}
		if (call.args[0] === "list" && call.args.includes("--assignee")) return { code: 0, stdout: JSON.stringify({ issues: [], total: 0 }) };
		return { code: 99, stdout: "", stderr: "unexpected fixture read" };
	};
	const env = { BR_ACTOR: "Holder", OMP_KIT_FLEET_WATCH_CONFIG: config, BEADS_DB: join(repo, ".beads", "beads.db"), BEADS_DIR: "" };
	const h = await createFlywheelHost(base, { env, home: repo, respond });
	return { repo, config, rows, h };
}


test("native owned rework resumes without a second claim", async () => {
	const f = await cutFixture();
	f.rows["k-1"]!.status = "rework";
	f.rows["k-1"]!.assignee = "Holder";
	expect(await toolCall(f.h, f.repo, "br --actor Holder update k-1 --status in_progress")).toBeUndefined();
});

// --- DBLITERAL2 (ompkit-nxlx1): the guard never runs br with an unexpanded --db -----

const BT = String.fromCharCode(96);

test("DBLITERAL2: a br mutation whose --db is a shell expansion is refused before the guard runs any br", async () => {
	const project = freshDir(base, "proj-");
	const h = await createFlywheelHost(base, { env: { BR_ACTOR: "Holder" }, respond: brTable({ "kit-1": bead("kit-1", "Holder") }) });
	for (const command of [
		"D=.beads/beads.db; br update kit-1 --status open --assignee '' --db $D",
		"br close kit-1 --db=${DB}",
		"br update kit-1 --status open --db " + BT + "cat dbpath" + BT,
	]) {
		const result = await toolCall(h, project, command);
		expect(result?.block).toBe(true);
		expect(result?.reason).toContain("TRACKER_DB_UNEXPANDED");
	}
	// The planted negative this guards: before the check, the release path ran `br show ... --db $D` here.
	expect(h.execs.filter(call => call.command === "br" && call.args.includes("--db"))).toEqual([]);
});

test("DBLITERAL2 control: a literal --db path is not refused by this check", async () => {
	const project = freshDir(base, "proj-");
	const h = await createFlywheelHost(base, { env: { BR_ACTOR: "Holder" }, respond: brTable({ "kit-1": bead("kit-1", "Holder") }) });
	const result = await toolCall(h, project, "br update kit-1 --priority 2 --db /abs/repo/.beads/beads.db");
	expect(result?.reason ?? "").not.toContain("TRACKER_DB_UNEXPANDED");
});

test("BRIEFCONTRACT1 live tool-call boundary refuses a planted build and admits current digest and read-only controls", async () => {
	const project = freshDir(base, "brief-");
	const execute: Responder = async call => {
		const result = await runFixtureAsync([call.command, ...call.args], { cwd: call.options?.cwd ?? project, env: { ...process.env, GIT_CEILING_DIRECTORIES: base, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" } });
		return { code: result.rc ?? 1, stdout: new TextDecoder().decode(result.stdout), stderr: new TextDecoder().decode(result.stderr) };
	};
	const initialized = await execute({ command: "git", args: ["init", "-q", "--template=", project] });
	expect(initialized.code).toBe(0);
	const hooks = join(project, ".git", "hooks", "hooks.d", "pre-commit");
	mkdirSync(hooks, { recursive: true });
	const member = join(hooks, "51-omp-kit-staged-kitlib");
	writeFileSync(member, "#!/bin/sh\n# Refuse raw process spawn; use src/kitlib/run.ts\nexit 0\n", { mode: 0o755 });
	const h = await createFlywheelHost(base, { respond: execute });
	const input = { context: `Repo: ${project}`, tasks: [{ task: "Implement the requested change. Do not edit unrelated paths." }] };
	const [refused] = await h.emit("tool_call", { toolCallId: "brief-missing", toolName: "task", input }, h.ctx(project));
	expect(refused).toMatchObject({ block: true, reason: expect.stringContaining("BRIEF_CONTRACT_REFUSED") });
	const contract = await briefContract(project);
	const [admitted] = await h.emit("tool_call", { toolCallId: "brief-present", toolName: "task", input: { ...input, context: `${input.context}\n${renderBrief(contract)}` } }, h.ctx(project));
	expect((admitted as FlywheelToolCallResult | undefined)?.block).not.toBe(true);
	const [readOnlyResult] = await h.emit("tool_call", { toolCallId: "brief-read", toolName: "task", input: { ...input, tasks: [{ task: "Read-only: analyze the implementation" }] } }, h.ctx(project));
	expect((readOnlyResult as FlywheelToolCallResult | undefined)?.block).not.toBe(true);
});

describe("BRIEFREPOWORD1 pasted brief text never names a target", () => {
	// The measured CFS hook prose: `omp-kit brief --repo clutterfreespaces.ios` prints "THIS REPO: - the ...", and the omp-kit commit-msg member "per-repo: any".
	const hookProse = "# 30-db-drift-ledger WHAT THIS CAN NOT SEE: THREE OF THEM NEVER TOUCH THIS REPO: - the Supabase dashboard SQL editor\n# One history per-repo: any, --repo its own checkout\n";
	const execute: Responder = async call => {
		const result = await runFixtureAsync([call.command, ...call.args], { cwd: call.options?.cwd ?? base, env: { ...process.env, GIT_CEILING_DIRECTORIES: base, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" } });
		return { code: result.rc ?? 1, stdout: new TextDecoder().decode(result.stdout), stderr: new TextDecoder().decode(result.stderr) };
	};
	const repo = async (prefix: string) => {
		const project = freshDir(base, prefix);
		expect((await execute({ command: "git", args: ["init", "-q", "--template=", project] })).code).toBe(0);
		const hooks = join(project, ".git", "hooks", "hooks.d", "pre-commit");
		mkdirSync(hooks, { recursive: true });
		writeFileSync(join(hooks, "30-db-drift-ledger"), `#!/bin/sh\n${hookProse}exit 0\n`, { mode: 0o755 });
		return project;
	};
	const build = [{ task: "# Target\nThese paths are reserved for you: src/x.ts.\n# Change\nFix the bug." }];
	const planted = async () => {
		const cfs = await repo("cfs-");
		const companion = await repo("companion-");
		const briefs = [renderBrief(await briefContract(cfs)), renderBrief(await briefContract(companion))];
		expect(briefs.join("\n")).toContain("THIS REPO: - the");
		return { cfs, companion, input: { context: `Repo: ${cfs}\nRepo: ${companion}\n${briefs.join("\n")}`, tasks: build } };
	};

	test("BRIEFREPOWORD1 planted: complete CFS and companion briefs in context are admitted", async () => {
		const { cfs, companion, input } = await planted();
		const h = await createFlywheelHost(base, { respond: execute });
		const [verdict] = await h.emit("tool_call", { toolCallId: "brw-a", toolName: "task", input }, h.ctx(cfs));
		expect((verdict as FlywheelToolCallResult | undefined)?.block).not.toBe(true);
		expect(briefTargets(input.context, cfs).sort()).toEqual([cfs, companion].sort());
	});

	test("BRIEFREPOWORD1 planted: the live CFS and companion briefs are admitted when those checkouts exist", async () => {
		const live = ["/Users/josh/Developer/clutterfreespaces.ios", "/Users/josh/Developer/omp-kit-companion"].filter(path => existsSync(join(path, ".git")));
		if (live.length < 2) return;
		const briefs = await Promise.all(live.map(async path => renderBrief(await briefContract(path))));
		expect(await checkTaskBrief({ context: `Repo: ${live[0]}\n${briefs.join("\n")}`, tasks: build }, live[0]!)).toBeUndefined();
	});

	test("BRIEFREPOWORD1 words '-', 'any', 'its', 'the' and trailing commas are not targets; no lookup crashes the guard", async () => {
		const cwd = await repo("words-");
		const text = `Repo: -\nrepo: any\n--repo its\nRepo: the companion\nRepo: ${cwd},\nscripts/full-suite-verdict.sh, ${cwd}/src/x.ts,`;
		expect(briefTargets(text, cwd)).toEqual([cwd]);
		expect(briefTargets("repository=/nonexistent/abs/path,", cwd)).toEqual(["/nonexistent/abs/path"]);
		const h = await createFlywheelHost(base, { respond: execute });
		for (const context of ["Repo: -", "per-repo: any", "Repo: /nonexistent/abs/path,", "--repo fails after a chdir"]) {
			const [verdict] = await h.emit("tool_call", { toolCallId: `brw-b-${freshSeq++}`, toolName: "task", input: { context, tasks: build } }, h.ctx(cwd));
			const reason = String((verdict as FlywheelToolCallResult | undefined)?.reason ?? "");
			expect(reason).not.toContain("LOOKUP_REFUSED");
			expect(reason).toContain(`BRIEF_CONTRACT_REFUSED: build task lacks the current contract for ${realpathSync(cwd)}`);
		}
		const plain = freshDir(base, "plain-");
		expect(await checkTaskBrief({ context: "Repo: -", tasks: build }, plain, execute)).toContain("names no target checkout that resolves");
		const started = performance.now();
		briefTargets(`Repo: x${".".repeat(200_000)}\nGate contract: ${"a".repeat(200_000)}`, cwd);
		expect(performance.now() - started).toBeLessThan(2000);
	});

	test("BRIEFREPOWORD1 control: a real checkout named without its marker is refused with the existing reason", async () => {
		const { cfs, input } = await planted();
		const h = await createFlywheelHost(base, { respond: execute });
		const [verdict] = await h.emit("tool_call", { toolCallId: "brw-c", toolName: "task", input: { context: `Repo: ${cfs}`, tasks: build } }, h.ctx(base));
		expect(verdict).toMatchObject({ block: true, reason: expect.stringContaining(`BRIEF_CONTRACT_REFUSED: build task lacks the current contract for ${realpathSync(cfs)}`) });
		expect(input.context).toContain(cfs);
	});

	test("BRIEFREPOWORD1 mutant: restoring the old extraction makes the planted case fail", async () => {
		const source = readFileSync(join(import.meta.dir, "..", "src", "brief.ts"), "utf8");
		const old = source.replace("const prose = stripBriefBlocks(text);", "const prose = text;").replace(/\n\t\t\.filter\(path => path && \(isAbsolute[^\n]*/, "");
		expect(old).not.toBe(source);
		const dir = freshDir(base, "mutant-");
		writeFileSync(join(dir, "brief.ts"), old.replaceAll('from "./', `from "${join(import.meta.dir, "..", "src")}/`));
		// Dynamic: the mutant module is generated at test time, so no static specifier exists.
		const mutant = await import(join(dir, "brief.ts")) as { checkTaskBrief: typeof checkTaskBrief };
		const { cfs, input } = await planted();
		const outcome = await mutant.checkTaskBrief(input, cfs, execute).then(reason => reason ?? "admitted", (error: unknown) => `threw ${String(error)}`);
		expect(outcome).not.toBe("admitted");
	});
});


test("BRIEFCONTRACT1 parent's task-result hook refuses DONE without preflight, admits clean evidence and analysis controls", async () => {
	const h = await createFlywheelHost(base);
	const input = { context: "Repo: /fixture", tasks: [{ task: "Implement feature" }] };
	const emit = (text: string, taskInput = input) => h.emit("tool_result", { toolName: "task", input: taskInput, content: [{ type: "text", text }] }, h.ctx(base));
	const [refused] = await emit("DONE: implemented feature");
	expect(refused).toMatchObject({ isError: true, details: { code: "BRIEF_PREFLIGHT_REFUSED", accepted: false } });
	const [nonzero] = await emit("DONE\nsh scripts/commit-preflight.sh --files src/feature.ts\ncommit-preflight: 12 checks, 1 refused/unjudged, 1.00s");
	expect(nonzero).toMatchObject({ isError: true });
	const [missingMember] = await emit("DONE\nsh scripts/commit-preflight.sh --files skills/contract.md\nUNKNOWN installed-gate:55-omp-kit-staged-wallclock: missing or not executable\ncommit-preflight: 22 checks, 1 refused/unjudged, 1.00s");
	expect(missingMember).toMatchObject({ isError: true, details: { accepted: false } });
	const [unknownDespiteZero] = await emit("DONE\nsh scripts/commit-preflight.sh --files src/feature.ts\nUNKNOWN installed-gate: no installed hook chain\ncommit-preflight: 12 checks, 0 refused/unjudged, 1.00s");
	expect(unknownDespiteZero).toMatchObject({ isError: true, details: { accepted: false } });
	// EXPORTTEST1 planted: changed src without an export test run is refused even at 0 refused/unjudged.
	const [noExportTests] = await emit("DONE\nsh scripts/commit-preflight.sh --files src/feature.ts\ncommit-preflight: 12 checks, 0 refused/unjudged, 1.00s; no fresh gate or tests run");
	expect(noExportTests).toMatchObject({ isError: true, details: { accepted: false } });
	const [zeroTests] = await emit("DONE\nsh scripts/commit-preflight.sh --files src/feature.ts --tests tests/cli/feature.test.ts\ncommit-preflight: 12 checks, 0 refused/unjudged, 1.00s; 0 export test file(s) run; no fresh gate run");
	expect(zeroTests).toMatchObject({ isError: true, details: { accepted: false } });
	const [admitted] = await emit("DONE\nsh scripts/commit-preflight.sh --files src/feature.ts tests/cli/feature.test.ts --tests tests/cli/feature.test.ts\ncommit-preflight: 12 checks, 0 refused/unjudged, 1.00s; 1 export test file(s) run; no fresh gate run");
	expect(admitted).toBeUndefined();
	// Control: a docs-only handback needs no export test run.
	const [docsOnly] = await emit("DONE\nsh scripts/commit-preflight.sh --files skills/contract.md\ncommit-preflight: 12 checks, 0 refused/unjudged, 1.00s; no fresh gate or tests run");
	expect(docsOnly).toBeUndefined();
	const [analysis] = await emit("DONE: read-only analysis", { ...input, tasks: [{ task: "Read-only: analyze feature" }] });
	expect(analysis).toBeUndefined();
	const [progress] = await emit("Still implementing feature");
	expect(progress).toBeUndefined();
	const [mixed] = await h.emit("tool_result", {
		toolName: "task", input: { ...input, tasks: [{ task: "Implement first" }, { task: "Implement second" }] },
		content: [{ type: "text", text: "DONE: both" }],
		details: { results: [
			{ index: 0, id: "First", output: "DONE\nsh scripts/commit-preflight.sh --files src/first.ts --tests tests/cli/first.test.ts\ncommit-preflight: 12 checks, 0 refused/unjudged, 1.00s; 1 export test file(s) run; no fresh gate run" },
			{ index: 1, id: "Second", output: "DONE: second implemented without preflight" },
		] },
	}, h.ctx(base));
	expect(mixed).toMatchObject({ isError: true, content: [{ type: "text", text: expect.stringContaining("Second: BRIEF_PREFLIGHT_REFUSED") }] });
});

test("BRIEFCONTRACT1 direct parent DONE message after file edits needs the same preflight evidence", async () => {
	const h = await createFlywheelHost(base);
	await h.emit("tool_call", { toolCallId: "brief-edit", toolName: "edit", input: { path: "src/feature.ts" } }, h.ctx(base));
	const [refused] = await h.emit("tool_call", { toolCallId: "brief-message", toolName: "write", input: { path: "agent://Main", content: "DONE: feature implemented" } }, h.ctx(base));
	expect(refused).toMatchObject({ block: true, reason: expect.stringContaining("BRIEF_PREFLIGHT_REFUSED") });
	const [admitted] = await h.emit("tool_call", { toolCallId: "brief-message-clean", toolName: "write", input: { path: "agent://Main", content: "DONE\nsh scripts/commit-preflight.sh --files src/feature.ts --tests tests/cli/feature.test.ts\ncommit-preflight: 12 checks, 0 refused/unjudged, 1.00s; 1 export test file(s) run; no fresh gate run" } }, h.ctx(base));
	expect((admitted as FlywheelToolCallResult | undefined)?.block).not.toBe(true);
});

describe("AGENTMODEL1 registered task-call guard", () => {
	const SOL = "openai-codex/gpt-6.1-sol";
	const OPUS = "anthropic/claude-opus-5-5";
	const MUSE = "muse-code/muse-spark-1.3-contributor";
	async function spawnSeat(options: { role?: "chief" | "director" | "builder"; overrides?: Record<string, unknown>; agent?: string; requestModel?: string; query?: boolean; rosterLocation?: "override" | "xdg"; rosterState?: "missing" | "malformed" | "dangling" } = {}) {
		const runtime = await loadSpawnModelRuntime();
		// The catalog belongs to the PATH-selected OMP, not a kit dependency.
		const { getBundledModels } = await import(import.meta.resolve("@oh-my-pi/pi-catalog/models", join(runtime.source, "index.ts")));
		const models: SpawnModelIdentity[] = ["anthropic", "openai-codex", "muse-code"].flatMap(provider => getBundledModels(provider));
		const home = freshDir(base, "spawn-home-"), project = freshDir(base, "spawn-project-");
		const configHome = join(home, options.rosterLocation === "xdg" ? "xdg" : ".config");
		const rosterDir = join(configHome, "omp-kit");
		const rosterPath = options.rosterLocation === "override" ? join(home, "operator-roster.json") : join(rosterDir, "fleet-roster.json");
		const agentDir = join(home, ".omp", "agent");
		mkdirSync(rosterDir, { recursive: true });
		mkdirSync(agentDir, { recursive: true });
		mkdirSync(join(project, ".omp", "agents"), { recursive: true });
		const role = options.role ?? "chief", name = "SpawnSeat";
		if (options.rosterState === "dangling") symlinkSync(join(home, "missing-roster.json"), rosterPath);
		else if (options.rosterState !== "missing") writeFileSync(rosterPath, options.rosterState === "malformed" ? "{broken" : JSON.stringify({
			chiefs: { lead: role === "chief" ? name : "OtherChief", peers: [] },
			sessions: { test: { seats: { [name]: { role } } } },
		}));
		writeFileSync(join(agentDir, "config.yml"), JSON.stringify({ task: { agentModelOverrides: options.overrides ?? {} } }));
		writeFileSync(join(project, ".omp", "agents", "muse-worker.md"), `---\nname: muse-worker\ndescription: Read-only Muse worker\nmodel: ${MUSE}\n---\nRead the requested source.\n`);
		const settings = await runtime.Settings.loadReadOnly({ cwd: project, agentDir });
		const h = await createFlywheelHost(base, { env: { AGENT_NAME: name,
			...(options.rosterLocation === "override" ? { OMP_KIT_FLEET_ROSTER: rosterPath } : {}),
			...(options.rosterLocation === "xdg" ? { XDG_CONFIG_HOME: configHome } : {}) }, home });
		const input = { context: "Read-only analysis", tasks: [{ task: "Read-only: analyze the model choice", ...(options.agent ? { agent: options.agent } : {}), ...(options.requestModel ? { model: options.requestModel } : {}) }] };
		const ctx = { ...h.ctx(project), model: { provider: "anthropic", id: "claude-opus-5-5" },
			...(options.query === false ? {} : { models: { resolve: (patterns: string) => runtime.resolveModelRoleValue(patterns, models, { settings }).model } }) };
		const [raw] = await h.emit("tool_call", { toolCallId: `spawn-${freshSeq++}`, toolName: "task", input }, ctx);
		return raw as FlywheelToolCallResult | undefined;
	}

	for (const role of ["chief", "director"] as const) {
		test(`planted: ${role} without an override cannot spawn from an Opus parent`, async () => {
			const result = await spawnSeat({ role });
			expect(result?.block).toBe(true);
			expect(result?.reason).toContain("SPAWN_MODEL_REFUSED");
			expect(result?.reason).toContain("OPUS_CLASS");
			expect(result?.reason).toContain("J-2026-10-18-33");
		});
	}
	test("planted: an Opus settings override is refused", async () => {
		const result = await spawnSeat({ overrides: { task: OPUS } });
		expect(result?.block).toBe(true);
		expect(result?.reason).toContain("OPUS_CLASS");
	});
	test("control: a persisted Sol override is admitted", async () => {
		expect((await spawnSeat({ overrides: { task: SOL } }))?.block).not.toBe(true);
	});
	for (const rosterLocation of ["override", "xdg"] as const) {
		test(`control: ${rosterLocation} operator roster path is honored`, async () => {
			expect((await spawnSeat({ overrides: { task: SOL }, rosterLocation }))?.block).not.toBe(true);
		});
	}
	test("stock-home control: an identified non-fleet seat with no roster admits an Opus-parent task", async () => {
		expect((await spawnSeat({ rosterState: "missing", overrides: { task: OPUS }, query: false }))?.block).not.toBe(true);
	});
	for (const rosterState of ["missing", "malformed"] as const) {
		test(`planted: configured ${rosterState} roster refuses an Opus spawn with a named reason`, async () => {
			for (const role of ["chief", "director"] as const) {
				const result = await spawnSeat({ role, overrides: { task: OPUS }, rosterState, rosterLocation: "override" });
				expect(result?.block).toBe(true);
				expect(result?.reason).toContain("SPAWN_ROSTER_UNREADABLE");
			}
		});
	}
	for (const rosterState of ["malformed", "dangling"] as const) {
		test(`planted: an existing ${rosterState} default roster remains fail-closed`, async () => {
			const result = await spawnSeat({ overrides: { task: OPUS }, rosterState });
			expect(result?.block).toBe(true);
			expect(result?.reason).toContain("SPAWN_ROSTER_UNREADABLE");
		});
	}
	test("control: a project agent explicitly selecting Muse is admitted", async () => {
		expect((await spawnSeat({ agent: "muse-worker" }))?.block).not.toBe(true);
	});
	test("control: a non-lead builder is unaffected even without model-query support", async () => {
		expect((await spawnSeat({ role: "builder", overrides: { task: OPUS }, query: false }))?.block).not.toBe(true);
	});
	test("unknown model and unavailable query fail closed with named reasons", async () => {
		const unavailable = await spawnSeat({ overrides: { task: "unreachable-provider/no-model" } });
		expect(unavailable?.block).toBe(true);
		expect(unavailable?.reason).toContain("MODEL_UNAVAILABLE");
		const query = await spawnSeat({ overrides: { task: SOL }, query: false });
		expect(query?.block).toBe(true);
		expect(query?.reason).toContain("MODEL_QUERY_UNAVAILABLE");
	});
	test("SPAWNNATIVE1: on a native host the task call no longer runs the settings-import check; its spawn event still refuses Opus and admits Sol", async () => {
		const home = freshDir(base, "native-task-home-"), project = freshDir(base, "native-task-project-");
		const rosterPath = join(home, "roster.json");
		writeFileSync(rosterPath, JSON.stringify({ chiefs: { lead: "SpawnSeat", peers: [] }, sessions: {} }));
		const handlers = new Map<string, unknown>();
		await kitFlywheelGuard({
			on: (event: string, handler: unknown) => { handlers.set(event, handler); },
			getAllTools: () => [],
			sendMessage: () => {},
			exec: async () => ({ code: 127, stdout: "", stderr: "not needed" }),
		}, { home, env: { AGENT_NAME: "SpawnSeat" }, rosterPath });
		const opusModel = { provider: "anthropic", id: "claude-opus-5-5" }, solModel = { provider: "openai-codex", id: "gpt-6.1-sol" };
		// An Opus parent with no override: the legacy task-call path refuses this child (OPUS inheritance).
		const ctx: FlywheelContext = { cwd: project, model: opusModel,
			models: { resolve: (p: string) => p.includes("sol") ? solModel : opusModel } };
		const call = handlers.get("tool_call") as (e: unknown, c: FlywheelContext) => Promise<FlywheelToolCallResult | undefined>;
		const taskResult = await call({ toolName: "task", toolCallId: "native-task", input: { context: "Read-only analysis", tasks: [{ task: "Read-only: analyze the model choice" }] } }, ctx);
		expect(taskResult?.reason ?? "").not.toContain("SPAWN_MODEL_REFUSED");
		const spawn = handlers.get("before_subagent_spawn") as (e: FlywheelBeforeSubagentSpawnEvent, c: FlywheelContext) => Promise<FlywheelToolCallResult | undefined>;
		const opus = await spawn({ type: "before_subagent_spawn", agent: "task", invocationKind: "task", patterns: [OPUS] }, ctx);
		expect(opus?.block).toBe(true);
		expect(opus?.reason).toContain("SPAWN_MODEL_REFUSED");
		const sol = await spawn({ type: "before_subagent_spawn", agent: "task", invocationKind: "task", patterns: [SOL] }, ctx);
		expect(sol?.block ?? false).toBe(false);
	});
});

describe("AGENTMODEL1 native final-policy boundary", () => {
	const SOL = "openai-codex/gpt-6.1-sol", OPUS = "anthropic/claude-opus-5-5";
	async function finalPolicy(model: string, options: { role?: "chief" | "builder"; query?: boolean; subagent?: boolean; rosterState?: "missing" | "malformed"; configured?: boolean } = {}) {
		const runtime = await loadSpawnModelRuntime();
		// Resolve against the real installed catalog and native session settings.
		const { getBundledModels } = await import(import.meta.resolve("@oh-my-pi/pi-catalog/models", join(runtime.source, "index.ts")));
		const models: SpawnModelIdentity[] = ["anthropic", "openai-codex", "muse-code"].flatMap(provider => getBundledModels(provider));
		const home = freshDir(base, "final-policy-"), project = freshDir(base, "final-project-");
		const rosterDir = join(home, ".config", "omp-kit"), agentDir = join(home, ".omp", "agent");
		mkdirSync(rosterDir, { recursive: true });
		mkdirSync(agentDir, { recursive: true });
		writeFileSync(join(agentDir, "config.yml"), JSON.stringify({ task: { agentModelOverrides: { task: SOL } } }));
		if (options.rosterState !== "missing") writeFileSync(join(rosterDir, "fleet-roster.json"), options.rosterState === "malformed" ? "{broken" : JSON.stringify({
			chiefs: { lead: options.role === "builder" ? "OtherChief" : "NativeSeat", peers: [] },
			sessions: { test: { seats: { NativeSeat: { role: options.role ?? "chief" } } } },
		}));
		// Disk remains Sol while the effective in-memory session may select Opus.
		const settings = runtime.Settings.isolated({ "task.agentModelOverrides": { task: model } });
		const patterns = runtime.resolveAgentModelSelection({ settings,
			settingsOverride: model, agentModel: "@task", activeModelPattern: OPUS }).patterns;
		const handlers = new Map<string, unknown>();
		await kitFlywheelGuard({
			on: (event: string, handler: unknown) => { handlers.set(event, handler); },
			// Native registration happens before the tool registry is populated.
			getAllTools: () => [],
			sendMessage: () => {},
			exec: async () => ({ stdout: "", stderr: "not needed", code: 127 }),
		}, { home, env: { AGENT_NAME: "NativeSeat", ...(options.configured ? { OMP_KIT_FLEET_ROSTER: join(rosterDir, "fleet-roster.json") } : {}) } });
		const handler = handlers.get("before_subagent_spawn");
		if (typeof handler !== "function") throw new Error("Native spawn event was not registered");
		const ctx: FlywheelContext = { cwd: project, agent: { kind: options.subagent ? "sub" : "main" },
			model: { provider: "anthropic", id: "claude-opus-5-5" },
			...(options.query === false ? {} : { models: { resolve: (value: string) => runtime.resolveModelRoleValue(value, models, { settings }).model } }) };
		const event: FlywheelBeforeSubagentSpawnEvent = { type: "before_subagent_spawn", agent: "task", invocationKind: "task", patterns };
		return await handler(event, ctx) as FlywheelToolCallResult | undefined;
	}
	test("planted: core's session-only Opus override is refused even when disk says Sol", async () => {
		const result = await finalPolicy(OPUS);
		expect(result?.block).toBe(true);
		expect(result?.reason).toContain("SPAWN_MODEL_REFUSED");
		expect(result?.reason).toContain("OPUS_CLASS_CANDIDATE");
	});
	test("control: core's final Sol model is admitted", async () => {
		expect((await finalPolicy(SOL))?.block).not.toBe(true);
	});
	test("stock-home native control: an identified non-fleet seat with no roster admits an Opus spawn", async () => {
		expect((await finalPolicy(OPUS, { rosterState: "missing", query: false }))?.block).not.toBe(true);
	});
	for (const rosterState of ["missing", "malformed"] as const) {
		test(`planted: final ${rosterState} roster refuses an Opus spawn by name`, async () => {
			const result = await finalPolicy(OPUS, { rosterState, configured: true });
			expect(result?.block).toBe(true);
			expect(result?.reason).toContain("SPAWN_ROSTER_UNREADABLE");
		});
	}
	test("final unresolvable model or unavailable model query fails closed", async () => {
		expect((await finalPolicy("unreachable-provider/no-model"))?.reason).toContain("MODEL_UNAVAILABLE");
		expect((await finalPolicy(SOL, { query: false }))?.reason).toContain("MODEL_QUERY_UNAVAILABLE");
	});
	test("non-lead workers and child sessions with inherited chief environment are unaffected", async () => {
		expect((await finalPolicy(OPUS, { role: "builder" }))?.block).not.toBe(true);
		expect((await finalPolicy(OPUS, { subagent: true }))?.block).not.toBe(true);
	});
});

describe("RETIREGUARD1 legitimate work", () => {
	for (const name of ["SilverCondor", "JadeThrush", "RusticPine", "PeachLeopard"]) {
		test(`human questions: ${name} may request explicit human authority`, async () => {
			const { result } = await askSeat(name, undefined, true, withDefault, "goal");
			expect(result?.block).not.toBe(true);
		});
	}
	test("flat work selection: unpinned repair survives an unreadable cut, not unreadable custody", async () => {
		const f = await cutFixture();
		expect(await toolCall(f.h, f.repo, "br --actor Holder update k-2 --claim")).toBeUndefined();
		writeFileSync(f.config, "{broken");
		expect(await toolCall(f.h, f.repo, "br --actor Holder update k-2 --claim")).toBeUndefined();
		f.rows["k-2"]!.status = "blocked";
		expect((await toolCall(f.h, f.repo, "br --actor Holder update k-2 --claim"))?.reason).toContain("CLAIM_REFUSED");
		f.rows["k-2"]!.status = "open";
		f.rows["k-2"]!.assignee = "Peer";
		expect((await toolCall(f.h, f.repo, "br --actor Holder update k-2 --claim"))?.reason).toContain("CLAIM_REFUSED");
		delete f.rows["k-2"];
		expect((await toolCall(f.h, f.repo, "br --actor Holder update k-2 --claim"))?.reason).toContain("CLAIM_REFUSED");
	});
	test("gap prose: first comment and mail proceed with no scanner available", async () => {
		const h = await createFlywheelHost(base, { respond: () => ({ code: 127, stdout: "", stderr: "scanner unavailable" }) });
		expect(await toolCall(h, base, "br comments add kit-1 'the gate should say X; gap in output'")).toBeUndefined();
		const [mail] = await h.emit("tool_call", { toolName: "write", input: {
			path: "xd://mcp__mcp_agent_mail_send_message", content: JSON.stringify({ subject: "DONE gap in output" }),
		} }, h.ctx(base));
		expect(mail).toBeUndefined();
		// Rewording the description cannot bypass acceptance replay.
		expect((await toolCall(h, base, 'br close kit-1 --reason "gap fixed; acceptance not run"'))?.reason).toContain("NARROW_CLOSE_REFUSED");
	});
	test("owned job completion: main seat can collect native wait and bounded timers", async () => {
		const h = await createFlywheelHost(base, { env: { AGENT_NAME: "Builder" } });
		expect(await callAs(h, base, "wait-owned", "wait", {})).toEqual([undefined]);
		expect(await bashInput(h, { command: "python3 scripts/idle_wait.py", timeout: 60 })).toBeUndefined();
		expect(await bashInput(h, { command: "sleep 30", timeout: 60 })).toBeUndefined();
		expect((await bashInput(h, { command: "while true; do sleep 1; done", timeout: 0 }))?.reason).toContain("FINITE_JOB_NO_DEADLINE");
		const failed = await run([process.execPath, "-e", "process.exit(7)"], { deadline_s: 10, max_output_bytes: 1024 });
		expect(failed.rc).toBe(7);
	});
	test("prior art is not a close password; incomplete acceptance still refuses", async () => {
		const h = await createFlywheelHost(base, { env: { BR_ACTOR: "Verifier" }, respond: brTable({
			"kit-fix": { code: 0, stdout: JSON.stringify([{ id: "kit-fix", status: "in_review",
				assignee: "Builder", created_by: "Filer", issue_type: "bug", comments: [] }]) },
		}) });
		expect(await toolCall(h, base, 'br close kit-fix --reason "bun test -> 8 passed"')).toBeUndefined();
		expect((await toolCall(h, base, 'br close kit-fix --reason "acceptance not run"'))?.reason).toContain("NARROW_CLOSE_REFUSED");
	});
	test("bounded task context: authorized build launches without a citation password", async () => {
		const project = stockRepo();
		const h = await createFlywheelHost(base, { respond: call => call.command === "br"
			? { code: 127, stdout: "", stderr: "tracker unavailable" }
			: { code: 0, stdout: project, stderr: "" } });
		const [verdict] = await h.emit("tool_call", { toolName: "task", input: {
			context: `Repo: ${project}`,
			tasks: [{ task: "# Target\nBead ompkit-abc1.1. These paths are reserved for you: src/x.ts.\n# Change\nFix the authorized bug.\n# Acceptance\nRun the consumer test." }],
		} }, h.ctx(project));
		expect((verdict as FlywheelToolCallResult | undefined)?.block).not.toBe(true);
	});
});

test("RETIREGUARD1 restored wait veto kills the owned-job PASS control", async () => {
	const allocation = ownedTmp("retired-wait-mutant", { root: base });
	try {
		const preload = join(allocation.path, "restore-wait.ts");
		writeFileSync(preload, `
			Bun.plugin({ name: "restore-retired-wait-veto", setup(build) {
				build.onLoad({ filter: /kit-flywheel-guard[.]ts$/ }, async ({ path }) => {
					const source = await Bun.file(path).text();
					const site = 'const guardVerdict = async (event: FlywheelToolCallEvent, ctx: FlywheelContext): Promise<FlywheelToolCallResult | undefined> => {';
					if (source.split(site).length !== 2) throw new Error("RESTORE_SITE_NOT_UNIQUE");
					return { contents: source.replace(site, site + '\\nif (event.toolName === "wait" && admissionOwner(env) !== null) return { block: true, reason: "restored main-seat wait veto" };'), loader: "ts" };
				});
			} });
		`);
		const result = await run([process.execPath, "test", "--preload", preload, import.meta.path,
			"-t", "owned job completion: main seat"], {
			deadline_s: fixtureDeadlineS(30), max_output_bytes: 65536, cwd: import.meta.dir,
			env: { ...process.env, TMPDIR: allocation.path },
		});
		expect(result.timed_out).toBe(false);
		expect(result.rc).toBe(1);
		const output = new TextDecoder().decode(result.stdout) + new TextDecoder().decode(result.stderr);
		expect(output).toContain("restored main-seat wait veto");
		expect(output).toContain("1 fail");
	} finally { allocation.cleanup(); }
});
