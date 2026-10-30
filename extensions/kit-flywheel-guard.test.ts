import { afterAll, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { FLYWHEEL_EXEC_TIMEOUT_MS, isMutatingCall, trackerRequests, type FlywheelExecResult, type FlywheelToolCallResult } from "./kit-flywheel-guard";
import { checkNoWait } from "./kit-flywheel-guard";
import { checkBgWait } from "./kit-flywheel-guard";
import { createFlywheelHost, toolCall, bashInput, type FakeHost, type Responder } from "../tests/fleet-guard/kit-flywheel-host";
import { ownedTmp } from "../src/kitlib/tmp.ts";
import { run } from "../src/kitlib/run.ts";

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


// --- ASKBLOCK1 -----------------------------------------------------------

async function askSeat(name?: string, roster: unknown = {
	sessions: { "omp-test": { seats: {
		SilverCondor: { role: "builder" }, JadeThrush: { role: "grader" }, RusticPine: { role: "director" },
	} } },
}, held = true) {
	const home = freshDir(base, "ask-home-");
	const dir = join(home, ".claude", "skills", "omp-kit-orchestration");
	mkdirSync(dir, { recursive: true });
	if (roster !== null) writeFileSync(join(dir, "fleet-roster.json"), typeof roster === "string" ? roster : JSON.stringify(roster));
	const h = await createFlywheelHost(base, { home, env: name ? { AGENT_NAME: name } : {}, respond: () => ({
		code: 0, stdout: JSON.stringify(held ? [{ id: "ompkit-worker-task", status: "in_progress", assignee: name }] : []),
	}) });
	const [result] = await h.emit("tool_call", { toolCallId: "ask-1", toolName: "ask", input: { question: "Which option?" } }, h.ctx(base));
	return { h, result: result as FlywheelToolCallResult | undefined };
}

for (const name of ["SilverCondor", "JadeThrush"]) {
	test(`ASKBLOCK1: ${name} worker ask is refused before the host opens a dialog`, async () => {
		const { h, result } = await askSeat(name);
		let dialogs = 0;
		if (result?.block !== true) dialogs++;
		expect(dialogs).toBe(0);
		expect(result?.reason).toContain("QUESTION mail");
		expect(result?.reason).toContain("ompkit-worker-task");
		expect(h.sent).toEqual([]);
	});
}

test("ASKBLOCK1: unknown held bead still refuses and names the bead you hold", async () => {
	const { result } = await askSeat("SilverCondor", undefined, false);
	expect(result?.block).toBe(true);
	expect(result?.reason).toContain("the bead you hold");
	expect(result?.reason).toContain("QUESTION mail");
});

for (const name of ["RusticPine", "PeachLeopard", undefined]) {
	test(`ASKBLOCK1 control: ${name ?? "unbound session"} ask is allowed`, async () => {
		const { result } = await askSeat(name);
		expect(result?.block).not.toBe(true);
	});
}

for (const roster of [null, "{broken", { sessions: null }]) {
	test(`ASKBLOCK1 control: unreadable roster ${JSON.stringify(roster)} allows and says so`, async () => {
		const { h, result } = await askSeat("SilverCondor", roster);
		expect(result?.block).not.toBe(true);
		expect(result?.additionalContext).toContain("roster");
		expect(result?.additionalContext).toContain("allowed");
		expect(h.notices.join("\n")).toContain("allowed");
	});
}

// --- COMPACTION_REREAD ---------------------------------------------------

function stockRepo(parent = base): string {
	const cwd = freshDir(parent, "stock-repo-");
	const git = Bun.spawnSync(["git", "init", "--quiet", cwd]);
	if (git.exitCode !== 0) throw new Error(git.stderr.toString());
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

// --- SELF_CLOSE_REFUSED --------------------------------------------------

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
	const project = freshDir(base, "proj-");
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
	const cwd = freshDir(base, "reread-");
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

test("NO_WAIT_REFUSED: a fleet seat's idle_wait.py and sleep >= 30 s are refused, bare chained wrapped or sh -c (J-2026-10-18-43)", async () => {
	const cwd = freshDir(base, "nowait-");
	const h = await createFlywheelHost(base, { env: { AGENT_NAME: "CopperTrout" } });
	for (const command of [
		"python3 scripts/idle_wait.py --minutes 10",
		"python3.13 /tmp/idle_wait.py",
		"./tools/idle_wait.py",
		"idle_wait.py && br ready --json",
		"make build && python3 scripts/idle_wait.py",
		"sh -c 'sleep 60'",
		"bash -lc \"python3 idle_wait.py\"",
		"env sleep 45",
		"sleep 600",
		"sleep 30",
		"sleep 30s",
		"sleep 5m",
		"sleep 1h",
		"sleep 20 20",
		"make build && sleep 120",
		"BR_ACTOR=X sh -c 'sleep 90'",
	]) {
		const [result] = await callAs(h, cwd, "w", "bash", { command });
		expect((result as FlywheelToolCallResult)?.block).toBe(true);
		expect((result as FlywheelToolCallResult)?.reason).toContain("NO_WAIT_REFUSED");
		expect((result as FlywheelToolCallResult)?.reason).toContain("bead DAG repair");
		expect((result as FlywheelToolCallResult)?.reason).toContain("/skill:reality-check-for-project");
		expect((result as FlywheelToolCallResult)?.reason).toContain("/skill:profiling-software-performance");
	}
});

test("NO_WAIT_REFUSED negatives: short sleeps, mere mentions and identity-less sessions pass", async () => {
	const cwd = freshDir(base, "nowait-");
	const seat = await createFlywheelHost(base, { env: { AGENT_NAME: "CopperTrout" } });
	for (const command of [
		"sleep 2",
		"sleep 29",
		"sleep 0.5",
		"sleep 10 && make test",
		"sleep --version",
		"echo sleep 600",
		"echo idle_wait.py",
		"grep -n 'sleep 600' scripts/poll.sh",
		"grep -rn idle_wait.py docs/",
	]) {
		expect(await callAs(seat, cwd, "s", "bash", { command })).toEqual([undefined]);
	}
	const person = await createFlywheelHost(base, { env: {} });
	expect(await callAs(person, cwd, "s", "bash", { command: "sleep 600" })).toEqual([undefined]);
	expect(await callAs(person, cwd, "s", "bash", { command: "python3 idle_wait.py" })).toEqual([undefined]);
});

test("NO_WAIT_REFUSED seam: the pure check refuses the planted wait and passes without identity", () => {
	const event = { toolCallId: "w", toolName: "bash", input: { command: "sleep 600" } };
	expect(checkNoWait(event, "CopperTrout")?.block).toBe(true);
	expect(checkNoWait(event, null)).toBeUndefined();
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
	const cwd = freshDir(base, "reread-plain-");
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
		return { stdout: JSON.stringify([{ id, title: "t", status: row.status, assignee: row.assignee, updated_at: row.updatedAt ?? "2026-10-19T19:00:00Z" }]), stderr: "", code: 0 };
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

// --- BGWAIT1 (ompkit-fp72.19.1.24): seats never block their turn on their own background work ---

test("WAIT_REFUSED: a fleet seat's wait tool call is refused and names the next action (BGWAIT1)", async () => {
	const cwd = freshDir(base, "bgwait-");
	const h = await createFlywheelHost(base, { env: { AGENT_NAME: "CopperTrout" } });
	for (const input of [{}, { timeout: 120000 }]) {
		const [result] = await callAs(h, cwd, "w", "wait", input);
		expect((result as FlywheelToolCallResult)?.block).toBe(true);
		expect((result as FlywheelToolCallResult)?.reason).toContain("WAIT_REFUSED");
		expect((result as FlywheelToolCallResult)?.reason).toContain("Take the next item");
		expect((result as FlywheelToolCallResult)?.reason).toContain("later tool boundary");
	}
});

test("WAIT_REFUSED: a fleet seat's sleep-poll loops, chained sleeps and time.sleep idles are refused (BGWAIT1)", async () => {
	const cwd = freshDir(base, "bgwait-");
	const h = await createFlywheelHost(base, { env: { AGENT_NAME: "CopperTrout" } });
	for (const command of [
		"for i in $(seq 1 100); do [ -f rc ] && break; sleep 10; done",
		"while [ ! -f rc ]; do sleep 5; done",
		"until make ready; do sleep 10; done",
		"sleep 20 && sleep 20",
		"sleep 15; make test; sleep 15",
		"python3 -c \"import time; time.sleep(30)\"",
		"python3 -c \"import time\nwhile True:\n    time.sleep(5)\"",
		"python3 -c \"import time\nfor i in range(10):\n    time.sleep(1)\n    poll()\"",
	]) {
		const [result] = await callAs(h, cwd, "w", "bash", { command });
		expect((result as FlywheelToolCallResult)?.block).toBe(true);
		expect((result as FlywheelToolCallResult)?.reason).toContain("WAIT_REFUSED");
		expect((result as FlywheelToolCallResult)?.reason).toContain("Take the next item");
	}
	const [evaled] = await callAs(h, cwd, "e", "eval", { language: "py", code: "import time\nwhile True:\n    time.sleep(5)" });
	expect((evaled as FlywheelToolCallResult)?.block).toBe(true);
	expect((evaled as FlywheelToolCallResult)?.reason).toContain("WAIT_REFUSED");
});

test("WAIT_REFUSED negatives: async jobs, short single sleeps and identity-less sessions pass (BGWAIT1)", async () => {
	const cwd = freshDir(base, "bgwait-");
	const seat = await createFlywheelHost(base, { env: { AGENT_NAME: "CopperTrout" } });
	for (const input of [
		{ command: "sleep 2" },
		{ command: "sleep 10 && make test" },
		{ command: "for f in *.log; do echo $f; done" },
		{ command: "python3 -c \"import time; time.sleep(2)\"" },
		{ command: "for i in $(seq 1 100); do [ -f rc ] && break; sleep 10; done", async: true },
		{ command: "sleep 60", async: true },
	]) {
		expect(await callAs(seat, cwd, "s", "bash", input)).toEqual([undefined]);
	}
	expect(await callAs(seat, cwd, "e", "eval", { language: "py", code: "import time\ntime.sleep(2)" })).toEqual([undefined]);
	const person = await createFlywheelHost(base, { env: {} });
	expect(await callAs(person, cwd, "s", "bash", { command: "for i in $(seq 1 5); do sleep 10; done" })).toEqual([undefined]);
	expect(await callAs(person, cwd, "w", "wait", {})).toEqual([undefined]);
});

test("WAIT_REFUSED seam: the pure check refuses each planted form and passes without identity", () => {
	expect(checkBgWait({ toolCallId: "w", toolName: "wait", input: {} }, "CopperTrout")?.block).toBe(true);
	expect(checkBgWait({ toolCallId: "w", toolName: "bash", input: { command: "while true; do sleep 1; done" } }, "CopperTrout")?.block).toBe(true);
	expect(checkBgWait({ toolCallId: "w", toolName: "bash", input: { command: "sleep 20 && sleep 20" } }, "CopperTrout")?.block).toBe(true);
	expect(checkBgWait({ toolCallId: "w", toolName: "bash", input: { command: "python3 -c \"import time; time.sleep(30)\"" } }, "CopperTrout")?.block).toBe(true);
	expect(checkBgWait({ toolCallId: "w", toolName: "bash", input: { command: "sleep 2" } }, "CopperTrout")).toBeUndefined();
	expect(checkBgWait({ toolCallId: "w", toolName: "wait", input: {} }, null)).toBeUndefined();
});
