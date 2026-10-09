import { afterAll, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import kitFlywheelGuard, {
	type FlywheelContext,
	type FlywheelExecOptions,
	type FlywheelExecResult,
	type FlywheelMessage,
	type FlywheelToolCallResult,
} from "./kit-flywheel-guard";

const base = mkdtempSync(join(tmpdir(), "kit-flywheel-guard-"));

afterAll(() => {
	rmSync(base, { recursive: true, force: true });
});

interface ExecCall { command: string; args: string[]; options?: FlywheelExecOptions }
type Responder = (call: ExecCall) => FlywheelExecResult | Promise<FlywheelExecResult>;

interface FakeHost {
	emit(type: string, event: Record<string, unknown>, ctx: FlywheelContext): Promise<unknown[]>;
	ctx(cwd: string, idle?: boolean): FlywheelContext;
	sent: { message: FlywheelMessage; options?: { deliverAs?: string } }[];
	execs: ExecCall[];
	notices: string[];
}

/** Fake omp host: records handlers, sent messages and every exec the guard makes. */
async function host(opts: { env?: Record<string, string | undefined>; home?: string; respond?: Responder } = {}): Promise<FakeHost> {
	const handlers = new Map<string, ((event: unknown, ctx: FlywheelContext) => unknown)[]>();
	const sent: FakeHost["sent"] = [];
	const execs: ExecCall[] = [];
	const notices: string[] = [];
	const respond: Responder = opts.respond ?? (() => ({ stdout: "", stderr: "not stubbed", code: 127 }));
	const pi = {
		on: (event: string, handler: (event: unknown, ctx: FlywheelContext) => unknown) =>
			void handlers.set(event, [...(handlers.get(event) ?? []), handler]),
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
		for (const handler of handlers.get(type) ?? []) results.push(await handler({ type, ...event }, ctx));
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
	expect(result?.reason).toContain("report DONE with evidence");
	const show = h.execs.find(call => call.command === "br");
	expect(show?.args).toEqual(["show", "kit-1", "--json"]);
	expect(show?.options?.cwd).toBe(tracker);
	expect(show?.options?.timeout).toBeGreaterThan(0);
	expect(show?.options?.timeout).toBeLessThanOrEqual(5000);
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
	expect(h.execs.find(call => call.command === "tmux")?.args).toEqual(["display-message", "-p", "-t", "%90", "#{session_name}:#{window_index}:#{pane_index}"]);
	expect(h.execs.find(call => call.command === "bd")?.args).toEqual(["show", "kit-2", "--json"]);
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
	expect(env.execs.find(call => call.command === "br")?.args).toEqual(["show", "kit-3", "--json", "--db", ".beads/beads.db"]);
});

test("SELF_CLOSE_REFUSED negative: a different closer is allowed silently", async () => {
	const project = mkdtempSync(join(base, "proj-"));
	const home = identityHome(project, "77", "{\"name\":\"Director\"}");
	const h = await host({ env: { TMUX_PANE: "%77" }, home, respond: brTable({ "kit-1": bead("kit-1", "BlueFox") }) });
	expect(await toolCall(h, project, "br close kit-1 --reason verified")).toBeUndefined();
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

test("SELF_CLOSE_REFUSED negative: br show failure is allowed with a warning", async () => {
	const project = mkdtempSync(join(base, "proj-"));
	const home = identityHome(project, "77", "{\"name\":\"BlueFox\"}");
	const h = await host({ env: { TMUX_PANE: "%77" }, home, respond: brTable({}) });
	const result = await toolCall(h, project, "br close kit-404");
	expect(result?.block).toBeUndefined();
	expect(result?.additionalContext).toContain("`br show kit-404` exited 3: Issue not found: kit-404");
	const thrown = await host({ env: { BR_ACTOR: "BlueFox" }, respond: () => { throw new Error("spawn br ENOENT"); } });
	const crashed = await toolCall(thrown, project, "br close kit-1");
	expect(crashed?.block).toBeUndefined();
	expect(crashed?.additionalContext).toContain("could not run (spawn br ENOENT)");
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
