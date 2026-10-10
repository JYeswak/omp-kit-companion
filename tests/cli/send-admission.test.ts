import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { proveSend, type SendExec } from "../../src/send.ts";
import type { AdmissionInput } from "../../src/actuator-admission.ts";

// ompkit-bj08.5: pause/custody negatives through the real send branch.

const repoRoot = resolve(import.meta.dir, "../..");
const scratchRoot = join(repoRoot, "var", "agent-tmp");
mkdirSync(scratchRoot, { recursive: true });
const scratch = mkdtempSync(join(scratchRoot, "send-admission." + process.pid + "."));
writeFileSync(join(scratch, ".owner"), "pid=" + process.pid + " label=send-admission-test repo=" + repoRoot + " created=" + new Date().toISOString() + "\n");
const testEnv = { ...process.env, TMUX_TMPDIR: join(scratch, "managed") };
delete testEnv.TMUX;

const noWait = async (_ms: number) => {};

function countingPane(): { exec: SendExec; calls: string[][]; sends: number } {
	const calls: string[][] = [];
	let sends = 0;
	let lastText = "";
	return {
		calls,
		get sends() { return sends; },
		exec: {
			run(argv: string[]) {
				calls.push([...argv]);
				if (argv[0] === "ntm") {
					sends++;
					lastText = argv[argv.length - 1] ?? "";
					return { code: 0, out: "sent" };
				}
				return { code: 0, out: lastText };
			},
		},
	};
}

function dropDir(): string {
	const dir = join(scratch, "drop-" + Math.random().toString(36).slice(2));
	mkdirSync(dir, { recursive: true });
	return dir;
}

function snapshot(authority: "ACTIVE" | "PAUSED"): AdmissionInput {
	return {
		launcherBinding: "none",
		authority,
		authorityConfirmed: true,
		authorityGeneration: "gen-7",
		launchers: [],
		keeper: null,
		packet: { action: "send", ownedAction: "send", generation: "gen-7" },
		governedActions: ["send"],
	};
}

test("[b] planted: paused authority refuses through real proveSend with zero effects", async () => {
	const pane = countingPane();
	const dir = dropDir();
	const result = await proveSend({ session: "s", pane: "%1", message: "hello", dropDir: dir, exec: pane.exec, env: testEnv, pollMs: 1, deadlineMs: 50, wait: noWait, admission: snapshot("PAUSED") });
	expect(result.status).toBe("ADMISSION_REFUSED");
	expect(result.sends).toBe(0);
	expect(result.drop_path).toBeNull();
	expect(pane.calls).toEqual([]);
	expect(readdirSync(dir)).toEqual([]);
});

test("[b] admitted send proceeds through the real branch", async () => {
	const pane = countingPane();
	const result = await proveSend({ session: "s", pane: "%1", message: "hello", dropDir: dropDir(), exec: pane.exec, env: testEnv, pollMs: 1, deadlineMs: 50, wait: noWait, admission: snapshot("ACTIVE") });
	expect(result.status).toBe("OK");
	expect(result.sends).toBe(1);
	expect(pane.calls.length).toBeGreaterThan(0);
});
