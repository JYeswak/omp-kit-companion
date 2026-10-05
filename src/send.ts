import { spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { randomBytes } from "node:crypto";

export const SEND_POLL_MS = 1500;
export const SEND_DEADLINE_MS = 15000;
export const SEND_MAX_SENDS = 2;

export interface SendExec {
	run(argv: string[]): { code: number; out: string };
}

export interface ProvenSend {
	status: "OK" | "NOT_DELIVERED";
	marker: string;
	sends: number;
	drop_path: string | null;
	detail: string;
}

function defaultExec(): SendExec {
	return {
		run(argv) {
			const run = spawnSync(argv[0]!, argv.slice(1), { encoding: "utf8", maxBuffer: 4 * 1024 * 1024 });
			return { code: run.status ?? 1, out: String(run.stdout ?? "") };
		},
	};
}

const waitFor = async (ms: number) => {
	await new Promise<void>((resolve) => setTimeout(resolve, ms));
};

function dropMessage(dropDir: string, session: string, pane: string, marker: string, message: string): string {
	mkdirSync(dropDir, { recursive: true });
	const stamp = new Date().toISOString().replace(/[:.]/g, "-");
	const path = join(dropDir, `${session}-${pane.replace(/[^A-Za-z0-9]+/g, "_")}-${stamp}-${marker}.md`);
	writeFileSync(path, `# Undelivered fleet message\n\n- session: ${session}\n- pane: ${pane}\n- marker: ${marker}\n- at: ${new Date().toISOString()}\n\n${message}\n`);
	return path;
}

/** Send via ntm and prove the marker landed in the target pane's capture. */
export async function proveSend(input: {
	session: string;
	pane: string;
	message: string;
	dropDir: string;
	exec?: SendExec;
	pollMs?: number;
	deadlineMs?: number;
	wait?: (ms: number) => Promise<void>;
}): Promise<ProvenSend> {
	const exec = input.exec ?? defaultExec();
	const pollMs = input.pollMs ?? SEND_POLL_MS;
	const deadlineMs = input.deadlineMs ?? SEND_DEADLINE_MS;
	const wait = input.wait ?? waitFor;
	const marker = `kit-send-${randomBytes(6).toString("hex")}`;
	const text = `${input.message}\n[${marker}]`;
	for (let sends = 1; sends <= SEND_MAX_SENDS; sends++) {
		if (exec.run(["ntm", "send", input.session, "--panes=" + input.pane, text]).code !== 0) continue;
		const started = Date.now();
		while (Date.now() - started < deadlineMs) {
			const got = exec.run(["tmux", "capture-pane", "-p", "-t", `${input.session}:${input.pane}`]);
			if (got.code === 0 && got.out.includes(marker)) {
				return { status: "OK", marker, sends, drop_path: null, detail: `marker seen in ${input.session}:${input.pane} after ${sends} send(s)` };
			}
			await wait(pollMs);
		}
	}
	const dropPath = dropMessage(input.dropDir, input.session, input.pane, marker, input.message);
	return { status: "NOT_DELIVERED", marker, sends: SEND_MAX_SENDS, drop_path: dropPath, detail: `marker never appeared in ${input.session}:${input.pane}; message written to ${dropPath}` };
}
