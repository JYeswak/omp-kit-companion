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
	status: "OK" | "PENDING_SUBMIT" | "NOT_DELIVERED" | "BEAD_REQUIRED";
	marker: string;
	sends: number;
	drop_path: string | null;
	detail: string;
	bead_ids: string[];
	no_bead_reason: string | null;
}

/**
 * Tracker id shape across the fleet's .beads stores (72k ids checked):
 * `<prefix>-<seg>[-<seg>...][.<n>...]`, e.g. ompkit-xa5s, cfs-9yrif,
 * core8-h9l.31, beads_rust-abc. Matched against a whole whitespace token so
 * URLs and paths (`https://x/y-z`, `src/kit-flywheel.ts`) never qualify.
 * Linear: every repeated group starts with a distinct literal.
 */
export const BEAD_ID = /^[a-z][a-z0-9_]*(?:-[a-z0-9]+)+(?:\.[0-9]+)*$/;
const TOKEN_EDGE = /^[(\[{"'`<]+|[)\]}"'`>,;:!?.]+$/g;

/**
 * Kernel inv 4: beads are the execution substrate. A work dispatch is a
 * message whose first token is `D` (DISPATCH.md pane line `D AM<id> <slug>`)
 * or that has a line starting `queue:`. Slugs are not beads: the D line's
 * slug position and the names after `queue:` do not count as citations.
 */
export function dispatchBeads(message: string): { dispatch: boolean; bead_ids: string[] } {
	const lines = message.split("\n");
	const dLine = /^\s*D /.test(message);
	const queue = lines.some((line) => /^\s*queue:/.test(line));
	const bead_ids: string[] = [];
	lines.forEach((line, index) => {
		let tokens = line.trim().split(/\s+/);
		if (index === 0 && dLine) tokens = tokens.slice(3);
		const queueAt = tokens.findIndex((token) => token.startsWith("queue:"));
		if (queueAt >= 0) tokens = tokens.slice(0, queueAt);
		for (const token of tokens) {
			const bare = token.replace(TOKEN_EDGE, "");
			if (BEAD_ID.test(bare) && !bead_ids.includes(bare)) bead_ids.push(bare);
		}
	});
	return { dispatch: dLine || queue, bead_ids };
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

/**
 * True when the marker appears in the lower-most composer region: after the
 * latest default `╭──` border or Claude `─` rule immediately above a `❯` prompt.
 */
export function markerInComposer(capture: string, marker: string): boolean {
	const lines = capture.split("\n");
	let composerStart = -1;
	for (let i = 0; i < lines.length; i++) {
		const line = lines[i]!.trimStart();
		if (line.startsWith("╭──")) composerStart = i + 1;
		if (line.startsWith("─") && lines[i + 1]?.trimStart().startsWith("❯")) composerStart = i + 1;
	}
	return composerStart >= 0 && lines.slice(composerStart).some((line) => line.includes(marker));
}

/**
 * Send via ntm and prove the marker landed in the target pane's capture.
 * A work dispatch citing no bead is refused before anything reaches tmux
 * unless `noBeadReason` records the exception.
 */
export async function proveSend(input: {
	session: string;
	pane: string;
	message: string;
	dropDir: string;
	noBeadReason?: string;
	exec?: SendExec;
	pollMs?: number;
	deadlineMs?: number;
	wait?: (ms: number) => Promise<void>;
}): Promise<ProvenSend> {
	const { dispatch, bead_ids } = dispatchBeads(input.message);
	const no_bead_reason = dispatch && bead_ids.length === 0 ? input.noBeadReason?.trim() || null : null;
	if (dispatch && bead_ids.length === 0 && !no_bead_reason) {
		return { status: "BEAD_REQUIRED", marker: "", sends: 0, drop_path: null, bead_ids, no_bead_reason,
			detail: "work dispatch cites no bead id; nothing was sent" };
	}
	const exec = input.exec ?? defaultExec();
	const pollMs = input.pollMs ?? SEND_POLL_MS;
	const deadlineMs = input.deadlineMs ?? SEND_DEADLINE_MS;
	const wait = input.wait ?? waitFor;
	const marker = `kit-send-${randomBytes(6).toString("hex")}`;
	const text = `${input.message}\n[${marker}]`;
	for (let sends = 1; sends <= SEND_MAX_SENDS; sends++) {
		if (exec.run(["ntm", "send", input.session, "--panes=" + input.pane, text]).code !== 0) continue;
		const started = Date.now();
		let entered = false;
		while (Date.now() - started < deadlineMs) {
			// Bare pane id: session:pane is parsed as a window and misses.
			// -S -200 reads scrollback history: a rendered message scrolls off
			// the visible screen but stays provable in history.
			const got = exec.run(["tmux", "capture-pane", "-p", "-S", "-200", "-t", input.pane]);
			if (got.code === 0 && got.out.includes(marker)) {
				// Text typed into the input box but never submitted is not a delivery.
				if (!markerInComposer(got.out, marker)) {
					const how = entered ? " after one Enter" : "";
					return { status: "OK", marker, sends, drop_path: null, detail: `marker seen in ${input.pane} history after ${sends} send(s)${how}`, bead_ids, no_bead_reason };
				}
				if (!entered) {
					exec.run(["tmux", "send-keys", "-t", input.pane, "Enter"]);
					entered = true;
				}
			}
			await wait(pollMs);
		}
		// The text is on the pane: resending or dropping would duplicate it.
		if (entered) {
			return { status: "PENDING_SUBMIT", marker, sends, drop_path: null, detail: `marker still unsubmitted in ${input.pane} input box after one Enter`, bead_ids, no_bead_reason };
		}
	}
	const dropPath = dropMessage(input.dropDir, input.session, input.pane, marker, input.message);
	return { status: "NOT_DELIVERED", marker, sends: SEND_MAX_SENDS, drop_path: dropPath, detail: `marker never appeared in ${input.pane} history; message written to ${dropPath}`, bead_ids, no_bead_reason };
}
