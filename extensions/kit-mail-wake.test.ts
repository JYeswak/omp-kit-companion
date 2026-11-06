import { afterAll, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { closeSync, existsSync, ftruncateSync, mkdirSync, openSync, readFileSync, rmSync, writeFileSync, writeSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { FlywheelExecOptions, FlywheelExecResult } from "./kit-flywheel-guard";
import { createMailWake, mailWakeStopReason, messageIdOf, pauseOverrideReason, type MailWake } from "./kit-mail-wake";
import { ownedTmp } from "../src/kitlib/tmp.ts";
import { fixtureDeadlineS, runFixture } from "../tests/cli/fixture-process.ts";

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
function chiefFleet(chief: Record<string, unknown> = {}, identity = "PeachLeopard", sessionFile?: string) {
	const f = fleet({
		blocks: [{ id: 44, cwd: CHIEF_CWD, live: true }],
		panes: sessionFile ? [{ pane: 44, omp_session_file: sessionFile }] : [],
		omp: call => {
			const cwd = call.args[call.args.indexOf("--cwd") + 1];
			return cwd === CHIEF_CWD
				? { code: 0, stdout: JSON.stringify({ data: { status: "DELIVERED" } }) }
				: { code: 2, stdout: JSON.stringify({ data: { status: "NOT_RUN" }, errors: [{ code: "SEAT_CWD_MISMATCH" }] }) };
		},
	});
	const ident = join(f.home, ".config", "agent-mail", "identity", createHash("sha1").update(REPO).digest("hex").slice(0, 12));
	if (identity) writeFileSync(join(ident, "tern-44"), JSON.stringify({ name: identity }));
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

test.each(["chief", "chiefs"] as const)("CHIEFXPROJ1 %s resolves the chief's canonical seat for another mail project and honors its journal", async field => {
	const sessionFile = join(freshDir(base, "chief-session-"), "seat.jsonl");
	writeFileSync(sessionFile, '{"type":"mode_change","mode":"goal"}\n');
	const f = chiefFleet({}, "PeachLeopard", sessionFile);
	if (field === "chiefs") {
		const { chief } = JSON.parse(readFileSync(f.fleetWatchPath, "utf8"));
		writeFileSync(f.fleetWatchPath, JSON.stringify({ chiefs: [chief] }));
	}
	expect(await f.wake.resolve("PeachLeopard", CFS)).toEqual({
		kind: "seat", seat: { name: "PeachLeopard", session: "omp-test", block: "44", repo: CHIEF_CWD, project: REPO, sessionFile },
	});
	expect(await f.wake.caller(sessionFile, CFS)).toEqual({
		session: "omp-test", block: "44", repo: CHIEF_CWD, name: "PeachLeopard", projectName: null,
	});
	const args = { ...ask("PeachLeopard"), sender_name: "CrimsonHorizon", project_key: CFS };
	expect(await f.wake.beforeSend("cross-chief", "send_message", args, CFS)).toBeUndefined();
	const patch = await f.wake.afterSend({ toolCallId: "cross-chief", content: sent(78982), isError: false });
	expect(JSON.stringify(patch)).toContain("WAKE_DELIVERED: mail 78982 -> PeachLeopard at tern:44 (omp-test, /abs/fleet)");
	expect(f.ledger()).toMatchObject([{ status: "WAKE_DELIVERED", project_key: CFS, recipient: "PeachLeopard", pause_state: "NOT_PAUSED" }]);
	// The mail project has no journal binding. Only the resolved seat's journal can stop this wake.
	writeFileSync(sessionFile, '{"type":"mode_change","mode":"goal_paused"}\n');
	expect(await f.wake.beforeSend("cross-chief-paused", "send_message", args, CFS)).toBeUndefined();
	await f.wake.afterSend({ toolCallId: "cross-chief-paused", content: sent(78983), isError: false });
	expect(f.wakes()).toHaveLength(1);
	expect(f.ledger()[1]).toMatchObject({ status: "STOPPED_NOT_WOKEN", pause_state: "PAUSED", reason: expect.stringContaining("GOAL_PAUSED") });
});

test.each([
	["non-chief", {}, "PeachLeopard", "GreenRabbit"],
	["wrong identity name", {}, "OtherAgent", "PeachLeopard"],
	["missing identity", {}, "", "PeachLeopard"],
	["wrong block", { pane: "tern:45" }, "PeachLeopard", "PeachLeopard"],
	["wrong session", { session: "another-tab" }, "PeachLeopard", "PeachLeopard"],
	["wrong cwd", { cwd: "/abs/elsewhere" }, "PeachLeopard", "PeachLeopard"],
	["wrong canonical repo", { repo: "/abs/elsewhere" }, "PeachLeopard", "PeachLeopard"],
	["wrong configured agent", { agent: "OtherAgent" }, "PeachLeopard", "PeachLeopard"],
] as const)("CHIEFXPROJ1 planted %s remains NO_WAKE_PATH under another project", async (_label, chief, identity, recipient) => {
	const f = chiefFleet(chief, identity);
	const args = { ...ask(recipient), sender_name: "CrimsonHorizon", project_key: CFS };
	expect(await f.wake.resolve(recipient, CFS)).toMatchObject({ kind: "none" });
	expect((await f.wake.beforeSend("cross-chief-refused", "send_message", args, CFS))?.reason).toStartWith("NO_WAKE_PATH");
	expect(await f.wake.afterSend({ toolCallId: "cross-chief-refused", content: sent(78984), isError: false })).toBeUndefined();
	expect(f.wakes()).toHaveLength(0);
	expect(f.ledger()).toMatchObject([{ status: "NO_WAKE_PATH", refused: true, recipient, project_key: CFS }]);
});

test("CHIEFXPROJ1 canonical-project stop still applies when mail is under another project", async () => {
	const f = chiefFleet();
	const { chief } = JSON.parse(readFileSync(f.fleetWatchPath, "utf8"));
	writeFileSync(f.fleetWatchPath, JSON.stringify({ chief, sessions: [{ session: "other-tab", repo: REPO, pullEnabled: false }] }));
	const args = { ...ask("PeachLeopard"), sender_name: "CrimsonHorizon", project_key: CFS };
	expect(await f.wake.beforeSend("cross-chief-stopped", "send_message", args, CFS)).toBeUndefined();
	await f.wake.afterSend({ toolCallId: "cross-chief-stopped", content: sent(78985), isError: false });
	expect(f.wakes()).toHaveLength(0);
	expect(f.ledger()).toMatchObject([{ status: "STOPPED_NOT_WOKEN", reason: "PROJECT_STOPPED: fleet-watch pullEnabled false", project_key: CFS }]);
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

// STAGE0WAKE1 (ompkit-fp72.120.16.276): arm_seat --override-pause on one seat lets that seat's mail wake under the pause.
function stage0Fleet(receipts: Record<string, unknown>[] | null) {
	const f = fleet();
	writeFileSync(f.fleetWatchPath, JSON.stringify({ sessions: [{ session: "omp-test", repo: REPO, pullEnabled: false,
		pauseHistory: [{ at: "2026-11-02T17:15:00Z", pullEnabled: false, reason: "fleet stop" }] }] }));
	if (receipts === null) return f; // STAGE0WAKE2: the real producer writes the receipts file itself
	const dir = join(f.home, ".local", "state", "omp-kit-orchestration");
	mkdirSync(dir, { recursive: true });
	writeFileSync(join(dir, "goal-replacements.jsonl"), receipts.map(r => JSON.stringify(r)).join("\n") + "\n");
	return f;
}
const overrideArm = { at: "2026-11-05T06:57:00Z", session: "omp-test", block: "5", override_pause: "launch stage 0 canary" };

test("STAGE0WAKE1 planted: the excepted director wakes under the pause and a worker stays STOPPED", async () => {
	const f = stage0Fleet([overrideArm]);
	expect(await f.wake.beforeSend("s0", "send_message", { ...ask("RusticPine"), to: ["RusticPine", "JadeThrush"] }, REPO)).toBeUndefined();
	const text = JSON.stringify(await f.wake.afterSend({ toolCallId: "s0", content: sent(78726), isError: false }));
	expect(text).toContain("WAKE_DELIVERED: mail 78726 -> RusticPine at tern:5");
	expect(text).toContain("STOPPED_NOT_WOKEN: mail 78726 to JadeThrush");
	expect(f.wakes()).toHaveLength(1);
	expect(f.ledger()).toMatchObject([{ status: "WAKE_DELIVERED", recipient: "RusticPine", pause_override: "launch stage 0 canary" },
		{ status: "STOPPED_NOT_WOKEN", recipient: "JadeThrush", reason: "PROJECT_STOPPED: fleet-watch pullEnabled false" }]);
});

test("STAGE0WAKE1 control: no exception (none, stale before the pause, or disarmed) stops both", async () => {
	for (const receipts of [[], [{ ...overrideArm, at: "2026-11-01T00:00:00Z" }], [overrideArm, { at: "2026-11-05T07:00:00Z", session: "omp-test", block: "5" }]]) {
		const f = stage0Fleet(receipts);
		expect(await f.wake.beforeSend("c0", "send_message", { ...ask("RusticPine"), to: ["RusticPine", "JadeThrush"] }, REPO)).toBeUndefined();
		const text = JSON.stringify(await f.wake.afterSend({ toolCallId: "c0", content: sent(78727), isError: false }));
		expect(text).toContain("STOPPED_NOT_WOKEN: mail 78727 to RusticPine");
		expect(text).toContain("STOPPED_NOT_WOKEN: mail 78727 to JadeThrush");
		expect(f.wakes()).toHaveLength(0);
	}
});

test("STAGE0WAKE1 mutant: without the override lookup the director is stopped", () => {
	const f = stage0Fleet([overrideArm]);
	expect(pauseOverrideReason(f.fleetWatchPath, join(f.home, ".local", "state", "omp-kit-orchestration", "goal-replacements.jsonl"), "omp-test", "5")).toBe("launch stage 0 canary");
	expect(mailWakeStopReason(f.fleetWatchPath, REPO, REPO, "omp-test")).toBe("PROJECT_STOPPED: fleet-watch pullEnabled false");
	expect(mailWakeStopReason(f.fleetWatchPath, REPO, REPO, "omp-test", [], true)).toBeNull();
});

// STAGE0WAKE2 (ompkit-fp72.120.16.284): STAGE0WAKE1 passed on hand-written receipts while the live arm (--set
// --apply --override-pause, 2026-11-05 06:5xZ) wrote only an undated managed_goal row, so mail 78766 to the director
// read PROJECT_STOPPED. These receipts come from arm_seat.py's real main(): its seat reads, the journal the proof
// reads and every Tern call are intercepted in the child, so nothing reaches a live seat.
const ARM_SEAT = join(homedir(), ".claude", "skills", "omp-kit-orchestration", "scripts", "arm_seat.py");
const PRODUCER = Bun.which("python3", { PATH: process.env.PATH ?? "" }) !== null && existsSync(ARM_SEAT);
const STAGE0_REASON = "launch stage 0: wake the director (STAGE0WAKE2)";
const ARM_DRIVER = String.raw`
import contextlib, importlib.util, io, json, pathlib, sys, time
from unittest import mock
path, fleet_watch, variant, repo, reason = sys.argv[1:6]
spec = importlib.util.spec_from_file_location("arm_seat", path)
me = importlib.util.module_from_spec(spec)
sys.modules["arm_seat"] = me
spec.loader.exec_module(me)
journal = [{"type": "mode_change", "id": "m0", "mode": "goal", "data": {"goal": {"id": "old1", "objective": "Old."}}}]
sends = []

def run(argv, timeout=0):
    if list(argv[:3]) != ["tern", "send", "5"]:
        return 127, "", "fixture: unexpected native call"
    sends.append(list(argv[3:]))
    if list(argv[3:]) == ["keys", "Enter"]:
        journal.extend([{"type": "message", "message": {"role": "user"}},
                        {"type": "mode_change", "id": "m1", "mode": "goal",
                         "data": {"goal": {"id": "new1", "objective": "Direct omp-test as RusticPine."}}}])
    return 0, "", ""

seat = {"repo": repo, "role": "director", "session_file": str(pathlib.Path.home() / "rustic.jsonl"),
        "name": "RusticPine", "binding": "fixture", "goal": ("goal", "old1"), "ok": True, "why": "fixture"}
prompt = {"id": "director-loop-objective@v21", "body": "/goal Direct omp-test as <your agent name>.",
          "basis": "fixture", "body_sha256": "fixture"}
argv = ["--session", "omp-test", "--block", "5", "--version", "21", "--set", "--apply"]
if variant != "control":
    argv += ["--override-pause", reason]
patches = [mock.patch.object(me, "read_seat", return_value=seat),
           mock.patch.object(me, "select_prompt", return_value=prompt),
           mock.patch.object(me, "tern_pane", return_value=({"omp_session_file": seat["session_file"]}, "director")),
           mock.patch.object(me, "session_entries", side_effect=lambda p: list(journal)),
           mock.patch.object(me.fsa, "FLEET_WATCH", pathlib.Path(fleet_watch)),
           mock.patch.object(me.fsa, "run", side_effect=run),
           mock.patch.object(time, "sleep", return_value=None)]
if variant == "mutant":  # the producer before STAGE0WAKE2: the reason never reaches the receipt row
    real = me.receipt
    patches.append(mock.patch.object(me, "receipt",
                                     side_effect=lambda row: real({k: v for k, v in row.items() if k != "override_pause"})))
buf = io.StringIO()
with contextlib.ExitStack() as stack, contextlib.redirect_stdout(buf):
    for p in patches:
        stack.enter_context(p)
    rc = me.main(argv)
print(json.dumps({"rc": rc, "out": json.loads(buf.getvalue().strip().splitlines()[-1]), "sends": sends,
                  "receipts": str(me.RECEIPTS)}))
`;

/** One real arm_seat.py `--set --apply` of the director (block 5) while omp-test is paused, then its receipt rows. */
function armUnderPause(variant: "planted" | "control" | "mutant") {
	const f = stage0Fleet(null);
	const state = join(f.home, ".local", "state");
	const run = runFixture(["python3", "-c", ARM_DRIVER, ARM_SEAT, f.fleetWatchPath, variant, REPO, STAGE0_REASON], {
		cwd: f.home, floor_s: 30, label: `arm_seat STAGE0WAKE2 ${variant}`,
		env: { PATH: process.env.PATH, HOME: f.home, XDG_STATE_HOME: state, LANG: "C.UTF-8" },
	});
	const stderr = new TextDecoder().decode(run.stderr);
	if (run.rc !== 0) throw new Error(`arm_seat driver rc=${run.rc}: ${stderr}`);
	const arm = JSON.parse(new TextDecoder().decode(run.stdout).trim().split("\n").at(-1)!);
	const receiptsPath = join(state, "omp-kit-orchestration", "goal-replacements.jsonl");
	expect(arm.receipts).toBe(receiptsPath); // producer and kit-mail-wake resolve one file
	const rows = existsSync(receiptsPath)
		? readFileSync(receiptsPath, "utf8").split("\n").filter(line => line.trim()).map(line => JSON.parse(line))
		: [];
	return { f, arm, rows };
}

async function mailDirector(wake: MailWake, id: number) {
	expect(await wake.beforeSend(`w${id}`, "send_message", { ...ask("RusticPine"), to: ["RusticPine", "JadeThrush"] }, REPO)).toBeUndefined();
	return JSON.stringify(await wake.afterSend({ toolCallId: `w${id}`, content: sent(id), isError: false }));
}

const SET_SENDS = [["keys", "ctrl+e"], ["keys", "ctrl+u"], ["paste", "/goal set Direct omp-test as RusticPine."], ["keys", "Enter"]];

test.skipIf(!PRODUCER)("STAGE0WAKE2 planted: arm_seat --set --override-pause under the pause writes the row kit-mail-wake reads, and the director's mail is woken with pause_override", async () => {
	const { f, arm, rows } = armUnderPause("planted");
	expect(arm).toMatchObject({ rc: 0, out: { result: "DELIVERED", override_pause: STAGE0_REASON }, sends: SET_SENDS });
	expect(rows).toEqual([expect.objectContaining({ kind: "managed_goal", session: "omp-test", block: "5", at: expect.any(String), override_pause: STAGE0_REASON })]);
	const text = await mailDirector(f.wake, 78766);
	expect(text).toContain("WAKE_DELIVERED: mail 78766 -> RusticPine at tern:5");
	expect(f.wakes()).toHaveLength(1);
	expect(f.ledger()).toMatchObject([{ status: "WAKE_DELIVERED", recipient: "RusticPine", pause_override: STAGE0_REASON },
		{ status: "STOPPED_NOT_WOKEN", recipient: "JadeThrush", reason: "PROJECT_STOPPED: fleet-watch pullEnabled false" }]);
}, fixtureDeadlineS(60) * 1000);

test.skipIf(!PRODUCER)("STAGE0WAKE2 control: without --override-pause the arm is refused, writes no row, and the director's mail reads PROJECT_STOPPED", async () => {
	const { f, arm, rows } = armUnderPause("control");
	expect(arm).toMatchObject({ rc: 2, out: { result: "REFUSED_PAUSED" }, sends: [] });
	expect(rows).toEqual([]);
	expect(await mailDirector(f.wake, 78767)).toContain("STOPPED_NOT_WOKEN: mail 78767 to RusticPine");
	expect(f.wakes()).toHaveLength(0);
	expect(f.ledger()[0]).toMatchObject({ status: "STOPPED_NOT_WOKEN", recipient: "RusticPine", reason: "PROJECT_STOPPED: fleet-watch pullEnabled false" });
}, fixtureDeadlineS(60) * 1000);

test.skipIf(!PRODUCER)("STAGE0WAKE2 mutant: a producer whose receipt row drops override_pause (0.2.94: stdout only) leaves the director PROJECT_STOPPED", async () => {
	const { f, arm, rows } = armUnderPause("mutant");
	expect(arm).toMatchObject({ rc: 0, out: { result: "DELIVERED", override_pause: STAGE0_REASON }, sends: SET_SENDS });
	expect(rows).toEqual([expect.objectContaining({ kind: "managed_goal", session: "omp-test", block: "5", at: expect.any(String) })]);
	expect(rows[0]).not.toHaveProperty("override_pause");
	expect(await mailDirector(f.wake, 78768)).toContain("STOPPED_NOT_WOKEN: mail 78768 to RusticPine");
	expect(f.wakes()).toHaveLength(0);
	expect(f.ledger()[0]).toMatchObject({ status: "STOPPED_NOT_WOKEN", recipient: "RusticPine", reason: "PROJECT_STOPPED: fleet-watch pullEnabled false" });
}, fixtureDeadlineS(60) * 1000);
