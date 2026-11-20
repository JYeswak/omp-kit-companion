import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { TernObservation, TernObserverIo } from "../../src/plane-tern.ts";
import { ownedTmp } from "../../src/kitlib/tmp.ts";
import { buildTernProofKey, deliverToTernSeat, paneLockPath } from "../../src/send.ts";

const oldStart = "Thu Nov 19 01:25:00 2026";
const currentStart = "Thu Nov 19 02:36:00 2026";
const oldMarker = "kit-send-0123456789ae";
const oldPayload = `old wake\n[${oldMarker}]`;
const newPayload = "new wake";
const sha = (value: string) => createHash("sha256").update(value).digest("hex");
const line = (value: object) => `${JSON.stringify(value)}\n`;
const message = (id: string, parentId: string | null, role: string, text: string) =>
	line({ type: "message", id, parentId, message: { role, content: [{ type: "text", text }], ...(role === "assistant" ? { stopReason: "stop" } : {}) } });
const sessionFile = "/fixture/stale-incarnation.jsonl";
const initialJournal = line({ type: "session", version: 3, id: "s1", cwd: "/repo" }) + message("m1", null, "assistant", "ready");

async function exercise(foregroundStarted: string | null, options: { consumed?: boolean; refuseLedger?: boolean; heldLock?: boolean } = {}) {
	const scratch = ownedTmp("send-stale-incarnation", { root: process.env.TMPDIR });
	try {
		const dropDir = join(scratch.path, "drop");
		const pendingDir = join(scratch.path, "tern-pending");
		const pending = join(pendingDir, `s_7_W.${sha("s1").slice(0, 16)}.json`);
		const ledger = join(pendingDir, "ledger.jsonl");
		mkdirSync(dropDir);
		mkdirSync(pendingDir);
		if (options.refuseLedger) mkdirSync(ledger);
		if (options.heldLock) {
			const lock = paneLockPath(dropDir, "s", "7");
			mkdirSync(dirname(lock), { recursive: true });
			writeFileSync(lock, `${process.pid}\n`);
		}
		const key = buildTernProofKey(initialJournal, { sessionId: "s1", leafId: "m1" },
			{ kind: "message", payload: oldPayload, marker: oldMarker, objective: "" });
		const original = line({ ...key, seatKey: "s_7_W", sessionSha: sha(initialJournal), textSha256: sha("old wake"),
			createdAt: "2026-11-19T02:00:00Z", foregroundStarted });
		writeFileSync(pending, original);
		let journal = options.consumed
			? initialJournal + message("old", "m1", "user", oldPayload) + message("settled", "old", "assistant", "old wake processed")
			: initialJournal;
		const binding = { sessionId: "1", sessionUuid: "s1", sessionFile, paneId: "7", foregroundPid: 12,
			foregroundName: "omp", foregroundStarted: currentStart, foregroundArgv: ["omp"], cwd: "/repo" };
		const observation: TernObservation = { state: "IDLE", working: false, oracleBusy: false, sessionFile,
			sessionSha: sha(journal), sessionCursorBytes: null, sessionLeafId: null, fg: null,
			runtimeBinding: binding, evidence: [], reason: null };
		const sent: string[] = [];
		let settledBeforeDispatch = false;
		const io: TernObserverIo = {
			wait: async () => {},
			readSessionFile: () => journal,
			run(argv) {
				if (argv.includes("lua")) {
					settledBeforeDispatch = existsSync(ledger) && readFileSync(ledger, "utf8").includes(oldMarker);
					const payload = [...argv.join("\n").matchAll(/string\.char\(([0-9,]+)\)/g)].slice(1)
						.flatMap((match) => match[1]!.split(",").map(Number));
					const text = Buffer.from(payload).toString("utf8");
					sent.push(text);
					journal += message("new", options.consumed ? "settled" : "m1", "user", text);
				}
				return { code: 0, out: '{"ok":true}' };
			},
		};
		const result = await deliverToTernSeat({ seat: { session: "s", pane: "7", windowKey: "W", cwd: "/repo", identityProject: "/repo" },
			text: newPayload, dropDir, io, observe: async () => observation,
			identify: async () => ({ status: "IDENTIFIED", agent: "Fixture", binding: "b", cwdOk: true, runtimeBinding: binding }),
			env: { AGENT_NAME: "FixtureSender" }, pollMs: 1, deadlineMs: 5, wait: io.wait });
		return { result, sent, original, settledBeforeDispatch, pending: existsSync(pending) ? readFileSync(pending, "utf8") : null,
			ledger: !options.refuseLedger && existsSync(ledger) ? readFileSync(ledger, "utf8").trim().split("\n").map((row) => JSON.parse(row)) : [],
			drops: readdirSync(dropDir).map((name) => readFileSync(join(dropDir, name), "utf8")) };
	} finally {
		scratch.cleanup();
	}
}

test("older foreground: acknowledge the old wake and dispatch and prove only the new wake", async () => {
	const { result, sent, pending, ledger, drops, settledBeforeDispatch } = await exercise(oldStart);
	expect(result).toMatchObject({ status: "OK", code: "PROVEN", sends: 1 });
	expect(result.detail).toContain(oldMarker);
	expect(result.detail).toContain("recovery copy");
	expect(sent).toEqual([`[from agent FixtureSender via omp-kit send]\n${newPayload}\n[${result.marker}]`]);
	expect(settledBeforeDispatch).toBe(true);
	expect(pending).toBeNull();
	expect(ledger).toMatchObject([{ status: "ACKNOWLEDGED", marker: oldMarker, offset: null }]);
	expect(drops).toHaveLength(1);
	expect(drops[0]).toContain(oldMarker);
});

test.each([currentStart, null, "unreadable", "Thu Nov 19 03:00:00 2026"])(
	"a current or unproven predecessor (%s) retains the original hold", async (start) => {
		const { result, sent, ledger, drops, pending, original } = await exercise(start);
		expect(result).toMatchObject({ status: "PENDING_CONSUME", code: "SUPPRESSED_PENDING", marker: oldMarker, sends: 0 });
		expect(sent).toEqual([]);
		expect(ledger).toEqual([]);
		expect(drops).toEqual([]);
		expect(pending).toBe(original);
	},
);

test("a provably consumed old record stays consumed, not an acknowledgement of loss", async () => {
	const { result, sent, ledger, drops } = await exercise(oldStart, { consumed: true });
	expect(result).toMatchObject({ status: "OK", sends: 1 });
	expect(sent).toEqual([`[from agent FixtureSender via omp-kit send]\n${newPayload}\n[${result.marker}]`]);
	expect(ledger).toMatchObject([{ status: "CONSUMED_LATER", marker: oldMarker, offset: Buffer.byteLength(initialJournal) }]);
	expect(drops).toEqual([]);
});

test("failed stale settlement keeps the hold and does not dispatch", async () => {
	const { result, sent, pending, original } = await exercise(oldStart, { refuseLedger: true });
	expect(result).toMatchObject({ status: "REFUSED", code: "PENDING_SETTLEMENT_FAILED", sends: 0 });
	expect(sent).toEqual([]);
	expect(pending).toBe(original);
});

test("another sender holding the pane lock prevents stale settlement", async () => {
	const { result, sent, ledger, drops, pending, original } = await exercise(oldStart, { heldLock: true });
	expect(result).toMatchObject({ status: "NOT_DELIVERED", code: "LOCK_BUSY", sends: 0 });
	expect(sent).toEqual([]);
	expect(ledger).toEqual([]);
	expect(drops.some((drop) => drop.includes(oldMarker))).toBe(false);
	expect(pending).toBe(original);
});
