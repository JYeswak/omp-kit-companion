import { afterAll, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isMutatingCall, trackerRequests, type FlywheelExecResult, type FlywheelToolCallResult } from "./kit-flywheel-guard";
import { createFlywheelHost, toolCall, bashInput, type FakeHost, type Responder } from "../tests/fleet-guard/kit-flywheel-host";

const base = mkdtempSync(join(tmpdir(), "kit-flywheel-guard-"));

afterAll(() => {
	rmSync(base, { recursive: true, force: true });
});


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


// --- COMPACTION_REREAD ---------------------------------------------------

test("COMPACTION_REREAD: session_compact injects a reread of the nearest AGENTS.md and br show", async () => {
	const root = mkdtempSync(join(base, "proj-"));
	const repo = join(root, "repo");
	const cwd = join(repo, "pkg", "deep");
	mkdirSync(cwd, { recursive: true });
	writeFileSync(join(root, "AGENTS.md"), "outer\n");
	writeFileSync(join(repo, "AGENTS.md"), "inner\n");
	const h = await createFlywheelHost(base);
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
	const h = await createFlywheelHost(base, { env: { TMUX_PANE: "%41" }, home, respond: brTable({}) });
	await h.emit("session_compact", { compactionEntry: {}, fromExtension: false }, h.ctx(cwd, false));
	expect(h.sent.length).toBe(1);
	expect(h.sent[0]!.options?.deliverAs).toBe("aside");
	expect(h.sent[0]!.message.content).toContain("--assignee AmberHeron");
});

test("COMPACTION_REREAD negative: an ordinary turn emits nothing", async () => {
	const cwd = mkdtempSync(join(base, "proj-"));
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
	const project = mkdtempSync(join(base, "proj-"));
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
	const project = mkdtempSync(join(base, "proj-"));
	const home = identityHome(project, "fleet-0-3", "GreenLynx\n");
	const respond: Responder = call => call.command === "tmux"
		? { stdout: "fleet:0:3\n", stderr: "", code: 0 }
		: bead("kit-2", "GreenLynx");
	const h = await createFlywheelHost(base, { env: { TMUX_PANE: "%90" }, home, respond });
	const result = await toolCall(h, project, "bd close kit-2");
	expect(result?.block).toBe(true);
});

test("SELF_CLOSE_REFUSED: --actor, BR_ACTOR and BR_AGENT_NAME identify the caller", async () => {
	const project = mkdtempSync(join(base, "proj-"));
	const table = brTable({ "kit-3": bead("kit-3", "RedOwl") });
	const flag = await createFlywheelHost(base, { respond: table });
	expect((await toolCall(flag, project, "br --actor RedOwl close kit-3"))?.block).toBe(true);
	const inline = await createFlywheelHost(base, { respond: table });
	expect((await toolCall(inline, project, "BR_ACTOR=RedOwl br close kit-3"))?.block).toBe(true);
	const env = await createFlywheelHost(base, { env: { BR_AGENT_NAME: "RedOwl" }, respond: table });
	expect((await toolCall(env, project, "br close --db .beads/beads.db kit-3"))?.block).toBe(true);
});

test("SELF_CLOSE_REFUSED negative: a different closer is allowed silently", async () => {
	const project = mkdtempSync(join(base, "proj-"));
	const home = identityHome(project, "77", "{\"name\":\"Director\"}");
	const h = await createFlywheelHost(base, { env: { TMUX_PANE: "%77" }, home, respond: brTable({ "kit-1": bead("kit-1", "BlueFox") }) });
	expect(await toolCall(h, project, "br close kit-1 --reason \"bun test extensions/kit-flywheel-guard.test.ts -> 26 passed\"")).toBeUndefined();
	expect(h.notices).toEqual([]);
});

test("SELF_CLOSE_REFUSED negative: an unassigned bead is allowed with a warning", async () => {
	const project = mkdtempSync(join(base, "proj-"));
	const home = identityHome(project, "77", "{\"name\":\"BlueFox\"}");
	const h = await createFlywheelHost(base, { env: { TMUX_PANE: "%77" }, home, respond: brTable({ "kit-4": bead("kit-4", null) }) });
	const result = await toolCall(h, project, "br close kit-4");
	expect(result?.block).toBeUndefined();
	expect(result?.additionalContext).toContain("kit-4 has no assignee");
	expect(h.notices.length).toBe(1);
});

test("LOOKUP_REFUSED: evidence-bearing close is blocked when br show fails", async () => {
	const project = mkdtempSync(join(base, "proj-"));
	const home = identityHome(project, "77", "{\"name\":\"BlueFox\"}");
	const h = await createFlywheelHost(base, { env: { TMUX_PANE: "%77" }, home, respond: brTable({}) });
	const result = await toolCall(h, project, "br close kit-404 --reason \"bun test extensions/kit-flywheel-guard.test.ts -> 26 passed\"");
	expect(result?.block).toBe(true);
	expect(result?.reason).toContain("LOOKUP_REFUSED");
	expect(result?.reason).toContain("kit-404");
	expect(result?.reason).toContain("Issue not found: kit-404");
	const thrown = await createFlywheelHost(base, { env: { BR_ACTOR: "BlueFox" }, respond: () => { throw new Error("spawn br ENOENT"); } });
	const crashed = await toolCall(thrown, project, "br close kit-1 --reason \"bun test extensions/kit-flywheel-guard.test.ts -> 26 passed\"");
	expect(crashed?.block).toBe(true);
	expect(crashed?.reason).toContain("LOOKUP_REFUSED");
});

test("SELF_CLOSE_REFUSED negative: unknown caller identity is allowed with a warning", async () => {
	const project = mkdtempSync(join(base, "proj-"));
	const h = await createFlywheelHost(base, { respond: brTable({ "kit-1": bead("kit-1", "BlueFox") }) });
	const result = await toolCall(h, project, "br close kit-1");
	expect(result?.block).toBeUndefined();
	expect(result?.additionalContext).toContain("caller identity unknown");
});

test("SELF_CLOSE_REFUSED negative: close text that is not a br/bd close never consults br", async () => {
	const project = mkdtempSync(join(base, "proj-"));
	const h = await createFlywheelHost(base, { env: { BR_ACTOR: "BlueFox" }, respond: brTable({ "kit-1": bead("kit-1", "BlueFox") }) });
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

// --- COMPACTION_REREAD gate (ompkit-xa5s.24) ----------------------------------

/** Compacted host whose nearest AGENTS.md is `cwd/AGENTS.md`; identity TestWorker. */
async function rereadHost(extra: string[] = []): Promise<{ h: FakeHost; cwd: string; agents: string }> {
	const cwd = mkdtempSync(join(base, "reread-"));
	const agents = join(cwd, "AGENTS.md");
	writeFileSync(agents, "rules\n");
	for (const name of extra) writeFileSync(join(cwd, name), "x\n");
	const h = await createFlywheelHost(base, { env: { BR_ACTOR: "TestWorker" } });
	await h.emit("session_compact", { compactionEntry: { type: "compaction", id: "e1" }, fromExtension: false }, h.ctx(cwd));
	return { h, cwd, agents };
}

async function callAs(h: FakeHost, cwd: string, id: string, toolName: string, input: Record<string, unknown>): Promise<unknown[]> {
	return h.emit("tool_call", { toolCallId: id, toolName, input }, h.ctx(cwd));
}

async function endAs(h: FakeHost, cwd: string, id: string, toolName: string, result: unknown, isError = false): Promise<unknown[]> {
	return h.emit("tool_execution_end", { toolCallId: id, toolName, result, isError }, h.ctx(cwd));
}

function showStdout(id: string, status: string, assignee: string | null): string {
	return JSON.stringify([{ id, title: "t", status, assignee }]);
}

test("REREAD: compact then edit with no reread is blocked (planted negative)", async () => {
	const { h, cwd } = await rereadHost();
	const [blocked] = await callAs(h, cwd, "e1", "edit", { path: "f.ts", diff: "+x" });
	expect((blocked as FlywheelToolCallResult)?.block).toBe(true);
	expect((blocked as FlywheelToolCallResult)?.reason).toContain("COMPACTION_REREAD");
	const [push] = await callAs(h, cwd, "g1", "bash", { command: "git push origin master" });
	expect((push as FlywheelToolCallResult)?.block).toBe(true);
});

test("REREAD: AGENTS read plus owned in_progress br show unblocks the edit", async () => {
	const { h, cwd, agents } = await rereadHost();
	expect(await callAs(h, cwd, "r1", "read", { path: agents })).toEqual([undefined]);
	await endAs(h, cwd, "r1", "read", { details: { content: "rules\n" } });
	expect(await callAs(h, cwd, "s1", "bash", { command: "br show k-1 --json" })).toEqual([undefined]);
	await endAs(h, cwd, "s1", "bash", { details: { stdout: showStdout("k-1", "in_progress", "TestWorker") } });
	expect(await callAs(h, cwd, "e1", "edit", { path: "f.ts", diff: "+x" })).toEqual([undefined]);
	expect(await callAs(h, cwd, "g1", "bash", { command: "cd sub && git commit -m done" })).toEqual([undefined]);
});

test("REREAD: a failed read never clears the flag", async () => {
	const { h, cwd, agents } = await rereadHost();
	await callAs(h, cwd, "r1", "read", { path: agents });
	await endAs(h, cwd, "r1", "read", { details: { content: "rules\n" } }, true);
	const [blocked] = await callAs(h, cwd, "e1", "edit", { path: "f.ts", diff: "+x" });
	expect((blocked as FlywheelToolCallResult)?.block).toBe(true);
});

test("REREAD: reading the wrong AGENTS.md never clears the flag", async () => {
	const outer = mkdtempSync(join(base, "reread-outer-"));
	writeFileSync(join(outer, "AGENTS.md"), "outer\n");
	const cwd = mkdtempSync(join(base, "reread-inner-"));
	const agents = join(cwd, "AGENTS.md");
	writeFileSync(agents, "inner\n");
	const h = await createFlywheelHost(base, { env: { BR_ACTOR: "TestWorker" } });
	await h.emit("session_compact", {}, h.ctx(cwd));
	await callAs(h, cwd, "r1", "read", { path: join(outer, "AGENTS.md") });
	await endAs(h, cwd, "r1", "read", { details: { content: "outer\n" } });
	await callAs(h, cwd, "s1", "bash", { command: "br show k-1 --json" });
	await endAs(h, cwd, "s1", "bash", { details: { stdout: showStdout("k-1", "in_progress", "TestWorker") } });
	const [blocked] = await callAs(h, cwd, "e1", "edit", { path: "f.ts", diff: "+x" });
	expect((blocked as FlywheelToolCallResult)?.block).toBe(true);
	expect((blocked as FlywheelToolCallResult)?.reason).toContain("COMPACTION_REREAD");
});

test("REREAD: br show of a closed or foreign bead never clears the flag", async () => {
	for (const [status, assignee] of [["closed", "TestWorker"], ["in_progress", "SomebodyElse"]] as const) {
		const { h, cwd, agents } = await rereadHost();
		await callAs(h, cwd, "r1", "read", { path: agents });
		await endAs(h, cwd, "r1", "read", { details: { content: "rules\n" } });
		await callAs(h, cwd, "s1", "bash", { command: "br show k-9 --json" });
		await endAs(h, cwd, "s1", "bash", { details: { stdout: showStdout("k-9", status, assignee) } });
		const [blocked] = await callAs(h, cwd, "e1", "edit", { path: "f.ts", diff: "+x" });
		expect((blocked as FlywheelToolCallResult)?.block).toBe(true);
	}
});

test("REREAD: call arguments alone never clear the flag", async () => {
	const { h, cwd } = await rereadHost();
	await callAs(h, cwd, "s1", "bash", { command: "br show k-1 --json" });
	const [blocked] = await callAs(h, cwd, "e1", "edit", { path: "f.ts", diff: "+x" });
	expect((blocked as FlywheelToolCallResult)?.block).toBe(true);
});

test("REREAD: an empty br list clears the bead flag", async () => {
	const { h, cwd, agents } = await rereadHost();
	await callAs(h, cwd, "r1", "read", { path: agents });
	await endAs(h, cwd, "r1", "read", { content: "rules\n" });
	await callAs(h, cwd, "s1", "bash", { command: "br list --assignee TestWorker --json" });
	await endAs(h, cwd, "s1", "bash", { details: { stdout: "[]" } });
	expect(await callAs(h, cwd, "e1", "edit", { path: "f.ts", diff: "+x" })).toEqual([undefined]);
});

test("REREAD: read and grep stay allowed while pending", async () => {
	const { h, cwd, agents } = await rereadHost();
	expect(await callAs(h, cwd, "r1", "read", { path: agents })).toEqual([undefined]);
	expect(await callAs(h, cwd, "g1", "grep", { pattern: "COMPACTION", path: cwd })).toEqual([undefined]);
	expect(await callAs(h, cwd, "b1", "bash", { command: "git status --short" })).toEqual([undefined]);
	expect(await callAs(h, cwd, "b2", "bash", { command: "br show k-1 --json" })).toEqual([undefined]);
});

test("REREAD: without compaction nothing is blocked", async () => {
	const cwd = mkdtempSync(join(base, "reread-plain-"));
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
