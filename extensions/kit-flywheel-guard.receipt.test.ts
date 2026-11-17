import { afterAll, afterEach, beforeEach, expect, test } from "bun:test";
import { appendFileSync, chmodSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createHash } from "node:crypto";
import {
	CC_BEAD_RE,
	parseEvidenceIds,
	resolveCloseActor,
	trackerRequests,
	type FlywheelExecResult,
	type FlywheelToolCallResult,
} from "./kit-flywheel-guard";
import { createFlywheelHost, type FakeHost, type Responder } from "../tests/fleet-guard/kit-flywheel-host";
import { ownedTmp } from "../src/kitlib/tmp.ts";
import { runFixture } from "../tests/cli/fixture-process.ts";

let freshSeq = 0;
/** A unique empty child dir under an owned parent; the parent's cleanup removes it. */
function freshDir(parent: string, prefix: string): string {
	const dir = join(parent, `${prefix}${process.pid}-${++freshSeq}`);
	mkdirSync(dir);
	return dir;
}

const base = ownedTmp("kit-guard-receipt").path;
const savedCcState = process.env.CC_STATE;
const savedCc = process.env.OMP_KIT_CC;

afterAll(() => {
	rmSync(base, { recursive: true, force: true });
	if (savedCcState === undefined) delete process.env.CC_STATE;
	else process.env.CC_STATE = savedCcState;
});

afterEach(() => {
	if (savedCcState === undefined) delete process.env.CC_STATE;
	else process.env.CC_STATE = savedCcState;
	if (savedCc === undefined) delete process.env.OMP_KIT_CC;
	else process.env.OMP_KIT_CC = savedCc;
});

function stockRepo(): string {
	const cwd = freshDir(base, "repo-");
	const git = Bun.spawnSync(["git", "init", "--quiet", cwd]);
	if (git.exitCode !== 0) throw new Error(git.stderr.toString());
	return cwd;
}

// FILERCLOSE1 (ompkit-l5746): a close reads created_by and comments to refuse filer and DONE-author
// self-closes, and refuses fail-closed when either is missing. The fixture carries both, filed by the
// implementer, so a non-author Verifier close is admitted and a BlueFox close is refused.
function bead(id: string, status: string, assignee: string | null): FlywheelExecResult {
	return { stdout: JSON.stringify([{ id, title: "t", status, assignee, created_by: assignee, comments: [] }]), stderr: "", code: 0 };
}

/** br show answers from a table; git toplevel resolves to the real repo; tmux is absent. */
function respond(table: Record<string, FlywheelExecResult>, cwd: string): Responder {
	return call => {
		if (call.command === "git") return { stdout: `${cwd}\n`, stderr: "", code: 0 };
		if (call.command === "tmux") return { stdout: "", stderr: "no server", code: 1 };
		const id = call.args[1] ?? "";
		return table[id] ?? {
			stdout: JSON.stringify({ error: { code: "ISSUE_NOT_FOUND", message: `Issue not found: ${id}` } }),
			stderr: "",
			code: 3,
		};
	};
}

function spoolState(): string {
	const state = freshDir(base, "cc-");
	mkdirSync(join(state, "spool"), { recursive: true });
	process.env.CC_STATE = state;
	process.env.OMP_KIT_CC = "1";
	return state;
}

function spoolLines(state: string, producer: string): Array<Record<string, unknown>> {
	const dir = join(state, "spool", producer);
	let names: string[];
	try {
		names = readdirSync(dir);
	} catch {
		return [];
	}
	const out: Array<Record<string, unknown>> = [];
	for (const name of names) {
		for (const line of readFileSync(join(dir, name), "utf8").split("\n")) {
			if (line.trim() !== "") out.push(JSON.parse(line));
		}
	}
	return out;
}

async function closeCall(h: FakeHost, cwd: string, id: string, command: string): Promise<FlywheelToolCallResult | undefined> {
	const [result] = await h.emit("tool_call", { toolCallId: id, toolName: "bash", input: { command } }, h.ctx(cwd));
	return result as FlywheelToolCallResult | undefined;
}

async function closeEnd(h: FakeHost, cwd: string, id: string, ok: boolean): Promise<void> {
	await h.emit("tool_execution_end",
		ok
			? { toolCallId: id, toolName: "bash", isError: false, result: { stdout: "closed", code: 0 } }
			: { toolCallId: id, toolName: "bash", isError: true, result: { stdout: "", stderr: "boom", code: 1 } },
		h.ctx(cwd));
}

// --- pure seams ------------------------------------------------------------

test("receipt parse: ev_ ids come from --reason only", () => {
	expect(parseEvidenceIds(null)).toEqual([]);
	expect(parseEvidenceIds("done, tests pass")).toEqual([]);
	expect(parseEvidenceIds("verified ev_d2d42c18 and ev_00ff, see ev_d2d42c18")).toEqual(["ev_d2d42c18", "ev_00ff"]);
	expect(parseEvidenceIds("ev_ alone and rev_ev_x stay out")).toEqual([]);
	const [tracked] = trackerRequests("br close kit-1 --reason \"verified ev_abc123\"", "/w", "/home");
	expect(tracked?.reason).toBe("verified ev_abc123");
	expect(tracked?.operation).toBe("close");
});

test("receipt parse: update --status closed is a close", () => {
	const [closed] = trackerRequests("br update kit-1 --status closed --reason ok", "/w", "/home");
	expect(closed?.operation).toBe("close");
	const [open] = trackerRequests("br update kit-1 --status open", "/w", "/home");
	expect(open?.operation).toBe("release");
	const [notes] = trackerRequests("br update kit-1 --notes close", "/w", "/home");
	expect(notes).toBeUndefined();
});

test("receipt actor priority: --actor, attribution, env, pane", () => {
	const req = { actor: "CliActor", identities: ["AgentName"] };
	expect(resolveCloseActor(req, ["EnvActor"], ["PaneActor"])).toBe("CliActor");
	expect(resolveCloseActor({ actor: null, identities: ["AgentName"] }, ["EnvActor"], ["PaneActor"])).toBe("AgentName");
	expect(resolveCloseActor({ actor: null, identities: [] }, ["EnvActor"], ["PaneActor"])).toBe("EnvActor");
	expect(resolveCloseActor({ actor: null, identities: [] }, [], ["PaneActor"])).toBe("PaneActor");
	expect(resolveCloseActor({ actor: "  ", identities: [] }, [], [])).toBeNull();
});

// --- live handler boundary -------------------------------------------------

test("receipt: non-author close emits exactly one attributed receipt", async () => {
	const cwd = stockRepo();
	const state = spoolState();
	const h = await createFlywheelHost(base, { respond: respond({ "rc-1": bead("rc-1", "in_progress", "BlueFox") }, cwd) });
	const verdict = await closeCall(h, cwd, "r1", "br --actor Verifier close rc-1 --reason \"verified ev_d2d42c18\"");
	expect(verdict).toBeUndefined();
	await closeEnd(h, cwd, "r1", true);
	const lines = spoolLines(state, "closeguard");
	expect(lines.length).toBe(1);
	const env = lines[0]!;
	expect(env.type).toBe("bead.status");
	expect(env.producer).toBe("closeguard");
	expect(env.dataschema).toBe("bead.status@1");
	expect(env.data).toEqual({
		from_status: "in_progress",
		to_status: "closed",
		assignee: "BlueFox",
		actor: "Verifier",
		verifier: "Verifier",
		evidence: ["ev_d2d42c18"],
		observation: "receipt",
	});
	expect(env.repo).toBe(cwd);
	expect(env.bead).toBe("rc-1");
	expect(typeof env.position).toBe("string");
	expect(String(env.position)).toContain("r1");
	expect(h.notices).toEqual([]);
});

test("receipt: status update to closed emits a receipt with null evidence", async () => {
	const cwd = stockRepo();
	const state = spoolState();
	const h = await createFlywheelHost(base, { respond: respond({ "rc-2": bead("rc-2", "in_review", "BlueFox") }, cwd) });
	const verdict = await closeCall(h, cwd, "r2", "br --actor Verifier update rc-2 --status closed --reason done");
	expect(verdict).toBeUndefined();
	await closeEnd(h, cwd, "r2", true);
	const lines = spoolLines(state, "closeguard");
	expect(lines.length).toBe(1);
	expect((lines[0]!.data as Record<string, unknown>).from_status).toBe("in_review");
	expect((lines[0]!.data as Record<string, unknown>).evidence).toBeNull();
});

test("refused: planted self-close is refused AND recorded, no closed receipt", async () => {
	const cwd = stockRepo();
	const state = spoolState();
	const h = await createFlywheelHost(base, {
		env: { BR_ACTOR: "BlueFox" },
		respond: respond({ "rc-3": bead("rc-3", "in_progress", "BlueFox") }, cwd),
	});
	const verdict = await closeCall(h, cwd, "r3", "br close rc-3 --reason \"mine ev_99\"");
	expect(verdict?.block).toBe(true);
	expect(verdict?.reason).toContain("SELF_CLOSE_REFUSED");
	await closeEnd(h, cwd, "r3", true);
	const lines = spoolLines(state, "closeguard");
	const refused = lines.filter(line => line.type === "action.result");
	expect(refused.length).toBe(1);
	const data = refused[0]!.data as Record<string, unknown>;
	expect(data.outcome).toBe("refused");
	expect(data.code).toBe("SELF_CLOSE_REFUSED");
	expect(typeof data.duration_ms).toBe("number");
	expect(refused[0]!.bead).toBe("rc-3");
	expect(refused[0]!.repo).toBe(cwd);
	expect(refused[0]!.agent).toBe("BlueFox");
	expect(lines.some(line => line.type === "bead.status"
		&& (line.data as Record<string, unknown>).to_status === "closed")).toBe(false);
});

test("error close emits no receipt", async () => {
	const cwd = stockRepo();
	const state = spoolState();
	const h = await createFlywheelHost(base, { respond: respond({ "rc-4": bead("rc-4", "open", "BlueFox") }, cwd) });
	const verdict = await closeCall(h, cwd, "r4", "br --actor Verifier close rc-4 --reason ok");
	expect(verdict).toBeUndefined();
	await closeEnd(h, cwd, "r4", false);
	expect(spoolLines(state, "closeguard")).toEqual([]);
	expect(h.notices).toEqual([]);
});

test("unwritable spool: the close still succeeds and CC_SPOOL_WRITE_FAILED is logged", async () => {
	const cwd = stockRepo();
	const state = spoolState();
	const h = await createFlywheelHost(base, { respond: respond({ "rc-5": bead("rc-5", "open", "BlueFox") }, cwd) });
	const verdict = await closeCall(h, cwd, "r5", "br --actor Verifier close rc-5 --reason ok");
	expect(verdict).toBeUndefined();
	chmodSync(join(state, "spool"), 0o555);
	try {
		await closeEnd(h, cwd, "r5", true);
	} finally {
		chmodSync(join(state, "spool"), 0o755);
	}
	expect(h.notices.some(notice => notice.includes("CC_SPOOL_WRITE_FAILED"))).toBe(true);
	expect(spoolLines(state, "closeguard")).toEqual([]);
});

test("unknown caller: allowed with a warning, receipt carries null actor and verifier", async () => {
	const cwd = stockRepo();
	const state = spoolState();
	const h = await createFlywheelHost(base, { respond: respond({ "rc-6": bead("rc-6", "open", "BlueFox") }, cwd) });
	const verdict = await closeCall(h, cwd, "r6", "br close rc-6 --reason ok");
	expect(verdict?.block).toBeUndefined();
	expect(verdict?.additionalContext).toContain("caller identity unknown");
	await closeEnd(h, cwd, "r6", true);
	const lines = spoolLines(state, "closeguard");
	expect(lines.length).toBe(1);
	expect((lines[0]!.data as Record<string, unknown>).actor).toBeNull();
	expect((lines[0]!.data as Record<string, unknown>).verifier).toBeNull();
});

test("inert spool: no fleet state means no receipt and no warning", async () => {
	const cwd = stockRepo();
	const empty = freshDir(base, "nostate-");
	process.env.CC_STATE = empty;
	process.env.OMP_KIT_CC = "1";
	const h = await createFlywheelHost(base, { respond: respond({ "rc-7": bead("rc-7", "open", "BlueFox") }, cwd) });
	const verdict = await closeCall(h, cwd, "r7", "br --actor Verifier close rc-7 --reason ok");
	expect(verdict).toBeUndefined();
	await closeEnd(h, cwd, "r7", true);
	expect(h.notices).toEqual([]);
});

test("refused: a non-bead token ($b, a sentence) is recorded without ctx.bead, so it never dead-letters", async () => {
	// CLOSEGUARDBEAD1 (ompkit-5vi6p): cc.db dead_letters 6725-6728 were refused-close records whose
	// ctx.bead held `$b`, `$BEAD`, `$1` and a mis-parsed reason sentence (FIELD_CODE / FIELD_LENGTH).
	const cwd = stockRepo();
	const state = spoolState();
	const sentence = "GRADE-PASS (non-author GradeUdsRework, firsthand at be5fa3d incl 55a9523): tests 10/10";
	const h = await createFlywheelHost(base, { respond: respond({}, cwd) });
	for (const [call, token] of [["r8", "$b"], ["r9", sentence]] as const) {
		const verdict = await closeCall(h, cwd, call, `br --actor Verifier close '${token}' --reason ok`);
		expect(verdict?.block).toBe(true);
		await closeEnd(h, cwd, call, true);
	}
	const refused = spoolLines(state, "closeguard").filter(line => line.type === "action.result");
	expect(refused.length).toBe(2);
	for (const line of refused) {
		expect("bead" in line).toBe(false);
		expect((line.data as Record<string, unknown>).outcome).toBe("refused");
		expect(line.repo).toBe(cwd);
	}
	expect(CC_BEAD_RE.test("$b")).toBe(false);
	expect(CC_BEAD_RE.test(sentence)).toBe(false);
	expect(CC_BEAD_RE.test("ompkit-fp72.120.16.14")).toBe(true);
});

beforeEach(() => {
	delete process.env.CC_STATE;
});

test("mine replay: refused tool call retains original input and context", async () => {
	const cwd = stockRepo();
	const state = freshDir(base, "mine-state-");
	const h = await createFlywheelHost(base, {
		env: { BR_ACTOR: "BlueFox", XDG_STATE_HOME: state },
		respond: respond({ "rc-replay": bead("rc-replay", "in_progress", "BlueFox") }, cwd),
	});
	const command = 'br close rc-replay --reason "ordinary attempted input"';
	const verdict = await closeCall(h, cwd, "native-refusal-1", command);
	expect(verdict?.block).toBe(true);
	const rows = readFileSync(join(state, "omp-kit", "gate-events.jsonl"), "utf8").trim().split("\n").map(line => JSON.parse(line));
	const row = rows.find(row => row.kind === "refuse");
	expect(row.event_id).toBe("native-refusal-1");
	expect(row.replay.tool).toBe("bash");
	expect(row.replay.arguments.command).toBe(command);
	expect(row.replay.cwd).toBe(cwd);
});

test("mine replay: failed execution retains pending input but authoritative zero rc is not refused", async () => {
	const cwd = stockRepo();
	const state = freshDir(base, "mine-execution-");
	const h = await createFlywheelHost(base, { env: { XDG_STATE_HOME: state } });
	await h.emit("tool_call", { toolCallId: "native-failure-1", toolName: "read", input: { path: "ordinary-missing.txt" } }, h.ctx(cwd));
	await h.emit("tool_execution_end", { toolCallId: "native-failure-1", toolName: "read", isError: true, result: { code: 2, stderr: "ENOENT: no such file" } }, h.ctx(cwd));
	const ledger = join(state, "omp-kit", "gate-events.jsonl");
	const failed = readFileSync(ledger, "utf8").trim().split("\n").map(line => JSON.parse(line));
	expect(failed.find(row => row.event_id === "native-failure-1").replay.arguments).toEqual({ path: "ordinary-missing.txt" });
	await h.emit("tool_call", { toolCallId: "native-success-1", toolName: "read", input: { path: "ordinary.txt" } }, h.ctx(cwd));
	await h.emit("tool_execution_end", { toolCallId: "native-success-1", toolName: "read", isError: true, result: { code: 0, stderr: "historical REFUSED timeout text", timed_out: false } }, h.ctx(cwd));
	const rows = readFileSync(ledger, "utf8").trim().split("\n").map(line => JSON.parse(line));
	expect(rows.some(row => row.event_id === "native-success-1" && row.kind === "refuse")).toBe(false);
});

test("mine replay: commit refusal observes staged paths diff message and canonical custody", async () => {
	const cwd = stockRepo();
	writeFileSync(join(cwd, "ordinary.txt"), "staged replay content\n");
	expect(runFixture(["git", "-C", cwd, "add", "--", "ordinary.txt"], { cwd }).rc).toBe(0);
	const diff = runFixture(["git", "-C", cwd, "diff", "--cached", "--binary", "--no-ext-diff"], { cwd }).stdout;
	const state = freshDir(base, "mine-commit-");
	const fleet = freshDir(base, "custody-reader-");
	mkdirSync(join(fleet, "scripts", "cc"), { recursive: true });
	writeFileSync(join(fleet, "scripts", "cc", "custody.py"), "# fixture canonical reader selected via OMP_KIT_FLEET_ROOT\n");
	const h = await createFlywheelHost(base, {
		env: { BR_ACTOR: "ReplaySeat", XDG_STATE_HOME: state, OMP_KIT_FLEET_ROOT: fleet },
		respond: call => {
			if (call.command === "python3") {
				expect(call.args).not.toContain("--reserve");
				return { code: 10, stdout: JSON.stringify({ overall: "HELD", observed_by: "fixture canonical reader" }), stderr: "" };
			}
			if (call.command === "git") {
				const result = runFixture(["git", ...call.args], { cwd: call.options?.cwd ?? cwd });
				if (result.rc === null) throw new Error(`git fixture did not exit: ${Buffer.from(result.stderr).toString()}`);
				return { code: result.rc, stdout: Buffer.from(result.stdout).toString(), stderr: Buffer.from(result.stderr).toString() };
			}
			return { code: 127, stdout: "", stderr: "not available" };
		},
	});
	await h.emit("tool_call", { toolCallId: "native-commit-1", toolName: "bash", input: { command: 'git commit -m "ordinary replay commit"' } }, h.ctx(cwd));
	const rows = readFileSync(join(state, "omp-kit", "gate-events.jsonl"), "utf8").trim().split("\n").map(line => JSON.parse(line));
	const row = rows.find(row => row.event_id === "native-commit-1");
	expect(row.replay.staged_paths).toEqual(["ordinary.txt"]);
	expect(row.replay.diff_sha256).toBe(createHash("sha256").update(diff).digest("hex"));
	expect(row.replay.message).toBe("ordinary replay commit");
	expect(row.replay.custody.observations[0].result).toEqual({ overall: "HELD", observed_by: "fixture canonical reader" });
});

test("GATEMODELRATE1: native refusal retains its causal assistant model, never the latest auxiliary model", async () => {
	const cwd = stockRepo();
	const state = freshDir(base, "native-model-");
	const sessionFile = join(state, "session.jsonl");
	const toolCallId = "native-effective-call";
	const command = "br close rc-effective --reason ordinary";
	const assistant = {
		id: "assistant-effective", parentId: null, type: "message", timestamp: "2026-01-02T03:04:05Z",
		message: { role: "assistant", provider: "native-provider", model: "native-served", stopReason: "toolUse",
			content: [{ type: "toolCall", id: toolCallId, name: "bash", arguments: { command } }] },
	};
	const auxiliary = {
		id: "auxiliary-latest", parentId: assistant.id, type: "model_usage", timestamp: "2026-01-02T03:04:06Z",
		provider: "auxiliary-provider", model: "auxiliary-default", purpose: "judge",
	};
	writeFileSync(sessionFile, [JSON.stringify({ type: "session", id: "native-session" }),
		JSON.stringify(assistant), JSON.stringify(auxiliary)].join("\n") + "\n");
	const entries = new Map<string, unknown>([[assistant.id, assistant], [auxiliary.id, auxiliary]]);
	const sessionManager = {
		getSessionId: () => "native-session", getSessionFile: () => sessionFile,
		getLeafId: () => auxiliary.id, getEntry: (id: string) => entries.get(id),
		getEntries: () => [assistant, auxiliary],
	};
	const h = await createFlywheelHost(base, {
		env: { BR_ACTOR: "BlueFox", XDG_STATE_HOME: state, OMP_MODEL: "registration-default" },
		respond: respond({ "rc-effective": bead("rc-effective", "in_progress", "BlueFox") }, cwd),
	});
	const ctx = Object.assign(h.ctx(cwd), { sessionManager });
	const [verdict] = await h.emit("tool_call", { toolCallId, toolName: "bash", input: { command } }, ctx);
	expect(verdict).toMatchObject({ block: true });
	const rows = readFileSync(join(state, "omp-kit", "gate-events.jsonl"), "utf8").trim().split("\n").map(line => JSON.parse(line));
	const refused = rows.find(row => row.kind === "refuse" && row.event_id === toolCallId);
	expect(refused).toMatchObject({
		model: "native-served", provider: "native-provider",
		attribution: { status: "KNOWN", source: {
			session_id: "native-session", entry_id: assistant.id, tool_call_id: toolCallId,
		} },
	});
	expect(refused.model).not.toBe(auxiliary.model);
	expect(refused.model).not.toBe("registration-default");
});

test("GATEMODELRATE1: native lifecycle deduplicates verdicts, starts, ends, and restoration", async () => {
	const cwd = stockRepo();
	const state = freshDir(base, "native-attempts-");
	const sessionFile = join(state, "session.jsonl");
	const entries = new Map<string, unknown>();
	let leafId: string | null = null;
	writeFileSync(sessionFile, `${JSON.stringify({ type: "session", id: "native-attempt-session" })}\n`);
	const sessionManager = {
		getSessionId: () => "native-attempt-session",
		getSessionFile: () => sessionFile,
		getLeafId: () => leafId,
		getEntry: (id: string) => entries.get(id),
		getEntries: () => [...entries.values()],
	};
	const attempts = [
		{ id: "native-refused", command: "br close rc-refused --reason ordinary", refused: true, isError: false, model: "native-served", provider: "native-provider" },
		{ id: "native-success", command: "printf native-success", refused: false, isError: false, model: "native-served", provider: "native-provider" },
		{ id: "native-error", command: "false", refused: false, isError: true, model: "native-served", provider: "native-provider" },
		{ id: "native-next-turn", command: "br close rc-next --reason ordinary", refused: false, isError: false, model: "native-served-next", provider: "native-provider-next" },
	];
	const h = await createFlywheelHost(base, {
		env: { BR_ACTOR: "BlueFox", XDG_STATE_HOME: state, OMP_MODEL: "registration-default" },
		respond: respond({
			"rc-refused": bead("rc-refused", "in_progress", "BlueFox"),
			"rc-success": bead("rc-success", "in_progress", "OtherAgent"),
			"rc-error": bead("rc-error", "in_progress", "OtherAgent"),
			"rc-next": bead("rc-next", "in_progress", "OtherAgent"),
		}, cwd),
	});
	const ctx = Object.assign(h.ctx(cwd), { sessionManager });
	const sourceTimestamp = new Date(Math.floor(Date.now() / 600_000) * 600_000 + 1_000).toISOString();
	for (const attempt of attempts) {
		const callEvent = { toolCallId: attempt.id, toolName: "bash", input: { command: attempt.command } };
		const originalCall = JSON.stringify(callEvent);
		const [verdict] = await h.emit("tool_call", callEvent, ctx);
		const originalVerdict = JSON.stringify(verdict);
		expect(JSON.stringify(callEvent)).toBe(originalCall);
		if (attempt.refused) {
			expect(verdict).toMatchObject({ block: true });
			if (typeof verdict !== "object" || verdict === null || !("reason" in verdict)) throw new Error("Native refusal lost its reason");
			expect(verdict.reason).toContain("SELF_CLOSE_REFUSED");
		} else expect(verdict).toBeUndefined();

		const assistantId = `assistant-${attempt.id}`;
		const timestamp = sourceTimestamp;
		const assistant = {
			id: assistantId, parentId: leafId, type: "message", timestamp,
			message: { role: "assistant", provider: attempt.provider, model: attempt.model, stopReason: "toolUse",
				content: [{ type: "toolCall", id: attempt.id, name: "bash", arguments: { command: attempt.command } }] },
		};
		const auxiliaryId = `aux-${attempt.id}`;
		const auxiliary = {
			id: auxiliaryId, parentId: assistantId, type: "model_usage", timestamp,
			provider: "auxiliary-provider", model: "auxiliary-latest",
		};
		appendFileSync(sessionFile, `${JSON.stringify(assistant)}\n${JSON.stringify(auxiliary)}\n`);
		entries.set(assistantId, assistant);
		entries.set(auxiliaryId, auxiliary);
		leafId = auxiliaryId;

		const startEvent = { toolCallId: attempt.id, toolName: "bash" };
		const originalStart = JSON.stringify(startEvent);
		expect(await h.emit("tool_execution_start", startEvent, ctx)).toEqual([undefined]);
		expect(JSON.stringify(startEvent)).toBe(originalStart);
		const result = Object.freeze({
			stdout: attempt.isError ? "" : "closed",
			stderr: attempt.isError ? "ordinary tool failure" : "",
			code: attempt.isError ? 1 : 0,
			details: Object.freeze({ attempt: attempt.id }),
		});
		const originalResult = JSON.stringify(result);
		const endEvent = { toolCallId: attempt.id, toolName: "bash", isError: attempt.isError, result };
		const originalEnd = JSON.stringify(endEvent);
		expect(await h.emit("tool_execution_end", endEvent, ctx)).toEqual([undefined]);
		expect(endEvent.result).toBe(result);
		expect(JSON.stringify(endEvent)).toBe(originalEnd);
		expect(JSON.stringify(result)).toBe(originalResult);
		expect(JSON.stringify(verdict)).toBe(originalVerdict);
	}

	type NativeAttemptsFile = {
		windows: Array<{
			coverage: { status: string; reasons: string[] };
			attempts: Array<Record<string, unknown>>;
			buckets: Array<Record<string, unknown>>;
		}>;
	};
	const attemptsPath = join(state, "omp-kit", "native-tool-attempts.json");
	let counter = JSON.parse(readFileSync(attemptsPath, "utf8")) as NativeAttemptsFile;
	expect(counter).toMatchObject({ scope: "observed-native-tool-lifecycle", rate_scope: "own-kit-guard-observed-admissions" });
	let window = counter.windows.at(-1)!;
	const nativeModel = window.buckets.find(bucket => bucket.model === "native-served" && bucket.provider === "native-provider")!;
	expect(window.coverage.status).toBe("COMPLETE");
	expect(nativeModel).toMatchObject({
		seat: "BlueFox", tool: "bash", attempted: 3, own_guard_observed: 3, own_guard_refused: 1,
		native_error_results: 1, own_guard_refusal_rate: 1 / 3, all_guard_refusal_rate: null,
	});
	const nextModel = window.buckets.find(bucket => bucket.model === "native-served-next" && bucket.provider === "native-provider-next")!;
	expect(nextModel).toMatchObject({ attempted: 1, own_guard_observed: 1, own_guard_refused: 0, own_guard_refusal_rate: 0, all_guard_refusal_rate: null });
	const refusedAttempt = window.attempts.find(record => record.tool_call_id === "native-refused")!;
	expect(refusedAttempt).toMatchObject({ model: "native-served", provider: "native-provider", own_guard: "REFUSED" });
	const gatePath = join(state, "omp-kit", "gate-events.jsonl");
	const gateRows = readFileSync(gatePath, "utf8").trim().split("\n").map(line => JSON.parse(line) as Record<string, unknown>);
	const rawRefusal = gateRows.find(row => row.kind === "refuse" && row.event_id === "native-refused")!;
	expect(rawRefusal).toMatchObject({ model: null, provider: null, attribution: { status: "UNKNOWN" } });

	const duplicateEvent = { toolCallId: "native-next-turn", toolName: "bash", input: { command: attempts[3]!.command } };
	expect(await h.emit("tool_call", duplicateEvent, ctx)).toEqual([undefined]);
	expect(await h.emit("tool_execution_start", { toolCallId: "native-next-turn", toolName: "bash" }, ctx)).toEqual([undefined]);
	expect(await h.emit("tool_execution_end", {
		toolCallId: "native-next-turn", toolName: "bash", isError: false,
		result: { stdout: "closed again", stderr: "", code: 0 },
	}, ctx)).toEqual([undefined]);
	const duplicateGateRows = readFileSync(gatePath, "utf8").trim().split("\n");
	expect(JSON.parse(duplicateGateRows.at(-1)!)).toMatchObject({ event_id: "native-next-turn", kind: "pass", model: "native-served-next" });
	counter = JSON.parse(readFileSync(attemptsPath, "utf8")) as NativeAttemptsFile;
	window = counter.windows.at(-1)!;
	expect(window.coverage.status).toBe("COMPLETE");
	expect(window.buckets.find(bucket => bucket.model === "native-served")?.attempted).toBe(3);
	expect(window.buckets.find(bucket => bucket.model === "native-served-next")?.attempted).toBe(1);

	const restored = await createFlywheelHost(base, {
		env: { BR_ACTOR: "BlueFox", XDG_STATE_HOME: state, OMP_MODEL: "registration-default" },
		respond: respond({ "rc-next": bead("rc-next", "in_progress", "OtherAgent") }, cwd),
	});
	const restoredCtx = Object.assign(restored.ctx(cwd), { sessionManager });
	expect(await restored.emit("tool_call", duplicateEvent, restoredCtx)).toEqual([undefined]);
	expect(await restored.emit("tool_execution_start", { toolCallId: "native-next-turn", toolName: "bash" }, restoredCtx)).toEqual([undefined]);
	expect(await restored.emit("tool_execution_end", {
		toolCallId: "native-next-turn", toolName: "bash", isError: false,
		result: { stdout: "closed after restore", stderr: "", code: 0 },
	}, restoredCtx)).toEqual([undefined]);
	counter = JSON.parse(readFileSync(attemptsPath, "utf8")) as NativeAttemptsFile;
	window = counter.windows.at(-1)!;
	expect(window.coverage.status).toBe("INCOMPLETE");
	expect(window.buckets.find(bucket => bucket.model === "native-served")?.attempted).toBe(3);
	expect(window.buckets.find(bucket => bucket.model === "native-served")?.own_guard_refusal_rate).toBeNull();
	expect(window.buckets.find(bucket => bucket.model === "native-served-next")?.attempted).toBe(1);
	expect(window.buckets.find(bucket => bucket.model === "native-served-next")?.own_guard_refusal_rate).toBeNull();
	expect(window.buckets.every(bucket => bucket.all_guard_refusal_rate === null)).toBe(true);
	expect(readFileSync(gatePath, "utf8")).toContain(JSON.stringify(rawRefusal));
});

test("GATEMODELRATE1: missing, replaced, and mixed-turn source evidence never falls back to defaults", async () => {
	const cwd = stockRepo();
	const state = freshDir(base, "native-attempts-unknown-");
	const sessionFile = join(state, "session.jsonl");
	writeFileSync(sessionFile, `${JSON.stringify({ type: "session", id: "native-unknown-session" })}\n`);
	const entries = new Map<string, unknown>();
	let scenario = "unbound";
	let finalized = false;
	let leafReads = 0;
	let assistantId = "";
	let auxiliaryId = "";
	let previousLeaf: string | null = null;
	const sessionManager = {
		getSessionId: () => "native-unknown-session",
		getSessionFile: () => sessionFile,
		getLeafId: () => {
			if (!finalized || scenario === "unpersisted") return null;
			if (scenario === "replaced") return ++leafReads === 1 ? auxiliaryId : "replacement-leaf";
			return auxiliaryId;
		},
		getEntry: (id: string) => entries.get(id),
		getEntries: () => [...entries.values()],
	};
	const h = await createFlywheelHost(base, {
		env: { XDG_STATE_HOME: state, OMP_MODEL: "registration-default" },
	});
	const cases = [
		{ id: "unknown-unbound", scenario: "unbound" },
		{ id: "unknown-unpersisted", scenario: "unpersisted" },
		{ id: "unknown-replaced", scenario: "replaced" },
		{ id: "unknown-mixed", scenario: "mixed" },
	];
	const sourceTimestamp = new Date(Math.floor(Date.now() / 600_000) * 600_000 + 1_000).toISOString();
	for (const attempt of cases) {
		scenario = attempt.scenario;
		finalized = false;
		leafReads = 0;
		const command = `echo ${attempt.id}`;
		const ctx = Object.assign(h.ctx(cwd), scenario === "unbound" ? {} : { sessionManager });
		const callEvent = { toolCallId: attempt.id, toolName: "bash", input: { command } };
		expect(await h.emit("tool_call", callEvent, ctx)).toEqual([undefined]);
		assistantId = `assistant-${attempt.id}`;
		auxiliaryId = `aux-${attempt.id}`;
		const timestamp = sourceTimestamp;
		const assistant = {
			id: assistantId, parentId: previousLeaf, type: "message", timestamp,
			message: { role: "assistant", provider: "would-be-native-provider", model: "would-be-native-model", stopReason: "toolUse",
				content: [{ type: "toolCall", id: scenario === "mixed" ? `other-${attempt.id}` : attempt.id, name: "bash", arguments: { command } }] },
		};
		const auxiliary = {
			id: auxiliaryId, parentId: assistantId, type: "model_usage", timestamp,
			provider: "auxiliary-provider", model: "auxiliary-default",
		};
		appendFileSync(sessionFile, `${JSON.stringify(assistant)}\n${JSON.stringify(auxiliary)}\n`);
		entries.set(assistantId, assistant);
		entries.set(auxiliaryId, auxiliary);
		previousLeaf = auxiliaryId;
		finalized = true;
		const result = Object.freeze({ stdout: "ok", stderr: "", code: 0 });
		expect(await h.emit("tool_execution_start", { toolCallId: attempt.id, toolName: "bash" }, ctx)).toEqual([undefined]);
		expect(await h.emit("tool_execution_end", { toolCallId: attempt.id, toolName: "bash", isError: false, result }, ctx)).toEqual([undefined]);
	}
	type NativeAttemptsFile = {
		windows: Array<{
			coverage: { status: string; reasons: string[] };
			attempts: Array<Record<string, unknown>>;
			buckets: Array<Record<string, unknown>>;
		}>;
	};
	const counter = JSON.parse(readFileSync(join(state, "omp-kit", "native-tool-attempts.json"), "utf8")) as NativeAttemptsFile;
	const window = counter.windows.at(-1)!;
	const unknownBucket = window.buckets.find(bucket => bucket.model === null && bucket.provider === null)!;
	expect(window.coverage.status).toBe("INCOMPLETE");
	expect(unknownBucket).toMatchObject({
		attempted: null, own_guard_observed: 3, model: null, provider: null,
		own_guard_refusal_rate: null, all_guard_refusal_rate: null,
	});
	for (const id of ["unknown-unbound", "unknown-unpersisted", "unknown-replaced", "unknown-mixed"]) {
		const attempt = window.attempts.find(record => record.tool_call_id === id)!;
		expect(attempt).toMatchObject({ model: null, provider: null });
		expect(String(attempt.attribution_reason).startsWith("NATIVE_")).toBe(true);
	}
});

test("GATEMODELRATE1: unwritable attempt metadata warns without refusing the native call", async () => {
	const cwd = stockRepo();
	const state = freshDir(base, "native-attempts-unwritable-");
	const stateFile = join(state, "not-a-directory");
	writeFileSync(stateFile, "occupied");
	const h = await createFlywheelHost(base, {
		env: { XDG_STATE_HOME: stateFile, OMP_MODEL: "registration-default" },
	});
	const ctx = h.ctx(cwd);
	const callEvent = { toolCallId: "native-unwritable", toolName: "bash", input: { command: "echo allowed" } };
	const originalCall = JSON.stringify(callEvent);
	const [verdict] = await h.emit("tool_call", callEvent, ctx);
	expect(verdict).toBeUndefined();
	expect(JSON.stringify(callEvent)).toBe(originalCall);
	const result = Object.freeze({ stdout: "ok", stderr: "", code: 0 });
	const originalResult = JSON.stringify(result);
	expect(await h.emit("tool_execution_start", { toolCallId: "native-unwritable", toolName: "bash" }, ctx)).toEqual([undefined]);
	const endEvent = { toolCallId: "native-unwritable", toolName: "bash", isError: false, result };
	const originalEnd = JSON.stringify(endEvent);
	expect(await h.emit("tool_execution_end", endEvent, ctx)).toEqual([undefined]);
	expect(JSON.stringify(endEvent)).toBe(originalEnd);
	expect(JSON.stringify(result)).toBe(originalResult);
	expect(h.notices.length).toBeGreaterThan(0);
});
