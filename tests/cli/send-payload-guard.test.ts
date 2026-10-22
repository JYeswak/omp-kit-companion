import { afterAll, expect, test } from "bun:test";
import { mkdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { paneRunsShell, refuseShellPayload } from "../../src/send-payload-guard.ts";
import { proveSend, type SendExec } from "../../src/send.ts";
import { ownedTmp } from "../../src/kitlib/tmp.ts";

const repoRoot = resolve(import.meta.dir, "../..");
const scratchRoot = join(repoRoot, "var", "agent-tmp");
mkdirSync(scratchRoot, { recursive: true });
const scratchTmp = ownedTmp("send-payload-guard-test", { root: scratchRoot });
const scratch = scratchTmp.path;
afterAll(() => scratchTmp.cleanup());

const testEnv: NodeJS.ProcessEnv = { ...process.env, TMUX_TMPDIR: join(scratch, "managed") };
delete testEnv.TMUX;
const noWait = async (_ms: number) => {};
const dropDir = () => {
	const dir = join(scratch, "drop-" + Math.random().toString(36).slice(2));
	mkdirSync(dir, { recursive: true });
	return dir;
};

// Fake exec: pane_current_command answers per test; ntm send records (must stay unsent on refusal).
function fakeExec(paneCommand: string): { exec: SendExec; sends: string[][] } {
	const sends: string[][] = [];
	return {
		sends,
		exec: {
			run(argv: string[]) {
				if (argv.includes("#{pane_current_command}")) return { code: 0, out: paneCommand + "\n" };
				if (argv[0] === "ntm") {
					sends.push(argv);
					return { code: 0, out: "sent" };
				}
				return { code: 0, out: "" };
			},
		},
	};
}

const run = (exec: SendExec, message: string) =>
	proveSend({ session: "s", pane: "%1", message, dropDir: dropDir(), exec, env: testEnv, pollMs: 1, deadlineMs: 20, wait: noWait });

// --- unit: shell detection ---
test("shells by name, login dash, and full path", () => {
	for (const cmd of ["zsh", "bash", "sh", "fish", "-zsh", "/bin/bash", "/usr/local/bin/fish"]) {
		expect(paneRunsShell(cmd)).toBe(true);
	}
});

test("agent panes and empties are not shells", () => {
	for (const cmd of ["omp", "claude", "codex", "node", "bun", "vim", ""]) {
		expect(paneRunsShell(cmd)).toBe(false);
	}
});

// --- unit: payload matcher ---
test("fire rows refused with naming rule", () => {
	expect(refuseShellPayload("tmux kill-server")?.rule).toBe("send-payload-tmux-kill-server");
	expect(refuseShellPayload("sudo tmux -S /tmp/x kill-server")?.rule).toBe("send-payload-tmux-kill-server");
	expect(refuseShellPayload("echo hi; pkill -9 ollama")?.rule).toBe("send-payload-pattern-kill");
	expect(refuseShellPayload("FOO=1 pkill agent")?.rule).toBe("send-payload-pattern-kill");
	expect(refuseShellPayload("rm -rf ~")?.rule).toBe("send-payload-rmrf-critical");
	expect(refuseShellPayload("sudo rm -fr /")?.rule).toBe("send-payload-rmrf-critical");
	expect(refuseShellPayload("rm -r -f /*")?.rule).toBe("send-payload-rmrf-critical");
});

test("quiet rows pass: prose, benign, near-names", () => {
	expect(refuseShellPayload("ls")).toBeNull();
	expect(refuseShellPayload("never pkill the watcher, wait for your PID")).toBeNull();
	expect(refuseShellPayload("the tmux kill-server incident is documented")).toBeNull();
	expect(refuseShellPayload("rm -rf ./build-cache")).toBeNull();
	expect(refuseShellPayload("rm -rf build")).toBeNull();
	expect(refuseShellPayload("rm old.txt")).toBeNull();
	expect(refuseShellPayload("rmpkill is not a command")).toBeNull();
	expect(refuseShellPayload("my tmux-kill-server-wrapper helps")).toBeNull();
});

// --- integration: proveSend gates on pane type ---
test("incident shape: separator-joined kill-server refused, space-joined passes", async () => {
	// 2026-10-09 fire row: multi-command text ending in a shell-executed
	// `tmux kill-server` (separator form) killed every session. The same
	// words space-joined are arguments to sleep, not an execution.
	const { exec } = fakeExec("zsh");
	const fired = await run(exec, "sleep 5; tmux kill-server");
	expect(fired.status).toBe("ADMISSION_REFUSED");
	expect(fired.detail).toContain("send-payload-tmux-kill-server");
	const { exec: exec2 } = fakeExec("zsh");
	const quiet = await run(exec2, "sleep 5 tmux kill-server");
	expect(quiet.status).not.toBe("ADMISSION_REFUSED");
});

test("kill-server to a shell pane is ADMISSION_REFUSED and nothing is sent", async () => {
	const { exec, sends } = fakeExec("zsh");
	const got = await run(exec, "tmux kill-server");
	expect(got.status).toBe("ADMISSION_REFUSED");
	expect(got.detail).toContain("send-payload-tmux-kill-server");
	expect(sends.length).toBe(0);
});

test("same payload to an agent pane passes the guard", async () => {
	const { exec } = fakeExec("omp");
	const got = await run(exec, "tmux kill-server");
	expect(got.status).not.toBe("ADMISSION_REFUSED");
});

test("benign payload to a shell pane passes the guard", async () => {
	const { exec } = fakeExec("bash");
	const got = await run(exec, "ls");
	expect(got.status).not.toBe("ADMISSION_REFUSED");
});

// --- regex budget: long near-miss stays fast ---
test("64KB near-miss completes quickly", () => {
	const near = "pkill".padStart(1024, "x").repeat(64).slice(0, 65536);
	const start = Date.now();
	expect(refuseShellPayload(near)).toBeNull();
	expect(Date.now() - start).toBeLessThan(1000);
	const nearRm = ("rm -" + "r".repeat(500) + " ").repeat(200).slice(0, 65536);
	const start2 = Date.now();
	expect(refuseShellPayload(nearRm)).toBeNull();
	expect(Date.now() - start2).toBeLessThan(1000);
});
