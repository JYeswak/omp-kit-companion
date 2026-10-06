import { expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { proveSend, type SendExec } from "../../src/send.ts";

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
