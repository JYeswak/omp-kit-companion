import { afterAll, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { closeSync, existsSync, ftruncateSync, mkdirSync, openSync, readFileSync, rmSync, writeFileSync, writeSync } from "node:fs";
import { join } from "node:path";
import type { FlywheelExecOptions, FlywheelExecResult } from "./kit-flywheel-guard";
import { createMailWake, mailWakeStopReason, messageIdOf } from "./kit-mail-wake";
import { ownedTmp } from "../src/kitlib/tmp.ts";
import { fixtureDeadlineS } from "../tests/cli/fixture-process.ts";

let freshSeq = 0;
/** A unique empty child dir under an owned parent; the parent's cleanup removes it. */
function freshDir(parent: string, prefix: string): string {
	const dir = join(parent, `${prefix}${process.pid}-${++freshSeq}`);
	mkdirSync(dir);
	return dir;
}

const base = ownedTmp("kit-mail-wake").path;
afterAll(() => rmSync(base, { recursive: true, force: true }));

const REPO = "/abs/fleet/omp-kit";
interface Call { command: string; args: string[]; options?: FlywheelExecOptions }

/** A fleet: omp-test tab with live blocks 5 (RusticPine, director) and 9 (JadeThrush); GreenRabbit is a background agent. */
function fleet(opts: { omp?: (call: Call) => FlywheelExecResult | Promise<FlywheelExecResult>; fastWaitMs?: number; blocks?: { id: number; cwd: string; live: boolean }[]; extraTabs?: { name: string; blocks: { id: number; cwd: string; live: boolean }[] }[]; panes?: { pane: number; omp_session_file: string }[] } = {}) {
	const home = freshDir(base, "home-");
	const ident = join(home, ".config", "agent-mail", "identity", createHash("sha1").update(REPO).digest("hex").slice(0, 12));
	mkdirSync(ident, { recursive: true });
	writeFileSync(join(ident, "tern-5"), JSON.stringify({ name: "RusticPine" }));
	writeFileSync(join(ident, "tern-9"), JSON.stringify({ name: "JadeThrush" }));
	writeFileSync(join(ident, "tern-77"), JSON.stringify({ name: "DeadSeat" })); // block 77 is not live
	const rosterPath = join(home, "fleet-roster.json");
	writeFileSync(rosterPath, JSON.stringify({ chiefs: { lead: "PeachLeopard" }, sessions: { "omp-test": { director: "RusticPine", workers: ["JadeThrush", "DeadSeat"] } } }));
	const fleetWatchPath = join(home, "fleet-watch.json");
	writeFileSync(fleetWatchPath, JSON.stringify({ sessions: [{ session: "omp-test", repo: REPO }] }));
	const calls: Call[] = [];
	const exec = async (command: string, args: string[], options?: FlywheelExecOptions): Promise<FlywheelExecResult> => {
		const call = { command, args, options };
		calls.push(call);
		if (command === "tern") return { code: 0, stdout: JSON.stringify({ sessions: [{ name: "Default", tabs: [{ name: "omp-test", blocks: opts.blocks ?? [{ id: 5, cwd: REPO, live: true }, { id: 9, cwd: REPO, live: true }] }, ...(opts.extraTabs ?? [])] }], panes: opts.panes }) };
		if (command === "am") return { code: 0, stdout: JSON.stringify([{ name: "GreenRabbit", task_description: "MAILPROTO1 bead ompkit-fp72.134 (roster BuildMailProto)" }, { name: "StormyCove", task_description: "rhy9.16 cutover under CopperTrout" }]) };
		if (command === "omp-kit") return opts.omp ? opts.omp(call) : { code: 0, stdout: JSON.stringify({ data: { status: "OK", detail: "landed" } }) };
		return { code: 127, stdout: "", stderr: "unexpected" };
	};
	const ledgerPath = join(home, "mail-wake.jsonl");
	const wake = createMailWake({ exec, home, env: {}, rosterPath, fleetWatchPath, ledgerPath, fastWaitMs: opts.fastWaitMs ?? 200, untilDeliveredS: 600 });
	const ledger = () => existsSync(ledgerPath) ? readFileSync(ledgerPath, "utf8").trim().split("\n").map(line => JSON.parse(line)) : [];
	const wakes = () => calls.filter(call => call.command === "omp-kit");
	return { wake, calls, ledger, wakes, home, fleetWatchPath };
}

const sent = (id: number) => [{ type: "text", text: JSON.stringify({ deliveries: [{ project: REPO, payload: { id, subject: "s" } }], count: 1 }) }];
const ask = (to: string) => ({ project_key: REPO, sender_name: "PeachLeopard", to: [to], subject: "QUESTION ompkit-uk9wn: who owns sitrep?", body_md: "b", ack_required: true });

test("MAILSTOP1 planted: stopping after send planning persists the mail without invoking omp-kit send", async () => {
	const f = fleet();
	expect(await f.wake.beforeSend("stopped", "send_message", ask("JadeThrush"), REPO)).toBeUndefined();
	writeFileSync(f.fleetWatchPath, JSON.stringify({ sessions: [{ session: "omp-test", repo: REPO, pullEnabled: false }] }));
	const patch = await f.wake.afterSend({ toolCallId: "stopped", content: sent(78388), isError: false });
	expect(f.wakes()).toHaveLength(0);
	expect(JSON.stringify(patch)).toContain("STOPPED_NOT_WOKEN");
	expect(f.ledger()).toMatchObject([{ message_id: 78388, status: "STOPPED_NOT_WOKEN", reason: expect.stringContaining("PROJECT_STOPPED") }]);
}, fixtureDeadlineS() * 1000);

test.each([
	[["goal", "goal_paused"], false],
	[["goal_paused", "goal"], true],
	[["goal_paused", "none"], true],
] as const)("MAILSTOP1 recipient journal latest mode %j controls wake (%s)", async (modes, active) => {
	const f = fleet();
	const sessionFile = join(f.home, "recipient.jsonl");
	writeFileSync(sessionFile, modes.map(mode => JSON.stringify({ type: "mode_change", mode })).join("\n") + "\n");
	const other = fleet({ panes: [{ pane: 9, omp_session_file: sessionFile }] });
	expect(await other.wake.beforeSend("paused", "send_message", ask("JadeThrush"), REPO)).toBeUndefined();
	await other.wake.afterSend({ toolCallId: "paused", content: sent(78389), isError: false });
	expect(other.wakes()).toHaveLength(active ? 1 : 0);
	expect(other.ledger()[0].status).toBe(active ? "WAKE_DELIVERED" : "STOPPED_NOT_WOKEN");
}, fixtureDeadlineS() * 1000);

test("MAILSTOP1 bounded tail handles an 877 MiB journal without reading its body", async () => {
	const f = fleet();
	const sessionFile = join(f.home, "large.jsonl");
	const fd = openSync(sessionFile, "w");
	try {
		const size = 877 * 1024 * 1024;
		ftruncateSync(fd, size);
		writeSync(fd, '\n{"type":"mode_change","mode":"goal_paused"}\n', size - 48);
	} finally { closeSync(fd); }
	const seat = fleet({ panes: [{ pane: 9, omp_session_file: sessionFile }] });
	await seat.wake.beforeSend("large", "send_message", ask("JadeThrush"), REPO);
	await seat.wake.afterSend({ toolCallId: "large", content: sent(78390), isError: false });
	expect(seat.wakes()).toHaveLength(0);
	expect(seat.ledger()[0]).toMatchObject({ status: "STOPPED_NOT_WOKEN", reason: expect.stringContaining("GOAL_PAUSED") });
}, fixtureDeadlineS() * 1000);

test("MAILSTOP1 malformed fleet state never invokes a sender", async () => {
	const f = fleet();
	await f.wake.beforeSend("unreadable", "send_message", ask("JadeThrush"), REPO);
	writeFileSync(f.fleetWatchPath, "{");
	await f.wake.afterSend({ toolCallId: "unreadable", content: sent(78391), isError: false });
	expect(f.wakes()).toHaveLength(0);
	expect(f.ledger()[0]).toMatchObject({ status: "STOPPED_NOT_WOKEN", reason: expect.stringContaining("FLEET_STATE_UNREADABLE") });
}, fixtureDeadlineS() * 1000);

test("MAILSTOP1 control: no fleet-watch file configures no owner stop (portable machine), so it is never FLEET_STATE_UNREADABLE", async () => {
	const f = fleet();
	await f.wake.beforeSend("nofleet", "send_message", ask("JadeThrush"), REPO);
	rmSync(f.fleetWatchPath);
	await f.wake.afterSend({ toolCallId: "nofleet", content: sent(78392), isError: false });
	for (const row of f.ledger()) expect(String(row.reason ?? "")).not.toContain("FLEET_STATE_UNREADABLE");
}, fixtureDeadlineS() * 1000);

test("MAILSTOP1 active project with mode outside bounded tail wakes and records UNKNOWN", async () => {
	const f = fleet();
	const sessionFile = join(f.home, "old-mode.jsonl");
	writeFileSync(sessionFile, '{"type":"mode_change","mode":"goal"}\n' + ('{"type":"message"}\n'.repeat(20_000)));
	const seat = fleet({ panes: [{ pane: 9, omp_session_file: sessionFile }] });
	await seat.wake.beforeSend("unknown", "send_message", ask("JadeThrush"), REPO);
	await seat.wake.afterSend({ toolCallId: "unknown", content: sent(78392), isError: false });
	expect(seat.wakes()).toHaveLength(1);
	expect(seat.ledger()[0]).toMatchObject({ status: "WAKE_DELIVERED", pause_state: "UNKNOWN" });
}, fixtureDeadlineS() * 1000);

const CHIEF_CWD = "/abs/fleet";
function chiefFleet(chief: Record<string, unknown> = {}, identity = "PeachLeopard") {
	const f = fleet({
		blocks: [{ id: 44, cwd: CHIEF_CWD, live: true }],
		omp: call => {
			const cwd = call.args[call.args.indexOf("--cwd") + 1];
			return cwd === CHIEF_CWD
				? { code: 0, stdout: JSON.stringify({ data: { status: "DELIVERED" } }) }
				: { code: 2, stdout: JSON.stringify({ data: { status: "NOT_RUN" }, errors: [{ code: "SEAT_CWD_MISMATCH" }] }) };
		},
	});
	const ident = join(f.home, ".config", "agent-mail", "identity", createHash("sha1").update(REPO).digest("hex").slice(0, 12));
	writeFileSync(join(ident, "tern-44"), JSON.stringify({ name: identity }));
	writeFileSync(f.fleetWatchPath, JSON.stringify({
		chief: { agent: "PeachLeopard", session: "omp-test", pane: "tern:44", repo: REPO, cwd: CHIEF_CWD, ...chief },
	}));
	return f;
}

test("a configured chief uses canonical-project identity without changing its actual wake cwd", async () => {
	const f = chiefFleet();
	expect(await f.wake.beforeSend("chief", "send_message", { ...ask("PeachLeopard"), sender_name: "RusticPine" }, REPO)).toBeUndefined();
	const patch = await f.wake.afterSend({ toolCallId: "chief", content: sent(66107), isError: false });
	expect(JSON.stringify(patch)).toContain("WAKE_DELIVERED: mail 66107 -> PeachLeopard");
	expect(f.ledger()).toMatchObject([{ status: "WAKE_DELIVERED", recipient: "PeachLeopard", repo: CHIEF_CWD }]);
});

test.each([
	["different block", { pane: "tern:45" }],
	["different tab", { session: "another-tab" }],
	["different launch cwd", { cwd: "/abs/elsewhere" }],
	["different canonical project", { repo: "/abs/another-project" }],
	["different configured agent", { agent: "OtherAgent" }],
] as const)("canonical-project identity does not authorize a chief with %s", async (_label, chief) => {
	const f = chiefFleet(chief);
	expect((await f.wake.beforeSend("wrong-chief", "send_message", { ...ask("PeachLeopard"), sender_name: "RusticPine" }, REPO))?.reason).toStartWith("NO_WAKE_PATH");
	expect(await f.wake.afterSend({ toolCallId: "wrong-chief", content: sent(66108), isError: false })).toBeUndefined();
	expect(f.wakes()).toHaveLength(0);
});

test("configured chief metadata cannot override a different identity-file name", async () => {
	const f = chiefFleet({}, "OtherAgent");
	expect((await f.wake.beforeSend("wrong-name", "send_message", { ...ask("PeachLeopard"), sender_name: "RusticPine" }, REPO))?.reason).toStartWith("NO_WAKE_PATH");
	expect(f.wakes()).toHaveLength(0);
});

// MAILWAKECWD1 (ompkit-774u.38): the three omp-chief blocks share cwd ~/Developer; each configured `chiefs[]` row
// resolves under its canonical repo hash. The fourth live OMP block is unconfigured; an earlier shell decoy must not steal its path.
test("every configured chief block resolves its canonical-project identity; planted: an unconfigured OMP block under the same cwd does not", async () => {
	const f = fleet({
		blocks: [{ id: 44, cwd: CHIEF_CWD, live: true }, { id: 45, cwd: CHIEF_CWD, live: true }, { id: 46, cwd: CHIEF_CWD, live: true }, { id: 48, cwd: CHIEF_CWD, live: true }, { id: 47, cwd: CHIEF_CWD, live: true }],
		panes: [44, 45, 46, 47].map(id => ({ pane: id, omp_session_file: `/sessions/chief-${id}.jsonl` })),
		omp: call => call.args[call.args.indexOf("--cwd") + 1] === CHIEF_CWD
			? { code: 0, stdout: JSON.stringify({ data: { status: "DELIVERED" } }) }
			: { code: 2, stdout: JSON.stringify({ data: { status: "NOT_RUN" }, errors: [{ code: "SEAT_CWD_MISMATCH" }] }) },
	});
	const ident = join(f.home, ".config", "agent-mail", "identity", createHash("sha1").update(REPO).digest("hex").slice(0, 12));
	for (const [block, name] of [["44", "PeachLeopard"], ["45", "QuietBadger"], ["46", "ScarletPrairie"]]) writeFileSync(join(ident, `tern-${block}`), JSON.stringify({ name }));
	const row = (agent: string, pane: string) => ({ agent, session: "omp-test", pane, repo: REPO, cwd: CHIEF_CWD });
	writeFileSync(f.fleetWatchPath, JSON.stringify({ chief: row("PeachLeopard", "tern:44"), chiefs: [row("QuietBadger", "tern:45"), row("ScarletPrairie", "tern:46")] }));
	for (const [i, name] of [["a", "PeachLeopard"], ["b", "QuietBadger"], ["c", "ScarletPrairie"]]) {
		expect(await f.wake.beforeSend(i, "send_message", { ...ask(name), sender_name: "RusticPine" }, REPO)).toBeUndefined();
		const patch = await f.wake.afterSend({ toolCallId: i, content: sent(66200 + i.charCodeAt(0)), isError: false });
		expect(JSON.stringify(patch)).toContain(`WAKE_DELIVERED: mail ${66200 + i.charCodeAt(0)} -> ${name}`);
	}
	expect(f.ledger().map(r => [r.status, r.recipient])).toEqual([["WAKE_DELIVERED", "PeachLeopard"], ["WAKE_DELIVERED", "QuietBadger"], ["WAKE_DELIVERED", "ScarletPrairie"]]);
	// planted: block 48 is an earlier shell; block 47 is live under the same cwd with no chiefs row.
	const missingIdentityPath = join(ident, "tern-47");
	const ghostRefusal = (await f.wake.beforeSend("d", "send_message", { ...ask("GhostChief"), sender_name: "RusticPine" }, REPO))?.reason ?? "";
	expect(ghostRefusal).toStartWith("NO_WAKE_PATH");
	expect(ghostRefusal).toContain(missingIdentityPath);
	// planted: a chiefs row whose pane names a block another chief owns never borrows that identity
	writeFileSync(f.fleetWatchPath, JSON.stringify({ chief: row("PeachLeopard", "tern:44"), chiefs: [row("QuietBadger", "tern:46")] }));
	expect((await f.wake.beforeSend("e", "send_message", { ...ask("QuietBadger"), sender_name: "RusticPine" }, REPO))?.reason).toStartWith("NO_WAKE_PATH");
});

test("planted (a): an ack_required ask to a background agent is refused NO_WAKE_PATH naming its parent, and nothing is sent", async () => {
	const f = fleet();
	const verdict = await f.wake.beforeSend("c1", "send_message", ask("GreenRabbit"), REPO);
	expect(verdict?.block).toBe(true);
	expect(verdict?.reason).toStartWith("NO_WAKE_PATH");
	expect(verdict?.reason).toContain("GreenRabbit is registered in Agent Mail");
	expect(verdict?.reason).toContain("re-address the ask to RusticPine (director of omp-test, the fleet session for /abs/fleet/omp-kit)");
	expect(verdict?.reason).toContain("Nothing was sent");
	expect(f.wakes()).toHaveLength(0);
	expect(f.ledger()).toMatchObject([{ status: "NO_WAKE_PATH", recipient: "GreenRabbit", refused: true }]);
	// The refusal leaves no plan: a stray result for the same call wakes nobody.
	expect(await f.wake.afterSend({ toolCallId: "c1", content: sent(1), isError: false })).toBeUndefined();
});

test("planted (a) control: the same ask to its parent seat queues exactly one wake", async () => {
	const f = fleet();
	expect(await f.wake.beforeSend("c2", "send_message", ask("RusticPine"), REPO)).toBeUndefined();
	const patch = await f.wake.afterSend({ toolCallId: "c2", content: sent(66101), isError: false });
	expect(f.wakes()).toHaveLength(1);
	expect(f.wakes()[0].args.slice(0, 4)).toEqual(["send", "omp-test", "tern:5", "MAIL 66101 from PeachLeopard: QUESTION ompkit-uk9wn: who owns sitrep?"]);
	expect(f.wakes()[0].args).toContain("--until-delivered");
	expect(JSON.stringify(patch)).toContain("WAKE_DELIVERED: mail 66101 -> RusticPine at tern:5");
	expect(f.ledger()).toMatchObject([{ status: "WAKE_DELIVERED", message_id: 66101, recipient: "RusticPine", seat: "tern:5" }]);
});

test("parent from the task description, roster worker, and a dead seat", async () => {
	const f = fleet();
	expect((await f.wake.beforeSend("c3", "send_message", ask("StormyCove"), REPO))?.reason).toContain("re-address the ask to CopperTrout (named in its Agent Mail task_description)");
	expect((await f.wake.beforeSend("c4", "send_message", ask("DeadSeat"), REPO))?.reason).toContain("re-address the ask to RusticPine (director of omp-test (fleet-roster.json))");
	expect(f.wakes()).toHaveLength(0);
});

test("planted (b): a live seat whose waker fails tells the sender UNSIGNALED in the same tool result", async () => {
	const f = fleet({ omp: () => ({ code: 1, stdout: JSON.stringify({ data: { status: "REFUSED", detail: "wake path disabled" } }) }) });
	expect(await f.wake.beforeSend("c5", "send_message", ask("JadeThrush"), REPO)).toBeUndefined();
	const patch = await f.wake.afterSend({ toolCallId: "c5", content: sent(66102), isError: false });
	const text = JSON.stringify(patch);
	expect(text).toContain("UNSIGNALED: mail 66102 to JadeThrush is persisted but the wake to tern:9");
	expect(text).toContain("wake path disabled");
	expect(f.ledger()).toMatchObject([{ status: "WAKE_FAILED", message_id: 66102, recipient: "JadeThrush" }]);
});

test("control: a send to a live seat queues exactly one wake keyed by the message id, reported queued while the seat is busy", async () => {
	const busy = Promise.withResolvers<FlywheelExecResult>();
	// fastWaitMs 1: the seat stays busy, so the result must report the wake queued, not wait for it.
	const f = fleet({ omp: () => busy.promise, fastWaitMs: 1 });
	const fyi = { project_key: REPO, sender_name: "PeachLeopard", to: ["JadeThrush"], subject: "FYI ompkit-uk9wn: landed", body_md: "b" };
	expect(await f.wake.beforeSend("c6", "send_message", fyi, REPO)).toBeUndefined();
	const patch = await f.wake.afterSend({ toolCallId: "c6", content: sent(66103), isError: false });
	expect(f.wakes()).toHaveLength(1);
	expect(f.wakes()[0].args[3]).toBe("MAIL 66103 from PeachLeopard: FYI ompkit-uk9wn: landed");
	expect(JSON.stringify(patch)).toContain("WAKE_QUEUED: mail 66103 -> JadeThrush at tern:9");
	expect(f.ledger()).toMatchObject([{ status: "WAKE_QUEUED", message_id: 66103 }]);
	busy.resolve({ code: 0, stdout: JSON.stringify({ data: { status: "DELIVERED", detail: "after busy" } }) });
	await f.wake.settled();
	expect(f.ledger().map(row => row.status)).toEqual(["WAKE_QUEUED", "WAKE_DELIVERED"]);
});

test("a reply without explicit recipients wakes the thread recipient named in the result", async () => {
	const f = fleet();
	expect(await f.wake.beforeSend("c9", "reply_message", { project_key: REPO, sender_name: "JadeThrush", message_id: 66100, body_md: "done" }, REPO)).toBeUndefined();
	const result = [{ type: "text", text: JSON.stringify({ deliveries: [{ payload: { id: 66106, subject: "Re: QUESTION x", to: ["RusticPine"] } }] }) }];
	expect(JSON.stringify(await f.wake.afterSend({ toolCallId: "c9", content: result, isError: false }))).toContain("WAKE_DELIVERED: mail 66106 -> RusticPine at tern:5");
	expect(f.wakes().map(call => call.args[3])).toEqual(["MAIL 66106 from JadeThrush: Re: QUESTION x"]);
});

test("FYI to a background agent is allowed with an UNSIGNALED notice; a failed send wakes nobody", async () => {
	const f = fleet();
	const fyi = { project_key: REPO, sender_name: "PeachLeopard", to: ["GreenRabbit"], subject: "FYI x", body_md: "b" };
	expect(await f.wake.beforeSend("c7", "send_message", fyi, REPO)).toBeUndefined();
	expect(JSON.stringify(await f.wake.afterSend({ toolCallId: "c7", content: sent(66104), isError: false }))).toContain("UNSIGNALED: mail 66104 to GreenRabbit is persisted but wakes nobody (NO_WAKE_PATH");
	expect(await f.wake.beforeSend("c8", "send_message", ask("RusticPine"), REPO)).toBeUndefined();
	expect(await f.wake.afterSend({ toolCallId: "c8", content: sent(66105), isError: true })).toBeUndefined();
	expect(f.wakes()).toHaveLength(0);
});

test("message id parsing and the task-description parent pattern", () => {
	expect(messageIdOf({ deliveries: [{ payload: { id: 42 } }] })).toBe(42);
	expect(messageIdOf({ message_id: "7" })).toBe(7);
	expect(messageIdOf({ deliveries: [] })).toBeNull();
	const pattern = /\bunder ([A-Z][a-z]+[A-Z][a-z]+)\b/;
	expect("x under CopperTrout".match(pattern)?.[1]).toBe("CopperTrout");
	expect("x under coppertrout".match(pattern)).toBeNull();
	expect("thunder CopperTrout".match(pattern)).toBeNull();
	const near = `under ${"Ab".repeat(250)}`;
	const start = performance.now();
	expect(near.slice(0, 500).match(pattern)).toBeNull();
	expect(performance.now() - start).toBeLessThan(50);
});

// MAILSTOPXREPO1 (ompkit-fp72.120.16.234): a resolved seat is judged by its own repo and session, never the mail's key.
const CFS = "/abs/fleet/cfsios";
function crossRepoFleet(ompTestEnabled: boolean, cfsEnabled: boolean) {
	const f = fleet({ extraTabs: [{ name: "cfsios", blocks: [{ id: 12, cwd: CFS, live: true }] }] });
	const ident = join(f.home, ".config", "agent-mail", "identity", createHash("sha1").update(CFS).digest("hex").slice(0, 12));
	mkdirSync(ident, { recursive: true });
	writeFileSync(join(ident, "tern-12"), JSON.stringify({ name: "CrimsonHorizon" }));
	writeFileSync(f.fleetWatchPath, JSON.stringify({ sessions: [
		{ session: "omp-test", repo: REPO, pullEnabled: ompTestEnabled }, { session: "cfsios", repo: CFS, pullEnabled: cfsEnabled },
	] }));
	return f;
}

test("MAILSTOPXREPO1 planted: mail under a paused project's key to an enabled seat in another repo wakes it", async () => {
	const f = crossRepoFleet(false, true);
	expect(await f.wake.beforeSend("xrepo", "send_message", ask("CrimsonHorizon"), REPO)).toBeUndefined();
	const patch = await f.wake.afterSend({ toolCallId: "xrepo", content: sent(78603), isError: false });
	expect(JSON.stringify(patch)).toContain("WAKE_DELIVERED: mail 78603 -> CrimsonHorizon at tern:12 (cfsios, /abs/fleet/cfsios)");
	expect(f.wakes()).toHaveLength(1);
	expect(f.ledger()).toMatchObject([{ status: "WAKE_DELIVERED", recipient: "CrimsonHorizon", session: "cfsios", repo: CFS, project_key: REPO }]);
	// Mutant: the old call judged this seat by the mail key, which matches the paused omp-test row.
	expect(mailWakeStopReason(f.fleetWatchPath, REPO, CFS, "cfsios")).toBe("PROJECT_STOPPED: fleet-watch pullEnabled false");
	expect(mailWakeStopReason(f.fleetWatchPath, CFS, CFS, "cfsios")).toBeNull();
});

test("MAILSTOPXREPO1 planted: mail under an enabled project's key to a seat in a paused session stays STOPPED", async () => {
	const f = crossRepoFleet(false, true);
	expect(await f.wake.beforeSend("xrepo-paused", "send_message", { ...ask("JadeThrush"), project_key: CFS }, CFS)).toBeUndefined();
	const patch = await f.wake.afterSend({ toolCallId: "xrepo-paused", content: sent(78612), isError: false });
	expect(JSON.stringify(patch)).toContain("STOPPED_NOT_WOKEN: mail 78612 to JadeThrush");
	expect(f.wakes()).toHaveLength(0);
	expect(f.ledger()).toMatchObject([{ status: "STOPPED_NOT_WOKEN", session: "omp-test", repo: REPO, project_key: CFS }]);
});

test("MAILSTOPXREPO1 planted: a chief launched above its project whose session row is paused stays STOPPED", async () => {
	const f = chiefFleet();
	const chief = { agent: "PeachLeopard", session: "omp-test", pane: "tern:44", repo: REPO, cwd: CHIEF_CWD };
	// The paused row covers neither the chief's project nor its cwd: only the session match stops it.
	writeFileSync(f.fleetWatchPath, JSON.stringify({ chief, sessions: [{ session: "omp-test", repo: "/abs/unrelated", pullEnabled: false }] }));
	expect(await f.wake.beforeSend("chief-paused", "send_message", { ...ask("PeachLeopard"), sender_name: "RusticPine" }, REPO)).toBeUndefined();
	const patch = await f.wake.afterSend({ toolCallId: "chief-paused", content: sent(66109), isError: false });
	expect(JSON.stringify(patch)).toContain("STOPPED_NOT_WOKEN: mail 66109 to PeachLeopard");
	expect(f.wakes()).toHaveLength(0);
	// A paused row on the chief's canonical project (not its cwd, which sits above it) also stops it.
	const g = chiefFleet();
	writeFileSync(g.fleetWatchPath, JSON.stringify({ chief, sessions: [{ session: "other-tab", repo: REPO, pullEnabled: false }] }));
	expect(await g.wake.beforeSend("chief-project", "send_message", { ...ask("PeachLeopard"), sender_name: "RusticPine" }, REPO)).toBeUndefined();
	expect(JSON.stringify(await g.wake.afterSend({ toolCallId: "chief-project", content: sent(66110), isError: false }))).toContain("STOPPED_NOT_WOKEN");
	expect(g.wakes()).toHaveLength(0);
});
