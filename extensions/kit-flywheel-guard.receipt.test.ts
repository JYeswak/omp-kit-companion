import { afterAll, beforeEach, expect, test } from "bun:test";
import { chmodSync, mkdirSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
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

let freshSeq = 0;
/** A unique empty child dir under an owned parent; the parent's cleanup removes it. */
function freshDir(parent: string, prefix: string): string {
	const dir = join(parent, `${prefix}${process.pid}-${++freshSeq}`);
	mkdirSync(dir);
	return dir;
}

const base = ownedTmp("kit-guard-receipt").path;
const savedCcState = process.env.CC_STATE;

afterAll(() => {
	rmSync(base, { recursive: true, force: true });
	if (savedCcState === undefined) delete process.env.CC_STATE;
	else process.env.CC_STATE = savedCcState;
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
	delete process.env.OMP_KIT_CC;
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
