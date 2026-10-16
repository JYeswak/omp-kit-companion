import { afterAll, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import kitFlywheelGuard, {
    FlywheelToolCallEvent,
	type FlywheelContext,
	type FlywheelExecOptions,
	type FlywheelExecResult,
	type FlywheelMessage,
	type FlywheelToolCallResult,
} from "./kit-flywheel-guard";
import { trackerRequests } from "./kit-flywheel-guard";

const base = mkdtempSync(join(tmpdir(), "kit-flywheel-guard-"));

afterAll(() => {
	rmSync(base, { recursive: true, force: true });
});

interface ExecCall { command: string; args: string[]; options?: FlywheelExecOptions }
type Responder = (call: ExecCall) => FlywheelExecResult | Promise<FlywheelExecResult>;
type CompactHandler = (event: { type: "session_compact" }, ctx: FlywheelContext) => unknown;
type ToolHandler = (event: FlywheelToolCallEvent, ctx: FlywheelContext) => unknown;
type HostRegistration = ["session_compact", CompactHandler] | ["tool_call", ToolHandler];

interface FakeHost {
	emit(type: string, event: Record<string, unknown>, ctx: FlywheelContext): Promise<unknown[]>;
	ctx(cwd: string, idle?: boolean): FlywheelContext;
	sent: { message: FlywheelMessage; options?: { deliverAs?: string } }[];
	execs: ExecCall[];
	notices: string[];
}

/** Fake omp host: records handlers, sent messages and every exec the guard makes. */
async function host(opts: { env?: Record<string, string | undefined>; home?: string; respond?: Responder } = {}): Promise<FakeHost> {
	const compacts: CompactHandler[] = [];
	const tools: ToolHandler[] = [];
	const sent: FakeHost["sent"] = [];
	const execs: ExecCall[] = [];
	const notices: string[] = [];
	const respond: Responder = opts.respond ?? (() => ({ stdout: "", stderr: "not stubbed", code: 127 }));
	const pi = {
		on: (...args: HostRegistration) => {
			if (args[0] === "session_compact") compacts.push(args[1]);
			else tools.push(args[1]);
		},
		sendMessage: (message: FlywheelMessage, options?: { deliverAs?: string }) => void sent.push({ message, options }),
		exec: async (command: string, args: string[], options?: FlywheelExecOptions) => {
			const call = { command, args, options };
			execs.push(call);
			return respond(call);
		},
	};
	await kitFlywheelGuard(pi, { env: opts.env ?? {}, home: opts.home ?? join(base, "no-home") });
	const emit = async (type: string, event: Record<string, unknown>, ctx: FlywheelContext): Promise<unknown[]> => {
		const results: unknown[] = [];
		if (type === "session_compact") {
			for (const handler of compacts) results.push(await handler({ type: "session_compact" }, ctx));
		} else if (type === "tool_call") {
			for (const handler of tools) results.push(await handler({ ...event, type: "tool_call" }, ctx));
		}
		return results;
	};
	const ctx = (cwd: string, idle = true): FlywheelContext =>
		({ cwd, isIdle: () => idle, ui: { notify: (message: string) => void notices.push(message) } });
	return { emit, ctx, sent, execs, notices };
}

function identityHome(project: string, paneKey: string, content: string): string {
	const home = mkdtempSync(join(base, "home-"));
	const hash = createHash("sha1").update(project).digest("hex").slice(0, 12);
	const dir = join(home, ".config", "agent-mail", "identity", hash);
	mkdirSync(dir, { recursive: true });
	writeFileSync(join(dir, paneKey), content);
	return home;
}

function bead(id: string, assignee: string | null): FlywheelExecResult {
	return { stdout: JSON.stringify([{ id, title: "t", status: "in_progress", assignee }]), stderr: "", code: 0 };
}

/** tmux has no composite key; `br show` answers from a table, misses shaped like br 0.7.4 (JSON error on stdout, tracing on stderr). */
function brTable(table: Record<string, FlywheelExecResult>): Responder {
	return call => {
		if (call.command === "tmux") return { stdout: "", stderr: "no server", code: 1 };
		const id = call.args[1] ?? "";
		return table[id] ?? {
			stdout: JSON.stringify({ error: { code: "ISSUE_NOT_FOUND", message: `Issue not found: ${id}` } }),
			stderr: "2026-10-09T20:42:45Z  INFO fsqlite::runtime: event=\"region_closed\"\n",
			code: 3,
		};
	};
}

async function toolCall(h: FakeHost, cwd: string, command: string): Promise<FlywheelToolCallResult | undefined> {
	const [result] = await h.emit("tool_call", { toolCallId: "c1", toolName: "bash", input: { command } }, h.ctx(cwd));
	return result as FlywheelToolCallResult | undefined;
}

async function bashInput(h: FakeHost, input: Record<string, unknown>): Promise<FlywheelToolCallResult | undefined> {
	const [result] = await h.emit("tool_call", { toolCallId: "c1", toolName: "bash", input }, h.ctx("/repo"));
	return result as FlywheelToolCallResult | undefined;
}

// --- COMPACTION_REREAD ---------------------------------------------------

test("COMPACTION_REREAD: session_compact injects a reread of the nearest AGENTS.md and br show", async () => {
	const root = mkdtempSync(join(base, "proj-"));
	const repo = join(root, "repo");
	const cwd = join(repo, "pkg", "deep");
	mkdirSync(cwd, { recursive: true });
	writeFileSync(join(root, "AGENTS.md"), "outer\n");
	writeFileSync(join(repo, "AGENTS.md"), "inner\n");
	const h = await host();
	await h.emit("session_compact", { compactionEntry: { type: "compaction", id: "e1" }, fromExtension: false }, h.ctx(cwd));
	expect(h.sent.length).toBe(1);
	const { message, options } = h.sent[0]!;
	expect(message.content).toContain("COMPACTION_REREAD");
	expect(message.content).toContain(`reread ${join(repo, "AGENTS.md")} in full`);
	expect(message.content).not.toContain(join(root, "AGENTS.md") + " ");
	expect(message.content).toContain("br show <id>");
	expect(options?.deliverAs).toBe("nextTurn");
});

test("COMPACTION_REREAD: mid-run compaction injects at the next step boundary and names the pane identity", async () => {
	const cwd = mkdtempSync(join(base, "proj-"));
	writeFileSync(join(cwd, "AGENTS.md"), "rules\n");
	const home = identityHome(cwd, "41", "{\"name\":\"AmberHeron\"}");
	const h = await host({ env: { TMUX_PANE: "%41" }, home, respond: brTable({}) });
	await h.emit("session_compact", { compactionEntry: {}, fromExtension: false }, h.ctx(cwd, false));
	expect(h.sent.length).toBe(1);
	expect(h.sent[0]!.options?.deliverAs).toBe("aside");
	expect(h.sent[0]!.message.content).toContain("--assignee AmberHeron");
});

test("COMPACTION_REREAD negative: an ordinary turn emits nothing", async () => {
	const cwd = mkdtempSync(join(base, "proj-"));
	writeFileSync(join(cwd, "AGENTS.md"), "rules\n");
	const h = await host();
	const c = h.ctx(cwd);
	for (const type of ["session_start", "turn_start", "message_start", "message_end", "turn_end", "agent_end"]) await h.emit(type, {}, c);
	expect(await toolCall(h, cwd, "ls -la && git status --short")).toBeUndefined();
	expect(h.sent).toEqual([]);
	expect(h.execs).toEqual([]);
});

// --- SELF_CLOSE_REFUSED --------------------------------------------------

test("SELF_CLOSE_REFUSED: closing a bead assigned to the caller's pane identity is blocked", async () => {
	const project = mkdtempSync(join(base, "proj-"));
	const tracker = join(project, "tracker");
	mkdirSync(tracker);
	const home = identityHome(project, "77", "{\"name\":\"BlueFox\"}");
	const h = await host({ env: { TMUX_PANE: "%77" }, home, respond: brTable({ "kit-1": bead("kit-1", "BlueFox") }) });
	const result = await toolCall(h, project, "cd tracker && br close kit-1 --reason \"done, tests pass\"");
	expect(result?.block).toBe(true);
	expect(result?.reason).toContain("SELF_CLOSE_REFUSED");
	expect(result?.reason).toContain("kit-1 is assigned to BlueFox");
});

test("SELF_CLOSE_REFUSED: bd close, composite pane key and plain-text identity file are honoured", async () => {
	const project = mkdtempSync(join(base, "proj-"));
	const home = identityHome(project, "fleet-0-3", "GreenLynx\n");
	const respond: Responder = call => call.command === "tmux"
		? { stdout: "fleet:0:3\n", stderr: "", code: 0 }
		: bead("kit-2", "GreenLynx");
	const h = await host({ env: { TMUX_PANE: "%90" }, home, respond });
	const result = await toolCall(h, project, "bd close kit-2");
	expect(result?.block).toBe(true);
});

test("SELF_CLOSE_REFUSED: --actor, BR_ACTOR and BR_AGENT_NAME identify the caller", async () => {
	const project = mkdtempSync(join(base, "proj-"));
	const table = brTable({ "kit-3": bead("kit-3", "RedOwl") });
	const flag = await host({ respond: table });
	expect((await toolCall(flag, project, "br --actor RedOwl close kit-3"))?.block).toBe(true);
	const inline = await host({ respond: table });
	expect((await toolCall(inline, project, "BR_ACTOR=RedOwl br close kit-3"))?.block).toBe(true);
	const env = await host({ env: { BR_AGENT_NAME: "RedOwl" }, respond: table });
	expect((await toolCall(env, project, "br close --db .beads/beads.db kit-3"))?.block).toBe(true);
});

test("SELF_CLOSE_REFUSED negative: a different closer is allowed silently", async () => {
	const project = mkdtempSync(join(base, "proj-"));
	const home = identityHome(project, "77", "{\"name\":\"Director\"}");
	const h = await host({ env: { TMUX_PANE: "%77" }, home, respond: brTable({ "kit-1": bead("kit-1", "BlueFox") }) });
	expect(await toolCall(h, project, "br close kit-1 --reason \"bun test extensions/kit-flywheel-guard.test.ts -> 26 passed\"")).toBeUndefined();
	expect(h.notices).toEqual([]);
});

test("SELF_CLOSE_REFUSED negative: an unassigned bead is allowed with a warning", async () => {
	const project = mkdtempSync(join(base, "proj-"));
	const home = identityHome(project, "77", "{\"name\":\"BlueFox\"}");
	const h = await host({ env: { TMUX_PANE: "%77" }, home, respond: brTable({ "kit-4": bead("kit-4", null) }) });
	const result = await toolCall(h, project, "br close kit-4");
	expect(result?.block).toBeUndefined();
	expect(result?.additionalContext).toContain("kit-4 has no assignee");
	expect(h.notices.length).toBe(1);
});

test("LOOKUP_REFUSED: evidence-bearing close is blocked when br show fails", async () => {
	const project = mkdtempSync(join(base, "proj-"));
	const home = identityHome(project, "77", "{\"name\":\"BlueFox\"}");
	const h = await host({ env: { TMUX_PANE: "%77" }, home, respond: brTable({}) });
	const result = await toolCall(h, project, "br close kit-404 --reason \"bun test extensions/kit-flywheel-guard.test.ts -> 26 passed\"");
	expect(result?.block).toBe(true);
	expect(result?.reason).toContain("LOOKUP_REFUSED");
	expect(result?.reason).toContain("kit-404");
	expect(result?.reason).toContain("Issue not found: kit-404");
	const thrown = await host({ env: { BR_ACTOR: "BlueFox" }, respond: () => { throw new Error("spawn br ENOENT"); } });
	const crashed = await toolCall(thrown, project, "br close kit-1 --reason \"bun test extensions/kit-flywheel-guard.test.ts -> 26 passed\"");
	expect(crashed?.block).toBe(true);
	expect(crashed?.reason).toContain("LOOKUP_REFUSED");
});

test("SELF_CLOSE_REFUSED negative: unknown caller identity is allowed with a warning", async () => {
	const project = mkdtempSync(join(base, "proj-"));
	const h = await host({ respond: brTable({ "kit-1": bead("kit-1", "BlueFox") }) });
	const result = await toolCall(h, project, "br close kit-1");
	expect(result?.block).toBeUndefined();
	expect(result?.additionalContext).toContain("caller identity unknown");
});

test("SELF_CLOSE_REFUSED negative: close text that is not a br/bd close never consults br", async () => {
	const project = mkdtempSync(join(base, "proj-"));
	const h = await host({ env: { BR_ACTOR: "BlueFox" }, respond: brTable({ "kit-1": bead("kit-1", "BlueFox") }) });
	for (const command of [
		"echo 'br close kit-1'",
		"git commit -m \"br close kit-1 after review\"",
		"br show kit-1 # then br close kit-1 later",
		"br update kit-1 --notes close",
		"gh issue close 12",
	]) expect(await toolCall(h, project, command)).toBeUndefined();
	expect(h.execs).toEqual([]);
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
	const project = mkdtempSync(join(base, "proj-"));
	const home = identityHome(project, "77", "{\"name\":\"BlueFox\"}");
	const h = await host({ env: { TMUX_PANE: "%77" }, home, respond: brTable({ "kit-9": bead("kit-9", "BlueFox") }) });
	const result = await toolCall(h, project, "br close kit-9 --reason ok 2>&1 | tail -3");
	expect(result?.block).toBe(true);
	expect(result?.reason).toContain("SELF_CLOSE_REFUSED");
});

function nativeClaimFixture() {
	const project = mkdtempSync(join(base, "native-claim-"));
	const db = join(project, ".beads", "beads.db");
	writeFileSync(join(project, ".owner"), JSON.stringify({
		pid: process.pid, label: "native-claim-test", repo: join(import.meta.dir, ".."), created: new Date().toISOString(),
	}));
	const run = (args: string[], actor = "ClaimFixture"): FlywheelExecResult => {
		const result = Bun.spawnSync(["br", ...args, "--db", db, "--actor", actor, "--json", "--no-auto-import", "--no-auto-flush"], {
			cwd: project, env: { ...process.env, HOME: project }, stdout: "pipe", stderr: "pipe", timeout: 10_000,
		});
		return { code: result.exitCode, stdout: result.stdout.toString(), stderr: result.stderr.toString() };
	};
	const init = run(["init", "--prefix", "gc"]);
	if (init.code !== 0) throw new Error(init.stdout + init.stderr);
	const create = () => {
		const result = run(["create", "--title", "Native claim consumer"]);
		if (result.code !== 0) throw new Error(result.stdout + result.stderr);
		const value: unknown = JSON.parse(result.stdout);
		if (typeof value !== "object" || value === null || !("id" in value) || typeof value.id !== "string") throw new Error("native create has no id");
		return value.id;
	};
	const respond: Responder = call => {
		const result = Bun.spawnSync([call.command, ...call.args], {
			cwd: call.options?.cwd ?? project, env: { ...process.env, HOME: project },
			stdout: "pipe", stderr: "pipe", timeout: call.options?.timeout ?? 10_000,
		});
		return { code: result.exitCode, stdout: result.stdout.toString(), stderr: result.stderr.toString() };
	};
	return { project, db, run, create, respond };
}

test("PULLADMIT1: a competing native claim is refused with its actual holder, not attribution identity", async () => {
	const fixture = nativeClaimFixture();
	const id = fixture.create();
	expect(fixture.run(["sync", "--flush-only"]).code).toBe(0);
	const exportPath = join(fixture.project, ".beads", "issues.jsonl");
	const exported = readFileSync(exportPath, "utf8");
	expect(fixture.run(["update", id, "--claim"], "Winner").code).toBe(0);
	const h = await host({ env: { BR_ACTOR: "Loser", BR_AGENT_NAME: "Winner" }, respond: fixture.respond });
	const result = await toolCall(h, fixture.project, `br update ${id} --claim --actor Loser --agent-name Winner --db '${fixture.db}'`);
	expect(result?.block).toBe(true);
	expect(JSON.parse(result?.reason ?? "null")).toMatchObject({
		refusal: { class: "unsafe_custody", bead: id, actor: "Winner", next: expect.stringContaining(id) },
	});
	const observed: unknown = JSON.parse(fixture.run(["show", id]).stdout);
	expect(observed).toEqual(expect.arrayContaining([expect.objectContaining({ id, assignee: "Winner" })]));
	expect(readFileSync(exportPath, "utf8")).toBe(exported);
});

test("PULLADMIT1: fresh and same-holder native claims execute, rather than a guard refusing everything", async () => {
	const fixture = nativeClaimFixture();
	const id = fixture.create();
	const h = await host({ env: { BR_ACTOR: "Worker" }, respond: fixture.respond });
	for (let attempt = 0; attempt < 2; attempt += 1) {
		const result = await toolCall(h, fixture.project, `br update ${id} --claim --actor Worker --db '${fixture.db}'`);
		if (result?.block) throw new Error(result.reason);
		const claimed = fixture.run(["update", id, "--claim"], "Worker");
		expect(claimed.code).toBe(0);
		expect(JSON.parse(claimed.stdout)).toEqual(expect.arrayContaining([expect.objectContaining({ id, assignee: "Worker", status: "in_progress" })]));
	}
});

test("PULLADMIT1: native lookup failure is not an unassigned claim", async () => {
	const fixture = nativeClaimFixture();
	const h = await host({ env: { BR_ACTOR: "Worker" }, respond: fixture.respond });
	const result = await toolCall(h, fixture.project, `br update gc-nonexistent --claim --actor Worker --db '${fixture.db}'`);
	expect(result?.block).toBe(true);
	expect(JSON.parse(result?.reason ?? "null")).toMatchObject({
		refusal: { class: "tool_read_failure", bead: "gc-nonexistent", actor: expect.stringContaining("UNKNOWN"), next: expect.stringContaining("gc-nonexistent") },
	});
});

test("PULLADMIT1: a bare in-progress update cannot replace an atomic native ownership claim", async () => {
	for (const status of ["in_progress", "IN_PROGRESS", "inprogress"]) {
		const fixture = nativeClaimFixture();
		const id = fixture.create();
		const h = await host({ env: { BR_ACTOR: "Worker" }, respond: fixture.respond });
		const result = await toolCall(h, fixture.project, `br update ${id} --status ${status} --actor Worker --db '${fixture.db}'`);
		expect(result?.block).toBe(true);
		expect(JSON.parse(result?.reason ?? "null")).toMatchObject({
			refusal: { class: "unsupported_native", bead: id, next: expect.stringContaining("--claim") },
		});
		expect(JSON.parse(fixture.run(["show", id]).stdout)).toEqual(expect.arrayContaining([expect.objectContaining({ id, status: "open" })]));
	}
});

test("PULLADMIT1: explicit native database scope wins over the caller cwd", async () => {
	const local = nativeClaimFixture();
	local.create();
	const remote = nativeClaimFixture();
	const id = remote.create();
	expect(remote.run(["update", id, "--claim"], "ScopedHolder").code).toBe(0);
	const h = await host({ env: { BR_ACTOR: "Requester" }, respond: local.respond });
	const result = await toolCall(h, local.project, `br --db '${remote.db}' --actor Requester update ${id} --claim`);
	expect(result?.block).toBe(true);
	expect(JSON.parse(result?.reason ?? "null")).toMatchObject({
		refusal: { class: "unsafe_custody", bead: id, actor: "ScopedHolder" },
	});
});

test("PULLADMIT1: concurrent native awards have one winner and name it to the loser", async () => {
	const fixture = nativeClaimFixture();
	const id = fixture.create();
	const actors = ["RaceOne", "RaceTwo"];
	for (const actor of actors) {
		const h = await host({ env: { BR_ACTOR: actor }, respond: fixture.respond });
		const admission = await toolCall(h, fixture.project, `br update ${id} --claim --actor ${actor} --db '${fixture.db}'`);
		if (admission?.block) throw new Error(admission.reason);
	}
	const children = actors.map(actor => ({
		actor,
		child: Bun.spawn(["br", "update", id, "--claim", "--db", fixture.db, "--actor", actor, "--json", "--no-auto-import", "--no-auto-flush"], {
			cwd: fixture.project, env: { ...process.env, HOME: fixture.project },
			stdout: "pipe", stderr: "pipe", timeout: 10_000,
		}),
	}));
	const outcomes = await Promise.all(children.map(async ({ actor, child }) => {
		const [stdout, stderr, code] = await Promise.all([
			new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited,
		]);
		return { actor, stdout, stderr, code };
	}));
	const winners = outcomes.filter(row => row.code === 0);
	const losers = outcomes.filter(row => row.code !== 0);
	expect(winners).toHaveLength(1);
	expect(losers).toHaveLength(1);
	const winner = winners[0];
	const loser = losers[0];
	if (winner === undefined || loser === undefined) throw new Error(JSON.stringify(outcomes));
	expect(JSON.parse(winner.stdout)).toEqual(expect.arrayContaining([expect.objectContaining({ id, assignee: winner.actor })]));
	expect(JSON.parse(loser.stdout)).toMatchObject({
		error: { context: { reason: expect.stringContaining(winner.actor) } },
	});
	const h = await host({ env: { BR_ACTOR: loser.actor }, respond: fixture.respond });
	const refused = await toolCall(h, fixture.project, `br update ${id} --claim --actor ${loser.actor} --db '${fixture.db}'`);
	expect(refused?.block).toBe(true);
	expect(JSON.parse(refused?.reason ?? "null")).toMatchObject({
		refusal: { class: "unsafe_custody", bead: id, actor: winner.actor },
	});
});

test("PULLADMIT1: ownership whitespace follows native same-holder claim semantics", async () => {
	const fixture = nativeClaimFixture();
	for (const { assignee, actor, explicit } of [
		{ assignee: "Worker ", actor: "Worker", explicit: true },
		{ assignee: "   ", actor: "Worker", explicit: true },
		{ assignee: "Worker", actor: "Worker ", explicit: true },
		{ assignee: "Worker", actor: " Worker ", explicit: false },
	]) {
		const id = fixture.create();
		const updated = fixture.run(["update", id, "--assignee", assignee], "Worker");
		if (updated.code !== 0) throw new Error(updated.stdout + updated.stderr);
		const h = await host({ env: { BR_ACTOR: actor }, respond: fixture.respond });
		const actorFlag = explicit ? ` --actor ${JSON.stringify(actor)}` : "";
		const admission = await toolCall(h, fixture.project, `br update ${id} --claim${actorFlag} --db '${fixture.db}'`);
		expect(admission?.block).not.toBe(true);
		const claimed = fixture.run(["update", id, "--claim"], actor);
		expect(claimed.code).toBe(0);
		expect(JSON.parse(claimed.stdout)).toEqual(expect.arrayContaining([expect.objectContaining({ id, assignee: "Worker", status: "in_progress" })]));
	}
});

test("BGDEADLINE1: finite async bash jobs reject timeout zero and accept native bounded defaults", async () => {
	const h = await host();
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
	const h = await host();
	const finite = await bashInput(h, { command: "cargo test", name: "tests", ready: { log: "completed" } });
	expect(finite?.block).toBe(true);
	expect(finite?.reason).toContain("FINITE_SUITE_AS_SERVICE");
	const unready = await bashInput(h, { command: "bun run dev", name: "web" });
	expect(unready?.block).toBe(true);
	expect(unready?.reason).toContain("SERVICE_READINESS_REQUIRED");
	expect(await bashInput(h, { command: "bun run dev", name: "web", ready: { port: 3000 } })).toBeUndefined();
});
