import { afterAll, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { FlywheelExecOptions, FlywheelExecResult } from "./kit-flywheel-guard";
import { createMailWake, messageIdOf } from "./kit-mail-wake";

const base = mkdtempSync(join(tmpdir(), "kit-mail-wake-"));
afterAll(() => rmSync(base, { recursive: true, force: true }));

const REPO = "/abs/fleet/omp-kit";
interface Call { command: string; args: string[]; options?: FlywheelExecOptions }

/** A fleet: omp-test tab with live blocks 5 (RusticPine, director) and 9 (JadeThrush); GreenRabbit is a background agent. */
function fleet(opts: { omp?: (call: Call) => FlywheelExecResult | Promise<FlywheelExecResult>; fastWaitMs?: number } = {}) {
	const home = mkdtempSync(join(base, "home-"));
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
		if (command === "tern") return { code: 0, stdout: JSON.stringify({ sessions: [{ name: "Default", tabs: [{ name: "omp-test", blocks: [{ id: 5, cwd: REPO, live: true }, { id: 9, cwd: REPO, live: true }] }] }] }) };
		if (command === "am") return { code: 0, stdout: JSON.stringify([{ name: "GreenRabbit", task_description: "MAILPROTO1 bead ompkit-fp72.134 (roster BuildMailProto)" }, { name: "StormyCove", task_description: "rhy9.16 cutover under CopperTrout" }]) };
		if (command === "omp-kit") return opts.omp ? opts.omp(call) : { code: 0, stdout: JSON.stringify({ data: { status: "OK", detail: "landed" } }) };
		return { code: 127, stdout: "", stderr: "unexpected" };
	};
	const ledgerPath = join(home, "mail-wake.jsonl");
	const wake = createMailWake({ exec, home, env: {}, rosterPath, fleetWatchPath, ledgerPath, fastWaitMs: opts.fastWaitMs ?? 200, untilDeliveredS: 600 });
	const ledger = () => existsSync(ledgerPath) ? readFileSync(ledgerPath, "utf8").trim().split("\n").map(line => JSON.parse(line)) : [];
	const wakes = () => calls.filter(call => call.command === "omp-kit");
	return { wake, calls, ledger, wakes };
}

const sent = (id: number) => [{ type: "text", text: JSON.stringify({ deliveries: [{ project: REPO, payload: { id, subject: "s" } }], count: 1 }) }];
const ask = (to: string) => ({ project_key: REPO, sender_name: "PeachLeopard", to: [to], subject: "QUESTION ompkit-uk9wn: who owns sitrep?", body_md: "b", ack_required: true });

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
