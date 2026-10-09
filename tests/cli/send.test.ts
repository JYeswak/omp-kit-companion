import { expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { BEAD_ID, dispatchBeads, proveSend, type SendExec } from "../../src/send.ts";

const repoRoot = resolve(import.meta.dir, "../..");
const scratchRoot = join(repoRoot, "var", "agent-tmp");
mkdirSync(scratchRoot, { recursive: true });
const scratch = mkdtempSync(join(scratchRoot, "send-test." + process.pid + "."));
writeFileSync(join(scratch, ".owner"), "pid=" + process.pid + " label=send-test repo=" + repoRoot + " created=" + new Date().toISOString() + "\n");

const noWait = async (_ms: number) => {};

/** Fake pane: echoes the last sent text into captures once enough polls have passed. */
function echoPane(capturesBeforeEcho: number, sendRc: number[] = []): { exec: SendExec; taken: { sends: number; captures: number; captureArgv: string[][] } } {
	const taken = { sends: 0, captures: 0, captureArgv: [] as string[][] };
	let lastText = "";
	return {
		taken,
		exec: {
			run(argv: string[]) {
				if (argv[0] === "ntm") {
					taken.sends++;
					const code = sendRc.length ? sendRc.shift()! : 0;
					if (code === 0) lastText = argv[argv.length - 1] ?? "";
					return { code, out: code === 0 ? "sent" : "ntm failed" };
				}
				taken.captures++;
				taken.captureArgv.push(argv);
				return { code: 0, out: taken.captures >= capturesBeforeEcho ? lastText : "nothing yet" };
			},
		},
	};
}

function dropDir(): string {
	const dir = join(scratch, "drop-" + Math.random().toString(36).slice(2));
	mkdirSync(dir, { recursive: true });
	return dir;
}

test("SEND1: delivered marker returns OK with the marker seen", async () => {
	const { exec, taken } = echoPane(1);
	const seen = await proveSend({ session: "s", pane: "%1", message: "hello", dropDir: dropDir(), exec, pollMs: 1, deadlineMs: 50, wait: noWait });
	expect(taken.sends).toBe(1);
	expect(seen.status).toBe("OK");
	expect(seen.drop_path).toBeNull();
	expect(seen.marker.length).toBeGreaterThan(0);
});

test("SEND1 planted: missing pane returns NOT_DELIVERED and writes the drop file", async () => {
	const { exec, taken } = echoPane(Number.MAX_SAFE_INTEGER, [1, 1]);
	const dir = dropDir();
	const missed = await proveSend({ session: "gone", pane: "%9", message: "hello", dropDir: dir, exec, pollMs: 1, deadlineMs: 20, wait: noWait });
	expect(taken.sends).toBe(2);
	expect(missed.status).toBe("NOT_DELIVERED");
	expect(missed.drop_path ?? "").toContain(dir);
	expect(existsSync(missed.drop_path!)).toBe(true);
	expect(readFileSync(missed.drop_path!, "utf8")).toContain("hello");
	expect(readFileSync(missed.drop_path!, "utf8")).toContain(missed.marker);
});

test("SEND1: late marker within the deadline still returns OK without resending", async () => {
	const { exec, taken } = echoPane(3);
	const late = await proveSend({ session: "s", pane: "%1", message: "hello", dropDir: dropDir(), exec, pollMs: 1, deadlineMs: 5000, wait: noWait });
	expect(late.status).toBe("OK");
	expect(taken.sends).toBe(1);
	expect(taken.captures).toBe(3);
});

test("SEND1 capture uses the bare pane id with scrollback history", async () => {
	const { exec, taken } = echoPane(1);
	await proveSend({ session: "s", pane: "%1", message: "hello", dropDir: dropDir(), exec, pollMs: 1, deadlineMs: 50, wait: noWait });
	expect(taken.captureArgv.length).toBeGreaterThan(0);
	for (const argv of taken.captureArgv) {
		expect(argv).toEqual(["tmux", "capture-pane", "-p", "-S", "-200", "-t", "%1"]);
	}
});

const send = (message: string, noBeadReason?: string) => {
	const pane = echoPane(1);
	return proveSend({ session: "s", pane: "%1", message, noBeadReason, dropDir: dropDir(), exec: pane.exec, pollMs: 1, deadlineMs: 50, wait: noWait })
		.then((result) => ({ result, taken: pane.taken }));
};

test("BEAD1: a D dispatch citing no bead is refused with zero tmux submission", async () => {
	const { result, taken } = await send("D AM48600 flywheel-guard: mail project /Users/josh/Developer/localbench, thread 48536; prompt w.md@abc1234; ack first");
	expect(result.status).toBe("BEAD_REQUIRED");
	expect(taken.sends).toBe(0);
	expect(taken.captures).toBe(0);
});

test("BEAD1 planted: the same dispatch citing a bead proceeds and records it", async () => {
	const { result, taken } = await send("D AM48600 flywheel-guard: bead ompkit-xa5s; mail thread 48536; ack first");
	expect(result.status).toBe("OK");
	expect(taken.sends).toBe(1);
	expect(result.bead_ids).toEqual(["ompkit-xa5s"]);
	expect(result.no_bead_reason).toBeNull();
});

test("BEAD2: a queue: message without a bead is refused; with one it proceeds", async () => {
	const bare = await send("next up\nqueue: send-guard, doctor-rows");
	expect(bare.result.status).toBe("BEAD_REQUIRED");
	expect(bare.taken.sends).toBe(0);
	const cited = await send("next up for (core8-h9l.31).\nqueue: send-guard, doctor-rows");
	expect(cited.result.status).toBe("OK");
	expect(cited.result.bead_ids).toEqual(["core8-h9l.31"]);
});

test("BEAD3: DONE/BLOCKED returns, R: replies and notes are not dispatches", async () => {
	for (const message of [
		"DONE AM48600 flywheel-guard abc1234 R:AM48601; NEXT doctor-rows — omp-test:0.1",
		"BLOCKED AM48600 flywheel-guard reservation-held R:AM48602",
		"R: AM48600 looks good, ship it",
		"Did you mean D or E? the queue is empty",
	]) {
		const { result, taken } = await send(message);
		expect(result.status).toBe("OK");
		expect(taken.sends).toBe(1);
		expect(result.no_bead_reason).toBeNull();
	}
});

test("BEAD4: --no-bead-reason passes a bead-less dispatch and records the reason", async () => {
	const { result, taken } = await send("D AM48600 machine-reboot: restart the fleet", "  ops recovery, no tracker item  ");
	expect(result.status).toBe("OK");
	expect(taken.sends).toBe(1);
	expect(result.no_bead_reason).toBe("ops recovery, no tracker item");
	const blank = await send("D AM48600 machine-reboot: restart the fleet", "   ");
	expect(blank.result.status).toBe("BEAD_REQUIRED");
	expect(blank.taken.sends).toBe(0);
});

test("BEAD5: URLs, paths and the D-line slug are not bead ids", () => {
	const urls = dispatchBeads("D AM1 send-guard: see https://github.com/x/omp-kit-companion/pull/12 and src/kit-flywheel-guard.ts and ~/Developer/omp-kit/docs/core8-plan.md");
	expect(urls).toEqual({ dispatch: true, bead_ids: [] });
	expect(dispatchBeads("D AM1 cfs-9yrif: go").bead_ids).toEqual([]);
	expect(dispatchBeads("D AM1 x: bead=ompkit-xa5s").bead_ids).toEqual([]);
	expect(dispatchBeads("D AM1 x: cfs-9yrif, ompkit-rc-epic-land-fix-release-dogfood-rz5.125;").bead_ids).toEqual(["cfs-9yrif", "ompkit-rc-epic-land-fix-release-dogfood-rz5.125"]);
});

test("BEAD5 regex: real fleet ids match, near-misses do not, long near-miss is linear", () => {
	for (const id of ["ompkit-xa5s", "cfs-9yrif", "core8-h9l.31", "beads_rust-abc", "ompkit-rc-epic-land-fix-release-dogfood-rz5.125"]) expect(BEAD_ID.test(id)).toBe(true);
	for (const bad of ["ompkit", "-xa5s", "Ompkit-xa5s", "ompkit-", "ompkit-xa5s.", "ompkit-xa5s.a", "a/b-c", "https://a-b", "ompkit--x"]) expect(BEAD_ID.test(bad)).toBe(false);
	const nearMiss = "a" + "-b".repeat(50_000) + ".1".repeat(50_000) + "!";
	const started = performance.now();
	expect(BEAD_ID.test(nearMiss)).toBe(false);
	expect(performance.now() - started).toBeLessThan(200);
});
