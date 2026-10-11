import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { proveSend, type SendExec } from "../../src/send.ts";

// ompkit-q3mw SENDRESUME1: slash commands go out verbatim (no marker) and
// delivery is proved by the command effect, never by marker echo.

const repoRoot = resolve(import.meta.dir, "../..");
const scratchRoot = join(repoRoot, "var", "agent-tmp");
mkdirSync(scratchRoot, { recursive: true });
const scratch = mkdtempSync(join(scratchRoot, "send-slash-test." + process.pid + "."));
writeFileSync(join(scratch, ".owner"), "pid=" + process.pid + " label=send-slash-test repo=" + repoRoot + " created=" + new Date().toISOString() + "\n");

const noWait = async (_ms: number) => {};
const dropDir = () => {
	const dir = join(scratch, "drop-" + Math.random().toString(36).slice(2));
	mkdirSync(dir, { recursive: true });
	return dir;
};
const managed = join(scratch, "managed");
mkdirSync(managed, { recursive: true });
const managedEnv = () => ({ TMUX_TMPDIR: managed });
const STATIC = "pane %1 idle, empty scrollback";

function staticPane(): { exec: SendExec; argvLog: string[][] } {
	const argvLog: string[][] = [];
	return { argvLog, exec: { run(argv: string[]) {
		argvLog.push(argv);
		if (argv[0] === "ntm") return { code: 0, out: "sent" };
		return { code: 0, out: STATIC };
	} } };
}

function echoPane(): { exec: SendExec; argvLog: string[][] } {
	const argvLog: string[][] = [];
	let sent = "";
	let captures = 0;
	return { argvLog, exec: { run(argv: string[]) {
		argvLog.push(argv);
		if (argv[0] === "ntm") {
			sent = String(argv[argv.length - 1] ?? "");
			return { code: 0, out: "sent" };
		}
		if (argv[1] === "capture-pane") {
			captures++;
			return { code: 0, out: captures <= 1 ? STATIC : "pane> " + sent };
		}
		return { code: 0, out: "" };
	} } };
}

const sentText = (log: string[][]) => {
	const ntm = log.find((argv) => argv[0] === "ntm");
	return String(ntm?.[ntm.length - 1] ?? "");
};

test("planted: /resume to nowhere reports NOT_DELIVERED and sends clean text", async () => {
	const pane = staticPane();
	const got = await proveSend({ session: "s", pane: "%1", message: "/resume does-not-exist", dropDir: dropDir(), exec: pane.exec, env: managedEnv(), pollMs: 1, deadlineMs: 20, wait: noWait });
	expect(got.status).toBe("NOT_DELIVERED");
	expect(sentText(pane.argvLog)).toBe("/resume does-not-exist");
	expect(sentText(pane.argvLog)).not.toMatch(/\[kit-send-/);
});

test("effect: a slash command with visible effect reports OK without Enter", async () => {
	const pane = echoPane();
	const got = await proveSend({ session: "s", pane: "%1", message: "/resume sess-1", dropDir: dropDir(), exec: pane.exec, env: managedEnv(), pollMs: 1, deadlineMs: 200, wait: noWait });
	expect(got.status).toBe("OK");
	expect(got.detail).toMatch(/command effect observed/);
	expect(sentText(pane.argvLog)).toBe("/resume sess-1");
	expect(pane.argvLog.filter((argv) => argv[1] === "send-keys")).toEqual([]);
});

test("regression: plain messages still append the marker and prove by echo", async () => {
	const pane = echoPane();
	const got = await proveSend({ session: "s", pane: "%1", message: "hello", dropDir: dropDir(), exec: pane.exec, env: managedEnv(), pollMs: 1, deadlineMs: 200, wait: noWait });
	expect(got.status).toBe("OK");
	expect(sentText(pane.argvLog)).toMatch(/\[kit-send-[0-9a-f]{12}\]$/);
	expect(got.detail).toMatch(/marker seen/);
});
